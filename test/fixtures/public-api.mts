/**
 * The documented public surface — the authoritative list.
 *
 * Two tests read it, and they check opposite directions of the same promise:
 * `test/dist/exports.test.mts` asserts every name here exists in both the CJS
 * and the ESM flavours, and `test/docs/snippets.test.mts` asserts the markdown
 * imports nothing that is *not* here. A name the docs need must be added to
 * `src/index.ts` and to this file together, or one of the two fails.
 */

/** Values the documentation may reference. */
export const PUBLIC_VALUES = [
  'DEFAULT_BASE_URL',
  'DEFAULT_TIMEOUT_MS',
  'NON_TERMINAL_TRANSACTION_STATUSES',
  'Pesepay',
  'PesepayApiError',
  'PesepayAuthError',
  'PesepayConfigError',
  'PesepayCryptoError',
  'PesepayError',
  'PesepayNetworkError',
  'PesepayTimeoutError',
  'TERMINAL_TRANSACTION_STATUSES',
  'TRANSACTION_STATUS_CODES',
  'TRANSACTION_STATUS_DESCRIPTIONS',
  'TransactionStatus',
  'VERSION',
  'createHttpsTransport',
  'httpsTransport',
  'isPaid',
  'isTerminal',
  'isTransactionStatus',
] as const;

/** Types the documentation may reference. Declarations are their reference. */
export const PUBLIC_TYPES = [
  'AmountDetails',
  'CallbackHeaders',
  'CallbackKeyStatus',
  'CallbackVerification',
  'Currency',
  'CustomerDetails',
  'HttpsTransportOptions',
  'InitiateInvoiceOptions',
  'InitiateTransactionOptions',
  'InitiateTransactionResponse',
  'Invoice',
  'InvoicePayer',
  'InvoiceResult',
  'InvoiceStatus',
  'PaymentMethod',
  'PaymentResult',
  'PaymentTransactionResult',
  'PesepayApiErrorInit',
  'PesepayErrorBody',
  'PesepayErrorCode',
  'PesepayOptions',
  'RecurringFrequency',
  'RequiredField',
  'RequiredFieldType',
  'SeamlessPaymentOptions',
  'SplitReversalResponse',
  'TransactionType',
  'Transport',
  'TransportMethod',
  'TransportRequest',
  'TransportResponse',
] as const;

/** v1's surface, as `pesepay/v1-compat` must present it. */
export const V1_COMPAT_VALUES = [
  'ALGORITHM',
  'Amount',
  'BASE_URL',
  'CHECK_PAYMENT_URL',
  'Customer',
  'INITIATE_PAYMENT_URL',
  'MAKE_SEAMLESS_PAYMENT_URL',
  'Payment',
  'Pesepay',
  'PesepayResponse',
  'Transaction',
  'V1_COMPAT',
] as const;
