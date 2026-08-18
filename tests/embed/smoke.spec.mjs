// tests/embed/smoke.spec.mjs: fast CI-tier check, one engine boot.
// The full suite (protocol/textures/envmap/etc, `npm run test:embed`)
// is local/workflow_dispatch only; see playwright.config.mjs's header.

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, waitForEventCount, getEvents,
} from './lib/test-base.mjs';

test('@smoke eager viewer boots, lists renderables, stays hermetic and error-free', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const requests = [];
  page.on('request', (req) => requests.push(req.url()));

  // Iframe console output surfaces on the parent `page` object in
  // Playwright, so this also catches errors logged inside the embed.
  const consoleErrors = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    eager: true,
  });

  await waitForReady(page, idx);
  const [ready] = await getEvents(page, idx, 'mtlx-ready');
  expect(ready.detail.version).not.toBeNull();

  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  const [renderables] = await getEvents(page, idx, 'mtlx-renderables');
  expect(renderables.detail.map((r) => r.name).sort()).toEqual(['MatA', 'MatB']);

  await page.waitForTimeout(300); // beat for any late mtlx-error/console message to land

  const errors = await getEvents(page, idx, 'mtlx-error');
  expect(errors).toEqual([]);

  const githubRequests = requests.filter((u) => u.includes('raw.githubusercontent.com'));
  expect(githubRequests).toEqual([]);

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
