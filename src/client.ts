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
const INVOICE_INITIATE_PATH = '/v1/payments/invoice/initiate';
const INVOICE_CHECK_PATH = '/v1/payments/invoice/check';

// The catalogue. Plain JSON, and permitAll() server-side — see
// `Pesepay.getPaymentMethods` for why no credential goes with them.
const ACTIVE_CURRENCIES_PATH = '/v1/currencies/active';
const PAYMENT_METHODS_FOR_CURRENCY_PATH = '/v1/payment-methods/for-currency';
const ACTIVE_PAYMENT_METHODS_PATH = '/v1/payment-methods/all-active';

/** `MM/DD/YYYY` — what the invoice endpoint parses, and nothing else. */
const GATEWAY_DATE_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** Accepted as input and converted, because JavaScript dates arrive like this. */
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

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

export interface InitiateInvoiceOptions {
  /** Major units. */
  amount: number;
  currencyCode: string;
  /** What the invoice is for. The payer reads this. No HTML. */
  narrative: string;
  /** Who to bill. Both `name` and `email` are required. */
  payer: InvoicePayer;
  /**
   * Which of your applications owns the invoice. **Required** — the gateway
   * resolves it from this field and not from the integration key.
   */
  applicationCode: string;
  /**
   * When Pesepay sends the invoice to the payer. A `Date` (read in UTC), an
   * ISO `'YYYY-MM-DD'`, or the gateway's `'MM/DD/YYYY'`.
   */
  processingDate: Date | string;
  /** When payment is due. Same three accepted forms. */
  dueDate: Date | string;
  /** Regenerate the invoice on a schedule. Needs `recurringFrequency`. */
  recurring?: boolean | undefined;
  recurringFrequency?: RecurringFrequency | undefined;
  /** Your own identifier. The gateway rejects a duplicate. */
  initiatorReference?: string | undefined;
  /** Overrides {@link Pesepay.resultUrl} for this call only. */
  resultUrl?: string | undefined;
  /** Overrides {@link Pesepay.returnUrl} for this call only. */
  returnUrl?: string | undefined;
}

/**
 * A frozen {@link Invoice}. `invoiceNumber` is the handle for everything
 * afterwards — {@link Pesepay.checkInvoice} takes it, and `pollUrl` embeds it.
 */
export type InvoiceResult = Readonly<Invoice>;

/**
 * Request headers in Node's `IncomingHttpHeaders` shape. Express's `req.headers`
 * satisfies this, as does a plain object; names are matched case-insensitively.
 */
export type CallbackHeaders = Readonly<Record<string, string | string[] | undefined>>;

/**
 * Why {@link CallbackVerification.keyVerified} came out the way it did.
 *
 * - `'matched'` — the `Authorization` header held your integration key.
 * - `'mismatched'` — a header was present and held something else. Either a key
 *   you have since rotated, or a request that did not come from Pesepay.
 * - `'absent'` — no `Authorization` header at all. The gateway sends none when
 *   *its* lookup of your integration key fails, and posts the body regardless,
 *   so this is as likely to be a misconfiguration on your account as an
 *   unsolicited request.
 */
export type CallbackKeyStatus = 'matched' | 'mismatched' | 'absent';

/** What {@link Pesepay.parseCallback} returns. Frozen. */
export interface CallbackVerification {
  /** The decoded result, with `paid` and `isTerminal` derived as usual. */
  readonly result: PaymentResult;
  /**
   * `true` only when the header was present and matched, compared in constant
   * time. **Not** a signature: see {@link Pesepay.parseCallback}. Never act on
   * a callback without re-reading the transaction through
   * {@link Pesepay.checkPayment}, whatever this says.
   */
  readonly keyVerified: boolean;
  /** Which of the three cases produced `keyVerified`. */
  readonly keyStatus: CallbackKeyStatus;
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

