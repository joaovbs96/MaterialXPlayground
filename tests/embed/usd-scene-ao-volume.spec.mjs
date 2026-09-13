import { test, expect } from './lib/test-base.mjs';

const materialXml = `<materialx version="1.39"><standard_surface name="surface" type="surfaceshader">
  <input name="base" type="float" value="1"/><input name="base_color" type="color3" value="0.7,0.7,0.7"/>
  <input name="specular" type="float" value="0"/><input name="transmission" type="float" value="0"/>
  <input name="emission" type="float" value="0"/>
</standard_surface><surfacematerial name="material" type="material"><input name="surfaceshader" type="surfaceshader" nodename="surface"/></surfacematerial></materialx>`;

// A 4-unit room open at the top (floor plus four walls, like the skyvis
// spec's room but scaled up and missing its ceiling): the corner sits close
// to two walls that block most of the opening, while the centre is two
// units from every wall and sees much more of it, giving sky and volume
// real spatial variation. Camera poses stay pitched at the floor, so the
// opening never enters frame and every pixel still lands on real geometry
// (which the edge probe below relies on).
const quad = (primPath, positions, normal) => ({
  primPath, materialPath: '/Room',
  positions: new Float32Array(positions),
  normals: new Float32Array(Array(4).fill(normal).flat()),
  uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
});
const room = [
  quad('/Floor', [-2, -2, -2, 2, -2, -2, 2, -2, 2, -2, -2, 2], [0, 1, 0]),
  quad('/WallXNeg', [-2, -2, -2, -2, -2, 2, -2, 2, 2, -2, 2, -2], [1, 0, 0]),
  quad('/WallXPos', [2, -2, -2, 2, 2, -2, 2, 2, 2, 2, -2, 2], [-1, 0, 0]),
  quad('/WallZNeg', [-2, -2, -2, -2, 2, -2, 2, 2, -2, 2, -2, -2], [0, 0, 1]),
  quad('/WallZPos', [-2, -2, 2, 2, -2, 2, 2, 2, 2, -2, 2, 2], [0, 0, -1]),
];

test('@scene hybrid AO: baked volume plus guarded SSAO combine at a floor corner and centre', async ({ page, embedURL }, testInfo) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => window.createMtlxSceneView && window.getMxEnv, null, { timeout: 30000 });
  const result = await page.evaluate(async ({ xml, room }) => {
    window.localStorage.setItem('mtlx_scene_ao', '1');
    window.localStorage.setItem('mtlx_scene_skyvis', '1');
    window.localStorage.setItem('mtlx_scene_shadows', '0');
    const T = window.THREE;
    const env = await window.getMxEnv();
    const doc = env.mx.createDocument();
    await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
    if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
    const node = window.listDocRenderables(doc)[0].node;
    const holder = document.createElement('div');
    holder.style.cssText = 'position:fixed;left:0;top:0;width:480px;height:360px';
    document.body.appendChild(holder);
    const stage = {
      upAxis: 'Y', metersPerUnit: 1,
      meshes: room.map((m) => ({ primPath: m.primPath, materialPath: m.materialPath,
        positions: new Float32Array(m.positions), normals: new Float32Array(m.normals),
        uvs: new Float32Array(m.uvs), indices: new Uint32Array(m.indices) })),
      materials: [{ path: '/Room', node }], lights: [],
    };
    const h = await window.createMtlxSceneView({ container: holder, stage, version: '1.39.5' });
    const renderer = h.renderer; renderer.setPixelRatio(1); renderer.setSize(480, 360, false);
    const gl = renderer.getContext();
    h.setBackdrop('none'); h.setEnvironment(window.makeFlatEnvironment([0.5, 0.5, 0.5])); h.setEnvExposure(1);
    h.setShadowsEnabled(false);

    const corner = new T.Vector3(-1.6, -2, -1.6);
    const centre = new T.Vector3(0, -2, 0);
    const up = new T.Vector3(0, 1, 0);
    const target = new T.Vector3(-0.8, -1.8, -0.8);

    const measure = (position) => {
      h.camera.position.set(position[0], position[1], position[2]);
      h.camera.up.set(0, 1, 0);
      h.camera.fov = 70;
      h.camera.aspect = 480 / 360;
      h.camera.lookAt(target);
      h.camera.updateProjectionMatrix();
      h.camera.updateMatrixWorld(true);
      h.renderNow();
      if (gl.getError() !== gl.NO_ERROR) throw new Error('GL error after render at ' + position.join(','));
      const cornerProbe = h.__aoProbe(corner, up);
      const centreProbe = h.__aoProbe(centre, up);
      const combinedCorner = cornerProbe.sky * Math.min(cornerProbe.volume, cornerProbe.ssao.ao);
      const combinedCentre = centreProbe.sky * Math.min(centreProbe.volume, centreProbe.ssao.ao);
      // A world point just inside the left edge of frame: unprojecting an
      // NDC x near -1 always lands on real geometry, since the room is sealed.
      const aoWidth = Math.floor(480 * 0.5);
      const ndcX = -1 + (4.5 / aoWidth) * 2;
      const edgePoint = new T.Vector3(ndcX, 0, 0).unproject(h.camera);
      const edgeProbe = h.__aoProbe(edgePoint, up);
      return { cornerProbe, centreProbe, combinedCorner, combinedCentre, edgeConfidence: edgeProbe.ssao.confidence };
    };

    const poseA = measure([1.2, -0.3, 1.4]);
    const poseB = measure([-1.3, 0.4, 1.5]);
    const volume = h.getAmbientOcclusion().volume;
    const out = { poseA, poseB, volume };
    h.dispose(); holder.remove(); doc.delete();
    return out;
  }, { xml: materialXml, room });

  await testInfo.attach('ao-volume-bake.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  console.log('[ao-volume]', JSON.stringify(result));

  expect(result.volume.ready).toBe(true);

  for (const pose of [result.poseA, result.poseB]) {
    expect(pose.combinedCorner).toBeLessThan(pose.combinedCentre);
    expect(pose.edgeConfidence).toBeLessThan(0.5);
  }
  expect(Math.abs(result.poseA.combinedCorner - result.poseB.combinedCorner)).toBeLessThan(0.05);
  expect(Math.abs(result.poseA.combinedCentre - result.poseB.combinedCentre)).toBeLessThan(0.05);
});
