import { gbp } from '@switchboard/core';
import { schema as s, type Db } from '@switchboard/db';
import { and, eq } from 'drizzle-orm';

/**
 * Step history for the UI's RunTrace (`app.desk_steps`), written by the tool layer so both signal
 * backends produce the same trail. Each call writes a `running` row before the tool runs and
 * completes it afterwards: a worker that dies mid-tool leaves its last step visibly unfinished.
 * Evidence a tool fetched (call transcripts, documents) is mirrored as `kind = evidence` rows,
 * which the signal stream shows as evidence.
 */
type Input = { hireRef?: string } & Record<string, unknown>;
type Out = { status?: string; result?: Record<string, unknown>; reason?: string; message?: string; currentVersion?: number } | undefined;

type ToolCtx = { runId?: string; agent?: { runId?: string; threadId?: string }; workflow?: { runId?: string } } | undefined;

export function callLabel(tool: string, i: Input): string {
  const ref = String(i.hireRef ?? '');
  switch (tool) {
    case 'searchEvidence':
      return `searchEvidence("${String(i.query ?? '').slice(0, 48)}")`;
    case 'proposeDraft':
      return `proposeDraft(${String(i.intent)}, based on v${String(i.basedOnVersion)}${i.supersedes ? `, supersedes ${String(i.supersedes)}` : ''})`;
    case 'applyRoutineUpdate':
      return `applyRoutineUpdate(${Object.keys((i.changes as object) ?? {}).join(', ')}, expected v${String(i.expectedVersion)})`;
    case 'applyPricing':
      return `applyPricing(${String(i.draftRef)}, expected v${String(i.expectedVersion)})`;
    case 'cancelLine':
      return `cancelLine(${String(i.draftRef)}, line ${String(i.lineNo)}, expected v${String(i.expectedVersion)})`;
    case 'issueCreditNote':
      return `issueCreditNote(${String(i.draftRef)}, line ${String(i.lineNo)})`;
    case 'queueEmail':
      return `queueEmail(${String(i.draftRef)})`;
    default:
      return `${tool}(${ref})`;
  }
}

export function resultLabel(tool: string, out: Out): string {
  if (!out || typeof out !== 'object') return '';
  const r = out.result ?? {};
  if (out.status === 'STALE') return `STALE: hire is v${out.currentVersion}`;
  if (out.status === 'REJECTED') return `refused: ${out.reason ?? ''}`.slice(0, 120);
  const dup = out.status === 'DUPLICATE' ? 'already done (same action key)' : '';
  switch (tool) {
    case 'getHire':
      return `v${(r.hire as { version?: number } | undefined)?.version ?? '?'}`;
    case 'getLines':
      return `v${String(r.version ?? '?')}`;
    case 'searchEvidence':
      return `${((r.hits as unknown[]) ?? []).length} hits`;
    case 'getDraftChain': {
      const ds = (r.drafts as Array<{ ref: string; status: string }>) ?? [];
      const open = ds.filter((d) => ['pending', 'stale', 'approved'].includes(d.status));
      return open.length ? open.map((d) => `${d.ref} ${d.status}`).join(', ') : `${ds.length} drafts, none open`;
    }
    case 'getWaiverStatus':
      return r.signed ? 'waiver signed' : 'no signed waiver on file';
    case 'proposeDraft': {
      const d = r.draft as { ref?: string; status?: string } | undefined;
      return dup ? `${d?.ref} already open for this intent: merged` : `${d?.ref} ${d?.status ?? ''}`.trim();
    }
    case 'applyRoutineUpdate':
    case 'applyPricing':
      return dup || `hire now v${String(r.version ?? '?')}`;
    case 'cancelLine':
      return dup || (r.alreadyCancelled ? 'line already cancelled' : `cancelled, hire now v${String(r.version)}`);
    case 'issueCreditNote':
      return dup || `${String(r.creditNoteRef)} ${typeof r.amountPence === 'number' ? gbp(r.amountPence) : ''}`.trim();
    case 'queueEmail':
      return dup || 'email sent';
    default:
      return dup || (out.status ?? '');
  }
}

/** Pick the most relevant line of an evidence chunk for the stream ("Sam: Two of them are definite this quarter…"). */
export function evidenceSnippet(content: string, query: string): { title: string; snippet: string } {
  const [title = '', ...rest] = content.split('\n');
  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 3);
  let best = rest[0] ?? '';
  let bestScore = -1;
  for (const line of rest) {
    const l = line.toLowerCase();
    // Longer query words carry more meaning ("quarter" over "more").
    const score = terms.reduce((n, t) => n + (l.includes(t) ? t.length : 0), 0);
    if (score > bestScore) {
      best = line;
      bestScore = score;
    }
  }
  return { title, snippet: best.trim().slice(0, 220) };
}

