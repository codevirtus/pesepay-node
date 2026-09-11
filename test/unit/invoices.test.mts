/**
 * Invoices — `initiateInvoice` and `checkInvoice`, through a fake gateway that
 * decrypts what it is sent and encrypts what it returns.
 *
 * Unlike the catalogue, these *are* the encrypted endpoints, so the round trip
 * is the centre of the file: the fake gateway decrypts the request body with
 * the same key the client encrypted it with, and answers with real ciphertext.
 * A client that stopped encrypting would fail at the gateway rather than
 * quietly pass.
 *
 * The rest pins the four things about this endpoint that are unlike the others
 * — `applicationCode` being required, `MM/DD/YYYY` dates, the `currencyCode`
 * request key against the `currency` reply key, and a `pollUrl` carrying
 * `?invoiceNumber=` rather than `?referenceNumber=`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { InitiateInvoiceOptions, PesepayOptions } from '../../src/client.ts';
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from '../../src/internal/transport.ts';
import { client, crypto, errors } from '../fixtures/modules.mts';

const { DEFAULT_BASE_URL, Pesepay } = client;
const { PesepayApiError, PesepayAuthError, PesepayConfigError } = errors;

const INTEGRATION_KEY = 'integration-key-for-tests-0123456789';
const ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';

const RESULT_URL = 'https://merchant.example/pesepay/webhook';
const RETURN_URL = 'https://merchant.example/checkout/done';

const INVOICE_INITIATE_URL = `${DEFAULT_BASE_URL}/v1/payments/invoice/initiate`;
const INVOICE_CHECK_URL = `${DEFAULT_BASE_URL}/v1/payments/invoice/check`;

const INVOICE_NUMBER = '0001042';

type Responder = (request: TransportRequest) => TransportResponse | Promise<TransportResponse>;

interface Harness {
  pesepay: InstanceType<typeof Pesepay>;
  sent: TransportRequest[];
}

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

function jsonResponse(status: number, body: unknown): TransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    usedInsecureHttpParser: false,
  };
}

function envelopeResponse(status: number, plaintext: unknown): TransportResponse {
  return jsonResponse(status, {
    payload: crypto.encryptPayload(ENCRYPTION_KEY, JSON.stringify(plaintext)),
  });
}

/** Decrypts what the client actually put on the wire. */
function decryptRequest(request: TransportRequest): Record<string, unknown> {
  assert.ok(request.body !== undefined, 'expected a request body');
  const envelope = JSON.parse(request.body) as { payload?: unknown };
  assert.equal(typeof envelope.payload, 'string', 'expected a { payload } envelope');
  return JSON.parse(crypto.decryptPayload(ENCRYPTION_KEY, envelope.payload as string)) as Record<
    string,
    unknown
  >;
}

/** The server's `Invoice` entity as it serialises back. */
function invoiceBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: 'k3Ld9xQ2',
    invoiceNumber: INVOICE_NUMBER,
    initiatorReference: 'INV-2026-0042',
    transaction: null,
    payer: { name: 'Tendai Moyo', email: 'tendai@example.com', phoneNumber: '0771111111' },
    amount: 120.5,
    narrative: 'Consulting, September',
    // Note the asymmetry: the request sends `currencyCode: "USD"`, the reply
    // carries the whole currency record under `currency`.
    currency: { name: 'United States Dollar', code: 'USD', rateToDefault: 1, active: true },
    application: { applicationCode: 'APP-001', applicationName: 'Example Store' },
    processingDate: '09/11/2026',
    dueDate: '09/25/2026',
    recurringPayment: false,
    recurringFrequency: null,
    processed: false,
    cancelled: false,
    payerNotified: false,
    // The gotcha: invoiceNumber, not referenceNumber.
    pollUrl: `${INVOICE_CHECK_URL}?invoiceNumber=${INVOICE_NUMBER}`,
    invoiceStatus: 'OPEN',
    resultUrl: RESULT_URL,
    returnUrl: RETURN_URL,
    createdDate: '2026-09-11 09:15:00',
    version: 1,
    deleted: false,
    ...overrides,
  };
}

