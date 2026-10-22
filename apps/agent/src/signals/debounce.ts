import { mergeEdits, type PendingEdit } from '@switchboard/core';

/**
 * App-side debounce for staff field edits (the "one file" of glue the plan
 * allows). Edits to one hire within `ms` collapse into one queued message.
 */
export class EditDebouncer {
  private pending = new Map<string, { edit: PendingEdit; timer: NodeJS.Timeout }>();

  constructor(
    private readonly ms: number,
    private readonly flush: (edit: PendingEdit) => Promise<void>,
  ) {}

  add(edit: PendingEdit): void {
    const cur = this.pending.get(edit.hireId);
    if (cur) clearTimeout(cur.timer);
    const merged = mergeEdits(cur?.edit, edit);
    const timer = setTimeout(() => {
      this.pending.delete(edit.hireId);
      void this.flush(merged).catch((e: unknown) => console.error('[debounce] flush failed', e));
    }, this.ms);
    this.pending.set(edit.hireId, { edit: merged, timer });
  }

  has(hireId: string): boolean {
    return this.pending.has(hireId);
  }

  /** Deliver one hire's pending edits now (the scenario runner uses this to land Jo's edit mid-run). */
  async flushNow(hireId: string): Promise<boolean> {
    const p = this.pending.get(hireId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(hireId);
    await this.flush(p.edit);
    return true;
  }

  /** Drop everything pending without delivering it (scenario reset). */
  clear(): void {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  async flushAll(): Promise<void> {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) {
      clearTimeout(p.timer);
      await this.flush(p.edit);
    }
  }
}
