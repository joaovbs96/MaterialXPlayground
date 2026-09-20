// tests/embed/displacement-settings.spec.mjs: the global Displacement and
// preview Subdivision settings (js/mtlx-engine.js), same URL-seeds/persist/
// dispatch contract as Force Transparency, plus pickSubdivisionLevel.
// P6: the Settings dialog's Displacement/Subdivision rows on the real
// #!viewer, driving the live view handle end to end.

import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

const INDEX_PATH = '/index.html';

// Uniform 0.1 offset along the normal (0.2 displacement * 0.5 scale),
// same fixture shape as displacement-view.spec.mjs's SCALE_A_MTLX.
const DISPLACED_MTLX = `<?xml version="1.0"?>
<materialx version="1.39">
  <standard_surface name="surf" type="surfaceshader" />
  <displacement name="disp" type="displacementshader">
    <input name="displacement" type="float" value="0.2" />
    <input name="scale" type="float" value="0.5" />
  </displacement>
  <surfacematerial name="mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surf" />
    <input name="displacementshader" type="displacementshader" nodename="disp" />
  </surfacematerial>
</materialx>`;

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

// #!viewer's browser layout keeps Settings' only content (Force
// Transparency, and now Displacement/Subdivision) inline in the sidebar's
// always-open Rendering card instead of behind the cog: viewer-app.jsx
// passes `showSettings={IN_VSCODE}` to ViewportControls, so the cog/
// SettingsDialog popover never mounts in a plain browser tab. These tests
// drive that real, always-visible sidebar surface instead of a dialog that
// does not exist on this route in this mode.
test.describe('Rendering card Displacement/Subdivision rows (#!viewer)', () => {
  // Each test gets a fresh browser context (Playwright default), so the
  // module-level settings start at their documented defaults every time.
  async function gotoViewerWithMaterial(page, embedURL) {
    await page.goto(embedURL + INDEX_PATH + '#!viewer');
    await waitForEngine(page);
    // The Viewer also kicks off its own default-material fetch on mount;
    // waiting for that first build to land before dispatching our own
    // document avoids a load race where whichever finishes LAST wins
    // (both funnel through the same session-replacing ingest()).
    await page.waitForFunction(() => !!window.__mtlxViewerHandle, null, { timeout: WAIT_TIMEOUT });
    await page.evaluate((xml) => {
      window.dispatchEvent(new CustomEvent('mtlx-view-document', {
        detail: { xml, name: 'p6-displaced', files: {} },
      }));
    }, DISPLACED_MTLX);
    await expect(page.getByText('p6-displaced.mtlx', { exact: false }).first()).toBeVisible({ timeout: WAIT_TIMEOUT });
    await page.waitForFunction(
      () => window.__mtlxViewerHandle && window.__mtlxViewerHandle.getDisplacementState().mode === 'float',
      null, { timeout: WAIT_TIMEOUT }
    );
    await page.evaluate(() => window.__mtlxViewerHandle.whenDisplacementSettled());
  }

  test('the Displacement/Subdivision rows render without horizontal overflow at 1280x720', async ({ page, embedURL }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await gotoViewerWithMaterial(page, embedURL);
    const dispRow = page.getByText('Displacement', { exact: true }).locator('xpath=ancestor::div[1]');
    await expect(dispRow).toBeVisible();
    const box = await dispRow.boundingBox();
    expect(box).toBeTruthy();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1280);
  });

  test('toggling the Displacement row flips the setting and the live view state', async ({ page, embedURL }) => {
    await gotoViewerWithMaterial(page, embedURL);

    const dispToggle = page.getByText('Displacement', { exact: true }).locator('xpath=following-sibling::button');
    await dispToggle.click();

    expect(await page.evaluate(() => window.getDisplacementEnabled())).toBe(false);
    await page.evaluate(() => window.__mtlxViewerHandle.whenDisplacementSettled());
    const state = await page.evaluate(() => window.__mtlxViewerHandle.getDisplacementState());
    expect(state.state).toBe('off');
  });

  test('changing Subdivision to 1 re-settles the live view at level 1', async ({ page, embedURL }) => {
    await gotoViewerWithMaterial(page, embedURL);

    const subdivRow = page.getByText('Subdivision', { exact: true }).locator('xpath=ancestor::div[1]');
    await subdivRow.getByRole('combobox').click();
    await page.getByRole('option', { name: '1', exact: true }).click();

    expect(await page.evaluate(() => window.getPreviewSubdivisionLevel())).toBe(1);
    await page.evaluate(() => window.__mtlxViewerHandle.whenDisplacementSettled());
    const state = await page.evaluate(() => window.__mtlxViewerHandle.getDisplacementState());
    expect(state.level).toBe(1);
  });
});

