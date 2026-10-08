// tests/embed/gallery-overlay.spec.mjs: the gallery detail overlay's scrim
// starts exactly at the header's bottom edge and the viewer survives reopen.
// The manifest is built at deploy time, so it is mocked here.
import fs from 'node:fs';
import { test, expect } from './lib/test-base.mjs';

const MANIFEST = {
  version: 1,
  source: { tag: 'v1.39.5' },
  materials: [{
    id: 'fixture-glass', name: 'Fixture Glass', family: 'other', familyLabel: 'Other',
    shader: 'standard_surface', tags: [], renderables: ['glass'], textured: false, origin: 'playground',
    docPath: 'tests/embed/fixtures/glass.mtlx', thumb: '',
  }],
};

// Header bottom, published CSS var and the overlay's top, in one read.
async function measure(page) {
  return page.evaluate(() => {
    const header = document.querySelector('.mtlx-header').getBoundingClientRect();
    const overlay = document.querySelector('[data-testid="gallery-overlay"]');
    const r = overlay.getBoundingClientRect();
    const cssVar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mtlx-header-h'));
    return { headerBottom: header.bottom, cssVar, overlayTop: r.top, overlayLeft: r.left, overlayRight: r.right, vw: window.innerWidth };
  });
}

for (const width of [1440, 820]) {
  test(`gallery overlay starts at the header bottom at ${width}px`, async ({ page, embedURL }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/gallery/manifest.json', (route) => route.fulfill({ json: MANIFEST }));
    await page.goto(embedURL + '/index.html#!gallery');
    await page.getByTitle('Fixture Glass').click();
    await expect(page.locator('[data-testid="gallery-overlay"]')).toBeVisible();
    const m = await measure(page);
    test.info().annotations.push({ type: 'measure', description: JSON.stringify(m) });
    if (process.env.GALLERY_SHOT) await page.screenshot({ path: process.env.GALLERY_SHOT + '-' + width + '.png' });
    expect(Math.abs(m.overlayTop - m.headerBottom)).toBeLessThanOrEqual(1);
    expect(Math.abs(m.cssVar - m.headerBottom)).toBeLessThanOrEqual(1);
    // The scrim spans the full window width, not the scroll wrapper's.
    expect(m.overlayLeft).toBeLessThanOrEqual(0);
    expect(m.overlayRight).toBeGreaterThanOrEqual(m.vw);
    expect(errors).toEqual([]);
  });
}

test('gallery overlay keeps the same viewer element across close and reopen', async ({ page, embedURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/gallery/manifest.json', (route) => route.fulfill({ json: MANIFEST }));
  await page.goto(embedURL + '/index.html#!gallery');
  await page.getByTitle('Fixture Glass').click();
  const viewer = page.locator('[data-testid="gallery-overlay"] materialx-viewer');
  await expect(viewer).toBeAttached({ timeout: 60000 });
  await page.evaluate(() => {
    window.__galleryViewerEl = document.querySelector('[data-testid="gallery-overlay"] materialx-viewer');
  });
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="gallery-overlay"]')).toBeHidden();
  await page.getByTitle('Fixture Glass').click();
  await expect(page.locator('[data-testid="gallery-overlay"]')).toBeVisible();
  const same = await page.evaluate(
    () => window.__galleryViewerEl === document.querySelector('[data-testid="gallery-overlay"] materialx-viewer')
      && window.__galleryViewerEl.isConnected);
  expect(same).toBe(true);
});
