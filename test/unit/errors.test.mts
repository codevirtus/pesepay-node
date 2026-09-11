/**
 * The error hierarchy.
 *
 * Two things are load-bearing beyond the obvious `instanceof` plumbing: the
 * status-code mapping, which is genuinely counter-intuitive, and the promise
 * that no error ever carries key material.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { errors } from '../fixtures/modules.mts';

const {
  PesepayApiError,
  PesepayAuthError,
  PesepayConfigError,
  PesepayCryptoError,
  PesepayError,
  PesepayNetworkError,
  PesepayTimeoutError,
} = errors;

describe('errors — hierarchy', () => {
  it('makes every error catchable as PesepayError', () => {
    const all = [
      new PesepayError('x'),
      new PesepayApiError({ status: 500 }),
      new PesepayAuthError({ status: 404 }),
      new PesepayCryptoError('x'),
      new PesepayNetworkError('x'),
      new PesepayTimeoutError('x', 1),
      new PesepayConfigError('x'),
    ];
    for (const error of all) {
      assert.ok(error instanceof PesepayError, `${error.name} must extend PesepayError`);
      assert.ok(error instanceof Error);
      assert.ok(error.stack !== undefined && error.stack.length > 0);
    }
  });

  it('gives each class a distinct name and code', () => {
    const pairs: ReadonlyArray<readonly [Error & { code: string }, string, string]> = [
      [new PesepayError('x'), 'PesepayError', 'ERR_PESEPAY'],
      [new PesepayApiError({ status: 500 }), 'PesepayApiError', 'ERR_PESEPAY_API'],
      [new PesepayAuthError({ status: 404 }), 'PesepayAuthError', 'ERR_PESEPAY_AUTH'],
      [new PesepayCryptoError('x'), 'PesepayCryptoError', 'ERR_PESEPAY_CRYPTO'],
      [new PesepayNetworkError('x'), 'PesepayNetworkError', 'ERR_PESEPAY_NETWORK'],
      [new PesepayTimeoutError('x', 1), 'PesepayTimeoutError', 'ERR_PESEPAY_TIMEOUT'],
      [new PesepayConfigError('x'), 'PesepayConfigError', 'ERR_PESEPAY_CONFIG'],
    ];
    for (const [error, name, code] of pairs) {
      assert.equal(error.name, name);
      assert.equal(error.code, code);
    }
  });

  it('nests the specific classes under the ones you would catch', () => {
    // An auth failure is an API failure; a timeout is a network failure. This
    // is what lets a caller catch broadly and still narrow when it wants to.
    assert.ok(new PesepayAuthError({ status: 403 }) instanceof PesepayApiError);
    assert.ok(new PesepayTimeoutError('x', 1) instanceof PesepayNetworkError);
    assert.ok(!(new PesepayCryptoError('x') instanceof PesepayApiError));
  });

  it('preserves the cause chain', () => {
    const cause = new Error('ECONNRESET');
    assert.equal(new PesepayNetworkError('wrapped', { cause }).cause, cause);
  });

  it('carries the elapsed timeout', () => {
    assert.equal(new PesepayTimeoutError('too slow', 30_000).timeoutMs, 30_000);
  });
});

describe('errors — PesepayApiError', () => {
  it("leads its message with the server's own words", () => {
    const error = new PesepayApiError({
      status: 400,
      serverMessage: 'Reason for payment should be provided',
      method: 'POST',
      url: 'https://api.pesepay.com/api/payments-engine/v1/payments/initiate',
    });
    assert.match(error.message, /Pesepay responded 400: Reason for payment should be provided/);
    assert.match(error.message, /POST https:\/\/api\.pesepay\.com/);
    assert.equal(error.status, 400);
    assert.equal(error.serverMessage, 'Reason for payment should be provided');
  });

  it('says so plainly when the server sent no message', () => {
    // `message` really is nullable on the server, so this is a live path.
    assert.match(new PesepayApiError({ status: 502 }).message, /502 with no error message/);
  });

  it('falls back to description when message is absent', () => {
    const error = new PesepayApiError({ status: 400, description: 'Bad Request' });
    assert.match(error.message, /Pesepay responded 400: Bad Request/);
  });

  it('truncates an oversized response body', () => {
    const error = new PesepayApiError({ status: 500, responseBody: 'x'.repeat(10_000) });
    assert.ok((error.responseBody ?? '').length < 2_200);
    assert.match(error.responseBody ?? '', /10000 chars total/);
  });

  it('keeps a small response body verbatim', () => {
    const body = '{"message":"nope"}';
    assert.equal(new PesepayApiError({ status: 500, responseBody: body }).responseBody, body);
  });
});

describe('errors — retry classification', () => {
  it('does not retry the statuses that mean "your configuration is wrong"', () => {
    // 404 is an UNKNOWN INTEGRATION KEY, not a missing endpoint, and 403 is a
    // disabled one. Both will still be wrong in ten minutes.
    assert.equal(new PesepayApiError({ status: 403 }).isRetryable(), false);
    assert.equal(new PesepayApiError({ status: 404 }).isRetryable(), false);
    assert.equal(new PesepayApiError({ status: 400 }).isRetryable(), false);
  });

  it('does not retry a wrong encryption key, even though it arrives as a 500', () => {
    const error = new PesepayApiError({
      status: 500,
      serverMessage: 'Failed to decrypt your data',
    });
    assert.equal(error.isEncryptionKeyMismatch(), true);
    assert.equal(error.isRetryable(), false, 'retrying a key mismatch is a loop, not a recovery');
  });

  it('retries a genuine server fault', () => {
    assert.equal(new PesepayApiError({ status: 500 }).isRetryable(), true);
    assert.equal(new PesepayApiError({ status: 502 }).isRetryable(), true);
    assert.equal(new PesepayApiError({ status: 503 }).isRetryable(), true);
    assert.equal(new PesepayApiError({ status: 408 }).isRetryable(), true);
    assert.equal(new PesepayApiError({ status: 429 }).isRetryable(), true);
  });

  it('never retries an auth failure', () => {
    assert.equal(new PesepayAuthError({ status: 404 }).isRetryable(), false);
    assert.equal(new PesepayAuthError({ status: 403 }).isRetryable(), false);
  });

  it('does not mistake an ordinary 500 for a key mismatch', () => {
    assert.equal(new PesepayApiError({ status: 500 }).isEncryptionKeyMismatch(), false);
    assert.equal(
      new PesepayApiError({
        status: 400,
        serverMessage: 'Failed to decrypt your data',
      }).isEncryptionKeyMismatch(),
      false,
      'the mismatch is specifically a 500',
    );
  });
});

describe('errors — no credential ever reaches a log', () => {
  it('keeps keys out of messages, stacks and serialised output', () => {
    const integrationKey = 'INTEGRATION-KEY-DO-NOT-LOG-0001';
    const encryptionKey = 'ENCRYPTIONKEYDONOTLOG00000000002';

    const constructed = [
      new PesepayApiError({
        status: 404,
        serverMessage: 'Invalid integration key',
        method: 'GET',
        url: 'https://api.pesepay.com/api/payments-engine/v1/payments/check-payment?referenceNumber=RN1',
        responseBody: '{"message":"Invalid integration key"}',
      }),
      new PesepayCryptoError('Failed to decrypt the gateway payload.'),
      new PesepayNetworkError('Could not reach Pesepay: connect ECONNREFUSED (ECONNREFUSED)'),
    ];

    for (const error of constructed) {
      const serialised = JSON.stringify(error, Object.getOwnPropertyNames(error));
      for (const secret of [integrationKey, encryptionKey]) {
        assert.ok(!error.message.includes(secret));
        assert.ok(!(error.stack ?? '').includes(secret));
        assert.ok(!serialised.includes(secret));
      }
    }
  });
});
