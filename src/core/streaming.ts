/**
 * Streaming readers (doc 38 §3.2 row 3, `streaming:` protocols `sse|jsonl`):
 * an SSE parser and a JSONL line reader, both surfaced through `Stream<T>` —
 * a single-use AsyncIterable of typed events. `[DONE]` (configurable)
 * terminates SSE streams; an early `break` cancels the underlying body
 * reader (proper close handling), and an incomplete trailing SSE event is
 * discarded per the spec.
 *
 * Vendored kernel file — imports only sibling kernel modules.
 */
import { APIConnectionError } from './errors.js';

export interface ServerSentEvent {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
}

/**
 * Decode a byte stream into lines (`\n` / `\r\n`), buffering across chunk
 * boundaries. The reader is cancelled when the consumer stops early.
 */
async function* streamLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done && buffer.endsWith('\r')) buffer += '\n';
      const parts = buffer.split(/\r\n|\r(?!$)|\n/);
      buffer = parts.pop() ?? '';
      if (buffer.length > 8 * 1024 * 1024 || parts.some(part => part.length > 8 * 1024 * 1024)) {
        throw new Error('Stream line limit exceeded');
      }
      for (const part of parts) yield trimCr(part);
      if (done) {
        if (buffer.length > 0) yield trimCr(buffer);
        return;
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function trimCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Parse an SSE byte stream into events (WHATWG EventSource semantics). */
export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<ServerSentEvent, void, undefined> {
  let event = '';
  let dataLines: string[] = [];
  let dataLength = 0;
  let id: string | undefined;
  let retry: number | undefined;
  for await (const line of streamLines(stream)) {
    if (line === '') {
      if (dataLines.length > 0) {
        yield { event: event === '' ? 'message' : event, data: dataLines.join('\n'), id, retry };
      }
      event = '';
      dataLines = [];
      dataLength = 0;
      continue;
    }
    if (line.startsWith(':')) continue;
    const { field, value } = splitSseField(line);
    if (field === 'event') event = value;
    else if (field === 'data') {
      dataLength += value.length + 1;
      if (dataLength > 8 * 1024 * 1024) throw new Error('Stream event limit exceeded');
      dataLines.push(value);
    }
    else if (field === 'id' && !value.includes('\0')) id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
  }
  // End of stream: an incomplete event (no dispatching blank line) is discarded.
}

function splitSseField(line: string): { field: string; value: string } {
  const colon = line.indexOf(':');
  if (colon === -1) return { field: line, value: '' };
  const raw = line.slice(colon + 1);
  return { field: line.slice(0, colon), value: raw.startsWith(' ') ? raw.slice(1) : raw };
}

/** Parse newline-delimited JSON; blank lines are skipped. */
export async function* parseJsonLines<T>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T, void, undefined> {
  for await (const line of streamLines(stream)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    yield JSON.parse(trimmed) as T;
  }
}

export interface SseStreamOptions {
  /** SSE data sentinel that ends the stream (default `[DONE]`). */
  readonly doneSentinel?: string;
}

/** A single-use async iterable of typed streaming events. */
export class Stream<T> implements AsyncIterable<T> {
  private consumed = false;

  private constructor(private readonly source: () => AsyncGenerator<T, void, undefined>) {}

  /** Validate each event without materializing or buffering the stream. */
  validate(check: (value: unknown) => void): Stream<T> {
    return new Stream<T>(() => validateEvents(this, check));
  }

  /** Typed events from an SSE response: JSON-parsed `data`, `[DONE]`-aware. */
  static fromSSE<T>(response: Response, options?: SseStreamOptions): Stream<T> {
    const body = requireBody(response, 'sse');
    const doneSentinel = options?.doneSentinel ?? '[DONE]';
    return new Stream<T>(async function* () {
      for await (const sse of parseSSE(body)) {
        if (sse.data === doneSentinel) return;
        yield JSON.parse(sse.data) as T;
      }
    });
  }

  /** Raw SSE events (event name, id, retry preserved) — no JSON parsing. */
  static fromSSEEvents(response: Response): Stream<ServerSentEvent> {
    const body = requireBody(response, 'sse');
    return new Stream<ServerSentEvent>(() => parseSSE(body));
  }

  /** Typed items from a JSONL response. */
  static fromJSONL<T>(response: Response): Stream<T> {
    const body = requireBody(response, 'jsonl');
    return new Stream<T>(() => parseJsonLines<T>(body));
  }

  [Symbol.asyncIterator](): AsyncIterator<T, void, undefined> {
    if (this.consumed) throw new Error('this Stream was already consumed — iterate it once');
    this.consumed = true;
    return this.source();
  }
}

function requireBody(response: Response, protocol: 'sse' | 'jsonl'): ReadableStream<Uint8Array> {
  if (response.body === null) {
    throw new APIConnectionError('Response has no body to stream');
  }
  const media = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const supported = protocol === 'sse' ? media === 'text/event-stream'
    : ['application/jsonl', 'application/x-ndjson', 'application/ndjson'].includes(media ?? '');
  if (!supported) {
    void response.body.cancel().catch(() => undefined);
    throw new APIConnectionError('Stream response content type mismatch');
  }
  return response.body;
}

async function* validateEvents<T>(source: AsyncIterable<T>, check: (value: unknown) => void): AsyncGenerator<T, void, undefined> {
  for await (const value of source) { check(value); yield value; }
}
