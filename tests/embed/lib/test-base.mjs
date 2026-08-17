// tests/embed/lib/test-base.mjs: shared Playwright `test`/`expect`,
// worker-scoped `embedURL`/`cleanUrlsURL` server fixtures, and DOM
// helpers addressing elements via window.__viewers[i], not JSHandles.

import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export const HARNESS_PATH = '/tests/embed/fixtures/harness.html';
export const FIXTURE_MTLX_PATH = '/tests/embed/fixtures/multi-material.mtlx';

/** Reads tests/embed/fixtures/multi-material.mtlx's raw text, for
 * tests that pass it directly to el.load() instead of via `src`. */
export function readMultiMaterialXml() {
  return fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'multi-material.mtlx'), 'utf8');
}

export const test = base.extend({
  // The repo-root static server every test navigates against.
  embedURL: [async ({}, use) => {
    const { baseURL: url, close } = await startServer({ root: REPO_ROOT });
    await use(url);
    await close();
  }, { scope: 'worker' }],

  // Simulates a serve/Vercel cleanUrls host, for the dropped-params test.
  cleanUrlsURL: [async ({}, use) => {
    const { baseURL: url, close } = await startServer({ root: REPO_ROOT, cleanUrls: true });
    await use(url);
    await close();
  }, { scope: 'worker' }],
});

export { expect };

/** Navigates to the shared test harness page on the given server origin. */
export async function gotoHarness(page, embedURL) {
  await page.goto(embedURL + HARNESS_PATH);
}

/** Creates a <materialx-viewer> on the harness page and returns its
 * index into window.__viewers. */
export async function createViewer(page, attrs) {
  return page.evaluate((attrs) => window.createViewer(attrs), attrs);
}

/** Creates a hand-written <iframe src=...> and returns its index into
 * window.__iframes. */
export async function createRawIframe(page, src) {
  return page.evaluate((src) => window.createRawIframe(src), src);
}

export async function waitForReady(page, idx, timeout = 45000) {
  await page.waitForFunction(
    (i) => window.__viewers[i].__events.some((e) => e.type === 'mtlx-ready'),
    idx,
    { timeout }
  );
}

export async function waitForEventCount(page, idx, type, count, timeout = 45000) {
  await page.waitForFunction(
    ({ i, type, count }) => window.__viewers[i].__events.filter((e) => e.type === type).length >= count,
    { i: idx, type, count },
    { timeout }
  );
}

export async function getEvents(page, idx, type) {
  return page.evaluate(
    ({ i, type }) => window.__viewers[i].__events.filter((e) => !type || e.type === type),
    { i: idx, type: type || null }
  );
}

export async function getProp(page, idx, prop) {
  return page.evaluate(({ i, prop }) => window.__viewers[i][prop], { i: idx, prop });
}

export async function setProp(page, idx, name, value) {
  return page.evaluate(({ i, name, value }) => { window.__viewers[i][name] = value; }, { i: idx, name, value });
}

/** Calls el.load(xml) and reports the outcome instead of letting a
 * rejection cross the page.evaluate() boundary as a thrown error. */
export async function callLoad(page, idx, xml) {
  return page.evaluate(async ({ i, xml }) => {
    const el = window.__viewers[i];
    try {
      const renderables = await el.load(xml);
      return { ok: true, renderables };
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) };
    }
  }, { i: idx, xml });
}

export async function getCamera(page, idx) {
  return page.evaluate((i) => window.__viewers[i].getCamera(), idx);
}

export async function setCamera(page, idx, pose) {
  return page.evaluate(({ i, pose }) => window.__viewers[i].setCamera(pose), { i: idx, pose });
}

export async function waitForMsg(page, type, timeout = 45000) {
  await page.waitForFunction((type) => window.__msgs.some((m) => m.type === type), type, { timeout });
}

export async function getMsgs(page, type) {
  return page.evaluate((type) => window.__msgs.filter((m) => m.type === type), type);
}
