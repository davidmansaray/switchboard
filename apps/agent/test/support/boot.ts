import { schema as s, type Db } from '@switchboard/db';
import { resetDatabase } from '@switchboard/db/reset';
import { HERO_REF } from '@switchboard/db';
import { eq } from 'drizzle-orm';
import type { MastraModelConfig } from '@mastra/core/llm';
import { configFromEnv, type SwitchboardConfig } from '../../src/config';
import { createSwitchboard, type Switchboard } from '../../src/runtime';

let port = 4500 + Math.floor(Math.random() * 300);

/** Fresh test DB + a running Switchboard on the chosen backend, scripted model. */
export async function bootSwitchboard(over: Partial<SwitchboardConfig> = {}, opts: { reset?: boolean; model?: MastraModelConfig } = {}): Promise<Switchboard> {
  if (opts.reset !== false) await resetDatabase(process.env.DATABASE_URL);
  const config: SwitchboardConfig = {
    ...configFromEnv(process.env),
    llmMode: 'scripted',
    scriptedLatencyMs: 60,
    editDebounceMs: 150,
    allowCrashEndpoint: true,
    internalApiToken: undefined,
    ...over,
  };
  const sb = createSwitchboard(config, { port: port++, model: opts.model });
  await sb.start({ workers: true, recover: config.signalBackend === 'harness' });
  return sb;
}

export async function heroId(db: Db): Promise<string> {
  const [h] = await db.select({ id: s.hires.id }).from(s.hires).where(eq(s.hires.ref, HERO_REF));
  return h!.id;
}

export const BACKENDS = ['harness', 'app'] as const;
