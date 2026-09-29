/**
 * The Pesepay API's request and response shapes.
 *
 * `*Request` types are what this package sends. `*Response` and `*Result`
 * types are decoded JSON from Pesepay, so fields that may be missing are
 * optional here.
 *
 * Only the payment endpoints are encrypted: `/v1/payments/*` and
 * `/v2/payments/*` exchange {@link EncryptedEnvelope}, while currencies and
 * payment methods are plain JSON. Errors are always plain JSON.
 *
 * @packageDocumentation
 */

import type { TransactionStatus } from './status.js';

/** The `{ "payload": "<base64>" }` wrapper the payment endpoints use in both directions. */
export interface EncryptedEnvelope {
  /** Base64 AES-256-CBC ciphertext of a JSON document. */
  payload: string;
}

/** An error response body. Plain JSON, never encrypted. */
export interface PesepayErrorBody {
  timestamp?: string | null;
  message?: string | null;
  description?: string | null;
  status?: number | null;
}

export interface AmountRequest {
  /** In major units: `10.5` is ten dollars fifty. */
  amount: number;
  /** As configured on your Pesepay account, for example `'USD'`. */
  currencyCode: string;
}

/**
 * Amount details as returned by Pesepay. `amount` is what you asked for,
 * `customerPayableAmount` what the customer is charged, and `merchantAmount`
 * what you receive. Reconcile against `merchantAmount`.
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

/** A seamless payment's customer. At least one of `email` or `phoneNumber` is required. */
export interface CustomerDetails {
  email?: string;
  phoneNumber?: string;
  name?: string;
}

export type TransactionType = 'BASIC' | 'INVOICE';

/** Body of `POST /v1/payments/initiate`, before encryption. */
export interface CreateTransactionRequest {
  amountDetails: AmountRequest;
  reasonForPayment: string;
  /** Your own identifier, returned on the result. */
  merchantReference?: string;
  transactionType?: TransactionType;
  resultUrl?: string;
  returnUrl?: string;
  /** Pre-selects a payment method, skipping the method picker. */
  paymentMethodCode?: string;
  /** Returned as `transactionMetadata` on the result. */
  paymentMetadata?: Record<string, string>;
}

/** Decrypted body of a successful `POST /v1/payments/initiate`. */
export interface InitiateTransactionResponse {
  referenceNumber: string;
  /** Already includes `?referenceNumber=…`. */
  pollUrl: string;
  /** Send the customer here to pay. */
  redirectUrl: string;
}

/**
 * Body of `POST /v2/payments/make-payment`, before encryption. The customer
 * stays on your site, so there is no `redirectUrl` in the response.
 */
