/** Bounded, independently readable invalidation history (no per-render consumer). */
export class ChangeJournal<T> {
  private readonly entries: T[] = [];
  private epochValue = 0;
  private readonly capacity = 4096;

  get epoch(): number { return this.epochValue; }

  note(value: T): void {
    this.entries[this.epochValue % this.capacity] = value;
    this.epochValue++;
  }

  /** null means the reader fell behind: rebuild instead of losing changes. */
  since(epoch: number): readonly T[] | null {
    if (epoch < this.epochValue - this.capacity) return null;
    const changes: T[] = [];
    for (let i = epoch; i < this.epochValue; i++) changes.push(this.entries[i % this.capacity]!);
    return changes;
  }
}
