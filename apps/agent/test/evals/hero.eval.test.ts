/**
 * Eval suite: play the whole hero story on a scripted (default) or replayed desk, then score every
 * customer-facing draft with the Mastra scorers in src/evals/scorers.ts and check the run-level
 * guarantees (exactly one email per draft, one credit note per line, no stale draft applied).
 * Needs no API key. `pnpm eval` (EVAL_LLM_MODE=replay to score recordings; SIGNAL_BACKEND=app for the fallback).
 */
import { schema as s } from '@switchboard/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DRAFT_SCORERS, type DraftCase } from '../../src/evals/scorers';
import { defaultRecordingsDir, RecordReplayModel, ScriptedDeskModel } from '../../src/models';
import type { Switchboard } from '../../src/runtime';
import { beats } from '../../src/scenario/beats';
import { bootSwitchboard, heroId } from '../support/boot';
import { playBeats } from '../support/story';

const backend = (process.env.SIGNAL_BACKEND as 'harness' | 'app' | undefined) ?? 'harness';
const llmMode = (process.env.EVAL_LLM_MODE as 'scripted' | 'replay' | undefined) ?? 'scripted';

/** Thresholds: safety scorers must be perfect; nothing here is allowed to be "mostly right". */
const THRESHOLD: Record<string, number> = { 'cites-evidence': 1, 'no-unsupported-facts': 1, 'links-open-request': 1, 'reply-addressed': 1 };

