#!/usr/bin/env node
/**
 * `pnpm e2e`: for each SIGNAL_BACKEND (harness, app), reset a dedicated database, start the
 * production builds on their own ports (web 3243, agent 4243) under the dev supervisor (so the
 * crash beat's killed worker comes back), run the Playwright hero story, and stop the stack.
 * Run `pnpm build` first. Pass a backend to run one: `pnpm e2e app`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv[2];
const backends = only ? [only] : ['harness', 'app'];
const DB = process.env.E2E_DATABASE_URL ?? 'postgres://localhost:5432/switchboard_showcase_e2e';
const WEB = process.env.E2E_WEB_PORT ?? '3243';
const AGENT = process.env.E2E_AGENT_PORT ?? '4243';

const exists = execFileSync('psql', ['-d', 'postgres', '-Atc', "select 1 from pg_database where datname = 'switchboard_showcase_e2e'"]).toString().trim();
if (!exists && DB.endsWith('/switchboard_showcase_e2e')) execFileSync('createdb', ['switchboard_showcase_e2e']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function up(url) {
  for (let i = 0; i < 120; i++) {
    if (await fetch(url, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false)) return;
    await sleep(1000);
  }
  throw new Error(`${url} did not come up`);
}

let failed = 0;
for (const backend of backends) {
  console.log(`\n=== e2e · SIGNAL_BACKEND=${backend} ===`);
  const env = {
    ...process.env,
    DATABASE_URL: DB,
    DATABASE_URL_DIRECT: DB,
    MASTRA_DATABASE_URL: DB,
    SIGNAL_BACKEND: backend,
    LLM_MODE: process.env.E2E_LLM_MODE ?? 'scripted',
    WEB_PORT: WEB,
    AGENT_PORT: AGENT,
    PORT: AGENT,
    MASTRA_SERVER_URL: `http://localhost:${AGENT}`,
    APP_URL: `http://localhost:${WEB}`,
    ALLOW_CRASH_ENDPOINT: 'true',
    ALLOW_SCENARIO_RESET: 'true',
    SCRIPTED_LATENCY_MS: process.env.SCRIPTED_LATENCY_MS ?? '250',
  };
  execFileSync('pnpm', ['--filter', '@switchboard/db', 'reset'], { cwd: root, env, stdio: 'inherit' });
  // Run the agent from a snapshot of the build, so a `mastra dev` rebundling .mastra/output can't change it mid-run.
  const snap = resolve(root, 'apps/agent/.mastra/e2e-output');
  execFileSync('rm', ['-rf', snap]);
  execFileSync('cp', ['-R', resolve(root, 'apps/agent/.mastra/output'), snap]);
  env.AGENT_ENTRY = '.mastra/e2e-output/index.mjs';
  const stack = spawn('node', ['scripts/dev.mjs', '--prod'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  stack.stdout.on('data', (d) => (log += d));
  stack.stderr.on('data', (d) => (log += d));
  try {
    await up(`http://localhost:${AGENT}/status`);
    await up(`http://localhost:${WEB}/api/health`);
    execFileSync('pnpm', ['exec', 'playwright', 'test'], { cwd: root, env: { ...env, E2E_BASE_URL: `http://localhost:${WEB}` }, stdio: 'inherit' });
  } catch (e) {
    failed++;
    console.error(`e2e failed on ${backend}: ${e.message}`);
    console.error(log.split('\n').slice(-60).join('\n'));
  } finally {
    try {
      process.kill(-stack.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    await sleep(2500);
    try {
      process.kill(-stack.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
process.exit(failed ? 1 : 0);
