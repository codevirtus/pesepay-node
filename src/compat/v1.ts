/**
 * The 1.x API surface, backed by the 2.x client.
 *
 * ```js
 * const { Pesepay } = require('pesepay/v1-compat');   // was require('pesepay')
 * ```
 *
 * That import is the only line a 1.x integration has to change. Every method,
 * every argument order and the `{ success, message, referenceNumber, pollUrl,
 * redirectUrl, paid }` response object behave as they did in 1.0.4, including
 * the two places 1.x threw rather than returning `{ success: false }`.
 *
 * The typed errors of the modern client are caught here and folded back into
 * `{ success: false, message }`, which is why this layer exists at all: v2
 * throws, v1 did not, and code written against v1 has no `catch`.
 *
 * This is a migration aid, not a destination. It cannot report a
 * `transactionStatus` other than through `paid`, so it cannot tell `PENDING`
 * from `DECLINED` from `REVERSED` — the reason v2 changed shape. Move to
 * `require('pesepay')` a call site at a time; {@link Pesepay.client} gives you
 * the modern client to migrate towards without constructing a second one.
 *
 * @packageDocumentation
 */

import { Pesepay as ModernPesepay, type PaymentResult, type PesepayOptions } from '../client.js';
import type { Transport } from '../internal/transport.js';
import type { CustomerDetails } from '../types.js';

/** Marker for the compatibility entry point. */
export const V1_COMPAT: true = true;

export const BASE_URL: string = 'https://api.pesepay.com/api/payments-engine';
export const CHECK_PAYMENT_URL: string = `${BASE_URL}/v1/payments/check-payment`;
export const MAKE_SEAMLESS_PAYMENT_URL: string = `${BASE_URL}/v2/payments/make-payment`;
export const INITIATE_PAYMENT_URL: string = `${BASE_URL}/v1/payments/initiate`;
export const ALGORITHM: string = 'aes-256-cbc';

/** v1's response object. Every method resolves to one of these, never rejects. */
export class PesepayResponse {
  success: boolean;
  message?: string | undefined;
  referenceNumber?: string | undefined;
  pollUrl?: string | undefined;
  /**
   * Only ever set by {@link Pesepay.initiateTransaction}. The gateway declares
   * a `redirectUrl` on transaction results but has it commented out, so v1's
   * read of it on a poll or a check was always `undefined`.
   */
  redirectUrl?: string | undefined;
  paid: boolean;

  constructor(
    success = false,
    message?: string,
    referenceNumber?: string,
    pollUrl?: string,
    redirectUrl?: string,
    paid = false,
  ) {
    this.success = success;
    this.message = message;
    this.referenceNumber = referenceNumber;
    this.pollUrl = pollUrl;
    this.redirectUrl = redirectUrl;
    this.paid = paid;
  }
}

export class Amount {
  amount: number;
  currencyCode: string;

  constructor(amount: number, currencyCode: string) {
    this.amount = amount;
    this.currencyCode = currencyCode;
  }
}

export class Customer {
  email?: string | undefined;
  phoneNumber?: string | undefined;
  name?: string | undefined;

  constructor(email?: string, phoneNumber?: string, name?: string) {
    if (email == null && phoneNumber == null) {
      throw new Error('Customer details should have an email and/or phone number');
    }

    this.email = email;
    this.phoneNumber = phoneNumber;
    this.name = name;
  }
}

export class Payment {
  currencyCode: string;
  paymentMethodCode: string;
  customer: Customer;
  referenceNumber?: string | undefined;
  amountDetails?: Amount | undefined;
  reasonForPayment?: string | undefined;
  paymentRequestFields?: Record<string, string> | undefined;
  paymentMethodRequiredFields?: Record<string, string> | undefined;
  merchantReference?: string | undefined;
  returnUrl?: string | undefined;
  resultUrl?: string | undefined;

