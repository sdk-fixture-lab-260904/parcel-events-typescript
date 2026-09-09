/** Settle cancellation even when an injected adapter ignores its signal. */
export async function fetchWithSignal(
  fetchFn: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const pending = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return fetchFn(url, { ...init, signal });
    }).then(response => {
      if (signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        throw signal.reason;
      }
      return response;
    });
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
