/**
 * The Pesepay payments client.
 *
 * Payment endpoints exchange an encrypted `{ "payload": "<base64>" }` envelope
 * and authenticate with a `key` header. Error responses are plain JSON, so the
 * status is always checked before anything is decrypted.
 *
 * @packageDocumentation
 */

import { createHash, timingSafeEqual } from 'node:crypto';
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
  CreateInvoiceRequest,
  CreateTransactionRequest,
  Currency,
  CustomerDetails,
  EncryptedEnvelope,
  InitiateTransactionResponse,
  Invoice,
  InvoicePayer,
  PaymentMethod,
  PaymentTransactionResult,
  RecurringFrequency,
  SeamlessPaymentRequest,
} from './types.js';

/** The production API. */
export const DEFAULT_BASE_URL: string = 'https://api.pesepay.com/api/payments-engine';

/**
 * 30 seconds. A seamless mobile-money payment waits for the customer to approve
 * it on their phone, so a shorter limit tends to time out payments that then
 * succeed.
 */
export const DEFAULT_TIMEOUT_MS: number = 30_000;

const INITIATE_PATH = '/v1/payments/initiate';
const SEAMLESS_PAYMENT_PATH = '/v2/payments/make-payment';
const CHECK_PAYMENT_PATH = '/v1/payments/check-payment';
const INVOICE_INITIATE_PATH = '/v1/payments/invoice/initiate';
const INVOICE_CHECK_PATH = '/v1/payments/invoice/check';

// Currencies and payment methods: public, plain JSON endpoints. No credential
// is sent to them.
const ACTIVE_CURRENCIES_PATH = '/v1/currencies/active';
const PAYMENT_METHODS_FOR_CURRENCY_PATH = '/v1/payment-methods/for-currency';
const ACTIVE_PAYMENT_METHODS_PATH = '/v1/payment-methods/all-active';

/** `MM/DD/YYYY`, the format invoice dates are sent in. */
const GATEWAY_DATE_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** `YYYY-MM-DD`, also accepted and converted. */
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const REDACTED = '[redacted]';

/** Below this length, a "secret" is too short to blind-replace safely. */
const MIN_REDACTABLE_LENGTH = 8;

export interface PesepayOptions {
  /** Your integration key. Sent as the `key` header. */
  integrationKey: string;
  /** Your encryption key: exactly 32 ASCII characters. Checked in the constructor. */
  encryptionKey: string;
  /**
   * Where Pesepay sends payment notifications. Required by
   * {@link Pesepay.initiateTransaction}, {@link Pesepay.makeSeamlessPayment}
   * and {@link Pesepay.initiateInvoice}. Can also be set later as a property.
   */
  resultUrl?: string | undefined;
  /** Where the customer lands after paying on Pesepay's payment page. */
  returnUrl?: string | undefined;
  /** Time limit for each call, in milliseconds. Defaults to 30 000. */
  timeoutMs?: number | undefined;
  /** Set to `https://api.test.pesepay.com/api/payments-engine` for the sandbox. */
  baseUrl?: string | undefined;
  /** A custom HTTP function: a proxy, a custom agent, or a test double. */
  transport?: Transport | undefined;
}

export interface InitiateTransactionOptions {
  /** Major units: `10.5` is ten dollars fifty. */
  amount: number;
  currencyCode: string;
  reasonForPayment: string;
  /** Your own identifier. Returned on every result for this transaction. */
  merchantReference?: string | undefined;
  /** Sends the customer straight to this payment method, skipping the picker. */
  paymentMethodCode?: string | undefined;
  /** Returned as `transactionMetadata`. */
  paymentMetadata?: Record<string, string> | undefined;
  /** Overrides {@link Pesepay.resultUrl} for this call only. */
  resultUrl?: string | undefined;
  /** Overrides {@link Pesepay.returnUrl} for this call only. */
  returnUrl?: string | undefined;
}

