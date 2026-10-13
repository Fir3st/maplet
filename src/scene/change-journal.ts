/** Bounded, independently readable invalidation history (no per-render consumer). */
export class ChangeJournal<T> {
  private readonly entries: T[] = [];
  private epochValue = 0;
  private invalidatedAt = 0;
  private readonly capacity = 4096;

  get epoch(): number { return this.epochValue; }

  note(value: T): void {
    this.entries[this.epochValue % this.capacity] = value;
    this.epochValue++;
  }

  /** A whole-set change cannot be represented by a few individual entries. */
  invalidate(): void {
    this.invalidatedAt = ++this.epochValue;
    this.entries.length = 0;
  }

  /** null means the reader fell behind: rebuild instead of losing changes. */
  since(epoch: number): readonly T[] | null {
    if (epoch < this.invalidatedAt || epoch < this.epochValue - this.capacity) return null;
    const changes: T[] = [];
    for (let i = epoch; i < this.epochValue; i++) changes.push(this.entries[i % this.capacity]!);
    return changes;
  }
}
