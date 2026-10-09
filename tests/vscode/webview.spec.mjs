// tests/vscode/webview.spec.mjs: catches "Failed to load this view" (a
// file missing from the vsix, or blocked by CSP) via a whitelist server
// plus a substituted webview.html with a fake acquireVsCodeApi().

import { test as base, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startWhitelistServer, getPackagedFileSet } from './lib/server.mjs';
import { substitutePlaceholders, installFakeVsCodeApi } from './lib/harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WEBVIEW_PATH = '/vscode_extension/media/webview.html';

const test = base.extend({
  vsixFiles: [async ({}, use) => {
    const files = getPackagedFileSet({ repoRoot: REPO_ROOT, spawnSyncFn: spawnSync });
    await use(files);
  }, { scope: 'worker' }],

  vscodeServer: [async ({ vsixFiles }, use) => {
    const { baseURL, close } = await startWhitelistServer({ root: REPO_ROOT, allowedFiles: vsixFiles });
    await use(baseURL);
    await close();
  }, { scope: 'worker' }],
});

const TEMPLATE = fs.readFileSync(path.join(REPO_ROOT, 'vscode_extension', 'media', 'webview.html'), 'utf8');

// Routes the webview.html request to a substituted copy, placeholders
// pinned to this harness server's own origin (a real webview uses a
// vscode-webview:// origin instead; only the same-origin relationship matters here).
async function routeWebview(page, baseURL, { initialHash, docsOnly }) {
  const html = substitutePlaceholders(TEMPLATE, {
    cspSource: baseURL,
    baseUri: baseURL + '/',
    bootstrapUri: baseURL + '/vscode_extension/media/bootstrap.js',
    initialHash,
    docsOnly,
    extensionVersion: 'test',
    vscodeVersion: 'test',
  });
  await page.route(baseURL + WEBVIEW_PATH + '**', (route) => {
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
  });
}

/** Boots the synthesized webview for one view and returns collected
 * diagnostics: console errors, page errors, and failed/missing (404)
 * requests for script/style/document resources. */
