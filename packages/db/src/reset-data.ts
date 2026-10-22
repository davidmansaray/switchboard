import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { seed, type SeedResult } from './seed';

/**
 * Scenario reset for a *running* system (the simulator's Reset): empty every app and Mastra
 * table in place (no DROP, so the live Mastra instance keeps its tables), restart the ref
 * sequences, and seed the morning again. The caller makes sure no desk run is active.
 */
export async function resetData(db: Db): Promise<SeedResult> {
  const tables = await db.execute<{ t: string }>(sql`
    select format('%I.%I', schemaname, tablename) as t from pg_tables
    where schemaname in ('app', 'mastra') and tablename <> '__migrations'`);
  const list = (tables as unknown as Array<{ t: string }>).map((r) => r.t);
  if (list.length) await db.execute(sql.raw(`truncate ${list.join(', ')} restart identity cascade`));
  await db.execute(sql`alter sequence app.draft_ref_seq restart with 7`);
  await db.execute(sql`alter sequence app.credit_note_ref_seq restart with 301`);
  return seed(db);
}
