import { test, expect } from './lib/test-base.mjs';

// These tests exercise the exported GPU compositor with hand-authored
// RawShaderMaterials.  The fixture supplies premultiplied C and RGB T through
// the documented payload uniforms, so MaterialX code generation is not part
// of the result being measured.
const makeLayerFixture = (THREE, { layers, background = [0.1, 0.1, 0.1], linearGuard = false }) => {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 20);
  const opaqueMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: 'in vec3 position; uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix; void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: linearGuard
      ? `precision highp float; uniform int u_peelLinear; out vec4 out1; void main(){vec3 lin=vec3(${background.join(',')}); vec3 lo=lin*12.92; vec3 hi=1.055*pow(lin,vec3(1.0/2.4))-0.055; vec3 enc=mix(hi,lo,step(lin,vec3(0.0031308))); out1=vec4(u_peelLinear!=0?lin:enc,1.0);}`
      : `precision highp float; out vec4 out1; void main(){out1=vec4(${background.join(',')},1.0);}`,
    uniforms: linearGuard ? { u_peelLinear: { value: 0 } } : undefined,
    depthTest: true,
    depthWrite: true,
  });
  const opaque = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), opaqueMaterial);
  opaque.position.z = -15;
  scene.add(opaque);

  const vertexShader =
    'in vec3 position; uniform mat4 modelViewMatrix; uniform mat4 projectionMatrix;\n' +
    'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}\n';
  const fragmentShader = [
    'precision highp float;',
    'uniform vec3 u_color,u_transmission;',
    'uniform int u_peelRgbt,u_peelMode,u_peelRgbtPass,u_peelHasPrev;',
    'uniform sampler2D u_peelPrevDepth,u_opaqueDepth;',
    'out vec4 out1;',
    'void main(){',
    ' vec2 uv=gl_FragCoord.xy/vec2(textureSize(u_peelPrevDepth,0));',
    ' if(u_peelHasPrev==1 && gl_FragCoord.z<=texture(u_peelPrevDepth,uv).r+0.00001) discard;',
    ' vec2 ouv=gl_FragCoord.xy/vec2(textureSize(u_opaqueDepth,0));',
    ' if(gl_FragCoord.z>=texture(u_opaqueDepth,ouv).r-0.00001) discard;',
    // Pass 0 writes C. Pass 1 writes RGB T. Pass 2 writes C plus the scalar
    // tail alpha used by the bounded tail fold.
    ' if(u_peelRgbtPass==1) out1=vec4(u_transmission,1.0);',
    ' else if(u_peelRgbtPass==2) out1=vec4(u_color,1.0-(u_transmission.r+u_transmission.g+u_transmission.b)/3.0);',
    ' else out1=vec4(u_color,1.0-(u_transmission.r+u_transmission.g+u_transmission.b)/3.0);',
    '}',
  ].join('\n');
  const transparent = [];
  layers.forEach((layer) => {
    const material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        u_color: { value: new THREE.Vector3(...layer.c) },
        u_transmission: { value: new THREE.Vector3(...layer.t) },
        u_peelMode: { value: 0 },
        u_peelRgbt: { value: 0 },
        u_peelRgbtPass: { value: 0 },
        u_peelRgbtLayer: { value: 0 },
        u_peelHasPrev: { value: 0 },
        u_peelPrevDepth: { value: null },
        u_opaqueDepth: { value: null },
        u_numActiveLightSources: { value: 3 },
      },
      vertexShader,
      fragmentShader,
      depthTest: true,
      depthWrite: true,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    // Half-width quads make the right side an independently testable empty
    // pixel while all layers still overlap on the left side.
    mesh.scale.x = layer.coverage === 'half' ? 0.5 : 1;
    mesh.position.x = layer.coverage === 'half' ? -0.5 : 0;
    mesh.position.z = layer.z;
    scene.add(mesh);
    transparent.push(mesh);
  });
  return { scene, camera, opaque, transparent };
};

