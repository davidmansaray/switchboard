import { createDb, HERO_REF, indexEvidence, recordEvent, schema as s, withActor } from '@switchboard/db';
import { and, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { Switchboard } from '../../src/runtime';
import { BEAT_EMAILS, LEANNE } from '../../src/scenario/beats';
import { BACKENDS, bootSwitchboard, heroId } from '../support/boot';

/**
 * The scenario runner (simulator rail / `pnpm scenario:*`): beats played through the runner, the
 * in-place reset with the agent still running, and resume() finishing a beat a dead process left
 * `playing`. allowCrashEndpoint is off: beat 6 must not SIGKILL the test process.
 */
const opts = { allowScenarioReset: true, allowCrashEndpoint: false, scriptedLatencyMs: 40 } as const;

async function waitBeat(sb: Switchboard, n: number, ms = 60_000): Promise<string> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = await sb.scenario.state();
    const row = st.beats.find((b) => b.n === n);
    if (row && row.status !== 'playing' && !st.busy) return row.status === 'failed' ? `failed: ${row.error}` : row.status;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`beat ${n} did not finish`);
}

describe.each(BACKENDS)('scenario runner (SIGNAL_BACKEND=%s)', (backend) => {
  let sb: Switchboard;
  afterEach(async () => {
    await sb?.stop().catch(() => {});
  });

  it('reset while idle goes back to the seeded morning in place, and the next beat still wakes the desk', async () => {
    sb = await bootSwitchboard({ ...opts, signalBackend: backend });
    const db = () => sb.db.db;
    const oldHire = await heroId(db());
    await expect(sb.scenario.play(2)).rejects.toMatchObject({ code: 'INVALID', message: 'the next beat is 1' });
    await sb.scenario.play(1);
    // A second click while beat 1 plays is refused, and so is a reset.
    await expect(sb.scenario.play(1)).rejects.toMatchObject({ code: 'INVALID', message: 'a beat is still playing' });
    await expect(sb.scenario.reset()).rejects.toMatchObject({ code: 'INVALID', message: 'a beat is still playing' });
    expect(await waitBeat(sb, 1)).toBe('done');
    await sb.scenario.play(2);
    expect(await waitBeat(sb, 2)).toBe('done');
    expect((await sb.scenario.state()).next).toBe(3);
    expect((await db().select().from(s.hires).where(eq(s.hires.id, oldHire)))[0]!.version).toBe(4);

    await sb.scenario.reset();

    const st = await sb.scenario.state();
    expect(st).toMatchObject({ beats: [], next: 1, busy: false });
    const hireId = await heroId(db());
    expect(hireId).not.toBe(oldHire); // re-seeded: new ids, so cached hire ids must have been dropped
    const [hire] = await db().select().from(s.hires).where(eq(s.hires.id, hireId));
    expect(hire).toMatchObject({ version: 3, poNumber: null });
    // The seed has drafts on other hires only; everything the story wrote is gone.
    expect(await db().select().from(s.drafts).where(eq(s.drafts.hireId, hireId))).toHaveLength(0);
    for (const [name, t] of [['signals_log', s.signalsLog], ['desk_steps', s.deskSteps], ['desk_runs', s.deskRuns], ['agent_actions', s.agentActions], ['outbox', s.outbox]] as const) {
      expect(await db().select().from(t), name).toHaveLength(0);
    }
    const [desk] = await db().select().from(s.desks).where(eq(s.desks.hireId, hireId));
    expect(desk).toMatchObject({ runState: 'idle', activeRunId: null });
    expect((await db().select().from(s.opsLog).where(eq(s.opsLog.kind, 'reset'))).length).toBe(1);

    // The live agent carries on against the new rows: beat 1 again wakes the desk, traces its steps
    // under the new hire id and writes a fresh working memory (Mastra's tables were emptied too).
    await sb.scenario.play(1);
    expect(await waitBeat(sb, 1)).toBe('done');
    const log = await db().select().from(s.signalsLog).where(eq(s.signalsLog.hireId, hireId));
    expect(log).toMatchObject([{ kind: 'message', outcome: 'delivered', tag: 'email' }]);
    const steps = await db().select().from(s.deskSteps).where(eq(s.deskSteps.hireId, hireId));
    expect(steps.map((x) => x.tool)).toContain('getHire');
    expect(steps.every((x) => x.runId)).toBe(true);
    const mem = await sb.mastra.getAgent('desk').getMemory();
    const wm = await mem!.getWorkingMemory({ threadId: desk!.mastraThreadId, resourceId: desk!.resourceId });
    expect(wm).toMatch(/- \[open\] discount: /);
    expect(wm).not.toMatch(/invoicing/); // nothing from before the reset
  });

  it('resume: a beat a dead process left "playing" is finished by the next process', async () => {
    sb = await bootSwitchboard({ ...opts, signalBackend: backend });
    let hireId = await heroId(sb.db.db);
    await sb.scenario.play(1);
    expect(await waitBeat(sb, 1)).toBe('done');
    await sb.stop();

    // What a process that died inside beat 2 leaves behind: the beat marked playing, and Leanne's
    // email recorded (source of truth + event) but never handled by a desk run.
    const raw = createDb(process.env.DATABASE_URL, { max: 2 });
    try {
      await raw.db.insert(s.scenarioBeats).values({ n: 2, status: 'playing' });
      const e = BEAT_EMAILS.poAndInvoice;
      await withActor(raw.db, `customer:${LEANNE}`, async (tx) => {
        const [thread] = await tx.select().from(s.emailThreads).where(and(eq(s.emailThreads.hireId, hireId), eq(s.emailThreads.label, 'T2')));
        const [contact] = await tx.select().from(s.contacts).where(eq(s.contacts.email, LEANNE));
        const [email] = await tx
          .insert(s.emails)
          .values({ threadId: thread!.id, hireId, messageId: e.messageId, direction: 'in', fromAddr: e.from, toAddrs: ['hiredesk@northgate-hire.co.uk'], subject: e.subject, body: e.body, contactId: contact!.id })
          .returning();
        const evidenceId = await indexEvidence(tx, { hireId, sourceType: 'email', sourceId: email!.id, content: `${e.subject}\n${e.body}` });
        await recordEvent(tx, {
          hireId,
          type: 'email.received',
          source: 'customer',
          actor: e.from,
          dedupeKey: `email:${e.messageId}`,
          payload: { emailId: email!.id, threadLabel: 'T2', from: e.from, fromName: contact!.name, subject: e.subject, body: e.body, evidenceId },
        });
      });
    } finally {
      await raw.close();
    }

    sb = await bootSwitchboard({ ...opts, signalBackend: backend }, { reset: false });
    hireId = await heroId(sb.db.db);
    expect(await waitBeat(sb, 2)).toBe('done');
    const st = await sb.scenario.state();
    expect(st.next).toBe(3);
    const [hire] = await sb.db.db.select().from(s.hires).where(eq(s.hires.id, hireId));
    expect(hire).toMatchObject({ poNumber: 'HAL-PO-88213', version: 4 });
    const recovery = (await sb.db.db.select().from(s.opsLog).where(eq(s.opsLog.kind, 'recovery'))).at(-1)!;
    expect(recovery.detail).toMatchObject({ redelivered: 1, resumedBeats: [2] });
  });
});

