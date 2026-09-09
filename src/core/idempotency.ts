/**
 * Idempotency-key injection (doc 38 §3.2 row 8, `idempotency:` in
 * `doctorine.sdk.yml`). The key is resolved ONCE per logical request, BEFORE
 * the retry loop, so every retry of one call carries the SAME key — that is
 * the whole point of the header. Auto-generation (crypto.randomUUID) applies
 * only to POST; an explicit caller key is honored on any method.
 *
 * Vendored kernel file — imports only sibling kernel modules.
 */
import type { HttpMethod } from './transport.js';

export const DEFAULT_IDEMPOTENCY_HEADER = 'Idempotency-Key';

export interface IdempotencyOptions {
  /** Header name (config `idempotency.header`; default `Idempotency-Key`). */
  readonly header?: string;
  /** Auto-generate a key for POST requests (opt-in, like the config block). */
  readonly autoGenerate?: boolean;
  /** Key factory override (default `doctorine-ts-<uuid>`). */
  readonly generate?: () => string;
}

export interface ResolvedIdempotency {
  readonly header: string;
  readonly autoGenerate: boolean;
  readonly generate: () => string;
}

export function resolveIdempotency(options?: IdempotencyOptions): ResolvedIdempotency {
  return {
    header: options?.header ?? DEFAULT_IDEMPOTENCY_HEADER,
    autoGenerate: options?.autoGenerate ?? false,
    generate: options?.generate ?? defaultIdempotencyKey,
  };
}

/** `doctorine-ts-<uuid>` — runtime-unique by design (never hashed into builds). */
export function defaultIdempotencyKey(): string {
  return `doctorine-ts-${crypto.randomUUID()}`;
}

/**
 * The key for this logical request: an explicit key always wins; otherwise
 * auto-generation covers POST only (the one non-idempotent-by-spec verb).
 */
export function resolveIdempotencyKey(
  method: HttpMethod,
  explicitKey: string | undefined,
  config: ResolvedIdempotency,
): string | undefined {
  if (explicitKey !== undefined && explicitKey !== '') return explicitKey;
  if (config.autoGenerate && method === 'POST') return config.generate();
  return undefined;
}
