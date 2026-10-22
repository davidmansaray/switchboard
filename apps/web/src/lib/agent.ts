import 'server-only';

/** Web → agent service (Mastra server) internal routes, with the shared bearer token. */
export class AgentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function agent<T = unknown>(path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<T> {
  const base = process.env.MASTRA_SERVER_URL ?? 'http://localhost:4103';
  const token = process.env.INTERNAL_API_TOKEN;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch {
    throw new AgentError(503, 'The agent service is not answering (restarting after a crash?). Try again in a few seconds.');
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) throw new AgentError(res.status, json.message ?? json.error ?? `agent ${res.status}`);
  return json;
}

export function errorResponse(e: unknown) {
  if (e instanceof AgentError) return Response.json({ error: e.message }, { status: e.status });
  return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}
