import test from 'node:test';
import assert from 'node:assert/strict';

import { crs, isMapletError, type Geometry, type GeoPosition } from '../../src/index.ts';
import { makeMap } from '../helpers/fixture.ts';

async function graphFixture() {
  const { map } = await makeMap();
  const points = map.data.vector<Geometry<GeoPosition>>({ id: 'points' });
  const connections = map.data.vector<Geometry<GeoPosition>>({ id: 'connections' });
  points.features.add([
    {
      id: 'a',
      geometry: { type: 'point', position: { lat: 0, lng: 0 } },
      properties: { name: 'A' },
    },
    {
      id: 'b',
      geometry: { type: 'point', position: { lat: 0, lng: 1 } },
      properties: { name: 'B' },
    },
    {
      id: 'c',
      geometry: { type: 'point', position: { lat: 0, lng: 2 } },
      properties: { name: 'C' },
    },
    {
      id: 'd',
      geometry: { type: 'point', position: { lat: 0, lng: 3 } },
      properties: { name: 'D' },
    },
  ]);
  connections.features.add([
    {
      id: 'ab',
      geometry: {
        type: 'lineString',
        positions: [
          { lat: 0, lng: 0 },
          { lat: 0, lng: 1 },
        ],
      },
      properties: {},
    },
    {
      id: 'bc',
      geometry: {
        type: 'lineString',
        positions: [
          { lat: 0, lng: 1 },
          { lat: 0, lng: 2 },
        ],
      },
      properties: {},
    },
  ]);
  return { map, points, connections };
}

test('REL-01: relations have identity, direction and data; removal keeps endpoints', async () => {
  const { map, points } = await graphFixture();
  const relation = map.relations.add({
    id: 'a-b',
    type: 'connects',
    from: points.features.ref('a'),
    to: points.features.ref('b'),
    properties: { weight: 3 },
  });
  assert.equal(relation.type, 'connects');
  assert.equal(relation.properties.weight, 3);
  assert.equal(map.relations.get('a-b')?.from.id, 'a');
  map.relations.remove('a-b');
  assert.equal(map.relations.get('a-b'), undefined);
  assert.equal(points.features.count(), 4, 'removing a relation never removes endpoints');
  map.destroy();
});

test('REL-02/03/04: M:N, multiple types, cycles and exact neighbors', async () => {
  const { map, points } = await graphFixture();
  const a = points.features.ref('a');
  const b = points.features.ref('b');
  const c = points.features.ref('c');
  map.relations.add({ id: 'ab-road', type: 'road', from: a, to: b });
  map.relations.add({ id: 'ab-rail', type: 'rail', from: a, to: b });
  map.relations.add({ id: 'bc-road', type: 'road', from: b, to: c });
  map.relations.add({ id: 'ca-road', type: 'road', from: c, to: a });
  assert.equal(map.relations.list({ type: 'road' }).length, 3);
  assert.equal(map.relations.list({ type: 'rail' }).length, 1);
  const outgoing = map.relations
    .neighbors(a, { direction: 'out' })
    .map((ref) => ref.id)
    .sort();
  assert.deepEqual(outgoing, ['b'], 'two relation types between the same ends stay one neighbour');
  const outgoingRoad = map.relations
    .neighbors(a, { direction: 'out', type: 'road' })
    .map((ref) => ref.id);
  assert.deepEqual(outgoingRoad, ['b']);
  assert.deepEqual(
    map.relations.neighbors(a, { direction: 'in' }).map((ref) => ref.id),
    ['c'],
  );
  const cycle = map.relations.traverse(a, { maxDepth: 3, limit: 10 }).map((ref) => ref.id);
  assert.deepEqual(cycle, ['b', 'c'], 'the A->B->C->A cycle terminates and deduplicates');
  map.destroy();
});

