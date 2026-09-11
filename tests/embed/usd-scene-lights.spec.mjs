import {
  test, expect, gotoHarness, createViewer, waitForReady, callLoad,
} from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

test('@scene area-light conversion preserves lights for shader-side source cosine', async ({ page, embedURL }) => {
  await page.addInitScript(() => {
    let factory = null;
    Object.defineProperty(window, 'createMtlxSceneView', {
      configurable: true,
      get: () => factory,
      set: (next) => {
        factory = async (options) => {
          const handle = await next(options);
          window.__usdSceneHandle = handle;
          return handle;
        };
      },
    });
  });
  await page.goto(embedURL + '/index.html#!scene');
  await page.getByTestId('usd-scene-load-example').click();
  await expect(page.getByTestId('usd-scene-status')).toContainText('rendered', { timeout: 120000 });
  await page.waitForFunction(() => window.__usdSceneHandle && window.__usdSceneHandle.prims.some((object) => object.material && object.material.userData && object.material.userData.mtlxSceneCompiled), null, { timeout: 30000 });

  const shaderPatch = await page.evaluate(() => {
    const h = window.__usdSceneHandle;
    let fs = '';
    h.scene.traverse((object) => {
      const compiled = object.material && object.material.userData && object.material.userData.mtlxSceneCompiled;
      if (!fs && compiled) fs = compiled.fs || '';
    });
    return {
      sourceKindStruct: /struct\s+LightData[\s\S]*\bsourceKind\b/.test(fs),
      sourceCosine: /sourceKind[\s\S]*max\(dot\(u_lightData\[activeLightIndex\]\.direction, -L\), 0\.0\)/.test(fs),
      shadowDepthPlane: /u_shadowDepthPlanes[\s\S]*receiverDepth[\s\S]*dot\(vec4\(offsetP, 1\.0\), depthPlane\)/.test(fs),
      skyDirectional: /visibilityDirection[\s\S]*moments\.gba[\s\S]*dot\(visibilityDirection, skyNormal\)/.test(fs),
      skyFaceOriented: /vec3 skyNormal = normalize\(normalWorld\);[\s\S]*if \(!gl_FrontFacing\) skyNormal = -skyNormal;[\s\S]*dot\(visibilityDirection, skyNormal\)/.test(fs),
      aoEnvironmentOnly: /Ambient occlusion[\s\S]*occlusion = mx_ssao_occlusion\(\)[\s\S]*Add environment contribution/.test(fs)
        && /shader_constructor_out\.color \+= blended_coat_emission_edf_out;/.test(fs),
    };
  });
  expect(shaderPatch.sourceKindStruct).toBe(true);
  expect(shaderPatch.sourceCosine).toBe(true);
  expect(shaderPatch.shadowDepthPlane).toBe(true);
  expect(shaderPatch.skyDirectional).toBe(true);
  expect(shaderPatch.skyFaceOriented).toBe(true);
  expect(shaderPatch.aoEnvironmentOnly).toBe(true);

  const result = await page.evaluate(() => {
    const identity = [
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ];
    const base = {
      primPath: '/Rect',
      type: 'RectLight',
      matrix: identity,
      intensity: 1,
      exposure: 0,
      color: [1, 1, 1],
      width: 2,
      height: 2,
      normalize: false,
    };
    const convert = window.convertUsdStageLights;
    const front = convert([base], { limit: 16, sceneCenter: new window.THREE.Vector3(0, 0, -5) });
    const back = convert([base], { limit: 16, sceneCenter: new window.THREE.Vector3(0, 0, 5) });
    const frontIntensity = front.reduce((sum, light) => sum + light.intensity, 0);
    const backIntensity = back.reduce((sum, light) => sum + light.intensity, 0);
    const sphere = convert([{ ...base, primPath: '/Sphere', type: 'SphereLight', radius: 1, normalize: false }], { limit: 16 });
    const sphereNormalized = convert([{ ...base, primPath: '/Sphere', type: 'SphereLight', radius: 1, normalize: true }], { limit: 16 });
    const disk = convert([{ ...base, primPath: '/Disk', type: 'DiskLight', radius: 1 }], { limit: 16 });
    const cylinder = convert([{ ...base, primPath: '/Cylinder', type: 'CylinderLight', radius: 1, length: 2 }], { limit: 16 });
    const stageScale = new window.THREE.Matrix4().makeScale(0.01, 0.01, 0.01);
    const normalizedStage = convert([{ ...base, primPath: '/NormalizedStage', normalize: true }], {
      rootMatrix: stageScale, metersPerUnit: 0.01, limit: 16,
    });
    const unnormalizedStage = convert([{ ...base, primPath: '/UnnormalizedStage' }], {
      rootMatrix: stageScale, metersPerUnit: 0.01, limit: 16,
    });
    const pointStage = convert([{ ...base, primPath: '/PointStage', type: 'PointLight', normalize: false }], {
      rootMatrix: stageScale, metersPerUnit: 0.01, limit: 16,
    });
    const distantStage = convert([{ ...base, primPath: '/DistantStage', type: 'DistantLight', normalize: true }], {
      rootMatrix: stageScale, metersPerUnit: 0.01, limit: 16,
    });
    const tinyRect = convert([{ ...base, primPath: '/TinyRect', width: 1.5e-5, height: 1.5e-5 }], {
      limit: 16, metersPerUnit: 1,
    });
    const areaWarnings = [];
    const zeroRect = convert([{ ...base, primPath: '/ZeroRect', width: 0, height: 2 }], {
      limit: 16, warn: (message) => areaWarnings.push(message),
    });
    const zeroSphereNormalized = convert([{ ...base, primPath: '/ZeroSphere', type: 'SphereLight', radius: 0, normalize: true }], {
      limit: 16, metersPerUnit: 1, warn: (message) => areaWarnings.push(message),
    });
    const invalidRect = convert([{ ...base, primPath: '/InvalidRect', width: -1, height: 2 }], {
      limit: 16, warn: (message) => areaWarnings.push(message),
    });
    const source = front[0];
    const sourceCosine = (receiver) => Math.max(0, source.direction.dot(
      receiver.clone().sub(source.position).normalize()));
    const frontReceiver = source.position.clone().add(source.direction.clone().multiplyScalar(5));
    const backReceiver = source.position.clone().add(source.direction.clone().multiplyScalar(-5));
    const obliqueReceiver = source.position.clone().add(
      source.direction.clone().add(new window.THREE.Vector3(1, 0, 0)).normalize().multiplyScalar(5));
    return { frontCount: front.length, backCount: back.length, frontIntensity, backIntensity,
      sphereIntensity: sphere[0].intensity, sphereNormalizedIntensity: sphereNormalized[0].intensity,
      normalizedStageIntensity: normalizedStage.reduce((sum, light) => sum + light.intensity, 0),
      unnormalizedStageIntensity: unnormalizedStage.reduce((sum, light) => sum + light.intensity, 0),
      pointStageIntensity: pointStage[0].intensity,
      distantStageIntensity: distantStage[0].intensity,
      tinyRectIntensity: tinyRect.reduce((sum, light) => sum + light.intensity, 0),
      zeroRectCount: zeroRect.length,
      zeroSphereNormalizedIntensity: zeroSphereNormalized[0] && zeroSphereNormalized[0].intensity,
      invalidRectCount: invalidRect.length,
      areaWarnings,
      diskSourceKind: disk[0].sourceKind, cylinderSourceKind: cylinder[0].sourceKind,
      frontCosine: sourceCosine(frontReceiver), backCosine: sourceCosine(backReceiver),
      rectExtent: source.emitter && source.emitter.extent,
      rectEmitterExtent: source.emitter && source.emitter.primPath === '/Rect' ? source.emitter.extent : null,
      rectEmitterSourceKind: source.emitter && source.emitter.sourceKind,
      obliqueCosine: sourceCosine(obliqueReceiver) };
  });

  expect(result.frontCount).toBeGreaterThan(0);
  expect(result.rectExtent).toBeCloseTo(2, 6);
  expect(result.rectEmitterExtent).toBeCloseTo(2, 6);
  expect(result.rectEmitterSourceKind).toBe(1);
  expect(result.frontIntensity).toBeGreaterThan(0);
  expect(result.backCount).toBe(result.frontCount);
  expect(result.backIntensity).toBeCloseTo(result.frontIntensity, 6);
  expect(result.sphereIntensity).toBeCloseTo(Math.PI, 6);
  expect(result.sphereNormalizedIntensity).toBeCloseTo(0.25, 6);
  expect(result.normalizedStageIntensity).toBeCloseTo(0.0001, 8);
  expect(result.unnormalizedStageIntensity).toBeCloseTo(0.0004, 8);
  expect(result.pointStageIntensity).toBeCloseTo(0.0001, 8);
  expect(result.distantStageIntensity).toBeCloseTo(1, 6);
  expect(result.tinyRectIntensity).toBeCloseTo(2.25e-10, 12);
  expect(result.zeroRectCount).toBe(0);
  expect(result.zeroSphereNormalizedIntensity).toBeCloseTo(0.25, 6);
  expect(result.invalidRectCount).toBe(0);
  expect(result.areaWarnings.some((warning) => /invalid width.*skipped/i.test(warning))).toBe(true);
  expect(result.diskSourceKind).toBe(1);
  expect(result.cylinderSourceKind).toBe(0);
  expect(result.frontCosine).toBeCloseTo(1, 6);
  expect(result.backCosine).toBe(0);
  expect(result.obliqueCosine).toBeCloseTo(Math.SQRT1_2, 6);
});

