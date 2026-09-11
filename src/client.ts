/**
 * The payments client — `initiate`, `make-payment`, `check-payment`, `poll`.
 *
 * ## The shape of a call
 *
 * Every payment endpoint speaks the `{ "payload": "<base64>" }` envelope in
 * both directions, authenticated by a `key` header carrying the integration
 * key. So a request is: build the plain object, `JSON.stringify`, encrypt,
 * wrap, send; and a response is the same in reverse.
 *
 * **Except when it fails.** Errors come back as plain, unencrypted JSON, at
 * every status. That is not a detail — it is the whole reason {@link Pesepay}
 * checks the status *before* it decrypts anything. Feeding a 404 body to the
 * decryptor turns "your integration key is unknown" into "decryption failed",
 * which sends you hunting the wrong credential. v1 did exactly that, and then
 * flattened the result to `{ success: false }`.
 *
 * ## Statuses are not what you would guess
 *
 * | status | what it means |
 * |---|---|
 * | `400` | often an unhandled server-side `RuntimeException` |
 * | `403` | the integration key exists but is **disabled** |
 * | `404` | the integration key is **unknown** — not "no such endpoint" |
 * | `500` + `"Failed to decrypt your data"` | your **encryption** key is wrong |
 *
 * `403` and `404` become {@link PesepayAuthError}; the rest become
 * {@link PesepayApiError}, on which `isEncryptionKeyMismatch()` picks out that
 * last row.
 *
 * ## No credential ever reaches an error
 *
 * The gateway's own words are passed through into error messages, so they are
 * redacted first: any occurrence of the integration or encryption key is
 * replaced before the error is constructed. Combined with `#private` fields —
 * which `JSON.stringify` cannot see — an error from this client is safe to log
 * whatever the server chooses to echo back.
 *
 * @packageDocumentation
 */

import { assertValidEncryptionKey, decryptPayload, encryptPayload } from './crypto.js';
import {
  PesepayApiError,
  type PesepayApiErrorInit,
  PesepayAuthError,
  PesepayConfigError,
} from './errors.js';
import {
  httpsTransport,
  type Transport,
  type TransportMethod,
  type TransportResponse,
} from './internal/transport.js';
import { isPaid, isTerminal } from './status.js';
import type {
  CreateTransactionRequest,
  CustomerDetails,
  EncryptedEnvelope,
  InitiateTransactionResponse,
  PaymentTransactionResult,
  SeamlessPaymentRequest,
} from './types.js';

/** Production. The path prefix is part of it — every endpoint hangs off here. */
export const DEFAULT_BASE_URL: string = 'https://api.pesepay.com/api/payments-engine';

/**
 * 30 seconds. A seamless mobile-money charge waits on a customer's handset, so
 * it is genuinely slow; a shorter budget mostly manufactures
 * `PesepayTimeoutError`s for payments that then succeed.
 */
export const DEFAULT_TIMEOUT_MS: number = 30_000;

const INITIATE_PATH = '/v1/payments/initiate';
const SEAMLESS_PAYMENT_PATH = '/v2/payments/make-payment';
const CHECK_PAYMENT_PATH = '/v1/payments/check-payment';

const REDACTED = '[redacted]';

/** Below this length, a "secret" is too short to blind-replace safely. */
const MIN_REDACTABLE_LENGTH = 8;

export interface PesepayOptions {
  /** Sent as the `key` header. Identifies your application. */
  integrationKey: string;
  /** 32 ASCII characters. Validated eagerly, before any socket. */
  encryptionKey: string;
  /**
   * Where the gateway POSTs the result. Required by
   * {@link Pesepay.initiateTransaction} and
   * {@link Pesepay.makeSeamlessPayment}, and settable afterwards as a property.
   */
  resultUrl?: string | undefined;
  /** Where the customer is sent after the hosted payment page. */
  returnUrl?: string | undefined;
  /** Total budget per call, including the transport's parser retry. */
  timeoutMs?: number | undefined;
  /** Point at `https://api.test.pesepay.com/api/payments-engine` for sandbox. */
  baseUrl?: string | undefined;
  /** Inject your own HTTP — a proxy, a custom agent, or a test double. */
  transport?: Transport | undefined;
}

