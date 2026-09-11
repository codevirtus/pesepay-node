/**
 * The wire contract, read off the Java server in `pesepay-payments-engine`
 * rather than from v1's code or the public docs, both of which are incomplete.
 * Where the server and the documentation disagree, these types follow the
 * server.
 *
 * `*Request` types are what you hand this package. `*Response` and `*Result`
 * types are decoded JSON from the gateway, so fields the server declares
 * nullable are optional here.
 *
 * Only the payment endpoints are encrypted: `/v1/payments/*` and
 * `/v2/payments/*` exchange {@link EncryptedEnvelope}, while currencies and
 * payment methods are plain JSON. Errors are always plain JSON either way.
 *
 * @packageDocumentation
 */

import type { TransactionStatus } from './status.js';

/**
 * The `{ "payload": "<base64>" }` wrapper the payment endpoints use in both
 * directions. The server calls it `TransactionDetailsHolder`.
 */
export interface EncryptedEnvelope {
  /** Base64 AES-256-CBC ciphertext of a JSON document. */
  payload: string;
}

/**
 * The gateway's error body — plain JSON, never encrypted, which is why a failed
 * request is still reportable when the encryption key is the thing that is
 * wrong. `message` is genuinely nullable on the server.
 */
export interface PesepayErrorBody {
  timestamp?: string | null;
  message?: string | null;
  description?: string | null;
  status?: number | null;
}

export interface AmountRequest {
  /** In major units — `10.5` is ten dollars fifty. */
  amount: number;
  /** As configured on your Pesepay account, e.g. `'USD'`. */
  currencyCode: string;
}

/**
 * Amount details as returned by the gateway, which computes the fee split
 * rather than echoing what you sent. `amount` is what you asked for,
 * `customerPayableAmount` what the customer is charged, and `merchantAmount`
 * what settles to you — reconcile against that one.
 */
export interface AmountDetails {
  amount: number;
  currencyCode: string;
  defaultCurrencyAmount?: number;
  defaultCurrencyCode?: string;
  transactionServiceFee?: number;
  customerPayableAmount?: number;
  totalTransactionAmount?: number;
  merchantAmount?: number;
}

/**
 * At least one of `email` or `phoneNumber` must be present, and the object
 * itself is not optional in practice: the server dereferences `customer`
 * without a null check, so omitting it yields a 500 NPE.
 */
export interface CustomerDetails {
  email?: string;
  phoneNumber?: string;
  name?: string;
}

export type TransactionType = 'BASIC' | 'INVOICE';

/**
 * Body of `POST /v1/payments/initiate`, before encryption. The server calls it
 * `CreateTransactionCommand`, and **silently substitutes the string `"NONE"`**
 * for a missing or blank `resultUrl`/`returnUrl` rather than rejecting it — so
 * a typo'd URL yields a transaction whose outcome you are never told.
 */
export interface CreateTransactionRequest {
  amountDetails: AmountRequest;
  reasonForPayment: string;
  /** Your own identifier, echoed back on the result. */
  merchantReference?: string;
  transactionType?: TransactionType;
  resultUrl?: string;
  returnUrl?: string;
  /** Pre-selects a payment method, skipping the method picker. */
  paymentMethodCode?: string;
  /** Echoed back as `transactionMetadata` on the result. */
  paymentMetadata?: Record<string, string>;
}

/** Decrypted body of a successful `POST /v1/payments/initiate`. */
export interface InitiateTransactionResponse {
  referenceNumber: string;
  /** Already carries `?referenceNumber=…`. */
  pollUrl: string;
  /** Send the customer here to pay. */
  redirectUrl: string;
}

/**
 * Body of `POST /v2/payments/make-payment`, before encryption. The server calls
 * it `SeamlessPaymentContext`. "Seamless" means the customer never leaves your
 * site — you collect the payment details and the gateway charges directly — so
 * there is no `redirectUrl` in the response.
 */
