/**
 * `parseCallback` — the webhook path, and the only place in this SDK where the
 * SDK is the *server*.
 *
 * The gateway POSTs a plain, unencrypted `PaymentTransactionResult` to the
 * merchant's `resultUrl`, with no HMAC and no signature. The only credential is
 * an `Authorization` header holding the integration key verbatim, and the
 * gateway omits it entirely when its own key lookup fails — posting the body
 * anyway. So there are three outcomes, not two, and each has a test here:
 *
 * | header | keyStatus | keyVerified |
 * |---|---|---|
 * | present, matching | `matched` | `true` |
 * | present, wrong | `mismatched` | `false` |
 * | absent | `absent` | `false` |
 *
 * Two properties beyond the table matter:
 *
 * - **An absent header must not throw.** A webhook endpoint that crashes when
 *   Pesepay's key lookup fails is worse than one that records the fact.
 * - **The comparison must not leak the key's length.** `timingSafeEqual`
 *   throws outright on unequal lengths, so the naive fix is a length check in
 *   front of it — which both short-circuits and answers "how long is the key?".
 *   The last describe block is aimed squarely at that.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { client, errors } from '../fixtures/modules.mts';

const { Pesepay } = client;
const { PesepayConfigError } = errors;

const INTEGRATION_KEY = 'integration-key-for-tests-0123456789';
const ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';

const REFERENCE = 'PSP-REF-0001';

function pesepay(): InstanceType<typeof Pesepay> {
  return new Pesepay({
    integrationKey: INTEGRATION_KEY,
    encryptionKey: ENCRYPTION_KEY,
    resultUrl: 'https://merchant.example/pesepay/webhook',
    transport: async () => {
      throw new Error('parseCallback must not make a request');
    },
  });
}

/** Exactly what `PaymentTransactionResultPosterImpl` serialises and POSTs. */
function callbackBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    referenceNumber: REFERENCE,
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
    resultUrl: 'https://merchant.example/pesepay/webhook',
    transactionMetadata: { orderId: '1024' },
    ...overrides,
  };
}

describe('parseCallback — key verification', () => {
  it('verifies a present, matching Authorization header', async () => {
    const { result, keyVerified, keyStatus } = pesepay().parseCallback(callbackBody(), {
      authorization: INTEGRATION_KEY,
      'content-type': 'application/json',
    });

    assert.equal(keyVerified, true);
    assert.equal(keyStatus, 'matched');
    assert.equal(result.referenceNumber, REFERENCE);
    assert.equal(result.transactionStatus, 'SUCCESS');
  });

  it('reports a present but wrong header as mismatched, and does not throw', async () => {
    const { result, keyVerified, keyStatus } = pesepay().parseCallback(callbackBody(), {
      authorization: 'some-other-integration-key-entirely',
    });

    assert.equal(keyVerified, false);
    assert.equal(keyStatus, 'mismatched');
    // The body is still decoded: the caller decides what to do about it, and a
    // handler that wants to log the reference number needs it.
    assert.equal(result.referenceNumber, REFERENCE);
  });

  it('reports an absent header as absent rather than throwing', async () => {
    // This is the case the gateway actually produces: when
    // findIntegrationKeyForApplication throws RecordNotFoundException it logs a
    // warning, skips the interceptor, and posts the body with no Authorization
    // header at all.
    const { result, keyVerified, keyStatus } = pesepay().parseCallback(callbackBody(), {
      'content-type': 'application/json',
      'user-agent': 'Java/17.0.9',
    });

    assert.equal(keyVerified, false);
    assert.equal(keyStatus, 'absent');
    assert.equal(result.referenceNumber, REFERENCE);
  });

  it('reports absent when no headers are passed at all', async () => {
    const { keyVerified, keyStatus } = pesepay().parseCallback(callbackBody());

    assert.equal(keyVerified, false);
    assert.equal(keyStatus, 'absent');
  });

  it('matches the header whatever case it arrived in', async () => {
    for (const name of ['authorization', 'Authorization', 'AUTHORIZATION', 'AuThOrIzAtIoN']) {
      const { keyVerified } = pesepay().parseCallback(callbackBody(), {
        [name]: INTEGRATION_KEY,
      });
      assert.equal(keyVerified, true, `header name ${name} was not matched`);
    }
  });

  it('accepts a single-element array, as Node folds a repeated header', async () => {
    const { keyVerified } = pesepay().parseCallback(callbackBody(), {
      authorization: [INTEGRATION_KEY],
    });

    assert.equal(keyVerified, true);
  });

  it('treats several Authorization headers as no key presented', async () => {
    // A merged pair is exactly the shape a header-injection attempt takes, and
    // the gateway never sends one. Picking either value and comparing it would
    // let an attacker smuggle the right key alongside a wrong one.
    const { keyVerified, keyStatus } = pesepay().parseCallback(callbackBody(), {
      authorization: ['not-the-key', INTEGRATION_KEY],
    });

    assert.equal(keyVerified, false);
    assert.equal(keyStatus, 'absent');
  });

  it('does not accept a Bearer-prefixed key', async () => {
    // The gateway sets the header to the raw key. Accepting a scheme prefix
    // would only widen what counts as a match, for no real-world gain.
    const { keyVerified } = pesepay().parseCallback(callbackBody(), {
      authorization: `Bearer ${INTEGRATION_KEY}`,
    });

    assert.equal(keyVerified, false);
  });

  it('does not accept a key with surrounding whitespace', async () => {
    const { keyVerified } = pesepay().parseCallback(callbackBody(), {
      authorization: ` ${INTEGRATION_KEY} `,
    });

    assert.equal(keyVerified, false);
  });

  it('does not accept a prefix of the key', async () => {
    const { keyVerified } = pesepay().parseCallback(callbackBody(), {
      authorization: INTEGRATION_KEY.slice(0, -1),
    });

    assert.equal(keyVerified, false);
  });

  it('is never verified against the encryption key', async () => {
    const { keyVerified } = pesepay().parseCallback(callbackBody(), {
      authorization: ENCRYPTION_KEY,
    });

    assert.equal(keyVerified, false);
  });
});

