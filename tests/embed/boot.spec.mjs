// tests/embed/boot.spec.mjs, a plain hand-written iframe: viewer.html
// must post `ready` once the engine loads, echoing the query string.

import { test, expect, gotoHarness, createRawIframe, waitForMsg, getMsgs } from './lib/test-base.mjs';

test('iframe posts ready with a version and echoes the search string', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const requests = [];
  page.on('request', (req) => requests.push(req.url()));

  await createRawIframe(page, embedURL + '/embed/viewer.html?geometry=sphere');
  await waitForMsg(page, 'mtlx-embed:ready', 60000);

  const [ready] = await getMsgs(page, 'mtlx-embed:ready');
  expect(ready.data.version).not.toBeNull();
  expect(typeof ready.data.version).toBe('string');
  expect(ready.data.search).toBe('?geometry=sphere');

  // A bare boot (no src=) must never reach GitHub for the default
  // material: materials/open_pbr_default.mtlx (repo root) is served
  // locally, so the raw.githubusercontent.com fallback is never hit.
  const githubRequests = requests.filter((u) => u.includes('raw.githubusercontent.com'));
  expect(githubRequests).toEqual([]);
});
