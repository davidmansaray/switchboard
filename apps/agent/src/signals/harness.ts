import type { Mastra } from '@mastra/core';
import type { Agent } from '@mastra/core/agent';
import {
  getDeskByThread,
  markEventsProcessed,
  recordEvent,
  schema as s,
  setDeskState,
  type Db,
} from '@switchboard/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DESK_AGENT_ID } from '../mastra/agents/desk';
import { recordRunEnd, recordRunStart } from './runs';
import type { Delivery, DeliveryResult, DeliveryTarget, Outcome, SignalBackend } from './types';

type Accepted = { action: 'wake' | 'deliver' | 'persist' | 'discard' | 'blocked'; runId?: string };

/**
 * Harness backend: Mastra signals carry every wake-up, `mastra.schedules` runs
 * the daily sweep, and the desk is a durable agent. This file only translates
 * plans into calls and mirrors what happened into app tables.
 */
export class HarnessBackend implements SignalBackend {
  readonly name = 'harness' as const;
  private subs = new Map<string, { unsubscribe: () => void; unwatch: () => void }>();
  private active = new Map<string, string>(); // hireId -> runId
  private queued = new Map<string, number>(); // hireId -> local queue count
  private runEvents = new Map<string, Set<string>>(); // runId -> event ids
  private hireOfThread = new Map<string, string>();
  /** Queued deliveries accepted while a run was active, not yet started. */
  private waiting = new Map<string, Set<string>>();

  constructor(
    private readonly deps: {
      db: Db;
      mastra: () => Mastra;
      sweepCron: string;
      sweepTimezone: string;
      onDeskChange?: (hireId: string) => void;
    },
  ) {}

  private agent(): Agent {
    return this.deps.mastra().getAgent(DESK_AGENT_ID) as unknown as Agent;
  }

  async start(): Promise<void> {
    const desks = await this.deps.db.select().from(s.desks);
    for (const d of desks) await this.watch(d);
  }

  /** One thread subscription per desk: run start/finish drive desk state and event bookkeeping. */
  private async watch(desk: s.Desk): Promise<void> {
    if (this.subs.has(desk.hireId)) return;
    const agent = this.agent();
    const thread = { resourceId: desk.resourceId, threadId: desk.mastraThreadId };
    this.hireOfThread.set(desk.mastraThreadId, desk.hireId);
    const sub = await agent.subscribeToThread(thread);
    const unwatch = agent.subscribeThreadEvents(thread, (ev) => {
      if (ev.type !== 'queue-count-changed') return;
      this.queued.set(desk.hireId, ev.count);
      if (this.active.has(desk.hireId)) void this.setState(desk.hireId, ev.count > 0 ? 'queued' : 'running');
    });
    this.subs.set(desk.hireId, { unsubscribe: sub.unsubscribe, unwatch });
    void (async () => {
      try {
        for await (const chunk of sub.stream as AsyncIterable<{ type: string; runId?: string; data?: unknown }>) {
          await this.onChunk(desk.hireId, chunk).catch((e: unknown) => console.error('[harness] chunk handler', e));
        }
      } catch (e) {
        console.error('[harness] subscription ended', desk.mastraThreadId, e);
      }
    })();
  }

  private lastChunks = new Map<string, string[]>();
  private seenRuns = new Set<string>();

