import 'server-only';
import { formatDiff, priceHire, type DiffEntry } from '@switchboard/core';
import { getDb, schema as s } from '@switchboard/db';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { addDays, fmtDate, fmtTime, gbp0, shortMachine, shortRun, shortSig } from './format';
import type {
  BoardView,
  DeskDetail,
  DeskStatus,
  DeskView,
  DraftView,
  EvidenceRef,
  FieldChange,
  LineView,
  LoopView,
  RunView,
  RuntimeView,
  ScenarioView,
  SignalSource,
  SignalView,
  Staff,
} from './types';

/**
 * Read side of the UI. Everything comes from the real tables in `app` (written by the agent's
 * tools, triggers and signal adapter). Two Mastra tables are read, read-only: the desk thread's
 * working memory (open loops) lives in `mastra.mastra_threads.metadata`.
 */
const db = () => getDb().db;

type Snapshot = {
  deliveryDate: string;
  durationDays: number;
  discountPct: string | number;
  totalPence: number;
  lines: Record<string, { kind: string; model: string; description: string; fleetNo: string | null; status: string; weeklyRatePence: number }>;
};

const LEASE_MS = 30_000;

// ---------------------------------------------------------------- staff + runtime

export async function listStaff(): Promise<Staff[]> {
  const rows = await db().select().from(s.staff).orderBy(asc(s.staff.name));
  return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, title: r.title }));
}

export async function getRuntime(): Promise<RuntimeView> {
  const rows = await db().select().from(s.opsLog).orderBy(desc(s.opsLog.createdAt)).limit(40);
  const boot = rows.find((r) => r.kind === 'boot');
  const crash = rows.find((r) => r.kind === 'crash');
  const armed = rows.find((r) => r.kind === 'crash.armed');
  const bootAt = boot?.createdAt.getTime() ?? 0;
  const crashAt = crash?.createdAt.getTime() ?? 0;
  const bootDetail = (boot?.detail ?? {}) as { backend?: string; llmMode?: string; crashEnabled?: boolean };
  // The lease Mastra reported when it skipped recovery ("run-active", retryAt), else crash + 30 s.
  const lease = rows.find((r) => r.kind === 'recovery' && (r.detail as { retryAt?: string }).retryAt && r.createdAt.getTime() >= crashAt);
  const armedLive = armed && armed.createdAt.getTime() > Math.max(bootAt, crashAt) ? String((armed.detail as { tool?: string }).tool ?? '*') : null;
  return {
    workerDown: crashAt > bootAt,
    lastCrashAt: crash?.createdAt.toISOString() ?? null,
    leaseEndsAt: lease ? String((lease.detail as { retryAt: string }).retryAt) : crash ? new Date(crashAt + LEASE_MS).toISOString() : null,
    lastBootAt: boot?.createdAt.toISOString() ?? null,
    crashArmed: armedLive,
    backend: bootDetail.backend ?? null,
    llmMode: bootDetail.llmMode ?? null,
    crashEnabled: bootDetail.crashEnabled ?? process.env.ALLOW_CRASH_ENDPOINT === 'true',
    resetEnabled: process.env.ALLOW_SCENARIO_RESET !== 'false',
  };
}

export async function getScenario(): Promise<ScenarioView> {
  const rows = await db().select().from(s.scenarioBeats).orderBy(asc(s.scenarioBeats.n));
  const done = new Set(rows.filter((r) => r.status === 'done').map((r) => r.n));
  let next: number | null = null;
  for (let n = 1; n <= 9; n++) if (!done.has(n)) { next = n; break; }
  return {
    beats: rows.map((r) => ({ n: r.n, status: r.status, error: r.error })),
    next,
    busy: rows.some((r) => r.status === 'playing'),
  };
}

// ---------------------------------------------------------------- hires + desks

type HireRow = typeof s.hires.$inferSelect & { customer: string };

