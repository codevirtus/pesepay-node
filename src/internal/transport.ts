/**
 * The default HTTP transport, built on `node:https`. Only the {@link Transport}
 * type and the two exported factories are public API.
 *
 * Each request is tried with Node's strict HTTP parser first. If the response
 * fails to parse, it is retried once with `insecureHTTPParser`, replaying the
 * body, and a warning is emitted once per process. Timeouts and connection
 * errors are never retried, because replaying a payment request could charge
 * the customer twice.
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
  /** Includes the integration key, as `key`, on authenticated calls. */
  headers: Readonly<Record<string, string>>;
  /** Already serialised. Absent for `GET`. */
  body?: string | undefined;
  /** Time limit for the request, including any retry. */
  timeoutMs: number;
}

export interface TransportResponse {
  status: number;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: string;
  /** `true` when the response needed the lenient HTTP parser. */
  usedInsecureHttpParser: boolean;
}

/**
 * A function that performs one HTTP request. Supply your own to route through a
 * proxy, use a custom agent, or answer without a socket at all.
 */
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface HttpsTransportOptions {
  /**
   * Retry once with Node's lenient HTTP parser when a response fails strict
   * parsing. Defaults to `true`. Setting `false` makes such requests fail
   * instead, which can cause calls to Pesepay to fail.
   */
  allowInsecureHttpParserFallback?: boolean;
}

const PARSER_ERROR_PREFIX = 'HPE_';

const WARNING_CODE = 'PESEPAY_INSECURE_HTTP_PARSER';

const WARNING_TEXT =
  "A Pesepay response failed Node's strict HTTP parsing and was retried with the " +
  'lenient parser (insecureHTTPParser), which succeeded. This applies only to the ' +
  'affected requests. To turn the fallback off, use ' +
  'createHttpsTransport({ allowInsecureHttpParserFallback: false }).';

/**
 * Builds a `node:https` transport.
 *
 * The warn-once flag lives on the closure rather than on the module so each
 * instance is independently testable; the package ships one shared instance,
 * so in practice the warning appears once per process.
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

      // The retry shares the caller's original time limit rather than starting
      // a fresh one, so a call never takes longer than the stated timeout.
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new PesepayTimeoutError(
          `Pesepay did not respond within ${req.timeoutMs}ms (the strict HTTP parser ` +
            'rejected the response and there was no time left to retry).',
          req.timeoutMs,
          { cause: error },
        );
      }

      // `req.body` is a string, so replaying it is just writing it again. A
      // stream-based body would be drained by the first attempt and the retry
      // would send nothing.
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
 * `true` for an HTTP parse failure, and nothing else. `ECONNREFUSED`,
 * `ENOTFOUND`, `ECONNRESET` and timeouts must answer `false`: a different
 * parser cannot help, and retrying a `POST` could charge the customer twice.
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
    // inactivity: a server sending a byte a second would never trip that, and
    // the caller asked for a total time limit.
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
 * Plain HTTP is allowed to loopback only, for local testing. Credentials over
 * cleartext to anything else are refused.
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
  // wrapping would hide it.
  if (isParserError(error)) return error;

  const code = (error as { code?: unknown }).code;
  const suffix = typeof code === 'string' ? ` (${code})` : '';
  return new PesepayNetworkError(`Could not reach Pesepay: ${error.message}${suffix}`, {
    cause: error,
  });
}
