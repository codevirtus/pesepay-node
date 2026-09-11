/**
 * Transaction statuses, mirrored from the gateway's own enum.
 *
 * The source of truth is `TransactionStatus` in the Java server
 * (`pesepay-cloud-utilities/payments/.../TransactionStatus.java`). All 17
 * values are reproduced here, with the server's own codes and descriptions.
 *
 * v1 reduced this whole vocabulary to `paid: transactionStatus == 'SUCCESS'`,
 * which meant a merchant could not tell `PENDING` (keep waiting) from
 * `DECLINED` (stop, tell the customer) from `REVERSED` (you have already been
 * paid and then un-paid). v2 surfaces the real value.
 *
 * @packageDocumentation
 */

/**
 * Every transaction status the gateway can report.
 *
 * A `const` object rather than a TypeScript `enum`: the build runs with
 * `erasableSyntaxOnly`, which forbids `enum` outright — and for a public API a
 * const object is the better shape anyway. It survives JSON round-trips,
 * compares equal to the raw string off the wire, and needs no import to write
 * `if (result.transactionStatus === 'SUCCESS')`.
 */
export const TransactionStatus = {
  /** Created, no payment attempt yet. Not terminal. */
  INITIATED: 'INITIATED',
  /** Handed to the payment provider. Not terminal. */
  PROCESSING: 'PROCESSING',
  /** Awaiting the customer — e.g. an unconfirmed mobile-money prompt. Not terminal. */
  PENDING: 'PENDING',
  /** Some of the amount has been received. Not terminal. */
  PARTIALLY_PAID: 'PARTIALLY_PAID',
  /** Paid in full. The only status that means you have the money. */
  SUCCESS: 'SUCCESS',
  /** The payment failed. */
  FAILED: 'FAILED',
  /** Ended by the gateway. */
  TERMINATED: 'TERMINATED',
  /** The provider did not answer in time. */
  TIME_OUT: 'TIME_OUT',
  /** Closed. Shares status code 307 with {@link TransactionStatus.CLOSED_PERIOD_ELAPSED}. */
  CLOSED: 'CLOSED',
  /** The customer's account had insufficient funds. */
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  /** Cancelled before completion. */
  CANCELLED: 'CANCELLED',
  /** An unclassified error occurred. */
  ERROR: 'ERROR',
  /** Declined by the service provider. */
  DECLINED: 'DECLINED',
  /** The customer's provider refused authorisation. */
  AUTHORIZATION_FAILED: 'AUTHORIZATION_FAILED',
  /** The provider was unavailable. */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /**
   * A previously successful payment was reversed.
   *
   * This fires a **second** callback for a reference that already reported
   * `SUCCESS`, which is the main reason webhook handlers must be idempotent on
   * `referenceNumber` + `transactionStatus` rather than on reference alone.
   */
  REVERSED: 'REVERSED',
  /** Closed by Pesepay because the payment window elapsed. Also code 307. */
  CLOSED_PERIOD_ELAPSED: 'CLOSED_PERIOD_ELAPSED',
} as const;

/** Union of every value in {@link TransactionStatus}. */
export type TransactionStatus = (typeof TransactionStatus)[keyof typeof TransactionStatus];

/**
 * The statuses that mean "still in flight" — keep polling.
 *
 * This is the small, closed set; everything else is terminal. Defining it in
 * this direction is deliberate: a status the gateway adds in future will be
 * treated as terminal, which stops a poll loop, rather than as pending, which
 * would spin forever. See {@link isTerminal}.
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
 * The server's numeric code for each status.
 *
 * **These are not unique.** `CLOSED` and `CLOSED_PERIOD_ELAPSED` are both
 * `307`, so a code cannot be mapped back to a status and branching on
 * `transactionStatusCode` silently conflates two different outcomes. Branch on
 * the status *name*; this map exists for logging and for display alongside the
 * gateway's dashboard, not for control flow.
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

/** The server's human-readable description for each status, verbatim. */
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

/**
 * Narrows an arbitrary value to a known {@link TransactionStatus}.
 *
 * Useful when handling a webhook body, which arrives as unvalidated JSON.
 */
export function isTransactionStatus(value: unknown): value is TransactionStatus {
  return typeof value === 'string' && Object.hasOwn(TRANSACTION_STATUS_CODES, value);
}

/**
 * `true` when the transaction will not change status again — stop polling.
 *
 * Accepts any string, not just a known status, and treats anything outside
 * {@link NON_TERMINAL_TRANSACTION_STATUSES} as terminal. That fail-safe
 * direction matters: an unrecognised status is far more likely to be a new
 * terminal outcome than a new in-flight one, and guessing "pending" turns a
 * poll loop into an infinite one. Terminal never implies *paid* — use
 * {@link isPaid} for that.
 */
export function isTerminal(status: TransactionStatus | string): boolean {
  return !NON_TERMINAL_TRANSACTION_STATUSES.has(status as TransactionStatus);
}

/**
 * `true` only for {@link TransactionStatus.SUCCESS}.
 *
 * `PARTIALLY_PAID` is money received, but not the amount you asked for, and is
 * still in flight; it is not success. Neither is `REVERSED`, which was
 * successful and then was not.
 */
export function isPaid(status: TransactionStatus | string): boolean {
  return status === TransactionStatus.SUCCESS;
}