describe('scenario runner: reset vs a boot-time watcher, and clicks that are beats', () => {
  let sb: Switchboard;
  afterEach(async () => {
    await sb?.stop().catch(() => {});
  });

  it('reset cancels a resume() watcher that would never settle, instead of refusing or hanging', async () => {
    sb = await bootSwitchboard({ ...opts, signalBackend: 'harness' });
    const hireId = await heroId(sb.db.db);
    await sb.db.db.insert(s.scenarioBeats).values({ n: 5, status: 'playing' });
    // An inbound event nobody will deliver keeps the desk from ever looking quiet.
    await recordEvent(sb.db.db, { hireId, type: 'note.created', source: 'staff', actor: 'jo', payload: { body: 'never routed' } });
    expect(await sb.scenario.resume()).toEqual([5]);
    expect((await sb.scenario.state()).busy).toBe(true);
    await expect(sb.scenario.play(1)).rejects.toMatchObject({ message: 'a beat is still playing' });

    const t0 = Date.now();
    await sb.scenario.reset();
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(await sb.scenario.state()).toMatchObject({ beats: [], next: 1, busy: false });
  });

  it('an approve click on the open discount draft at beats 5 and 6, and the sweep at beat 7, are those beats', async () => {
    sb = await bootSwitchboard({ ...opts, signalBackend: 'harness' });
    const db = () => sb.db.db;
    expect(await sb.scenario.beatForSweep(HERO_REF)).toBeNull();
    for (const n of [1, 2, 3]) {
      await sb.scenario.play(n);
      expect(await waitBeat(sb, n)).toBe('done');
    }
    // Beat 3 played beat 4 itself, at the race moment: Jo's edit was queued behind the running desk.
    expect(await waitBeat(sb, 4)).toBe('done');
    const st = await sb.scenario.state();
    expect(st.next).toBe(5);
    const edit = (await db().select().from(s.signalsLog)).find((l) => l.tag === 'field_edit');
    expect(edit).toMatchObject({ kind: 'queued-message', outcome: 'queued' });
    expect(edit!.waitsForRunId).toBeTruthy();
    expect((await db().select().from(s.drafts).where(eq(s.drafts.ref, 'D-7')))[0]).toMatchObject({ status: 'stale', basedOnVersion: 4 });

    expect(await sb.scenario.beatForApproval('D-7', 'approved')).toBe(5);
    expect(await sb.scenario.beatForApproval('D-7', 'rejected')).toBeNull();
    expect(await sb.scenario.beatForApproval('D-99', 'approved')).toBeNull();
    expect(await sb.scenario.beatForSweep(HERO_REF)).toBeNull();
    expect(await sb.scenario.beatForSweep('NH-5512')).toBeNull();

    await sb.scenario.play(5);
    expect(await sb.scenario.beatForApproval('D-7', 'approved')).toBeNull(); // busy while it plays
    expect(await waitBeat(sb, 5)).toBe('done');
    expect((await db().select().from(s.drafts).where(eq(s.drafts.ref, 'D-8')))[0]).toMatchObject({ status: 'pending', basedOnVersion: 5 });
    expect(await sb.scenario.beatForApproval('D-7', 'approved')).toBeNull(); // superseded
    expect(await sb.scenario.beatForApproval('D-8', 'approved')).toBe(6);

    await sb.scenario.play(6); // crash disabled here: a plain apply
    expect(await waitBeat(sb, 6)).toBe('done');
    expect(await db().select().from(s.outbox)).toHaveLength(1);
    expect(await sb.scenario.beatForApproval('D-8', 'approved')).toBeNull();
    expect(await sb.scenario.beatForSweep(HERO_REF)).toBe(7);
    expect(await sb.scenario.beatForSweep('NH-5524')).toBeNull();
  });
});