async function loadHires(ref?: string) {
  const hires = await db()
    .select({ h: s.hires, customer: s.customers.name })
    .from(s.hires)
    .innerJoin(s.customers, eq(s.customers.id, s.hires.customerId))
    .where(ref ? eq(s.hires.ref, ref) : undefined);
  const ids = hires.map((x) => x.h.id);
  if (!ids.length) return { hires: [] as HireRow[], lines: new Map<string, LineView[]>(), desks: new Map<string, typeof s.desks.$inferSelect>() };
  const [lines, fleet, desks] = await Promise.all([
    db().select().from(s.hireLines).where(inArray(s.hireLines.hireId, ids)).orderBy(asc(s.hireLines.lineNo)),
    db().select().from(s.fleet),
    db().select().from(s.desks).where(inArray(s.desks.hireId, ids)),
  ]);
  const fleetBy = new Map(fleet.map((f) => [f.fleetNo, f]));
  const linesBy = new Map<string, LineView[]>();
  for (const l of lines) {
    const f = l.fleetNo ? fleetBy.get(l.fleetNo) : undefined;
    const arr = linesBy.get(l.hireId) ?? [];
    arr.push({
      lineNo: l.lineNo,
      kind: l.kind,
      model: l.model,
      description: l.description,
      short: shortMachine(l.description),
      spec: l.spec,
      fleetNo: l.fleetNo,
      status: l.status,
      weeklyRatePence: l.weeklyRatePence,
      ipaf: f?.ipafCategory ?? null,
      lolerDue: f?.lolerDue ?? null,
      lolerMonths: f?.lolerIntervalMonths ?? null,
    });
    linesBy.set(l.hireId, arr);
  }
  return {
    hires: hires.map((x) => ({ ...x.h, customer: x.customer })),
    lines: linesBy,
    desks: new Map(desks.map((d) => [d.hireId, d])),
  };
}

// ---------------------------------------------------------------- signals

type SignalQuery = { hireIds?: string[]; since?: Date; limit?: number };

export async function loadSignals(q: SignalQuery = {}): Promise<SignalView[]> {
  const where = and(q.hireIds ? inArray(s.signalsLog.hireId, q.hireIds) : undefined, q.since ? gte(s.signalsLog.createdAt, q.since) : undefined);
  const rows = await db()
    .select({ sl: s.signalsLog, ref: s.hires.ref, ev: s.events })
    .from(s.signalsLog)
    .innerJoin(s.hires, eq(s.hires.id, s.signalsLog.hireId))
    .leftJoin(s.events, eq(s.events.id, s.signalsLog.eventId))
    .where(where)
    .orderBy(desc(s.signalsLog.createdAt))
    .limit(q.limit ?? 200);
  const evWhere = and(
    eq(s.deskSteps.kind, 'evidence'),
    q.hireIds ? inArray(s.deskSteps.hireId, q.hireIds) : undefined,
    q.since ? gte(s.deskSteps.createdAt, q.since) : undefined,
  );
  const evidence = await db()
    .select({ st: s.deskSteps, ref: s.hires.ref })
    .from(s.deskSteps)
    .innerJoin(s.hires, eq(s.hires.id, s.deskSteps.hireId))
    .where(evWhere)
    .orderBy(desc(s.deskSteps.createdAt))
    .limit(60);
  const staff = new Map((await db().select().from(s.staff)).map((x) => [x.id, x.name]));
  const approvalIds = rows.map((r) => (r.sl.attributes as Record<string, string | undefined>).approval_id).filter((x): x is string => Boolean(x));
  const approvals = approvalIds.length ? await db().select().from(s.approvals).where(inArray(s.approvals.id, approvalIds)) : [];
  const channel = new Map(approvals.map((a) => [a.id, a.channel]));
  const shortOf = new Map(rows.map((r) => [r.sl.id, shortSig(r.sl.id)]));

  const out: SignalView[] = rows.map(({ sl, ref, ev }) => {
    const a = sl.attributes as Record<string, string>;
    const p = (ev?.payload ?? {}) as Record<string, unknown>;
    const source = (sl.tag === 'schedule' ? 'schedule' : sl.tag) as SignalSource;
    let actor = '';
    let summary = '';
    switch (sl.tag) {
      case 'email': {
        actor = a.from_name ?? a.from ?? 'Customer';
        summary = emailSummary(sl.contents);
        break;
      }
      case 'note':
        actor = staff.get(a.author ?? '') ?? a.author ?? 'Staff';
        summary = `“${sl.contents.replace(/@assistant\s*/gi, '').trim()}”`;
        break;
      case 'field_edit':
        actor = staff.get(a.by ?? '') ?? a.by ?? 'Staff';
        summary = humaniseDiff((p.diff as DiffEntry[] | undefined) ?? []) || sl.contents;
        break;
      case 'status_change':
        actor = staff.get(a.by ?? '') ?? a.by ?? 'Staff';
        summary = `Line ${a.line} set ${(a.from ?? '').replace('_', ' ')} → ${(a.to ?? '').replace('_', ' ')} directly`;
        break;
      case 'approval': {
        const ch = channel.get(a.approval_id ?? '');
        actor = `${staff.get(a.decided_by ?? '') ?? a.decided_by ?? 'Approver'}${ch === 'mobile' ? ' (mobile)' : ''}`;
        summary = `${a.draft} ${a.decision}; hire is ${a.based_on && a.hire_version && a.based_on !== a.hire_version ? 'now ' : ''}v${a.hire_version}`;
        break;
      }
      case 'schedule':
        actor = a.trigger === 'cron' ? 'daily, 07:00' : 'fired now';
        summary = '07:00 pre-delivery sweep: waiver, delivery readiness, anything waiting on us';
        break;
      default:
        actor = sl.tag;
        summary = sl.contents.slice(0, 140);
    }
    const pickedUp = sl.outcome === 'queued' && Boolean(ev?.runId || ev?.processedAt);
    return {
      id: sl.id,
      short: shortOf.get(sl.id)!,
      at: sl.createdAt.toISOString(),
      hireRef: ref,
      source,
      type: sl.kind,
      delivery: sl.outcome,
      pickedUp,
      actor,
      thread: a.thread ?? null,
      summary,
      mergedInto: sl.mergedInto ? shortSig(sl.mergedInto) : null,
      waitsFor: shortRun(sl.waitsForRunId),
      runId: sl.runId,
      backend: sl.backend,
    };
  });
  for (const { st, ref } of evidence) {
    const d = st.detail as { sourceType?: string; title?: string };
    out.push({
      id: st.id,
      short: shortSig(st.id),
      at: st.createdAt.toISOString(),
      hireRef: ref,
      source: d.sourceType === 'document' ? 'document' : 'transcript',
      type: 'evidence',
      delivery: 'delivered',
      pickedUp: false,
      actor: (d.title ?? '').replace(/^Call:\s*/, '').replace(/\s*\(.*\)$/, ''),
      thread: null,
      summary: st.text,
      mergedInto: null,
      waitsFor: null,
      runId: st.runId,
      backend: '',
    });
  }
  return out.sort((x, y) => y.at.localeCompare(x.at));
}

