import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// Loads the vendored, patched EXRLoader.js (a browser global-script module,
// not an ES module) into a vm sandbox with a minimal THREE stub, the same
// pattern used by tests/unit/mesh-displacement.test.mjs for other vendored
// browser code.
function loadExrLoader() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'vendor', 'EXRLoader.js'), 'utf8');

  const FloatType = 'FloatType';
  const HalfFloatType = 'HalfFloatType';
  const RedFormat = 'RedFormat';
  const RGBAFormat = 'RGBAFormat';
  const LinearEncoding = 'LinearEncoding';
  const LinearFilter = 'LinearFilter';

  class DataTextureLoader {
    constructor() {}
  }

  const THREE = {
    DataTextureLoader,
    FloatType,
    HalfFloatType,
    RedFormat,
    RGBAFormat,
    LinearEncoding,
    LinearFilter,
    DataUtils: {
      toHalfFloat: (v) => v
    }
  };

  const sandbox = { THREE, fflate: {}, console, TextDecoder };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.THREE.EXRLoader;
}

const PIXEL_TYPE_FLOAT = 2;
const COMPRESSION_NO_COMPRESSION = 0;

// Round-trips through a 32-bit float, matching the precision loss the EXR
// scanline data (and the loader's Float32Array output) already impose.
function f32(value) {
  return Math.fround(value);
}

function writeCString(bytes, str) {
  for (const ch of str) bytes.push(ch.charCodeAt(0));
  bytes.push(0);
}

function writeUint32(bytes, value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  bytes.push(...buf);
}

function writeInt32(bytes, value) {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(value | 0, 0);
  bytes.push(...buf);
}

function writeFloat32(bytes, value) {
  const buf = Buffer.alloc(4);
  buf.writeFloatLE(value, 0);
  bytes.push(...buf);
}

function writeUint8(bytes, value) {
  bytes.push(value & 0xff);
}

function writeInt64Zero(bytes) {
  for (let i = 0; i < 8; i++) bytes.push(0);
}

// Builds a minimal, uncompressed single-part EXR buffer with the given
// channel list (in header/scanline order) and a per-channel, per-pixel value
// function. Mirrors exactly the layout js/vendor/EXRLoader.js's parseHeader,
// setupDecoder and uncompressRAW expect (see js/vendor/EXRLoader.js:1894,
// 1959, 1203).
function buildExr({ width, height, channels, valueAt }) {
  const bytes = [];

  // magic + version + spec byte + 2 reserved bytes, then header starts at byte 8.
  writeUint32(bytes, 20000630);
  writeUint8(bytes, 2); // version
  writeUint8(bytes, 0); // spec (no tiling/deep/multipart/longname)
  writeUint8(bytes, 0);
  writeUint8(bytes, 0);

  // "channels" chlist attribute.
  const chlistBytes = [];
  for (const ch of channels) {
    writeCString(chlistBytes, ch.name);
    writeInt32(chlistBytes, PIXEL_TYPE_FLOAT);
    writeUint8(chlistBytes, 0); // pLinear
    chlistBytes.push(0, 0, 0); // reserved
    writeInt32(chlistBytes, 1); // xSampling
    writeInt32(chlistBytes, 1); // ySampling
  }
  chlistBytes.push(0); // chlist terminator

  writeCString(bytes, 'channels');
  writeCString(bytes, 'chlist');
  writeUint32(bytes, chlistBytes.length);
  bytes.push(...chlistBytes);

  // "compression" attribute.
  writeCString(bytes, 'compression');
  writeCString(bytes, 'compression');
  writeUint32(bytes, 1);
  writeUint8(bytes, COMPRESSION_NO_COMPRESSION);

  // "dataWindow" attribute.
  const boxBytes = [];
  writeUint32(boxBytes, 0);
  writeUint32(boxBytes, 0);
  writeUint32(boxBytes, width - 1);
  writeUint32(boxBytes, height - 1);
  writeCString(bytes, 'dataWindow');
  writeCString(bytes, 'box2i');
  writeUint32(bytes, boxBytes.length);
  bytes.push(...boxBytes);

  // end of header.
  bytes.push(0);

  // scanline offset table (blockCount = height for NO_COMPRESSION, values unused by the loader).
  for (let i = 0; i < height; i++) writeInt64Zero(bytes);

  // scanline blocks: line number, data length, then raw channel-major pixel data.
  const bytesPerLine = width * 4 * channels.length;
  for (let y = 0; y < height; y++) {
    writeUint32(bytes, y);
    writeUint32(bytes, bytesPerLine);
    for (let c = 0; c < channels.length; c++) {
      for (let x = 0; x < width; x++) {
        writeFloat32(bytes, valueAt(c, x, y));
      }
    }
  }

  return new Uint8Array(bytes).buffer;
}

test('EXRLoader decodes a single-channel "A" float EXR without corrupting output offsets', () => {
  const EXRLoader = loadExrLoader();
  const width = 4;
  const height = 4;
  const valueAt = (c, x, y) => 0.1 * (y * width + x + 1); // distinct, always non-zero

  const buffer = buildExr({
    width,
    height,
    channels: [{ name: 'A' }],
    valueAt
  });

  const loader = new EXRLoader();
  loader.setDataType('FloatType');
  const result = loader.parse(buffer);

  assert.equal(result.width, width);
  assert.equal(result.height, height);
  assert.equal(result.data.length, width * height); // outputChannels === 1, no bounds spill

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // EXRLoader.parse() itself flips scanlines (row 0 stored last), matching
      // js/vendor/EXRLoader.js:2140's own (height-1-true_y) arithmetic.
      const outIndex = (height - 1 - y) * width + x;
      assert.equal(
        result.data[outIndex],
        f32(valueAt(0, x, y)),
        `texel (${x},${y}) should hold its authored value, not be corrupted by a hardcoded RGBA offset`
      );
      assert.notEqual(result.data[outIndex], 0);
    }
  }
});

test('EXRLoader still promotes a 3-channel RGB float EXR to RGBA with the fixed channel table', () => {
  const EXRLoader = loadExrLoader();
  const width = 2;
  const height = 2;
  // R, G, B distinct per channel and pixel; alpha is not authored (promoted, filled with 1).
  const valueAt = (c, x, y) => (c + 1) * 0.1 + 0.01 * (y * width + x);

  const buffer = buildExr({
    width,
    height,
    channels: [{ name: 'R' }, { name: 'G' }, { name: 'B' }],
    valueAt
  });

  const loader = new EXRLoader();
  loader.setDataType('FloatType');
  const result = loader.parse(buffer);

  assert.equal(result.data.length, width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const outIndex = (height - 1 - y) * (width * 4) + x * 4;
      assert.equal(result.data[outIndex + 0], f32(valueAt(0, x, y))); // R
      assert.equal(result.data[outIndex + 1], f32(valueAt(1, x, y))); // G
      assert.equal(result.data[outIndex + 2], f32(valueAt(2, x, y))); // B
      assert.equal(result.data[outIndex + 3], 1); // alpha fill, unaffected by the single-channel fix
    }
  }
});
