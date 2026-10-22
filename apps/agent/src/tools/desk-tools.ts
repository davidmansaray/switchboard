import { createTool } from '@mastra/core/tools';
import {
  classifyChange,
  formatDiff,
  keys,
  lineCreditPence,
  priceHire,
  rejected,
  stale,
  type DiffEntry,
  type DraftStatus,
  type ToolResult,
} from '@switchboard/core';
import {
  deskThreadId,
  getDraftByRef,
  getDraftChain,
  getHireByRef,
  getVersion,
  indexEvidence,
  recordEvent,
  schema as s,
  searchEvidence,
  type Db,
  type HireView,
} from '@switchboard/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { runAction, type LedgerDeps } from './ledger';
import { makeTracer, type Tracer } from './trace';

export type DeskToolDeps = LedgerDeps & { tracer?: Tracer };

type Ctx = { agent?: { threadId?: string; resourceId?: string } } | undefined;

/** Guardrail: a desk may only touch its own hire. */
async function loadHire(db: Db, hireRef: string, ctx: Ctx): Promise<HireView | ToolResult<never>> {
  const threadId = ctx?.agent?.threadId;
  if (threadId && threadId !== deskThreadId(hireRef)) return rejected(`this desk (${threadId}) cannot act on ${hireRef}`);
  const hire = await getHireByRef(db, hireRef);
  return hire ?? rejected(`unknown hire ${hireRef}`);
}
const isResult = (x: unknown): x is ToolResult<never> => typeof x === 'object' && x !== null && 'status' in x && !('ref' in x);

const runIdOf = (ctx: unknown) => (ctx as { agent?: { runId?: string } } | undefined)?.agent?.runId;

function hireFacts(h: HireView) {
  return {
    ref: h.ref,
    version: h.version,
    status: h.status,
    site: h.site,
    deliveryDate: h.deliveryDate,
    deliverySlot: h.deliverySlot,
    durationDays: h.durationDays,
    poNumber: h.poNumber,
    invoiceAddress: h.invoiceAddress,
    discountPct: Number(h.discountPct),
    damageWaiver: h.damageWaiver,
    waiverRatePct: Number(h.waiverRatePct),
    transportPence: h.transportPence,
    totalPence: h.totalPence,
    lines: h.lines.map((l) => ({
      lineNo: l.lineNo,
      kind: l.kind,
      model: l.model,
      description: l.description,
      spec: l.spec,
      fleetNo: l.fleetNo,
      status: l.status,
      weeklyRatePence: l.weeklyRatePence,
      quantity: l.quantity,
    })),
  };
}

const draftFacts = (d: s.Draft, refs: Map<string, string>) => ({
  ref: d.ref,
  kind: d.kind,
  title: d.title,
  status: d.status,
  basedOnVersion: d.basedOnVersion,
  supersedesRef: d.supersedesId ? (refs.get(d.supersedesId) ?? null) : null,
  staleReason: d.staleReason,
  evidenceIds: d.evidenceIds,
  payload: d.payload,
});

