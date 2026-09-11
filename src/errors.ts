/**
 * The SDK's error hierarchy.
 *
 * Every failure this package raises is an instance of {@link PesepayError}, so
 * a single `catch` can separate "Pesepay went wrong" from a bug in your own
 * handler. The subclasses then tell you *whose* problem it is and whether a
 * retry could ever help.
 *
 * v1 returned `{ success: false, message }` for every failure, which collapsed
 * "your integration key is wrong" and "the socket dropped" into the same value
 * and discarded the server's `transactionStatus` entirely. v2 throws instead.
 *
 * ## Never log a key
 *
 * No error in this file carries the integration key or the encryption key, in
 * its message, its properties, or its `cause`. Error objects end up in log
 * aggregators, crash reporters and issue trackers; a payments SDK that leaks
 * credentials into any of those is the vulnerability, not the outage. If you
 * extend these classes, keep that property.
 *
 * @packageDocumentation
 */

/**
 * Stable, machine-readable discriminator carried by every {@link PesepayError}.
 *
 * Prefer `instanceof` where you can. `code` is here for the places `instanceof`
 * cannot reach: structured logs, error serialised across a worker boundary, and
 * consumers on a bundler that somehow ended up with two copies of the package.
 */
export type PesepayErrorCode =
  | 'ERR_PESEPAY'
  | 'ERR_PESEPAY_API'
  | 'ERR_PESEPAY_AUTH'
  | 'ERR_PESEPAY_CRYPTO'
  | 'ERR_PESEPAY_NETWORK'
  | 'ERR_PESEPAY_TIMEOUT'
  | 'ERR_PESEPAY_CONFIG';

/**
 * Base class for every error thrown by this package.
 *
 * ```ts
 * try {
 *   await pesepay.checkPayment(reference);
 * } catch (err) {
 *   if (err instanceof PesepayError) {
 *     // ours
 *   }
 *   throw err;
 * }
 * ```
 */
export class PesepayError extends Error {
  override readonly name: string = 'PesepayError';

  /** Stable discriminator; see {@link PesepayErrorCode}. */
  readonly code: PesepayErrorCode = 'ERR_PESEPAY';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

/** Constructor input for {@link PesepayApiError}. */
export interface PesepayApiErrorInit {
  /** HTTP status code the gateway responded with. */
  readonly status: number;

  /**
   * The server's `message` field, when it sent one.
   *
   * Pesepay's error body is plain JSON — never the `{ payload }` envelope —
   * shaped `{ timestamp, message, description, status }`, and `message` is
   * genuinely nullable, so this is optional rather than defaulted to a
   * fabricated string.
   */
  readonly serverMessage?: string | undefined;

  /** The server's `description` field, when it sent one. */
  readonly description?: string | undefined;

  /** Request URL, with any query string preserved. Never contains a key. */
  readonly url?: string | undefined;

  /** Request method. */
  readonly method?: string | undefined;

  /**
   * The raw response body, truncated.
   *
   * Present so that an unparseable or unexpected body is still diagnosable.
   * It is the *response*, so it holds no request credentials.
   */
  readonly responseBody?: string | undefined;
}

/** How much of an unexpected response body {@link PesepayApiError} keeps. */
const MAX_RETAINED_BODY = 2048;

/**
 * The gateway returned a non-2xx HTTP status.
 *
 * ### The status codes are not what you would guess
 *
 * These mappings are read off the Java server, not inferred from convention,
 * and at least three of them break the usual reading of HTTP:
 *
 * | status | what it actually means |
 * |---|---|
 * | `400` | often just an unhandled server-side `RuntimeException` |
 * | `403` | the integration key exists but is disabled |
 * | `404` | the integration key is **unknown** — not "no such endpoint" |
 * | `500` | `"Failed to decrypt your data"` means your *encryption key* is wrong |
 *
 * So "4xx is the caller's fault, 5xx is worth retrying" is exactly backwards
 * here: the 404 and the 500 are both permanent configuration faults, and the
 * 400 may well be transient. Use {@link isRetryable}, which encodes this.
 */
export class PesepayApiError extends PesepayError {
  override readonly name: string = 'PesepayApiError';
  override readonly code: PesepayErrorCode = 'ERR_PESEPAY_API';

  /** HTTP status code the gateway responded with. */
  readonly status: number;

  /** The server's own `message`, if it sent one. */
  readonly serverMessage: string | undefined;

  /** The server's own `description`, if it sent one. */
  readonly description: string | undefined;

  /** Request URL. */
  readonly url: string | undefined;

  /** Request method. */
  readonly method: string | undefined;

