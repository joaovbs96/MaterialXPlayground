// M1.2 bias-policy gate: shadow-wing-sphere.usda via the file picker,
// isolated to the direct light (flat black env, no sky/AO/bloom). Four
// ground controls checked by both render ratio and __shadowProbe.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';

const fixtureRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'usd-scene');
const fixtureFile = (name) => ({ name, mimeType: 'text/plain', buffer: fs.readFileSync(path.join(fixtureRoot, name)) });

const POINTS = {
  blocked: [-1.3, 0.01, 0.8],
  litLeft: [-5, 0.01, 0.8],
  litRight: [3, 0.01, 0.8],
  litFront: [-1.3, 0.01, 3],
};
const LIGHT_PATH = '/Scene/LampLight';
const CAMERA_PATH = '/Scene/ShadowCam';

test('@scene sphere light umbra/lit ground controls agree between render and shadow probe', async ({ page, embedURL }, testInfo) => {
  await page.goto(embedURL + '/index.html#!scene');
  await expect(page.getByTestId('usd-scene-viewer')).toBeVisible();
  await page.getByTestId('usd-scene-file-picker').setInputFiles([
    fixtureFile('shadow-wing-sphere.usda'),
    fixtureFile('shadow-wing-material.mtlx'),
  ]);
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await expect(page.getByTestId('usd-scene-error')).toHaveCount(0);

  const result = await page.evaluate(({ points, lightPath, cameraPath }) => {
    const h = window.__mtlxUsdSceneHandle;
    const THREE = window.THREE;
    h.setBackdrop('none');
    h.setEnvironment(window.makeFlatEnvironment([0, 0, 0]));
    h.setEnvExposure(0);
    h.setSkyVisibility(false);
    h.setAmbientOcclusionEnabled(false);
    h.setStageLightsEnabled(true);
    h.setStageLightsEv(0);
    h.applyCamera(cameraPath);
    h.setSceneDisplayTransform('lin_rec709');
    h.setPresentation({ enabled: true, bloom: false, antialias: false, samples: 0, persist: false });

    const renderer = h.renderer; const camera = h.camera; const scene = h.scene;
    const gl = renderer.getContext();
    const width = 1600; const height = 900;
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    const target = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.FloatType, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
    });
    const luma = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
    const raycaster = new THREE.Raycaster();

    const render = (shadows) => {
      h.setShadowsEnabled(shadows);
      h.renderNow();
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, camera);
      const rows = {};
      for (const [name, point] of Object.entries(points)) {
        const ndc = new THREE.Vector3(...point).project(camera);
        if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) throw new Error(name + ' offscreen');
        const x = Math.floor((ndc.x * 0.5 + 0.5) * width);
        const y = Math.floor((ndc.y * 0.5 + 0.5) * height);
        const px = new Float32Array(4);
        renderer.readRenderTargetPixels(target, x, y, 1, 1, px);
        raycaster.setFromCamera(new THREE.Vector2((x + 0.5) / width * 2 - 1, (y + 0.5) / height * 2 - 1), camera);
        const hit = raycaster.intersectObjects(scene.children, true)
          .find((entry) => /Ground/.test((entry.object && entry.object.name) || ''));
        rows[name] = { point, pixel: Array.from(px), hitPoint: hit ? hit.point.toArray() : null };
      }
      return rows;
    };

    let off; let on;
    try {
      off = render(false);
      on = render(true);
    } finally {
      renderer.setRenderTarget(null);
      target.dispose();
    }

    // The sphere light is an 'omni' caster (six cube faces, world-axis
    // basis), so the probe face is whichever face the same major-axis
    // test the shader's mx_face resolution would pick.
    const debug = h.__shadowDebug();
    const lightTiles = debug.tiles
      .map((t, index) => ({ ...t, index }))
      .filter((t) => t.caster === lightPath);
    if (!lightTiles.length) throw new Error('sphere light produced no shadow faces');
    const lightPos = lightTiles[0].cameraPosition;
    const faceFor = (point) => {
      const dx = point[0] - lightPos[0]; const dy = point[1] - lightPos[1]; const dz = point[2] - lightPos[2];
      const ax = Math.abs(dx); const ay = Math.abs(dy); const az = Math.abs(dz);
      const label = ax >= ay && ax >= az ? (dx >= 0 ? '+X' : '-X')
        : ay >= ax && ay >= az ? (dy >= 0 ? '+Y' : '-Y') : (dz >= 0 ? '+Z' : '-Z');
      const tile = lightTiles.find((t) => t.face === label);
      if (!tile) throw new Error('no shadow face for axis ' + label);
      return tile.index;
    };

    const rows = Object.fromEntries(Object.keys(points).map((name) => [name, {
      ...off[name], on: on[name].pixel,
      ratio: luma(on[name].pixel) / Math.max(luma(off[name].pixel), 1e-12),
    }]));
    const probes = Object.fromEntries(Object.keys(points).map((name) => {
      const hitPoint = rows[name].hitPoint;
      if (!hitPoint) return [name, null];
      return [name, h.__shadowProbe(hitPoint, faceFor(hitPoint), [0, 1, 0])];
    }));

    const glError = gl.getError();
    return { rows, probes, lightTiles, glError };
  }, { points: POINTS, lightPath: LIGHT_PATH, cameraPath: CAMERA_PATH });

  const evidencePath = process.env.MTLX_RENDER_RESULTS
    ? path.join(process.env.MTLX_RENDER_RESULTS, 'sphere-geometric.json')
    : testInfo.outputPath('sphere-geometric.json');
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, JSON.stringify(result, null, 2));

  expect(result.glError).toBe(0);
  expect(result.rows.blocked.ratio).toBeLessThan(0.05);
  for (const name of ['litLeft', 'litRight', 'litFront']) {
    expect(result.rows[name].ratio, name).toBeGreaterThan(0.95);
  }
  expect(result.probes.blocked).not.toBeNull();
  expect(result.probes.blocked.filteredVisibility).toBeLessThan(0.05);
  expect(result.probes.blocked.reference.classification).toBe('deep-umbra');
  for (const name of ['litLeft', 'litRight', 'litFront']) {
    expect(result.probes[name], name).not.toBeNull();
    expect(result.probes[name].filteredVisibility, name).toBeGreaterThan(0.95);
    expect(result.probes[name].reference.classification, name).toBe('lit');
  }
});