  constructor(currencyCode: string, paymentMethodCode: string, customer: Customer) {
    this.currencyCode = currencyCode;
    this.paymentMethodCode = paymentMethodCode;
    this.customer = customer;
  }

  setRequiredFields(requiredFields: Record<string, string>): void {
    const fields = { ...requiredFields };
    this.paymentMethodRequiredFields = fields;
    this.paymentRequestFields = fields;
  }
}

export class Transaction {
  resultUrl?: string | undefined;
  returnUrl?: string | undefined;
  merchantReference?: string | undefined;
  amountDetails: Amount;
  transactionType: string;
  reasonForPayment: string;

  constructor(
    amount: number,
    currencyCode: string,
    reasonForPayment: string,
    merchantReference?: string,
  ) {
    this.amountDetails = new Amount(amount, currencyCode);
    this.transactionType = 'BASIC';
    this.reasonForPayment = reasonForPayment;
    this.merchantReference = merchantReference;
  }
}

/**
 * Extras v1 had no way to express. Passing none of them leaves behaviour
 * identical to 1.0.4 against production.
 */
export interface V1CompatOptions {
  /** Point at `https://api.test.pesepay.com/api/payments-engine` for sandbox. */
  baseUrl?: string | undefined;
  /** Per-call budget in milliseconds. Defaults to 30 s; v1 had no timeout. */
  timeoutMs?: number | undefined;
  /** Inject your own HTTP — a proxy, a custom agent, or a test double. */
  transport?: Transport | undefined;
}

/**
 * v1's `Pesepay`, method for method.
 *
 * ```js
 * const pesepay = new Pesepay('INTEGRATION KEY', 'ENCRYPTION KEY');
 * pesepay.resultUrl = 'https://example.com/result';
 * pesepay.returnUrl = 'https://example.com/return';
 * ```
 *
 * The methods are own properties holding arrow functions, as v1's were, so
 * `const { checkPayment } = pesepay` still works.
 */
export class Pesepay {
  readonly #integrationKey: string;
  readonly #encryptionKey: string;
  readonly #options: V1CompatOptions;
  #client: ModernPesepay | undefined;

  resultUrl?: string | undefined;
  returnUrl?: string | undefined;

  constructor(integrationKey: string, encryptionKey: string, options: V1CompatOptions = {}) {
    this.#integrationKey = integrationKey;
    this.#encryptionKey = encryptionKey;
    this.#options = options;
  }

  /**
   * The modern client, built on first use — the handle to migrate towards.
   *
   * Construction is deferred because v2 validates the encryption key eagerly
   * and v1 did not: with a malformed key v1 failed per call and returned
   * `{ success: false }`, so validating in this constructor would turn a
   * degraded integration into a crash at startup. Deferring keeps the failure
   * inside a method, where the fold can catch it.
   */
  get client(): ModernPesepay {
    if (this.#client === undefined) {
      const options: PesepayOptions = {
        integrationKey: this.#integrationKey,
        encryptionKey: this.#encryptionKey,
        ...this.#options,
      };
      this.#client = new ModernPesepay(options);
    }
    return this.#client;
  }

  createTransaction: (
    amount: number,
    currencyCode: string,
    paymentReason: string,
    merchantReference?: string,
  ) => Transaction = (amount, currencyCode, paymentReason, merchantReference) =>
    new Transaction(amount, currencyCode, paymentReason, merchantReference);

  createPayment: (
    currencyCode: string,
    paymentMethodCode: string,
    email?: string,
    phone?: string,
    name?: string,
  ) => Payment = (currencyCode, paymentMethodCode, email, phone, name) => {
    if (email == null && phone == null) {
      throw new Error('Email and/or phone number should be provided');
    }
    return new Payment(currencyCode, paymentMethodCode, new Customer(email, phone, name));
  };

