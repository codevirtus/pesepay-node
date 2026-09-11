/**
 * The v1 compatibility layer, against a fake `Transport`.
 *
 * Two things carry the weight here:
 *
 * 1. **The call sites are v1's own**, copied from the 1.0.4 README and the
 *    `v1` branch rather than paraphrased — same argument order, same mutation
 *    of the caller's objects, same `{ success, message, referenceNumber,
 *    pollUrl, redirectUrl, paid }` object back.
 * 2. **Every modern error folds.** v1 code has no `catch`, so a typed error
 *    escaping this layer is a crash in an application that used to keep
 *    running. Each error class is provoked deliberately and asserted to come
 *    back as `{ success: false }` — from all four async methods, not just one.
 *
 * The two exceptions are v1's own: the missing-url checks sat before its `try`
 * and threw. Those still throw, with the same messages.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from '../../src/internal/transport.ts';
import type { PaymentTransactionResult } from '../../src/types.ts';
import { crypto, errors, v1 } from '../fixtures/modules.mts';

const { Amount, Customer, Payment, Pesepay, PesepayResponse, Transaction } = v1;
const {
  PesepayApiError,
  PesepayAuthError,
  PesepayConfigError,
  PesepayCryptoError,
  PesepayNetworkError,
  PesepayTimeoutError,
} = errors;

const INTEGRATION_KEY = 'integration-key-for-tests-0123456789';
const ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
const OTHER_ENCRYPTION_KEY = 'fedcba9876543210fedcba9876543210';

const RESULT_URL = 'https://example.com/result';
const RETURN_URL = 'https://example.com/return';
const POLL_URL = 'https://api.pesepay.com/api/payments-engine/v1/payments/check-payment?ref=1';

type Responder = (request: TransportRequest) => TransportResponse | Promise<TransportResponse>;

interface Harness {
  pesepay: InstanceType<typeof Pesepay>;
  sent: TransportRequest[];
}

function harness(respond: Responder, encryptionKey: string = ENCRYPTION_KEY): Harness {
  const sent: TransportRequest[] = [];
  const transport: Transport = async (request) => {
    sent.push(request);
    return respond(request);
  };

  const pesepay = new Pesepay(INTEGRATION_KEY, encryptionKey, { transport });
  pesepay.resultUrl = RESULT_URL;
  pesepay.returnUrl = RETURN_URL;

  return { pesepay, sent };
}

function envelope(
  status: number,
  plaintext: unknown,
  key: string = ENCRYPTION_KEY,
): TransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ payload: crypto.encryptPayload(key, JSON.stringify(plaintext)) }),
    usedInsecureHttpParser: false,
  };
}

function jsonResponse(status: number, body: unknown): TransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    usedInsecureHttpParser: false,
  };
}

const INITIATED = {
  referenceNumber: 'REF-1024',
  pollUrl: POLL_URL,
  redirectUrl: 'https://pesepay.com/pay/REF-1024',
};

function transactionResult(
  overrides: Partial<PaymentTransactionResult> = {},
): PaymentTransactionResult {
  return {
    referenceNumber: 'REF-1024',
    transactionStatus: 'SUCCESS',
    transactionStatusCode: 2,
    pollUrl: POLL_URL,
    amountDetails: { amount: 10.5, currencyCode: 'USD', merchantAmount: 10 },
    ...overrides,
  };
}

/** The decrypted request body the client handed to the transport. */
function sentBody(request: TransportRequest): Record<string, unknown> {
  const { payload } = JSON.parse(request.body ?? '') as { payload: string };
  return JSON.parse(crypto.decryptPayload(ENCRYPTION_KEY, payload)) as Record<string, unknown>;
}