  private async onChunk(hireId: string, chunk: { type: string; runId?: string; data?: unknown }) {
    const runId = chunk.runId;
    const trail = this.lastChunks.get(hireId) ?? [];
    trail.push(`${chunk.type}@${runId?.slice(0, 8)}`);
    this.lastChunks.set(hireId, trail.slice(-12));
    if (!runId) return;
    if (chunk.type === 'tool-call') return; // the tool layer records steps (tools/trace.ts)
    const ending = chunk.type === 'finish' || chunk.type === 'error' || chunk.type === 'abort';
    if (chunk.type === 'start' || (!ending && this.active.get(hireId) !== runId && !this.seenRuns.has(runId))) {
      // 'start', or the first chunk of a run this process didn't start (a recovered run).
      this.seenRuns.add(runId);
      this.active.set(hireId, runId);
      await this.setState(hireId, (this.queued.get(hireId) ?? 0) > 0 ? 'queued' : 'running', runId);
      await recordRunStart(this.deps.db, hireId, runId, 'harness').catch((e: unknown) => console.error('[harness] run start', e));
      if (chunk.type === 'start') return;
    }
    if (chunk.type === 'data-signal' || chunk.type === 'data-user-message') {
      const data = (chunk as { data?: { attributes?: Record<string, unknown> } }).data;
      const ids = [data?.attributes?.event_id, ...String(data?.attributes?.event_ids ?? '').split(',')].filter((x): x is string => typeof x === 'string' && x.length > 0);
      if (ids.length) {
        const set = this.runEvents.get(runId) ?? new Set<string>();
        ids.forEach((i) => set.add(i));
        this.runEvents.set(runId, set);
        ids.forEach((i) => this.waiting.get(hireId)?.delete(i));
        if (data?.attributes?.kind === 'schedule.fired') this.waiting.get(hireId)?.delete('sweep');
        await this.deps.db.update(s.events).set({ runId }).where(inArray(s.events.id, ids));
      }
      return;
    }
    if (chunk.type === 'finish' || chunk.type === 'error' || chunk.type === 'abort') {
      const ids = [...(this.runEvents.get(runId) ?? [])];
      this.runEvents.delete(runId);
      if (chunk.type === 'finish') {
        await markEventsProcessed(this.deps.db, ids, runId);
        // A recovered run was started by another (dead) process, so this one never saw its input
        // chunks; that process stamped the run id on the events, so close those out too.
        await this.deps.db
          .update(s.events)
          .set({ processedAt: sql`now()` })
          .where(and(eq(s.events.runId, runId), isNull(s.events.processedAt)));
      }
      if (this.active.get(hireId) === runId) this.active.delete(hireId);
      await recordRunEnd(this.deps.db, runId, chunk.type === 'finish' ? 'completed' : 'failed').catch((e: unknown) => console.error('[harness] run end', e));
      await setDeskState(this.deps.db, hireId, { currentStep: null });
      await this.settle(hireId);
    }
  }

  /** Idle desks with a pending draft show as awaiting approval. */
  private async settle(hireId: string) {
    if (this.active.has(hireId)) return;
    const pending = await this.deps.db
      .select({ id: s.drafts.id })
      .from(s.drafts)
      .where(and(eq(s.drafts.hireId, hireId), inArray(s.drafts.status, ['pending', 'stale'])))
      .limit(1);
    await this.setState(hireId, pending.length ? 'awaiting_approval' : 'idle', null);
  }

  private async setState(hireId: string, runState: s.Desk['runState'], activeRunId?: string | null) {
    await setDeskState(this.deps.db, hireId, { runState, ...(activeRunId !== undefined ? { activeRunId } : {}) });
    this.deps.onDeskChange?.(hireId);
  }

  private threadsReady = new Set<string>();

  /**
   * A `persist` signal is written straight into thread memory, which fails if no run has created
   * the desk's thread yet (e.g. a plain FYI note is the first thing a desk ever receives).
   */
  private async ensureThread(desk: s.Desk): Promise<void> {
    if (this.threadsReady.has(desk.mastraThreadId)) return;
    const memory = await this.agent().getMemory();
    if (memory && !(await memory.getThreadById({ threadId: desk.mastraThreadId }))) {
      await memory.createThread({ threadId: desk.mastraThreadId, resourceId: desk.resourceId });
    }
    this.threadsReady.add(desk.mastraThreadId);
  }

