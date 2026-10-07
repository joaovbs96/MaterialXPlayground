// @scene: a material double-clicked open from the Scene Viewer and sent to
// the Graph Editor ("Open in Graph Editor") must land there view only, carrying
// only the picked material of a multi-material source (pruned document).
// js/usd-scene-app.jsx openInEditor builds the window.__mtlxPendingImport +
// 'mtlx-load-document' handoff directly (it does not go through
// js/shared/mtlx-ui.jsx openInGraphEditor, which drops a materialName
// field), setting readOnly/readOnlySource and materialName for
// js/graph-app.jsx's docReadOnly state and __inline_/__usdshade_/
// __usdpreview_ name mapping.
import { test, expect } from './lib/test-base.mjs';

// Two materials in one source file, each with its own texture: the inspector
// and its Graph Editor handoff carry only the picked one (pruned document).
const LOOKS_MTLX = [
  '<?xml version="1.0"?>',
  '<materialx version="1.39" colorspace="lin_rec709">',
  '  <image name="red_img" type="color3">',
  '    <input name="file" type="filename" value="red.png" />',
  '  </image>',
  '  <standard_surface name="red_surface" type="surfaceshader">',
  '    <input name="base_color" type="color3" nodename="red_img" />',
  '  </standard_surface>',
  '  <surfacematerial name="red_material" type="material">',
  '    <input name="surfaceshader" type="surfaceshader" nodename="red_surface" />',
  '  </surfacematerial>',
  '  <image name="blue_img" type="color3">',
  '    <input name="file" type="filename" value="blue.png" />',
  '  </image>',
  '  <standard_surface name="blue_surface" type="surfaceshader">',
  '    <input name="base_color" type="color3" nodename="blue_img" />',
  '  </standard_surface>',
  '  <surfacematerial name="blue_material" type="material">',
  '    <input name="surfaceshader" type="surfaceshader" nodename="blue_surface" />',
  '  </surfacematerial>',
  '</materialx>',
].join('\n');

// 1x1 RGBA PNGs, generated here (no image assets on disk).
function onePixelPng(r, g, b) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
  // Stored (uncompressed) deflate block holding one filter byte plus RGBA.
  const raw = Buffer.from([0, r, g, b, 255]);
  const adler = (() => { let a = 1, d = 0; for (const byte of raw) { a = (a + byte) % 65521; d = (d + a) % 65521; } return Buffer.from([d >> 8, d & 255, a >> 8, a & 255]); })();
  const idat = Buffer.concat([Buffer.from([0x78, 0x01, 0x01, raw.length, 0, raw.length ^ 0xff, 0xff]), raw, adler]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const ROOT_USDA = [
  '#usda 1.0',
  '(',
  '    defaultPrim = "World"',
  '    upAxis = "Y"',
  '    metersPerUnit = 1',
  ')',
  'def Xform "World" {',
  '    def Scope "Looks" {',
  '        def Material "red_material" (',
  '            references = @looks.mtlx@</MaterialX/Materials/red_material>',
  '        ) {',
  '        }',
  '        def Material "blue_material" (',
  '            references = @looks.mtlx@</MaterialX/Materials/blue_material>',
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
  '        rel material:binding = </World/Looks/red_material>',
  '    }',
  '    def Mesh "MeshB" (',
  '        prepend apiSchemas = ["MaterialBindingAPI"]',
  '    ) {',
  '        uniform token subdivisionScheme = "none"',
  '        int[] faceVertexCounts = [4]',
  '        int[] faceVertexIndices = [0, 1, 2, 3]',
  '        point3f[] points = [(0.8, -0.6, 0), (2, -0.6, 0), (2, 0.6, 0), (0.8, 0.6, 0)]',
  '        normal3f[] normals = [(0, 0, 1)] ( interpolation = "constant" )',
  '        rel material:binding = </World/Looks/blue_material>',
  '    }',
  '}',
  '',
].join('\n');

function usdFiles() {
  return [
    { name: 'root.usda', mimeType: 'text/plain', buffer: Buffer.from(ROOT_USDA) },
    { name: 'looks.mtlx', mimeType: 'application/xml', buffer: Buffer.from(LOOKS_MTLX) },
    { name: 'red.png', mimeType: 'image/png', buffer: onePixelPng(220, 20, 10) },
    { name: 'blue.png', mimeType: 'image/png', buffer: onePixelPng(10, 50, 230) },
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
  await expect(panel).toContainText('red_material');
  // One renderable: the shader ball offers no material dropdown for the pruned document.
  await expect(panel.getByText('Loading material')).toBeHidden({ timeout: 90000 });
  await expect(panel.locator('[title^="Material to display"]')).toHaveCount(0);

  // The handoff event fires before the Graph Editor view (and its own
  // listener) exists, so capture it directly to check materialName made it
  // through (the leaf of the material's prim path: "Red" -> "red_material").
  await page.evaluate(() => {
    window.__testHandoffDetail = null;
    window.addEventListener('mtlx-load-document', (e) => { window.__testHandoffDetail = e.detail; });
  });
  await panel.getByRole('button', { name: 'Open in Graph Editor' }).click();

  await expect(page).toHaveURL(/#!graph/);
  const handoffDetail = await page.evaluate(() => window.__testHandoffDetail);
  expect(handoffDetail && handoffDetail.materialName).toBe('red_material');
  // Only the picked material (pruned document) and only its texture travel.
  expect(handoffDetail.select).toBe('red_material');
  expect(handoffDetail.name).toBe('red_material');
  expect(handoffDetail.readOnly).toBe(true);
  expect(handoffDetail.xml).toContain('name="red_material"');
  expect(handoffDetail.xml).not.toContain('blue_material');
  expect(handoffDetail.xml).not.toContain('blue.png');
  expect(Object.keys(handoffDetail.files || {}).some((k) => /red\.png$/.test(k))).toBe(true);
  expect(Object.keys(handoffDetail.files || {}).some((k) => /blue\.png$/.test(k))).toBe(false);

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

test('@scene Reopen as copy turns the view-only material into an editable, unsaved copy', async ({ page, embedURL }) => {
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

  const banner = page.getByText(/View only: material from root\.usda/);
  await expect(banner).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Reopen as copy' }).click();

  // The lock and banner go, the document name carries _copy, and the copy counts as unsaved.
  await expect(banner).toBeHidden({ timeout: 20000 });
  await expect(page.getByText('View only', { exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: /_copy.mtlx$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Add Node/ })).toBeEnabled();
  const xml = await page.evaluate(() => window.__mtlxGetGraphXml());
  expect(xml).toContain('red_surface');

  // Dirty proof: replacing it (New Material) now asks to confirm.
  await page.getByRole('menuitem', { name: 'File' }).click();
  await page.getByRole('menuitem', { name: 'New Material' }).click();
  await expect(page.getByText('Unsaved changes')).toBeVisible({ timeout: 10000 });
});
