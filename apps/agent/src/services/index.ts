import { formatDiff, keys, type DiffEntry } from '@switchboard/core';
import {
  getDraftByRef,
  getHireByRef,
  getVersion,
  indexEvidence,
  recordEvent,
  schema as s,
  withActor,
  type Db,
} from '@switchboard/db';
import { and, eq } from 'drizzle-orm';
import type { SignalRouter } from '../signals/adapter';

export class ServiceError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'FORBIDDEN' | 'INVALID',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Everything that can happen to a hire from outside the desk: customer email,
 * staff notes and edits, approvals, the sweep. Each one writes the source of
 * truth first, records an event, then hands the event to the signal router.
 * HTTP routes, the scenario runner and tests all call these.
 */
export function createServices(deps: { db: Db; router: SignalRouter }) {
  const { db, router } = deps;

  async function hireOrThrow(ref: string) {
    const h = await getHireByRef(db, ref);
    if (!h) throw new ServiceError('NOT_FOUND', `unknown hire ${ref}`);
    return h;
  }

  async function ingestEmail(input: { hireRef: string; threadLabel: string; from: string; subject: string; body: string; messageId?: string }) {
    const h = await hireOrThrow(input.hireRef);
    const messageId = input.messageId ?? `<${crypto.randomUUID()}@inbound.switchboard>`;
    const out = await withActor(db, `customer:${input.from}`, async (tx) => {
      const [thread] = await tx.select().from(s.emailThreads).where(and(eq(s.emailThreads.hireId, h.id), eq(s.emailThreads.label, input.threadLabel)));
      if (!thread) throw new ServiceError('NOT_FOUND', `no thread ${input.threadLabel} on ${h.ref}`);
      const [contact] = await tx.select().from(s.contacts).where(eq(s.contacts.email, input.from));
      const [email] = await tx
        .insert(s.emails)
        .values({ threadId: thread.id, hireId: h.id, messageId, direction: 'in', fromAddr: input.from, toAddrs: ['hiredesk@northgate-hire.co.uk'], subject: input.subject, body: input.body, contactId: contact?.id ?? null })
        .onConflictDoNothing({ target: s.emails.messageId })
        .returning();
      if (!email) return null; // inbound dedupe: same message id twice
      const evidenceId = await indexEvidence(tx, { hireId: h.id, sourceType: 'email', sourceId: email.id, content: `${input.subject}\n${input.body}` });
      const { event } = await recordEvent(tx, {
        hireId: h.id,
        type: 'email.received',
        source: 'customer',
        actor: input.from,
        dedupeKey: `email:${messageId}`,
        payload: { emailId: email.id, threadLabel: input.threadLabel, from: input.from, fromName: contact?.name ?? null, subject: input.subject, body: input.body, evidenceId },
      });
      return event;
    });
    if (!out) return { duplicate: true as const };
    return { duplicate: false as const, event: out, delivery: await router.route(out) };
  }

  async function addNote(input: { hireRef: string; authorId: string; body: string }) {
    const h = await hireOrThrow(input.hireRef);
    const mentions = [...input.body.matchAll(/@(\w+)/g)].map((m) => m[1]!.toLowerCase());
    const event = await withActor(db, input.authorId, async (tx) => {
      const [note] = await tx.insert(s.notes).values({ hireId: h.id, authorId: input.authorId, body: input.body, mentions }).returning();
      const evidenceId = await indexEvidence(tx, { hireId: h.id, sourceType: 'note', sourceId: note!.id, content: input.body });
      const { event } = await recordEvent(tx, {
        hireId: h.id,
        type: 'note.created',
        source: 'staff',
        actor: input.authorId,
        payload: { noteId: note!.id, author: input.authorId, body: input.body, mentions, evidenceId },
      });
      return event;
    });
    return { event, delivery: await router.route(event) };
  }

  /** Staff edit the hire directly (Jo). All changes in one transaction = one new version. */
  async function editHire(input: {
    hireRef: string;
    staffId: string;
    changes: { deliveryDate?: string; deliverySlot?: string; durationDays?: number };
    lines?: Array<{ lineNo: number; model?: string; description?: string; spec?: string; fleetNo?: string; weeklyRatePence?: number }>;
  }) {
    const h = await hireOrThrow(input.hireRef);
    const event = await withActor(db, input.staffId, async (tx) => {
      if (Object.keys(input.changes).length) await tx.update(s.hires).set(input.changes).where(eq(s.hires.id, h.id));
      for (const l of input.lines ?? []) {
        const { lineNo, ...patch } = l;
        await tx.update(s.hireLines).set(patch).where(and(eq(s.hireLines.hireId, h.id), eq(s.hireLines.lineNo, lineNo)));
      }
      const [after] = await tx.select({ version: s.hires.version }).from(s.hires).where(eq(s.hires.id, h.id));
      if (after!.version === h.version) return null;
      const v = await getVersion(tx, h.id, after!.version);
      const diff = (v?.diff ?? []) as DiffEntry[];
      const { event } = await recordEvent(tx, {
        hireId: h.id,
        type: 'hire.updated',
        source: 'staff',
        actor: input.staffId,
        payload: { fromVersion: h.version, toVersion: after!.version, fields: [...new Set(diff.map((d) => d.path))], summary: formatDiff(h.version, after!.version, diff), diff },
      });
      return event;
    });
    if (!event) return { changed: false as const };
    return { changed: true as const, event, delivery: await router.route(event) };
  }

  async function setLineStatus(input: { hireRef: string; staffId: string; lineNo: number; status: 'booked' | 'on_hire' | 'cancelled' }) {
    const h = await hireOrThrow(input.hireRef);
    const line = h.lines.find((l) => l.lineNo === input.lineNo);
    if (!line) throw new ServiceError('NOT_FOUND', `no line ${input.lineNo}`);
    if (line.status === input.status) return { changed: false as const };
    const event = await withActor(db, input.staffId, async (tx) => {
      await tx.update(s.hireLines).set({ status: input.status }).where(eq(s.hireLines.id, line.id));
      const [after] = await tx.select({ version: s.hires.version }).from(s.hires).where(eq(s.hires.id, h.id));
      const [staff] = await tx.select().from(s.staff).where(eq(s.staff.id, input.staffId));
      const summary = `${staff?.name ?? input.staffId} set line ${input.lineNo} (${line.model}) ${line.status} → ${input.status} directly.`;
      const evidenceId = await indexEvidence(tx, { hireId: h.id, sourceType: 'note', sourceId: crypto.randomUUID(), content: summary });
      const { event } = await recordEvent(tx, {
        hireId: h.id,
        type: 'status.changed',
        source: 'staff',
        actor: input.staffId,
        payload: { lineNo: input.lineNo, from: line.status, to: input.status, toVersion: after!.version, summary, evidenceId },
      });
      return event;
    });
    return { changed: true as const, event, delivery: await router.route(event) };
  }

  /**
   * An approver decides a draft. The approval is a row (survives restarts) and then
   * a signal to the desk; the desk does the applying, through idempotent tools.
   * A double click is the same idempotency key, so it is one approval and one signal.
   */
  async function assertApprover(staffId: string) {
    const [staff] = await db.select().from(s.staff).where(eq(s.staff.id, staffId));
    if (!staff) throw new ServiceError('NOT_FOUND', `unknown staff ${staffId}`);
    if (staff.role !== 'approver') throw new ServiceError('FORBIDDEN', `${staff.name} is not an approver`);
    return staff;
  }

  async function decideApproval(input: { draftRef: string; staffId: string; decision: 'approved' | 'rejected'; note?: string; channel?: 'web' | 'mobile' }) {
    const [staff] = await db.select().from(s.staff).where(eq(s.staff.id, input.staffId));
    if (!staff) throw new ServiceError('NOT_FOUND', `unknown staff ${input.staffId}`);
    if (staff.role !== 'approver') throw new ServiceError('FORBIDDEN', `${staff.name} is not an approver`);
    const idem = keys.approval(input.draftRef, input.staffId);
    const res = await withActor(db, input.staffId, async (tx) => {
      const d = await getDraftByRef(tx, input.draftRef);
      if (!d) throw new ServiceError('NOT_FOUND', `unknown draft ${input.draftRef}`);
      const [hire] = await tx.select().from(s.hires).where(eq(s.hires.id, d.hireId)).for('update');
      const [appr] = await tx
        .insert(s.approvals)
        .values({ draftId: d.id, decidedBy: input.staffId, decision: input.decision, idempotencyKey: idem, hireVersionAtDecision: hire!.version, channel: input.channel ?? 'web', note: input.note ?? null })
        .onConflictDoNothing({ target: s.approvals.idempotencyKey })
        .returning();
      if (!appr) return { duplicate: true as const, draft: d };
      if (!['pending', 'stale'].includes(d.status)) throw new ServiceError('INVALID', `${d.ref} is ${d.status}`);
      const current = d.status === 'pending' && d.basedOnVersion === hire!.version;
      const status = input.decision === 'rejected' ? 'rejected' : current ? 'approved' : 'stale';
      await tx.update(s.drafts).set({ status, decidedAt: new Date() }).where(eq(s.drafts.id, d.id));
      const { event } = await recordEvent(tx, {
        hireId: d.hireId,
        type: 'approval.decided',
        source: 'staff',
        actor: input.staffId,
        dedupeKey: idem,
        payload: { approvalId: appr.id, draftRef: d.ref, decision: input.decision, decidedBy: input.staffId, basedOnVersion: d.basedOnVersion, hireVersion: hire!.version, applies: status === 'approved' },
      });
      return { duplicate: false as const, draft: { ...d, status }, event, hireRef: hire!.ref };
    });
    if (res.duplicate) return res;
    return { ...res, delivery: await router.route(res.event) };
  }

  async function fireSweep(hireRef: string) {
    const h = await hireOrThrow(hireRef);
    return router.backend.fireSweep(await router.target(h.id));
  }

  async function ensureSweeps() {
    const hires = await db.select().from(s.hires);
    for (const h of hires) {
      if (h.status === 'cancelled' || h.status === 'off_hire') continue;
      await router.backend.ensureSweep(await router.target(h.id));
    }
  }

  return { ingestEmail, addNote, editHire, setLineStatus, decideApproval, assertApprover, fireSweep, ensureSweeps };
}

export type Services = ReturnType<typeof createServices>;