describe('v1 compat — the README call sites, verbatim', () => {
  it('makes a redirect payment', async () => {
    const { pesepay, sent } = harness(() => envelope(200, INITIATED));

    const transaction = pesepay.createTransaction(10.5, 'USD', 'Order #1024');
    const response = await pesepay.initiateTransaction(transaction);

    assert.equal(response.success, true);
    assert.equal(response.message, undefined);
    assert.equal(response.referenceNumber, 'REF-1024');
    assert.equal(response.pollUrl, POLL_URL);
    assert.equal(response.redirectUrl, 'https://pesepay.com/pay/REF-1024');
    assert.equal(response.paid, false);

    assert.deepEqual(sentBody(sent[0] as TransportRequest), {
      amountDetails: { amount: 10.5, currencyCode: 'USD' },
      reasonForPayment: 'Order #1024',
      transactionType: 'BASIC',
      resultUrl: RESULT_URL,
      returnUrl: RETURN_URL,
    });
  });

  it('makes a seamless payment', async () => {
    const { pesepay, sent } = harness(() => envelope(200, transactionResult()));

    const payment = pesepay.createPayment('USD', 'PZW204', 'buyer@example.com', '0771111111');
    const requiredFields = { customerPhoneNumber: '0771111111' };
    const response = await pesepay.makeSeamlessPayment(
      payment,
      'Order #1024',
      10.5,
      requiredFields,
    );

    assert.equal(response.success, true);
    assert.equal(response.referenceNumber, 'REF-1024');
    assert.equal(response.pollUrl, POLL_URL);
    assert.equal(response.paid, true);

    const body = sentBody(sent[0] as TransportRequest);
    assert.equal(body.paymentMethodCode, 'PZW204');
    assert.deepEqual(body.customer, { email: 'buyer@example.com', phoneNumber: '0771111111' });
    assert.deepEqual(body.paymentMethodRequiredFields, requiredFields);
  });

  it('checks payment status by reference number', async () => {
    const { pesepay, sent } = harness(() => envelope(200, transactionResult()));

    const response = await pesepay.checkPayment('REF-1024');

    assert.equal(response.success, true);
    assert.equal(response.paid, true);
    assert.equal(
      new URL((sent[0] as TransportRequest).url).searchParams.get('referenceNumber'),
      'REF-1024',
    );
  });

  it('checks payment status by poll url', async () => {
    const { pesepay } = harness(() => envelope(200, transactionResult()));

    const response = await pesepay.pollTransaction(POLL_URL);

    assert.equal(response.success, true);
    assert.equal(response.paid, true);
  });

  it('reports an unpaid transaction as paid: false, not as a failure', async () => {
    const { pesepay } = harness(() =>
      envelope(200, transactionResult({ transactionStatus: 'PENDING' })),
    );

    const response = await pesepay.pollTransaction(POLL_URL);

    assert.equal(response.success, true);
    assert.equal(response.paid, false);
  });

  it('is paid only for SUCCESS', async () => {
    for (const [status, paid] of [
      ['SUCCESS', true],
      ['PENDING', false],
      ['PROCESSING', false],
      ['FAILED', false],
      ['PARTIALLY_PAID', false],
      ['REVERSED', false],
    ] as const) {
      const { pesepay } = harness(() =>
        envelope(200, transactionResult({ transactionStatus: status })),
      );
      assert.equal((await pesepay.pollTransaction(POLL_URL)).paid, paid, status);
    }
  });
});

describe('v1 compat — the response object', () => {
  it('is a PesepayResponse with exactly v1 six fields', async () => {
    const { pesepay } = harness(() => envelope(200, INITIATED));

    const response = await pesepay.initiateTransaction(pesepay.createTransaction(1, 'USD', 'x'));

    assert.ok(response instanceof PesepayResponse);
    assert.deepEqual(Object.keys(response).sort(), [
      'message',
      'paid',
      'pollUrl',
      'redirectUrl',
      'referenceNumber',
      'success',
    ]);
  });

  it('never carries a redirectUrl on a poll — the server has it commented out', async () => {
    const { pesepay } = harness(() =>
      envelope(200, { ...transactionResult(), redirectUrl: 'https://leaked.example' }),
    );

    assert.equal((await pesepay.pollTransaction(POLL_URL)).redirectUrl, undefined);
  });

  it('defaults to v1 empty response when constructed bare', () => {
    const response = new PesepayResponse();

    assert.equal(response.success, false);
    assert.equal(response.paid, false);
    assert.equal(response.message, undefined);
  });
});

