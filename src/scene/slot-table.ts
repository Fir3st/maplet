/** Page-backed canonical fields. Object views are materialized only on access. */
import type { FeatureId } from '../api/types.ts';
import type { GeometryKindCode, PreparedFeatureGeometry } from '../geometry/geometry.ts';
import type { SlotRecord } from './store.ts';

const PAGE_SIZE = 512;

class SlotPage {
  readonly live = new Uint8Array(PAGE_SIZE);
  readonly kinds = new Uint8Array(PAGE_SIZE);
  readonly generations = new Float64Array(PAGE_SIZE);
  readonly positions: Float64Array;
  readonly altitudes = new Float64Array(PAGE_SIZE);
  readonly hasAltitude = new Uint8Array(PAGE_SIZE);
  readonly ids: (FeatureId | undefined)[] = new Array(PAGE_SIZE);
  readonly keys: (string | undefined)[] = new Array(PAGE_SIZE);
  readonly namespaces: (string | undefined)[] = new Array(PAGE_SIZE);
  readonly geometries: (PreparedFeatureGeometry | null | undefined)[] = new Array(PAGE_SIZE);
  readonly properties: (Readonly<Record<string, unknown>> | undefined)[] = new Array(PAGE_SIZE);
  readonly views: (SlotView | undefined)[] = new Array(PAGE_SIZE);

  constructor(positions: Float64Array = new Float64Array(PAGE_SIZE * 2)) {
    this.positions = positions;
  }
}

class SlotView implements SlotRecord {
  readonly slot: number;
  private readonly page: SlotPage;
  private readonly row: number;
  constructor(slot: number, page: SlotPage, row: number) {
    this.slot = slot;
    this.page = page;
    this.row = row;
  }
  get key(): string { return this.page.keys[this.row]!; }
  get id(): FeatureId { return this.page.ids[this.row]!; }
  get namespace(): string | undefined { return this.page.namespaces[this.row]; }
  get generation(): number { return this.page.generations[this.row]!; }
  set generation(value: number) { this.page.generations[this.row] = value; }
  get kind(): GeometryKindCode { return this.page.kinds[this.row] as GeometryKindCode; }
  set kind(value: GeometryKindCode) { this.page.kinds[this.row] = value; }
  get wx(): number { return this.page.positions[this.row * 2]!; }
  set wx(value: number) { this.page.positions[this.row * 2] = value; }
  get wy(): number { return this.page.positions[this.row * 2 + 1]!; }
  set wy(value: number) { this.page.positions[this.row * 2 + 1] = value; }
  get alt(): number | undefined { return this.page.hasAltitude[this.row] ? this.page.altitudes[this.row] : undefined; }
  set alt(value: number | undefined) {
    this.page.hasAltitude[this.row] = value === undefined ? 0 : 1;
    if (value !== undefined) this.page.altitudes[this.row] = value;
  }
  get geometry(): PreparedFeatureGeometry | null { return this.page.geometries[this.row] ?? null; }
  set geometry(value: PreparedFeatureGeometry | null) { this.page.geometries[this.row] = value; }
  get properties(): Readonly<Record<string, unknown>> { return this.page.properties[this.row]!; }
  set properties(value: Readonly<Record<string, unknown>>) { this.page.properties[this.row] = value; }
}

export class SlotTable {
  private readonly pages: SlotPage[] = [];
  private lengthValue = 0;

  /** Adopt an owned projected pool instead of allocating/copying it a second time. */
  constructor(pointPositions?: Float64Array) {
    if (!pointPositions) return;
    for (let start = 0; start < pointPositions.length; start += PAGE_SIZE * 2) {
      const slice = pointPositions.subarray(start, start + PAGE_SIZE * 2);
      const positions = slice.length === PAGE_SIZE * 2 ? slice : new Float64Array(PAGE_SIZE * 2);
      if (positions !== slice) positions.set(slice);
      this.pages.push(new SlotPage(positions));
    }
  }

