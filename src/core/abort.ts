/** Cancel an awaited stage without leaving an abort listener behind. */
import { APIConnectionTimeoutError, APIUserAbortError } from './errors.js';

export async function abortable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return pending;
  if (signal.aborted) {
    void pending.catch(() => undefined);
    throw new APIUserAbortError();
  }
  let onAbort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new APIUserAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Bound credential resolution as well as transport; provider failures are never retried. */
export async function authorizeWithin<T>(pending: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new APIConnectionTimeoutError(timeoutMs)), timeoutMs);
  });
  try { return await abortable(Promise.race([pending, deadline]), signal); }
  finally { clearTimeout(timer); }
}

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