export interface SeamlessPaymentRequest {
  amountDetails: AmountRequest;
  reasonForPayment: string;
  paymentMethodCode: string;
  /** Required in practice — see {@link CustomerDetails}. */
  customer: CustomerDetails;
  merchantReference?: string;
  resultUrl?: string;
  /** Defaults to `resultUrl` server-side when blank. */
  returnUrl?: string;
  /**
   * Values for the fields {@link PaymentMethod.requiredFields} declares, keyed
   * by the field's `name` — e.g. `{ customerPhoneNumber: '0771111111' }`.
   */
  paymentMethodRequiredFields?: Record<string, string>;
  paymentMetadata?: Record<string, string>;
}

/** A reversal leg. Only populated for split transactions. */
export interface SplitReversalResponse {
  referenceNumber?: string;
  amount?: number;
  currencyCode?: string;
  [key: string]: unknown;
}

/**
 * The decrypted transaction result — payload of a poll, a check, a seamless
 * payment, and of the webhook POSTed to your `resultUrl`. The server calls it
 * `PaymentTransactionResult`.
 *
 * There is no `redirectUrl` here: the server declares one but has it commented
 * out, so it never reaches the wire. It exists only on
 * {@link InitiateTransactionResponse}.
 */
export interface PaymentTransactionResult {
  referenceNumber: string;
  /** ISO-8601 as serialised by Jackson. */
  dateOfTransaction?: string;
  applicationId?: number;
  applicationName?: string;
  amountDetails?: AmountDetails;
  reasonForPayment?: string;
  /**
   * One of 17 values. Typed as the union *or* `string`, so a value the gateway
   * adds before this package does is not a type error in your code. Compare
   * with `isTerminal()` / `isPaid()`.
   */
  transactionStatus: TransactionStatus | (string & Record<never, never>);
  /** Not unique — `CLOSED` and `CLOSED_PERIOD_ELAPSED` are both `307`. */
  transactionStatusCode?: number;
  transactionStatusDescription?: string;
  resultUrl?: string;
  returnUrl?: string;
  pollUrl?: string;
  /** Whatever you sent as `paymentMetadata`. */
  transactionMetadata?: Record<string, string>;
  splits?: SplitReversalResponse[];
}

export type RequiredFieldType = 'TEXT' | 'NUMBER' | 'FILE' | 'DATE';

/** One input a payment method needs before it can be charged. */
export interface RequiredField {
  /** Wire key — this is what belongs in `paymentMethodRequiredFields`. */
  name: string;
  /** Human-facing label, for your UI rather than the wire. */
  displayName?: string;
  fieldType?: RequiredFieldType;
  optional?: boolean;
}

/** From `GET /v1/currencies/active`. */
export interface Currency {
  name: string;
  description?: string;
  /** The value to put in `currencyCode`. */
  code: string;
  defaultCurrency?: boolean;
  rateToDefault?: number;
  active?: boolean;
}

/** From `GET /v1/payment-methods/for-currency`. */
export interface PaymentMethod {
  name: string;
  description?: string;
  /** The value to put in `paymentMethodCode`. */
  code: string;
  /** Check the amount against these before calling the gateway. */
  maximumAmount?: number;
  minimumAmount?: number;
  /**
   * When `true`, this method cannot be charged seamlessly — the customer must
   * be sent to the hosted payment page.
   */
  redirectRequired?: boolean;
  redirectURL?: string;
  active?: boolean;
  /** What a seamless charge must collect. */
  requiredFields?: RequiredField[];
  /** Currency codes this method accepts. */
  currencies?: string[];
  /** Show this to the customer while the charge is in flight. */
  processingPaymentMessage?: string;
  imageFileName?: string;
}

export type InvoiceStatus =
  | 'OPEN'
  | 'PAID'
  | 'PAYMENT_FAILED'
  | 'CANCELLED'
  | 'PAYMENT_CANCELED_BY_PAYER';
