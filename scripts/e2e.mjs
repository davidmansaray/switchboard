#!/usr/bin/env node
/**
 * `pnpm e2e`: for each SIGNAL_BACKEND (harness, app), reset a dedicated database, start the
 * production builds on their own ports (web 3243, agent 4243) under the dev supervisor (so the
 * crash beat's killed worker comes back), run the Playwright hero story, and stop the stack.
 * Run `pnpm build` first. Pass a backend to run one: `pnpm e2e app`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
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
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: 'localhost', port: Number(port) });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(true));
  });
}

async function requireFreePorts(waitMs = 0) {
  const deadline = Date.now() + waitMs;
  do {
    if (!(await portOpen(WEB)) && !(await portOpen(AGENT))) return;
    if (Date.now() >= deadline) break;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error(`E2E ports ${WEB}/${AGENT} are still in use; refusing to reset or reuse another stack`);
}

async function stopStack(stack) {
  const signal = (name) => {
    try { process.kill(-stack.pid, name); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(-stack.pid, 0); } catch { break; }
    await sleep(100);
  }
  signal('SIGKILL');
  await requireFreePorts(10_000);
}

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
  await requireFreePorts();
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
    const status = await fetch(`http://localhost:${AGENT}/status`).then((r) => r.json());
    if (status.backend !== backend) throw new Error(`expected ${backend} agent, got ${status.backend}`);
    await up(`http://localhost:${WEB}/api/health`);
    execFileSync('pnpm', ['exec', 'playwright', 'test', '--output', `test-results/${backend}`], { cwd: root, env: { ...env, E2E_BASE_URL: `http://localhost:${WEB}` }, stdio: 'inherit' });
  } catch (e) {
    failed++;
    console.error(`e2e failed on ${backend}: ${e.message}`);
    console.error(log.split('\n').slice(-60).join('\n'));
  } finally {
    try {
      await stopStack(stack);
    } finally {
      mkdirSync(resolve(root, 'test-results'), { recursive: true });
      writeFileSync(resolve(root, `test-results/stack-${backend}.log`), log);
    }
  }
}
process.exit(failed ? 1 : 0);
