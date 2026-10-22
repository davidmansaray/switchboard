import { createHash } from 'node:crypto';
import { gbp, lineCreditPence, priceHire } from '@switchboard/core';
import type { DeskInput, ToolOutcome } from './prompt';

/**
 * The scripted desk: a deterministic stand-in for the LLM (LLM_MODE=scripted).
 * It reads exactly what a live model would read (the rendered signals and its
 * own tool results) and decides the next tool calls. It never touches the
 * database itself: every fact it uses comes back through a tool, so the tools'
 * guarantees (versions, action keys, tiers, evidence) are exercised for real.
 */
export type ToolCall = { toolCallId: string; toolName: string; input: Record<string, unknown> };
export type Decision = { calls: ToolCall[] } | { text: string };

type HireFacts = {
  ref: string;
  version: number;
  deliveryDate: string;
  deliverySlot: string;
  durationDays: number;
  discountPct: number;
  damageWaiver: boolean;
  waiverRatePct: number;
  transportPence: number;
  totalPence: number;
  poNumber: string | null;
  lines: Array<{ lineNo: number; kind: string; model: string; description: string; status: 'booked' | 'on_hire' | 'cancelled'; weeklyRatePence: number; quantity: number; fleetNo?: string | null }>;
  siteContact?: { name: string; email: string } | null;
  threads?: Array<{ label: string; subject: string; contactEmail: string | null }>;
};
type DraftFacts = {
  ref: string;
  status: string;
  basedOnVersion: number;
  kind: string;
  title?: string;
  payload: { intent?: string; actions?: Array<Record<string, unknown>>; reply?: Record<string, unknown> };
  supersedesRef?: string | null;
};

type Ctx = {
  input: DeskInput;
  /** Results of calls made for this input, in order. */
  done: ToolOutcome[];
  memoryTool?: string;
  /** Open loops currently in working memory (parsed from the system prompt). */
  loops: Loop[];
  call: (step: string, toolName: string, input: Record<string, unknown>) => ToolCall;
};

type Step = { calls: ToolCall[] } | { done: string };

const okResult = <T>(o: ToolOutcome | undefined): T | undefined => {
  const v = o?.output as { status?: string; result?: T } | undefined;
  return v && (v.status === 'OK' || v.status === 'DUPLICATE') ? v.result : undefined;
};
const find = (c: Ctx, step: string) => c.done.find((r) => r.toolCallId.endsWith(`:${step}`));
const has = (c: Ctx, step: string) => Boolean(find(c, step));

function hireOf(c: Ctx): HireFacts | undefined {
  // The latest hire read wins (a STALE result triggers a re-read under a new step name).
  const reads = c.done.filter((r) => r.toolName === 'getHire');
  return okResult<{ hire: HireFacts }>(reads.at(-1))?.hire;
}

const fmtDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

export type Loop = { status: 'open' | 'decided' | 'closed'; key: string; text: string };
const LOOP_RE = /^- \[(open|decided|closed)\] ([\w-]+): (.+)$/;

/** Open loops from the working memory block Mastra puts in the system prompt. */
export function parseLoops(system: string): Loop[] {
  const block = system.match(/<working_memory_data>([\s\S]*?)<\/working_memory_data>/)?.[1] ?? '';
  return block
    .split('\n')
    .map((l) => LOOP_RE.exec(l.trim()))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ status: m[1] as Loop['status'], key: m[2]!, text: m[3]! }));
}

export function renderLoops(loops: Loop[]): string {
  const lines = loops.length ? loops.map((l) => `- [${l.status}] ${l.key}: ${l.text}`) : ['- (none)'];
  return ['# Desk working memory', '## Open loops', ...lines].join('\n');
}

/** Upsert one loop (by key) into working memory; earlier loops are carried forward. No clock times, so replays hash the same. */
function memoryCall(c: Ctx, step: string, loop: Loop): Step {
  if (!c.memoryTool || has(c, step)) return { done: '' };
  const loops = c.loops.filter((l) => l.key !== loop.key).concat(loop);
  return { calls: [c.call(step, c.memoryTool, { memory: renderLoops(loops) })] };
}