describe('parseCallback — constant-time comparison', () => {
  const cases: Array<[string, string]> = [
    ['empty', ''],
    ['one character', 'x'],
    ['one char short', INTEGRATION_KEY.slice(0, -1)],
    ['one char long', `${INTEGRATION_KEY}x`],
    ['same length, wrong value', 'X'.repeat(INTEGRATION_KEY.length)],
    ['64 KiB', 'a'.repeat(65_536)],
    ['non-ASCII', '🔑'.repeat(64)],
    ['embedded NUL', `${INTEGRATION_KEY.slice(0, 5)}\u0000${INTEGRATION_KEY.slice(6)}`],
  ];

  for (const [label, presented] of cases) {
    it(`answers false for a ${label} header without throwing`, async () => {
      // A length check in front of timingSafeEqual would still answer `false`
      // here — so this is not the leak test on its own. What it pins is that
      // no length reaches timingSafeEqual, which throws on unequal operands:
      // an implementation that passed the raw strings straight through would
      // crash the merchant's webhook endpoint on every one of these.
      const { keyVerified, keyStatus } = pesepay().parseCallback(callbackBody(), {
        authorization: presented,
      });

      assert.equal(keyVerified, false);
      assert.equal(keyStatus, 'mismatched');
    });
  }

  it('does not branch on length: a wrong key of the right length is no different', async () => {
    // The length-leak test proper. A same-length wrong key and a
    // wildly-different-length wrong key must be indistinguishable in both
    // outcome and cost. Outcome is asserted above; cost is asserted here by
    // comparing aggregate timing across many iterations.
    //
    // Timing on a shared CI runner is noisy, so this is written as a ratio with
    // a deliberately loose bound: it catches an implementation that short-
    // circuits on length (where the mismatched-length case is orders of
    // magnitude cheaper, because it never compares anything) without failing
    // on ordinary scheduler jitter.
    const ITERATIONS = 2_000;
    const sameLength = 'X'.repeat(INTEGRATION_KEY.length);
    const veryDifferentLength = 'X';

    const time = (presented: string): number => {
      const subject = pesepay();
      const body = callbackBody();
      const started = process.hrtime.bigint();
      for (let i = 0; i < ITERATIONS; i += 1) {
        subject.parseCallback(body, { authorization: presented });
      }
      return Number(process.hrtime.bigint() - started);
    };

    // Warm both paths so JIT tiering is not what is being measured.
    time(sameLength);
    time(veryDifferentLength);

    const same = time(sameLength);
    const different = time(veryDifferentLength);

    const ratio = Math.max(same, different) / Math.min(same, different);
    assert.ok(
      ratio < 5,
      `comparison cost differs by ${ratio.toFixed(2)}x between a same-length and a ` +
        'different-length key, which suggests the comparison branches on length',
    );
  });

  it('consumes the whole presented value, which a short-circuit cannot', async () => {
    // The two tests either side of this one assert that nothing is *cheaper*
    // than anything else. They cannot, on their own, tell a real constant-time
    // comparison from a plain `===` — which is functionally correct and differs
    // only in timing, and whose timing difference is too small to measure
    // reliably from JavaScript.
    //
    // This one comes at it from the other direction, and asserts a property
    // `===` provably does not have: the comparison must do work proportional to
    // what was presented. A string comparison checks length first and returns
    // immediately, so 64 KiB costs it exactly what one byte costs. Hashing both
    // operands to a fixed width — which is what makes the comparison
    // length-safe in the first place — must read all 64 KiB.
    //
    // So this is the test that fails if the constant-time primitive is ever
    // swapped out for `===` or for a length check that short-circuits.
    const ITERATIONS = 500;
    const short = 'X'.repeat(INTEGRATION_KEY.length);
    const long = 'X'.repeat(1 << 20);

    const time = (presented: string): number => {
      const subject = pesepay();
      const body = callbackBody();
      const started = process.hrtime.bigint();
      for (let i = 0; i < ITERATIONS; i += 1) {
        subject.parseCallback(body, { authorization: presented });
      }
      return Number(process.hrtime.bigint() - started);
    };

    time(short);
    time(long);

    const ratio = time(long) / time(short);
    assert.ok(
      ratio > 3,
      `a 1 MiB header cost only ${ratio.toFixed(2)}x what a ${INTEGRATION_KEY.length}-byte ` +
        'one did, so the comparison is short-circuiting rather than reading its ' +
        'whole input — which means it is not the constant-time primitive',
    );
  });

  it('costs the same for a correct key as for a same-length wrong one', async () => {
    // The other half: a byte-by-byte comparison that returns early on the first
    // differing character makes the correct key measurably more expensive.
    const ITERATIONS = 2_000;
    const wrong = `${INTEGRATION_KEY.slice(0, -1)}X`;

    const time = (presented: string): number => {
      const subject = pesepay();
      const body = callbackBody();
      const started = process.hrtime.bigint();
      for (let i = 0; i < ITERATIONS; i += 1) {
        subject.parseCallback(body, { authorization: presented });
      }
      return Number(process.hrtime.bigint() - started);
    };

    time(INTEGRATION_KEY);
    time(wrong);

    const correct = time(INTEGRATION_KEY);
    const incorrect = time(wrong);

    const ratio = Math.max(correct, incorrect) / Math.min(correct, incorrect);
    assert.ok(ratio < 5, `correct and incorrect keys differ in cost by ${ratio.toFixed(2)}x`);
  });
});

