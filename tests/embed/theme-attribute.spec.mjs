// tests/embed/theme-attribute.spec.mjs: the `theme` attribute (light | dark | auto)
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

test('theme auto (default and invalid) follows the OS color scheme', async ({ page, embedURL }) => {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const opts of [{}, { theme: 'auto' }, { theme: 'bogus' }]) {
      const { frame } = await open(page, embedURL, opts);
      expect(await dataTheme(frame)).toBe(scheme);
    }
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
