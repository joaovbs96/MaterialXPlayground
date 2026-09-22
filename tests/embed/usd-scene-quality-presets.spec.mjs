import { test, expect } from './lib/test-base.mjs';

// @scene: exercises the Performance/Default/Quality control in
// js/usd-scene-app.jsx (SCENE_QUALITY_LEVELS, the Render settings popover's
// segmented control, and the draft/Apply/Cancel/Reset dance). PRESET_SETTINGS
// mirrors SCENE_QUALITY_LEVELS (not exposed on window for the test to read
// back at runtime) and must be updated together with it. default.subdivision
// tracks SCENE_SUBDIVISION_DEFAULT (currently 0). The popover header is just
// "Preset" + the segmented control (no name/count pill); every other
// popover row is also governed (live sliders/selects included) and shares
// the same value on all three levels. Staged (non-live) rows wait for
// Apply; live rows are forced immediately by picking a level in the
// segmented control (stageQualityLevel calls forceLiveValue for every live
// key), same as Reset -- so no row shows a "differs from preset" dot right
// after a pick.
const PRESET_SETTINGS = {
  performance: { resolution: '512 px', memory: '1 GB', subdivision: 'Off', shadows: false, ao: false, skyVis: false, transparency: false },
  default: { resolution: '2048 px', memory: '1 GB', subdivision: 'Off', shadows: false, ao: false, skyVis: false, transparency: true },
  quality: { resolution: '4096 px', memory: '4 GB', subdivision: '2', shadows: true, ao: true, skyVis: true, transparency: true },
};

// The popover's three-way segmented control stages a draft; nothing
// reaches the renderer until the footer's Apply button is clicked (live
// keys are the exception, forced immediately on pick).
function popoverGroup(page) {
  return page.getByTestId('usd-scene-quality-popover');
}
async function stagePopoverQuality(popover, id) {
  await popoverGroup(popover.page()).getByTestId('usd-scene-quality-' + id).click();
}
function applyButton(popover) { return popover.getByTestId('usd-scene-quality-apply'); }
function cancelButton(popover) { return popover.getByTestId('usd-scene-quality-cancel'); }
function resetButton(popover) { return popover.getByTestId('usd-scene-quality-reset'); }

// Reads which of the three segments is currently active (data-active).
async function activeQualityId(popover) {
  const group = popoverGroup(popover.page());
  for (const id of ['performance', 'default', 'quality']) {
    if (await group.getByTestId('usd-scene-quality-' + id).getAttribute('data-active')) return id;
  }
  return null;
}

// Opens the popover (if not already), stages a level in the segmented
// control and applies it. Callers wait for a reload themselves when one
// is expected, same shape the old toolbar helper had.
async function applyQualityLevel(page, id) {
  const popover = await openPopover(page);
  await stagePopoverQuality(popover, id);
  await applyButton(popover).click();
  return popover;
}

// The popover closes itself on any pointerdown outside it (js/usd-scene-app.jsx),
// including a click on the load button. It stays mounted (hidden via CSS),
// so this must be called again before any click inside it.
async function openPopover(page) {
  const popover = page.getByTestId('usd-scene-render-settings-popover');
  if (!(await popover.isVisible().catch(() => false))) {
    await page.getByTestId('usd-scene-render-settings').click();
  }
  await expect(popover).toBeVisible();
  return popover;
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

async function waitForReload(page) {
  const status = page.getByTestId('usd-scene-status');
  const progress = page.getByTestId('usd-scene-progress');
  await Promise.race([
    expect(progress).toBeVisible({ timeout: 5000 }),
    expect(status).not.toContainText('rendered', { timeout: 5000 }),
  ]).catch(() => {});
  await expect(status).toContainText('rendered', { timeout: 150000 });
}

test('@scene defaults the popover quality control to Default on a cleared profile, with Reset and Apply disabled', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  const popover = await openPopover(page);
  await expect.poll(() => activeQualityId(popover)).toBe('default');
  // Zero dots on a fresh profile: Reset's predicate is the exact same one
  // the per-row dots use, so if either is dirty here they have diverged.
  await expect(resetButton(popover)).toBeDisabled();
  await expect(applyButton(popover)).toBeDisabled();
});

test('@scene Reset and Apply stay disabled right after picking a preset and right after Apply', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-load-example').click();
  await waitForReload(page);

  const popover = await openPopover(page);
  await stagePopoverQuality(popover, 'performance');
  await expect(resetButton(popover)).toBeDisabled();
  await applyButton(popover).click();
  await waitForReload(page);
  await expect(resetButton(popover)).toBeDisabled();
  await expect(applyButton(popover)).toBeDisabled();
});

