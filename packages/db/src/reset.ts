import { sql } from 'drizzle-orm';
import { createDb } from './client';
import { runMigrations } from './migrate';
import { seed, type SeedResult } from './seed';

/**
 * Drop and rebuild both schemas, then seed. Dropping `mastra` too matters:
 * desk threads, working memory, schedules and durable-run snapshots live there.
 */
export async function resetDatabase(url?: string): Promise<SeedResult> {
  const h = createDb(url, { max: 1 });
  try {
    await h.db.execute(sql`drop schema if exists app cascade`);
    await h.db.execute(sql`drop schema if exists mastra cascade`);
    await h.db.execute(sql`create schema mastra`);
  } finally {
    await h.close();
  }
  await runMigrations(url);
  const h2 = createDb(url, { max: 2 });
  try {
    return await seed(h2.db);
  } finally {
    await h2.close();
  }
}

