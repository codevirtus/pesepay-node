/**
 * Official Node.js SDK for the Pesepay payment gateway.
 *
 * Server-side only: this package handles your integration and encryption keys.
 *
 * ```ts
 * import { Pesepay, isTerminal, PesepayTimeoutError } from 'pesepay';
 * ```
 *
 * Migrating from 1.x? `require('pesepay/v1-compat')` keeps the old surface.
 *
 * @packageDocumentation
 */

export type {
  CallbackHeaders,
  CallbackKeyStatus,
  CallbackVerification,
  InitiateInvoiceOptions,
  InitiateTransactionOptions,
  InvoiceResult,
  PaymentResult,
  PesepayOptions,
  SeamlessPaymentOptions,
} from './client.js';
export {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  Pesepay,
} from './client.js';
export type { PesepayApiErrorInit, PesepayErrorCode } from './errors.js';
export {
  PesepayApiError,
  PesepayAuthError,
  PesepayConfigError,
  PesepayCryptoError,
  PesepayError,
  PesepayNetworkError,
  PesepayTimeoutError,
} from './errors.js';
export type {
  HttpsTransportOptions,
  Transport,
  TransportMethod,
  TransportRequest,
  TransportResponse,
} from './internal/transport.js';
/**
 * The HTTP seam. Supply your own `Transport` to route through a proxy, add
 * retries or instrumentation, or drive the client from a test double.
 *
 * `encryptPayload` / `decryptPayload` stay internal on purpose: raw AES-256-CBC
 * with no integrity protection is not a primitive to hand out, and nothing in
 * the public API needs it.
 */
export { createHttpsTransport, httpsTransport } from './internal/transport.js';
export {
  isPaid,
  isTerminal,
  isTransactionStatus,
  NON_TERMINAL_TRANSACTION_STATUSES,
  TERMINAL_TRANSACTION_STATUSES,
  TRANSACTION_STATUS_CODES,
  TRANSACTION_STATUS_DESCRIPTIONS,
  TransactionStatus,
} from './status.js';
/**
 * The wire types the gateway sends back, plus the two it accepts by name.
 *
 * The `*Request` shapes — `CreateTransactionRequest`, `SeamlessPaymentRequest`,
 * `CreateInvoiceRequest` — and `EncryptedEnvelope` and `AmountRequest` are
 * deliberately **not** exported. No public method takes one; they are built
 * from the `*Options` types, and publishing them would advertise an input
 * format that is not an input, while pinning this package to the gateway's
 * request shape as a compatibility promise.
 */
export type {
  AmountDetails,
  Currency,
  CustomerDetails,
  InitiateTransactionResponse,
  Invoice,
  InvoicePayer,
  InvoiceStatus,
  PaymentMethod,
  PaymentTransactionResult,
  PesepayErrorBody,
  RecurringFrequency,
  RequiredField,
  RequiredFieldType,
  SplitReversalResponse,
  TransactionType,
} from './types.js';

/** The SDK version, as published to npm. */
export const VERSION: string = '2.0.0';
