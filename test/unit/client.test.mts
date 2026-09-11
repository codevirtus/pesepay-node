/**
 * The payments client, against a fake `Transport`.
 *
 * Four things here carry real weight, and the rest is plumbing around them:
 *
 * 1. **The wire body is ciphertext.** Asserted by searching the bytes actually
 *    handed to the transport for the cleartext that went in — an encryption
 *    step that silently no-ops is otherwise invisible, because the fake gateway
 *    would happily decrypt nothing and the round-trip test would still pass.
 * 2. **A failure body never reaches the decryptor.** Every error the gateway
 *    sends is plain JSON at every status, so each of these cases is written so
 *    that a client which decrypted first would throw `PesepayCryptoError` — and
 *    each asserts it did not.
 * 3. **No key material in any error.** Including when the gateway echoes both
 *    keys straight back at us, which is the case a "we checked, it doesn't"
 *    guarantee would miss.
 * 4. **The round trip.** A `PaymentTransactionResult` encrypted with the test
 *    key, handed back through the fake transport, decoded into the real
 *    `transactionStatus` plus the derived `paid` and `isTerminal`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PesepayOptions } from '../../src/client.ts';
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from '../../src/internal/transport.ts';
import type { PaymentTransactionResult } from '../../src/types.ts';
import { client, crypto, errors, status } from '../fixtures/modules.mts';

const { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, Pesepay } = client;
const { PesepayApiError, PesepayAuthError, PesepayConfigError, PesepayCryptoError, PesepayError } =
  errors;

/** Long enough to be redactable, and obviously not a real key. */
const INTEGRATION_KEY = 'integration-key-for-tests-0123456789';

/** Exactly 32 ASCII characters, as the gateway issues them. */
const ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';

/** A different, equally valid key — for "wrong key" cases. */
const OTHER_ENCRYPTION_KEY = 'fedcba9876543210fedcba9876543210';

const RESULT_URL = 'https://merchant.example/pesepay/webhook';
const RETURN_URL = 'https://merchant.example/checkout/done';

const INITIATE_URL = `${DEFAULT_BASE_URL}/v1/payments/initiate`;
const SEAMLESS_URL = `${DEFAULT_BASE_URL}/v2/payments/make-payment`;
const CHECK_URL = `${DEFAULT_BASE_URL}/v1/payments/check-payment`;

type Responder = (request: TransportRequest) => TransportResponse | Promise<TransportResponse>;

interface Harness {
  pesepay: InstanceType<typeof Pesepay>;
  /** Every request the client handed to the transport, in order. */
  sent: TransportRequest[];
}

/**
 * A client wired to a fake gateway. `sent` is the injection point's ledger —
 * assertions about the wire read from it rather than from the client.
 */
function harness(respond: Responder, options: Partial<PesepayOptions> = {}): Harness {
  const sent: TransportRequest[] = [];

  const transport: Transport = async (request) => {
    sent.push(request);
    return respond(request);
  };

  const pesepay = new Pesepay({
    integrationKey: INTEGRATION_KEY,
    encryptionKey: ENCRYPTION_KEY,
    resultUrl: RESULT_URL,
    returnUrl: RETURN_URL,
    transport,
    ...options,
  });

  return { pesepay, sent };
}

/** A transport that fails the test if it is ever reached. */
const forbiddenTransport: Transport = async () => {
  throw new Error('the transport was called, but this case must fail before any socket');
};

function jsonResponse(httpStatus: number, body: unknown): TransportResponse {
  return {
    status: httpStatus,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    usedInsecureHttpParser: false,
  };
}

/** The `{ payload }` envelope, encrypted the way the gateway encrypts it. */
function envelopeResponse(
  httpStatus: number,
  plaintext: unknown,
  key: string = ENCRYPTION_KEY,
): TransportResponse {
  return jsonResponse(httpStatus, {
    payload: crypto.encryptPayload(key, JSON.stringify(plaintext)),
  });
}

function transactionResult(overrides: Partial<PaymentTransactionResult> = {}): unknown {
  return {
    referenceNumber: 'PSP-REF-0001',
    dateOfTransaction: '2026-09-11T09:15:00.000+00:00',
    applicationId: 42,
    applicationName: 'Example Store',
    amountDetails: {
      amount: 10.5,
      currencyCode: 'USD',
      transactionServiceFee: 0.25,
      customerPayableAmount: 10.75,
      merchantAmount: 10.5,
      totalTransactionAmount: 10.75,
    },
    reasonForPayment: 'Order #1024',
    transactionStatus: 'SUCCESS',
    transactionStatusCode: 304,
    transactionStatusDescription: 'Transaction was successfully completed',
    pollUrl: `${CHECK_URL}?referenceNumber=PSP-REF-0001`,
    transactionMetadata: { orderId: '1024' },
    ...overrides,
  };
}

