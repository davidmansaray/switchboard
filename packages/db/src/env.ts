import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Load `.env.local` then `.env` from the repo root (first value wins), for scripts and tests. */
export async function loadEnv(): Promise<void> {
  const root = findRoot(dirname(fileURLToPath(import.meta.url)));
  // Deployed services get env from the platform; dotenv is only a local convenience.
  const { config } = await import('dotenv').catch(() => ({ config: undefined }));
  if (!config) return;
  for (const f of ['.env.local', '.env']) {
    const p = resolve(root, f);
    if (existsSync(/*turbopackIgnore: true*/ p)) config({ path: p, quiet: true });
  }
}

function findRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(/*turbopackIgnore: true*/ resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return start;
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (see .env.example)');
  return url;
}
