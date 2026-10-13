/**
 * Columnar vector import (IO-05..IO-07).
 *
 * A batch owns flat typed arrays instead of per-feature objects:
 *
 * - `positions` is a flat `x, y` stream. `x` is the longitude for a geographic
 *   CRS and the `x` axis for a planar CRS; `y` is the latitude or the `y` axis.
 * - `kind: 'point'`: every vertex is one feature.
 * - `kind: 'lineString' | 'polygon'`: `partOffsets` slices vertices into parts
 *   (a line string, or a polygon ring). When `featurePartOffsets` is absent
 *   every part is one feature; otherwise it slices parts into features — a
 *   multi line string, or a polygon whose first part is the exterior ring and
 *   the remaining parts are holes.
 * - `altitudes` (geographic CRS only) carries one altitude per vertex; `NaN`
 *   means "this vertex has no altitude".
 * - `ids`/`properties` are indexed per feature; an `undefined` entry keeps the
 *   source's generated-id policy and empty properties.
 *
 * The structure is validated before any vertex is read: array types, lengths,
 * offset monotonicity and bounds. A malformed batch can therefore never read
 * past the end of a buffer and is rejected as `import-invalid` before anything
 * is published (IO-05). The input arrays are read, never retained; the store
 * owns its prepared world-coordinate copy (IO-06).
 */

import { fail } from '../api/errors.ts';
import type { FeatureId, FeatureProperties, Geometry, Position } from '../api/types.ts';
import type { FeatureInput } from '../scene/source.ts';

export type ColumnarPositionArray = Float32Array | Float64Array;
export type ColumnarIndexArray = Int32Array | Uint32Array;
export type ColumnarPositionKind = 'geographic' | 'planar';
export type ColumnarKind = 'point' | 'lineString' | 'polygon';

export interface ColumnarPointBatch {
  readonly kind: 'point';
  readonly positions: ColumnarPositionArray;
  readonly altitudes?: ColumnarPositionArray;
  readonly ids?: readonly (FeatureId | undefined)[];
  readonly properties?: readonly (FeatureProperties | undefined)[];
}

export interface ColumnarPartsBatch {
  readonly kind: 'lineString' | 'polygon';
  readonly positions: ColumnarPositionArray;
  /** `partCount + 1` vertex start indices; strictly increasing, `0` to `vertexCount`. */
  readonly partOffsets: ColumnarIndexArray;
  /** `featureCount + 1` part start indices; absent means one part per feature. */
  readonly featurePartOffsets?: ColumnarIndexArray;
  readonly altitudes?: ColumnarPositionArray;
  readonly ids?: readonly (FeatureId | undefined)[];
  readonly properties?: readonly (FeatureProperties | undefined)[];
}

export type ColumnarBatch = ColumnarPointBatch | ColumnarPartsBatch;

export interface ColumnarToFeaturesOptions {
  readonly positionKind: ColumnarPositionKind;
  /** Error context, e.g. `columnar(source-id)`. */
  readonly context?: string;
}

/**
 * Columnar batches may be planar, so features are built with the full position
 * union; the public return type follows the library's default geographic typing
 * (`VectorSourceHandle<Geometry<PlanarPosition>>` is the planar opt-in) and the
 * CRS validates the actual position shape at ingest.
 */
type ColumnarFeatureInput = FeatureInput<Geometry<Position>, FeatureProperties>;

function invalid(message: string, detail?: Record<string, unknown>): never {
  fail('import-invalid', message, detail ?? {});
}

function readPositions(value: unknown, context: string): ColumnarPositionArray {
  if (!(value instanceof Float32Array) && !(value instanceof Float64Array)) {
    invalid(`${context}.positions must be a Float32Array or Float64Array`, { positions: value });
  }
  if (value.length % 2 !== 0) {
    invalid(`${context}.positions must contain whole x, y pairs`, { length: value.length });
  }
  return value;
}

function readAltitudes(
  value: unknown,
  vertexCount: number,
  positionKind: ColumnarPositionKind,
  context: string,
): ColumnarPositionArray | null {
  if (value === undefined) return null;
  if (!(value instanceof Float32Array) && !(value instanceof Float64Array)) {
    invalid(`${context}.altitudes must be a Float32Array or Float64Array`, { altitudes: value });
  }
  if (positionKind !== 'geographic') {
    invalid(`${context}.altitudes require a geographic CRS`, { positionKind });
  }
  if (value.length !== vertexCount) {
    invalid(`${context}.altitudes must hold one value per vertex`, {
      length: value.length,
      vertexCount,
    });
  }
  return value;
}