function initiateResponse(): unknown {
  return {
    referenceNumber: 'PSP-REF-0001',
    pollUrl: `${CHECK_URL}?referenceNumber=PSP-REF-0001`,
    redirectUrl: 'https://pay.pesepay.com/checkout/PSP-REF-0001',
  };
}

/** Decrypts what the client actually put on the wire. */
function decodeSentBody(request: TransportRequest): Record<string, unknown> {
  assert.ok(request.body !== undefined, 'expected a request body');
  const envelope: unknown = JSON.parse(request.body);
  assert.ok(
    typeof envelope === 'object' && envelope !== null && 'payload' in envelope,
    'the request body must be a { payload } envelope',
  );
  const payload = (envelope as { payload: unknown }).payload;
  assert.equal(typeof payload, 'string');
  return JSON.parse(crypto.decryptPayload(ENCRYPTION_KEY, payload as string)) as Record<
    string,
    unknown
  >;
}

function firstRequest(sent: TransportRequest[]): TransportRequest {
  const request = sent[0];
  assert.ok(request !== undefined, 'expected exactly one request');
  return request;
}

async function rejection(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof Error, 'a non-Error was thrown');
    return error;
  }
  throw new assert.AssertionError({ message: 'expected the call to reject, but it resolved' });
}

/** Everything an error could plausibly carry a credential in. */
function assertNoKeyMaterial(error: Error, label: string): void {
  const surfaces: Array<[string, string]> = [
    ['message', error.message],
    ['stack', error.stack ?? ''],
    ['JSON.stringify', JSON.stringify(error)],
    ['String()', String(error)],
  ];

  for (const [surface, text] of surfaces) {
    assert.ok(
      !text.includes(INTEGRATION_KEY),
      `${label}: the integration key leaked into ${surface}`,
    );
    assert.ok(
      !text.includes(ENCRYPTION_KEY),
      `${label}: the encryption key leaked into ${surface}`,
    );
  }
}

describe('Pesepay — construction', () => {
  it('rejects a malformed encryption key before any socket', () => {
    // Eager validation is the whole point: this must not wait for a request.
    assert.throws(
      () =>
        new Pesepay({
          integrationKey: INTEGRATION_KEY,
          encryptionKey: 'too-short',
          transport: forbiddenTransport,
        }),
      (error: unknown) => {
        assert.ok(error instanceof PesepayConfigError);
        assert.match(error.message, /exactly 32 characters/);
        return true;
      },
    );
  });

  it('keeps the key itself out of that error', () => {
    const error = (() => {
      try {
        new Pesepay({ integrationKey: INTEGRATION_KEY, encryptionKey: 'x'.repeat(31) });
      } catch (thrown) {
        return thrown as Error;
      }
      throw new assert.AssertionError({ message: 'expected a throw' });
    })();

    assert.ok(!error.message.includes('x'.repeat(31)));
  });

  it('rejects a missing or blank integration key', () => {
    for (const integrationKey of ['', '   ']) {
      assert.throws(
        () => new Pesepay({ integrationKey, encryptionKey: ENCRYPTION_KEY }),
        PesepayConfigError,
      );
    }
  });

  it('accepts the v1 positional form, with settable callback URLs', async () => {
    const pesepay = new Pesepay(INTEGRATION_KEY, ENCRYPTION_KEY);

    assert.equal(pesepay.resultUrl, undefined);
    assert.equal(pesepay.returnUrl, undefined);
    assert.equal(pesepay.baseUrl, DEFAULT_BASE_URL);
    assert.equal(pesepay.timeoutMs, DEFAULT_TIMEOUT_MS);

    pesepay.resultUrl = RESULT_URL;
    pesepay.returnUrl = RETURN_URL;

    assert.equal(pesepay.resultUrl, RESULT_URL);
    assert.equal(pesepay.returnUrl, RETURN_URL);
  });

  it('validates the positional form the same way', () => {
    assert.throws(() => new Pesepay(INTEGRATION_KEY, 'nope'), PesepayConfigError);
  });

  it('refuses a cleartext baseUrl, but allows loopback for local testing', () => {
    assert.throws(
      () =>
        new Pesepay({
          integrationKey: INTEGRATION_KEY,
          encryptionKey: ENCRYPTION_KEY,
          baseUrl: 'http://api.pesepay.com/api/payments-engine',
        }),
      PesepayConfigError,
    );

    const local = new Pesepay({
      integrationKey: INTEGRATION_KEY,
      encryptionKey: ENCRYPTION_KEY,
      baseUrl: 'http://127.0.0.1:8080/api/payments-engine/',
    });

    // And the trailing slash is normalised away, so paths never double up.
    assert.equal(local.baseUrl, 'http://127.0.0.1:8080/api/payments-engine');
  });

  it('rejects a non-positive timeout', () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () =>
          new Pesepay({
            integrationKey: INTEGRATION_KEY,
            encryptionKey: ENCRYPTION_KEY,
            timeoutMs,
          }),
        PesepayConfigError,
        `timeoutMs ${String(timeoutMs)} should be rejected`,
      );
    }
  });

  it('rejects a callback URL that is not absolute', () => {
    assert.throws(
      () =>
        new Pesepay({
          integrationKey: INTEGRATION_KEY,
          encryptionKey: ENCRYPTION_KEY,
          resultUrl: '/pesepay/webhook',
        }),
      PesepayConfigError,
    );
  });

  it('holds both keys where JSON.stringify cannot reach them', () => {
    // `#private` rather than TS `private`, which is an ordinary enumerable own
    // property at runtime and would publish both keys into any log that
    // serialised the client.
    const { pesepay } = harness(() => jsonResponse(200, {}));
    const serialised = JSON.stringify(pesepay);

    assert.ok(!serialised.includes(INTEGRATION_KEY));
    assert.ok(!serialised.includes(ENCRYPTION_KEY));
  });
});

