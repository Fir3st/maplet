/**
 * Marker clustering (MARKER-11): nearby pins group into one count badge.
 *
 * Grouping happens in screen space at the current zoom: two pins are near when
 * their screen positions are within `radiusPx`. That keeps the grouping stable
 * while the map pans (screen distances do not change) and lets it dissolve as
 * the view zooms in (screen distances grow). The greedy pass follows
 * Leaflet.markercluster: candidates are visited in the layer's insertion order,
 * each one joins the nearest existing group whose running centre is within the
 * radius, and otherwise starts a new group — so the result is deterministic and
 * a member is always within the radius of the centre it met.
 *
 * The badge artwork is generated per member count: a flat circle with a white
 * rim and the count as text, in three size tiers. Artwork is derived only from
 * the count, so the controller can cache one asset per label.
 */

import { assertArgument } from '../api/errors.ts';

/** One clusterable point in screen coordinates (CSS px). */
export interface ClusterCandidate {
  /** Stable key of the underlying marker (the controller passes the record key). */
  readonly key: string;
  readonly x: number;
  readonly y: number;
}

/** A group of nearby points; `x`/`y` is the running average of its members. */
export interface ClusterGroup {
  readonly members: readonly string[];
  readonly x: number;
  readonly y: number;
}

export interface ClusterPartition {
  /** Groups that reached `minCount`; every other point stays individual. */
  readonly clusters: readonly ClusterGroup[];
  /** Keys of the individual points, in input order. */
  readonly singles: readonly string[];
}

/**
 * Groups points whose screen distance is within `radiusPx`, joining the nearest
 * running centre and starting a new group when none is in reach.
 */
export function clusterByProximity(
  points: readonly ClusterCandidate[],
  radiusPx: number,
  minCount: number,
): ClusterPartition {
  const radius = Math.max(radiusPx, 1);
  const groups: { x: number; y: number; members: string[] }[] = [];
  const grid = new Map<string, number[]>();
  const groupCell = new Map<number, string>();
  const cellKey = (x: number, y: number): string =>
    `${Math.floor(x / radius)}:${Math.floor(y / radius)}`;
  const addToGrid = (index: number, key: string): void => {
    const bucket = grid.get(key);
    if (bucket) bucket.push(index);
    else grid.set(key, [index]);
    groupCell.set(index, key);
  };
  const moveInGrid = (index: number, key: string): void => {
    const previous = groupCell.get(index);
    if (previous === key) return;
    if (previous !== undefined) {
      const bucket = grid.get(previous);
      const at = bucket?.indexOf(index) ?? -1;
      if (bucket && at >= 0) bucket.splice(at, 1);
    }
    addToGrid(index, key);
  };

  for (const point of points) {
    const cellX = Math.floor(point.x / radius);
    const cellY = Math.floor(point.y / radius);
    // A group is indexed at its centre, so every group whose centre is within
    // the radius sits in one of the nine cells around the candidate.
    let best = -1;
    let bestDistance = radius;
    for (let gx = cellX - 1; gx <= cellX + 1; gx++) {
      for (let gy = cellY - 1; gy <= cellY + 1; gy++) {
        const bucket = grid.get(`${gx}:${gy}`);
        if (!bucket) continue;
        for (const index of bucket) {
          const group = groups[index]!;
          const distance = Math.hypot(group.x - point.x, group.y - point.y);
          if (distance <= bestDistance) {
            best = index;
            bestDistance = distance;
          }
        }
      }
    }
    if (best < 0) {
      groups.push({ x: point.x, y: point.y, members: [point.key] });
      addToGrid(groups.length - 1, `${cellX}:${cellY}`);
      continue;
    }
    const group = groups[best]!;
    const count = group.members.length;
    group.x += (point.x - group.x) / (count + 1);
    group.y += (point.y - group.y) / (count + 1);
    group.members.push(point.key);
    // The centre moves with every member; re-index it so later candidates in a
    // chain still find the group (a chain may walk far from its first point).
    moveInGrid(best, cellKey(group.x, group.y));
  }

  const clusters: ClusterGroup[] = [];
  const singles: string[] = [];
  for (const group of groups) {
    if (group.members.length >= minCount) {
      clusters.push({ members: group.members, x: group.x, y: group.y });
    } else {
      for (const key of group.members) singles.push(key);
    }
  }
  return { clusters, singles };
}

/** Clustering options; `null` in `setMarkerClustering` turns clustering off. */
export interface MarkerClusteringOptions {
  /** Screen radius in CSS px within which pins group; default 64. */
  readonly radiusPx?: number;
  /** Members a group needs to replace individual pins; default 2. */
  readonly minCount?: number;
  /** Zoom at and above which every pin draws individually; default `null`. */
  readonly disableAtZoom?: number | null;
}

/** Options with the defaults applied (what `getMarkerClustering` reports). */
export interface ResolvedMarkerClustering {
  readonly radiusPx: number;
  readonly minCount: number;
  readonly disableAtZoom: number | null;
}

export const DEFAULT_CLUSTER_RADIUS_PX = 64;
export const DEFAULT_CLUSTER_MIN_COUNT = 2;

export function resolveMarkerClustering(
  options: MarkerClusteringOptions,
): ResolvedMarkerClustering {
  assertArgument(
    typeof options === 'object' && options !== null,
    'marker clustering options must be an object',
  );
  const radiusPx = options.radiusPx ?? DEFAULT_CLUSTER_RADIUS_PX;
  const minCount = options.minCount ?? DEFAULT_CLUSTER_MIN_COUNT;
  const disableAtZoom = options.disableAtZoom ?? null;
  assertArgument(
    Number.isFinite(radiusPx) && radiusPx > 0,
    'clustering radiusPx must be a positive number',
    { radiusPx },
  );
  assertArgument(
    Number.isInteger(minCount) && minCount >= 2,
    'clustering minCount must be an integer of at least 2',
    { minCount },
  );
  assertArgument(
    disableAtZoom === null || Number.isFinite(disableAtZoom),
    'clustering disableAtZoom must be a finite number or null',
    { disableAtZoom },
  );
  return { radiusPx, minCount, disableAtZoom };
}

/** Generated badge artwork for a member count. */
export interface ClusterBadgeArt {
  /** Count text: exact up to 999, then `1.2k` / `12k`. */
  readonly label: string;
  /** Square size in CSS px; three tiers keep a dense map readable. */
  readonly size: number;
  /** Body colour of the badge circle. */
  readonly color: string;
  /** Ready-to-register SVG data URL. */
  readonly url: string;
}

export function clusterBadge(count: number): ClusterBadgeArt {
  const label =
    count <= 999
      ? String(count)
      : count <= 9999
        ? `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`
        : `${Math.round(count / 1000)}k`;
  const size = count < 10 ? 34 : count < 100 ? 40 : 46;
  const color = count < 10 ? '#2563eb' : count < 100 ? '#1d4ed8' : '#1e3a8a';
  const fontSize = size < 36 ? 13 : size < 44 ? 15 : 17;
  const center = size / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${center}" cy="${center}" r="${center - 1.5}" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>` +
    `<text x="${center}" y="${center}" dy="0.35em" text-anchor="middle" font-family="system-ui, sans-serif"` +
    ` font-size="${fontSize}" font-weight="600" fill="#ffffff">${label}</text></svg>`;
  return { label, size, color, url: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) };
}
