import { loadEnv } from '../env';

await loadEnv();
const { createDb } = await import('../client');
const { seed } = await import('../seed');
const h = createDb();
try {
  const r = await seed(h.db);
  console.log(`seeded ${Object.keys(r.hireIds).length} hires`);
} finally {
  await h.close();
}
