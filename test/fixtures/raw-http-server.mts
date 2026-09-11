/**
 * A raw `node:net` server that speaks HTTP as explicit bytes.
 *
 * `node:http` cannot produce what this suite needs: it always writes a correct
 * header block, and the whole point is one that is incorrect in a specific way.
 */

import type { Server, Socket } from 'node:net';
import { createServer } from 'node:net';

export interface CapturedRequest {
  /** The request line and headers, verbatim. */
  head: string;
  /** Empty string when there was no body. */
  body: string;
  method: string;
}

export interface RawHttpServer {
  /** `http://127.0.0.1:<port>` — loopback, which the transport permits. */
  origin: string;
  /** Every request received, in order. */
  requests: CapturedRequest[];
  close(): Promise<void>;
}

/**
 * A byte-exact reproduction of the header block `api.pesepay.com` emits.
 *
 * Note the lone `\n` after `max-age=31536000;` where HTTP/1.1 requires `\r\n`.
 * That single byte is the entire bug: llhttp reports `HPE_CR_EXPECTED` and
 * undici "Missing expected CR after header value". Written as explicit escapes
 * so no editor or `.gitattributes` rule can quietly repair it.
 */
export function malformedResponse(body: string): string {
  const length = Buffer.byteLength(body, 'utf8');
  return (
    'HTTP/1.1 200 OK\r\n' +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${length}\r\n` +
    'Strict-Transport-Security: max-age=31536000;\n includeSubDomains\r\n' +
    'Connection: close\r\n' +
    '\r\n' +
    body
  );
}

/** The same response with correct CRLF throughout — the negative control. */
export function wellFormedResponse(body: string): string {
  const length = Buffer.byteLength(body, 'utf8');
  return (
    'HTTP/1.1 200 OK\r\n' +
    'Content-Type: application/json\r\n' +
    `Content-Length: ${length}\r\n` +
    'Strict-Transport-Security: max-age=31536000; includeSubDomains\r\n' +
    'Connection: close\r\n' +
    '\r\n' +
    body
  );
}

/**
 * @param respond - Called with the 0-based request index, so a test can answer
 *   the retry differently from the first attempt. Return `null` to accept the
 *   connection and never answer — how the timeout case is exercised, since
 *   ending the socket would surface as a reset instead.
 */
export async function startRawHttpServer(
  respond: (attempt: number) => string | null,
): Promise<RawHttpServer> {
  const requests: CapturedRequest[] = [];
  const open = new Set<Socket>();

  const server: Server = createServer((socket: Socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    const chunks: Buffer[] = [];

    const tryRespond = (): void => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const separator = raw.indexOf('\r\n\r\n');
      if (separator === -1) return;

      const head = raw.slice(0, separator);
      const body = raw.slice(separator + 4);

      // Wait for the whole body, so a retry that forgets to replay it shows up
      // as an empty `body` rather than as a race between the two.
      const declared = /content-length:\s*(\d+)/i.exec(head);
      const expected = declared?.[1] === undefined ? 0 : Number(declared[1]);
      if (Buffer.byteLength(body, 'utf8') < expected) return;

      socket.removeListener('data', onData);
      requests.push({ head, body, method: head.split(' ')[0] ?? '' });

      const reply = respond(requests.length - 1);
      if (reply === null) return;
      socket.end(reply);
    };

    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      tryRespond();
    };

    socket.on('data', onData);
    socket.on('error', () => {
      // A client destroying the socket on timeout is expected here.
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('raw server did not bind to a TCP port');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // `net.Server` has no `closeAllConnections`, and the timeout case
        // deliberately leaves a socket open — `close` alone would wait forever.
        for (const socket of open) socket.destroy();
        open.clear();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
