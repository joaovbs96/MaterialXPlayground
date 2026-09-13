/* CPU regression checks for environment key extraction and storage fallback.
 * node tests/raster/environment-split-regressions.cjs
 * These checks do not replace renderer/GPU validation. */
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const sourcePath = path.join(root, 'js/mtlx-engine.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const THREE = require(path.join(root, 'vendor/three/three.min.js'));
const start = source.indexOf('const _f32');
const end = source.indexOf('// Cheaper direction-only estimate');
assert(start >= 0 && end > start, 'pinned environment extraction helpers unavailable');
const context = { THREE, console, Float32Array, Uint16Array, Math, Number, Array };
vm.runInNewContext(`${source.slice(start, end)}
this.extract = extractKeyLight;
this.floatToHalf = floatToHalf;
this.halfToFloat = halfToFloat;`, context);

const width = 256;
const height = 128;
const hotspotRow = 64;

function texture(kind, mode = 'valid') {
  const data = kind === 'half' ? new Uint16Array(width * height * 4) : new Float32Array(width * height * 4);
  const write = (index, value) => { data[index] = kind === 'half' ? context.floatToHalf(value) : value; };
  const background = [100.123, 80.37, 60.77];
  const hotspot = [10000.3, 7000.7, 3000.2];
  for (let i = 0; i < width * height; i++) {
    write(i * 4, background[0]); write(i * 4 + 1, background[1]); write(i * 4 + 2, background[2]); write(i * 4 + 3, 1);
  }
  if (mode === 'valid') for (const x of [0, width - 1]) for (let c = 0; c < 3; c++) write((hotspotRow * width + x) * 4 + c, hotspot[c]);
  if (mode === 'invalid') write((hotspotRow * width + 2) * 4, NaN);
  if (mode === 'annulus') for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) write((hotspotRow * width + x) * 4 + c, 100);
  return { image: { width, height, data }, flipY: false };
}

function digest(data) {
  return crypto.createHash('sha256').update(Buffer.from(data.buffer)).digest('hex');
}

function integral(tex) {
  const sum = [0, 0, 0];
  const data = tex.image.data;
  const half = data instanceof Uint16Array;
  for (let y = 0; y < height; y++) {
    const solidAngle = Math.sin(Math.PI * (y + .5) / height) * (2 * Math.PI / width) * (Math.PI / height);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) sum[c] += (half ? context.halfToFloat(data[i + c]) : data[i + c]) * solidAngle;
    }
  }
  return sum;
}

function runValid(kind) {
  const tex = texture(kind);
  const beforeHash = digest(tex.image.data);
  const beforeIntegral = integral(tex);
  const key = context.extract(tex);
  const afterHash = digest(tex.image.data);
  const afterIntegral = integral(tex);
  assert(key, `${kind}: expected key extraction`);
  const keyRgb = key.color.map(value => value * key.intensity);
  const residuals = afterIntegral.map((value, i) => value + keyRgb[i] - beforeIntegral[i]);
  const tolerances = beforeIntegral.map(value => 1e-6 * Math.max(1, Math.abs(value)));
  assert(residuals.every((value, i) => Math.abs(value) <= tolerances[i]), `${kind}: energy integral mismatch ${residuals}`);
  return { returned: true, beforeHash, afterHash, changed: beforeHash !== afterHash, beforeIntegral, afterIntegral, keyRgb, residuals, tolerances, direction: key.direction.toArray() };
}

function runNull(mode) {
  const tex = texture('float', mode);
  const beforeHash = digest(tex.image.data);
  const key = context.extract(tex);
  const afterHash = digest(tex.image.data);
  assert.equal(key, null, `${mode}: expected extraction fallback`);
  assert.equal(afterHash, beforeHash, `${mode}: fallback must preserve texture bytes`);
  return { returned: false, byteIdentical: true, beforeHash, afterHash };
}

const floatCase = runValid('float');
const halfCase = runValid('half');
const directionDot = floatCase.direction.reduce((sum, value, i) => sum + value * halfCase.direction[i], 0);
assert(directionDot > 0.999, `float/half direction mismatch: ${directionDot}`);
const energyRatio = halfCase.keyRgb.map((value, i) => value / floatCase.keyRgb[i]);
assert(energyRatio.every(value => Math.abs(value - 1) < 0.02), `float/half energy mismatch: ${energyRatio}`);
const invalidCase = runNull('invalid');
const annulusCase = runNull('annulus');

console.log(JSON.stringify({
  status: 'passed',
  source: path.relative(root, sourcePath),
  sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
  size: [width, height],
  float: floatCase,
  half: halfCase,
  invalid: invalidCase,
  insufficientAnnulus: annulusCase,
  directionDot,
  energyRatio,
}, null, 2));
