// tests/embed/usd-scene-transmission-shadow.spec.mjs: Milestone 2 gate for
// colored light transmittance. White light through a green transmissive
// dielectric must tint the ground green; an opaque occluder must fully
// block; opacity-only coverage must stay neutral gray; a camera looking
// through a transmissive box must see the backdrop tinted through it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene');
const outDir = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\raster-quality\\transmission-gate';
fs.mkdirSync(outDir, { recursive: true });

function fixtureFile(relativePath) {
  return { name: relativePath, mimeType: 'text/plain', buffer: fs.readFileSync(path.join(fixtureRoot, relativePath)) };
}

function savePng(name, dataUrl) {
  fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
}

// Shared shadow rig geometry, authored identically into every
// transmission-*-root.usda: one DistantLight and a 2x0.1x2 occluder
// centered at x=0,z=0, y in [0.95,1.05], on a 6x6 ground plane.
//
// The occluder's cast shadow direction was found empirically (a top-down
// brightness probe along x=0, logged as transmission-probe:*), not by
// trusting a hand-derived light-direction formula: it darkens the ground
// from about z=-0.5 to z=-2.5, brightest darkening around z=-1..-1.5, and
// nothing at all on the +z side. inner/ring below sample that band.
const OCCLUDER_HALF = 1;
const OCCLUDER_Y_HIGH = 1.05;
const CAMERA_PATH = '/Scene/TransmissionCam';

// Both rects sit on the same (shadowed) side of the occluder so ambient
// falloff can't explain a difference; only the shadow can. ring is
// further out, past where the probe found the shadow ends.
const INNER_RECT = { xMin: -0.85, xMax: 0.85, zMin: -1.6, zMax: -1.1 };
const RING_RECT = { xMin: 1.15, xMax: 1.85, zMin: -1.6, zMax: -1.1 };

// Top-down and high enough to see the occluder, its shadow, and open
// ground beyond it with no self-occlusion ambiguity (the same rig the
// reference usd-scene-shadows.spec.mjs raw-API tests use).
const SHADOW_CAMERA_POSE = { position: [0, 7, 0.0001], target: [0, 0, -1], up: [0, 0, -1], fov: 50 };

function rectPolygon(rect, y = 0.02) {
  return [
    [rect.xMin, y, rect.zMin], [rect.xMax, y, rect.zMin],
    [rect.xMax, y, rect.zMax], [rect.xMin, y, rect.zMax],
  ];
}

function gridPoints(rect, n, y = 0.02) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = rect.xMin + (rect.xMax - rect.xMin) * (i + 0.5) / n;
      const z = rect.zMin + (rect.zMax - rect.zMin) * (j + 0.5) / n;
      pts.push([x, y, z]);
    }
  }
  return pts;
}

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function meanLinearColor(pixels) {
  const sum = [0, 0, 0];
  for (const [r, g, b] of pixels) {
    sum[0] += srgbToLinear(r); sum[1] += srgbToLinear(g); sum[2] += srgbToLinear(b);
  }
  const n = Math.max(1, pixels.length);
  return [sum[0] / n, sum[1] / n, sum[2] / n];
}

const EPS = 1e-4;
function luminance([r, g, b]) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
function gr([r, g]) { return g / Math.max(r, EPS); }
function gb([, g, b]) { return g / Math.max(b, EPS); }

async function loadScene(page, embedURL, rootFile, mtlxFiles, cameraPath, cameraPose) {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  // Force a fresh profile so "Transparency on" is the actual Scene default,
  // not a leftover preference from an earlier test in this worker.
  await page.evaluate(() => {
    localStorage.removeItem('mtlxUsdSceneTransparency');
    localStorage.removeItem('mtlxForceTransparency');
  });
  await page.reload();
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof window.getUsdSceneTransparency === 'function'
    && window.getUsdSceneTransparency())).toBe(true);
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile(rootFile),
    ...mtlxFiles.map(fixtureFile),
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);
  await page.waitForFunction(() => !!window.__mtlxUsdSceneHandle, null, { timeout: 30000 });
  await page.evaluate(({ cameraPath, cameraPose }) => {
    const h = window.__mtlxUsdSceneHandle;
    // The app auto-frames a default camera on load, ignoring the authored
    // camera prim. Explicitly select it back so the fixture's own framing
    // is what actually renders (or is the base for an override below).
    if (cameraPath && h.applyCamera) h.applyCamera(cameraPath);
    // A hand-authored USD rotateXYZ for an exact framing is easy to get
    // wrong; THREE's own lookAt is the ground truth.
    if (cameraPose) {
      h.camera.position.set(...cameraPose.position);
      h.camera.up.set(...(cameraPose.up || [0, 1, 0]));
      h.camera.lookAt(new window.THREE.Vector3(...cameraPose.target));
      if (cameraPose.fov) h.camera.fov = cameraPose.fov;
      h.camera.updateProjectionMatrix();
      h.camera.updateMatrixWorld(true);
    }
    // The default studio backdrop/dome light washes out this single-light
    // rig; strip it so the authored DistantLight is the only illumination.
    h.setBackdrop('none');
    h.setAmbientOcclusionEnabled(false);
    h.renderNow();
  }, { cameraPath, cameraPose });
  await page.waitForTimeout(100);
}