function emailSummary(contents: string): string {
  const body = contents.split('\n\n').slice(1).join('\n\n') || contents;
  const lines = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^(hi|hello|dear|cheers|thanks|kind regards|regards)\b/i.test(l) && !/^[A-Z][a-z]+( [A-Z][a-z]+)?$/.test(l));
  const text = lines.slice(0, 2).join(' ');
  return text.length > 150 ? `${text.slice(0, 147)}…` : text;
}

/** A hire version diff in words: "Delivery Mon 2 Nov → Wed 4 Nov; line 2: 14m telehandler → 17m telehandler (TH17-05)". */
export function humaniseDiff(diff: DiffEntry[]): string {
  const parts: string[] = [];
  const byLine = new Map<string, Record<string, DiffEntry>>();
  for (const d of diff) {
    const m = d.path.match(/^lines\.(\d+)\.(\w+)$/);
    if (m) {
      const rec = byLine.get(m[1]!) ?? {};
      rec[m[2]!] = d;
      byLine.set(m[1]!, rec);
      continue;
    }
    if (d.path === 'deliveryDate') parts.push(`Delivery ${fmtDate(String(d.from))} → ${fmtDate(String(d.to))}`);
    else if (d.path === 'durationDays') parts.push(`Duration ${Number(d.from) / 7} → ${Number(d.to) / 7} weeks`);
    else if (d.path === 'deliverySlot') parts.push(`Slot ${String(d.from)} → ${String(d.to)}`);
    else if (d.path === 'discountPct') parts.push(`Discount ${Number(d.from)}% → ${Number(d.to)}%`);
    else if (d.path === 'poNumber') parts.push(`PO ${d.to ?? '–'}`);
    else if (d.path === 'invoiceAddress') parts.push('Invoice address');
  }
  for (const [no, rec] of byLine) {
    if (rec.description || rec.fleetNo) {
      const from = rec.description?.from ?? '';
      const to = rec.description?.to ?? from;
      parts.push(`line ${no}: ${String(from)} → ${String(to)}${rec.fleetNo ? ` (${String(rec.fleetNo.to)})` : ''}`);
    } else if (rec.status) parts.push(`line ${no} ${String(rec.status.from).replace('_', ' ')} → ${String(rec.status.to).replace('_', ' ')}`);
    else if (rec.weeklyRatePence) parts.push(`line ${no} rate ${gbp0(Number(rec.weeklyRatePence.from))} → ${gbp0(Number(rec.weeklyRatePence.to))}/wk`);
  }
  return parts.join('; ');
}

// ---------------------------------------------------------------- drafts

