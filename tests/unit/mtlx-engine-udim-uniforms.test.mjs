import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'js/mtlx-engine.js'), 'utf8');

const start = source.indexOf('const findUdimRefs =');
const end = source.indexOf('\n\n// ------------------------------------------------------------------\n// tryRefreshRenderView', start);
assert.ok(start >= 0 && end > start, 'could not slice findUdimRefs/createUdimVariantUniforms from js/mtlx-engine.js');

function load() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(
    source.slice(start, end) + '\nthis.findUdimRefs = findUdimRefs; this.createUdimVariantUniforms = createUdimVariantUniforms;',
    sandbox
  );
  return sandbox;
}

test('findUdimRefs keeps only filename uniforms whose data contains <UDIM> (case-insensitive)', () => {
  const { findUdimRefs } = load();
  const introspected = [
    { name: 'u_a', type: 'filename', data: '/tex/albedo.<UDIM>.png' },
    { name: 'u_b', type: 'filename', data: '/tex/plain.png' },
    { name: 'u_c', type: 'float', data: '<udim>' },
    { name: 'u_d', type: 'filename', data: '/tex/rough.<udim>.png' },
    { name: 'u_e', type: 'filename', data: null },
  ];
  const refs = findUdimRefs(introspected);
  assert.deepEqual(refs.map((r) => r.name), ['u_a', 'u_d']);
  assert.deepEqual([...findUdimRefs(null)], []);
});

test('createUdimVariantUniforms shareSlots:true shares every OTHER slot object by reference, UDIM slot is independent', () => {
  const { createUdimVariantUniforms } = load();
  const timeSlot = { value: 0 };
  const base = {
    u_time: timeSlot,
    u_baseColor: { value: [1, 1, 1] },
    u_map: { value: 'tile-1001-texture' },
  };
  const variant = createUdimVariantUniforms(base, { u_map: 'tile-1002-texture' }, { shareSlots: true });

  // The UDIM sampler is a fresh slot with the tile's own value.
  assert.notEqual(variant.u_map, base.u_map);
  assert.equal(variant.u_map.value, 'tile-1002-texture');
  assert.equal(base.u_map.value, 'tile-1001-texture'); // base untouched

  // Every other slot is the SAME object: a later mutation of base's slot
  // (as setUniforms/env setters/sliders do in place) reaches the variant.
  assert.equal(variant.u_time, base.u_time);
  assert.equal(variant.u_baseColor, base.u_baseColor);
  timeSlot.value = 42;
  assert.equal(variant.u_time.value, 42);
});

test('createUdimVariantUniforms shareSlots:false clones every non-UDIM value, textures shared by reference', () => {
  const { createUdimVariantUniforms } = load();
  const fakeTexture = { isTexture: true, id: 'shared-texture' };
  const arraySlot = [1, 2, 3];
  const base = {
    u_baseColor: { value: arraySlot },
    u_env: { value: fakeTexture },
    u_map: { value: 'tile-1001-texture' },
  };
  const variant = createUdimVariantUniforms(base, { u_map: 'tile-1002-texture' }, { shareSlots: false });

  assert.notEqual(variant.u_baseColor, base.u_baseColor);
  assert.deepEqual(variant.u_baseColor.value, arraySlot);
  assert.notEqual(variant.u_baseColor.value, arraySlot); // array value cloned, not shared

  assert.equal(variant.u_env.value, fakeTexture); // texture value SHARED, not cloned
  assert.equal(variant.u_map.value, 'tile-1002-texture');

  // Mutating base's array slot does NOT reach the variant (deep clone).
  arraySlot.push(4);
  assert.equal(variant.u_baseColor.value.length, 3);
});
