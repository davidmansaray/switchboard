/**
 * A desk worker in its own process, for crash/fencing tests.
 *   tsx worker.ts <crash|hang> <beat>
 * crash: SIGKILL itself right after applyPricing commits.
 * hang:  stall inside applyPricing (before writing) for HANG_MS, then continue.
 */
import { loadEnv } from '@switchboard/db';
import { configFromEnv } from '../../src/config';
import { createSwitchboard } from '../../src/runtime';
import { beats } from '../../src/scenario/beats';

await loadEnv();
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/switchboard_showcase_test';
const [mode, beat] = process.argv.slice(2);
const config = { ...configFromEnv(process.env), databaseUrl: process.env.DATABASE_URL, mastraDatabaseUrl: process.env.DATABASE_URL, llmMode: 'scripted' as const, scriptedLatencyMs: 60, editDebounceMs: 100, internalApiToken: undefined };
const sb = createSwitchboard(config, { port: 4900 + Math.floor(Math.random() * 90) });
await sb.start({ workers: true });
if (mode === 'crash') sb.crash.arm('applyPricing');
if (mode === 'hang') sb.crash.armHang('applyPricing', Number(process.env.HANG_MS ?? 6000));
const run = beats(sb.services)[Number(beat) as 6];
const r = await run();
console.log(`[worker] beat ${beat} sent: ${JSON.stringify((r as { delivery?: unknown }).delivery)}`);
process.on('unhandledRejection', (e) => console.log('[worker] unhandled', String(e)));
// Stay alive until killed (crash) or long enough for the zombie to try its writes (hang).
setTimeout(() => process.exit(0), Number(process.env.WORKER_LIFETIME_MS ?? 60_000));