// One round trip: renders, round-trips the canvas through an <img> (a
// WebGL canvas's drawing buffer can be gone by the time a later task
// reads it directly), projects every sample/outline point with the live
// camera, and draws a debug overlay saved as a PNG for visual review.
async function captureShadowVariant(page, { innerPts, ringPts, boxCorners, innerPoly, ringPoly }) {
  return page.evaluate(async ({ innerPts, ringPts, boxCorners, innerPoly, ringPoly }) => {
    const handle = window.__mtlxUsdSceneHandle;
    const canvas = document.querySelector('[data-testid="usd-scene-canvas"] canvas');
    const camera = handle.camera;
    if (handle.renderNow) handle.renderNow();
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = canvas.toDataURL('image/png');
    });
    const project = (p) => {
      const v = new window.THREE.Vector3(p[0], p[1], p[2]).project(camera);
      return [(v.x * 0.5 + 0.5) * canvas.width, (-v.y * 0.5 + 0.5) * canvas.height];
    };
    const off = document.createElement('canvas');
    off.width = canvas.width; off.height = canvas.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const readPixel = (sx, sy) => {
      const x = Math.max(0, Math.min(off.width - 1, Math.round(sx)));
      const y = Math.max(0, Math.min(off.height - 1, Math.round(sy)));
      const d = ctx.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const sample = (pts) => pts.map((p) => readPixel(...project(p)));
    const innerPixels = sample(innerPts);
    const ringPixels = sample(ringPts);
    const boxScreen = boxCorners.map(project);
    const boxXs = boxScreen.map((p) => p[0]);
    const boxYs = boxScreen.map((p) => p[1]);
    const boxBBox = { x0: Math.min(...boxXs), x1: Math.max(...boxXs), y0: Math.min(...boxYs), y1: Math.max(...boxYs) };
    const slabPixels = [];
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) {
        const sx = boxBBox.x0 + (boxBBox.x1 - boxBBox.x0) * (i + 0.5) / 6;
        const sy = boxBBox.y0 + (boxBBox.y1 - boxBBox.y0) * (j + 0.5) / 6;
        slabPixels.push(readPixel(sx, sy));
      }
    }
    ctx.lineWidth = 2;
    const strokePoly = (pts, color) => {
      ctx.strokeStyle = color; ctx.beginPath();
      pts.forEach((p, i) => { const [sx, sy] = project(p); if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); });
      ctx.closePath(); ctx.stroke();
    };
    strokePoly(innerPoly, 'red');
    strokePoly(ringPoly, 'cyan');
    strokePoly(boxCorners, 'magenta');
    return { innerPixels, ringPixels, slabPixels, dataUrl: off.toDataURL('image/png') };
  }, { innerPts, ringPts, boxCorners, innerPoly, ringPoly });
}

