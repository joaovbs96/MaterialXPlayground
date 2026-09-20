// tests/embed/displacement-bake.spec.mjs: P4 acceptance for js/mtlx-engine.js's
// standalone displacement generation and per-vertex GPU evaluation. Runs
// against the real #!viewer engine globals, inline .mtlx strings only.

import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

async function gotoEngine(page, embedURL) {
  await page.goto(embedURL + '/index.html#!viewer');
  await page.waitForFunction(
    () => window.getMxEnv && window.generatePreviewSources && window.evaluateDisplacement && window.THREE,
    null, { timeout: WAIT_TIMEOUT }
  );
}

const FLOAT_CONST_MTLX = `<?xml version="1.0"?>
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

const VECTOR3_CONST_MTLX = `<?xml version="1.0"?>
<materialx version="1.39">
  <standard_surface name="surf" type="surfaceshader" />
  <displacement name="disp" type="displacementshader">
    <input name="displacement" type="vector3" value="0.0, 0.0, 0.1" />
    <input name="scale" type="float" value="1.0" />
  </displacement>
  <surfacematerial name="mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surf" />
    <input name="displacementshader" type="displacementshader" nodename="disp" />
  </surfacematerial>
</materialx>`;

const MIX_MTLX = `<?xml version="1.0"?>
<materialx version="1.39">
  <standard_surface name="surf" type="surfaceshader" />
  <displacement name="d1" type="displacementshader">
    <input name="displacement" type="float" value="0.1" />
  </displacement>
  <displacement name="d2" type="displacementshader">
    <input name="displacement" type="float" value="0.3" />
  </displacement>
  <mix name="disp" type="displacementshader">
    <input name="fg" type="displacementshader" nodename="d1" />
    <input name="bg" type="displacementshader" nodename="d2" />
    <input name="mix" type="float" value="0.5" />
  </mix>
  <surfacematerial name="mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surf" />
    <input name="displacementshader" type="displacementshader" nodename="disp" />
  </surfacematerial>
</materialx>`;

const NOISE_MTLX = `<?xml version="1.0"?>
<materialx version="1.39">
  <standard_surface name="surf" type="surfaceshader" />
  <position name="pos" type="vector3" space="object" />
  <noise3d name="n" type="float">
    <input name="position" type="vector3" nodename="pos" />
    <input name="amplitude" type="float" value="0.05" />
  </noise3d>
  <displacement name="disp" type="displacementshader">
    <input name="displacement" type="float" nodename="n" />
  </displacement>
  <surfacematerial name="mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surf" />
    <input name="displacementshader" type="displacementshader" nodename="disp" />
  </surfacematerial>
</materialx>`;

const GEOMPROP_MTLX = `<?xml version="1.0"?>
<materialx version="1.39">
  <standard_surface name="surf" type="surfaceshader" />
  <geompropvalue name="mask" type="float">
    <input name="geomprop" type="string" value="mask" />
    <input name="default" type="float" value="0.25" />
  </geompropvalue>
  <displacement name="disp" type="displacementshader">
    <input name="displacement" type="float" nodename="mask" />
  </displacement>
  <surfacematerial name="mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surf" />
    <input name="displacementshader" type="displacementshader" nodename="disp" />
  </surfacematerial>
</materialx>`;

const POWER_FRACTIONAL_MTLX = `<?xml version="1.0"?>
<materialx version="1.39">
  <standard_surface name="surf" type="surfaceshader" />
  <constant name="base" type="float" nodedef="ND_constant_float">
    <input name="value" type="float" value="-0.5" />
  </constant>
  <constant name="exponent" type="float" nodedef="ND_constant_float">
    <input name="value" type="float" value="0.7" />
  </constant>
  <power name="pow" type="float">
    <input name="in1" type="float" nodename="base" />
    <input name="in2" type="float" nodename="exponent" />
  </power>
  <displacement name="disp" type="displacementshader">
    <input name="displacement" type="float" nodename="pow" />
  </displacement>
  <surfacematerial name="mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surf" />
    <input name="displacementshader" type="displacementshader" nodename="disp" />
  </surfacematerial>