test('@scene rect source cosine lights the front receiver and leaves the back receiver dark', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.prepGeometry && window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const result = await page.evaluate(async () => {
    const xml = `<materialx version="1.39">
      <constant name="base" type="color3"><input name="value" type="color3" value="0.8, 0.8, 0.8"/></constant>
      <standard_surface name="surface" type="surfaceshader">
        <input name="base" type="float" value="1"/>
        <input name="base_color" type="color3" nodename="base"/>
        <input name="specular" type="float" value="0"/>
        <input name="emission" type="float" value="0"/>
      </standard_surface>
      <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
    </materialx>`;
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const renderable = window.listDocRenderables(doc)[0];
    const positions = new Float32Array([
      -1.5, -0.8, -2, -0.2, -0.8, -2, -0.2, 0.8, -2, -1.5, 0.8, -2,
       0.2, -0.8,  2,  1.5, -0.8,  2,  1.5, 0.8,  2,  0.2, 0.8,  2,
    ]);
    const normals = new Float32Array([
      0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
      0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1,
    ]);
    const uvs = new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
      0, 0, 1, 0, 1, 1, 0, 1,
    ]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const lightMatrix = identity.slice();
    const stage = {
      upAxis: 'Y', metersPerUnit: 1,
      meshes: [{ positions, normals, uvs, indices, materialPath: '/Material' }],
      materials: [{ path: '/Material', node: renderable.node }],
      lights: [{ primPath: '/Rect', type: 'RectLight', matrix: lightMatrix,
        intensity: 20, exposure: 0, color: [1, 1, 1], width: 2, height: 2, normalize: false }],
    };
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:480px;background:#000';
    document.body.appendChild(holder);
    const handle = await window.createMtlxSceneView({ container: holder, stage, version: '1.39.5' });
    handle.setBackdrop('none');
    handle.setEnvExposure(0);
    handle.camera.position.set(0, 0, 8);
    handle.camera.lookAt(0, 0, 0);
    handle.camera.updateMatrixWorld(true);
    handle.renderNow();
    return { image: await holder.querySelector('canvas').toDataURL('image/png') };
  });
  const image = decodePNG(Buffer.from(result.image.split(',')[1], 'base64'));
  const average = (x0, x1) => {
    let sum = 0;
    let count = 0;
    for (let y = 150; y < 330; y++) for (let x = x0; x < x1; x++) {
      const p = image.getPixel(x, y);
      sum += (0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b);
      count += 1;
    }
    return sum / count;
  };
  const front = average(150, 315);
  const back = average(325, 490);
  expect(front).toBeGreaterThan(30);
  expect(back).toBeLessThan(front * 0.2);
});

