import { Mastra } from '@mastra/core';
import type { MastraModelConfig } from '@mastra/core/llm';
import { PinoLogger } from '@mastra/loggers';
import { PostgresStore } from '@mastra/pg';
import { createDb, schema as s, type DbHandle } from '@switchboard/db';
import { and, eq, inArray } from 'drizzle-orm';
import type { SwitchboardConfig } from './config';
import { createDeskAgent, DESK_AGENT_ID } from './mastra/agents/desk';
import { liveModel, resolveDeskModel } from './models';
import { createScenario, type Scenario } from './scenario/runner';
import { markOrphanedRuns } from './signals/runs';
import { buildRoutes } from './server/routes';
import { createServices, type Services } from './services';
import { SignalRouter } from './signals/adapter';
import { AppLoopBackend } from './signals/app-loop';
import { HarnessBackend } from './signals/harness';
import type { SignalBackend } from './signals/types';
import { createDeskTools } from './tools/desk-tools';
import { CrashSwitch } from './tools/ledger';
import { makeTracer, type Tracer } from './tools/trace';

export type Switchboard = {
  config: SwitchboardConfig;
  mastra: Mastra;
  db: DbHandle;
  router: SignalRouter;
  services: Services;
  crash: CrashSwitch;
  tracer: Tracer;
  scenario: Scenario;
  /** Start workers, desk subscriptions, sweeps; recover crashed runs; re-deliver leftovers. */
  start: (opts?: { workers?: boolean; recover?: boolean }) => Promise<{ recovered: number; redelivered: number }>;
  stop: () => Promise<void>;
};

