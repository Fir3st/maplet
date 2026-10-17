/**
 * Typed style expressions and filters over feature properties, state and zoom.
 *
 * Expressions are declarative values evaluated by the frame planner when a chunk
 * is (re)built — not arbitrary JS callbacks over the whole collection on every
 * frame (STYLE-01..STYLE-10). A feature-level override and the interaction style
 * sit above the layer/property expressions in the documented order.
 */

import { fail } from '../api/errors.ts';
import type { FeatureId } from '../api/types.ts';

export interface ExpressionContext {
  readonly properties: Readonly<Record<string, unknown>>;
  readonly state: {
    readonly hovered: boolean;
    readonly selected: boolean;
    readonly disabled: boolean;
  };
  readonly zoom: number;
}

export interface Expression<T> {
  readonly evaluate: (context: ExpressionContext) => T;
  /** Constant expressions are marked for cheap invalidation decisions. */
  readonly constant: boolean;
}

export type ExpressionInput<T> = T | Expression<T>;
export type ColorValue =
  string | readonly [number, number, number] | readonly [number, number, number, number];

function makeExpression<T>(
  evaluate: (context: ExpressionContext) => T,
  constant = false,
): Expression<T> {
  return { evaluate, constant };
}

const constantCache = new Map<unknown, Expression<unknown>>();

function constant<T>(value: T): Expression<T> {
  let cached = constantCache.get(value);
  if (!cached) {
    cached = makeExpression(() => value, true);
    constantCache.set(value, cached);
  }
  return cached as Expression<T>;
}

function isExpression(value: unknown): value is Expression<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Expression<unknown>).evaluate === 'function' &&
    'constant' in value
  );
}

function toExpression<T>(value: ExpressionInput<T>): Expression<T> {
  return isExpression(value) ? value : constant(value);
}

/** Resolves a dotted property path. Returns undefined for missing parts. */
export function readField(properties: Readonly<Record<string, unknown>>, path: string): unknown {
  if (!path.includes('.')) return properties[path];
  let current: unknown = properties;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export interface TypedField<Name extends string, Value> extends Expression<Value> {
  readonly fieldName: Name;
}

function field<Name extends string, Value>(name: Name): TypedField<Name, Value> {
  const expression = makeExpression((context) => readField(context.properties, name) as Value);
  return { ...expression, fieldName: name };
}

function match<T, const Cases extends Record<string, T>>(
  subject: ExpressionInput<unknown>,
  cases: Cases,
  fallback: T,
): Expression<T> {
  const subjectExpression = toExpression(subject);
  return makeExpression((context) => {
    const value = subjectExpression.evaluate(context);
    if (value === null || value === undefined) return fallback;
    const key = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
    return Object.hasOwn(cases, key) ? (cases[key] as T) : fallback;
  });
}

function compare(
  operator: 'gt' | 'gte' | 'lt' | 'lte',
  left: ExpressionInput<number | string>,
  right: ExpressionInput<number | string>,
): Expression<boolean> {
  const a = toExpression(left);
  const b = toExpression(right);
  return makeExpression((context) => {
    const x = a.evaluate(context);
    const y = b.evaluate(context);
    if (typeof x !== typeof y) return false;
    switch (operator) {
      case 'gt':
        return x > y;
      case 'gte':
        return x >= y;
      case 'lt':
        return x < y;
      case 'lte':
        return x <= y;
    }
  });
}

function eq(left: ExpressionInput<unknown>, right: ExpressionInput<unknown>): Expression<boolean> {
  const a = toExpression(left);
  const b = toExpression(right);
  return makeExpression((context) => Object.is(a.evaluate(context), b.evaluate(context)));
}

function neq(left: ExpressionInput<unknown>, right: ExpressionInput<unknown>): Expression<boolean> {
  const inner = eq(left, right);
  return makeExpression((context) => !inner.evaluate(context));
}

function arithmetic(
  operator: 'add' | 'sub' | 'mul' | 'div',
  left: ExpressionInput<number>,
  right: ExpressionInput<number>,
): Expression<number> {
  const a = toExpression(left);
  const b = toExpression(right);
  return makeExpression((context) => {
    const x = a.evaluate(context);
    const y = b.evaluate(context);
    switch (operator) {
      case 'add':
        return x + y;
      case 'sub':
        return x - y;
      case 'mul':
        return x * y;
      case 'div':
        return x / y;
    }
  });
}

function when<T>(
  condition: ExpressionInput<boolean>,
  thenValue: ExpressionInput<T>,
  elseValue: ExpressionInput<T>,
): Expression<T> {
  const cond = toExpression(condition);
  const thenExpression = toExpression(thenValue);
  const elseExpression = toExpression(elseValue);
  return makeExpression((context) =>
    cond.evaluate(context) ? thenExpression.evaluate(context) : elseExpression.evaluate(context),
  );
}

/** Piecewise-linear interpolation over zoom; exact at the stops. STYLE-02. */
function interpolate(
  zoom: ExpressionInput<number>,
  stops: readonly (readonly [number, number | string])[],
): Expression<number | string> {
  if (stops.length === 0) fail('invalid-argument', 'interpolate needs at least one stop');
  const sorted = [...stops].sort((a, b) => a[0] - b[0]);
  const zoomExpression = toExpression(zoom);
  return makeExpression((context) => {
    const z = zoomExpression.evaluate(context);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    if (z <= first[0]) return first[1];
    if (z >= last[0]) return last[1];
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1]!;
      const current = sorted[i]!;
      if (z <= current[0]) {
        const t = (z - previous[0]) / (current[0] - previous[0]);
        const a = previous[1];
        const b = current[1];
        if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
        return t < 0.5 ? a : b;
      }
    }
    return last[1];
  });
}