function invoiceOptions(overrides: Partial<InitiateInvoiceOptions> = {}): InitiateInvoiceOptions {
  return {
    amount: 120.5,
    currencyCode: 'USD',
    narrative: 'Consulting, September',
    payer: { name: 'Tendai Moyo', email: 'tendai@example.com', phoneNumber: '0771111111' },
    applicationCode: 'APP-001',
    processingDate: '2026-09-11',
    dueDate: '2026-09-25',
    initiatorReference: 'INV-2026-0042',
    ...overrides,
  };
}

describe('initiateInvoice', () => {
  it('round-trips through a gateway that really decrypts', async () => {
    let received: Record<string, unknown> | undefined;

    const { pesepay, sent } = harness((request) => {
      received = decryptRequest(request);
      return envelopeResponse(200, invoiceBody());
    });

    const invoice = await pesepay.initiateInvoice(invoiceOptions());

    assert.equal(sent[0]?.method, 'POST');
    assert.equal(sent[0]?.url, INVOICE_INITIATE_URL);
    assert.equal(sent[0]?.headers.key, INTEGRATION_KEY);

    assert.ok(received !== undefined);
    assert.equal(received.amount, 120.5);
    assert.equal(received.narrative, 'Consulting, September');
    assert.equal(received.applicationCode, 'APP-001');
    assert.equal(received.initiatorReference, 'INV-2026-0042');
    assert.equal(received.resultUrl, RESULT_URL);
    assert.equal(received.returnUrl, RETURN_URL);
    assert.equal(received.recurringPayment, false);
    assert.deepEqual(received.payer, {
      name: 'Tendai Moyo',
      email: 'tendai@example.com',
      phoneNumber: '0771111111',
    });

    assert.equal(invoice.invoiceNumber, INVOICE_NUMBER);
    assert.equal(invoice.invoiceStatus, 'OPEN');
    assert.equal(invoice.amount, 120.5);
    assert.equal(invoice.currency?.code, 'USD');
    assert.ok(Object.isFrozen(invoice));
  });

  it('sends the currency as `currencyCode`, a string, not a `currency` object', async () => {
    // The Java field is `Currency currency` with @JsonProperty("currencyCode")
    // and a code-lookup deserialiser, so the request key and the reply key
    // differ. Sending `currency` gets it dropped and the invoice rejected.
    let received: Record<string, unknown> | undefined;

    const { pesepay } = harness((request) => {
      received = decryptRequest(request);
      return envelopeResponse(200, invoiceBody());
    });

    await pesepay.initiateInvoice(invoiceOptions({ currencyCode: 'ZWG' }));

    assert.equal(received?.currencyCode, 'ZWG');
    assert.equal('currency' in (received ?? {}), false);
  });

  it('puts ciphertext on the wire, never the cleartext invoice', async () => {
    const { pesepay, sent } = harness(() => envelopeResponse(200, invoiceBody()));

    await pesepay.initiateInvoice(invoiceOptions({ narrative: 'a-very-distinctive-narrative' }));

    const body = sent[0]?.body ?? '';
    assert.ok(!body.includes('a-very-distinctive-narrative'));
    assert.ok(!body.includes('tendai@example.com'));
    assert.ok(!body.includes('APP-001'));
    assert.ok(!body.includes(ENCRYPTION_KEY));
  });

  it('returns a pollUrl carrying ?invoiceNumber=, which pollTransaction accepts', async () => {
    const responses: TransportResponse[] = [
      envelopeResponse(200, invoiceBody()),
      envelopeResponse(200, {
        referenceNumber: INVOICE_NUMBER,
        transactionStatus: 'PENDING',
        transactionStatusCode: 300,
      }),
    ];

    const { pesepay, sent } = harness(() => {
      const next = responses.shift();
      assert.ok(next !== undefined, 'unexpected third request');
      return next;
    });

    const invoice = await pesepay.initiateInvoice(invoiceOptions());

    assert.equal(invoice.pollUrl, `${INVOICE_CHECK_URL}?invoiceNumber=${INVOICE_NUMBER}`);
    assert.ok(!String(invoice.pollUrl).includes('referenceNumber'));

    const result = await pesepay.pollTransaction(invoice.pollUrl as string);

    assert.equal(sent[1]?.url, invoice.pollUrl);
    assert.equal(result.transactionStatus, 'PENDING');
    assert.equal(result.paid, false);
    assert.equal(result.isTerminal, false);
  });

  describe('dates', () => {
    async function sentDates(
      overrides: Partial<InitiateInvoiceOptions>,
    ): Promise<Record<string, unknown>> {
      let received: Record<string, unknown> | undefined;
      const { pesepay } = harness((request) => {
        received = decryptRequest(request);
        return envelopeResponse(200, invoiceBody());
      });
      await pesepay.initiateInvoice(invoiceOptions(overrides));
      assert.ok(received !== undefined);
      return received;
    }

    it('converts ISO YYYY-MM-DD to the gateway MM/DD/YYYY', async () => {
      const received = await sentDates({
        processingDate: '2026-09-11',
        dueDate: '2026-12-01',
      });

      assert.equal(received.processingDate, '09/11/2026');
      assert.equal(received.dueDate, '12/01/2026');
    });

    it('passes MM/DD/YYYY through unchanged', async () => {
      const received = await sentDates({
        processingDate: '09/11/2026',
        dueDate: '12/01/2026',
      });

      assert.equal(received.processingDate, '09/11/2026');
      assert.equal(received.dueDate, '12/01/2026');
    });

    it('reads a Date in UTC, not local time', async () => {
      // `new Date('2026-09-11')` is UTC midnight. Reading local components off
      // it reports the 10th for every caller west of Greenwich, which is a due
      // date silently one day early and nothing downstream to flag it.
      const received = await sentDates({
        processingDate: new Date('2026-09-11T00:00:00.000Z'),
        dueDate: new Date('2026-12-01T23:59:59.000Z'),
      });

      assert.equal(received.processingDate, '09/11/2026');
      assert.equal(received.dueDate, '12/01/2026');
    });

    it('pads single-digit months and days', async () => {
      const received = await sentDates({
        processingDate: new Date('2026-01-02T00:00:00.000Z'),
        dueDate: '2026-03-04',
      });

      assert.equal(received.processingDate, '01/02/2026');
      assert.equal(received.dueDate, '03/04/2026');
    });

    it('rejects an ISO datetime string, which the gateway cannot parse', async () => {
      const { pesepay, sent } = harness(() => envelopeResponse(200, invoiceBody()));

      await assert.rejects(
        () => pesepay.initiateInvoice(invoiceOptions({ dueDate: '2026-09-25T12:00:00.000Z' })),
        (error: unknown) => {
          assert.ok(error instanceof PesepayConfigError);
          assert.match(error.message, /dueDate/);
          assert.match(error.message, /MM\/DD\/YYYY/);
          return true;
        },
      );
      assert.equal(sent.length, 0);
    });

    it('rejects an Invalid Date rather than sending NaN/NaN/NaN', async () => {
      const { pesepay, sent } = harness(() => envelopeResponse(200, invoiceBody()));

      await assert.rejects(
        () => pesepay.initiateInvoice(invoiceOptions({ processingDate: new Date('nonsense') })),
        (error: unknown) => {
          assert.ok(error instanceof PesepayConfigError);
          assert.match(error.message, /Invalid Date/);
          return true;
        },
      );
      assert.equal(sent.length, 0);
    });

    it('rejects a date that is not on the calendar instead of rolling it over', async () => {
      const { pesepay } = harness(() => envelopeResponse(200, invoiceBody()));

      await assert.rejects(
        () => pesepay.initiateInvoice(invoiceOptions({ dueDate: '2026-02-30' })),
        (error: unknown) => {
          assert.ok(error instanceof PesepayConfigError);
          assert.match(error.message, /not a real calendar date/);
          return true;
        },
      );
    });

    it('accepts a leap day in a leap year', async () => {
      const received = await sentDates({ dueDate: '2028-02-29' });
      assert.equal(received.dueDate, '02/29/2028');
    });
  });

  describe('validation, before any socket', () => {
    async function rejectsWith(
      overrides: Partial<InitiateInvoiceOptions>,
      pattern: RegExp,
    ): Promise<void> {
      const { pesepay, sent } = harness(() => envelopeResponse(200, invoiceBody()));

      await assert.rejects(
        () => pesepay.initiateInvoice(invoiceOptions(overrides)),
        (error: unknown) => {
          assert.ok(
            error instanceof PesepayConfigError,
            `expected PesepayConfigError, got ${String(error)}`,
          );
          assert.match(error.message, pattern);
          return true;
        },
      );
      assert.equal(sent.length, 0, 'nothing should reach the transport');
    }

    it('requires applicationCode, which the gateway answers 500 for', async () => {
      await rejectsWith({ applicationCode: '' }, /applicationCode is required/);
      await rejectsWith({ applicationCode: '   ' }, /rather than from your integration key/);
    });

    it('requires a payer with both a name and an email', async () => {
      await rejectsWith({ payer: { name: '', email: 'a@b.c' } }, /name and an email/);
      await rejectsWith({ payer: { name: 'Tendai', email: '' } }, /name and an email/);
      await rejectsWith({ payer: { name: 'Tendai', email: '   ' } }, /name and an email/);
    });

    it('requires a recurringFrequency when recurring is true', async () => {
      await rejectsWith({ recurring: true }, /recurringFrequency is required/);
    });

    it('requires a narrative, a currency code and a positive amount', async () => {
      await rejectsWith({ narrative: '  ' }, /narrative is required/);
      await rejectsWith({ currencyCode: '' }, /currencyCode is required/);
      await rejectsWith({ amount: 0 }, /amount must be a positive/);
      await rejectsWith({ amount: -5 }, /amount must be a positive/);
    });

    it('requires a resultUrl, explaining the "NONE" substitution', async () => {
      const { pesepay, sent } = harness(() => envelopeResponse(200, invoiceBody()), {
        resultUrl: undefined,
      });

      await assert.rejects(
        () => pesepay.initiateInvoice(invoiceOptions()),
        (error: unknown) => {
          assert.ok(error instanceof PesepayConfigError);
          assert.match(error.message, /resultUrl is required/);
          return true;
        },
      );
      assert.equal(sent.length, 0);
    });
  });

  it('sends recurringFrequency only when recurring, and omits absent options', async () => {
    let received: Record<string, unknown> | undefined;
    const { pesepay } = harness((request) => {
      received = decryptRequest(request);
      return envelopeResponse(200, invoiceBody());
    });

    await pesepay.initiateInvoice(
      invoiceOptions({ recurring: true, recurringFrequency: 'EVERY_MONTH' }),
    );

    assert.equal(received?.recurringPayment, true);
    assert.equal(received?.recurringFrequency, 'EVERY_MONTH');

    await pesepay.initiateInvoice(
      // A frequency without `recurring` is a contradiction; the flag governs.
      invoiceOptions({ recurringFrequency: 'DAILY', initiatorReference: undefined }),
    );

    assert.equal(received?.recurringPayment, false);
    assert.equal('recurringFrequency' in (received ?? {}), false);
    // Absent, not null: the server's @NotBlank validators treat them
    // differently.
    assert.equal('initiatorReference' in (received ?? {}), false);
  });

  it('maps a duplicate initiatorReference to PesepayApiError with the server message', async () => {
    const { pesepay } = harness(() =>
      jsonResponse(400, {
        message: 'Duplicate initiator reference for invoice by initiator',
        status: 400,
      }),
    );

    await assert.rejects(
      () => pesepay.initiateInvoice(invoiceOptions()),
      (error: unknown) => {
        assert.ok(error instanceof PesepayApiError);
        assert.equal(error.status, 400);
        assert.equal(error.serverMessage, 'Duplicate initiator reference for invoice by initiator');
        // A duplicate will still be a duplicate in ten minutes.
        assert.equal(error.isRetryable(), false);
        return true;
      },
    );
  });

  it('maps 404 to PesepayAuthError without touching the decryptor', async () => {
    const { pesepay } = harness(() => jsonResponse(404, { message: 'Not Found', status: 404 }));

    await assert.rejects(
      () => pesepay.initiateInvoice(invoiceOptions()),
      (error: unknown) => {
        assert.ok(error instanceof PesepayAuthError);
        assert.match(error.message, /404/);
        return true;
      },
    );
  });

  it('rejects a reply with no invoiceNumber', async () => {
    const { pesepay } = harness(() =>
      envelopeResponse(200, invoiceBody({ invoiceNumber: undefined })),
    );

    await assert.rejects(
      () => pesepay.initiateInvoice(invoiceOptions()),
      (error: unknown) => {
        assert.ok(error instanceof PesepayApiError);
        assert.match(error.message, /it has no invoiceNumber/);
        // Decrypted invoice data is payer data; it must not ride on the error.
        assert.equal(error.responseBody, undefined);
        return true;
      },
    );
  });
});

