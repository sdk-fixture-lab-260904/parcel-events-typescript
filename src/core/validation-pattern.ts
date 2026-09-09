/** Thompson NFA for portable ECMA-262 patterns: bounded work, no backtracking. */
type Ast = { kind: 'atom'; source: string } | { kind: 'assert'; source: string }
  | { kind: 'sequence' | 'choice'; nodes: Ast[] } | { kind: 'repeat'; node: Ast; min: number; max: number };
interface Parser { chars: string[]; at: number; depth: number }
function expression(parser: Parser): Ast {
  if (++parser.depth > 64) throw new TypeError('Pattern nesting limit');
  const choices: Ast[] = [];
  do {
    const nodes: Ast[] = [];
    while (parser.at < parser.chars.length && !['|', ')'].includes((parser.chars[parser.at] ?? ''))) nodes.push(repeated(parser));
    choices.push({ kind: 'sequence', nodes });
    if (parser.chars[parser.at] !== '|') break;
    parser.at++;
  } while (parser.at <= parser.chars.length);
  parser.depth--;
  return choices.length === 1 ? (choices[0] ?? { kind: 'sequence', nodes: [] }) : { kind: 'choice', nodes: choices };
}
function escape(parser: Parser): string {
  const char = parser.chars[parser.at++];
  if (char === undefined || /[1-9]/.test(char) || ['k', 'p', 'P'].includes(char)) throw new TypeError('Unsupported pattern escape');
  if (char === 'u' || char === 'x') {
    const size = char === 'u' ? 4 : 2;
    const hex = parser.chars.slice(parser.at, parser.at + size).join('');
    if (hex.length !== size || !/^[0-9a-f]+$/i.test(hex)) throw new TypeError('Unsupported Unicode escape');
    parser.at += size;
    const code = Number.parseInt(hex, 16);
    if (code >= 0xd800 && code <= 0xdfff) return surrogatePair(parser, code);
    return `\\${char}${hex}`;
  }
  return `\\${char}`;
}
function surrogatePair(parser: Parser, high: number): string {
  const tail = parser.chars.slice(parser.at, parser.at + 6).join('');
  const low = /^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/.test(tail) ? Number.parseInt(tail.slice(2), 16) : 0;
  if (high > 0xdbff || low < 0xdc00) throw new TypeError('Unsupported isolated surrogate');
  parser.at += 6;
  return String.fromCodePoint(0x10000 + (high - 0xd800) * 0x400 + low - 0xdc00);
}
function atom(parser: Parser): Ast {
  const char = parser.chars[parser.at++];
  if (char === '(') {
    if (parser.chars[parser.at] === '?') {
      if (parser.chars[parser.at + 1] !== ':') throw new TypeError('Unsupported pattern group');
      parser.at += 2;
    }
    const node = expression(parser);
    if (parser.chars[parser.at++] !== ')') throw new TypeError('Unclosed pattern group');
    return node;
  }
  if (char === '^' || char === '$') return { kind: 'assert', source: char };
  if (char === '\\') {
    const source = escape(parser);
    return { kind: source === '\\b' || source === '\\B' ? 'assert' : 'atom', source };
  }
  if (char === '[') return characterClass(parser);
  if (char === undefined || '*+?{}'.includes(char)) throw new TypeError('Invalid pattern atom');
  return { kind: 'atom', source: char };
}
function characterClass(parser: Parser): Ast {
    let source = '[';
    while (parser.at < parser.chars.length) {
      const item = parser.chars[parser.at++];
      source += item === '\\' ? escape(parser) : item;
      if (item === ']') return { kind: 'atom', source };
    }
    throw new TypeError('Unclosed pattern class');
}