export interface InitiateTransactionOptions {
  /** Major units — `10.5` is ten dollars fifty. */
  amount: number;
  currencyCode: string;
  reasonForPayment: string;
  /** Your own identifier. Echoed back on every result for this reference. */
  merchantReference?: string | undefined;
  /** Pre-selects a method, so the customer skips the method picker. */
  paymentMethodCode?: string | undefined;
  /** Echoed back as `transactionMetadata`. */
  paymentMetadata?: Record<string, string> | undefined;
  /** Overrides {@link Pesepay.resultUrl} for this call only. */
  resultUrl?: string | undefined;
  /** Overrides {@link Pesepay.returnUrl} for this call only. */
  returnUrl?: string | undefined;
}

export interface SeamlessPaymentOptions {
  amount: number;
  currencyCode: string;
  /** From a payment method's `code`. Required by the gateway. */
  paymentMethodCode: string;
  reasonForPayment: string;
  /**
   * **Always sent**, because the server dereferences it without a null check
   * and answers a 500 NPE when it is absent. At least one of `email` or
   * `phoneNumber` must be present.
   */
  customer: CustomerDetails;
  /**
   * Values for whatever the payment method's `requiredFields` declares, keyed
   * by each field's `name` — e.g. `{ customerPhoneNumber: '0771111111' }`. Sent
   * as `paymentMethodRequiredFields`.
   */
  requiredFields?: Record<string, string> | undefined;
  merchantReference?: string | undefined;
  paymentMetadata?: Record<string, string> | undefined;
  resultUrl?: string | undefined;
  /** Defaults to `resultUrl` server-side when omitted. */
  returnUrl?: string | undefined;
}

/**
 * A decoded `PaymentTransactionResult`, with the two questions you actually
 * have answered for you.
 *
 * Everything the gateway sent is here — the real `transactionStatus` string,
 * its code, its description, the fee split in `amountDetails`, your metadata.
 * v1 discarded all of it and returned `paid: boolean`, which cannot tell
 * `PENDING` (wait) from `DECLINED` (stop) from `REVERSED` (you were paid, then
 * un-paid).
 *
 * `paid` and `isTerminal` are plain data rather than getters, so the object
 * survives `JSON.stringify`, `structuredClone`, and a trip through a queue.
 * Frozen, because a payment result is a record of what happened.
 */
export interface PaymentResult extends Readonly<PaymentTransactionResult> {
  /** `true` only for `SUCCESS`. Never for `PARTIALLY_PAID` or `REVERSED`. */
  readonly paid: boolean;
  /** `true` when the status will not change again — stop polling. */
  readonly isTerminal: boolean;
}

/**
 * The Pesepay payments client.
 *
 * ```ts
 * const pesepay = new Pesepay({
 *   integrationKey: process.env.PESEPAY_INTEGRATION_KEY,
 *   encryptionKey: process.env.PESEPAY_ENCRYPTION_KEY,
 *   resultUrl: 'https://example.com/pesepay/webhook',
 *   returnUrl: 'https://example.com/checkout/done',
 * });
 *
 * const { referenceNumber, redirectUrl } = await pesepay.initiateTransaction({
 *   amount: 10.5,
 *   currencyCode: 'USD',
 *   reasonForPayment: 'Order #1024',
 * });
 * ```
 *
 * The v1 positional form still constructs the same class:
 *
 * ```ts
 * const pesepay = new Pesepay(integrationKey, encryptionKey);
 * pesepay.resultUrl = 'https://example.com/pesepay/webhook';
 * ```
 *
 * **Server-side only.** This object holds two secrets; there is no browser
 * build and there should not be one.
 */
export class Pesepay {
  // `#private`, not `private`: a TS `private` field is an ordinary enumerable
  // own property at runtime, so `JSON.stringify(pesepay)` would publish both
  // keys into whatever log swallowed it. These are invisible to it.
  readonly #integrationKey: string;
  readonly #encryptionKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #transport: Transport;

