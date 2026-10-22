import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb } from './client';
import { loadEnv } from './env';

export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

export async function runMigrations(url?: string) {
  const h = createDb(url, { max: 1 });
  try {
    await migrate(h.db, { migrationsFolder: MIGRATIONS_DIR, migrationsSchema: 'app', migrationsTable: '__migrations' });
  } finally {
    await h.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await loadEnv();
  await runMigrations();
  console.log('migrations applied');
}