describe('Pesepay — what goes on the wire', () => {
  it('POSTs an encrypted envelope, never cleartext', async () => {
    const { pesepay, sent } = harness(() => envelopeResponse(200, initiateResponse()));

    await pesepay.initiateTransaction({
      amount: 10.5,
      currencyCode: 'USD',
      reasonForPayment: 'Order #1024',
      merchantReference: 'ORDER-1024',
    });

    const request = firstRequest(sent);
    assert.equal(request.method, 'POST');
    assert.equal(request.url, INITIATE_URL);
    assert.ok(request.body !== undefined);

    // The assertion that matters: none of the plaintext survives into the bytes
    // handed to the transport. An encryption step that no-opped would be
    // invisible to the round-trip test alone.
    for (const secret of ['Order #1024', 'ORDER-1024', 'USD', '10.5', 'reasonForPayment']) {
      assert.ok(
        !request.body.includes(secret),
        `"${secret}" appeared in cleartext on the wire: ${request.body}`,
      );
    }

    // Nor does the encryption key, which is never transmitted at all.
    assert.ok(!request.body.includes(ENCRYPTION_KEY));
  });

  it('authenticates with the `key` header and declares JSON', async () => {
    const { pesepay, sent } = harness(() => envelopeResponse(200, initiateResponse()));

    await pesepay.initiateTransaction({
      amount: 1,
      currencyCode: 'USD',
      reasonForPayment: 'Test',
    });

    const request = firstRequest(sent);
    assert.equal(request.headers.key, INTEGRATION_KEY);
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.headers.accept, 'application/json');
    assert.equal(request.timeoutMs, DEFAULT_TIMEOUT_MS);
  });

  it('sends the CreateTransactionCommand the server expects', async () => {
    const { pesepay, sent } = harness(() => envelopeResponse(200, initiateResponse()));

    await pesepay.initiateTransaction({
      amount: 10.5,
      currencyCode: 'USD',
      reasonForPayment: 'Order #1024',
      merchantReference: 'ORDER-1024',
      paymentMethodCode: 'PZW204',
      paymentMetadata: { orderId: '1024' },
    });

    assert.deepEqual(decodeSentBody(firstRequest(sent)), {
      amountDetails: { amount: 10.5, currencyCode: 'USD' },
      reasonForPayment: 'Order #1024',
      transactionType: 'BASIC',
      // Explicitly present. A blank one is not rejected by the gateway — it is
      // silently replaced with the string "NONE" and the result goes nowhere.
      resultUrl: RESULT_URL,
      returnUrl: RETURN_URL,
      merchantReference: 'ORDER-1024',
      paymentMethodCode: 'PZW204',
      paymentMetadata: { orderId: '1024' },
    });
  });

  it('omits absent options rather than sending nulls', async () => {
    const { pesepay, sent } = harness(() => envelopeResponse(200, initiateResponse()));

    await pesepay.initiateTransaction({
      amount: 1,
      currencyCode: 'USD',
      reasonForPayment: 'Test',
      merchantReference: undefined,
    });

    const body = decodeSentBody(firstRequest(sent));
    assert.ok(!('merchantReference' in body));
    assert.ok(!('paymentMethodCode' in body));
    assert.ok(!('paymentMetadata' in body));
  });

  it('lets a per-call resultUrl override the client default', async () => {
    const { pesepay, sent } = harness(() => envelopeResponse(200, initiateResponse()));
    const override = 'https://merchant.example/pesepay/other-hook';

    await pesepay.initiateTransaction({
      amount: 1,
      currencyCode: 'USD',
      reasonForPayment: 'Test',
      resultUrl: override,
    });

    assert.equal(decodeSentBody(firstRequest(sent)).resultUrl, override);
  });

  it('refuses to initiate without a resultUrl, and never opens a socket', async () => {
    const pesepay = new Pesepay({
      integrationKey: INTEGRATION_KEY,
      encryptionKey: ENCRYPTION_KEY,
      transport: forbiddenTransport,
    });

    const error = await rejection(() =>
      pesepay.initiateTransaction({ amount: 1, currencyCode: 'USD', reasonForPayment: 'Test' }),
    );

    assert.ok(error instanceof PesepayConfigError);
    assert.match(error.message, /resultUrl is required/);
    // The "NONE" substitution is the reason this is checked client-side at all.
    assert.match(error.message, /NONE/);
  });

  it('treats a blank resultUrl exactly like a missing one', async () => {
    // The case the gateway is worst at: `""` and `"   "` are not rejected
    // server-side, they become the string "NONE". So the client-side error has
    // to explain that, not merely say the URL does not parse — v1's `== null`
    // check let both of these straight through.
    for (const resultUrl of ['', '   ']) {
      const pesepay = new Pesepay(INTEGRATION_KEY, ENCRYPTION_KEY);
      pesepay.resultUrl = resultUrl;
      pesepay.returnUrl = RETURN_URL;

      const error = await rejection(() =>
        pesepay.initiateTransaction({ amount: 1, currencyCode: 'USD', reasonForPayment: 'Test' }),
      );

      assert.ok(error instanceof PesepayConfigError, `"${resultUrl}" should be rejected`);
      assert.match(error.message, /resultUrl is required/);
      assert.match(error.message, /NONE/);
    }
  });

  it('refuses a non-positive amount', async () => {
    const { pesepay, sent } = harness(() => envelopeResponse(200, initiateResponse()));

    for (const amount of [0, -5, Number.NaN]) {
      const error = await rejection(() =>
        pesepay.initiateTransaction({ amount, currencyCode: 'USD', reasonForPayment: 'Test' }),
      );
      assert.ok(error instanceof PesepayConfigError);
    }

    assert.equal(sent.length, 0);
  });

  it('GETs check-payment with no body and an encoded reference', async () => {
    const { pesepay, sent } = harness(() => envelopeResponse(200, transactionResult()));

    // v1 concatenated the reference straight into the query string, so one
    // containing `&` or `#` silently produced a different request.
    await pesepay.checkPayment('PSP REF&x=1');

    const request = firstRequest(sent);
    assert.equal(request.method, 'GET');
    assert.equal(request.body, undefined);
    assert.equal(request.headers.key, INTEGRATION_KEY);
    assert.equal(request.headers['content-type'], undefined);
    assert.equal(request.url, `${CHECK_URL}?referenceNumber=PSP+REF%26x%3D1`);
  });

  it('polls exactly the URL the gateway handed back', async () => {
    const { pesepay, sent } = harness(() => envelopeResponse(200, transactionResult()));
    const pollUrl = `${CHECK_URL}?referenceNumber=PSP-REF-0001`;

    await pesepay.pollTransaction(pollUrl);

    assert.equal(firstRequest(sent).url, pollUrl);
  });

  it('routes everything through a custom baseUrl', async () => {
    const sandbox = 'https://api.test.pesepay.com/api/payments-engine';
    const { pesepay, sent } = harness(() => envelopeResponse(200, transactionResult()), {
      baseUrl: sandbox,
    });

    await pesepay.checkPayment('PSP-REF-0001');

    assert.ok(firstRequest(sent).url.startsWith(`${sandbox}/v1/payments/check-payment`));
  });
});