export interface SeamlessPaymentOptions {
  amount: number;
  currencyCode: string;
  /** A payment method's `code`. */
  paymentMethodCode: string;
  reasonForPayment: string;
  /** The customer being charged. At least one of `email` or `phoneNumber` is required. */
  customer: CustomerDetails;
  /**
   * Values for the payment method's `requiredFields`, keyed by each field's
   * `name`, for example `{ customerPhoneNumber: '0771111111' }`.
   */
  requiredFields?: Record<string, string> | undefined;
  merchantReference?: string | undefined;
  paymentMetadata?: Record<string, string> | undefined;
  resultUrl?: string | undefined;
  /** Defaults to `resultUrl` when omitted. */
  returnUrl?: string | undefined;
}

export interface InitiateInvoiceOptions {
  /** Major units. */
  amount: number;
  currencyCode: string;
  /** What the invoice is for. Shown to the payer. Must not contain HTML. */
  narrative: string;
  /** Who to bill. Both `name` and `email` are required. */
  payer: InvoicePayer;
  /** The code of the application that owns the invoice. Required. */
  applicationCode: string;
  /**
   * When Pesepay sends the invoice to the payer. A `Date` (read in UTC),
   * `'YYYY-MM-DD'`, or `'MM/DD/YYYY'`.
   */
  processingDate: Date | string;
  /** When payment is due. Same accepted forms as `processingDate`. */
  dueDate: Date | string;
  /** Reissue the invoice on a schedule. Requires `recurringFrequency`. */
  recurring?: boolean | undefined;
  recurringFrequency?: RecurringFrequency | undefined;
  /** Your own identifier. Must be unique across your invoices. */
  initiatorReference?: string | undefined;
  /** Overrides {@link Pesepay.resultUrl} for this call only. */
  resultUrl?: string | undefined;
  /** Overrides {@link Pesepay.returnUrl} for this call only. */
  returnUrl?: string | undefined;
}

/**
 * A frozen {@link Invoice}. Pass its `invoiceNumber` to
 * {@link Pesepay.checkInvoice}.
 */
export type InvoiceResult = Readonly<Invoice>;

/**
 * Request headers in Node's `IncomingHttpHeaders` shape. Express's `req.headers`
 * fits, as does a plain object. Names are matched case-insensitively.
 */
export type CallbackHeaders = Readonly<Record<string, string | string[] | undefined>>;

/**
 * The result of checking a callback's `Authorization` header.
 *
 * - `'matched'`: the header matches your integration key.
 * - `'mismatched'`: the header holds a different value, such as an old key
 *   after you rotated it, or a request that did not come from Pesepay.
 * - `'absent'`: the request has no `Authorization` header.
 */
export type CallbackKeyStatus = 'matched' | 'mismatched' | 'absent';

/** What {@link Pesepay.parseCallback} returns. Frozen. */
export interface CallbackVerification {
  /** The transaction result, with `paid` and `isTerminal`. */
  readonly result: PaymentResult;
  /**
   * `true` when the `Authorization` header matches your integration key.
   * Confirm the outcome with {@link Pesepay.checkPayment} before acting on a
   * callback, whatever this says.
   */
  readonly keyVerified: boolean;
  /** Why `keyVerified` is `true` or `false`. */
  readonly keyStatus: CallbackKeyStatus;
}

/**
 * A transaction result, with `paid` and `isTerminal` added.
 *
 * Both are plain properties rather than getters, so the object survives
 * `JSON.stringify`, `structuredClone` and a trip through a queue. Frozen.
 */
export interface PaymentResult extends Readonly<PaymentTransactionResult> {
  /** `true` only for `SUCCESS`. Never for `PARTIALLY_PAID` or `REVERSED`. */
  readonly paid: boolean;
  /** `true` when the status will not change again. Stop polling. */
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
 * The 1.x positional form also works:
 *
 * ```ts
 * const pesepay = new Pesepay(integrationKey, encryptionKey);
 * pesepay.resultUrl = 'https://example.com/pesepay/webhook';
 * ```
 *
 * **Server-side only.** This object holds your keys.
 */
export class Pesepay {
  // `#private` rather than TypeScript `private`, so `JSON.stringify(pesepay)`
  // cannot include the keys.
  readonly #integrationKey: string;
  readonly #encryptionKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #transport: Transport;

  /** Where Pesepay sends payment notifications. */
  resultUrl: string | undefined;

  /** Where the customer lands after paying on Pesepay's payment page. */
  returnUrl: string | undefined;

