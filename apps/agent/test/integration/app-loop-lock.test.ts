import { createDb, schema as s, type DbHandle } from '@switchboard/db';
import { and, eq } from 'drizzle-orm';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Switchboard } from '../../src/runtime';
import { beats } from '../../src/scenario/beats';
import { AppLoopBackend } from '../../src/signals/app-loop';
import { bootSwitchboard, heroId } from '../support/boot';

/**
 * SIGNAL_BACKEND=app has no Mastra run fencing; it holds a Postgres session advisory lock per desk
 * for each turn instead. These tests take the same lock from another session to prove it is held
 * for the whole turn, that a second holder makes the loop leave the desk's events for the owner,
 * and that a failure to get a connection for the lock does not wedge the desk.
 */
describe('app loop: per-desk advisory lock', () => {
  let sb: Switchboard;
  let other: DbHandle;
  let hireId: string;
  const db = () => sb.db.db;
  const tryLock = async (conn: postgres.Sql | postgres.ReservedSql) =>
    ((await conn`select pg_try_advisory_lock(hashtext('switchboard:desk'), hashtext(${hireId})) as ok`) as unknown as [{ ok: boolean }])[0].ok;
  const unlock = (conn: postgres.Sql | postgres.ReservedSql) => conn`select pg_advisory_unlock(hashtext('switchboard:desk'), hashtext(${hireId}))`;
  const emailEvent = async () => (await db().select().from(s.events).where(and(eq(s.events.hireId, hireId), eq(s.events.type, 'email.received'))))[0]!;

  beforeAll(async () => {
    other = createDb(process.env.DATABASE_URL, { max: 2 });
  });
  afterEach(async () => {
    await sb?.stop().catch(() => {});
  });
  afterAll(async () => other?.close());

  it('the lock is held for the whole turn (another session cannot take it) and released after', async () => {
    sb = await bootSwitchboard({ signalBackend: 'app', scriptedLatencyMs: 250 });
    hireId = await heroId(db());
    await beats(sb.services)[1]();
    // The run row is written after the lock is taken.
    for (let i = 0; i < 200 && !(await db().select().from(s.deskRuns).where(eq(s.deskRuns.hireId, hireId))).length; i++) await new Promise((r) => setTimeout(r, 10));
    const probe = await other.sql.reserve();
    try {
      expect(sb.router.backend.isIdle(hireId)).toBe(false);
      expect(await tryLock(probe)).toBe(false);
      await sb.router.idle(hireId);
      expect(await tryLock(probe)).toBe(true);
      await unlock(probe);
    } finally {
      probe.release();
    }
    expect((await emailEvent()).processedAt).not.toBeNull();
  });

  it('while another process holds the desk, the loop does not drain it: the events stay unprocessed for the owner', async () => {
    sb = await bootSwitchboard({ signalBackend: 'app', scriptedLatencyMs: 40 });
    hireId = await heroId(db());
    const holder = await other.sql.reserve();
    try {
      expect(await tryLock(holder)).toBe(true);
      const r = await beats(sb.services)[1]();
      expect(r.duplicate).toBe(false);
      await sb.router.idle(hireId);

      const ev = await emailEvent();
      expect(ev.processedAt).toBeNull();
      expect(ev.runId).toBeNull();
      expect(await db().select().from(s.deskRuns).where(eq(s.deskRuns.hireId, hireId))).toHaveLength(0);
      expect(await db().select().from(s.deskSteps).where(eq(s.deskSteps.hireId, hireId))).toHaveLength(0);
      const [desk] = await db().select().from(s.desks).where(eq(s.desks.hireId, hireId));
      expect(desk).toMatchObject({ runState: 'idle', activeRunId: null });
    } finally {
      await unlock(holder);
      holder.release();
    }

    // Once the other holder lets go, the leftover event is handed back and handled exactly once.
    expect(await sb.router.redeliverUnprocessed()).toBe(1);
    await sb.router.idle(hireId);
    const ev = await emailEvent();
    expect(ev.processedAt).not.toBeNull();
    expect(ev.runId).toMatch(/^app-/);
    expect(await db().select().from(s.deskRuns).where(eq(s.deskRuns.hireId, hireId))).toMatchObject([{ runId: ev.runId, state: 'completed', backend: 'app' }]);
  });

  it('if no connection can be reserved for the lock, the desk is not left "running" forever and nothing rejects unhandled', async () => {
    sb = await bootSwitchboard({ signalBackend: 'app', scriptedLatencyMs: 40 });
    hireId = await heroId(db());
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const broken = { reserve: () => Promise.reject(new Error('sorry, too many clients already')) } as unknown as postgres.Sql;
      const backend = new AppLoopBackend({ db: db(), sql: broken, mastra: () => sb.mastra, sweepCron: '0 7 * * *', sweepTimezone: 'Europe/London' });
      const target = await sb.router.target(hireId);
      const r = await backend.deliver({
        target,
        kind: 'message',
        ifActive: 'deliver',
        ifIdle: 'wake',
        signal: { tag: 'email', contents: 'Subject: x\n\nhello', attributes: { kind: 'email.received', hire: 'NH-5520' } },
        eventIds: [],
      });
      expect(r.outcome).toBe('delivered');
      for (let i = 0; i < 100 && !backend.isIdle(hireId); i++) await new Promise((res) => setTimeout(res, 10));
      await new Promise((res) => setTimeout(res, 50));
      expect(backend.isIdle(hireId)).toBe(true);
      expect(unhandled).toEqual([]);
      // The next delivery is not swallowed by a stuck "running" flag: it tries (and fails) to lock again.
      const again = await backend.deliver({
        target,
        kind: 'message',
        ifActive: 'deliver',
        ifIdle: 'wake',
        signal: { tag: 'email', contents: 'Subject: y\n\nhello again', attributes: { kind: 'email.received', hire: 'NH-5520' } },
        eventIds: [],
      });
      expect(again.outcome).toBe('delivered');
      await expect.poll(() => backend.isIdle(hireId), { timeout: 10_000 }).toBe(true);
      expect(unhandled).toEqual([]);
    } finally {
      await new Promise((res) => setTimeout(res, 50));
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
