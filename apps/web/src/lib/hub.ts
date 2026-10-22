import 'server-only';
import postgres from 'postgres';

/**
 * One LISTEN connection per server process (DATABASE_URL_DIRECT: a session connection, never a
 * transaction pooler), fanned out to every open SSE stream. Triggers send small payloads
 * ({table, op, id, hireId}); clients refetch what they show.
 */
export type Change = { table: string; op: string; id: string | null; hireId: string | null };
type Hub = { subs: Set<(c: Change) => void>; ready: Promise<void> | null };

const g = globalThis as unknown as { __switchboardHub?: Hub };

export function hub(): Hub {
  if (g.__switchboardHub) return g.__switchboardHub;
  const h: Hub = { subs: new Set(), ready: null };
  g.__switchboardHub = h;
  return h;
}

function connect(h: Hub) {
  const url = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  h.ready = sql
    .listen(
      'switchboard',
      (payload) => {
        let c: Change;
        try {
          c = JSON.parse(payload) as Change;
        } catch {
          return;
        }
        for (const fn of h.subs) fn(c);
      },
      () => {},
    )
    .then(() => undefined)
    .catch((e: unknown) => {
      console.error('[hub] LISTEN failed', e);
      h.ready = null;
    });
}

export function subscribe(fn: (c: Change) => void): () => void {
  const h = hub();
  if (!h.ready) connect(h);
  h.subs.add(fn);
  return () => h.subs.delete(fn);
}
