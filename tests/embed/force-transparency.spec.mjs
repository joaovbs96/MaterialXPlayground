// tests/embed/force-transparency.spec.mjs: guards two forcetransparency
// regressions. (1) the query-param path must apply the flag to this embed
// instance only, never writing the visitor's shared localStorage
// preference (js/mtlx-engine.js's persist:false mode, embed-boot.js).
// (2) glass under forcetransparency=1 must show a real Fresnel falloff,
// not a flat ghost: near-silhouette must read clearly more opaque than
// dead center (js/mtlx-engine.js's patchTransmissionAlpha).

import {
  test, expect, gotoHarness, WAIT_TIMEOUT,
  createViewer, waitForReady, waitForEventCount,
} from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const GLASS_FIXTURE_PATH = '/tests/embed/fixtures/glass.mtlx';
const TRANSPARENT_HARNESS_PATH = '/tests/embed/fixtures/harness-transparent.html';

// Redness excess: how much of the harness's solid red backdrop
// (harness-transparent.html's body) is bleeding through a pixel. High
// means mostly background (more see-through); low means mostly the
// material's own shaded color (more opaque/reflective).
function rednessExcess(p) {
  return p.r - (p.g + p.b) / 2;
}

test('forcetransparency query param does not persist to localStorage, but still renders transparent', async ({ page, embedURL }) => {
  await page.goto(embedURL + TRANSPARENT_HARNESS_PATH);

  const before = await page.evaluate(() => localStorage.getItem('mtlxForceTransparency'));
  expect(before).toBeNull();

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + GLASS_FIXTURE_PATH,
    geometry: 'sphere',
    transparent: true,
    forcetransparency: true,
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  await page.waitForTimeout(1000); // lets the first real (peeled) frame render and settle

  // Same-origin harness page and iframe already share one localStorage
  // bucket; the iframe's own frame is checked directly too (frame
  // evaluation), which is what actually exercises embed-boot.js's code.
  const iframeUrl = await page.evaluate((i) => window.__viewers[i].shadowRoot.querySelector('iframe').src, idx);
  const iframe = page.frames().find((f) => f.url() === iframeUrl);
  expect(iframe).toBeTruthy();
  const inFrame = await iframe.evaluate(() => localStorage.getItem('mtlxForceTransparency'));
  expect(inFrame).toBeNull();

  const onTopPage = await page.evaluate(() => localStorage.getItem('mtlxForceTransparency'));
  expect(onTopPage).toBeNull();

  // The render must still actually be transparent: sample dead center
  // and expect the harness's red backdrop to show through meaningfully
  // (a silent "persist:false also means doesn't apply" regression would
  // render fully opaque here instead).
  const viewerHandle = await page.evaluateHandle((i) => window.__viewers[i], idx);
  const elementHandle = viewerHandle.asElement();
  await page.evaluate((i) => {
    const el = window.__viewers[i];
    el.style.width = '640px';
    el.style.height = '480px';
    el.style.aspectRatio = 'auto';
  }, idx);
  await page.waitForTimeout(300);
  const buf = await elementHandle.screenshot({ timeout: WAIT_TIMEOUT });
  const png = decodePNG(buf);
  const center = png.getPixel(Math.floor(png.width / 2), Math.floor(png.height / 2));
  expect(rednessExcess(center)).toBeGreaterThan(80);
});

test('glass under forcetransparency=1 reads as glass, not a uniform ghost', async ({ page, embedURL }) => {
  await page.goto(embedURL + TRANSPARENT_HARNESS_PATH);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + GLASS_FIXTURE_PATH,
    geometry: 'sphere',
    transparent: true,
    forcetransparency: true,
    eager: true,
  });

  await waitForReady(page, idx);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  await page.waitForTimeout(1000);

  const viewerHandle = await page.evaluateHandle((i) => window.__viewers[i], idx);
  const elementHandle = viewerHandle.asElement();
  // A fixed pixel size sidesteps the 16:9 aspect-ratio box landing exactly
  // on the default viewport height, which otherwise makes Playwright's
  // stable-bounding-box wait for the element screenshot never settle.
  await page.evaluate((i) => {
    const el = window.__viewers[i];
    el.style.width = '640px';
    el.style.height = '480px';
    el.style.aspectRatio = 'auto';
  }, idx);
  await page.waitForTimeout(300);
  const buf = await elementHandle.screenshot({ timeout: WAIT_TIMEOUT });
  const png = decodePNG(buf);

  const cy = Math.floor(png.height / 2);
  const corner = png.getPixel(3, 3);
  expect(rednessExcess(corner)).toBeGreaterThan(200); // sanity: red backdrop is genuinely visible outside the sphere

  const center = png.getPixel(Math.floor(png.width / 2), cy);

  // Finds the sphere's left silhouette by scanning inward from the
  // corner's known-background color until a pixel meaningfully departs
  // from it, then samples a few pixels further in (still on the ball,
  // close to the grazing-angle rim).
  let edgeX = -1;
  for (let x = 0; x < png.width; x++) {
    const p = png.getPixel(x, cy);
    if (rednessExcess(p) < rednessExcess(corner) - 40) { edgeX = x; break; }
  }
  expect(edgeX).toBeGreaterThan(-1);
  const nearSilhouette = png.getPixel(Math.min(edgeX + 6, png.width - 1), cy);

  // Real glass: the rim reads meaningfully more opaque (less backdrop
  // bleed) than dead center. A flat fold regresses this back to ~0.
  expect(rednessExcess(center) - rednessExcess(nearSilhouette)).toBeGreaterThan(30);
});
