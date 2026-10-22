import { createDb, schema as s, type DbHandle } from '@switchboard/db';
import { resetDatabase } from '@switchboard/db/reset';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markOrphanedRuns, recordRunEnd, recordRunStart } from '../../src/signals/runs';
import { createDeskTools } from '../../src/tools/desk-tools';
import { CrashSwitch } from '../../src/tools/ledger';
import { makeTracer } from '../../src/tools/trace';

/**
 * The step tracer (app.desk_steps + evidence rows) and run-id resolution, called through the real
 * tools with no model. Mastra's tool context carries the thread but not the run id, so the tracer
 * must take it from desks.active_run_id and hand it to the tool body (ledger rows, drafts.run_id).
 */
describe('tool tracer: desk steps, evidence rows, run ids', () => {
  let h: DbHandle;
  let tools: ReturnType<typeof createDeskTools>;
  let hireId: string;
  const ctx = (extra: Record<string, unknown> = {}) => ({ agent: { threadId: 'desk:NH-5520', resourceId: 'r', toolCallId: 't', messages: [], suspend: async () => {}, ...extra } });
  const exec = <K extends keyof typeof tools>(name: K, input: unknown, c: unknown = ctx()) =>
    (tools[name] as unknown as { execute: (i: unknown, c: unknown) => Promise<{ status: string; result?: Record<string, unknown> }> }).execute(input, c);
  const steps = (runId?: string) =>
    h.db
      .select()
      .from(s.deskSteps)
      .where(runId ? and(eq(s.deskSteps.hireId, hireId), eq(s.deskSteps.runId, runId)) : eq(s.deskSteps.hireId, hireId))
      .orderBy(asc(s.deskSteps.createdAt));
  const setActiveRun = (runId: string | null) => h.db.update(s.desks).set({ activeRunId: runId }).where(eq(s.desks.hireId, hireId));

  beforeAll(async () => {
    await resetDatabase(process.env.DATABASE_URL);
    h = createDb(process.env.DATABASE_URL, { max: 4 });
    tools = createDeskTools({ db: h.db, crash: new CrashSwitch(), tracer: makeTracer(h.db) });
    [{ id: hireId }] = (await h.db.select({ id: s.hires.id }).from(s.hires).where(eq(s.hires.ref, 'NH-5520'))) as [{ id: string }];
  });
  afterAll(async () => h?.close());

  it('takes the run id from desks.active_run_id and stamps it on the step, the ledger row and the attempt', async () => {
    await setActiveRun('run-A');
    const r = await exec('applyRoutineUpdate', { hireRef: 'NH-5520', expectedVersion: 3, changes: { poNumber: 'HAL-PO-1' } });
    expect(r).toMatchObject({ status: 'OK', result: { version: 4 } });

    const [step] = await steps('run-A');
    expect(step).toMatchObject({ kind: 'tool', tool: 'applyRoutineUpdate', status: 'OK', text: 'applyRoutineUpdate(poNumber, expected v3) → hire now v4' });
    const [action] = await h.db.select().from(s.agentActions).where(eq(s.agentActions.actionKey, 'routine:nh-5520:ponumber:hal-po-1'));
    expect(action!.runId).toBe('run-A');
    const [attempt] = await h.db.select().from(s.actionAttempts).where(eq(s.actionAttempts.actionKey, 'routine:nh-5520:ponumber:hal-po-1'));
    expect(attempt!.runId).toBe('run-A');
    const [desk] = await h.db.select().from(s.desks).where(eq(s.desks.hireId, hireId));
    expect(desk!.currentStep).toBe('applyRoutineUpdate(poNumber, expected v3)');
  });

  it('a run id carried by the tool context wins over the desk row', async () => {
    await setActiveRun('run-desk-row');
    await exec('getHire', { hireRef: 'NH-5520' }, ctx({ runId: 'run-from-ctx' }));
    expect(await steps('run-from-ctx')).toHaveLength(1);
    expect(await steps('run-desk-row')).toHaveLength(0);
  });

  it('a STALE or REJECTED result is recorded on the step with its status, and the step is never left running', async () => {
    await setActiveRun('run-B');
    await exec('applyRoutineUpdate', { hireRef: 'NH-5520', expectedVersion: 3, changes: { poNumber: 'HAL-PO-2' } });
    await exec('applyRoutineUpdate', { hireRef: 'NH-5520', expectedVersion: 4, changes: { deliveryDate: '2026-12-01' } });
    const rows = await steps('run-B');
    expect(rows.map((r) => [r.status, r.text])).toEqual([
      ['STALE', 'applyRoutineUpdate(poNumber, expected v3) → STALE: hire is v4'],
      ['REJECTED', 'applyRoutineUpdate(deliveryDate, expected v4) → refused: needs approval: deliveryDate'],
    ]);
    expect((await steps()).filter((r) => r.status === 'running')).toHaveLength(0);
  });

  it('proposeDraft writes drafts.run_id from the resolved run', async () => {
    await setActiveRun('run-C');
    const [ev] = await h.db.select().from(s.evidenceChunks).where(and(eq(s.evidenceChunks.hireId, hireId), eq(s.evidenceChunks.sourceType, 'transcript')));
    const r = await exec('proposeDraft', { hireRef: 'NH-5520', intent: 'trace-check', kind: 'update', title: 't', basedOnVersion: 4, actions: [], evidenceIds: [ev!.id] });
    expect(r).toMatchObject({ status: 'OK' });
    const ref = (r.result as { draft: { ref: string } }).draft.ref;
    const [d] = await h.db.select().from(s.drafts).where(eq(s.drafts.ref, ref));
    expect(d!.runId).toBe('run-C');
    const [step] = await steps('run-C');
    expect(step!.text).toBe(`proposeDraft(trace-check, based on v4) → ${ref} pending`);
  });

  it('searchEvidence mirrors transcript hits as evidence rows with the best-matching line, once per run', async () => {
    await setActiveRun('run-D');
    const query = 'call Sam more hires this quarter discount';
    await exec('searchEvidence', { hireRef: 'NH-5520', query, sourceTypes: ['transcript'] });
    await exec('searchEvidence', { hireRef: 'NH-5520', query, sourceTypes: ['transcript'] });
    const rows = await steps('run-D');
    const evidence = rows.filter((r) => r.kind === 'evidence');
    expect(rows.filter((r) => r.kind === 'tool')).toHaveLength(2);
    expect(evidence).toHaveLength(1); // the second search in the same run adds no duplicate
    expect(evidence[0]!.detail).toMatchObject({ sourceType: 'transcript', title: expect.stringMatching(/^Call: Gary Dunn/) });
    expect(evidence[0]!.text.toLowerCase()).toContain('quarter');
    // A new run that searches again gets its own evidence row.
    await setActiveRun('run-E');
    await exec('searchEvidence', { hireRef: 'NH-5520', query, sourceTypes: ['transcript'] });
    expect((await steps('run-E')).filter((r) => r.kind === 'evidence')).toHaveLength(1);
  });

  it('a call on a hire it cannot resolve writes no step, and a guardrail refusal still returns', async () => {
    const before = (await h.db.select().from(s.deskSteps)).length;
    expect(await exec('getHire', { hireRef: 'NH-0000' })).toMatchObject({ status: 'REJECTED' });
    expect((await h.db.select().from(s.deskSteps)).length).toBe(before);
  });
});