  constructor(options: PesepayOptions);
  /** The 1.x form. Set `resultUrl` and `returnUrl` as properties afterwards. */
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

    // Checked now, so a bad key fails at startup rather than mid-checkout.
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

    // Validated now when supplied, and again at use, since they are settable.
    if (options.resultUrl !== undefined) assertCallbackUrl(options.resultUrl, 'resultUrl');
    if (options.returnUrl !== undefined) assertCallbackUrl(options.returnUrl, 'returnUrl');

    this.resultUrl = options.resultUrl;
    this.returnUrl = options.returnUrl;
  }

  /** The API base URL in use, without a trailing slash. */
  get baseUrl(): string {
    return this.#baseUrl;
  }

  /** The time limit for each call, in milliseconds. */
  get timeoutMs(): number {
    return this.#timeoutMs;
  }

  /**
   * Creates a transaction and returns the URL to send the customer to.
   *
   * Only this method returns `redirectUrl`. Store it with the reference number
   * if you might need to send the customer back to the payment page.
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
   * Charges a payment method directly. The customer stays on your site.
   *
   * The result is usually `PENDING` while the customer approves the payment on
   * their phone. Call {@link Pesepay.checkPayment} until
   * {@link PaymentResult.isTerminal} is `true`.
   *
   * @throws {PesepayConfigError} If `customer` has neither an email nor a
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
   * Use this to recover after a `PesepayTimeoutError`: the payment may have
   * gone through, and retrying it could charge the customer twice.
   */
  async checkPayment(referenceNumber: string): Promise<PaymentResult> {
    const reference = assertNonBlank(referenceNumber, 'referenceNumber');

    // Built with URL so the reference is encoded.
    const url = new URL(`${this.#baseUrl}${CHECK_PAYMENT_PATH}`);
    url.searchParams.set('referenceNumber', reference);

    return this.pollTransaction(url.toString());
  }

  /**
   * Reads a transaction from a `pollUrl` returned by Pesepay.
   *
   * Pass only a URL that came from Pesepay: your integration key is sent to
   * whatever host it names.
   */
  async pollTransaction(pollUrl: string): Promise<PaymentResult> {
    const url = assertNonBlank(pollUrl, 'pollUrl');
    const decoded = await this.#exchange('GET', url, undefined);
    return toPaymentResult(decoded, { status: 200, method: 'GET', url });
  }

  /**
   * The currencies your account can use.
   *
   * Use it to populate a currency selector instead of hard-coding codes: a
   * currency your account isn't set up for is rejected when you create a
   * payment. This endpoint is public, so no keys are sent.
   *
   * @throws {PesepayApiError} Any non-2xx, or a body that is not an array.
   * @throws {PesepayNetworkError} If no response arrived at all.
   */
  async getActiveCurrencies(): Promise<Currency[]> {
    const url = this.#endpoint(ACTIVE_CURRENCIES_PATH);
    const decoded = await this.#exchangePlain('GET', url);
    return readCatalogue<Currency>(decoded, 'currency', { status: 200, method: 'GET', url });
  }

  /**
   * The payment methods that accept a given currency.
   *
   * Check three fields on each method before you charge it:
   *
   * - **`redirectRequired`**: when `true`, the method can't be charged with
   *   {@link Pesepay.makeSeamlessPayment}. Use
   *   {@link Pesepay.initiateTransaction} instead.
   * - **`requiredFields`**: what a seamless payment must collect. Use each
   *   entry's `name` as the key in `requiredFields`, and show its
   *   `displayName` in your UI.
   * - **`minimumAmount` / `maximumAmount`**: the allowed amount range.
   *
   * This endpoint is public, so no keys are sent.
   *
   * @param currencyCode A `code` from {@link Pesepay.getActiveCurrencies}.
   */
  async getPaymentMethods(currencyCode: string): Promise<PaymentMethod[]> {
    const code = assertNonBlank(currencyCode, 'currencyCode');

    const url = new URL(`${this.#baseUrl}${PAYMENT_METHODS_FOR_CURRENCY_PATH}`);
    url.searchParams.set('currencyCode', code);
    const href = url.toString();

    const decoded = await this.#exchangePlain('GET', href);
    return readCatalogue<PaymentMethod>(decoded, 'payment method', {
      status: 200,
      method: 'GET',
      url: href,
    });
  }