  async deliver(d: Delivery): Promise<DeliveryResult> {
    await this.watch(d.target.desk);
    if (d.ifIdle === 'persist' || d.ifActive === 'persist') await this.ensureThread(d.target.desk);
    const agent = this.agent();
    const wasActive = this.active.has(d.target.hireId);
    const target = {
      resourceId: d.target.desk.resourceId,
      threadId: d.target.desk.mastraThreadId,
      ifActive: { behavior: d.ifActive },
      ifIdle: { behavior: d.ifIdle },
    } as const;
    const attributes = d.signal.attributes;
    const signal = { type: 'notification' as const, tagName: d.signal.tag, contents: d.signal.contents, attributes };
    const message = { contents: d.signal.contents, attributes: { tag: d.signal.tag, ...attributes } };
    // Mark queued input as waiting *before* the call: `accepted` can resolve after the next run has already picked it up.
    if (d.kind === 'queued-message' || d.kind === 'queued-signal' || wasActive) {
      const w = this.waiting.get(d.target.hireId) ?? new Set<string>();
      d.eventIds.forEach((i) => w.add(i));
      this.waiting.set(d.target.hireId, w);
    }
    const res =
      d.kind === 'message'
        ? agent.sendMessage(message, target)
        : d.kind === 'queued-message'
          ? agent.queueMessage(message, target)
          : d.kind === 'queued-signal'
            ? agent.queueSignal(signal, target)
            : agent.sendSignal(signal, target);
    const acc = (await res.accepted) as Accepted;
    if (acc.action === 'persist') await res.persisted;
    const queuedKind = d.kind === 'queued-message' || d.kind === 'queued-signal';
    if (acc.action !== 'deliver' && acc.action !== 'wake') d.eventIds.forEach((i) => this.waiting.get(d.target.hireId)?.delete(i));
    const outcome: Outcome =
      acc.action === 'wake'
        ? 'delivered'
        : acc.action === 'deliver'
          ? queuedKind && wasActive
            ? 'queued'
            : 'delivered'
          : acc.action === 'persist'
            ? 'persisted'
            : acc.action === 'discard'
              ? 'discarded'
              : 'blocked';
    if (acc.action === 'persist' || acc.action === 'discard') await markEventsProcessed(this.deps.db, d.eventIds);
    if (acc.runId && !queuedKind) {
      const set = this.runEvents.get(acc.runId) ?? new Set<string>();
      d.eventIds.forEach((i) => set.add(i));
      this.runEvents.set(acc.runId, set);
    }
    if (acc.action === 'wake' && acc.runId) {
      this.active.set(d.target.hireId, acc.runId);
      await this.setState(d.target.hireId, 'running', acc.runId);
      if (!this.seenRuns.has(acc.runId)) {
        this.seenRuns.add(acc.runId);
        await recordRunStart(this.deps.db, d.target.hireId, acc.runId, 'harness').catch(() => {});
      }
    }
    return { outcome, runId: acc.runId, action: acc.action, waitsForRunId: outcome === 'queued' ? this.active.get(d.target.hireId) : undefined };
  }

  private sweepId(ref: string) {
    return `sweep-${ref.toLowerCase()}`;
  }

  async ensureSweep(t: DeliveryTarget): Promise<string> {
    const schedules = this.deps.mastra().schedules;
    const id = this.sweepId(t.hireRef);
    const existing = await schedules.get(`agent_${id}`).catch(() => null);
    const sched =
      existing ??
      (await schedules.create({
        id,
        agentId: DESK_AGENT_ID,
        name: `Pre-delivery sweep ${t.hireRef}`,
        cron: this.deps.sweepCron,
        timezone: this.deps.sweepTimezone,
        prompt: 'Daily pre-delivery sweep: check waiver, delivery readiness and anything waiting on us.',
        threadId: t.desk.mastraThreadId,
        resourceId: t.desk.resourceId,
        tagName: 'schedule',
        attributes: { kind: 'schedule.fired', hire: t.hireRef },
        ifActive: { behavior: 'persist' },
        ifIdle: { behavior: 'wake' },
      }));
    if (t.desk.sweepScheduleId !== sched.id) await setDeskState(this.deps.db, t.hireId, { sweepScheduleId: sched.id });
    return sched.id;
  }

  async fireSweep(t: DeliveryTarget): Promise<{ scheduleId: string }> {
    const id = await this.ensureSweep(t);
    // The scheduler fires asynchronously: count the desk as busy until the fire lands.
    const w = this.waiting.get(t.hireId) ?? new Set<string>();
    w.add('sweep');
    this.waiting.set(t.hireId, w);
    await this.deps.mastra().schedules.run(id);
    return { scheduleId: id };
  }

