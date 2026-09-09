/**
 * The core client (doc 38 §1 "Emitters + kernels" row): the fetch-based
 * transport orchestrator every generated resource method calls into. One
 * request = prepare (URL, default + per-call query, headers, JSON body, ONE
 * idempotency key) → the retry loop (auth per attempt · per-attempt timeout
 * · backoff with `Retry-After`/`retry-after-ms` · the server's
 * `x-should-retry` verdict · one transparent re-auth on 401) → typed error
 * or parsed body. Also the `PageFetcher` pagination iterates through, the
 * raw response source for streams and generated lazy promises.
 */
import { lifecycleRequest, LifecycleHookTimeoutError, type LifecycleHooks } from './lifecycle.js';
import type { RequestOptions, CallOptions } from './request-options.js';
export type { RequestOptions, CallOptions } from './request-options.js';
import { parseResponseBody } from './response-body.js';
export { parseResponseBody } from './response-body.js';
import { assertValid, type ValidationOptions, type ValidationContract } from './validation.js';
import { abortable, authorizeWithin, defaultSleep } from './abort.js';
import { APIPromise } from './api-promise.js';
import type { AuthProvider } from './auth.js';
import { APIConnectionError, APIError, APIUserAbortError } from './errors.js';
import {
  resolveIdempotency,
  resolveIdempotencyKey,
  type IdempotencyOptions,
  type ResolvedIdempotency,
} from './idempotency.js';
import { consoleLogger, leveledLogger, redactHeaders, redactUrl, type Logger, type LogLevel } from './logger.js';
import type { PageFetcher, PageRequest } from './pagination.js';
import {
  nextRetryDecision,
  parseRetryAfterMs,
  parseShouldRetry,
  resolveRetryPolicy,
  type RetryDecision,
  type RetryPolicy,
} from './retries.js';
import { lowercaseKeys, appendQuery, encodeQuery, jsonBody, type QueryParamValue } from './serialization.js';
import {
  headersToRecord,
  performFetch,
  type HttpMethod,
  type KernelFetch,
  UnsupportedTransportMethodError,
} from './transport.js';
import { runtimeDescriptor, userAgent, KERNEL_VERSION } from './version.js';