describe('Pesepay — seamless payment', () => {
  it('always sends customer, and maps requiredFields to the wire name', async () => {
    const { pesepay, sent } = harness(() =>
      envelopeResponse(200, transactionResult({ transactionStatus: 'PENDING' })),
    );

    await pesepay.makeSeamlessPayment({
      amount: 10.5,
      currencyCode: 'USD',
      paymentMethodCode: 'PZW211',
      reasonForPayment: 'Order #1024',
      customer: { email: 'buyer@example.com', phoneNumber: '0771111111', name: 'A Buyer' },
      requiredFields: { customerPhoneNumber: '0771111111' },
    });

    const request = firstRequest(sent);
    assert.equal(request.url, SEAMLESS_URL);

    assert.deepEqual(decodeSentBody(request), {
      amountDetails: { amount: 10.5, currencyCode: 'USD' },
      reasonForPayment: 'Order #1024',
      paymentMethodCode: 'PZW211',
      // Unconditional: the server dereferences this without a null check.
      customer: { email: 'buyer@example.com', phoneNumber: '0771111111', name: 'A Buyer' },
      resultUrl: RESULT_URL,
      returnUrl: RETURN_URL,
      paymentMethodRequiredFields: { customerPhoneNumber: '0771111111' },
    });
  });

  it('still sends customer when only a phone number is known', async () => {
    const { pesepay, sent } = harness(() =>
      envelopeResponse(200, transactionResult({ transactionStatus: 'PENDING' })),
    );

    await pesepay.makeSeamlessPayment({
      amount: 1,
      currencyCode: 'USD',
      paymentMethodCode: 'PZW211',
      reasonForPayment: 'Test',
      customer: { phoneNumber: '0771111111' },
    });

    assert.deepEqual(decodeSentBody(firstRequest(sent)).customer, { phoneNumber: '0771111111' });
  });

  it('refuses a customer with neither email nor phone, before any socket', async () => {
    const pesepay = new Pesepay({
      integrationKey: INTEGRATION_KEY,
      encryptionKey: ENCRYPTION_KEY,
      resultUrl: RESULT_URL,
      transport: forbiddenTransport,
    });

    const error = await rejection(() =>
      pesepay.makeSeamlessPayment({
        amount: 1,
        currencyCode: 'USD',
        paymentMethodCode: 'PZW211',
        reasonForPayment: 'Test',
        customer: { name: 'A Buyer' },
      }),
    );

    assert.ok(error instanceof PesepayConfigError);
    assert.match(error.message, /NullPointerException/);
  });

  it('omits returnUrl entirely when there is none, letting the server default it', async () => {
    const { pesepay, sent } = harness(
      () => envelopeResponse(200, transactionResult({ transactionStatus: 'PENDING' })),
      { returnUrl: undefined },
    );

    await pesepay.makeSeamlessPayment({
      amount: 1,
      currencyCode: 'USD',
      paymentMethodCode: 'PZW211',
      reasonForPayment: 'Test',
      customer: { email: 'buyer@example.com' },
    });

    assert.ok(!('returnUrl' in decodeSentBody(firstRequest(sent))));
  });
});

