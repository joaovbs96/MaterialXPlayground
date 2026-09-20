import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Regression for the Scene's own multi-part displacement compositor
// (displaceRecordParts in js/usd-scene-renderer.js): before this change it
// had a SEPARATE call to MtlxMeshDisplacement.computeDisplacedAttributes
// than js/mtlx-engine.js's buildDisplacedGeometry, and never forwarded the
// offsetsTangent/offsetsBitangent/analyticFrame fields that
// evaluateDisplacement already returns per part, so the USD Scene view
// (#!scene) always fell back to triangle-averaged mesh normals regardless
// of getDisplacementNormalsMode(). See
// scratchpad/displacement-verified/uv-diagnosis/normals-analytic/implementation.md.
//
// This is a source-text assertion (like
// usd-scene-displacement-notice-forwarding.test.mjs) rather than a call
// into the function directly: displaceRecordParts is not a pure function
// (it drives THREE geometries, materials and window.evaluateDisplacement),
// so real behavioral coverage lives in
// tests/embed/usd-scene-displacement.spec.mjs's Playwright suite.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'js/usd-scene-renderer.js'), 'utf8');

const start = source.indexOf('const displaceRecordParts = async (record, parts, worldMatrix) => {');
const end = source.indexOf('// A stage dome seeds rotation and exposure', start);

test('displaceRecordParts is present and bounded', () => {
  assert.ok(start >= 0, 'displaceRecordParts is present');
  assert.ok(end > start, 'the next top-level section follows it');
});

test('displaceRecordParts aggregates offsetsTangent/offsetsBitangent/analyticFrame across parts', () => {
  const region = source.slice(start, end);
  assert.match(region, /result\.offsetsTangent\s*&&\s*result\.offsetsBitangent\s*&&\s*result\.analyticFrame/,
    'must gate the aggregate on every compatible range actually carrying analytic data');
  assert.match(region, /offsetsTangentAll\[gv \* 3\]\s*=\s*result\.offsetsTangent\[v \* 3\]/,
    'must copy each part\'s tangent-offset samples into the aggregate at the global vertex index');
  assert.match(region, /frameEpsAll\[gv\]\s*=\s*result\.analyticFrame\.eps\[v\]/,
    'must copy the analytic frame epsilon alongside tangent/bitangent');
});

test('displaceRecordParts forwards the aggregated fields and the live normals mode into computeDisplacedAttributes', () => {
  const region = source.slice(start, end);
  const callStart = region.indexOf('window.MtlxMeshDisplacement.computeDisplacedAttributes({');
  assert.ok(callStart >= 0, 'the compositor call is present');
  const callRegion = region.slice(callStart, region.indexOf('});', callStart));
  assert.match(callRegion, /offsetsTangent:\s*offsetsTangentAll/);
  assert.match(callRegion, /offsetsBitangent:\s*offsetsBitangentAll/);
  assert.match(callRegion, /analyticFrame:\s*wantAnalyticAgg\s*\?/);
  assert.match(callRegion, /displacementNormals:\s*window\.getDisplacementNormalsMode/,
    'must read the live displacement-normals setting, not hardcode a mode');
});

test('displaceRecordParts records normalsMode/analyticFallbacks onto warnings, which captures already forward', () => {
  const region = source.slice(start, end);
  assert.match(region, /computed\.stats\.normalsMode/);
  assert.match(region, /computed\.stats\.analyticFallbacks/);
  assert.match(region, /warnings\.push\(nextNotice\)/,
    'the diagnostic line must land on the shared warnings array the capture JSON already reads');
});