export interface ClientOptions {
  readonly hooks?: LifecycleHooks;
  readonly validation?: ValidationOptions;
  /** Explicit opt-in to replaying writes without an idempotency key. */
  readonly retryUnsafeRequests?: boolean;
  readonly baseUrl: string;
  readonly auth?: AuthProvider;
  /** WHATWG fetch rejects TRACE; inject a TRACE-capable adapter for those operations. */
  readonly fetch?: KernelFetch | undefined;
  /** Extra `RequestInit` fields merged into every fetch (a dispatcher, `keepalive`, `cache`, …). */
  readonly fetchOptions?: RequestInit;
  /** Per-request timeout (config `timeouts.default_ms`; default 60s). */
  readonly timeoutMs?: number;
  readonly retries?: Partial<RetryPolicy>;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  /** Query parameters sent with EVERY request (a per-call value wins). */
  readonly defaultQuery?: Readonly<Record<string, QueryParamValue>>;
  /** Stamped into User-Agent alongside the kernel version. */
  readonly sdkName?: string;
  readonly sdkVersion?: string;
  readonly idempotency?: IdempotencyOptions;
  /** Where request logs go (default `console`) and how much (default `warn`). */
  readonly logger?: Logger;
  readonly logLevel?: LogLevel;
  /** Injection points for tests; production uses real timers/clock. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export interface APIResponse<T = unknown> {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly data: T;
}

interface PreparedRequest {
  readonly operation?: string;
  readonly url: string;
  readonly method: HttpMethod;
  readonly headers: Record<string, string>;
  readonly body: BodyInit | undefined;
  readonly signal: AbortSignal | undefined;
  readonly timeoutMs: number;
}

type AttemptOutcome =
  | { readonly kind: 'response'; readonly response: Response }
  | { readonly kind: 'connection'; readonly error: APIConnectionError };

export class CoreClient implements PageFetcher {
  private readonly options: ClientOptions;
  private readonly baseUrl: string;
  private readonly auth: AuthProvider | undefined;
  private readonly fetchFn: KernelFetch;
  private readonly usesDefaultFetch: boolean;
  private readonly timeoutMs: number;
  private readonly retryPolicy: RetryPolicy;
  private readonly defaultHeaders: Readonly<Record<string, string>>;
  private readonly defaultQuery: Readonly<Record<string, QueryParamValue>>;
  private readonly telemetry: Readonly<Record<string, string>>;
  private readonly idempotency: ResolvedIdempotency;
  private readonly log: Logger;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly nowFn: () => number;

  constructor(options: ClientOptions) {
    this.options = options;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.auth = options.auth;
    this.usesDefaultFetch = options.fetch === undefined;
    this.fetchFn = options.fetch ?? ((url, init): Promise<Response> => fetch(url, init));
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.retryPolicy = resolveRetryPolicy(options.retries);
    this.defaultHeaders = options.defaultHeaders ?? {};
    this.defaultQuery = options.defaultQuery ?? {};
    const sdkName = options.sdkName ?? 'doctorine-sdk';
    const sdkVersion = options.sdkVersion ?? '0.0.0';
    this.telemetry = {
      'user-agent': userAgent(sdkName, sdkVersion),
      'x-doctorine-lang': 'js',
      'x-doctorine-package': sdkName,
      'x-doctorine-package-version': sdkVersion,
      'x-doctorine-kernel': KERNEL_VERSION,
      'x-doctorine-runtime': runtimeDescriptor(),
    };
    this.idempotency = resolveIdempotency(options.idempotency);
    this.log = leveledLogger(options.logger ?? consoleLogger, options.logLevel ?? 'warn');
    this.sleepFn = options.sleep ?? defaultSleep;
    this.nowFn = options.now ?? ((): number => Date.now());
  }

  /** A client for one call site: the same auth and fetch, these options merged on top. */
  withOptions(overrides: Partial<ClientOptions>): CoreClient {
    return new CoreClient({
      ...this.options,
      ...overrides,
      defaultHeaders: { ...this.options.defaultHeaders, ...overrides.defaultHeaders },
      defaultQuery: { ...this.options.defaultQuery, ...overrides.defaultQuery },
      retries: { ...this.options.retries, ...overrides.retries },
      validation: { ...this.options.validation, ...overrides.validation },
    });
  }

  /** Perform a request and parse the body (JSON / text / bytes). */
  async request<T = unknown>(options: RequestOptions): Promise<APIResponse<T>> {
    const response = await this.raw(options);
    const data = (await parseResponseBody(response)) as T;
    this.responseValidator(options.responseContract, options)(data);
    return { status: response.status, headers: headersToRecord(response.headers), data };
  }

  /** The lazy, unwrappable promise every generated method returns (`parse` defaults to the content-type parser). */
  promise<T = unknown>(
    options: RequestOptions | (() => RequestOptions),
    remap: (error: unknown) => unknown = (error) => error,
    parse: (response: Response) => Promise<T> = (response) => parseResponseBody(response) as Promise<T>,
  ): APIPromise<T> {
    let resolved: RequestOptions | undefined;
    return new APIPromise<T>(async () => {
      try { resolved = typeof options === 'function' ? options() : options; return await this.raw(resolved); }
      catch (error) { throw remap(error); }
    }, async (response) => {
      const value = await parse(response);
      this.responseValidator(resolved?.responseContract, resolved)(value);
      return value;
    });
  }

  validateInput(contract: ValidationContract | undefined, value: unknown, options?: { validation?: ValidationOptions }): void {
    if (contract && (options?.validation?.request ?? this.options.validation?.request ?? true)) assertValid(contract, value, 'request');
  }

  responseValidator(contract: ValidationContract | undefined, options?: { validation?: ValidationOptions }): (value: unknown) => void {
    return (value) => {
      if (contract && (options?.validation?.response ?? this.options.validation?.response ?? true)) assertValid(contract, value, 'response');
    };
  }

