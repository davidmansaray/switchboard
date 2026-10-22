import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createDb, schema as s } from '@switchboard/db';
import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DESK_AGENT_ID } from '../../src/mastra/agents/desk';
import type { Switchboard } from '../../src/runtime';
import { beats } from '../../src/scenario/beats';
import { BACKENDS, bootSwitchboard, heroId } from '../support/boot';
import { playBeats } from '../support/story';

const WORKER = fileURLToPath(new URL('../support/worker.ts', import.meta.url));

function runWorker(mode: 'crash' | 'hang', beat: number, env: Record<string, string>, onLine?: (l: string) => void) {
  const child = spawn(process.execPath, ['--import', 'tsx', WORKER, mode, String(beat)], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { ...process.env, ...env, SWITCHBOARD_SKIP_BOOT: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const feed = (d: Buffer) => {
    out += d.toString();
    for (const l of d.toString().split('\n')) if (l.trim()) onLine?.(l);
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal, out })),
  );
  return { child, exited, output: () => out };
}

/** M4: idempotent apply + crash/recovery (beat 6), schedule sweep (beat 7), duplicate-intent merge (beat 8). */
describe.each(BACKENDS)('M4 hero beats 6–8 (SIGNAL_BACKEND=%s)', (backend) => {
  let sb: Switchboard;
  let hireId: string;
  const db = () => sb.db.db;
  const draft = async (ref: string) => (await db().select().from(s.drafts).where(eq(s.drafts.ref, ref)))[0];

  beforeAll(async () => {
    sb = await bootSwitchboard({ signalBackend: backend, scriptedLatencyMs: 80 });
    hireId = await heroId(db());
    await playBeats(sb, hireId, 5);
    expect(await draft('D-8')).toMatchObject({ status: 'pending', basedOnVersion: 5 });
    await sb.stop(); // the worker process takes over for the crash
  });
  afterAll(async () => {
    await sb?.stop().catch(() => {});
  });

  it('beat 6: worker dies right after applyPricing commits; recovery skips the recorded action and sends exactly one email', async () => {
    const w = runWorker('crash', 6, { SIGNAL_BACKEND: backend });
    const res = await w.exited;
    if (res.signal !== 'SIGKILL') console.log(res.out);
    expect(res.signal).toBe('SIGKILL');
    expect(res.out).toContain('[crash] killing agent process after applyPricing committed');

    // State at the moment of the crash (read before anything restarts): pricing applied (v6),
    // email not sent, draft still approved. Recovery has to finish the job without redoing it.
    const peek = createDb(process.env.DATABASE_URL, { max: 1 });
    try {
      const [h] = await peek.db.select().from(s.hires).where(eq(s.hires.id, hireId));
      expect(h!.version).toBe(6);
      expect(Number(h!.discountPct)).toBe(10);
      expect(h!.totalPence).toBe(385200);
      expect(await peek.db.select().from(s.outbox).where(eq(s.outbox.hireId, hireId))).toHaveLength(0);
      const [d8] = await peek.db.select().from(s.drafts).where(eq(s.drafts.ref, 'D-8'));
      expect(d8!.status).toBe('approved');
      const done = await peek.db.select().from(s.agentActions).where(and(eq(s.agentActions.hireId, hireId), inArray(s.agentActions.actionKey, ['apply:d-8', 'email:d-8'])));
      expect(done.map((a) => a.actionKey)).toEqual(['apply:d-8']);
      // The approval event was never finished: a restart must pick it up.
      const [appr] = await peek.db.select().from(s.events).where(and(eq(s.events.hireId, hireId), eq(s.events.type, 'approval.decided'), sql`${s.events.payload} ->> 'draftRef' = 'D-8'`));
      expect(appr!.processedAt).toBeNull();
    } finally {
      await peek.close();
    }

    sb = await bootSwitchboard({ signalBackend: backend, scriptedLatencyMs: 40 }, { reset: false });

    if (backend === 'harness') {
      // The crashed process still holds the run's lease (30 s TTL); take it over now instead of waiting.
      const agent = sb.mastra.getAgent(DESK_AGENT_ID) as unknown as {
        listActiveRuns: () => Promise<{ runs: Array<{ runId: string }> }>;
        recover: (id: string, o: { force: boolean }) => Promise<{ output: { getFullOutput: () => Promise<{ text: string }> } }>;
      };
      const { runs } = await agent.listActiveRuns();
      expect(runs).toHaveLength(1);
      const rec = await agent.recover(runs[0]!.runId, { force: true });
      const full = await rec.output.getFullOutput();
      expect(full.text).toContain('Applied D-8 and sent exactly one email');
    }
    // app backend: start() re-delivered the unprocessed approval event; the desk re-ran it.
    await sb.router.idle(hireId, 30_000);

    const outbox = await db().select().from(s.outbox).where(eq(s.outbox.hireId, hireId));
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.idempotencyKey).toBe('email:d-8');
    const applies = await db().select().from(s.agentActions).where(and(eq(s.agentActions.hireId, hireId), inArray(s.agentActions.actionKey, ['apply:d-8', 'email:d-8'])));
    expect(applies.map((a) => a.actionKey).sort()).toEqual(['apply:d-8', 'email:d-8']);
    expect((await draft('D-8'))!.status).toBe('applied');
    const attempts = await db().select().from(s.actionAttempts).where(and(eq(s.actionAttempts.hireId, hireId), eq(s.actionAttempts.actionKey, 'apply:d-8')));
    expect(attempts.map((x) => x.status).sort()).toEqual(['recorded', 'skipped_duplicate']);
    const [after] = await db().select().from(s.hires).where(eq(s.hires.id, hireId));
    expect(after!.version).toBe(6); // the retry did not apply pricing twice
    // The approval is closed out, so the next restart does not hand it to the desk again.
    const [appr] = await db().select().from(s.events).where(and(eq(s.events.hireId, hireId), eq(s.events.type, 'approval.decided'), sql`${s.events.payload} ->> 'draftRef' = 'D-8'`));
    expect(appr!.processedAt).not.toBeNull();
    const [desk] = await db().select().from(s.desks).where(eq(s.desks.hireId, hireId));
    expect(desk!.runState).toBe('idle');
  });

  if (backend === 'harness') {
    it('beat 6 (fencing): a hung "zombie" execution that wakes after a takeover cannot write', async () => {
      // Fresh D-8-style situation: reset to beat 5 on a new story.
      await sb.stop();
      sb = await bootSwitchboard({ signalBackend: backend, scriptedLatencyMs: 40 });
      hireId = await heroId(db());
      await playBeats(sb, hireId, 5);
      await sb.stop();

      let stalled!: () => void;
      const isStalled = new Promise<void>((r) => (stalled = r));
      const w = runWorker('hang', 6, { SIGNAL_BACKEND: backend, HANG_MS: '8000', WORKER_LIFETIME_MS: '20000' }, (l) => {
        if (l.includes('[hang] applyPricing stalled')) stalled();
      });
      await isStalled;

      sb = await bootSwitchboard({ signalBackend: backend, scriptedLatencyMs: 40 }, { reset: false });
      const agent = sb.mastra.getAgent(DESK_AGENT_ID) as unknown as {
        listActiveRuns: () => Promise<{ runs: Array<{ runId: string }> }>;
        recover: (id: string, o: { force: boolean }) => Promise<{ output: { getFullOutput: () => Promise<{ text: string }> } }>;
      };
      const { runs } = await agent.listActiveRuns();
      expect(runs).toHaveLength(1);
      const rec = await agent.recover(runs[0]!.runId, { force: true });
      expect((await rec.output.getFullOutput()).text).toContain('Applied D-8 and sent exactly one email');

      const res = await w.exited; // the zombie wakes up, tries applyPricing, then its next step
      expect(res.out).toContain('[hang] applyPricing resumed');
      // After it wakes, Mastra's fence stops the zombie (its lease was taken over).
      const afterWake = res.out.slice(res.out.indexOf('[hang] applyPricing resumed'));
      expect(afterWake).toMatch(/DurableExecutionFenceError|RunFenceConflictError|DURABLE_AGENT_EXECUTION_SUPERSEDED|STORAGE_RUN_FENCE_CONFLICT/);

      expect(await db().select().from(s.outbox).where(eq(s.outbox.hireId, hireId))).toHaveLength(1);
      const [h] = await db().select().from(s.hires).where(eq(s.hires.id, hireId));
      expect(h!.version).toBe(6);
      // The takeover recorded the apply; the zombie's late applyPricing hit the ledger as a duplicate.
      const applyAttempts = await db().select().from(s.actionAttempts).where(and(eq(s.actionAttempts.hireId, hireId), eq(s.actionAttempts.actionKey, 'apply:d-8')));
      expect(applyAttempts.map((a) => a.status).sort()).toEqual(['recorded', 'skipped_duplicate']);
      const emailAttempts = await db().select().from(s.actionAttempts).where(and(eq(s.actionAttempts.hireId, hireId), eq(s.actionAttempts.actionKey, 'email:d-8')));
      expect(emailAttempts.filter((a) => a.status === 'recorded')).toHaveLength(1);
      expect((await draft('D-8'))!.status).toBe('applied');
      const [appr] = await db().select().from(s.events).where(and(eq(s.events.hireId, hireId), eq(s.events.type, 'approval.decided'), sql`${s.events.payload} ->> 'draftRef' = 'D-8'`));
      expect(appr!.processedAt).not.toBeNull();
    });
  }

  it('beat 7: the daily sweep (fired now) finds no signed waiver and drafts a chaser to Gary’s queue', async () => {
    await sb.services.fireSweep('NH-5520');
    await new Promise((r) => setTimeout(r, 300));
    await sb.router.idle(hireId, 30_000);
    const chain = await db().select().from(s.drafts).where(eq(s.drafts.hireId, hireId));
    const chaser = chain.find((d) => (d.payload as { intent?: string }).intent === 'waiver-chaser');
    expect(chaser).toMatchObject({ kind: 'email', status: 'pending' });
    expect((chaser!.payload as { reply: { body: string } }).reply.body).toContain('signed damage waiver');
    expect(chaser!.evidenceIds).toHaveLength(1);
    const log = await db().select().from(s.signalsLog).where(and(eq(s.signalsLog.hireId, hireId), eq(s.signalsLog.kind, 'schedule')));
    expect(log).toHaveLength(1);
    expect(log[0]!.outcome).toBe('delivered');
    const [ev] = await db().select().from(s.events).where(and(eq(s.events.hireId, hireId), eq(s.events.type, 'schedule.fired')));
    expect(ev!.processedAt).not.toBeNull();
  });

  it('beat 8: Sam’s email and Jo’s direct cancel are one intent — one draft chain, one credit note, one email', async () => {
    const [{ now }] = (await db().execute(sql`select now() as now`)) as unknown as [{ now: Date | string }];
    const beat8At = new Date(now);
    await beats(sb.services)[8]();
    await new Promise((r) => setTimeout(r, 300));
    await sb.router.idle(hireId, 30_000);

    const all = await db().select().from(s.drafts).where(eq(s.drafts.hireId, hireId));
    const cancel = all.filter((d) => (d.payload as { intent?: string }).intent === 'cancel-line-2');
    const open = cancel.filter((d) => ['pending', 'stale', 'approved'].includes(d.status));
    expect(open).toHaveLength(1);
    expect(open[0]!.status).toBe('pending');
    const [line] = await db().select().from(s.hireLines).where(and(eq(s.hireLines.hireId, hireId), eq(s.hireLines.lineNo, 2)));
    expect(line!.status).toBe('cancelled'); // Jo did it directly

    const sigs = await db().select().from(s.signalsLog).where(eq(s.signalsLog.hireId, hireId));
    expect(sigs.filter((x) => x.tag === 'status_change')).toHaveLength(1);
    // The second source for the same intent is shown merged into the first: Jo's status change
    // points at Sam's email (signals_log.merged_into), and nothing else is marked merged.
    const samEmail = sigs.find((x) => x.tag === 'email' && x.contents.includes('cancel the telehandler'));
    const joStatus = sigs.find((x) => x.tag === 'status_change');
    expect(samEmail).toBeDefined();
    expect(joStatus!.mergedInto).toBe(samEmail!.id);
    expect(sigs.filter((x) => x.mergedInto).map((x) => x.id)).toEqual([joStatus!.id]);

    await sb.services.decideApproval({ draftRef: open[0]!.ref, staffId: 'gary', decision: 'approved' });
    await sb.router.idle(hireId, 30_000);
    const once = {
      credits: await db().select().from(s.creditNotes).where(eq(s.creditNotes.hireId, hireId)),
      outbox: await db().select().from(s.outbox).where(eq(s.outbox.hireId, hireId)),
      drafts: (await db().select().from(s.drafts).where(eq(s.drafts.hireId, hireId))).length,
      version: (await db().select().from(s.hires).where(eq(s.hires.id, hireId)))[0]!.version,
    };
    expect(once.credits).toHaveLength(1);
    expect(once.outbox).toHaveLength(2);

    // Replay every beat-8 input (Sam's email, Jo's status change, the approval) as if a restart
    // lost track of them: the desk handles each again, and still makes exactly one of everything.
    const replayed = await db()
      .update(s.events)
      .set({ processedAt: null })
      .where(and(eq(s.events.hireId, hireId), gte(s.events.createdAt, beat8At), ne(s.events.source, 'agent')))
      .returning({ type: s.events.type });
    expect(replayed.map((e) => e.type).sort()).toEqual(['approval.decided', 'email.received', 'status.changed']);
    expect(await sb.router.redeliverUnprocessed()).toBe(3);
    await new Promise((r) => setTimeout(r, 300));
    await sb.router.idle(hireId, 30_000);

    const credits = await db().select().from(s.creditNotes).where(eq(s.creditNotes.hireId, hireId));
    expect(credits).toHaveLength(1);
    expect(credits[0]!.amountPence).toBe(154800); // £860 × 2 weeks × 0.9
    const outbox = await db().select().from(s.outbox).where(eq(s.outbox.hireId, hireId));
    expect(outbox).toHaveLength(2); // D-8 confirmation + the partial-cancellation confirmation
    expect(outbox.map((o) => o.idempotencyKey).sort()).toEqual([`email:${open[0]!.ref.toLowerCase()}`, 'email:d-8']);
    expect((await draft(open[0]!.ref))!.status).toBe('applied');
    // The replay proposed nothing new and moved nothing.
    expect((await db().select().from(s.drafts).where(eq(s.drafts.hireId, hireId))).length).toBe(once.drafts);
    expect((await db().select().from(s.hires).where(eq(s.hires.id, hireId)))[0]!.version).toBe(once.version);
    const unprocessed = await db().select().from(s.events).where(and(eq(s.events.hireId, hireId), gte(s.events.createdAt, beat8At), ne(s.events.source, 'agent')));
    expect(unprocessed.filter((e) => !e.processedAt)).toHaveLength(0);
  });
});
