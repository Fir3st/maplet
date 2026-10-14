import { assertArgument } from './errors.ts';
import type { Position } from './types.ts';
import type { Crs } from '../math/crs.ts';

/** Geographic tuples always use [latitude, longitude], never GeoJSON order. */
export type PositionInput = Position | readonly [lat: number, lng: number];

export function normalizePosition(input: PositionInput, projection: Crs): Position {
  if (Array.isArray(input)) {
    assertArgument(projection.positionKind === 'geographic', 'coordinate tuples are [lat, lng]; use { x, y } with a planar CRS');
    assertArgument(input.length === 2, 'a geographic coordinate needs exactly [lat, lng]');
    return projection.normalize({ lat: input[0]!, lng: input[1]! });
  }
  return projection.normalize(input as Position);
}