  /** Undocumented endpoints: `client.get('/v1/beta/things', { query })` — typed by the caller. */
  get<T = unknown>(path: string, options: CallOptions = {}): APIPromise<T> {
    return this.promise<T>({ ...options, method: 'GET', path });
  }

  post<T = unknown>(path: string, options: CallOptions = {}): APIPromise<T> {
    return this.promise<T>({ ...options, method: 'POST', path });
  }

  put<T = unknown>(path: string, options: CallOptions = {}): APIPromise<T> {
    return this.promise<T>({ ...options, method: 'PUT', path });
  }

  patch<T = unknown>(path: string, options: CallOptions = {}): APIPromise<T> {
    return this.promise<T>({ ...options, method: 'PATCH', path });
  }

  delete<T = unknown>(path: string, options: CallOptions = {}): APIPromise<T> {
    return this.promise<T>({ ...options, method: 'DELETE', path });
  }

  /**
   * Perform a request through the full auth/retry pipeline and return the
   * UNREAD ok Response — the entry point streaming methods build on
   * (`Stream.fromSSE(await client.raw(...))`).
   */
  async raw(options: RequestOptions): Promise<Response> {
    if (options.method === 'TRACE' && this.usesDefaultFetch) {
      throw new UnsupportedTransportMethodError(options.method);
    }
    options.validateRequest?.();
    const prepared = this.prepare(options);
    const policy = this.requestRetryPolicy(prepared, options);
    const startMs = this.nowFn();
    let attempt = 0;
    let reauthorized = false;
    for (;;) {
      const outcome = await this.attemptOnce(prepared, attempt);
      if (outcome.kind === 'response' && outcome.response.ok) return outcome.response;
      if (outcome.kind === 'response' && outcome.response.status === 401 && !reauthorized && this.invalidateAuth()) {
        reauthorized = true;
        await discardBody(outcome.response);
        continue;
      }
      const decision = this.decide(outcome, attempt, this.nowFn() - startMs, policy);
      if (!decision.retry) {
        this.log.error(`${prepared.method} ${redactUrl(prepared.url)} failed`, describeOutcome(outcome));
        return await failWith(outcome);
      }
      this.log.warn(`${prepared.method} ${redactUrl(prepared.url)} retrying in ${decision.delayMs} ms`, describeOutcome(outcome));
      if (outcome.kind === 'response') await discardBody(outcome.response);
      await abortable(this.sleepFn(decision.delayMs), prepared.signal);
      if (prepared.signal?.aborted === true) throw new APIUserAbortError();
      attempt += 1;
    }
  }

  /** The pagination hook (`PageFetcher`). */
  async requestPage(request: PageRequest): Promise<{ body: unknown }> {
    const { data } = await this.request<unknown>({
      ...request,
      method: request.method,
      path: request.url,
      query: request.query,
      headers: request.headers ?? {},
      body: request.body,
    });
    return { body: data };
  }

  private requestRetryPolicy(prepared: PreparedRequest, options: RequestOptions): RetryPolicy {
    const policy = resolveRetryPolicy({ ...this.retryPolicy, ...options.retries });
    const safeToRetry = /^(GET|HEAD|OPTIONS|TRACE|PUT|DELETE)$/.test(prepared.method)
      || Boolean(prepared.headers[this.idempotency.header.toLowerCase()]?.trim())
      || (options.retryUnsafeRequests ?? this.options.retryUnsafeRequests ?? false);
    const replayable = !(typeof ReadableStream !== 'undefined' && prepared.body instanceof ReadableStream);
    return { ...policy, enabled: policy.enabled && safeToRetry && replayable };
  }