function readIndexArray(value: unknown, last: number, context: string): ColumnarIndexArray {
  if (!(value instanceof Int32Array) && !(value instanceof Uint32Array)) {
    invalid(`${context} must be an Int32Array or Uint32Array`, { offsets: value });
  }
  if (value.length < 2) {
    invalid(`${context} must hold at least one range`, { length: value.length });
  }
  if (value[0] !== 0 || value[value.length - 1] !== last) {
    invalid(`${context} must start at 0 and end at ${last}`, {
      first: value[0],
      last: value[value.length - 1],
    });
  }
  for (let i = 1; i < value.length; i++) {
    if (value[i - 1]! >= value[i]!) {
      invalid(`${context} must be strictly increasing`, { index: i, previous: value[i - 1], value: value[i] });
    }
  }
  return value;
}

function readIds(
  value: unknown,
  featureCount: number,
  context: string,
): readonly (FeatureId | undefined)[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length !== featureCount) {
    invalid(`${context}.ids must hold one entry per feature`, {
      length: Array.isArray(value) ? value.length : null,
      featureCount,
    });
  }
  for (let i = 0; i < value.length; i++) {
    const id = value[i];
    if (id === undefined) continue;
    if (typeof id === 'string') continue;
    if (typeof id === 'number' && Number.isSafeInteger(id)) continue;
    invalid(`${context}.ids[${i}] must be a string, a safe integer or undefined`, { id });
  }
  return value as readonly (FeatureId | undefined)[];
}

function readProperties(
  value: unknown,
  featureCount: number,
  context: string,
): readonly (FeatureProperties | undefined)[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length !== featureCount) {
    invalid(`${context}.properties must hold one entry per feature`, {
      length: Array.isArray(value) ? value.length : null,
      featureCount,
    });
  }
  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    if (entry === undefined) continue;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      invalid(`${context}.properties[${i}] must be an object or undefined`, { properties: entry });
    }
  }
  return value as readonly (FeatureProperties | undefined)[];
}

/** Metadata is validated/owned on the publishing thread, not round-tripped. */
export function validateColumnarMetadata(batch: ColumnarBatch, count: number, context = 'columnar'): void {
  readIds(batch.ids, count, context);
  readProperties(batch.properties, count, context);
}

/** Validate a point batch without expanding it into hundreds of thousands of objects. */
export function validatePointBatch(batch: ColumnarPointBatch, options: ColumnarToFeaturesOptions): ColumnarPointBatch {
  const context = options.context ?? 'columnar';
  if (typeof batch !== 'object' || batch === null || batch.kind !== 'point') invalid(`${context}: expected a point batch`);
  if ('partOffsets' in batch || 'featurePartOffsets' in batch) invalid(`${context}: a point batch has no part offsets`);
  const positions = readPositions(batch.positions, context);
  const count = positions.length / 2;
  readAltitudes(batch.altitudes, count, options.positionKind, context);
  readIds(batch.ids, count, context);
  readProperties(batch.properties, count, context);
  for (let i = 0; i < count; i++) {
    if (!Number.isFinite(positions[i * 2]) || !Number.isFinite(positions[i * 2 + 1])) {
      invalid(`${context}.positions[${i}] must be finite numbers`);
    }
  }
  return batch;
}

/** Validate flat structure before projection; never materialize Position objects. */
export function validatePartsBatch(batch: ColumnarPartsBatch, options: ColumnarToFeaturesOptions): number {
  const context = options.context ?? 'columnar';
  if (typeof batch !== 'object' || batch === null || (batch.kind !== 'lineString' && batch.kind !== 'polygon')) invalid(`${context}: expected a parts batch`);
  const positions = readPositions(batch.positions, context), vertices = positions.length / 2;
  readAltitudes(batch.altitudes, vertices, options.positionKind, context);
  const parts = readIndexArray(batch.partOffsets, vertices, `${context}.partOffsets`).length - 1;
  const count = batch.featurePartOffsets === undefined ? parts : readIndexArray(batch.featurePartOffsets, parts, `${context}.featurePartOffsets`).length - 1;
  validateColumnarMetadata(batch, count, context);
  for (let at = 0; at < positions.length; at++) if (!Number.isFinite(positions[at])) invalid(`${context}.positions[${Math.floor(at / 2)}] must be finite numbers`);
  return count;
}

