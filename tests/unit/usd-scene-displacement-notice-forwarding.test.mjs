import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Regression for egg_geode: a material whose displacement network fails to
// generate (bad geomprop wiring in the USD inline extraction, a shader-gen
// exception, a missing splice anchor, ...) reports the reason on
// compiled.notices (see generateDisplacementSourcesUnlocked/
// generatePreviewSourcesUnlocked in js/mtlx-engine.js). ensureCompiledMaterial
// in js/usd-scene-renderer.js used to read compiled.samplerBudget,
// compiled.samplerOverBudget and compiled.fragmentUniformOverBudget onto
// `warnings`, but never compiled.notices itself for the PRIMARY material
// compile (only for the separate light-transport "transmittance" variant),
// so a displacement compile failure left displacementStatus.evaluatorCalls
// empty with zero trace anywhere in the scene's warnings or console.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'js/usd-scene-renderer.js'), 'utf8');

const start = source.indexOf('compiled = await window.compileMtlxSceneMaterial({');
const end = source.indexOf('let transferCompiled = transferCompiledByPath.get(cacheKey);', start);

test('the primary material compile is present and precedes the transfer-variant compile', () => {
  assert.ok(start >= 0, 'compileMtlxSceneMaterial call for the primary material is present');
  assert.ok(end > start, 'transfer-variant compile follows the primary compile');
});

test('ensureCompiledMaterial forwards compiled.notices onto warnings for the primary material', () => {
  const region = source.slice(start, end);
  // Must iterate compiled.notices (not just samplerBudget/fragmentUniform
  // fields, which are separate structured warnings) and push onto `warnings`.
  assert.match(region, /for \(const notice of compiled\.notices \|\| \[\]\)/,
    'primary compile notices (e.g. a failed displacement generation) must be forwarded, not silently dropped');
  assert.match(region, /warnings\.push\(text\)/);
});

test('the transfer-variant compile already forwards its own notices (existing behavior, unchanged)', () => {
  const transferRegion = source.slice(end, source.indexOf('transferCompiledByPath.set(cacheKey, transferCompiled);', end));
  assert.match(transferRegion, /transferSrcs\.notices/);
});