</materialx>`;
const imageSamplerMtlx = (mode) => [
'<?xml version="1.0"?>',
'<materialx version="1.39">',
'  <standard_surface name="surf" type="surfaceshader" />',
'  <texcoord name="uv" type="vector2" nodedef="ND_texcoord_vector2">',
'    <input name="geomprop" type="string" value="uv" />',
'  </texcoord>',
'  <image name="img" type="float">',
'    <input name="file" type="filename" value="tex.png" />',
'    <input name="texcoord" type="vector2" nodename="uv" />',
'    <input name="uaddressmode" type="string" value="' + mode + '" />',
'    <input name="vaddressmode" type="string" value="clamp" />',
'  </image>',
'  <displacement name="disp" type="displacementshader">',
'    <input name="displacement" type="float" nodename="img" />',
'  </displacement>',
'  <surfacematerial name="mat" type="material">',
'    <input name="surfaceshader" type="surfaceshader" nodename="surf" />',
'    <input name="displacementshader" type="displacementshader" nodename="disp" />',
'  </surfacematerial>',
'</materialx>',
].join(String.fromCharCode(10));
const NO_DISPLACEMENT_MTLX = `<?xml version="1.0"?>
<materialx version="1.39">
  <standard_surface name="surf" type="surfaceshader" />
  <surfacematerial name="mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surf" />
  </surfacematerial>