const INTENT_LABEL: Record<string, string> = {
  discount: 'Pricing + reply',
  'waiver-chaser': 'Waiver chaser',
  'off-hire': 'Off-hire confirmation',
};
export const intentLabel = (intent: string) => INTENT_LABEL[intent] ?? (intent.startsWith('cancel-line') ? 'Partial cancellation' : 'Draft');

async function loadDrafts(hireIds?: string[]) {
  const rows = await db()
    .select({ d: s.drafts, ref: s.hires.ref, version: s.hires.version, customer: s.customers.name, hireId: s.hires.id })
    .from(s.drafts)
    .innerJoin(s.hires, eq(s.hires.id, s.drafts.hireId))
    .innerJoin(s.customers, eq(s.customers.id, s.hires.customerId))
    .where(hireIds ? inArray(s.drafts.hireId, hireIds) : undefined)
    .orderBy(asc(s.drafts.createdAt));
  if (!rows.length) return [] as DraftView[];
  const ids = rows.map((r) => r.d.id);
  const hids = [...new Set(rows.map((r) => r.hireId))];
  const [versions, approvals, staff, evidence, contacts] = await Promise.all([
    db().select().from(s.hireVersions).where(inArray(s.hireVersions.hireId, hids)),
    db().select().from(s.approvals).where(inArray(s.approvals.draftId, ids)).orderBy(asc(s.approvals.createdAt)),
    db().select().from(s.staff),
    db()
      .select({ id: s.evidenceChunks.id, sourceType: s.evidenceChunks.sourceType, content: s.evidenceChunks.content })
      .from(s.evidenceChunks)
      .where(inArray(s.evidenceChunks.hireId, hids)),
    db().select({ email: s.contacts.email, name: s.contacts.name }).from(s.contacts),
  ]);
  const actorName = (actor: string | null) =>
    !actor ? 'someone' : actor.startsWith('agent:') ? 'the desk' : actor.startsWith('customer:') ? contactName(actor.slice(9)) : (staffName.get(actor) ?? actor);
  const contactName = (email?: string) => (email ? (contacts.find((c) => c.email === email)?.name ?? email) : 'customer');
  const snap = (hireId: string, v: number) => versions.find((x) => x.hireId === hireId && x.version === v)?.snapshot as Snapshot | undefined;
  const staffName = new Map(staff.map((x) => [x.id, x.name]));
  const ev = new Map(evidence.map((e) => [e.id, e]));
  const refOf = new Map(rows.map((r) => [r.d.id, r.d.ref]));
  const supersededBy = new Map(rows.filter((r) => r.d.supersedesId).map((r) => [r.d.supersedesId!, r.d.ref]));

  return rows.map(({ d, ref, version, customer, hireId }) => {
    const payload = (d.payload ?? {}) as {
      intent?: string;
      summary?: string;
      reply?: { subject: string; body: string; to: string[]; threadLabel?: string };
      pricing?: { subtotalPence?: number; credits?: number[]; discountPct?: number };
      actions?: Array<{ type: string; discountPct?: number; lineNo?: number }>;
    };
    const intent = payload.intent ?? 'update';
    const base = snap(hireId, d.basedOnVersion);
    const credit = payload.pricing?.credits?.reduce((a, b) => a + b, 0) ?? 0;
    const total = intent.startsWith('cancel-line') ? -credit : intent === 'discount' ? (payload.pricing?.subtotalPence ?? null) : null;
    const prev = d.supersedesId ? rows.find((r) => r.d.id === d.supersedesId) : undefined;
    const prevSnap = prev ? snap(prev.hireId, prev.d.basedOnVersion) : undefined;
    const changes = prev && prevSnap && base ? snapshotChanges(prevSnap, base) : [];
    const prevTotal = (prev?.d.payload as { pricing?: { subtotalPence?: number } } | undefined)?.pricing?.subtotalPence;
    if (prev && intent === 'discount' && prevTotal !== undefined && total !== null && prevTotal !== total) {
      changes.push({ field: 'Price before VAT', from: gbpText(prevTotal), to: gbpText(total) });
    }
    const live = snap(hireId, version);
    const staleChanges = d.status === 'stale' && base && live ? snapshotChanges(base, live) : [];
    // Who moved the hire past this draft: the version right after the one it was written against.
    const mover = d.status === 'stale' ? versions.find((v) => v.hireId === hireId && v.version === d.basedOnVersion + 1) : undefined;
    const staleBy = mover ? `v${d.basedOnVersion} → v${version} · ${actorName(mover.changedBy)}${(mover.diff as Array<{ path: string }>).some((x) => x.path.startsWith('lines.') && x.path.endsWith('.status')) ? ' (status change)' : mover.changedBy?.startsWith('agent:') ? '' : ' (direct edit)'}` : null;
    const toContact = payload.reply?.to?.[0];
    return {
      id: d.id,
      ref: d.ref,
      hireRef: ref,
      customer,
      status: d.status,
      kind: d.kind,
      intent,
      title: d.title,
      to: payload.reply ? `${contactName(toContact)}${payload.reply.threadLabel ? ` (${payload.reply.threadLabel})` : ''}` : intent === 'off-hire' ? customer : null,
      summary: payload.summary ?? draftSummary(intent, payload, base),
      totalPence: total,
      basedOnVersion: d.basedOnVersion,
      hireVersion: version,
      staleReason: d.staleReason,
      staleBy,
      supersedesRef: d.supersedesId ? (refOf.get(d.supersedesId) ?? null) : null,
      supersededByRef: supersededBy.get(d.id) ?? null,
      changes,
      staleChanges,
      evidence: d.evidenceIds.map((id) => evidenceRef(id, ev.get(id))).filter((x): x is EvidenceRef => Boolean(x)),
      reply: payload.reply ? { subject: payload.reply.subject, body: payload.reply.body, to: payload.reply.to } : null,
      createdAt: d.createdAt.toISOString(),
      decidedAt: d.decidedAt?.toISOString() ?? null,
      appliedAt: d.appliedAt?.toISOString() ?? null,
      decisions: approvals
        .filter((a) => a.draftId === d.id)
        .map((a) => ({ by: staffName.get(a.decidedBy) ?? a.decidedBy, decision: a.decision, channel: a.channel, at: a.createdAt.toISOString(), hireVersion: a.hireVersionAtDecision })),
    } satisfies DraftView;
  });
}

