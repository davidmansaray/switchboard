import { HERO_REF, schema as s } from '@switchboard/db';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Switchboard } from '../../src/runtime';
import { beats } from '../../src/scenario/beats';
import { BACKENDS, bootSwitchboard, heroId } from '../support/boot';

/** M3: approval tiers, draft chain and staleness — hero beats 1–5 as one story per backend. */
describe.each(BACKENDS)('M3 hero beats 1–5 (SIGNAL_BACKEND=%s)', (backend) => {
  let sb: Switchboard;
  let hireId: string;
  const db = () => sb.db.db;
  const hire = async () => (await db().select().from(s.hires).where(eq(s.hires.id, hireId)))[0]!;
  const draft = async (ref: string) => (await db().select().from(s.drafts).where(eq(s.drafts.ref, ref)))[0];

  beforeAll(async () => {
    sb = await bootSwitchboard({ signalBackend: backend, scriptedLatencyMs: 120 });
    hireId = await heroId(db());
  });
  afterAll(async () => {
    await sb?.stop();
  });

  it('beat 1: discount ask is recorded as an open loop, nothing drafted', async () => {
    expect((await hire()).version).toBe(3);
    await beats(sb.services)[1]();
    await sb.router.idle(hireId);
    expect(await db().select().from(s.drafts).where(eq(s.drafts.hireId, hireId))).toHaveLength(0);
    expect((await hire()).version).toBe(3);
  });

  it('beat 2: PO + invoice address are applied automatically (tier auto) and logged', async () => {
    await beats(sb.services)[2]();
    await sb.router.idle(hireId);
    const h = await hire();
    expect(h.poNumber).toBe('HAL-PO-88213');
    expect(h.invoiceAddress).toBe('Halden Build Ltd, Accounts Payable, 4 Canal Wharf, Leeds LS11 5PY');
    expect(h.version).toBe(4);
    expect(h.updatedBy).toBe('agent:desk');
    const actions = await db().select().from(s.agentActions).where(eq(s.agentActions.hireId, hireId));
    expect(actions.map((a) => a.tool)).toEqual(['applyRoutineUpdate']);
    expect(await db().select().from(s.approvals)).toHaveLength(0);
    // Same thread as beat 1: one desk per hire.
    const threads = new Set((await db().select().from(s.signalsLog).where(eq(s.signalsLog.hireId, hireId))).map((l) => (l.attributes as { thread?: string }).thread));
    expect(threads).toEqual(new Set(['T1', 'T2']));
    // Working memory carries beat 1's open loop forward next to the new one (the scripted desk
    // parses the loops out of the system prompt and writes the whole list back).
    const [desk] = await db().select().from(s.desks).where(eq(s.desks.hireId, hireId));
    const mem = await sb.mastra.getAgent('desk').getMemory();
    const wm = (await mem!.getWorkingMemory({ threadId: desk!.mastraThreadId, resourceId: desk!.resourceId })) ?? '';
    expect(wm).toMatch(/- \[open\] discount: Sam Fletcher \(T1\) asked for a discount/);
    expect(wm).toMatch(/- \[closed\] invoicing: PO HAL-PO-88213 \+ invoice address applied automatically/);
  });

  it('beats 3+4: D-7 is drafted on v4; Jo’s edit waits for the run, then D-7 goes stale', async () => {
    await beats(sb.services)[3]();
    // Jo edits while the desk is still working on Gary's note (after D-7 exists).
    for (let i = 0; i < 200 && !(await draft('D-7')); i++) await new Promise((r) => setTimeout(r, 20));
    const d7 = await draft('D-7');
    expect(d7).toMatchObject({ basedOnVersion: 4, status: 'pending', kind: 'bundle' });
    expect((d7!.payload as { pricing: { subtotalPence: number } }).pricing.subtotalPence).toBe(372600); // £3,726.00
    expect(d7!.evidenceIds.length).toBeGreaterThanOrEqual(2); // Gary's note + the call transcript
    await beats(sb.services)[4]();
    await sb.router.idle(hireId);

    expect((await hire()).version).toBe(5);
    expect(await draft('D-7')).toMatchObject({ status: 'stale', staleReason: 'hire moved v4 → v5' });
    const log = await db().select().from(s.signalsLog).where(eq(s.signalsLog.hireId, hireId)).orderBy(asc(s.signalsLog.createdAt));
    const edit = log.find((l) => l.tag === 'field_edit')!;
    expect(edit).toMatchObject({ kind: 'queued-message', outcome: 'queued' });
    const [v5] = await db().select().from(s.hireVersions).where(and(eq(s.hireVersions.hireId, hireId), eq(s.hireVersions.version, 5)));
    expect((v5!.diff as Array<{ path: string }>).map((d) => d.path).sort()).toEqual(['deliveryDate', 'lines.2.description', 'lines.2.fleetNo', 'lines.2.model', 'lines.2.weeklyRatePence']);
    expect(v5!.changedBy).toBe('jo');
  });

  it('beat 5: approving stale D-7 regenerates D-8 on v5 (chain D-7 → D-8) and asks again', async () => {
    // Staff cannot approve: refused server-side, nothing recorded, nothing signalled.
    await expect(sb.services.decideApproval({ draftRef: 'D-7', staffId: 'jo', decision: 'approved' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await db().select().from(s.approvals)).toHaveLength(0);
    const r = await beats(sb.services)[5]();
    expect(r.duplicate).toBe(false);
    // A double-tap on the phone is the same approval.
    const again = await beats(sb.services)[5]();
    expect(again.duplicate).toBe(true);
    await sb.router.idle(hireId);

    const d7 = await draft('D-7');
    const d8 = await draft('D-8');
    expect(d7!.status).toBe('superseded');
    expect(d8).toMatchObject({ basedOnVersion: 5, status: 'pending', supersedesId: d7!.id });
    const reply = (d8!.payload as { reply: { body: string } }).reply.body;
    expect(reply).toContain('Wednesday 4 November');
    expect(reply).toContain('TH17-05 17m telehandler');
    expect(reply).toContain('£3,852.00'); // (1180 + 860) × 2 × 0.9 + £180 transport
    expect((await hire()).version).toBe(5); // nothing applied
    expect(await db().select().from(s.outbox)).toHaveLength(0);
    const approvals = await db().select().from(s.approvals);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ draftId: d7!.id, decidedBy: 'gary', decision: 'approved', channel: 'mobile', hireVersionAtDecision: 5 });
    // The double tap is one approval signal, and approving a stale draft applied nothing.
    const approvalSignals = (await db().select().from(s.signalsLog).where(eq(s.signalsLog.hireId, hireId))).filter((l) => l.tag === 'approval');
    expect(approvalSignals).toHaveLength(1);
    expect(approvalSignals[0]!.kind).toBe('queued-signal');
    const actions = await db().select().from(s.agentActions).where(eq(s.agentActions.hireId, hireId));
    expect(actions.map((a) => a.actionKey).filter((k) => /^(apply|email|cancel-line|credit-note):/.test(k))).toEqual([]);
    const [ev] = await db().select().from(s.events).where(and(eq(s.events.hireId, hireId), eq(s.events.type, 'approval.decided')));
    expect(ev!.payload).toMatchObject({ draftRef: 'D-7', applies: false, basedOnVersion: 4, hireVersion: 5 });
    expect(ev!.processedAt).not.toBeNull();
    // A second approver acting on the superseded D-7 is refused; only D-8 can be approved now.
    await expect(sb.services.decideApproval({ draftRef: 'D-7', staffId: 'aisha', decision: 'approved' })).rejects.toMatchObject({ code: 'INVALID' });
    expect(await db().select().from(s.approvals)).toHaveLength(1);
    const [desk] = await db().select().from(s.desks).where(eq(s.desks.hireId, hireId));
    expect(desk!.runState).toBe('awaiting_approval');
    expect(HERO_REF).toBe('NH-5520');
  });
});
