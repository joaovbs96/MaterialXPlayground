// @scene: stage payload coverage across composed layers (js/usd/usd-stage-worker.js).
// The native material payload only carries materials a mesh binds; materialPrims
// must still list the unbound ones, from the root and from referenced layers.
import { test, expect } from './lib/test-base.mjs';

const quad = (name, x, binding) => [
  `    def Mesh "${name}" (`,
  '        prepend apiSchemas = ["MaterialBindingAPI"]',
  '    ) {',
  '        int[] faceVertexCounts = [4]',
  '        int[] faceVertexIndices = [0, 1, 2, 3]',
  `        point3f[] points = [(${x - 0.4}, -0.4, 0), (${x + 0.4}, -0.4, 0), (${x + 0.4}, 0.4, 0), (${x - 0.4}, 0.4, 0)]`,
  `        rel material:binding = <${binding}>`,
  '    }',
];

const preview = (name, path) => [
  `        def Material "${name}" {`,
  `            token outputs:surface.connect = <${path}/PS.outputs:surface>`,
  '            def Shader "PS" {',
  '                uniform token info:id = "UsdPreviewSurface"',
  '                color3f inputs:diffuseColor = (0.5, 0.5, 0.5)',
  '                token outputs:surface',
  '            }',
  '        }',
];

const header = (defaultPrim, extra = []) => ['#usda 1.0', '(', `    defaultPrim = "${defaultPrim}"`, '    upAxis = "Y"', '    metersPerUnit = 1', ...extra, ')'];

const ROOT_USDA = [
  ...header('World', ['    subLayers = [@./layer.usda@]']),
  'def Xform "World" {',
  '    def Scope "Looks" {',
  ...preview('RootBound', '/World/Looks/RootBound'),
  ...preview('RootUnbound', '/World/Looks/RootUnbound'),
  '        def Material "FromMtlx" (',
  '            prepend references = @./mat.mtlx@</MaterialX/Materials/M_x>',
  '        ) {',
  '        }',
  '    }',
  ...quad('RootMesh', -2, '/World/Looks/RootBound'),
  ...quad('MtlxMesh', -1, '/World/Looks/FromMtlx'),
  '    def Xform "Asset" (',
  '        prepend references = @./asset.usda@',
  '    ) {',
  '    }',
  '}',
  '',
].join('\n');

const ASSET_USDA = [
  ...header('Asset'),
  'def Xform "Asset" {',
  '    def Scope "mtl" {',
  ...preview('RefBound', '/Asset/mtl/RefBound'),
  ...preview('RefUnbound', '/Asset/mtl/RefUnbound'),
  '    }',
  ...quad('RefMesh', 0, '/Asset/mtl/RefBound'),
  '    def Camera "RefCam" {',
  '        double3 xformOp:translate = (0, 0, 5)',
  '        uniform token[] xformOpOrder = ["xformOp:translate"]',
  '    }',
  '    def SphereLight "RefLight" {',
  '        float inputs:intensity = 2',
  '    }',
  '}',
  '',
].join('\n');

const LAYER_USDA = [
  ...header('World'),
  'over "World" {',
  '    def Scope "SubLooks" {',
  ...preview('SubUnbound', '/World/SubLooks/SubUnbound'),
  '    }',
  '}',
  '',
].join('\n');

const MAT_MTLX = [
  '<?xml version="1.0"?>',
  '<materialx version="1.39">',
  '  <standard_surface name="SR_x" type="surfaceshader" />',
  '  <surfacematerial name="M_x" type="material">',
  '    <input name="surfaceshader" type="surfaceshader" nodename="SR_x" />',
  '  </surfacematerial>',
  '</materialx>',
  '',
].join('\n');

test('@scene materialPrims lists unbound materials from every composed layer', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html');
  const result = await page.evaluate(async (layers) => {
    const files = Object.entries(layers).map(([path, text]) => ({ path, data: new TextEncoder().encode(text).buffer }));
    const { loadUsdStage } = await import(`${location.origin}/js/usd/index.js`);
    const stage = await loadUsdStage({ files, rootPath: 'root.usda' });
    return {
      materials: stage.materials.map((material) => material.path).sort(),
      materialPrims: (stage.materialPrims || []).map((prim) => prim.path).sort(),
      names: (stage.materialPrims || []).map((prim) => prim.name).sort(),
      cameras: stage.cameras.map((camera) => camera.primPath),
      lights: stage.lights.map((light) => light.primPath),
    };
  }, { 'root.usda': ROOT_USDA, 'asset.usda': ASSET_USDA, 'layer.usda': LAYER_USDA, 'mat.mtlx': MAT_MTLX });

  // Payload records: only the mesh-bound materials, whichever layer defines them.
  expect(result.materials).toEqual(['/World/Asset/mtl/RefBound', '/World/Looks/FromMtlx', '/World/Looks/RootBound']);
  expect(result.materialPrims).toEqual([
    '/World/Asset/mtl/RefBound', '/World/Asset/mtl/RefUnbound',
    '/World/Looks/FromMtlx', '/World/Looks/RootBound', '/World/Looks/RootUnbound',
    '/World/SubLooks/SubUnbound',
  ]);
  expect(result.names).toContain('RefUnbound');
  // Cameras and lights from a referenced layer are collected too.
  expect(result.cameras).toEqual(['/World/Asset/RefCam']);
  expect(result.lights).toEqual(['/World/Asset/RefLight']);
});