test('@scene constant white dome gives a Lambertian diffuse plane its authored albedo in linear output', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.prepGeometry && window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const result = await page.evaluate(async () => {
    const xml = `<materialx version="1.39">
      <constant name="baseColor" type="color3"><input name="value" type="color3" value="0.8, 0.8, 0.8"/></constant>
      <standard_surface name="surface" type="surfaceshader">
        <input name="base" type="float" value="1"/>
        <input name="base_color" type="color3" nodename="baseColor"/>
        <input name="specular" type="float" value="0"/>
        <input name="transmission" type="float" value="0"/>
        <input name="emission" type="float" value="0"/>
      </standard_surface>
      <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
    </materialx>`;
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const renderable = window.listDocRenderables(doc)[0];
    const positions = new Float32Array([-1.8, -1.2, 0, 1.8, -1.2, 0, 1.8, 1.2, 0, -1.8, 1.2, 0]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const stage = {
      upAxis: 'Y', metersPerUnit: 1,
      meshes: [{ positions, normals, uvs, indices, materialPath: '/Material' }],
      materials: [{ path: '/Material', node: renderable.node }],
      lights: [],
    };
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:480px;background:#000';
    document.body.appendChild(holder);
    const handle = await window.createMtlxSceneView({ container: holder, stage, version: '1.39.5' });
    handle.setBackdrop('none');
    handle.setEnvironment(window.makeFlatEnvironment([1, 1, 1]));
    handle.setEnvExposure(1);
    handle.setSceneDisplayTransform('lin_rec709');
    handle.setSkyVisibility(true);
    handle.camera.position.set(0, 0, 6);
    handle.camera.lookAt(0, 0, 0);
    handle.camera.updateMatrixWorld(true);
    handle.renderNow();
    const u = handle.prims[0] && handle.prims[0].material && handle.prims[0].material.uniforms;
    const map = u && u.u_skyVisMap && u.u_skyVisMap.value;
    const info = handle.getSkyVisibility && handle.getSkyVisibility();
    const dims = map && map.image ? [map.image.width, map.image.height, map.image.depth] : null;
    const data = map && map.image && map.image.data;
    const mn = u && u.u_skyVisMin && u.u_skyVisMin.value;
    const sz = u && u.u_skyVisSize && u.u_skyVisSize.value;
    const cell = u && u.u_skyVisCell && u.u_skyVisCell.value;
    const uv = mn && sz ? [
      (0 - mn.x) / sz.x,
      (0 - mn.y) / sz.y,
      (1.5 * cell - mn.z) / sz.z,
    ] : null;
    const at = (x, y, z) => data && dims ? Array.from(data.slice(((z * dims[1] + y) * dims[0] + x) * 4, ((z * dims[1] + y) * dims[0] + x) * 4 + 4)) : null;
    const cx = dims ? Math.floor(dims[0] / 2) : 0, cy = dims ? Math.floor(dims[1] / 2) : 0;
    const sampleZ = mn && dims ? Math.max(0, Math.min(dims[2] - 1, Math.floor((1.5 * cell - mn.z) / cell))) : 0;
    return {
      image: await holder.querySelector('canvas').toDataURL('image/png'),
      compiled: !!(handle.prims[0] && handle.prims[0].material
        && handle.prims[0].material.userData
        && handle.prims[0].material.userData.mtlxSceneCompiled),
      diagnostic: { info, uniformMin: mn && mn.toArray(), uniformSize: sz && sz.toArray(), cell, uv, sampleZ, dims, z0: at(cx, cy, 0), z1: at(cx, cy, 1), normal: handle.prims[0].geometry && Array.from(handle.prims[0].geometry.getAttribute('normal').array.slice(0, 3)) },
    };
  });
  console.log('white dome sky diagnostic', result.diagnostic);
  expect(result.compiled).toBe(true);
  expect(result.diagnostic.uv.every((value) => value > 0 && value < 1)).toBe(true);
  expect(result.diagnostic.sampleZ).toBeGreaterThan(1);
  const image = decodePNG(Buffer.from(result.image.split(',')[1], 'base64'));
  const center = image.getPixel(Math.floor(image.width / 2), Math.floor(image.height / 2));
  expect(center.r).toBeGreaterThan(190);
  expect(center.r).toBeLessThan(218);
  expect(Math.abs(center.r - center.g)).toBeLessThanOrEqual(2);
  expect(Math.abs(center.r - center.b)).toBeLessThanOrEqual(2);
});

