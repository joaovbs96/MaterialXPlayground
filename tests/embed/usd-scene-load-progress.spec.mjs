import { test, expect } from './lib/test-base.mjs';

// Builds a MaterialX document with three independent standard_surface
// materials and a matching stage (three quads, one material each) so the
// precompile/bind/geometry loops each iterate at least three times.
async function loadThreeMaterialFixture(page) {
  return page.evaluate(async () => {
    const xml = `<materialx version="1.39">
      <constant name="base0" type="color3"><input name="value" type="color3" value="0.8, 0.2, 0.2"/></constant>
      <standard_surface name="surface0" type="surfaceshader">
        <input name="base" type="float" value="1"/>
        <input name="base_color" type="color3" nodename="base0"/>
      </standard_surface>
      <surfacematerial name="material0" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface0"/></surfacematerial>
      <constant name="base1" type="color3"><input name="value" type="color3" value="0.2, 0.8, 0.2"/></constant>
      <standard_surface name="surface1" type="surfaceshader">
        <input name="base" type="float" value="1"/>
        <input name="base_color" type="color3" nodename="base1"/>
      </standard_surface>
      <surfacematerial name="material1" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface1"/></surfacematerial>
      <constant name="base2" type="color3"><input name="value" type="color3" value="0.2, 0.2, 0.8"/></constant>
      <standard_surface name="surface2" type="surfaceshader">
        <input name="base" type="float" value="1"/>
        <input name="base_color" type="color3" nodename="base2"/>
      </standard_surface>
      <surfacematerial name="material2" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface2"/></surfacematerial>
    </materialx>`;
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const renderables = window.listDocRenderables(doc);
    const quad = (offset) => ({
      positions: new Float32Array([-0.4 + offset, -0.4, 0, 0.4 + offset, -0.4, 0, 0.4 + offset, 0.4, 0, -0.4 + offset, 0.4, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    });
    const stage = {
      upAxis: 'Y', metersPerUnit: 1,
      meshes: renderables.map((r, i) => ({ ...quad(i * 1.2), primPath: '/Prims/Item' + i, materialPath: '/Material' + i })),
      materials: renderables.map((r, i) => ({ path: '/Material' + i, node: r.node, materialName: r.name })),
      lights: [],
    };
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:480px;background:#000';
    document.body.appendChild(holder);
    const events = [];
    const handle = await window.createMtlxSceneView({
      container: holder, stage, version: '1.39.5',
      onProgress: (e) => events.push(e),
    });
    handle.dispose();
    holder.remove();
    return { events, materialCount: renderables.length };
  });
}

test('@scene load-progress events carry per-material and per-phase counts in order', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.prepGeometry && window.createMtlxSceneView && window.getMxEnv && window.usdSceneProgressFraction, null, { timeout: 30000 });

  const { events, materialCount } = await loadThreeMaterialFixture(page);
  expect(materialCount).toBe(3);

  // Material compile: the outer precompile-loop reports carry index/total;
  // ensureCompiledMaterial's own internal start/ready reports do not.
  const materialCounted = events.filter((e) => e.phase === 'material' && e.index != null);
  const materialStarts = materialCounted.filter((e) => e.status === 'start');
  const materialEnds = materialCounted.filter((e) => e.status === 'ready' || e.status === 'error');
  expect(materialStarts.map((e) => e.index)).toEqual([1, 2, 3]);
  expect(materialEnds.map((e) => e.index)).toEqual([1, 2, 3]);
  expect(materialStarts.every((e) => e.total === materialCount)).toBe(true);
  expect(materialEnds.every((e) => e.total === materialCount)).toBe(true);
  const uncountedMaterialEvents = events.filter((e) => e.phase === 'material' && e.index == null);
  expect(uncountedMaterialEvents.every((e) => e.index == null && e.total == null)).toBe(true);

  const bindEvents = events.filter((e) => e.phase === 'material-bind');
  expect(bindEvents.map((e) => e.index)).toEqual([1, 2, 3]);
  expect(bindEvents.every((e) => e.total === materialCount)).toBe(true);

  const geometryEvents = events.filter((e) => e.phase === 'geometry');
  expect(geometryEvents.length).toBe(materialCount);
  let lastGeometryIndex = 0;
  for (const e of geometryEvents) {
    expect(e.index).toBeGreaterThan(lastGeometryIndex);
    lastGeometryIndex = e.index;
    expect(typeof e.label).toBe('string');
    expect(e.label.length).toBeGreaterThan(0);
  }

  const stepEvents = events.filter((e) => e.phase === 'renderer' && e.status === 'step');
  expect(stepEvents.length).toBeGreaterThan(0);
  stepEvents.forEach((e, i) => {
    expect(e.index).toBe(i + 1);
    expect(e.total).toBe(stepEvents.length);
  });
  const knownStepOrder = ['sky-visibility', 'shadow-atlas', 'gpu-program', 'first-frame'];
  const seenSteps = stepEvents.map((e) => e.step);
  const expectedSteps = knownStepOrder.filter((s) => seenSteps.includes(s));
  expect(seenSteps).toEqual(expectedSteps);

  const readyEvents = events.filter((e) => e.phase === 'renderer' && e.status === 'ready');
  expect(readyEvents.length).toBe(1);
  expect(events[events.length - 1]).toBe(readyEvents[0]);

  const fractions = await page.evaluate((collected) => {
    let previous = 0;
    const out = [];
    for (const event of collected) {
      previous = window.usdSceneProgressFraction(event, previous);
      out.push(previous);
    }
    return out;
  }, events);
  for (let i = 1; i < fractions.length; i += 1) expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1]);
  expect(fractions[fractions.length - 1]).toBe(1);

  console.log('usd-scene-load-progress fixture events:', JSON.stringify(events.map((e) => ({
    phase: e.phase, status: e.status, index: e.index, total: e.total, step: e.step, label: e.label,
  }))));
});

