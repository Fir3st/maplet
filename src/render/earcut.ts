/**
 * XY-only TypeScript adaptation of Earcut 3.0.2 (Mapbox, ISC).
 * https://github.com/mapbox/earcut/tree/v3.0.2 — license in NOTICE.
 * Retains linked-ring and Morton-index algorithms; omits unused public helpers.
 */
class RingNode {
  readonly i: number;
  readonly x: number;
  readonly y: number;
  prev: RingNode = this;
  next: RingNode = this;
  z = 0;
  prevZ: RingNode | null = null;
  nextZ: RingNode | null = null;
  steiner = false;
  constructor(i: number, x: number, y: number) { this.i = i; this.x = x; this.y = y; }
}

export function earcut(data: ArrayLike<number>, holes: readonly number[] = []): number[] {
  const outerEnd = holes.length ? holes[0]! * 2 : data.length;
  let outer = linkedList(data, 0, outerEnd, true);
  const triangles: number[] = [];
  if (!outer || outer.next === outer.prev) return triangles;
  if (holes.length) outer = eliminateHoles(data, holes, outer);
  let minX = 0, minY = 0, invSize = 0;
  if (data.length > 160) {
    minX = data[0]!; minY = data[1]!;
    let maxX = minX, maxY = minY;
    for (let i = 2; i < outerEnd; i += 2) {
      minX = Math.min(minX, data[i]!); minY = Math.min(minY, data[i + 1]!);
      maxX = Math.max(maxX, data[i]!); maxY = Math.max(maxY, data[i + 1]!);
    }
    invSize = Math.max(maxX - minX, maxY - minY);
    invSize = invSize !== 0 ? 32767 / invSize : 0;
  }
  earcutLinked(outer, triangles, minX, minY, invSize, 0);
  return triangles;
}

function linkedList(data: ArrayLike<number>, start: number, end: number, clockwise: boolean): RingNode | null {
  let last: RingNode | null = null, sum = 0;
  for (let i = start, j = end - 2; i < end; i += 2) {
    sum += (data[j]! - data[i]!) * (data[i + 1]! + data[j + 1]!); j = i;
  }
  if (clockwise === (sum > 0)) {
    for (let i = start; i < end; i += 2) last = insertNode(i / 2, data[i]!, data[i + 1]!, last);
  } else {
    for (let i = end - 2; i >= start; i -= 2) last = insertNode(i / 2, data[i]!, data[i + 1]!, last);
  }
  if (last && equals(last, last.next)) { removeNode(last); last = last.next; }
  return last;
}

function filterPoints(start: RingNode, end: RingNode = start): RingNode {
  let p = start, again: boolean;
  do {
    again = false;
    if (!p.steiner && (equals(p, p.next) || area(p.prev, p, p.next) === 0)) {
      removeNode(p); p = end = p.prev;
      if (p === p.next) break;
      again = true;
    } else p = p.next;
  } while (again || p !== end);
  return end;
}

function earcutLinked(ear: RingNode, triangles: number[], minX: number, minY: number, invSize: number, pass: number): void {
  if (!pass && invSize) indexCurve(ear, minX, minY, invSize);
  let stop = ear;
  while (ear.prev !== ear.next) {
    const prev = ear.prev, next = ear.next;
    if (invSize ? isEarHashed(ear, minX, minY, invSize) : isEar(ear)) {
      triangles.push(prev.i, ear.i, next.i);
      removeNode(ear); ear = next.next; stop = next.next;
      continue;
    }
    ear = next;
    if (ear === stop) {
      if (!pass) earcutLinked(filterPoints(ear), triangles, minX, minY, invSize, 1);
      else if (pass === 1) earcutLinked(cureLocalIntersections(filterPoints(ear), triangles), triangles, minX, minY, invSize, 2);
      else if (pass === 2) splitEarcut(ear, triangles, minX, minY, invSize);
      break;
    }
  }
}

function isEar(ear: RingNode): boolean {
  const a = ear.prev, b = ear, c = ear.next;
  if (area(a, b, c) >= 0) return false;
  const x0 = Math.min(a.x, b.x, c.x), y0 = Math.min(a.y, b.y, c.y);
  const x1 = Math.max(a.x, b.x, c.x), y1 = Math.max(a.y, b.y, c.y);
  let p = c.next;
  while (p !== a) {
    if (p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 &&
      pointInTriangleExceptFirst(a, b, c, p) && area(p.prev, p, p.next) >= 0) return false;
    p = p.next;
  }
  return true;
}

