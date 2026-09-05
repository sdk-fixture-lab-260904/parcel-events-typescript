/**
 * `APIPromise<T>`: what every generated method returns. Awaiting it yields
 * the parsed body (`const pet = await client.pets.get(id)`); the same
 * object also answers `asResponse()` — the raw, unread `Response` (status,
 * headers, streaming body) — and `withResponse()` — the parsed body PLUS
 * the status and headers, for callers who need a request id or a rate-limit
 * header without giving up typing. The upstream request is issued once,
 * when the promise is first awaited or unwrapped, never on construction.
 *
 * Vendored kernel file — imports nothing.
 */

export interface ResponseMeta {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}

export interface WithResponse<T> extends ResponseMeta {
  readonly data: T;
  /** The raw `Response` — its body is already consumed; use `asResponse()` to read it yourself. */
  readonly response: Response;
}

function recordOf(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
}

export class APIPromise<T> implements PromiseLike<T> {
  private response: Promise<Response> | undefined;
  private parsed: Promise<T> | undefined;

  constructor(
    private readonly issue: () => Promise<Response>,
    private readonly parse: (response: Response) => Promise<T>,
  ) {}

  /** The raw, UNREAD `Response` (after auth, retries and error mapping). Reading it is the caller's job. */
  asResponse(): Promise<Response> {
    this.response ??= this.issue();
    return this.response;
  }

  /** The parsed body together with the status and headers of the response it came from. */
  async withResponse(): Promise<WithResponse<T>> {
    const response = await this.asResponse();
    const data = await this.data(response);
    return { data, status: response.status, headers: recordOf(response.headers), response };
  }

  // oxlint-disable-next-line unicorn/no-thenable -- a lazily issued, unwrappable thenable is the whole point
  then<R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): Promise<R1 | R2> {
    return this.asResponse()
      .then((response) => this.data(response))
      .then(onfulfilled, onrejected);
  }

  catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<T | R> {
    return this.then(undefined, onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<T> {
    return this.then((value) => value).finally(onfinally);
  }

  private data(response: Response): Promise<T> {
    this.parsed ??= this.parse(response);
    return this.parsed;
  }
}
