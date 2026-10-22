import { describe, expect, it } from 'vitest';
import { citesEvidenceScorer, DRAFT_SCORERS, linksOpenRequestScorer, noUnsupportedFactsScorer, replyAddressedScorer, type DraftCase } from '../../src/evals/scorers';

/**
 * The eval scorers must be able to fail: the hero eval only asserts "every draft scores 1.0", which
 * a scorer that always returns 1 would also pass. Each scorer gets a good draft (1.0) and a bad one.
 */
const score = async (scorer: (typeof DRAFT_SCORERS)[number], c: DraftCase) => (await scorer.run({ input: c, output: c })).score;

// NH-5520 at v5: boom £1,180/wk + 17m telehandler £860/wk, two weeks from Wed 4 Nov, £180 transport.
const good: DraftCase = {
  ref: 'D-8',
  intent: 'discount',
  status: 'pending',
  basedOnVersion: 5,
  reply: {
    threadLabel: 'T1',
    to: ['sam.fletcher@haldenbuild.co.uk'],
    body: "As agreed with Gary, we've applied 10% off. Delivery: Wednesday 4 November (AM), 2 weeks. Hire price: £3,852.00 incl. transport (was £4,260.00), plus VAT.",
  },
  actions: [{ type: 'applyPricing', discountPct: 10 }],
  pricing: { discountPct: 10, subtotalPence: 385_200 },
  evidence: [
    { id: 'ev-note', sourceType: 'note', hireMatches: true },
    { id: 'ev-call', sourceType: 'transcript', hireMatches: true },
  ],
  hire: {
    deliveryDate: '2026-11-04',
    durationDays: 14,
    discountPct: 0,
    waiverRatePct: 12,
    damageWaiver: true,
    transportPence: 18_000,
    totalPence: 426_000,
    lines: {
      '1': { kind: 'boom', model: 'JLG 600AJ', description: '19m articulated boom lift', fleetNo: 'AB19-07', status: 'booked', weeklyRatePence: 118_000, quantity: 1 },
      '2': { kind: 'telehandler', model: 'Manitou MT 1840', description: '17m telehandler', fleetNo: 'TH17-05', status: 'booked', weeklyRatePence: 86_000, quantity: 1 },
    },
  },
};
const withBody = (body: string): DraftCase => ({ ...good, reply: { ...good.reply!, body } });

describe('eval scorers', () => {
  it('a well-formed hero discount draft scores 1.0 on every scorer', async () => {
    for (const s of DRAFT_SCORERS) expect(await score(s, good), s.id).toBe(1);
  });

  it('cites-evidence: no evidence scores 0; evidence from another hire counts against it', async () => {
    expect(await score(citesEvidenceScorer, { ...good, evidence: [] })).toBe(0);
    expect(await score(citesEvidenceScorer, { ...good, evidence: [good.evidence[0]!, { id: 'x', sourceType: 'email', hireMatches: false }] })).toBe(0.5);
    // A draft with no customer reply is not customer-facing.
    expect(await score(citesEvidenceScorer, { ...good, reply: null, evidence: [] })).toBe(1);
  });

  it('links-open-request: a discount draft without the call transcript only half-links its request', async () => {
    expect(await score(linksOpenRequestScorer, { ...good, evidence: [good.evidence[0]!] })).toBe(0.5);
    expect(await score(linksOpenRequestScorer, { ...good, intent: 'cancel-line-2', evidence: [{ id: 'd', sourceType: 'document', hireMatches: true }] })).toBe(0);
  });

  it('reply-addressed: no recipient, a non-address or no thread scores 0', async () => {
    expect(await score(replyAddressedScorer, { ...good, reply: { ...good.reply!, to: [] } })).toBe(0);
    expect(await score(replyAddressedScorer, { ...good, reply: { ...good.reply!, to: ['Sam'] } })).toBe(0);
    expect(await score(replyAddressedScorer, { ...good, reply: { ...good.reply!, threadLabel: undefined } })).toBe(0);
  });

  it('no-unsupported-facts: a wrong price, weekday or percentage pulls the score below 1', async () => {
    expect(await score(noUnsupportedFactsScorer, withBody('Hire price: £3,999.00, delivered Wednesday 4 November.'))).toBeLessThan(1);
    expect(await score(noUnsupportedFactsScorer, withBody('Delivered Friday 6 November.'))).toBe(0);
    expect(await score(noUnsupportedFactsScorer, withBody('We can do 15% off.'))).toBe(0);
  });

  it('no-unsupported-facts: unsupported facts the quick fact count does not spot still fail (GBP, numeric dates, "per cent", "5th November")', async () => {
    // checkReply catches each of these; the score must not stay at 1.0 because the fact counter missed them.
    for (const body of ['We can do it for GBP 3700.', 'See you on 05/11.', 'A 12.5 per cent saving.', 'Booked for 5th November.']) {
      expect(await score(noUnsupportedFactsScorer, withBody(body)), body).toBeLessThan(1);
    }
  });
});