const canvasPixel = (canvas, x, y) => {
  const sample = document.createElement('canvas');
  sample.width = sample.height = 1;
  const ctx = sample.getContext('2d');
  // drawImage uses top-left coordinates, which is intentional for this
  // canvas readback (the center and symmetric empty sample are unambiguous).
  ctx.drawImage(canvas, x, y, 1, 1, 0, 0, 1, 1);
  return Array.from(ctx.getImageData(0, 0, 1, 1).data).map((v) => v / 255);
};

const srgb = (v) => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;

test('@scene RGB-T compositor peels depth, keeps premultiplied C, and preserves clear emission', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createRgbtPeelPipeline, null, { timeout: 30000 });
  const result = await page.evaluate(({ fixtureSource, pixelSource }) => {
    const makeLayerFixture = eval(`(${fixtureSource})`);
    const canvasPixel = eval(`(${pixelSource})`);
    const THREE = window.THREE;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    document.body.appendChild(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, preserveDrawingBuffer: true });
    renderer.setSize(32, 32, false);
    const layers = [
      // Front-to-back values; they are inserted in reverse order below.
      { z: -1, c: [0.2, 0.0, 0.0], t: [0.5, 0.5, 0.5], coverage: 'half' },
      { z: -2, c: [0.0, 0.3, 0.0], t: [0.25, 0.5, 0.75], coverage: 'half' },
      // T=1 must not erase this premultiplied emissive C.
      { z: -3, c: [0.0, 0.0, 0.4], t: [1.0, 1.0, 1.0], coverage: 'half' },
    ];
    const fixture = makeLayerFixture(THREE, { layers, linearGuard: true });
    // Deliberately wrong submission order: depth peeling must recover the
    // nearest layer from depth, independently of scene traversal order.
    fixture.transparent.slice().reverse().forEach((mesh) => {
      fixture.scene.remove(mesh);
      fixture.scene.add(mesh);
    });
    const opaqueOutput = true;
    const pipeline = window.createRgbtPeelPipeline(renderer, {
      layers: 3,
      getDisplayTransform: () => 'lin_rec709',
      getDisplayExposure: () => 1,
      opaqueOutput,
    });
    if (!pipeline.supported) return { supported: false };
    const trackedLightUniform = fixture.transparent[0].material.uniforms.u_numActiveLightSources;
    const originalRender = renderer.render;
    let minimumLightCount = Infinity;
    renderer.render = function (...args) {
      minimumLightCount = Math.min(minimumLightCount, trackedLightUniform.value);
      return originalRender.apply(this, args);
    };
    pipeline.render(fixture.scene, fixture.camera, fixture.transparent);
    renderer.render = originalRender;
    const center = canvasPixel(canvas, 8, 16);
    const empty = canvasPixel(canvas, 26, 16);
    const expectedLinear = [0.2125, 0.175, 0.1875];
    const expected = [...expectedLinear, 1];
    const result = {
      supported: true, center, empty, expected, alpha: center[3], minimumLightCount,
      restoredLightCount: trackedLightUniform.value,
    };
    pipeline.dispose();
    renderer.dispose();
    canvas.remove();
    return result;
  }, { fixtureSource: makeLayerFixture.toString(), pixelSource: canvasPixel.toString() });
  expect(result.supported).toBe(true);
  // lin_rec709 is an inspection transform: it applies no OETF or tone map.
  // Canvas readback is 8-bit, so the tolerance covers one quantization step.
  result.expected.forEach((value, i) => expect(result.center[i]).toBeCloseTo(value, 2));
  expect(result.empty[0]).toBeCloseTo(0.1, 2);
  expect(result.empty[1]).toBeCloseTo(0.1, 2);
  expect(result.empty[2]).toBeCloseTo(0.1, 2);
  expect(result.empty[3]).toBeCloseTo(1, 2);
  expect(result.minimumLightCount).toBe(0);
  expect(result.restoredLightCount).toBe(3);
});

