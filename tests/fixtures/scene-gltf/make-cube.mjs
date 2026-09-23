// tests/fixtures/scene-gltf/make-cube.mjs: regenerates cube.glb, a tiny
// hand-authored binary glTF used by tests/embed/scene-gltf.spec.mjs. One
// cube (24 verts, per-face normals, 36 indices) and one untextured
// pbrMetallicRoughness material (red baseColorFactor, metallic 0,
// roughness 0.5). No external tooling: run `node make-cube.mjs` from
// this directory (or anywhere, it resolves its own __dirname) to
// rewrite cube.glb byte-for-byte the same way every time.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Six faces, each as a bottom-left/bottom-right/top-right/top-left quad
// (CCW as seen from outside, along the face's own normal) so a plain
// [0,1,2, 0,2,3] triangle fan per face keeps front-face winding intact.
const HALF = 0.5;
const FACES = [
  { normal: [0, 0, 1], verts: [[-HALF, -HALF, HALF], [HALF, -HALF, HALF], [HALF, HALF, HALF], [-HALF, HALF, HALF]] },
  { normal: [0, 0, -1], verts: [[HALF, -HALF, -HALF], [-HALF, -HALF, -HALF], [-HALF, HALF, -HALF], [HALF, HALF, -HALF]] },
  { normal: [0, 1, 0], verts: [[-HALF, HALF, HALF], [HALF, HALF, HALF], [HALF, HALF, -HALF], [-HALF, HALF, -HALF]] },
  { normal: [0, -1, 0], verts: [[-HALF, -HALF, -HALF], [HALF, -HALF, -HALF], [HALF, -HALF, HALF], [-HALF, -HALF, HALF]] },
  { normal: [1, 0, 0], verts: [[HALF, -HALF, HALF], [HALF, -HALF, -HALF], [HALF, HALF, -HALF], [HALF, HALF, HALF]] },
  { normal: [-1, 0, 0], verts: [[-HALF, -HALF, -HALF], [-HALF, -HALF, HALF], [-HALF, HALF, HALF], [-HALF, HALF, -HALF]] },
];

const positions = [];
const normals = [];
const indices = [];
FACES.forEach((face, faceIndex) => {
  const base = faceIndex * 4;
  face.verts.forEach((v) => { positions.push(...v); normals.push(...face.normal); });
  indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
});

const posBuf = Buffer.alloc(positions.length * 4);
positions.forEach((v, i) => posBuf.writeFloatLE(v, i * 4));
const normBuf = Buffer.alloc(normals.length * 4);
normals.forEach((v, i) => normBuf.writeFloatLE(v, i * 4));
const idxBuf = Buffer.alloc(indices.length * 2);
indices.forEach((v, i) => idxBuf.writeUInt16LE(v, i * 2));

// All three views already land on 4-byte boundaries (288, 288, 72 bytes),
// so no inter-view padding is needed to satisfy glTF's alignment rule.
const binChunk = Buffer.concat([posBuf, normBuf, idxBuf]);
if (binChunk.length % 4 !== 0) throw new Error('make-cube: BIN chunk is not 4-byte aligned');

const posMin = [0, 1, 2].map((axis) => Math.min(...positions.filter((_, i) => i % 3 === axis)));
const posMax = [0, 1, 2].map((axis) => Math.max(...positions.filter((_, i) => i % 3 === axis)));

const json = {
  asset: { version: '2.0', generator: 'mxpt make-cube.mjs' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'Cube' }],
  meshes: [{
    name: 'Cube',
    primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }],
  }],
  materials: [{
    name: 'RedMatte',
    pbrMetallicRoughness: { baseColorFactor: [0.8, 0.1, 0.1, 1.0], metallicFactor: 0, roughnessFactor: 0.5 },
  }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: posMin, max: posMax },
    { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
    { bufferView: 2, componentType: 5123, count: indices.length, type: 'SCALAR' },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 },
    { buffer: 0, byteOffset: posBuf.length, byteLength: normBuf.length, target: 34962 },
    { buffer: 0, byteOffset: posBuf.length + normBuf.length, byteLength: idxBuf.length, target: 34963 },
  ],
  buffers: [{ byteLength: binChunk.length }],
};

// JSON chunk padded with trailing spaces (0x20) to a 4-byte boundary,
// per the GLB container spec; BIN chunk padded with zero bytes.
let jsonText = JSON.stringify(json);
while (jsonText.length % 4 !== 0) jsonText += ' ';
const jsonBuf = Buffer.from(jsonText, 'utf8');
const jsonChunk = Buffer.concat([
  u32le(jsonBuf.length), Buffer.from('JSON', 'ascii'), jsonBuf,
]);
const binChunkFull = Buffer.concat([
  u32le(binChunk.length), Buffer.from('BIN\0', 'ascii'), binChunk,
]);

const totalLength = 12 + jsonChunk.length + binChunkFull.length;
const header = Buffer.concat([
  Buffer.from('glTF', 'ascii'), u32le(2), u32le(totalLength),
]);

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
}

const glb = Buffer.concat([header, jsonChunk, binChunkFull]);
fs.writeFileSync(path.join(__dirname, 'cube.glb'), glb);
console.log('wrote cube.glb:', glb.length, 'bytes');
