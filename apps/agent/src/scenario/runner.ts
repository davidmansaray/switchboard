import { HERO_BEATS } from '@switchboard/core';
import { HERO_REF, getDraftByRef, resetData, schema as s, type Db } from '@switchboard/db';
import { and, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import { ServiceError, type Services } from '../services';
import type { SignalRouter } from '../signals/adapter';
import type { CrashSwitch } from '../tools/ledger';
import type { Tracer } from '../tools/trace';
import { beats, JO_EDIT } from './beats';

type Deps = {
  db: Db;
  services: Services;
  router: SignalRouter;
  crash: CrashSwitch;
  tracer: Tracer;
  allowCrash: boolean;
  allowReset: boolean;
  /** Re-subscribe desks and re-create sweeps after a reset. */
  restart: () => Promise<void>;
  timeoutMs?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The scenario runner behind the simulator rail (and `pnpm scenario:*`). Every beat goes through
 * the same services the HTTP routes use, against the real harness and database; nothing here
 * touches a desk's state directly. Progress lives in `app.scenario_beats`, so the UI follows it
 * over SSE and a beat interrupted by the crash beat is finished by the next process on boot.
 */
export function createScenario(deps: Deps) {
  const { db } = deps;
  const timeoutMs = deps.timeoutMs ?? 120_000;
  let playing: Promise<void> | null = null;
  /** True while `playing` is only a boot-time watcher (resume), which a reset may cancel. */
  let watching = false;
  let cancelled = 0;

  async function heroId(): Promise<string> {
    const [h] = await db.select({ id: s.hires.id }).from(s.hires).where(eq(s.hires.ref, HERO_REF));
    if (!h) throw new ServiceError('NOT_FOUND', `no hero hire ${HERO_REF}`);
    return h.id;
  }

  async function state() {
    const rows = await db.select().from(s.scenarioBeats).orderBy(s.scenarioBeats.n);
    const done = rows.filter((r) => r.status === 'done').map((r) => r.n);
    const next = HERO_BEATS.find((b) => !done.includes(b.n))?.n ?? null;
    return { beats: rows, next, busy: Boolean(playing) || rows.some((r) => r.status === 'playing') };
  }

  /**
   * Quiet = nothing for this hire left to do: no debounced edit or in-flight delivery, the backend
   * has no active or queued run, every inbound event has been processed and the desk has settled.
   * DB-based, so it also holds across a restart (the crash beat).
   */
  async function quiet(hireId: string, opts: { since?: Date; needEvent?: string } = {}): Promise<boolean> {
    if (deps.router.busy(hireId) || !deps.router.backend.isIdle(hireId)) return false;
    if (opts.needEvent) {
      const [e] = await db
        .select({ id: s.events.id })
        .from(s.events)
        .where(and(eq(s.events.hireId, hireId), eq(s.events.type, opts.needEvent), opts.since ? gte(s.events.createdAt, opts.since) : undefined));
      if (!e) return false;
    }
    const [pending] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.events)
      .where(and(eq(s.events.hireId, hireId), isNull(s.events.processedAt), ne(s.events.source, 'agent')));
    if ((pending?.n ?? 0) > 0) return false;
    const [desk] = await db.select({ st: s.desks.runState }).from(s.desks).where(eq(s.desks.hireId, hireId));
    return desk?.st === 'idle' || desk?.st === 'awaiting_approval';
  }

  async function waitQuiet(hireId: string, opts: { since?: Date; needEvent?: string } = {}) {
    const t0 = Date.now();
    const epoch = cancelled;
    let quietSince = 0;
    while (Date.now() - t0 < timeoutMs) {
      if (cancelled !== epoch) throw new Error('cancelled by a scenario reset');
      if (await quiet(hireId, opts)) {
        quietSince ||= Date.now();
        if (Date.now() - quietSince > 400) return;
      } else quietSince = 0;
      await sleep(150);
    }
    throw new Error(`desk did not settle within ${Math.round(timeoutMs / 1000)}s`);
  }

  async function waitFor(what: string, fn: () => Promise<boolean>, ms = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return;
      await sleep(40);
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  async function mark(n: number, status: 'playing' | 'done' | 'failed', extra: { detail?: Record<string, unknown>; error?: string } = {}) {
    await db
      .insert(s.scenarioBeats)
      .values({ n, status, detail: extra.detail ?? {}, error: extra.error ?? null, finishedAt: status === 'playing' ? null : new Date() })
      .onConflictDoUpdate({
        target: s.scenarioBeats.n,
        set: { status, error: extra.error ?? null, finishedAt: status === 'playing' ? null : new Date(), ...(extra.detail ? { detail: extra.detail } : {}) },
      });
  }

  type PlayOpts = { staffId?: string; channel?: 'web' | 'mobile' };

  async function run(n: number, hireId: string, o: PlayOpts = {}) {
    const svc = deps.services;
    const b = beats(svc);
    const since = new Date();
    switch (n) {
      case 1:
      case 2:
        await b[n]();
        return waitQuiet(hireId);
      case 5: {
        const d7 = await latestOpenDraft(hireId, 'discount');
        await svc.decideApproval({ draftRef: d7, staffId: o.staffId ?? 'gary', decision: 'approved', channel: o.channel ?? 'mobile' });
        return waitQuiet(hireId);
      }
      case 3: {
        await b[3]();
        // Beat 4 is the race: Jo's edit lands while the run that wrote the draft is still working.
        await waitFor('the beat-3 draft', async () => {
          const [d] = await db
            .select({ id: s.drafts.id })
            .from(s.drafts)
            .where(and(eq(s.drafts.hireId, hireId), gte(s.drafts.createdAt, since)));
          return Boolean(d);
        });
        await mark(3, 'done');
        await mark(4, 'playing');
        await svc.editHire(JO_EDIT);
        // Skip the rest of the debounce window so the queued message meets the running desk.
        await deps.router.flushEdits(hireId);
        await waitQuiet(hireId);
        return mark(4, 'done');
      }
      case 4:
        // Only reachable if beat 3 was played without the race (e.g. interrupted); play the edit on its own.
        await svc.editHire(JO_EDIT);
        await deps.router.flushEdits(hireId);
        return waitQuiet(hireId);
      case 6: {
        const d8 = await latestOpenDraft(hireId, 'discount');
        if (deps.allowCrash) {
          deps.crash.arm('applyPricing');
          await db.insert(s.opsLog).values({ kind: 'crash.armed', detail: { tool: 'applyPricing', by: 'scenario', beat: 6 } });
        }
        await svc.decideApproval({ draftRef: d8, staffId: o.staffId ?? 'gary', decision: 'approved', channel: o.channel ?? 'mobile' });
        // With the crash armed this process dies inside the apply; the next process finishes the beat (resume()).
        return waitQuiet(hireId);
      }
      case 7:
        await b[7]();
        return waitQuiet(hireId, { since, needEvent: 'schedule.fired' });
      case 8:
        await b[8]();
        return waitQuiet(hireId);
      case 9:
        return; // client side: the Architecture Overlay
      default:
        throw new ServiceError('INVALID', `no beat ${n}`);
    }
  }

  /** The draft to act on for an intent: the newest open one (D-8 after beat 5 regenerated D-7). */
  async function latestOpenDraft(hireId: string, intent: string): Promise<string> {
    const [d] = await db
      .select({ ref: s.drafts.ref })
      .from(s.drafts)
      .where(and(eq(s.drafts.hireId, hireId), inArray(s.drafts.status, ['pending', 'stale']), sql`${s.drafts.payload} ->> 'intent' = ${intent}`))
      .orderBy(sql`${s.drafts.createdAt} desc`)
      .limit(1);
    if (!d) throw new ServiceError('INVALID', `no open ${intent} draft to approve`);
    const draft = await getDraftByRef(db, d.ref);
    return draft!.ref;
  }

  /**
   * An approve click in the UI on the hero's discount draft while the story is at beat 5 or 6 *is*
   * that beat (beat 6 includes the crash), so it is played through the runner. Otherwise null.
   */
  async function beatForApproval(draftRef: string, decision: string): Promise<number | null> {
    if (decision !== 'approved') return null;
    const st = await state();
    if (st.busy || (st.next !== 5 && st.next !== 6)) return null;
    const hireId = await heroId().catch(() => null);
    if (!hireId) return null;
    const open = await latestOpenDraft(hireId, 'discount').catch(() => null);
    return open === draftRef ? st.next : null;
  }

  /** The same for "fire the 07:00 sweep" on the hero desk while the story is at beat 7. */
  async function beatForSweep(hireRef: string): Promise<number | null> {
    if (hireRef !== HERO_REF) return null;
    const st = await state();
    return !st.busy && st.next === 7 ? 7 : null;
  }

  async function play(n: number, o: PlayOpts = {}): Promise<{ accepted: true; n: number }> {
    const st = await state();
    if (st.busy) throw new ServiceError('INVALID', 'a beat is still playing');
    if (st.next !== n) throw new ServiceError('INVALID', st.next ? `the next beat is ${st.next}` : 'every beat has been played; reset first');
    const hireId = await heroId();
    await mark(n, 'playing');
    playing = run(n, hireId, o)
      .then(() => mark(n, 'done'))
      .catch(async (e: unknown) => {
        console.error(`[scenario] beat ${n} failed`, e);
        await mark(n, 'failed', { error: e instanceof Error ? e.message : String(e) }).catch(() => {});
      })
      .finally(() => {
        playing = null;
      });
    return { accepted: true, n };
  }

  /** On boot: a beat left 'playing' by a dead process (the crash beat) is watched to completion here. */
  async function resume(): Promise<number[]> {
    const rows = await db.select().from(s.scenarioBeats).where(eq(s.scenarioBeats.status, 'playing'));
    if (!rows.length) return [];
    const hireId = await heroId();
    const ns = rows.map((r) => r.n);
    watching = true;
    playing = (async () => {
      try {
        await waitQuiet(hireId);
        for (const n of ns) await mark(n, 'done');
      } catch (e) {
        for (const n of ns) await mark(n, 'failed', { error: e instanceof Error ? e.message : String(e) });
      }
    })().finally(() => {
      playing = null;
      watching = false;
    });
    return ns;
  }

  /** Back to the seeded morning, in place, with the agent still running. */
  async function reset(): Promise<{ ok: true }> {
    if (!deps.allowReset) throw new ServiceError('FORBIDDEN', 'scenario reset is disabled on this deployment');
    if (playing && !watching) throw new ServiceError('INVALID', 'a beat is still playing');
    if (playing) {
      cancelled++;
      await playing.catch(() => {});
    }
    const t0 = Date.now();
    for (;;) {
      const running = await db.select({ id: s.desks.id }).from(s.desks).where(inArray(s.desks.runState, ['running', 'queued', 'recovering']));
      if (!running.length) break;
      if (Date.now() - t0 > 20_000) throw new ServiceError('INVALID', 'a desk is still running; try again when it settles');
      await sleep(250);
    }
    deps.crash.disarm();
    deps.router.clear();
    deps.router.backend.resetState();
    deps.tracer.clear();
    await resetData(db);
    await db.insert(s.opsLog).values({ kind: 'reset', detail: { pid: process.pid } });
    await deps.restart();
    return { ok: true };
  }

  return { state, play, resume, reset, quiet, beatForApproval, beatForSweep };
}

export type Scenario = ReturnType<typeof createScenario>;
