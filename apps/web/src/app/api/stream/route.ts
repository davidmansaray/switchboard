import { subscribe, type Change } from '@/lib/hub';

export const dynamic = 'force-dynamic';

/** Server-sent events: every NOTIFY on the `switchboard` channel, named by table ("desks", "drafts"…). */
export async function GET(req: Request) {
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };
      send('ready', { at: new Date().toISOString() });
      const unsubscribe = subscribe((c: Change) => send('change', c));
      const beat = setInterval(() => send('ping', { at: Date.now() }), 15_000);
      cleanup = () => {
        clearInterval(beat);
        unsubscribe();
      };
      req.signal.addEventListener('abort', () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' },
  });
}