describe('v1 compat — the two failures v1 threw rather than folded', () => {
  it('throws when resultUrl is unset, with v1 message and typo', async () => {
    const { pesepay } = harness(() => envelope(200, INITIATED));
    pesepay.resultUrl = undefined;

    await assert.rejects(
      pesepay.initiateTransaction(pesepay.createTransaction(1, 'USD', 'x')),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof PesepayConfigError) &&
        error.message === 'Result url has not beeen specified.',
    );
  });

  it('throws when returnUrl is unset', async () => {
    const { pesepay } = harness(() => envelope(200, INITIATED));
    pesepay.returnUrl = undefined;

    await assert.rejects(
      pesepay.initiateTransaction(pesepay.createTransaction(1, 'USD', 'x')),
      /Return url has not been specified\./,
    );
  });

  it('throws from makeSeamlessPayment when resultUrl is unset', async () => {
    const { pesepay } = harness(() => envelope(200, transactionResult()));
    const payment = pesepay.createPayment('USD', 'PZW204', 'buyer@example.com');
    pesepay.resultUrl = undefined;

    await assert.rejects(
      pesepay.makeSeamlessPayment(payment, 'x', 1),
      /Result url has not beeen specified\./,
    );
  });

  it('does not send a request when a url check throws', async () => {
    const { pesepay, sent } = harness(() => envelope(200, INITIATED));
    pesepay.resultUrl = undefined;

    await pesepay
      .initiateTransaction(pesepay.createTransaction(1, 'USD', 'x'))
      .catch(() => undefined);

    assert.equal(sent.length, 0);
  });

  it('throws from createPayment with neither email nor phone', () => {
    const { pesepay } = harness(() => envelope(200, transactionResult()));

    assert.throws(
      () => pesepay.createPayment('USD', 'PZW204'),
      /Email and\/or phone number should be provided/,
    );
  });

  it('throws from the Customer constructor with neither email nor phone', () => {
    assert.throws(
      () => new Customer(),
      /Customer details should have an email and\/or phone number/,
    );
  });
});

describe('v1 compat — every modern error folds to { success: false }', () => {
  /**
   * One provoker per error class. Each is asserted to be the class it claims,
   * so a change in the client's mapping fails here rather than silently
   * weakening the table.
   */
  const cases: Array<
    [string, ErrorConstructor | (new (...args: never[]) => Error), Responder, string?]
  > = [
    ['PesepayApiError (400)', PesepayApiError, () => jsonResponse(400, { message: 'Bad request' })],
    [
      'PesepayAuthError (404)',
      PesepayAuthError,
      () => jsonResponse(404, { message: 'Unknown key' }),
    ],
    [
      'PesepayAuthError (403)',
      PesepayAuthError,
      () => jsonResponse(403, { message: 'Key disabled' }),
    ],
    [
      'PesepayApiError (500, key mismatch)',
      PesepayApiError,
      () => jsonResponse(500, { message: 'Failed to decrypt your data' }),
    ],
    [
      'PesepayCryptoError',
      PesepayCryptoError,
      () => envelope(200, transactionResult(), OTHER_ENCRYPTION_KEY),
    ],
    [
      'PesepayNetworkError',
      PesepayNetworkError,
      () => {
        throw new PesepayNetworkError('socket hang up');
      },
    ],
    [
      'PesepayTimeoutError',
      PesepayTimeoutError,
      () => {
        throw new PesepayTimeoutError('Pesepay request timed out after 30000 ms', 30_000);
      },
    ],
  ];

  for (const [label, Class, respond] of cases) {
    it(`folds ${label}`, async () => {
      // The class claim first: if the client stopped throwing this, the fold
      // assertions below would still pass and prove nothing.
      const direct = harness(respond).pesepay.client;
      await assert.rejects(direct.pollTransaction(POLL_URL), Class);

      for (const call of asyncCalls(harness(respond).pesepay)) {
        const response = await call();

        assert.equal(response.success, false);
        assert.equal(response.paid, false);
        assert.equal(response.referenceNumber, undefined);
        assert.equal(response.pollUrl, undefined);
        assert.equal(response.redirectUrl, undefined);
        assert.equal(typeof response.message, 'string');
        assert.ok((response.message ?? '').length > 0);
      }
    });
  }

  it('folds PesepayConfigError from a per-call argument', async () => {
    const { pesepay } = harness(() => envelope(200, INITIATED));

    const response = await pesepay.initiateTransaction(pesepay.createTransaction(-1, 'USD', 'x'));

    assert.equal(response.success, false);
    assert.match(response.message ?? '', /amount/i);
  });

  it('folds a malformed encryption key instead of throwing at construction', async () => {
    // v1 validated nothing up front, so a bad key failed per call and returned
    // { success: false }. Validating in the compat constructor would turn a
    // degraded integration into a crash at startup.
    const pesepay = new Pesepay(INTEGRATION_KEY, 'too-short', {
      transport: async () => ({
        status: 200,
        headers: {},
        body: '',
        usedInsecureHttpParser: false,
      }),
    });
    pesepay.resultUrl = RESULT_URL;
    pesepay.returnUrl = RETURN_URL;

    const response = await pesepay.checkPayment('REF-1024');

    assert.equal(response.success, false);
    assert.equal(typeof response.message, 'string');
  });

  it('folds an error that is not ours', async () => {
    const { pesepay } = harness(() => {
      throw new Error('something else broke');
    });

    assert.deepEqual(
      { ...(await pesepay.pollTransaction(POLL_URL)) },
      {
        success: false,
        message: 'something else broke',
        referenceNumber: undefined,
        pollUrl: undefined,
        redirectUrl: undefined,
        paid: false,
      },
    );
  });

  it("falls back to v1 'Something went wrong!' for a thrown non-Error", async () => {
    const { pesepay } = harness(() => {
      throw 'a bare string';
    });

    assert.equal((await pesepay.pollTransaction(POLL_URL)).message, 'Something went wrong!');
  });

  it('never leaks a key into a folded message', async () => {
    const { pesepay } = harness(() =>
      jsonResponse(400, {
        message: `Rejected key ${INTEGRATION_KEY}`,
        description: `Decryption used ${ENCRYPTION_KEY}`,
      }),
    );

    for (const call of asyncCalls(pesepay)) {
      const message = (await call()).message ?? '';
      assert.ok(!message.includes(INTEGRATION_KEY), message);
      assert.ok(!message.includes(ENCRYPTION_KEY), message);
    }
  });
});

