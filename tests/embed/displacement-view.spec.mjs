// tests/embed/displacement-view.spec.mjs: P5 acceptance for displacement
// wired into createMtlxRenderView (subdivide + CPU displace + swap).
// Runs against the real #!viewer engine globals, inline .mtlx strings only.

import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

async function gotoEngine(page, embedURL) {
  await page.goto(embedURL + '/index.html#!viewer');
  await page.waitForFunction(
    () => window.getMxEnv && window.createMtlxRenderView && window.THREE,
    null, { timeout: WAIT_TIMEOUT }
  );
}

// Float-constant displacement (0.2) scaled by 0.5 -> a uniform 0.1 offset
// along the normal, same fixture shape as displacement-bake's FLOAT_CONST_MTLX.
const SCALE_A_MTLX = `<?xml version="1.0"?>
<materialx version="1.39">
  <standard_surface name="surf" type="surfaceshader" />
  <displacement name="disp" type="displacementshader">
    <input name="displacement" type="float" value="0.2" />
    <input name="scale" type="float" value="0.5" />
  </displacement>
  <surfacematerial name="mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surf" />
    <input name="displacementshader" type="displacementshader" nodename="disp" />
  </surfacematerial>
</materialx>`;

// Same shape, larger scale (0.2 * 1.0 = 0.2 offset), for the "changed
// scale re-evaluates" case.
const SCALE_B_MTLX = `<?xml version="1.0"?>
<materialx version="1.39">
  <standard_surface name="surf" type="surfaceshader" />
  <displacement name="disp" type="displacementshader">
    <input name="displacement" type="float" value="0.2" />
    <input name="scale" type="float" value="1.0" />
  </displacement>
  <surfacematerial name="mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surf" />
    <input name="displacementshader" type="displacementshader" nodename="disp" />
  </surfacematerial>
</materialx>`;

const NO_DISPLACEMENT_MTLX = `<?xml version="1.0"?>
<materialx version="1.39">
  <standard_surface name="surf" type="surfaceshader" />
  <surfacematerial name="mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surf" />
  </surfacematerial>
</materialx>`;

// Runs entirely inside the page: parses xml, creates a real createMtlxRenderView
// shell on a fresh canvas, stashes { view, env } on window.__disp for later
// steps in the same test, and returns an initial stats snapshot.
async function setupView(page, { xml, geomName, materialName = null, triangleBudget, forceFailure = false }) {
  return page.evaluate(async ({ xml, geomName, materialName, triangleBudget, forceFailure }) => {
    if (forceFailure) window.__mtlxForceDisplacementFailure = true;
    if (Number.isFinite(triangleBudget)) window.__mtlxTriangleBudgetOverride = triangleBudget;

    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const { name: resolvedMaterialName, node: renderable } = window.listDocRenderables(doc)[0];

    const canvas = document.createElement('canvas');
    canvas.style.width = '256px';
    canvas.style.height = '256px';
    document.body.appendChild(canvas);

    const view = await window.createMtlxRenderView({
      canvas, mx: env.mx, gen: env.gen, genContext: env.genContext, renderable,
      label: 'displacement-view-test', geomName, needsLighting: true,
      materialName: materialName || resolvedMaterialName,
      triangleBudget,
      isMounted: () => true,
    });

    window.__disp = { view, env, canvas };
    const d = view.__debug();
    const g = d.geometry;
    g.computeBoundingSphere();
    return {
      state: view.getDisplacementState(),
      triangles: g.index ? g.index.count / 3 : g.attributes.position.count / 3,
      radius: g.boundingSphere ? g.boundingSphere.radius : null,
      notices: view.notices,
    };
  }, { xml, geomName, materialName, triangleBudget, forceFailure });
}

