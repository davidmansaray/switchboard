import { stale, type ToolResult } from '@switchboard/core';
import { getHireById, schema as s, withActor, type Db, type HireView, type Tx } from '@switchboard/db';
import { and, eq, sql } from 'drizzle-orm';

export const DESK_ACTOR = 'agent:desk';

/**
 * Demo crash switch. When armed, the next ledgered write SIGKILLs the process
 * right after its transaction commits: the side effect is durable, the tool
 * result never reaches the run. Recovery must then find the action recorded.
 */
export class CrashSwitch {
  private armedFor: string | null = null;
  private hangFor: { tool: string; ms: number } | null = null;
  /** Called (and awaited) just before the kill, so the UI can record the crash moment. */
  onCrash?: (tool: string) => Promise<void>;
  arm(tool = '*') {
    this.armedFor = tool;
  }
  /** Simulate a hung ("zombie") worker: stall before the write, then carry on as if nothing happened. */
  armHang(tool: string, ms: number) {
    this.hangFor = { tool, ms };
  }
  disarm() {
    this.armedFor = null;
    this.hangFor = null;
  }
  get armed() {
    return this.armedFor;
  }
  async maybeHang(tool: string) {
    const h = this.hangFor;
    if (!h || (h.tool !== '*' && h.tool !== tool)) return;
    this.hangFor = null;
    console.error(`[hang] ${tool} stalled for ${h.ms}ms`);
    await new Promise((r) => setTimeout(r, h.ms));
    console.error(`[hang] ${tool} resumed`);
  }
  async maybeCrash(tool: string) {
    if (this.armedFor && (this.armedFor === '*' || this.armedFor === tool)) {
      console.error(`[crash] killing agent process after ${tool} committed`);
      await this.onCrash?.(tool).catch(() => {});
      process.kill(process.pid, 'SIGKILL');
    }
  }
}

export type LedgerDeps = { db: Db; crash: CrashSwitch };

/**
 * Run a write exactly once per (hire, action_key).
 *
 * The ledger row is inserted first, in the same transaction as the write, so a
 * concurrent duplicate blocks on the unique index and then sees DUPLICATE. A
 * version precondition is checked under a row lock. Failures roll back the
 * ledger row too, so a STALE/REJECTED attempt can be retried with a new version.
 */
export async function runAction<T>(
  deps: LedgerDeps,
  input: { hireId: string; actionKey: string; tool: string; expectedVersion?: number; runId?: string },
  fn: (tx: Tx, hire: HireView) => Promise<ToolResult<T>>,
): Promise<ToolResult<T>> {
  await deps.crash.maybeHang(input.tool);
  const result = await withActor(deps.db, DESK_ACTOR, async (tx) => {
    const [claimed] = await tx
      .insert(s.agentActions)
      .values({ hireId: input.hireId, actionKey: input.actionKey, tool: input.tool, result: {}, runId: input.runId ?? null })
      .onConflictDoNothing()
      .returning({ id: s.agentActions.id });
    if (!claimed) {
      const [prev] = await tx
        .select()
        .from(s.agentActions)
        .where(and(eq(s.agentActions.hireId, input.hireId), eq(s.agentActions.actionKey, input.actionKey)));
      return { status: 'DUPLICATE', actionKey: input.actionKey, result: (prev?.result as { result?: T })?.result as T } as ToolResult<T>;
    }
    const hire = await getHireById(tx, input.hireId, { forUpdate: true });
    if (!hire) throw new Error(`hire ${input.hireId} not found`);
    if (input.expectedVersion !== undefined && hire.version !== input.expectedVersion) {
      throw new Abort(stale(input.expectedVersion, hire.version));
    }
    const r = await fn(tx, hire);
    if (r.status !== 'OK') throw new Abort(r);
    await tx.update(s.agentActions).set({ result: sql`${JSON.stringify(r)}::jsonb` }).where(eq(s.agentActions.id, claimed.id));
    return r;
  }).catch((e: unknown) => {
    if (e instanceof Abort) return e.result as ToolResult<T>;
    throw e;
  });
  const status = { OK: 'recorded', DUPLICATE: 'skipped_duplicate', STALE: 'rejected_version', REJECTED: 'rejected' }[result.status] as s.ActionAttemptStatus;
  await deps.db
    .insert(s.actionAttempts)
    .values({
      hireId: input.hireId,
      actionKey: input.actionKey,
      tool: input.tool,
      status,
      runId: input.runId ?? null,
      note: result.status === 'STALE' ? result.message : result.status === 'REJECTED' ? result.reason : null,
    })
    .catch((e: unknown) => console.error('[ledger] attempt log failed', e));
  if (result.status === 'OK') await deps.crash.maybeCrash(input.tool);
  return result;
}

class Abort extends Error {
  constructor(readonly result: ToolResult<unknown>) {
    super('abort');
  }
}
