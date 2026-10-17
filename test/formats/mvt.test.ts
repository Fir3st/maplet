import test from 'node:test';
import assert from 'node:assert/strict';

import { decodeMvtTile } from '../../src/formats/mvt.ts';
import {
  encodeLayer,
  encodeTile,
  geomLine,
  geomPoint,
  geomPolygon,
  type TestLayerSpec,
} from '../helpers/mvt-encoder.ts';

function layer(spec: Partial<TestLayerSpec> & { name: string }): TestLayerSpec {
  return { features: [], ...spec };
}

test('MVT decode: points, lines and polygons with typed properties', () => {
  const tile = decodeMvtTile(
    encodeTile([
      encodeLayer(
        layer({
          name: 'pois',
          keys: ['name', 'rank', 'score', 'ratio', 'open'],
          values: [
            { t: 'string', v: 'Praha' },
            { t: 'uint', v: 7n },
            { t: 'sint', v: -3n },
            { t: 'double', v: 1.5 },
            { t: 'bool', v: true },
          ],
          features: [
            {
              id: 1,
              type: 1,
              geometry: geomPoint([[10, 20]]),
              tags: [
                [0, 0],
                [1, 1],
                [2, 2],
                [3, 3],
                [4, 4],
              ],
            },
          ],
        }),
      ),
      encodeLayer(
        layer({
          name: 'roads',
          extent: 512,
          features: [
            {
              id: 2,
              type: 2,
              geometry: geomLine([
                [
                  [0, 0],
                  [100, 0],
                  [100, 50],
                ],
              ]),
            },
            {
              id: 3,
              type: 2,
              geometry: geomLine([
                [
                  [0, 0],
                  [10, 0],
                ],
                [
                  [20, 20],
                  [30, 20],
                ],
              ]),
            },
            {
              id: 4,
              type: 3,
              geometry: geomPolygon([
                [
                  [0, 0],
                  [100, 0],
                  [100, 100],
                  [0, 100],
                ],
                [
                  [20, 20],
                  [20, 40],
                  [40, 40],
                  [40, 20],
                ],
              ]),
            },
          ],
        }),
      ),
    ]),
  );

  assert.equal(tile.rejectedFeatures, 0);
  assert.equal(tile.tile.layers.length, 2);
  const pois = tile.tile.layers[0]!;
  assert.equal(pois.name, 'pois');
  assert.equal(pois.extent, 4096);
  const point = pois.features[0]!;
  assert.equal(point.id, 1);
  assert.equal(point.geometry.kind, 'point');
  if (point.geometry.kind !== 'point') throw new Error('expected point');
  assert.deepEqual(Array.from(point.geometry.points), [10, 20]);
  assert.deepEqual(point.properties, {
    name: 'Praha',
    rank: 7,
    score: -3,
    ratio: 1.5,
    open: true,
  });

  const roads = tile.tile.layers[1]!;
  assert.equal(roads.extent, 512);
  const line = roads.features[0]!;
  if (line.geometry.kind !== 'line') throw new Error('expected line');
  assert.deepEqual(Array.from(line.geometry.parts), [0, 3]);
  assert.deepEqual(Array.from(line.geometry.vertices), [0, 0, 100, 0, 100, 50]);

  const multi = roads.features[1]!;
  if (multi.geometry.kind !== 'line') throw new Error('expected line');
  assert.deepEqual(
    Array.from(multi.geometry.parts),
    [0, 2, 2, 2],
    'two MoveTo starts produce two parts',
  );

  const polygon = roads.features[2]!;
  if (polygon.geometry.kind !== 'polygon') throw new Error('expected polygon');
  assert.deepEqual(Array.from(polygon.geometry.ringOuter), [1, 0], 'winding decides outer vs hole');
  assert.equal(polygon.geometry.rings.length, 4);
  // Rings are closed with the repeated first vertex.
  const firstRingCount = polygon.geometry.rings[1]!;
  assert.equal(firstRingCount, 5);
});

test('MVT-03: uint64 ids beyond 2^53 stay exact as decimal strings', () => {
  const big = 9007199254740993n; // 2^53 + 1
  const near = 9007199254740995n; // 2^53 + 3
  const tile = decodeMvtTile(
    encodeTile([
      encodeLayer(
        layer({
          name: 'big',
          features: [
            { id: big, type: 1, geometry: geomPoint([[0, 0]]) },
            { id: near, type: 1, geometry: geomPoint([[1, 1]]) },
          ],
        }),
      ),
    ]),
  );
  assert.equal(tile.tile.layers[0]!.features[0]!.id, '9007199254740993');
  assert.equal(tile.tile.layers[0]!.features[1]!.id, '9007199254740995');
  assert.notEqual(tile.tile.layers[0]!.features[0]!.id, tile.tile.layers[0]!.features[1]!.id);
});

test('MVT-03: the id varint bytes are pinned (2^53 + 1)', () => {
  const bytes = encodeTile([
    encodeLayer(
      layer({
        name: 'l',
        features: [{ id: 9007199254740993n, type: 1, geometry: geomPoint([[0, 0]]) }],
      }),
    ),
  ]);
  // Frame: tile field 3 -> layer(1+23) -> feature(1+10) -> id field 1 varint 8 bytes.
  const idVarint = [0x81, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10];
  const asArray = Array.from(bytes);
  const at = indexOfSequence(asArray, idVarint);
  assert.ok(at >= 0, `expected the pinned varint bytes in ${asArray.join(',')}`);
  assert.equal(decodeMvtTile(bytes).tile.layers[0]!.features[0]!.id, '9007199254740993');
});

function indexOfSequence(haystack: readonly number[], needle: readonly number[]): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

test('MVT-08: malformed bytes are rejected as import-invalid', () => {
  assert.throws(
    () => decodeMvtTile(Uint8Array.from([0x1a, 0x05, 0x01, 0x02])),
    /truncated|exceeds the supported range/,
  );
  assert.throws(() => decodeMvtTile(Uint8Array.from([0x0f])), /unsupported wire type/);
  assert.throws(() => decodeMvtTile(Uint8Array.from([0x1a, 0x80])), /truncated varint|truncated/);
});

test('MVT-08: extreme vertex offsets reject the feature, not the scene', () => {
  const tile = decodeMvtTile(
    encodeTile([
      encodeLayer(
        layer({
          name: 'broken',
          features: [
            { id: 1, type: 1, geometry: geomPoint([[20_000_000, 0]]) },
            { id: 2, type: 1, geometry: geomPoint([[5, 5]]) },
          ],
        }),
      ),
    ]),
  );
  assert.equal(tile.rejectedFeatures, 1);
  const features = tile.tile.layers[0]!.features;
  assert.equal(features.length, 1);
  assert.equal(features[0]!.id, 2);
});

test('MVT decode: empty and unknown fields are skipped safely', () => {
  const tileBytes = encodeTile([encodeLayer(layer({ name: 'empty' }))]);
  // Append an unknown top-level length-delimited field (field 9).
  const withUnknown = Uint8Array.from([...tileBytes, (9 << 3) | 2, 3, 1, 2, 3]);
  const tile = decodeMvtTile(withUnknown);
  assert.equal(tile.tile.layers.length, 1);
  assert.equal(tile.tile.layers[0]!.features.length, 0);
});