const gbpText = (p: number) => `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`;


function evidenceRef(id: string, e?: { sourceType: string; content: string }): EvidenceRef | null {
  if (!e) return null;
  const first = e.content.split('\n')[0] ?? '';
  const label =
    e.sourceType === 'transcript'
      ? `Call transcript · ${first.replace(/^Call:\s*/, '').replace(/\s*\(.*\)$/, '')}`
      : e.sourceType === 'note'
        ? `Note · “${first.replace(/@assistant\s*/i, '').slice(0, 64)}${first.length > 64 ? '…' : ''}”`
        : e.sourceType === 'email'
          ? `Email · ${first.replace(/^Re:\s*/i, '').slice(0, 60)}`
          : first;
  return { id, sourceType: e.sourceType, label };
}

function draftSummary(intent: string, p: { actions?: Array<{ type: string; discountPct?: number; lineNo?: number }> }, base?: Snapshot): string {
  if (!base) return '';
  const lines = Object.values(base.lines).filter((l) => l.status !== 'cancelled');
  const kit = lines.map((l) => shortMachine(l.description)).join(' + ');
  if (intent === 'discount') {
    const pct = p.actions?.find((a) => a.type === 'applyPricing')?.discountPct ?? 0;
    return `${pct}% off hire charges. Delivery ${fmtDate(base.deliveryDate)}, ${kit}.`;
  }
  if (intent === 'waiver-chaser') return `Asks for the signed damage waiver before delivery on ${fmtDate(base.deliveryDate)}.`;
  if (intent.startsWith('cancel-line')) {
    const no = p.actions?.find((a) => a.type === 'cancelLine')?.lineNo;
    const line = no ? base.lines[String(no)] : undefined;
    const kept = lines.filter((l) => l !== line).map((l) => shortMachine(l.description));
    return `Cancels the ${line ? shortMachine(line.description) : 'line'}${kept.length ? `, keeps the ${kept.join(' + ')}` : ''}, with a credit note.`;
  }
  return '';
}

/** Field-level changes between two hire snapshots, worded for the FieldDiff. */
function snapshotChanges(a: Snapshot, b: Snapshot): FieldChange[] {
  const out: FieldChange[] = [];
  if (a.deliveryDate !== b.deliveryDate) out.push({ field: 'Delivery', from: fmtDate(a.deliveryDate), to: fmtDate(b.deliveryDate) });
  if (a.durationDays !== b.durationDays) out.push({ field: 'Duration', from: `${a.durationDays / 7} wks`, to: `${b.durationDays / 7} wks` });
  for (const no of Object.keys(b.lines)) {
    const x = a.lines[no];
    const y = b.lines[no]!;
    if (!x) continue;
    const name = y.kind.charAt(0).toUpperCase() + y.kind.slice(1);
    const label = (l: typeof y) => `${shortMachine(l.description)} · ${l.fleetNo ?? ''} · ${gbp0(l.weeklyRatePence)}/wk`;
    if (x.fleetNo !== y.fleetNo || x.weeklyRatePence !== y.weeklyRatePence || x.description !== y.description) out.push({ field: name, from: label(x), to: label(y) });
    else if (x.status !== y.status) out.push({ field: name, from: x.status.replace('_', ' '), to: y.status.replace('_', ' ') });
  }
  if (Number(a.discountPct) !== Number(b.discountPct)) out.push({ field: 'Discount', from: `${Number(a.discountPct)}%`, to: `${Number(b.discountPct)}%` });
  return out;
}