function repeated(parser: Parser): Ast {
  const node = atom(parser);
  const char = parser.chars[parser.at];
  let min: number;
  let max: number;
  if (char === '*' || char === '+' || char === '?') {
    parser.at++;
    min = char === '+' ? 1 : 0;
    max = char === '?' ? 1 : Infinity;
  } else if (char === '{') {
    [min, max] = repetitionBounds(parser);
  } else return node;
  if (node.kind === 'assert') throw new TypeError('Repeated assertion');
  if (parser.chars[parser.at] === '?') parser.at++; // Greediness does not affect acceptance.
  return { kind: 'repeat', node, min, max };
}
function repetitionBounds(parser: Parser): readonly [number, number] {
    const tail = parser.chars.slice(parser.at).join('');
    const match = /^\{(\d+)(?:,(\d*))?\}/.exec(tail);
    if (!match) throw new TypeError('Invalid pattern repetition');
    parser.at += match[0].length;
    const min = Number(match[1]);
    const max = match[2] === undefined ? min : match[2] === '' ? Infinity : Number(match[2]);
    if (min > 1000 || (max !== Infinity && max > 1000) || max < min) throw new TypeError('Pattern repetition limit');
    return [min, max];
}
type State = { kind: 'accept' } | { kind: 'split'; next: number[] }
  | { kind: 'atom'; test: RegExp; next: number } | { kind: 'assert'; source: string; next: number };
function add(states: State[], state: State): number {
  if (states.length >= 10_000) throw new TypeError('Pattern state limit');
  states.push(state);
  return states.length - 1;
}
function compileNode(node: Ast, next: number, states: State[]): number {
  switch (node.kind) {
    case 'atom': return add(states, { kind: 'atom', test: new RegExp(`^(?:${node.source})$`, 'u'), next });
    case 'assert': return add(states, { kind: 'assert', source: node.source, next });
    case 'sequence': return node.nodes.reduceRight((end, child) => compileNode(child, end, states), next);
    case 'choice': return add(states, { kind: 'split', next: node.nodes.map((child) => compileNode(child, next, states)) });
    case 'repeat': return compileRepeat(node, next, states);
  }
}
function compileRepeat(node: Ast & { kind: 'repeat' }, end: number, states: State[]): number {
  let next = end;
  if (node.max === Infinity) {
    const loop = add(states, { kind: 'split', next: [] });
    const child = compileNode(node.node, loop, states);
    states[loop] = { kind: 'split', next: [child, end] };
    next = loop;
  } else {
    for (let count = node.min; count < node.max; count++) {
      next = add(states, { kind: 'split', next: [compileNode(node.node, next, states), end] });
    }
  }
  for (let count = 0; count < node.min; count++) next = compileNode(node.node, next, states);
  return next;
}
function word(char: string | undefined): boolean { return char !== undefined && /^[a-zA-Z0-9_]$/.test(char); }
function assertion(source: string, chars: string[], at: number): boolean {
  if (source === '^') return at === 0;
  if (source === '$') return at === chars.length;
  const boundary = word(chars[at - 1]) !== word(chars[at]);
  return source === '\\b' ? boundary : !boundary;
}
interface Machine { readonly states: State[]; readonly start: number }
const CACHE = new Map<string, Machine>();
function machine(pattern: string): Machine {
  const cached = CACHE.get(pattern);
  if (cached) return cached;
  if (pattern.length > 4096) throw new TypeError('Pattern length limit');
  const parser = { chars: [...pattern], at: 0, depth: 0 };
  const ast = expression(parser);
  if (parser.at !== parser.chars.length) throw new TypeError('Unexpected pattern token');
  const states: State[] = [{ kind: 'accept' }];
  const result = { states, start: compileNode(ast, 0, states) };
  if (CACHE.size >= 128) CACHE.delete(CACHE.keys().next().value ?? '');
  CACHE.set(pattern, result);
  return result;
}
export function assertPortablePattern(pattern: string): void { machine(pattern); }
export function matchesPattern(pattern: string, value: string): boolean {
  const { states, start } = machine(pattern);
  const chars = [...value];
  let active = new Set<number>();
  let budget = 5_000_000;
  for (let at = 0; at <= chars.length; at++) {
    active.add(start);
    const pending = [...active];
    const visited = new Set<number>();
    const next = new Set<number>();
    while (pending.length) {
      if (--budget < 0) throw new RangeError('Pattern work limit');
      const index = pending.pop();
      if (index === undefined) continue;
      if (visited.has(index)) continue;
      visited.add(index);
      const state = states[index];
      if (state === undefined) throw new TypeError('Invalid pattern state');
      if (state.kind === 'accept') return true;
      if (state.kind === 'split') pending.push(...state.next);
      else if (state.kind === 'assert' && assertion(state.source, chars, at)) pending.push(state.next);
      else if (state.kind === 'atom' && at < chars.length && state.test.test((chars[at] ?? ''))) next.add(state.next);
    }
    active = next;
  }
  return false;
}


