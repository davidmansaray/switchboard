/**
 * Scenario runner CLI, the same functions the simulator rail calls.
 *
 *   pnpm scenario:reset            back to the seeded morning
 *   pnpm scenario:beat             play the next beat
 *   pnpm scenario:beat 5           play beat 5 (must be the next one)
 *   pnpm scenario:beat all         play every remaining beat
 *   pnpm scenario:state            show progress
 *
 * Talks to the running agent service (MASTRA_SERVER_URL), so the browser sees every beat live.
 * With --local it boots an in-process Switchboard against DATABASE_URL instead (no server needed).
 */
import { HERO_BEATS } from '@switchboard/core';
import { loadEnv } from '@switchboard/db';

await loadEnv();
const [cmd = 'state', arg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const base = process.env.MASTRA_SERVER_URL ?? 'http://localhost:4103';
const headers = { 'content-type': 'application/json', ...(process.env.INTERNAL_API_TOKEN ? { authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` } : {}) };

type Runtime = { scenario: { next: number | null; busy: boolean; beats: Array<{ n: number; status: string; error: string | null }> } };

async function remote(): Promise<boolean> {
  return fetch(`${base}/status`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok)
    .catch(() => false);
}

async function http<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = (await r.json()) as T & { error?: string; message?: string };
  if (!r.ok) throw new Error(`${path}: ${j.message ?? j.error ?? r.status}`);
  return j;
}

function show(st: Runtime['scenario']) {
  for (const b of HERO_BEATS) {
    const row = st.beats.find((x) => x.n === b.n);
    console.log(`${String(b.n).padStart(2)} ${(row?.status ?? '·').padEnd(8)} ${b.title}${row?.error ? `  (${row.error})` : ''}`);
  }
  console.log(st.next ? `next: beat ${st.next}` : 'all beats played');
}

const local = process.argv.includes('--local');
if (!local) {
  // The agent may still be starting (mastra dev bundles first): wait for it rather than racing it in-process.
  for (let i = 0; i < 60 && !(await remote()); i++) {
    if (i === 0) console.log(`waiting for the agent at ${base} (pass --local to run in-process instead)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!local && (await remote())) {
  const state = async () => (await http<Runtime>('/internal/runtime')).scenario;
  const waitDone = async () => {
    for (;;) {
      const st = await state().catch(() => null); // the crash beat restarts the agent under us
      if (st && !st.busy) return st;
      await new Promise((r) => setTimeout(r, 500));
    }
  };
  if (cmd === 'reset') {
    await http('/internal/scenario/reset', {});
    console.log('reset to the seeded morning');
  } else if (cmd === 'beat') {
    const plan = arg === 'all' ? HERO_BEATS.map((b) => b.n) : [arg ? Number(arg) : (await state()).next];
    for (const n of plan) {
      const st = await state();
      if (n === null || n === undefined || st.next === null) break;
      if (arg === 'all' && n < st.next) continue;
      console.log(`playing beat ${n}: ${HERO_BEATS[n - 1]!.title}`);
      await http('/internal/scenario/beat', { n });
      await waitDone();
    }
    show(await state());
  } else show(await state());
} else {
  if (!local) {
    console.error(`agent not reachable at ${base}; start it with \`pnpm dev\` or pass --local`);
    process.exit(1);
  }
  console.log('running in-process (--local)');
  process.env.SWITCHBOARD_SKIP_BOOT = 'true';
  const { configFromEnv } = await import('../src/config');
  const { createSwitchboard } = await import('../src/runtime');
  const sb = createSwitchboard(configFromEnv(), { port: 4990 });
  await sb.start({ workers: true, recover: true });
  try {
    if (cmd === 'reset') await sb.scenario.reset();
    else if (cmd === 'beat') {
      const all = arg === 'all';
      for (;;) {
        const st = await sb.scenario.state();
        const n = all || !arg ? st.next : Number(arg);
        if (!n) break;
        console.log(`playing beat ${n}: ${HERO_BEATS[n - 1]!.title}`);
        await sb.scenario.play(n);
        while ((await sb.scenario.state()).busy) await new Promise((r) => setTimeout(r, 300));
        if (!all) break;
      }
    }
    const st = await sb.scenario.state();
    show({ ...st, beats: st.beats.map((b) => ({ n: b.n, status: b.status, error: b.error })) });
  } finally {
    await sb.stop();
  }
}
