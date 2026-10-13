import test from 'node:test';
import assert from 'node:assert/strict';
import { CollisionGrid, type CollisionBox } from '../../src/render/collision-grid.ts';

test('indexed collisions match a linear oracle including touching, negative and oversized boxes', () => {
  const grid = new CollisionGrid(), accepted: CollisionBox[] = [];
  let seed = 71;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const inputs: CollisionBox[] = [{ x0: -10000, y0: -1, x1: 10000, y1: 1 }, { x0: 1, y0: 1, x1: 2, y1: 2 }];
  for (let i = 0; i < 10000; i++) {
    const x = random() * 10000 - 5000, y = random() * 10000 - 5000;
    inputs.push({ x0: x, y0: y, x1: x + random() * 120, y1: y + random() * 60 });
  }
  for (const box of inputs) {
    const expected = accepted.some((other) => !(box.x1 <= other.x0 || box.x0 >= other.x1 || box.y1 <= other.y0 || box.y0 >= other.y1));
    assert.equal(grid.overlaps(box), expected);
    if (!expected) { grid.add(box); accepted.push(box); }
  }
});