test('@scene RGB-T compositor folds tail layers and applies live display settings once', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createRgbtPeelPipeline, null, { timeout: 30000 });
  const result = await page.evaluate(({ fixtureSource, pixelSource }) => {
    const makeLayerFixture = eval(`(${fixtureSource})`);
    const canvasPixel = eval(`(${pixelSource})`);
    const THREE = window.THREE;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 24;
    document.body.appendChild(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, preserveDrawingBuffer: true });
    renderer.setSize(24, 24, false);
    const layers = Array.from({ length: 10 }, (_, i) => ({
      z: -1 - i,
      c: i === 9 ? [0.0, 0.0, 0.6] : [0.0, 0.0, 0.0],
      t: [0.8, 0.8, 0.8],
    }));
    // The later emitter is fully clear, so its C must survive the scalar tail
    // even though it is deeper than the eight explicitly peeled layers.
    layers[9].t = [1, 1, 1];
    const fixture = makeLayerFixture(THREE, { layers, background: [0.2, 0.2, 0.2] });
    fixture.transparent.slice().reverse().forEach((mesh) => {
      fixture.scene.remove(mesh);
      fixture.scene.add(mesh);
    });
    let exposure = 1;
    let transform = 'lin_rec709';
    const pipeline = window.createRgbtPeelPipeline(renderer, {
      layers: 8,
      getDisplayTransform: () => transform,
      getDisplayExposure: () => exposure,
      opaqueOutput: true,
    });
    if (!pipeline.supported) return { supported: false };
    pipeline.render(fixture.scene, fixture.camera, fixture.transparent);
    const first = canvasPixel(canvas, 12, 12);
    exposure = 0.5;
    pipeline.render(fixture.scene, fixture.camera, fixture.transparent);
    const halfExposure = canvasPixel(canvas, 12, 12);
    transform = 'srgb';
    pipeline.render(fixture.scene, fixture.camera, fixture.transparent);
    const transformed = canvasPixel(canvas, 12, 12);
    renderer.setSize(12, 12, false);
    pipeline.render(fixture.scene, fixture.camera, fixture.transparent);
    const resized = pipeline.supported;
    // The exact linear result includes the ninth layer's .8 transmission and
    // the opaque background beneath the fully clear tail emitter.
    const expectedResidual = Math.pow(0.8, 9);
    const expectedBlue = expectedResidual * (0.6 + 0.2);
    const result = { supported: true, first, halfExposure, transformed, expectedBlue, resized };
    pipeline.dispose();
    renderer.dispose();
    canvas.remove();
    return result;
  }, { fixtureSource: makeLayerFixture.toString(), pixelSource: canvasPixel.toString() });
  expect(result.supported).toBe(true);
  expect(result.first[2]).toBeCloseTo(result.expectedBlue, 2);
  expect(result.halfExposure[2]).toBeCloseTo(result.expectedBlue * 0.5, 2);
  expect(result.transformed[2]).toBeCloseTo(srgb(result.expectedBlue * 0.5), 2);
  // The clear tail emitter contributes blue while its transmission is one;
  // opaqueOutput also promises a fully opaque final pixel.
  expect(result.first[2]).toBeGreaterThan(0.08);
  expect(result.transformed[3]).toBeCloseTo(1, 2);
  expect(result.resized).toBe(true);
});

