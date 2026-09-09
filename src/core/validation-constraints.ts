import { matchesFormat } from './validation-formats.js';
import { matchesPattern } from './validation-pattern.js';
/** JSON Schema assertions over wire values. */
type Schema = Readonly<Record<string, unknown>>;

function rational(value: number): readonly [bigint, bigint] {
  const [mantissa = '', exponent = '0'] = String(value).toLowerCase().split('e');
  const decimals = mantissa.split('.')[1]?.length ?? 0;
  const scale = decimals - Number(exponent);
  const numerator = BigInt(mantissa.replace('.', ''));
  return scale >= 0 ? [numerator, 10n ** BigInt(scale)] : [numerator * 10n ** BigInt(-scale), 1n];
}
function multipleOf(value: number, divisor: number): boolean {
  if (!Number.isFinite(divisor) || divisor <= 0) return false;
  const [a, b] = rational(value);
  const [c, d] = rational(divisor);
  return (a * d) % (b * c) === 0n;
}
function numberConstraint(schema: Schema, value: number): string | null {
  if (!Number.isFinite(value)) return 'non-finite number';
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'] as const) {
    const bound = schema[key];
    if (typeof bound !== 'number') continue;
    if ((key === 'minimum' && value < bound) || (key === 'maximum' && value > bound)
      || (key === 'exclusiveMinimum' && value <= bound) || (key === 'exclusiveMaximum' && value >= bound)) return key;
  }
  const divisor = schema['multipleOf'];
  return typeof divisor === 'number' && !multipleOf(value, divisor) ? 'multipleOf' : null;
}
function lengthConstraint(schema: Schema, length: number, suffix: string): string | null {
  const min = schema[`min${suffix}`];
  const max = schema[`max${suffix}`];
  if (typeof min === 'number' && length < min) return `min${suffix}`;
  return typeof max === 'number' && length > max ? `max${suffix}` : null;
}
/** Canonical equality makes object property order irrelevant, including nested arrays. */
function canonical(value: unknown, budget: { remaining: number }, depth = 0): string {
  if (--budget.remaining < 0 || depth > 128) throw new RangeError('validation budget exceeded');
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, budget, depth + 1)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).toSorted().map((key) => `${JSON.stringify(key)}:${canonical((value as Schema)[key], budget, depth + 1)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
function arrayConstraint(schema: Schema, value: readonly unknown[]): string | null {
  const error = lengthConstraint(schema, value.length, 'Items');
  if (error !== null || schema['uniqueItems'] !== true) return error;
  const keys = new Set<string>();
  const budget = { remaining: 100_000 };
  try {
    for (const item of value) {
      const key = canonical(item, budget);
      if (keys.has(key)) return 'uniqueItems';
      keys.add(key);
    }
  } catch { return 'validation budget exceeded'; }
  return null;
}
export function constraintError(schema: Schema, value: unknown): string | null {
  if (typeof value === 'number') return numberConstraint(schema, value);
  if (typeof value === 'string') {
    const error = lengthConstraint(schema, [...value].length, 'Length');
    if (error !== null) return error;
    if (typeof schema['format'] === 'string' && !matchesFormat(schema['format'], value)) return `format ${schema['format']}`;
    const pattern = schema['pattern'];
    if (typeof pattern === 'string') {
      try { if (!matchesPattern(pattern, value)) return 'pattern'; }
      catch { return 'invalid pattern'; }
    }
  }
  if (Array.isArray(value)) return arrayConstraint(schema, value);
  if (value !== null && typeof value === 'object') return lengthConstraint(schema, Object.keys(value).length, 'Properties');
  return null;
}
