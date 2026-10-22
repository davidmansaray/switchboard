import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from './client';
import * as s from './schema';

export type HireView = s.Hire & { lines: s.HireLine[] };

export async function getHireByRef(db: DbOrTx, ref: string): Promise<HireView | undefined> {
  const [hire] = await db.select().from(s.hires).where(eq(s.hires.ref, ref));
  return hire ? withLines(db, hire) : undefined;
}

export async function getHireById(db: DbOrTx, id: string, opts: { forUpdate?: boolean } = {}): Promise<HireView | undefined> {
  const q = db.select().from(s.hires).where(eq(s.hires.id, id));
  const [hire] = opts.forUpdate ? await q.for('update') : await q;
  return hire ? withLines(db, hire) : undefined;
}

async function withLines(db: DbOrTx, hire: s.Hire): Promise<HireView> {
  const lines = await db.select().from(s.hireLines).where(eq(s.hireLines.hireId, hire.id)).orderBy(asc(s.hireLines.lineNo));
  return { ...hire, lines };
}

export async function getVersion(db: DbOrTx, hireId: string, version: number) {
  const [row] = await db
    .select()
    .from(s.hireVersions)
    .where(and(eq(s.hireVersions.hireId, hireId), eq(s.hireVersions.version, version)));
  return row;
}

export async function listVersions(db: DbOrTx, hireId: string) {
  return db.select().from(s.hireVersions).where(eq(s.hireVersions.hireId, hireId)).orderBy(asc(s.hireVersions.version));
}

export async function getDeskByHire(db: DbOrTx, hireId: string) {
  const [d] = await db.select().from(s.desks).where(eq(s.desks.hireId, hireId));
  return d;
}

export async function getDeskByThread(db: DbOrTx, threadId: string) {
  const [d] = await db.select().from(s.desks).where(eq(s.desks.mastraThreadId, threadId));
  return d;
}

export async function getDraftByRef(db: DbOrTx, ref: string) {
  const [d] = await db.select().from(s.drafts).where(eq(s.drafts.ref, ref));
  return d;
}

/** Drafts for a hire, oldest first, with their supersedes links (D-7 → D-8). */
export async function getDraftChain(db: DbOrTx, hireId: string) {
  return db.select().from(s.drafts).where(eq(s.drafts.hireId, hireId)).orderBy(asc(s.drafts.createdAt));
}

export async function recordEvent(
  db: DbOrTx,
  e: { hireId: string; type: string; payload: Record<string, unknown>; source: s.DbEvent['source']; actor?: string; dedupeKey?: string },
): Promise<{ event: s.DbEvent; duplicate: boolean }> {
  const [row] = await db
    .insert(s.events)
    .values({ ...e, actor: e.actor ?? null, dedupeKey: e.dedupeKey ?? null })
    .onConflictDoNothing({ target: s.events.dedupeKey })
    .returning();
  if (row) return { event: row, duplicate: false };
  const [existing] = await db.select().from(s.events).where(eq(s.events.dedupeKey, e.dedupeKey!));
  return { event: existing!, duplicate: true };
}

export async function markEventsProcessed(db: DbOrTx, eventIds: string[], runId?: string | null) {
  if (!eventIds.length) return;
  await db
    .update(s.events)
    .set({ processedAt: sql`coalesce(${s.events.processedAt}, now())`, runId: runId ?? null })
    .where(inArray(s.events.id, eventIds));
}

export async function unprocessedEvents(db: DbOrTx, hireId?: string) {
  return db
    .select()
    .from(s.events)
    .where(and(isNull(s.events.processedAt), hireId ? eq(s.events.hireId, hireId) : undefined, sql`${s.events.source} <> 'agent'`))
    .orderBy(asc(s.events.createdAt));
}

export async function listSignals(db: DbOrTx, hireId: string, limit = 100) {
  return db.select().from(s.signalsLog).where(eq(s.signalsLog.hireId, hireId)).orderBy(desc(s.signalsLog.createdAt)).limit(limit);
}

export async function setDeskState(
  db: DbOrTx,
  hireId: string,
  patch: Partial<Pick<s.Desk, 'runState' | 'activeRunId' | 'currentStep' | 'lastSignalAt' | 'sweepScheduleId'>>,
) {
  await db
    .update(s.desks)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(s.desks.hireId, hireId));
}
