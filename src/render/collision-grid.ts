/** Exact AABB collision broad phase; large boxes stay in a bounded overflow list. */
export interface CollisionBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const CELL = 64;
const MAX_CELLS = 256;

export class CollisionGrid {
  private readonly cells = new Map<string, number[]>();
  private readonly boxes: CollisionBox[] = [];
  private readonly oversized: number[] = [];

  private range(box: CollisionBox) {
    const x0 = Math.floor(box.x0 / CELL),
      y0 = Math.floor(box.y0 / CELL);
    const x1 = Math.floor(box.x1 / CELL),
      y1 = Math.floor(box.y1 / CELL);
    return { x0, y0, x1, y1, count: (x1 - x0 + 1) * (y1 - y0 + 1) };
  }

  overlaps(box: CollisionBox): boolean {
    const intersects = (index: number): boolean => {
      const other = this.boxes[index]!;
      return !(
        box.x1 <= other.x0 ||
        box.x0 >= other.x1 ||
        box.y1 <= other.y0 ||
        box.y0 >= other.y1
      );
    };
    const range = this.range(box);
    if (range.count > MAX_CELLS) return this.boxes.some((_, i) => intersects(i));
    if (this.oversized.some(intersects)) return true;
    const seen = new Set<number>();
    for (let y = range.y0; y <= range.y1; y++)
      for (let x = range.x0; x <= range.x1; x++) {
        const indices = this.cells.get(`${x},${y}`);
        if (!indices) continue;
        for (const index of indices) {
          if (seen.has(index)) continue;
          seen.add(index);
          if (intersects(index)) return true;
        }
      }
    return false;
  }

  add(box: CollisionBox): void {
    const index = this.boxes.length;
    this.boxes.push(box);
    const range = this.range(box);
    if (range.count > MAX_CELLS) {
      this.oversized.push(index);
      return;
    }
    for (let y = range.y0; y <= range.y1; y++)
      for (let x = range.x0; x <= range.x1; x++) {
        const key = `${x},${y}`;
        let indices = this.cells.get(key);
        if (!indices) {
          indices = [];
          this.cells.set(key, indices);
        }
        indices.push(index);
      }
  }
}
