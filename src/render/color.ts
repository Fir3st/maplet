/**
 * Color parsing and packing for the render styles.
 * Accepts `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()`, `rgba()` and a small
 * named palette; returns linear 0..1 RGBA ready for instance attributes.
 */

import { fail } from '../api/errors.ts';
import type { ColorValue } from '../scene/expression.ts';

const NAMED: Record<string, [number, number, number, number]> = {
  black: [0, 0, 0, 1],
  white: [1, 1, 1, 1],
  red: [1, 0, 0, 1],
  green: [0, 128 / 255, 0, 1],
  blue: [0, 0, 1, 1],
  gray: [128 / 255, 128 / 255, 128 / 255, 1],
  grey: [128 / 255, 128 / 255, 128 / 255, 1],
  transparent: [0, 0, 0, 0],
};

export type Rgba = readonly [number, number, number, number];

export function parseColor(value: ColorValue | undefined, fallback: Rgba): Rgba {
  if (value === undefined) return fallback;
  if (Array.isArray(value)) {
    const [r = 0, g = 0, b = 0, a = 1] = value as readonly number[];
    return [clamp01(r), clamp01(g), clamp01(b), clamp01(a)];
  }
  if (typeof value !== 'string') {
    fail('invalid-argument', 'color must be a string or an [r,g,b(,a)] array', { value });
  }
  const text = value.trim().toLowerCase();
  const named = NAMED[text];
  if (named) return named;
  if (text.startsWith('#')) {
    const hex = text.slice(1);
    const expand = (c: string): number => parseInt(c + c, 16) / 255;
    if (hex.length === 3 || hex.length === 4) {
      return [
        expand(hex[0]!),
        expand(hex[1]!),
        expand(hex[2]!),
        hex.length === 4 ? expand(hex[3]!) : 1,
      ];
    }
    if (hex.length === 6 || hex.length === 8) {
      const byte = (i: number): number => parseInt(hex.slice(i * 2, i * 2 + 2), 16) / 255;
      return [byte(0), byte(1), byte(2), hex.length === 8 ? byte(3) : 1];
    }
    fail('invalid-argument', `unsupported hex color: ${value}`, { value });
  }
  const rgb = /^rgba?\(([^)]+)\)$/.exec(text);
  if (rgb) {
    const parts = rgb[1]!.split(',').map((part) => Number(part.trim()));
    if (parts.length >= 3 && parts.every((part) => Number.isFinite(part))) {
      return [
        clamp01(parts[0]! / 255),
        clamp01(parts[1]! / 255),
        clamp01(parts[2]! / 255),
        parts[3] === undefined ? 1 : clamp01(parts[3]),
      ];
    }
  }
  fail('invalid-argument', `unsupported color: ${value}`, { value });
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
