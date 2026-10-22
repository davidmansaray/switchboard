import { loadEnv } from '@switchboard/db';
import { configFromEnv } from '../config';
import { createSwitchboard } from '../runtime';

await loadEnv();

/** Mastra server entry (`mastra dev` / `mastra build`). */
export const switchboard = createSwitchboard(configFromEnv());
export const mastra = switchboard.mastra;

if (process.env.SWITCHBOARD_SKIP_BOOT !== 'true') {
  // Workers and durable-agent recovery are started by the Mastra server itself.
  void switchboard
    .start()
    .then((r) => console.log(`[switchboard] desks ready (backend=${switchboard.config.signalBackend}, llm=${switchboard.config.llmMode}); re-delivered ${r.redelivered} event(s)`))
    .catch((e: unknown) => console.error('[switchboard] boot failed', e));
}
