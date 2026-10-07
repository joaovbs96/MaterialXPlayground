// Transparency for graphs the WASM verdict misses (js/shared/mtlx-gen-core.js
// classifyTransparentGraph): Disney glass (specTrans inside NG_disney_principled)
// peels in the Viewer embed and in the Scene Viewer; Disney's default stays opaque.
// Fixtures are generated here, nothing on disk.
import { test, expect, gotoHarness, createViewer, waitForEventCount } from './lib/test-base.mjs';

const disney = (name, specTrans) => [
  '<?xml version="1.0"?>',
  '<materialx version="1.39" colorspace="lin_rec709">',
  '  <disney_principled name="' + name + '_surface" type="surfaceshader">',
  '    <input name="baseColor" type="color3" value="0.9, 0.9, 0.9" />',
  '    <input name="roughness" type="float" value="0.05" />',
  '    <input name="specTrans" type="float" value="' + specTrans + '" />',
  '  </disney_principled>',
  '  <surfacematerial name="' + name + '" type="material">',
  '    <input name="surfaceshader" type="surfaceshader" nodename="' + name + '_surface" />',
  '  </surfacematerial>',
  '</materialx>',
].join('\n');
const GLASS = disney('disney_glass', '1.0');
const SOLID = disney('disney_solid', '0.0');

test('a Disney glass document peels in the Viewer embed, the default Disney stays opaque', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await gotoHarness(page, embedURL);
  const idx = await createViewer(page, { base: embedURL + '/embed/', src: embedURL + '/tests/embed/fixtures/glass.mtlx', geometry: 'sphere', forcetransparency: true, eager: true });
  await waitForEventCount(page, idx, 'mtlx-ready', 1);
  const iframeUrl = await page.evaluate((j) => window.__viewers[j].shadowRoot.querySelector('iframe').src, idx);
  const iframe = page.frames().find((f) => f.url() === iframeUrl);
  expect(iframe, 'viewer iframe').toBeTruthy();
  const loadLive = async (xml) => {
    await iframe.evaluate(() => { window.__mtlxPrevHandle = window.__mtlxViewerHandle; });
    await page.evaluate(({ j, xml }) => window.__viewers[j].load(xml), { j: idx, xml });
    await iframe.waitForFunction(() => {
      const h = window.__mtlxViewerHandle;
      return !!h && h !== window.__mtlxPrevHandle && !!h.fs;
    });
    return iframe.evaluate(() => {
      const h = window.__mtlxViewerHandle;
      h.renderNow();
      const img = h.snapshotPixels(32, 32);
      const c = ((16 * img.width) + 16) * 4;
      return { transparent: !!h.isTransparent, peel: h.__debug().peel, fold: h.fs.indexOf('uniform int u_peelMode;') !== -1, center: Array.from(img.data.slice(c, c + 4)) };
    });
  };
  const glass = await loadLive(GLASS);
  expect(glass.transparent).toBe(true);
  expect(glass.fold).toBe(true);
  expect(glass.peel.mode).not.toBe('off');
  const solid = await loadLive(SOLID);
  expect(solid.transparent).toBe(false);
  // The peel composites the backdrop through the glass: turning transparency off
  // for the same document (opaque refraction only) changes the centre pixel.
  await loadLive(GLASS);
  const peeled = await iframe.evaluate(() => { const h = window.__mtlxViewerHandle; h.renderNow(); const img = h.snapshotPixels(32, 32); const c = ((16 * img.width) + 16) * 4; return Array.from(img.data.slice(c, c + 4)); });
  await iframe.evaluate(() => window.setForceTransparency(false, { persist: false }));
  const unpeeled = await iframe.evaluate(() => { const h = window.__mtlxViewerHandle; h.renderNow(); const img = h.snapshotPixels(32, 32); const c = ((16 * img.width) + 16) * 4; return Array.from(img.data.slice(c, c + 4)); });
  expect(peeled.slice(0, 3)).not.toEqual(unpeeled.slice(0, 3));
});

const quad = (name, x, material) => [
  '    def Mesh "' + name + '" (',
  '        prepend apiSchemas = ["MaterialBindingAPI"]',
  '    ) {',
  '        uniform token subdivisionScheme = "none"',
  '        int[] faceVertexCounts = [4]',
  '        int[] faceVertexIndices = [0, 1, 2, 3]',
  '        point3f[] points = [(' + (x - 0.6) + ', -0.6, 0), (' + (x + 0.6) + ', -0.6, 0), (' + (x + 0.6) + ', 0.6, 0), (' + (x - 0.6) + ', 0.6, 0)]',
  '        normal3f[] normals = [(0, 0, 1)] ( interpolation = "constant" )',
  '        rel material:binding = </World/Looks/' + material + '>',
  '    }',
];
const USDA = [
  '#usda 1.0',
  '(',
  '    defaultPrim = "World"',
  '    upAxis = "Y"',
  '    metersPerUnit = 1',
  ')',
  'def Xform "World" {',
  '    def Scope "Looks" {',
  '        def Material "disney_glass" (',
  '            references = @glass.mtlx@</MaterialX/Materials/disney_glass>',
  '        ) {',
  '        }',
  '        def Material "disney_solid" (',
  '            references = @solid.mtlx@</MaterialX/Materials/disney_solid>',
  '        ) {',
  '        }',
  '    }',
  ...quad('Glass', -0.8, 'disney_glass'),
  ...quad('Solid', 0.8, 'disney_solid'),
  '}',
  '',
].join('\n');

test('@scene a Disney glass material binds as a peeled material in the Scene Viewer', async ({ page, embedURL }) => {
  test.setTimeout(180000);
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    { name: 'disney.usda', mimeType: 'text/plain', buffer: Buffer.from(USDA) },
    { name: 'glass.mtlx', mimeType: 'application/xml', buffer: Buffer.from(GLASS) },
    { name: 'solid.mtlx', mimeType: 'application/xml', buffer: Buffer.from(SOLID) },
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 150000 });
  const peel = await page.evaluate(() => {
    const out = {};
    for (const object of window.__mtlxUsdSceneHandle.prims) {
      const material = Array.isArray(object.material) ? object.material[0] : object.material;
      out[object.userData.primPath] = !!(material && material.userData && material.userData.mtlxScenePeel);
    }
    return out;
  });
  expect(peel['/World/Glass']).toBe(true);
  expect(peel['/World/Solid']).toBe(false);
});
