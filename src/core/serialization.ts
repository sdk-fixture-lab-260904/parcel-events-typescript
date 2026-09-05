/**
 * Serialization helpers (doc 38 §3.2 rows 7–8): OpenAPI query-encoding styles
 * (form / form-no-explode / spaceDelimited / pipeDelimited / deepObject),
 * JSON bodies, multipart/form-data uploads, binary downloads, and a
 * dependency-free base64 (used by basic auth — `btoa` is latin1-only).
 *
 * Vendored kernel file — imports nothing.
 */

export type QueryPrimitive = string | number | boolean;
export type QueryParamValue =
  | QueryPrimitive
  | readonly QueryPrimitive[]
  | Readonly<Record<string, QueryPrimitive>>
  | null
  | undefined;

export type QueryStyle = 'form' | 'formNoExplode' | 'spaceDelimited' | 'pipeDelimited' | 'deepObject';

/**
 * Encode query params. Style defaults to OpenAPI's `form` (explode): arrays
 * repeat the key, objects flatten to their property names. Key order follows
 * the caller's insertion order — deterministic for identical input.
 */
export function encodeQuery(
  params: Readonly<Record<string, QueryParamValue>>,
  styles?: Readonly<Record<string, QueryStyle>>,
): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    encodeParam(pairs, key, value, styles?.[key] ?? 'form');
  }
  return pairs.join('&');
}

/** Append `query` onto a URL that may already carry a query string. */
export function appendQuery(url: string, query: string): string {
  if (query === '') return url;
  return url + (url.includes('?') ? '&' : '?') + query;
}

function encodeParam(
  pairs: string[],
  key: string,
  value: NonNullable<QueryParamValue>,
  style: QueryStyle,
): void {
  if (typeof value !== 'object') {
    pairs.push(pair(key, value));
    return;
  }
  if (Array.isArray(value)) {
    encodeArray(pairs, key, value as readonly QueryPrimitive[], style);
    return;
  }
  encodeObject(pairs, key, value as Readonly<Record<string, QueryPrimitive>>, style);
}

function encodeArray(pairs: string[], key: string, values: readonly QueryPrimitive[], style: QueryStyle): void {
  switch (style) {
    case 'form':
      for (const value of values) pairs.push(pair(key, value));
      return;
    case 'formNoExplode':
      pairs.push(joined(key, values, ','));
      return;
    case 'spaceDelimited':
      pairs.push(joined(key, values, '%20'));
      return;
    case 'pipeDelimited':
      pairs.push(joined(key, values, '%7C'));
      return;
    case 'deepObject':
      values.forEach((value, index) => pairs.push(pair(`${key}[${index}]`, value)));
      return;
    default:
      unreachable(style);
  }
}

function encodeObject(
  pairs: string[],
  key: string,
  value: Readonly<Record<string, QueryPrimitive>>,
  style: QueryStyle,
): void {
  switch (style) {
    case 'form':
      for (const [prop, propValue] of Object.entries(value)) pairs.push(pair(prop, propValue));
      return;
    case 'formNoExplode': {
      const flat = Object.entries(value).flatMap(([prop, propValue]) => [prop, propValue]);
      pairs.push(joined(key, flat, ','));
      return;
    }
    case 'deepObject':
      for (const [prop, propValue] of Object.entries(value)) pairs.push(pair(`${key}[${prop}]`, propValue));
      return;
    case 'spaceDelimited':
    case 'pipeDelimited':
      throw new TypeError(`query style "${style}" does not support object values`);
    default:
      unreachable(style);
  }
}

function pair(key: string, value: QueryPrimitive): string {
  return `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`;
}

function joined(key: string, values: readonly QueryPrimitive[], separator: string): string {
  return `${encodeURIComponent(key)}=${values.map((v) => encodeURIComponent(String(v))).join(separator)}`;
}

/** JSON request body + its content type. */
export function jsonBody(value: unknown): { body: string; contentType: 'application/json' } {
  return { body: JSON.stringify(value), contentType: 'application/json' };
}

// ── multipart upload ───────────────────────────────────────────────────────

export interface UploadPart {
  readonly data: Uint8Array<ArrayBuffer> | string;
  readonly filename?: string;
  readonly contentType?: string;
}

export type MultipartFieldValue = Blob | UploadPart | QueryPrimitive;

/** Build a `FormData` body — fetch stamps the boundary content-type itself. */
export function toFormData(
  fields: Readonly<Record<string, MultipartFieldValue | readonly MultipartFieldValue[]>>,
): FormData {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    const items: readonly MultipartFieldValue[] = Array.isArray(value)
      ? (value as readonly MultipartFieldValue[])
      : [value as MultipartFieldValue];
    for (const item of items) appendField(form, key, item);
  }
  return form;
}

function appendField(form: FormData, key: string, value: MultipartFieldValue): void {
  if (value instanceof Blob) {
    form.append(key, value);
    return;
  }
  if (typeof value === 'object') {
    const blob =
      value.contentType === undefined
        ? new Blob([value.data])
        : new Blob([value.data], { type: value.contentType });
    form.append(key, blob, value.filename ?? 'upload');
    return;
  }
  form.append(key, String(value));
}

// ── binary download ────────────────────────────────────────────────────────

/** Read a binary response body into bytes. */
export async function readBinary(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}

// ── base64 (dependency-free, RFC 4648) ─────────────────────────────────────

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64-encode bytes (strings encode as UTF-8 first — unlike `btoa`). */
export function encodeBase64(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const triple = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    out += BASE64_ALPHABET[(triple >> 18) & 63] ?? '';
    out += BASE64_ALPHABET[(triple >> 12) & 63] ?? '';
    out += b1 === undefined ? '=' : (BASE64_ALPHABET[(triple >> 6) & 63] ?? '');
    out += b2 === undefined ? '=' : (BASE64_ALPHABET[triple & 63] ?? '');
  }
  return out;
}

function unreachable(value: never): never {
  throw new Error(`unreachable: ${String(value)}`);
}
