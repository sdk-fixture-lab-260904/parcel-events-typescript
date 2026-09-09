/**
 * Retry policy + backoff math (doc 38 §3.2 row 4). Retries are ON BY DEFAULT
 * (max 2), mirroring the `retries:` block of `doctorine.sdk.yml` field for
 * field — config only tunes what the kernel already does. Backoff is pure
 * exponential WITHOUT jitter: the kernel never draws randomness, so retry
 * schedules are reproducible (the determinism doctrine extended to runtime).
 * `Retry-After` (seconds or HTTP-date) and `retry-after-ms` are respected
 * when the server sends them, and an explicit `x-should-retry: true|false`
 * from the server overrides the status-code policy (never the retry budget).
 *
 * Vendored kernel file — everything here is a pure function.
 */

/** A literal status code or a whole 4XX/5XX family. */
export type StatusMatcher = number | '4XX' | '5XX';

export interface RetryPolicy {
  readonly enabled: boolean;
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxElapsedMs: number;
  readonly exponent: number;
  readonly statusCodes: readonly StatusMatcher[];
  readonly retryConnectionErrors: boolean;
}

/** Mirrors the `retries:` defaults in the sdk-config schema, byte for byte. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  enabled: true,
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 8_000,
  maxElapsedMs: 60_000,
  exponent: 2,
  statusCodes: [408, 429, '5XX'],
  retryConnectionErrors: true,
};

export function resolveRetryPolicy(overrides?: Partial<RetryPolicy>): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...overrides };
}

/** What the failed attempt looked like. */
export type RetryOutcome = { readonly kind: 'status'; readonly status: number } | { readonly kind: 'connection' };

export interface RetryState {
  /** 0-based count of retries already performed. */
  readonly attempt: number;
  /** Wall-clock ms since the first attempt started. */
  readonly elapsedMs: number;
}

export interface RetryDecision {
  readonly retry: boolean;
  readonly delayMs: number;
}

/** What the server said about retrying: its wait hint and its explicit verdict. */
export interface RetryHints {
  readonly retryAfterMs?: number | undefined;
  /** `x-should-retry: true|false` — overrides the status policy, never the budget. */
  readonly shouldRetry?: boolean | undefined;
}

const NO_RETRY: RetryDecision = { retry: false, delayMs: 0 };

export function statusMatches(status: number, matcher: StatusMatcher): boolean {
  if (typeof matcher === 'number') return status === matcher;
  switch (matcher) {
    case '4XX':
      return status >= 400 && status < 500;
    case '5XX':
      return status >= 500 && status < 600;
    default:
      return unreachable(matcher);
  }
}

export function isRetryable(policy: RetryPolicy, outcome: RetryOutcome): boolean {
  switch (outcome.kind) {
    case 'connection':
      return policy.retryConnectionErrors;
    case 'status':
      return policy.statusCodes.some((matcher) => statusMatches(outcome.status, matcher));
    default:
      return unreachable(outcome);
  }
}

/**
 * The delay before retry number `retryIndex` (0-based). A server-provided
 * `Retry-After` overrides the exponential schedule (capped at maxElapsedMs);
 * otherwise `initialDelayMs * exponent^retryIndex`, capped at `maxDelayMs`.
 */
export function backoffDelayMs(policy: RetryPolicy, retryIndex: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(Math.max(retryAfterMs, 0), policy.maxElapsedMs);
  return Math.min(policy.initialDelayMs * policy.exponent ** retryIndex, policy.maxDelayMs);
}

/** The single retry-decision entry point the client transport consults. */
export function nextRetryDecision(
  policy: RetryPolicy,
  state: RetryState,
  outcome: RetryOutcome,
  hints: RetryHints = {},
): RetryDecision {
  if (!policy.enabled || state.attempt >= policy.maxRetries) return NO_RETRY;
  if (!(hints.shouldRetry ?? isRetryable(policy, outcome))) return NO_RETRY;
  const delayMs = backoffDelayMs(policy, state.attempt, hints.retryAfterMs);
  if (state.elapsedMs + delayMs > policy.maxElapsedMs) return NO_RETRY;
  return { retry: true, delayMs };
}

/**
 * Parse the server's wait hint: `retry-after-ms` (milliseconds, wins when
 * present and sane — under a minute) else `Retry-After` as delta-seconds
 * (`"3"`) or an IMF-fixdate (`"Wed, 01 Jul 2026 10:00:00 GMT"`), returned
 * as non-negative ms from `nowMs`. Unparseable values yield `undefined`
 * (fall back to backoff).
 */
export function parseRetryAfterMs(retryAfterMs: string | null, retryAfter: string | null, nowMs: number): number | undefined {
  if (retryAfterMs !== null && /^\d+$/.test(retryAfterMs.trim())) {
    const ms = Number(retryAfterMs.trim());
    if (ms < 60_000) return ms;
  }
  if (retryAfter === null) return undefined;
  const trimmed = retryAfter.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

/** `x-should-retry: true|false` — the server's explicit verdict, or undefined when absent/other. */
export function parseShouldRetry(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  const lowered = value.trim().toLowerCase();
  return lowered === 'true' ? true : lowered === 'false' ? false : undefined;
}

function unreachable(value: never): never {
  throw new Error(`unreachable: ${String(value)}`);
}
