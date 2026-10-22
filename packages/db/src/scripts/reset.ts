import { loadEnv } from '../env';

await loadEnv();
const { resetDatabase } = await import('../reset');
const r = await resetDatabase();
console.log(`reset + seeded: ${Object.keys(r.hireIds).length} hires (hero ${r.heroHireId})`);
