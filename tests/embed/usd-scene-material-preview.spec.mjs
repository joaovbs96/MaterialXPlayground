import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene');
function fixtureFile(relativePath) {
  return { name: relativePath, mimeType: 'text/plain', buffer: fs.readFileSync(path.join(fixtureRoot, relativePath)) };
}
// Minimal valid 1x1 PNG, reused for both texture stand-ins (pixel content
// is irrelevant here, only the file's presence and name are checked).
const ONE_PX_PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000a4944415478da6360000002000155e621bc0000000049454e44ae426082', 'hex');

// @scene: double-clicking a mesh in the Scene viewport opens its material's
// graph + shaderball preview panel. Uses the same nested reference fixture
// as usd-scene.spec.mjs.
test('@scene opens a material preview panel on double-click', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-load-example').click();
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });

  // A single-material mesh: QuadWithSubset/Quad splits one bounding box
  // across two materials right at its centre, so a bbox-centre pick there
  // is ambiguous by a sub-pixel rounding difference between calls.
  const meshPath = '/Scene/RootTransform/NestedAsset/SharedMaterialTriangle/Triangle';
  const canvas = page.getByTestId('usd-scene-canvas').locator('canvas');
  const canvasBox = await canvas.boundingBox();

  const point = await page.evaluate((path) => {
    const handle = window.__mtlxUsdSceneHandle;
    const mesh = handle.selectPrim(path);
    if (!mesh) return null;
    const box = new window.THREE.Box3().setFromObject(mesh);
    const center = box.getCenter(new window.THREE.Vector3());
    const ndc = center.clone().project(handle.camera);
    const rect = handle.renderer ? handle.renderer.domElement.getBoundingClientRect() : null;
    return { ndc: { x: ndc.x, y: ndc.y }, rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null };
  }, meshPath);
  expect(point).toBeTruthy();
  const rect = point.rect || { left: canvasBox.x, top: canvasBox.y, width: canvasBox.width, height: canvasBox.height };
  const x = rect.left + (point.ndc.x * 0.5 + 0.5) * rect.width;
  const y = rect.top + (-point.ndc.y * 0.5 + 0.5) * rect.height;

  // The graph node's label is the raw MaterialX element name (e.g.
  // "red_material"), not the USD-facing materialName ("RedMaterial") shown
  // in the panel header, so pull it straight from the same document.
  const graphNodeName = await page.evaluate((clientPoint) => {
    const handle = window.__mtlxUsdSceneHandle;
    const hit = handle.pickAt(clientPoint.x, clientPoint.y);
    const doc = hit && handle.getMaterialDocument(hit.materialPath);
    const match = doc && doc.xml.match(/<surfacematerial\s+name="([^"]+)"/);
    return match ? match[1] : null;
  }, { x, y });
  expect(graphNodeName).toBeTruthy();

  // Watch for a second <materialx-viewer> ever being mounted for the
  // preview, and record the first 'mtlx-renderables' event it fires.
  await page.evaluate(() => {
    window.__previewRenderablesEvents = [];
    window.__previewViewerCount = 0;
    const attach = (el) => {
      if (el.tagName !== 'MATERIALX-VIEWER') return;
      window.__previewViewerCount += 1;
      el.addEventListener('mtlx-renderables', (e) => {
        window.__previewRenderablesEvents.push(Array.isArray(e.detail) ? e.detail.length : 0);
      });
    };
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          attach(node);
          node.querySelectorAll && node.querySelectorAll('materialx-viewer').forEach(attach);
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__previewObserver = observer;
  });

  await page.mouse.dblclick(x, y);

  const panel = page.getByTestId('usd-scene-material-preview');
  await expect(panel).toBeVisible({ timeout: 15000 });
  await expect(panel).toContainText(/\S/, { timeout: 15000 });
  await expect(panel.locator('.react-flow__node').first()).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => window.__previewRenderablesEvents.length), { timeout: 30000 }).toBeGreaterThan(0);
  // The shaderball column must actually be expanded (not collapsed to the
  // chevron chip), so the <materialx-viewer> element has real pixel size.
  const shaderball = panel.locator('materialx-viewer');
  await expect(shaderball).toBeVisible({ timeout: 15000 });
  const shaderballBox = await shaderball.boundingBox();
  expect(shaderballBox).toBeTruthy();
  expect(shaderballBox.width).toBeGreaterThan(50);
  expect(shaderballBox.height).toBeGreaterThan(50);
  await page.getByTestId('usd-scene-canvas').screenshot({ path: '.local-raster-v2/results/r3/s4/panel.png' });

  // Corner resize: the graph pane and the shaderball column must both
  // follow the panel's new size, not stay pinned at their initial size.
  const flowBefore = await panel.locator('.react-flow').boundingBox();
  const shaderballBefore = await shaderball.boundingBox();
  const handle2 = panel.getByTestId('usd-scene-material-preview-resize');
  const handleBox = await handle2.boundingBox();
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 150, startY + 100, { steps: 5 });
  await page.mouse.move(startX + 300, startY + 200, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => {
    const box = await panel.locator('.react-flow').boundingBox();
    return box ? box.width - flowBefore.width : 0;
  }, { timeout: 5000 }).toBeGreaterThanOrEqual(250);
  const flowAfterResize = await panel.locator('.react-flow').boundingBox();
  expect(flowAfterResize.height - flowBefore.height).toBeGreaterThanOrEqual(150);
  const shaderballAfterResize = await shaderball.boundingBox();
  expect(shaderballAfterResize.height - shaderballBefore.height).toBeGreaterThan(0);
  await page.getByTestId('usd-scene-canvas').screenshot({ path: '.local-raster-v2/results/r3/s4/panel.png' });

  // Divider drag: moving it left grows the shaderball column, shrinking
  // the graph pane, without touching the outer panel size.
  const divider = panel.getByTestId('mtlx-graph-preview-divider');
  const dividerBox = await divider.boundingBox();
  const dividerY = dividerBox.y + dividerBox.height / 2;
  const dividerX = dividerBox.x + dividerBox.width / 2;
  await page.mouse.move(dividerX, dividerY);
  await page.mouse.down();
  await page.mouse.move(dividerX - 75, dividerY, { steps: 3 });
  await page.mouse.move(dividerX - 150, dividerY, { steps: 3 });
  await page.mouse.up();
  await expect.poll(async () => {
    const box = await shaderball.boundingBox();
    return box ? box.width - shaderballAfterResize.width : 0;
  }, { timeout: 5000 }).toBeGreaterThanOrEqual(100);

  // Close paths, both checked while the Scene view is still the one
  // mounted: X hides it, then reopening and pressing Escape hides it again.
  await panel.getByRole('button', { name: 'Close' }).click();
  await expect(panel).toBeHidden();

  const viewerCountAfterFirst = await page.evaluate(() => window.__previewViewerCount);
  await page.mouse.dblclick(x, y);
  await expect(panel).toBeVisible({ timeout: 15000 });
  const viewerCountAfterSecond = await page.evaluate(() => window.__previewViewerCount);
  expect(viewerCountAfterSecond).toBe(viewerCountAfterFirst);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await page.mouse.dblclick(x, y);
  await expect(panel).toBeVisible({ timeout: 15000 });

  // "Open in Graph Editor" must actually route and load the material, not
  // silently no-op (a pointer-capture-on-header regression bug): last,
  // since the Scene view unmounts once the route leaves it.
  await panel.getByRole('button', { name: 'Open in Graph Editor' }).click();
  await expect(page).toHaveURL(/#!graph/);
  // The Scene view's own panel (with its own react-flow graph) can still be
  // mounted-but-hidden behind the new route, so scope to a VISIBLE match.
  await expect(page.locator('.react-flow__node:visible', { hasText: graphNodeName }).first()).toBeVisible({ timeout: 15000 });

  // Back to the Scene: the panel was remounted while the view was hidden
  // (zero-size bounds), so the next double-click must still open a panel
  // of a usable size instead of a collapsed one.
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await page.mouse.dblclick(x, y);
  await expect(panel).toBeVisible({ timeout: 15000 });
  const box = await panel.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(320);
  expect(box.height).toBeGreaterThanOrEqual(220);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('mtlx_scene_material_preview_rect') || 'null'));
  expect(stored && stored.width).toBeGreaterThanOrEqual(320);
});

