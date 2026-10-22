import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { decide } from './desk-policy';
import { currentTurn } from './prompt';

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

export function streamOf(parts: LanguageModelV2StreamPart[]): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(p);
      c.close();
    },
  });
}

/** Deterministic, offline desk model (LLM_MODE=scripted). See desk-policy.ts. */
export class ScriptedDeskModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider = 'switchboard';
  readonly modelId = 'scripted-desk';
  readonly supportedUrls = {};
  calls = 0;

  /** `latencyMs` per model step makes runs take demo-realistic time (and makes races observable). */
  constructor(private readonly opts: { latencyMs?: number } = {}) {}

  partsFor(options: LanguageModelV2CallOptions): LanguageModelV2StreamPart[] {
    this.calls++;
    const turn = currentTurn(options.prompt);
    const toolNames = (options.tools ?? []).map((t) => t.name);
    const d = decide({ inputs: turn.inputs, results: turn.results, toolNames, system: turn.system });
    const parts: LanguageModelV2StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'response-metadata', id: `scripted-${this.calls}`, modelId: this.modelId, timestamp: new Date(0) },
    ];
    if ('calls' in d) {
      for (const c of d.calls) parts.push({ type: 'tool-call', toolCallId: c.toolCallId, toolName: c.toolName, input: JSON.stringify(c.input) });
      parts.push({ type: 'finish', finishReason: 'tool-calls', usage });
    } else {
      parts.push({ type: 'text-start', id: 't0' }, { type: 'text-delta', id: 't0', delta: d.text }, { type: 'text-end', id: 't0' });
      parts.push({ type: 'finish', finishReason: 'stop', usage });
    }
    return parts;
  }

  async doStream(options: LanguageModelV2CallOptions) {
    if (this.opts.latencyMs) await new Promise((r) => setTimeout(r, this.opts.latencyMs));
    return { stream: streamOf(this.partsFor(options)) };
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    const parts = this.partsFor(options);
    const content: Awaited<ReturnType<LanguageModelV2['doGenerate']>>['content'] = [];
    let text = '';
    for (const p of parts) {
      if (p.type === 'tool-call') content.push({ type: 'tool-call', toolCallId: p.toolCallId, toolName: p.toolName, input: p.input });
      if (p.type === 'text-delta') text += p.delta;
    }
    if (text) content.push({ type: 'text', text });
    const finish = parts.find((p) => p.type === 'finish');
    return { content, finishReason: finish?.type === 'finish' ? finish.finishReason : 'stop', usage, warnings: [] };
  }
}
