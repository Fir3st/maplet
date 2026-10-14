import { expr, type Expression } from '../scene/expression.ts';

/** Declarative styles: common property mapping without nested expression calls. */
export const style = {
  ...expr,
  by<T>(property: string, values: Readonly<Record<string, T>>, fallback: T): Expression<T> {
    return expr.match(expr.field(property), values, fallback);
  },
};
