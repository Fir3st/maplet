/** Persistent expansion for WebGL profiles without wide element indices. */
import { FILL_STRIDE, type PlanBatch } from './frame-plan.ts';

export class ExpandedFill {
  private readonly indices: Uint32Array;
  private readonly data: Float32Array;
  private readonly offsets: Uint32Array;
  private readonly rows: Uint32Array;
  private version = -1;
  private upload: PlanBatch['upload'];

  constructor(batch: PlanBatch) {
    this.indices = batch.indices!;
    this.data = new Float32Array(this.indices.length * FILL_STRIDE);
    const vertices = batch.data.length / FILL_STRIDE;
    this.offsets = new Uint32Array(vertices + 1);
    for (const vertex of this.indices) this.offsets[vertex + 1]!++;
    for (let i = 1; i <= vertices; i++) this.offsets[i]! += this.offsets[i - 1]!;
    this.rows = new Uint32Array(this.indices.length);
    const cursor = this.offsets.slice();
    this.indices.forEach((vertex, row) => { this.rows[cursor[vertex]!] = row; cursor[vertex]!++; });
    this.update(batch);
  }

  private update(batch: PlanBatch): void {
    const version = batch.upload?.version ?? 0;
    if (version === this.version) return;
    const write = (row: number) => {
      const start = this.indices[row]! * FILL_STRIDE;
      this.data.set(batch.data.subarray(start, start + FILL_STRIDE), row * FILL_STRIDE);
    };
    if (batch.upload && this.version >= 0 && this.version === batch.upload.previousVersion) {
      const changed: number[] = [];
      for (const range of batch.upload.ranges) {
        for (let vertex = range.start / FILL_STRIDE; vertex < range.end / FILL_STRIDE; vertex++) {
          for (let at = this.offsets[vertex]!; at < this.offsets[vertex + 1]!; at++) { const row = this.rows[at]!; write(row); changed.push(row); }
        }
      }
      changed.sort((a, b) => a - b);
      const ranges: { start: number; end: number }[] = [];
      for (const row of changed) {
        const start = row * FILL_STRIDE, last = ranges[ranges.length - 1];
        if (last && start <= last.end) last.end = Math.max(last.end, start + FILL_STRIDE);
        else ranges.push({ start, end: start + FILL_STRIDE });
      }
      this.upload = { version, previousVersion: this.version, ranges };
    } else {
      for (let row = 0; row < this.indices.length; row++) write(row);
      this.upload = { version, previousVersion: -1, ranges: [] };
    }
    this.version = version;
  }

  batch(batch: PlanBatch): PlanBatch {
    this.update(batch);
    const { indices: _indices, upload: _upload, ...rest } = batch;
    return { ...rest, data: this.data, count: this.indices.length, upload: this.upload! };
  }
}