describe('Pesepay — a failure body never reaches the decryptor', () => {
  /**
   * Each case is written so that a client which decrypted before checking the
   * status would throw `PesepayCryptoError`. Asserting the error is an API
   * error is therefore also asserting the ordering.
   */
  const check = (error: Error, label: string): void => {
    assert.ok(
      !(error instanceof PesepayCryptoError),
      `${label}: the plain-JSON error body reached the decryptor`,
    );
    assert.ok(error instanceof PesepayApiError, `${label}: expected a PesepayApiError`);
    assert.ok(
      !/decrypt the gateway payload/i.test(error.message),
      `${label}: decryption was tried`,
    );
  };

  it('maps 404 to an auth error — an unknown integration key, not a missing route', async () => {
    const { pesepay } = harness(() =>
      jsonResponse(404, {
        timestamp: '2026-09-11T09:15:00.000+00:00',
        message: 'Integration key record was not found',
        status: 404,
      }),
    );

    const error = await rejection(() => pesepay.checkPayment('PSP-REF-0001'));

    check(error, '404');
    assert.ok(error instanceof PesepayAuthError);
    assert.equal((error as InstanceType<typeof PesepayApiError>).status, 404);
    assert.equal((error as InstanceType<typeof PesepayApiError>).isRetryable(), false);
    assert.match(error.message, /Integration key record was not found/);
  });

  it('maps 403 to an auth error — a key that exists but is disabled', async () => {
    const { pesepay } = harness(() => jsonResponse(403, { message: null, status: 403 }));

    const error = await rejection(() => pesepay.checkPayment('PSP-REF-0001'));

    check(error, '403');
    assert.ok(error instanceof PesepayAuthError);
    // `message` is genuinely nullable on the server, so the description has to
    // carry the explanation.
    assert.match(error.message, /disabled/);
  });

  it('maps the 500 decrypt failure to an encryption-key mismatch', async () => {
    const { pesepay } = harness(() =>
      jsonResponse(500, {
        message: 'Failed to decrypt your data',
        description: 'Internal Server Error',
        status: 500,
      }),
    );

    const error = await rejection(() => pesepay.checkPayment('PSP-REF-0001'));

    check(error, '500 decrypt');
    // The distinction the whole ordering exists to preserve: this is the
    // *server* failing to decrypt *our* request, not us failing to decrypt its
    // response. Confusing the two sends you rotating the wrong credential.
    assert.ok(error instanceof PesepayApiError);
    assert.equal(error.isEncryptionKeyMismatch(), true);
    assert.equal(error.isRetryable(), false);
    assert.ok(!(error instanceof PesepayAuthError));
  });

  it('keeps a generic 400 RuntimeException as an API error with the server text', async () => {
    const { pesepay } = harness(() =>
      jsonResponse(400, { message: 'Reason for payment should be provided', status: 400 }),
    );

    const error = await rejection(() =>
      pesepay.initiateTransaction({ amount: 1, currencyCode: 'USD', reasonForPayment: 'Test' }),
    );

    check(error, '400');
    assert.ok(error instanceof PesepayApiError);
    assert.equal(error.serverMessage, 'Reason for payment should be provided');
    assert.equal(error.isRetryable(), false);
    assert.equal(error.method, 'POST');
    assert.equal(error.url, INITIATE_URL);
  });

  it('survives an error body that is not JSON at all', async () => {
    // An upstream proxy returning an HTML error page must still produce an
    // error that names the status, not a SyntaxError from the parser.
    const { pesepay } = harness(() => jsonResponse(502, '<html><body>Bad Gateway</body></html>'));

    const error = await rejection(() => pesepay.checkPayment('PSP-REF-0001'));

    check(error, 'html');
    assert.ok(error instanceof PesepayApiError);
    assert.equal(error.status, 502);
    assert.equal(error.isRetryable(), true);
    assert.match(error.message, /502/);
  });

  it('reads the first element when the body is an array of error messages', async () => {
    const { pesepay } = harness(() => jsonResponse(400, [{ message: 'Currency not supported' }]));

    const error = await rejection(() => pesepay.checkPayment('PSP-REF-0001'));

    check(error, 'array');
    assert.match(error.message, /Currency not supported/);
  });

  it('does not decrypt even when the failure body is a valid envelope', async () => {
    // The sharpest version of the ordering test: this body *would* decrypt
    // cleanly. A client that decrypted first would report a successful-looking
    // result for a 500.
    const { pesepay } = harness(() => envelopeResponse(500, transactionResult(), ENCRYPTION_KEY));

    const error = await rejection(() => pesepay.checkPayment('PSP-REF-0001'));

    check(error, 'valid envelope at 500');
    assert.equal((error as InstanceType<typeof PesepayApiError>).status, 500);
  });
});

