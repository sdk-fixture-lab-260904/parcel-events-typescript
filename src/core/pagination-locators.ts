/**
 * Pagination locator primitives (doc 38 §3.2 row 2) — the `doctorine.sdk.yml`
 * role-mapping grammar shared by every page class: request locators
 * (`query.cursor`, `body.page`, `header.x-next`) and `$`-rooted dotted
 * response body pointers (`$.data`, `$.result_info.cursor`).
 *
 * Vendored kernel file — imports only sibling kernel modules.
 */
import type { HttpMethod } from './transport.js';

export type PageQueryValue = string | number | boolean;

export interface PageRequest {
  readonly method: HttpMethod;
  /** Path relative to the client's baseUrl, or an absolute URL (cursor_url). */
  readonly url: string;
  readonly query: Readonly<Record<string, PageQueryValue>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** The client hook page classes fetch through (CoreClient implements it). */
export interface PageFetcher {
  requestPage(request: PageRequest): Promise<{ readonly body: unknown }>;
}

/** Read a `$`-rooted dotted body pointer (`$.data.items`). */
export function readBodyPointer(body: unknown, pointer: string): unknown {
  if (pointer !== '$' && !pointer.startsWith('$.')) {
    throw new Error(`invalid body pointer: ${pointer}`);
  }
  const segments = pointer === '$' ? [] : pointer.slice(2).split('.');
  let current: unknown = body;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Immutably set a request locator (`query.cursor` / `header.x` / `body.a.b`). */
export function applyRequestLocator(request: PageRequest, locator: string, value: PageQueryValue): PageRequest {
  const { kind, rest } = splitLocator(locator);
  switch (kind) {
    case 'query':
      return { ...request, query: { ...request.query, [rest]: value } };
    case 'header':
      return { ...request, headers: { ...request.headers, [rest]: String(value) } };
    case 'body':
      return { ...request, body: deepSet(request.body, rest.split('.'), value) };
    case 'path':
      throw new Error('path.* locators cannot advance pagination at runtime');
    default:
      throw new Error(`unknown request locator kind: ${kind}`);
  }
}

/** Read the current value at a request locator (offset/page_number schemes). */
export function readRequestLocator(request: PageRequest, locator: string): unknown {
  const { kind, rest } = splitLocator(locator);
  switch (kind) {
    case 'query':
      return request.query[rest];
    case 'header':
      return request.headers?.[rest];
    case 'body': {
      let current: unknown = request.body;
      for (const segment of rest.split('.')) {
        if (current === null || typeof current !== 'object') return undefined;
        current = (current as Record<string, unknown>)[segment];
      }
      return current;
    }
    default:
      return undefined;
  }
}

function splitLocator(locator: string): { kind: string; rest: string } {
  const dot = locator.indexOf('.');
  if (dot === -1) return { kind: locator, rest: '' };
  return { kind: locator.slice(0, dot), rest: locator.slice(dot + 1) };
}

function deepSet(target: unknown, path: readonly string[], value: unknown): unknown {
  const head = path[0];
  if (head === undefined) return value;
  const base =
    target !== null && typeof target === 'object' && !Array.isArray(target)
      ? (target as Record<string, unknown>)
      : {};
  return { ...base, [head]: deepSet(base[head], path.slice(1), value) };
}

/** The item array at a response pointer ([] when absent or not an array). */
export function itemsAt<Item>(body: unknown, pointer: string): readonly Item[] {
  const value = readBodyPointer(body, pointer);
  return Array.isArray(value) ? (value as readonly Item[]) : [];
}

/** A finite number from a number-or-numeric-string, else undefined. */
export function toFiniteNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}
