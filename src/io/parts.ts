/** Binary geometry compilation: input offsets -> canonical pools, without object expansion. */
import { GEOMETRY_KIND, prepareWorldParts, type PreparedFeatureGeometry } from '../geometry/geometry.ts';
import { projectColumns, type Crs } from '../math/crs.ts';
import { validatePartsBatch, type ColumnarPartsBatch } from './columnar.ts';

export interface PreparedPartsImport {
  readonly kind: 'prepared-parts';
  readonly geometries: readonly PreparedFeatureGeometry[];
  readonly ids?: ColumnarPartsBatch['ids'];
  readonly properties?: ColumnarPartsBatch['properties'];
}

export function prepareParts(batch: ColumnarPartsBatch, projection: Crs, context = 'columnar'): PreparedPartsImport {
  const count = validatePartsBatch(batch, { positionKind: projection.positionKind, context });
  const projected = projectColumns(projection, batch.positions, batch.altitudes);
  const geometries: PreparedFeatureGeometry[] = new Array(count);
  for (let feature = 0; feature < count; feature++) {
    const first = batch.featurePartOffsets?.[feature] ?? feature;
    const last = batch.featurePartOffsets?.[feature + 1] ?? feature + 1;
    const parts: Float64Array[] = [];
    for (let part = first; part < last; part++) parts.push(projected.subarray(batch.partOffsets[part]! * 2, batch.partOffsets[part + 1]! * 2));
    geometries[feature] = prepareWorldParts(batch.kind, parts, `${context}[${feature}]`);
  }
  return { kind: 'prepared-parts', geometries, ...(batch.ids === undefined ? {} : { ids: batch.ids }),
    ...(batch.properties === undefined ? {} : { properties: batch.properties }) };
}

/** Worker trust boundary: finite coordinates, bounded offsets and matching anchors. */
export function validPreparedParts(value: unknown): value is PreparedPartsImport {
  if (!value || typeof value !== 'object' || (value as PreparedPartsImport).kind !== 'prepared-parts') return false;
  const parts = value as PreparedPartsImport;
  if (!Array.isArray(parts.geometries)) return false;
  for (const geometry of parts.geometries) {
    if (!geometry || typeof geometry !== 'object' || !geometry.payload) return false;
    const payload = geometry.payload;
    if (payload.kind !== geometry.kind) return false;
    const polygon = payload.kind === GEOMETRY_KIND.polygon;
    if (!polygon && payload.kind !== GEOMETRY_KIND.lineString && payload.kind !== GEOMETRY_KIND.multiLineString) return false;
    if (polygon ? !('ringVertices' in payload && 'rings' in payload && 'ringOuter' in payload) : !('vertices' in payload && 'parts' in payload)) return false;
    const vertices = 'ringVertices' in payload ? payload.ringVertices : 'vertices' in payload ? payload.vertices : null;
    const offsets = 'rings' in payload ? payload.rings : 'parts' in payload ? payload.parts : null;
    if (!(vertices instanceof Float64Array) || vertices.length < 4 || vertices.length % 2 ||
      !(offsets instanceof Uint32Array) || offsets.length === 0 || offsets.length % 2) return false;
    let end = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let at = 0; at < vertices.length; at += 2) {
      const x = vertices[at]!, y = vertices[at + 1]!;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    for (let at = 0; at < offsets.length; at += 2) {
      const start = offsets[at]!, count = offsets[at + 1]!;
      if (start !== end || count < (polygon ? 4 : 2) || start + count > vertices.length / 2) return false;
      end = start + count;
      if (polygon && (vertices[start * 2] !== vertices[(end - 1) * 2] || vertices[start * 2 + 1] !== vertices[(end - 1) * 2 + 1])) return false;
    }
    if (end !== vertices.length / 2) return false;
    if ('ringOuter' in payload && (!(payload.ringOuter instanceof Uint8Array) || payload.ringOuter.length !== offsets.length / 2 ||
      payload.ringOuter[0] !== 1 || payload.ringOuter.subarray(1).some((outer: number) => outer !== 0))) return false;
    if (!(geometry.bbox instanceof Float64Array) || geometry.bbox.length !== 4 ||
      geometry.bbox[0] !== minX || geometry.bbox[1] !== minY || geometry.bbox[2] !== maxX || geometry.bbox[3] !== maxY ||
      geometry.anchorX !== (minX + maxX) / 2 || geometry.anchorY !== (minY + maxY) / 2) return false;
  }
  return true;
}
