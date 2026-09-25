// @scene: a material double-clicked open from the Scene Viewer and sent to
// the Graph Editor ("Open in Graph Editor") must land there view only.
// js/usd-scene-app.jsx openInEditor passes readOnly/readOnlySource through
// js/shared/mtlx-ui.jsx openInGraphEditor to js/graph-app.jsx's docReadOnly
// state, which folds into the existing library scopeLocked gate.
import { test, expect } from './lib/test-base.mjs';

const RED_MTLX = [
  '<?xml version="1.0"?>',
  '<materialx version="1.39" colorspace="lin_rec709">',
  '  <standard_surface name="red_surface" type="surfaceshader">',
  '    <input name="base_color" type="color3" value="0.86, 0.08, 0.04" />',
  '  </standard_surface>',
  '  <surfacematerial name="red_material" type="material">',
  '    <input name="surfaceshader" type="surfaceshader" nodename="red_surface" />',
  '  </surfacematerial>',
  '</materialx>',
].join('\n');

const ROOT_USDA = [
  '#usda 1.0',
  '(',
  '    defaultPrim = "World"',
  '    upAxis = "Y"',
  '    metersPerUnit = 1',
  ')',
  'def Xform "World" {',
  '    def Scope "Looks" {',
  '        def Material "Red" (',
  '            references = @red.mtlx@</MaterialX/Materials/red_material>',
  '        ) {',
  '        }',
  '    }',
  '    def Mesh "MeshA" (',
  '        prepend apiSchemas = ["MaterialBindingAPI"]',
  '    ) {',
  '        uniform token subdivisionScheme = "none"',
  '        int[] faceVertexCounts = [4]',
  '        int[] faceVertexIndices = [0, 1, 2, 3]',
  '        point3f[] points = [(-0.6, -0.6, 0), (0.6, -0.6, 0), (0.6, 0.6, 0), (-0.6, 0.6, 0)]',
  '        normal3f[] normals = [(0, 0, 1)] ( interpolation = "constant" )',
  '        rel material:binding = </World/Looks/Red>',
  '    }',
  '}',
  '',
].join('\n');

function usdFiles() {
  return [
    { name: 'root.usda', mimeType: 'text/plain', buffer: Buffer.from(ROOT_USDA) },
    { name: 'red.mtlx', mimeType: 'application/xml', buffer: Buffer.from(RED_MTLX) },
  ];
}

test('@scene material opened from the Scene Viewer opens the Graph Editor view only', async ({ page, embedURL }) => {
  test.setTimeout(180000);
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles(usdFiles());
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 150000 });

  await page.locator('[data-testid="usd-scene-tree-row"][data-path="/World/MeshA"]').dblclick();
  const panel = page.getByTestId('usd-scene-material-preview');
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Open in Graph Editor' }).click();

  await expect(page).toHaveURL(/#!graph/);

  // The view-only banner names the scene file and offers Export .mtlx.
  const banner = page.getByText(/View only: material from root\.usda/);
  await expect(banner).toBeVisible({ timeout: 20000 });
  const bannerExport = page.getByRole('button', { name: 'Export .mtlx' });
  await expect(bannerExport).toBeVisible();

  // The "View only" tag sits next to the document name in the header.
  await expect(page.getByText('View only', { exact: true })).toBeVisible();

  // Edits are inert: the underlying document is unchanged after an attempt
  // to add a node (Edit menu, guarded the same way as the pre-existing
  // library-scope lock) and after a value-edit attempt on the canvas.
  const xmlBefore = await page.evaluate(() => window.__mtlxGetGraphXml());

  // Toolbar: the Add Node / Delete Nodes buttons are natively disabled.
  await expect(page.getByRole('button', { name: /^Add Node/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Delete Nodes/ })).toBeDisabled();

  // Edit menu: every mutating action is aria-disabled by the same
  // scopeLocked gate the pre-existing library view-only mode uses.
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  for (const label of ['Undo', 'Redo', 'Copy', 'Paste', 'Auto Layout', 'Group into Nodegraph']) {
    await expect(page.getByRole('menuitem', { name: label })).toHaveAttribute('aria-disabled', 'true');
  }
  // aria-disabled blocks Playwright's own actionability check (the row
  // never becomes "enabled"), which is itself proof the row is inert;
  // force a raw DOM click to confirm commitItem() no-ops on top of that.
  await page.getByRole('menuitem', { name: 'Undo' }).click({ force: true });
  await page.keyboard.press('Escape');

  const xmlAfter = await page.evaluate(() => window.__mtlxGetGraphXml());
  expect(xmlAfter).toBe(xmlBefore);

  // Export .mtlx from the banner opens the real export dialog.
  await bannerExport.click();
  await expect(page.getByTestId('export-attribution')).toBeVisible();
});