  /**
   * Where the gateway POSTs the result. A mutable property because
   * `pesepay.resultUrl = …` is the single most common line in existing v1
   * integrations.
   */
  resultUrl: string | undefined;

  /** Where the customer lands after the hosted payment page. */
  returnUrl: string | undefined;

  constructor(options: PesepayOptions);
  /** v1 form. `resultUrl` and `returnUrl` are then set as properties. */
  constructor(integrationKey: string, encryptionKey: string);
  constructor(optionsOrIntegrationKey: PesepayOptions | string, legacyEncryptionKey?: string) {
    if (optionsOrIntegrationKey === null || optionsOrIntegrationKey === undefined) {
      throw new PesepayConfigError(
        'Pesepay requires either an options object or the v1 positional form ' +
          'new Pesepay(integrationKey, encryptionKey).',
      );
    }

    const options: PesepayOptions =
      typeof optionsOrIntegrationKey === 'string'
        ? { integrationKey: optionsOrIntegrationKey, encryptionKey: legacyEncryptionKey ?? '' }
        : optionsOrIntegrationKey;

    if (typeof options.integrationKey !== 'string' || options.integrationKey.trim() === '') {
      throw new PesepayConfigError('integrationKey is required.');
    }

    // Eager, and before any socket: a 32-character ASCII key is checkable here,
    // and discovering it now beats discovering it mid-checkout.
    assertValidEncryptionKey(options.encryptionKey);

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new PesepayConfigError(
        `timeoutMs must be a positive, finite number of milliseconds, but is ${String(timeoutMs)}.`,
      );
    }

    this.#integrationKey = options.integrationKey;
    this.#encryptionKey = options.encryptionKey;
    this.#baseUrl = normaliseBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#timeoutMs = timeoutMs;
    this.#transport = options.transport ?? httpsTransport;

    // Validated now when supplied, and again at use — they are settable, so the
    // constructor cannot be the only gate.
    if (options.resultUrl !== undefined) assertCallbackUrl(options.resultUrl, 'resultUrl');
    if (options.returnUrl !== undefined) assertCallbackUrl(options.returnUrl, 'returnUrl');

