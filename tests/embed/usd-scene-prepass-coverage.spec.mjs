import { test, expect } from './lib/test-base.mjs';

const RECEIVER_STAGE = {
  upAxis: 'Y', metersPerUnit: 1,
  meshes: [{
    primPath: '/Receiver', materialPath: '/Material',
    positions: new Float32Array([-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  }],
  materials: [{ path: '/Material', node: null }], lights: [],
};

function materialXml(input, extra = '') {
  return `<materialx version="1.39">${extra}
    <standard_surface name="surface" type="surfaceshader">
      <input name="base" type="float" value="1"/>
      <input name="base_color" type="color3" value="0.8,0.8,0.8"/>
      <input name="specular" type="float" value="0"/>
      ${input}
      <input name="emission" type="float" value="0"/>
    </standard_surface>
    <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
  </materialx>`;
}

test('@scene classifies static and connected transmission for visibility prepasses', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.prepGeometry && window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const values = await page.evaluate(async ({ stage, xmls }) => {
    const env = await window.getMxEnv();
    const out = {};
    for (const [name, xml] of Object.entries(xmls)) {
      const doc = env.mx.createDocument();
      await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
      if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
      const renderables = window.listDocRenderables(doc);
      const node = name === 'layered'
        ? renderables.find((entry) => entry.node?.getCategory?.() === 'mix')?.node
        : renderables[0]?.node;
      const holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:0;top:0;width:64px;height:64px';
      document.body.appendChild(holder);
      const localStage = Object.assign({}, stage, { materials: [{ path: '/Material', node }] });
      const handle = await window.createMtlxSceneView({ container: holder, stage: localStage, version: '1.39.5' });
      const material = handle.prims[0].material;
      out[name] = {
        compiled: !!material.userData.mtlxSceneCompiled?.vs,
        coverage: material.userData.mtlxScenePrepassCoverage,
        warnings: handle.warnings.slice(),
      };
      handle.dispose();
      holder.remove();
      doc.delete();
    }
    return out;
  }, {
    stage: RECEIVER_STAGE,
    xmls: {
      partial: materialXml('<input name="transmission" type="float" value="0.05"/><input name="transmission_color" type="color3" value="1,1,1"/>'),
      clear: materialXml('<input name="transmission" type="float" value="1"/><input name="transmission_color" type="color3" value="1,1,1"/>'),
      connected: materialXml('<input name="transmission" type="float" nodename="transTex"/>', '<image name="transTex" type="float"><input name="file" type="filename" value="transmission.png"/></image>'),
      connectedTint: materialXml('<input name="transmission" type="float" value="0.5"/><input name="transmission_color" type="color3" nodename="tintTex"/>', '<image name="tintTex" type="color3"><input name="file" type="filename" value="tint.png"/></image>'),
      metallic: materialXml('<input name="transmission" type="float" value="1"/><input name="transmission_color" type="color3" value="1,1,1"/><input name="metalness" type="float" value="1"/>'),
      layered: `<materialx version="1.39">
        <standard_surface name="clearSurface" type="surfaceshader"><input name="transmission" type="float" value="1"/><input name="transmission_color" type="color3" value="1,1,1"/></standard_surface>
        <standard_surface name="opaqueSurface" type="surfaceshader"><input name="transmission" type="float" value="0"/></standard_surface>
        <mix name="mix" type="surfaceshader"><input name="fg" type="surfaceshader" nodename="clearSurface"/><input name="bg" type="surfaceshader" nodename="opaqueSurface"/><input name="mix" type="float" value="0.5"/></mix>
        <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="mix"/></surfacematerial>
      </materialx>`,
    },
  });
  for (const value of Object.values(values)) {
    expect(value.compiled).toBe(true);
    expect(value.warnings.some((warning) => /compile failed|unsupported material/i.test(warning))).toBe(false);
  }
  expect(values.partial.coverage.mode).toBe('static');
  expect(values.partial.coverage.opacity).toBeCloseTo(0.95, 5);
  expect(values.clear.coverage).toMatchObject({ mode: 'clear', opacity: 0 });
  expect(values.connected.coverage).toMatchObject({ mode: 'unknown', opacity: 1 });
  expect(values.connectedTint.coverage).toMatchObject({ mode: 'unknown', opacity: 1 });
  expect(values.metallic.coverage).toMatchObject({ mode: 'unknown', opacity: 1 });
  expect(values.layered.coverage).toMatchObject({ mode: 'unknown', opacity: 1 });
});

test('@scene sky visibility weights a partial blocker once per contiguous occupied run', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => typeof window.buildSkyVisibility === 'function' && window.THREE, null, { timeout: 30000 });
  const values = await page.evaluate(() => {
    const geometry = new window.THREE.BufferGeometry();
    geometry.setAttribute('position', new window.THREE.Float32BufferAttribute([
      -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0,
    ], 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const box = new window.THREE.Box3(new window.THREE.Vector3(-1, -1, -1), new window.THREE.Vector3(1, 1, 1));
    const bake = (opacity, geometryOverride = geometry) => window.buildSkyVisibility([{ geometry: geometryOverride, matrixWorld: new window.THREE.Matrix4(), opacity }], box, { resolution: 16, rays: 64 });
    const opaque = bake(1); const partial = bake(0.95);
    const duplicated = new window.THREE.BufferGeometry();
    duplicated.setAttribute('position', new window.THREE.Float32BufferAttribute([
      -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0,
      -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0,
    ], 3));
    duplicated.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const duplicatePartial = bake(0.95, duplicated);
    const tilted = new window.THREE.BufferGeometry();
    tilted.setAttribute('position', new window.THREE.Float32BufferAttribute([
      -1, -1, -0.5, 1, -1, 0.5, 1, 1, 0.5, -1, 1, -0.5,
    ], 3));
    tilted.setIndex([0, 1, 2, 0, 2, 3]);
    const tiltedOpaque = bake(1, tilted); const tiltedPartial = bake(0.95, tilted);
    const mean = (result) => result.data.reduce((sum, value, index) => sum + (index % 4 === 0 ? value : 0), 0) / (result.data.length / 4) / 255;
    return { opaqueMean: mean(opaque), partialMean: mean(partial), duplicatePartialMean: mean(duplicatePartial), tiltedOpaqueMean: mean(tiltedOpaque), tiltedPartialMean: mean(tiltedPartial) };
  });
  expect(values.partialMean).toBeGreaterThan(values.opaqueMean);
  expect(values.partialMean).toBeLessThan(1);
  expect(values.opaqueMean).toBeLessThan(0.9);
  expect(values.partialMean - values.opaqueMean).toBeCloseTo(0.05 * (1 - values.opaqueMean), 2);
  expect(values.duplicatePartialMean).toBeCloseTo(values.partialMean, 2);
  expect(values.tiltedPartialMean).toBeGreaterThan(values.tiltedOpaqueMean);
  expect(values.tiltedPartialMean - values.tiltedOpaqueMean).toBeCloseTo(0.05 * (1 - values.tiltedOpaqueMean), 2);
});

test('@scene weights blocker coverage in the GPU AO buffer without weighting the receiver', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const result = await page.evaluate(async (stage) => {
    window.localStorage.setItem('mtlx_scene_ao', '1');
    window.localStorage.setItem('mtlx_scene_skyvis', '0');
    window.localStorage.setItem('mtlx_scene_shadows', '0');
    const env = await window.getMxEnv();
    const makeXml = (transmission) => `<materialx version="1.39">
      <standard_surface name="surface" type="surfaceshader">
        <input name="base" type="float" value="1"/><input name="base_color" type="color3" value="0.7,0.7,0.7"/>
        <input name="specular" type="float" value="0"/><input name="transmission" type="float" value="${transmission}"/>
        <input name="transmission_color" type="color3" value="1,1,1"/><input name="emission" type="float" value="0"/>
      </standard_surface>
      <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
    </materialx>`;
    const makeNode = async (transmission) => {
      const doc = env.mx.createDocument();
      await window.mxExclusive(() => env.mx.readFromXmlString(doc, makeXml(transmission)));
      if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
      return { doc, node: window.listDocRenderables(doc)[0].node };
    };
    // The blocker starts at A=.05 (T=.95); its metadata is then varied so
    // every GPU result uses the same geometry, camera, and compiled programs.
    const receiver = await makeNode(0);
    const blocker = await makeNode(0.95);
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:128px;height:128px';
    document.body.appendChild(holder);
    const handle = await window.createMtlxSceneView({
      container: holder,
      stage: Object.assign({}, stage, { materials: [
        { path: '/Receiver', node: receiver.node }, { path: '/Blocker', node: blocker.node },
      ] }),
      version: '1.39.5',
    });
    handle.setBackdrop('none');
    handle.setSkyVisibility(false);
    handle.setShadowsEnabled(false);
    handle.setAmbientOcclusionEnabled(true);
    handle.setCamera({ position: [3, 2.5, 3], target: [0, 0.2, 0] });
    const debug = handle.__debug();
    const renderer = debug.renderer;
    const targets = [];
    const originalSetRenderTarget = renderer.setRenderTarget.bind(renderer);
    renderer.setRenderTarget = (target) => {
      if (target && !targets.includes(target)) targets.push(target);
      return originalSetRenderTarget(target);
    };
    handle.renderNow();
    renderer.setRenderTarget = originalSetRenderTarget;
    const aoTarget = targets.find((target) => target.width === 64 && target.height === 64
      && target.texture && target.texture.type === 1009);
    if (!aoTarget) throw new Error('AO GPU target was not captured');
    const prepassTarget = targets.find((target) => target.width === 64 && target.height === 64
      && target.texture && target.texture.type !== 1009);
    if (!prepassTarget) throw new Error('AO prepass GPU target was not captured');
    // Ground receiver just outside the blocker footprint. This must remain a
    // receiver pixel for every blocker coverage case; sampling the blocker
    // itself would conflate receiver and blocker weighting.
    const probe = new window.THREE.Vector3(0.6, 0.005, 0.03).project(debug.camera);
    const px = Math.floor((probe.x * 0.5 + 0.5) * aoTarget.width);
    // readRenderTargetPixels uses the OpenGL bottom-left origin.
    const py = Math.floor((probe.y * 0.5 + 0.5) * aoTarget.height);
    const readProbe = () => {
      const pixels = new Uint8Array(25 * 4);
      renderer.readRenderTargetPixels(aoTarget, Math.max(0, px - 2), Math.max(0, py - 2), 5, 5, pixels);
      let sum = 0;
      for (let i = 0; i < pixels.length; i += 4) sum += pixels[i];
      return sum / 25;
    };
    const receiverPrepass = new Float32Array(4);
    renderer.readRenderTargetPixels(prepassTarget, Math.max(0, px - 1), Math.max(0, py - 1), 1, 1, receiverPrepass);
    const receiverMesh = handle.selectPrim('/Ground');
    const blockerMesh = handle.selectPrim('/Blocker');
    const renderCoverage = (receiverCoverage, blockerCoverage) => {
      receiverMesh.material.userData.mtlxScenePrepassCoverage.opacity = receiverCoverage;
      blockerMesh.material.userData.mtlxScenePrepassCoverage.opacity = blockerCoverage;
      handle.renderNow();
      return readProbe();
    };
    const opaqueReceiver = [0, 0.05, 0.95, 1].map((coverage) => renderCoverage(1, coverage));
    const partialReceiver = [0, 0.05, 0.95, 1].map((coverage) => renderCoverage(0.05, coverage));
    const compiled = !!receiverMesh.material.userData.mtlxSceneCompiled?.vs;
    handle.dispose();
    holder.remove();
    receiver.doc.delete();
    blocker.doc.delete();
    return { opaqueReceiver, partialReceiver, receiverPrepass: Array.from(receiverPrepass), compiled, aoSize: [aoTarget.width, aoTarget.height] };
  }, {
    upAxis: 'Y', metersPerUnit: 1,
    meshes: [
      { primPath: '/Ground', materialPath: '/Receiver', positions: new Float32Array([-2, 0, -2, 2, 0, -2, 2, 0, 2, -2, 0, 2]), normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]), uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) },
      { primPath: '/Blocker', materialPath: '/Blocker', positions: new Float32Array([-0.4, 0, 0, 0.4, 0, 0, 0.4, 1, 0, -0.4, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) },
    ],
    lights: [],
  });
  expect(result.compiled).toBe(true);
  expect(result.aoSize).toEqual([64, 64]);
  expect(result.receiverPrepass[3]).toBeGreaterThan(0);
  expect(Math.abs(result.receiverPrepass[1])).toBeGreaterThan(0.5);
  const [clear, thin, mostly, opaque] = result.opaqueReceiver;
  expect(clear).toBeGreaterThan(253);
  expect(thin).toBeLessThan(clear - 1);
  expect(mostly).toBeLessThan(thin - 1);
  expect(opaque).toBeLessThanOrEqual(mostly + 1);
  expect(result.partialReceiver[0]).toBeGreaterThan(253);
  expect(result.partialReceiver[1]).toBeLessThan(result.partialReceiver[0] - 0.1);
  expect(result.partialReceiver[3]).toBeLessThan(result.partialReceiver[0] - 1);
  expect(Math.abs(result.partialReceiver[3] - opaque)).toBeLessThan(2);
});

