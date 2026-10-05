// tests/embed/theme-attribute.spec.mjs: the `theme` attribute (light | dark | auto | any registry id | a custom theme code)
// sets the iframe's data-theme, updates live without a reload, and never persists.

import {
  test, expect, gotoHarness, FIXTURE_MTLX_PATH,
  createViewer, waitForReady, setProp,
} from './lib/test-base.mjs';

async function open(page, embedURL, opts) {
  await gotoHarness(page, embedURL);
  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + FIXTURE_MTLX_PATH,
    geometry: 'sphere',
    eager: true,
    ...opts,
  });
  await waitForReady(page, idx);
  const handle = await page.evaluateHandle((i) => window.__viewers[i].shadowRoot.querySelector('iframe'), idx);
  const frame = await handle.asElement().contentFrame();
  expect(frame, 'embed iframe').toBeTruthy();
  return { idx, frame };
}

const dataTheme = (frame) => frame.evaluate(() => document.documentElement.dataset.theme);

test('theme="light" and theme="dark" set the iframe theme', async ({ page, embedURL }) => {
  for (const value of ['light', 'dark']) {
    const { frame } = await open(page, embedURL, { theme: value });
    expect(await dataTheme(frame)).toBe(value);
  }
});

test('theme accepts a registry id such as hc-dark', async ({ page, embedURL }) => {
  const { idx, frame } = await open(page, embedURL, { theme: 'hc-dark' });
  expect(await dataTheme(frame)).toBe('hc-dark');
  expect(await frame.evaluate(() => document.documentElement.dataset.themeBase)).toBe('dark');

  await setProp(page, idx, 'theme', 'light');
  await expect.poll(() => dataTheme(frame)).toBe('light');
  await setProp(page, idx, 'theme', 'hc-dark');
  await expect.poll(() => dataTheme(frame)).toBe('hc-dark');
  const surface = () => frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mtlx-surface-base').trim());
  expect(await surface()).toBe('0 0 0');
});

test('a preset set live loads its stylesheet and switches without a reload', async ({ page, embedURL }) => {
  const { idx, frame } = await open(page, embedURL, { theme: 'dark' });
  await frame.evaluate(() => { window.__themeMarker = 1; });
  await setProp(page, idx, 'theme', 'paper');
  await expect.poll(() => dataTheme(frame)).toBe('paper');
  expect(await frame.evaluate(() => document.documentElement.dataset.themeBase)).toBe('light');
  expect(await frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mtlx-surface-base').trim())).toBe('244 239 230');
  expect(await frame.evaluate(() => window.__themeMarker)).toBe(1);
});

test('theme defaults to dark (missing or invalid) whatever the OS scheme', async ({ page, embedURL }) => {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const opts of [{}, { theme: 'bogus' }, { theme: 'vscode' }]) {
      const { frame } = await open(page, embedURL, opts);
      expect(await dataTheme(frame)).toBe('dark');
    }
  }
});

test('theme="auto" follows the OS color scheme', async ({ page, embedURL }) => {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    const { frame } = await open(page, embedURL, { theme: 'auto' });
    expect(await dataTheme(frame)).toBe(scheme);
  }
});

test('changing theme live updates the iframe without reloading it', async ({ page, embedURL }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const { idx, frame } = await open(page, embedURL, { theme: 'dark' });
  await frame.evaluate(() => { window.__themeMarker = 1; });

  await setProp(page, idx, 'theme', 'light');
  await expect.poll(() => dataTheme(frame)).toBe('light');
  expect(await frame.evaluate(() => window.__themeMarker)).toBe(1);

  await setProp(page, idx, 'theme', 'auto');
  await expect.poll(() => dataTheme(frame)).toBe('dark');
  expect(await frame.evaluate(() => window.__themeMarker)).toBe(1);
});

test('theme accepts a custom theme code: decoded in the iframe, base on the placeholder, invalid is dark', async ({ page, embedURL }) => {
  // "Ocean": dark base, seeds #0b1d2a / #e6f1f8 / #2563eb (the docs/EMBEDDING.md example).
  const code = 'mtlx2.DAALHSrm8fglY-sFb2NlYW4FT2NlYW4A';
  await page.emulateMedia({ colorScheme: 'light' });
  const { idx, frame } = await open(page, embedURL, { theme: code });
  expect(await dataTheme(frame)).toBe('custom:ocean');
  expect(await frame.evaluate(() => document.documentElement.dataset.themeBase)).toBe('dark');
  const surface = () => frame.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mtlx-surface-base').trim());
  expect(await surface()).toBe('11 29 42');
  const phBg = () => page.evaluate((i) => getComputedStyle(window.__viewers[i]).getPropertyValue('--ph-bg').trim(), idx);
  expect(await phBg(), 'the placeholder reads the base from the code').toBe('#111827');

  await frame.evaluate(() => { window.__themeMarker = 1; });
  await setProp(page, idx, 'theme', 'mtlx2.not-a-real-code');
  await expect.poll(() => dataTheme(frame)).toBe('dark');
  await setProp(page, idx, 'theme', 'mtlx1.' + code.slice(6));
  await expect.poll(() => dataTheme(frame), 'a version 1 code is no longer accepted').toBe('dark');
  await setProp(page, idx, 'theme', code);
  await expect.poll(() => dataTheme(frame)).toBe('custom:ocean');
  expect(await frame.evaluate(() => window.__themeMarker)).toBe(1);
  expect(await frame.evaluate(() => [window.localStorage.getItem('mtlxCustomThemes'), window.localStorage.getItem('mtlxTheme')])).toEqual([null, null]);
});

test('theme accepts a code based on Paper: its exact colors, light base on the placeholder', async ({ page, embedURL }) => {
  // "Warm paper": based on paper with accent-fill overridden (the docs/EMBEDDING.md example).
  const code = 'mtlx2.LAVwYXBlcgR3YXJtCldhcm0gcGFwZXIBC2FjY2VudC1maWxstFMJ';
  await page.emulateMedia({ colorScheme: 'dark' });
  const { idx, frame } = await open(page, embedURL, { theme: code });
  expect(await dataTheme(frame)).toBe('custom:warm');
  expect(await frame.evaluate(() => document.documentElement.dataset.themeBase)).toBe('light');
  const token = (t) => frame.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue('--mtlx-' + n).trim(), t);
  expect(await token('surface-base'), 'Paper surface-base, not re-derived').toBe('244 239 230');
  expect(await token('accent-fill')).toBe('180 83 9');
  const phBg = () => page.evaluate((i) => getComputedStyle(window.__viewers[i]).getPropertyValue('--ph-bg').trim(), idx);
  expect(await phBg(), 'the placeholder reads the light base from the code').toBe('#f3f4f6');
  expect(await frame.evaluate(() => [window.localStorage.getItem('mtlxCustomThemes'), window.localStorage.getItem('mtlxTheme')])).toEqual([null, null]);
});

test('the embed never writes the theme preference to localStorage', async ({ page, embedURL }) => {
  const { idx, frame } = await open(page, embedURL, { theme: 'light' });
  await setProp(page, idx, 'theme', 'dark');
  await expect.poll(() => dataTheme(frame)).toBe('dark');
  expect(await frame.evaluate(() => window.localStorage.getItem('mtlxTheme'))).toBeNull();
});