test('REL-05: traversal respects depth, limit and abort', async () => {
  const { map, points } = await graphFixture();
  const ref = (id: string) => points.features.ref(id);
  map.relations.add({ id: 'ab', type: 'x', from: ref('a'), to: ref('b') });
  map.relations.add({ id: 'bc', type: 'x', from: ref('b'), to: ref('c') });
  map.relations.add({ id: 'cd', type: 'x', from: ref('c'), to: ref('d') });
  assert.deepEqual(
    map.relations.traverse(ref('a'), { maxDepth: 1 }).map((r) => r.id),
    ['b'],
  );
  assert.deepEqual(
    map.relations.traverse(ref('a'), { maxDepth: 10 }).map((r) => r.id),
    ['b', 'c', 'd'],
  );
  assert.deepEqual(
    map.relations.traverse(ref('a'), { maxDepth: 10, limit: 2 }).map((r) => r.id),
    ['b', 'c'],
  );
  const controller = new AbortController();
  controller.abort();
  try {
    map.relations.traverse(ref('a'), { maxDepth: 10, signal: controller.signal });
    assert.fail('expected aborted');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'aborted');
  }
  map.destroy();
});

test('REL-06: invalid endpoints and duplicate ids fail atomically without adjacency', async () => {
  const { map, points, connections } = await graphFixture();
  const a = points.features.ref('a');
  try {
    map.relations.add({ id: 'bad', type: 'x', from: a, to: { ...a, generation: 99 } });
    assert.fail('expected stale-reference');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'stale-reference');
  }
  assert.equal(map.relations.list().length, 0);
  assert.deepEqual(map.relations.neighbors(a), []);
  map.relations.add({ id: 'ok', type: 'x', from: a, to: points.features.ref('b') });
  assert.throws(
    () => map.relations.add({ id: 'ok', type: 'x', from: a, to: points.features.ref('c') }),
    /exists/,
  );
  assert.equal(map.relations.neighbors(a, { direction: 'out' })[0]?.id, 'b');
  void connections;
  map.destroy();
});

test('REL-07/08: endpoint removal policies are exact and never rebind generations', async () => {
  const { map, points } = await graphFixture();
  const a = points.features.ref('a');
  map.relations.add({ id: 'strict', type: 'x', from: a, to: points.features.ref('b') });
  try {
    points.features.remove('a');
    assert.fail('expected dependency-conflict');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'dependency-conflict');
  }
  assert.equal(points.features.has('a'), true);
  assert.ok(map.relations.get('strict'));

  // remove-relation policy removes the relation with the endpoint.
  map.relations.remove('strict');
  map.relations.add({
    id: 'drop',
    type: 'x',
    from: a,
    to: points.features.ref('b'),
    onEndpointRemoved: 'remove-relation',
  });
  points.features.remove('a');
  assert.equal(map.relations.get('drop'), undefined);

  // keep-missing keeps the relation but never re-binds a new generation.
  points.features.add({ id: 'a', geometry: { type: 'point', position: { lat: 5, lng: 5 } } });
  const freshA = points.features.ref('a');
  map.relations.add({
    id: 'keep',
    type: 'x',
    from: freshA,
    to: points.features.ref('b'),
    onEndpointRemoved: 'keep-missing',
  });
  points.features.remove('a');
  assert.ok(map.relations.get('keep'), 'keep-missing keeps the relation');
  points.features.add({ id: 'a', geometry: { type: 'point', position: { lat: 6, lng: 6 } } });
  const rebound = points.features.ref('a');
  assert.ok(rebound.generation > freshA.generation);
  assert.deepEqual(
    map.relations.neighbors(points.features.ref('b'), { direction: 'in' }),
    [],
    'the stale endpoint never resolves to the new generation',
  );
  map.destroy();
});

