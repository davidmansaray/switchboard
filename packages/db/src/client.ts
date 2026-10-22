import { sql as sqlTag } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import { databaseUrl } from './env';

export type Db = PostgresJsDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export type DbHandle = { db: Db; sql: postgres.Sql; close: () => Promise<void> };

/** Pool size per process. Production caps each app's role at 20 connections, shared by web + agent. */
function defaultPoolMax(): number {
  const n = Number(process.env.DB_POOL_MAX);
  return Number.isInteger(n) && n > 0 ? n : 10;
}

export function createDb(url = databaseUrl(), opts: { max?: number } = {}): DbHandle {
  const sql = postgres(url, { max: opts.max ?? defaultPoolMax(), onnotice: () => {}, prepare: false });
  const db = drizzle(sql, { schema, casing: undefined });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

let shared: DbHandle | undefined;
/** Process-wide handle (web route handlers, agent service). Tests create their own. */
export function getDb(): DbHandle {
  shared ??= createDb();
  return shared;
}

export async function pingDb(): Promise<void> {
  await getDb().sql`select 1`;
}

/**
 * Run `fn` in a transaction with `app.actor` set, so version triggers record
 * who changed the hire (staff id, `agent:desk`, `customer:<email>`).
 */
export async function withActor<T>(db: DbOrTx, actor: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sqlTag`select set_config('app.actor', ${actor}, true)`);
    return fn(tx);
  });
}
