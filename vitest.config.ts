import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/core/test/**/*.test.ts', 'apps/agent/test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/db/test/**/*.test.ts', 'apps/agent/test/integration/**/*.test.ts'],
          environment: 'node',
          // One shared test database: files run one at a time, each in a fresh process
          // (Mastra keeps process-level durable-run registries; instances must not share one).
          fileParallelism: false,
          pool: 'forks',
          isolate: true,
          testTimeout: 90_000,
          hookTimeout: 90_000,
          setupFiles: ['apps/agent/test/support/env.ts'],
        },
      },
      {
        test: {
          name: 'evals',
          include: ['apps/agent/test/evals/**/*.eval.test.ts'],
          environment: 'node',
          fileParallelism: false,
          pool: 'forks',
          isolate: true,
          testTimeout: 120_000,
          hookTimeout: 240_000,
          setupFiles: ['apps/agent/test/support/env.ts'],
        },
      },
    ],
  },
});