  /**
   * Every active payment method, across all currencies.
   *
   * Prefer {@link Pesepay.getPaymentMethods} when you know the currency.
   * Methods returned here must be filtered by their `currencies` list before
   * you offer them.
   */
  async getActivePaymentMethods(): Promise<PaymentMethod[]> {
    const url = this.#endpoint(ACTIVE_PAYMENT_METHODS_PATH);
    const decoded = await this.#exchangePlain('GET', url);
    return readCatalogue<PaymentMethod>(decoded, 'payment method', {
      status: 200,
      method: 'GET',
      url,
    });
  }

  /**
   * Creates an invoice. Pesepay emails the payer a payment link, so there is
   * no checkout page and no `redirectUrl`.
   *
   * - **`applicationCode` is required.**
   * - **Dates** can be a `Date` (read in UTC), `'YYYY-MM-DD'` or
   *   `'MM/DD/YYYY'`.
   * - **`initiatorReference` must be unique** across your invoices, so you can
   *   use it to avoid creating duplicates.
   * - **The returned `pollUrl`** can be passed to
   *   {@link Pesepay.pollTransaction}.
   *
   * @throws {PesepayConfigError} A missing `applicationCode`, an invalid date,
   *   a payer without a name or email, `recurring` without a frequency, or a
   *   missing `resultUrl`.
   */
  async initiateInvoice(options: InitiateInvoiceOptions): Promise<InvoiceResult> {
    const resultUrl = assertCallbackUrl(options.resultUrl ?? this.resultUrl, 'resultUrl');
    const returnUrl = options.returnUrl ?? this.returnUrl;
    if (returnUrl !== undefined) assertCallbackUrl(returnUrl, 'returnUrl');

    const recurringPayment = options.recurring === true;
    if (recurringPayment && options.recurringFrequency === undefined) {
      throw new PesepayConfigError('recurringFrequency is required when recurring is true.');
    }

    const request: CreateInvoiceRequest = {
      payer: assertPayer(options.payer),
      amount: assertAmount(options.amount),
      narrative: assertNonBlank(options.narrative, 'narrative'),
      currencyCode: assertNonBlank(options.currencyCode, 'currencyCode'),
      applicationCode: assertApplicationCode(options.applicationCode),
      processingDate: toServerDate(options.processingDate, 'processingDate'),
      dueDate: toServerDate(options.dueDate, 'dueDate'),
      recurringPayment,
      resultUrl,
      ...optional('returnUrl', returnUrl),
      ...optional('recurringFrequency', recurringPayment ? options.recurringFrequency : undefined),
      ...optional('initiatorReference', options.initiatorReference),
    };

    const url = this.#endpoint(INVOICE_INITIATE_PATH);
    const decoded = await this.#exchange('POST', url, request);
    return toInvoiceResult(decoded, { status: 200, method: 'POST', url });
  }

  /**
   * Reads the current state of an invoice's payment.
   *
   * Returns a {@link PaymentResult}, the same as {@link Pesepay.checkPayment}:
   * an invoice's `invoiceNumber` is also the reference number of the payer's
   * transaction.
   *
   * Equivalent to `pollTransaction(invoice.pollUrl)`.
   */
  async checkInvoice(invoiceNumber: string): Promise<PaymentResult> {
    const invoice = assertNonBlank(invoiceNumber, 'invoiceNumber');

    const url = new URL(`${this.#baseUrl}${INVOICE_CHECK_PATH}`);
    url.searchParams.set('invoiceNumber', invoice);

    return this.pollTransaction(url.toString());
  }