    this.resultUrl = options.resultUrl;
    this.returnUrl = options.returnUrl;
  }

  /** The gateway root in use, without a trailing slash. Never a credential. */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** The per-call budget in milliseconds. */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  /**
   * Creates a transaction and returns the URL to send the customer to.
   *
   * `redirectUrl` exists **only here** — the server declares one on
   * `PaymentTransactionResult` but has it commented out, so no later poll or
   * webhook gives it back. Store it alongside the reference number.
   *
   * @throws {PesepayConfigError} If `resultUrl`/`returnUrl` are missing or not
   *   absolute URLs, or the amount is not a positive number.
   * @throws {PesepayAuthError} `403` (key disabled) or `404` (key unknown).
   * @throws {PesepayApiError} Any other non-2xx.
   * @throws {PesepayCryptoError} If the response will not decrypt.
   * @throws {PesepayNetworkError} If no response arrived at all.
   */
  async initiateTransaction(
    options: InitiateTransactionOptions,
  ): Promise<InitiateTransactionResponse> {
    // Both URLs are checked here rather than left to the gateway, which does
    // not reject a blank one: CreateTransactionCommand substitutes the literal
    // string "NONE". The transaction is created, the customer pays, and the
    // result is posted nowhere.
    const resultUrl = assertCallbackUrl(options.resultUrl ?? this.resultUrl, 'resultUrl');
    const returnUrl = assertCallbackUrl(options.returnUrl ?? this.returnUrl, 'returnUrl');

    const request: CreateTransactionRequest = {
      amountDetails: {
        amount: assertAmount(options.amount),
        currencyCode: assertNonBlank(options.currencyCode, 'currencyCode'),
      },
      reasonForPayment: assertNonBlank(options.reasonForPayment, 'reasonForPayment'),
      transactionType: 'BASIC',
      resultUrl,
      returnUrl,
      ...optional('merchantReference', options.merchantReference),
      ...optional('paymentMethodCode', options.paymentMethodCode),
      ...optional('paymentMetadata', options.paymentMetadata),
    };

    const url = this.#endpoint(INITIATE_PATH);
    const decoded = await this.#exchange('POST', url, request);
    const context: ResponseContext = { status: 200, method: 'POST', url };

    const record = asRecord(decoded);
    if (record === undefined) {
      throw malformed(context, 'the decrypted payload was not a JSON object');
    }

    return {
      referenceNumber: readString(record, 'referenceNumber', context),
      pollUrl: readString(record, 'pollUrl', context),
      redirectUrl: readString(record, 'redirectUrl', context),
    };
  }

  /**
   * Charges a payment method directly — the customer never leaves your site,
   * so there is no redirect and no hosted page.
   *
   * The returned status is usually **not** terminal: a mobile-money charge
   * comes back `PENDING` while the customer's handset is still showing the
   * prompt. Poll {@link Pesepay.checkPayment} until
   * {@link PaymentResult.isTerminal}.
   *
   * @throws {PesepayConfigError} If `customer` carries neither an email nor a
   *   phone number, or `resultUrl` is missing.
   * @throws {PesepayAuthError} `403` (key disabled) or `404` (key unknown).
   * @throws {PesepayApiError} Any other non-2xx.
   */
  async makeSeamlessPayment(options: SeamlessPaymentOptions): Promise<PaymentResult> {
    const resultUrl = assertCallbackUrl(options.resultUrl ?? this.resultUrl, 'resultUrl');
    const returnUrl = options.returnUrl ?? this.returnUrl;
    if (returnUrl !== undefined) assertCallbackUrl(returnUrl, 'returnUrl');

    const request: SeamlessPaymentRequest = {
      amountDetails: {
        amount: assertAmount(options.amount),
        currencyCode: assertNonBlank(options.currencyCode, 'currencyCode'),
      },
      reasonForPayment: assertNonBlank(options.reasonForPayment, 'reasonForPayment'),
      paymentMethodCode: assertNonBlank(options.paymentMethodCode, 'paymentMethodCode'),
      // Unconditional. SeamlessPaymentProcessingProviderImpl reads getCustomer()
      // straight into the payment context with no null check, so omitting it
      // answers 500 with a NullPointerException rather than a validation error.
      customer: assertCustomer(options.customer),
      resultUrl,
      ...optional('returnUrl', returnUrl),
      ...optional('merchantReference', options.merchantReference),
      ...optional('paymentMethodRequiredFields', options.requiredFields),
      ...optional('paymentMetadata', options.paymentMetadata),
    };

    const url = this.#endpoint(SEAMLESS_PAYMENT_PATH);
    const decoded = await this.#exchange('POST', url, request);
    return toPaymentResult(decoded, { status: 200, method: 'POST', url });
  }

  /**
   * Reads the current state of a transaction by reference number.
   *
   * This is the recovery path after a `PesepayTimeoutError`: a timed-out
   * `initiateTransaction` may well have been accepted, and re-initiating risks
   * charging the customer twice.
   */
  async checkPayment(referenceNumber: string): Promise<PaymentResult> {
    const reference = assertNonBlank(referenceNumber, 'referenceNumber');

    // Built through URL rather than concatenated. v1 interpolated the reference
    // raw, so one containing `&`, `#` or a space produced a silently different
    // query.
    const url = new URL(`${this.#baseUrl}${CHECK_PAYMENT_PATH}`);
    url.searchParams.set('referenceNumber', reference);

    return this.pollTransaction(url.toString());
  }

  /**
   * Reads a transaction from the `pollUrl` the gateway handed back, which
   * already carries its own `?referenceNumber=`.
   *
   * Pass only a URL that came from Pesepay: this sends your integration key to
   * whatever host it names. The transport refuses anything but `https` (and
   * loopback `http`), which is the backstop, not the policy.
   */
  async pollTransaction(pollUrl: string): Promise<PaymentResult> {
    const url = assertNonBlank(pollUrl, 'pollUrl');
    const decoded = await this.#exchange('GET', url, undefined);
    return toPaymentResult(decoded, { status: 200, method: 'GET', url });
  }

  #endpoint(path: string): string {
    return `${this.#baseUrl}${path}`;
  }

  /**
   * One round trip: encrypt, send, check the status, decrypt — in that order.
   */
  async #exchange(
    method: TransportMethod,
    url: string,
    requestBody: object | undefined,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      key: this.#integrationKey,
      accept: 'application/json',
    };

    let body: string | undefined;
    if (requestBody !== undefined) {
      headers['content-type'] = 'application/json';
      const envelope: EncryptedEnvelope = {
        payload: encryptPayload(this.#encryptionKey, JSON.stringify(requestBody)),
      };
      body = JSON.stringify(envelope);
    }

    const response = await this.#transport({
      method,
      url,
      headers,
      body,
      timeoutMs: this.#timeoutMs,
    });

    const context: ResponseContext = { status: response.status, method, url };

    // The ordering here is the point of this method. A failure body is plain
    // JSON at every status, so it must be recognised as a failure before
    // anything touches the decryptor — otherwise the 500 that means "wrong
    // encryption key" arrives as a generic padding error, and so does the 404
    // that means "unknown integration key".
    if (response.status < 200 || response.status >= 300) {
      throw this.#toApiError(response, context);
    }

    const envelope = asRecord(parseJson(response.body));
    const payload = envelope?.payload;
    if (typeof payload !== 'string' || payload === '') {
      throw malformed(context, 'the body is not a { "payload": "…" } envelope');
    }

    const decoded = parseJson(decryptPayload(this.#encryptionKey, payload));
    if (decoded === undefined) {
      throw malformed(context, 'the decrypted payload is not JSON');
    }

    return decoded;
  }

  #toApiError(response: TransportResponse, context: ResponseContext): PesepayApiError {
    const parsed = parseErrorBody(response.body);

    const init: PesepayApiErrorInit = {
      status: context.status,
      serverMessage: this.#redact(parsed.message),
      description: this.#redact(parsed.description) ?? describeStatus(context.status),
      url: context.url,
      method: context.method,
      responseBody: this.#redact(response.body),
    };

    // 404 is the gateway's answer for an integration key it cannot find, and
    // 403 for one it finds but will not accept. Neither is a missing endpoint,
    // and neither is worth retrying.
    return context.status === 403 || context.status === 404
      ? new PesepayAuthError(init)
      : new PesepayApiError(init);
  }

  /**
   * Strips both keys out of anything the server said, before it becomes part of
   * an error. The gateway is not believed to echo credentials back — but error
   * objects end up in log aggregators and issue trackers, and "we checked, and
   * it does not" is a weaker guarantee than "it cannot".
   */
  #redact(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;

    let redacted = value;
    for (const secret of [this.#integrationKey, this.#encryptionKey]) {
      if (secret.length >= MIN_REDACTABLE_LENGTH && redacted.includes(secret)) {
        redacted = redacted.split(secret).join(REDACTED);
      }
    }
    return redacted;
  }
}

