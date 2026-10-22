// Crash/recovery smoke: child starts a durable run and is SIGKILLed mid-tool; parent recovers it.
import { spawn } from 'node:child_process';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createTool } from '@mastra/core/tools';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';
import { PostgresStore } from '@mastra/pg';
import { Memory } from '@mastra/memory';
import { z } from 'zod';

const url = 'postgres://localhost:5432/switchboard_showcase_test';
const role = process.argv[2] ?? 'parent';
const threadId = process.argv[3] ?? `desk:crash:${Date.now()}`;
const log = (...a: unknown[]) => console.log(`[${role}]`, ...a);
const sleepMs = role === 'child' ? 20000 : 100;
const applyTool = createTool({
  id: 'apply', description: 'apply', inputSchema: z.object({ key: z.string() }),
  execute: async ({ key }) => { log('TOOL_STARTED', key); await new Promise(r => setTimeout(r, sleepMs)); log('TOOL_DONE', key); return { ok: true }; },
});
let calls = 0;
const model = new MastraLanguageModelV2Mock({
  doStream: async (opts) => {
    calls++;
    const lastRole = opts.prompt.at(-1)?.role;
    const parts: any[] = [{ type: 'stream-start', warnings: [] }];
    if (lastRole !== 'tool') {
      parts.push({ type: 'tool-call', toolCallId: 'apply-1', toolName: 'apply', input: JSON.stringify({ key: 'pricing:v5' }) },
        { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    } else {
      parts.push({ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'applied' }, { type: 'text-end', id: 't' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
    }
    log('model call', calls, lastRole);
    return { stream: new ReadableStream({ start(c) { for (const p of parts) c.enqueue(p); c.close(); } }) };
  },
});
const desk = new Agent({ id: 'desk', name: 'desk', instructions: 't', model, tools: { apply: applyTool }, memory: new Memory(), durable: true });
const mastra = new Mastra({ agents: { desk }, storage: new PostgresStore({ id: 's', connectionString: url, schemaName: 'mastra' }), recovery: { durableAgents: 'auto' } });
await mastra.startWorkers();
const agent = mastra.getAgent('desk') as any;
const thread = { resourceId: 'customer:crash', threadId };

if (role === 'child') {
  const r = agent.sendSignal({ type: 'notification', contents: 'approved D-8' }, { ...thread, ifIdle: { behavior: 'wake' } });
  const a = await r.accepted; log('RUN', a.runId);
  await new Promise(() => {});
} else {
  const child = spawn(process.execPath, ['--import', 'tsx', new URL(import.meta.url).pathname, 'child', threadId], { stdio: ['ignore', 'pipe', 'inherit'] });
  let runId = '';
  await new Promise<void>((resolve) => child.stdout.on('data', (d: Buffer) => {
    const s = d.toString(); process.stdout.write(s);
    const m = s.match(/RUN (\S+)/); if (m) runId = m[1]!;
    if (s.includes('TOOL_STARTED')) { child.kill('SIGKILL'); resolve(); }
  }));
  log('killed child; runId', runId);
  await new Promise(r => setTimeout(r, 500));
  log('listActiveRuns', JSON.stringify(await agent.listActiveRuns()).slice(0, 400));
  const t0 = Date.now();
  const rec = await agent.recoverActiveRuns({ runId });
  log('recoverActiveRuns (no force)', JSON.stringify(rec));
  const forced = await agent.recover(runId, { force: true });
  const full = await forced.output.getFullOutput();
  log('recover(force) text:', full.text, 'after ms', Date.now() - t0);
  await mastra.shutdown();
  process.exit(0);
}
