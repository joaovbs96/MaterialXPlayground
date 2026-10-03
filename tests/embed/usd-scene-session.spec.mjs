// @scene P6 S3: the Scene handle is built by the shared render session
// (MtlxRender.buildHandle): full HANDLE_CONTRACT, live data fields, capture
// through the session's controller (selection overlay excluded, transparent
// None backdrop), setEnvMap, and WebGL context-loss recovery. Fixtures are inline.
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

const USDA = [
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
  '    def Mesh "Card" (',
  '        prepend apiSchemas = ["MaterialBindingAPI"]',
  '    ) {',
  '        uniform token subdivisionScheme = "none"',
  '        int[] faceVertexCounts = [4]',
  '        int[] faceVertexIndices = [0, 1, 2, 3]',
  '        point3f[] points = [(-0.5, -0.5, 0), (0.5, -0.5, 0), (0.5, 0.5, 0), (-0.5, 0.5, 0)]',
  '        rel material:binding = </World/Looks/Red>',
  '    }',
  '}',
  '',
].join('\n');

const files = [
  { name: 'card.usda', mimeType: 'text/plain', buffer: Buffer.from(USDA) },
  { name: 'red.mtlx', mimeType: 'text/plain', buffer: Buffer.from(RED_MTLX) },
];

async function loadScene(page, embedURL) {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles(files);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 150000 });
  await page.waitForFunction(() => !!window.__mtlxUsdSceneHandle);
}

test('@scene the Scene handle covers the shared contract and captures without the overlay', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await loadScene(page, embedURL);
  const result = await page.evaluate(async () => {
    const h = window.__mtlxUsdSceneHandle;
    const missing = window.MtlxRender.HANDLE_CONTRACT.filter((name) => typeof h[name] !== 'function');
    const getter = Object.getOwnPropertyDescriptor(h, 'missingFiles');
    const primPath = h.prims[0] && h.prims[0].userData.primPath;
    h.setHighlightedPrims([primPath]);
    const withOverlay = h.snapshot();
    h.setHighlightedPrims([]);
    const withoutOverlay = h.snapshot();
    // Transparent capture: the None backdrop clears to alpha 0 around the card.
    const previous = h.getBackdrop();
    h.setBackdrop('none');
    h.beginCapture({ width: 64, height: 64 });
    const frame = h.captureFrame();
    h.endCapture();
    h.setBackdrop(previous);
    const cornerAlpha = frame.data[3];
    const centre = ((32 * 64) + 32) * 4;
    let unsupported = null;
    try { await h.setEnvMap('https://example.invalid/env.png'); } catch (e) { unsupported = String(e && e.message); }
    const restored = await h.setEnvMap(null);
    await h.whenSettled();
    return {
      missing, getterLive: !!(getter && getter.get), missingFiles: Array.isArray(h.missingFiles),
      sameSnapshot: withOverlay === withoutOverlay, cornerAlpha, centreAlpha: frame.data[centre + 3],
      unsupported, restored, notices: Array.isArray(h.getNotices()), hasEnv: h.hasEnvBackground(),
    };
  });
  expect(result.missing).toEqual([]);
  expect(result.getterLive).toBe(true);
  expect(result.missingFiles).toBe(true);
  expect(result.sameSnapshot).toBe(true);
  expect(result.cornerAlpha).toBe(0);
  expect(result.centreAlpha).toBe(255);
  expect(result.unsupported).toContain('Unsupported environment URL');
  expect(result.restored).toBe(true);
  expect(result.notices).toBe(true);
  expect(result.hasEnv).toBe(true);
});

test('@scene WebGL context loss then restore rebuilds the Scene view', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await loadScene(page, embedURL);
  await page.evaluate(() => {
    window.__mtlxPrevSceneHandle = window.__mtlxUsdSceneHandle;
    const gl = window.__mtlxUsdSceneHandle.renderer.getContext();
    const ext = gl.getExtension('WEBGL_lose_context');
    if (!ext) throw new Error('WEBGL_lose_context unavailable in this browser');
    window.__mtlxSceneLoseExt = ext;
    ext.loseContext();
  });
  await expect(page.getByTestId('usd-scene-error')).toContainText('reclaimed this 3D view');
  await page.evaluate(() => window.__mtlxSceneLoseExt.restoreContext());
  await page.waitForFunction(() => window.__mtlxUsdSceneHandle && window.__mtlxUsdSceneHandle !== window.__mtlxPrevSceneHandle,
    null, { timeout: 150000 });
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 150000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);
});
