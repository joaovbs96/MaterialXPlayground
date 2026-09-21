import { test, expect } from './lib/test-base.mjs';

// @scene: exercises the Performance/Default/Quality control added to
// js/usd-scene-app.jsx (SCENE_QUALITY_LEVELS, activeQualityPreset,
// applyQualityPreset, QualitySegments). PRESET_SETTINGS mirrors
// SCENE_QUALITY_LEVELS in js/usd-scene-app.jsx (not exposed on window for
// the test to read back at runtime) and must be updated together with it.
// default.subdivision tracks SCENE_SUBDIVISION_DEFAULT (currently 1);
// update it if that constant changes.
const PRESET_SETTINGS = {
  performance: { resolution: '512 px', memory: '1 GB', subdivision: 'Off', shadows: false, ao: false, skyVis: false, transparency: false },
  default: { resolution: '2048 px', memory: '1 GB', subdivision: '1', shadows: true, ao: true, skyVis: true, transparency: true },
  quality: { resolution: 'Original', memory: '4 GB', subdivision: '2', shadows: true, ao: true, skyVis: true, transparency: true },
};

function toolbarGroup(page) {
  return page.getByTestId('usd-scene-quality-toolbar');
}
function popoverGroup(page) {
  return page.getByTestId('usd-scene-quality-popover');
}

// The popover closes itself on any pointerdown outside it (js/usd-scene-app.jsx
// ~line 629), including a click on the toolbar quality segments or the load
// button. It stays mounted (hidden via CSS), so this must be called again
// before any click targeting something inside it.
async function openPopover(page) {
  const popover = page.getByTestId('usd-scene-render-settings-popover');
  if (!(await popover.isVisible().catch(() => false))) {
    await page.getByTestId('usd-scene-render-settings').click();
  }
  await expect(popover).toBeVisible();
  return popover;
}

// Clicking the toggle button while it is open closes it through its own
// handler, not the outside-pointerdown listener. Closing this way first
// avoids a race where a toolbar click's pointerdown fires that listener
// (closing the popover) a beat before the click itself is processed.
async function closePopover(page) {
  const popover = page.getByTestId('usd-scene-render-settings-popover');
  if (await popover.isVisible().catch(() => false)) {
    await page.getByTestId('usd-scene-render-settings').click();
    await expect(popover).toBeHidden();
  }
}

async function openTab(popover, name) {
  await popover.getByRole('button', { name, exact: true }).click();
}

// Selects and toggles are read the same way the existing Scene specs read
// them: by the row's own label text, walking up to the row that also holds
// the control.
async function readGeometrySelects(popover) {
  await openTab(popover, 'Geometry and Textures');
  const resolution = await popover.getByText('Texture resolution', { exact: true }).locator('../..').getByRole('combobox').textContent();
  const memory = await popover.getByText('Texture memory', { exact: true }).locator('../..').getByRole('combobox').textContent();
  const subdivision = await popover.getByText('Subdivision', { exact: true }).locator('../..').getByRole('combobox').textContent();
  return { resolution, memory, subdivision };
}

function toggleLocator(popover, label) {
  return popover.getByText(label, { exact: true }).locator('../..').getByRole('switch');
}

// Reads the switch's aria-checked directly: this does not require the
// popover to be visible, unlike a click.
async function readToggle(popover, label) {
  return (await toggleLocator(popover, label).getAttribute('aria-checked')) === 'true';
}

async function assertActivePreset(page, id) {
  for (const group of [toolbarGroup(page), popoverGroup(page)]) {
    for (const level of ['performance', 'default', 'quality']) {
      const button = group.getByTestId('usd-scene-quality-' + level);
      if (level === id) await expect(button).toHaveAttribute('data-active', 'true');
      else await expect(button).not.toHaveAttribute('data-active');
    }
  }
}