  get length(): number { return this.lengthValue; }

  private pageForWrite(slot: number): SlotPage {
    const index = Math.floor(slot / PAGE_SIZE);
    while (this.pages.length <= index) this.pages.push(new SlotPage());
    this.lengthValue = Math.max(this.lengthValue, slot + 1);
    return this.pages[index]!;
  }

  get(slot: number): SlotRecord | undefined {
    if (slot < 0 || slot >= this.lengthValue) return undefined;
    const page = this.pages[Math.floor(slot / PAGE_SIZE)]!;
    const row = slot % PAGE_SIZE;
    if (!page.live[row]) return undefined;
    return page.views[row] ?? (page.views[row] = new SlotView(slot, page, row));
  }

  /** Reject off-rectangle points before allocating their object view. */
  getInRect(slot: number, minX: number, minY: number, maxX: number, maxY: number): SlotRecord | undefined {
    if (slot < 0 || slot >= this.lengthValue) return undefined;
    const page = this.pages[Math.floor(slot / PAGE_SIZE)]!;
    const row = slot % PAGE_SIZE;
    if (!page.live[row]) return undefined;
    if (!page.geometries[row]) {
      const x = page.positions[row * 2]!, y = page.positions[row * 2 + 1]!;
      if (x < minX || x > maxX || y < minY || y > maxY) return undefined;
    }
    return page.views[row] ?? (page.views[row] = new SlotView(slot, page, row));
  }

  /** Removal/replacement undo owns values, not a view of a recyclable row. */
  snapshot(slot: number): SlotRecord | undefined {
    const record = this.get(slot);
    return record ? {
      slot, key: record.key, id: record.id, namespace: record.namespace,
      generation: record.generation, kind: record.kind, wx: record.wx,
      wy: record.wy, alt: record.alt, geometry: record.geometry,
      properties: record.properties,
    } : undefined;
  }

  set(slot: number, record: SlotRecord): void {
    const page = this.pageForWrite(slot);
    const row = slot % PAGE_SIZE;
    page.live[row] = 1;
    page.ids[row] = record.id;
    page.keys[row] = record.key;
    page.namespaces[row] = record.namespace;
    page.generations[row] = record.generation;
    page.kinds[row] = record.kind;
    page.positions[row * 2] = record.wx;
    page.positions[row * 2 + 1] = record.wy;
    page.hasAltitude[row] = record.alt === undefined ? 0 : 1;
    if (record.alt !== undefined) page.altitudes[row] = record.alt;
    page.geometries[row] = record.geometry;
    page.properties[row] = record.properties;
  }

  /** Direct column adoption avoids allocating a record per imported point. */
  setPoint(slot: number, key: string, id: FeatureId, wx: number, wy: number,
    alt: number | undefined, properties: Readonly<Record<string, unknown>>): void {
    const page = this.pageForWrite(slot);
    const row = slot % PAGE_SIZE;
    page.live[row] = 1;
    page.ids[row] = id;
    page.keys[row] = key;
    page.generations[row] = 1;
    page.kinds[row] = 0;
    page.positions[row * 2] = wx;
    page.positions[row * 2 + 1] = wy;
    page.hasAltitude[row] = alt === undefined ? 0 : 1;
    if (alt !== undefined) page.altitudes[row] = alt;
    page.geometries[row] = null;
    page.properties[row] = properties;
  }

  delete(slot: number): void {
    const page = this.pages[Math.floor(slot / PAGE_SIZE)]!;
    const row = slot % PAGE_SIZE;
    page.live[row] = 0;
    page.ids[row] = undefined;
    page.keys[row] = undefined;
    page.namespaces[row] = undefined;
    page.geometries[row] = undefined;
    page.properties[row] = undefined;
  }

  *[Symbol.iterator](): IterableIterator<SlotRecord> {
    for (let slot = 0; slot < this.lengthValue; slot++) {
      const record = this.get(slot);
      if (record) yield record;
    }
  }
}
