import test from 'node:test';
import assert from 'node:assert/strict';
import { SlotTable } from '../../src/scene/slot-table.ts';

test('canonical pages preserve row values and altitude presence across page boundaries', () => {
  const table = new SlotTable();
  for (let i = 0; i < 1600; i++) {
    table.setPoint(i, `k:${i}`, i, i / 2, -i, i === 511 ? NaN : i === 512 ? Infinity : undefined, { i });
  }
  assert.equal(table.length, 1600);
  assert.equal(table.get(1600), undefined);
  assert.equal(table.get(-1), undefined);
  for (const record of table) {
    assert.equal(record.key, `k:${record.slot}`);
    assert.equal(record.id, record.slot);
    assert.equal(record.wx, record.slot / 2);
    assert.equal(record.wy, -record.slot);
    assert.deepEqual(record.properties, { i: record.slot });
    assert.equal(record.generation, 1);
  }
  assert.ok(Number.isNaN(table.get(511)!.alt));
  assert.equal(table.get(512)!.alt, Infinity);
  assert.equal(table.get(513)!.alt, undefined);
});

test('undo snapshots do not alias recycled page rows', () => {
  const table = new SlotTable();
  table.setPoint(512, 'old', 'old', 1, 2, undefined, { value: 1 });
  const old = table.snapshot(512)!;
  table.delete(512);
  assert.equal(table.get(512), undefined);
  table.set(512, { ...old, key: 'new', id: 42, namespace: 'n', generation: 7, wx: 9, properties: { value: 2 } });
  assert.equal(old.id, 'old');
  assert.equal(old.wx, 1);
  assert.equal(old.generation, 1);
  assert.deepEqual(old.properties, { value: 1 });
  table.set(512, old);
  assert.deepEqual(table.snapshot(512), old);
  assert.equal([...table].length, 1);
});

test('owned point pools are paged without a second coordinate copy and can extend their final page', () => {
  const positions = new Float64Array(1026);
  positions[0] = 12; positions[1024] = 34;
  const table = new SlotTable(positions);
  for (let i = 0; i < 513; i++) table.setPoint(i, `k:${i}`, i, positions[i * 2]!, positions[i * 2 + 1]!, undefined, {});
  table.get(0)!.wx = 56;
  assert.equal(positions[0], 56, 'full pages adopt the owned pool');
  table.setPoint(600, 'last', 'last', 78, 90, undefined, {});
  assert.equal(table.get(512)!.wx, 34);
  assert.equal(table.get(600)!.wx, 78);
  assert.equal(table.get(600)!.wy, 90);
});