/** Declarative filter over properties/state/id. */
export type FilterExpression =
  | { readonly field: string; readonly eq: unknown }
  | { readonly field: string; readonly neq: unknown }
  | { readonly field: string; readonly gt: number }
  | { readonly field: string; readonly gte: number }
  | { readonly field: string; readonly lt: number }
  | { readonly field: string; readonly lte: number }
  | { readonly field: string; readonly in: readonly unknown[] | ReadonlySet<unknown> }
  | { readonly field: string; readonly contains: string }
  | { readonly field: string; readonly exists: boolean }
  | { readonly field: string; readonly test: (value: unknown) => boolean }
  | { readonly id: FeatureId }
  | { readonly not: FilterExpression }
  | { readonly and: readonly FilterExpression[] }
  | { readonly or: readonly FilterExpression[] };

export type Filter =
  FilterExpression | ((properties: Readonly<Record<string, unknown>>, id: FeatureId) => boolean);

export interface FilterRuntime {
  readonly state: {
    readonly hovered: boolean;
    readonly selected: boolean;
    readonly disabled: boolean;
  };
  readonly id: FeatureId;
}

export function compileFilter(
  filter: Filter | null | undefined,
): (runtime: FilterRuntime, properties: Readonly<Record<string, unknown>>) => boolean {
  if (filter === null || filter === undefined) return () => true;
  if (typeof filter === 'function') {
    return (_runtime, properties) => filter(properties, _runtime.id);
  }
  return compileFilterExpression(filter);
}

function compileFilterExpression(
  filter: FilterExpression,
): (runtime: FilterRuntime, properties: Readonly<Record<string, unknown>>) => boolean {
  if ('not' in filter) {
    const inner = compileFilterExpression(filter.not);
    return (runtime, properties) => !inner(runtime, properties);
  }
  if ('and' in filter) {
    const parts = filter.and.map(compileFilterExpression);
    return (runtime, properties) => parts.every((part) => part(runtime, properties));
  }
  if ('or' in filter) {
    const parts = filter.or.map(compileFilterExpression);
    return (runtime, properties) => parts.some((part) => part(runtime, properties));
  }
  if ('id' in filter) {
    const id = filter.id;
    return (runtime) => Object.is(runtime.id, id);
  }
  const fieldName = filter.field;
  if ('eq' in filter) {
    const expected = filter.eq;
    return (_runtime, properties) => Object.is(readField(properties, fieldName), expected);
  }
  if ('neq' in filter) {
    const expected = filter.neq;
    return (_runtime, properties) => !Object.is(readField(properties, fieldName), expected);
  }
  if ('gt' in filter) {
    return (_runtime, properties) => {
      const value = readField(properties, fieldName);
      return typeof value === 'number' && value > filter.gt;
    };
  }
  if ('gte' in filter) {
    return (_runtime, properties) => {
      const value = readField(properties, fieldName);
      return typeof value === 'number' && value >= filter.gte;
    };
  }
  if ('lt' in filter) {
    return (_runtime, properties) => {
      const value = readField(properties, fieldName);
      return typeof value === 'number' && value < filter.lt;
    };
  }
  if ('lte' in filter) {
    return (_runtime, properties) => {
      const value = readField(properties, fieldName);
      return typeof value === 'number' && value <= filter.lte;
    };
  }
  if ('in' in filter) {
    const set = filter.in instanceof Set ? filter.in : new Set(filter.in);
    return (_runtime, properties) => set.has(readField(properties, fieldName));
  }
  if ('contains' in filter) {
    const needle = filter.contains;
    return (_runtime, properties) => {
      const value = readField(properties, fieldName);
      return typeof value === 'string' && value.includes(needle);
    };
  }
  if ('exists' in filter) {
    const want = filter.exists;
    return (_runtime, properties) => (readField(properties, fieldName) !== undefined) === want;
  }
  if ('test' in filter) {
    const test = filter.test;
    return (_runtime, properties) => test(readField(properties, fieldName));
  }
  fail('invalid-argument', 'unsupported filter expression', { filter });
}

export const expr = {
  constant,
  field,
  match,
  /** The current view zoom as an expression. */
  zoom: () => makeExpression((context: ExpressionContext) => context.zoom),
  /** Feature interaction state (hovered/selected/disabled); STYLE-05/06. */
  state: (key: 'hovered' | 'selected' | 'disabled') =>
    makeExpression((context: ExpressionContext) => context.state[key]),
  eq,
  neq,
  gt: (left: ExpressionInput<number | string>, right: ExpressionInput<number | string>) =>
    compare('gt', left, right),
  gte: (left: ExpressionInput<number | string>, right: ExpressionInput<number | string>) =>
    compare('gte', left, right),
  lt: (left: ExpressionInput<number | string>, right: ExpressionInput<number | string>) =>
    compare('lt', left, right),
  lte: (left: ExpressionInput<number | string>, right: ExpressionInput<number | string>) =>
    compare('lte', left, right),
  add: (left: ExpressionInput<number>, right: ExpressionInput<number>) =>
    arithmetic('add', left, right),
  sub: (left: ExpressionInput<number>, right: ExpressionInput<number>) =>
    arithmetic('sub', left, right),
  mul: (left: ExpressionInput<number>, right: ExpressionInput<number>) =>
    arithmetic('mul', left, right),
  div: (left: ExpressionInput<number>, right: ExpressionInput<number>) =>
    arithmetic('div', left, right),
  when,
  interpolate,
} as const;

/** Resolves a possibly-expression style value without re-reading properties. */
export function evaluateStyleValue<T>(
  value: ExpressionInput<T> | undefined,
  fallback: T,
  context: ExpressionContext,
): T {
  if (value === undefined) return fallback;
  if (isExpression(value)) return value.evaluate(context);
  return value;
}

export { isExpression };