  /**
   * Reads a payment notification that Pesepay sent to your `resultUrl`, and
   * checks whether the request carries your integration key.
   *
   * Treat a notification as a signal to check, not as proof of payment:
   *
   * ```ts
   * app.post('/pesepay/webhook', express.json(), async (req, res) => {
   *   // 1. Respond right away, before doing any work.
   *   res.sendStatus(200);
   *
   *   const { result, keyVerified } = pesepay.parseCallback(req.body, req.headers);
   *   if (!keyVerified) log.warn('unverified pesepay callback', result.referenceNumber);
   *
   *   // 2. Confirm the outcome with Pesepay before acting on it.
   *   const confirmed = await pesepay.checkPayment(result.referenceNumber);
   *
   *   // 3. Handle each (referenceNumber, transactionStatus) pair only once.
   *   await creditOnce(confirmed.referenceNumber, confirmed.transactionStatus, confirmed);
   * });
   * ```
   *
   * - **Respond first**, so a slow or failing handler doesn't lose the
   *   notification. Also poll {@link Pesepay.checkPayment} for any order that
   *   stays pending.
   * - **Confirm with {@link Pesepay.checkPayment}**, which returns the
   *   authoritative status.
   * - **Be idempotent on `referenceNumber` and `transactionStatus`.** One
   *   transaction can notify more than once, for example `SUCCESS` and later
   *   `REVERSED`.
   *
   * `body` can be a parsed object (from `express.json()`), a JSON string, or
   * the raw `Buffer`/`Uint8Array`. `headers` is optional and matched
   * case-insensitively. A missing `Authorization` header does not throw: it is
   * reported as `keyStatus: 'absent'`.
   *
   * @returns The transaction result, `keyVerified`, and `keyStatus`.
   * @throws {PesepayConfigError} If `body` is not a JSON object with a
   *   `referenceNumber` and a `transactionStatus`.
   */
  parseCallback(body: unknown, headers?: CallbackHeaders): CallbackVerification {
    const record = decodeCallbackBody(body);

    const transactionStatus = readCallbackString(record, 'transactionStatus');
    // Not returned, just required: without it there is nothing to reconcile
    // against or re-verify with.
    readCallbackString(record, 'referenceNumber');

    const keyStatus = classifyPresentedKey(readAuthorization(headers), this.#integrationKey);

    return Object.freeze({
      result: derivePaymentResult(record, transactionStatus),
      keyVerified: keyStatus === 'matched',
      keyStatus,
    });
  }

  /**
   * One round trip with no encryption and no `key` header, for the public
   * endpoints. The status is still checked before the body is parsed.
   */
  async #exchangePlain(method: TransportMethod, url: string): Promise<unknown> {
    const response = await this.#transport({
      method,
      url,
      headers: { accept: 'application/json' },
      timeoutMs: this.#timeoutMs,
    });

    const context: ResponseContext = { status: response.status, method, url };

    if (response.status < 200 || response.status >= 300) {
      throw this.#toApiError(response, context);
    }

    const decoded = parseJson(response.body);
    if (decoded === undefined) {
      throw malformed(context, 'the body is not JSON');
    }

    return decoded;
  }

  #endpoint(path: string): string {
    return `${this.#baseUrl}${path}`;
  }

  /**
   * One round trip: encrypt, send, check the status, decrypt, in that order.
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

    // Error bodies are plain JSON, so check the status before decrypting.
    // Otherwise a wrong key would surface as a generic decryption error.
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

    // 404 means an unknown integration key and 403 a disabled one.
    return context.status === 403 || context.status === 404
      ? new PesepayAuthError(init)
      : new PesepayApiError(init);
  }

  /**
   * Removes both keys from anything the server said before it becomes part of
   * an error, since errors end up in logs.
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

/** Validates a decoded transaction result and adds `paid` and `isTerminal`. */
function toPaymentResult(value: unknown, context: ResponseContext): PaymentResult {
  const record = asRecord(value);
  if (record === undefined) {
    throw malformed(context, 'the decrypted payload was not a JSON object');
  }

  const transactionStatus = readString(record, 'transactionStatus', context);

  // Everything else is reconciled against the reference number.
  readString(record, 'referenceNumber', context);

  return derivePaymentResult(record, transactionStatus);
}

/**
 * Freezes a result and adds `paid` and `isTerminal`. Shared by the polling and
 * callback paths, so both produce identical objects.
 */
function derivePaymentResult(
  record: Record<string, unknown>,
  transactionStatus: string,
): PaymentResult {
  // Spread first, so the derived fields always win.
  return Object.freeze({
    ...record,
    transactionStatus,
    paid: isPaid(transactionStatus),
    isTerminal: isTerminal(transactionStatus),
  }) as unknown as PaymentResult;
}