// Reads the same stats shape for the CURRENT window.__disp.view, after some
// mutation the test already triggered.
async function readStats(page) {
  return page.evaluate(() => {
    const { view } = window.__disp;
    const d = view.__debug();
    const g = d.geometry;
    g.computeBoundingSphere();
    return {
      state: view.getDisplacementState(),
      triangles: g.index ? g.index.count / 3 : g.attributes.position.count / 3,
      radius: g.boundingSphere ? g.boundingSphere.radius : null,
      notices: view.notices,
    };
  });
}

async function settle(page) {
  await page.evaluate(() => window.__disp.view.whenDisplacementSettled());
}

test.describe('displacement wired into createMtlxRenderView', () => {
  test('sphere: bounding sphere grows by the offset, triangles = base * 16 at level 2', async ({ page, embedURL }) => {
    await gotoEngine(page, embedURL);
    const before = await page.evaluate(() => {
      const g = new window.THREE.SphereGeometry(1, 64, 64);
      const base = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      g.dispose();
      return base;
    });
    const r = await setupView(page, { xml: SCALE_A_MTLX });
    await settle(page);
    const after = await readStats(page);

    expect(after.state.state).toBe('applied');
    expect(after.state.level).toBe(2);
    expect(after.state.capped).toBe(false);
    expect(after.triangles).toBe(before * 16);
    // Unit sphere, uniform 0.1 offset along the normal -> radius ~1.1.
    expect(after.radius).toBeGreaterThan(1.05);
    expect(after.radius).toBeLessThan(1.15);
    expect(r).toBeTruthy(); // setup itself didn't throw
  });

  test('setDisplacementEnabled(false) restores the exact original triangle count and bounds, re-enabling re-applies', async ({ page, embedURL }) => {
    await gotoEngine(page, embedURL);
    const baseTriangles = await page.evaluate(() => {
      const g = new window.THREE.SphereGeometry(1, 64, 64);
      const base = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      g.dispose();
      return base;
    });
    await setupView(page, { xml: SCALE_A_MTLX });
    await settle(page);
    const applied = await readStats(page);
    expect(applied.state.state).toBe('applied');
    expect(applied.triangles).toBe(baseTriangles * 16);

    await page.evaluate(() => window.setDisplacementEnabled(false, { persist: false }));
    const off = await readStats(page);
    expect(off.state.state).toBe('off');
    expect(off.triangles).toBe(baseTriangles);
    expect(off.radius).toBeGreaterThan(0.95);
    expect(off.radius).toBeLessThan(1.05);

    await page.evaluate(() => window.setDisplacementEnabled(true, { persist: false }));
    await settle(page);
    const on = await readStats(page);
    expect(on.state.state).toBe('applied');
    expect(on.triangles).toBe(baseTriangles * 16);
    expect(on.radius).toBeGreaterThan(1.05);

    // Best-effort cleanup: this settings pair is process-global.
    await page.evaluate(() => { window.setDisplacementEnabled(true, { persist: false }); window.setPreviewSubdivisionLevel(2, { persist: false }); });
  });

  test('__mtlxTriangleBudgetOverride caps the level with a notice', async ({ page, embedURL }) => {
    await gotoEngine(page, embedURL);
    await setupView(page, { xml: SCALE_A_MTLX, triangleBudget: 10000 });
    await settle(page);
    const r = await readStats(page);
    expect(r.state.capped).toBe(true);
    expect(r.state.level).toBeLessThan(2);
    expect(r.state.notices.some((n) => /capped at level/i.test(n))).toBe(true);
    expect(r.notices.some((n) => /capped at level/i.test(n))).toBe(true);
  });

  test('applyMaterial with a changed scale re-evaluates; a material without displacement restores the original', async ({ page, embedURL }) => {
    await gotoEngine(page, embedURL);
    await setupView(page, { xml: SCALE_A_MTLX });
    await settle(page);
    const first = await readStats(page);
    expect(first.radius).toBeGreaterThan(1.05);
    expect(first.radius).toBeLessThan(1.15);

    // Same materialName, larger displacement scale -> a different displacement key.
    await page.evaluate(async ({ xml }) => {
      const { view, env } = window.__disp;
      const doc2 = env.mx.createDocument();
      await window.mxExclusive(() => env.mx.readFromXmlString(doc2, xml));
      if (doc2.setDataLibrary) doc2.setDataLibrary(env.stdlib);
      const { node: renderable2 } = window.listDocRenderables(doc2)[0];
      await view.applyMaterial({ mx: env.mx, gen: env.gen, genContext: env.genContext, renderable: renderable2, label: 'scale-b', isMounted: () => true });
      window.__disp.doc2 = doc2;
    }, { xml: SCALE_B_MTLX });
    // applyMaterial's own displacement debounce is 150ms; give it room, then settle.
    await page.waitForTimeout(250);
    await settle(page);
    const second = await readStats(page);
    expect(second.state.state).toBe('applied');
    // 0.2 offset now (vs 0.1 before): a visibly larger radius.
    expect(second.radius).toBeGreaterThan(first.radius + 0.03);

    // A material with no displacement input restores the plain original.
    await page.evaluate(async ({ xml }) => {
      const { view, env } = window.__disp;
      const doc3 = env.mx.createDocument();
      await window.mxExclusive(() => env.mx.readFromXmlString(doc3, xml));
      if (doc3.setDataLibrary) doc3.setDataLibrary(env.stdlib);
      const { node: renderable3 } = window.listDocRenderables(doc3)[0];
      await view.applyMaterial({ mx: env.mx, gen: env.gen, genContext: env.genContext, renderable: renderable3, label: 'no-disp', isMounted: () => true });
    }, { xml: NO_DISPLACEMENT_MTLX });
    const third = await readStats(page);
    expect(third.state.state).toBe('none');
    expect(third.radius).toBeGreaterThan(0.95);
    expect(third.radius).toBeLessThan(1.05);
  });

  test('tryRefreshRenderView with an unchanged surface still re-evaluates a changed displacement', async ({ page, embedURL }) => {
    await gotoEngine(page, embedURL);
    await setupView(page, { xml: SCALE_A_MTLX });
    await settle(page);
    const first = await readStats(page);
    expect(first.radius).toBeLessThan(1.15);

    // Graph Editor edits of a pinned material take this in-place path: the
    // surface source is identical, only the displacement scale differs.
    const refreshed = await page.evaluate(async ({ xml }) => {
      const { view, env } = window.__disp;
      const doc2 = env.mx.createDocument();
      await window.mxExclusive(() => env.mx.readFromXmlString(doc2, xml));
      if (doc2.setDataLibrary) doc2.setDataLibrary(env.stdlib);
      const { node: renderable2 } = window.listDocRenderables(doc2)[0];
      const res = await window.tryRefreshRenderView({ view, mx: env.mx, gen: env.gen, genContext: env.genContext, renderable: renderable2, label: 'refresh-scale-b', isMounted: () => true });
      window.__disp.doc2 = doc2;
      return res.refreshed;
    }, { xml: SCALE_B_MTLX });
    expect(refreshed).toBe(true);
    await page.waitForTimeout(250);
    await settle(page);
    const second = await readStats(page);
    expect(second.state.state).toBe('applied');
    expect(second.radius).toBeGreaterThan(first.radius + 0.03);
  });

  test('shaderball-scene: only the surface mesh geometry changes', async ({ page, embedURL }) => {
    await gotoEngine(page, embedURL);
    await setupView(page, { xml: SCALE_A_MTLX, geomName: 'shaderball-scene' });
    await settle(page);
    const first = await readStats(page);
    expect(first.state.state).toBe('applied');

    const before = await page.evaluate(() => {
      const { view } = window.__disp;
      const d = view.__debug();
      const others = [];
      d.scene.traverse((o) => { if (o.isMesh && o !== d.mesh) others.push(o.geometry.uuid); });
      return { meshGeomUuid: d.geometry.uuid, others };
    });

    // Force a rebuild at a different subdivision level; only the surface
    // mesh's own geometry should be swapped for a new one.
    await page.evaluate(() => window.setPreviewSubdivisionLevel(1, { persist: false }));
    await settle(page);
    const after = await page.evaluate(() => {
      const { view } = window.__disp;
      const d = view.__debug();
      const others = [];
      d.scene.traverse((o) => { if (o.isMesh && o !== d.mesh) others.push(o.geometry.uuid); });
      return { meshGeomUuid: d.geometry.uuid, others };
    });

    expect(after.meshGeomUuid).not.toBe(before.meshGeomUuid);
    expect(after.others.sort()).toEqual(before.others.sort());

    await page.evaluate(() => window.setPreviewSubdivisionLevel(2, { persist: false }));
  });

  test('__mtlxForceDisplacementFailure: state failed, undisplaced geometry, material still renders', async ({ page, embedURL }) => {
    await gotoEngine(page, embedURL);
    const baseTriangles = await page.evaluate(() => {
      const g = new window.THREE.SphereGeometry(1, 64, 64);
      const base = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      g.dispose();
      return base;
    });
    await setupView(page, { xml: SCALE_A_MTLX, forceFailure: true });
    await settle(page);
    const r = await readStats(page);
    expect(r.state.state).toBe('failed');
    expect(r.triangles).toBe(baseTriangles); // fell all the way back to originalGeometry
    expect(r.state.notices.length).toBeGreaterThan(0);

    const glCheck = await page.evaluate(() => {
      delete window.__mtlxForceDisplacementFailure;
      const { view } = window.__disp;
      const dataUrl = view.snapshot();
      const gl = view.__debug().renderer.getContext();
      return { dataUrlLen: dataUrl.length, glError: gl.getError() };
    });
    expect(glCheck.glError).toBe(0);
    expect(glCheck.dataUrlLen).toBeGreaterThan(1000);
  });

  test('buffer2d: state stays none', async ({ page, embedURL }) => {
    await gotoEngine(page, embedURL);
    const r = await setupView(page, { xml: SCALE_A_MTLX, geomName: 'buffer2d' });
    expect(r.state.state).toBe('none');
    // Give any (incorrectly) scheduled run a chance to fire, then re-check.
    await page.waitForTimeout(300);
    const after = await readStats(page);
    expect(after.state.state).toBe('none');
  });
});

