// @scene: the rebuild progress seam (handle.onRebuildProgress / getRebuildState
// in js/usd-scene-renderer.js) and the viewport indicator it drives
// (SceneRebuildIndicator in js/usd-scene-app.jsx). Fixtures are generated here.
import { test, expect } from './lib/test-base.mjs';

const COUNT = 6;
const mtlx = (name, rgb, roughness) => [
  '<?xml version="1.0"?>',
  '<materialx version="1.39" colorspace="lin_rec709">',
  '  <standard_surface name="' + name + '_surface" type="surfaceshader">',
  '    <input name="base_color" type="color3" value="' + rgb + '" />',
  '    <input name="specular_roughness" type="float" value="' + roughness + '" />',
  '  </standard_surface>',
  '  <surfacematerial name="' + name + '_material" type="material">',
  '    <input name="surfaceshader" type="surfaceshader" nodename="' + name + '_surface" />',
  '  </surfacematerial>',
  '</materialx>',
].join('\n');

const names = Array.from({ length: COUNT }, (_, i) => 'm' + i);
const quad = (name, x, material) => [
  '        def Mesh "' + name + '" (',
  '            prepend apiSchemas = ["MaterialBindingAPI"]',
  '        ) {',
  '            uniform token subdivisionScheme = "none"',
  '            int[] faceVertexCounts = [4]',
  '            int[] faceVertexIndices = [0, 1, 2, 3]',
  '            point3f[] points = [(' + (x - 0.4) + ', -0.4, 0), (' + (x + 0.4) + ', -0.4, 0), (' + (x + 0.4) + ', 0.4, 0), (' + (x - 0.4) + ', 0.4, 0)]',
  '            normal3f[] normals = [(0, 0, 1)] ( interpolation = "constant" )',
  '            rel material:binding = <' + material + '>',
  '        }',
];
const ROOT_USDA = [
  '#usda 1.0',
  '(',
  '    defaultPrim = "World"',
  '    upAxis = "Y"',
  '    metersPerUnit = 1',
  ')',
  'def Xform "World" {',
  '    def Scope "Looks" {',
  ...names.flatMap((n) => [
    '        def Material "' + n + '" (',
    '            references = @' + n + '.mtlx@</MaterialX/Materials/' + n + '_material>',
    '        ) {',
    '        }',
  ]),
  '    }',
  ...names.flatMap((n, i) => quad('Mesh' + i, (i - (COUNT - 1) / 2) * 1.0, '/World/Looks/' + n)),
  '}',
  '',
].join('\n');

function files() {
  return [
    { name: 'root.usda', mimeType: 'text/plain', buffer: Buffer.from(ROOT_USDA) },
    ...names.map((n, i) => ({
      name: n + '.mtlx', mimeType: 'application/xml',
      buffer: Buffer.from(mtlx(n, (0.1 + i * 0.15).toFixed(2) + ', 0.3, 0.6', (0.2 + i * 0.1).toFixed(2))),
    })),
  ];
}

async function loadScene(page, embedURL) {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles(files());
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 150000 });
  // Record every progress event the handle emits from here on.
  await page.evaluate(() => {
    window.__rebuildEvents = [];
    window.__mtlxUsdSceneHandle.onRebuildProgress((e) => window.__rebuildEvents.push({ ...e }));
  });
}

const events = (page) => page.evaluate(() => window.__rebuildEvents);
const rebuildState = (page) => page.evaluate(() => window.__mtlxUsdSceneHandle.getRebuildState());