export function makeTracer(db: Db) {
  const hireIds = new Map<string, string>();
  async function hireIdOf(ref: unknown): Promise<string | undefined> {
    if (typeof ref !== 'string' || !ref) return undefined;
    const cached = hireIds.get(ref);
    if (cached) return cached;
    const [h] = await db.select({ id: s.hires.id }).from(s.hires).where(eq(s.hires.ref, ref));
    if (h) hireIds.set(ref, h.id);
    return h?.id;
  }

  /**
   * The desk run a tool call belongs to. Mastra's agent tool context carries the thread but not the
   * run id, so it comes from the desk row (both backends set `active_run_id` when a run starts).
   */
  async function runIdFor(ctx: unknown, hireId: string | undefined): Promise<string | null> {
    const c = ctx as ToolCtx;
    const direct = c?.agent?.runId ?? c?.runId ?? c?.workflow?.runId;
    if (direct) return direct;
    if (!hireId) return null;
    const [d] = await db.select({ runId: s.desks.activeRunId }).from(s.desks).where(eq(s.desks.hireId, hireId));
    return d?.runId ?? null;
  }

  return {
    /** Forget cached hire ids (scenario reset re-seeds with new ids). */
    clear: () => hireIds.clear(),
    traced<I extends Input, O>(tool: string, fn: (input: I, ctx: unknown) => Promise<O>) {
      return async (input: I, ctx: unknown): Promise<O> => {
        const hireId = await hireIdOf(input.hireRef).catch(() => undefined);
        const runId = await runIdFor(ctx, hireId).catch(() => null);
        const label = callLabel(tool, input);
        let stepId: string | undefined;
        if (hireId) {
          try {
            await db.update(s.desks).set({ currentStep: label, updatedAt: new Date() }).where(eq(s.desks.hireId, hireId));
            const [row] = await db.insert(s.deskSteps).values({ hireId, runId, tool, text: label, status: 'running' }).returning({ id: s.deskSteps.id });
            stepId = row?.id;
          } catch (e) {
            console.error('[trace] step start', e);
          }
        }
        // Hand the run id on to the tool body (ledger rows, drafts.run_id) on a copy of the context.
        const c = (ctx ?? {}) as Record<string, unknown> & { agent?: Record<string, unknown> };
        const withRun = runId && !c.agent?.runId ? { ...c, agent: { ...(c.agent ?? {}), runId } } : ctx;
        const out = await fn(input, withRun);
        if (hireId && stepId) {
          try {
            const o = out as Out;
            const res = resultLabel(tool, o);
            await db
              .update(s.deskSteps)
              .set({ text: res ? `${label} → ${res}` : label, status: o?.status ?? 'OK' })
              .where(eq(s.deskSteps.id, stepId));
            if (tool === 'searchEvidence' && o?.status === 'OK') await recordEvidence(hireId, runId, String(input.query ?? ''), o);
          } catch (e) {
            console.error('[trace] step finish', e);
          }
        }
        return out;
      };
    },
  };

  async function recordEvidence(hireId: string, runId: string | null, query: string, o: NonNullable<Out>) {
    const hits = ((o.result?.hits as Array<{ id: string; sourceType: string; sourceId: string; content: string }>) ?? []).filter(
      (h) => h.sourceType === 'transcript' || h.sourceType === 'document',
    );
    for (const h of hits.slice(0, 2)) {
      const dupe = runId
        ? await db
            .select({ id: s.deskSteps.id })
            .from(s.deskSteps)
            .where(and(eq(s.deskSteps.hireId, hireId), eq(s.deskSteps.kind, 'evidence'), eq(s.deskSteps.runId, runId), eq(s.deskSteps.tool, h.sourceId)))
        : [];
      if (dupe.length) continue;
      const { title, snippet } = evidenceSnippet(h.content, query);
      await db.insert(s.deskSteps).values({
        hireId,
        runId,
        kind: 'evidence',
        tool: h.sourceId,
        text: snippet || title,
        status: 'OK',
        detail: { sourceType: h.sourceType, sourceId: h.sourceId, evidenceId: h.id, title },
      });
    }
  }
}

export type Tracer = ReturnType<typeof makeTracer>;