</materialx>`;

// Runs entirely inside the page: builds the document, generates preview
// sources (surface + displacement), optionally bakes displacement on a
// sphere via evaluateDisplacement, and reports plain JSON back.
async function bakeCase(page, { xml, segments = 8, evaluate = true, forceFailure = false, breakAnchors = false, geompropValues = null, useGeompropDefaults = false, outOfRangeUv = false, makeTexture = false }) {
  return page.evaluate(async ({ xml, segments, evaluate, forceFailure, breakAnchors, geompropValues, useGeompropDefaults, outOfRangeUv, makeTexture }) => {
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const { name: materialName, node: renderable } = window.listDocRenderables(doc)[0];

    // Simulates editing the generated source in the page: intercepts only
    // the displacement generation call and hands back source with the
    // vertex splice anchor destroyed; the surface material is untouched.
    const originalGenerate = breakAnchors ? env.gen.generate.bind(env.gen) : null;
    if (breakAnchors) {
      env.gen.generate = (name, source, ctx) => {
        if (name !== 'mtlx_displacement') return originalGenerate(name, source, ctx);
        const real = originalGenerate(name, source, ctx);
        const vs = real.getSourceCode('vertex').replace(
          /gl_Position\s*=\s*u_viewProjectionMatrix\s*\*\s*hPositionWorld\s*;/, 'gl_Position = vec4(0.0);'
        );
        const fs = real.getSourceCode('pixel');
        real.delete();
        return { getSourceCode: (stage) => (stage === 'vertex' ? vs : fs), getStage: () => null, delete: () => {} };
      };
    }

    let srcs = null, error = null;
    try {
      srcs = await window.generatePreviewSources({
        mx: env.mx, gen: env.gen, genContext: env.genContext, renderable, materialName, label: 'displacement-bake-test',
      });
    } catch (e) {
      error = String((e && e.message) || e);
    } finally {
      if (breakAnchors) env.gen.generate = originalGenerate;
    }

    const out = {
      error,
      hasVs: !!(srcs && srcs.vs), hasFs: !!(srcs && srcs.fs),
      notices: srcs ? srcs.notices : [],
      displacement: srcs && srcs.displacement ? {
        mode: srcs.displacement.mode, key: srcs.displacement.key,
        introspected: srcs.displacement.introspected.map((u) => ({ name: u.name, type: u.type })),
        notices: srcs.displacement.notices,
      } : null,
    };

    if (evaluate && srcs && srcs.displacement) {
      if (forceFailure) window.__mtlxForceDisplacementFailure = true;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      document.body.appendChild(canvas);
      const renderer = new window.THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, preserveDrawingBuffer: true });
      renderer.setSize(64, 64, false);
      const geometry = new window.THREE.SphereGeometry(1, segments, segments);
      const position = geometry.getAttribute('position');
      let fileMap = null;
      if (outOfRangeUv) {
        const uvData = new Float32Array(geometry.getAttribute('position').count * 2);
        for (let i = 0; i < uvData.length; i += 2) { uvData[i] = 1.25; uvData[i + 1] = 0.5; }
        geometry.setAttribute('uv', new window.THREE.BufferAttribute(uvData, 2));
      }
      if (srcs.displacement.geomprops && (geompropValues || useGeompropDefaults)) {
        const bindingNotices = [];
        if (geompropValues) {
          const values = Array.isArray(geompropValues) ? geompropValues : [];
          const data = new Float32Array(geometry.getAttribute('position').count);
          for (let i = 0; i < data.length; i++) data[i] = Number(values[i % values.length] || 0);
          geometry.setAttribute('i_geomprop_mask', new window.THREE.BufferAttribute(data, 1));
        }
        window.bindGeompropAttributes(geometry, srcs.displacement.geomprops, (message) => bindingNotices.push(message));
        const bound = geometry.getAttribute('i_geomprop_mask');
        out.geompropBinding = {
          notices: bindingNotices,
          values: bound ? Array.from(bound.array) : null,
          declared: srcs.displacement.geomprops.map((g) => ({ name: g.name, type: g.type, defaultValue: g.defaultValue || null })),
        };
      }
      if (makeTexture) {
        const imageCanvas = document.createElement('canvas');
        imageCanvas.width = 2; imageCanvas.height = 1;
        const imageContext = imageCanvas.getContext('2d');
        imageContext.fillStyle = '#000000'; imageContext.fillRect(0, 0, 1, 1);
        imageContext.fillStyle = '#ffffff'; imageContext.fillRect(1, 0, 1, 1);
        fileMap = { 'tex.png': await new Promise((resolve) => imageCanvas.toBlob(resolve, 'image/png')) };
      }
      const result = await window.evaluateDisplacement({
        renderer, displacement: srcs.displacement, geometry, worldMatrix: new window.THREE.Matrix4(), fileMap,
      });
      out.eval = result ? {
        offsets: result.offsets ? Array.from(result.offsets) : null,
        mode: result.mode, notices: result.notices,
      } : null;
      out.positions = Array.from(position.array);
      renderer.dispose();
      delete window.__mtlxForceDisplacementFailure;
    }
    doc.delete();
    return out;
  }, { xml, segments, evaluate, forceFailure, breakAnchors, geompropValues, useGeompropDefaults, outOfRangeUv, makeTexture });
}

test.describe('displacement program generation and evaluation', () => {
  test('float constant: mode float, offsets 0.1 in x/y/z everywhere', async ({ page, embedURL }) => {
    await gotoEngine(page, embedURL);
    const r = await bakeCase(page, { xml: FLOAT_CONST_MTLX });
    expect(r.error).toBeNull();
    expect(r.displacement).toBeTruthy();
    expect(r.displacement.mode).toBe('float');
    expect(r.eval).toBeTruthy();
    expect(r.eval.offsets).toBeTruthy();
    for (let i = 0; i < r.eval.offsets.length; i++) {
      expect(r.eval.offsets[i]).toBeCloseTo(0.1, 3);
    }
  });

  test('vector3 constant: mode vector3, offsets (0, 0, 0.1) everywhere', async ({ page, embedURL }) => {
    await gotoEngine(page, embedURL);
    const r = await bakeCase(page, { xml: VECTOR3_CONST_MTLX });
    expect(r.error).toBeNull();
    expect(r.displacement).toBeTruthy();
    expect(r.displacement.mode).toBe('vector3');
    expect(r.eval).toBeTruthy();
    const N = r.eval.offsets.length / 3;
    for (let i = 0; i < N; i++) {
      expect(r.eval.offsets[i * 3]).toBeCloseTo(0, 3);
      expect(r.eval.offsets[i * 3 + 1]).toBeCloseTo(0, 3);
      expect(r.eval.offsets[i * 3 + 2]).toBeCloseTo(0.1, 3);
    }
  });

  test('mix of two float displacements: not supported, surface still compiles', async ({ page, embedURL }) => {
    await gotoEngine(page, embedURL);
    const r = await bakeCase(page, { xml: MIX_MTLX, evaluate: false });
    expect(r.error).toBeNull();
    expect(r.hasVs).toBe(true);
    expect(r.hasFs).toBe(true);
    expect(r.displacement).toBeNull();
    expect(r.notices.some((n) => /not supported by the MaterialX shader generator/i.test(n))).toBe(true);
  });

  test('position-driven noise3d: finite, not constant, seam vertices agree', async ({ page, embedURL }) => {
    await gotoEngine(page, embedURL);
    const r = await bakeCase(page, { xml: NOISE_MTLX, segments: 16 });
    expect(r.error).toBeNull();
    expect(r.displacement).toBeTruthy();
    expect(r.eval).toBeTruthy();
    const offsets = r.eval.offsets;
    expect(offsets.every((v) => Number.isFinite(v))).toBe(true);
    const distinct = new Set(offsets.map((v) => v.toFixed(5)));
    expect(distinct.size).toBeGreaterThan(1);

    // Bucket vertices by rounded world position to find UV-seam duplicates
    // (same position, different vertex index), and require equal offsets.
    const positions = r.positions;
    const N = positions.length / 3;
    const buckets = new Map();
    for (let i = 0; i < N; i++) {
      const key = [0, 1, 2].map((c) => positions[i * 3 + c].toFixed(4)).join(',');
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(i);
    }
    let seamPairs = 0;
    for (const indices of buckets.values()) {
      if (indices.length < 2) continue;
      seamPairs++;
      const [a, ...rest] = indices;
      for (const b of rest) {
        for (let c = 0; c < 3; c++) {
          expect(offsets[b * 3 + c]).toBeCloseTo(offsets[a * 3 + c], 4);
        }
      }
    }
    expect(seamPairs).toBeGreaterThan(0);
  });

  test('material without displacement: srcs.displacement is null', async ({ page, embedURL }) => {
    await gotoEngine(page, embedURL);
    const r = await bakeCase(page, { xml: NO_DISPLACEMENT_MTLX, evaluate: false });
    expect(r.error).toBeNull();
    expect(r.hasVs).toBe(true);
    expect(r.displacement).toBeNull();
  });

  test('broken splice anchors: null plus a notice, surface still compiles', async ({ page, embedURL }) => {
    await gotoEngine(page, embedURL);
    const r = await bakeCase(page, { xml: FLOAT_CONST_MTLX, evaluate: false, breakAnchors: true });
    expect(r.error).toBeNull();
    expect(r.hasVs).toBe(true);
    expect(r.hasFs).toBe(true);
    expect(r.displacement).toBeNull();
    expect(r.notices.some((n) => /anchors not found/i.test(n))).toBe(true);
  });

  test('__mtlxForceDisplacementFailure: evaluation returns null offsets plus a notice', async ({ page, embedURL }) => {
    await gotoEngine(page, embedURL);
    const r = await bakeCase(page, { xml: FLOAT_CONST_MTLX, forceFailure: true });
    expect(r.error).toBeNull();
    expect(r.displacement).toBeTruthy();
    expect(r.eval).toBeTruthy();
    expect(r.eval.offsets).toBeNull();
    expect(r.eval.notices.length).toBeGreaterThan(0);
  });
});

test('geompropvalue displacement binds authored values and defaults missing streams', async ({ page, embedURL }) => {
  await gotoEngine(page, embedURL);
  const authored = await bakeCase(page, { xml: GEOMPROP_MTLX, segments: 4, geompropValues: [0.05, 0.1, 0.2, 0.35] });
  expect(authored.error).toBeNull();
  expect(authored.geompropBinding).toBeTruthy();
  expect(authored.geompropBinding.notices).toEqual([]);
  expect(authored.eval).toBeTruthy();
  for (let i = 0; i < authored.geompropBinding.values.length; i++) {
    const expected = authored.geompropBinding.values[i];
    for (let c = 0; c < 3; c++) expect(authored.eval.offsets[i * 3 + c]).toBeCloseTo(expected, 3);
  }
  const fallback = await bakeCase(page, { xml: GEOMPROP_MTLX, segments: 4, useGeompropDefaults: true });
  expect(fallback.error).toBeNull();
  expect(fallback.geompropBinding.values.every((value) => Math.abs(value - 0.25) < 1e-6)).toBe(true);
  expect(fallback.geompropBinding.notices.some((notice) => /no geometry stream/i.test(notice))).toBe(true);
  for (const value of fallback.eval.offsets) expect(value).toBeCloseTo(0.25, 3);
});

test('negative fractional power displacement returns finite zero offsets', async ({ page, embedURL }) => {
  await gotoEngine(page, embedURL);
  const result = await bakeCase(page, { xml: POWER_FRACTIONAL_MTLX, segments: 4 });
  expect(result.error).toBeNull();
  expect(result.eval).toBeTruthy();
  expect(result.eval.offsets.every((value) => Number.isFinite(value))).toBe(true);
  expect(result.eval.offsets.every((value) => Math.abs(value) < 1e-4)).toBe(true);
});

test('clamp and periodic image samplers produce different out-of-range UV readback', async ({ page, embedURL }) => {
  await gotoEngine(page, embedURL);
  const clamp = await bakeCase(page, { xml: imageSamplerMtlx('clamp'), segments: 4, outOfRangeUv: true, makeTexture: true });
  const periodic = await bakeCase(page, { xml: imageSamplerMtlx('periodic'), segments: 4, outOfRangeUv: true, makeTexture: true });
  expect(clamp.error).toBeNull();
  expect(periodic.error).toBeNull();
  expect(clamp.eval.offsets.every((value) => Number.isFinite(value))).toBe(true);
  expect(periodic.eval.offsets.every((value) => Number.isFinite(value))).toBe(true);
  const clampMean = clamp.eval.offsets.reduce((sum, value) => sum + value, 0) / clamp.eval.offsets.length;
  const periodicMean = periodic.eval.offsets.reduce((sum, value) => sum + value, 0) / periodic.eval.offsets.length;
  expect(clampMean).toBeGreaterThan(periodicMean + 0.1);
});