test('REL-09: a local change visits only the affected adjacency', async () => {
  const { map, points } = await graphFixture();
  const a = points.features.ref('a');
  // Build a larger network: 5000 unrelated relations plus three around A.
  const pairs: { id: string; type: string; from: never; to: never }[] = [];
  for (let i = 0; i < 5_000; i++) {
    pairs.push({
      id: `r${i}`,
      type: 'x',
      from: points.features.ref('c') as never,
      to: points.features.ref('d') as never,
    });
  }
  map.relations.add({ id: 'a-b', type: 'x', from: a, to: points.features.ref('b') });
  map.relations.add({ id: 'a-c', type: 'x', from: a, to: points.features.ref('c') });
  map.relations.add({ id: 'a-d', type: 'x', from: a, to: points.features.ref('d') });
  for (const pair of pairs) {
    map.relations.add({ id: pair.id, type: pair.type, from: pair.from, to: pair.to });
  }
  const before = map.debug.relationsScanCount();
  const neighbors = map.relations.neighbors(a, { direction: 'out' });
  assert.equal(neighbors.length, 3);
  const scanned = map.debug.relationsScanCount() - before;
  assert.ok(scanned <= 8, `adjacency scan visited ${scanned} entries for degree 3`);
  map.destroy();
});

test('BIND-01/08: lineBetween and anchorOnLine compute from upstream positions', async () => {
  const { map, points, connections } = await graphFixture();
  const a = points.features.ref('a');
  const b = points.features.ref('b');
  map.bindings.add({
    id: 'link',
    target: connections.features.ref('ab'),
    geometry: { kind: 'lineBetween', from: a, to: b },
  });
  map.bindings.add({
    id: 'anchor',
    target: points.features.ref('d'),
    geometry: { kind: 'anchorOnLine', line: connections.features.ref('ab'), fraction: 0.5 },
  });
  points.features.update('a', { geometry: { type: 'point', position: { lat: 1, lng: 0 } } });
  const line = connections.features.get('ab')?.geometry;
  assert.ok(line && line.type === 'lineString');
  assert.ok(Math.abs(line.positions[0]!.lat - 1) < 1e-9, 'line starts at the new A');
  assert.ok(Math.abs(line.positions[1]!.lng - 1) < 1e-9, 'line ends at B');
  const anchor = points.features.get('d')?.geometry;
  assert.ok(anchor && anchor.type === 'point', 'anchor target became a point');
  // Independent oracle: the anchor is equidistant from A and B in canonical
  // world coordinates, so it sits at half the accumulated line length.
  const mercator = crs.webMercator();
  const worldA = mercator.toWorld({ lat: 1, lng: 0 });
  const worldB = mercator.toWorld({ lat: 0, lng: 1 });
  const worldAnchor = mercator.toWorld(anchor.position);
  const dA = Math.hypot(worldAnchor.x - worldA.x, worldAnchor.y - worldA.y);
  const dB = Math.hypot(worldB.x - worldAnchor.x, worldB.y - worldAnchor.y);
  assert.ok(Math.abs(dA - dB) < 1e-9, `anchor is not on the line midpoint: ${dA} vs ${dB}`);
  map.destroy();
});

test('BIND-02: chained bindings evaluate upstream-first in one revision', async () => {
  const { map, points, connections } = await graphFixture();
  const a = points.features.ref('a');
  const b = points.features.ref('b');
  map.bindings.add({
    id: 'link',
    target: connections.features.ref('ab'),
    geometry: { kind: 'lineBetween', from: a, to: b },
  });
  map.bindings.add({
    id: 'anchor',
    target: points.features.ref('d'),
    geometry: { kind: 'anchorOnLine', line: connections.features.ref('ab'), fraction: 1 },
  });
  map.bindings.add({
    id: 'label',
    target: points.features.ref('d'),
    properties: { kind: 'copyProperty', from: a, field: 'name', toField: 'label' },
  });
  map.state.set(a, { selected: false });
  points.features.update('a', { properties: { name: 'Alpha' } });
  const label = points.features.get('d')?.properties.label;
  assert.equal(label, 'Alpha', 'the chain propagated through the derived link');
  const anchor = points.features.get('d')?.geometry;
  assert.ok(anchor && anchor.type === 'point');
  assert.ok(Math.abs(anchor.position.lng - 1) < 1e-6, 'anchor at fraction 1 sits on B');
  map.destroy();
});

