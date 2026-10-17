/** Immutable AABB hierarchy over flat bounds. Used for topology and spatial blocks. */
export class BoundsTree {
  private readonly boxes: Float64Array;
  private readonly order: Uint32Array;
  private readonly bounds: Float64Array;
  private readonly links: Int32Array;
  private used = 0;

  constructor(boxes: Float64Array) {
    this.boxes = boxes;
    const count = boxes.length / 4;
    this.order = Uint32Array.from({ length: count }, (_, i) => i);
    this.bounds = new Float64Array(Math.max(1, count * 2) * 4);
    this.links = new Int32Array(Math.max(1, count * 2) * 4).fill(-1);
    if (count > 0) this.build(0, count);
  }

  private build(start: number, end: number): number {
    const node = this.used++,
      at = node * 4;
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (let i = start; i < end; i++) {
      const box = this.order[i]! * 4;
      minX = Math.min(minX, this.boxes[box]!);
      minY = Math.min(minY, this.boxes[box + 1]!);
      maxX = Math.max(maxX, this.boxes[box + 2]!);
      maxY = Math.max(maxY, this.boxes[box + 3]!);
    }
    this.bounds.set([minX, minY, maxX, maxY], at);
    if (end - start <= 16) {
      this.links[at + 2] = start;
      this.links[at + 3] = end;
      return node;
    }
    const axis = maxX - minX >= maxY - minY ? 0 : 1;
    this.order
      .subarray(start, end)
      .sort(
        (a, b) =>
          this.boxes[a * 4 + axis]! +
            this.boxes[a * 4 + axis + 2]! -
            this.boxes[b * 4 + axis]! -
            this.boxes[b * 4 + axis + 2]! || a - b,
      );
    const mid = (start + end) >>> 1;
    this.links[at] = this.build(start, mid);
    this.links[at + 1] = this.build(mid, end);
    return node;
  }

  /** Returning false from a visitor stops the traversal immediately. */
  query(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
    visit: (index: number) => boolean | void,
  ): boolean {
    if (this.used === 0) return true;
    const walk = (node: number): boolean => {
      const at = node * 4;
      if (
        this.bounds[at]! > maxX ||
        this.bounds[at + 1]! > maxY ||
        this.bounds[at + 2]! < minX ||
        this.bounds[at + 3]! < minY
      )
        return true;
      if (this.links[at]! >= 0) return walk(this.links[at]!) && walk(this.links[at + 1]!);
      for (let i = this.links[at + 2]!; i < this.links[at + 3]!; i++) {
        const index = this.order[i]!,
          box = index * 4;
        if (
          this.boxes[box]! <= maxX &&
          this.boxes[box + 1]! <= maxY &&
          this.boxes[box + 2]! >= minX &&
          this.boxes[box + 3]! >= minY &&
          visit(index) === false
        )
          return false;
      }
      return true;
    };
    return walk(0);
  }
}