test('@scene a material rebuild shows the progress indicator with a count and hides it on end', async ({ page, embedURL }) => {
  test.setTimeout(240000);
  await loadScene(page, embedURL);
  const indicator = page.getByTestId('usd-scene-rebuild-indicator');
  const bar = page.getByTestId('usd-scene-rebuild-bar');
  await expect(indicator).toHaveCount(0);

  // A DOM observer records every indicator frame, so a fast rebuild cannot race the asserts.
  await page.evaluate(() => {
    window.__indicatorFrames = [];
    const capture = () => {
      const pill = document.querySelector('[data-testid="usd-scene-rebuild-indicator"]');
      const strip = document.querySelector('[data-testid="usd-scene-rebuild-bar"]');
      if (!pill) return;
      window.__indicatorFrames.push({
        kind: pill.getAttribute('data-kind'), text: pill.textContent,
        pillEvents: getComputedStyle(pill).pointerEvents, barEvents: strip ? getComputedStyle(strip).pointerEvents : null,
      });
    };
    new MutationObserver(capture).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  const before = await page.evaluate(() => window.__mtlxUsdSceneHandle.getSceneSpecularAA());
  await page.evaluate((on) => window.__mtlxUsdSceneHandle.setSceneSpecularAA(on), !before);
  await expect.poll(() => page.evaluate(() => window.__indicatorFrames.length), { timeout: 30000 }).toBeGreaterThan(0);
  await expect(indicator).toHaveCount(0, { timeout: 150000 });
  await expect(bar).toHaveCount(0);
  expect(await rebuildState(page)).toEqual([]);
  const frames = await page.evaluate(() => window.__indicatorFrames);
  expect(frames.length).toBeGreaterThan(0);
  expect(frames.every((f) => f.kind === 'materials' && f.pillEvents === 'none' && f.barEvents === 'none')).toBe(true);
  expect(frames.some((f) => /^Updating materials \d+\/6$/.test(f.text))).toBe(true);
  const list = await events(page);
  expect(list[0]).toMatchObject({ kind: 'materials', phase: 'start', done: 0, total: COUNT });
  expect(list.at(-1)).toMatchObject({ kind: 'materials', phase: 'end' });
  const compiled = list.filter((e) => e.phase === 'progress' && e.label === 'Updating materials').map((e) => e.done);
  expect(compiled).toContain(COUNT);
  // Counts only climb within a pass.
  expect(compiled).toEqual([...compiled].sort((a, b) => a - b));
});

test('@scene a second setting change during a rebuild supersedes it and still ends with the indicator hidden', async ({ page, embedURL }) => {
  test.setTimeout(300000);
  await loadScene(page, embedURL);
  const indicator = page.getByTestId('usd-scene-rebuild-indicator');

  const before = await page.evaluate(() => window.__mtlxUsdSceneHandle.getSceneSpecularAA());
  await page.evaluate((on) => window.__mtlxUsdSceneHandle.setSceneSpecularAA(on), !before);
  // Wait until the first pass is genuinely mid-flight, then change another generation setting.
  await page.waitForFunction(() => window.__rebuildEvents.some((e) => e.phase === 'progress' && e.done >= 1), null, { timeout: 60000 });
  await page.evaluate(() => {
    const h = window.__mtlxUsdSceneHandle;
    h.setSceneMaterialWorkspace(h.getSceneMaterialWorkspace() === 'acescg' ? 'rec709' : 'acescg');
  });
  expect((await rebuildState(page)).map((s) => s.kind)).toEqual(['materials']);

  await expect(indicator).toHaveCount(0, { timeout: 200000 });
  expect(await rebuildState(page)).toEqual([]);
  const list = await events(page);
  // Exactly one end per start, and the last word is always an end.
  const starts = list.filter((e) => e.phase === 'start').length;
  const ends = list.filter((e) => e.phase === 'end').length;
  expect(ends).toBe(starts);
  expect(list.at(-1).phase).toBe('end');
  // The superseded pass restarted its count from zero.
  const compiled = list.filter((e) => e.phase === 'progress' && e.label === 'Updating materials').map((e) => e.done);
  expect(compiled.filter((d) => d === 0).length).toBeGreaterThanOrEqual(2);
  // The indicator stays hidden once the scene is idle again.
  await page.waitForTimeout(400);
  await expect(indicator).toHaveCount(0);
});