  /** Response body, truncated to {@link MAX_RETAINED_BODY} characters. */
  readonly responseBody: string | undefined;

  constructor(init: PesepayApiErrorInit, options?: ErrorOptions) {
    super(buildApiMessage(init), options);
    this.status = init.status;
    this.serverMessage = init.serverMessage;
    this.description = init.description;
    this.url = init.url;
    this.method = init.method;
    this.responseBody =
      init.responseBody === undefined ? undefined : truncate(init.responseBody, MAX_RETAINED_BODY);
  }

  /**
   * `true` when the same request might succeed if repeated.
   *
   * Only `408`, `429` and the 5xx range other than the decryption failure
   * qualify. A `403` or `404` is a key that will still be wrong in ten minutes,
   * and a `500` reading `"Failed to decrypt your data"` means your encryption
   * key does not match the one on your Pesepay account — retrying that is a
   * loop, not a recovery.
   */
  isRetryable(): boolean {
    if (this.status === 408 || this.status === 429) return true;
    if (this.status < 500) return false;
    return !this.isEncryptionKeyMismatch();
  }

  /**
   * `true` for the specific 500 the server returns when it cannot decrypt the
   * request body — i.e. the encryption key configured here is not the one
   * registered against this integration key.
   */
  isEncryptionKeyMismatch(): boolean {
    return this.status === 500 && /failed to decrypt/i.test(this.serverMessage ?? '');
  }
}

/**
 * The integration key was rejected.
 *
 * Raised for the `403` (key disabled) and `404` (key unknown) cases, so that
 * "my credentials are wrong" does not have to be recovered from a status code
 * that reads like something else entirely.
 */
export class PesepayAuthError extends PesepayApiError {
  override readonly name: string = 'PesepayAuthError';
  override readonly code: PesepayErrorCode = 'ERR_PESEPAY_AUTH';

  override isRetryable(): boolean {
    return false;
  }
}

/**
 * Encryption or decryption failed.
 *
 * In practice this is almost always one of:
 * - the encryption key does not match the one Pesepay holds, so the padding
 *   check on the decrypted response fails;
 * - the response was truncated or altered in transit;
 * - the key is not the 32 ASCII characters the wire contract requires.
 *
 * Because AES-CBC has no integrity protection, a padding failure is the *only*
 * signal that the ciphertext is not what the server sent. It is deliberately
 * fatal: a payments SDK that returns a garbled `transactionStatus` is worse
 * than one that refuses to guess.
 */
export class PesepayCryptoError extends PesepayError {
  override readonly name: string = 'PesepayCryptoError';
  override readonly code: PesepayErrorCode = 'ERR_PESEPAY_CRYPTO';
}

/**
 * The request never produced an HTTP response — DNS failure, refused
 * connection, reset socket, TLS failure, or an unparseable response that even
 * the lenient parser could not read.
 */
export class PesepayNetworkError extends PesepayError {
  override readonly name: string = 'PesepayNetworkError';
  override readonly code: PesepayErrorCode = 'ERR_PESEPAY_NETWORK';
}

/**
 * The request exceeded the configured timeout.
 *
 * **A timeout is not a failed payment.** The gateway may have accepted and
 * processed the transaction; you simply did not hear back. Recover by calling
 * `checkPayment(referenceNumber)` — never by re-initiating, which risks
 * charging the customer twice.
 */
export class PesepayTimeoutError extends PesepayNetworkError {
  override readonly name: string = 'PesepayTimeoutError';
  override readonly code: PesepayErrorCode = 'ERR_PESEPAY_TIMEOUT';

  /** The timeout that elapsed, in milliseconds. */
  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number, options?: ErrorOptions) {
    super(message, options);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The SDK was configured wrongly — a missing or malformed key, an absent
 * `resultUrl`, a non-https base URL.
 *
 * Thrown eagerly, before any network call, because none of these can be fixed
 * at runtime and failing at construction is cheaper than failing mid-checkout.
 */
export class PesepayConfigError extends PesepayError {
  override readonly name: string = 'PesepayConfigError';
  override readonly code: PesepayErrorCode = 'ERR_PESEPAY_CONFIG';
}

/** Builds a one-line message that leads with the server's own words. */
function buildApiMessage(init: PesepayApiErrorInit): string {
  const where =
    init.method !== undefined && init.url !== undefined ? ` (${init.method} ${init.url})` : '';
  const said = init.serverMessage ?? init.description;
  return said !== undefined && said !== ''
    ? `Pesepay responded ${init.status}: ${said}${where}`
    : `Pesepay responded ${init.status} with no error message${where}`;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}… (${value.length} chars total)`;
}
