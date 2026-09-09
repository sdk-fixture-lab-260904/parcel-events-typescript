import type { ParameterSerialization } from './parameter-serialization.js';
/** Shared request controls: independent of client and pagination execution. */
import type { ValidationOptions, ValidationContract } from './validation.js';
import type { RetryPolicy } from './retries.js';
import type { QueryParamValue, QueryStyle } from './serialization.js';
import type { HttpMethod } from './transport.js';

export interface RequestOptions {
  readonly operation?: string;
  readonly validation?: ValidationOptions;
  /** Explicit opt-in to replaying writes without an idempotency key. */
  readonly retryUnsafeRequests?: boolean;
  readonly responseContract?: ValidationContract;
  readonly validateRequest?: () => void;
  readonly method: HttpMethod;
  /** Path relative to baseUrl, or an absolute URL (pagination next links). */
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryParamValue>>;
  readonly queryStyles?: Readonly<Record<string, QueryStyle | ParameterSerialization>>;
  readonly headers?: Readonly<Record<string, string>>;
  /** JSON-encoded body (sets content-type: application/json). */
  readonly body?: unknown;
  /** Pre-encoded body (multipart FormData, binary) — bypasses JSON encoding. */
  readonly rawBody?: BodyInit;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly idempotencyKey?: string;
  /** Per-call policy overrides, including disabling retries. */
  readonly retries?: Partial<RetryPolicy>;
}

/** What an undocumented-endpoint helper accepts: everything but the method and path. */
export type CallOptions = Omit<RequestOptions, 'method' | 'path'>;

