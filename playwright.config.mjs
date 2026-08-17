// playwright.config.mjs: embed viewer test suite (tests/embed/**).
// Chromium only, single worker: the embed is heavy (WASM engine
// load), so serializing keeps runs deterministic.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/embed',
  timeout: 120000,
  expect: { timeout: 30000 },
  retries: 1,
  workers: 1,
  reporter: 'list',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
