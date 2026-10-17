import test from 'node:test';
import assert from 'node:assert/strict';

import { isMapletError } from '../../src/api/errors.ts';
import {
  DEFAULT_CLUSTER_MIN_COUNT,
  DEFAULT_CLUSTER_RADIUS_PX,
  clusterBadge,
  clusterByProximity,
  resolveMarkerClustering,
  type ClusterCandidate,
} from '../../src/ui/marker-clusters.ts';

const at = (key: string, x: number, y: number): ClusterCandidate => ({ key, x, y });

test('MARKER-11: nearby candidates group, distant ones stay single', () => {
  const { clusters, singles } = clusterByProximity(
    [at('a', 100, 100), at('b', 110, 104), at('c', 400, 300), at('d', 405, 300)],
    64,
    2,
  );
  assert.equal(clusters.length, 2);
  assert.deepEqual(clusters[0]!.members, ['a', 'b']);
  assert.deepEqual(clusters[1]!.members, ['c', 'd']);
  assert.deepEqual(singles, []);
  // The centre is the running average of the members.
  assert.equal(clusters[0]!.x, 105);
  assert.equal(clusters[0]!.y, 102);
});

test('MARKER-11: the radius is inclusive, minCount keeps small groups individual', () => {
  const touching = clusterByProximity([at('a', 0, 0), at('b', 64, 0)], 64, 2);
  assert.equal(touching.clusters.length, 1);
  assert.deepEqual(touching.clusters[0]!.members, ['a', 'b']);

  const beyond = clusterByProximity([at('a', 0, 0), at('b', 64.0001, 0)], 64, 2);
  assert.equal(beyond.clusters.length, 0);
  assert.deepEqual(beyond.singles, ['a', 'b']);

  const pair = clusterByProximity([at('a', 0, 0), at('b', 10, 0)], 64, 3);
  assert.equal(pair.clusters.length, 0);
  assert.deepEqual(pair.singles, ['a', 'b']);

  const triple = clusterByProximity([at('a', 0, 0), at('b', 10, 0), at('c', 20, 0)], 64, 3);
  assert.equal(triple.clusters.length, 1);
  assert.deepEqual(triple.clusters[0]!.members, ['a', 'b', 'c']);

  // Singles keep the input order.
  assert.deepEqual(clusterByProximity([at('z', 0, 0), at('a', 500, 0)], 64, 2).singles, ['z', 'a']);
});

test('MARKER-11: a group centre is re-indexed as it drifts, so a later neighbour still joins', () => {
  // 60, 124 and 150 from the origin: each one is within the radius of the
  // running centre it meets, but the centre crosses into the next grid cell —
  // were the group left behind in its first cell the third candidate would miss
  // it (its lookup scans only the nine cells around itself).
  const { clusters, singles } = clusterByProximity(
    [at('a', 60, 0), at('b', 124, 0), at('c', 150, 0)],
    64,
    2,
  );
  assert.deepEqual(singles, []);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0]!.members, ['a', 'b', 'c']);
  assert.ok(Math.abs(clusters[0]!.x - 334 / 3) < 1e-9, 'centre is the members mean');
});

test('MARKER-11: candidates join the nearest group and the pass is deterministic', () => {
  const points = [
    at('a', 0, 0),
    at('a2', 20, 0),
    at('b1', 100, 0),
    at('b2', 120, 0),
    at('q', 50, 0),
  ];
  const first = clusterByProximity(points, 64, 2);
  assert.equal(first.clusters.length, 2);
  // q is within the radius of both centres (40 px vs 60 px) and joins the closer one.
  assert.deepEqual(first.clusters[0]!.members, ['a', 'a2', 'q']);
  assert.deepEqual(first.clusters[1]!.members, ['b1', 'b2']);

  const again = clusterByProximity(points, 64, 2);
  assert.deepEqual(again, first);
});

test('MARKER-11: clustering options resolve defaults and reject nonsense', () => {
  assert.deepEqual(resolveMarkerClustering({}), {
    radiusPx: DEFAULT_CLUSTER_RADIUS_PX,
    minCount: DEFAULT_CLUSTER_MIN_COUNT,
    disableAtZoom: null,
  });
  assert.deepEqual(resolveMarkerClustering({ radiusPx: 32, minCount: 3, disableAtZoom: 12 }), {
    radiusPx: 32,
    minCount: 3,
    disableAtZoom: 12,
  });
  const invalid = (options: unknown): boolean =>
    (() => {
      try {
        resolveMarkerClustering(options as never);
        return false;
      } catch (error) {
        return isMapletError(error) && error.code === 'invalid-argument';
      }
    })();
  assert.equal(invalid({ radiusPx: 0 }), true);
  assert.equal(invalid({ radiusPx: Number.NaN }), true);
  assert.equal(invalid({ minCount: 1 }), true);
  assert.equal(invalid({ minCount: 2.5 }), true);
  assert.equal(invalid({ disableAtZoom: Number.POSITIVE_INFINITY }), true);
  assert.equal(invalid(null), true);
});

test('MARKER-11: badge artwork follows the member count in three tiers', () => {
  const small = clusterBadge(2);
  assert.equal(small.label, '2');
  assert.equal(small.size, 34);
  assert.equal(small.color, '#2563eb');
  assert.match(small.url, /^data:image\/svg\+xml/);
  assert.match(decodeURIComponent(small.url), />2<\/text>/);

  assert.equal(clusterBadge(9).size, 34);
  assert.equal(clusterBadge(10).size, 40);
  assert.equal(clusterBadge(10).color, '#1d4ed8');
  assert.equal(clusterBadge(99).size, 40);
  assert.equal(clusterBadge(100).size, 46);
  assert.equal(clusterBadge(100).color, '#1e3a8a');
  assert.equal(clusterBadge(999).label, '999');
  assert.equal(clusterBadge(1000).label, '1k');
  assert.equal(clusterBadge(1200).label, '1.2k');
  assert.equal(clusterBadge(9999).label, '10k');
  assert.equal(clusterBadge(12000).label, '12k');
  assert.match(clusterBadge(1000).url, /^data:image\/svg\+xml/);
});
