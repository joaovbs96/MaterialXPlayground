import { test, expect } from './lib/test-base.mjs';
import { decodePNG } from './lib/png.mjs';

const changed = (a, b) => {
  let sum = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const p = a.getPixel(x, y), q = b.getPixel(x, y);
    sum += Math.abs(p.r - q.r) + Math.abs(p.g - q.g) + Math.abs(p.b - q.b);
  }
  return sum;
};

test('@scene preserves mirrored tangent-frame handedness for normal maps', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.prepGeometry && window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const result = await page.evaluate(async () => {
    const xml = `<materialx version="1.39">
      <constant name="base" type="color3"><input name="value" type="color3" value="0.18, 0.18, 0.18"/></constant>
      <constant name="normalValue" type="vector3"><input name="value" type="vector3" value="0.5, 1, 0.5"/></constant>
      <image name="normalImage" type="vector3"><input name="file" type="filename" value="normal.png"/></image>
      <normalmap name="normalMap" type="vector3"><input name="in" type="vector3" nodename="normalImage"/></normalmap>
      <standard_surface name="surface" type="surfaceshader">
        <input name="base_color" type="color3" nodename="base"/>
        <input name="specular_roughness" type="float" value="0.35"/>
        <input name="normal" type="vector3" nodename="normalMap"/>
        <input name="emission" type="float" value="1"/>
        <input name="emission_color" type="color3" nodename="normalMap"/>
      </standard_surface>
      <surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial>
    </materialx>`;
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const renderables = window.listDocRenderables(doc);
    const renderable = renderables.find((entry) => entry.name === 'material') || renderables[0];
    if (!renderable) throw new Error('normal-map regression material was not renderable');
    const planePositions = [
      -1.4, -0.55, 0, -0.1, -0.55, 0, -0.1, 0.55, 0, -1.4, 0.55, 0,
       0.1, -0.55, 0,  1.4, -0.55, 0,  1.4, 0.55, 0,  0.1, 0.55, 0,
    ];
    const positions = new Float32Array(planePositions);
    const normals = new Float32Array(Array.from({ length: 8 }, () => [0, 0, 1]).flat());
    const uvs = new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
      1, 0, 0, 0, 0, 1, 1, 1,
    ]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    const imageCanvas = document.createElement('canvas');
    imageCanvas.width = imageCanvas.height = 2;
    const imageContext = imageCanvas.getContext('2d');
    imageContext.fillStyle = 'rgb(128, 255, 128)';
    imageContext.fillRect(0, 0, 2, 2);
    const normalBlob = await new Promise((resolve) => imageCanvas.toBlob(resolve, 'image/png'));
    const stage = {
      upAxis: 'Y', metersPerUnit: 1,
      meshes: [{ positions, normals, uvs, indices, materialPath: '/Material' }],
      materials: [{ path: '/Material', node: renderable.node }],
    };
    const holder = document.createElement('div');
    holder.dataset.testid = 'normalmap-regression-holder';
    holder.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:480px;background:#000';
    document.body.appendChild(holder);
    const handle = await window.createMtlxSceneView({ container: holder, stage, files: [{ path: 'normal.png', data: normalBlob }], version: '1.39.5' });
    handle.setBackdrop('none');
    handle.renderNow();
    const geometry = handle.prims[0].geometry;
    const tangent = geometry.getAttribute('i_tangent');
    const bitangent = geometry.getAttribute('i_bitangent');
    const material = handle.prims[0].material;
    const shader = material.userData.mtlxSceneCompiled.vs;
    // Exercise the non-indexed path directly as well. USD draw extraction
    // can return either indexed or already-expanded triangles.
    const nonIndexed = new window.THREE.BufferGeometry();
    nonIndexed.setAttribute('position', new window.THREE.Float32BufferAttribute([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ], 3));
    nonIndexed.setAttribute('normal', new window.THREE.Float32BufferAttribute(Array.from({ length: 6 }, () => [0, 0, 1]).flat(), 3));
    nonIndexed.setAttribute('uv', new window.THREE.Float32BufferAttribute([
      0, 0, 1, 0, 0, 1,
      1, 0, 0, 0, 1, 1,
    ], 2));
    window.prepGeometry(nonIndexed);
    const nonIndexedTangent = nonIndexed.getAttribute('i_tangent');
    const nonIndexedBitangent = nonIndexed.getAttribute('i_bitangent');
    const normalSlots = [];
    Object.entries(material.uniforms || {}).forEach(([name, slot]) => {
      if (/normal/i.test(name) && slot && slot.value && slot.value.isTexture) normalSlots.push({ material, name, value: slot.value });
    });
    const frame = {
      tangent: Array.from({ length: 8 }, (_, i) => [tangent.getX(i), tangent.getY(i), tangent.getZ(i)]),
      bitangent: Array.from({ length: 8 }, (_, i) => [bitangent.getX(i), bitangent.getY(i), bitangent.getZ(i)]),
      nonIndexedTangent: [nonIndexedTangent.getX(3), nonIndexedTangent.getY(3), nonIndexedTangent.getZ(3)],
      nonIndexedBitangent: [nonIndexedBitangent.getX(3), nonIndexedBitangent.getY(3), nonIndexedBitangent.getZ(3)],
      explicitAttribute: shader.includes('i_bitangent'),
      explicitBitangentObjectTransform: /bitangentWorld[\s\S]{0,180}i_bitangent/.test(shader) && /u_worldMatrix/.test(shader),
      fragmentUsesNormal: material.userData.mtlxSceneCompiled.fs.includes('normalMap') || material.userData.mtlxSceneCompiled.fs.includes('bitangent'),
    };
    frame.frameFiniteUnit = [...frame.tangent, ...frame.bitangent].every((v) => v.every(Number.isFinite)
      && Math.abs(Math.hypot(...v) - 1) < 1e-4);
    window.__normalmapRegression = { handle, doc, holder, bitangent, frame, normalSlots };
    return frame;
  });
  expect(result.explicitAttribute).toBe(true);
  expect(result.tangent[0][0]).toBeGreaterThan(0.9);
  expect(result.tangent[4][0]).toBeLessThan(-0.9);
  expect(result.bitangent[0][1]).toBeGreaterThan(0.9);
  expect(result.bitangent[4][1]).toBeGreaterThan(0.9);
  expect(result.nonIndexedTangent[0]).toBeLessThan(-0.9);
  expect(result.nonIndexedBitangent[1]).toBeGreaterThan(0.9);
  expect(result.frameFiniteUnit).toBe(true);
  expect(result.explicitBitangentObjectTransform).toBe(true);
  const image = decodePNG(await page.getByTestId('normalmap-regression-holder').screenshot());
  await page.getByTestId('normalmap-regression-holder').screenshot({ path: 'docs/local/usd-scene-normalmap.png' });
  await page.evaluate(async () => {
    const { handle, normalSlots } = window.__normalmapRegression;
    const neutral = new window.THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1, window.THREE.RGBAFormat);
    neutral.flipY = false;
    neutral.minFilter = neutral.magFilter = window.THREE.NearestFilter;
    neutral.needsUpdate = true;
    let bound = 0;
    normalSlots.forEach(({ material, name }) => { material.uniforms[name].value = neutral; bound++; });
    if (!bound) throw new Error('normal-map fixture did not expose a texture sampler');
    handle.renderNow();
    window.__normalmapRegression.neutral = neutral;
  });
  const neutralImage = decodePNG(await page.getByTestId('normalmap-regression-holder').screenshot());
  expect(changed(image, neutralImage)).toBeGreaterThan(image.width * image.height * 0.001);
  await page.evaluate(() => {
    const { handle, normalSlots } = window.__normalmapRegression;
    normalSlots.forEach(({ material, name, value }) => { material.uniforms[name].value = value; });
    handle.renderNow();
  });
  const restoredImage = decodePNG(await page.getByTestId('normalmap-regression-holder').screenshot());
  expect(changed(image, restoredImage)).toBeLessThan(image.width * image.height * 0.001);
  await page.evaluate(() => {
    const { handle, bitangent } = window.__normalmapRegression;
    for (let i = 4; i < 8; i++) bitangent.array[i * 3 + 1] *= -1;
    bitangent.needsUpdate = true;
    handle.renderNow();
  });
  const wrongImage = decodePNG(await page.getByTestId('normalmap-regression-holder').screenshot());
  expect(changed(image, wrongImage)).toBeGreaterThan(image.width * image.height * 0.001);
  await page.evaluate(() => {
    const { handle, doc, holder, neutral } = window.__normalmapRegression;
    handle.dispose();
    neutral?.dispose();
    holder.remove();
    try { doc.delete(); } catch (e) {}
    delete window.__normalmapRegression;
  });
});
