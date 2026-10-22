# Mastra versions and harness API check

Checked 2026-10-20 against the **installed** packages (type declarations in `node_modules/@mastra/core/dist/**/*.d.ts` and the docs bundled in `@mastra/core/dist/docs/references/`), then confirmed with live smoke runs against `switchboard_test` (`scripts/smoke-harness.ts`, `scripts/smoke-crash.ts`).

Every version is pinned **exactly** in `package.json` (no `^`). Signals, schedules and durable agents are marked beta in the docs ("breaking changes may occur without a major version bump"), so upgrades are deliberate: bump, re-run both smoke scripts and the integration suite, then update this file.

## Pinned versions

| Package | Version | Notes |
|---|---|---|
| `@mastra/core` | 1.78.0 | signals (since 1.39), schedules (since 1.50), durable agents (since 1.45, beta) |
| `@mastra/memory` | 1.38.0 | working memory + observational memory |
| `@mastra/pg` | 1.31.2 | `PostgresStore` (schema `mastra`), `PgVector`; peer `@mastra/core >=1.76` |
| `@mastra/loggers` | 1.3.8 | |
| `mastra` (CLI) | 1.34.2 | `mastra dev` / `mastra build`; peer `@mastra/core >=1.58` |
| `@mastra/client-js` | 1.55.0 | web → agent service (added with the web app) |
| `@mastra/core/evals` (`createScorer`) | in core 1.78.0 | M7 scorers are code-only, no judge model; no extra package needed |

Model router strings (from `provider-types.generated.d.ts`): `anthropic/claude-sonnet-5-5` (`AGENT_MODEL`), `anthropic/claude-haiku-5-5` (`FAST_MODEL`), `openai/text-embedding-3-small` (`EMBEDDING_MODEL`).

## Signals (`Agent` methods, `dist/agent/agent.d.ts`)

- `sendMessage(message, target)`, `queueMessage(message, target)`, `sendSignal(signal, target)`, `queueSignal(signal, target)`, plus `cancelQueuedMessages`, `subscribeToThread`, `subscribeThreadEvents` (queue-count events), `abortThreadStream`, `sendStateSignal`, `sendNotificationSignal`.
- Target: `{ resourceId, threadId, runId?, ifActive?: { behavior: 'deliver'|'persist'|'discard', attributes }, ifIdle?: { behavior: 'wake'|'persist'|'discard', streamOptions, attributes, requireClaimedOwner }, scopes? }`. Queue variants add `queueOwnerId`.
- Result: `{ accepted: Promise<{action:'wake',runId,output} | {action:'deliver',runId} | {action:'persist'} | {action:'discard'} | {action:'blocked',reason:'thread-blocked',runId}>, signal, persisted? }`.
- Signal shape: `{ type: 'user'|'state'|'reactive'|'notification', contents, attributes, metadata, tagName }`. The model sees `<tagName k="v">contents</tagName>`.

**Observed (smoke run):**
- `sendSignal` on an idle thread → `wake`, durable run starts.
- `queueMessage` while a run is active → `accepted.action === 'deliver'`, but the input is processed **after** the active run's tool step completes (it arrived as the next model input, after the tool result). `signals_log` therefore records `queued` when the desk was running at enqueue time; the raw action is kept in the payload.
- `sendSignal` with `ifActive/ifIdle: persist` → `persist`; the message lands in thread memory (role `signal`) without waking.
- **Caveat:** the `queueMessage` FIFO is process-local (`EventEmitterPubSub` by default). Pending queued input is lost if the agent process dies. Switchboard keeps the source event in `app.events` (`processed_at` null until handled), so nothing is lost on restart: the adapter re-sends unprocessed events on boot.

## Schedules (`mastra.schedules`, `dist/schedules/schedules.d.ts`)

- `create / get / list / update / delete / pause / resume / run(id)`. `run(id)` → `{ scheduleId, claimId: 'manual_<id>_<ts>', scheduledFireAt }`.
- Threaded agent schedule input: `{ id?, agentId, cron, prompt, name?, timezone?, threadId, resourceId, signalType? (default 'notification'), tagName? (default 'schedule'), attributes?, ifActive?: {behavior}, ifIdle?: {behavior, streamOptions}, metadata?, status? }`. `ifActive: persist, ifIdle: wake` is supported as the brief needs.
- Hooks on `new Mastra({ schedules: { prepare, onFinish, onError, onAbort } })`.
- `@mastra/pg` implements the `schedules` domain.
- **Gotcha (observed):** schedules only fire when workers run. `mastra dev`/the built server start them; scripts and tests must call `await mastra.startWorkers()`. The scheduler ticks every 10 s by default (`scheduler.tickIntervalMs`); `run(id)` fires immediately.