describe('v1 compat — the shapes v1 handed back and mutated', () => {
  it('mutates the transaction with the urls, as v1 did', async () => {
    const { pesepay } = harness(() => envelope(200, INITIATED));

    const transaction = pesepay.createTransaction(10.5, 'USD', 'Order #1024', 'MERCH-1');
    assert.equal(transaction.resultUrl, undefined);

    await pesepay.initiateTransaction(transaction);

    assert.equal(transaction.resultUrl, RESULT_URL);
    assert.equal(transaction.returnUrl, RETURN_URL);
  });

  it('mutates the payment with the amount, reason, urls and required fields', async () => {
    const { pesepay } = harness(() => envelope(200, transactionResult()));

    const payment = pesepay.createPayment('USD', 'PZW204', 'buyer@example.com');
    await pesepay.makeSeamlessPayment(payment, 'Order #1024', 10.5, { a: 'b' });

    assert.equal(payment.resultUrl, RESULT_URL);
    assert.equal(payment.returnUrl, RETURN_URL);
    assert.equal(payment.reasonForPayment, 'Order #1024');
    assert.deepEqual(payment.amountDetails, new Amount(10.5, 'USD'));
    assert.deepEqual(payment.paymentMethodRequiredFields, { a: 'b' });
    assert.deepEqual(payment.paymentRequestFields, { a: 'b' });
  });

  it('builds v1 Transaction and Payment shapes', () => {
    const { pesepay } = harness(() => envelope(200, INITIATED));

    const transaction = pesepay.createTransaction(10.5, 'USD', 'Order', 'MERCH-1');
    assert.ok(transaction instanceof Transaction);
    assert.equal(transaction.transactionType, 'BASIC');
    assert.deepEqual(transaction.amountDetails, new Amount(10.5, 'USD'));
    assert.equal(transaction.merchantReference, 'MERCH-1');

    const payment = pesepay.createPayment('USD', 'PZW204', undefined, '0771111111', 'Buyer');
    assert.ok(payment instanceof Payment);
    assert.ok(payment.customer instanceof Customer);
    assert.deepEqual(
      { ...payment.customer },
      {
        email: undefined,
        phoneNumber: '0771111111',
        name: 'Buyer',
      },
    );
  });

  it('sends only the three declared customer fields', async () => {
    // v1 serialised the customer whole, so anything hung off it went too.
    const { pesepay, sent } = harness(() => envelope(200, transactionResult()));

    const payment = pesepay.createPayment('USD', 'PZW204', undefined, '0771111111');
    (payment.customer as unknown as Record<string, unknown>).internalNote = 'do not send';
    await pesepay.makeSeamlessPayment(payment, 'Order', 1);

    assert.deepEqual(sentBody(sent[0] as TransportRequest).customer, { phoneNumber: '0771111111' });
  });

  it('carries merchantReference through both paths', async () => {
    const initiate = harness(() => envelope(200, INITIATED));
    await initiate.pesepay.initiateTransaction(
      initiate.pesepay.createTransaction(1, 'USD', 'x', 'MERCH-1'),
    );
    assert.equal(sentBody(initiate.sent[0] as TransportRequest).merchantReference, 'MERCH-1');

    const seamless = harness(() => envelope(200, transactionResult()));
    const payment = seamless.pesepay.createPayment('USD', 'PZW204', 'buyer@example.com');
    payment.merchantReference = 'MERCH-2';
    await seamless.pesepay.makeSeamlessPayment(payment, 'x', 1);
    assert.equal(sentBody(seamless.sent[0] as TransportRequest).merchantReference, 'MERCH-2');
  });
});