export interface SeamlessPaymentRequest {
  amountDetails: AmountRequest;
  reasonForPayment: string;
  paymentMethodCode: string;
  /** Required. See {@link CustomerDetails}. */
  customer: CustomerDetails;
  merchantReference?: string;
  resultUrl?: string;
  /** Defaults to `resultUrl` when blank. */
  returnUrl?: string;
  /**
   * Values for the fields {@link PaymentMethod.requiredFields} lists, keyed by
   * the field's `name`, for example `{ customerPhoneNumber: '0771111111' }`.
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
 * A transaction result: the response to a poll, a check or a seamless payment,
 * and the body of the notification sent to your `resultUrl`.
 *
 * There is no `redirectUrl` here. Only {@link InitiateTransactionResponse}
 * has one.
 */
export interface PaymentTransactionResult {
  referenceNumber: string;
  /** ISO-8601. */
  dateOfTransaction?: string;
  applicationId?: number;
  applicationName?: string;
  amountDetails?: AmountDetails;
  reasonForPayment?: string;
  /**
   * One of 17 values. Typed as the union *or* `string`, so a status added
   * later is not a type error in your code. Check it with `isTerminal()` and
   * `isPaid()`.
   */
  transactionStatus: TransactionStatus | (string & Record<never, never>);
  /** Not unique: `CLOSED` and `CLOSED_PERIOD_ELAPSED` are both `307`. */
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
  /** The key to use in `paymentMethodRequiredFields`. */
  name: string;
  /** A label for your UI. */
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
  /** Check the amount against these before creating a payment. */
  maximumAmount?: number;
  minimumAmount?: number;
  /**
   * When `true`, this method can't be charged seamlessly: the customer must
   * use Pesepay's payment page.
   */
  redirectRequired?: boolean;
  redirectURL?: string;
  active?: boolean;
  /** What a seamless payment must collect. */
  requiredFields?: RequiredField[];
  /** Currency codes this method accepts. */
  currencies?: string[];
  /** Show this to the customer while the payment is in progress. */
  processingPaymentMessage?: string;
  imageFileName?: string;
}

export type InvoiceStatus =
  | 'OPEN'
  | 'PAID'
  | 'PAYMENT_FAILED'
  | 'CANCELLED'
  | 'PAYMENT_CANCELED_BY_PAYER';

/** How often a recurring invoice is reissued. `EVERY_YEARLY` is the API's spelling. */
export type RecurringFrequency =
  | 'DAILY'
  | 'EVERY_MONTH'
  | 'EVERY_THREE_MONTHS'
  | 'EVERY_FOUR_MONTHS'
  | 'EVERY_SIX_MONTHS'
  | 'EVERY_YEARLY';

/**
 * Who the invoice is addressed to. `name` and `email` are required;
 * `phoneNumber` is optional. Pesepay emails the payment link to the payer.
 */
export interface InvoicePayer {
  name: string;
  email: string;
  phoneNumber?: string;
}

/**
 * Body of `POST /v1/payments/invoice/initiate`, before encryption.
 *
 * - **`currencyCode` is a string here**, but the response has a full
 *   `currency` object instead.
 * - **Dates are `MM/DD/YYYY`**, not ISO-8601.
 */
export interface CreateInvoiceRequest {
  payer: InvoicePayer;
  amount: number;
  /** What the invoice is for. Shown to the payer. Must not contain HTML. */
  narrative: string;
  /** Just the code, for example `'USD'`. */
  currencyCode: string;
  /** The code of the application that owns the invoice. Required. */
  applicationCode?: string;
  /** `MM/DD/YYYY`. When Pesepay should send the invoice to the payer. */
  processingDate: string;
  /** `MM/DD/YYYY`. */
  dueDate: string;
  recurringPayment?: boolean;
  /** Required when `recurringPayment` is `true`. */
  recurringFrequency?: RecurringFrequency;
  resultUrl?: string;
  returnUrl?: string;
  /** Your own identifier. Must be unique. */
  initiatorReference?: string;
}

/**
 * The decrypted body of a successful `POST /v1/payments/invoice/initiate`.
 *
 * The response carries more fields than are listed here; only the ones worth
 * relying on are named, and the rest are kept under the index signature.
 */
export interface Invoice {
  /**
   * The invoice's identifier. It is also the reference number of the payer's
   * transaction, and it is what `pollUrl` looks up.
   */
  invoiceNumber: string;
  /** Includes `?invoiceNumber=…`, not `?referenceNumber=`. */
  pollUrl?: string;
  invoiceStatus?: InvoiceStatus;
  /** Returned from the request. */
  initiatorReference?: string;
  amount?: number;
  narrative?: string;
  /** The full currency record, not the code you sent. */
  currency?: Currency;
  payer?: InvoicePayer;
  /** `MM/DD/YYYY`, the same format the request uses. */
  processingDate?: string;
  dueDate?: string;
  recurringPayment?: boolean;
  recurringFrequency?: RecurringFrequency;
  processed?: boolean;
  cancelled?: boolean;
  reasonForCancellation?: string;
  cancelledBy?: string;
  payerNotified?: boolean;
  resultUrl?: string;
  returnUrl?: string;
  /** An internal identifier. Not the `invoiceNumber`. */
  id?: string;
  [key: string]: unknown;
}
