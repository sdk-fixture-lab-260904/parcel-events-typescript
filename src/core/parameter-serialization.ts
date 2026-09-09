/** OpenAPI parameter values are escaped before structural separators are added. */
export interface ParameterSerialization {
  readonly style: string;
  readonly explode: boolean;
  readonly allowReserved: boolean;
  readonly contentType?: string;
}
type Location = 'path' | 'query' | 'header' | 'cookie';
const RESERVED = /%([0-9A-F]{2})/g;
function encode(value: string, reserved = false): string {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  // #, &, = and + would alter URL/query structure. They remain escaped even
  // with allowReserved (OpenAPI Appendix E requires avoiding ambiguity).
  return reserved ? encoded.replace(RESERVED, (match, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return ":/?@!$'()*,;".includes(char) ? char : match;
  }).replace(/%25([0-9A-Fa-f]{2})/g, '%$1') : encoded;
}
function scalar(value: unknown): string {
  if (value === null) return '';
  if (!['string', 'number', 'boolean'].includes(typeof value)) throw new TypeError('OpenAPI parameter requires scalar members');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('OpenAPI parameter requires a finite number');
  return String(value);
}
interface Parts { readonly values: string[]; readonly entries: readonly (readonly [string, string])[] | null; readonly array: boolean }
function parts(value: unknown, encoder: (value: string) => string): Parts {
  if (Array.isArray(value)) return { values: value.map((item) => encoder(scalar(item))), entries: null, array: true };
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => [encoder(key), encoder(scalar(item))] as const);
    return { values: entries.flatMap(([key, item]) => [key, item]), entries, array: false };
  }
  return { values: [encoder(scalar(value))], entries: null, array: false };
}
function pathOrHeader(name: string, data: Parts, options: ParameterSerialization): string {
  const { style, explode } = options;
  const { values, entries, array } = data;
  if (style === 'simple') return entries && explode ? entries.map(([key, value]) => `${key}=${value}`).join(',') : values.join(',');
  if (style === 'label') return '.' + (entries && explode ? entries.map(([key, value]) => `${key}=${value}`).join('.') : values.join(explode ? '.' : ','));
  if (style !== 'matrix') throw new TypeError('Invalid path/header serialization style');
  if (!values.length) return '';
  if (entries && explode) return entries.map(([key, value]) => `;${key}${value === '' ? '' : `=${value}`}`).join('');
  if (array && explode) return values.map((value) => `;${name}${value === '' ? '' : `=${value}`}`).join('');
  const text = values.join(',');
  return `;${name}${text === '' ? '' : `=${text}`}`;
}
function queryOrCookie(name: string, data: Parts, options: ParameterSerialization, separator: string): string {
  const { style, explode } = options;
  const { values, entries, array } = data;
  if (style === 'deepObject') {
    if (!entries || !explode) throw new TypeError('deepObject requires a flat object and explode: true');
    return entries.map(([key, value]) => `${name}%5B${key}%5D=${value}`).join('&');
  }
  if (style === 'spaceDelimited' || style === 'pipeDelimited') {
    if ((!array && !entries) || explode) throw new TypeError('Delimited parameters require an array or object and explode: false');
    return `${name}=${values.join(style === 'spaceDelimited' ? '%20' : '%7C')}`;
  }
  if (style !== 'form') throw new TypeError('Invalid query/cookie serialization style');
  if (explode && entries) return entries.map(([key, value]) => `${key}=${value}`).join(separator);
  if (explode && array) return values.map((value) => `${name}=${value}`).join(separator);
  return `${name}=${values.join(',')}`;
}
export function serializeParameter(name: string, value: unknown, location: Location, supplied?: ParameterSerialization): string {
  if (value === undefined) return '';
  const options = supplied ?? { style: location === 'query' || location === 'cookie' ? 'form' : 'simple', explode: location === 'query' || location === 'cookie', allowReserved: false };
  const encoder = location === 'header' ? (text: string) => {
    if (text.includes('\r') || text.includes('\n') || text.includes(String.fromCharCode(0))) throw new TypeError('Invalid header parameter');
    return text;
  } : (text: string) => encode(text, location === 'query' && options.allowReserved);
  const wireValue = options.contentType === undefined ? value : JSON.stringify(value);
  if (options.contentType !== undefined) {
    const text = encoder(scalar(wireValue));
    return location === 'path' || location === 'header' ? text : `${encode(name)}=${text}`;
  }
  const data = parts(wireValue, encoder);
  return location === 'path' || location === 'header'
    ? pathOrHeader(encode(name), data, options)
    : queryOrCookie(encode(name), data, options, location === 'cookie' ? '; ' : '&');
}