/** What a response was, for error messages. */
interface ResponseContext {
  status: number;
  method: TransportMethod;
  url: string;
}

/**
 * Wraps a decoded `PaymentTransactionResult`, answering "did it work" and "is
 * it over" alongside everything the gateway sent.
 */
function toPaymentResult(value: unknown, context: ResponseContext): PaymentResult {
  const record = asRecord(value);
  if (record === undefined) {
    throw malformed(context, 'the decrypted payload was not a JSON object');
  }

  const transactionStatus = readString(record, 'transactionStatus', context);

  // Required on the server for every result, and the key everything else is
  // reconciled against — a result without one is not usable.
  readString(record, 'referenceNumber', context);

  // Spread first, so the derived fields win whatever the gateway sends.
  return Object.freeze({
    ...record,
    transactionStatus,
    paid: isPaid(transactionStatus),
    isTerminal: isTerminal(transactionStatus),
  }) as unknown as PaymentResult;
}

/**
 * Parses the gateway's plain-JSON failure body.
 *
 * Tolerant on purpose — this runs on the path where something is already
 * wrong, so an HTML error page or an empty body must still produce an error
 * that names the status rather than a `SyntaxError` from in here. The array
 * branch is real: the engine's own client code handles `ErrorMessage[]`
 * bodies, so some services in the estate emit them.
 */