describe('Pesepay — no key material in errors', () => {
  it('redacts both keys when the gateway echoes them back', async () => {
    // Not hypothetical enough to ignore: a server that logs the request in its
    // error message would hand the integration key straight to whatever
    // aggregator swallowed the exception.
    const { pesepay } = harness(() =>
      jsonResponse(400, {
        message: `Rejected request for key ${INTEGRATION_KEY}`,
        description: `Decryption used ${ENCRYPTION_KEY}`,
        status: 400,
      }),
    );

    const error = await rejection(() => pesepay.checkPayment('PSP-REF-0001'));

    assertNoKeyMaterial(error, 'echoed keys');
    assert.match(error.message, /\[redacted\]/);

    assert.ok(error instanceof PesepayApiError);
    assert.ok(error.responseBody !== undefined);
    assert.ok(!error.responseBody.includes(INTEGRATION_KEY));
    assert.ok(!error.responseBody.includes(ENCRYPTION_KEY));
  });

  it('keeps every error path clean', async () => {
    const cases: Array<[string, Responder]> = [
      ['404', () => jsonResponse(404, { message: `no key ${INTEGRATION_KEY}` })],
      ['403', () => jsonResponse(403, { message: null })],
      ['500 decrypt', () => jsonResponse(500, { message: 'Failed to decrypt your data' })],
      ['non-JSON', () => jsonResponse(500, `dump: ${INTEGRATION_KEY} / ${ENCRYPTION_KEY}`)],
      ['not an envelope', () => jsonResponse(200, { referenceNumber: 'PSP-REF-0001' })],
      ['undecryptable', () => envelopeResponse(200, transactionResult(), OTHER_ENCRYPTION_KEY)],
      ['not base64', () => jsonResponse(200, { payload: 'not base64 at all!!' })],
      ['no transactionStatus', () => envelopeResponse(200, { referenceNumber: 'PSP-REF-0001' })],
      ['transport failure', () => Promise.reject(new Error('socket hang up'))],
    ];

    for (const [label, respond] of cases) {
      const { pesepay } = harness(respond);
      const error = await rejection(() => pesepay.checkPayment('PSP-REF-0001'));
      assert.ok(error instanceof PesepayError || label === 'transport failure');
      assertNoKeyMaterial(error, label);
    }
  });
});

