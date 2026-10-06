// @scene Export USD from the Scene Viewer (js/usd-scene-app.jsx ExportUsdDialog,
// js/usd/usd-stage-export.js). Needs the fetch-only OpenUSD runtime and skips without it.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JSZip = createRequire(import.meta.url)(path.join(root, 'vendor', 'jszip', 'jszip.min.js'));
const HAS_USD = fs.existsSync(path.join(root, 'vendor', 'usd-webview-bindings', 'usdWebViewBindingsModule.wasm'));
// One untextured triangle with an embedded buffer keeps the scene load short.
const TRI_GLTF = '{"asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],"nodes":[{"mesh":0}],"meshes":[{"primitives":[{"attributes":{"POSITION":0},"material":0}]}],"materials":[{"pbrMetallicRoughness":{"baseColorFactor":[0.8,0.1,0.1,1]}}],"accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}],"bufferViews":[{"buffer":0,"byteLength":36}],"buffers":[{"byteLength":36,"uri":"data:application/octet-stream;base64,AAAAAAAAAAAAAAAAAACAPwAAAAAAAAAAAAAAAAAAgD8AAAAA"}]}';


const OBJ = [
  'mtllib tri.mtl', 'o Tri', 'usemtl Green',
  'v 0 0 0', 'v 1 0 0', 'v 0 1 0', 'vn 0 0 1', 'f 1//1 2//1 3//1', '',
].join('\n');
const MTL = ['newmtl Green', 'Kd 0.1 0.7 0.2', 'Ks 0 0 0', ''].join('\n');

async function openScene(page, embedURL, files) {
  await page.addInitScript(() => { delete window.showSaveFilePicker; });
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles(files);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 150000 });
}

async function pick(page, label, optionName) {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: optionName }).click();
}

async function exportAs(page, materials, format) {
  await page.getByTestId('usd-scene-export-usd').click();
  await expect(page.getByTestId('usd-scene-export-dialog')).toBeVisible();
  await pick(page, 'Material export mode', materials);
  if (format) await pick(page, 'USD format', format);
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 180000 }),
    page.getByTestId('usd-scene-export-run').click(),
  ]);
  const bytes = fs.readFileSync(await download.path());
  await expect(page.getByTestId('usd-scene-export-error')).toHaveCount(0);
  await page.keyboard.press('Escape');
  return { name: download.suggestedFilename(), zip: await JSZip.loadAsync(bytes) };
}

async function readEntries(zip) {
  const out = {};
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    out[name] = /\.(usda|mtlx)$/.test(name) ? await zip.files[name].async('string') : null;
  }
  return out;
}

const rootUsda = (entries) => Object.entries(entries).find(([n, t]) => /\.usda$/.test(n) && t && /def Mesh/.test(t));

test.describe('Export USD', () => {
  test.skip(!HAS_USD, 'vendor/usd-webview-bindings is fetch-only and absent');

  test('@smoke glTF exports as USDA with a referenced MaterialX material', async ({ page, embedURL }) => {
    test.setTimeout(180000);
    await openScene(page, embedURL, [{ name: 'tri.gltf', mimeType: 'model/gltf+json', buffer: Buffer.from(TRI_GLTF) }]);

    const ref = await exportAs(page, 'USD + referenced', 'USDA');
    const refEntries = await readEntries(ref.zip);
    const refRoot = rootUsda(refEntries);
    expect(refRoot, 'root usda with a Mesh in ' + Object.keys(refEntries)).toBeTruthy();
    expect(refRoot[1]).toContain('material:binding');
    const mtlxNames = Object.keys(refEntries).filter((n) => n.endsWith('.mtlx'));
    expect(mtlxNames.length).toBeGreaterThan(0);
    expect(refRoot[1]).toMatch(/@[^@]*\.mtlx@<\/[^>]+>/);
  });

  test('glTF exports as UsdShade networks and as USDZ', async ({ page, embedURL }) => {
    test.setTimeout(180000);
    await openScene(page, embedURL, [{ name: 'tri.gltf', mimeType: 'model/gltf+json', buffer: Buffer.from(TRI_GLTF) }]);

    const net = await exportAs(page, 'MaterialX as UsdShade', 'USDA');
    const netEntries = await readEntries(net.zip);
    const netRoot = rootUsda(netEntries);
    expect(netRoot).toBeTruthy();
    expect(netRoot[1]).toContain('material:binding');
    expect(netRoot[1]).toContain('ND_');
    expect(netRoot[1]).not.toContain('.mtlx');
    expect(Object.keys(netEntries).filter((n) => n.endsWith('.mtlx'))).toHaveLength(0);

    const usdz = await exportAs(page, 'MaterialX as UsdShade', 'USDZ');
    expect(usdz.name).toMatch(/\.usdz$|\.zip$/);
    const names = Object.keys(usdz.zip.files).filter((n) => !usdz.zip.files[n].dir);
    expect(names.length).toBeGreaterThan(0);
    expect(names[0]).toMatch(/\.(usd|usda|usdc)$/);
  });

  test('OBJ with an MTL exports as USDA with a referenced MaterialX material', async ({ page, embedURL }) => {
    test.setTimeout(180000);
    await openScene(page, embedURL, [
      { name: 'tri.obj', mimeType: 'text/plain', buffer: Buffer.from(OBJ) },
      { name: 'tri.mtl', mimeType: 'text/plain', buffer: Buffer.from(MTL) },
    ]);
    const ref = await exportAs(page, 'USD + referenced', 'USDA');
    const entries = await readEntries(ref.zip);
    const r = rootUsda(entries);
    expect(r, 'root usda in ' + Object.keys(entries)).toBeTruthy();
    expect(r[1]).toContain('material:binding');
    expect(r[1]).toMatch(/\.mtlx@/);
    expect(Object.keys(entries).some((n) => n.endsWith('.mtlx'))).toBe(true);
  });
});
