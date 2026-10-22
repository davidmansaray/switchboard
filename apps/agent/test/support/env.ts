import { loadEnv } from '@switchboard/db';

await loadEnv();
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/switchboard_showcase_test';
process.env.MASTRA_DATABASE_URL = process.env.DATABASE_URL;
process.env.SWITCHBOARD_SKIP_BOOT = 'true';
process.env.INTERNAL_API_TOKEN = '';
