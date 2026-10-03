// tests/embed/usd-scene-address-modes.spec.mjs: the Scene's PNG textures
// honour authored uaddressmode/vaddressmode. A quad with UVs 0..3 shows the
// edge colour under clamp; under the default periodic mode it repeats.

import zlib from 'node:zlib';
import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const HIDE_HINT_PILL = '[data-testid="usd-scene-hint-pill"] { visibility: hidden !important; }';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
// 2x1 RGB PNG: left pixel red, right pixel blue.
function makeRedBluePng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.from([0, 255, 0, 0, 0, 0, 255]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const usda = `#usda 1.0
(
    defaultPrim = "Scene"
    upAxis = "Y"
    metersPerUnit = 1
)

def Xform "Scene" {
    def Scope "Looks" {
        def Material "Mat" (
            references = @address.mtlx@</MaterialX/Materials/mat>
        ) {
        }
    }

    def Mesh "Quad" (
        prepend apiSchemas = ["MaterialBindingAPI"]
    ) {
        uniform token subdivisionScheme = "none"
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 1, 2, 3]
        point3f[] points = [(-2, -1, 0), (2, -1, 0), (2, 1, 0), (-2, 1, 0)]
        normal3f[] normals = [(0, 0, 1), (0, 0, 1), (0, 0, 1), (0, 0, 1)] ( interpolation = "vertex" )
        texCoord2f[] primvars:st = [(0, 0), (3, 0), (3, 1), (0, 1)] ( interpolation = "faceVarying" )
        rel material:binding = </Scene/Looks/Mat>
    }
}
`;

const mtlx = (mode) => `<?xml version="1.0"?>
<materialx version="1.39" colorspace="lin_rec709">
  <image name="img" type="color3">
    <input name="file" type="filename" value="rb.png" colorspace="srgb_texture" />
    <input name="uaddressmode" type="string" value="${mode}" />
    <input name="vaddressmode" type="string" value="${mode}" />
  </image>
  <surface_unlit name="surf" type="surfaceshader">
    <input name="emission_color" type="color3" nodename="img" />
  </surface_unlit>
  <surfacematerial name="mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surf" />
  </surfacematerial>
</materialx>
`;

async function renderRightThirdRed(page, embedURL, mode) {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    { name: 'root.usda', mimeType: 'text/plain', buffer: Buffer.from(usda) },
    { name: 'address.mtlx', mimeType: 'text/plain', buffer: Buffer.from(mtlx(mode)) },
    { name: 'rb.png', mimeType: 'image/png', buffer: makeRedBluePng() },
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);
  await page.getByTestId('usd-scene-backdrop-select').getByRole('combobox').click();
  await page.getByRole('option', { name: 'None', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__mtlxUsdSceneHandle.getBackdrop())).toBe('none');
  await page.waitForTimeout(300);

  const canvas = page.getByTestId('usd-scene-canvas').locator('canvas');
  const png = decodePNG(await canvas.screenshot({ style: HIDE_HINT_PILL }));
  const bg = png.getPixel(0, 0);
  // Find the quad's horizontal extent, then average red over its right third (u 2..3).
  let minX = png.width, maxX = -1;
  const midY = Math.floor(png.height / 2);
  for (let x = 0; x < png.width; x++) {
    const p = png.getPixel(x, midY);
    if (Math.abs(p.r - bg.r) + Math.abs(p.g - bg.g) + Math.abs(p.b - bg.b) > 30) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
  }
  expect(maxX).toBeGreaterThan(minX);
  const w = maxX - minX;
  let red = 0, blue = 0, n = 0;
  for (let x = minX + Math.floor(w * 0.7); x < maxX - Math.floor(w * 0.05); x++) {
    const p = png.getPixel(x, midY);
    red += p.r; blue += p.b; n++;
  }
  return { red: red / n, blue: blue / n };
}

test('@scene clamp address mode shows the edge colour past UV 1 on a PNG texture', async ({ page, embedURL }) => {
  const clamp = await renderRightThirdRed(page, embedURL, 'clamp');
  expect(clamp.blue).toBeGreaterThan(200);
  expect(clamp.red).toBeLessThan(40);
});

test('@scene periodic address mode still repeats a PNG texture past UV 1', async ({ page, embedURL }) => {
  const periodic = await renderRightThirdRed(page, embedURL, 'periodic');
  expect(periodic.red).toBeGreaterThan(80);
});