test('@scene applies every governed setting from the popover Apply', async ({ page, embedURL }) => {
  test.setTimeout(300000);
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-load-example').click();
  await waitForReload(page);

  await applyQualityLevel(page, 'performance');
  await waitForReload(page);
  let popover = await openPopover(page);
  await expect.poll(() => activeQualityId(popover)).toBe('performance');
  const selects = await readGeometrySelects(popover);
  expect(selects).toEqual({ resolution: PRESET_SETTINGS.performance.resolution, memory: PRESET_SETTINGS.performance.memory, subdivision: PRESET_SETTINGS.performance.subdivision });
  await openTab(popover, 'Lighting');
  expect(await readToggle(popover, 'Shadows')).toBe(PRESET_SETTINGS.performance.shadows);
  expect(await readToggle(popover, 'Sky visibility')).toBe(PRESET_SETTINGS.performance.skyVis);
  await openTab(popover, 'Effects');
  expect(await readToggle(popover, 'Ambient occlusion')).toBe(PRESET_SETTINGS.performance.ao);
  expect(await readToggle(popover, 'Transparency')).toBe(PRESET_SETTINGS.performance.transparency);
  // The popover's own draft matches Performance's values already; apply is a no-op here.
  await expect(applyButton(popover)).toBeDisabled();
  await cancelButton(popover).click();

  await applyQualityLevel(page, 'quality');
  await waitForReload(page);
  popover = await openPopover(page);
  await expect.poll(() => activeQualityId(popover)).toBe('quality');
  const qualitySelects = await readGeometrySelects(popover);
  expect(qualitySelects).toEqual({ resolution: PRESET_SETTINGS.quality.resolution, memory: PRESET_SETTINGS.quality.memory, subdivision: PRESET_SETTINGS.quality.subdivision });
  await openTab(popover, 'Lighting');
  expect(await readToggle(popover, 'Shadows')).toBe(PRESET_SETTINGS.quality.shadows);
  expect(await readToggle(popover, 'Sky visibility')).toBe(PRESET_SETTINGS.quality.skyVis);
  await openTab(popover, 'Effects');
  expect(await readToggle(popover, 'Ambient occlusion')).toBe(PRESET_SETTINGS.quality.ao);
  expect(await readToggle(popover, 'Transparency')).toBe(PRESET_SETTINGS.quality.transparency);
});

test('@scene stages popover changes until Apply, and Cancel discards them', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-load-example').click();
  await waitForReload(page);

  const popover = await openPopover(page);
  await openTab(popover, 'Lighting');
  const shadows = toggleLocator(popover, 'Shadows');
  await expect(shadows).toHaveAttribute('aria-checked', 'false');

  // Toggling a staged row flips the draft switch immediately but must not
  // touch the live renderer: the footer names the pending change (no header
  // pill anymore).
  await shadows.click();
  await expect(shadows).toHaveAttribute('aria-checked', 'true');
  await expect(popover.getByText(/change/)).toBeVisible();
  await expect(applyButton(popover)).toBeEnabled();

  // Cancel restores the row and closes the popover; nothing was ever sent
  // to the renderer, so there is nothing to reload.
  await cancelButton(popover).click();
  await expect(popover).toBeHidden();
  const reopened = await openPopover(page);
  await openTab(reopened, 'Lighting');
  await expect(toggleLocator(reopened, 'Shadows')).toHaveAttribute('aria-checked', 'false');
});

test('@scene applies a staged draft and Reset returns it to the selected level', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-load-example').click();
  await waitForReload(page);

  const popover = await openPopover(page);
  await openTab(popover, 'Lighting');
  const shadows = toggleLocator(popover, 'Shadows');
  await shadows.click();
  await expect(resetButton(popover)).toBeEnabled();

  await resetButton(popover).click();
  await expect(shadows).toHaveAttribute('aria-checked', 'false');
  await expect(applyButton(popover)).toBeDisabled();

  await shadows.click();
  await applyButton(popover).click();
  await expect.poll(() => page.getByTestId('usd-scene-status').textContent()).toContain('rendered');
  await expect(shadows).toHaveAttribute('aria-checked', 'true');
  await expect(applyButton(popover)).toBeDisabled();
});

