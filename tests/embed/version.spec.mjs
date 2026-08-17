// tests/embed/version.spec.mjs: ?version=1.39.4 selects a non-default
// MaterialX WASM build. js/materialx/1.39.4/ is gitignored, so this
// test skips cleanly when it isn't present on disk.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  test, expect, gotoHarness,
  createRawIframe, waitForMsg, getMsgs,
} from './lib/test-base.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION_DIR = path.resolve(__dirname, '..', '..', 'js', 'materialx', '1.39.4');

test('?version=1.39.4 reaches ready with no version-related mtlx-error', async ({ page, embedURL }) => {
  test.skip(!fs.existsSync(VERSION_DIR), 'js/materialx/1.39.4 not on disk (gitignored, run npm run vendor first)');

  await gotoHarness(page, embedURL);
  await createRawIframe(page, embedURL + '/embed/viewer.html?geometry=sphere&version=1.39.4');
  await waitForMsg(page, 'mtlx-embed:ready', 60000);

  // Grace period: an invalid `version` is reported synchronously,
  // around when `ready` fires, so this window would still catch it.
  await page.waitForTimeout(500);

  const errors = await getMsgs(page, 'mtlx-embed:error');
  const versionErrors = errors.filter((e) => /version/i.test(e.data.message || ''));
  expect(versionErrors).toEqual([]);
});