// ---------------------------------------------------------------- desks

function deriveStatus(raw: DeskStatus, runtime: RuntimeView): DeskStatus {
  // The dead process could not update its desks: show the run as lost until the next process boots.
  if (runtime.workerDown && (raw === 'running' || raw === 'queued')) return 'recovering';
  return raw;
}

function buildDesk(h: HireRow, lines: LineView[], desk: typeof s.desks.$inferSelect | undefined, drafts: DraftView[], signals: SignalView[], runtime: RuntimeView): DeskView {
  const mine = signals.filter((x) => x.hireRef === h.ref && x.type !== 'evidence');
  const status = deriveStatus((desk?.runState ?? 'idle') as DeskStatus, runtime);
  const leaseEndsAt = status === 'recovering' ? runtime.leaseEndsAt : null;
  return {
    ref: h.ref,
    version: h.version,
    customer: h.customer,
    site: h.site,
    siteArea: h.siteArea,
    status,
    step: desk?.currentStep ?? null,
    activeRun: shortRun(desk?.activeRunId),
    lines,
    awaiting: drafts.filter((d) => d.hireRef === h.ref && (d.status === 'pending' || d.status === 'stale')).map((d) => d.ref),
    queued: mine.filter((x) => x.delivery === 'queued' && !x.pickedUp).reverse(),
    lastSignal: mine[0] ?? null,
    leaseEndsAt,
  };
}

/** Rack order: the hero first, then by hire ref (stable, so FLIP movement reads as state change only). */
const rackOrder = (a: { ref: string }, b: { ref: string }) => (a.ref === 'NH-5520' ? -1 : b.ref === 'NH-5520' ? 1 : b.ref.localeCompare(a.ref));

export function londonMidnight(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const hoursIntoDay = get('hour') + now.getUTCMinutes() / 60;
  return new Date(now.getTime() - hoursIntoDay * 3_600_000 - now.getUTCSeconds() * 1000);
}

export async function getBoard(opts: { desk?: string | null } = {}): Promise<BoardView> {
  const [{ hires, lines, desks }, runtime, scenario] = await Promise.all([loadHires(), getRuntime(), getScenario()]);
  const [drafts, signals] = await Promise.all([loadDrafts(), loadSignals({ limit: 120 })]);
  const deskViews = hires.map((h) => buildDesk(h, lines.get(h.id) ?? [], desks.get(h.id), drafts, signals, runtime)).sort(rackOrder);
  const waiting = drafts
    .filter((d) => d.status === 'pending' || d.status === 'stale')
    .sort((a, b) => (a.status === 'stale' ? 0 : 1) - (b.status === 'stale' ? 0 : 1) || b.createdAt.localeCompare(a.createdAt));
  const midnight = londonMidnight();
  const detail = opts.desk ? await getDeskDetail(opts.desk, { runtime, drafts, signals }) : null;
  return {
    now: new Date().toISOString(),
    desks: deskViews,
    waiting,
    signals: signals.slice(0, 60),
    signalsToday: signals.filter((x) => x.type !== 'evidence' && x.at >= midnight.toISOString()).length,
    scenario,
    runtime,
    detail,
  };
}

// ---------------------------------------------------------------- desk detail