  /**
   * The currencies your account can transact in.
   *
   * Plain JSON, and **not** encrypted — the `{ payload }` envelope covers
   * `/v1/payments/*` and `/v2/payments/*` only. This endpoint is also
   * `permitAll()` server-side, so no credential is sent with it; see
   * {@link Pesepay.getPaymentMethods} for why that is deliberate.
   *
   * Use it to populate a currency selector, and to fail early: a
   * `currencyCode` your account is not configured for is rejected at initiate
   * time, several steps further into a checkout than here.
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
   * Read three fields off each one before you charge it:
   *
   * - **`redirectRequired`** — when `true`, the method *cannot* be charged
   *   through {@link Pesepay.makeSeamlessPayment} at all. The customer must be
   *   sent to the hosted page via {@link Pesepay.initiateTransaction}. This is
   *   the single most useful field here, and there is no other way to know.
   * - **`requiredFields`** — what a seamless charge must collect. Each entry's
   *   `name` is the key to use in `requiredFields` on the request; its
   *   `displayName` is for your UI. Sending an incomplete set fails
   *   server-side, not here.
   * - **`minimumAmount` / `maximumAmount`** — checkable before the call rather
   *   than after.
   *
   * Plain JSON, not the envelope. **No credential is sent**: the gateway
   * declares this path, `/v1/payment-methods/all-active` and
   * `/v1/currencies/active` as `permitAll()`, so the integration key would buy
   * nothing, and a bearer credential is not worth sending to an endpoint that
   * does not ask for it. If Pesepay ever secures these, the call answers
   * `401`/`403` through {@link PesepayAuthError}, and this is the decision to
   * revisit.
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
   * This reads `/v1/payment-methods/all-active`, which is the only unsecured
   * endpoint returning the full `PaymentMethod` shape. The similarly named
   * `/v1/payment-methods/active` is **not** it: that one returns a reduced DTO
   * — name, code, accepted currencies, and required-field *names* only — and
   * silently drops every method whose `redirectRequired` is true, which makes
   * "this method does not exist" indistinguishable from "this method needs a
   * redirect".
   *
   * Prefer {@link Pesepay.getPaymentMethods} when you know the currency: each
   * method here still has to be filtered against its own `currencies` array
   * before it can be offered.
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
   * Creates an invoice: Pesepay emails the payer a payment link and collects
   * the money on your behalf.
   *
   * That is the difference from {@link Pesepay.initiateTransaction} — you do
   * not present a checkout, and there is no `redirectUrl` to send anyone to.
   * You get an `invoiceNumber` and a `pollUrl` back, and the payer gets an
   * email.
   *
   * Four things about this endpoint are unlike every other one here:
   *
   * 1. **`applicationCode` is required**, and this method enforces it. The
   *    gateway resolves the owning application from that field rather than
   *    from your integration key, and answers a `500` when it is absent.
   * 2. **Dates are `MM/DD/YYYY`**, parsed by a hand-written formatter rather
   *    than by Jackson, so ISO-8601 does not work on the wire. A `Date`, an
   *    ISO `'YYYY-MM-DD'` string, or the gateway's own `'MM/DD/YYYY'` are all
   *    accepted here and converted — a `Date` is read in **UTC**, because
   *    `new Date('2026-09-11')` is UTC midnight and reading local components
   *    would report the 10th anywhere west of Greenwich.
   * 3. **`initiatorReference` must be unique** across your invoices. A repeat
   *    is rejected server-side, which makes it a usable idempotency key.
   * 4. **The reply's `pollUrl` carries `?invoiceNumber=`**, not
   *    `?referenceNumber=`. It is still a valid argument to
   *    {@link Pesepay.pollTransaction}, which does not care.
   *
   * @throws {PesepayConfigError} A missing `applicationCode`, an unparseable
   *   date, a payer without a name or email, `recurring` without a frequency,
   *   or a missing `resultUrl`.
   */
  async initiateInvoice(options: InitiateInvoiceOptions): Promise<InvoiceResult> {
    const resultUrl = assertCallbackUrl(options.resultUrl ?? this.resultUrl, 'resultUrl');
    const returnUrl = options.returnUrl ?? this.returnUrl;
    if (returnUrl !== undefined) assertCallbackUrl(returnUrl, 'returnUrl');

    const recurringPayment = options.recurring === true;
    if (recurringPayment && options.recurringFrequency === undefined) {
      throw new PesepayConfigError(
        'recurringFrequency is required when recurring is true. The gateway asserts ' +
          'it with requireNonNull rather than validating it, so omitting it answers ' +
          '500 instead of a validation message.',
      );
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
   * Returns a {@link PaymentResult}, not an invoice: the gateway answers this
   * with the same `PaymentTransactionResult` that {@link Pesepay.checkPayment}
   * returns, because an invoice's `invoiceNumber` *is* the reference number of
   * the transaction created when the payer pays. So `paid` and `isTerminal`
   * mean exactly what they mean everywhere else.
   *
   * Equivalent to `pollTransaction(invoice.pollUrl)`, and preferable when all
   * you kept was the invoice number.
   */
  async checkInvoice(invoiceNumber: string): Promise<PaymentResult> {
    const invoice = assertNonBlank(invoiceNumber, 'invoiceNumber');

    const url = new URL(`${this.#baseUrl}${INVOICE_CHECK_PATH}`);
    url.searchParams.set('invoiceNumber', invoice);

    return this.pollTransaction(url.toString());
  }

  /**
   * Decodes the callback Pesepay POSTs to your `resultUrl`, and reports
   * whether the request carried your integration key.
   *
   * ## Read this before you credit anything
   *
   * **The callback is not authenticated.** There is no HMAC and no signature —
   * not a weak one, none. The only credential is an `Authorization` header
   * holding your integration key verbatim, and the gateway **omits that header
   * entirely** when its own key lookup fails, posting the body anyway. So a
   * `keyVerified: false` result is a body that anyone could have sent you.
   *
   * `keyVerified: true` proves only that the sender knew your integration key.
   * That is a shared secret you also put in an outbound header on every API
   * call, so it is evidence, not proof, and it says nothing at all about the
   * *contents* being untampered.
   *
   * **So: treat a callback as a hint that something changed, never as the fact
   * of payment.** The safe handler is short:
   *
   * ```ts
   * app.post('/pesepay/webhook', express.json(), async (req, res) => {
   *   // 1. Answer immediately. There are no retries — a slow or failing
   *   //    response loses the notification permanently.
   *   res.sendStatus(200);
   *
   *   const { result, keyVerified } = pesepay.parseCallback(req.body, req.headers);
   *   if (!keyVerified) log.warn('unverified pesepay callback', result.referenceNumber);
   *
   *   // 2. Re-verify over the authenticated, encrypted API before acting.
   *   const confirmed = await pesepay.checkPayment(result.referenceNumber);
   *
   *   // 3. Be idempotent on referenceNumber + transactionStatus.
   *   await creditOnce(confirmed.referenceNumber, confirmed.transactionStatus, confirmed);
   * });
   * ```
   *
   * Each numbered step answers a specific property of this gateway:
   *
   * - **No retries.** The server posts once, catches every exception, logs it,
   *   and moves on. A 500 from your handler, a timeout, a deploy mid-post — the
   *   notification is gone for good, and only polling recovers it. So never do
   *   work before responding.
   * - **Re-verify.** {@link Pesepay.checkPayment} is encrypted, authenticated
   *   by your key in an *outbound* header, and answered by the gateway. It is
   *   the only channel here that actually establishes what happened.
   * - **Idempotency is mandatory, not defensive.** The callback fires on every
   *   terminal status change, so a transaction that succeeds and is later
   *   reversed delivers **two** callbacks for one reference number — `SUCCESS`
   *   and then `REVERSED`. A handler keyed on `referenceNumber` alone either
   *   ignores the reversal or double-credits the success. Key on the pair.
   *
   * ## What it accepts
   *
   * The body as a parsed object (`express.json()`), a JSON string, or the raw
   * `Buffer`/`Uint8Array`. Unlike every other response from this gateway the
   * callback is **plain, unencrypted JSON** — not the `{ payload }` envelope —
   * so nothing here is decrypted, and a body that *is* an envelope is rejected
   * with that explanation rather than quietly mis-parsed.
   *
   * `headers` is optional and takes Node's `IncomingHttpHeaders` shape; lookup
   * is case-insensitive. Omitting it, or passing headers with no
   * `Authorization`, yields `keyVerified: false`. This never throws over a
   * missing header: the gateway genuinely sends none when its key lookup
   * fails, and a webhook endpoint that crashes on that is worse than one that
   * records it.
   *
   * @returns The decoded result, `keyVerified`, and a `keyStatus` separating
   *   the two ways verification fails. `'absent'` means the gateway could not
   *   find an integration key for the application — your problem, and a
   *   configuration one. `'mismatched'` means something presented the wrong
   *   key, which is either a stale key after a rotation or someone else
   *   entirely. Alert on them differently.
   * @throws {PesepayConfigError} If `body` is not a JSON object carrying a
   *   `referenceNumber` and a `transactionStatus`. Nothing that reaches that
   *   point should be treated as a transaction result.
   */
  parseCallback(body: unknown, headers?: CallbackHeaders): CallbackVerification {
    const record = decodeCallbackBody(body);

    const transactionStatus = readCallbackString(record, 'transactionStatus');
    // Not returned, just required: without it there is nothing to reconcile
    // against, re-verify with, or be idempotent on.
    readCallbackString(record, 'referenceNumber');

    const keyStatus = classifyPresentedKey(readAuthorization(headers), this.#integrationKey);

    return Object.freeze({
      result: derivePaymentResult(record, transactionStatus),
      keyVerified: keyStatus === 'matched',
      keyStatus,
    });
  }

  /**
   * One round trip with no cryptography at all: send, check the status, parse.
   *
   * The catalogue endpoints exchange plain JSON, so this is {@link #exchange}
   * with the encrypt and decrypt steps removed — and, deliberately, with no
   * `key` header. Status is still checked before anything else, for the same
   * reason: a failure body is plain JSON here too, and reporting it as "the
   * body was not an array" would bury the actual cause.
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

  return derivePaymentResult(record, transactionStatus);
}

/**
 * Freezes a decoded result and answers the two derived questions on it.
 *
 * Shared with `parseCallback`, which reaches a validated record by a different
 * route — the callback is plain JSON and never went through `#exchange` — and
 * must still produce an identical object. Splitting this is what keeps the
 * webhook path from drifting away from the polled path.
 */
function derivePaymentResult(
  record: Record<string, unknown>,
  transactionStatus: string,
): PaymentResult {
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

/**
 * Reads a catalogue array — currencies or payment methods.
 *
 * Only `code` is required of each entry, because `code` is the one field you
 * hand back to the gateway; everything else is presentational, and a method
 * that gains a field should not fail here. Each entry is frozen, matching
 * {@link PaymentResult}: a catalogue is a snapshot of what the gateway said.
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

  // The only field worth failing over: it is the poll parameter, and it is the
  // reference number the payer's transaction is eventually created under.
  readString(record, 'invoiceNumber', context);

  return Object.freeze(record) as InvoiceResult;
}

/**
 * Turns the gateway's `MM/dd/yyyy` requirement into something callable from
 * JavaScript, where a calendar date is almost never already in that shape.
 *
 * A `Date` is read in **UTC**. That is the load-bearing choice: `new
 * Date('2026-09-11')` and `JSON.parse` of an ISO date both produce UTC
 * midnight, and reading local components off those gives the previous day for
 * every caller west of Greenwich — a due date silently one day early, which
 * nothing downstream would flag.
 */
function toServerDate(value: Date | string, label: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new PesepayConfigError(
        `${label} is an Invalid Date. Whatever produced it did not parse, and the ` +
          'gateway would receive "NaN/NaN/NaN".',
      );
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
    `${label} must be a Date, an ISO "YYYY-MM-DD" string, or the gateway's own ` +
      `"MM/DD/YYYY" string, but is "${String(value)}". Pesepay parses invoice dates ` +
      'with a hand-written MM/dd/yyyy formatter rather than with Jackson, so an ' +
      'ISO-8601 string passed straight through is rejected server-side.',
  );
}

/** Rejects 2026-02-30 and friends, which `Date.UTC` would silently roll over. */
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
    throw new PesepayConfigError(
      `${label} is not a real calendar date: "${raw}". Date arithmetic would roll it ` +
        'over to a different day rather than reject it, so it is rejected here.',
    );
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
      'payer must carry both a name and an email address. Pesepay delivers the ' +
        'invoice to the payer by email, so one without a deliverable address is ' +
        'never presented to anybody, and both are non-null columns server-side.',
    );
  }

  return payer;
}

function assertApplicationCode(applicationCode: string): string {
  if (typeof applicationCode !== 'string' || applicationCode.trim() === '') {
    throw new PesepayConfigError(
      'applicationCode is required for an invoice. Unlike every other endpoint in ' +
        'this SDK, the gateway resolves the owning application from this field ' +
        'rather than from your integration key, and answers 500 rather than a ' +
        'validation message when it is missing.',
    );
  }

  return applicationCode;
}

/**
 * Accepts the three shapes a webhook body arrives in — a parsed object, a JSON
 * string, or the raw bytes — and refuses everything else by name, because the
 * alternative is a webhook handler that silently treats garbage as a payment.
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
          'carries no content-type it recognises.',
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
      `the body was not a JSON object (it was ${describeType(body)}). The callback is ` +
        'a PaymentTransactionResult; pass req.body, the raw string, or the raw Buffer',
    );
  }

  // A body that is an envelope means something upstream is wrong, and saying so
  // is worth more than "it has no referenceNumber". Every *other* payments
  // endpoint is enveloped, so this is a natural mistake to make.
  if (typeof record.payload === 'string' && Object.keys(record).length === 1) {
    throw callbackError(
      'the body is a { "payload": "…" } envelope, but the callback is never ' +
        'encrypted — the gateway POSTs a plain PaymentTransactionResult to your ' +
        'resultUrl. Something has re-wrapped it, or this is a response from an API ' +
        'call rather than a callback.',
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

/** Phrases a rejected body's type with its article, for the error message. */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * Finds the `Authorization` header whatever case it arrived in.
 *
 * A repeated header reaches Node as an array. More than one `Authorization` is
 * not something the gateway sends, so rather than picking one and comparing it,
 * the whole thing is treated as absent — the merged case is exactly the shape a
 * header-injection attempt takes, and "no key was presented" is the honest
 * reading of it.
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
 * `timingSafeEqual` throws outright on operands of different lengths, so the
 * naive version needs a length check in front of it — and that check both
 * short-circuits and tells an attacker the key's length, which is the first
 * thing they would want. Hashing each side to a fixed 32 bytes removes the
 * length signal completely and leaves one constant-time comparison over equal
 * buffers. The hash is not for secrecy; it is for making both operands the same
 * size no matter what was presented.
 *
 * The comparison is verbatim — no `Bearer` prefix is stripped and nothing is
 * trimmed, because the gateway sets the header to the raw integration key, and
 * leniency here would only widen what counts as a match.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const left = createHash('sha256').update(presented, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right);
}