function stddevGray(pixels) {
  const gray = pixels.map(([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b);
  const mean = gray.reduce((a, b) => a + b, 0) / gray.length;
  const variance = gray.reduce((a, b) => a + (b - mean) ** 2, 0) / gray.length;
  return Math.sqrt(variance);
}

async function runShadowVariant(page, embedURL, name, rootFile, mtlxFiles) {
  await loadScene(page, embedURL, rootFile, mtlxFiles, CAMERA_PATH, SHADOW_CAMERA_POSE);
  const uniformDiag = await page.evaluate(() => {
    const h = window.__mtlxUsdSceneHandle;
    const occluder = h.prims.find((p) => p.userData && p.userData.primPath === '/Scene/Occluder');
    const material = occluder && occluder.material;
    const uniforms = material && material.uniforms ? Object.keys(material.uniforms) : [];
    const findU = (frag) => uniforms.filter((n) => n.toLowerCase().includes(frag));
    const read = (names) => Object.fromEntries(names.map((n) => {
      const v = material.uniforms[n].value;
      return [n, v && v.isVector3 ? [v.x, v.y, v.z] : v];
    }));
    return {
      hasMaterial: !!material,
      transmissionUniforms: read(findU('transmission')),
      thinWalledUniforms: read(findU('thin')),
      opacityUniforms: read(findU('opacity')),
    };
  });
  console.log('[transmission-uniforms:' + name + ']', JSON.stringify(uniformDiag));
  const innerPts = gridPoints(INNER_RECT, 4);
  const ringPts = gridPoints(RING_RECT, 4);
  const boxCorners = [
    [-OCCLUDER_HALF, OCCLUDER_Y_HIGH, -OCCLUDER_HALF], [OCCLUDER_HALF, OCCLUDER_Y_HIGH, -OCCLUDER_HALF],
    [OCCLUDER_HALF, OCCLUDER_Y_HIGH, OCCLUDER_HALF], [-OCCLUDER_HALF, OCCLUDER_Y_HIGH, OCCLUDER_HALF],
  ];
  const result = await captureShadowVariant(page, {
    innerPts, ringPts, boxCorners,
    innerPoly: rectPolygon(INNER_RECT), ringPoly: rectPolygon(RING_RECT),
  });
  savePng('transmission-' + name, result.dataUrl);
  const innerMean = meanLinearColor(result.innerPixels);
  const ringMean = meanLinearColor(result.ringPixels);
  const metrics = {
    shadowLum: luminance(innerMean) / Math.max(luminance(ringMean), EPS),
    shadowGR: gr(innerMean) / Math.max(gr(ringMean), EPS),
    shadowGB: gb(innerMean) / Math.max(gb(ringMean), EPS),
    innerMean, ringMean,
    slabStddev: stddevGray(result.slabPixels),
  };
  console.log('[transmission-shadow:' + name + ']', JSON.stringify(metrics));
  return metrics;
}

test('@scene colored transmission tints the shadow green while opaque and opacity-only occluders stay neutral', async ({ page, embedURL }) => {
  const c = await runShadowVariant(page, embedURL, 'opaque', 'transmission-opaque-root.usda', ['transmission-ground.mtlx', 'transmission-opaque.mtlx']);
  expect.soft(c.shadowLum, 'opaque shadowLum').toBeLessThan(0.25);

  const a = await runShadowVariant(page, embedURL, 'thin', 'transmission-thin-root.usda', ['transmission-ground.mtlx', 'transmission-thin.mtlx']);
  expect.soft(a.shadowGR, 'thin-walled shadowGR').toBeGreaterThan(2.0);
  expect.soft(a.shadowLum, 'thin-walled shadowLum').toBeGreaterThan(0.15);
  expect.soft(a.shadowLum, 'thin-walled shadowLum').toBeLessThan(0.9);
  expect.soft(a.slabStddev, 'thin-walled slab reflective variation').toBeGreaterThan(1.5);

  const b = await runShadowVariant(page, embedURL, 'solid', 'transmission-solid-root.usda', ['transmission-ground.mtlx', 'transmission-solid.mtlx']);
  expect.soft(b.shadowGR, 'solid shadowGR').toBeGreaterThan(2.0);

  const b2 = await runShadowVariant(page, embedURL, 'solid-thick', 'transmission-solid-thick-root.usda', ['transmission-ground.mtlx', 'transmission-solid-thick.mtlx']);
  expect.soft(b2.shadowLum, 'thicker solid absorbs more').toBeLessThan(b.shadowLum);

  const d = await runShadowVariant(page, embedURL, 'opacity', 'transmission-opacity-root.usda', ['transmission-ground.mtlx', 'transmission-opacity.mtlx']);
  expect.soft(d.shadowLum, 'opacity-only shadowLum').toBeGreaterThan(0.3);
  expect.soft(d.shadowLum, 'opacity-only shadowLum').toBeLessThan(0.8);
  expect.soft(d.shadowGR, 'opacity-only shadowGR neutral').toBeGreaterThan(0.85);
  expect.soft(d.shadowGR, 'opacity-only shadowGR neutral').toBeLessThan(1.15);
});

test('@scene camera through a solid transmissive box sees the backdrop tinted green', async ({ page, embedURL }) => {
  await loadScene(page, embedURL, 'transmission-refract-root.usda', [
    'transmission-solid.mtlx', 'transmission-backdrop-light.mtlx', 'transmission-backdrop-dark.mtlx',
  ], '/Scene/RefractCam');

  // Two backdrop points directly behind the box (occluded from a direct
  // line of sight) and two at the same y/z but outside the box's x-range
  // (seen directly), one per stripe color on each side.
  const points = {
    insideLight: [0.25, 1, 0], insideDark: [-0.25, 1, 0],
    outsideLight: [1.25, 1, 0], outsideDark: [-1.25, 1, 0],
  };
  const boxCorners = [
    [-0.5, 1.5, 1.85], [0.5, 1.5, 1.85], [0.5, 1.5, 2.15], [-0.5, 1.5, 2.15],
  ];

  async function capture() {
    return page.evaluate(async ({ points, boxCorners }) => {
      const handle = window.__mtlxUsdSceneHandle;
      const canvas = document.querySelector('[data-testid="usd-scene-canvas"] canvas');
      const camera = handle.camera;
      if (handle.renderNow) handle.renderNow();
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = canvas.toDataURL('image/png');
      });
      const project = (p) => {
        const v = new window.THREE.Vector3(p[0], p[1], p[2]).project(camera);
        return [(v.x * 0.5 + 0.5) * canvas.width, (-v.y * 0.5 + 0.5) * canvas.height];
      };
      const off = document.createElement('canvas');
      off.width = canvas.width; off.height = canvas.height;
      const ctx = off.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const readPixel = (sx, sy) => {
        const x = Math.max(0, Math.min(off.width - 1, Math.round(sx)));
        const y = Math.max(0, Math.min(off.height - 1, Math.round(sy)));
        const d = ctx.getImageData(x, y, 1, 1).data;
        return [d[0], d[1], d[2]];
      };
      const out = {};
      for (const [key, world] of Object.entries(points)) out[key] = readPixel(...project(world));
      ctx.lineWidth = 2; ctx.strokeStyle = 'magenta'; ctx.beginPath();
      boxCorners.forEach((p, i) => { const [sx, sy] = project(p); if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy); });
      ctx.closePath(); ctx.stroke();
      return { pixels: out, dataUrl: off.toDataURL('image/png') };
    }, { points, boxCorners });
  }

  const on = await capture();
  savePng('transmission-refract-on', on.dataUrl);
  await page.evaluate(() => window.setUsdSceneTransparency && window.setUsdSceneTransparency(false, { persist: false }));
  await page.waitForTimeout(150);
  const off = await capture();
  savePng('transmission-refract-off', off.dataUrl);
  await page.evaluate(() => window.setUsdSceneTransparency && window.setUsdSceneTransparency(true, { persist: false }));

  function metrics(sample) {
    const iL = meanLinearColor([sample.insideLight]);
    const iD = meanLinearColor([sample.insideDark]);
    const oL = meanLinearColor([sample.outsideLight]);
    const oD = meanLinearColor([sample.outsideDark]);
    const insideContrast = (luminance(iL) - luminance(iD)) / Math.max(luminance(iL) + luminance(iD), EPS);
    const outsideContrast = (luminance(oL) - luminance(oD)) / Math.max(luminance(oL) + luminance(oD), EPS);
    const insideGR = (gr(iL) + gr(iD)) / 2;
    const outsideGR = (gr(oL) + gr(oD)) / 2;
    return { insideContrast, outsideContrast, insideGR, outsideGR, raw: sample };
  }

  const onMetrics = metrics(on.pixels);
  const offMetrics = metrics(off.pixels);
  console.log('[transmission-refract:on]', JSON.stringify(onMetrics));
  console.log('[transmission-refract:off]', JSON.stringify(offMetrics));

  expect(onMetrics.insideContrast, 'pattern visible through the box').toBeGreaterThan(0.2 * onMetrics.outsideContrast);
  expect(onMetrics.insideGR, 'green tint through the box').toBeGreaterThan(1.3 * onMetrics.outsideGR);
});
