// Live smoke test of the Mastra harness APIs Switchboard depends on.
// Runs against switchboard_showcase_test with a scripted (no-network) model.
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { PostgresStore } from '@mastra/pg';
import { Memory } from '@mastra/memory';
import { z } from 'zod';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/switchboard_showcase_test';
const log = (...a: unknown[]) => console.log('[smoke]', ...a);
let toolRuns = 0;
const slowTool = createTool({
  id: 'slow',
  description: 'slow tool',
  inputSchema: z.object({ ms: z.number() }),
  execute: async ({ ms }) => { toolRuns++; await new Promise(r => setTimeout(r, ms)); return { ok: true }; },
});

let calls = 0;
const model = new MastraLanguageModelV2Mock({
  doStream: async (opts) => {
    calls++;
    const last = JSON.stringify(opts.prompt.at(-1)).slice(0, 200);
    log('model call', calls, last);
    const hasToolResult = opts.prompt.at(-1)?.role === 'tool';
    const parts: any[] = [{ type: 'stream-start', warnings: [] }];
    if (!hasToolResult && last.includes('SLOW')) {
      parts.push({ type: 'tool-call', toolCallId: `c${calls}`, toolName: 'slow', input: JSON.stringify({ ms: 1500 }) });
      parts.push({ type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    } else {
      parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: `ack ${calls}` }, { type: 'text-end', id: 't' });
      parts.push({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    }
    return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
  },
});

const storage = new PostgresStore({ id: 'smoke', connectionString: url, schemaName: 'mastra' });
const desk = new Agent({
  id: 'desk', name: 'desk', instructions: 'test', model, tools: { slow: slowTool },
  memory: new Memory({ options: { workingMemory: { enabled: true, scope: 'thread', template: '# Open loops\n' } } }),
  durable: true,
});
const outcomes: unknown[] = [];
const mastra = new Mastra({
  agents: { desk }, storage, recovery: { durableAgents: 'auto' },
  schedules: { onFinish: async (ctx: any) => { outcomes.push(ctx.outcome); log('schedule onFinish', ctx.outcome); } },
});
await mastra.startWorkers();
const agent = mastra.getAgent('desk');
log('agent class', agent.constructor.name);
const thread = { resourceId: 'customer:smoke', threadId: `desk:smoke:${Date.now()}` };

const sub = await agent.subscribeToThread(thread);
(async () => { for await (const ch of sub.stream as AsyncIterable<any>) { if (!['text-delta','tool-call-delta','tool-call-input-streaming-start','tool-call-input-streaming-end','reasoning-delta'].includes(ch.type)) log('SUB', ch.type, ch.runId, ch.type === 'finish' ? JSON.stringify(ch.payload?.stepResult ?? '').slice(0,80) : ''); } })();
const s1 = agent.sendSignal({ type: 'notification', contents: 'SLOW email arrived', attributes: { kind: 'email' } }, { ...thread, ifIdle: { behavior: 'wake' } });
const a1 = await s1.accepted; log('signal1', a1.action, (a1 as any).runId);
await new Promise(r => setTimeout(r, 200));
const q = agent.queueMessage({ contents: 'queued field edit', attributes: { kind: 'edit' } }, thread);
const qa = await q.accepted; log('queued while running ->', qa.action);
const p = agent.sendSignal({ type: 'notification', contents: 'persist only' }, { ...thread, ifActive: { behavior: 'persist' }, ifIdle: { behavior: 'persist' } });
log('persist ->', (await p.accepted).action); await p.persisted;
if (a1.action === 'wake') { await (a1 as any).output.getFullOutput?.().catch((e: unknown) => log('full output err', e)); }
await new Promise(r => setTimeout(r, 3000));
log('model calls', calls, 'tool runs', toolRuns);

const sched = await mastra.schedules.create({
  agentId: 'desk', cron: '0 7 * * *', timezone: 'Europe/London', prompt: 'pre-delivery sweep', name: 'sweep',
  threadId: thread.threadId, resourceId: thread.resourceId, tagName: 'schedule', ifActive: { behavior: 'persist' }, ifIdle: { behavior: 'wake' },
} as any);
log('schedule created', sched.id, (sched as any).nextFireAt);
const fired = await mastra.schedules.run(sched.id);
log('schedules.run ->', fired);
await new Promise(r => setTimeout(r, 3000));
log('active runs', JSON.stringify(await (agent as any).listActiveRuns()).slice(0, 300));
await mastra.schedules.delete(sched.id);
const mem = await agent.getMemory();
const msgs = await mem?.recall({ threadId: thread.threadId, resourceId: thread.resourceId } as any);
log('messages in thread', (msgs as any)?.messages?.length, JSON.stringify((msgs as any)?.messages?.map((m: any) => [m.role, JSON.stringify(m.content).slice(0, 80)])));
log('schedule outcomes', outcomes);
await mastra.shutdown?.();
process.exit(0);
