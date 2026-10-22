import { HERO_REF, schema as s } from '@switchboard/db';
import { asc, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { Switchboard } from '../../src/runtime';
import { BEAT_EMAILS, beats } from '../../src/scenario/beats';
import { BACKENDS, bootSwitchboard, heroId } from '../support/boot';

describe.each(BACKENDS)('M2 desk + signals adapter (SIGNAL_BACKEND=%s)', (backend) => {
  let sb: Switchboard;
  afterEach(async () => {
    await sb?.stop();
  });

  it('a signal wakes an idle desk, and the desk works through tools', async () => {
    sb = await bootSwitchboard({ signalBackend: backend });
    const db = sb.db.db;
    const hireId = await heroId(db);
    const [before] = await db.select().from(s.desks).where(eq(s.desks.hireId, hireId));
    expect(before!.runState).toBe('idle');

    const r = await beats(sb.services)[1]();
    expect(r.duplicate).toBe(false);
    const steps = new Set<string>();
    for (let i = 0; i < 100 && !sb.router.backend.isIdle(hireId); i++) {
      const [d] = await db.select({ step: s.desks.currentStep }).from(s.desks).where(eq(s.desks.hireId, hireId));
      if (d?.step) steps.add(d.step);
      await new Promise((res) => setTimeout(res, 20));
    }
    await sb.router.idle(hireId);
    if (backend === 'harness') expect([...steps]).toContain('getHire(NH-5520)');
    const attempts = await db.select().from(s.actionAttempts).where(eq(s.actionAttempts.hireId, hireId));
    expect(attempts).toHaveLength(0); // beat 1 writes nothing

    const log = await db.select().from(s.signalsLog).where(eq(s.signalsLog.hireId, hireId));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'message', outcome: 'delivered', backend, tag: 'email' });
    // Beat 1: an open ask is recorded, nothing customer-facing is drafted.
    expect(await db.select().from(s.drafts).where(eq(s.drafts.hireId, hireId))).toHaveLength(0);
    const [ev] = await db.select().from(s.events).where(eq(s.events.type, 'email.received'));
    expect(ev!.processedAt).not.toBeNull();
    const [desk] = await db.select().from(s.desks).where(eq(s.desks.hireId, hireId));
    expect(desk!.runState).toBe('idle');

    const mem = await sb.mastra.getAgent('desk').getMemory();
    const wm = await mem!.getWorkingMemory({ threadId: desk!.mastraThreadId, resourceId: desk!.resourceId });
    expect(wm).toMatch(/- \[open\] discount: Sam Fletcher \(T1\) asked for a discount: "Can you knock something off NH-5520\?/);
  });

  it('inbound email is deduplicated by message id', async () => {
    sb = await bootSwitchboard({ signalBackend: backend });
    const hireId = await heroId(sb.db.db);
    await sb.services.ingestEmail(BEAT_EMAILS.discountAsk);
    const again = await sb.services.ingestEmail(BEAT_EMAILS.discountAsk);
    expect(again.duplicate).toBe(true);
    await sb.router.idle(hireId);
    expect(await sb.db.db.select().from(s.signalsLog).where(eq(s.signalsLog.hireId, hireId))).toHaveLength(1);
  });

  it('a queued message waits for the running desk, then runs next', async () => {
    sb = await bootSwitchboard({ signalBackend: backend, scriptedLatencyMs: 250 });
    const db = sb.db.db;
    const hireId = await heroId(db);
    await beats(sb.services)[1]();
    // While the desk works on Sam's email, Jo edits the hire directly.
    await new Promise((r) => setTimeout(r, 150));
    const edit = await sb.services.editHire({ hireRef: HERO_REF, staffId: 'jo', changes: { deliverySlot: 'PM' } });
    expect(edit.changed).toBe(true);
    await sb.router.idle(hireId);

    const log = await db.select().from(s.signalsLog).where(eq(s.signalsLog.hireId, hireId)).orderBy(asc(s.signalsLog.createdAt));
    expect(log.map((l) => [l.kind, l.outcome])).toEqual([
      ['message', 'delivered'],
      ['queued-message', 'queued'],
    ]);
    const evs = await db.select().from(s.events).where(eq(s.events.hireId, hireId)).orderBy(asc(s.events.createdAt));
    const email = evs.find((e) => e.type === 'email.received')!;
    const editEv = evs.find((e) => e.type === 'hire.updated' && e.source === 'staff')!;
    expect(email.processedAt).not.toBeNull();
    expect(editEv.processedAt).not.toBeNull();
    // The edit was handled in its own, later turn (not injected into the email's run).
    expect(editEv.processedAt!.getTime()).toBeGreaterThan(email.processedAt!.getTime());
    expect(email.runId).toBeTruthy();
    expect(editEv.runId).toBeTruthy();
    expect(editEv.runId).not.toBe(email.runId);
    // The queued row names the run it waited for: the email's run.
    expect(log[0]!.eventId).toBe(email.id);
    expect(log[1]!.eventId).toBe(editEv.id);
    expect(log[1]!.waitsForRunId).toBe(email.runId);
    expect(log[0]!.waitsForRunId).toBeNull();
    const [desk] = await db.select().from(s.desks).where(eq(s.desks.hireId, hireId));
    expect(desk!.runState).toBe('idle');
  });

  it('a plain internal note is persisted as context without waking the desk', async () => {
    sb = await bootSwitchboard({ signalBackend: backend });
    const db = sb.db.db;
    const hireId = await heroId(db);
    const r = await sb.services.addNote({ hireRef: HERO_REF, authorId: 'jo', body: 'FYI the site gate code changed to 4471.' });
    expect(r.delivery).toMatchObject({ outcome: 'persisted' });
    await sb.router.idle(hireId);
    const log = await db.select().from(s.signalsLog).where(eq(s.signalsLog.hireId, hireId));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'signal', outcome: 'persisted', tag: 'note', backend, runId: null });
    // No run: nothing called, desk still idle.
    expect(await db.select().from(s.actionAttempts).where(eq(s.actionAttempts.hireId, hireId))).toHaveLength(0);
    const [desk] = await db.select().from(s.desks).where(eq(s.desks.hireId, hireId));
    expect(desk!.runState).toBe('idle');
    expect(desk!.activeRunId).toBeNull();
    if (backend === 'harness') {
      // Persisted means written into the desk's thread, where the next run will see it.
      const mem = await sb.mastra.getAgent('desk').getMemory();
      const { messages } = await mem!.recall({ threadId: desk!.mastraThreadId, resourceId: desk!.resourceId, hideSignals: false });
      expect(JSON.stringify(messages)).toContain('gate code changed to 4471');
    }

    // The next real wake-up carries on from there; the note is not left behind as unprocessed.
    await beats(sb.services)[1]();
    await sb.router.idle(hireId);
    const [note] = await db.select().from(s.events).where(eq(s.events.id, r.event.id));
    expect(note!.processedAt).not.toBeNull();
    expect(await sb.router.redeliverUnprocessed()).toBe(0);
  });
});
