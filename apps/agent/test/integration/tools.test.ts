import { schema as s } from '@switchboard/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDeskTools } from '../../src/tools/desk-tools';
import { CrashSwitch } from '../../src/tools/ledger';
import { createDb, withActor, type DbHandle } from '@switchboard/db';
import { resetDatabase } from '@switchboard/db/reset';

/** Tool preconditions and idempotency, called directly (no model). */
describe('desk tools: preconditions + idempotency', () => {
  let h: DbHandle;
  let tools: ReturnType<typeof createDeskTools>;
  const ctx = (threadId = 'desk:NH-5520') => ({ agent: { threadId, resourceId: 'r', toolCallId: 't', messages: [], suspend: async () => {} } });
  const exec = <K extends keyof typeof tools>(name: K, input: unknown, c = ctx()) =>
    (tools[name] as unknown as { execute: (i: unknown, c: unknown) => Promise<{ status: string; [k: string]: unknown }> }).execute(input, c);

  const hero = async () => (await h.db.select().from(s.hires).where(eq(s.hires.ref, 'NH-5520')))[0]!;
  const draftRow = async (ref: string) => (await h.db.select().from(s.drafts).where(eq(s.drafts.ref, ref)))[0]!;
  const ledger = async (actionKey: string) => h.db.select().from(s.agentActions).where(eq(s.agentActions.actionKey, actionKey));
  const attempts = async (actionKey: string) =>
    (await h.db.select().from(s.actionAttempts).where(eq(s.actionAttempts.actionKey, actionKey))).map((a) => a.status).sort();
  const transcriptEvidence = async () => (await h.db.select().from(s.evidenceChunks).where(eq(s.evidenceChunks.sourceType, 'transcript')))[0]!.id;
  /** Simulate Gary approving in the UI: an approver's row + the draft moved to approved. */
  const approve = async (ref: string, by = 'gary') => {
    const d = await draftRow(ref);
    await h.db.insert(s.approvals).values({ draftId: d.id, decidedBy: by, decision: 'approved', idempotencyKey: `test:${ref}:${by}`, hireVersionAtDecision: (await hero()).version });
    await h.db.update(s.drafts).set({ status: 'approved' }).where(eq(s.drafts.ref, ref));
  };
  /** Jo changes an approval-tier field directly: a new, material hire version. */
  const joBumpsHire = async () => {
    const cur = await hero();
    await withActor(h.db, 'jo', (tx) => tx.update(s.hires).set({ deliverySlot: cur.deliverySlot === 'AM' ? 'PM' : 'AM' }).where(eq(s.hires.id, cur.id)));
    return (await hero()).version;
  };

  beforeAll(async () => {
    await resetDatabase(process.env.DATABASE_URL);
    h = createDb(process.env.DATABASE_URL, { max: 6 });
    tools = createDeskTools({ db: h.db, crash: new CrashSwitch() });
  });
  afterAll(async () => h?.close());

  it('a desk can only touch its own hire (reads and writes)', async () => {
    expect(await exec('getHire', { hireRef: 'NH-5498' })).toMatchObject({ status: 'REJECTED', reason: expect.stringMatching(/cannot act on NH-5498/) });
    expect(await exec('getHire', { hireRef: 'NH-5520' })).toMatchObject({ status: 'OK' });
    // Another desk's thread may not write to NH-5520 either.
    expect(await exec('applyRoutineUpdate', { hireRef: 'NH-5520', expectedVersion: 3, changes: { poNumber: 'PO-X' } }, ctx('desk:NH-5498'))).toMatchObject({
      status: 'REJECTED',
      reason: expect.stringMatching(/cannot act on NH-5520/),
    });
    expect((await hero()).version).toBe(3);
  });

  it('routine updates: auto tier only, version precondition, same key twice is one write', async () => {
    expect(await exec('applyRoutineUpdate', { hireRef: 'NH-5520', expectedVersion: 3, changes: { deliveryDate: '2026-12-01' } })).toMatchObject({
      status: 'REJECTED',
      reason: 'needs approval: deliveryDate',
    });
    // A routine field smuggled alongside an approval field does not get through.
    expect(await exec('applyRoutineUpdate', { hireRef: 'NH-5520', expectedVersion: 3, changes: { poNumber: 'PO-9', discountPct: 25 } })).toMatchObject({
      status: 'REJECTED',
      reason: 'needs approval: discountPct',
    });
    // Unknown fields fail closed.
    expect(await exec('applyRoutineUpdate', { hireRef: 'NH-5520', expectedVersion: 3, changes: { siteNotes: 'x' } })).toMatchObject({ status: 'REJECTED', reason: 'needs approval: siteNotes' });
    expect((await hero()).version).toBe(3);

    expect(await exec('applyRoutineUpdate', { hireRef: 'NH-5520', expectedVersion: 2, changes: { poNumber: 'PO-9' } })).toMatchObject({ status: 'STALE', expectedVersion: 2, currentVersion: 3 });
    // A STALE attempt rolls its ledger row back, so the same key can still be applied later.
    expect(await ledger('routine:nh-5520:ponumber:po-9')).toHaveLength(0);

    const [a, b] = await Promise.all([
      exec('applyRoutineUpdate', { hireRef: 'NH-5520', expectedVersion: 3, changes: { poNumber: 'PO-9' } }),
      exec('applyRoutineUpdate', { hireRef: 'NH-5520', expectedVersion: 3, changes: { poNumber: 'PO-9' } }),
    ]);
    expect([a!.status, b!.status].sort()).toEqual(['DUPLICATE', 'OK']);
    // The duplicate hands back what the first call did, so a retried run sees the same result.
    const [ok, dup] = a!.status === 'OK' ? [a!, b!] : [b!, a!];
    expect(dup.result).toEqual(ok.result);
    expect(ok.result).toMatchObject({ version: 4, fields: ['poNumber'], tier: 'auto' });
    expect(await hero()).toMatchObject({ poNumber: 'PO-9', version: 4, updatedBy: 'agent:desk' });
    expect(await ledger('routine:nh-5520:ponumber:po-9')).toHaveLength(1);
    expect(await attempts('routine:nh-5520:ponumber:po-9')).toEqual(['recorded', 'rejected_version', 'skipped_duplicate']);
  });

  it('customer-facing drafts need evidence and may only state supported prices/days', async () => {
    const base = { hireRef: 'NH-5520', intent: 'discount', kind: 'bundle', title: 't', basedOnVersion: 4, actions: [{ type: 'applyPricing', discountPct: 10 }] };
    const reply = { threadLabel: 'T1', to: ['sam@x'], subject: 's', body: 'Hire price: £3,726.00 on Monday' };
    expect(await exec('proposeDraft', { ...base, reply, evidenceIds: [] })).toMatchObject({ status: 'REJECTED', reason: expect.stringMatching(/evidence/) });
    const ev = await transcriptEvidence();
    // Evidence from another hire does not count.
    const [foreign] = await h.db.select().from(s.evidenceChunks).where(sql`${s.evidenceChunks.hireId} <> ${(await hero()).id}`).limit(1);
    if (foreign) expect(await exec('proposeDraft', { ...base, reply, evidenceIds: [foreign.id] })).toMatchObject({ status: 'REJECTED', reason: expect.stringMatching(/unknown evidence/) });
    expect(await exec('proposeDraft', { ...base, reply: { ...reply, body: 'Hire price: £3,999.00' }, evidenceIds: [ev] })).toMatchObject({
      status: 'REJECTED',
      reason: expect.stringContaining('£3,999.00'),
    });
    expect(await exec('proposeDraft', { ...base, reply: { ...reply, body: 'Delivered Friday, £3,726.00' }, evidenceIds: [ev] })).toMatchObject({
      status: 'REJECTED',
      reason: expect.stringContaining('Friday'),
    });
    expect(await h.db.select().from(s.drafts).where(eq(s.drafts.ref, 'D-7'))).toHaveLength(0); // nothing rejected was written

    const ok = await exec('proposeDraft', { ...base, reply, evidenceIds: [ev] });
    expect(ok).toMatchObject({ status: 'OK', result: { draft: { ref: 'D-7', basedOnVersion: 4, status: 'pending' } } });
    // One open draft per intent.
    expect(await exec('proposeDraft', { ...base, reply, evidenceIds: [ev] })).toMatchObject({ status: 'DUPLICATE', result: { draft: { ref: 'D-7' } } });
    expect(await exec('proposeDraft', { ...base, basedOnVersion: 3, reply, evidenceIds: [ev] })).toMatchObject({ status: 'STALE', expectedVersion: 3, currentVersion: 4 });
    expect(await h.db.select().from(s.drafts).where(sql`${s.drafts.payload} ->> 'intent' = 'discount'`)).toHaveLength(1);
  });

  it('apply tools refuse drafts without an approver’s approval', async () => {
    expect(await exec('applyPricing', { hireRef: 'NH-5520', draftRef: 'D-7', expectedVersion: 4 })).toMatchObject({ status: 'REJECTED', reason: 'D-7 has no approval from an approver' });
    await approve('D-7', 'jo');
    // Jo is staff, not an approver.
    expect(await exec('applyPricing', { hireRef: 'NH-5520', draftRef: 'D-7', expectedVersion: 4 })).toMatchObject({ status: 'REJECTED', reason: 'D-7 has no approval from an approver' });
    expect(await exec('queueEmail', { hireRef: 'NH-5520', draftRef: 'D-7' })).toMatchObject({ status: 'REJECTED', reason: 'D-7 has no approval from an approver' });
    expect(await ledger('apply:d-7')).toHaveLength(0);
    // Gary (approver) approves: pricing applies once, email sends once.
    await approve('D-7', 'gary');
    const applied = await exec('applyPricing', { hireRef: 'NH-5520', draftRef: 'D-7', expectedVersion: 4 });
    expect(applied).toMatchObject({ status: 'OK', result: { version: 5, discountPct: 10, subtotalPence: 372600 } });
    expect(await exec('applyPricing', { hireRef: 'NH-5520', draftRef: 'D-7', expectedVersion: 4 })).toMatchObject({ status: 'DUPLICATE', result: applied.result });
    expect(await hero()).toMatchObject({ version: 5, totalPence: 372600 });
    expect(await exec('queueEmail', { hireRef: 'NH-5520', draftRef: 'D-7' })).toMatchObject({ status: 'OK' });
    expect(await exec('queueEmail', { hireRef: 'NH-5520', draftRef: 'D-7' })).toMatchObject({ status: 'DUPLICATE' });
    expect(await h.db.select().from(s.outbox)).toHaveLength(1);
    expect(await draftRow('D-7')).toMatchObject({ status: 'applied' });
    expect(await attempts('email:d-7')).toEqual(['recorded', 'rejected', 'skipped_duplicate']);
  });

  it('an approved draft whose hire moved on is STALE to apply, and its email is never sent on its own', async () => {
    const ev = await transcriptEvidence();
    const v = (await hero()).version;
    const r = await exec('proposeDraft', {
      hireRef: 'NH-5520',
      intent: 'discount',
      kind: 'bundle',
      title: '15% off',
      basedOnVersion: v,
      actions: [{ type: 'applyPricing', discountPct: 15 }],
      reply: { threadLabel: 'T1', to: ['sam@x'], subject: 's', body: 'Confirming the new price on NH-5520.' },
      evidenceIds: [ev],
    });
    expect(r).toMatchObject({ status: 'OK', result: { draft: { ref: 'D-8', basedOnVersion: v } } });
    await approve('D-8');
    // Jo moves the hire after the approval, before the desk applies it.
    const now = await joBumpsHire();
    expect(now).toBe(v + 1);
    expect(await exec('applyPricing', { hireRef: 'NH-5520', draftRef: 'D-8', expectedVersion: v })).toMatchObject({ status: 'STALE', expectedVersion: v, currentVersion: now });
    expect(await ledger('apply:d-8')).toHaveLength(0);
    // The reply confirms a price that was never applied: the outbox must refuse it (the draft is stale now).
    expect(await exec('queueEmail', { hireRef: 'NH-5520', draftRef: 'D-8' })).toMatchObject({ status: 'REJECTED', reason: 'D-8 is stale, not approved' });
    expect(await h.db.select().from(s.outbox)).toHaveLength(1); // still only D-7's email
    expect(await hero()).toMatchObject({ version: now });
    expect(Number((await hero()).discountPct)).toBe(10); // D-7's discount, not D-8's
    // Not stuck in `approved`: the apply tool marks it stale with the reason, so the desk regenerates it.
    expect(await draftRow('D-8')).toMatchObject({ status: 'stale', staleReason: expect.stringMatching(/approved on v\d+, but the hire moved to v\d+ before it was applied/) });
    // Retrying the apply after that is still refused (and does not resurrect the approval).
    expect(await exec('applyPricing', { hireRef: 'NH-5520', draftRef: 'D-8', expectedVersion: now })).toMatchObject({ status: 'REJECTED', reason: 'D-8 is stale, not approved' });
  });

  it('a credit note is only issued for a line that is actually cancelled', async () => {
    const ev = await transcriptEvidence();
    const v = (await hero()).version;
    const r = await exec('proposeDraft', {
      hireRef: 'NH-5520',
      intent: 'credit-only-line-1',
      kind: 'update',
      title: 'Credit line 1',
      basedOnVersion: v,
      actions: [{ type: 'creditNote', lineNo: 1 }],
      evidenceIds: [ev],
    });
    expect(r).toMatchObject({ status: 'OK' });
    const ref = (r as unknown as { result: { draft: { ref: string } } }).result.draft.ref;
    await approve(ref);
    expect(await exec('issueCreditNote', { hireRef: 'NH-5520', draftRef: ref, lineNo: 1 })).toMatchObject({
      status: 'REJECTED',
      reason: expect.stringMatching(/line 1 .* is (booked|on_hire), not cancelled/),
    });
    expect(await h.db.select().from(s.creditNotes)).toHaveLength(0);
    expect(await ledger('credit-note:nh-5520:1')).toHaveLength(0);
  });

  it('proposeDraft re-checks the version under the row lock (a concurrent edit makes it STALE, not a pending draft on an old version)', async () => {
    const ev = await transcriptEvidence();
    const v = (await hero()).version;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    // Jo's edit holds the hire row: written but not committed yet.
    const jo = withActor(h.db, 'jo', async (tx) => {
      const cur = await hero();
      await tx.update(s.hires).set({ deliverySlot: cur.deliverySlot === 'AM' ? 'PM' : 'AM' }).where(eq(s.hires.id, cur.id));
      locked();
      await gate;
    });
    await isLocked;
    const proposing = exec('proposeDraft', {
      hireRef: 'NH-5520',
      intent: 'race-check',
      kind: 'update',
      title: 'race',
      basedOnVersion: v,
      actions: [],
      evidenceIds: [ev],
    });
    // Wait until the proposal is blocked on the hire row lock, then let Jo commit.
    let waiting = 0;
    for (let i = 0; i < 200 && waiting === 0; i++) {
      const rows = (await h.db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)) as unknown as Array<{ n: number }>;
      waiting = rows[0]!.n;
      if (!waiting) await new Promise((r) => setTimeout(r, 10));
    }
    expect(waiting).toBeGreaterThan(0);
    release();
    await jo;
    expect(await proposing).toMatchObject({ status: 'STALE', expectedVersion: v, currentVersion: v + 1 });
    expect(await h.db.select().from(s.drafts).where(sql`${s.drafts.payload} ->> 'intent' = 'race-check'`)).toHaveLength(0);
    expect(await ledger(`propose:nh-5520:race-check:v${v}`)).toHaveLength(0);
  });

  it('one credit note per (hire, line), whichever draft asks for it', async () => {
    const ev = await transcriptEvidence();
    const propose = async (intent: string) => {
      const v = (await hero()).version;
      const r = await exec('proposeDraft', {
        hireRef: 'NH-5520',
        intent,
        kind: 'bundle',
        title: intent,
        basedOnVersion: v,
        actions: [
          { type: 'cancelLine', lineNo: 2 },
          { type: 'creditNote', lineNo: 2 },
        ],
        evidenceIds: [ev],
      });
      expect(r).toMatchObject({ status: 'OK' });
      return (r.result as { draft: { ref: string; basedOnVersion: number } }).draft;
    };
    // Two sources, two differently named intents: the action keys are still per (hire, line).
    const a = await propose('cancel-line-2');
    const b = await propose('cancel-telehandler');
    await approve(a.ref);
    await approve(b.ref);
    const cancelled = await exec('cancelLine', { hireRef: 'NH-5520', draftRef: a.ref, lineNo: 2, expectedVersion: a.basedOnVersion });
    expect(cancelled).toMatchObject({ status: 'OK', result: { lineNo: 2, alreadyCancelled: false } });
    const credit = await exec('issueCreditNote', { hireRef: 'NH-5520', draftRef: a.ref, lineNo: 2 });
    expect(credit).toMatchObject({ status: 'OK' });
    expect(await draftRow(a.ref)).toMatchObject({ status: 'applied' });

    expect(await exec('cancelLine', { hireRef: 'NH-5520', draftRef: b.ref, lineNo: 2, expectedVersion: b.basedOnVersion })).toMatchObject({ status: 'DUPLICATE', result: cancelled.result });
    expect(await exec('issueCreditNote', { hireRef: 'NH-5520', draftRef: b.ref, lineNo: 2 })).toMatchObject({ status: 'DUPLICATE', result: credit.result });
    const hireId = (await hero()).id;
    expect(await h.db.select().from(s.creditNotes).where(eq(s.creditNotes.hireId, hireId))).toHaveLength(1);
    const [line] = await h.db.select().from(s.hireLines).where(and(eq(s.hireLines.hireId, hireId), eq(s.hireLines.lineNo, 2)));
    expect(line!.status).toBe('cancelled');
  });
});
