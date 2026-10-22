import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  MASTRA_DATABASE_URL: z.string().min(1).optional(),
  AGENT_MODEL: z.string().default('anthropic/claude-sonnet-5-5'),
  FAST_MODEL: z.string().default('anthropic/claude-haiku-5-5'),
  LLM_MODE: z.enum(['live', 'record', 'replay', 'scripted']).default('scripted'),
  SIGNAL_BACKEND: z.enum(['harness', 'app']).default('harness'),
  RECORDINGS_DIR: z.string().optional(),
  RECORD_SOURCE: z.enum(['live', 'scripted']).default('live'),
  SCRIPTED_LATENCY_MS: z.coerce.number().int().nonnegative().default(400),
  EDIT_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(1500),
  ALLOW_CRASH_ENDPOINT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  INTERNAL_API_TOKEN: z.string().optional(),
  /** Optional: an Anthropic key that is not workspace-scoped needs this header on every request. */
  ANTHROPIC_WORKSPACE_ID: z.string().optional(),
  ALLOW_SCENARIO_RESET: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SWEEP_CRON: z.string().default('0 7 * * *'),
  SWEEP_TIMEZONE: z.string().default('Europe/London'),
});

export type SwitchboardConfig = {
  databaseUrl: string;
  mastraDatabaseUrl: string;
  agentModel: string;
  fastModel: string;
  llmMode: 'live' | 'record' | 'replay' | 'scripted';
  signalBackend: 'harness' | 'app';
  recordingsDir?: string;
  recordSource: 'live' | 'scripted';
  editDebounceMs: number;
  scriptedLatencyMs: number;
  allowCrashEndpoint: boolean;
  internalApiToken?: string;
  anthropicWorkspaceId?: string;
  allowScenarioReset: boolean;
  sweepCron: string;
  sweepTimezone: string;
};

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SwitchboardConfig {
  const e = schema.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    mastraDatabaseUrl: e.MASTRA_DATABASE_URL ?? e.DATABASE_URL,
    agentModel: e.AGENT_MODEL,
    fastModel: e.FAST_MODEL,
    llmMode: e.LLM_MODE,
    signalBackend: e.SIGNAL_BACKEND,
    recordingsDir: e.RECORDINGS_DIR || undefined,
    recordSource: e.RECORD_SOURCE,
    editDebounceMs: e.EDIT_DEBOUNCE_MS,
    scriptedLatencyMs: e.SCRIPTED_LATENCY_MS,
    allowCrashEndpoint: e.ALLOW_CRASH_ENDPOINT,
    internalApiToken: e.INTERNAL_API_TOKEN || undefined,
    anthropicWorkspaceId: e.ANTHROPIC_WORKSPACE_ID || undefined,
    allowScenarioReset: e.ALLOW_SCENARIO_RESET,
    sweepCron: e.SWEEP_CRON,
    sweepTimezone: e.SWEEP_TIMEZONE,
  };
}
