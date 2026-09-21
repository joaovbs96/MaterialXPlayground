import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'js/mtlx-engine.js'), 'utf8');

test('displacement normals default to mesh until the analytic path is verified', () => {
  const start = source.indexOf('let DISPLACEMENT_NORMALS_MODE = (() => {');
  const end = source.indexOf('const getDisplacementNormalsMode', start);
  const block = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  // Both the query/localStorage-miss fallback and the catch fallback must
  // resolve to 'mesh', not 'analytic', so a fresh session never silently
  // renders the unverified analytic terracing.
  const returns = [...block.matchAll(/return\s+'(analytic|mesh)';/g)].map((m) => m[1]);
  assert.deepEqual(returns, ['mesh', 'mesh'], 'both the default and error fallback must be mesh');
});

test('the analytic displacement-normal readback requires a float render target and fails soft', () => {
  const start = source.indexOf('const evaluateDisplacement = async');
  const end = source.indexOf('\n// ------------------------------------------------------------------\n// tryRefreshRenderView', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);

  assert.match(body, /floatReadbackAvailable\s*=\s*!!\(gl\.getExtension/, 'must probe for float render-target support');
  assert.match(body, /EXT_color_buffer_float/);
  assert.match(body, /if \(wantAnalytic && !floatReadbackAvailable\)\s*{\s*\n\s*wantAnalytic = false;/, 'must fail soft to the mesh path when float readback is unavailable');
  // The float target is preferred whenever it is available at all, not only
  // for the analytic-normal path, so a single raw-vec3 draw replaces the
  // three legacy bit-packed draws whenever the GPU supports it.
  assert.match(body, /readbackFormat = floatReadbackAvailable \? 'rgba32f' : 'rgba8'/);
  assert.match(body, /type: readbackFormat === 'rgba32f' \? THREE\.FloatType : THREE\.UnsignedByteType/);
  assert.match(body, /const rawPack = readbackFormat === 'rgba32f';/);
  assert.match(body, /uniforms\.u_dispPackMode = \{ value: rawPack \? 1 : 0 \};/);
  // The diagnostic must be reported on the evaluator's result so callers
  // (and evaluatorCalls forwarding) can tell which precision was used.
  assert.match(body, /return \{ offsets, offsetsTangent, offsetsBitangent, analyticFrame, mode, notices, readbackFormat \};/);
});

test('displacement readback decodes are pure helpers usable without WebGL', () => {
  const legacyStart = source.indexOf('const decodeLegacyDisplacementComponent =');
  const legacyEnd = source.indexOf('\n};', legacyStart) + 3;
  const rawStart = source.indexOf('const decodeRawDisplacementVec3 =');
  const rawEnd = source.indexOf('\n};', rawStart) + 3;
  assert.ok(legacyStart >= 0 && legacyEnd > legacyStart);
  assert.ok(rawStart >= 0 && rawEnd > rawStart);
  const context = {};
  vm.runInNewContext(
    source.slice(legacyStart, legacyEnd) + '\n' + source.slice(rawStart, rawEnd)
      + '\nthis.decodeLegacyDisplacementComponent = decodeLegacyDisplacementComponent;'
      + '\nthis.decodeRawDisplacementVec3 = decodeRawDisplacementVec3;',
    context
  );

  // Legacy: one component per call, little-endian float32 packed into bytes.
  const value = 0.15;
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  const bytes = new Uint8Array(buf);
  const pixels = new Uint8Array([bytes[0], bytes[1], bytes[2], bytes[3]]);
  const passOffsets = new Float32Array(3);
  const byteView = new DataView(new ArrayBuffer(4));
  context.decodeLegacyDisplacementComponent(pixels, 1, 1, passOffsets, byteView);
  assert.ok(Math.abs(passOffsets[1] - value) < 1e-6);
  assert.equal(passOffsets[0], 0);
  assert.equal(passOffsets[2], 0);

  // Raw: one draw's RGBA32F readback carries all three components directly.
  const rawPixels = new Float32Array([1.5, -2.25, 0.5, 1]);
  const rawOffsets = new Float32Array(3);
  context.decodeRawDisplacementVec3(rawPixels, 1, rawOffsets);
  assert.deepEqual(Array.from(rawOffsets), [1.5, -2.25, 0.5]);
});
