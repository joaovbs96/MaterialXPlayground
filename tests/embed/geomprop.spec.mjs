// tests/embed/geomprop.spec.mjs: a geompropvalue(vector2) node used as the
// only UV source used to fail ESSL compilation (redefinition + l-value
// error on i_geomprop_st). Covers patchGeompropVaryings + the UV alias in
// prepGeometry: the shader must compile and read real texcoords, not zeros.

import {
  test, expect, gotoHarness,
  createViewer, waitForReady, waitForEventCount, getEvents,
} from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const GEOMPROP_MTLX_PATH = '/tests/embed/fixtures/geomprop-st.mtlx';

// Finds the rendered sphere's bounding box against the flat backdrop
// color, then compares outer thirds of ONLY the sphere's own pixels (the
// bbox rectangle's corners are still backdrop and would dilute a plain
// rectangular-region average).
function sphereAxisSpread(png, channel, axis) {
  const bg = png.getPixel(0, 0);
  const isFg = (x, y) => {
    const p = png.getPixel(x, y);
    return Math.abs(p.r - bg.r) + Math.abs(p.g - bg.g) + Math.abs(p.b - bg.b) > 10;
  };
  let minX = png.width, maxX = 0, minY = png.height, maxY = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (!isFg(x, y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const meanOfFg = (x0, x1, y0, y1) => {
    let sum = 0, count = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (!isFg(x, y)) continue;
        sum += png.getPixel(x, y)[channel];
        count++;
      }
    }
    return count ? sum / count : 0;
  };
  if (axis === 'x') {
    const third = Math.floor((maxX - minX + 1) / 3);
    const lo = meanOfFg(minX, minX + third, minY, maxY + 1);
    const hi = meanOfFg(maxX - third + 1, maxX + 1, minY, maxY + 1);
    return Math.abs(lo - hi);
  }
  const third = Math.floor((maxY - minY + 1) / 3);
  const lo = meanOfFg(minX, maxX + 1, minY, minY + third);
  const hi = meanOfFg(minX, maxX + 1, maxY - third + 1, maxY + 1);
  return Math.abs(lo - hi);
}

test('geompropvalue(vector2) compiles and reads real UVs, not zeros', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + GEOMPROP_MTLX_PATH,
    geometry: 'sphere',
    backdrop: 'none',
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  await page.waitForTimeout(500); // a beat for any late mtlx-error to land

  const errors = await getEvents(page, idx, 'mtlx-error');
  expect(errors).toEqual([]);

  const allText = [...pageErrors, ...consoleErrors].join('\n');
  expect(allText).not.toContain('Shader compile error');

  // <materialx-viewer> renders its content inside a same-origin iframe
  // (its shadow DOM's src=embed/viewer.html), so the canvas is reached
  // through frameLocator, not a plain page-level locator.
  const canvas = page.frameLocator('iframe').locator('canvas').first();
  const png = decodePNG(await canvas.screenshot());

  // Zeros (unbound geomprop) would render the whole sphere one flat
  // color; real UVs vary smoothly across it in both axes.
  expect(sphereAxisSpread(png, 'r', 'x')).toBeGreaterThan(40);
  expect(sphereAxisSpread(png, 'g', 'y')).toBeGreaterThan(40);
});
