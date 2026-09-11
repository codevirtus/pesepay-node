/**
 * The HTTP seam.
 *
 * Internal: nothing here is part of the package's public API, and it may change
 * in a minor release. The {@link Transport} *type* is re-exported publicly so
 * that a custom transport can be supplied; the implementation is not.
 *
 * ## Why this is not `fetch`
 *
 * `api.pesepay.com` emits a malformed response. Its `Strict-Transport-Security`
 * header value contains a literal newline, so the header block carries a **bare
 * LF** where HTTP/1.1 requires CRLF:
 *
 * ```
 * Strict-Transport-Security: max-age=31536000;⏎ includeSubDomains
 * ```
 *
 * Node's strict `llhttp` parser rejects this. Verified against production by
 * raw TLS socket dump:
 *
 * | client | result |
 * |---|---|
 * | `fetch` / undici | **fails** — `Missing expected CR after header value` |
 * | `node:https`, strict parser | **fails** — `HPE_CR_EXPECTED` |
 * | `node:https`, `insecureHTTPParser: true` | 200 OK |
 *
 * There is no undici option that relaxes this, so a `fetch`-based SDK cannot
 * talk to Pesepay's production host at all. `api.test.pesepay.com` sends no
 * HSTS header and is unaffected, which is how this survived to production.
 *
 * ## What this module does about it
 *
 * Try the **strict** parser first. Retry **once**, with
 * `insecureHTTPParser: true` and the request body replayed, but **only** when
 * the failure was a parser error (`HPE_*`). Warn once per process, naming the
 * server-side fix.
 *
 * Three properties that matter more than the workaround itself:
 *
 * - **It is not the default.** Every request gets full response-smuggling
 *   protection until a response proves it needs otherwise. An SDK that simply
 *   sets `insecureHTTPParser: true` — as v1.0.4 did — opts every user out
 *   permanently and silently.
 * - **It self-heals.** The day the nginx config is fixed, the strict parse
 *   succeeds and the lenient path stops being reached. Nothing to un-ship.
 * - **It does not mask real failures.** `ECONNREFUSED`, DNS failure and
 *   timeouts fail immediately. Retrying those would turn one dead connection
 *   into two, and a retry on a timed-out `POST /initiate` risks a double
 *   charge.
 *
 * The real fix lives in nginx, not here:
 * `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;`
 *
 * @packageDocumentation
 */

import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { PesepayNetworkError, PesepayTimeoutError } from '../errors.js';

/** HTTP methods the SDK issues. */
export type TransportMethod = 'GET' | 'POST';

/** One outbound request, fully described. */
export interface TransportRequest {
  method: TransportMethod;
  /** Absolute URL, including any query string. */
  url: string;
  /** Headers to send. The integration key travels here, as `key`. */
  headers: Readonly<Record<string, string>>;
  /** Request body, already serialised. Absent for `GET`. */
  body?: string | undefined;
  /** Total budget for the request, in milliseconds. */
  timeoutMs: number;
}

/** One response, fully buffered. */
export interface TransportResponse {
  status: number;
  /** Lower-cased header names, as Node reports them. */
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The response body decoded as UTF-8. */
  body: string;
  /** `true` when the lenient parser was needed — i.e. the gateway is malformed. */
  usedInsecureHttpParser: boolean;
}

/**
 * The injection seam for HTTP.
 *
 * Supply your own to route through a proxy, add a custom agent, or — in tests —
 * to answer without a socket at all.
 */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

/** Tuning for {@link createHttpsTransport}. */
export interface HttpsTransportOptions {
  /**
   * Allow the one-shot retry with `insecureHTTPParser: true`.
   *
   * Defaults to `true`, which is the only setting that works against
   * `api.pesepay.com` today. Set it to `false` if your security policy forbids
   * the lenient parser outright and you would rather the call fail.
   */
  allowInsecureHttpParserFallback?: boolean;
}

/** Node's `code` prefix for every llhttp parse failure. */
const PARSER_ERROR_PREFIX = 'HPE_';

const WARNING_CODE = 'PESEPAY_INSECURE_HTTP_PARSER';

const WARNING_TEXT =
  'Pesepay returned an HTTP response that violates RFC 7230: its header block ' +
  "contains a bare LF, which Node's strict parser rejects with HPE_CR_EXPECTED. " +
  'The request was retried with insecureHTTPParser enabled and succeeded. This ' +
  'relaxes response-smuggling protection for affected requests only. The fix is ' +
  "server-side, in the gateway's nginx configuration: " +
  'add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;';

/**
 * Builds a `node:https` transport.
 *
 * The warn-once flag lives on the returned closure rather than on the module,
 * so that each transport instance is independently testable. The package uses a
 * single shared instance ({@link httpsTransport}), which makes the practical
 * behaviour one warning per process.
 */