export function createSwitchboard(config: SwitchboardConfig, opts: { model?: MastraModelConfig; port?: number } = {}): Switchboard {
  const db = createDb(config.databaseUrl);
  const crash = new CrashSwitch();
  crash.onCrash = async (tool) => {
    await db.db.insert(s.opsLog).values({ kind: 'crash', detail: { tool, pid: process.pid, leaseMs: 30_000 } });
  };
  const tracer = makeTracer(db.db);
  const tools = createDeskTools({ db: db.db, crash, tracer });
  const workspaceId = config.anthropicWorkspaceId;
  const model =
    opts.model ??
    resolveDeskModel({ mode: config.llmMode, agentModel: config.agentModel, recordingsDir: config.recordingsDir, scriptedLatencyMs: config.scriptedLatencyMs, workspaceId, recordSource: config.recordSource });
  const observationalModel =
    config.llmMode === 'live' ? ((workspaceId ? liveModel(config.fastModel, { workspaceId }) : config.fastModel) as MastraModelConfig) : undefined;
  const desk = createDeskAgent({ model, tools, observationalModel });

  // Backends need the Mastra instance, which needs the backends' hooks: resolve lazily.
  const ref: { mastra?: Mastra } = {};
  const getMastra = () => {
    if (!ref.mastra) throw new Error('mastra not ready');
    return ref.mastra;
  };
  const backendDeps = { db: db.db, sql: db.sql, mastra: getMastra, sweepCron: config.sweepCron, sweepTimezone: config.sweepTimezone };
  const backend: SignalBackend = config.signalBackend === 'harness' ? new HarnessBackend(backendDeps) : new AppLoopBackend(backendDeps);
  const router = new SignalRouter({ db: db.db, backend, debounceMs: config.editDebounceMs });
  const services = createServices({ db: db.db, router });

  const harness = backend instanceof HarnessBackend ? backend : undefined;
  const mastra = new Mastra({
    agents: { [DESK_AGENT_ID]: desk },
    storage: new PostgresStore({ id: 'switchboard-mastra', connectionString: config.mastraDatabaseUrl, schemaName: 'mastra' }),
    recovery: { durableAgents: 'auto' },
    logger: new PinoLogger({ name: 'switchboard', level: (process.env.LOG_LEVEL as 'info') ?? 'warn' }),
    ...(harness
      ? {
          schedules: {
            prepare: (ctx) => harness.prepareSweep(ctx as never),
            onFinish: (ctx) => harness.finishSweep(ctx as never),
            onError: (ctx) => harness.sweepFailed(ctx as never),
          },
        }
      : {}),
    server: {
      port: opts.port ?? Number(process.env.PORT ?? 4103),
      apiRoutes: buildRoutes(() => sb),
    },
  });
  ref.mastra = mastra;

  /** Desks a dead process left looking busy, with no live run behind them: settle them. */
  async function settleStaleDesks(activeThreads: Set<string>) {
    const desks = await db.db.select().from(s.desks).where(inArray(s.desks.runState, ['running', 'queued', 'recovering']));
    for (const d of desks) {
      if (activeThreads.has(d.mastraThreadId) || !backend.isIdle(d.hireId)) continue;
      const open = await db.db
        .select({ id: s.drafts.id })
        .from(s.drafts)
        .where(and(eq(s.drafts.hireId, d.hireId), inArray(s.drafts.status, ['pending', 'stale'])))
        .limit(1);
      await db.db
        .update(s.desks)
        .set({ runState: open.length ? 'awaiting_approval' : 'idle', currentStep: null, activeRunId: null })
        .where(eq(s.desks.id, d.id));
    }
  }
  const runThreads = new Map<string, string>();
  const recovering = new Set<string>();

  /** Recover one orphaned durable run, retrying at Mastra's `retryAt` hint until its lease lapses. */
  async function driveRecovery(runId: string, attempt: number): Promise<void> {
    if (attempt === 0 && recovering.has(runId)) return;
    recovering.add(runId);
    const agent = mastra.getAgent(DESK_AGENT_ID) as unknown as {
      recoverActiveRuns: (o: { runId: string }) => Promise<{ recovered: Array<{ runId: string; status: string; reason?: string; retryAt?: number }> }>;
    };
    const r = await agent.recoverActiveRuns({ runId }).catch((e: unknown) => ({ recovered: [{ runId, status: 'failed', reason: String(e) }] }));
    const one = r.recovered.find((x) => x.runId === runId) as { runId: string; status: string; reason?: string; retryAt?: number } | undefined;
    await db.db
      .insert(s.opsLog)
      .values({ kind: 'recovery', detail: { runId, attempt, status: one?.status ?? 'none', reason: one?.reason ?? null, retryAt: one?.retryAt ? new Date(one.retryAt).toISOString() : null } })
      .catch(() => {});
    if (one?.status === 'skipped' && one.reason === 'run-active' && attempt < 6) {
      const wait = Math.max(500, (one.retryAt ?? Date.now() + 10_000) - Date.now() + 500);
      setTimeout(() => void driveRecovery(runId, attempt + 1), wait).unref?.();
      return;
    }
    recovering.delete(runId);
  }
  async function threadsOf(runIds: Set<string>) {
    return new Set([...runIds].map((r) => runThreads.get(r)).filter((t): t is string => Boolean(t)));
  }

  const scenario = createScenario({
    db: db.db,
    services,
    router,
    crash,
    tracer,
    allowCrash: config.allowCrashEndpoint,
    allowReset: config.allowScenarioReset,
    restart: async () => {
      await backend.start();
      await services.ensureSweeps();
    },
  });

  const sb: Switchboard = {
    config,
    mastra,
    db,
    router,
    services,
    crash,
    tracer,
    scenario,
    async start(o = {}) {
      const t0 = Date.now();
      const lap = (what: string) => process.env.SWITCHBOARD_BOOT_TRACE === 'true' && console.log(`[boot] ${what} +${Date.now() - t0}ms`);
      // The process is up: say so first, so the UI stops showing "worker down" while recovery runs.
      await db.db.insert(s.opsLog).values({ kind: 'boot', detail: { pid: process.pid, backend: config.signalBackend, llmMode: config.llmMode, crashEnabled: config.allowCrashEndpoint, phase: 'up' } }).catch(() => {});
      if (o.workers) await mastra.startWorkers();
      const orphaned = await markOrphanedRuns(db.db).catch(() => 0);
      lap('orphaned runs marked');
      await backend.start();
      lap('desks subscribed');
      await services.ensureSweeps();
      lap('sweeps ensured');
      let recovered = 0;
      const live = new Set<string>();
      if (o.recover && harness) {
        // The server boot already does this with recovery: 'auto'; tests and scripts call it here.
        const r = await mastra.recoverAllDurableAgents();
        recovered = (r as { recovered?: number }).recovered ?? 0;
      }
      lap('recovery checked');
      if (harness) {
        const agent = mastra.getAgent(DESK_AGENT_ID) as unknown as { listActiveRuns: () => Promise<{ runs: Array<{ runId: string; threadId?: string }> }> };
        const active = await agent.listActiveRuns().catch(() => ({ runs: [] }));
        lap('active runs listed');
        for (const run of active.runs) {
          live.add(run.runId);
          if (run.threadId) runThreads.set(run.runId, run.threadId);
        }
        const threads = active.runs.map((r) => r.threadId).filter((t): t is string => Boolean(t));
        if (threads.length) await db.db.update(s.desks).set({ runState: 'recovering' }).where(inArray(s.desks.mastraThreadId, threads));
        // Mastra's boot recovery skips a run whose dead owner still holds the lease ("run-active", retryAt)
        // and leaves the retry to the caller. A supervised restart is faster than the 30 s lease, so drive it.
        for (const runId of live) void driveRecovery(runId, 0);
      }
      const redelivered = await router.redeliverUnprocessed({ skipRunIds: live });
      await settleStaleDesks(live.size ? await threadsOf(live) : new Set());
      const resumed = await scenario.resume().catch(() => [] as number[]);
      lap('re-delivered + resumed');
      await db.db
        .insert(s.opsLog)
        .values({
          kind: 'recovery',
          detail: { pid: process.pid, backend: config.signalBackend, llmMode: config.llmMode, activeRuns: [...live], orphanedRuns: orphaned, redelivered, resumedBeats: resumed, crashEnabled: config.allowCrashEndpoint },
        })
        .catch(() => {});
      return { recovered, redelivered };
    },
    async stop() {
      await router.stop();
      await backend.stop();
      await mastra.shutdown().catch(() => {});
      await db.close();
    },
  };
  return sb;
}