describe('Pesepay — malformed successful responses', () => {
  it('rejects a 200 that is not the { payload } envelope', async () => {
    const { pesepay } = harness(() => jsonResponse(200, transactionResult()));

    const error = await rejection(() => pesepay.checkPayment('PSP-REF-0001'));

    assert.ok(error instanceof PesepayApiError);
    assert.ok(!(error instanceof PesepayCryptoError));
    assert.match(error.message, /payload/);
  });

  it('reports a wrong encryption key as a crypto error, fatally', async () => {
    const { pesepay } = harness(() =>
      envelopeResponse(200, transactionResult(), OTHER_ENCRYPTION_KEY),
    );

    const error = await rejection(() => pesepay.checkPayment('PSP-REF-0001'));

    // CBC has no integrity protection, so the padding check is the only signal
    // that this is not what the server sent. Returning a garbled status would
    // be worse than refusing.
    assert.ok(error instanceof PesepayCryptoError);
    assert.match(error.message, /does not match/);
  });

  it('names the field when the decrypted result is missing one', async () => {
    const { pesepay } = harness(() =>
      envelopeResponse(200, { referenceNumber: 'PSP-REF-0001', amountDetails: {} }),
    );

    const error = await rejection(() => pesepay.checkPayment('PSP-REF-0001'));

    assert.ok(error instanceof PesepayApiError);
    assert.match(error.message, /transactionStatus/);
  });

  it('names redirectUrl when an initiate response omits it', async () => {
    const { pesepay } = harness(() =>
      envelopeResponse(200, { referenceNumber: 'PSP-REF-0001', pollUrl: CHECK_URL }),
    );

    const error = await rejection(() =>
      pesepay.initiateTransaction({ amount: 1, currencyCode: 'USD', reasonForPayment: 'Test' }),
    );

    assert.ok(error instanceof PesepayApiError);
    assert.match(error.message, /redirectUrl/);
  });
});