/** Run steps in order; the first step that still has work returns its calls. */
function sequence(c: Ctx, steps: Array<() => Step | null>, summary: () => string): Step {
  for (const s of steps) {
    const r = s();
    if (r && 'calls' in r && r.calls.length) return r;
  }
  return { done: summary() };
}

function readHire(c: Ctx, attempt = 0): Step | null {
  const step = attempt ? `read${attempt}` : 'read';
  if (has(c, step)) return null;
  return { calls: [c.call(step, 'getHire', { hireRef: c.input.attrs.hire })] };
}

/** How many proposals came back STALE: each one means "re-read and redo against the new version". */
function staleAttempts(c: Ctx): number {
  return c.done.filter((r) => r.toolName === 'proposeDraft' && (r.output as { status?: string })?.status === 'STALE').length;
}
const proposeStep = (attempt: number) => (attempt ? `propose${attempt}` : 'propose');
const lastProposal = (c: Ctx) => [...c.done].reverse().find((r) => r.toolName === 'proposeDraft' && (r.output as { status?: string })?.status !== 'STALE');

function discountReply(h: HireFacts, discountPct: number) {
  const price = priceHire({ lines: h.lines, durationDays: h.durationDays, discountPct, damageWaiver: h.damageWaiver, transportPence: h.transportPence, waiverRatePct: h.waiverRatePct });
  const was = priceHire({ lines: h.lines, durationDays: h.durationDays, discountPct: 0, damageWaiver: h.damageWaiver, transportPence: h.transportPence, waiverRatePct: h.waiverRatePct });
  const active = h.lines.filter((l) => l.status !== 'cancelled');
  const kit = active.map((l) => `${l.fleetNo ? `${l.fleetNo} ` : ''}${l.description}`).join(' and ');
  const body = [
    `Hi ${h.siteContact?.name.split(' ')[0] ?? 'there'},`,
    '',
    `Thanks for the call. As agreed with Gary, we've applied ${discountPct}% off ${h.ref} in return for the two further hires this quarter.`,
    '',
    `Kit: ${kit}.`,
    `Delivery: ${fmtDate(h.deliveryDate)} (${h.deliverySlot}), ${h.durationDays / 7} weeks.`,
    `Hire price: ${gbp(price.subtotalPence)} incl. transport (was ${gbp(was.subtotalPence)}), plus damage waiver ${gbp(price.waiverPence)} and VAT.`,
    '',
    'Kind regards,',
    'Northgate Plant & Access Hire',
  ].join('\n');
  return { body, price };
}

function threadFor(h: HireFacts, label: string) {
  return h.threads?.find((t) => t.label === label);
}

// ---------------------------------------------------------------------------
// Plans per input kind
// ---------------------------------------------------------------------------

function planEmail(c: Ctx): Step {
  const body = c.input.contents;
  const intent = /cancel/i.test(body)
    ? 'cancel'
    : /\bPO\b|purchase order|invoice address/i.test(body)
      ? 'routine'
      : /knock|discount|cheaper|better price|deal|money off/i.test(body)
        ? 'discount-ask'
        : 'other';
  if (intent === 'cancel') return planCancellation(c, 'customer email');
  if (intent === 'routine') return planRoutine(c);
  if (intent === 'discount-ask') {
    return sequence(
      c,
      [
        () => readHire(c),
        () => (has(c, 'evidence') ? null : { calls: [c.call('evidence', 'searchEvidence', { hireRef: c.input.attrs.hire, query: 'discount price more sites' })] }),
        () =>
          memoryCall(c, 'memory', {
            status: 'open',
            key: 'discount',
            text: `${c.input.attrs.from_name ?? 'Customer'} (${c.input.attrs.thread ?? 'email'}) asked for a discount: "${firstLine(body)}" Waiting on an approver's decision; no price quoted.`,
          }),
      ],
      () => `Recorded an open discount ask on ${c.input.attrs.hire}. No customer reply drafted: price changes need an approver's decision.`,
    );
  }
  return sequence(c, [() => readHire(c)], () => `Read ${c.input.attrs.hire}; nothing to action in this email.`);
}