export async function getDeskDetail(ref: string, pre: { runtime?: RuntimeView; drafts?: DraftView[]; signals?: SignalView[] } = {}): Promise<DeskDetail | null> {
  const { hires, lines, desks } = await loadHires(ref);
  const h = hires[0];
  if (!h) return null;
  const runtime = pre.runtime ?? (await getRuntime());
  const drafts = (pre.drafts ?? (await loadDrafts([h.id]))).filter((d) => d.hireRef === ref);
  const signals = (pre.signals ?? (await loadSignals({ hireIds: [h.id], limit: 100 }))).filter((x) => x.hireRef === ref);
  const desk = desks.get(h.id);
  const [attempts, outbox, credits, steps, runs, contact, waiver, threadLabels, memory] = await Promise.all([
    db().select().from(s.actionAttempts).where(eq(s.actionAttempts.hireId, h.id)).orderBy(desc(s.actionAttempts.createdAt)).limit(40),
    db().select().from(s.outbox).where(eq(s.outbox.hireId, h.id)).orderBy(asc(s.outbox.createdAt)),
    db().select().from(s.creditNotes).where(eq(s.creditNotes.hireId, h.id)).orderBy(asc(s.creditNotes.createdAt)),
    db().select().from(s.deskSteps).where(and(eq(s.deskSteps.hireId, h.id), eq(s.deskSteps.kind, 'tool'))).orderBy(desc(s.deskSteps.createdAt)).limit(14),
    db().select().from(s.deskRuns).where(eq(s.deskRuns.hireId, h.id)).orderBy(asc(s.deskRuns.startedAt)),
    h.siteContactId ? db().select().from(s.contacts).where(eq(s.contacts.id, h.siteContactId)) : Promise.resolve([]),
    db().select().from(s.documents).where(and(eq(s.documents.hireId, h.id), eq(s.documents.kind, 'damage_waiver'))).orderBy(desc(s.documents.createdAt)).limit(1),
    db().select({ id: s.emailThreads.id, label: s.emailThreads.label }).from(s.emailThreads).where(eq(s.emailThreads.hireId, h.id)),
    readWorkingMemory(desk?.mastraThreadId),
  ]);
  const hireLines = lines.get(h.id) ?? [];
  const price = priceHire({
    lines: hireLines.map((l) => ({ lineNo: l.lineNo, weeklyRatePence: l.weeklyRatePence, quantity: 1, status: l.status })),
    durationDays: h.durationDays,
    discountPct: Number(h.discountPct),
    damageWaiver: h.damageWaiver,
    transportPence: h.transportPence,
    waiverRatePct: Number(h.waiverRatePct),
  });
  const labelOf = new Map(threadLabels.map((t) => [t.id, t.label]));
  const fenceOrdinal = new Map<string, number>();
  const runViews: RunView[] = runs.map((r) => {
    const n = (fenceOrdinal.get(r.runId) ?? 0) + 1;
    fenceOrdinal.set(r.runId, n);
    return { runId: r.runId, short: shortRun(r.runId)!, fence: n, state: r.state, startedAt: r.startedAt.toISOString(), endedAt: r.endedAt?.toISOString() ?? null, backend: r.backend };
  });
  return {
    desk: buildDesk(h, hireLines, desk, drafts, signals, runtime),
    facts: {
      deliveryDate: h.deliveryDate,
      offHireDate: addDays(h.deliveryDate, h.durationDays),
      weeks: h.durationDays / 7,
      deliverySlot: h.deliverySlot,
      poNumber: h.poNumber,
      invoiceAddress: h.invoiceAddress,
      discountPct: Number(h.discountPct),
      waiverRatePct: Number(h.waiverRatePct),
      waiverSigned: Boolean(waiver[0]?.signed),
      damageWaiver: h.damageWaiver,
      transportPence: h.transportPence,
      netPence: price.netPence,
      waiverPence: price.waiverPence,
      subtotalPence: price.subtotalPence,
      status: h.status,
      updatedBy: h.updatedBy,
    },
    contact: contact[0] ? { name: contact[0].name, email: contact[0].email } : null,
    drafts,
    loops: memory,
    ledger: attempts.map((a) => ({ id: a.id, tool: a.tool, status: a.status, actionKey: a.actionKey, run: shortRun(a.runId), note: a.note, at: a.createdAt.toISOString() })),
    emails: outbox.map((o) => ({ id: o.id, subject: o.subject, to: o.toAddrs.map((e) => (contact[0]?.email === e ? contact[0].name : e)).join(', '), thread: o.threadId ? (labelOf.get(o.threadId) ?? null) : null, idempotencyKey: o.idempotencyKey, at: o.createdAt.toISOString() })),
    creditNotes: credits.map((c) => ({ ref: c.ref, amountPence: c.amountPence, reason: c.reason, at: c.createdAt.toISOString() })),
    steps: steps.reverse().map((x) => ({ id: x.id, at: x.createdAt.toISOString(), text: x.text, status: x.status, run: shortRun(x.runId), kind: x.kind })),
    runs: runViews,
    signals,
    schedule: { id: desk?.sweepScheduleId ?? null, ...nextSweep() },
  };
}

