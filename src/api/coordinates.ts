import { assertArgument } from './errors.ts';
import { isArrayValue } from './types.ts';
import type { Position } from './types.ts';
import type { Crs } from '../math/crs.ts';

/** Geographic tuples always use [latitude, longitude], never GeoJSON order. */
export type PositionInput = Position | readonly [lat: number, lng: number];

export function normalizePosition(input: PositionInput, projection: Crs): Position {
  if (isArrayValue(input)) {
    const tuple = input as readonly [lat: number, lng: number];
    assertArgument(
      projection.positionKind === 'geographic',
      'coordinate tuples are [lat, lng]; use { x, y } with a planar CRS',
    );
    assertArgument(tuple.length === 2, 'a geographic coordinate needs exactly [lat, lng]');
    return projection.normalize({ lat: tuple[0], lng: tuple[1] });
  }
  return projection.normalize(input as Position);
}