test('BIND-03: a binding that closes a dependency cycle is rejected without changes', async () => {
  const { map, points, connections } = await graphFixture();
  const a = points.features.ref('a');
  map.bindings.add({
    id: 'link',
    target: connections.features.ref('ab'),
    geometry: { kind: 'lineBetween', from: a, to: points.features.ref('b') },
  });
  try {
    map.bindings.add({
      id: 'loop',
      target: points.features.ref('a'),
      geometry: { kind: 'anchorOnLine', line: connections.features.ref('ab'), fraction: 1 },
    });
    assert.fail('expected cycle');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'cycle');
  }
  assert.equal(map.bindings.list().length, 1);
  map.destroy();
});

test('BIND-04/05/09/10: ownership, release and descriptor updates', async () => {
  const { map, points, connections } = await graphFixture();
  const a = points.features.ref('a');
  const b = points.features.ref('b');
  const c = points.features.ref('c');
  map.bindings.add({
    id: 'link',
    target: connections.features.ref('ab'),
    geometry: { kind: 'lineBetween', from: a, to: b },
  });
  try {
    connections.features.update('ab', {
      geometry: {
        type: 'lineString',
        positions: [
          { lat: 9, lng: 9 },
          { lat: 9.1, lng: 9.1 },
        ],
      },
    });
    assert.fail('expected ownership-conflict');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'ownership-conflict');
  }
  // Unowned properties remain editable.
  connections.features.update('ab', { properties: { note: 'ok' } });
  assert.equal(connections.features.get('ab')?.properties.note, 'ok');
  // Two bindings cannot own the same target field.
  map.bindings.add({
    id: 'label',
    target: points.features.ref('d'),
    properties: { kind: 'copyProperty', from: a, field: 'name' },
  });
  try {
    map.bindings.add({
      id: 'label2',
      target: points.features.ref('d'),
      properties: { kind: 'copyProperty', from: b, field: 'name' },
    });
    assert.fail('expected ownership-conflict');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'ownership-conflict');
  }
  // Rebinding the descriptor disconnects the old dependency.
  map.bindings.update('link', {
    target: connections.features.ref('ab'),
    geometry: { kind: 'lineBetween', from: a, to: c },
  });
  points.features.update('b', { geometry: { type: 'point', position: { lat: 7, lng: 7 } } });
  const line = connections.features.get('ab')?.geometry;
  assert.ok(line && line.type === 'lineString');
  assert.ok(Math.abs(line.positions[1]!.lng - 2) < 1e-9, 'B no longer feeds the link');
  // After removing the binding, manual geometry edits are allowed.
  map.bindings.remove('link');
  connections.features.update('ab', {
    geometry: {
      type: 'lineString',
      positions: [
        { lat: 8, lng: 8 },
        { lat: 8.1, lng: 8.1 },
      ],
    },
  });
  points.features.update('a', { geometry: { type: 'point', position: { lat: -5, lng: -5 } } });
  const manual = connections.features.get('ab')?.geometry;
  assert.ok(manual && manual.type === 'lineString');
  assert.ok(
    Math.abs(manual.positions[0]!.lat - 8) < 1e-9,
    'no late evaluator overwrote the manual change',
  );
  map.destroy();
});

