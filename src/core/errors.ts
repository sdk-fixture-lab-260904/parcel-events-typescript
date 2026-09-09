/**
 * The kernel error taxonomy (doc 38 §3.2 row 6): a typed `APIError` base with
 * status-family subclasses (`catch (e) { if (e instanceof RateLimitError) }`),
 * plus the non-HTTP failures — `APIConnectionError` (network),
 * `APIConnectionTimeoutError` (per-request timeout), and `APIUserAbortError`
 * (the caller's own AbortSignal). Error bodies are captured verbatim on the
 * error object; `x-request-id` is surfaced as `requestId` for support tickets.
 *
 * Vendored kernel file — imports nothing (self-contained by construction).
 */

export interface APIErrorInit {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly message?: string;
}

/** Base class for every non-2xx HTTP response the API returned. */
export class APIError extends Error {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** The parsed (JSON) or raw (text) error body, captured verbatim. */
  readonly body: unknown;
  /** The `x-request-id` response header, when the server sent one. */
  readonly requestId: string | undefined;

  constructor(init: APIErrorInit) {
    super(init.message ?? defaultErrorMessage(init.status, init.body));
    this.name = new.target.name;
    this.status = init.status;
    this.headers = init.headers ?? {};
    this.body = init.body;
    this.requestId = this.headers['x-request-id'];
  }

  /** Map a status onto the most specific error subclass. */
  static generate(init: APIErrorInit): APIError {
    switch (init.status) {
      case 400:
        return new BadRequestError(init);
      case 401:
        return new AuthenticationError(init);
      case 403:
        return new PermissionDeniedError(init);
      case 404:
        return new NotFoundError(init);
      case 409:
        return new ConflictError(init);
      case 422:
        return new UnprocessableEntityError(init);
      case 429:
        return new RateLimitError(init);
      default:
        return init.status >= 500 ? new InternalServerError(init) : new APIError(init);
    }
  }
}

export class BadRequestError extends APIError {}
export class AuthenticationError extends APIError {}
export class PermissionDeniedError extends APIError {}
export class NotFoundError extends APIError {}
export class ConflictError extends APIError {}
export class UnprocessableEntityError extends APIError {}
export class RateLimitError extends APIError {}
export class InternalServerError extends APIError {}

/** The caller's own AbortSignal fired — never retried. */
export class APIUserAbortError extends Error {
  constructor(message = 'Request was aborted by the caller') {
    super(message);
    this.name = 'APIUserAbortError';
  }
}

/** The request never produced an HTTP response (DNS, TLS, socket, …). */
export class APIConnectionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = new.target.name;
    this.cause = cause;
  }
}

/** The per-request timeout elapsed before a response arrived. */
export class APIConnectionTimeoutError extends APIConnectionError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs} ms`);
    this.timeoutMs = timeoutMs;
  }
}

/** Best-effort human message from common `{error:{message}}`-style bodies. */
function defaultErrorMessage(status: number, body: unknown): string {
  const detail = extractMessage(body);
  return detail === undefined ? `HTTP ${status}` : `HTTP ${status}: ${detail}`;
}

function extractMessage(body: unknown): string | undefined {
  if (typeof body === 'string') return body.length > 0 ? body : undefined;
  if (body === null || typeof body !== 'object') return undefined;
  const record = body as Record<string, unknown>;
  const error = record['error'];
  if (typeof error === 'string' && error.length > 0) return error;
  if (error !== null && typeof error === 'object') {
    const nested = (error as Record<string, unknown>)['message'];
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  const message = record['message'];
  return typeof message === 'string' && message.length > 0 ? message : undefined;
}