test('@scene usdSceneProgressFraction segment maths are monotonic and land in their segment', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.usdSceneProgressFraction, null, { timeout: 30000 });

  const result = await page.evaluate(() => {
    const events = [
      { phase: 'worker', done: 0, total: 4, fraction: 0.5, message: 'Preparing input files' },
      { phase: 'worker', done: 4, total: 4, message: 'Reading input files' },
      { phase: 'parse', done: 0, total: 0, message: 'Composing stage' },
      { phase: 'parse', done: 1, total: 1, message: 'Composed stage' },
      { phase: 'material', status: 'start', index: 1, total: 2, label: 'a' },
      { phase: 'material', status: 'ready', index: 1, total: 2, label: 'a' },
      { phase: 'material', status: 'start', index: 2, total: 2, label: 'b' },
      { phase: 'material', status: 'ready', index: 2, total: 2, label: 'b' },
      { phase: 'material-bind', index: 1, total: 2, label: 'a' },
      { phase: 'material-bind', index: 2, total: 2, label: 'b' },
      { phase: 'texture', done: 0, total: 2 },
      { phase: 'texture', done: 2, total: 2 },
      { phase: 'geometry', index: 1, total: 1, label: 'mesh' },
      { phase: 'renderer', status: 'step', step: 'sky-visibility', index: 1, total: 3 },
      { phase: 'renderer', status: 'step', step: 'gpu-program', index: 2, total: 3 },
      { phase: 'renderer', status: 'step', step: 'first-frame', index: 3, total: 3 },
      { phase: 'renderer', status: 'ready' },
    ];
    let previous = 0;
    const out = [];
    for (const event of events) {
      previous = window.usdSceneProgressFraction(event, previous);
      out.push(previous);
    }
    return out;
  });

  for (let i = 1; i < result.length; i += 1) expect(result[i]).toBeGreaterThanOrEqual(result[i - 1]);
  expect(result[result.length - 1]).toBe(1);
  // The first (worker, explicit fraction) event lands inside worker's
  // [0.00, 0.08] segment, scaled rather than used as the raw whole fraction.
  expect(result[0]).toBeGreaterThan(0);
  expect(result[0]).toBeLessThanOrEqual(0.08);
  // The parse event with no counts (done 0/total 0) does not regress past
  // where the worker phase already landed; it starts at parse's own 0.08.
  expect(result[2]).toBeGreaterThanOrEqual(0.08);
  expect(result[2]).toBeLessThanOrEqual(0.12);
});
