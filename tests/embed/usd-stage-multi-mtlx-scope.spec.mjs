// @scene: one Scope referencing several .mtlx files (one per material) must
// give each material its own MaterialX source, not the first reference.
import { test, expect } from './lib/test-base.mjs';

const mtlx = (name) => [
  '<?xml version="1.0"?>',
  '<materialx version="1.38">',
  `  <open_pbr_surface name="SR_${name}" type="surfaceshader" />`,
  `  <surfacematerial name="MAT_${name}" type="material">`,
  `    <input name="surfaceshader" type="surfaceshader" nodename="SR_${name}" />`,
  '  </surfacematerial>',
  '</materialx>',
  '',
].join('\n');

const quad = (name, x) => [
  `    def Mesh "${name}" (`,
  '        prepend apiSchemas = ["MaterialBindingAPI"]',
  '    )',
  '    {',
  '        int[] faceVertexCounts = [4]',
  '        int[] faceVertexIndices = [0, 1, 2, 3]',
  `        point3f[] points = [(${x - 0.4}, -0.4, 0), (${x + 0.4}, -0.4, 0), (${x + 0.4}, 0.4, 0), (${x - 0.4}, 0.4, 0)]`,
  `        rel material:binding = </World/Materials/MAT_${name}>`,
  '    }',
];

const ROOT_USDA = [
  '#usda 1.0',
  '(',
  '    defaultPrim = "World"',
  '    upAxis = "Y"',
  ')',
  '',
  'def Xform "World"',
  '{',
  '    def Scope "Materials" (',
  '        prepend references = [',
  '            @./a/material.mtlx@</MaterialX/Materials>,',
  '            @./b/material.mtlx@</MaterialX/Materials>',
  '        ]',
  '    )',
  '    {',
  '    }',
  ...quad('a', -0.5),
  ...quad('b', 0.5),
  '}',
  '',
].join('\n');

test('@scene a Scope with several mtlx references resolves each material to its own file', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html');
  const result = await page.evaluate(async ({ rootText, a, b }) => {
    const enc = (s) => new TextEncoder().encode(s).buffer;
    const files = [
      { path: 'root.usda', data: enc(rootText) },
      { path: 'a/material.mtlx', data: enc(a) },
      { path: 'b/material.mtlx', data: enc(b) },
    ];
    const { loadUsdStage } = await import(`${location.origin}/js/usd/index.js`);
    const stage = await loadUsdStage({ files, rootPath: 'root.usda' });
    return Object.fromEntries(stage.materials.map((m) => [m.path, m.sourceAsset]));
  }, { rootText: ROOT_USDA, a: mtlx('a'), b: mtlx('b') });

  expect(result['/World/Materials/MAT_a']).toMatch(/a\/material\.mtlx$/);
  expect(result['/World/Materials/MAT_b']).toMatch(/b\/material\.mtlx$/);
});