function planRoutine(c: Ctx): Step {
  const body = c.input.contents;
  const po = body.match(/\bPO\s*(?:number|no\.?|#)?[^\n]*?\b(?:is|:)\s*([A-Z0-9][A-Z0-9/-]{3,}[A-Z0-9])/)?.[1];
  const addr = body.match(/invoice address(?:\s+is)?\s*[:-]?\s*\n?([^\n]+(?:\n(?!\s*\n)[^\n]+){0,4})/i)?.[1];
  const changes: Record<string, string> = {};
  if (po) changes.poNumber = po;
  if (addr) changes.invoiceAddress = addr.split('\n').map((s) => s.trim().replace(/,$/, '')).filter(Boolean).filter((s) => !/^(thanks|kind regards|regards|cheers)/i.test(s)).join(', ');
  return sequence(
    c,
    [
      () => readHire(c),
      () => {
        const h = hireOf(c);
        if (!h || has(c, 'apply') || !Object.keys(changes).length) return null;
        return {
          calls: [
            c.call('apply', 'applyRoutineUpdate', {
              hireRef: h.ref,
              expectedVersion: h.version,
              changes,
              evidenceIds: c.input.attrs.evidence_id ? [c.input.attrs.evidence_id] : [],
            }),
          ],
        };
      },
      () => {
        const r = okResult<{ version: number }>(find(c, 'apply'));
        if (!r) return null;
        const what = [changes.poNumber ? `PO ${changes.poNumber}` : '', changes.invoiceAddress ? 'invoice address' : ''].filter(Boolean).join(' + ');
        return memoryCall(c, 'memory', { status: 'closed', key: 'invoicing', text: `${what} applied automatically (routine tier, logged, no approval).` });
      },
    ],
    () => {
      const r = find(c, 'apply')?.output as { status?: string; result?: { version?: number } } | undefined;
      return r?.status === 'OK' || r?.status === 'DUPLICATE'
        ? `Applied routine update (${Object.keys(changes).join(', ')}) to ${c.input.attrs.hire} automatically (tier: auto, logged); hire now v${r.result?.version}.`
        : `Routine update not applied: ${JSON.stringify(r ?? 'no recognised fields')}.`;
    },
  );
}

function planDiscountDecision(c: Ctx): Step {
  const pct = Number(c.input.contents.match(/(\d{1,2})\s*%/)?.[1] ?? 0);
  return sequence(
    c,
    [
      () => readHire(c),
      () =>
        has(c, 'evidence')
          ? null
          : {
              calls: [
                c.call('evidence', 'searchEvidence', {
                  hireRef: c.input.attrs.hire,
                  query: 'call Sam more hires this quarter discount',
                  sourceTypes: ['transcript', 'email'],
                }),
              ],
            },
      () => (has(c, 'chain') ? null : { calls: [c.call('chain', 'getDraftChain', { hireRef: c.input.attrs.hire })] }),
      () => (staleAttempts(c) ? readHire(c, staleAttempts(c)) : null),
      () => {
        const h = hireOf(c);
        const step = proposeStep(staleAttempts(c));
        if (!h || has(c, step) || staleAttempts(c) > 2) return null;
        const hits = okResult<{ hits: Array<{ id: string; sourceType: string }> }>(find(c, 'evidence'))?.hits ?? [];
        const evidenceIds = [c.input.attrs.evidence_id, ...hits.filter((x) => x.sourceType === 'transcript').map((x) => x.id)].filter(Boolean);
        const t1 = threadFor(h, 'T1');
        const { body } = discountReply(h, pct);
        return {
          calls: [
            c.call(step, 'proposeDraft', {
              hireRef: h.ref,
              intent: 'discount',
              kind: 'bundle',
              title: `Pricing + reply to ${h.siteContact?.name.split(' ')[0] ?? 'customer'} (${pct}% off)`,
              basedOnVersion: h.version,
              actions: [{ type: 'applyPricing', discountPct: pct }],
              reply: { threadLabel: 'T1', to: [t1?.contactEmail ?? h.siteContact?.email], subject: `Re: ${t1?.subject ?? h.ref}`, body },
              evidenceIds,
            }),
          ],
        };
      },
      () => {
        const d = okResult<{ draft: DraftFacts }>(lastProposal(c))?.draft;
        return d
          ? memoryCall(c, 'memory', { status: 'decided', key: 'discount', text: `Gary decided ${pct}% off, final (note + call transcript). ${d.ref} (based on v${d.basedOnVersion}) waiting in the sign-off slot.` })
          : null;
      },
    ],
    () => {
      const r = lastProposal(c)?.output as { status: string; result?: { draft: DraftFacts } } | undefined;
      return r?.result ? `Prepared ${r.result.draft.ref} (pricing + reply, based on v${r.result.draft.basedOnVersion}) for approval.` : `Could not prepare the draft: ${JSON.stringify(r)}`;
    },
  );
}

function planEdit(c: Ctx): Step {
  return sequence(
    c,
    [
      () => readHire(c),
      () => (has(c, 'chain') ? null : { calls: [c.call('chain', 'getDraftChain', { hireRef: c.input.attrs.hire })] }),
      () => {
        const drafts = okResult<{ drafts: DraftFacts[] }>(find(c, 'chain'))?.drafts ?? [];
        const stale = drafts.filter((d) => d.status === 'stale');
        const h = hireOf(c);
        if (!stale.length || !h) return null;
        const key = stale[0]?.payload.intent ?? 'discount';
        return memoryCall(c, 'memory', {
          status: 'decided',
          key,
          text: `${stale.map((d) => d.ref).join(', ')} is stale: the hire moved to v${h.version} (staff edit). Nothing is sent until it is regenerated against v${h.version}.`,
        });
      },
    ],
    () => {
      const drafts = okResult<{ drafts: DraftFacts[] }>(find(c, 'chain'))?.drafts ?? [];
      const stale = drafts.filter((d) => d.status === 'stale').map((d) => d.ref);
      return `Noted staff edit on ${c.input.attrs.hire}.${stale.length ? ` ${stale.join(', ')} now stale.` : ''}`;
    },
  );
}

const statusOf = (o: ToolOutcome | undefined) => (o?.output as { status?: string } | undefined)?.status;

function planApproval(c: Ctx): Step {
  const ref = c.input.attrs.draft;
  const decision = c.input.attrs.decision;
  const draftOf = () => (okResult<{ drafts: DraftFacts[] }>(find(c, 'chain'))?.drafts ?? []).find((d) => d.ref === ref);
  /** An apply step came back STALE: the hire moved between the approval and the apply. */
  const overtaken = () => c.done.some((r) => r.toolCallId.includes(':act') && statusOf(r) === 'STALE');
  return sequence(
    c,
    [
      () => readHire(c),
      () => (has(c, 'chain') ? null : { calls: [c.call('chain', 'getDraftChain', { hireRef: c.input.attrs.hire })] }),
      () => {
        const d = draftOf();
        const h = hireOf(c);
        if (!d || !h || decision !== 'approved') return null;
        // An approved draft is past the staleness gate (the approval checked it); our own apply
        // steps move the version, so a retried turn must carry on applying, not regenerate.
        const isStale = d.status === 'stale' || (d.status === 'pending' && d.basedOnVersion < h.version);
        if (isStale) return regenerate(c, d, h);
        if (d.status !== 'approved') return null;
        if (overtaken()) {
          // The apply tool marked the draft stale; re-read the hire and regenerate it, like beat 5.
          if (!has(c, 'reread')) return { calls: [c.call('reread', 'getHire', { hireRef: h.ref })] };
          return regenerate(c, d, hireOf(c) ?? h);
        }
        return applyApproved(c, d, h);
      },
      () => {
        const d = draftOf();
        const h = hireOf(c);
        if (!d || !h) return null;
        const intent = d.payload.intent ?? 'update';
        const regen = okResult<{ draft: DraftFacts }>(find(c, 'regen'))?.draft;
        if (decision !== 'approved') return memoryCall(c, 'memory', { status: 'closed', key: intent, text: `${ref} rejected by the approver; nothing sent.` });
        if (regen) {
          const why = overtaken() ? 'the hire moved after the approval' : `it was written against v${d.basedOnVersion}`;
          return memoryCall(c, 'memory', { status: 'decided', key: intent, text: `${ref} approved, but ${why}. Regenerated as ${regen.ref} for v${regen.basedOnVersion}; waiting on Gary again.` });
        }
        const sent = okResult<{ outboxId: string }>(find(c, 'email'));
        if (!sent) return null;
        const versions = c.done.map((r) => okResult<{ version?: number }>(r)?.version).filter((v): v is number => typeof v === 'number');
        const now = versions.length ? Math.max(...versions) : h.version;
        const what = intent === 'discount' ? 'pricing applied' : intent.startsWith('cancel-line') ? 'line cancelled, credit note issued' : 'sent';
        return memoryCall(c, 'memory', { status: 'closed', key: intent, text: `${ref} applied: ${what}, hire now v${now}. Exactly one email to the customer.` });
      },
    ],
    () => {
      const d = draftOf();
      const regen = okResult<{ draft: DraftFacts }>(find(c, 'regen'))?.draft;
      if (decision !== 'approved') return `${ref} was rejected; closed the loop.`;
      if (regen && overtaken()) return `${ref} was approved, but the hire moved before it could be applied; regenerated as ${regen.ref} against v${regen.basedOnVersion}. Needs approval again.`;
      if (regen) return `${ref} was approved but is stale (based on v${d?.basedOnVersion}); regenerated as ${regen.ref} against v${regen.basedOnVersion}. Needs approval again.`;
      const email = okResult<{ outboxId: string }>(find(c, 'email'));
      return email ? `Applied ${ref} and sent exactly one email (outbox ${email.outboxId}).` : `Approval of ${ref} handled.`;
    },
  );
}

function regenerate(c: Ctx, d: DraftFacts, h: HireFacts): Step | null {
  if (has(c, 'regen')) return null;
  const intent = d.payload.intent ?? 'update';
  const actions = d.payload.actions ?? [];
  let body = String(d.payload.reply?.body ?? '');
  if (intent === 'discount') {
    const pct = Number((actions.find((a) => a.type === 'applyPricing') as { discountPct?: number } | undefined)?.discountPct ?? 0);
    body = discountReply(h, pct).body.replace("Thanks for the call.", `Thanks for the call. Note the updated delivery and kit below.`);
  }
  return {
    calls: [
      c.call('regen', 'proposeDraft', {
        hireRef: h.ref,
        intent,
        kind: d.kind,
        title: `${String(d.title ?? intent).replace(/, revised for v\d+$/, '')}, revised for v${h.version}`,
        basedOnVersion: h.version,
        supersedes: d.ref,
        actions,
        reply: { ...(d.payload.reply ?? {}), body },
        evidenceIds: (d as { evidenceIds?: string[] }).evidenceIds ?? [],
      }),
    ],
  };
}

function applyApproved(c: Ctx, d: DraftFacts, h: HireFacts): Step | null {
  const actions = d.payload.actions ?? [];
  for (const [i, a] of actions.entries()) {
    const step = `act${i}`;
    if (has(c, step)) continue;
    if (a.type === 'applyPricing') return { calls: [c.call(step, 'applyPricing', { hireRef: h.ref, draftRef: d.ref, expectedVersion: d.basedOnVersion })] };
    if (a.type === 'cancelLine') return { calls: [c.call(step, 'cancelLine', { hireRef: h.ref, draftRef: d.ref, lineNo: a.lineNo, expectedVersion: d.basedOnVersion })] };
    if (a.type === 'creditNote') return { calls: [c.call(step, 'issueCreditNote', { hireRef: h.ref, draftRef: d.ref, lineNo: a.lineNo })] };
  }
  if (d.payload.reply && !has(c, 'email')) return { calls: [c.call('email', 'queueEmail', { hireRef: h.ref, draftRef: d.ref })] };
  return null;
}

function planSweep(c: Ctx): Step {
  return sequence(
    c,
    [
      () => readHire(c),
      () => (has(c, 'waiver') ? null : { calls: [c.call('waiver', 'getWaiverStatus', { hireRef: c.input.attrs.hire })] }),
      () => (has(c, 'chain') ? null : { calls: [c.call('chain', 'getDraftChain', { hireRef: c.input.attrs.hire })] }),
      () => {
        const w = okResult<{ signed: boolean; documentEvidenceId: string | null; daysToDelivery: number }>(find(c, 'waiver'));
        const h = hireOf(c);
        if (!w || !h || w.signed || has(c, 'propose')) return null;
        const t1 = threadFor(h, 'T1');
        const first = h.siteContact?.name.split(' ')[0] ?? 'there';
        return {
          calls: [
            c.call('propose', 'proposeDraft', {
              hireRef: h.ref,
              intent: 'waiver-chaser',
              kind: 'email',
              title: `Waiver chaser to ${h.siteContact?.name.split(' ')[0] ?? 'customer'}: damage waiver not signed`,
              basedOnVersion: h.version,
              actions: [],
              reply: {
                threadLabel: 'T1',
                to: [t1?.contactEmail ?? h.siteContact?.email],
                subject: `Re: ${t1?.subject ?? h.ref}`,
                body: [
                  `Hi ${first},`,
                  '',
                  `Quick one before delivery on ${fmtDate(h.deliveryDate)}: we don't have the signed damage waiver for ${h.ref} on file yet. Could you sign and return it so the machines can go out as planned?`,
                  '',
                  'Kind regards,',
                  'Northgate Plant & Access Hire',
                ].join('\n'),
              },
              evidenceIds: [w.documentEvidenceId].filter(Boolean),
            }),
          ],
        };
      },
      () => {
        const p = okResult<{ draft: DraftFacts }>(find(c, 'propose'))?.draft;
        return p ? memoryCall(c, 'memory', { status: 'open', key: 'waiver-chaser', text: `No signed damage waiver on file before delivery. Chaser ${p.ref} to the site contact waiting on Gary.` }) : null;
      },
    ],
    () => {
      const w = okResult<{ signed: boolean }>(find(c, 'waiver'));
      const p = okResult<{ draft: DraftFacts }>(find(c, 'propose'))?.draft;
      if (w?.signed) return `Pre-delivery sweep on ${c.input.attrs.hire}: waiver signed, nothing due.`;
      return p ? `Pre-delivery sweep: no signed damage waiver on file. Drafted chaser ${p.ref} to Gary's queue.` : 'Pre-delivery sweep done.';
    },
  );
}

/**
 * Which line a cancellation is about. A status change names it (attrs.line); in prose, the words after
 * "cancel" win and anything after "keep" is excluded ("cancel the telehandler, keep the boom").
 */
export function cancelLineOf(c: { input: { attrs: Record<string, string> } }, h: Pick<HireFacts, 'lines'>, text: string) {
  const byNo = Number(c.input.attrs.line);
  if (byNo) return h.lines.find((l) => l.lineNo === byNo);
  const names = (l: HireFacts['lines'][number]) =>
    [l.kind.replace('_', ' '), l.model.toLowerCase(), l.fleetNo?.toLowerCase(), l.description.toLowerCase()].filter((x): x is string => Boolean(x));
  const t = text.toLowerCase();
  const clause = t.match(/cancel(?:ling|led)?\s+(?:the\s+)?([^,.;\n]+)/)?.[1]?.split(/\b(?:keep|but)\b/)[0] ?? '';
  const named = clause ? h.lines.find((l) => names(l).some((n) => clause.includes(n))) : undefined;
  if (named) return named;
  const kept = t.match(/keep\s+(?:the\s+)?([^,.;\n]+)/)?.[1] ?? '';
  return h.lines.find((l) => names(l).some((n) => t.includes(n)) && !names(l).some((n) => kept.includes(n)));
}

function planCancellation(c: Ctx, source: string): Step {
  const text = c.input.contents.toLowerCase();
  return sequence(
    c,
    [
      () => readHire(c),
      () => (has(c, 'chain') ? null : { calls: [c.call('chain', 'getDraftChain', { hireRef: c.input.attrs.hire })] }),
      () => (staleAttempts(c) ? readHire(c, staleAttempts(c)) : null),
      () => {
        const h = hireOf(c);
        const step = proposeStep(staleAttempts(c));
        if (!h || has(c, step) || staleAttempts(c) > 2) return null;
        const line = cancelLineOf(c, h, text);
        if (!line) return null;
        const kept = h.lines.filter((l) => l.lineNo !== line.lineNo && l.status !== 'cancelled');
        const credit = lineCreditPence(line, h.durationDays, h.discountPct);
        const t1 = threadFor(h, 'T1');
        const first = h.siteContact?.name.split(' ')[0] ?? 'there';
        return {
          calls: [
            c.call(step, 'proposeDraft', {
              hireRef: h.ref,
              intent: `cancel-line-${line.lineNo}`,
              kind: 'bundle',
              title: `Partial cancellation: ${line.description}${line.fleetNo ? ` ${line.fleetNo}` : ''} (credit ${gbp(credit)})`,
              basedOnVersion: h.version,
              actions: [
                { type: 'cancelLine', lineNo: line.lineNo },
                { type: 'creditNote', lineNo: line.lineNo },
              ],
              reply: {
                threadLabel: 'T1',
                to: [t1?.contactEmail ?? h.siteContact?.email],
                subject: `Re: ${t1?.subject ?? h.ref}`,
                body: [
                  `Hi ${first},`,
                  '',
                  `Confirming the ${line.description}${line.fleetNo ? ` (${line.fleetNo})` : ''} is cancelled from ${h.ref}; the ${kept.map((l) => l.description).join(' and ') || 'rest of the hire'} stays booked for ${fmtDate(h.deliveryDate)}.`,
                  `We'll issue a credit note for ${gbp(credit)}.`,
                  '',
                  'Kind regards,',
                  'Northgate Plant & Access Hire',
                ].join('\n'),
              },
              evidenceIds: [c.input.attrs.evidence_id].filter(Boolean),
              source,
            }),
          ],
        };
      },
      () => {
        const r = lastProposal(c)?.output as { status: string; result?: { draft: DraftFacts } } | undefined;
        const d = r?.result?.draft;
        if (!d || has(c, 'memory')) return null;
        const h = hireOf(c);
        const line = h ? cancelLineOf(c, h, text) : undefined;
        const key = line ? `cancel-line-${line.lineNo}` : 'cancel-line';
        return memoryCall(c, 'memory', {
          status: 'open',
          key,
          text:
            r?.status === 'DUPLICATE'
              ? `Same cancellation asked twice (customer email + staff status change): one intent, one action key. ${d.ref} waiting on Gary; no second credit note.`
              : `Partial cancellation requested (${source}). ${d.ref} with credit note waiting on Gary.`,
        });
      },
    ],
    () => {
      const r = lastProposal(c)?.output as { status: string; result?: { draft: DraftFacts } } | undefined;
      if (r?.status === 'DUPLICATE') return `Same cancellation intent already in hand as ${r.result?.draft.ref} (${source}); no second credit note.`;
      return r?.result ? `Prepared partial cancellation ${r.result.draft.ref} for approval (${source}).` : 'Cancellation request noted.';
    },
  );
}

const firstLine = (s: string) => s.split('\n').find((l) => l.trim() && !/^(hi|hello|dear|subject:)/i.test(l.trim()))?.trim().slice(0, 120) ?? s.slice(0, 120);

function planFor(c: Ctx): Step {
  const kind = c.input.attrs.kind ?? c.input.tag;
  if (!c.input.attrs.hire) return { done: '' };
  switch (kind) {
    case 'email.received':
      return planEmail(c);
    case 'note.created':
      return /\b\d{1,2}\s*%/.test(c.input.contents) && /@assistant/i.test(c.input.contents) ? planDiscountDecision(c) : { done: '' };
    case 'hire.updated':
      return planEdit(c);
    case 'approval.decided':
      return planApproval(c);
    case 'status.changed':
      return c.input.attrs.to === 'cancelled' ? planCancellation(c, 'staff status change') : { done: '' };
    case 'schedule.fired':
    case 'schedule':
      return planSweep(c);
    default:
      return { done: '' };
  }
}

export function decide(input: { inputs: DeskInput[]; results: ToolOutcome[]; toolNames: string[]; system?: string }): Decision {
  const memoryTool = input.toolNames.find((n) => /working.?memory/i.test(n));
  const loops = parseLoops(input.system ?? '');
  const summaries: string[] = [];
  for (const inp of input.inputs) {
    const prefix = `in${inp.index}-${shortHash(inp.raw)}`;
    const done = input.results.filter((r) => r.toolCallId.startsWith(`${prefix}:`));
    const ctx: Ctx = {
      input: inp,
      done,
      memoryTool,
      loops,
      call: (step, toolName, args) => ({ toolCallId: `${prefix}:${step}`, toolName, input: args }),
    };
    const step = planFor(ctx);
    if ('calls' in step) return { calls: step.calls };
    if (step.done) summaries.push(step.done);
  }
  return { text: summaries.length ? summaries.join('\n') : 'Nothing to action.' };
}

const shortHash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 8);
