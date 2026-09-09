import { ResponseValidationError } from './validation.js';
/** Hold cancellation and timeout through body consumption, including streaming. */
export function protectBody(response: Response, signal: AbortSignal, failure: () => Error, cleanup: () => void): Response {
  if (signal.aborted) { cleanup(); void response.body?.cancel().catch(() => undefined); throw failure(); }
  if (response.body === null) { cleanup(); return response; }
  const reader = response.body.getReader();
  let finished = false;
  let onAbort: () => void = () => undefined;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', onAbort);
    cleanup();
    reader.releaseLock();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      onAbort = () => {
        if (finished) return;
        controller.error(failure());
        void reader.cancel().catch(() => undefined);
        finish();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (finished) return;
        if (done) { finish(); controller.close(); }
        else controller.enqueue(value);
      } catch (error) {
        if (!finished) { void reader.cancel().catch(() => undefined); finish(); controller.error(error); }
      }
    },
    cancel(reason) { void reader.cancel(reason).catch(() => undefined); finish(); },
  });
  const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  for (const key of ['url', 'redirected', 'type'] as const) Object.defineProperty(wrapped, key, { value: response[key] });
  return wrapped;
}

/** Parse a response body by content type: JSON → value, text → string, else bytes. */
export async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    const text = await response.text();
    try { return text === '' ? null : (JSON.parse(text) as unknown); }
    catch { throw new ResponseValidationError(['$: invalid JSON']); }
  }
  if (contentType.startsWith('text/') || contentType === '') return await response.text();
  return new Uint8Array(await response.arrayBuffer());
}
