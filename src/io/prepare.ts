/**
 * Shared import preparation.
 *
 * The same function runs inside the import worker and in the inline fallback,
 * so both paths validate and convert identically: the worker is an execution
 * layer, not a second semantics. It returns feature inputs for the source
 * transaction; the transaction itself always runs on the main thread against
 * the authoritative store (IO-09..IO-11).
 */

import { parseGeoJson, parsedToFeatureInput } from '../formats/geojson.ts';
import type { FeatureInput } from '../scene/source.ts';
import { columnarToFeatures, type ColumnarBatch, type ColumnarPositionKind } from './columnar.ts';

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

/** Validates and converts an import request into feature inputs. */
export function prepareImport(request: ImportJobRequest): FeatureInput[] {
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