function isEarHashed(ear: RingNode, minX: number, minY: number, invSize: number): boolean {
  const a = ear.prev, b = ear, c = ear.next;
  if (area(a, b, c) >= 0) return false;
  const x0 = Math.min(a.x, b.x, c.x), y0 = Math.min(a.y, b.y, c.y);
  const x1 = Math.max(a.x, b.x, c.x), y1 = Math.max(a.y, b.y, c.y);
  const minZ = zOrder(x0, y0, minX, minY, invSize), maxZ = zOrder(x1, y1, minX, minY, invSize);
  const contains = (p: RingNode): boolean => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1 && p !== a && p !== c &&
    pointInTriangleExceptFirst(a, b, c, p) && area(p.prev, p, p.next) >= 0;
  let p = ear.prevZ, n = ear.nextZ;
  while (p && p.z >= minZ && n && n.z <= maxZ) {
    if (contains(p)) return false;
    p = p.prevZ;
    if (contains(n)) return false;
    n = n.nextZ;
  }
  while (p && p.z >= minZ) { if (contains(p)) return false; p = p.prevZ; }
  while (n && n.z <= maxZ) { if (contains(n)) return false; n = n.nextZ; }
  return true;
}

function cureLocalIntersections(start: RingNode, triangles: number[]): RingNode {
  let p = start;
  do {
    const a = p.prev, b = p.next.next;
    if (!equals(a, b) && intersects(a, p, p.next, b) && locallyInside(a, b) && locallyInside(b, a)) {
      triangles.push(a.i, p.i, b.i); removeNode(p); removeNode(p.next); p = start = b;
    }
    p = p.next;
  } while (p !== start);
  return filterPoints(p);
}

function splitEarcut(start: RingNode, triangles: number[], minX: number, minY: number, invSize: number): void {
  let a = start;
  do {
    let b = a.next.next;
    while (b !== a.prev) {
      if (a.i !== b.i && isValidDiagonal(a, b)) {
        let c = splitPolygon(a, b);
        a = filterPoints(a, a.next); c = filterPoints(c, c.next);
        earcutLinked(a, triangles, minX, minY, invSize, 0); earcutLinked(c, triangles, minX, minY, invSize, 0);
        return;
      }
      b = b.next;
    }
    a = a.next;
  } while (a !== start);
}

function eliminateHoles(data: ArrayLike<number>, holes: readonly number[], outer: RingNode): RingNode {
  const queue: RingNode[] = [];
  for (let i = 0; i < holes.length; i++) {
    const list = linkedList(data, holes[i]! * 2, i < holes.length - 1 ? holes[i + 1]! * 2 : data.length, false)!;
    if (list === list.next) list.steiner = true;
    queue.push(getLeftmost(list));
  }
  queue.sort((a, b) => a.x - b.x || a.y - b.y || (a.next.y - a.y) / (a.next.x - a.x) - (b.next.y - b.y) / (b.next.x - b.x));
  for (const hole of queue) {
    const bridge = findHoleBridge(hole, outer);
    if (!bridge) continue;
    const reverse = splitPolygon(bridge, hole);
    filterPoints(reverse, reverse.next); outer = filterPoints(bridge, bridge.next);
  }
  return outer;
}

function findHoleBridge(hole: RingNode, outer: RingNode): RingNode | null {
  let p = outer, qx = -Infinity, m: RingNode | null = null;
  const hx = hole.x, hy = hole.y;
  if (equals(hole, p)) return p;
  do {
    if (equals(hole, p.next)) return p.next;
    if (hy <= p.y && hy >= p.next.y && p.next.y !== p.y) {
      const x = p.x + (hy - p.y) * (p.next.x - p.x) / (p.next.y - p.y);
      if (x <= hx && x > qx) { qx = x; m = p.x < p.next.x ? p : p.next; if (x === hx) return m; }
    }
    p = p.next;
  } while (p !== outer);
  if (!m) return null;
  const stop = m, mx = m.x, my = m.y;
  let tanMin = Infinity;
  p = m;
  do {
    if (hx >= p.x && p.x >= mx && hx !== p.x &&
      pointInTriangle(hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, p.x, p.y)) {
      const tan = Math.abs(hy - p.y) / (hx - p.x);
      if (locallyInside(p, hole) && (tan < tanMin || tan === tanMin &&
        (p.x > m.x || p.x === m.x && area(m.prev, m, p.prev) < 0 && area(p.next, m, m.next) < 0))) { m = p; tanMin = tan; }
    }
    p = p.next;
  } while (p !== stop);
  return m;
}

function indexCurve(start: RingNode, minX: number, minY: number, invSize: number): void {
  let p = start;
  do {
    if (p.z === 0) p.z = zOrder(p.x, p.y, minX, minY, invSize);
    p.prevZ = p.prev; p.nextZ = p.next; p = p.next;
  } while (p !== start);
  p.prevZ!.nextZ = null; p.prevZ = null;
  sortLinked(p);
}

function sortLinked(list: RingNode | null): void {
  let inSize = 1, merges: number;
  do {
    let p = list, tail: RingNode | null = null;
    list = null; merges = 0;
    while (p) {
      merges++;
      let q: RingNode | null = p, pSize = 0;
      for (let i = 0; i < inSize; i++) { pSize++; q = q!.nextZ; if (!q) break; }
      let qSize = inSize;
      while (pSize > 0 || qSize > 0 && q) {
        let e: RingNode;
        if (pSize !== 0 && (qSize === 0 || !q || p!.z <= q.z)) { e = p!; p = p!.nextZ; pSize--; }
        else { e = q!; q = q!.nextZ; qSize--; }
        if (tail) tail.nextZ = e; else list = e;
        e.prevZ = tail; tail = e;
      }
      p = q;
    }
    tail!.nextZ = null; inSize *= 2;
  } while (merges > 1);
}

