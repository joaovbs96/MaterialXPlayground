// tests/embed/env-overflow.spec.mjs: a bright real-world .hdr/.exr
// overflows three r128's non-clamping half-float conversion into NaN,
// which used to poison the whole IBL pipeline black. Covers the
// sanitizer (js/mtlx-engine.js sanitizeHalfEnvData) end to end via the
// real #!viewer Environment FilePickerField.

import fs from 'node:fs';
import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';
import { makeHotHdr, makeHotExr } from './lib/env-fixtures.mjs';

const ENVIRONMENT_INPUT = 'input[type=file][accept=".hdr,.exr"]';

async function gotoViewer(page, embedURL) {
  await page.goto(embedURL + '/index.html#!viewer');
  await page.locator(ENVIRONMENT_INPUT).waitFor({ state: 'attached', timeout: WAIT_TIMEOUT });
}

async function uploadEnv(page, name, buffer) {
  await page.locator(ENVIRONMENT_INPUT).setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  return page.waitForFunction(() => window.getEnvOverride && window.getEnvOverride(), null, { timeout: WAIT_TIMEOUT });
}

// Scans the parsed radiance texture in-page (a 1024x512 RGBA env is 2M
// halves, far too many to ship through evaluate or feed to expect one
// by one) and returns the offending counts plus the key light.
async function inspectEnv(page) {
  return page.evaluate(() => {
    const e = window.getEnvOverride();
    const data = e.radiance.image.data;
    const stride = data.length / (e.radiance.image.width * e.radiance.image.height);
    let overflow = 0, badAlpha = 0;
    for (let i = 0; i < data.length; i += stride) {
      for (let c = 0; c < 3; c++) if ((data[i + c] & 0x7C00) === 0x7C00) overflow++;
      if (stride === 4 && data[i + 3] !== 0x3C00) badAlpha++;
    }
    const k = e.keyLight;
    return {
      stride, overflow, badAlpha, isHalf: data.constructor === Uint16Array,
      keyLight: k ? { direction: [k.direction.x, k.direction.y, k.direction.z], intensity: k.intensity } : null,
    };
  });
}

function assertSanitized(env) {
  expect(env.isHalf).toBe(true);
  expect(env.overflow).toBe(0);
  expect(env.badAlpha).toBe(0);
}

async function assertBrightPixelSurvives(page) {
  const canvas = page.locator('canvas').first();
  await page.waitForTimeout(300); // a beat for the new env to reach the render
  const png = decodePNG(await canvas.screenshot());
  let maxChannel = 0;
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const p = png.getPixel(x, y);
      maxChannel = Math.max(maxChannel, p.r, p.g, p.b);
    }
  }
  expect(maxChannel).toBeGreaterThan(8);
}

// The 4x2 fixtures can never reach KEYLIGHT_MIN_CONTRAST (the hot texel
// is too large a share of its own mean), so keyLight stays null here;
// the real-file test below covers extraction. These prove the clamp only.
test('@smoke a hot .hdr environment does not blacken the render', async ({ page, embedURL }) => {
  await gotoViewer(page, embedURL);
  await uploadEnv(page, 'hot.hdr', makeHotHdr());
  const env = await inspectEnv(page);
  assertSanitized(env);
  await assertBrightPixelSurvives(page);
});

test('a hot .exr environment does not blacken the render', async ({ page, embedURL }) => {
  await gotoViewer(page, embedURL);
  await uploadEnv(page, 'hot.exr', makeHotExr());
  const env = await inspectEnv(page);
  assertSanitized(env);
  await assertBrightPixelSurvives(page);
});

test('the normal-range fixture .hdr does not trigger the overflow sanitizer', async ({ page, embedURL }) => {
  const logs = [];
  page.on('console', (msg) => { if (msg.type() === 'info') logs.push(msg.text()); });
  await gotoViewer(page, embedURL);
  const buffer = fs.readFileSync('tests/embed/fixtures/env/test-env.hdr');
  await uploadEnv(page, 'test-env.hdr', buffer);
  expect(logs.some((l) => l.includes('[env-sanitize]'))).toBe(false);
});

test('a real-world overflowing .exr (MTLX_ENV_FILE) does not blacken the render', async ({ page, embedURL }) => {
  test.skip(!process.env.MTLX_ENV_FILE, 'requires MTLX_ENV_FILE to point at a real overflowing .exr');
  const filePath = process.env.MTLX_ENV_FILE;
  const buffer = fs.readFileSync(filePath);
  const logs = [];
  page.on('console', (msg) => { if (msg.type() === 'info') logs.push(msg.text()); });
  await gotoViewer(page, embedURL);
  await uploadEnv(page, 'real-env.exr', buffer);
  const env = await inspectEnv(page);
  console.log('[env-overflow] real-file sanitize logs:', logs);
  console.log('[env-overflow] real-file keyLight:', JSON.stringify(env.keyLight));
  expect(env.keyLight).not.toBeNull();
  assertSanitized(env);
  await assertBrightPixelSurvives(page);
});
