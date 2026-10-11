/**
 * Mapbox Vector Tile decoding (MVT 2.x), dependency-free.
 *
 * The decoder works in tile-local coordinates: geometry is returned in extent
 * units with the tile's y-down axis, so the tile-source layer can map it to
 * world coordinates without re-reading the bytes. Feature ids stay exact:
 * a uint64 beyond `Number.MAX_SAFE_INTEGER` is a decimal string, never a
 * rounded number (MVT-03). Malformed tiles, truncated messages and absurd
 * vertex offsets are rejected as `import-invalid` or per-feature, so the scene
 * never receives half-decoded geometry (MVT-08).
 */

import { fail } from '../api/errors.ts';
import type { FeatureId } from '../api/types.ts';

export interface MvtPointGeometry {
  readonly kind: 'point';
  /** Interleaved x, y in extent units. */
  readonly points: Float64Array;
}

export interface MvtLineGeometry {
  readonly kind: 'line';
  /** Interleaved x, y in extent units. */
  readonly vertices: Float64Array;
  /** Pairs of [start, count] into vertices for each part. */
  readonly parts: Uint32Array;
}

export interface MvtPolygonGeometry {
  readonly kind: 'polygon';
  /** Interleaved x, y in extent units for every ring, concatenated and closed. */
  readonly ringVertices: Float64Array;
  /** Pairs of [start, count] into ringVertices for each ring. */
  readonly rings: Uint32Array;
  /** 1 for a ring with positive area (exterior), 0 for a hole. */
  readonly ringOuter: Uint8Array;
}

export type MvtGeometry = MvtPointGeometry | MvtLineGeometry | MvtPolygonGeometry;

export interface MvtFeature {
  /** Exact provider id; decimal string when it exceeds the safe number range. */
  readonly id: FeatureId | null;
  readonly geometry: MvtGeometry;
  readonly properties: Readonly<Record<string, unknown>>;
  /** Position within the source layer; the tile-local identity falls back to it. */
  readonly index: number;
}

export interface MvtLayer {
  /** Source-layer name; it becomes the feature namespace (MVT-02). */
  readonly name: string;
  readonly extent: number;
  readonly features: readonly MvtFeature[];
}

export interface MvtTile {
  readonly layers: readonly MvtLayer[];
}

export interface MvtDecodeResult {
  readonly tile: MvtTile;
  /** Features dropped because their geometry was inconsistent (MVT-08). */
  readonly rejectedFeatures: number;
}

export interface MvtDecodeOptions {
  /** Coordinates beyond this bound reject the feature; defaults to 1e7 extent units. */
  readonly maxCoord?: number;
}

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;

const GEOMETRY_TYPE = { point: 1, line: 2, polygon: 3 } as const;

class Reader {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  pos = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get eof(): boolean {
    return this.pos >= this.bytes.length;
  }

  varint(): bigint {
    let shift = 0n;
    let result = 0n;
    for (let count = 0; ; count++) {
      if (this.pos >= this.bytes.length) fail('import-invalid', 'MVT: truncated varint', {});
      if (count >= 10) fail('import-invalid', 'MVT: varint is too long', {});
      const byte = this.bytes[this.pos++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
    }
  }

  varintNumber(max = Number.MAX_SAFE_INTEGER): number {
    const value = this.varint();
    if (value > BigInt(max)) {
      fail('import-invalid', 'MVT: varint exceeds the supported range', { value: String(value) });
    }
    return Number(value);
  }

  tag(): { field: number; wire: number } {
    const raw = this.varintNumber(0xffff_ffff);
    return { field: raw >>> 3, wire: raw & 7 };
  }

  lengthDelimited(): Reader {
    const length = this.varintNumber(this.bytes.length);
    if (this.pos + length > this.bytes.length) {
      fail('import-invalid', 'MVT: truncated length-delimited field', { length });
    }
    const slice = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return new Reader(slice);
  }

  fixed32(): number {
    if (this.pos + 4 > this.bytes.length) fail('import-invalid', 'MVT: truncated fixed32', {});
    const value = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return value;
  }

  fixed64(): number {
    if (this.pos + 8 > this.bytes.length) fail('import-invalid', 'MVT: truncated fixed64', {});
    const value = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return value;
  }

  skip(wire: number): void {
    switch (wire) {
      case WIRE_VARINT:
        this.varint();
        return;
      case WIRE_FIXED64:
        this.pos += 8;
        break;
      case WIRE_LENGTH: {
        const length = this.varintNumber(this.bytes.length);
        this.pos += length;
        break;
      }
      case WIRE_FIXED32:
        this.pos += 4;
        break;
      default:
        fail('import-invalid', `MVT: unsupported wire type ${wire}`, { wire });
    }
    if (this.pos > this.bytes.length) fail('import-invalid', 'MVT: truncated field', {});
  }
}

function zigzag(value: number): number {
  return (value >>> 1) ^ -(value & 1);
}

function readPackedVarints(reader: Reader, max: number): number[] {
  const out: number[] = [];
  while (!reader.eof) out.push(reader.varintNumber(max));
  return out;
}

/**
 * Decodes one value from the layer value table. int64/uint64/sint64 stay exact:
 * safe values become numbers, larger ones decimal strings (MVT-03).
 */
function decodeValue(reader: Reader): unknown {
  let value: unknown = null;
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    switch (field) {
      case 1:
        value = new TextDecoder().decode(reader.lengthDelimited().bytes);
        break;
      case 2:
        value = reader.fixed32();
        break;
      case 3:
        value = reader.fixed64();
        break;
      case 4: {
        const signed = BigInt.asIntN(64, reader.varint());
        value =
          signed >= BigInt(Number.MIN_SAFE_INTEGER) && signed <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(signed)
            : String(signed);
        break;
      }
      case 5: {
        const raw = reader.varint();
        value = raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : String(raw);
        break;
      }
      case 6: {
        const raw = reader.varint();
        const signed = (raw >> 1n) ^ -(raw & 1n);
        value =
          signed >= BigInt(Number.MIN_SAFE_INTEGER) && signed <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(signed)
            : String(signed);
        break;
      }
      case 7:
        value = reader.varint() !== 0n;
        break;
      default:
        reader.skip(wire);
        continue;
    }
  }
  return value;
}

