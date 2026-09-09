/**
 * Pagination page classes (doc 38 §3.2 row 2) — one per `doctorine.sdk.yml`
 * scheme: cursor · cursor_url · offset · page_number · token · single_page ·
 * item_cursor. Every page is an `AsyncIterable<Item>`, so
 * `for await (const item of client.x.list())` transparently walks ALL pages
 * (a `single_page` walks its ONE response — the iteration surface stays
 * uniform across every list method). Bindings mirror the config's role
 * mappings verbatim: request locators (`query.cursor`, `body.page`,
 * `header.x-next`) and response body pointers (`$.data`, `$.next_cursor`);
 * the locator grammar lives in `pagination-locators.ts` (re-exported here so
 * generated code imports ONE pagination module).
 *
 * Vendored kernel file — imports only sibling kernel modules.
 */
import {
  applyRequestLocator,
  itemsAt,
  readBodyPointer,
  readRequestLocator,
  toFiniteNumber,
  type PageFetcher,
  type PageRequest,
} from './pagination-locators.js';

export {
  applyRequestLocator,
  itemsAt,
  readBodyPointer,
  readRequestLocator,
  toFiniteNumber,
  type PageFetcher,
  type PageQueryValue,
  type PageRequest,
} from './pagination-locators.js';

// ── the page base class ────────────────────────────────────────────────────

export abstract class AbstractPage<Item> implements AsyncIterable<Item> {
  protected constructor(
    protected readonly fetcher: PageFetcher,
    readonly request: PageRequest,
    readonly body: unknown,
  ) {}

  /** The items of THIS page. */
  abstract items(): readonly Item[];
  /** The request for the next page, or null when this is the last one. */
  abstract nextPageRequest(): PageRequest | null;
  /** Same-scheme page construction (keeps `getNextPage` type-safe). */
  protected abstract makePage(request: PageRequest, body: unknown): AbstractPage<Item>;

  hasNextPage(): boolean {
    return this.items().length > 0 && this.nextPageRequest() !== null;
  }

  async getNextPage(): Promise<AbstractPage<Item>> {
    const next = this.nextPageRequest();
    if (next === null) throw new Error('no next page; check hasNextPage() first');
    const { body } = await this.fetcher.requestPage(next);
    return this.makePage(next, body);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Item, void, undefined> {
    for (const item of this.items()) yield item;
    let page: AbstractPage<Item> | null = this.hasNextPage() ? await this.getNextPage() : null;
    while (page !== null) {
      for (const item of page.items()) yield item;
      page = page.hasNextPage() ? await page.getNextPage() : null;
    }
  }
}

// ── cursor ─────────────────────────────────────────────────────────────────

export interface CursorPageBinding {
  readonly requestCursor: string;
  readonly responseItems: string;
  readonly responseNextCursor: string;
}

export class CursorPage<Item> extends AbstractPage<Item> {
  constructor(
    fetcher: PageFetcher,
    request: PageRequest,
    body: unknown,
    private readonly binding: CursorPageBinding,
  ) {
    super(fetcher, request, body);
  }

  override items(): readonly Item[] {
    return itemsAt<Item>(this.body, this.binding.responseItems);
  }

  override nextPageRequest(): PageRequest | null {
    const cursor = readBodyPointer(this.body, this.binding.responseNextCursor);
    if (cursor === null || cursor === undefined || cursor === '') return null;
    if (typeof cursor !== 'string' && typeof cursor !== 'number') return null;
    return applyRequestLocator(this.request, this.binding.requestCursor, cursor);
  }

  protected override makePage(request: PageRequest, body: unknown): CursorPage<Item> {
    return new CursorPage<Item>(this.fetcher, request, body, this.binding);
  }
}

// ── token (google-style page tokens; cursor semantics, different roles) ────

export interface TokenPageBinding {
  readonly requestPageToken: string;
  readonly responseItems: string;
  readonly responseNextPageToken: string;
}

export class TokenPage<Item> extends CursorPage<Item> {
  constructor(
    fetcher: PageFetcher,
    request: PageRequest,
    body: unknown,
    private readonly tokenBinding: TokenPageBinding,
  ) {
    super(fetcher, request, body, {
      requestCursor: tokenBinding.requestPageToken,
      responseItems: tokenBinding.responseItems,
      responseNextCursor: tokenBinding.responseNextPageToken,
    });
  }

  protected override makePage(request: PageRequest, body: unknown): TokenPage<Item> {
    return new TokenPage<Item>(this.fetcher, request, body, this.tokenBinding);
  }
}

// ── cursor_url (the next page is a ready-made URL) ─────────────────────────

export interface CursorUrlPageBinding {
  readonly responseItems: string;
  readonly responseNextUrl: string;
}

export class CursorUrlPage<Item> extends AbstractPage<Item> {
  constructor(
    fetcher: PageFetcher,
    request: PageRequest,
    body: unknown,
    private readonly binding: CursorUrlPageBinding,
  ) {
    super(fetcher, request, body);
  }

  override items(): readonly Item[] {
    return itemsAt<Item>(this.body, this.binding.responseItems);
  }