interface Witness {
  readonly index: number;
  readonly value: string;
  readonly length: number;
  readonly boundary: boolean | undefined;
  readonly ended: boolean;
}
interface WitnessLimits { readonly minLength?: number; readonly maxLength?: number; readonly accept?: (value: string) => boolean }
function atomWitnesses(test: RegExp): readonly string[] {
  const alphabet = new Set([...Array.from({ length: 128 }, (_, code) => String.fromCharCode(code)),
    ...[...test.source].slice(0, 256), 'Ā', '一', '😀', String.fromCodePoint(0x10ffff)]);
  for (const match of test.source.matchAll(/\\(?:u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/g)) {
    alphabet.add(String.fromCodePoint(Number.parseInt(match[1] ?? match[2] ?? '0', 16)));
  }
  const candidates = [...alphabet].filter((char) => test.test(char));
  return [candidates.find(word), candidates.find((char) => !word(char))].filter((char): char is string => char !== undefined);
}
function witnessAssertion(state: State & { kind: 'assert' }, current: Witness): Witness | null {
  if (state.source === '^') return current.length === 0 ? { ...current, index: state.next } : null;
  if (state.source === '$') return { ...current, index: state.next, ended: true };
  const requiredWord = state.source === '\\b' ? !word(current.value.at(-1)) : word(current.value.at(-1));
  if (current.boundary !== undefined && current.boundary !== requiredWord) return null;
  return { ...current, index: state.next, boundary: requiredWord };
}
function witnessSteps(state: State, current: Witness, atoms: ReadonlyMap<number, readonly string[]>): readonly Witness[] {
  if (state.kind === 'split') return state.next.map((index) => ({ ...current, index }));
  if (state.kind === 'assert') {
    const next = witnessAssertion(state, current);
    return next === null ? [] : [next];
  }
  if (state.kind !== 'atom' || current.ended) return [];
  return (atoms.get(current.index) ?? []).filter((char) => current.boundary === undefined || word(char) === current.boundary)
    .map((char) => ({ index: state.next, value: current.value + char, length: current.length + 1, boundary: undefined, ended: false }));
}
function acceptedWitness(pattern: string, current: Witness, limits: WitnessLimits, budget: { remaining: number }): string | null {
  if (current.boundary === true) return null;
  const missing = Math.max(0, (limits.minLength ?? 0) - current.length);
  const candidates = missing === 0 ? [current.value] : ['a', ' '].flatMap((char) =>
    [current.value + char.repeat(missing), char.repeat(missing) + current.value]);
  return candidates.find((candidate) => --budget.remaining >= 0 && matchesPattern(pattern, candidate) && (limits.accept?.(candidate) ?? true)) ?? null;
}
/** Generation-only bounded witness search over the SAME admitted NFA, never a second regex parser.
 * Null means no witness found within the alphabet/work limits, not an unsatisfiable-pattern claim. */
export function patternExample(pattern: string, limits: WitnessLimits = {}): string | null {
  const max = Math.min(4096, limits.maxLength ?? 4096);
  if ((limits.minLength ?? 0) > max) return null;
  const { states, start } = machine(pattern);
  const atoms = new Map(states.flatMap((state, index) => state.kind === 'atom' ? [[index, atomWitnesses(state.test)] as const] : []));
  const queue: Witness[] = [{ index: start, value: '', length: 0, boundary: undefined, ended: false },
    { index: start, value: 'a', length: 1, boundary: undefined, ended: false },
    { index: start, value: ' ', length: 1, boundary: undefined, ended: false }];
  const seen = new Set<string>();
  let stored = 0;
  const checks = { remaining: 32 };
  for (let cursor = 0; cursor < queue.length && cursor < 20_000; cursor++) {
    const current = queue[cursor];
    if (current === undefined || current.length > max) continue;
    const key = `${current.index}:${current.length}:${word(current.value.at(-1))}:${String(current.boundary)}:${current.ended}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const state = states[current.index];
    if (state === undefined) return null;
    if (state.kind === 'accept') {
      const value = acceptedWitness(pattern, current, limits, checks);
      if (value !== null) return value;
      if (checks.remaining <= 0) return null;
    }
    const next = witnessSteps(state, current, atoms);
    stored += next.reduce((sum, item) => sum + item.length, 0);
    if (stored > 1_000_000) return null;
    queue.push(...next);
  }
  return null;
}
