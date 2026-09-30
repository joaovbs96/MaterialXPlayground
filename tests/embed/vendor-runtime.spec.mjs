// tests/embed/vendor-runtime.spec.mjs: MtlxVendor.url/load/has against the
// synthetic fixture deps in tests/embed/fixtures/vendor-runtime/. Boots no
// WASM, so it is tagged @smoke.

import { test, expect } from './lib/test-base.mjs';

const FIXTURE_PATH = '/tests/embed/fixtures/vendor-runtime/index.html';

test.describe('@smoke vendor-runtime', () => {
  test('url, load and has behave per kind, retry, and host gating', async ({ page, embedURL }) => {
    await page.goto(embedURL + FIXTURE_PATH);

    // url() resolves under the fixture's <base href="nested/">.
    const esmUrl = await page.evaluate(() => window.MtlxVendor.url('esmdep', 'module.js'));
    expect(esmUrl).toBe(embedURL + '/tests/embed/fixtures/vendor-runtime/nested/vendor/esm-fake/module.js');

    expect(await page.evaluate(() => window.MtlxVendor.has('esmdep'))).toBe(true);
    expect(await page.evaluate(() => window.MtlxVendor.has('nope'))).toBe(false);
    await expect(page.evaluate(() => window.MtlxVendor.url('nope', 'x'))).rejects.toThrow(
      'unknown vendor dependency "nope"'
    );

    // emscripten-esm: locateFile joins against the dep's own dir.
    const emResult = await page.evaluate(() => window.MtlxVendor.load('emscripten'));
    expect(emResult.answer).toBe(42);
    expect(emResult.dataText.trim()).toBe('fake-data-contents');
    expect(emResult.dataUrl.endsWith('/vendor/emscripten-fake/fake.data')).toBe(true);

    // esm: resolves to the module namespace.
    const esmNs = await page.evaluate(() => window.MtlxVendor.load('esmdep'));
    expect(esmNs.value).toBe('esm-value');

    // script: injects a classic <script>, resolves the declared global.
    const scriptGlobal = await page.evaluate(() => window.MtlxVendor.load('scriptdep'));
    expect(scriptGlobal.value).toBe('script-value');
    // The injected <script> tag is removed once it settles, success or not.
    expect(await page.evaluate(() => document.querySelectorAll('script[src*="script-fake"]').length)).toBe(0);

    // Second load() returns the same cached promise.
    const same = await page.evaluate(async () => {
      const p1 = window.MtlxVendor.load('esmdep');
      const p2 = window.MtlxVendor.load('esmdep');
      return p1 === p2;
    });
    expect(same).toBe(true);

    // A missing entry rejects; fixing the entry and retrying then succeeds.
    await expect(page.evaluate(() => window.MtlxVendor.load('fixabledep'))).rejects.toThrow();
    await page.evaluate(() => { window.MTLX_VENDOR_DEPS.fixabledep.module.entry = 'module.js'; });
    const fixed = await page.evaluate(() => window.MtlxVendor.load('fixabledep'));
    expect(fixed.value).toBe('script-value');

    // No module field: rejects with a clear message.
    await expect(page.evaluate(() => window.MtlxVendor.load('nomoduledep'))).rejects.toThrow(
      'no module entry'
    );

    // vscode: false while __MTLX_VSCODE__ is set: rejects, never loads.
    await page.evaluate(() => { window.__MTLX_VSCODE__ = true; });
    await expect(page.evaluate(() => window.MtlxVendor.load('vscodedep'))).rejects.toThrow(
      'not packaged in the VS Code extension'
    );
  });
});
