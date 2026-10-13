/**
 * Shared import preparation.
 *
 * The same function runs inside the import worker and in the inline fallback,
 * so both paths validate and convert identically: the worker is an execution
 * layer, not a second semantics. It returns owned columns/canonical pools (or
 * GeoJSON feature inputs) for the source
 * transaction; the transaction itself always runs on the main thread against
 * the authoritative store (IO-09..IO-11).
 */

import { parseGeoJson, parsedToFeatureInput } from '../formats/geojson.ts';
import type { FeatureInput } from '../scene/source.ts';
import { columnarToFeatures, validatePointBatch, validatePartsBatch, type ColumnarBatch, type ColumnarPointBatch, type ColumnarPartsBatch, type ColumnarPositionKind } from './columnar.ts';
import { crs } from '../math/crs.ts';
import { prepareParts, type PreparedPartsImport } from './parts.ts';

export type ImportJobRequest =
  | {
      readonly kind: 'columnar';
      readonly sourceId: string;
      readonly batch: ColumnarBatch;
      readonly positionKind: ColumnarPositionKind;
    }
  | {
      readonly kind: 'geojson';
      readonly sourceId: string;
      readonly input: string | object;
    };

export interface PointImportJobRequest {
  readonly kind: 'columnar-points';
  readonly sourceId: string;
  readonly batch: ColumnarPointBatch;
  readonly positionKind: ColumnarPositionKind;
}
export interface PartsImportJobRequest {
  readonly kind: 'columnar-parts';
  readonly sourceId: string;
  readonly batch: ColumnarPartsBatch;
  readonly positionKind: ColumnarPositionKind;
  /** Only an unmodified built-in projection is serializable. */
  readonly projectionCode?: string;
}
export interface RawPartsImport { readonly kind: 'raw-parts'; readonly batch: ColumnarPartsBatch }
export type PartsImport = PreparedPartsImport | RawPartsImport;
export type WorkerImportRequest = ImportJobRequest | PointImportJobRequest | PartsImportJobRequest;
export type PreparedImport = FeatureInput[] | ColumnarPointBatch | PartsImport;

/** Validate input and prepare the representation used by its publication path. */
export function prepareImport(request: ImportJobRequest): FeatureInput[];
export function prepareImport(request: PointImportJobRequest): ColumnarPointBatch;
export function prepareImport(request: PartsImportJobRequest): PartsImport;
export function prepareImport(request: WorkerImportRequest): PreparedImport;
export function prepareImport(request: WorkerImportRequest): PreparedImport {
  if (request.kind === 'columnar-parts') {
    validatePartsBatch(request.batch, { positionKind: request.positionKind, context: `columnar(${request.sourceId})` });
    if (request.projectionCode === undefined) return { kind: 'raw-parts', batch: request.batch };
    const projection = crs.get(request.projectionCode);
    if (!projection || projection.positionKind !== request.positionKind) throw new Error('invalid import projection');
    return prepareParts(request.batch, projection, `columnar(${request.sourceId})`);
  }
  if (request.kind === 'columnar-points') {
    return validatePointBatch(request.batch, { positionKind: request.positionKind, context: `columnar(${request.sourceId})` });
  }
  if (request.kind === 'geojson') {
    return parseGeoJson(request.input as never, { sourceId: request.sourceId }).map(
      parsedToFeatureInput,
    );
  }
  return columnarToFeatures(request.batch, {
    positionKind: request.positionKind,
    context: `columnar(${request.sourceId})`,
  });
}