function zOrder(x: number, y: number, minX: number, minY: number, invSize: number): number {
  x = (x - minX) * invSize | 0; y = (y - minY) * invSize | 0;
  x = (x | x << 8) & 0x00FF00FF; x = (x | x << 4) & 0x0F0F0F0F; x = (x | x << 2) & 0x33333333; x = (x | x << 1) & 0x55555555;
  y = (y | y << 8) & 0x00FF00FF; y = (y | y << 4) & 0x0F0F0F0F; y = (y | y << 2) & 0x33333333; y = (y | y << 1) & 0x55555555;
  return x | y << 1;
}

function getLeftmost(start: RingNode): RingNode {
  let p = start, leftmost = start;
  do { if (p.x < leftmost.x || p.x === leftmost.x && p.y < leftmost.y) leftmost = p; p = p.next; } while (p !== start);
  return leftmost;
}

function pointInTriangle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, px: number, py: number): boolean {
  return (cx - px) * (ay - py) >= (ax - px) * (cy - py) && (ax - px) * (by - py) >= (bx - px) * (ay - py) && (bx - px) * (cy - py) >= (cx - px) * (by - py);
}
function pointInTriangleExceptFirst(a: RingNode, b: RingNode, c: RingNode, p: RingNode): boolean {
  return !equals(a, p) && pointInTriangle(a.x, a.y, b.x, b.y, c.x, c.y, p.x, p.y);
}
function isValidDiagonal(a: RingNode, b: RingNode): boolean {
  return a.next.i !== b.i && a.prev.i !== b.i && !intersectsPolygon(a, b) &&
    (locallyInside(a, b) && locallyInside(b, a) && middleInside(a, b) && !!(area(a.prev, a, b.prev) || area(a, b.prev, b)) ||
      equals(a, b) && area(a.prev, a, a.next) > 0 && area(b.prev, b, b.next) > 0);
}
function area(p: RingNode, q: RingNode, r: RingNode): number { return (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y); }
function equals(a: RingNode, b: RingNode): boolean { return a.x === b.x && a.y === b.y; }
function onSegment(p: RingNode, q: RingNode, r: RingNode): boolean { return q.x <= Math.max(p.x, r.x) && q.x >= Math.min(p.x, r.x) && q.y <= Math.max(p.y, r.y) && q.y >= Math.min(p.y, r.y); }
function intersects(p1: RingNode, q1: RingNode, p2: RingNode, q2: RingNode): boolean {
  const o1 = Math.sign(area(p1, q1, p2)), o2 = Math.sign(area(p1, q1, q2)), o3 = Math.sign(area(p2, q2, p1)), o4 = Math.sign(area(p2, q2, q1));
  return o1 !== o2 && o3 !== o4 || o1 === 0 && onSegment(p1, p2, q1) || o2 === 0 && onSegment(p1, q2, q1) || o3 === 0 && onSegment(p2, p1, q2) || o4 === 0 && onSegment(p2, q1, q2);
}
function intersectsPolygon(a: RingNode, b: RingNode): boolean {
  let p = a;
  do { if (p.i !== a.i && p.next.i !== a.i && p.i !== b.i && p.next.i !== b.i && intersects(p, p.next, a, b)) return true; p = p.next; } while (p !== a);
  return false;
}
function locallyInside(a: RingNode, b: RingNode): boolean { return area(a.prev, a, a.next) < 0 ? area(a, b, a.next) >= 0 && area(a, a.prev, b) >= 0 : area(a, b, a.prev) < 0 || area(a, a.next, b) < 0; }
function middleInside(a: RingNode, b: RingNode): boolean {
  let p = a, inside = false;
  const px = (a.x + b.x) / 2, py = (a.y + b.y) / 2;
  do { if ((p.y > py) !== (p.next.y > py) && p.next.y !== p.y && px < (p.next.x - p.x) * (py - p.y) / (p.next.y - p.y) + p.x) inside = !inside; p = p.next; } while (p !== a);
  return inside;
}
function splitPolygon(a: RingNode, b: RingNode): RingNode {
  const a2 = new RingNode(a.i, a.x, a.y), b2 = new RingNode(b.i, b.x, b.y), an = a.next, bp = b.prev;
  a.next = b; b.prev = a; a2.next = an; an.prev = a2; b2.next = a2; a2.prev = b2; bp.next = b2; b2.prev = bp;
  return b2;
}
function insertNode(i: number, x: number, y: number, last: RingNode | null): RingNode {
  const p = new RingNode(i, x, y);
  if (last) { p.next = last.next; p.prev = last; last.next.prev = p; last.next = p; }
  return p;
}
function removeNode(p: RingNode): void {
  p.next.prev = p.prev; p.prev.next = p.next;
  if (p.prevZ) p.prevZ.nextZ = p.nextZ;
  if (p.nextZ) p.nextZ.prevZ = p.prevZ;
}
