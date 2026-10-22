import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageModelV2, LanguageModelV2CallOptions, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import { streamOf } from './scripted';

/**
 * Record/replay wrapper. Each call is keyed by a hash of the *normalised* request
 * (prompt text, tool results and tool names, with ids/timestamps stripped), so a
 * re-run of the same scenario hits the same recordings.
 *
 * - record: call `inner`, store the stream parts under scenarios/recordings/<hash>.json
 * - replay: serve the recording; on a miss, call `fallback` (scripted desk) and say so
 */
export class RecordReplayModel implements LanguageModelV2 {
  readonly specificationVersion = 'v2' as const;
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls = {};
  hits = 0;
  misses = 0;

  constructor(
    private readonly opts: {
      mode: 'record' | 'replay';
      dir: string;
      inner?: LanguageModelV2;
      fallback?: LanguageModelV2;
      onMiss?: (key: string) => void;
    },
  ) {
    this.provider = opts.inner?.provider ?? 'replay';
    this.modelId = opts.inner?.modelId ?? 'replay';
    mkdirSync(opts.dir, { recursive: true });
  }

  static keyFor(options: LanguageModelV2CallOptions): string {
    return createHash('sha256').update(JSON.stringify(RecordReplayModel.normalise(options))).digest('hex').slice(0, 32);
  }

  /** The request as it is hashed: ids and timestamps stripped. Stored beside each recording to debug misses. */
  static normalise(options: LanguageModelV2CallOptions, clean: (s: string) => string = scrub) {
    const scrubJson = (v: unknown) => JSON.parse(clean(JSON.stringify(v ?? null))) as unknown;
    return {
      prompt: options.prompt.map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string'
            ? clean(m.content)
            : m.content.map((p) => {
                const q = p as unknown as Record<string, unknown>;
                if (q.type === 'text') return { t: clean(String(q.text)) };
                if (q.type === 'tool-call') return { call: q.toolName, input: scrubJson(q.input) };
                if (q.type === 'tool-result') return { result: q.toolName, output: scrubJson(q.output) };
                return { type: q.type };
              }),
      })),
      tools: (options.tools ?? []).map((t) => t.name).sort(),
    };
  }

  /**
   * Ids (evidence ids, outbox ids…) differ between the run that recorded and the run that replays,
   * and a recorded tool call carries the old ones. Both prompts hash the same with ids scrubbed, so
   * the n-th id in one is the n-th id in the other: map them and rewrite the recorded parts.
   */
  static idsOf(options: LanguageModelV2CallOptions): string[] {
    return JSON.stringify(RecordReplayModel.normalise(options, (x) => x)).match(UUID) ?? [];
  }

  private file(key: string) {
    return join(this.opts.dir, `${key}.json`);
  }

  async doStream(options: LanguageModelV2CallOptions) {
    const key = RecordReplayModel.keyFor(options);
    const f = this.file(key);
    if (this.opts.mode === 'replay' && existsSync(f)) {
      this.hits++;
      const rec = JSON.parse(readFileSync(f, 'utf8')) as { parts: LanguageModelV2StreamPart[]; ids?: string[] };
      const now = RecordReplayModel.idsOf(options);
      const map = new Map((rec.ids ?? []).map((id, i) => [id.toLowerCase(), now[i]] as const).filter((x): x is readonly [string, string] => Boolean(x[1])));
      const remap = (v: string) => (map.size ? v.replace(UUID, (m) => map.get(m.toLowerCase()) ?? m) : v);
      const parts = rec.parts.map(revive).map((p) => (p.type === 'tool-call' ? { ...p, input: remap(p.input) } : p.type === 'text-delta' ? { ...p, delta: remap(p.delta) } : p));
      return { stream: streamOf(parts) };
    }
    const source = this.opts.mode === 'record' ? this.opts.inner : this.opts.fallback;
    if (!source) throw new Error(`replay miss for ${key} and no fallback model`);
    if (this.opts.mode === 'replay') {
      this.misses++;
      this.opts.onMiss?.(key);
      if (process.env.REPLAY_DEBUG_DIR) {
        mkdirSync(process.env.REPLAY_DEBUG_DIR, { recursive: true });
        writeFileSync(join(process.env.REPLAY_DEBUG_DIR, `${key}.json`), JSON.stringify(RecordReplayModel.normalise(options), null, 2));
      }
    }
    const res = await source.doStream(options);
    if (this.opts.mode !== 'record') return res;
    const [a, b] = res.stream.tee();
    void collect(b).then((parts) => writeFileSync(f, JSON.stringify({ key, model: source.modelId, ids: RecordReplayModel.idsOf(options), request: RecordReplayModel.normalise(options), parts }, null, 2)));
    return { ...res, stream: a };
  }

  async doGenerate(options: LanguageModelV2CallOptions) {
    const source = this.opts.mode === 'record' ? this.opts.inner : this.opts.fallback;
    if (!source) throw new Error('doGenerate is not recorded; use streaming');
    return source.doGenerate(options);
  }
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const scrub = (s: string) => s.replace(UUID, '<id>').replace(ISO, '<ts>');

async function collect(s: ReadableStream<LanguageModelV2StreamPart>) {
  const out: LanguageModelV2StreamPart[] = [];
  const r = s.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) return out;
    out.push(value);
  }
}

function revive(p: LanguageModelV2StreamPart): LanguageModelV2StreamPart {
  if (p.type === 'response-metadata' && p.timestamp) return { ...p, timestamp: new Date(p.timestamp) };
  return p;
}
