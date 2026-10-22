import { join } from 'node:path';
import { ModelRouterLanguageModel, type MastraModelConfig } from '@mastra/core/llm';
import type { LanguageModelV2 } from '@ai-sdk/provider';
import { RecordReplayModel } from './recording';
import { ScriptedDeskModel } from './scripted';

export { ScriptedDeskModel } from './scripted';
export { RecordReplayModel } from './recording';

export function defaultRecordingsDir(): string {
  return join(process.cwd().replace(/\/apps\/agent.*$/, ''), 'scenarios', 'recordings');
}

/** Header Anthropic needs when the API key is not scoped to one workspace. */
export const WORKSPACE_HEADER = 'anthropic-workspace-id';

/**
 * A live provider instance for a router id ("anthropic/claude-sonnet-5-5"). Mastra's router builds
 * the AI SDK provider (`createAnthropic({ apiKey, baseURL, headers })`) from this config, so the
 * optional workspace header reaches every request. The key itself is read from ANTHROPIC_API_KEY
 * by the router and never passes through this code.
 */
export function liveModel(modelId: string, opts: { workspaceId?: string } = {}): ModelRouterLanguageModel {
  const headers = opts.workspaceId && modelId.startsWith('anthropic/') ? { [WORKSPACE_HEADER]: opts.workspaceId } : undefined;
  return new ModelRouterLanguageModel(headers ? { id: modelId as `${string}/${string}`, headers } : (modelId as never));
}

/**
 * The desk's model for the configured LLM mode:
 * - scripted: the deterministic offline desk (default; no keys)
 * - live: the router model (with the workspace header when ANTHROPIC_WORKSPACE_ID is set)
 * - record: the live model wrapped so every response is written to scenarios/recordings/
 * - replay: recordings first, the scripted desk on a miss (so demos never need a key)
 */
export function resolveDeskModel(opts: {
  mode: 'live' | 'record' | 'replay' | 'scripted';
  agentModel: string;
  recordingsDir?: string;
  live?: LanguageModelV2;
  scriptedLatencyMs?: number;
  workspaceId?: string;
  /** What `record` wraps: the live model (default) or the scripted desk (offline pipeline check). */
  recordSource?: 'live' | 'scripted';
}): MastraModelConfig {
  const scripted = new ScriptedDeskModel({ latencyMs: opts.scriptedLatencyMs });
  const dir = opts.recordingsDir ?? defaultRecordingsDir();
  switch (opts.mode) {
    case 'live':
      return (opts.workspaceId ? liveModel(opts.agentModel, { workspaceId: opts.workspaceId }) : opts.agentModel) as MastraModelConfig;
    case 'record':
      return new RecordReplayModel({
        mode: 'record',
        dir,
        inner: opts.live ?? (opts.recordSource === 'scripted' ? scripted : (liveModel(opts.agentModel, { workspaceId: opts.workspaceId }) as unknown as LanguageModelV2)),
      }) as unknown as MastraModelConfig;
    case 'replay':
      return new RecordReplayModel({
        mode: 'replay',
        dir,
        fallback: scripted,
        onMiss: (k) => console.warn(`[replay] miss ${k}; using scripted desk`),
      }) as unknown as MastraModelConfig;
    default:
      return scripted as unknown as MastraModelConfig;
  }
}