function ringArea(vertices: Float64Array, start: number, count: number): number {
  let sum = 0;
  for (let i = 0; i < count; i++) {
    const ax = vertices[(start + i) * 2]!;
    const ay = vertices[(start + i) * 2 + 1]!;
    const bx = vertices[(start + ((i + 1) % count)) * 2]!;
    const by = vertices[(start + ((i + 1) % count)) * 2 + 1]!;
    sum += ax * by - bx * ay;
  }
  return sum / 2;
}

function finiteCoord(value: number, maxCoord: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= maxCoord;
}

/** Decodes one feature's geometry commands; returns null for a rejected feature. */
function decodeGeometryCommands(
  type: number,
  params: readonly number[],
  maxCoord: number,
): MvtGeometry | null {
  if (type === GEOMETRY_TYPE.point) {
    const points: number[] = [];
    let x = 0;
    let y = 0;
    let i = 0;
    while (i < params.length) {
      const command = params[i++]!;
      const id = command & 7;
      const count = command >>> 3;
      if (id !== 1 || count === 0) return null;
      for (let k = 0; k < count; k++) {
        if (i + 2 > params.length) return null;
        x += zigzag(params[i++]!);
        y += zigzag(params[i++]!);
        if (!finiteCoord(x, maxCoord) || !finiteCoord(y, maxCoord)) return null;
        points.push(x, y);
      }
    }
    return points.length === 0 ? null : { kind: 'point', points: Float64Array.from(points) };
  }

  if (type === GEOMETRY_TYPE.line) {
    const parts: number[][] = [];
    let current: number[] = [];
    let x = 0;
    let y = 0;
    let i = 0;
    const readPoint = (): number[] | null => {
      if (i + 2 > params.length) return null;
      x += zigzag(params[i++]!);
      y += zigzag(params[i++]!);
      if (!finiteCoord(x, maxCoord) || !finiteCoord(y, maxCoord)) return null;
      return [x, y];
    };
    while (i < params.length) {
      const command = params[i++]!;
      const id = command & 7;
      const count = command >>> 3;
      if (id === 1) {
        // Each MoveTo starts a new part; an incomplete part is dropped.
        if (current.length >= 4) parts.push(current);
        current = [];
        for (let k = 0; k < count; k++) {
          const point = readPoint();
          if (!point) return null;
          current.push(point[0]!, point[1]!);
          if (k < count - 1) {
            if (current.length >= 4) parts.push(current);
            current = [];
          }
        }
      } else if (id === 2) {
        for (let k = 0; k < count; k++) {
          const point = readPoint();
          if (!point) return null;
          current.push(point[0]!, point[1]!);
        }
      } else {
        return null;
      }
    }
    if (current.length >= 4) parts.push(current);
    if (parts.length === 0) return null;
    const vertices: number[] = [];
    const ranges: number[] = [];
    for (const part of parts) {
      ranges.push(vertices.length / 2, part.length / 2);
      vertices.push(...part);
    }
    return {
      kind: 'line',
      vertices: Float64Array.from(vertices),
      parts: Uint32Array.from(ranges),
    };
  }

  if (type === GEOMETRY_TYPE.polygon) {
    const ringVertices: number[] = [];
    const rings: number[] = [];
    let current: number[] = [];
    let x = 0;
    let y = 0;
    let i = 0;
    const readPoint = (): boolean => {
      if (i + 2 > params.length) return false;
      x += zigzag(params[i++]!);
      y += zigzag(params[i++]!);
      if (!finiteCoord(x, maxCoord) || !finiteCoord(y, maxCoord)) return false;
      current.push(x, y);
      return true;
    };
    const flushRing = (): boolean => {
      if (current.length < 6) return false; // fewer than 3 positions
      const firstX = current[0]!;
      const firstY = current[1]!;
      if (current[current.length - 2] !== firstX || current[current.length - 1] !== firstY) {
        current.push(firstX, firstY);
      }
      const count = current.length / 2;
      if (count - 1 < 3) return false;
      rings.push(ringVertices.length / 2, count);
      ringVertices.push(...current);
      current = [];
      return true;
    };
    while (i < params.length) {
      const command = params[i++]!;
      const id = command & 7;
      const count = command >>> 3;
      if (id === 1) {
        if (current.length > 0 && !flushRing()) return null;
        for (let k = 0; k < count; k++) {
          if (!readPoint()) return null;
        }
      } else if (id === 2) {
        for (let k = 0; k < count; k++) {
          if (!readPoint()) return null;
        }
      } else if (id === 3) {
        if (current.length > 0 && !flushRing()) return null;
      } else {
        return null;
      }
    }
    if (current.length > 0 && !flushRing()) return null;
    if (rings.length === 0) return null;
    const vertices = Float64Array.from(ringVertices);
    const ringOuter = new Uint8Array(rings.length / 2);
    let outerCount = 0;
    let bestArea = 0;
    let bestRing = -1;
    for (let r = 0; r < rings.length; r += 2) {
      const area = ringArea(vertices, rings[r]!, rings[r + 1]!);
      if (area > 0) {
        ringOuter[r / 2] = 1;
        outerCount++;
      }
      if (Math.abs(area) > Math.abs(bestArea)) {
        bestArea = area;
        bestRing = r / 2;
      }
    }
    if (outerCount === 0) {
      // Lenient fallback for providers that emit a negative exterior ring.
      if (bestRing < 0) return null;
      ringOuter[bestRing] = 1;
    }
    return {
      kind: 'polygon',
      ringVertices: vertices,
      rings: Uint32Array.from(rings),
      ringOuter,
    };
  }

  return null;
}