/**
 * Parses a plain-JSON error body. Tolerant on purpose: an HTML page or an empty
 * body must still produce an error that names the status. An array body is
 * read from its first element.
 */
function parseErrorBody(body: string): {
  message?: string | undefined;
  description?: string | undefined;
} {
  const parsed = parseJson(body);
  const record = asRecord(Array.isArray(parsed) ? parsed[0] : parsed);
  if (record === undefined) return {};

  // `message` can be null.
  return {
    message: typeof record.message === 'string' ? record.message : undefined,
    description: typeof record.description === 'string' ? record.description : undefined,
  };
}

/** A description for statuses that need one when the server sent none. */
function describeStatus(status: number): string | undefined {
  if (status === 404) {
    return 'the integration key is not recognised — check that it belongs to this environment';
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
    // No responseBody: by this point it has been decrypted, and decrypted
    // transaction data is customer data.
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
 * Builds `{ key: value }` or nothing, so an absent option is left out of the
 * request rather than sent as `null`.
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
      'customer is required for a seamless payment, with an email address, a phone ' +
        'number, or both.',
    );
  }
  return customer;
}

/**
 * Checks a `resultUrl` or `returnUrl` before any request is sent, so a missing
 * one fails here rather than as a notification that never arrives.
 */
function assertCallbackUrl(value: string | undefined, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PesepayConfigError(
      `${label} is required. Set it on the client (pesepay.${label} = …), pass it ` +
        'to the constructor, or pass it with the request.',
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PesepayConfigError(
      `${label} must be an absolute URL, but is "${value}". Pesepay cannot reach a ` +
        'relative path.',
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
 * The transport refuses cleartext to anything but loopback when it sends; this
 * applies the same rule at construction, so a mistyped `baseUrl` fails early.
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
        'http, for local testing — your integration key is a credential.',
    );
  }

  return value.replace(/\/+$/, '');
}

/**
 * Reads an array of currencies or payment methods.
 *
 * Only `code` is required of each entry, since it is the one field you send
 * back; everything else is descriptive. Each entry is frozen.
 */
function readCatalogue<T>(value: unknown, label: string, context: ResponseContext): T[] {
  if (!Array.isArray(value)) {
    throw malformed(context, `the body was not a JSON array of ${label} records`);
  }

  return value.map((entry, index) => {
    const record = asRecord(entry);
    if (record === undefined) {
      throw malformed(context, `${label} ${index} was not a JSON object`);
    }
    if (typeof record.code !== 'string' || record.code === '') {
      throw malformed(context, `${label} ${index} has no code`);
    }
    return Object.freeze(record) as T;
  });
}

function toInvoiceResult(value: unknown, context: ResponseContext): InvoiceResult {
  const record = asRecord(value);
  if (record === undefined) {
    throw malformed(context, 'the decrypted payload was not a JSON object');
  }

  // Required: it is how the invoice is looked up afterwards.
  readString(record, 'invoiceNumber', context);

  return Object.freeze(record) as InvoiceResult;
}

/**
 * Converts an invoice date to `MM/DD/YYYY`.
 *
 * A `Date` is read in UTC: `new Date('2026-09-11')` is UTC midnight, and
 * reading local fields would give the previous day for callers west of UTC.
 */
function toServerDate(value: Date | string, label: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new PesepayConfigError(`${label} is an Invalid Date.`);
    }
    return formatServerDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
  }

  if (typeof value === 'string') {
    const iso = ISO_DATE_PATTERN.exec(value);
    if (iso !== null) {
      return assertCalendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), value, label);
    }

    const gateway = GATEWAY_DATE_PATTERN.exec(value);
    if (gateway !== null) {
      return assertCalendarDate(
        Number(gateway[3]),
        Number(gateway[1]),
        Number(gateway[2]),
        value,
        label,
      );
    }
  }

  throw new PesepayConfigError(
    `${label} must be a Date, a "YYYY-MM-DD" string, or a "MM/DD/YYYY" string, ` +
      `but is "${String(value)}".`,
  );
}

