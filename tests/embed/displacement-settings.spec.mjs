// tests/embed/displacement-settings.spec.mjs: the global Displacement and
// preview Subdivision settings (js/mtlx-engine.js), same URL-seeds/persist/
// dispatch contract as Force Transparency, plus pickSubdivisionLevel.

import { test, expect } from './lib/test-base.mjs';

const INDEX_PATH = '/index.html';

async function waitForEngine(page) {
  await page.waitForFunction(() => typeof window.getDisplacementEnabled === 'function');
}

test('defaults: displacement on, subdivision 2, with empty storage', async ({ page, embedURL }) => {
  await page.goto(embedURL + INDEX_PATH);
  await waitForEngine(page);

  const result = await page.evaluate(() => ({
    displacement: window.getDisplacementEnabled(),
    subdivision: window.getPreviewSubdivisionLevel(),
    displacementStorage: localStorage.getItem('mtlxDisplacement'),
    subdivisionStorage: localStorage.getItem('mtlxPreviewSubdivision'),
  }));

  expect(result.displacement).toBe(true);
  expect(result.subdivision).toBe(2);
  expect(result.displacementStorage).toBeNull();
  expect(result.subdivisionStorage).toBeNull();
});

test('URL query seeds both settings without writing storage', async ({ page, embedURL }) => {
  await page.goto(embedURL + INDEX_PATH + '?displacement=0&previewsubdivision=3');
  await waitForEngine(page);

  const result = await page.evaluate(() => ({
    displacement: window.getDisplacementEnabled(),
    subdivision: window.getPreviewSubdivisionLevel(),
    displacementStorage: localStorage.getItem('mtlxDisplacement'),
    subdivisionStorage: localStorage.getItem('mtlxPreviewSubdivision'),
  }));

  expect(result.displacement).toBe(false);
  expect(result.subdivision).toBe(3);
  expect(result.displacementStorage).toBeNull();
  expect(result.subdivisionStorage).toBeNull();
});

test('top-level setters persist and dispatch mtlx-settings-changed', async ({ page, embedURL }) => {
  await page.goto(embedURL + INDEX_PATH);
  await waitForEngine(page);

  const result = await page.evaluate(() => {
    const events = [];
    window.addEventListener('mtlx-settings-changed', (e) => {
      events.push({ key: e.detail.key, value: e.detail.value });
    });
    window.setDisplacementEnabled(false);
    window.setPreviewSubdivisionLevel(1);
    return {
      events,
      displacement: window.getDisplacementEnabled(),
      subdivision: window.getPreviewSubdivisionLevel(),
      displacementStorage: localStorage.getItem('mtlxDisplacement'),
      subdivisionStorage: localStorage.getItem('mtlxPreviewSubdivision'),
    };
  });

  expect(result.displacement).toBe(false);
  expect(result.subdivision).toBe(1);
  expect(result.displacementStorage).toBe('0');
  expect(result.subdivisionStorage).toBe('1');
  expect(result.events).toContainEqual({ key: 'displacement', value: false });
  expect(result.events).toContainEqual({ key: 'previewSubdivision', value: 1 });
});

test('setting the same value again still dispatches the event', async ({ page, embedURL }) => {
  await page.goto(embedURL + INDEX_PATH);
  await waitForEngine(page);

  const count = await page.evaluate(() => {
    let n = 0;
    window.addEventListener('mtlx-settings-changed', (e) => { if (e.detail.key === 'displacement') n++; });
    window.setDisplacementEnabled(true);
    window.setDisplacementEnabled(true);
    return n;
  });

  expect(count).toBe(2);
});

test('setters inside a same-origin iframe do not write shared storage', async ({ page, embedURL }) => {
  await page.goto(embedURL + INDEX_PATH);
  await waitForEngine(page);

  await page.evaluate((src) => {
    const f = document.createElement('iframe');
    f.src = src;
    document.body.appendChild(f);
  }, embedURL + INDEX_PATH);

  const iframeElement = await page.waitForSelector('iframe');
  const frame = await iframeElement.contentFrame();
  await frame.waitForFunction(() => typeof window.getDisplacementEnabled === 'function');

  await frame.evaluate(() => {
    window.setDisplacementEnabled(false);
    window.setPreviewSubdivisionLevel(0);
  });

  const topStorage = await page.evaluate(() => ({
    displacement: localStorage.getItem('mtlxDisplacement'),
    subdivision: localStorage.getItem('mtlxPreviewSubdivision'),
  }));
  const frameStorage = await frame.evaluate(() => ({
    displacement: localStorage.getItem('mtlxDisplacement'),
    subdivision: localStorage.getItem('mtlxPreviewSubdivision'),
  }));

  expect(topStorage.displacement).toBeNull();
  expect(topStorage.subdivision).toBeNull();
  expect(frameStorage.displacement).toBeNull();
  expect(frameStorage.subdivision).toBeNull();

  // The in-frame value still updates locally, only persistence is skipped.
  const frameValue = await frame.evaluate(() => window.getDisplacementEnabled());
  expect(frameValue).toBe(false);
});

test.describe('pickSubdivisionLevel triangle budget', () => {
  test('stays uncapped when the requested level fits the budget', async ({ page, embedURL }) => {
    await page.goto(embedURL + INDEX_PATH);
    await waitForEngine(page);
    const result = await page.evaluate(() => window.pickSubdivisionLevel(88264, 2, 1500000));
    expect(result.level).toBe(2);
    expect(result.capped).toBe(false);
  });

  test('caps below the requested level when it would exceed the budget', async ({ page, embedURL }) => {
    await page.goto(embedURL + INDEX_PATH);
    await waitForEngine(page);
    const result = await page.evaluate(() => window.pickSubdivisionLevel(88264, 3));
    expect(result.level).toBe(2);
    expect(result.capped).toBe(true);
  });

  test('always allows level 0 even when the base mesh alone exceeds the budget', async ({ page, embedURL }) => {
    await page.goto(embedURL + INDEX_PATH);
    await waitForEngine(page);
    const result = await page.evaluate(() => window.pickSubdivisionLevel(2000000, 1));
    expect(result.level).toBe(0);
    expect(result.capped).toBe(true);
  });
});