  /**
   * @throws {Error} If `resultUrl` or `returnUrl` is unset. v1 checked these
   *   before its `try`, so they were the one failure it did not fold. The
   *   messages are reproduced verbatim, typo included.
   */
  initiateTransaction: (transaction: Transaction) => Promise<PesepayResponse> = async (
    transaction,
  ) => {
    if (this.resultUrl == null) throw new Error('Result url has not beeen specified.');
    if (this.returnUrl == null) throw new Error('Return url has not been specified.');

    transaction.resultUrl = this.resultUrl;
    transaction.returnUrl = this.returnUrl;

    try {
      const response = await this.client.initiateTransaction({
        amount: transaction.amountDetails.amount,
        currencyCode: transaction.amountDetails.currencyCode,
        reasonForPayment: transaction.reasonForPayment,
        merchantReference: transaction.merchantReference,
        resultUrl: this.resultUrl,
        returnUrl: this.returnUrl,
      });
      return new PesepayResponse(
        true,
        undefined,
        response.referenceNumber,
        response.pollUrl,
        response.redirectUrl,
      );
    } catch (error: unknown) {
      return fold(error);
    }
  };

  /** @throws {Error} If `resultUrl` is unset. See {@link initiateTransaction}. */
  makeSeamlessPayment: (
    payment: Payment,
    reasonForPayment: string,
    amount: number,
    requiredFields?: Record<string, string>,
  ) => Promise<PesepayResponse> = async (payment, reasonForPayment, amount, requiredFields) => {
    if (this.resultUrl == null) throw new Error('Result url has not beeen specified.');

    // v1 mutated the caller's payment object, and callers could observe it.
    payment.resultUrl = this.resultUrl;
    payment.returnUrl = this.returnUrl;
    payment.reasonForPayment = reasonForPayment;
    payment.amountDetails = new Amount(amount, payment.currencyCode);
    payment.setRequiredFields({ ...requiredFields });

    try {
      return toResponse(
        await this.client.makeSeamlessPayment({
          amount,
          currencyCode: payment.currencyCode,
          paymentMethodCode: payment.paymentMethodCode,
          reasonForPayment,
          customer: toCustomerDetails(payment.customer),
          requiredFields: payment.paymentMethodRequiredFields,
          merchantReference: payment.merchantReference,
          resultUrl: this.resultUrl,
          returnUrl: this.returnUrl,
        }),
      );
    } catch (error: unknown) {
      return fold(error);
    }
  };

  checkPayment: (referenceNumber: string) => Promise<PesepayResponse> = async (referenceNumber) => {
    try {
      return toResponse(await this.client.checkPayment(referenceNumber));
    } catch (error: unknown) {
      return fold(error);
    }
  };

  pollTransaction: (pollUrl: string) => Promise<PesepayResponse> = async (pollUrl) => {
    try {
      return toResponse(await this.client.pollTransaction(pollUrl));
    } catch (error: unknown) {
      return fold(error);
    }
  };
}

function toResponse(result: PaymentResult): PesepayResponse {
  return new PesepayResponse(
    true,
    undefined,
    result.referenceNumber,
    result.pollUrl,
    undefined,
    result.paid,
  );
}

/** v1's `error.message ?? 'Something went wrong!'`, applied to v2's errors. */
function fold(error: unknown): PesepayResponse {
  const message = (error as { message?: unknown } | null)?.message;
  return new PesepayResponse(
    false,
    typeof message === 'string' ? message : 'Something went wrong!',
  );
}

/**
 * Narrows a v1 `Customer` to exactly the three fields the server declares.
 *
 * v1 serialised the customer object whole, so anything a caller had hung off it
 * went to the gateway too. Sending only the declared fields is the same
 * discipline the modern client applies to every other request.
 */
function toCustomerDetails(customer: Customer): CustomerDetails {
  return {
    ...(customer.email === undefined ? {} : { email: customer.email }),
    ...(customer.phoneNumber === undefined ? {} : { phoneNumber: customer.phoneNumber }),
    ...(customer.name === undefined ? {} : { name: customer.name }),
  };
}
