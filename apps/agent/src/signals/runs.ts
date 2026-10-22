import { schema as s, type Db } from '@switchboard/db';
import { and, eq, lt, sql } from 'drizzle-orm';

/**
 * `app.desk_runs`: the runs the UI's RunTrace shows, one row per (run, ownership generation).
 * Harness runs read their generation from Mastra's run-fencing table (read-only); a recovered run
 * comes back with a higher generation, and the older generation is marked crashed (its worker
 * died: there is a crash in ops_log since it started) or fenced (superseded while still alive).
 */
export async function recordRunStart(db: Db, hireId: string, runId: string, backend: 'harness' | 'app'): Promise<void> {
  let generation = 1;
  if (backend === 'harness') {
    const rows = (await db
      .execute(sql`select generation from mastra.mastra_workflow_run_owners where "runId" = ${runId}`)
      .catch(() => [])) as unknown as Array<{ generation: string | number }>;
    if (rows[0]) generation = Number(rows[0].generation);
  }
  await db
    .insert(s.deskRuns)
    .values({ hireId, runId, generation, backend, state: 'running', pid: process.pid })
    .onConflictDoNothing();
  // Older generations of this run that never finished were taken over.
  const older = await db
    .select()
    .from(s.deskRuns)
    .where(and(eq(s.deskRuns.runId, runId), lt(s.deskRuns.generation, generation), eq(s.deskRuns.state, 'running')));
  for (const o of older) {
    const crashed = (await db.execute(sql`select 1 from app.ops_log where kind = 'crash' and created_at >= ${o.startedAt.toISOString()}::timestamptz limit 1`)) as unknown as unknown[];
    await db
      .update(s.deskRuns)
      .set({ state: crashed.length ? 'crashed' : 'fenced', endedAt: new Date() })
      .where(eq(s.deskRuns.id, o.id));
  }
}

export async function recordRunEnd(db: Db, runId: string, state: 'completed' | 'failed'): Promise<void> {
  await db
    .update(s.deskRuns)
    .set({ state, endedAt: new Date() })
    .where(and(eq(s.deskRuns.runId, runId), eq(s.deskRuns.state, 'running'), eq(s.deskRuns.pid, process.pid)));
}

/** On boot: runs that were running in a dead process are marked crashed (the harness recovers them as a new generation). */
export async function markOrphanedRuns(db: Db): Promise<number> {
  const rows = await db
    .update(s.deskRuns)
    .set({ state: 'crashed', endedAt: new Date() })
    .where(and(eq(s.deskRuns.state, 'running'), sql`${s.deskRuns.pid} is distinct from ${process.pid}`))
    .returning({ id: s.deskRuns.id });
  return rows.length;
}