describe(`hero story evals (SIGNAL_BACKEND=${backend}, LLM_MODE=${llmMode})`, () => {
  let sb: Switchboard;
  let hireId: string;
  const db = () => sb.db.db;
  const results: Array<{ draft: string; scorer: string; score: number; reason?: string }> = [];

  // Replay: serve recordings, fall back to the scripted desk on a miss, and count both.
  const replay = llmMode === 'replay' ? new RecordReplayModel({ mode: 'replay', dir: process.env.RECORDINGS_DIR || defaultRecordingsDir(), fallback: new ScriptedDeskModel({ latencyMs: 40 }) }) : undefined;

  beforeAll(async () => {
    sb = await bootSwitchboard({ signalBackend: backend, llmMode, scriptedLatencyMs: 40 }, { model: replay as never });
    hireId = await heroId(db());
    const b = beats(sb.services);
    await playBeats(sb, hireId, 5); // beats 1–5: ask, PO, note + transcript, Jo's edit mid-run, stale approval → D-8
    const open = async (intent: string) => {
      const [d] = await db()
        .select()
        .from(s.drafts)
        .where(and(eq(s.drafts.hireId, hireId), inArray(s.drafts.status, ['pending', 'stale']), sql`${s.drafts.payload} ->> 'intent' like ${intent}`))
        .orderBy(sql`${s.drafts.createdAt} desc`);
      return d!.ref;
    };
    await sb.services.decideApproval({ draftRef: await open('discount'), staffId: 'gary', decision: 'approved', channel: 'mobile' }); // beat 6 (no crash here)
    await sb.router.idle(hireId);
    await b[7]();
    await new Promise((r) => setTimeout(r, 300));
    await sb.router.idle(hireId, 30_000);
    await b[8]();
    await sb.router.idle(hireId, 30_000);
    await sb.services.decideApproval({ draftRef: await open('cancel-line-%'), staffId: 'gary', decision: 'approved' });
    await sb.router.idle(hireId, 30_000);
  }, 240_000);

  afterAll(async () => {
    if (replay) console.log(`replay: ${replay.hits} recorded responses served, ${replay.misses} misses (scripted fallback)`);
    if (results.length) {
      console.log(`\nscorer results (${backend}, ${llmMode})`);
      console.table(results.map((r) => ({ draft: r.draft, scorer: r.scorer, score: r.score.toFixed(2), reason: r.reason ?? '' })));
    }
    await sb?.stop();
  });

  async function cases(): Promise<DraftCase[]> {
    const drafts = await db().select().from(s.drafts).where(eq(s.drafts.hireId, hireId));
    const versions = await db().select().from(s.hireVersions).where(eq(s.hireVersions.hireId, hireId));
    const chunks = await db().select({ id: s.evidenceChunks.id, sourceType: s.evidenceChunks.sourceType, hireId: s.evidenceChunks.hireId }).from(s.evidenceChunks);
    return drafts
      .filter((d) => (d.payload as { reply?: unknown }).reply)
      .map((d) => {
        const p = d.payload as { intent: string; reply: DraftCase['reply']; actions: DraftCase['actions']; pricing: DraftCase['pricing'] };
        const snap = versions.find((v) => v.version === d.basedOnVersion)!.snapshot as DraftCase['hire'] & { discountPct: string; waiverRatePct: string };
        return {
          ref: d.ref,
          intent: p.intent,
          status: d.status,
          basedOnVersion: d.basedOnVersion,
          reply: p.reply,
          actions: p.actions ?? [],
          pricing: p.pricing ?? null,
          evidence: d.evidenceIds.map((id) => {
            const c = chunks.find((x) => x.id === id);
            return { id, sourceType: c?.sourceType ?? 'missing', hireMatches: c?.hireId === hireId };
          }),
          hire: { ...snap, discountPct: Number(snap.discountPct), waiverRatePct: Number(snap.waiverRatePct) },
        };
      });
  }

  it('every customer-facing draft scores 1.0 on every scorer', async () => {
    const all = await cases();
    expect(all.map((c) => c.intent).sort()).toEqual(['cancel-line-2', 'discount', 'discount', 'waiver-chaser']);
    for (const c of all) {
      for (const scorer of DRAFT_SCORERS) {
        const r = await scorer.run({ input: c, output: c });
        const score = r.score ?? 0;
        results.push({ draft: c.ref, scorer: scorer.id, score, reason: (r as { reason?: string }).reason });
        expect(score, `${scorer.id} on ${c.ref}`).toBeGreaterThanOrEqual(THRESHOLD[scorer.id]!);
      }
    }
  });

  it('exactly once: one email per sent draft, one credit note per cancelled line, a unique ledger', async () => {
    const outbox = await db().select().from(s.outbox).where(eq(s.outbox.hireId, hireId));
    const perDraft = new Map<string, number>();
    for (const o of outbox) perDraft.set(o.draftId!, (perDraft.get(o.draftId!) ?? 0) + 1);
    expect([...perDraft.values()].every((n) => n === 1)).toBe(true);
    expect(outbox).toHaveLength(2); // the discount confirmation and the partial cancellation
    const credits = await db().select().from(s.creditNotes).where(eq(s.creditNotes.hireId, hireId));
    expect(credits).toHaveLength(1);
    expect(credits[0]!.amountPence).toBe(154_800);
  });

  it.runIf(llmMode === 'replay' && process.env.EVAL_REQUIRE_RECORDINGS === 'true')('replay served every model step from recordings', () => {
    expect(replay!.hits).toBeGreaterThan(0);
    expect(replay!.misses).toBe(0);
  });

  it('no stale draft was ever applied, and the discount reached the hire once', async () => {
    const drafts = await db().select().from(s.drafts).where(eq(s.drafts.hireId, hireId));
    const approvals = await db().select().from(s.approvals);
    for (const d of drafts.filter((x) => x.status === 'applied')) {
      const a = approvals.find((x) => x.draftId === d.id && x.decision === 'approved');
      expect(a?.hireVersionAtDecision, `${d.ref} was applied on the version it was approved against`).toBe(d.basedOnVersion);
    }
    const discounts = drafts.filter((d) => (d.payload as { intent: string }).intent === 'discount');
    expect(discounts.filter((d) => d.status === 'applied')).toHaveLength(1);
    expect(discounts.filter((d) => d.status === 'superseded')).toHaveLength(1);
  });
});