describe('checkInvoice', () => {
  it('queries ?invoiceNumber= and decodes a PaymentTransactionResult', async () => {
    const { pesepay, sent } = harness(() =>
      envelopeResponse(200, {
        referenceNumber: INVOICE_NUMBER,
        transactionStatus: 'SUCCESS',
        transactionStatusCode: 304,
        transactionStatusDescription: 'Transaction was successfully completed',
        amountDetails: { amount: 120.5, currencyCode: 'USD', merchantAmount: 118.1 },
      }),
    );

    const result = await pesepay.checkInvoice(INVOICE_NUMBER);

    assert.equal(sent[0]?.method, 'GET');
    assert.equal(sent[0]?.url, `${INVOICE_CHECK_URL}?invoiceNumber=${INVOICE_NUMBER}`);
    assert.equal(sent[0]?.headers.key, INTEGRATION_KEY);

    assert.equal(result.referenceNumber, INVOICE_NUMBER);
    assert.equal(result.transactionStatus, 'SUCCESS');
    assert.equal(result.paid, true);
    assert.equal(result.isTerminal, true);
    assert.equal(result.amountDetails?.merchantAmount, 118.1);
  });

  it('builds the query through URL rather than concatenating it', async () => {
    const { pesepay, sent } = harness(() =>
      envelopeResponse(200, { referenceNumber: 'x', transactionStatus: 'PENDING' }),
    );

    await pesepay.checkInvoice('inv 42&foo=bar');

    assert.equal(sent[0]?.url, `${INVOICE_CHECK_URL}?invoiceNumber=inv+42%26foo%3Dbar`);
  });

  it('rejects a blank invoice number before any socket', async () => {
    const { pesepay, sent } = harness(() => envelopeResponse(200, {}));

    await assert.rejects(() => pesepay.checkInvoice('   '), PesepayConfigError);
    assert.equal(sent.length, 0);
  });

  it('reports an unpaid invoice as a real status, not a boolean', async () => {
    const { pesepay } = harness(() =>
      envelopeResponse(200, {
        referenceNumber: INVOICE_NUMBER,
        transactionStatus: 'INSUFFICIENT_FUNDS',
        transactionStatusCode: 306,
      }),
    );

    const result = await pesepay.checkInvoice(INVOICE_NUMBER);

    assert.equal(result.transactionStatus, 'INSUFFICIENT_FUNDS');
    assert.equal(result.paid, false);
    assert.equal(result.isTerminal, true, 'stop polling; the payer must try again');
  });
});
