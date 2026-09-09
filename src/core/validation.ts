import { constraintError } from './validation-constraints.js';
/** Structural wire validation for generated contracts; never coerces or strips data. */
export interface ValidationOptions {
  readonly request?: boolean;
  readonly response?: boolean;
}
export type Schema = Readonly<Record<string, unknown>>;
export interface ValidationContract {
  readonly schema: Schema;
  readonly definitions: Schema;
}
export class SDKValidationError extends Error {
  constructor(readonly direction: 'request' | 'response', readonly issues: readonly string[]) {
    super(`${direction} validation failed: ${issues.join('; ')}`);
    this.name = direction === 'request' ? 'SDKValidationError' : 'ResponseValidationError';
  }
}
export class ResponseValidationError extends SDKValidationError {
  constructor(issues: readonly string[]) { super('response', issues); }
}
interface Context { readonly definitions: Schema; remaining: number }
class ValidationBudgetExceeded extends Error {}
interface Site { readonly path: string; readonly depth: number }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function own(record: Schema, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
function kind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return !Number.isFinite(value) ? 'nonfinite' : Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}
function checkObject(ctx: Context, schema: Schema, value: Schema, site: Site): string | null {
  const { path, depth } = site;
  const properties = object(schema['properties']) ? schema['properties'] : {};
  const required = Array.isArray(schema['required']) ? schema['required'] : [];
  for (const key of required) {
    if (typeof key === 'string' && own(value, key) === undefined) return `${path}.${key}: required`;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    const child = own(properties, key);
    const extra = schema['additionalProperties'];
    if (child === undefined && extra === false) return `${path}.${key}: unexpected property`;
    const rule = child ?? extra;
    if (object(rule)) {
      const error = check(ctx, rule, entry, { path: `${path}.${key}`, depth: depth + 1 });
      if (error !== null) return error;
    }
  }
  return null;
}
function checkBranches(ctx: Context, schema: Schema, value: unknown, site: Site): string | null {
  const { path, depth } = site;
  const branches = schema['anyOf'] ?? schema['oneOf'];
  if (Array.isArray(branches)) {
    let matches = 0;
    for (const branch of branches) {
      if (object(branch) && check(ctx, branch, value, { path, depth: depth + 1 }) === null) matches++;
      if (matches > 0 && schema['oneOf'] === undefined) return null;
    }
    return matches === 1 ? null : `${path}: no unique matching schema variant`;
  }
  return `${path}: invalid schema variants`;
}
function checkScalar(schema: Schema, value: unknown, path: string): string | null {
  const declared = schema['type'];
  const types = Array.isArray(declared) ? declared : [declared];
  const actual = kind(value);
  if (declared !== undefined && !types.some((type) => type === actual || (type === 'number' && actual === 'integer'))) {
    return `${path}: expected ${types.join('|')}, received ${actual}`;
  }
  const choices = schema['enum'];
  return Array.isArray(choices) && !choices.some((entry) => Object.is(entry, value)) ? `${path}: invalid enum value` : null;
}
function checkCompositions(ctx: Context, schema: Schema, value: unknown, site: Site): string | null {
  const next = { path: site.path, depth: site.depth + 1 };
  const all = schema['allOf'];
  if (Array.isArray(all)) {
    for (const branch of all) {
      if (!object(branch)) return `${site.path}: invalid schema branch`;
      const error = check(ctx, branch, value, next);
      if (error !== null) return error;
    }
  }
  const excluded = schema['not'];
  return object(excluded) && check(ctx, excluded, value, next) === null ? `${site.path}: excluded schema variant` : null;
}
function binaryValue(schema: Schema, value: unknown): boolean {
  return schema['format'] === 'binary' && (value instanceof Uint8Array || (typeof Blob !== 'undefined' && value instanceof Blob));
}
function checkItems(ctx: Context, schema: Schema, value: unknown, site: Site): string | null {
  const { path, depth } = site;
  if (Array.isArray(value) && object(schema['items'])) {
    for (let index = 0; index < value.length; index++) {
      const error = check(ctx, schema['items'], value[index], { path: `${path}[${index}]`, depth: depth + 1 });
      if (error !== null) return error;
    }
  }
  return null;
}
function checkReference(ctx: Context, schema: Schema, value: unknown, site: Site): string | null {
  const ref = schema['$ref'];
  if (typeof ref !== 'string') return null;
  const name = ref.startsWith('#/$defs/') ? ref.slice(8) : '';
  const target = own(ctx.definitions, name);
  if (!object(target)) return `${site.path}: unresolved schema reference`;
  return check(ctx, target, value, { path: site.path, depth: site.depth + 1 });
}
function check(ctx: Context, schema: Schema, value: unknown, site: Site): string | null {
  const { path, depth } = site;
  if (depth > 128 || --ctx.remaining < 0) throw new ValidationBudgetExceeded();
  const compositionError = checkCompositions(ctx, schema, value, site);
  if (compositionError !== null) return compositionError;
  const referenceError = checkReference(ctx, schema, value, site);
  if (referenceError !== null) return referenceError;
  if (schema['anyOf'] !== undefined || schema['oneOf'] !== undefined) {
    const error = checkBranches(ctx, schema, value, site);
    if (error !== null) return error;
  }
  // Multipart binary values are transport objects, not JSON strings.
  if (binaryValue(schema, value)) return null;
  const scalarError = checkScalar(schema, value, path);
  if (scalarError !== null) return scalarError;
  const constraint = constraintError(schema, value);
  if (constraint === 'validation budget exceeded' || constraint === 'invalid pattern') throw new ValidationBudgetExceeded();
  if (constraint !== null) return `${path}: ${constraint}`;
  if (object(value)) return checkObject(ctx, schema, value, site);
  return checkItems(ctx, schema, value, site);
}
export function assertValid(contract: ValidationContract, value: unknown, direction: 'request' | 'response'): void {
  let error: string | null;
  try { error = check({ definitions: contract.definitions, remaining: 100_000 }, contract.schema, value, { path: '$', depth: 0 }); }
  catch (cause) {
    if (!(cause instanceof ValidationBudgetExceeded)) throw cause;
    error = '$: validation budget exceeded';
  }
  if (error !== null) {
    if (direction === 'response') throw new ResponseValidationError([error]);
    throw new SDKValidationError('request', [error]);
  }
}
