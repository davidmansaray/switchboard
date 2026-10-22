import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb, resetData, schema as s, type DbHandle } from '../src';
import { resetDatabase } from '../src/reset';

let h: DbHandle;
beforeAll(async () => {
  await resetDatabase(process.env.DATABASE_URL!);
  h = createDb(process.env.DATABASE_URL!, { max: 2 });
});
afterAll(async () => h?.close());

it('preserves the current scenario if reseeding fails after truncation', async () => {
  const staff = await h.db.select().from(s.staff).orderBy(s.staff.id);
  const hires = await h.db.select().from(s.hires).orderBy(s.hires.id);
  await h.db.execute(sql`
    create function app.reject_test_seed() returns trigger language plpgsql as $$
    begin raise exception 'injected seed failure'; end;
    $$`);
  await h.db.execute(sql`
    create trigger reject_test_seed before insert on app.staff
    for each row execute function app.reject_test_seed()`);
  try {
    await expect(resetData(h.db)).rejects.toThrow();
    expect(await h.db.select().from(s.staff).orderBy(s.staff.id)).toEqual(staff);
    expect(await h.db.select().from(s.hires).orderBy(s.hires.id)).toEqual(hires);
  } finally {
    await h.db.execute(sql`drop trigger reject_test_seed on app.staff`);
    await h.db.execute(sql`drop function app.reject_test_seed()`);
  }
});

it('publishes a complete seeded morning with all three historical revisions', async () => {
  const { heroHireId } = await resetData(h.db);
  const [hire] = await h.db.select().from(s.hires).where(eq(s.hires.id, heroHireId));
  expect(hire).toMatchObject({ version: 3, status: 'confirmed', deliverySlot: 'AM', damageWaiver: true });
  const versions = await h.db.select().from(s.hireVersions)
    .where(eq(s.hireVersions.hireId, heroHireId)).orderBy(s.hireVersions.version);
  expect(versions.map((v) => v.version)).toEqual([1, 2, 3]);
  expect(versions.map((v) => (v.snapshot as { damageWaiver: boolean }).damageWaiver)).toEqual([false, false, true]);
  expect(await h.db.select().from(s.staff)).toHaveLength(4);
});