const replySchema = z.object({
  threadLabel: z.string().describe('Email thread label, e.g. T1'),
  to: z.array(z.string()).min(1),
  subject: z.string(),
  body: z.string(),
});
const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('applyPricing'), discountPct: z.number().min(0).max(50) }),
  z.object({ type: z.literal('cancelLine'), lineNo: z.number().int() }),
  z.object({ type: z.literal('creditNote'), lineNo: z.number().int() }),
]);
type DraftAction = z.infer<typeof actionSchema>;
type DraftPayload = { intent: string; actions: DraftAction[]; reply?: z.infer<typeof replySchema>; pricing?: unknown; source?: string; checks?: unknown };

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_RE = /\b(Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)(day|sday|nesday|rsday|urday)?\b/g;
const DATE_RE = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:\s+(\d{4}))?\b/gi;
const NUM_DATE_RE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
const MONEY_RE = /(?:£|\bGBP\s?)(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?(k)?\b/gi;
const PCT_RE = /(\d{1,3}(?:\.\d+)?)\s?(?:%|per\s?cent\b)/gi;

const isoPlus = (iso: string, days: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Facts in a customer-facing reply must match the hire. Checked: every money amount (£1,234.56,
 * £1,234, £1.2k, GBP 1234), every date (4 November, 4th Nov, 04/11), every weekday (full or short
 * name) and every percentage. Allowed values come from the hire and the draft's own pricing
 * preview, never from the model. The eval scorer re-checks the same facts on every draft.
 */
export function checkReply(
  body: string,
  allowedPence: number[],
  h: Pick<HireView, 'deliveryDate' | 'durationDays' | 'discountPct' | 'waiverRatePct'>,
  opts: { percents?: number[] } = {},
): { ok: boolean; unsupported: string[] } {
  const unsupported: string[] = [];
  const allowed = new Set(allowedPence);
  for (const m of body.matchAll(MONEY_RE)) {
    const whole = Number(m[1]!.replace(/,/g, ''));
    const pence = m[3] ? Math.round(whole * 100_000) : Math.round(whole * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0));
    // "£3,852" is fine when the hire supports £3,852.xx (rounding to whole pounds in prose).
    const ok = allowed.has(pence) || (!m[2] && [...allowed].some((a) => Math.round(a / 100) * 100 === pence || Math.floor(a / 100) * 100 === pence));
    if (!ok) unsupported.push(m[0]);
  }
  const dates = [h.deliveryDate, isoPlus(h.deliveryDate, h.durationDays)];
  const weekdays = new Set(dates.map((d) => DAYS[new Date(`${d}T12:00:00Z`).getUTCDay()]!.slice(0, 3).toLowerCase()));
  for (const m of body.matchAll(DAY_RE)) if (!weekdays.has(m[1]!.slice(0, 3).toLowerCase())) unsupported.push(m[0]);
  const dayMonth = new Set(dates.map((d) => `${Number(d.slice(8, 10))}-${Number(d.slice(5, 7))}`));
  for (const m of body.matchAll(DATE_RE)) {
    const month = MONTHS.indexOf(m[2]!.toLowerCase().slice(0, 3)) + 1;
    if (!dayMonth.has(`${Number(m[1])}-${month}`)) unsupported.push(m[0]);
  }
  for (const m of body.matchAll(NUM_DATE_RE)) {
    if (!dayMonth.has(`${Number(m[1])}-${Number(m[2])}`)) unsupported.push(m[0]);
  }
  const pcts = new Set([Number(h.discountPct), Number(h.waiverRatePct), 20, ...(opts.percents ?? [])]);
  for (const m of body.matchAll(PCT_RE)) if (!pcts.has(Number(m[1]))) unsupported.push(m[0]);
  return { ok: unsupported.length === 0, unsupported };
}

function pricingPreview(h: HireView, actions: DraftAction[]) {
  const pricing = actions.find((a) => a.type === 'applyPricing');
  const discountPct = pricing ? pricing.discountPct : Number(h.discountPct);
  const cancelled = new Set(actions.filter((a) => a.type === 'cancelLine').map((a) => a.lineNo));
  const lines = h.lines.map((l) => ({ ...l, status: cancelled.has(l.lineNo) ? ('cancelled' as const) : l.status }));
  const price = priceHire({ lines, durationDays: h.durationDays, discountPct, damageWaiver: h.damageWaiver, transportPence: h.transportPence, waiverRatePct: Number(h.waiverRatePct) });
  const credits = actions
    .filter((a) => a.type === 'creditNote')
    .map((a) => {
      const line = h.lines.find((l) => l.lineNo === a.lineNo);
      return line ? lineCreditPence(line, h.durationDays, Number(h.discountPct)) : 0;
    });
  return { discountPct, ...price, credits };
}

export function createDeskTools(deps: DeskToolDeps) {
  const { db } = deps;
  const tracer = deps.tracer ?? makeTracer(db);
  const traced = tracer.traced;

  const getHire = createTool({
    id: 'getHire',
    description:
      'Read the current hire (booking) with its lines, version, contacts and email threads. Always call this first: never take booking facts from memory.',
    inputSchema: z.object({ hireRef: z.string() }),
    execute: traced('getHire', async ({ hireRef }, ctx) => {
      const h = await loadHire(db, hireRef, ctx as Ctx);
      if (isResult(h)) return h;
      const [contact] = h.siteContactId ? await db.select().from(s.contacts).where(eq(s.contacts.id, h.siteContactId)) : [];
      const threads = await db
        .select({ label: s.emailThreads.label, subject: s.emailThreads.subject, contactEmail: s.contacts.email })
        .from(s.emailThreads)
        .leftJoin(s.contacts, eq(s.contacts.id, s.emailThreads.contactId))
        .where(eq(s.emailThreads.hireId, h.id));
      const latest = await getVersion(db, h.id, h.version);
      return {
        status: 'OK' as const,
        result: {
          hire: { ...hireFacts(h), siteContact: contact ? { name: contact.name, email: contact.email } : null, threads },
          latestChange: latest ? formatDiff(h.version - 1, h.version, latest.diff as DiffEntry[]) : null,
        },
      };
    }),
  });

  const getLines = createTool({
    id: 'getLines',
    description: 'Read the equipment lines on a hire (model, status, weekly rate).',
    inputSchema: z.object({ hireRef: z.string() }),
    execute: traced('getLines', async ({ hireRef }, ctx) => {
      const h = await loadHire(db, hireRef, ctx as Ctx);
      if (isResult(h)) return h;
      return { status: 'OK' as const, result: { version: h.version, lines: hireFacts(h).lines } };
    }),
  });

  const searchEvidenceTool = createTool({
    id: 'searchEvidence',
    description: 'Search emails, notes, call transcripts and documents on this hire. Returns evidence ids to cite in drafts.',
    inputSchema: z.object({
      hireRef: z.string(),
      query: z.string(),
      sourceTypes: z.array(z.enum(['email', 'note', 'transcript', 'document'])).optional(),
    }),
    execute: traced('searchEvidence', async ({ hireRef, query, sourceTypes }, ctx) => {
      const h = await loadHire(db, hireRef, ctx as Ctx);
      if (isResult(h)) return h;
      const hits = await searchEvidence(db, { hireId: h.id, query, sourceTypes, limit: 5 });
      return { status: 'OK' as const, result: { hits: hits.map((x) => ({ ...x, content: x.content.slice(0, 600) })) } };
    }),
  });

  const getDraftChainTool = createTool({
    id: 'getDraftChain',
    description: 'List the drafts on this hire with status (pending/stale/superseded/approved/applied/rejected), based_on version and supersedes links.',
    inputSchema: z.object({ hireRef: z.string() }),
    execute: traced('getDraftChain', async ({ hireRef }, ctx) => {
      const h = await loadHire(db, hireRef, ctx as Ctx);
      if (isResult(h)) return h;
      const drafts = await getDraftChain(db, h.id);
      const refs = new Map(drafts.map((d) => [d.id, d.ref]));
      return { status: 'OK' as const, result: { hireVersion: h.version, drafts: drafts.map((d) => draftFacts(d, refs)) } };
    }),
  });

  const getWaiverStatus = createTool({
    id: 'getWaiverStatus',
    description: 'Check whether a signed damage waiver is on file for this hire (from the waiver document).',
    inputSchema: z.object({ hireRef: z.string() }),
    execute: traced('getWaiverStatus', async ({ hireRef }, ctx) => {
      const h = await loadHire(db, hireRef, ctx as Ctx);
      if (isResult(h)) return h;
      const docs = await db
        .select()
        .from(s.documents)
        .where(and(eq(s.documents.hireId, h.id), eq(s.documents.kind, 'damage_waiver')))
        .orderBy(desc(s.documents.createdAt));
      const doc = docs[0];
      const [chunk] = doc
        ? await db.select({ id: s.evidenceChunks.id }).from(s.evidenceChunks).where(and(eq(s.evidenceChunks.sourceType, 'document'), eq(s.evidenceChunks.sourceId, doc.id)))
        : [];
      const daysToDelivery = Math.round((Date.parse(`${h.deliveryDate}T00:00:00Z`) - Date.now()) / 86_400_000);
      return {
        status: 'OK' as const,
        result: { signed: Boolean(doc?.signed), documentId: doc?.id ?? null, documentEvidenceId: chunk?.id ?? null, daysToDelivery, waiverRequired: h.damageWaiver },
      };
    }),
  });

  const proposeDraft = createTool({
    id: 'proposeDraft',
    description:
      'Create a draft for human approval: a bundle (actions + customer reply), an email, or an update. Pass basedOnVersion from getHire. One open draft per intent: a current open draft for the same intent is returned as DUPLICATE; a stale one is superseded automatically. Customer-facing replies must cite evidenceIds.',
    inputSchema: z.object({
      hireRef: z.string(),
      intent: z.string().describe('Stable intent name, e.g. discount, waiver-chaser, cancel-line-2'),
      kind: z.enum(['bundle', 'email', 'update']),
      title: z.string(),
      basedOnVersion: z.number().int(),
      supersedes: z.string().optional().describe('Draft ref this replaces, e.g. D-7'),
      actions: z.array(actionSchema).default([]),
      reply: replySchema.optional(),
      evidenceIds: z.array(z.string()).default([]),
      source: z.string().optional(),
    }),
    execute: traced('proposeDraft', async (input, ctx) => {
      const h = await loadHire(db, input.hireRef, ctx as Ctx);
      if (isResult(h)) return h;
      if (input.basedOnVersion !== h.version) return stale(input.basedOnVersion, h.version);
      if (input.reply && input.evidenceIds.length === 0) return rejected('customer-facing drafts must cite at least one evidence id');
      if (input.evidenceIds.length) {
        const found = await db.select({ id: s.evidenceChunks.id }).from(s.evidenceChunks).where(and(eq(s.evidenceChunks.hireId, h.id), inArray(s.evidenceChunks.id, input.evidenceIds)));
        if (found.length !== new Set(input.evidenceIds).size) return rejected('unknown evidence id(s) for this hire');
      }
      const preview = pricingPreview(h, input.actions);
      const base = priceHire({ lines: h.lines, durationDays: h.durationDays, discountPct: 0, damageWaiver: h.damageWaiver, transportPence: h.transportPence, waiverRatePct: Number(h.waiverRatePct) });
      const allowed = [...Object.values(preview).filter((v): v is number => typeof v === 'number'), ...preview.credits, ...Object.values(base), h.totalPence, ...h.lines.map((l) => l.weeklyRatePence)];
      const percents = input.actions.flatMap((a) => (a.type === 'applyPricing' ? [a.discountPct] : []));
      const checks = input.reply ? checkReply(input.reply.body, allowed, h, { percents }) : { ok: true, unsupported: [] };
      if (!checks.ok) return rejected(`reply states facts the hire doesn't support: ${checks.unsupported.join(', ')}`);

      // expectedVersion: re-checked under the hire row lock, so an edit that lands between the read
      // above and this write makes the proposal STALE instead of a pending draft on an old version.
      const runId = runIdOf(ctx) ?? null;
      let merged: { into: string; auto: boolean } | undefined;
      const res = await runAction(deps, { hireId: h.id, actionKey: keys.proposal(h.ref, input.intent, h.version), tool: 'proposeDraft', expectedVersion: h.version, runId: runId ?? undefined }, async (tx) => {
        const open = await tx
          .select()
          .from(s.drafts)
          .where(and(eq(s.drafts.hireId, h.id), inArray(s.drafts.status, ['pending', 'stale', 'approved']), sql`${s.drafts.payload} ->> 'intent' = ${input.intent}`));
        const current = open.find((d) => d.basedOnVersion === h.version && d.status !== 'stale');
        if (current) {
          merged = { into: current.ref, auto: false };
          return { status: 'DUPLICATE' as const, actionKey: current.actionKey, result: { draft: { ref: current.ref, basedOnVersion: current.basedOnVersion, status: current.status } } } as never;
        }
        const supersede = input.supersedes ? await getDraftByRef(tx, input.supersedes) : open.find((d) => d.status === 'stale');
        // A stale draft for the same intent superseded without being asked to (no `supersedes`) means a
        // second source asked for the same thing after the hire moved: that signal merges into the first.
        if (!input.supersedes && supersede && supersede.runId && supersede.runId !== runId) merged = { into: supersede.ref, auto: true };
        const payload: DraftPayload = { intent: input.intent, actions: input.actions, reply: input.reply, pricing: preview, source: input.source, checks };
        const [d] = await tx
          .insert(s.drafts)
          .values({
            hireId: h.id,
            kind: input.kind,
            title: input.title,
            payload,
            basedOnVersion: h.version,
            evidenceIds: input.evidenceIds,
            supersedesId: supersede?.id ?? null,
            runId,
            actionKey: keys.proposal(h.ref, input.intent, h.version),
          })
          .returning();
        for (const old of open.filter((o) => o.id !== d!.id && (o.status === 'stale' || o.id === supersede?.id))) {
          await tx.update(s.drafts).set({ status: 'superseded' }).where(eq(s.drafts.id, old.id));
        }
        await recordEvent(tx, { hireId: h.id, type: 'draft.proposed', source: 'agent', actor: 'agent:desk', payload: { draftRef: d!.ref, supersedes: supersede?.ref ?? null, basedOnVersion: h.version } });
        return { status: 'OK' as const, result: { draft: { ref: d!.ref, basedOnVersion: d!.basedOnVersion, status: d!.status, supersedesRef: supersede?.ref ?? null }, pricing: preview } };
      });
      // DUPLICATE comes from the open-draft check above or straight from the ledger (same intent, same
      // version, same action key): either way this signal asked for something already in hand.
      const dupRef = res.status === 'DUPLICATE' ? ((res.result as { draft?: { ref?: string } } | undefined)?.draft?.ref ?? merged?.into) : merged?.auto ? merged.into : undefined;
      if (dupRef && runId) await markMerged(h.id, dupRef, runId).catch((e: unknown) => console.error('[merge]', e));
      return res;
    }),
  });

  const applyRoutineUpdate = createTool({
    id: 'applyRoutineUpdate',
    description:
      'Apply low-risk changes (PO number, invoice address, site contact) directly, without approval. Logged. Any other field is rejected: propose a draft instead.',
    inputSchema: z.object({
      hireRef: z.string(),
      expectedVersion: z.number().int(),
      changes: z.object({ poNumber: z.string().optional(), invoiceAddress: z.string().optional(), siteContactId: z.string().optional() }).catchall(z.unknown()),
      evidenceIds: z.array(z.string()).default([]),
    }),
    execute: traced('applyRoutineUpdate', async ({ hireRef, expectedVersion, changes, evidenceIds }, ctx) => {
      const h = await loadHire(db, hireRef, ctx as Ctx);
      if (isResult(h)) return h;
      const fields = Object.keys(changes).filter((k) => changes[k] !== undefined);
      const tier = classifyChange(fields);
      if (tier.tier !== 'auto') return rejected(`needs approval: ${tier.approvalFields.join(', ') || 'no fields'}`);
      const key = keys.routineUpdate(h.ref, fields.join('+'), fields.map((f) => String(changes[f])).join('|'));
      return runAction(deps, { hireId: h.id, actionKey: key, tool: 'applyRoutineUpdate', expectedVersion, runId: runIdOf(ctx) }, async (tx, hire) => {
        const patch: Partial<typeof s.hires.$inferInsert> = {};
        if (changes.poNumber) patch.poNumber = changes.poNumber;
        if (changes.invoiceAddress) patch.invoiceAddress = changes.invoiceAddress;
        if (changes.siteContactId) patch.siteContactId = changes.siteContactId;
        const [u] = await tx.update(s.hires).set(patch).where(eq(s.hires.id, hire.id)).returning({ version: s.hires.version });
        await recordEvent(tx, { hireId: hire.id, type: 'hire.updated', source: 'agent', actor: 'agent:desk', payload: { fields, tier: 'auto', evidenceIds, fromVersion: hire.version, toVersion: u!.version } });
        return { status: 'OK' as const, result: { version: u!.version, fields, tier: 'auto' } };
      });
    }),
  });

  /**
   * Record that the signal behind this run asked for an intent another signal already raised
   * (Sam's email and Jo's direct cancel): `signals_log.merged_into` points at the first signal.
   */
  async function markMerged(hireId: string, intoDraftRef: string, runId: string) {
    await db.execute(sql`
      with first_draft as (
        select d.run_id from app.drafts d where d.ref = ${intoDraftRef} and d.hire_id = ${hireId}
        union all
        select p.run_id from app.drafts d join app.drafts p on p.id = d.supersedes_id where d.ref = ${intoDraftRef}
      ),
      target as (
        select sl.id from app.signals_log sl join app.events e on e.id = sl.event_id
        where sl.hire_id = ${hireId} and e.run_id in (select run_id from first_draft where run_id is not null)
        order by sl.created_at asc limit 1
      ),
      candidate as (
        select sl.id from app.signals_log sl join app.events e on e.id = sl.event_id
        where sl.hire_id = ${hireId} and e.run_id = ${runId} and sl.merged_into is null
          and sl.id not in (select id from target)
        order by sl.created_at desc limit 1
      )
      update app.signals_log set merged_into = (select id from target)
      where id in (select id from candidate) and exists (select 1 from target)`);
  }

  /**
   * An approved draft whose hire moved before it was applied (a staff edit landed between the
   * approval and the apply): it must not stay "approved" forever. Mark it stale with the reason;
   * the desk regenerates it and asks again, exactly like approving a stale draft (beat 5).
   */
  async function markOvertaken(draftRef: string, r: { status: string; expectedVersion?: number; currentVersion?: number }) {
    if (r.status !== 'STALE') return;
    await db
      .update(s.drafts)
      .set({ status: 'stale', staleReason: `approved on v${r.expectedVersion}, but the hire moved to v${r.currentVersion} before it was applied` })
      .where(and(eq(s.drafts.ref, draftRef), eq(s.drafts.status, 'approved')));
  }

  /** Shared gate for apply tools: an approver approved this draft and it is current. */
  async function approvedDraft(
    tx: Parameters<Parameters<typeof runAction>[2]>[0],
    draftRef: string,
    hire: HireView,
    opts: { checkVersion?: boolean } = {},
  ): Promise<s.Draft | ToolResult<never>> {
    const d = await getDraftByRef(tx, draftRef);
    if (!d || d.hireId !== hire.id) return rejected(`unknown draft ${draftRef}`);
    const [appr] = await tx
      .select()
      .from(s.approvals)
      .innerJoin(s.staff, eq(s.staff.id, s.approvals.decidedBy))
      .where(and(eq(s.approvals.draftId, d.id), eq(s.approvals.decision, 'approved'), eq(s.staff.role, 'approver')));
    if (!appr) return rejected(`${draftRef} has no approval from an approver`);
    if (d.status === 'applied') return rejected(`${draftRef} is already applied`);
    if (d.status !== 'approved') return rejected(`${draftRef} is ${d.status}, not approved`);
    if (opts.checkVersion !== false && d.basedOnVersion !== hire.version) return stale(d.basedOnVersion, hire.version);
    return d;
  }

  /** Ledger keys of a draft's actions (not its email), in order. */
  const actionKeysOf = (d: s.Draft, h: HireView) =>
    (d.payload as DraftPayload).actions.map((a) =>
      a.type === 'applyPricing' ? keys.applyDraft(d.ref) : a.type === 'cancelLine' ? keys.cancelLine(h.ref, a.lineNo) : keys.creditNote(h.ref, a.lineNo),
    );

  async function doneKeys(tx: Parameters<Parameters<typeof runAction>[2]>[0], h: HireView, wanted: string[]) {
    if (!wanted.length) return new Set<string>();
    const rows = await tx.select({ k: s.agentActions.actionKey }).from(s.agentActions).where(and(eq(s.agentActions.hireId, h.id), inArray(s.agentActions.actionKey, wanted)));
    return new Set(rows.map((r) => r.k));
  }

  async function completeIfDone(tx: Parameters<Parameters<typeof runAction>[2]>[0], d: s.Draft, h: HireView, justDone: string) {
    const needed = actionKeysOf(d, h);
    if ((d.payload as DraftPayload).reply) needed.push(keys.emailForDraft(d.ref));
    const done = await doneKeys(tx, h, needed);
    done.add(justDone);
    if (needed.every((k) => done.has(k))) {
      await tx.update(s.drafts).set({ status: 'applied', appliedAt: new Date() }).where(eq(s.drafts.id, d.id));
      await recordEvent(tx, { hireId: h.id, type: 'draft.applied', source: 'agent', actor: 'agent:desk', payload: { draftRef: d.ref } });
      return true;
    }
    return false;
  }

  const applyPricing = createTool({
    id: 'applyPricing',
    description: 'Apply the pricing in an APPROVED draft. Requires expectedVersion = the draft\'s based_on version. Idempotent per draft.',
    inputSchema: z.object({ hireRef: z.string(), draftRef: z.string(), expectedVersion: z.number().int() }),
    execute: traced('applyPricing', async ({ hireRef, draftRef, expectedVersion }, ctx) => {
      const h = await loadHire(db, hireRef, ctx as Ctx);
      if (isResult(h)) return h;
      const key = keys.applyDraft(draftRef);
      const res = await runAction(deps, { hireId: h.id, actionKey: key, tool: 'applyPricing', expectedVersion, runId: runIdOf(ctx) }, async (tx, hire) => {
        const d = await approvedDraft(tx, draftRef, hire);
        if (isResult(d)) return d;
        const action = (d.payload as DraftPayload).actions.find((a) => a.type === 'applyPricing');
        if (!action) return rejected(`${draftRef} has no pricing action`);
        const price = priceHire({ lines: hire.lines, durationDays: hire.durationDays, discountPct: action.discountPct, damageWaiver: hire.damageWaiver, transportPence: hire.transportPence, waiverRatePct: Number(hire.waiverRatePct) });
        const [u] = await tx
          .update(s.hires)
          .set({ discountPct: String(action.discountPct), totalPence: price.subtotalPence })
          .where(eq(s.hires.id, hire.id))
          .returning({ version: s.hires.version });
        await recordEvent(tx, { hireId: hire.id, type: 'hire.updated', source: 'agent', actor: 'agent:desk', payload: { fields: ['discountPct', 'totalPence'], draftRef, fromVersion: hire.version, toVersion: u!.version } });
        await completeIfDone(tx, d, hire, key);
        return { status: 'OK' as const, result: { version: u!.version, discountPct: action.discountPct, subtotalPence: price.subtotalPence } };
      });
      await markOvertaken(draftRef, res as { status: string });
      return res;
    }),
  });

  const cancelLine = createTool({
    id: 'cancelLine',
    description: 'Cancel one hire line as part of an APPROVED cancellation draft. Already-cancelled lines are a no-op. Keyed by (hire, line): every source asking for the same cancellation shares one action.',
    inputSchema: z.object({ hireRef: z.string(), draftRef: z.string(), lineNo: z.number().int(), expectedVersion: z.number().int() }),
    execute: traced('cancelLine', async ({ hireRef, draftRef, lineNo, expectedVersion }, ctx) => {
      const h = await loadHire(db, hireRef, ctx as Ctx);
      if (isResult(h)) return h;
      const key = keys.cancelLine(h.ref, lineNo);
      const res = await runAction(deps, { hireId: h.id, actionKey: key, tool: 'cancelLine', expectedVersion, runId: runIdOf(ctx) }, async (tx, hire) => {
        const d = await approvedDraft(tx, draftRef, hire);
        if (isResult(d)) return d;
        const line = hire.lines.find((l) => l.lineNo === lineNo);
        if (!line) return rejected(`no line ${lineNo}`);
        let version = hire.version;
        if (line.status !== 'cancelled') {
          await tx.update(s.hireLines).set({ status: 'cancelled' }).where(eq(s.hireLines.id, line.id));
          const [v] = await tx.select({ version: s.hires.version }).from(s.hires).where(eq(s.hires.id, hire.id));
          version = v!.version;
        }
        await completeIfDone(tx, d, hire, key);
        return { status: 'OK' as const, result: { lineNo, alreadyCancelled: line.status === 'cancelled', version } };
      });
      await markOvertaken(draftRef, res as { status: string });
      return res;
    }),
  });

  const issueCreditNote = createTool({
    id: 'issueCreditNote',
    description: 'Issue the credit note for a cancelled line, as part of an APPROVED draft. Exactly one credit note per (hire, line), whatever the number of sources or retries.',
    inputSchema: z.object({ hireRef: z.string(), draftRef: z.string(), lineNo: z.number().int() }),
    execute: traced('issueCreditNote', async ({ hireRef, draftRef, lineNo }, ctx) => {
      const h = await loadHire(db, hireRef, ctx as Ctx);
      if (isResult(h)) return h;
      const key = keys.creditNote(h.ref, lineNo);
      return runAction(deps, { hireId: h.id, actionKey: key, tool: 'issueCreditNote', runId: runIdOf(ctx) }, async (tx, hire) => {
        // Runs after cancelLine moved the version, so only the approval is checked here.
        const d = await approvedDraft(tx, draftRef, hire, { checkVersion: false });
        if (isResult(d)) return d;
        const line = hire.lines.find((l) => l.lineNo === lineNo);
        if (!line) return rejected(`no line ${lineNo}`);
        // A credit note is only owed for a line that is actually cancelled (by cancelLine or by staff).
        if (line.status !== 'cancelled') return rejected(`line ${lineNo} (${line.model}) is ${line.status}, not cancelled: no credit note is owed`);
        const amountPence = lineCreditPence(line, hire.durationDays, Number(hire.discountPct));
        const [cn] = await tx
          .insert(s.creditNotes)
          .values({ hireId: hire.id, lineId: line.id, amountPence, reason: `Line ${lineNo} (${line.model}) cancelled before delivery`, actionKey: key })
          .returning();
        await completeIfDone(tx, d, hire, key);
        return { status: 'OK' as const, result: { creditNoteRef: cn!.ref, amountPence } };
      });
    }),
  });

  const queueEmail = createTool({
    id: 'queueEmail',
    description: 'Send the customer reply of an APPROVED draft through the outbox. Idempotent per draft: a retry never sends a second email.',
    inputSchema: z.object({ hireRef: z.string(), draftRef: z.string() }),
    execute: traced('queueEmail', async ({ hireRef, draftRef }, ctx) => {
      const h = await loadHire(db, hireRef, ctx as Ctx);
      if (isResult(h)) return h;
      const key = keys.emailForDraft(draftRef);
      return runAction(deps, { hireId: h.id, actionKey: key, tool: 'queueEmail', runId: runIdOf(ctx) }, async (tx, hire) => {
        // The last step of a bundle: earlier steps moved the version, so only the approval is checked.
        const d = await approvedDraft(tx, draftRef, hire, { checkVersion: false });
        if (isResult(d)) return d;
        const reply = (d.payload as DraftPayload).reply;
        if (!reply) return rejected(`${draftRef} has no reply`);
        // The reply confirms the draft's actions: never send it before they are all in the ledger
        // (e.g. applyPricing came back STALE because the hire moved after the approval).
        const needed = actionKeysOf(d, hire);
        const done = await doneKeys(tx, hire, needed);
        const missing = needed.filter((k) => !done.has(k));
        if (missing.length) return rejected(`${draftRef} reply not sent: its actions are not applied yet (${missing.join(', ')})`);
        const [thread] = await tx.select().from(s.emailThreads).where(and(eq(s.emailThreads.hireId, hire.id), eq(s.emailThreads.label, reply.threadLabel)));
        const [ob] = await tx
          .insert(s.outbox)
          .values({ hireId: hire.id, threadId: thread?.id ?? null, draftId: d.id, toAddrs: reply.to, subject: reply.subject, body: reply.body, idempotencyKey: key, sentAt: new Date() })
          .returning();
        if (thread) {
          const [em] = await tx
            .insert(s.emails)
            .values({ threadId: thread.id, hireId: hire.id, messageId: `<${key}@northgate-hire.co.uk>`, direction: 'out', fromAddr: 'hiredesk@northgate-hire.co.uk', toAddrs: reply.to, subject: reply.subject, body: reply.body })
            .returning();
          await indexEvidence(tx, { hireId: hire.id, sourceType: 'email', sourceId: em!.id, content: `${reply.subject}\n${reply.body}` });
        }
        await completeIfDone(tx, d, hire, key);
        return { status: 'OK' as const, result: { outboxId: ob!.id, to: reply.to } };
      });
    }),
  });

  return {
    getHire,
    getLines,
    searchEvidence: searchEvidenceTool,
    getDraftChain: getDraftChainTool,
    getWaiverStatus,
    proposeDraft,
    applyRoutineUpdate,
    applyPricing,
    cancelLine,
    issueCreditNote,
    queueEmail,
  };
}

export type DeskTools = ReturnType<typeof createDeskTools>;
export type { DraftPayload, DraftAction };
export const _internal = { checkReply, pricingPreview };
export type { Tracer };
export type { DraftStatus };
