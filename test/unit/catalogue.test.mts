/**
 * The catalogue endpoints — `getActiveCurrencies`, `getPaymentMethods`,
 * `getActivePaymentMethods`.
 *
 * These are the endpoints that are *not* like the others, and the tests here
 * exist mostly to pin that difference. Three properties carry the weight:
 *
 * 1. **The response is plain JSON, not the `{ payload }` envelope.** Asserted
 *    by answering with a bare array and expecting it to parse. A client that
 *    reached for `.payload` would fail every case in this file.
 * 2. **Nothing is encrypted, in either direction.** Asserted positively, by
 *    handing back an *enveloped* body and requiring it to be rejected rather
 *    than silently decrypted — a client that tried both would pass a naive
 *    round-trip test and this one catches it.
 * 3. **No credential is sent.** These paths are `permitAll()` on the gateway,
 *    so the integration key would buy nothing and is deliberately withheld.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PesepayOptions } from '../../src/client.ts';
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from '../../src/internal/transport.ts';
import { client, crypto, errors } from '../fixtures/modules.mts';

const { DEFAULT_BASE_URL, Pesepay } = client;
const { PesepayApiError, PesepayAuthError, PesepayConfigError, PesepayCryptoError } = errors;

const INTEGRATION_KEY = 'integration-key-for-tests-0123456789';
const ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';

const CURRENCIES_URL = `${DEFAULT_BASE_URL}/v1/currencies/active`;
const FOR_CURRENCY_URL = `${DEFAULT_BASE_URL}/v1/payment-methods/for-currency`;
const ALL_ACTIVE_URL = `${DEFAULT_BASE_URL}/v1/payment-methods/all-active`;

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

/** As the gateway's `Currency` entity serialises, auditing columns included. */
const USD = {
  name: 'United States Dollar',
  description: 'US Dollar',
  code: 'USD',
  defaultCurrency: true,
  rateToDefault: 1,
  active: true,
  createdDate: '2024-01-05 09:00:00',
  version: 3,
  deleted: false,
};

const ZWG = {
  name: 'Zimbabwe Gold',
  description: 'ZiG',
  code: 'ZWG',
  defaultCurrency: false,
  rateToDefault: 26.4,
  active: true,
};

/** As the gateway's `PaymentMethod` entity serialises. */
const ECOCASH = {
  name: 'Ecocash',
  description: 'Ecocash mobile money',
  code: 'PZW201',
  maximumAmount: 3000,
  minimumAmount: 1,
  redirectRequired: false,
  active: true,
  currencies: ['USD', 'ZWG'],
  processingPaymentMessage: 'Check your phone to authorise the payment',
  requiredFields: [
    {
      name: 'customerPhoneNumber',
      displayName: 'Phone number',
      fieldType: 'TEXT',
      optional: false,
    },
  ],
  // The entity leaks internal routing config. It must survive untouched rather
  // than be dropped, but nothing in the SDK's types promises it.
  reverseProxyName: 'ecocash-service',
};

const VISA = {
  name: 'Visa / Mastercard',
  description: 'Card payment',
  code: 'PZW204',
  maximumAmount: 10000,
  minimumAmount: 1,
  redirectRequired: true,
  redirectURL: 'https://pay.example/cards',
  active: true,
  currencies: ['USD'],
  requiredFields: [],
};

