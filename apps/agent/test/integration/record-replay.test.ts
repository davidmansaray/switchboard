import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MastraModelConfig } from '@mastra/core/llm';
import { schema as s } from '@switchboard/db';
import { resetDatabase } from '@switchboard/db/reset';
import { afterAll, describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config';
import { RecordReplayModel, ScriptedDeskModel } from '../../src/models';
import { createSwitchboard } from '../../src/runtime';
import { beats } from '../../src/scenario/beats';
import { heroId } from '../support/boot';

/** LLM_MODE=record then replay: the same beats are served from recordings, no model needed. */
describe('record/replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-rec-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function play(model: RecordReplayModel) {
    await resetDatabase(process.env.DATABASE_URL);
    const config = { ...configFromEnv(process.env), llmMode: 'scripted' as const, editDebounceMs: 100, internalApiToken: undefined };
    const sb = createSwitchboard(config, { model: model as unknown as MastraModelConfig, port: 4850 + Math.floor(Math.random() * 40) });
    await sb.start({ workers: true });
    const hireId = await heroId(sb.db.db);
    await beats(sb.services)[1]();
    await sb.router.idle(hireId);
    await beats(sb.services)[2]();
    await sb.router.idle(hireId);
    const hire = (await sb.db.db.select().from(s.hires)).find((x) => x.ref === 'NH-5520')!;
    await sb.stop();
    return hire;
  }

  it('records every model call, then replays them with zero misses', async () => {
    const rec = new RecordReplayModel({ mode: 'record', dir, inner: new ScriptedDeskModel() });
    const recorded = await play(rec);
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(3);

    const rep = new RecordReplayModel({ mode: 'replay', dir });
    const replayed = await play(rep);
    expect(rep.misses).toBe(0);
    expect(rep.hits).toBe(files.length);
    expect(replayed.poNumber).toBe(recorded.poNumber);
    expect(replayed.version).toBe(4);
  });
});
