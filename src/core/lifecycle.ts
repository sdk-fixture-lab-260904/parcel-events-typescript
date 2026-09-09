import { authorizeWithin } from './abort.js';
import { APIUserAbortError, APIConnectionTimeoutError } from './errors.js';

export interface RequestContext {
  /** Stable generated operation name; absent for undocumented raw endpoints. */
  readonly operation?: string;
  readonly method: string;
  readonly url: string;
  readonly attempt: number;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ResponseContext extends RequestContext {
  readonly status: number;
  readonly responseHeaders: Readonly<Record<string, string>>;
}

export interface LifecycleHooks {
  /** Runs after authentication for each attempt; returned headers override this attempt only. */
  readonly beforeRequest?: (context: RequestContext) => void | Readonly<Record<string, string>> | Promise<void | Readonly<Record<string, string>>>;
  /** Observes response metadata without consuming or replacing its body. */
  readonly afterResponse?: (context: ResponseContext) => void | Promise<void>;
  /** Observes a failed transport attempt. Throwing stops retries and preserves the cause. */
  readonly onError?: (context: RequestContext, error: unknown) => void | Promise<void>;
}

export class LifecycleHookError extends Error {
  constructor(readonly phase: keyof LifecycleHooks, cause: unknown) {
    super(`SDK lifecycle hook failed: ${phase}`, { cause });
    this.name = 'LifecycleHookError';
  }
}

export class LifecycleHookTimeoutError extends APIConnectionTimeoutError {
  constructor(readonly phase: keyof LifecycleHooks, timeoutMs: number) {
    super(timeoutMs);
    this.name = 'LifecycleHookTimeoutError';
  }
}

async function callHook<T>(phase: keyof LifecycleHooks, context: RequestContext, hook: () => T | Promise<T>): Promise<T> {
  try {
    return await authorizeWithin(Promise.resolve().then(() => {
      if (context.signal?.aborted) throw new APIUserAbortError();
      return hook();
    }), context.timeoutMs, context.signal);
  } catch (error) {
    if (error instanceof APIUserAbortError) throw error;
    if (error instanceof APIConnectionTimeoutError) throw new LifecycleHookTimeoutError(phase, context.timeoutMs);
    throw new LifecycleHookError(phase, error);
  }
}

/** Hooks cannot consume response bodies, change retry identity, or evade call cancellation. */
export async function lifecycleRequest(
  hooks: LifecycleHooks | undefined,
  context: RequestContext,
  send: (headers: Readonly<Record<string, string>>) => Promise<Response>,
): Promise<Response> {
  if (hooks === undefined) return send(context.headers);
  const frozen = Object.freeze({ ...context, headers: Object.freeze({ ...context.headers }) });
  const added = hooks?.beforeRequest === undefined ? undefined
    : await callHook('beforeRequest', frozen, () => hooks.beforeRequest?.(frozen));
  let response: Response;
  try {
    const headers = new Headers(context.headers);
    for (const [name, value] of Object.entries(added ?? {})) headers.set(name, value);
    response = await send(Object.fromEntries(headers));
  }
  catch (error) {
    if (hooks?.onError !== undefined && !context.signal?.aborted) {
      await callHook('onError', frozen, () => hooks.onError?.(frozen, error));
    }
    throw error;
  }
  try {
    if (hooks?.afterResponse !== undefined) {
      const result = Object.freeze({ ...frozen, status: response.status,
        responseHeaders: Object.freeze(Object.fromEntries(response.headers)) });
      await callHook('afterResponse', frozen, () => hooks.afterResponse?.(result));
    }
    return response;
  } catch (error) {
    void response.body?.cancel().catch(() => undefined);
    throw error;
  }
}
