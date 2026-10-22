#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, '.env.local');
if (existsSync(target)) {
  console.log('.env.local already exists; left unchanged.');
  process.exit(0);
}

let text = readFileSync(resolve(root, '.env.example'), 'utf8');
const values = {
  SESSION_SECRET: randomBytes(32).toString('hex'),
  INTERNAL_API_TOKEN: randomBytes(32).toString('hex'),
  // Controls for the isolated synthetic local story only.
  ALLOW_CRASH_ENDPOINT: 'true',
  ALLOW_SCENARIO_RESET: 'true',
  LLM_MODE: 'scripted',
};
for (const [key, value] of Object.entries(values)) {
  text = text.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
}
writeFileSync(target, text, { flag: 'wx', mode: 0o600 });
console.log('Created local showcase configuration with random secrets and synthetic demo controls.');
console.log('Run pnpm db:create and pnpm db:reset next. No database was changed by this command.');
