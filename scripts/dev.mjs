#!/usr/bin/env node
/**
 * `pnpm dev`: start the web app (Next.js, :3103) and the agent service (Mastra, :4103) with the
 * repo-root `.env.local` loaded into both, and supervise the agent the way systemd does in
 * production: when it dies (the simulator's "Crash worker" really SIGKILLs it), start it again.
 *
 *   pnpm dev            web + agent (mastra dev, hot reload)
 *   pnpm dev --built    web + the built agent (.mastra/output)
 *   pnpm dev --prod     next start + the built agent: production builds (run `pnpm build` first)
 *
 * Ports and database come from the environment (WEB_PORT, AGENT_PORT, DATABASE_URL), so the e2e
 * runner can start a second stack beside the dev one.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const built = process.argv.includes('--built');
/** --prod: `next start` (needs `pnpm build`) and the built agent: what e2e runs against. */
const prod = process.argv.includes('--prod');

/** Minimal dotenv: KEY=value lines, # comments, optional quotes. Existing env wins. */
function loadEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const fileEnv = { ...loadEnvFile(resolve(root, '.env')), ...loadEnvFile(resolve(root, '.env.local')) };
const env = { ...fileEnv, ...process.env };
if (!env.DATABASE_URL) {
  console.error('[dev] DATABASE_URL is not set: copy .env.example to .env.local first.');
  process.exit(1);
}
const agentPort = env.AGENT_PORT ?? env.PORT ?? '4103';
const webPort = env.WEB_PORT ?? '3103';
env.MASTRA_SERVER_URL ??= `http://localhost:${agentPort}`;

const children = new Set();
let stopping = false;
const tag = (name, color) => (line) => process.stdout.write(`\x1b[${color}m[${name}]\x1b[0m ${line}\n`);

function run(name, color, cmd, args, opts) {
  const print = tag(name, color);
  const log = (line) => {
    print(line);
    opts.onLine?.(line);
  };
  const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  const pipe = (s) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      lines.forEach(log);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (stopping) return;
    log(`exited (${signal ?? code})`);
    opts.onExit?.(code, signal);
  });
  return child;
}

function startWeb() {
  run('web', 36, 'pnpm', ['exec', 'next', prod ? 'start' : 'dev', '--port', webPort], {
    cwd: resolve(root, 'apps/web'),
    env: { ...env, PORT: webPort },
    onExit: () => setTimeout(() => !stopping && startWeb(), 2000),
  });
}

let restarts = 0;
let agentChild = null;
let healthTimer = null;
let wasUp = false;
function startAgent() {
  const cwd = resolve(root, 'apps/agent');
  const agentEnv = { ...env, PORT: agentPort };
  const [cmd, args] = built || prod ? ['node', [env.AGENT_ENTRY ?? '.mastra/output/index.mjs']] : ['pnpm', ['exec', 'mastra', 'dev', '--dir', 'src/mastra']];
  agentChild = run('agent', 33, cmd, args, {
    cwd,
    env: agentEnv,
    onLine: (line) => {
      // The server announces a demo crash just before it SIGKILLs itself: restart without waiting for health checks.
      if (line.includes('[crash] killing agent process')) setTimeout(() => restartAgent('crash'), 300);
      // mastra dev is hot-reloading after a file change: don't mistake the gap for a dead server.
      if (/Preparing development environment|Restarting|bundle/i.test(line)) wasUp = false;
    },
    onExit: () => {
      clearInterval(healthTimer);
      // Supervisor: like systemd Restart=always in production. Back off if it keeps dying at boot.
      restarts++;
      const wait = Math.min(1000 * restarts, 5000);
      tag('dev', 35)(`agent stopped; restarting in ${wait} ms (durable runs recover once the 30 s lease lapses)`);
      setTimeout(() => {
        if (!stopping) startAgent();
      }, wait);
      setTimeout(() => (restarts = Math.max(0, restarts - 1)), 60_000);
    },
  });
  // `mastra dev` keeps running when its server child dies (the crash demo SIGKILLs the server),
  // so watch the server itself: once it has been up, three failed health checks mean it is gone.
  wasUp = false;
  let fails = 0;
  clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    const ok = await fetch(`http://localhost:${agentPort}/health`, { signal: AbortSignal.timeout(1500) })
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) {
      wasUp = true;
      fails = 0;
      return;
    }
    if (!wasUp || ++fails < 15) return;
    restartAgent('health checks failing');
  }, 1000);
}

/** `mastra dev` outlives its server child: stop the whole agent process so onExit starts a fresh one. */
function restartAgent(why) {
  clearInterval(healthTimer);
  const dying = agentChild;
  if (!dying || dying.exitCode !== null || dying.signalCode !== null) return;
  tag('dev', 35)(`agent server is gone (${why}); restarting it`);
  dying.kill('SIGTERM');
  setTimeout(() => {
    if (dying.exitCode === null && dying.signalCode === null) dying.kill('SIGKILL');
  }, 3000);
}

function stop() {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

tag('dev', 35)(`web :${webPort} · agent :${agentPort}${built ? ' (built)' : ''} · backend=${env.SIGNAL_BACKEND ?? 'harness'} · llm=${env.LLM_MODE ?? 'scripted'}`);
startWeb();
startAgent();