function parseErrorBody(body: string): {
  message?: string | undefined;
  description?: string | undefined;
} {
  const parsed = parseJson(body);
  const record = asRecord(Array.isArray(parsed) ? parsed[0] : parsed);
  if (record === undefined) return {};

  // `message` is genuinely nullable on the server, so this covers `null` too.
  return {
    message: typeof record.message === 'string' ? record.message : undefined,
    description: typeof record.description === 'string' ? record.description : undefined,
  };
}

/** The rows of the status table worth spelling out when the server did not. */
function describeStatus(status: number): string | undefined {
  if (status === 404) {
    return 'the integration key is not recognised — Pesepay answers an unknown key with 404, not 401';
  }
  if (status === 403) {
    return 'the integration key is recognised but disabled for this application';
  }
  return undefined;
}

function malformed(context: ResponseContext, detail: string): PesepayApiError {
  return new PesepayApiError({
    status: context.status,
    description: `the response could not be understood — ${detail}`,
    url: context.url,
    method: context.method,
    // Deliberately no responseBody: by this point it has been decrypted, and
    // decrypted transaction data is customer data.
  });
}

function readString(
  record: Record<string, unknown>,
  key: string,
  context: ResponseContext,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw malformed(context, `it has no ${key}`);
  }
  return value;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Builds `{ key: value }` or nothing, so an absent option stays absent rather
 * than becoming `"key": null` on the wire — which the server's `@NotBlank`
 * validators and its `"NONE"` substitution treat differently from missing.
 */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | undefined {
  return value === undefined ? undefined : ({ [key]: value } as Record<K, V>);
}

function assertNonBlank(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PesepayConfigError(`${label} is required.`);
  }
  return value;
}

function assertAmount(amount: number): number {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    throw new PesepayConfigError(
      'amount must be a positive, finite number in major units (10.5 is ten dollars ' +
        `fifty), but is ${String(amount)}.`,
    );
  }
  return amount;
}

function assertCustomer(customer: CustomerDetails): CustomerDetails {
  const hasEmail = typeof customer?.email === 'string' && customer.email.trim() !== '';
  const hasPhone = typeof customer?.phoneNumber === 'string' && customer.phoneNumber.trim() !== '';

  if (!hasEmail && !hasPhone) {
    throw new PesepayConfigError(
      'customer must carry an email address, a phone number, or both. A seamless ' +
        'payment cannot omit it: the gateway dereferences customer without a null ' +
        'check and answers 500 with a NullPointerException rather than a validation ' +
        'message.',
    );
  }
  return customer;
}

/**
 * Callback URLs are checked here because the gateway will not check them: a
 * blank `resultUrl` becomes the string `"NONE"` server-side and the transaction
 * proceeds, so the mistake surfaces only as a webhook that never arrives.
 */
function assertCallbackUrl(value: string | undefined, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PesepayConfigError(
      `${label} is required. Set it on the client (pesepay.${label} = …), pass it ` +
        'to the constructor, or pass it with the request. The gateway will not ' +
        'reject a blank one — it substitutes the string "NONE" and creates the ' +
        'transaction anyway, so the outcome is simply never delivered.',
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PesepayConfigError(
      `${label} must be an absolute URL, but is "${value}". A relative path cannot ` +
        'be reached by the gateway.',
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PesepayConfigError(
      `${label} must be an http or https URL, but "${value}" uses ${url.protocol}`,
    );
  }

  return value;
}

/**
 * The transport refuses cleartext to anything but loopback at send time; this
 * repeats the rule at construction, so a mistyped `baseUrl` fails before the
 * first payment rather than during it.
 */
function normaliseBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PesepayConfigError(`baseUrl must be an absolute URL, but is "${String(value)}".`);
  }

  const loopback = /^(localhost|\[?::1\]?|127\..*)$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new PesepayConfigError(
      `baseUrl must use https, but is "${value}". Only a loopback host may use ` +
        'http, and only so the transport can be exercised locally — your ' +
        'integration key is a bearer credential.',
    );
  }

  return value.replace(/\/+$/, '');
}
