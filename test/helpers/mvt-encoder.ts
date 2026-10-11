/**
 * Minimal MVT writer for tests.
 *
 * This is a separate implementation from the demo's Python generator on
 * purpose: the decoder is exercised against two independently written encoders.
 * Coordinates are tile-local; geometry helpers emit correct command structure
 * (MoveTo/LineTo/ClosePath) with delta+zigzag parameters.
 */

export type TestValueSpec =
  | { readonly t: 'string'; readonly v: string }
  | { readonly t: 'int'; readonly v: bigint }
  | { readonly t: 'uint'; readonly v: bigint }
  | { readonly t: 'sint'; readonly v: bigint }
  | { readonly t: 'double'; readonly v: number }
  | { readonly t: 'float'; readonly v: number }
  | { readonly t: 'bool'; readonly v: boolean };

export interface TestFeatureSpec {
  readonly id?: bigint | number;
  readonly type: 1 | 2 | 3;
  /** Raw command integers (use the geom* helpers to build them). */
  readonly geometry: readonly number[];
  readonly tags?: readonly (readonly [number, number])[];
}

export interface TestLayerSpec {
  readonly name: string;
  readonly extent?: number;
  readonly keys?: readonly string[];
  readonly values?: readonly TestValueSpec[];
  readonly features: readonly TestFeatureSpec[];
}

const encoder = new TextEncoder();

export function zig(value: number): number {
  return value >= 0 ? value * 2 : -value * 2 - 1;
}

export function cmd(id: number, count: number): number {
  return (count << 3) | id;
}

function varint(value: bigint | number): number[] {
  let v = BigInt(value);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    out.push(byte);
  } while (v > 0n);
  return out;
}

function tag(field: number, wire: number): number[] {
  return varint((field << 3) | wire);
}

function lenField(field: number, payload: readonly number[]): number[] {
  return [...tag(field, 2), ...varint(payload.length), ...payload];
}

function encodeValue(value: TestValueSpec): number[] {
  switch (value.t) {
    case 'string':
      return lenField(1, Array.from(encoder.encode(value.v)));
    case 'float': {
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setFloat32(0, value.v, true);
      return [...tag(2, 5), ...bytes];
    }
    case 'double': {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, value.v, true);
      return [...tag(3, 1), ...bytes];
    }
    case 'int':
      return [...tag(4, 0), ...varint(value.v)];
    case 'uint':
      return [...tag(5, 0), ...varint(value.v)];
    case 'sint': {
      const raw = value.v >= 0n ? value.v * 2n : -value.v * 2n - 1n;
      return [...tag(6, 0), ...varint(raw)];
    }
    case 'bool':
      return [...tag(7, 0), ...varint(value.v ? 1 : 0)];
  }
}

function encodeFeature(feature: TestFeatureSpec): number[] {
  const parts: number[] = [];
  if (feature.id !== undefined) parts.push(...tag(1, 0), ...varint(feature.id));
  if (feature.tags && feature.tags.length > 0) {
    const packed: number[] = [];
    for (const [key, value] of feature.tags) {
      packed.push(...varint(key), ...varint(value));
    }
    parts.push(...lenField(2, packed));
  }
  parts.push(...tag(3, 0), ...varint(feature.type));
  const geometry: number[] = [];
  for (const command of feature.geometry) geometry.push(...varint(command >>> 0));
  parts.push(...lenField(4, geometry));
  return parts;
}

export function encodeLayer(layer: TestLayerSpec): number[] {
  const parts: number[] = [];
  parts.push(...lenField(1, Array.from(encoder.encode(layer.name))));
  for (const feature of layer.features) parts.push(...lenField(2, encodeFeature(feature)));
  for (const key of layer.keys ?? []) parts.push(...lenField(3, Array.from(encoder.encode(key))));
  for (const value of layer.values ?? []) parts.push(...lenField(4, encodeValue(value)));
  parts.push(...tag(5, 0), ...varint(layer.extent ?? 4096));
  return parts;
}

export function encodeTile(layers: readonly (readonly number[])[]): Uint8Array {
  const parts: number[] = [];
  for (const layer of layers) parts.push(...lenField(3, layer));
  return Uint8Array.from(parts);
}

/* ------------------------------ geometry --------------------------------- */

export function geomPoint(points: readonly (readonly [number, number])[]): number[] {
  const out: number[] = [];
  let x = 0;
  let y = 0;
  for (const [px, py] of points) {
    out.push(cmd(1, 1), zig(px - x), zig(py - y));
    x = px;
    y = py;
  }
  return out;
}

export function geomLine(parts: readonly (readonly (readonly [number, number])[])[]): number[] {
  const out: number[] = [];
  let x = 0;
  let y = 0;
  for (const part of parts) {
    const first = part[0]!;
    out.push(cmd(1, 1), zig(first[0] - x), zig(first[1] - y));
    x = first[0];
    y = first[1];
    const rest = part.slice(1);
    if (rest.length > 0) {
      out.push(cmd(2, rest.length));
      for (const [px, py] of rest) {
        out.push(zig(px - x), zig(py - y));
        x = px;
        y = py;
      }
    }
  }
  return out;
}

/** Rings are open (the decoder closes them); winding decides outer vs hole. */
export function geomPolygon(rings: readonly (readonly (readonly [number, number])[])[]): number[] {
  const out: number[] = [];
  let x = 0;
  let y = 0;
  for (const ring of rings) {
    const first = ring[0]!;
    out.push(cmd(1, 1), zig(first[0] - x), zig(first[1] - y));
    x = first[0];
    y = first[1];
    const rest = ring.slice(1);
    out.push(cmd(2, rest.length));
    for (const [px, py] of rest) {
      out.push(zig(px - x), zig(py - y));
      x = px;
      y = py;
    }
    out.push(cmd(3, 1));
  }
  return out;
}