// Framing measures the undisplaced mesh: turning displacement on after the
// shaderball scene framed itself must not widen the fov on the next resize.
test('displacement landing after the first framing keeps the shaderball scene fov', async ({ page, embedURL }) => {
  await gotoEngine(page, embedURL);
  const result = await page.evaluate(async ({ xml }) => {
    window.setDisplacementEnabled(false, { persist: false });
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const { name: materialName, node: renderable } = window.listDocRenderables(doc)[0];
    const canvas = document.createElement('canvas');
    canvas.style.width = '320px';
    canvas.style.height = '240px';
    document.body.appendChild(canvas);
    const view = await window.createMtlxRenderView({
      canvas, mx: env.mx, gen: env.gen, genContext: env.genContext, renderable,
      label: 'displacement-framing-test', geomName: 'shaderball-scene', sceneOrbit: true,
      autoRotate: false, needsLighting: true, materialName, isMounted: () => true,
    });
    const camera = view.__debug().camera;
    const fovBefore = camera.fov;
    window.setDisplacementEnabled(true, { persist: false });
    await view.whenDisplacementSettled();
    const state = view.getDisplacementState().state;
    canvas.style.width = '360px';
    canvas.style.height = '240px';
    await new Promise((resolve) => setTimeout(resolve, 500));
    const fovAfter = camera.fov;
    view.dispose();
    canvas.remove();
    window.setDisplacementEnabled(true, { persist: false });
    return { state, fovBefore, fovAfter };
  }, { xml: SCALE_A_MTLX });
  expect(result.state).toBe('applied');
  expect(Math.abs(result.fovAfter - result.fovBefore)).toBeLessThan(0.5);
});