// Subdivision is the only governed setting that reloads the stage
// (js/usd-scene-app.jsx pickSubdivisionLevel). Call after any preset click
// whose subdivision differs from the one just active; other preset clicks
// do not reload at all, so this must also tolerate no reload happening.
async function waitForReload(page) {
  const status = page.getByTestId('usd-scene-status');
  const progress = page.getByTestId('usd-scene-progress');
  // Racing for either signal avoids missing a transient progress overlay
  // that appears and disappears between polls, and also avoids missing a
  // reload where the status flips away from 'rendered' without the
  // overlay ever being caught visible. If a click did not trigger a
  // reload, neither ever fires; the short timeout keeps that case cheap.
  await Promise.race([
    expect(progress).toBeVisible({ timeout: 5000 }),
    expect(status).not.toContainText('rendered', { timeout: 5000 }),
  ]).catch(() => {});
  await expect(status).toContainText('rendered', { timeout: 150000 });
}

test('@scene defaults the quality control to Default on a cleared profile', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await openPopover(page);
  await assertActivePreset(page, 'default');
});

test('@scene applies every governed setting for Performance and Quality', async ({ page, embedURL }) => {
  test.setTimeout(300000);
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  // Mounts the popover once up front: assertActivePreset reads the
  // popover's segmented group by test id, which does not exist in the DOM
  // until the popover has been opened at least once.
  await openPopover(page);
  await closePopover(page);
  // Load a stage first: applyQualityPreset's HDR presentation update
  // (js/usd-scene-app.jsx updatePresentation, ~line 1130) only takes
  // effect through a live scene handle, unlike every other governed
  // setting, which also has a local fallback for no stage loaded yet.
  await page.getByTestId('usd-scene-load-example').click();
  await waitForReload(page);

  await toolbarGroup(page).getByTestId('usd-scene-quality-performance').click();
  await waitForReload(page);
  await assertActivePreset(page, 'performance');
  let popover = await openPopover(page);
  const selects = await readGeometrySelects(popover);
  expect(selects).toEqual({ resolution: PRESET_SETTINGS.performance.resolution, memory: PRESET_SETTINGS.performance.memory, subdivision: PRESET_SETTINGS.performance.subdivision });
  await openTab(popover, 'Lighting');
  expect(await readToggle(popover, 'Shadows')).toBe(PRESET_SETTINGS.performance.shadows);
  expect(await readToggle(popover, 'Sky visibility')).toBe(PRESET_SETTINGS.performance.skyVis);
  await openTab(popover, 'Effects');
  expect(await readToggle(popover, 'Ambient occlusion')).toBe(PRESET_SETTINGS.performance.ao);
  expect(await readToggle(popover, 'Transparency')).toBe(PRESET_SETTINGS.performance.transparency);
  await closePopover(page);

  await toolbarGroup(page).getByTestId('usd-scene-quality-quality').click();
  await waitForReload(page);
  await assertActivePreset(page, 'quality');
  popover = await openPopover(page);
  const qualitySelects = await readGeometrySelects(popover);
  expect(qualitySelects).toEqual({ resolution: PRESET_SETTINGS.quality.resolution, memory: PRESET_SETTINGS.quality.memory, subdivision: PRESET_SETTINGS.quality.subdivision });
  await openTab(popover, 'Lighting');
  expect(await readToggle(popover, 'Shadows')).toBe(PRESET_SETTINGS.quality.shadows);
  expect(await readToggle(popover, 'Sky visibility')).toBe(PRESET_SETTINGS.quality.skyVis);
  await openTab(popover, 'Effects');
  expect(await readToggle(popover, 'Ambient occlusion')).toBe(PRESET_SETTINGS.quality.ao);
  expect(await readToggle(popover, 'Transparency')).toBe(PRESET_SETTINGS.quality.transparency);
});

