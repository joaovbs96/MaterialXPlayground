import { test, expect } from './lib/test-base.mjs';

// Inline USDA text so this spec has no fixture-file dependency; it is the
// tracked equivalent of the local-only usd-stage-subdivision.spec.mjs.
const CUBE_USDA = `#usda 1.0
(
    defaultPrim = "Scene"
    upAxis = "Y"
    metersPerUnit = 1
)

def Xform "Scene" {
    def Mesh "Cube" {
        uniform token subdivisionScheme = "catmullClark"
        int[] faceVertexCounts = [4, 4, 4, 4, 4, 4]
        int[] faceVertexIndices = [
            0, 1, 2, 3,
            1, 5, 6, 2,
            5, 4, 7, 6,
            4, 0, 3, 7,
            3, 2, 6, 7,
            4, 5, 1, 0
        ]
        point3f[] points = [
            (-0.5, -0.5, 0.5),
            ( 0.5, -0.5, 0.5),
            ( 0.5,  0.5, 0.5),
            (-0.5,  0.5, 0.5),
            (-0.5, -0.5, -0.5),
            ( 0.5, -0.5, -0.5),
            ( 0.5,  0.5, -0.5),
            (-0.5,  0.5, -0.5)
        ]
        texCoord2f[] primvars:st = [
            (0,0), (1,0), (1,1), (0,1),
            (0,0), (1,0), (1,1), (0,1),
            (0,0), (1,0), (1,1), (0,1),
            (0,0), (1,0), (1,1), (0,1),
            (0,0), (1,0), (1,1), (0,1),
            (0,0), (1,0), (1,1), (0,1)
        ] (
            interpolation = "faceVarying"
        )
    }
}
`;

async function loadCube(page, subdivisionLevel) {
  return page.evaluate(async ({ usda, subdivisionLevel }) => {
    const bytes = new TextEncoder().encode(usda);
    const files = [{ path: 'cube.usda', data: bytes.buffer }];
    const { loadUsdStage } = await import(`${location.origin}/js/usd/index.js`);
    const stage = await loadUsdStage({ files, rootPath: 'cube.usda', subdivisionLevel });
    const mesh = stage.meshes[0];
    return {
      subdivisionScheme: mesh.subdivisionScheme,
      subdivisionLevelsApplied: mesh.subdivisionLevelsApplied ?? null,
      indexCount: mesh.indices?.length ?? null,
      cage: mesh.cage ? {
        positions: Array.from(mesh.cage.positions ?? []),
        // Pre-subdivision streams are per-corner (unindexed), so triangle
        // count comes from the corner count, like subdivideMesh computes it.
        cornerCount: (mesh.cage.indices?.length) ?? ((mesh.cage.positions?.length ?? 0) / 3),
      } : null,
    };
  }, { usda: CUBE_USDA, subdivisionLevel });
}

function distinctPositionCount(positions) {
  const seen = new Set();
  for (let i = 0; i + 2 < positions.length; i += 3) {
    seen.add(`${positions[i].toFixed(4)}|${positions[i + 1].toFixed(4)}|${positions[i + 2].toFixed(4)}`);
  }
  return seen.size;
}

test('@scene subdivided catmullClark mesh reports scheme, levels and a cage', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html');

  const level1 = await loadCube(page, 1);
  expect(level1.subdivisionScheme).toBe('catmullClark');
  expect(level1.subdivisionLevelsApplied).toBe(1);
  expect(level1.cage).toBeTruthy();
  expect(distinctPositionCount(level1.cage.positions)).toBe(8);
  expect(level1.cage.cornerCount / 3).toBe(12); // 6 quads * 2 tris, unsubdivided cube
});

test('@scene unsubdivided mesh (level 0) reports no cage', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html');

  const level0 = await loadCube(page, 0);
  expect(level0.subdivisionScheme).toBe('catmullClark');
  expect(level0.subdivisionLevelsApplied).toBeNull();
  expect(level0.cage).toBeNull();
});