  /** `schedules.onError`: never leave the desk looking busy. */
  async sweepFailed(ctx: { schedule?: { threadId?: unknown }; error?: unknown }) {
    const desk = typeof ctx.schedule?.threadId === 'string' ? await getDeskByThread(this.deps.db, ctx.schedule.threadId) : undefined;
    if (desk) this.waiting.get(desk.hireId)?.delete('sweep');
    console.error('[schedule] error', ctx.error);
  }

  /** `schedules.prepare`: record the fire as an app event and stamp its id on the signal. */
  async prepareSweep(ctx: { schedule: { id: string; [k: string]: unknown }; trigger: { kind: string } }) {
    const sched = ctx.schedule as { id: string; threadId?: string; attributes?: Record<string, string>; prompt?: string };
    const desk = sched.threadId ? await getDeskByThread(this.deps.db, sched.threadId) : undefined;
    if (!desk) return undefined;
    const { event } = await recordEvent(this.deps.db, {
      hireId: desk.hireId,
      type: 'schedule.fired',
      source: 'schedule',
      actor: `schedule:${sched.id}`,
      payload: { scheduleId: sched.id, name: 'pre-delivery sweep', trigger: ctx.trigger.kind },
    });
    return { attributes: { ...(sched.attributes ?? {}), event_id: event.id, trigger: ctx.trigger.kind } };
  }

  /** `schedules.onFinish`: mirror the outcome into signals_log. */
  async finishSweep(ctx: { schedule: { id: string; [k: string]: unknown }; outcome: string; runId?: string; joinedExistingRun?: boolean; effective: { prompt: string; attributes?: Record<string, unknown> } }) {
    const sched = ctx.schedule as { threadId?: string };
    const desk = sched.threadId ? await getDeskByThread(this.deps.db, sched.threadId) : undefined;
    if (!desk) return;
    const outcome: Outcome =
      ctx.outcome === 'persisted' ? 'persisted' : ctx.outcome === 'discarded' || ctx.outcome === 'skipped' ? 'discarded' : ctx.joinedExistingRun ? 'queued' : 'delivered';
    const attrs = (ctx.effective.attributes ?? {}) as Record<string, string>;
    await this.deps.db.insert(s.signalsLog).values({
      hireId: desk.hireId,
      eventId: attrs.event_id ?? null,
      kind: 'schedule',
      outcome,
      backend: 'harness',
      tag: 'schedule',
      contents: ctx.effective.prompt,
      attributes: attrs,
      runId: ctx.runId ?? null,
      detail: { scheduleOutcome: ctx.outcome, scheduleId: ctx.schedule.id },
    });
    if (ctx.outcome !== 'succeeded' && ctx.outcome !== 'delivered') this.waiting.get(desk.hireId)?.delete('sweep');
    if (ctx.outcome === 'persisted' || ctx.outcome === 'discarded' || ctx.outcome === 'skipped') {
      if (attrs.event_id) await markEventsProcessed(this.deps.db, [attrs.event_id]);
    }
  }

  describe(hireId: string) {
    return { active: this.active.get(hireId) ?? null, queued: this.queued.get(hireId) ?? 0, waiting: [...(this.waiting.get(hireId) ?? [])], lastChunks: this.lastChunks.get(hireId) ?? [] };
  }

  /** Scenario reset: forget per-desk bookkeeping (threads are re-created on the next delivery). */
  resetState() {
    for (const sub of this.subs.values()) {
      sub.unsubscribe();
      sub.unwatch();
    }
    this.subs.clear();
    this.hireOfThread.clear();
    this.seenRuns.clear();
    this.active.clear();
    this.queued.clear();
    this.runEvents.clear();
    this.waiting.clear();
    this.threadsReady.clear();
    this.lastChunks.clear();
  }

  isIdle(hireId: string): boolean {
    return !this.active.has(hireId) && (this.queued.get(hireId) ?? 0) === 0 && (this.waiting.get(hireId)?.size ?? 0) === 0;
  }

  async stop(): Promise<void> {
    for (const s of this.subs.values()) {
      s.unsubscribe();
      s.unwatch();
    }
    this.subs.clear();
  }
}