describe('desk runs (app.desk_runs)', () => {
  let h: DbHandle;
  let hireId: string;
  beforeAll(async () => {
    h = createDb(process.env.DATABASE_URL, { max: 2 });
    [{ id: hireId }] = (await h.db.select({ id: s.hires.id }).from(s.hires).where(eq(s.hires.ref, 'NH-5520'))) as [{ id: string }];
  });
  afterAll(async () => h?.close());
  const run = async (runId: string) => h.db.select().from(s.deskRuns).where(eq(s.deskRuns.runId, runId));

  it('one row per run start (idempotent), ended only by the process that owns it', async () => {
    await recordRunStart(h.db, hireId, 'app-run-1', 'app');
    await recordRunStart(h.db, hireId, 'app-run-1', 'app');
    expect(await run('app-run-1')).toMatchObject([{ generation: 1, backend: 'app', state: 'running', pid: process.pid }]);
    await recordRunEnd(h.db, 'app-run-1', 'completed');
    expect((await run('app-run-1'))[0]!.state).toBe('completed');

    // A row left by another (dead) process is not this process's to complete...
    await h.db.insert(s.deskRuns).values({ hireId, runId: 'dead-run', generation: 1, backend: 'app', state: 'running', pid: 999_999 });
    await recordRunEnd(h.db, 'dead-run', 'completed');
    expect((await run('dead-run'))[0]!.state).toBe('running');
    // ...it is marked crashed on boot; this process's own running rows are left alone.
    await recordRunStart(h.db, hireId, 'live-run', 'app');
    expect(await markOrphanedRuns(h.db)).toBe(1);
    expect((await run('dead-run'))[0]).toMatchObject({ state: 'crashed', endedAt: expect.any(Date) });
    expect((await run('live-run'))[0]!.state).toBe('running');
  });
});
