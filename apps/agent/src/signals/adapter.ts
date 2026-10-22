/**
 * THE signal adapter. Every wake-up in Switchboard goes through `SignalRouter`,
 * and the only thing that differs between SIGNAL_BACKEND=harness and
 * SIGNAL_BACKEND=app is which `SignalBackend` it is handed (see createBackend).
 *
 * Responsibilities kept here (app code, deliberately small):
 *  - apply the wake rules (`planWake` in @switchboard/core)
 *  - debounce staff field edits into one queued message
 *  - mirror every delivery into `signals_log`
 *  - re-deliver events left unprocessed by a crash
 */
import { planWake, type PendingEdit } from '@switchboard/core';
import { getDeskByHire, getHireById, markEventsProcessed, schema as s, unprocessedEvents, type Db } from '@switchboard/db';
import { inArray } from 'drizzle-orm';
import { EditDebouncer } from './debounce';
import { renderEvent } from './render';
import type { Delivery, DeliveryResult, DeliveryTarget, SignalBackend } from './types';

export class SignalRouter {
  private debouncer: EditDebouncer;
  private inflight = new Map<string, number>();

  constructor(
    private readonly deps: { db: Db; backend: SignalBackend; debounceMs: number },
  ) {
    this.debouncer = new EditDebouncer(deps.debounceMs, (edit) => this.flushEdit(edit));
  }

  get backend(): SignalBackend {
    return this.deps.backend;
  }

  async target(hireId: string): Promise<DeliveryTarget> {
    const [hire, desk] = await Promise.all([getHireById(this.deps.db, hireId), getDeskByHire(this.deps.db, hireId)]);
    if (!hire || !desk) throw new Error(`no desk for hire ${hireId}`);
    return { hireId, hireRef: hire.ref, desk };
  }

  /** Route one app event to its desk. Agent-authored events never wake anyone. */
  async route(event: s.DbEvent): Promise<DeliveryResult | { outcome: 'skipped'; reason: string } | { outcome: 'debounced' }> {
    const plan = planWake({ type: event.type, source: event.source, payload: event.payload as Record<string, unknown> });
    if (!plan.deliver) {
      await markEventsProcessed(this.deps.db, [event.id]);
      return { outcome: 'skipped', reason: plan.reason };
    }
    const t = await this.target(event.hireId);
    if (plan.debounceMs !== undefined && this.deps.debounceMs > 0) {
      const p = event.payload as { fromVersion: number; toVersion: number; fields: string[]; summary: string };
      this.debouncer.add({ hireId: event.hireId, fromVersion: p.fromVersion, toVersion: p.toVersion, fields: p.fields, summaries: [p.summary], eventIds: [event.id] });
      return { outcome: 'debounced' };
    }
    const signal = renderEvent(event, t.hireRef, plan);
    return this.send({ target: t, kind: plan.kind, ifActive: plan.ifActive, ifIdle: plan.ifIdle, signal, eventIds: [event.id] });
  }

  private async flushEdit(edit: PendingEdit): Promise<void> {
    const t = await this.target(edit.hireId);
    const [first] = await this.deps.db.select().from(s.events).where(inArray(s.events.id, edit.eventIds)).limit(1);
    if (!first) return;
    const plan = planWake({ type: 'hire.updated', source: first.source, payload: first.payload as Record<string, unknown> });
    if (!plan.deliver) return;
    const merged = {
      ...first,
      payload: { ...(first.payload as object), fromVersion: edit.fromVersion, toVersion: edit.toVersion, fields: edit.fields, summary: edit.summaries.join('\n') },
    };
    const signal = renderEvent(merged, t.hireRef, plan, edit.eventIds.length > 1 ? { batched: String(edit.eventIds.length), event_ids: edit.eventIds.join(',') } : {});
    await this.send({ target: t, kind: plan.kind, ifActive: plan.ifActive, ifIdle: plan.ifIdle, signal, eventIds: edit.eventIds });
  }

  private async send(d: Delivery): Promise<DeliveryResult> {
    this.inflight.set(d.target.hireId, (this.inflight.get(d.target.hireId) ?? 0) + 1);
    let r: DeliveryResult;
    try {
      r = await this.deps.backend.deliver(d);
    } catch (e) {
      r = { outcome: 'failed', action: `error: ${String(e)}` };
    } finally {
      this.inflight.set(d.target.hireId, (this.inflight.get(d.target.hireId) ?? 1) - 1);
    }
    await this.deps.db.insert(s.signalsLog).values({
      hireId: d.target.hireId,
      eventId: d.eventIds[0] ?? null,
      kind: d.kind,
      outcome: r.outcome,
      backend: this.deps.backend.name,
      tag: d.signal.tag,
      contents: d.signal.contents,
      attributes: d.signal.attributes,
      runId: r.runId ?? null,
      waitsForRunId: r.waitsForRunId ?? null,
      detail: { action: r.action, eventIds: d.eventIds, ifActive: d.ifActive, ifIdle: d.ifIdle },
    });
    await this.deps.db.update(s.desks).set({ lastSignalAt: new Date() }).where(inArray(s.desks.hireId, [d.target.hireId]));
    return r;
  }

  /** After a restart: hand any event that never finished processing back to its desk. Tools make this safe. */
  async redeliverUnprocessed(opts: { skipRunIds?: Set<string> } = {}): Promise<number> {
    const rows = await unprocessedEvents(this.deps.db);
    let n = 0;
    for (const e of rows) {
      if (e.runId && opts.skipRunIds?.has(e.runId)) continue;
      await this.route(e);
      n++;
    }
    return n;
  }

  /** Quiescence for tests and the scenario runner: nothing debounced, delivering, running or queued. */
  async idle(hireId: string, timeoutMs = 20_000): Promise<void> {
    const t0 = Date.now();
    let quietSince = 0;
    while (Date.now() - t0 < timeoutMs) {
      const quiet = !this.debouncer.has(hireId) && (this.inflight.get(hireId) ?? 0) === 0 && this.deps.backend.isIdle(hireId);
      if (quiet) {
        quietSince ||= Date.now();
        if (Date.now() - quietSince > 150) return;
      } else quietSince = 0;
      await new Promise((r) => setTimeout(r, 25));
    }
    const state = { debounced: this.debouncer.has(hireId), inflight: this.inflight.get(hireId) ?? 0, backend: (this.deps.backend as { describe?: (h: string) => unknown }).describe?.(hireId) };
    throw new Error(`desk for ${hireId} did not go idle within ${timeoutMs}ms: ${JSON.stringify(state)}`);
  }

  /** True while an edit for this hire waits in the debounce window or a delivery is in flight. */
  busy(hireId: string): boolean {
    return this.debouncer.has(hireId) || (this.inflight.get(hireId) ?? 0) > 0;
  }

  /** Deliver a hire's debounced edits now instead of waiting out the window. */
  async flushEdits(hireId: string): Promise<boolean> {
    return this.debouncer.flushNow(hireId);
  }

  /** Scenario reset: drop pending edits and in-flight counters. */
  clear(): void {
    this.debouncer.clear();
    this.inflight.clear();
  }

  async stop(): Promise<void> {
    await this.debouncer.flushAll();
  }
}
