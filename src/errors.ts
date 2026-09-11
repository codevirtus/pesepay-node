/**
 * The SDK's error hierarchy.
 *
 * Every failure this package raises extends {@link PesepayError}. v1 returned
 * `{ success: false, message }` for everything, which collapsed "your key is
 * wrong" and "the socket dropped" into one value; v2 throws instead.
 *
 * **No error here carries key material** — not in its message, its properties,
 * or its `cause`. Error objects reach log aggregators and issue trackers, so a
 * payments SDK that leaks credentials into them is the vulnerability. Keep that
 * property if you extend these classes.
 *
 * @packageDocumentation
 */

/**
 * Stable discriminator for the places `instanceof` cannot reach: structured
 * logs, errors crossing a worker boundary, a bundler that ended up with two
 * copies of the package.
 */
export type PesepayErrorCode =
  | 'ERR_PESEPAY'
  | 'ERR_PESEPAY_API'
  | 'ERR_PESEPAY_AUTH'
  | 'ERR_PESEPAY_CRYPTO'
  | 'ERR_PESEPAY_NETWORK'
  | 'ERR_PESEPAY_TIMEOUT'
  | 'ERR_PESEPAY_CONFIG';

/** Base class for every error thrown by this package. */
export class PesepayError extends Error {
  override readonly name: string = 'PesepayError';
  readonly code: PesepayErrorCode = 'ERR_PESEPAY';

  // Not redundant: narrows Error's optional `message` to required.
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface PesepayApiErrorInit {
  status: number;
  /**
   * The server's `message` field. Optional rather than defaulted, because the
   * gateway genuinely sends `null` here.
   */
  serverMessage?: string | undefined;
  description?: string | undefined;
  url?: string | undefined;
  method?: string | undefined;
  /** Kept so an unparseable body is still diagnosable. Holds no credentials. */
  responseBody?: string | undefined;
}

const MAX_RETAINED_BODY = 2048;

/**
 * The gateway returned a non-2xx status — or a 2xx whose body was not the
 * documented shape, which is reported the same way so the HTTP status stays
 * available on the error either way.
 *
 * The status codes are not what you would guess, and these mappings are read
 * off the Java server:
 *
 * | status | what it actually means |
 * |---|---|
 * | `400` | often just an unhandled server-side `RuntimeException` |
 * | `403` | the integration key exists but is disabled |
 * | `404` | the integration key is **unknown** — not "no such endpoint" |
 * | `500` | `"Failed to decrypt your data"` means your *encryption key* is wrong |
 *
 * So "4xx is your fault, 5xx is worth retrying" is backwards here. Use
 * {@link isRetryable}, which encodes it.
 */
export class PesepayApiError extends PesepayError {
  override readonly name: string = 'PesepayApiError';
  override readonly code: PesepayErrorCode = 'ERR_PESEPAY_API';

  readonly status: number;
  readonly serverMessage: string | undefined;
  readonly description: string | undefined;
  readonly url: string | undefined;
  readonly method: string | undefined;
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
   * `true` when repeating the request might succeed: `408`, `429`, and 5xx
   * other than the decryption failure. A `403`/`404` is a key that will still
   * be wrong in ten minutes, and retrying a key mismatch is a loop.
   */
  isRetryable(): boolean {
    if (this.status === 408 || this.status === 429) return true;
    if (this.status < 500) return false;
    return !this.isEncryptionKeyMismatch();
  }

  /**
   * `true` for the 500 meaning the encryption key configured here is not the
   * one registered against this integration key.
   */
  isEncryptionKeyMismatch(): boolean {
    return this.status === 500 && /failed to decrypt/i.test(this.serverMessage ?? '');
  }
}

/**
 * The integration key was rejected — the `403` (disabled) and `404` (unknown)
 * cases, so "my credentials are wrong" need not be recovered from a status code
 * that reads like something else.
 */
export class PesepayAuthError extends PesepayApiError {
  override readonly name: string = 'PesepayAuthError';
  override readonly code: PesepayErrorCode = 'ERR_PESEPAY_AUTH';

  override isRetryable(): boolean {
    return false;
  }
}

/**
 * Encryption or decryption failed — usually a key that does not match the one
 * Pesepay holds, a response altered in transit, or a key that is not 32 ASCII
 * characters.
 *
 * Deliberately fatal. Since CBC has no integrity protection, the padding check
 * is the only signal that the ciphertext is not what the server sent, and an
 * SDK returning a garbled `transactionStatus` is worse than one that refuses.
 */
export class PesepayCryptoError extends PesepayError {
  override readonly name: string = 'PesepayCryptoError';
  override readonly code: PesepayErrorCode = 'ERR_PESEPAY_CRYPTO';
}

/**
 * No HTTP response was produced — DNS failure, refused connection, reset
 * socket, TLS failure, or a response even the lenient parser could not read.
 */
export class PesepayNetworkError extends PesepayError {
  override readonly name: string = 'PesepayNetworkError';
  override readonly code: PesepayErrorCode = 'ERR_PESEPAY_NETWORK';
}

/**
 * The request exceeded its timeout.
 *
 * **A timeout is not a failed payment.** The gateway may have processed the
 * transaction and you simply did not hear back. Recover with
 * `checkPayment(referenceNumber)` — never by re-initiating, which risks
 * charging the customer twice.
 */
export class PesepayTimeoutError extends PesepayNetworkError {
  override readonly name: string = 'PesepayTimeoutError';
  override readonly code: PesepayErrorCode = 'ERR_PESEPAY_TIMEOUT';

  readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number, options?: ErrorOptions) {
    super(message, options);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The SDK was configured or called wrongly — a missing or malformed key, an
 * absent `resultUrl`, a non-https base URL, a negative amount, a seamless
 * payment with no customer. Thrown eagerly, before any network call: none of
 * these are fixable at runtime, and failing at construction (or at the top of
 * the method) is cheaper than failing mid-checkout.
 */
export class PesepayConfigError extends PesepayError {
  override readonly name: string = 'PesepayConfigError';
  override readonly code: PesepayErrorCode = 'ERR_PESEPAY_CONFIG';
}

/** Leads with the server's own words, when it sent any. */
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