function nextSweep() {
  const now = new Date();
  const hm = Number(fmtTime(now).replace(':', ''));
  const day = new Date(now.getTime() + (hm >= 700 ? 86_400_000 : 0));
  return { cron: '0 7 * * *', label: '07:00 pre-delivery sweep', next: `${fmtDayOf(day)}, 07:00`, ifActive: 'persist', ifIdle: 'wake' };
}
const fmtDayOf = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London' }).replace(',', '');

/** Open loops from the desk thread's working memory (Mastra storage, read-only). */
async function readWorkingMemory(threadId?: string): Promise<LoopView[]> {
  if (!threadId) return [];
  const rows = (await db()
    .execute(sql`select metadata ->> 'workingMemory' as wm from mastra.mastra_threads where id = ${threadId}`)
    .catch(() => [])) as unknown as Array<{ wm: string | null }>;
  const wm = rows[0]?.wm ?? '';
  return wm
    .split('\n')
    .map((l) => l.trim().match(/^- \[(open|decided|closed)\] ([\w-]+): (.+)$/))
    .filter((m): m is RegExpMatchArray => Boolean(m))
    .map((m) => ({ status: m[1] as LoopView['status'], key: m[2]!, text: m[3]! }));
}

// ---------------------------------------------------------------- other pages

export async function getHireRegister() {
  const [{ hires, lines, desks }, runtime, drafts] = await Promise.all([loadHires(), getRuntime(), loadDrafts()]);
  const signals = await loadSignals({ limit: 120 });
  return hires
    .map((h) => ({
      desk: buildDesk(h, lines.get(h.id) ?? [], desks.get(h.id), drafts, signals, runtime),
      deliveryDate: h.deliveryDate,
      offHireDate: addDays(h.deliveryDate, h.durationDays),
      po: h.poNumber,
      status: h.status,
      totalPence: h.totalPence,
      updatedAt: h.updatedAt.toISOString(),
      versionNote: '',
    }))
    .sort((a, b) => rackOrder(a.desk, b.desk));
}

export async function getApprovalsPage() {
  const drafts = await loadDrafts();
  const waiting = drafts
    .filter((d) => d.status === 'pending' || d.status === 'stale')
    .sort((a, b) => (a.status === 'stale' ? 0 : 1) - (b.status === 'stale' ? 0 : 1) || a.hireRef.localeCompare(b.hireRef) || b.createdAt.localeCompare(a.createdAt));
  const midnight = londonMidnight().toISOString();
  const filed = drafts
    .filter((d) => ['approved', 'applied', 'rejected', 'superseded'].includes(d.status) && (d.decidedAt ?? d.createdAt) >= midnight && d.decisions.length)
    .sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''));
  return { waiting, filed, all: drafts };
}

export async function getDraft(ref: string) {
  const drafts = await loadDrafts();
  const d = drafts.find((x) => x.ref === ref);
  if (!d) return null;
  const chain = drafts.filter((x) => x.hireRef === d.hireRef && (x.intent === d.intent || x.ref === d.supersedesRef || x.supersedesRef === d.ref));
  return { draft: d, chain, newer: d.supersededByRef ? (drafts.find((x) => x.ref === d.supersededByRef) ?? null) : null };
}

export async function getSignalsPage() {
  const [signals, hires] = await Promise.all([loadSignals({ limit: 300 }), db().select({ ref: s.hires.ref }).from(s.hires)]);
  return { signals, hires: hires.map((h) => h.ref).sort(), midnight: londonMidnight().toISOString() };
}

export { formatDiff };

/** What the simulator's signal panel needs per hire: lines and email threads with their contacts. */
export async function getSimHires() {
  const [hires, lines, threads] = await Promise.all([
    db().select().from(s.hires).orderBy(asc(s.hires.ref)),
    db().select().from(s.hireLines).orderBy(asc(s.hireLines.lineNo)),
    db()
      .select({ hireId: s.emailThreads.hireId, label: s.emailThreads.label, email: s.contacts.email, name: s.contacts.name })
      .from(s.emailThreads)
      .innerJoin(s.contacts, eq(s.contacts.id, s.emailThreads.contactId))
      .orderBy(asc(s.emailThreads.label)),
  ]);
  return hires
    .map((h) => ({
      ref: h.ref,
      version: h.version,
      deliveryDate: h.deliveryDate,
      lines: lines.filter((l) => l.hireId === h.id).map((l) => ({ lineNo: l.lineNo, description: l.description, fleetNo: l.fleetNo, status: l.status })),
      threads: threads.filter((t) => t.hireId === h.id).map((t) => ({ label: t.label, email: t.email, name: t.name })),
    }))
    .sort((a, b) => rackOrder(a, b));
}
