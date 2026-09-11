/**
 * The HTTP seam. Internal — only the {@link Transport} type is public API.
 *
 * ## Why this is not `fetch`
 *
 * `api.pesepay.com` emits a malformed response: its
 * `Strict-Transport-Security` value contains a literal newline, so the header
 * block carries a bare LF where HTTP/1.1 requires CRLF. Verified by raw TLS
 * dump — `fetch`/undici and strict `node:https` both reject it
 * (`HPE_CR_EXPECTED`); only `insecureHTTPParser: true` succeeds. No undici
 * option relaxes this, so a `fetch`-based SDK cannot talk to production at all.
 * `api.test.pesepay.com` sends no HSTS header, which is how this survived.
 *
 * So: try the strict parser, and retry **once** with `insecureHTTPParser` on an
 * `HPE_*` error only, replaying the body. That keeps response-smuggling
 * protection on by default (v1.0.4 set the flag unconditionally, opting every
 * user out silently), self-heals once the header is fixed, and leaves
 * `ECONNREFUSED` and timeouts failing fast — retrying a timed-out
 * `POST /initiate` risks a double charge.
 *
 * The real fix is one line of nginx:
 * `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;`
 *
 * @packageDocumentation
 */

import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { PesepayNetworkError, PesepayTimeoutError } from '../errors.js';

export type TransportMethod = 'GET' | 'POST';

export interface TransportRequest {
  method: TransportMethod;
  /** Absolute URL, including any query string. */
  url: string;
  /** The integration key travels here, as `key`. */
  headers: Readonly<Record<string, string>>;
  /** Already serialised. Absent for `GET`. */
  body?: string | undefined;
  /** Total budget for the request, including any retry. */
  timeoutMs: number;
}

export interface TransportResponse {
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: string;
  /** `true` when the lenient parser was needed — i.e. the gateway is malformed. */
  usedInsecureHttpParser: boolean;
}

/**
 * The injection seam for HTTP. Supply your own to route through a proxy, add a
 * custom agent, or answer without a socket at all.
 */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface HttpsTransportOptions {
  /**
   * Allow the one-shot `insecureHTTPParser` retry. Defaults to `true`, which is
   * the only setting that works against `api.pesepay.com` today. Set `false` if
   * your policy forbids the lenient parser and you would rather the call fail.
   */
  allowInsecureHttpParserFallback?: boolean;
}

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
 * The warn-once flag lives on the closure rather than on the module so each
 * instance is independently testable; the package ships one shared instance,
 * making the practical behaviour one warning per process.
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

      // The retry shares the caller's original budget rather than starting a
      // fresh one, so a slow gateway cannot cost twice the stated timeout.
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new PesepayTimeoutError(
          `Pesepay did not respond within ${req.timeoutMs}ms (the strict HTTP parser ` +
            'rejected the response and there was no time left to retry).',
          req.timeoutMs,
          { cause: error },
        );
      }

      // `req.body` is a string, so replaying it is just writing it again. This
      // is what a stream-based implementation gets wrong: the first attempt
      // drains the stream and the retry sends an empty body, which the gateway
      // answers with a validation error that looks nothing like a parser bug.
      const response = await send(req, remaining, true);

      if (!warned) {
        warned = true;
        process.emitWarning(WARNING_TEXT, { type: 'PesepayWarning', code: WARNING_CODE });
      }

      return response;
    }
  };
}

/** The default transport. A singleton, so "warn once" is once per process. */
export const httpsTransport: Transport = createHttpsTransport();

/**
 * `true` for an llhttp parse failure, and nothing else. `ECONNREFUSED`,
 * `ENOTFOUND`, `ECONNRESET` and timeouts all reach here and must answer
 * `false` — a different parser cannot help, and on a `POST` a retry risks a
 * second charge.
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

    // Wall-clock, not `clientRequest.setTimeout`, which measures socket
    // *inactivity*: a server dribbling a byte a second would never trip that,
    // and the caller asked for a total budget.
    timer = setTimeout(() => {
      fail(
        new PesepayTimeoutError(
          `Pesepay did not respond within ${timeoutMs}ms. This does NOT mean the ` +
            'payment failed — it may have been accepted. Recover with ' +
            'checkPayment(referenceNumber); do not re-initiate.',
          timeoutMs,
        ),
      );
      clientRequest.destroy();
    }, timeoutMs);
    timer.unref();

    if (body !== undefined) clientRequest.write(body);
    clientRequest.end();
  });
}

/**
 * Plain HTTP is allowed to loopback only, so the parser fallback can be tested
 * against a raw `node:net` server. Credentials over cleartext to anything else
 * are refused, not warned about.
 */
function isAllowedUrl(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopback(url.hostname);
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function wrap(error: Error): Error {
  if (error instanceof PesepayNetworkError) return error;
  // Parse errors pass through untouched: the retry keys off `code`, and
  // wrapping would hide the one signal that makes the fallback possible.
  if (isParserError(error)) return error;

  const code = (error as { code?: unknown }).code;
  const suffix = typeof code === 'string' ? ` (${code})` : '';
  return new PesepayNetworkError(`Could not reach Pesepay: ${error.message}${suffix}`, {
    cause: error,
  });
}
