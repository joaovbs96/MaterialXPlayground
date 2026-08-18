// playwright.config.mjs: embed viewer test suite (tests/embed/**).
// Chromium only, single worker: the embed is heavy (WASM engine
// load), so serializing keeps runs deterministic.
//
// Two tiers: `npm run test:embed:smoke` runs just @smoke (one boot);
// `npm run test:embed` runs the full suite. CI runs only the smoke
// tier per PR; the full suite is local/workflow_dispatch only.

import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/embed',
  // CI runs WebGL in software and is much slower than local; double
  // the budgets there so every spec gets headroom, not just the ones
  // we've already seen time out.
  timeout: isCI ? 240000 : 120000,
  expect: { timeout: isCI ? 60000 : 30000 },
  retries: 1,
  workers: 1,
  reporter: 'list',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