export function createHttpsTransport(options: HttpsTransportOptions = {}): Transport {
  const fallbackAllowed = options.allowInsecureHttpParserFallback !== false;
  let warned = false;

  return async function httpsTransportImpl(req: TransportRequest): Promise<TransportResponse> {
    const deadline = Date.now() + req.timeoutMs;

    try {
      return await send(req, req.timeoutMs, false);
    } catch (error) {
      if (!fallbackAllowed || !isParserError(error)) throw error;

      // The body is held as a string on `req`, so replaying it is simply
      // writing it again. This is the step a stream-based implementation gets
      // wrong: the first attempt drains the stream and the retry sends an
      // empty body, which the gateway answers with a validation error that
      // looks nothing like a parser problem.
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new PesepayTimeoutError(
          `Pesepay did not respond within ${req.timeoutMs}ms (the strict HTTP parser ` +
            'rejected the response and there was no time left to retry).',
          req.timeoutMs,
          { cause: error },
        );
      }

      const response = await send(req, remaining, true);

      if (!warned) {
        warned = true;
        process.emitWarning(WARNING_TEXT, {
          type: 'PesepayWarning',
          code: WARNING_CODE,
        });
      }

      return response;
    }
  };
}

/**
 * The transport the SDK uses unless one is injected.
 *
 * A module singleton so that the "warn once" really is once per process, rather
 * than once per client instance.
 */
export const httpsTransport: Transport = createHttpsTransport();

/**
 * `true` for an llhttp parse failure, and nothing else.
 *
 * Deliberately narrow. `ECONNREFUSED`, `ENOTFOUND`, `ECONNRESET` and timeouts
 * all reach this predicate too, and all must answer `false` — retrying them
 * with a different parser cannot help, and on a `POST` it risks a second
 * charge.
 */
function isParserError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.startsWith(PARSER_ERROR_PREFIX);
}

/** One attempt. Resolves only on a fully buffered response. */
function send(
  req: TransportRequest,
  timeoutMs: number,
  insecureHTTPParser: boolean,
): Promise<TransportResponse> {
  return new Promise<TransportResponse>((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      reject(new PesepayNetworkError(`Not a valid URL: ${req.url}`));
      return;
    }

    if (!isAllowedUrl(url)) {
      reject(
        new PesepayNetworkError(
          `Refusing to send Pesepay credentials over ${url.protocol}//${url.host}. ` +
            'Only https is allowed, except to loopback addresses for local testing.',
        ),
      );
      return;
    }

    const body = req.body === undefined ? undefined : Buffer.from(req.body, 'utf8');

    const requestOptions: RequestOptions = {
      method: req.method,
      headers: {
        ...req.headers,
        ...(body === undefined ? {} : { 'content-length': String(body.byteLength) }),
      },
      insecureHTTPParser,
    };

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const succeed = (response: TransportResponse): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(response);
    };

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      reject(wrap(error));
    };

    const onResponse = (res: IncomingMessage): void => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on('error', fail);
      res.on('end', () => {
        succeed({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          usedInsecureHttpParser: insecureHTTPParser,
        });
      });
    };

    const dispatch = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const clientRequest: ClientRequest = dispatch(url, requestOptions, onResponse);

    clientRequest.on('error', fail);

    // A wall-clock timer rather than `clientRequest.setTimeout`, which measures
    // socket *inactivity*: a server dribbling one byte a second would never
    // trip that, and the caller asked for a total budget.
    timer = setTimeout(() => {
      const error = new PesepayTimeoutError(
        `Pesepay did not respond within ${timeoutMs}ms. This does NOT mean the ` +
          'payment failed — it may have been accepted. Recover with ' +
          'checkPayment(referenceNumber); do not re-initiate.',
        timeoutMs,
      );
      fail(error);
      clientRequest.destroy();
    }, timeoutMs);
    timer.unref();

    if (body !== undefined) clientRequest.write(body);
    clientRequest.end();
  });
}

/**
 * Whether this URL may carry an integration key.
 *
 * Plain HTTP is permitted **only** to loopback, which exists so the parser
 * fallback can be tested against a raw `node:net` server speaking a byte-exact
 * malformed response. Anything else carrying credentials over cleartext is
 * refused outright rather than warned about.
 */
function isAllowedUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopback(url.hostname);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

/**
 * Maps a socket-level failure onto the SDK's error hierarchy.
 *
 * A parse error is re-thrown untouched: the retry logic keys off its `code`,
 * and wrapping it here would hide the one signal that makes the fallback
 * possible.
 */
function wrap(error: Error): Error {
  if (error instanceof PesepayNetworkError) return error;
  if (isParserError(error)) return error;

  const code = (error as { code?: unknown }).code;
  const suffix = typeof code === 'string' ? ` (${code})` : '';
  return new PesepayNetworkError(`Could not reach Pesepay: ${error.message}${suffix}`, {
    cause: error,
  });
}
