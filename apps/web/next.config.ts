import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The env files live at the repo root (shared with the agent service); Next only looks in apps/web.
loadEnvConfig(resolve(dirname(fileURLToPath(import.meta.url)), '../..'), process.env.NODE_ENV !== 'production');

const config: NextConfig = {
  transpilePackages: ['@switchboard/core', '@switchboard/db'],
  serverExternalPackages: ['postgres'],
  typedRoutes: false,
  poweredByHeader: false,
  devIndicators: false,
};

export default config;
