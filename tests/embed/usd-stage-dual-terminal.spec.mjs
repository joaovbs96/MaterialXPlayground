// @scene: a Material in a binary layer that publishes both a MaterialX network
// (outputs:mtlx:surface) and a UsdPreviewSurface (outputs:surface), as Houdini
// exports do. The native payload types it UsdPreviewSurface but still carries
// the MaterialX network, which must win over the flattened preview conversion.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from './lib/test-base.mjs';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'usd');

const quad = (name, x, binding) => [
  `    def Mesh "${name}" (`,
  '        prepend apiSchemas = ["MaterialBindingAPI"]',
  '    )',
  '    {',
  '        int[] faceVertexCounts = [4]',
  '        int[] faceVertexIndices = [0, 1, 2, 3]',
  `        point3f[] points = [(${x - 0.4}, -0.4, 0), (${x + 0.4}, -0.4, 0), (${x + 0.4}, 0.4, 0), (${x - 0.4}, 0.4, 0)]`,
  `        rel material:binding = <${binding}>`,
  '    }',
];

const ROOT_USDA = [
  '#usda 1.0',
  '(',
  '    defaultPrim = "World"',
  '    metersPerUnit = 1',
  '    upAxis = "Y"',
  ')',
  '',
  'def Xform "World"',
  '{',
  '    def Scope "mtl" (',
  '        prepend references = @./looks/dual-terminal-looks.usdc@</Looks>',
  '    )',
  '    {',
  '    }',
  ...quad('DualMesh', -0.5, '/World/mtl/Dual'),
  ...quad('PreviewMesh', 0.5, '/World/mtl/PreviewOnly'),
  '}',
  '',
].join('\n');

test('@scene a binary Material with both terminals keeps its MaterialX network', async ({ page, embedURL }) => {
  await page.goto(embedURL + '/index.html');
  const crate = fs.readFileSync(path.join(FIXTURE_DIR, 'dual-terminal-looks.usdc')).toString('base64');
  const result = await page.evaluate(async ({ rootText, crate }) => {
    const bytes = Uint8Array.from(atob(crate), (c) => c.charCodeAt(0));
    const files = [
      { path: 'root.usda', data: new TextEncoder().encode(rootText).buffer },
      { path: 'looks/dual-terminal-looks.usdc', data: bytes.buffer },
    ];
    const { loadUsdStage } = await import(`${location.origin}/js/usd/index.js`);
    const stage = await loadUsdStage({ files, rootPath: 'root.usda' });
    const decode = (data) => new TextDecoder().decode(new Uint8Array(data.buffer || data));
    const docOf = (record) => {
      const asset = (stage.assets || []).find((entry) => entry.path === record.sourceAsset);
      return asset ? decode(asset.data) : '';
    };
    const byPath = Object.fromEntries(stage.materials.map((record) => [record.path, {
      shaderId: record.shaderId, sourceAsset: record.sourceAsset, xml: docOf(record),
    }]));
    return {
      bindings: stage.meshes.map((mesh) => mesh.materialPath).sort(),
      dual: byPath['/World/mtl/Dual'],
      preview: byPath['/World/mtl/PreviewOnly'],
      warnings: stage.warnings,
    };
  }, { rootText: ROOT_USDA, crate });

  expect(result.bindings).toEqual(['/World/mtl/Dual', '/World/mtl/PreviewOnly']);
  // The native payload's own inline MaterialX, not a UsdPreviewSurface document.
  expect(result.dual.sourceAsset).toMatch(/^__inline_/);
  expect(result.dual.xml).toMatch(/<standard_surface\b/);
  expect(result.dual.xml).toMatch(/name="base_color"[^>]*value="0\.8/);
  expect(result.dual.xml).not.toMatch(/<UsdPreviewSurface\b/);
  expect(result.warnings.join('\n')).not.toContain('/World/mtl/Dual: UsdPreviewSurface converted');
  // A preview-only Material in a binary layer still gets the flattened conversion.
  expect(result.preview.sourceAsset).toMatch(/^__usdpreview_/);
  expect(result.preview.xml).toMatch(/<UsdPreviewSurface\b/);
  expect(result.preview.xml).toMatch(/name="diffuseColor"[^>]*value="0\.1, 0\.1, 0\.8/);
});
