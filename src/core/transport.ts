/**
 * Low-level HTTP transport: ONE fetch attempt with a per-request
 * AbortController timeout, and the mapping from runtime failures onto the
 * kernel error taxonomy. The kernel targets the WHATWG fetch standard
 * (Node >= 18, browsers, edge runtimes) with ZERO runtime dependencies.
 *
 * Vendored kernel file — imports only sibling kernel modules.
 */
import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError } from './errors.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'TRACE';

/**
 * The injected fetch surface (defaults to `globalThis.fetch` in the client).
 * WHATWG fetch forbids TRACE; TRACE operations require a capable adapter.
 */
export type KernelFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The configured fetch implementation rejected an otherwise valid HTTP method. */
export class UnsupportedTransportMethodError extends APIConnectionError {
  readonly method: HttpMethod;

  constructor(method: HttpMethod, cause?: unknown) {
    super(
      `${method} requests require a ${method}-capable ClientOptions.fetch adapter; WHATWG fetch does not support ${method}`,
      cause,
    );
    this.method = method;
  }
}

export interface TransportRequest {
  readonly url: string;
  readonly method: HttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: BodyInit | undefined;
  /** The CALLER's signal — aborting it raises APIUserAbortError. */
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs: number;
  /** Extra `RequestInit` fields (a dispatcher, `keepalive`, `cache`); the kernel's method/headers/body/signal win. */
  readonly init?: RequestInit | undefined;
}

/** Flatten a fetch `Headers` object into a plain lower-cased record. */
export function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

/**
 * Perform one fetch attempt under a fresh AbortController: the timeout timer
 * and the caller's signal both abort THIS attempt only (the Neon-in-Workers
 * lesson: per-request I/O contexts, no shared controllers). Failures map to:
 * caller abort → APIUserAbortError · timeout → APIConnectionTimeoutError ·
 * anything else without an HTTP response → APIConnectionError.
 */
/** Opaque to control-flow narrowing: `aborted` flips across awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export async function performFetch(fetchFn: KernelFetch, request: TransportRequest): Promise<Response> {
  if (isAborted(request.signal)) throw new APIUserAbortError();
  const controller = new AbortController();
  const onCallerAbort = (): void => {
    controller.abort();
  };
  request.signal?.addEventListener('abort', onCallerAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs);
  try {
    return await fetchFn(request.url, {
      ...request.init,
      method: request.method,
      headers: request.headers,
      body: request.body ?? null,
      signal: controller.signal,
    });
  } catch (error) {
    if (isAborted(request.signal)) throw new APIUserAbortError();
    if (timedOut) throw new APIConnectionTimeoutError(request.timeoutMs);
    throw new APIConnectionError('Connection error while contacting the API', error);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', onCallerAbort);
  }
}
