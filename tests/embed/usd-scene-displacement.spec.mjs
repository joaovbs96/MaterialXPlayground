// tests/embed/usd-scene-displacement.spec.mjs: P9 acceptance for displacement
// in the USD Scene. Builds a stage object directly (usd-scene-material-mix's
// pattern) instead of going through the USD worker: inline .mtlx strings only.

import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

// Float-constant displacement (0.2 * scale 0.5 = 0.1 offset along the
// normal), same shape as displacement-view.spec.mjs's SCALE_A_MTLX.
const DISPLACED_MTLX = `<?xml version="1.0"?>
<materialx version="1.39">
  <standard_surface name="surf" type="surfaceshader" />
  <displacement name="disp" type="displacementshader">
    <input name="displacement" type="float" value="0.2" />
    <input name="scale" type="float" value="0.5" />
  </displacement>
  <surfacematerial name="DispMat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surf" />
    <input name="displacementshader" type="displacementshader" nodename="disp" />
  </surfacematerial>
</materialx>`;

const PLAIN_MTLX = `<?xml version="1.0"?>
<materialx version="1.39">
  <standard_surface name="surf2" type="surfaceshader" />
  <surfacematerial name="PlainMat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surf2" />
  </surfacematerial>
</materialx>`;

// Two materials share the SAME surfaceshader node ("sharedSurf") with their
// own displacement constant; resolveDisplacementSource's name-only fallback
// cannot tell them apart without materialName (always the first found).
const SHARED_SURFACE_MTLX = `<?xml version="1.0"?>
<materialx version="1.39">
  <standard_surface name="sharedSurf" type="surfaceshader" />
  <displacement name="dispA" type="displacementshader">
    <input name="displacement" type="float" value="0.2" />
    <input name="scale" type="float" value="0.5" />
  </displacement>
  <displacement name="dispB" type="displacementshader">
    <input name="displacement" type="float" value="0.4" />
    <input name="scale" type="float" value="0.5" />
  </displacement>
  <surfacematerial name="SharedA" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="sharedSurf" />
    <input name="displacementshader" type="displacementshader" nodename="dispA" />
  </surfacematerial>
  <surfacematerial name="SharedB" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="sharedSurf" />
    <input name="displacementshader" type="displacementshader" nodename="dispB" />
  </surfacematerial>
</materialx>`;