// @scene: a material that references a real texture must hand every scene
// texture over to the Graph Editor, not just the renderer's own narrow
// per-material file map, so Export never reports it missing.
test('@scene hands the full scene file map to the Graph Editor for a textured material', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('override-root.usda'),
    fixtureFile('override.mtlx'),
    { name: 'tex-a.png', mimeType: 'image/png', buffer: ONE_PX_PNG },
    { name: 'tex-b.png', mimeType: 'image/png', buffer: ONE_PX_PNG },
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });

  const point = await page.evaluate(() => {
    const handle = window.__mtlxUsdSceneHandle;
    const mesh = handle.selectPrim('/Scene/QuadTexSwap');
    const box = new window.THREE.Box3().setFromObject(mesh);
    const center = box.getCenter(new window.THREE.Vector3());
    const ndc = center.clone().project(handle.camera);
    const rect = handle.renderer.domElement.getBoundingClientRect();
    return { ndc: { x: ndc.x, y: ndc.y }, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } };
  });
  const x = point.rect.left + (point.ndc.x * 0.5 + 0.5) * point.rect.width;
  const y = point.rect.top + (-point.ndc.y * 0.5 + 0.5) * point.rect.height;

  await page.mouse.dblclick(x, y);
  const panel = page.getByTestId('usd-scene-material-preview');
  await expect(panel).toBeVisible({ timeout: 15000 });
  await panel.getByRole('button', { name: 'Open in Graph Editor' }).click();
  await expect(page).toHaveURL(/#!graph/);
  await expect(page.locator('.react-flow__node:visible', { hasText: 'texswap' }).first()).toBeVisible({ timeout: 15000 });

  // File > Export .mtlx... opens the dialog whose "Not found in this
  // session" list is the exact symptom the user hit live. The menu's own
  // trigger and rows are custom <button role="menuitem"> elements, so a
  // plain tag+text locator is more reliable here than getByRole/name.
  await page.locator('button', { hasText: 'File' }).first().click();
  await page.locator('button', { hasText: 'Export .mtlx' }).click();
  await expect(page.getByText(/texture.*will be packaged/i)).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(/Not found in this session/i)).toHaveCount(0);
});