describe('parseCallback — body decoding', () => {
  it('accepts a parsed object, as express.json() produces', async () => {
    const { result } = pesepay().parseCallback(callbackBody());
    assert.equal(result.referenceNumber, REFERENCE);
  });

  it('accepts a JSON string', async () => {
    const { result } = pesepay().parseCallback(JSON.stringify(callbackBody()));
    assert.equal(result.referenceNumber, REFERENCE);
  });

  it('accepts a raw Buffer', async () => {
    const { result } = pesepay().parseCallback(Buffer.from(JSON.stringify(callbackBody()), 'utf8'));
    assert.equal(result.referenceNumber, REFERENCE);
  });

  it('accepts a Uint8Array', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(callbackBody()));
    const { result } = pesepay().parseCallback(bytes);
    assert.equal(result.referenceNumber, REFERENCE);
  });

  it('derives paid and isTerminal exactly as the polled path does', async () => {
    const subject = pesepay();

    const success = subject.parseCallback(callbackBody({ transactionStatus: 'SUCCESS' })).result;
    assert.equal(success.paid, true);
    assert.equal(success.isTerminal, true);

    const pending = subject.parseCallback(callbackBody({ transactionStatus: 'PENDING' })).result;
    assert.equal(pending.paid, false);
    assert.equal(pending.isTerminal, false);

    // The one that matters most: money arrived and then left again. v1's
    // `paid: boolean` reported this identically to a decline.
    const reversed = subject.parseCallback(callbackBody({ transactionStatus: 'REVERSED' })).result;
    assert.equal(reversed.paid, false);
    assert.equal(reversed.isTerminal, true);

    const partial = subject.parseCallback(
      callbackBody({ transactionStatus: 'PARTIALLY_PAID' }),
    ).result;
    assert.equal(partial.paid, false, 'partially paid is not paid');
    assert.equal(partial.isTerminal, false);
  });

  it('preserves everything the gateway sent', async () => {
    const { result } = pesepay().parseCallback(callbackBody());

    assert.equal(result.transactionStatusCode, 304);
    assert.equal(result.transactionStatusDescription, 'Transaction was successfully completed');
    assert.equal(result.amountDetails?.merchantAmount, 10.5);
    assert.deepEqual(result.transactionMetadata, { orderId: '1024' });
    assert.equal(result.applicationName, 'Example Store');
  });

  it('returns a frozen result that survives JSON.stringify', async () => {
    const verification = pesepay().parseCallback(callbackBody());

    assert.ok(Object.isFrozen(verification));
    assert.ok(Object.isFrozen(verification.result));

    // `paid` and `isTerminal` are plain data, not getters, so a result put on a
    // queue arrives with them intact.
    const revived = JSON.parse(JSON.stringify(verification.result)) as Record<string, unknown>;
    assert.equal(revived.paid, true);
    assert.equal(revived.isTerminal, true);
  });

  it('handles the second callback of a SUCCESS-then-REVERSED pair', async () => {
    // The gateway posts on every terminal status change, so one reference
    // number produces two callbacks. This is the pair a handler must be
    // idempotent across; both decode, and they disagree, which is the point.
    const subject = pesepay();
    const headers = { authorization: INTEGRATION_KEY };

    const first = subject.parseCallback(callbackBody({ transactionStatus: 'SUCCESS' }), headers);
    const second = subject.parseCallback(
      callbackBody({ transactionStatus: 'REVERSED', transactionStatusCode: 309 }),
      headers,
    );

    assert.equal(first.result.referenceNumber, second.result.referenceNumber);
    assert.notEqual(first.result.transactionStatus, second.result.transactionStatus);
    assert.equal(first.result.paid, true);
    assert.equal(second.result.paid, false);
    assert.equal(first.keyVerified, true);
    assert.equal(second.keyVerified, true);
  });
});