/** Converts a validated columnar batch into feature inputs (IO-05, IO-06). */
export function columnarToFeatures(
  batch: ColumnarBatch,
  options: ColumnarToFeaturesOptions,
): FeatureInput[] {
  if (typeof batch !== 'object' || batch === null) {
    invalid('columnar batch must be an object', { batch });
  }
  const context = options.context ?? 'columnar';
  const kind = (batch as { kind?: unknown }).kind;
  if (kind !== 'point' && kind !== 'lineString' && kind !== 'polygon') {
    invalid(`${context}: unsupported columnar kind ${String(kind)}`, { kind });
  }
  const positions = readPositions((batch as { positions?: unknown }).positions, context);
  const vertexCount = positions.length / 2;
  const altitudes = readAltitudes(
    (batch as { altitudes?: unknown }).altitudes,
    vertexCount,
    options.positionKind,
    context,
  );
  const read = (vertex: number): Position => {
    const x = positions[vertex * 2]!;
    const y = positions[vertex * 2 + 1]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      invalid(`${context}.positions[${vertex}] must be finite numbers`, { x, y });
    }
    if (options.positionKind === 'planar') return { x, y };
    const altitude = altitudes ? altitudes[vertex]! : Number.NaN;
    return Number.isNaN(altitude) ? { lng: x, lat: y } : { lng: x, lat: y, altitude };
  };
  const readRange = (start: number, end: number): Position[] => {
    const out: Position[] = new Array(end - start);
    for (let vertex = start; vertex < end; vertex++) out[vertex - start] = read(vertex);
    return out;
  };
  const withMetadata = (
    base: Omit<ColumnarFeatureInput, 'id' | 'properties'>,
    id: FeatureId | undefined,
    properties: FeatureProperties | undefined,
  ): ColumnarFeatureInput => ({
    ...(id === undefined ? {} : { id }),
    ...base,
    ...(properties === undefined ? {} : { properties }),
  });

  if (kind === 'point') {
    const pointBatch = batch as ColumnarPointBatch;
    if ('partOffsets' in pointBatch || 'featurePartOffsets' in pointBatch) {
      invalid(`${context}: a point batch has no part offsets`, {});
    }
    const ids = readIds(pointBatch.ids, vertexCount, context);
    const properties = readProperties(pointBatch.properties, vertexCount, context);
    const features: ColumnarFeatureInput[] = new Array(vertexCount);
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      features[vertex] = withMetadata(
        { geometry: { type: 'point', position: read(vertex) } },
        ids?.[vertex],
        properties?.[vertex],
      );
    }
    return features as unknown as FeatureInput[];
  }

  const partsBatch = batch as ColumnarPartsBatch;
  const partOffsets = readIndexArray(partsBatch.partOffsets, vertexCount, `${context}.partOffsets`);
  const partCount = partOffsets.length - 1;
  const featurePartOffsets =
    partsBatch.featurePartOffsets === undefined
      ? null
      : readIndexArray(partsBatch.featurePartOffsets, partCount, `${context}.featurePartOffsets`);
  const featureCount = featurePartOffsets ? featurePartOffsets.length - 1 : partCount;
  const ids = readIds(partsBatch.ids, featureCount, context);
  const properties = readProperties(partsBatch.properties, featureCount, context);
  const features: ColumnarFeatureInput[] = new Array(featureCount);
  for (let feature = 0; feature < featureCount; feature++) {
    const firstPart = featurePartOffsets ? featurePartOffsets[feature]! : feature;
    const lastPart = featurePartOffsets ? featurePartOffsets[feature + 1]! : feature + 1;
    const parts: Position[][] = [];
    for (let part = firstPart; part < lastPart; part++) {
      parts.push(readRange(partOffsets[part]!, partOffsets[part + 1]!));
    }
    const geometry: Geometry<Position> =
      kind === 'lineString'
        ? parts.length === 1
          ? { type: 'lineString', positions: parts[0]! }
          : { type: 'multiLineString', lines: parts }
        : { type: 'polygon', rings: parts };
    features[feature] = withMetadata({ geometry }, ids?.[feature], properties?.[feature]);
  }
  return features as unknown as FeatureInput[];
}