test('@scene sky visibility bake keeps an interior plane bright and a closed room dark', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.THREE && window.buildSkyVisibility, null, { timeout: 30000 });
  const result = await page.evaluate(() => {
    const THREE = window.THREE;
    const decodeAt = (bake, point) => {
      const x = Math.max(0, Math.min(bake.dim[0] - 1, Math.floor((point.x - bake.min[0]) / bake.cell)));
      const y = Math.max(0, Math.min(bake.dim[1] - 1, Math.floor((point.y - bake.min[1]) / bake.cell)));
      const z = Math.max(0, Math.min(bake.dim[2] - 1, Math.floor((point.z - bake.min[2]) / bake.cell)));
      const o = ((z * bake.dim[1] + y) * bake.dim[0] + x) * 4;
      const a = bake.data[o] / 255;
      const d = [bake.data[o + 1], bake.data[o + 2], bake.data[o + 3]].map((v) => (v - 128) / 127);
      return { a, diffuseUp: Math.max(0, Math.min(1, a + d[2])), cell: [x, y, z] };
    };
    const plane = new THREE.PlaneGeometry(2, 2);
    plane.computeBoundingBox();
    const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    const open = window.buildSkyVisibility([{ geometry: plane, matrixWorld: new THREE.Matrix4() }], box, { resolution: 16, rays: 64 });
    const interior = decodeAt(open, new THREE.Vector3(0, 0, 1.5 * open.cell));
    const room = new THREE.BoxGeometry(1.5, 1.5, 1.5);
    room.computeBoundingBox();
    const closed = window.buildSkyVisibility([{ geometry: room, matrixWorld: new THREE.Matrix4() }], box, { resolution: 16, rays: 64 });
    const floorPoint = new THREE.Vector3(0, 0, -0.75 + 1.5 * closed.cell);
    const enclosed = decodeAt(closed, floorPoint);
    return { interior, enclosed, openDim: open.dim, closedDim: closed.dim };
  });
  expect(result.interior.diffuseUp).toBeGreaterThan(0.85);
  expect(result.enclosed.diffuseUp).toBeLessThan(0.3);
});