/** Rejects dates such as 2026-02-30, which `Date.UTC` would silently roll over. */
function assertCalendarDate(
  year: number,
  month: number,
  day: number,
  raw: string,
  label: string,
): string {
  const utc = new Date(Date.UTC(year, month - 1, day));

  if (
    Number.isNaN(utc.getTime()) ||
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() + 1 !== month ||
    utc.getUTCDate() !== day
  ) {
    throw new PesepayConfigError(`${label} is not a real calendar date: "${raw}".`);
  }

  return formatServerDate(year, month, day);
}

function formatServerDate(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const yyyy = String(year).padStart(4, '0');
  return `${mm}/${dd}/${yyyy}`;
}

function assertPayer(payer: InvoicePayer): InvoicePayer {
  const hasName = typeof payer?.name === 'string' && payer.name.trim() !== '';
  const hasEmail = typeof payer?.email === 'string' && payer.email.trim() !== '';

  if (!hasName || !hasEmail) {
    throw new PesepayConfigError(
      'payer must have both a name and an email address. Pesepay emails the ' +
        'invoice to the payer.',
    );
  }

  return payer;
}

function assertApplicationCode(applicationCode: string): string {
  if (typeof applicationCode !== 'string' || applicationCode.trim() === '') {
    throw new PesepayConfigError(
      'applicationCode is required for an invoice. It identifies the application ' +
        'that owns the invoice.',
    );
  }

  return applicationCode;
}

/**
 * Accepts the three forms a webhook body arrives in (a parsed object, a JSON
 * string, or raw bytes) and rejects everything else by name, so a handler
 * never treats garbage as a payment.
 */
function decodeCallbackBody(body: unknown): Record<string, unknown> {
  let value: unknown = body;

  // Covers Buffer, which is a Uint8Array.
  if (value instanceof Uint8Array) {
    value = new TextDecoder().decode(value);
  }

  if (typeof value === 'string') {
    if (value.trim() === '') {
      throw callbackError(
        'the body was empty. If you are using a body parser, make sure it runs on ' +
          'this route: express.json() leaves req.body undefined when the request ' +
          'carries no content-type it recognises',
      );
    }

    const parsed = parseJson(value);
    if (parsed === undefined) {
      throw callbackError('the body was not JSON');
    }
    value = parsed;
  }

  const record = asRecord(value);
  if (record === undefined) {
    throw callbackError(
      `the body was not a JSON object (it was ${describeType(body)}). Pass req.body, ` +
        'the raw string, or the raw Buffer',
    );
  }

  // API responses are wrapped in an envelope and callbacks are not, so an
  // envelope here is a likely mix-up worth naming.
  if (typeof record.payload === 'string' && Object.keys(record).length === 1) {
    throw callbackError(
      'the body is a { "payload": "…" } envelope, but callbacks are plain JSON. ' +
        'Something has re-wrapped it, or this is an API response rather than a ' +
        'callback',
    );
  }

  return record;
}

function readCallbackString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw callbackError(`it has no ${key}`);
  }
  return value;
}

function callbackError(detail: string): PesepayConfigError {
  return new PesepayConfigError(
    `This is not a Pesepay callback body — ${detail}. Nothing about it has been ` +
      'treated as a transaction result.',
  );
}

/** Describes a rejected body's type, with its article, for the error message. */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * Finds the `Authorization` header in any case.
 *
 * A repeated header reaches Node as an array. Pesepay sends one, so more than
 * one is treated as absent rather than picking one to compare.
 */
function readAuthorization(headers: CallbackHeaders | undefined): string | undefined {
  if (headers === undefined || headers === null || typeof headers !== 'object') {
    return undefined;
  }

  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'authorization') continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value.length === 1) return value[0];
    return undefined;
  }

  return undefined;
}

function classifyPresentedKey(presented: string | undefined, expected: string): CallbackKeyStatus {
  if (presented === undefined) return 'absent';
  return secretsMatch(presented, expected) ? 'matched' : 'mismatched';
}

/**
 * Constant-time string comparison that does not leak length.
 *
 * `timingSafeEqual` requires equal-length inputs, and a length check in front
 * of it would reveal the key's length. Hashing both sides to 32 bytes avoids
 * that.
 *
 * The comparison is exact: no `Bearer` prefix is stripped and nothing is
 * trimmed, because the header holds the raw integration key.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const left = createHash('sha256').update(presented, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right);
}