describe('getActiveCurrencies', () => {
  it('reads a plain JSON array from /v1/currencies/active', async () => {
    const { pesepay, sent } = harness(() => jsonResponse(200, [USD, ZWG]));

    const currencies = await pesepay.getActiveCurrencies();

    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.method, 'GET');
    assert.equal(sent[0]?.url, CURRENCIES_URL);

    assert.equal(currencies.length, 2);
    assert.equal(currencies[0]?.code, 'USD');
    assert.equal(currencies[0]?.name, 'United States Dollar');
    assert.equal(currencies[0]?.defaultCurrency, true);
    assert.equal(currencies[0]?.rateToDefault, 1);
    assert.equal(currencies[1]?.code, 'ZWG');
  });

  it('sends no request body and no envelope', async () => {
    const { pesepay, sent } = harness(() => jsonResponse(200, []));

    await pesepay.getActiveCurrencies();

    assert.equal(sent[0]?.body, undefined);
  });

  it('does not send the integration key to an endpoint that is permitAll()', async () => {
    const { pesepay, sent } = harness(() => jsonResponse(200, [USD]));

    await pesepay.getActiveCurrencies();

    const headers = sent[0]?.headers ?? {};
    // Case-insensitive, because a header name is.
    for (const [name, value] of Object.entries(headers)) {
      assert.notEqual(
        name.toLowerCase(),
        'key',
        'the catalogue endpoints are unauthenticated; the key must not be sent',
      );
      assert.ok(
        !String(value).includes(INTEGRATION_KEY),
        `the integration key leaked into the ${name} header`,
      );
      assert.ok(!String(value).includes(ENCRYPTION_KEY));
    }
  });

  it('rejects an enveloped body rather than decrypting it', async () => {
    // The negative control for "these endpoints are not encrypted". A client
    // that opportunistically unwrapped `{ payload }` would pass every other
    // test in this file and fail only here.
    const { pesepay } = harness(() =>
      jsonResponse(200, {
        payload: crypto.encryptPayload(ENCRYPTION_KEY, JSON.stringify([USD])),
      }),
    );

    await assert.rejects(
      () => pesepay.getActiveCurrencies(),
      (error: unknown) => {
        assert.ok(error instanceof PesepayApiError);
        assert.ok(!(error instanceof PesepayCryptoError));
        assert.match(error.message, /not a JSON array of currency records/);
        return true;
      },
    );
  });

  it('reports a non-2xx before it looks at the shape', async () => {
    const { pesepay } = harness(() =>
      jsonResponse(503, { message: 'Service Unavailable', status: 503 }),
    );

    await assert.rejects(
      () => pesepay.getActiveCurrencies(),
      (error: unknown) => {
        assert.ok(error instanceof PesepayApiError);
        assert.equal(error.status, 503);
        assert.equal(error.serverMessage, 'Service Unavailable');
        assert.equal(error.isRetryable(), true);
        return true;
      },
    );
  });

  it('maps a 403 to PesepayAuthError, if Pesepay ever secures these', async () => {
    const { pesepay } = harness(() => jsonResponse(403, { message: 'Forbidden' }));

    await assert.rejects(() => pesepay.getActiveCurrencies(), PesepayAuthError);
  });

  it('rejects a body that is not JSON at all', async () => {
    const { pesepay } = harness(() => jsonResponse(200, '<html>gateway</html>'));

    await assert.rejects(
      () => pesepay.getActiveCurrencies(),
      (error: unknown) => {
        assert.ok(error instanceof PesepayApiError);
        assert.match(error.message, /the body is not JSON/);
        return true;
      },
    );
  });

  it('rejects an entry with no code', async () => {
    const { pesepay } = harness(() => jsonResponse(200, [USD, { name: 'Broken' }]));

    await assert.rejects(
      () => pesepay.getActiveCurrencies(),
      (error: unknown) => {
        assert.ok(error instanceof PesepayApiError);
        assert.match(error.message, /currency 1 has no code/);
        return true;
      },
    );
  });

  it('freezes each entry', async () => {
    const { pesepay } = harness(() => jsonResponse(200, [USD]));

    const [usd] = await pesepay.getActiveCurrencies();

    assert.ok(usd !== undefined);
    assert.ok(Object.isFrozen(usd));
  });
});

