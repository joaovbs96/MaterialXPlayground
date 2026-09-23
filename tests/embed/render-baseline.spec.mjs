// tests/embed/render-baseline.spec.mjs: @smoke render-parity baseline (P0).
// Boots the embed engine ONCE, loads the first tracked material via `src`,
// then the other two through the live load(xml, opts) protocol
// (embed/mtlx-viewer.js, posts into the running iframe, no WASM reboot -
// a `src` reload per material was ~3x this file's CI budget under
// SwiftShader). Reads the live preview's generated vertex/fragment GLSL off
// the render-view handle (window.__mtlxViewerHandle.vs/fs, set by
// js/viewer-app.jsx) and sha256s them against a committed fixture. Set
// RENDER_BASELINE_UPDATE=1 to (re)write that fixture.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  test, expect, gotoHarness,
  createViewer, waitForEventCount,
} from './lib/test-base.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const BASELINE_PATH = path.join(FIXTURES_DIR, 'render-baseline.json');

// One plain standard_surface (booted via `src`), one textured, one
// transmissive (forces the depth-peel/transparent path) - the last two
// loaded live via el.load(), so no second/third WASM boot.
const PLAIN_PATH = '/tests/embed/fixtures/multi-material.mtlx';
const TEXTURED_PATH = '/tests/embed/fixtures/textured.mtlx';
const GLASS_PATH = '/tests/embed/fixtures/glass.mtlx';

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

test('@smoke render baseline: generated shader sources match the committed hashes', async ({ page, embedURL }) => {
  // One real boot plus two live loads, measured locally at well under 30s;
  // CI's software WebGL runs 6-7x slower, so this covers that with margin
  // while staying under the embed job's own 8-minute timeout.
  test.setTimeout(240000);

  await gotoHarness(page, embedURL);

  const idx = await createViewer(page, {
    base: embedURL + '/embed/',
    src: embedURL + PLAIN_PATH,
    geometry: 'sphere',
    eager: true,
  });

  await waitForEventCount(page, idx, 'mtlx-ready', 1);
  await waitForEventCount(page, idx, 'mtlx-renderables', 1);
  await page.waitForTimeout(300); // beat for the first real frame to settle

  // The iframe never reloads after this (load() posts into it live), so it
  // is located once and reused for every material below.
  const iframeUrl = await page.evaluate((j) => window.__viewers[j].shadowRoot.querySelector('iframe').src, idx);
  const iframe = page.frames().find((f) => f.url() === iframeUrl);
  expect(iframe, 'viewer iframe').toBeTruthy();

  // Reads {vs, fs, samples} off the live handle and sha256s the sources.
  // Pixel variance across a few sampled points on a 32x32 readback stands
  // in for "canvas is non-blank" - snapshotPixels reads inside the iframe
  // (js/mtlx-engine.js:12531), avoiding an element screenshot, which can
  // hang under CI's SwiftShader.
  async function readMaterial(relPath) {
    const result = await iframe.evaluate(() => {
      const h = window.__mtlxViewerHandle;
      const img = h.snapshotPixels(32, 32);
      const at = (x, y) => {
        const o = (y * img.width + x) * 4;
        return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
      };
      return {
        vs: h.vs,
        fs: h.fs,
        samples: [at(2, 2), at(img.width >> 1, img.height >> 1), at(img.width - 3, img.height - 3)],
      };
    });
    const distinct = new Set(result.samples.map((p) => p.join(',')));
    expect(distinct.size, `${relPath} canvas non-blank`).toBeGreaterThan(1);
    return { vs: sha256(result.vs), fs: sha256(result.fs) };
  }

  // Loads a material live (no reboot) and waits until window.__mtlxViewerHandle
  // becomes a NEW object (the effect that rebuilds it runs asynchronously
  // after load()'s own promise resolves, so a plain truthy check would race
  // a stale handle from the previous material). The prev-handle marker MUST
  // be captured before load() is even sent, never after awaiting it: by the
  // time load() resolves the new handle may already be live, and capturing
  // "prev" then would just compare the new handle to itself and hang.
  async function loadLive(xml, opts) {
    await iframe.evaluate(() => { window.__mtlxPrevHandle = window.__mtlxViewerHandle; });
    await page.evaluate(({ j, xml, opts }) => window.__viewers[j].load(xml, opts), { j: idx, xml, opts });
    await iframe.waitForFunction(() => {
      const h = window.__mtlxViewerHandle;
      return !!h && h !== window.__mtlxPrevHandle && !!h.vs && !!h.fs;
    });
  }

  const results = {};
  await iframe.waitForFunction(() => !!window.__mtlxViewerHandle?.vs && !!window.__mtlxViewerHandle?.fs);
  results[PLAIN_PATH] = await readMaterial(PLAIN_PATH);

  const texturedXml = fs.readFileSync(path.join(FIXTURES_DIR, 'textured.mtlx'), 'utf8');
  const texturePng = fs.readFileSync(path.join(FIXTURES_DIR, 'textures', 'uv-test.png')).toString('base64');
  await loadLive(texturedXml, { textures: { 'textures/uv-test.png': texturePng } });
  results[TEXTURED_PATH] = await readMaterial(TEXTURED_PATH);

  const glassXml = fs.readFileSync(path.join(FIXTURES_DIR, 'glass.mtlx'), 'utf8');
  await loadLive(glassXml);
  results[GLASS_PATH] = await readMaterial(GLASS_PATH);

  const errors = await page.evaluate((j) => window.__viewers[j].__events.filter((e) => e.type === 'mtlx-error'), idx);
  expect(errors).toEqual([]);

  if (process.env.RENDER_BASELINE_UPDATE === '1') {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(results, null, 2) + '\n');
    return;
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  expect(results).toEqual(baseline);
});
