/**
 * The SDK's error hierarchy.
 *
 * Every failure this package raises extends {@link PesepayError}.
 *
 * **No error here carries key material**, in its message, its properties or
 * its `cause`, because errors end up in logs. Keep it that way if you extend
 * these classes.
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
  /** The server's `message` field, when it sent one. */
  serverMessage?: string | undefined;
  description?: string | undefined;
  url?: string | undefined;
  method?: string | undefined;
  /** Kept so an unparseable body is still diagnosable. Holds no credentials. */
  responseBody?: string | undefined;
}

const MAX_RETAINED_BODY = 2048;

/**
 * Pesepay returned a non-2xx status, or a 2xx whose body was not the expected
 * shape. The HTTP status is on the error either way.
 *
 * | status | meaning |
 * |---|---|
 * | `403` | the integration key is disabled |
 * | `404` | the integration key is not recognised (not a missing URL) |
 * | `500` with `"Failed to decrypt your data"` | the encryption key is wrong |
 *
 * Use {@link isRetryable} to decide whether to try again.
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
   * other than an encryption key mismatch. Key problems won't fix themselves.
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

/** The integration key was rejected: `403` (disabled) or `404` (not recognised). */
export class PesepayAuthError extends PesepayApiError {
  override readonly name: string = 'PesepayAuthError';
  override readonly code: PesepayErrorCode = 'ERR_PESEPAY_AUTH';

  override isRetryable(): boolean {
    return false;
  }
}

/**
 * Encryption or decryption failed: usually an encryption key that does not
 * match the one Pesepay holds, or a response altered in transit. Not retryable.
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
 * **A timeout is not a failed payment.** The payment may have gone through.
 * Recover with `checkPayment(referenceNumber)`, never by retrying the payment,
 * which could charge the customer twice.
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
 * The SDK was configured or called incorrectly: a missing or malformed key, a
 * missing `resultUrl`, a non-https base URL, a negative amount, a seamless
 * payment with no customer. Always thrown before any request is sent.
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