## Durable agents

- `new Agent({ ..., durable: true | { maxSteps, cleanupTimeoutMs, shouldPersistSnapshot, cache, pubsub } })` → registered as `DurableAgent` when attached to `Mastra` (confirmed: `mastra.getAgent('desk').constructor.name === 'DurableAgent'`).
- `new Mastra({ recovery: { durableAgents: 'auto' } })`. Default is `'off'`, and with `'off'` the per-step `running` checkpoints are **not** written, so a crash leaves nothing to recover. Switchboard sets `'auto'`.
- `agent.listActiveRuns()`, `agent.recoverActiveRuns({ runId? })` → `{ recovered: [{ runId, status: 'success'|'failed'|'skipped', reason?, retryAt? }], succeeded, failed }`, `agent.recover(runId, { force? })`, `agent.observe(runId)`, `mastra.recoverAllDurableAgents()`.
- **Observed (crash smoke):** child process SIGKILLed during a tool call; the parent saw the run in `listActiveRuns()` as `running`. `recoverActiveRuns()` returned `skipped / run-active` with `retryAt` ≈ 30 s later (claim lease TTL `EXECUTION_LEASE_TTL_MS = 30000`, renewed every 10 s). `recover(runId, { force: true })` re-drove it immediately and **re-executed the interrupted tool call**, which is exactly why every write tool is idempotent by `action_key`.

## Run fencing (`dist/storage/run-fencing.d.ts`, `dist/agent/durable/execution-fence.d.ts`)

- `RunFence { runId, generation, ownerId }`; stores implement `supportsRunFencing()`, `claimRunOwnership({ runId, ownerId, leaseMs, force?, expectedGeneration? })`, `renewRunOwnership({ ...fence, leaseMs })`. Conflicting writes throw `RunFenceConflictError` (`STORAGE_RUN_FENCE_CONFLICT`); a superseded execution stops with `DurableExecutionFenceError` (`DURABLE_AGENT_EXECUTION_SUPERSEDED`).
- `@mastra/pg` 1.31.2 implements `supportsRunFencing/claimRunOwnership/renewRunOwnership` in its workflows domain, and the docs list `@mastra/pg` as fencing-capable for memory writes too.
- Mastra fences **Mastra's own** writes (snapshots, messages, working memory). It cannot fence our tool side effects in `app.*`; those are protected by the `agent_actions (hire_id, action_key)` unique ledger plus `expected_version`.

## Storage domains in `@mastra/pg` 1.31.2

`agents, background-tasks, blobs, channels, datasets, experiments, favorites, knowledge, mcp-clients, mcp-servers, memory, notifications, observability, prompt-blocks, schedules, scorer-definitions, scores, skills, thread-state, tool-provider-connections, workflow-definitions, workflows, workspaces`.
There is **no `harness` domain** in pg. That domain only stores AgentController/Harness sessions, which Switchboard deliberately does not use (they don't survive restarts; approvals live in `app.approvals`).

## Mock / offline models

- `@mastra/core/test-utils/llm-mock` exports `MastraLanguageModelV2Mock` (`doStream`/`doGenerate` callbacks) and `createMockModel`. Used only by the smoke scripts.
- The app uses its own `LanguageModelV2` implementations (`src/models/`): a deterministic **scripted desk model** (`LLM_MODE=scripted`) and a **record/replay** wrapper (`LLM_MODE=record|replay`), so demos and tests run without `ANTHROPIC_API_KEY`.

## Conclusion

Nothing checked so far needs the `SIGNAL_BACKEND=app` fallback; it is still built (one adapter, two backends) and tested, as the plan requires.

## Added at M5–M7 (checked against the installed 1.78.0 types)

- `ModelRouterLanguageModel` (`@mastra/core/llm`) takes `{ id, headers }`; for `anthropic/*` the router builds `createAnthropic({ apiKey, baseURL, headers })`, so `ANTHROPIC_WORKSPACE_ID` reaches every request (wire-tested). It is also the live instance `record` mode wraps.
- `createScorer` from `@mastra/core/evals` with function steps (`preprocess`, `generateScore`, `generateReason`); `scorer.run({ input, output })` returns `{ score }`.
- Agent tool context for a durable agent carries `agent.threadId` but no run id; the run id is taken from the desk row.
- `recoverActiveRuns({ runId })` returns `skipped / run-active` with `retryAt` while a dead owner's lease is live and does **not** retry later by itself: the app re-calls it at `retryAt`.
- `agent.generate(text, { runId })` sets the run id (used by the app-loop backend).
- `mastra build` refuses to run while `mastra dev` serves the same directory (`--force` would empty its output).
