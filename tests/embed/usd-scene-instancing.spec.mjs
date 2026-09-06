import { test, expect } from './lib/test-base.mjs';

test('@scene expands PointInstancer matrices with the parent transform', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html#!scene');
  await page.waitForFunction(() => typeof window.createMtlxSceneView === 'function');
  const result = await page.evaluate(async () => {
    const holder = document.createElement('div');
    holder.style.cssText = 'width:128px;height:128px;position:absolute;left:-1000px;';
    document.body.appendChild(holder);
    const stage = {
      meshes: [{
        primPath: '/Scene/Instances/__instances__/Prototype/Quad',
        instanceOwnerPath: '/Scene/Instances',
        positions: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
        indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
        matrix: [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 2, 4, 0, 1],
        instanceMatrices: [
          [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1],
          [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 1, 1],
        ],
      }],
      materials: [],
      warnings: [],
    };
    const view = await window.createMtlxSceneView({ container: holder, stage, isMounted: () => true });
    const objects = view.prims.map(object => ({
      path: object.userData.primPath,
      geometryPath: object.userData.geometryPath,
      index: object.userData.instanceIndex,
      matrix: Array.from(object.matrix.elements),
    }));
    const sharedGeometry = view.prims[0]?.geometry === view.prims[1]?.geometry;
    view.dispose();
    holder.remove();
    return { objects, sharedGeometry, warnings: view.warnings };
  });
  expect(result.warnings).toEqual([]);
  expect(result.sharedGeometry).toBe(true);
  expect(result.objects).toHaveLength(2);
  expect(result.objects.map(object => object.path)).toEqual(['/Scene/Instances', '/Scene/Instances']);
  expect(result.objects.map(object => object.geometryPath)).toEqual([
    '/Scene/Instances/__instances__/Prototype/Quad',
    '/Scene/Instances/__instances__/Prototype/Quad',
  ]);
  expect(result.objects.map(object => object.index)).toEqual([0, 1]);
  // Parent scale/translation is composed with each local instance translation:
  // (2,4,0) * (0,0,1) -> (2,4,1), and (3,0,1) -> (8,4,1).
  expect(result.objects.map(object => object.matrix.slice(12, 15))).toEqual([[2, 4, 1], [8, 4, 1]]);
});