function decodeLayer(reader: Reader, maxCoord: number): { layer: MvtLayer; rejected: number } {
  let name = '';
  let extent = 4096;
  const keys: string[] = [];
  const values: unknown[] = [];
  const featureReaders: Reader[] = [];
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    switch (field) {
      case 1:
        name = new TextDecoder().decode(reader.lengthDelimited().bytes);
        break;
      case 2:
        featureReaders.push(reader.lengthDelimited());
        break;
      case 3:
        keys.push(new TextDecoder().decode(reader.lengthDelimited().bytes));
        break;
      case 4:
        values.push(decodeValue(reader.lengthDelimited()));
        break;
      case 5:
        extent = reader.varintNumber(0xffff_ffff);
        break;
      default:
        reader.skip(wire);
        continue;
    }
  }
  if (extent <= 0) extent = 4096;
  let rejected = 0;
  const features: MvtFeature[] = [];
  for (const featureReader of featureReaders) {
    let id: FeatureId | null = null;
    let type = 0;
    let tags: readonly number[] = [];
    let geometry: readonly number[] = [];
    while (!featureReader.eof) {
      const { field, wire } = featureReader.tag();
      switch (field) {
        case 1: {
          const raw = featureReader.varint();
          id = raw <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(raw) : String(raw);
          break;
        }
        case 2:
          tags = readPackedVarints(featureReader.lengthDelimited(), 0xffff_ffff);
          break;
        case 3:
          type = featureReader.varintNumber(255);
          break;
        case 4:
          geometry = readPackedVarints(featureReader.lengthDelimited(), 0xffff_ffff);
          break;
        default:
          featureReader.skip(wire);
          continue;
      }
    }
    const decoded = decodeGeometryCommands(type, geometry, maxCoord);
    if (!decoded) {
      rejected++;
      continue;
    }
    const properties: Record<string, unknown> = {};
    for (let i = 0; i + 1 < tags.length; i += 2) {
      const key = keys[tags[i]!];
      if (key === undefined) continue;
      const value = values[tags[i + 1]!];
      if (value !== undefined) properties[key] = value;
    }
    features.push({ id, geometry: decoded, properties, index: features.length });
  }
  return { layer: { name, extent, features }, rejected };
}

/** Decodes a complete tile; throws `import-invalid` for unusable bytes. */
export function decodeMvtTile(
  data: ArrayBuffer | Uint8Array,
  options: MvtDecodeOptions = {},
): MvtDecodeResult {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const maxCoord = options.maxCoord ?? 1e7;
  const reader = new Reader(bytes);
  const layers: MvtLayer[] = [];
  let rejectedFeatures = 0;
  while (!reader.eof) {
    const { field, wire } = reader.tag();
    if (field === 3 && wire === WIRE_LENGTH) {
      const decoded = decodeLayer(reader.lengthDelimited(), maxCoord);
      rejectedFeatures += decoded.rejected;
      layers.push(decoded.layer);
    } else {
      reader.skip(wire);
    }
  }
  return { tile: { layers }, rejectedFeatures };
}
