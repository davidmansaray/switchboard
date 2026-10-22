import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  schemaFilter: ['app'],
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/switchboard_showcase_dev' },
  migrations: { schema: 'app', table: '__migrations' },
});