// A 4x4 grid of independent (non-shared-index) quads, split column-major
// into two material groups so a boundary vertex pair is coincident but not
// the same index: the seam displaceRecordParts has to close by position.
function buildGridPlane() {
  const grid = 4;
  const positions = [], normals = [], uvs = [], indices = [];
  const quads = [];
  for (let col = 0; col < grid; col++) {
    for (let row = 0; row < grid; row++) quads.push({ col, row });
  }
  // Column-major order: all displaced-column quads first, then the rest,
  // so record.groups stays two contiguous ranges instead of interleaving.
  quads.sort((a, b) => (a.col < 2 ? 0 : 1) - (b.col < 2 ? 0 : 1) || a.col - b.col || a.row - b.row);
  quads.forEach((q) => {
    const base = positions.length / 3;
    const x0 = q.col, x1 = q.col + 1, z0 = q.row, z1 = q.row + 1;
    const corners = [[x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1]];
    corners.forEach((p) => { positions.push(...p); normals.push(0, 1, 0); });
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const dispQuadCount = quads.filter((q) => q.col < 2).length;
  const dispTriCount = dispQuadCount * 2;
  const totalTriCount = quads.length * 2;
  return {
    positions, normals, uvs, indices,
    groups: [
      { start: 0, count: dispTriCount * 3, materialPath: '/Grid/DispMat' },
      { start: dispTriCount * 3, count: (totalTriCount - dispTriCount) * 3, materialPath: '/Grid/PlainMat' },
    ],
    dispTriCount, totalTriCount,
  };
}

async function gotoScene(page, embedURL) {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(
    () => typeof window.createMtlxSceneView === 'function' && typeof window.setDisplacementEnabled === 'function',
    null, { timeout: WAIT_TIMEOUT }
  );
}

// Builds the full stage (grid mesh + a separately-instanced quad) and
// creates a view; returns per-vertex positions/groups/prim info so each
// test can assert on the specific behaviour it cares about.
async function loadStage(page, { grid, displacementSubdivision } = {}) {
  return page.evaluate(async ({ grid, displacementSubdivision, dispXml, plainXml }) => {
    const holder = document.createElement('div');
    holder.style.cssText = 'width:320px;height:180px;position:absolute;left:-1000px;';
    document.body.appendChild(holder);
    const instancedQuad = {
      primPath: '/Grid/InstancedQuad',
      instanceOwnerPath: '/Grid/InstancedQuad',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      materialPath: '/Grid/DispMat',
      instanceMatrices: [
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1],
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 20, 0, 0, 1],
      ],
    };
    const stage = {
      meshes: [
        {
          primPath: '/Grid/Plane',
          positions: new Float32Array(grid.positions),
          normals: new Float32Array(grid.normals),
          uvs: new Float32Array(grid.uvs),
          indices: new Uint32Array(grid.indices),
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          materialPath: '/Grid/DispMat',
          groups: grid.groups,
        },
        instancedQuad,
      ],
      materials: [
        { path: '/Grid/DispMat', sourceAsset: 'grid.mtlx', subIdentifier: 'DispMat' },
        { path: '/Grid/PlainMat', sourceAsset: 'grid.mtlx', subIdentifier: 'PlainMat' },
      ],
      warnings: [],
    };
    const files = [{ path: 'grid.mtlx', data: new Blob([dispXml + '\n' + plainXml], { type: 'application/xml' }) }];
    const options = { container: holder, stage, files, version: '1.39.5' };
    if (displacementSubdivision !== undefined) options.displacementSubdivision = displacementSubdivision;
    const h = await window.createMtlxSceneView(options);
    window.__sceneDisp = h;
    const planeParts = [];
    h.scene.traverse((o) => {
      if (o.isMesh && o.userData.primPath === '/Grid/Plane') planeParts.push(o);
    });
    const instancedParts = [];
    h.scene.traverse((o) => {
      if (o.isMesh && o.userData.primPath === '/Grid/InstancedQuad') instancedParts.push(o);
    });
    const readGeometry = (mesh) => {
      const pos = mesh.geometry.getAttribute('position');
      return Array.from(pos.array);
    };
    return {
      warnings: h.warnings.slice(),
      planePositions: planeParts.map(readGeometry),
      planeTriangles: planeParts.map((m) => (m.geometry.getIndex() ? m.geometry.getIndex().count / 3 : m.geometry.getAttribute('position').count / 3)),
      instancedCount: instancedParts.length,
      instancedGeometrySame: instancedParts.length === 2 && instancedParts[0].geometry === instancedParts[1].geometry,
      instancedPositions: instancedParts.map(readGeometry),
      sceneRadius: (() => {
        let radius = null;
        h.scene.traverse((o) => {
          const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
          for (const m of mats) if (m.uniforms && m.uniforms.u_sceneRadius) radius = m.uniforms.u_sceneRadius.value;
        });
        return radius;
      })(),
    };
  }, { grid, displacementSubdivision, dispXml: DISPLACED_MTLX, plainXml: PLAIN_MTLX });
}

async function disposeStage(page) {
  await page.evaluate(() => { window.__sceneDisp.dispose(); delete window.__sceneDisp; });
}

