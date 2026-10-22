import { createScorer } from '@mastra/core/evals';
import { priceHire } from '@switchboard/core';
import { checkReply } from '../tools/desk-tools';

/**
 * Code-based Mastra scorers for the desk's customer-facing drafts. No judge model: they run on
 * scripted and replayed desks with no API key, in CI. Each takes one `DraftCase` (a draft plus the
 * hire as it was when the draft was written and the evidence it cites) and returns 0..1.
 */
export type SnapshotLine = { kind: string; model: string; description: string; fleetNo: string | null; status: 'booked' | 'on_hire' | 'cancelled'; weeklyRatePence: number; quantity: number };
export type DraftCase = {
  ref: string;
  intent: string;
  status: string;
  basedOnVersion: number;
  reply: { body: string; to: string[]; threadLabel?: string } | null;
  actions: Array<{ type: string; discountPct?: number; lineNo?: number }>;
  pricing: Record<string, unknown> | null;
  evidence: Array<{ id: string; sourceType: string; hireMatches: boolean }>;
  /** The hire snapshot at `basedOnVersion` (app.hire_versions). */
  hire: {
    deliveryDate: string;
    durationDays: number;
    discountPct: number;
    waiverRatePct: number;
    damageWaiver: boolean;
    transportPence: number;
    totalPence: number;
    lines: Record<string, SnapshotLine>;
  };
};

/** Evidence each intent must rest on: the open request that justifies it. */
export const EXPECTED_EVIDENCE: Record<string, string[][]> = {
  // Gary's note and the call transcript (beats 3 and 5).
  discount: [['note'], ['transcript']],
  // The unsigned waiver document (beat 7).
  'waiver-chaser': [['document']],
  // The customer's email or the staff status change (beat 8).
  cancel: [['email', 'note']],
};

const expectedFor = (intent: string) => EXPECTED_EVIDENCE[intent.startsWith('cancel-line') ? 'cancel' : intent] ?? [];

function allowedPence(c: DraftCase): number[] {
  const lines = Object.entries(c.hire.lines).map(([no, l]) => ({ ...l, lineNo: Number(no) }));
  const base = priceHire({ lines, durationDays: c.hire.durationDays, discountPct: 0, damageWaiver: c.hire.damageWaiver, transportPence: c.hire.transportPence, waiverRatePct: c.hire.waiverRatePct });
  const preview = Object.values(c.pricing ?? {}).flatMap((v) => (typeof v === 'number' ? [v] : Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : []));
  return [...preview, ...Object.values(base), c.hire.totalPence, ...lines.map((l) => l.weeklyRatePence)];
}

export const citesEvidenceScorer = createScorer<DraftCase, DraftCase>({
  id: 'cites-evidence',
  description: 'Every customer-facing draft cites at least one evidence id, and every id belongs to this hire.',
}).generateScore(({ run }) => {
  const c = run.output;
  if (!c.reply) return 1;
  if (!c.evidence.length) return 0;
  return c.evidence.filter((e) => e.hireMatches).length / c.evidence.length;
});

export const noUnsupportedFactsScorer = createScorer<DraftCase, DraftCase>({
  id: 'no-unsupported-facts',
  description: 'Every price, date, weekday and percentage in the reply is backed by the hire version the draft was written against.',
})
  .preprocess(({ run }) => {
    const c = run.output;
    if (!c.reply) return { facts: 0, unsupported: [] as string[] };
    const percents = c.actions.flatMap((a) => (a.type === 'applyPricing' && typeof a.discountPct === 'number' ? [a.discountPct] : []));
    const res = checkReply(c.reply.body, allowedPence(c), { deliveryDate: c.hire.deliveryDate, durationDays: c.hire.durationDays, discountPct: String(c.hire.discountPct), waiverRatePct: String(c.hire.waiverRatePct) }, { percents });
    const facts = (c.reply.body.match(/£|\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\b|\d+\s?%|\b\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/g) ?? []).length;
    return { facts, unsupported: res.unsupported };
  })
  .generateScore(({ results }) => {
    const r = results.preprocessStepResult as { facts: number; unsupported: string[] };
    // The fact count is a rough regex; checkReply knows more spellings (GBP 3700, 05/11, "per cent",
    // 5th November). Every unsupported fact is a fact, so it can never be out-counted to a pass.
    const total = Math.max(r.facts, r.unsupported.length);
    if (!total) return 1;
    return Math.max(0, 1 - r.unsupported.length / total);
  })
  .generateReason(({ results }) => {
    const r = results.preprocessStepResult as { facts: number; unsupported: string[] };
    return r.unsupported.length ? `unsupported: ${r.unsupported.join(', ')}` : `${r.facts} facts, all backed by the hire`;
  });

export const linksOpenRequestScorer = createScorer<DraftCase, DraftCase>({
  id: 'links-open-request',
  description: 'The draft cites the request that opened it: the note and call for the discount, the waiver for the chaser, the email or status change for a cancellation.',
}).generateScore(({ run }) => {
  const c = run.output;
  const groups = expectedFor(c.intent);
  if (!groups.length) return 1;
  const kinds = new Set(c.evidence.map((e) => e.sourceType));
  return groups.filter((g) => g.some((k) => kinds.has(k))).length / groups.length;
});

export const replyAddressedScorer = createScorer<DraftCase, DraftCase>({
  id: 'reply-addressed',
  description: 'The reply goes to a real recipient on an email thread of this hire.',
}).generateScore(({ run }) => {
  const r = run.output.reply;
  if (!r) return 1;
  return r.to.length > 0 && r.to.every((t) => /@/.test(t)) && Boolean(r.threadLabel) ? 1 : 0;
});

export const DRAFT_SCORERS = [citesEvidenceScorer, noUnsupportedFactsScorer, linksOpenRequestScorer, replyAddressedScorer];
