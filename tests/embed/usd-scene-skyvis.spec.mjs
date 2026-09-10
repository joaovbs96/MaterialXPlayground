import { test, expect } from './lib/test-base.mjs';

test('@scene sky visibility stores normal-aware moments and preserves a low-poly room under the triangle cap', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => typeof window.buildSkyVisibility === 'function' && window.THREE);
  const result = await page.evaluate(() => {
    const { Box3, BufferGeometry, Float32BufferAttribute, Matrix4, Vector3 } = window.THREE;
    const visibilityAtPage = (result, x, y, z) => {
      const [dx, dy] = result.dim;
      const offset = ((z * dy + y) * dx + x) * 4;
      const decode = (value) => (value - 128) / 127;
      const a = result.data[offset] / 255;
      const d = [decode(result.data[offset + 1]), decode(result.data[offset + 2]), decode(result.data[offset + 3])];
      return { a, d, up: Math.max(0, Math.min(1, a + d[1])), down: Math.max(0, Math.min(1, a - d[1])) };
    };
    const mesh = (positions, indices = null) => {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
      if (indices) geometry.setIndex(indices);
      return { geometry, matrixWorld: new Matrix4() };
    };
    const room = [
      // floor and ceiling
      mesh([-1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1], [0, 1, 2, 0, 2, 3]),
      mesh([-1, 1, -1, -1, 1, 1, 1, 1, 1, 1, 1, -1], [0, 1, 2, 0, 2, 3]),
      // x walls
      mesh([-1, -1, -1, -1, -1, 1, -1, 1, 1, -1, 1, -1], [0, 1, 2, 0, 2, 3]),
      mesh([1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1], [0, 1, 2, 0, 2, 3]),
      // z walls
      mesh([-1, -1, -1, -1, 1, -1, 1, 1, -1, 1, -1, -1], [0, 1, 2, 0, 2, 3]),
      mesh([-1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1], [0, 1, 2, 0, 2, 3]),
    ];
    const densePositions = [];
    for (let i = 0; i < 250; i++) {
      const x = 0.7 + (i % 10) * 0.001;
      const z = 0.7 + Math.floor(i / 10) * 0.001;
      densePositions.push(x, -0.9, z, x + 0.0005, -0.9, z, x, -0.8995, z);
    }
    const capped = window.buildSkyVisibility(
      room.concat(mesh(densePositions)),
      new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)),
      { resolution: 8, rays: 32, maxTriangles: 20 },
    );
    const center = 5;
    const centerValue = visibilityAtPage(capped, center, center, center);
    const exhausted = window.buildSkyVisibility(
      room.concat(mesh(densePositions)),
      new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)),
      { resolution: 8, rays: 8, maxTriangles: 4 },
    );

    const floor = mesh([-1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1], [0, 1, 2, 0, 2, 3]);
    const directional = window.buildSkyVisibility(
      [floor],
      new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)),
      { resolution: 8, rays: 64 },
    );
    const floorValue = visibilityAtPage(directional, center, center, center);
    const sparse = window.buildSkyVisibility(
      [mesh([0, 0, 0, 0.01, 0, 0, 0, 0.01, 0.01])],
      new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)),
      { resolution: 8, rays: 64 },
    );
    let open = null;
    for (let z = 0; z < sparse.dim[2] && !open; z++) {
      for (let y = 0; y < sparse.dim[1] && !open; y++) {
        for (let x = 0; x < sparse.dim[0]; x++) {
          const value = visibilityAtPage(sparse, x, y, z);
          if (value.a > 0.99) { open = value; break; }
        }
      }
    }
    return {
      capped: {
        triangles: capped.triangles,
        structuralTriangles: capped.structuralTriangles,
        subcellTriangles: capped.subcellTriangles,
        sampledTriangles: capped.sampledTriangles,
        stride: capped.stride,
        center: centerValue,
      },
      exhausted: {
        sampledTriangles: exhausted.sampledTriangles,
        structuralTriangles: exhausted.structuralTriangles,
        center: visibilityAtPage(exhausted, center, center, center),
      },
      directional: { center: floorValue, open },
    };
  });
  expect(result.capped.triangles).toBe(262);
  expect(result.capped.structuralTriangles).toBe(12);
  expect(result.capped.subcellTriangles).toBe(250);
  expect(result.capped.stride).toBeGreaterThan(1);
  expect(result.capped.sampledTriangles).toBeLessThan(result.capped.triangles);
  expect(result.capped.center.a).toBeLessThan(0.05);
  expect(result.exhausted.structuralTriangles).toBe(12);
  expect(result.exhausted.sampledTriangles).toBe(13);
  expect(result.exhausted.center.a).toBeLessThan(0.05);

  expect(result.directional.center.a).toBeGreaterThan(0.35);
  expect(result.directional.center.a).toBeLessThan(0.9);
  expect(result.directional.center.d[1]).toBeGreaterThan(0.2);
  expect(result.directional.center.up).toBeGreaterThan(0.8);
  expect(result.directional.center.down).toBeLessThan(0.6);
  expect(result.directional.open.a).toBeGreaterThan(0.99);
  expect(Math.abs(result.directional.open.d[0])).toBeLessThan(0.1);
  expect(Math.abs(result.directional.open.d[1])).toBeLessThan(0.1);
  expect(Math.abs(result.directional.open.d[2])).toBeLessThan(0.1);
});
