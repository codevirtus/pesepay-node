/**
 * The wire contract.
 *
 * Every shape here was read off the Java server in `pesepay-payments-engine`
 * rather than inferred from v1's code or from the public docs, both of which
 * are incomplete. Where the server and the documentation disagree, these types
 * follow the server.
 *
 * Two conventions worth knowing before reading on:
 *
 * - **Requests are the SDK's shape; responses are the gateway's shape.** Types
 *   named `*Request` are what you hand this package. Types named `*Response` or
 *   `*Result` are decoded JSON from the gateway and are therefore permissive:
 *   fields the server declares nullable are optional here, because they really
 *   do arrive as `null`.
 * - **Only the payment endpoints are encrypted.** `/v1/payments/*` and
 *   `/v2/payments/*` exchange {@link EncryptedEnvelope}. Currencies and payment
 *   methods are plain JSON. Errors are *always* plain JSON, in both cases.
 *
 * @packageDocumentation
 */

import type { TransactionStatus } from './status.js';

/**
 * The `{ "payload": "<base64>" }` wrapper used by the payment endpoints, in
 * both directions.
 *
 * The server calls this `TransactionDetailsHolder`. Its single field is the
 * base64 of the AES-256-CBC ciphertext of a JSON document — see `crypto.ts`.
 */
export interface EncryptedEnvelope {
  /** Base64 AES-256-CBC ciphertext of a JSON document. */
  payload: string;
}

/**
 * The gateway's error body.
 *
 * Plain JSON, never encrypted — which is why a failed request can be reported
 * usefully even when the encryption key is the thing that is wrong.
 * `message` is genuinely nullable on the server.
 */
export interface PesepayErrorBody {
  timestamp?: string | null;
  message?: string | null;
  description?: string | null;
  status?: number | null;
}

/** Amount and currency, as sent on a request. */
export interface AmountRequest {
  /** The amount, in major units (e.g. `10.5` is ten dollars fifty). */
  amount: number;
  /** ISO-4217-style code as configured on your Pesepay account, e.g. `'USD'`. */
  currencyCode: string;
}

/**
 * Amount details as returned by the gateway.
 *
 * The gateway computes the fee split; it does not echo back only what you sent.
 * `amount` is what you asked for, `customerPayableAmount` is what the customer
 * is actually charged once fees are applied, and `merchantAmount` is what
 * settles to you. Reconcile against `merchantAmount`, not `amount`.
 */
export interface AmountDetails {
  amount: number;
  currencyCode: string;
  /** The same amount converted into the account's default currency. */
  defaultCurrencyAmount?: number;
  defaultCurrencyCode?: string;
  transactionServiceFee?: number;
  /** What the customer pays, including fees, when fees are charged to them. */
  customerPayableAmount?: number;
  totalTransactionAmount?: number;
  /** What settles to the merchant. Reconcile against this. */
  merchantAmount?: number;
}

/**
 * Customer identification for a seamless payment.
 *
 * At least one of `email` or `phoneNumber` must be present, and the object
 * itself is **not optional** in practice: the server dereferences `customer`
 * without a null check, so omitting it yields a 500 NPE rather than a
 * validation error.
 */
export interface CustomerDetails {
  email?: string;
  phoneNumber?: string;
  name?: string;
}

/** The transaction types the gateway recognises. */
export type TransactionType = 'BASIC' | 'INVOICE';

/**
 * Body of `POST /v1/payments/initiate`, before encryption.
 *
 * The server calls this `CreateTransactionCommand`. Note that it **silently
 * substitutes the string `"NONE"`** for a missing or blank `resultUrl` or
 * `returnUrl` rather than rejecting the request, so a typo'd URL produces a
 * transaction you will never be told the outcome of.
 */
export interface CreateTransactionRequest {
  amountDetails: AmountRequest;
  reasonForPayment: string;
  /** Your own identifier, echoed back on the result. */
  merchantReference?: string;
  transactionType?: TransactionType;
  /** Where the gateway POSTs the result. Blank becomes `"NONE"` server-side. */
  resultUrl?: string;
  /** Where the customer is sent after paying. Blank becomes `"NONE"`. */
  returnUrl?: string;
  /** Pre-selects a payment method, skipping the method picker. */
  paymentMethodCode?: string;
  /** Free-form string map echoed back as `transactionMetadata` on the result. */
  paymentMetadata?: Record<string, string>;
}

