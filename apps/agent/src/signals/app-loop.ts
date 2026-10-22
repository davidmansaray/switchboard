import type { Mastra } from '@mastra/core';
import { Cron } from 'croner';
import { markEventsProcessed, recordEvent, schema as s, setDeskState, type Db } from '@switchboard/db';
import { and, eq, inArray } from 'drizzle-orm';
import type postgres from 'postgres';
import { recordRunEnd, recordRunStart } from './runs';
import { DESK_AGENT_ID } from '../mastra/agents/desk';
import type { Delivery, DeliveryResult, DeliveryTarget, SignalBackend } from './types';

type Item = Delivery;
type DeskQueue = { items: Item[]; persisted: Item[]; running: boolean; runId?: string };

/**
 * Fallback backend (SIGNAL_BACKEND=app): an app-owned event loop, as in Deskhand.
 * One serial queue per desk; each turn drains everything queued into one
 * `agent.generate()` call on the desk thread. No Mastra signals or schedules:
 * cron is croner in-process. Same rendering, same tools, same guarantees.
 *
 * Trade-off (why harness is the default): input never joins a running turn,
 * and the queue lives in this process (events stay unprocessed in the DB, so a
 * restart re-delivers them).
 *
 * Fencing: this backend has no run fencing (Mastra's fence covers durable-agent
 * runs only). The guard instead is a Postgres session advisory lock per desk,
 * held on a reserved connection for the whole turn: a second agent process
 * cannot drain the same desk at the same time, and if this process dies its
 * connection closes and the lock is released by Postgres itself. A process
 * that hangs keeps the lock (no takeover, so no zombie writes either); the
 * ledger's unique (hire_id, action_key) still makes every write exactly-once.
 */
export class AppLoopBackend implements SignalBackend {
  readonly name = 'app' as const;
  private queues = new Map<string, DeskQueue>();
  private crons = new Map<string, Cron>();
  private targets = new Map<string, DeliveryTarget>();

  constructor(
    private readonly deps: {
      db: Db;
      /** Raw client for the per-desk advisory lock (reserved connection per turn). */
      sql?: postgres.Sql;
      mastra: () => Mastra;
      sweepCron: string;
      sweepTimezone: string;
      onDeskChange?: (hireId: string) => void;
    },
  ) {}

  async start(): Promise<void> {}

  private q(hireId: string): DeskQueue {
    let q = this.queues.get(hireId);
    if (!q) {
      q = { items: [], persisted: [], running: false };
      this.queues.set(hireId, q);
    }
    return q;
  }

  async deliver(d: Delivery): Promise<DeliveryResult> {
    const q = this.q(d.target.hireId);
    this.targets.set(d.target.hireId, d.target);
    const active = q.running;
    if ((active && d.ifActive === 'persist') || (!active && d.ifIdle === 'persist')) {
      q.persisted.push(d);
      return { outcome: 'persisted', action: 'persist' };
    }
    q.items.push(d);
    if (active) {
      await this.setState(d.target.hireId, 'queued');
      return { outcome: 'queued', action: 'enqueue', waitsForRunId: q.runId };
    }
    void this.drain(d.target);
    return { outcome: 'delivered', action: 'wake' };
  }

  private async drain(t: DeliveryTarget): Promise<void> {
    const q = this.q(t.hireId);
    if (q.running) return;
    q.running = true;
    let lock: { held: boolean; release: () => Promise<void> } = { held: false, release: async () => {} };
    try {
      // Inside the try: if no connection can be reserved for the lock, the desk must not stay
      // "running" forever (and `void this.drain()` must not reject unhandled).
      lock = await this.lockDesk(t.hireId).catch((e: unknown) => {
        console.error(`[app-loop] could not lock desk ${t.hireRef}; leaving its events unprocessed`, e);
        return lock;
      });
      if (!lock.held) {
        // Another agent process owns this desk right now: leave the events unprocessed for it.
        console.warn(`[app-loop] desk ${t.hireRef} is locked by another process; not draining`);
        q.items = [];
        return;
      }
      while (q.items.length) {
        const batch = [...q.persisted, ...q.items.splice(0)];
        q.persisted = [];
        const runId = `app-${crypto.randomUUID()}`;
        q.runId = runId;
        const eventIds = batch.flatMap((b) => b.eventIds);
        // Stamp the pickup now (the harness does this from the run's input chunks).
        if (eventIds.length) await this.deps.db.update(s.events).set({ runId }).where(inArray(s.events.id, eventIds));
        await this.setState(t.hireId, 'running', runId);
        await recordRunStart(this.deps.db, t.hireId, runId, 'app').catch(() => {});
        const text = batch.map((b) => renderXml(b)).join('\n\n');
        const agent = this.deps.mastra().getAgent(DESK_AGENT_ID);
        try {
          const out = await agent.generate(text, { runId, memory: { thread: t.desk.mastraThreadId, resource: t.desk.resourceId } } as never);
          void out;
          await markEventsProcessed(this.deps.db, eventIds, runId);
          await recordRunEnd(this.deps.db, runId, 'completed').catch(() => {});
        } catch (e) {
          console.error('[app-loop] desk turn failed', t.hireRef, e);
          await recordRunEnd(this.deps.db, runId, 'failed').catch(() => {});
        }
      }
    } finally {
      await lock.release();
      q.runId = undefined;
      try {
        // Idle includes the final database writes, so callers can safely stop/reset afterwards.
        await this.settle(t.hireId);
      } finally {
        q.running = false;
      }
      // A delivery can join while settle() is awaiting the database.
      if (q.items.length) void this.drain(t);
    }
  }

