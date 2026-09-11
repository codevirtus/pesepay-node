/**
 * Transaction statuses, mirrored from the gateway's `TransactionStatus` enum
 * (`pesepay-cloud-utilities/payments/.../TransactionStatus.java`).
 *
 * v1 reduced all 17 to `paid: transactionStatus == 'SUCCESS'`, so a merchant
 * could not tell `PENDING` (keep waiting) from `DECLINED` (stop, tell the
 * customer) from `REVERSED` (you were paid, then un-paid).
 *
 * @packageDocumentation
 */

/**
 * Every status the gateway can report.
 *
 * A `const` object rather than an `enum`: the build runs with
 * `erasableSyntaxOnly`, which forbids `enum` — and for a public API this is the
 * better shape anyway, since it survives JSON round-trips and compares equal to
 * the raw string off the wire.
 */
export const TransactionStatus = {
  /** Created, no payment attempt yet. */
  INITIATED: 'INITIATED',
  /** Handed to the payment provider. */
  PROCESSING: 'PROCESSING',
  /** Awaiting the customer — e.g. an unconfirmed mobile-money prompt. */
  PENDING: 'PENDING',
  /** Some of the amount has been received. Still in flight. */
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  /** Paid in full. The only status that means you have the money. */
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  /** Ended by the gateway. */
  TERMINATED: 'TERMINATED',
  /** The provider did not answer in time. */
  TIME_OUT: 'TIME_OUT',
  /** Shares code 307 with {@link TransactionStatus.CLOSED_PERIOD_ELAPSED}. */
  CLOSED: 'CLOSED',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  CANCELLED: 'CANCELLED',
  ERROR: 'ERROR',
  /** Declined by the service provider. */
  DECLINED: 'DECLINED',
  /** The customer's provider refused authorisation. */
  AUTHORIZATION_FAILED: 'AUTHORIZATION_FAILED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /**
   * A previously successful payment was reversed. Fires a **second** callback
   * for a reference that already reported `SUCCESS`, which is why webhook
   * handlers must be idempotent on `referenceNumber` + `transactionStatus`
   * rather than on the reference alone.
   */
  REVERSED: 'REVERSED',
  /** Closed because the payment window elapsed. Also code 307. */
  CLOSED_PERIOD_ELAPSED: 'CLOSED_PERIOD_ELAPSED',
} as const;

export type TransactionStatus = (typeof TransactionStatus)[keyof typeof TransactionStatus];

/**
 * The statuses meaning "still in flight" — keep polling.
 *
 * Defined in this direction on purpose: a status the gateway adds later is
 * then treated as terminal, which stops a poll loop, rather than as pending,
 * which would spin forever.
 */
export const NON_TERMINAL_TRANSACTION_STATUSES: ReadonlySet<TransactionStatus> = new Set([
  TransactionStatus.INITIATED,
  TransactionStatus.PROCESSING,
  TransactionStatus.PENDING,
  TransactionStatus.PARTIALLY_PAID,
]);

/** The 13 statuses from which a transaction never moves again. */
export const TERMINAL_TRANSACTION_STATUSES: ReadonlySet<TransactionStatus> = new Set(
  Object.values(TransactionStatus).filter(
    (status) => !NON_TERMINAL_TRANSACTION_STATUSES.has(status),
  ),
);

/**
 * The server's numeric code per status.
 *
 * **Not unique**: `CLOSED` and `CLOSED_PERIOD_ELAPSED` are both `307`, so a
 * code cannot be mapped back to a status and branching on
 * `transactionStatusCode` silently conflates two outcomes. Branch on the name;
 * this map is for logging and display.
 */
export const TRANSACTION_STATUS_CODES: Readonly<Record<TransactionStatus, number>> = {
  INITIATED: 301,
  PROCESSING: 302,
  PENDING: 303,
  PARTIALLY_PAID: 315,
  SUCCESS: 304,
  FAILED: 300,
  TERMINATED: 305,
  TIME_OUT: 306,
  CLOSED: 307,
  INSUFFICIENT_FUNDS: 308,
  CANCELLED: 309,
  ERROR: 310,
  DECLINED: 311,
  AUTHORIZATION_FAILED: 312,
  SERVICE_UNAVAILABLE: 313,
  REVERSED: 314,
  CLOSED_PERIOD_ELAPSED: 307,
};

/** The server's own descriptions, verbatim. */
export const TRANSACTION_STATUS_DESCRIPTIONS: Readonly<Record<TransactionStatus, string>> = {
  INITIATED: 'Transaction has been initiated',
  PROCESSING: 'Transaction is being processed',
  PENDING: 'Transaction is Pending processing',
  PARTIALLY_PAID: 'Transaction is partially paid',
  SUCCESS: 'Transaction was successfully completed',
  FAILED: 'Transaction has failed',
  TERMINATED: 'Transaction is terminated',
  TIME_OUT: 'Transaction timed out',
  CLOSED: 'Transaction is closed',
  INSUFFICIENT_FUNDS: 'Transaction failed due to insufficient funds present',
  CANCELLED: 'Transaction was cancelled',
  ERROR: 'An error has occurred',
  DECLINED: 'Transaction declined by the service provider',
  AUTHORIZATION_FAILED: "Authorization failed by the customer's service provider",
  SERVICE_UNAVAILABLE: 'Service un available',
  REVERSED: 'Transaction was reversed',
  CLOSED_PERIOD_ELAPSED: 'Transaction is closed by pesepay, period of transaction elapsed',
};

/** Narrows unvalidated JSON — a webhook body, say — to a known status. */
export function isTransactionStatus(value: unknown): value is TransactionStatus {
  return typeof value === 'string' && Object.hasOwn(TRANSACTION_STATUS_CODES, value);
}

/**
 * `true` when the transaction will not change again — stop polling.
 *
 * Accepts any string and treats anything outside
 * {@link NON_TERMINAL_TRANSACTION_STATUSES} as terminal. Terminal never implies
 * *paid*; use {@link isPaid}.
 */
export function isTerminal(status: TransactionStatus | string): boolean {
  return !NON_TERMINAL_TRANSACTION_STATUSES.has(status as TransactionStatus);
}

/**
 * `true` only for `SUCCESS`. `PARTIALLY_PAID` is money received but not the
 * amount asked for, and is still in flight; `REVERSED` was successful and then
 * was not.
 */
export function isPaid(status: TransactionStatus | string): boolean {
  return status === TransactionStatus.SUCCESS;
}
