import { HERO_REF, schema as s } from '@switchboard/db';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Switchboard } from '../../src/runtime';
import { BACKENDS, bootSwitchboard, heroId } from '../support/boot';
import { playBeats } from '../support/story';

/**
 * M7 open risk: an approved draft whose hire moves *after* the approval and *before* the apply.
 * Gary approves the current D-8; the desk's applyPricing is held (a stalled tool) while Jo changes
 * the delivery slot. The apply must come back STALE, the draft must not stay "approved" forever,
 * and the scripted desk must regenerate it against the new version without applying or sending
 * anything. Approving the regenerated draft then applies once and sends one email.
 */
describe.each(BACKENDS)('overtaken approval → stale → regenerated (SIGNAL_BACKEND=%s)', (backend) => {
  let sb: Switchboard;
  let hireId: string;
  const db = () => sb.db.db;
  const draft = async (ref: string) => (await db().select().from(s.drafts).where(eq(s.drafts.ref, ref)))[0];
  const hire = async () => (await db().select().from(s.hires).where(eq(s.hires.id, hireId)))[0]!;

  beforeAll(async () => {
    sb = await bootSwitchboard({ signalBackend: backend, scriptedLatencyMs: 40 });
    hireId = await heroId(db());
    await playBeats(sb, hireId, 5);
    expect(await draft('D-8')).toMatchObject({ status: 'pending', basedOnVersion: 5 });
  });
  afterAll(async () => {
    await sb?.stop();
  });

  it('the apply comes back STALE, D-8 is marked stale with the reason and regenerated as D-9 on v6; nothing applied or sent', async () => {
    const before = await hire();
    sb.crash.armHang('applyPricing', 2_500);
    await sb.services.decideApproval({ draftRef: 'D-8', staffId: 'gary', decision: 'approved', channel: 'mobile' });
    expect((await draft('D-8'))!.status).toBe('approved');

    // The desk is inside applyPricing (step row written, the write itself stalled): Jo moves the hire now.
    for (let i = 0; i < 300; i++) {
      const [st] = await db().select().from(s.deskSteps).where(and(eq(s.deskSteps.hireId, hireId), eq(s.deskSteps.tool, 'applyPricing')));
      if (st) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const edit = await sb.services.editHire({ hireRef: HERO_REF, staffId: 'jo', changes: { deliverySlot: 'PM' } });
    expect(edit.changed).toBe(true);
    expect((await hire()).version).toBe(6);
    // The staleness trigger only touches pending drafts: the approved one is still "approved" here.
    expect((await draft('D-8'))!.status).toBe('approved');

    // 75 s, not 30: once in ~10 runs on SIGNAL_BACKEND=app the durable generate() of this turn stalled
    // past 30 s (the execution-lease TTL) before finishing; the outcome was still correct.
    await sb.router.idle(hireId, 75_000);

    const d8 = await draft('D-8');
    const d9 = await draft('D-9');
    expect(d8).toMatchObject({ status: 'superseded', staleReason: 'approved on v5, but the hire moved to v6 before it was applied' });
    expect(d9).toMatchObject({ status: 'pending', basedOnVersion: 6, supersedesId: d8!.id, kind: 'bundle' });
    const p9 = d9!.payload as { intent: string; actions: unknown[]; reply: { body: string } };
    expect(p9.intent).toBe('discount');
    expect(p9.actions).toEqual([{ type: 'applyPricing', discountPct: 10 }]);
    expect(p9.reply.body).toContain('Wednesday 4 November (PM)');
    expect(d9!.evidenceIds).toEqual(d8!.evidenceIds);

    // Nothing applied, nothing sent: the ledger only saw a rejected attempt.
    expect(await hire()).toMatchObject({ version: 6, totalPence: before.totalPence, discountPct: before.discountPct });
    expect(Number(before.discountPct)).toBe(0);
    expect(await db().select().from(s.outbox).where(eq(s.outbox.hireId, hireId))).toHaveLength(0);
    expect(await db().select().from(s.agentActions).where(and(eq(s.agentActions.hireId, hireId), like(s.agentActions.actionKey, '%d-8')))).toHaveLength(0);
    const attempts = await db().select().from(s.actionAttempts).where(and(eq(s.actionAttempts.hireId, hireId), eq(s.actionAttempts.actionKey, 'apply:d-8')));
    expect(attempts.map((a) => a.status)).toEqual(['rejected_version']);
    const [step] = await db().select().from(s.deskSteps).where(and(eq(s.deskSteps.hireId, hireId), eq(s.deskSteps.tool, 'applyPricing')));
    expect(step).toMatchObject({ status: 'STALE', text: 'applyPricing(D-8, expected v5) → STALE: hire is v6' });

    const [desk] = await db().select().from(s.desks).where(eq(s.desks.hireId, hireId));
    expect(desk!.runState).toBe('awaiting_approval');
    const mem = await sb.mastra.getAgent('desk').getMemory();
    const wm = await mem!.getWorkingMemory({ threadId: desk!.mastraThreadId, resourceId: desk!.resourceId });
    expect(wm).toMatch(/- \[decided\] discount: D-8 approved, but the hire moved after the approval\. Regenerated as D-9 for v6/);
    const unprocessed = await db().select().from(s.events).where(eq(s.events.hireId, hireId));
    expect(unprocessed.filter((e) => e.source !== 'agent' && !e.processedAt)).toHaveLength(0);
  });

  it('approving the regenerated D-9 applies it once and sends exactly one email', async () => {
    await sb.services.decideApproval({ draftRef: 'D-9', staffId: 'gary', decision: 'approved' });
    await sb.router.idle(hireId, 30_000);
    expect((await draft('D-9'))!.status).toBe('applied');
    const h = await hire();
    expect(h.version).toBe(7);
    expect(Number(h.discountPct)).toBe(10);
    const outbox = await db().select().from(s.outbox).where(eq(s.outbox.hireId, hireId));
    expect(outbox.map((o) => o.idempotencyKey)).toEqual(['email:d-9']);
    expect(outbox[0]!.body).toContain('(PM)');
  });
});
