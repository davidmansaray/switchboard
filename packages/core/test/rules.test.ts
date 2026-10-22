import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TIERS,
  approvalOutcome,
  canTransition,
  classifyChange,
  diffSnapshots,
  formatDiff,
  isStale,
  keys,
  lineCreditPence,
  mergeEdits,
  planWake,
  priceHire,
  tierOf,
} from '../src';

describe('approval tiers', () => {
  it('auto-applies only routine fields; unknown fields fail closed', () => {
    expect(tierOf('poNumber')).toBe('auto');
    expect(tierOf('invoiceAddress')).toBe('auto');
    expect(tierOf('discountPct')).toBe('approval');
    expect(tierOf('somethingNew')).toBe('approval');
    expect(classifyChange(['poNumber', 'invoiceAddress']).tier).toBe('auto');
    expect(classifyChange(['poNumber', 'deliveryDate'])).toEqual({ tier: 'approval', approvalFields: ['deliveryDate'] });
    expect(classifyChange([]).tier).toBe('approval');
  });
  it('price, dates and cancellations need approval', () => {
    for (const f of ['totalPence', 'deliveryDate', 'status', 'lineStatus']) expect(APPROVAL_TIERS[f as keyof typeof APPROVAL_TIERS].tier).toBe('approval');
  });
});

describe('action keys', () => {
  it('derive from intent, not from the run or the source', () => {
    expect(keys.cancelLine('NH-5520', 2)).toBe('cancel-line:nh-5520:2');
    expect(keys.cancelLine('NH-5520', 2)).toBe(keys.cancelLine('nh-5520 ', 2));
    expect(keys.applyDraft('D-8')).toBe('apply:d-8');
    expect(keys.proposal('NH-5520', 'discount', 4)).not.toBe(keys.proposal('NH-5520', 'discount', 5));
  });
});

describe('wake rules', () => {
  const plan = (type: string, source = 'customer', payload: Record<string, unknown> = {}) => planWake({ type, source, payload });
  it('emails and @mentions wake or inject; edits queue with debounce; approvals queue as signals', () => {
    expect(plan('email.received')).toMatchObject({ deliver: true, kind: 'message', ifIdle: 'wake', ifActive: 'deliver' });
    expect(plan('note.created', 'staff', { body: '@assistant 10% off', mentions: ['assistant'] })).toMatchObject({ kind: 'message' });
    expect(plan('note.created', 'staff', { body: 'fyi', mentions: [] })).toMatchObject({ kind: 'signal', ifIdle: 'persist', ifActive: 'persist' });
    expect(plan('hire.updated', 'staff')).toMatchObject({ kind: 'queued-message', debounceMs: 1500 });
    expect(plan('approval.decided', 'staff')).toMatchObject({ kind: 'queued-signal', tag: 'approval' });
    expect(plan('status.changed', 'staff')).toMatchObject({ kind: 'queued-signal', tag: 'status_change' });
    expect(plan('schedule.fired', 'schedule')).toMatchObject({ kind: 'schedule', ifActive: 'persist', ifIdle: 'wake' });
  });
  it("never wakes on the desk's own writes", () => {
    expect(plan('hire.updated', 'agent')).toEqual({ deliver: false, reason: 'agent-authored event' });
  });
  it('debounce merges edits into one version range', () => {
    const a = { hireId: 'h', fromVersion: 4, toVersion: 5, fields: ['deliveryDate'], summaries: ['a'], eventIds: ['1'] };
    const b = { hireId: 'h', fromVersion: 5, toVersion: 6, fields: ['lines.2.model', 'deliveryDate'], summaries: ['b'], eventIds: ['2'] };
    expect(mergeEdits(a, b)).toEqual({ hireId: 'h', fromVersion: 4, toVersion: 6, fields: ['deliveryDate', 'lines.2.model'], summaries: ['a', 'b'], eventIds: ['1', '2'] });
    expect(() => mergeEdits(a, { ...b, hireId: 'x' })).toThrow();
  });
});

describe('drafts', () => {
  it('state machine', () => {
    expect(canTransition('pending', 'stale')).toBe(true);
    expect(canTransition('stale', 'superseded')).toBe(true);
    expect(canTransition('applied', 'pending')).toBe(false);
    expect(canTransition('superseded', 'approved')).toBe(false);
  });
  it('approving a stale draft regenerates, never applies', () => {
    expect(isStale(4, 5)).toBe(true);
    expect(approvalOutcome('pending', 5, 5)).toBe('apply');
    expect(approvalOutcome('pending', 4, 5)).toBe('regenerate');
    expect(approvalOutcome('stale', 4, 5)).toBe('regenerate');
    expect(approvalOutcome('applied', 5, 5)).toBe('reject-invalid');
  });
});

describe('version diffing', () => {
  it('diffs nested snapshots and formats v4 → v5', () => {
    const v4 = { deliveryDate: '2026-11-02', lines: { '2': { model: 'JCB 535-95', weeklyRatePence: 90000 } }, updatedAt: 'x' };
    const v5 = { deliveryDate: '2026-11-04', lines: { '2': { model: 'Manitou MT 1335', weeklyRatePence: 95000 } }, updatedAt: 'y' };
    const d = diffSnapshots(v4, v5);
    expect(d.map((x) => x.path)).toEqual(['deliveryDate', 'lines.2.model', 'lines.2.weeklyRatePence', 'updatedAt']);
    expect(formatDiff(4, 5, d)).toBe('v4 → v5: deliveryDate 2026-11-02 → 2026-11-04; lines.2.model JCB 535-95 → Manitou MT 1335; lines.2.weeklyRatePence 90000 → 95000');
    expect(formatDiff(1, 2, [])).toBe('v1 → v2: no business changes');
  });
});

describe('pricing', () => {
  const lines = [
    { lineNo: 1, weeklyRatePence: 118000, quantity: 1, status: 'booked' as const },
    { lineNo: 2, weeklyRatePence: 79000, quantity: 1, status: 'booked' as const },
  ];
  const base = { durationDays: 14, damageWaiver: true, transportPence: 18000 };
  it('NH-5520 is £4,120 incl. transport for two weeks, plus a 12% waiver on net and 20% VAT', () => {
    expect(priceHire({ ...base, lines, discountPct: 0 })).toEqual({
      hireChargesPence: 394000,
      discountPence: 0,
      netPence: 394000,
      transportPence: 18000,
      subtotalPence: 412000,
      waiverPence: 47280,
      vatPence: 91856,
      totalPence: 551136,
    });
  });
  it('D-7 is £3,726 on v4; D-8 is £3,852 after the TH17-05 swap; cancelled lines drop out', () => {
    expect(priceHire({ ...base, lines, discountPct: 10 }).subtotalPence).toBe(372600);
    const v5 = [lines[0]!, { ...lines[1]!, weeklyRatePence: 86000 }];
    expect(priceHire({ ...base, lines: v5, discountPct: 10 }).subtotalPence).toBe(385200);
    expect(priceHire({ ...base, lines: [v5[0]!, { ...v5[1]!, status: 'cancelled' }], discountPct: 10 }).subtotalPence).toBe(230400);
    expect(lineCreditPence(v5[1]!, 14, 10)).toBe(154800);
    expect(priceHire({ ...base, lines, discountPct: 0, damageWaiver: false }).waiverPence).toBe(0);
  });
});