test('@scene RGB-T compositor restores renderer/material state after failure and diagnoses mixed groups', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createRgbtPeelPipeline, null, { timeout: 30000 });
  const result = await page.evaluate(({ fixtureSource, pixelSource }) => {
    const makeLayerFixture = eval(`(${fixtureSource})`);
    const canvasPixel = eval(`(${pixelSource})`);
    const THREE = window.THREE;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 16;
    document.body.appendChild(canvas);
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, preserveDrawingBuffer: true });
    renderer.setSize(16, 16, false);
    const fixture = makeLayerFixture(THREE, {
      layers: [{ z: -1, c: [0.2, 0.1, 0.05], t: [0.5, 0.5, 0.5] }],
    });
    const pipeline = window.createRgbtPeelPipeline(renderer, {
      layers: 1,
      getDisplayTransform: () => 'lin_rec709',
      getDisplayExposure: () => 1,
      opaqueOutput: true,
    });
    if (!pipeline.supported) return { supported: false };
    const savedTarget = new THREE.WebGLRenderTarget(4, 4);
    renderer.setRenderTarget(savedTarget);
    renderer.setViewport(2, 3, 9, 10);
    renderer.setScissor(1, 2, 8, 9);
    renderer.setScissorTest(true);
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    const before = {
      target: renderer.getRenderTarget(),
      viewport: renderer.getViewport(new THREE.Vector4()).toArray(),
      scissor: renderer.getScissor(new THREE.Vector4()).toArray(),
      scissorTest: renderer.getScissorTest(),
      autoClear: renderer.autoClear,
      clearColor: renderer.getClearColor(new THREE.Color()).getHex(),
      clearAlpha: renderer.getClearAlpha(),
      shadowUpdate: renderer.shadowMap.autoUpdate,
      visible: fixture.scene.children.filter((o) => o.isMesh).map((m) => m.visible),
      blend: fixture.transparent.map((m) => m.material.blending),
      mode: fixture.transparent.map((m) => m.material.uniforms.u_peelMode.value),
      pass: fixture.transparent.map((m) => m.material.uniforms.u_peelRgbtPass.value),
      depthTest: fixture.transparent.map((m) => m.material.depthTest),
      depthWrite: fixture.transparent.map((m) => m.material.depthWrite),
      hasPrev: fixture.transparent.map((m) => m.material.uniforms.u_peelHasPrev.value),
      layer: fixture.transparent.map((m) => m.material.uniforms.u_peelRgbtLayer.value),
    };
    const originalRender = renderer.render;
    let calls = 0;
    renderer.render = function (...args) {
      calls += 1;
      if (calls === 8) throw new Error('forced compositor failure');
      return originalRender.apply(this, args);
    };
    let thrown = false;
    try {
      pipeline.render(fixture.scene, fixture.camera, fixture.transparent);
    } catch (error) {
      thrown = /forced compositor failure/.test(String(error && error.message));
    }
    renderer.render = originalRender;
    const after = {
      target: renderer.getRenderTarget(),
      viewport: renderer.getViewport(new THREE.Vector4()).toArray(),
      scissor: renderer.getScissor(new THREE.Vector4()).toArray(),
      scissorTest: renderer.getScissorTest(),
      autoClear: renderer.autoClear,
      clearColor: renderer.getClearColor(new THREE.Color()).getHex(),
      clearAlpha: renderer.getClearAlpha(),
      shadowUpdate: renderer.shadowMap.autoUpdate,
      visible: fixture.scene.children.filter((o) => o.isMesh).map((m) => m.visible),
      blend: fixture.transparent.map((m) => m.material.blending),
      mode: fixture.transparent.map((m) => m.material.uniforms.u_peelMode.value),
      pass: fixture.transparent.map((m) => m.material.uniforms.u_peelRgbtPass.value),
      depthTest: fixture.transparent.map((m) => m.material.depthTest),
      depthWrite: fixture.transparent.map((m) => m.material.depthWrite),
      hasPrev: fixture.transparent.map((m) => m.material.uniforms.u_peelHasPrev.value),
      layer: fixture.transparent.map((m) => m.material.uniforms.u_peelRgbtLayer.value),
    };
    const restored = after.target === before.target &&
      JSON.stringify(after.viewport) === JSON.stringify(before.viewport) &&
      JSON.stringify(after.scissor) === JSON.stringify(before.scissor) &&
      after.scissorTest === before.scissorTest && after.autoClear === before.autoClear &&
      after.clearColor === before.clearColor && after.clearAlpha === before.clearAlpha &&
      after.shadowUpdate === before.shadowUpdate &&
      JSON.stringify(after.visible) === JSON.stringify(before.visible) &&
      JSON.stringify(after.blend) === JSON.stringify(before.blend) &&
      JSON.stringify(after.mode) === JSON.stringify(before.mode) &&
      JSON.stringify(after.pass) === JSON.stringify(before.pass) &&
      JSON.stringify(after.depthTest) === JSON.stringify(before.depthTest) &&
      JSON.stringify(after.depthWrite) === JSON.stringify(before.depthWrite) &&
      JSON.stringify(after.hasPrev) === JSON.stringify(before.hasPrev) &&
      JSON.stringify(after.layer) === JSON.stringify(before.layer);

    // A grouped mesh has mixed material semantics. Both groups are real RGBT
    // payloads over disjoint quads; the compositor must flatten the material
    // list without dropping either group's contribution.
    fixture.scene.remove(fixture.transparent[0]);
    const groupedGeometry = new THREE.BufferGeometry();
    groupedGeometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -1, 1, 0, -1, -1, 0, 0, 1, 0, 0, -1, 0,
      0, 1, 0, 0, -1, 0, 1, 1, 0, 1, -1, 0,
    ], 3));
    groupedGeometry.setIndex([0, 1, 2, 1, 3, 2, 4, 5, 6, 5, 7, 6]);
    groupedGeometry.clearGroups();
    groupedGeometry.addGroup(0, 6, 0);
    groupedGeometry.addGroup(6, 6, 1);
    const secondMaterial = fixture.transparent[0].material.clone();
    secondMaterial.uniforms.u_color.value.set(0.0, 0.2, 0.05);
    secondMaterial.uniforms.u_transmission.value.set(0.25, 0.25, 0.25);
    const grouped = new THREE.Mesh(groupedGeometry, [
      fixture.transparent[0].material,
      secondMaterial,
    ]);
    grouped.position.z = -1;
    fixture.scene.add(grouped);
    renderer.setRenderTarget(null);
    renderer.setViewport(0, 0, 16, 16);
    renderer.setScissorTest(false);
    const messages = [];
    const groupedPipeline = window.createRgbtPeelPipeline(renderer, {
      layers: 1, getDisplayTransform: () => 'lin_rec709', getDisplayExposure: () => 1, opaqueOutput: true,
    });
    const groupedResult = groupedPipeline.render(fixture.scene, fixture.camera, [grouped], {
      onUnsupported: (m) => messages.push(m),
    });
    const groupedLeft = canvasPixel(canvas, 4, 8);
    const groupedRight = canvasPixel(canvas, 12, 8);
    groupedPipeline.dispose();
    pipeline.dispose();
    renderer.setRenderTarget(null);
    savedTarget.dispose();
    groupedGeometry.dispose();
    renderer.dispose();
    canvas.remove();
    return { supported: true, thrown, restored, calls, groupedResult, groupedLeft, groupedRight, messages };
  }, { fixtureSource: makeLayerFixture.toString(), pixelSource: canvasPixel.toString() });
  expect(result.supported).toBe(true);
  expect(result.thrown).toBe(true);
  expect(result.calls).toBeGreaterThan(5);
  expect(result.restored).toBe(true);
  expect(result.groupedResult).toBe(true);
  expect(result.groupedLeft[0]).toBeCloseTo(0.25, 2);
  expect(result.groupedLeft[1]).toBeCloseTo(0.15, 2);
  expect(result.groupedLeft[2]).toBeCloseTo(0.1, 2);
  expect(result.groupedRight[0]).toBeCloseTo(0.025, 2);
  expect(result.groupedRight[1]).toBeCloseTo(0.225, 2);
  expect(result.groupedRight[2]).toBeCloseTo(0.075, 2);
  expect(result.messages).toEqual([]);
});
