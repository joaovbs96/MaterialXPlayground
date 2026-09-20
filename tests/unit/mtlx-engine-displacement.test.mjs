import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'js/mtlx-engine.js'), 'utf8');

const displacementStart = source.indexOf('const generateDisplacementSourcesUnlocked =');
const displacementEnd = source.indexOf('\n// Public entry point:', displacementStart);
const displacementSource = source.slice(displacementStart, displacementEnd);

test('standalone displacement generation inherits surface safety and sampler semantics', () => {
  assert.ok(displacementStart >= 0 && displacementEnd > displacementStart);
  assert.match(displacementSource, /patchMaterialPowerNodes\(fs, powerNodeNames\)/);
  assert.match(displacementSource, /patchGeompropVaryings\(vs, fs\)/);
  assert.match(displacementSource, /annotateFilenameSamplerModes\(introspected, document\)/);
  assert.match(displacementSource, /materialGeompropDefaults\(document\)/);
  assert.match(displacementSource, /samplerModes: u\.samplerModes \|\| null/);
});

test('preview displacement preserves geomprops and cancels stale evaluations', () => {
  assert.match(source, /geomprops = Object\.keys\(nonIndexed\.attributes\)/);
  assert.match(source, /for \(const stream of welded\.geomprops \|\| \[\]\)/);
  assert.match(source, /bindDisplacementGeomprops\(\);\s*const token = \+\+dispToken/);
  assert.match(source, /cancelDisplacementRun\(\);\s*if \(dispState !== 'off'\)/);
  assert.match(source, /dispToken\+\+;\s*dispRunInFlight = false;[\s\S]{0,140}dispSettleResolve\(\)/);
});

test('scene compile identity includes selected displacement', () => {
  assert.match(source, /\/\* displacement \*\/\\\\n' \+ \(srcs\.displacement \? srcs\.displacement\.key : ''\)/);
});

test('preview triangle budget skips an oversized authored base mesh', () => {
  const start = source.indexOf('const PREVIEW_TRIANGLE_BUDGET =');
  const end = source.indexOf('\n// LRU (3 entries)', start);
  const context = {};
  vm.runInNewContext(source.slice(start, end) + '\nthis.pick = pickSubdivisionLevel;', context);
  const oversized = context.pick(2_000_000, 0, 1_500_000);
  assert.equal(oversized.level, 0);
  assert.equal(oversized.allowed, false);
  assert.equal(oversized.capped, true);
  const bounded = context.pick(1000, 3, 20_000);
  assert.deepEqual(JSON.parse(JSON.stringify(bounded)), { level: 2, capped: true, triangles: 16000, allowed: true });
});