test('@viewer opaque material keeps display encoding with transparency off', async ({ page, embedURL }) => {
  await gotoHarness(page, embedURL);
  const idx = await createViewer(page, {
    base: embedURL + '/embed/', geometry: 'sphere', backdrop: 'none', eager: true,
  });
  await waitForReady(page, idx);
  const xml = `<materialx version="1.39">
    <standard_surface name="surface" type="surfaceshader">
      <input name="base" type="float" value="0"/>
      <input name="specular" type="float" value="0"/>
      <input name="emission" type="float" value="0.5"/>
      <input name="emission_color" type="color3" value="1,1,1"/>
    </standard_surface>
    <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
  </materialx>`;
  const loaded = await callLoad(page, idx, xml);
  expect(loaded.ok).toBe(true);
  const elementHandle = (await page.evaluateHandle((i) => window.__viewers[i], idx)).asElement();
  await page.evaluate((i) => {
    const el = window.__viewers[i];
    el.style.width = '640px'; el.style.height = '480px'; el.style.aspectRatio = 'auto';
  }, idx);
  await page.waitForTimeout(300);
  const image = decodePNG(await elementHandle.screenshot());
  const center = image.getPixel(Math.floor(image.width / 2), Math.floor(image.height / 2));
  // Raw linear 0.5 would be about 128; the ordinary opaque Viewer path must
  // encode it once for the display, approximately 188 in an sRGB screenshot.
  expect(center.r).toBeGreaterThan(175);
  expect(center.r).toBeLessThan(200);
  expect(Math.abs(center.r - center.g)).toBeLessThanOrEqual(2);
  expect(Math.abs(center.r - center.b)).toBeLessThanOrEqual(2);
});