  private prepare(options: RequestOptions): PreparedRequest {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...this.telemetry,
      ...lowercaseKeys(this.defaultHeaders),
      ...lowercaseKeys(options.headers),
    };
    let body: BodyInit | undefined = options.rawBody;
    if (body === undefined && options.body !== undefined) {
      const encoded = jsonBody(options.body);
      body = encoded.body;
      headers['content-type'] ??= encoded.contentType;
    }
    // ONE key per logical request — retries of this call all reuse it.
    const key = resolveIdempotencyKey(options.method, options.idempotencyKey, this.idempotency);
    if (key !== undefined) headers[this.idempotency.header.toLowerCase()] = key;
    return {
      operation: options.operation,
      url: this.buildUrl(options.path, { ...this.defaultQuery, ...options.query }, options.queryStyles),
      method: options.method,
      headers,
      body,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
    };
  }

  private buildUrl(
    path: string,
    query: Readonly<Record<string, QueryParamValue>>,
    styles: RequestOptions['queryStyles'],
  ): string {
    const base = /^https?:\/\//.test(path)
      ? path
      : `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
    return appendQuery(base, encodeQuery(query, styles));
  }

  /** One attempt: fresh auth material, one fetch, taxonomy-mapped failures. */
  private async attemptOnce(prepared: PreparedRequest, attempt: number): Promise<AttemptOutcome> {
    if (prepared.signal?.aborted) throw new APIUserAbortError();
    const material = this.auth === undefined ? {} : await authorizeWithin(this.auth.authorize(), prepared.timeoutMs, prepared.signal);
    const url = material.query === undefined ? prepared.url : appendQuery(prepared.url, encodeQuery(material.query));
    const headers = { ...prepared.headers, ...lowercaseKeys(material.headers), 'x-doctorine-retry-count': String(attempt) };
    this.log.debug(`${prepared.method} ${redactUrl(url)}`, { attempt, headers: redactHeaders(headers) });
    try {
      const response = await lifecycleRequest(this.options.hooks, { ...prepared, url, headers, attempt }, (hookHeaders) => performFetch(this.fetchFn, {
        url,
        method: prepared.method,
        headers: hookHeaders,
        body: prepared.body,
        signal: prepared.signal,
        timeoutMs: prepared.timeoutMs,
        init: this.options.fetchOptions,
      }));
      this.log.debug(`${prepared.method} ${redactUrl(url)} → ${response.status}`, { attempt });
      return { kind: 'response', response };
    } catch (error) {
      if (error instanceof APIUserAbortError || error instanceof LifecycleHookTimeoutError || error instanceof UnsupportedTransportMethodError) throw error;
      if (error instanceof APIConnectionError) return { kind: 'connection', error };
      throw error;
    }
  }

  private decide(outcome: AttemptOutcome, attempt: number, elapsedMs: number, policy: RetryPolicy): RetryDecision {
    const state = { attempt, elapsedMs };
    if (outcome.kind === 'connection') {
      return nextRetryDecision(policy, state, { kind: 'connection' });
    }
    const { headers, status } = outcome.response;
    const retryAfterMs = parseRetryAfterMs(headers.get('retry-after-ms'), headers.get('retry-after'), this.nowFn());
    const shouldRetry = parseShouldRetry(headers.get('x-should-retry'));
    return nextRetryDecision(policy, state, { kind: 'status', status }, { retryAfterMs, shouldRetry });
  }

  private invalidateAuth(): boolean {
    return this.auth?.invalidate?.() ?? false;
  }
}


function describeOutcome(outcome: AttemptOutcome): Record<string, unknown> {
  return outcome.kind === 'response'
    ? { status: outcome.response.status, headers: redactHeaders(headersToRecord(outcome.response.headers)) }
    : { error: outcome.error.message };
}

/** Exhaustively turn a terminal failed outcome into a thrown kernel error. */
async function failWith(outcome: AttemptOutcome): Promise<never> {
  switch (outcome.kind) {
    case 'connection':
      throw outcome.error;
    case 'response': {
      const { response } = outcome;
      const body = await parseResponseBody(response).catch((error: unknown) => {
        if (error instanceof APIUserAbortError || error instanceof APIConnectionError) throw error;
        return undefined;
      });
      throw APIError.generate({ status: response.status, headers: headersToRecord(response.headers), body });
    }
    default:
      return unreachable(outcome);
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* a body that cannot be cancelled has nothing left to release */
  }
}


function unreachable(value: never): never {
  throw new Error(`unreachable: ${String(value)}`);
}
