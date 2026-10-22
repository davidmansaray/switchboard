/**
 * `pnpm scenario:record`: play the hero story in-process with LLM_MODE=record, writing every desk
 * model response to scenarios/recordings/ (keyed by a hash of the normalised prompt). Afterwards
 * `LLM_MODE=replay` (and `pnpm eval:replay`) serve those responses with no API key.
 *
 *   RECORD_SOURCE=live      record the real model (needs ANTHROPIC_API_KEY; ANTHROPIC_WORKSPACE_ID if
 *                           the key is not workspace-scoped)
 *   RECORD_SOURCE=scripted  record the scripted desk (checks the pipeline offline)
 *
 * Uses RECORD_DATABASE_URL (default: the test database), never the dev database.
 */
import { mkdirSync, readdirSync } from 'node:fs';
import { loadEnv, schema as s } from '@switchboard/db';
import { and, eq, inArray, sql } from 'drizzle-orm';

await loadEnv();
const url = process.env.RECORD_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/switchboard_showcase_test';
process.env.DATABASE_URL = url;
process.env.MASTRA_DATABASE_URL = url;
process.env.SWITCHBOARD_SKIP_BOOT = 'true';
const { resetDatabase } = await import('@switchboard/db/reset');
const { configFromEnv } = await import('../src/config');
const { createSwitchboard } = await import('../src/runtime');
const { beats } = await import('../src/scenario/beats');
const { defaultRecordingsDir } = await import('../src/models');

const dir = process.env.RECORDINGS_DIR || defaultRecordingsDir();
mkdirSync(dir, { recursive: true });
const before = new Set(readdirSync(dir, { withFileTypes: true }).filter((f) => f.isFile()).map((f) => f.name));
await resetDatabase(url);
const config = { ...configFromEnv(), databaseUrl: url, mastraDatabaseUrl: url, llmMode: 'record' as const, scriptedLatencyMs: 40, editDebounceMs: 150, internalApiToken: undefined, recordingsDir: dir };
console.log(`recording the hero story (source: ${config.recordSource}) into ${dir}`);
const sb = createSwitchboard(config, { port: 4991 });
await sb.start({ workers: true, recover: true });
try {
  const [hero] = await sb.db.db.select({ id: s.hires.id }).from(s.hires).where(eq(s.hires.ref, 'NH-5520'));
  const hireId = hero!.id;
  const b = beats(sb.services);
  const open = async (like: string) => {
    const [d] = await sb.db.db
      .select({ ref: s.drafts.ref })
      .from(s.drafts)
      .where(and(eq(s.drafts.hireId, hireId), inArray(s.drafts.status, ['pending', 'stale']), sql`${s.drafts.payload} ->> 'intent' like ${like}`))
      .orderBy(sql`${s.drafts.createdAt} desc`);
    return d!.ref;
  };
  for (const n of [1, 2, 3] as const) {
    await b[n]();
    if (n !== 3) await sb.router.idle(hireId, 120_000);
  }
  for (let i = 0; i < 600; i++) {
    const [d] = await sb.db.db.select().from(s.drafts).where(eq(s.drafts.ref, 'D-7'));
    if (d) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await b[4]();
  await sb.router.idle(hireId, 120_000);
  await sb.services.decideApproval({ draftRef: await open('discount'), staffId: 'gary', decision: 'approved', channel: 'mobile' });
  await sb.router.idle(hireId, 120_000);
  await sb.services.decideApproval({ draftRef: await open('discount'), staffId: 'gary', decision: 'approved', channel: 'mobile' });
  await sb.router.idle(hireId, 120_000);
  await b[7]();
  await new Promise((r) => setTimeout(r, 500));
  await sb.router.idle(hireId, 120_000);
  await b[8]();
  await sb.router.idle(hireId, 120_000);
  await sb.services.decideApproval({ draftRef: await open('cancel-line-%'), staffId: 'gary', decision: 'approved' });
  await sb.router.idle(hireId, 120_000);
  await new Promise((r) => setTimeout(r, 500)); // let the last recordings flush to disk
} finally {
  await sb.stop();
}
const after = readdirSync(dir).filter((f) => f.endsWith('.json'));
console.log(`${after.length} recordings in ${dir} (${after.filter((f) => !before.has(f)).length} new)`);
