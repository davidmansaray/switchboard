#!/usr/bin/env node
/** Provision only dedicated local showcase databases; never reset existing tables. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = {};
for (const file of ['.env', '.env.local']) {
  const path = resolve(root, file);
  if (!existsSync(path)) continue;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
Object.assign(env, process.env);
const urls = new Set([
  env.DATABASE_URL ?? 'postgres://localhost:5432/switchboard_showcase_dev',
  env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/switchboard_showcase_test',
  env.E2E_DATABASE_URL ?? 'postgres://localhost:5432/switchboard_showcase_e2e',
]);
for (const value of urls) {
  const url = new URL(value);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^switchboard_showcase_[a-z0-9_]+$/.test(database)) {
    throw new Error('db:create only provisions local switchboard_showcase_* databases. Provision other installations separately.');
  }
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const exists = execFileSync('psql', [admin.href, '-Atc', `select 1 from pg_database where datname = '${database}'`]).toString().trim();
  if (!exists) execFileSync('psql', [admin.href, '-v', 'ON_ERROR_STOP=1', '-qc', `create database "${database}"`]);
  execFileSync('psql', [url.href, '-v', 'ON_ERROR_STOP=1', '-qc', 'create extension if not exists vector; create extension if not exists pg_trgm; create extension if not exists pgcrypto;']);
  console.log(`${database}: ready`);
}