describe('v1 compat — the seam to v2', () => {
  it('keeps the methods detachable, as v1 arrow properties were', async () => {
    const { pesepay } = harness(() => envelope(200, transactionResult()));

    const { checkPayment, pollTransaction } = pesepay;

    assert.equal((await checkPayment('REF-1024')).paid, true);
    assert.equal((await pollTransaction(POLL_URL)).paid, true);
  });

  it('exposes one modern client, built once', () => {
    const { pesepay } = harness(() => envelope(200, transactionResult()));

    assert.equal(pesepay.client, pesepay.client);
    assert.equal(pesepay.client.baseUrl, 'https://api.pesepay.com/api/payments-engine');
  });

  it('sends the integration key as the key header', async () => {
    const { pesepay, sent } = harness(() => envelope(200, transactionResult()));

    await pesepay.checkPayment('REF-1024');

    assert.equal((sent[0] as TransportRequest).headers.key, INTEGRATION_KEY);
  });

  it('keeps v1 endpoint constants', () => {
    assert.equal(v1.BASE_URL, 'https://api.pesepay.com/api/payments-engine');
    assert.equal(v1.CHECK_PAYMENT_URL, `${v1.BASE_URL}/v1/payments/check-payment`);
    assert.equal(v1.MAKE_SEAMLESS_PAYMENT_URL, `${v1.BASE_URL}/v2/payments/make-payment`);
    assert.equal(v1.INITIATE_PAYMENT_URL, `${v1.BASE_URL}/v1/payments/initiate`);
    assert.equal(v1.ALGORITHM, 'aes-256-cbc');
  });

  it('honours a sandbox baseUrl', async () => {
    const sent: TransportRequest[] = [];
    const pesepay = new Pesepay(INTEGRATION_KEY, ENCRYPTION_KEY, {
      baseUrl: 'https://api.test.pesepay.com/api/payments-engine',
      transport: async (request) => {
        sent.push(request);
        return envelope(200, transactionResult());
      },
    });

    await pesepay.checkPayment('REF-1024');

    assert.match((sent[0] as TransportRequest).url, /^https:\/\/api\.test\.pesepay\.com\//);
  });
});

/** The four methods that must never reject once the url checks have passed. */
function asyncCalls(
  pesepay: InstanceType<typeof Pesepay>,
): Array<() => Promise<InstanceType<typeof PesepayResponse>>> {
  return [
    () => pesepay.initiateTransaction(pesepay.createTransaction(10.5, 'USD', 'Order')),
    () =>
      pesepay.makeSeamlessPayment(
        pesepay.createPayment('USD', 'PZW204', 'buyer@example.com'),
        'Order',
        10.5,
      ),
    () => pesepay.checkPayment('REF-1024'),
    () => pesepay.pollTransaction(POLL_URL),
  ];
}