/** Decrypted body of a successful `POST /v1/payments/initiate`. */
export interface InitiateTransactionResponse {
  /** The gateway's identifier. Everything afterwards keys off this. */
  referenceNumber: string;
  /** Poll this for status. Already carries `?referenceNumber=…`. */
  pollUrl: string;
  /** Send the customer here to pay. */
  redirectUrl: string;
}

/**
 * Body of `POST /v2/payments/make-payment`, before encryption.
 *
 * The server calls this `SeamlessPaymentContext`. "Seamless" means the customer
 * never leaves your site: you collect the payment details yourself and the
 * gateway charges them directly, so there is no `redirectUrl` in the response.
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

/**
 * A reversal leg attached to a {@link PaymentTransactionResult}.
 *
 * Only populated for split transactions; empty for ordinary ones.
 */
export interface SplitReversalResponse {
  referenceNumber?: string;
  amount?: number;
  currencyCode?: string;
  [key: string]: unknown;
}

/**
 * The decrypted transaction result — the payload of a poll, a check, a seamless
 * payment, and of the webhook POSTed to your `resultUrl`.
 *
 * The server calls this `PaymentTransactionResult`. The field that matters is
 * {@link transactionStatus}: it carries one of 17 values, not a boolean.
 * `transactionStatusCode` is **not** a usable discriminator — `CLOSED` and
 * `CLOSED_PERIOD_ELAPSED` are both `307`.
 *
 * Note there is no `redirectUrl`: the server declares one but has it commented
 * out, so it never appears on the wire. The redirect URL exists only on
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
   * One of 17 values. Typed as the union *or* `string`, because the gateway can
   * add a value before this package does and an unknown status must not become
   * a type error in your code. Compare with `isTerminal()` / `isPaid()`.
   */
  transactionStatus: TransactionStatus | (string & Record<never, never>);
  /** Not unique — see {@link TRANSACTION_STATUS_CODES}. */
  transactionStatusCode?: number;
  transactionStatusDescription?: string;
  resultUrl?: string;
  returnUrl?: string;
  pollUrl?: string;
  /** Whatever you sent as `paymentMetadata`, echoed back. */
  transactionMetadata?: Record<string, string>;
  splits?: SplitReversalResponse[];
}

/** Field types a payment method can require. */
export type RequiredFieldType = 'TEXT' | 'NUMBER' | 'FILE' | 'DATE';

/**
 * One input a payment method needs before it can be charged.
 *
 * Pass the collected values as
 * {@link SeamlessPaymentRequest.paymentMethodRequiredFields}, keyed by
 * {@link name} — `displayName` is for your UI, not for the wire.
 */
export interface RequiredField {
  /** Wire key. This is what belongs in `paymentMethodRequiredFields`. */
  name: string;
  /** Human-facing label. */
  displayName?: string;
  fieldType?: RequiredFieldType;
  /** When `true`, the gateway accepts the payment without this field. */
  optional?: boolean;
}

/** A currency configured on the account, from `GET /v1/currencies/active`. */
export interface Currency {
  name: string;
  description?: string;
  /** The value to put in `currencyCode`. */
  code: string;
  /** Exactly one currency on an account has this set. */
  defaultCurrency?: boolean;
  rateToDefault?: number;
  active?: boolean;
}

/** A payment method, from `GET /v1/payment-methods/for-currency`. */
export interface PaymentMethod {
  name: string;
  description?: string;
  /** The value to put in `paymentMethodCode`. */
  code: string;
  /** Reject an amount above this before calling the gateway. */
  maximumAmount?: number;
  /** Reject an amount below this before calling the gateway. */
  minimumAmount?: number;
  /**
   * When `true`, this method cannot be charged seamlessly — the customer must
   * be sent to the hosted payment page.
   */
  redirectRequired?: boolean;
  redirectURL?: string;
  active?: boolean;
  /** What a seamless charge must collect. See {@link RequiredField}. */
  requiredFields?: RequiredField[];
  /** Currency codes this method accepts. */
  currencies?: string[];
  /** Message to show the customer while the charge is in flight. */
  processingPaymentMessage?: string;
  imageFileName?: string;
}

/** Lifecycle of an invoice. */
export type InvoiceStatus =
  | 'OPEN'
  | 'PAID'
  | 'PAYMENT_FAILED'
  | 'CANCELLED'
  | 'PAYMENT_CANCELED_BY_PAYER';
