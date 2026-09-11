/**
 * The strict → lenient HTTP parser fallback.
 *
 * All four cases the plan calls for, against a raw `node:net` server emitting
 * the byte-exact bare-LF header block production sends:
 *
 * 1. **Premise guard** — Node's strict parser really does reject that block.
 *    Without this the whole workaround rests on an assumption nobody rechecks,
 *    and the day `llhttp` relaxes, this test tells you the code can go.
 * 2. **Negative control** — a well-formed response must *not* trigger the
 *    retry. Without it, an implementation that simply sets
 *    `insecureHTTPParser: true` on every request passes every other test here.
 * 3. **Warn once** — three calls, one warning.
 * 4. **Body replay** — the retry must resend the body. This is the likeliest
 *    real bug in the path, and the gateway's response to a silently empty body
 *    looks nothing like a parser problem.
 */
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { errors, transport } from '../fixtures/modules.mts';
import {
  malformedResponse,
  type RawHttpServer,
  startRawHttpServer,
  wellFormedResponse,
} from '../fixtures/raw-http-server.mts';

const BODY = '{"payload":"c29tZS1jaXBoZXJ0ZXh0"}';

const servers: RawHttpServer[] = [];

async function serve(respond: (attempt: number) => string | null): Promise<RawHttpServer> {
  const server = await startRawHttpServer(respond);
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** Captures `process.emitWarning` for the duration of `run`. */
async function withCapturedWarnings<T>(
  run: () => Promise<T>,
): Promise<{ result: T; warnings: string[] }> {
  const original = process.emitWarning;
  const warnings: string[] = [];

  // Cast through `unknown`: emitWarning is heavily overloaded and the stub only
  // needs the (message, options) arm the transport actually calls.
  process.emitWarning = ((warning: string | Error) => {
    warnings.push(typeof warning === 'string' ? warning : warning.message);
  }) as unknown as typeof process.emitWarning;

  try {
    return { result: await run(), warnings };
  } finally {
    process.emitWarning = original;
  }
}

describe('transport — premise guard', () => {
  it("Node's strict parser still rejects a bare LF in the header block", async () => {
    // The reason the fallback exists. If this ever fails, llhttp has relaxed
    // and the retry, the warning and this whole file can be deleted.
    const server = await serve(() => malformedResponse(BODY));

    const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
      const req = httpRequest(`${server.origin}/probe`, { method: 'GET' }, () => {
        reject(new Error('strict parser unexpectedly accepted the malformed response'));
      });
      req.on('error', resolve);
      req.end();
    });

    assert.ok(error.code?.startsWith('HPE_'), `expected an HPE_* code, got ${String(error.code)}`);
  });

  it('accepts the same response once the parser is relaxed', async () => {
    // Proves the fixture is malformed in exactly the way the lenient parser
    // forgives, rather than broken in some other way.
    const server = await serve(() => malformedResponse(BODY));

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${server.origin}/probe`,
        { method: 'GET', insecureHTTPParser: true },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });

    assert.equal(status, 200);
  });
});

describe('transport — fallback behaviour', () => {
  it('retries once and returns the response', async () => {
    const server = await serve(() => malformedResponse(BODY));
    const send = transport.createHttpsTransport();

    const { result } = await withCapturedWarnings(() =>
      send({
        method: 'GET',
        url: `${server.origin}/api/payments-engine/v1/payments/check-payment`,
        headers: { key: 'integration-key' },
        timeoutMs: 5_000,
      }),
    );

    assert.equal(result.status, 200);
    assert.equal(result.body, BODY);
    assert.equal(result.usedInsecureHttpParser, true);
    assert.equal(server.requests.length, 2, 'exactly one retry');
  });

  it('does NOT relax the parser for a well-formed response', async () => {
    // The negative control. An implementation that always sets
    // insecureHTTPParser passes every other test in this file.
    const server = await serve(() => wellFormedResponse(BODY));
    const send = transport.createHttpsTransport();

    const { result, warnings } = await withCapturedWarnings(() =>
      send({
        method: 'GET',
        url: `${server.origin}/api/payments-engine/v1/currencies/active`,
        headers: { key: 'integration-key' },
        timeoutMs: 5_000,
      }),
    );

    assert.equal(result.status, 200);
    assert.equal(result.usedInsecureHttpParser, false, 'strict parser must have sufficed');
    assert.equal(server.requests.length, 1, 'no retry for a valid response');
    assert.deepEqual(warnings, [], 'no warning for a valid response');
  });

  it('warns exactly once across three calls', async () => {
    const server = await serve(() => malformedResponse(BODY));
    const send = transport.createHttpsTransport();

    const { warnings } = await withCapturedWarnings(async () => {
      for (let i = 0; i < 3; i++) {
        await send({
          method: 'GET',
          url: `${server.origin}/poll`,
          headers: { key: 'integration-key' },
          timeoutMs: 5_000,
        });
      }
    });

    assert.equal(server.requests.length, 6, 'three calls, each retried once');
    assert.equal(warnings.length, 1, 'the warning must not repeat per request');
    assert.match(warnings[0] ?? '', /HPE_CR_EXPECTED/);
    assert.match(warnings[0] ?? '', /Strict-Transport-Security/, 'must name the server-side fix');
  });

  it('replays the request body on the retry', async () => {
    // The bug this catches: an implementation that consumes a stream on the
    // first attempt and sends an empty body on the second. The gateway answers
    // that with a validation error that looks nothing like a parser problem.
    const requestBody = JSON.stringify({ payload: 'Zm9vYmFy'.repeat(40) });
    const server = await serve(() => malformedResponse(BODY));
    const send = transport.createHttpsTransport();

    await withCapturedWarnings(() =>
      send({
        method: 'POST',
        url: `${server.origin}/api/payments-engine/v1/payments/initiate`,
        headers: { key: 'integration-key', 'content-type': 'application/json' },
        body: requestBody,
        timeoutMs: 5_000,
      }),
    );

    assert.equal(server.requests.length, 2);
    for (const [index, received] of server.requests.entries()) {
      assert.equal(received.method, 'POST', `attempt ${index} method`);
      assert.equal(received.body, requestBody, `attempt ${index} body was not replayed`);
      assert.match(received.head, /content-length: \d+/i);
      assert.match(received.head, /^key: integration-key$/im, `attempt ${index} lost its key`);
    }
  });

  it('fails without retrying when the fallback is disabled', async () => {
    const server = await serve(() => malformedResponse(BODY));
    const send = transport.createHttpsTransport({ allowInsecureHttpParserFallback: false });

    await assert.rejects(
      send({
        method: 'GET',
        url: `${server.origin}/poll`,
        headers: { key: 'integration-key' },
        timeoutMs: 5_000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok((error as NodeJS.ErrnoException).code?.startsWith('HPE_'));
        return true;
      },
    );

    assert.equal(server.requests.length, 1, 'must not retry when opted out');
  });
});

describe('transport — failures that must NOT be retried', () => {
  it('fails fast on a refused connection', async () => {
    // Bind and immediately release a port so nothing is listening on it.
    const scratch = await startRawHttpServer(() => wellFormedResponse(BODY));
    const origin = scratch.origin;
    await scratch.close();

    const send = transport.createHttpsTransport();
    const { warnings } = await withCapturedWarnings(async () => {
      await assert.rejects(
        send({ method: 'GET', url: `${origin}/poll`, headers: {}, timeoutMs: 5_000 }),
        errors.PesepayNetworkError,
      );
    });

    assert.deepEqual(warnings, [], 'a refused connection is not a parser problem');
  });

  it('times out as PesepayTimeoutError, without a retry', async () => {
    // `null` means: accept the connection and never answer. Ending the socket
    // instead would surface as a reset, which is a different bug.
    const server = await serve(() => null);
    const send = transport.createHttpsTransport();

    await assert.rejects(
      send({ method: 'GET', url: `${server.origin}/poll`, headers: {}, timeoutMs: 150 }),
      (error: unknown) => {
        assert.ok(error instanceof errors.PesepayTimeoutError);
        assert.ok(error instanceof errors.PesepayNetworkError, 'timeout is a network error');
        assert.equal(error.code, 'ERR_PESEPAY_TIMEOUT');
        assert.equal(error.timeoutMs, 150);
        assert.match(error.message, /does NOT mean the payment failed/i);
        return true;
      },
    );
  });

  it('refuses to send credentials over plaintext to a non-loopback host', async () => {
    const send = transport.createHttpsTransport();
    await assert.rejects(
      send({
        method: 'GET',
        url: 'http://api.pesepay.com/api/payments-engine/v1/currencies/active',
        headers: { key: 'integration-key' },
        timeoutMs: 5_000,
      }),
      (error: unknown) => {
        assert.ok(error instanceof errors.PesepayNetworkError);
        assert.match(error.message, /Only https is allowed/);
        return true;
      },
    );
  });

  it('rejects a malformed URL before opening a socket', async () => {
    const send = transport.createHttpsTransport();
    await assert.rejects(
      send({ method: 'GET', url: 'not-a-url', headers: {}, timeoutMs: 5_000 }),
      errors.PesepayNetworkError,
    );
  });
});
