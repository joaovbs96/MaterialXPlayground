// USD connections win over a fallback value on the same input. The native
// bridge currently reports the fallback value but not `.connect`, so the
// renderer preserves the MaterialX graph connection when applying a USD
// fallback value.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene');
function fixtureFile(name) {
  return { name, mimeType: name.endsWith('.mtlx') ? 'application/xml' : 'text/plain', buffer: fs.readFileSync(path.join(fixtureRoot, name)) };
}
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type);
  const n = Buffer.alloc(4); n.writeUInt32BE(data.length);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([n, t, data, c]);
}
function solidPng([r, g, b]) {
  const raw = Buffer.from([0, r, g, b, 255]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('@scene USD connected input keeps its MaterialX connection over a fallback value', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('connected-override-root.usda'),
    fixtureFile('connected-override.mtlx'),
    { name: 'tex-a.png', mimeType: 'image/png', buffer: solidPng([0, 255, 0]) },
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);
  const backdrop = page.getByTestId('usd-scene-sidebar').getByRole('combobox').last();
  await backdrop.click();
  await page.getByRole('option', { name: 'None', exact: true }).click();
  await page.waitForTimeout(100);

  const connection = await page.evaluate(() => {
    const handle = window.__mtlxUsdSceneHandle;
    const material = handle.__debug().materials.find(m => m.userData?.mtlxSceneMaterialPath === '/Scene/Looks/connected');
    return {
      hasTextureInput: !!material?.userData?.mtlxSceneCompiled?.introspected
        && material.userData.mtlxSceneCompiled.introspected.some(entry => /tex-a\.png|img_tex/i.test(JSON.stringify(entry))),
      warnings: handle.warnings || [],
    };
  });
  expect(connection.warnings.join('\n')).not.toContain('GPU program compilation failed');
  expect(connection.warnings.join('\n')).toContain('USD shader connections are not exposed');
  expect(connection.hasTextureInput).toBe(true);

  const png = decodePNG(await page.getByTestId('usd-scene-canvas').locator('canvas').screenshot());
  const pixel = png.getPixel(Math.floor(png.width / 2), Math.floor(png.height / 2));
  expect(pixel.g).toBeGreaterThan(pixel.r + 40);
  expect(pixel.g).toBeGreaterThan(pixel.b + 40);
});
