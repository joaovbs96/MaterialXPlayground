import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'js/mtlx-engine.js'), 'utf8');

test('displacement normals default to mesh until the analytic path is verified', () => {
  const start = source.indexOf('let DISPLACEMENT_NORMALS_MODE = (() => {');
  const end = source.indexOf('const getDisplacementNormalsMode', start);
  const block = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  // Both the settings-store-miss fallback (`|| 'mesh'`) and the catch
  // fallback (`return 'mesh';`) must resolve to 'mesh', not 'analytic', so
  // a fresh session never silently renders the unverified analytic terracing.
  assert.match(block, /window\.MtlxRenderSettings\.get\('displacementNormals'.*\)\s*\|\|\s*'mesh'/, 'the store-miss fallback must be mesh');
  assert.match(block, /catch \(e\) \{ return 'mesh'; \}/, 'the catch fallback must be mesh');
});

test('the analytic displacement-normal readback requires a float render target and fails soft', () => {
  const start = source.indexOf('const evaluateDisplacement = async');
  const end = source.indexOf('\n// ------------------------------------------------------------------\n// tryRefreshRenderView', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  assert.match(body, /floatReadbackAvailable\s*=\s*!!\(gl\.getExtension/, 'must probe for float render-target support');
  assert.match(body, /EXT_color_buffer_float/);
  assert.match(body, /if \(wantAnalytic && !floatReadbackAvailable\)\s*{\s*\n\s*wantAnalytic = false;/, 'must fail soft to the mesh path when float readback is unavailable');
  assert.match(body, /readbackFormat = wantAnalytic \? 'rgba32f' : 'rgba8'/);
  assert.match(body, /type: readbackFormat === 'rgba32f' \? THREE\.FloatType : THREE\.UnsignedByteType/);
  // The diagnostic must be reported on the evaluator's result so callers
  // (and evaluatorCalls forwarding) can tell which precision was used.
  assert.match(body, /return \{ offsets, offsetsTangent, offsetsBitangent, analyticFrame, mode, notices, readbackFormat, perf \};/);
});
