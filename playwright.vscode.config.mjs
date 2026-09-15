// playwright.vscode.config.mjs: the VS Code webview simulation suite
// (tests/vscode/**), separate from playwright.config.mjs since it uses
// its own whitelist-only server modeling the packaged .vsix.

import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env.CI;

export default defineConfig({
  testDir: './tests/vscode',
  timeout: isCI ? 240000 : 120000,
  expect: { timeout: isCI ? 60000 : 30000 },
  retries: 1,
  workers: 1,
  reporter: 'list',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