  override nextPageRequest(): PageRequest | null {
    const nextUrl = readBodyPointer(this.body, this.binding.responseNextUrl);
    if (typeof nextUrl !== 'string' || nextUrl === '') return null;
    // The next URL carries its own query string — clear the request's.
    return { ...this.request, url: nextUrl, query: {} };
  }

  protected override makePage(request: PageRequest, body: unknown): CursorUrlPage<Item> {
    return new CursorUrlPage<Item>(this.fetcher, request, body, this.binding);
  }
}

// ── offset ─────────────────────────────────────────────────────────────────

export interface OffsetPageBinding {
  readonly requestOffset: string;
  readonly responseItems: string;
  readonly responseTotal?: string;
}

export class OffsetPage<Item> extends AbstractPage<Item> {
  constructor(
    fetcher: PageFetcher,
    request: PageRequest,
    body: unknown,
    private readonly binding: OffsetPageBinding,
  ) {
    super(fetcher, request, body);
  }

  override items(): readonly Item[] {
    return itemsAt<Item>(this.body, this.binding.responseItems);
  }

  override nextPageRequest(): PageRequest | null {
    const count = this.items().length;
    if (count === 0) return null;
    const current = toFiniteNumber(readRequestLocator(this.request, this.binding.requestOffset)) ?? 0;
    const nextOffset = current + count;
    if (this.binding.responseTotal !== undefined) {
      const total = toFiniteNumber(readBodyPointer(this.body, this.binding.responseTotal));
      if (total !== undefined && nextOffset >= total) return null;
    }
    return applyRequestLocator(this.request, this.binding.requestOffset, nextOffset);
  }

  protected override makePage(request: PageRequest, body: unknown): OffsetPage<Item> {
    return new OffsetPage<Item>(this.fetcher, request, body, this.binding);
  }
}

// ── page_number ────────────────────────────────────────────────────────────

export interface PageNumberPageBinding {
  readonly requestPage: string;
  readonly responseItems: string;
  readonly responseTotalPages?: string;
}

export class PageNumberPage<Item> extends AbstractPage<Item> {
  constructor(
    fetcher: PageFetcher,
    request: PageRequest,
    body: unknown,
    private readonly binding: PageNumberPageBinding,
  ) {
    super(fetcher, request, body);
  }

  override items(): readonly Item[] {
    return itemsAt<Item>(this.body, this.binding.responseItems);
  }

  override nextPageRequest(): PageRequest | null {
    if (this.items().length === 0) return null;
    const current = toFiniteNumber(readRequestLocator(this.request, this.binding.requestPage)) ?? 1;
    const nextPage = current + 1;
    if (this.binding.responseTotalPages !== undefined) {
      const totalPages = toFiniteNumber(readBodyPointer(this.body, this.binding.responseTotalPages));
      if (totalPages !== undefined && nextPage > totalPages) return null;
    }
    return applyRequestLocator(this.request, this.binding.requestPage, nextPage);
  }

  protected override makePage(request: PageRequest, body: unknown): PageNumberPage<Item> {
    return new PageNumberPage<Item>(this.fetcher, request, body, this.binding);
  }
}

// ── single_page (non-advancing: the one response IS the collection) ────────

export interface SinglePageBinding {
  readonly responseItems: string;
}

export class SinglePage<Item> extends AbstractPage<Item> {
  constructor(
    fetcher: PageFetcher,
    request: PageRequest,
    body: unknown,
    private readonly binding: SinglePageBinding,
  ) {
    super(fetcher, request, body);
  }

  override items(): readonly Item[] {
    return itemsAt<Item>(this.body, this.binding.responseItems);
  }

  /** This response is not paginated at the API level — there is never a
   *  next page (`for await` iterates the one response's items and stops). */
  override nextPageRequest(): null {
    return null;
  }

  protected override makePage(request: PageRequest, body: unknown): SinglePage<Item> {
    return new SinglePage<Item>(this.fetcher, request, body, this.binding);
  }
}

// ── item_cursor (the LAST item's field value is the next cursor) ───────────

export interface ItemCursorPageBinding {
  readonly requestCursor: string;
  readonly responseItems: string;
  readonly responseHasMore: string;
  /** Item field whose last value advances the cursor (`id`). */
  readonly itemCursorField: string;
}

export class ItemCursorPage<Item> extends AbstractPage<Item> {
  constructor(
    fetcher: PageFetcher,
    request: PageRequest,
    body: unknown,
    private readonly binding: ItemCursorPageBinding,
  ) {
    super(fetcher, request, body);
  }

  override items(): readonly Item[] {
    return itemsAt<Item>(this.body, this.binding.responseItems);
  }

  override nextPageRequest(): PageRequest | null {
    if (readBodyPointer(this.body, this.binding.responseHasMore) !== true) return null;
    const items = this.items();
    const last = items[items.length - 1];
    if (last === null || typeof last !== 'object') return null;
    const cursor = (last as Record<string, unknown>)[this.binding.itemCursorField];
    if (typeof cursor !== 'string' && typeof cursor !== 'number') return null;
    return applyRequestLocator(this.request, this.binding.requestCursor, cursor);
  }

  protected override makePage(request: PageRequest, body: unknown): ItemCursorPage<Item> {
    return new ItemCursorPage<Item>(this.fetcher, request, body, this.binding);
  }
}
