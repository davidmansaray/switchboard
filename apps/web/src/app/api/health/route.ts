import { pingDb } from '@switchboard/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const agentUrl = process.env.MASTRA_SERVER_URL ?? 'http://localhost:4103';
  const [db, agent] = await Promise.all([
    pingDb().then(() => 'ok' as const).catch((e: unknown) => `error: ${String(e)}`),
    fetch(`${agentUrl}/status`, { cache: 'no-store', signal: AbortSignal.timeout(2000) })
      .then((r) => (r.ok ? ('ok' as const) : `status ${r.status}`))
      .catch((e: unknown) => `unreachable: ${String(e)}`),
  ]);
  const ok = db === 'ok';
  return Response.json({ service: 'web', ok, db, agent }, { status: ok ? 200 : 503 });
}
