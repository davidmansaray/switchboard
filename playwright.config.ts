import { defineConfig } from '@playwright/test';

/**
 * E2E: the hero story through the UI against a running stack. `pnpm e2e` (scripts/e2e.mjs) starts
 * a production build on its own ports and database for each SIGNAL_BACKEND and runs this suite;
 * `E2E_BASE_URL=http://localhost:3103 pnpm exec playwright test` runs it against `pnpm dev`.
 * Uses the installed Google Chrome (channel: 'chrome'): no Playwright browser download.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 8 * 60_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3123',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
