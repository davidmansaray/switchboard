import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, HERO_REF, schema as s, withActor, type DbHandle } from '../src';
import { resetDatabase } from '../src/reset';

/** M1: version triggers, snapshots/diffs, staleness and NOTIFY. */
describe('db triggers', () => {
  let h: DbHandle;
  let hireId: string;
  const url = process.env.DATABASE_URL!;
  const hire = async () => (await h.db.select().from(s.hires).where(eq(s.hires.id, hireId)))[0]!;

  beforeAll(async () => {
    const r = await resetDatabase(url);
    hireId = r.heroHireId;
    h = createDb(url, { max: 3 });
  });
  afterAll(async () => h?.close());

  it('seeds NH-5520 at v3 with history and 6 desks', async () => {
    expect((await hire()).version).toBe(3);
    const versions = await h.db.select().from(s.hireVersions).where(eq(s.hireVersions.hireId, hireId));
    expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(Object.keys((versions[0]!.snapshot as { lines: object }).lines)).toEqual(['1', '2']);
    expect(await h.db.select().from(s.desks)).toHaveLength(6);
    expect((await h.db.select().from(s.drafts)).map((d) => d.ref)).toEqual(['D-31']);
  });

  it('several statements in one transaction make one version, with a diff and the actor', async () => {
    await withActor(h.db, 'jo', async (tx) => {
      await tx.update(s.hires).set({ deliveryDate: '2026-11-04' }).where(eq(s.hires.id, hireId));
      await tx.update(s.hireLines).set({ model: 'Manitou MT 1840' }).where(and(eq(s.hireLines.hireId, hireId), eq(s.hireLines.lineNo, 2)));
    });
    expect((await hire()).version).toBe(4);
    const [v4] = await h.db.select().from(s.hireVersions).where(and(eq(s.hireVersions.hireId, hireId), eq(s.hireVersions.version, 4)));
    expect(v4!.changedBy).toBe('jo');
    expect(v4!.diff).toEqual([
      { path: 'deliveryDate', from: '2026-11-02', to: '2026-11-04' },
      { path: 'lines.2.model', from: 'Manitou MT 1440', to: 'Manitou MT 1840' },
    ]);
  });

  it('no-op updates do not bump the version', async () => {
    await withActor(h.db, 'jo', (tx) => tx.update(s.hires).set({ deliveryDate: '2026-11-04' }).where(eq(s.hires.id, hireId)));
    expect((await hire()).version).toBe(4);
  });

  it('material changes mark pending drafts stale; routine-tier changes do not', async () => {
    const [d] = await h.db
      .insert(s.drafts)
      .values({ hireId, kind: 'bundle', title: 't', payload: {}, basedOnVersion: 4, actionKey: 'test:stale' })
      .returning();
    expect(d!.ref).toBe('D-7');
    await withActor(h.db, 'agent:desk', (tx) => tx.update(s.hires).set({ poNumber: 'PO-1' }).where(eq(s.hires.id, hireId)));
    expect((await hire()).version).toBe(5);
    expect((await h.db.select().from(s.drafts).where(eq(s.drafts.id, d!.id)))[0]!.status).toBe('pending');
    await withActor(h.db, 'jo', (tx) => tx.update(s.hires).set({ deliverySlot: 'PM' }).where(eq(s.hires.id, hireId)));
    const [after] = await h.db.select().from(s.drafts).where(eq(s.drafts.id, d!.id));
    expect(after).toMatchObject({ status: 'stale', staleReason: 'hire moved v4 → v6' });
  });

  it('a line change on its own makes a version; every auto-tier field leaves drafts alone, a line status does not', async () => {
    const v0 = (await hire()).version;
    const [d] = await h.db
      .insert(s.drafts)
      .values({ hireId, kind: 'bundle', title: 't', payload: {}, basedOnVersion: v0, actionKey: 'test:line-stale' })
      .returning();
    const [contact] = await h.db.select().from(s.contacts).limit(1);
    await withActor(h.db, 'agent:desk', (tx) => tx.update(s.hires).set({ invoiceAddress: 'Somewhere else', siteContactId: contact!.id }).where(eq(s.hires.id, hireId)));
    expect((await hire()).version).toBe(v0 + 1);
    expect((await h.db.select().from(s.drafts).where(eq(s.drafts.id, d!.id)))[0]!.status).toBe('pending');

    await withActor(h.db, 'jo', (tx) => tx.update(s.hireLines).set({ status: 'cancelled' }).where(and(eq(s.hireLines.hireId, hireId), eq(s.hireLines.lineNo, 2))));
    expect((await hire()).version).toBe(v0 + 2);
    const [v] = await h.db.select().from(s.hireVersions).where(and(eq(s.hireVersions.hireId, hireId), eq(s.hireVersions.version, v0 + 2)));
    expect(v!.changedBy).toBe('jo');
    expect(v!.diff).toEqual([{ path: 'lines.2.status', from: 'booked', to: 'cancelled' }]);
    expect((await h.db.select().from(s.drafts).where(eq(s.drafts.id, d!.id)))[0]).toMatchObject({ status: 'stale', staleReason: `hire moved v${v0} → v${v0 + 2}` });
  });

  it('NOTIFY carries table, op and hire id', async () => {
    const got: string[] = [];
    const listener = await h.sql.listen('switchboard', (p) => got.push(p));
    await h.db.insert(s.events).values({ hireId, type: 'note.created', source: 'staff', payload: {} });
    for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 20));
    await listener.unlisten();
    expect(JSON.parse(got[0]!)).toMatchObject({ table: 'events', op: 'INSERT', hireId });
  });

  it('agent_actions are unique per (hire, action_key)', async () => {
    await h.db.insert(s.agentActions).values({ hireId, actionKey: 'k', tool: 't', result: {} });
    await expect(h.db.insert(s.agentActions).values({ hireId, actionKey: 'k', tool: 't', result: {} })).rejects.toThrow();
    const [{ n }] = (await h.db.execute(sql`select count(*)::int as n from app.agent_actions where action_key = 'k'`)) as unknown as [{ n: number }];
    expect(n).toBe(1);
    expect(HERO_REF).toBe('NH-5520');
  });
});