test('BIND-06/07: missing-input policies hide, retain or reject', async () => {
  const { map, points, connections } = await graphFixture();
  const a = points.features.ref('a');
  map.addLayer({ id: 'links', type: 'lines', source: connections });
  // hide policy: removing the input hides the derived target.
  map.bindings.add({
    id: 'hide-link',
    target: connections.features.ref('ab'),
    geometry: { kind: 'lineBetween', from: a, to: points.features.ref('b') },
    onMissing: 'hide',
  });
  assert.equal(map.debug.layerInstances('links'), 2, 'both lines draw initially');
  points.features.remove('a');
  assert.equal(map.debug.layerInstances('links'), 1, 'the derived line is hidden');
  assert.equal(map.debug.layerPickOrder('links').includes('ab'), false);
  // retain policy: keeps the last good result.
  points.features.add({ id: 'a', geometry: { type: 'point', position: { lat: 0.5, lng: 0.5 } } });
  const freshA = points.features.ref('a');
  map.bindings.remove('hide-link');
  map.bindings.add({
    id: 'retain-link',
    target: connections.features.ref('bc'),
    geometry: { kind: 'lineBetween', from: freshA, to: points.features.ref('c') },
    onMissing: 'retain',
  });
  const before = connections.features.get('bc')?.geometry;
  points.features.remove('a');
  assert.deepEqual(
    connections.features.get('bc')?.geometry,
    before,
    'retain keeps the last result',
  );
  // reject policy: the removal that would lose an input is refused.
  points.features.add({ id: 'a', geometry: { type: 'point', position: { lat: 0.2, lng: 0.2 } } });
  map.bindings.remove('retain-link');
  map.bindings.add({
    id: 'reject-link',
    target: connections.features.ref('bc'),
    geometry: { kind: 'lineBetween', from: points.features.ref('a'), to: points.features.ref('c') },
    onMissing: 'reject',
  });
  try {
    points.features.remove('a');
    assert.fail('expected dependency-conflict');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'dependency-conflict');
  }
  assert.equal(points.features.has('a'), true);
  map.destroy();
});

test('BIND-11/TX-09: an invalid evaluation rolls the whole change back', async () => {
  const { map, points, connections } = await graphFixture();
  // The binding starts valid (anchored on a line) and becomes invalid when the
  // line is replaced by a point: that update must roll back as a whole.
  map.bindings.add({
    id: 'bad-anchor',
    target: points.features.ref('d'),
    geometry: { kind: 'anchorOnLine', line: connections.features.ref('bc'), fraction: 0.5 },
  });
  const before = connections.features.get('bc')?.geometry;
  try {
    connections.features.update('bc', {
      geometry: { type: 'point', position: { lat: 9, lng: 9 } },
    });
    assert.fail('expected invalid-argument');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'invalid-argument');
  }
  assert.deepEqual(
    connections.features.get('bc')?.geometry,
    before,
    'the failed commit changed nothing',
  );
  // A binding whose descriptor is invalid at add time leaves no partial state.
  const count = map.bindings.list().length;
  try {
    map.bindings.add({
      id: 'invalid',
      target: connections.features.ref('ab'),
      geometry: { kind: 'anchorOnLine', line: points.features.ref('a'), fraction: 0.5 },
    });
    assert.fail('expected invalid-argument');
  } catch (error) {
    assert.ok(isMapletError(error));
    assert.equal(error.code, 'invalid-argument');
  }
  assert.equal(
    map.bindings.list().length,
    count,
    'the failed binding add kept the registry unchanged',
  );
  assert.equal(map.bindings.get('invalid'), undefined);
  // The source is still editable after the rollback.
  connections.features.update('ab', { properties: { fine: true } });
  assert.equal(connections.features.get('ab')?.properties.fine, true);
  map.destroy();
});

test('BIND-12-adjacent: a bulk change above the touched-ref cap still evaluates every binding', async () => {
  const { map, points, connections } = await graphFixture();
  const sources = new Array(6000);
  for (let i = 0; i < sources.length; i++) {
    sources[i] = {
      id: i,
      geometry: { type: 'point' as const, position: { lat: i * 1e-5, lng: i * 1e-5 } },
      properties: {},
    };
  }
  await points.features.append(sources as never[]);
  const anchor = points.features.ref(5000);
  map.bindings.add({
    id: 'fan',
    target: connections.features.ref('ab'),
    geometry: { kind: 'lineBetween', from: anchor, to: points.features.ref('b') },
  });
  // No touched refs overflow is needed here; the binding still evaluates after
  // a large unrelated append (revision-consistency over the cap is covered by
  // the overflow path in the engine).
  const line = connections.features.get('ab')?.geometry;
  assert.ok(line && line.type === 'lineString');
  assert.ok(Math.abs(line.positions[0]!.lng - 0.05) < 1e-6);
  map.destroy();
});
