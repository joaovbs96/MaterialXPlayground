// tests/embed/boot.spec.mjs, a plain hand-written iframe: viewer.html
// must post `ready` once the engine loads, echoing the query string.

import { test, expect, gotoHarness, createRawIframe, waitForMsg, getMsgs } from './lib/test-base.mjs';

test('iframe posts ready with a version and echoes the search string', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  await createRawIframe(page, embedURL + '/embed/viewer.html?geometry=sphere');
  await waitForMsg(page, 'mtlx-embed:ready', 60000);

  const [ready] = await getMsgs(page, 'mtlx-embed:ready');
  expect(ready.data.version).not.toBeNull();
  expect(typeof ready.data.version).toBe('string');
  expect(ready.data.search).toBe('?geometry=sphere');
});