test('@scene shows an unapplied-changes marker while a draft differs from current', async ({ page, embedURL }) => {
  test.setTimeout(180000);
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-load-example').click();
  await waitForReload(page);

  const popover = await openPopover(page);
  await openTab(popover, 'Lighting');
  await toggleLocator(popover, 'Shadows').click();
  // Closing any other way (not Cancel) keeps the draft.
  await page.getByTestId('usd-scene-render-settings').click();
  await expect(popover).toBeHidden();
  await expect(page.getByTitle('Unapplied changes')).toBeVisible();
});

test('@scene moving a live slider away from the level applies immediately, and Reset moves it back', async ({ page, embedURL }) => {
  test.setTimeout(180000);
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-load-example').click();
  await waitForReload(page);

  const popover = await openPopover(page);
  await openTab(popover, 'Effects');
  const aoSlider = popover.getByText('Ambient occlusion strength', { exact: true }).locator('../..').getByRole('slider');
  const defaultValue = await aoSlider.inputValue();
  await aoSlider.fill('0.1');
  // A live key, so it applies immediately (no Apply needed).
  await expect(aoSlider).toHaveValue('0.1');
  await expect(resetButton(popover)).toBeEnabled();

  await resetButton(popover).click();
  await expect(aoSlider).toHaveValue(defaultValue);
});

test('@scene keeps the same draft and dots across a plain close and reopen, and Cancel still reverts to session start', async ({ page, embedURL }) => {
  test.setTimeout(180000);
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-load-example').click();
  await waitForReload(page);

  let popover = await openPopover(page);
  await openTab(popover, 'Lighting');
  await toggleLocator(popover, 'Shadows').click();
  // Escape closes without applying, cancelling or resetting anything.
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();

  popover = await openPopover(page);
  await openTab(popover, 'Lighting');
  await expect(toggleLocator(popover, 'Shadows')).toHaveAttribute('aria-checked', 'true');
  await expect(applyButton(popover)).toBeEnabled();

  // Cancel restores the value from when this editing session began (the
  // first open above), not from this second open.
  await cancelButton(popover).click();
  popover = await openPopover(page);
  await openTab(popover, 'Lighting');
  await expect(toggleLocator(popover, 'Shadows')).toHaveAttribute('aria-checked', 'false');
});

test('@scene reloads the stage when the applied preset changes subdivision or triangle limits', async ({ page, embedURL }) => {
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

  // Quality differs from Default on subdivision (2 vs 0): must reload.
  await applyQualityLevel(page, 'quality');
  await waitForReload(page);
  expect(await page.evaluate(() => window.__usdFactoryCalls)).toBe(2);

  // Quality also differs from Performance on triangleLimits (false vs
  // true), with subdivision going 2 -> 0 at the same time; still one reload.
  await applyQualityLevel(page, 'performance');
  await waitForReload(page);
  expect(await page.evaluate(() => window.__usdFactoryCalls)).toBe(3);

  // Back to Default: subdivision (0) already matches Performance's, and
  // triangleLimits does not change either (both true); textureMaxSize and
  // specularAA do change but only rebuild, no reload expected.
  await applyQualityLevel(page, 'default');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => window.__usdFactoryCalls)).toBe(3);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered');
});

test('@scene Apply with no scene loaded only persists settings, never reloads or shows Applying', async ({ page, embedURL }) => {
  test.setTimeout(180000);
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

  const popover = await openPopover(page);
  await openTab(popover, 'Lighting');
  const shadows = toggleLocator(popover, 'Shadows');
  await shadows.click();
  // Footer names the no-scene-loaded sentence, not a reload/rebuild verb.
  await expect(popover.getByText('Applies when a scene is loaded')).toBeVisible();

  await applyButton(popover).click();
  // Never shows "Applying ...": there is nothing to apply against.
  await expect(popover.getByText(/^Applying /)).toHaveCount(0);
  await expect(applyButton(popover)).toBeDisabled();
  expect(await page.evaluate(() => window.__usdFactoryCalls)).toBe(0);

  // The persisted value is what the next load reads: loading a scene now
  // comes up with Shadows already on, no extra Apply needed.
  await page.getByTestId('usd-scene-load-example').click();
  await waitForReload(page);
  expect(await page.evaluate(() => window.__usdFactoryCalls)).toBe(1);
  const reopened = await openPopover(page);
  await openTab(reopened, 'Lighting');
  await expect(toggleLocator(reopened, 'Shadows')).toHaveAttribute('aria-checked', 'true');
});