// The cog + SettingsDialog popover itself (with DisplacementSettingsRows)
// IS always visible in the Graph Editor's live preview panel (no sidebar
// substitute there), so the popover-sizing acceptance check runs against
// that route instead of #!viewer.
test.describe('SettingsDialog popover sizing (#!graph preview)', () => {
  test('the Settings popover fits the 1280x720 viewport', async ({ page, embedURL }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(embedURL + INDEX_PATH + '#!graph');
    await page.waitForSelector('.gtb-bar', { timeout: WAIT_TIMEOUT });
    await page.waitForFunction(() => typeof window.parseMtlxDocument === 'function', null, { timeout: WAIT_TIMEOUT });
    await page.evaluate((xml) => {
      window.dispatchEvent(new CustomEvent('mtlx-load-document', {
        detail: { xml, name: 'p6-displaced', files: {} },
      }));
    }, DISPLACED_MTLX);

    const settingsBtn = page.getByTitle('Settings');
    await settingsBtn.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    await settingsBtn.click();

    const dialog = page.getByText('Displacement', { exact: true }).locator('xpath=ancestor::div[4]');
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).toBeTruthy();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1280);
    expect(box.y + box.height).toBeLessThanOrEqual(720);
  });
});

// Compound Compile wraps the previewed surface shader in a transient node that
// no material references; the preview must still find the material's displacement.
const COMPOUND_DISPLACED_MTLX = `<?xml version="1.0"?>
<materialx version="1.39">
  <constant name="tint" type="color3"><input name="value" type="color3" value="0.8, 0.4, 0.2" /></constant>
  <standard_surface name="surf" type="surfaceshader"><input name="base_color" type="color3" nodename="tint" /></standard_surface>
  <displacement name="disp" type="displacementshader"><input name="displacement" type="float" value="0.15" /></displacement>
  <surfacematerial name="mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surf" />
    <input name="displacementshader" type="displacementshader" nodename="disp" />
  </surfacematerial>
</materialx>`;

test('Graph Editor preview applies displacement with Compound Compile on', async ({ page, embedURL }) => {
  await page.addInitScript(() => {
    try { localStorage.setItem('mtlx_graph_preview_compound', '1'); } catch (e) { /* storage blocked */ }
    window.__dispEvents = [];
    window.addEventListener('mtlx-displacement-status', (e) => { window.__dispEvents.push((e.detail || {}).state); });
  });
  await page.goto(embedURL + INDEX_PATH + '#!graph');
  await page.waitForSelector('.gtb-bar', { timeout: WAIT_TIMEOUT });
  await page.waitForFunction(() => typeof window.parseMtlxDocument === 'function', null, { timeout: WAIT_TIMEOUT });
  await page.evaluate((xml) => {
    window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: { xml, name: 'compound-displaced', files: {} } }));
  }, COMPOUND_DISPLACED_MTLX);
  await page.getByTitle('Settings').waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
  await page.waitForTimeout(8000);
  // The first build displaces before the view handle exists, so toggle to make
  // the live preview re-resolve its displacement and report the result.
  await page.evaluate(() => { window.__dispEvents.length = 0; window.setDisplacementEnabled(false, { persist: false }); });
  await page.waitForTimeout(1000);
  await page.evaluate(() => window.setDisplacementEnabled(true, { persist: false }));
  await expect.poll(() => page.evaluate(() => window.__dispEvents.slice()), { timeout: WAIT_TIMEOUT }).toContain('applied');
});
