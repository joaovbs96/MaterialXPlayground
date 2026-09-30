// tests/embed/theme-attribute.spec.mjs: the `theme` attribute (light | dark | auto | any registry id)
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

test('the embed never writes the theme preference to localStorage', async ({ page, embedURL }) => {
  const { idx, frame } = await open(page, embedURL, { theme: 'light' });
  await setProp(page, idx, 'theme', 'dark');
  await expect.poll(() => dataTheme(frame)).toBe('dark');
  expect(await frame.evaluate(() => window.localStorage.getItem('mtlxTheme'))).toBeNull();
});