async function bootWebview(page, baseURL, { initialHash, docsOnly, globalName }) {
  const consoleErrors = [];
  const pageErrors = [];
  const badResponses = [];
  const embedRequests = [];

  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('request', (req) => {
    if (/\/embed\//.test(req.url())) embedRequests.push(req.url());
  });
  page.on('requestfailed', (req) => {
    badResponses.push(`${req.url()} - ${req.failure()?.errorText || 'failed'}`);
  });
  page.on('response', (res) => {
    const url = res.url();
    if (res.status() === 404 && /\.(js|css|html|wasm|data)(\?|$)/.test(url)) {
      badResponses.push(`${url} - HTTP ${res.status()}`);
    }
  });

  await page.addInitScript(installFakeVsCodeApi);
  await routeWebview(page, baseURL, { initialHash, docsOnly });
  await page.goto(baseURL + WEBVIEW_PATH);

  // Success: window[globalName] defined, the same condition
  // js/shell.jsx's loadViewDeps() itself requires before marking a view
  // "ready". Failure: ViewErrorBoundary's "Failed to load this view" text.
  const outcome = await Promise.race([
    page.waitForFunction((name) => !!window[name], globalName, { timeout: 45000 }).then(() => 'ready'),
    page.getByText('Failed to load this view', { exact: false }).waitFor({ timeout: 45000 }).then(() => 'error'),
  ]).catch(() => 'timeout');

  let errorText = null;
  if (outcome === 'error') {
    errorText = await page.getByText('Failed to load this view', { exact: false }).first().textContent();
  }

  return { outcome, errorText, consoleErrors, pageErrors, badResponses, embedRequests };
}

test.describe('VS Code webview simulation', () => {
  test('Graph Editor view boots without requesting embed/ (not packaged)', async ({ page, vscodeServer }) => {
    const result = await bootWebview(page, vscodeServer, {
      initialHash: '#!graph',
      docsOnly: false,
      globalName: 'NodeGraphApp',
    });
    expect(result.errorText, 'Graph Editor view failed to load').toBeNull();
    expect(result.outcome, `Graph Editor view never reached ready (console: ${result.consoleErrors.join(' | ')})`).toBe('ready');
    expect(result.badResponses, 'requests for a packaged file must not fail/404').toEqual([]);
    expect(result.embedRequests, 'the webview must skip embed/ (unshipped, unused there)').toEqual([]);
    const cspViolations = result.consoleErrors.filter((t) => /Content Security Policy/i.test(t));
    expect(cspViolations, 'CSP must not block anything the webview needs').toEqual([]);
    expect(result.pageErrors).toEqual([]);
  });

  // The worker runs from a blob: URL here, which cannot resolve MaterialX's relative paths.
  test('Graph Editor node thumbnails render in the webview worker', async ({ page, vscodeServer }) => {
    await page.addInitScript(() => { try { localStorage.setItem('mtlxGraphThumbnails', 'true'); } catch (e) { /* storage blocked */ } });
    const result = await bootWebview(page, vscodeServer, { initialHash: '#!graph', docsOnly: false, globalName: 'NodeGraphApp' });
    expect(result.outcome).toBe('ready');
    await page.waitForFunction(() => typeof window.parseMtlxDocument === 'function', null, { timeout: 45000 });
    const xml = '<?xml version="1.0"?><materialx version="1.39"><constant name="c1" type="color3"><input name="value" type="color3" value="1, 0, 0" /></constant></materialx>';
    await page.evaluate((x) => window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: { xml: x, name: 'thumbs' } })), xml);
    const thumb = page.locator('.react-flow__node[data-id="n:c1"] [data-mtlx-thumb]');
    await expect(thumb).toHaveAttribute('data-mtlx-thumb', 'ready', { timeout: 60000 });
  });

  test('Viewer view boots', async ({ page, vscodeServer }) => {
    const result = await bootWebview(page, vscodeServer, {
      initialHash: '#!viewer',
      docsOnly: false,
      globalName: 'MaterialViewerApp',
    });
    expect(result.errorText).toBeNull();
    expect(result.outcome, `Viewer view never reached ready (console: ${result.consoleErrors.join(' | ')})`).toBe('ready');
    expect(result.badResponses).toEqual([]);
    const cspViolations = result.consoleErrors.filter((t) => /Content Security Policy/i.test(t));
    expect(cspViolations).toEqual([]);
    expect(result.pageErrors).toEqual([]);
  });

  test('Viewer canvas fills its pane at several pane sizes', async ({ page, vscodeServer }) => {
    await page.setViewportSize({ width: 776, height: 700 });
    await bootWebview(page, vscodeServer, { initialHash: '#!viewer', docsOnly: false, globalName: 'MaterialViewerApp' });
    await page.waitForSelector('canvas', { timeout: 30000 });
    for (const [w, h] of [[776, 700], [541, 776], [388, 500], [1082, 719]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(1500);
      await expect.poll(() => page.evaluate(() => {
        const c = document.querySelector('canvas');
        const b = c.getBoundingClientRect();
        const p = c.parentElement.getBoundingClientRect();
        return b.width === p.width && b.height === p.height && p.height > 0.5 * window.innerHeight ? 'fill' : JSON.stringify({ b: [b.width, b.height], p: [p.width, p.height] });
      })).toBe('fill');
    }
  });

  test('Docs (standalone node-documentation) panel boots', async ({ page, vscodeServer }) => {
    const result = await bootWebview(page, vscodeServer, {
      initialHash: '#!docs',
      docsOnly: true,
      globalName: 'App',
    });
    expect(result.errorText).toBeNull();
    expect(result.outcome, `Docs view never reached ready (console: ${result.consoleErrors.join(' | ')})`).toBe('ready');
    expect(result.badResponses).toEqual([]);
    const cspViolations = result.consoleErrors.filter((t) => /Content Security Policy/i.test(t));
    expect(cspViolations).toEqual([]);
    expect(result.pageErrors).toEqual([]);
  });
});