test('@scene switches to Custom when one setting changes, and back when it reverts', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await openPopover(page);
  await closePopover(page);
  await page.getByTestId('usd-scene-load-example').click();
  await waitForReload(page);

  await toolbarGroup(page).getByTestId('usd-scene-quality-performance').click();
  await waitForReload(page);
  await assertActivePreset(page, 'performance');
  const popover = await openPopover(page);
  await openTab(popover, 'Lighting');
  const shadows = toggleLocator(popover, 'Shadows');
  await expect(shadows).toHaveAttribute('aria-checked', 'false');

  await shadows.click();
  await expect(shadows).toHaveAttribute('aria-checked', 'true');
  for (const group of [toolbarGroup(page), popoverGroup(page)]) {
    for (const level of ['performance', 'default', 'quality']) {
      await expect(group.getByTestId('usd-scene-quality-' + level)).not.toHaveAttribute('data-active');
    }
  }
  await expect(popover.getByText('Custom', { exact: true })).toBeVisible();

  await shadows.click();
  await expect(shadows).toHaveAttribute('aria-checked', 'false');
  await assertActivePreset(page, 'performance');
  await expect(popover.getByText('Custom', { exact: true })).toHaveCount(0);
});

test('@scene keeps the toolbar and popover quality controls in sync', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await openPopover(page);
  await closePopover(page);
  await page.getByTestId('usd-scene-load-example').click();
  await waitForReload(page);

  await toolbarGroup(page).getByTestId('usd-scene-quality-performance').click();
  await waitForReload(page);
  await assertActivePreset(page, 'performance');

  await openPopover(page);
  await popoverGroup(page).getByTestId('usd-scene-quality-default').click();
  await waitForReload(page);
  await assertActivePreset(page, 'default');
});

test('@scene disables both quality groups while a stage is loading', async ({ page, embedURL }) => {
  test.setTimeout(180000);
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await openPopover(page);

  await page.getByTestId('usd-scene-load-example').click();
  await expect(page.getByTestId('usd-scene-progress')).toBeVisible({ timeout: 30000 });
  for (const group of [toolbarGroup(page), popoverGroup(page)]) {
    for (const level of ['performance', 'default', 'quality']) {
      await expect(group.getByTestId('usd-scene-quality-' + level)).toBeDisabled();
    }
  }
  await waitForReload(page);
  for (const group of [toolbarGroup(page), popoverGroup(page)]) {
    for (const level of ['performance', 'default', 'quality']) {
      await expect(group.getByTestId('usd-scene-quality-' + level)).toBeEnabled();
    }
  }
});

test('@scene only reloads the stage when the preset changes subdivision', async ({ page, embedURL }) => {
  test.setTimeout(360000);
  await page.addInitScript(() => {
    let factory = null;
    window.__usdFactoryCalls = 0;
    Object.defineProperty(window, 'createMtlxSceneView', {
      configurable: true,
      get: () => factory,
      set: (next) => {
        factory = async (options) => {
          window.__usdFactoryCalls += 1;
          return next(options);
        };
      },
    });
  });
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();

  await page.getByTestId('usd-scene-load-example').click();
  await waitForReload(page);
  expect(await page.evaluate(() => window.__usdFactoryCalls)).toBe(1);

  // Manually match Quality's subdivision (2) without touching anything
  // else: the loaded stage started at Default's subdivision (1), so this
  // change alone must reload the stage.
  let popover = await openPopover(page);
  await openTab(popover, 'Geometry and Textures');
  const subdivisionSelect = popover.getByText('Subdivision', { exact: true }).locator('../..').getByRole('combobox');
  await subdivisionSelect.click();
  await page.getByRole('option', { name: '2', exact: true }).click();
  await waitForReload(page);
  expect(await page.evaluate(() => window.__usdFactoryCalls)).toBe(2);
  await closePopover(page);

  // Quality's subdivision (2) now already matches; only the other governed
  // settings change, so this must not trigger another reload.
  await toolbarGroup(page).getByTestId('usd-scene-quality-quality').click();
  await assertActivePreset(page, 'quality');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__usdFactoryCalls)).toBe(2);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered');

  // Performance's subdivision (0) differs from the current 2, so this
  // preset must reload.
  await toolbarGroup(page).getByTestId('usd-scene-quality-performance').click();
  await waitForReload(page);
  expect(await page.evaluate(() => window.__usdFactoryCalls)).toBe(3);
});
