import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'js/mtlx-engine.js'), 'utf8');

// Isolate patchGeompropVaryings (and its INT_GEOMPROP_TYPES helper) without
// pulling in the rest of the engine. mtlxWarn is stubbed since it is only
// called on a malformed-shader warning path this test does not exercise.
const start = source.indexOf('const INT_GEOMPROP_TYPES =');
const end = source.indexOf('\n// Finds CALL sites of fnName', start);
assert.ok(start >= 0 && end > start, 'could not locate patchGeompropVaryings in mtlx-engine.js');
const context = { mtlxWarn: () => {} };
vm.createContext(context);
vm.runInContext(source.slice(start, end) + '\nthis.patchGeompropVaryings = patchGeompropVaryings;', context);
const { patchGeompropVaryings } = context;

const fixtureDir = path.join(root, 'tests/unit/fixtures/geomprop');
const realVs = fs.readFileSync(path.join(fixtureDir, 'plastic_vs.glsl'), 'utf8');
const realFs = fs.readFileSync(path.join(fixtureDir, 'plastic_fs.glsl'), 'utf8');

test('integer geomprop attribute is redeclared float and its varying is flat', () => {
  const { vs, fs: patchedFs } = patchGeompropVaryings(realVs, realFs);
  assert.match(vs, /in float i_geomprop_restoffset;/);
  assert.doesNotMatch(vs, /in int i_geomprop_restoffset;/);
  assert.match(vs, /flat out int vd_geomprop_restoffset;/);
  assert.match(patchedFs, /flat in int vd_geomprop_restoffset;/);
});

test('integer geomprop connector rounds the float attribute back to int', () => {
  const { vs } = patchGeompropVaryings(realVs, realFs);
  assert.match(vs, /vd_geomprop_restoffset = int\(round\(i_geomprop_restoffset\)\);/);
});

test('float geomprops are unaffected (plain, non-flat varyings)', () => {
  const { vs, fs: patchedFs } = patchGeompropVaryings(realVs, realFs);
  assert.match(vs, /in vec3 i_geomprop_rest;/);
  assert.match(vs, /(?<!flat )out vec3 vd_geomprop_rest;/);
  assert.match(vs, /vd_geomprop_rest = i_geomprop_rest;/);
  assert.match(patchedFs, /(?<!flat )in vec3 vd_geomprop_rest;/);
  assert.match(vs, /in float i_geomprop_streaks_horizontal;/);
  assert.match(vs, /vd_geomprop_streaks_horizontal = i_geomprop_streaks_horizontal;/);
});

test('no i_geomprop_ token survives in the patched fragment stage', () => {
  const { fs: patchedFs } = patchGeompropVaryings(realVs, realFs);
  assert.doesNotMatch(patchedFs, /\bi_geomprop_/);
});

test('a direct vertex-stage use of an integer geomprop is rounded, not the declaration', () => {
  const vs = [
    'in int i_geomprop_offset;',
    'out int i_geomprop_offset;',
    'void main() {',
    '    float scaled = float(i_geomprop_offset) * 2.0;',
    '    i_geomprop_offset = i_geomprop_offset;',
    '}',
  ].join('\n');
  const fsSrc = [
    'in int i_geomprop_offset;',
    'void main() {',
    '    int v = i_geomprop_offset;',
    '}',
  ].join('\n');
  const { vs: patchedVs, fs: patchedFs } = patchGeompropVaryings(vs, fsSrc);
  assert.match(patchedVs, /in float i_geomprop_offset;/);
  assert.match(patchedVs, /float scaled = float\(int\(round\(i_geomprop_offset\)\)\) \* 2\.0;/);
  assert.match(patchedVs, /vd_geomprop_offset = int\(round\(i_geomprop_offset\)\);/);
  assert.match(patchedFs, /flat in int vd_geomprop_offset;/);
  assert.match(patchedFs, /int v = vd_geomprop_offset;/);
});

test('ivec2 geomprops round componentwise and stay flat', () => {
  const vs = [
    'in ivec2 i_geomprop_tile;',
    'out ivec2 i_geomprop_tile;',
    'void main() {',
    '    i_geomprop_tile = i_geomprop_tile;',
    '}',
  ].join('\n');
  const fsSrc = [
    'in ivec2 i_geomprop_tile;',
    'void main() {',
    '    ivec2 t = i_geomprop_tile;',
    '}',
  ].join('\n');
  const { vs: patchedVs, fs: patchedFs } = patchGeompropVaryings(vs, fsSrc);
  assert.match(patchedVs, /in vec2 i_geomprop_tile;/);
  assert.match(patchedVs, /flat out ivec2 vd_geomprop_tile;/);
  assert.match(patchedVs, /vd_geomprop_tile = ivec2\(round\(i_geomprop_tile\)\);/);
  assert.match(patchedFs, /flat in ivec2 vd_geomprop_tile;/);
  assert.match(patchedFs, /ivec2 t = vd_geomprop_tile;/);
});