describe('parseCallback — bodies that are not callbacks', () => {
  function rejects(body: unknown, pattern: RegExp): void {
    assert.throws(
      () => pesepay().parseCallback(body),
      (error: unknown) => {
        assert.ok(
          error instanceof PesepayConfigError,
          `expected PesepayConfigError, got ${String(error)}`,
        );
        assert.match(error.message, pattern);
        return true;
      },
    );
  }

  it('rejects a body with no referenceNumber', () => {
    rejects(callbackBody({ referenceNumber: undefined }), /it has no referenceNumber/);
  });

  it('rejects a body with no transactionStatus', () => {
    rejects(callbackBody({ transactionStatus: undefined }), /it has no transactionStatus/);
  });

  it('rejects an empty body, naming the body-parser trap', () => {
    rejects('', /the body was empty/);
    rejects('   ', /express\.json\(\)/);
  });

  it('rejects undefined, which is what an unparsed express body is', () => {
    rejects(undefined, /not a JSON object \(it was undefined\)/);
  });

  it('rejects a non-JSON string', () => {
    rejects('<html>404</html>', /the body was not JSON/);
  });

  it('rejects an array and null', () => {
    rejects([callbackBody()], /it was an array/);
    rejects(null, /it was null/);
  });

  it('rejects an envelope, explaining that callbacks are never encrypted', () => {
    // The natural mistake: every other payments endpoint is enveloped, so a
    // merchant proxying their webhook through something that re-wraps it would
    // otherwise see only "it has no referenceNumber".
    rejects({ payload: 'IGdpYmJlcmlzaA==' }, /never\s+encrypted/);
  });

  it('does not mistake a real result that happens to carry a payload field', () => {
    // The envelope check requires the payload to be the *only* key, so a
    // gateway that one day adds a `payload` field to the result does not start
    // being rejected.
    const { result } = pesepay().parseCallback(callbackBody({ payload: 'something' }));
    assert.equal(result.referenceNumber, REFERENCE);
  });

  it('never leaks key material into a rejection', () => {
    assert.throws(
      () => pesepay().parseCallback(`{"key":"${INTEGRATION_KEY}"`),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        const surface = `${error.message}\n${error.stack ?? ''}\n${JSON.stringify(error)}`;
        assert.ok(!surface.includes(INTEGRATION_KEY));
        assert.ok(!surface.includes(ENCRYPTION_KEY));
        return true;
      },
    );
  });
});