  /** Session advisory lock on a reserved connection: released by Postgres if this process dies. */
  private async lockDesk(hireId: string): Promise<{ held: boolean; release: () => Promise<void> }> {
    const raw = this.deps.sql;
    if (!raw) return { held: true, release: async () => {} };
    const conn = await raw.reserve();
    try {
      const [r] = await conn<{ ok: boolean }[]>`select pg_try_advisory_lock(hashtext('switchboard:desk'), hashtext(${hireId})) as ok`;
      if (!r?.ok) {
        conn.release();
        return { held: false, release: async () => {} };
      }
      return {
        held: true,
        release: async () => {
          await conn`select pg_advisory_unlock(hashtext('switchboard:desk'), hashtext(${hireId}))`.catch(() => {});
          conn.release();
        },
      };
    } catch (e) {
      conn.release();
      throw e;
    }
  }

  private async settle(hireId: string) {
    const pending = await this.deps.db
      .select({ id: s.drafts.id })
      .from(s.drafts)
      .where(and(eq(s.drafts.hireId, hireId), inArray(s.drafts.status, ['pending', 'stale'])))
      .limit(1);
    await this.setState(hireId, pending.length ? 'awaiting_approval' : 'idle', null);
    await setDeskState(this.deps.db, hireId, { currentStep: null });
  }

  /** Scenario reset: drop queued work and cron handles (sweeps are re-created by ensureSweeps). */
  resetState() {
    this.queues.clear();
    for (const c of this.crons.values()) c.stop();
    this.crons.clear();
    this.targets.clear();
  }

  private async setState(hireId: string, runState: s.Desk['runState'], activeRunId?: string | null) {
    await setDeskState(this.deps.db, hireId, { runState, ...(activeRunId !== undefined ? { activeRunId } : {}) });
    this.deps.onDeskChange?.(hireId);
  }

  async ensureSweep(t: DeliveryTarget): Promise<string> {
    const id = `app-sweep-${t.hireRef.toLowerCase()}`;
    this.targets.set(t.hireId, t);
    if (!this.crons.has(id)) {
      this.crons.set(id, new Cron(this.deps.sweepCron, { timezone: this.deps.sweepTimezone }, () => void this.fireSweep(t, 'cron')));
      await setDeskState(this.deps.db, t.hireId, { sweepScheduleId: id });
    }
    return id;
  }

  async fireSweep(t: DeliveryTarget, trigger: 'manual' | 'cron' = 'manual'): Promise<{ scheduleId: string }> {
    const scheduleId = await this.ensureSweep(t);
    const { event } = await recordEvent(this.deps.db, {
      hireId: t.hireId,
      type: 'schedule.fired',
      source: 'schedule',
      actor: `schedule:${scheduleId}`,
      payload: { scheduleId, name: 'pre-delivery sweep', trigger },
    });
    const contents = 'Daily pre-delivery sweep: check waiver, delivery readiness and anything waiting on us.';
    const attributes = { kind: 'schedule.fired', hire: t.hireRef, event_id: event.id, trigger };
    const d: Delivery = { target: t, kind: 'schedule', ifActive: 'persist', ifIdle: 'wake', signal: { tag: 'schedule', contents, attributes }, eventIds: [event.id] };
    const r = await this.deliver(d);
    await this.deps.db.insert(s.signalsLog).values({
      hireId: t.hireId,
      eventId: event.id,
      kind: 'schedule',
      outcome: r.outcome,
      backend: 'app',
      tag: 'schedule',
      contents,
      attributes,
      detail: { action: r.action, scheduleId },
    });
    return { scheduleId };
  }

  isIdle(hireId: string): boolean {
    const q = this.queues.get(hireId);
    return !q || (!q.running && q.items.length === 0);
  }

  async stop(): Promise<void> {
    for (const c of this.crons.values()) c.stop();
    this.crons.clear();
  }
}

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function renderXml(d: Delivery): string {
  const attrs = Object.entries(d.signal.attributes)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');
  return `<${d.signal.tag}${attrs}>${d.signal.contents}</${d.signal.tag}>`;
}