describe('getPaymentMethods', () => {
  it('reads /v1/payment-methods/for-currency with the currency in the query', async () => {
    const { pesepay, sent } = harness(() => jsonResponse(200, [ECOCASH, VISA]));

    const methods = await pesepay.getPaymentMethods('USD');

    assert.equal(sent[0]?.method, 'GET');
    assert.equal(sent[0]?.url, `${FOR_CURRENCY_URL}?currencyCode=USD`);
    assert.equal(methods.length, 2);
  });

  it('surfaces requiredFields, the amount bounds, and redirectRequired', async () => {
    // The three fields a merchant cannot get any other way. Without
    // redirectRequired there is no way to know a method cannot be charged
    // seamlessly at all, and the failure shows up mid-checkout instead.
    const { pesepay } = harness(() => jsonResponse(200, [ECOCASH, VISA]));

    const [ecocash, visa] = await pesepay.getPaymentMethods('USD');

    assert.ok(ecocash !== undefined);
    assert.equal(ecocash.code, 'PZW201');
    assert.equal(ecocash.redirectRequired, false);
    assert.equal(ecocash.minimumAmount, 1);
    assert.equal(ecocash.maximumAmount, 3000);
    assert.deepEqual(ecocash.currencies, ['USD', 'ZWG']);
    assert.equal(ecocash.processingPaymentMessage, 'Check your phone to authorise the payment');

    const [field] = ecocash.requiredFields ?? [];
    assert.ok(field !== undefined);
    // `name` is the wire key for `requiredFields` on a seamless payment;
    // `displayName` is for the merchant's UI. Mixing them up is silent.
    assert.equal(field.name, 'customerPhoneNumber');
    assert.equal(field.displayName, 'Phone number');
    assert.equal(field.fieldType, 'TEXT');
    assert.equal(field.optional, false);

    assert.ok(visa !== undefined);
    assert.equal(visa.redirectRequired, true, 'cards cannot be charged seamlessly');
    assert.equal(visa.redirectURL, 'https://pay.example/cards');
  });

  it('preserves fields the SDK does not model', async () => {
    const { pesepay } = harness(() => jsonResponse(200, [ECOCASH]));

    const [ecocash] = await pesepay.getPaymentMethods('USD');

    assert.equal(
      (ecocash as unknown as Record<string, unknown>)?.reverseProxyName,
      'ecocash-service',
    );
  });

  it('encodes a currency code through URL rather than concatenating it', async () => {
    const { pesepay, sent } = harness(() => jsonResponse(200, []));

    await pesepay.getPaymentMethods('US D&x');

    assert.equal(sent[0]?.url, `${FOR_CURRENCY_URL}?currencyCode=US+D%26x`);
  });

  it('rejects a blank currency code before any socket', async () => {
    const { pesepay, sent } = harness(() => jsonResponse(200, []));

    await assert.rejects(() => pesepay.getPaymentMethods('  '), PesepayConfigError);
    assert.equal(sent.length, 0);
  });

  it('sends no credential', async () => {
    const { pesepay, sent } = harness(() => jsonResponse(200, [ECOCASH]));

    await pesepay.getPaymentMethods('USD');

    const names = Object.keys(sent[0]?.headers ?? {}).map((name) => name.toLowerCase());
    assert.ok(!names.includes('key'));
    assert.ok(!names.includes('authorization'));
  });

  it('rejects an enveloped body rather than decrypting it', async () => {
    const { pesepay } = harness(() =>
      jsonResponse(200, {
        payload: crypto.encryptPayload(ENCRYPTION_KEY, JSON.stringify([ECOCASH])),
      }),
    );

    await assert.rejects(
      () => pesepay.getPaymentMethods('USD'),
      (error: unknown) => {
        assert.ok(error instanceof PesepayApiError);
        assert.ok(!(error instanceof PesepayCryptoError));
        assert.match(error.message, /not a JSON array of payment method records/);
        return true;
      },
    );
  });
});

describe('getActivePaymentMethods', () => {
  it('reads /v1/payment-methods/all-active, not /active', async () => {
    // `/v1/payment-methods/active` is a different endpoint returning a reduced
    // DTO with every redirect-required method filtered out — which would make
    // cards silently invisible. This pins the path.
    const { pesepay, sent } = harness(() => jsonResponse(200, [ECOCASH, VISA]));

    const methods = await pesepay.getActivePaymentMethods();

    assert.equal(sent[0]?.url, ALL_ACTIVE_URL);
    assert.equal(sent[0]?.method, 'GET');
    assert.equal(methods.length, 2);
    assert.equal(
      methods.some((method) => method.redirectRequired === true),
      true,
      'the full shape includes redirect-required methods',
    );
  });

  it('returns the full PaymentMethod shape, not the reduced DTO', async () => {
    const { pesepay } = harness(() => jsonResponse(200, [ECOCASH]));

    const [ecocash] = await pesepay.getActivePaymentMethods();

    // The reduced DTO has only name, code, acceptedCurrencies and
    // required-field *names*. These four fields are how you tell them apart.
    assert.ok(ecocash !== undefined);
    assert.equal(typeof ecocash.minimumAmount, 'number');
    assert.equal(typeof ecocash.maximumAmount, 'number');
    assert.equal(typeof ecocash.redirectRequired, 'boolean');
    assert.equal(typeof ecocash.requiredFields?.[0]?.displayName, 'string');
  });

  it('sends no credential', async () => {
    const { pesepay, sent } = harness(() => jsonResponse(200, []));

    await pesepay.getActivePaymentMethods();

    const names = Object.keys(sent[0]?.headers ?? {}).map((name) => name.toLowerCase());
    assert.ok(!names.includes('key'));
  });

  it('accepts an empty catalogue', async () => {
    const { pesepay } = harness(() => jsonResponse(200, []));

    assert.deepEqual(await pesepay.getActivePaymentMethods(), []);
  });
});