describe('Pesepay — round trip through a fake gateway', () => {
  it('decodes an initiate response', async () => {
    const { pesepay } = harness(() => envelopeResponse(200, initiateResponse()));

    const response = await pesepay.initiateTransaction({
      amount: 10.5,
      currencyCode: 'USD',
      reasonForPayment: 'Order #1024',
    });

    assert.deepEqual(response, {
      referenceNumber: 'PSP-REF-0001',
      pollUrl: `${CHECK_URL}?referenceNumber=PSP-REF-0001`,
      // Only ever available here — the server has the field on
      // PaymentTransactionResult commented out.
      redirectUrl: 'https://pay.pesepay.com/checkout/PSP-REF-0001',
    });
  });

  it('decodes a successful payment, with the real status and both derivations', async () => {
    const { pesepay } = harness(() => envelopeResponse(200, transactionResult()));

    const result = await pesepay.checkPayment('PSP-REF-0001');

    assert.equal(result.transactionStatus, status.TransactionStatus.SUCCESS);
    assert.equal(result.transactionStatusCode, 304);
    assert.equal(result.transactionStatusDescription, 'Transaction was successfully completed');
    assert.equal(result.paid, true);
    assert.equal(result.isTerminal, true);

    // Everything v1 discarded. `merchantAmount` is what actually settles.
    assert.equal(result.referenceNumber, 'PSP-REF-0001');
    assert.equal(result.amountDetails?.merchantAmount, 10.5);
    assert.equal(result.amountDetails?.customerPayableAmount, 10.75);
    assert.deepEqual(result.transactionMetadata, { orderId: '1024' });
  });

  it('decodes a seamless payment the same way', async () => {
    const { pesepay } = harness(() =>
      envelopeResponse(
        200,
        transactionResult({ transactionStatus: 'PENDING', transactionStatusCode: 303 }),
      ),
    );

    const result = await pesepay.makeSeamlessPayment({
      amount: 10.5,
      currencyCode: 'USD',
      paymentMethodCode: 'PZW211',
      reasonForPayment: 'Order #1024',
      customer: { phoneNumber: '0771111111' },
    });

    // The usual outcome: the customer's handset is still showing the prompt.
    assert.equal(result.transactionStatus, 'PENDING');
    assert.equal(result.paid, false);
    assert.equal(result.isTerminal, false);
  });

  it('derives paid and isTerminal independently across the interesting statuses', async () => {
    const expected: Array<[string, boolean, boolean]> = [
      // status, paid, isTerminal
      ['SUCCESS', true, true],
      ['PENDING', false, false],
      ['INITIATED', false, false],
      ['PROCESSING', false, false],
      // Money arrived, but not all of it — still in flight, and not paid.
      ['PARTIALLY_PAID', false, false],
      // Was successful, then was not. Terminal, and emphatically not paid.
      ['REVERSED', false, true],
      ['DECLINED', false, true],
      ['INSUFFICIENT_FUNDS', false, true],
      ['TIME_OUT', false, true],
      // A status this SDK has never heard of: terminal, so a poll loop stops,
      // and never paid, so nothing is credited on a guess.
      ['SOME_FUTURE_STATUS', false, true],
    ];

    for (const [transactionStatus, paid, terminal] of expected) {
      const { pesepay } = harness(() =>
        envelopeResponse(200, transactionResult({ transactionStatus })),
      );
      const result = await pesepay.checkPayment('PSP-REF-0001');

      assert.equal(result.transactionStatus, transactionStatus);
      assert.equal(result.paid, paid, `${transactionStatus}: paid`);
      assert.equal(result.isTerminal, terminal, `${transactionStatus}: isTerminal`);
    }
  });

  it('returns a frozen result that survives JSON.stringify', async () => {
    const { pesepay } = harness(() => envelopeResponse(200, transactionResult()));

    const result = await pesepay.checkPayment('PSP-REF-0001');

    assert.ok(Object.isFrozen(result));

    // Plain data, not getters — so it can go through a queue, a cache, or a
    // structured log and still answer the same questions on the other side.
    const round = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    assert.equal(round.paid, true);
    assert.equal(round.isTerminal, true);
    assert.equal(round.transactionStatus, 'SUCCESS');
  });

  it('does not let the gateway overwrite the derived fields', async () => {
    const { pesepay } = harness(() =>
      envelopeResponse(
        200,
        transactionResult({ transactionStatus: 'DECLINED' } as Partial<PaymentTransactionResult>),
      ),
    );

    const result = await pesepay.checkPayment('PSP-REF-0001');

    assert.equal(result.paid, false);
    assert.equal(result.isTerminal, true);
  });

  it('honours a custom timeout on every call', async () => {
    const { pesepay, sent } = harness(() => envelopeResponse(200, transactionResult()), {
      timeoutMs: 1234,
    });

    await pesepay.checkPayment('PSP-REF-0001');

    assert.equal(firstRequest(sent).timeoutMs, 1234);
  });
});