test.describe('@scene displacement', () => {
  test('displaces the bound region and closes the material-boundary seam', async ({ page, embedURL }) => {
    await gotoScene(page, embedURL);
    const grid = buildGridPlane();
    const result = await loadStage(page, { grid });
    expect(result.planePositions.length).toBe(1);
    const positions = result.planePositions[0];
    const vertexCount = positions.length / 3;
    // Displaced-only interior vertex (column 0) moved by |0.1| along the
    // normal (the generated shader's own sign convention, not asserted
    // here); a non-displaced interior vertex (column 3) stayed at y=0.
    let dispInteriorY = null, plainInteriorY = null;
    for (let v = 0; v < vertexCount; v++) {
      const x = positions[v * 3], y = positions[v * 3 + 1];
      if (x === 0 && dispInteriorY === null) dispInteriorY = y;
      if (x === 4 && plainInteriorY === null) plainInteriorY = y;
    }
    expect(Math.abs(dispInteriorY)).toBeGreaterThan(0.08);
    expect(Math.abs(dispInteriorY)).toBeLessThan(0.12);
    expect(Math.abs(plainInteriorY)).toBeLessThan(1e-5);
    // Column-boundary (x=2) vertex pairs are geometrically coincident but
    // distinct vertex entries (one per quad); both must land at the same
    // (averaged) height so the seam between materials stays closed.
    const boundary = [];
    for (let v = 0; v < vertexCount; v++) {
      const x = positions[v * 3], z = positions[v * 3 + 2], y = positions[v * 3 + 1];
      if (x === 2) boundary.push({ z, y });
    }
    expect(boundary.length).toBeGreaterThanOrEqual(2);
    const byZ = new Map();
    boundary.forEach(({ z, y }) => { if (!byZ.has(z)) byZ.set(z, []); byZ.get(z).push(y); });
    for (const ys of byZ.values()) {
      if (ys.length < 2) continue;
      const spread = Math.max(...ys) - Math.min(...ys);
      expect(spread).toBeLessThan(1e-4);
    }
    await disposeStage(page);
  });

  test('point instances reference one displaced geometry', async ({ page, embedURL }) => {
    await gotoScene(page, embedURL);
    const grid = buildGridPlane();
    const result = await loadStage(page, { grid });
    expect(result.instancedCount).toBe(2);
    expect(result.instancedGeometrySame).toBe(true);
    for (const positions of result.instancedPositions) {
      for (let v = 0; v < positions.length / 3; v++) {
        expect(Math.abs(positions[v * 3 + 1])).toBeGreaterThan(0.08);
        expect(Math.abs(positions[v * 3 + 1])).toBeLessThan(0.12);
      }
    }
    await disposeStage(page);
  });

  test('numeric override subdivides 16x, follow keeps the authored count', async ({ page, embedURL }) => {
    await gotoScene(page, embedURL);
    const grid = buildGridPlane();
    const follow = await loadStage(page, { grid, displacementSubdivision: 'follow' });
    const total = follow.planeTriangles.reduce((a, b) => a + b, 0);
    expect(total).toBe(grid.totalTriCount);
    await disposeStage(page);
    const override2 = await loadStage(page, { grid, displacementSubdivision: 2 });
    const total2 = override2.planeTriangles.reduce((a, b) => a + b, 0);
    expect(total2).toBe(grid.totalTriCount * 16);
    await disposeStage(page);
  });

  test('toggling displacement off restores exact positions and updates stage bounds', async ({ page, embedURL }) => {
    await gotoScene(page, embedURL);
    const grid = buildGridPlane();
    await loadStage(page, { grid });
    // handle.scene includes the studio backdrop, which dwarfs this tiny
    // plane; measure only the loaded prims (handle.prims), like
    // rebuildGeometryDerivedState's own stageBox does via sceneRoot.
    const before = await page.evaluate(() => {
      const h = window.__sceneDisp;
      const box = new window.THREE.Box3();
      for (const prim of h.prims) box.expandByObject(prim);
      return box.getSize(new window.THREE.Vector3()).y;
    });
    const after = await page.evaluate(() => {
      window.setDisplacementEnabled(false);
      const h = window.__sceneDisp;
      let planeMesh = null;
      h.scene.traverse((o) => { if (o.isMesh && o.userData.primPath === '/Grid/Plane') planeMesh = o; });
      const positions = Array.from(planeMesh.geometry.getAttribute('position').array);
      const box = new window.THREE.Box3();
      for (const prim of h.prims) box.expandByObject(prim);
      const sizeY = box.getSize(new window.THREE.Vector3()).y;
      window.setDisplacementEnabled(true);
      return { positions, sizeY };
    });
    for (let v = 0; v < after.positions.length / 3; v++) {
      expect(Math.abs(after.positions[v * 3 + 1])).toBeLessThan(1e-5);
    }
    expect(after.sizeY).toBeLessThan(before);
    await disposeStage(page);
  });

  test('a forced displacement failure warns and leaves geometry undisplaced', async ({ page, embedURL }) => {
    await gotoScene(page, embedURL);
    const grid = buildGridPlane();
    await page.evaluate(() => { window.__mtlxForceDisplacementFailure = true; });
    const result = await loadStage(page, { grid });
    await page.evaluate(() => { delete window.__mtlxForceDisplacementFailure; });
    expect(result.warnings.some((w) => /[Dd]isplacement/.test(w))).toBe(true);
    const positions = result.planePositions[0];
    for (let v = 0; v < positions.length / 3; v++) {
      expect(Math.abs(positions[v * 3 + 1])).toBeLessThan(1e-5);
    }
    await disposeStage(page);
  });

  test('materialName disambiguates two materials sharing one surface node', async ({ page, embedURL }) => {
    await gotoScene(page, embedURL);
    // Without materialName, compileMtlxSceneMaterial resolves the same
    // displacement for both; with it, each material gets its own (both
    // measured through evaluateDisplacement).
    const engineResult = await page.evaluate(async ({ xml }) => {
      const env = await window.getMxEnv();
      const doc = env.mx.createDocument();
      await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
      if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
      const renderables = window.listDocRenderables(doc);
      const a = renderables.find((r) => r.name === 'SharedA');
      const b = renderables.find((r) => r.name === 'SharedB');
      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 64;
      const renderer = new window.THREE.WebGLRenderer({ canvas });
      const geometry = new window.THREE.BufferGeometry();
      geometry.setAttribute('position', new window.THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
      geometry.setAttribute('normal', new window.THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
      const magnitude = async (renderable, materialName) => {
        const compiled = await window.compileMtlxSceneMaterial({
          mx: env.mx, gen: env.gen, genContext: env.genContext, renderable,
          label: materialName || 'shared', materialName, isMounted: () => true,
        });
        const result = await window.evaluateDisplacement({
          renderer, displacement: compiled.displacement, geometry,
          worldMatrix: new window.THREE.Matrix4(), isAlive: () => true,
        });
        return Math.abs(result.offsets[2]);
      };
      const withoutA = await magnitude(a.node, undefined);
      const withoutB = await magnitude(b.node, undefined);
      const withA = await magnitude(a.node, 'SharedA');
      const withB = await magnitude(b.node, 'SharedB');
      renderer.dispose();
      return { withoutA, withoutB, withA, withB };
    }, { xml: SHARED_SURFACE_MTLX });
    // Without materialName, both resolve to the same (first-found) network.
    expect(Math.abs(engineResult.withoutA - engineResult.withoutB)).toBeLessThan(1e-4);
    // With materialName, each resolves its own 0.1 / 0.2 offset.
    expect(engineResult.withA).toBeGreaterThan(0.08);
    expect(engineResult.withA).toBeLessThan(0.12);
    expect(engineResult.withB).toBeGreaterThan(0.18);
    expect(engineResult.withB).toBeLessThan(0.22);

    // Scene level: the renderer always threads materialName through, so two
    // meshes bound to SharedA/SharedB each move by their own material's offset.
    const stageResult = await page.evaluate(async ({ xml }) => {
      const holder = document.createElement('div');
      holder.style.cssText = 'width:320px;height:180px;position:absolute;left:-1000px;';
      document.body.appendChild(holder);
      const stage = {
        meshes: [
          {
            primPath: '/Shared/A', positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], materialPath: '/Shared/MatA',
          },
          {
            primPath: '/Shared/B', positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
            normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]),
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], materialPath: '/Shared/MatB',
          },
        ],
        materials: [
          { path: '/Shared/MatA', sourceAsset: 'shared.mtlx', subIdentifier: 'SharedA', materialName: 'SharedA' },
          { path: '/Shared/MatB', sourceAsset: 'shared.mtlx', subIdentifier: 'SharedB', materialName: 'SharedB' },
        ],
        warnings: [],
      };
      const files = [{ path: 'shared.mtlx', data: new Blob([xml], { type: 'application/xml' }) }];
      const h = await window.createMtlxSceneView({ container: holder, stage, files, version: '1.39.5' });
      const readOffset = (primPath) => {
        let mesh = null;
        h.scene.traverse((o) => { if (o.isMesh && o.userData.primPath === primPath) mesh = o; });
        return Math.abs(mesh.geometry.getAttribute('position').array[2]);
      };
      const offsets = { a: readOffset('/Shared/A'), b: readOffset('/Shared/B') };
      h.dispose(); holder.remove();
      return offsets;
    }, { xml: SHARED_SURFACE_MTLX });
    expect(stageResult.a).toBeGreaterThan(0.08);
    expect(stageResult.a).toBeLessThan(0.12);
    expect(stageResult.b).toBeGreaterThan(0.18);
    expect(stageResult.b).toBeLessThan(0.22);
  });
});
