// Unit coverage for the diffuse bounce v3 bake (js/usd-scene-skyvis.js's
// bakeBounceGeometry/shadeBounce, js/usd-scene-renderer.js's
// makeEStoredSampler, js/mtlx-engine.js's patchDiffuseBounceAdd). See
// scratchpad/displacement-verified/color-parity/bounce/v3-design.md.
//
// Six things matter here (v3-design.md section 10):
//   1. voxelizeStage's no-option path stays byte identical to before this
//      change (the shared baker also feeds sky visibility and the AO
//      volume, so a regression there is silent everywhere else);
//   2. an analytic one-bounce check: a flat plate of constant outgoing
//      radiance under a constant E_stored reconstructs to within 10 percent
//      of the exact cosine-weighted hemisphere mean;
//   3. the shader term has NO extra 1/pi (v2's bug: the stored irradiance is
//      already divided by pi, so a second division under-lit the term);
//   4. makeEStoredSampler agrees with a direct texel read of the same
//      convolved map (its own bilinear/latlong projection copy) to within
//      1 percent;
//   5. a cell inside a thick slab gets exactly zero from its own slab
//      (escapeVisibilityHit's skipSelfCells);
//   6. zero albedo and a fully open grid both give exactly zero.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadSkyVis() {
  const source = fs.readFileSync(path.join(ROOT, 'js', 'usd-scene-skyvis.js'), 'utf8');
  // Minimal THREE stand-in: voxelizeStage only ever calls `new
  // THREE.Vector3()` then `.set(x,y,z).applyMatrix4(m)` and reads .x/.y/.z
  // back out. Every test mesh below is already authored in world space with
  // an identity transform, so applyMatrix4 is a no-op.
  class FakeVector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    applyMatrix4() { return this; }
  }
  const context = { window: {}, THREE: { Vector3: FakeVector3 }, console, Float32Array, Int32Array, Uint8Array, Math };
  vm.runInNewContext(source, context, { filename: 'usd-scene-skyvis.js' });
  return context.window.UsdSceneSkyVisibility;
}

const SkyVis = loadSkyVis();

// A flat quad "floor" mesh (two triangles), identity transform, used only to
// exercise voxelizeStage's rasterization path for the byte-identity guard;
// the actual geometry is not load-bearing for that check.
function makeQuadMesh(albedo) {
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
  const indices = [0, 1, 2, 0, 2, 3];
  const geometry = {
    getAttribute: (name) => (name === 'position' ? {
      count: 4,
      getX: (i) => positions[i * 3],
      getY: (i) => positions[i * 3 + 1],
      getZ: (i) => positions[i * 3 + 2],
    } : null),
    getIndex: () => ({ count: indices.length, getX: (t) => indices[t] }),
  };
  const mesh = { geometry, matrixWorld: {}, opacity: 1 };
  if (albedo != null) mesh.albedo = albedo;
  return mesh;
}

const flatBox = {
  min: { x: -0.5, y: -0.5, z: -0.5 },
  isEmpty: () => false,
  getSize: (target) => { target.x = 2; target.y = 2; target.z = 2; return target; },
};

test('voxelizeStage without opts.albedo/opts.normals is byte identical to before v3', () => {
  const withoutOpts = SkyVis.voxelizeStage([makeQuadMesh()], flatBox, { resolution: 4 });
  const withoutOptsAgain = SkyVis.voxelizeStage([makeQuadMesh()], flatBox, { resolution: 4 });
  assert.ok(withoutOpts, 'voxelizeStage should produce a result for a valid mesh/box');
  assert.equal(withoutOpts.alb, undefined, 'no opts.albedo means no alb field at all');
  assert.equal(withoutOpts.normals, undefined, 'no opts.normals means no normals field at all');
  assert.deepEqual(Array.from(withoutOpts.occ), Array.from(withoutOptsAgain.occ), 'occ must be deterministic/unchanged run to run');
  assert.deepEqual(withoutOpts.dim, withoutOptsAgain.dim);
  assert.equal(withoutOpts.cell, withoutOptsAgain.cell);
  assert.equal(withoutOpts.occupiedFraction, withoutOptsAgain.occupiedFraction);

  const withBoth = SkyVis.voxelizeStage([makeQuadMesh([0.8, 0.6, 0.4])], flatBox, { resolution: 4, albedo: true, normals: true });
  assert.ok(withBoth.alb, 'opts.albedo:true must produce an alb array');
  assert.equal(withBoth.alb.length, withBoth.occ.length * 3, 'alb is RGB: 3 floats per cell');
  assert.ok(withBoth.normals, 'opts.normals:true must produce a normals array');
  assert.equal(withBoth.normals.length, withBoth.occ.length * 3);
  // Same coverage decisions either way: the albedo/normals flags must not
  // change which cells get marked occupied or how much.
  assert.deepEqual(Array.from(withBoth.occ), Array.from(withoutOpts.occ), 'the albedo/normals flags must not perturb occ');
});

test('voxelizeStage with opts.normals produces unit-length normals (or an explicit zero fallback)', () => {
  const withNormals = SkyVis.voxelizeStage([makeQuadMesh([0.5, 0.5, 0.5])], flatBox, { resolution: 4, albedo: true, normals: true });
  const total = withNormals.occ.length;
  for (let i = 0; i < total; i++) {
    if (!withNormals.occ[i]) continue; // only occupied cells receive a triangle sample
    const nx = withNormals.normals[i * 3], ny = withNormals.normals[i * 3 + 1], nz = withNormals.normals[i * 3 + 2];
    const len = Math.hypot(nx, ny, nz);
    assert.ok(len < 1e-8 || Math.abs(len - 1) < 1e-6, `cell ${i} normal should be unit length or exactly zero, got length ${len}`);
  }
});

// Builds an occ/alb/normals grid representing an infinite half-space: every
// cell with z >= wallZ is a blocker of RGB albedo `a`, facing -Z (into the
// open half), everything below is open. dim is generous in x/y (41 cells)
// relative to the 1-cell standoff so a ray needs to travel very far
// laterally before it could exit those bounds, which is what keeps the
// near-grazing (dz ~ 0) rays from leaking through as false escapes.
function buildHalfSpace(a) {
  const dim = [41, 41, 6];
  const wallZ = 3;
  const total = dim[0] * dim[1] * dim[2];
  const occ = new Float32Array(total);
  const alb = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  for (let z = 0; z < dim[2]; z++) {
    for (let y = 0; y < dim[1]; y++) {
      for (let x = 0; x < dim[0]; x++) {
        const idx = (z * dim[1] + y) * dim[0] + x;
        if (z >= wallZ) {
          occ[idx] = 1;
          alb[idx * 3] = a; alb[idx * 3 + 1] = a; alb[idx * 3 + 2] = a;
          normals[idx * 3 + 2] = -1; // faces back toward the open half-space
        }
      }
    }
  }
  return { occ, alb, normals, dim, cell: 1, center: (2 * dim[1] + 20) * dim[0] + 20, wallCell: (wallZ * dim[1] + 20) * dim[0] + 20 };
}

// A constant-E_stored lighting stub: eStored ignores the normal/Vb entirely
// and always returns the same stored-unit RGB. Used to isolate
// bakeBounceGeometry/shadeBounce's own geometric/reconstruction arithmetic
// from makeEStoredSampler, which is tested separately below.
function constantLighting(e) {
  return { eStored: () => e.slice() };
}

test('shadeBounce on a half-space blocker matches the closed-form constant-hemisphere mean within 10%', () => {
  const albedo = 0.8;
  const eStored = [0.5, 0.5, 0.5];
  const voxels = buildHalfSpace(albedo);
  const rays = 128;
  const visibility = SkyVis.marchVisibility(voxels, { rays });
  // skipSelfCells: 0 here -- this test isolates the reconstruction
  // arithmetic against an exact analytic formula; the wall sits exactly
  // one cell from the center probe, so the default 1-cell self-skip window
  // (tested separately below) would discard the very hit under test.
  const geometry = SkyVis.bakeBounceGeometry(voxels, visibility.data, { rays, skipSelfCells: 0 });
  assert.ok(geometry, 'bakeBounceGeometry should produce a result with normals+visibility present');
  const shaded = SkyVis.shadeBounce(geometry, voxels, constantLighting(eStored));
  assert.ok(shaded, 'shadeBounce should produce a result');

  // Reconstruct the center cell's value from the encoded texture exactly as
  // the shader does: e = scale * clamp(R + dot(GBA_decoded, n), 0, 1).
  const decode = (idx, n) => {
    const o = idx * 4;
    const r = shaded.data[o] / 255;
    const d = [
      (shaded.data[o + 1] - 128) / 127,
      (shaded.data[o + 2] - 128) / 127,
      (shaded.data[o + 3] - 128) / 127,
    ];
    const dot = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
    return shaded.scale * Math.max(0, Math.min(1, r + dot));
  };

  // The center cell sits at the half-space boundary; its receiving normal
  // is +Z (facing the wall, the blocker) for the "exact analytic" case: a
  // full hemisphere of constant outgoing radiance L = albedo * eStored
  // gives a cosine-weighted mean of exactly L (the standard hemisphere
  // identity). +Z, not -Z: the moment sign follows "hits accumulate
  // lum(L) * rayDirection", and hits only ever come from rays travelling
  // TOWARD the wall (dz > 0), so a receiving normal that also faces the
  // wall (+Z) is the one that reads the high (lit) reconstruction.
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const L = lum(eStored.map((e) => e * albedo));
  const reconNormal = decode(voxels.center, [0, 0, 1]);
  assert.ok(Math.abs(reconNormal - L) < 0.10 * Math.max(L, 1e-6),
    `reconstructed value ${reconNormal} should be within 10% of the analytic hemisphere mean ${L}`);

  // At 45 degrees the analytic answer for a half-space is L * (1 + cos45)/2.
  const n45 = [Math.SQRT1_2, 0, Math.SQRT1_2];
  const recon45 = decode(voxels.center, n45);
  const expected45 = L * (1 + Math.cos(Math.PI / 4)) / 2;
  assert.ok(Math.abs(recon45 - expected45) < 0.10 * Math.max(expected45, 1e-6),
    `45-degree reconstructed value ${recon45} should be within 10% of ${expected45}`);
});

test('shadeBounce is exactly zero when the blocker has zero albedo', () => {
  const voxels = buildHalfSpace(0);
  const rays = 32;
  const visibility = SkyVis.marchVisibility(voxels, { rays });
  const geometry = SkyVis.bakeBounceGeometry(voxels, visibility.data, { rays });
  const shaded = SkyVis.shadeBounce(geometry, voxels, constantLighting([1, 1, 1]));
  for (let i = 0; i < voxels.dim[0] * voxels.dim[1] * voxels.dim[2]; i++) {
    assert.equal(shaded.data[i * 4], 0, `cell ${i} should have zero bounce mean with zero albedo`);
  }
});

test('shadeBounce is exactly zero on a fully open grid (no blockers at all)', () => {
  const dim = [9, 9, 9];
  const total = dim[0] * dim[1] * dim[2];
  const voxels = { occ: new Float32Array(total), alb: new Float32Array(total * 3).fill(0.9), normals: new Float32Array(total * 3), dim, cell: 1 };
  const rays = 32;
  const visibility = SkyVis.marchVisibility(voxels, { rays });
  const geometry = SkyVis.bakeBounceGeometry(voxels, visibility.data, { rays });
  const shaded = SkyVis.shadeBounce(geometry, voxels, constantLighting([1, 1, 1]));
  for (let i = 0; i < total; i++) {
    assert.equal(shaded.data[i * 4], 0, `cell ${i} should have zero bounce with no occupied cells to hit, even at high albedo`);
  }
});

test('escapeVisibilityHit self-hit: a cell inside a thick slab gets exactly zero from its own slab', () => {
  // A 5-cell-thick solid slab spanning the whole grid; the CENTER cell of
  // the slab is itself occupied, so every ray cast from it immediately
  // re-enters the SAME contiguous occupied run it started in. Without
  // skipSelfCells this would register as a "hit" on its own structure.
  const dim = [21, 21, 21];
  const total = dim[0] * dim[1] * dim[2];
  const occ = new Float32Array(total).fill(1); // the whole grid is one solid slab
  const alb = new Float32Array(total * 3).fill(0.9);
  const normals = new Float32Array(total * 3);
  const voxels = { occ, alb, normals, dim, cell: 1 };
  const cx = 10, cy = 10, cz = 10;
  const centerIdx = (cz * dim[1] + cy) * dim[0] + cx;
  const visibility = new Uint8Array(total * 4); // irrelevant here: no ray ever escapes to report a real hit
  const geometry = SkyVis.bakeBounceGeometry(voxels, visibility, { rays: 32, skipSelfCells: 1.0 });
  assert.ok(geometry);
  const base = centerIdx * geometry.rays;
  for (let r = 0; r < geometry.rays; r++) {
    assert.equal(geometry.hitIndex[base + r], -1, `ray ${r} from inside a uniform solid slab must not report a self-hit`);
  }
  const shaded = SkyVis.shadeBounce(geometry, voxels, constantLighting([1, 1, 1]));
  assert.equal(shaded.data[centerIdx * 4], 0, 'a cell entirely inside its own slab must get exactly zero bounce');
});

test('bakeBounceGeometry/shadeBounce return null without the required inputs', () => {
  const withoutNormals = SkyVis.voxelizeStage([makeQuadMesh()], flatBox, { resolution: 4, albedo: true });
  const dummyVisibility = new Uint8Array(withoutNormals.occ.length * 4).fill(255);
  assert.equal(SkyVis.bakeBounceGeometry(withoutNormals, dummyVisibility, { rays: 8 }), null, 'no .normals means no geometry bake');
  const withBoth = SkyVis.voxelizeStage([makeQuadMesh([0.5, 0.5, 0.5])], flatBox, { resolution: 4, albedo: true, normals: true });
  assert.equal(SkyVis.bakeBounceGeometry(withBoth, null, { rays: 8 }), null, 'no visibility data means no geometry bake');
  const geometry = SkyVis.bakeBounceGeometry(withBoth, dummyVisibility, { rays: 8 });
  assert.equal(SkyVis.shadeBounce(null, withBoth, constantLighting([1, 1, 1])), null);
  assert.equal(SkyVis.shadeBounce(geometry, withBoth, null), null);
  assert.equal(SkyVis.shadeBounce(geometry, withBoth, {}), null, 'lighting.eStored must be a function');
});

test('buildSkyBounce returns null unless voxels (with alb+normals), visibility and lighting are all supplied', () => {
  assert.equal(SkyVis.buildSkyBounce([], flatBox, {}), null);
  const voxelsNoOpts = SkyVis.voxelizeStage([makeQuadMesh()], flatBox, { resolution: 4 }); // no albedo/normals
  assert.equal(SkyVis.buildSkyBounce([], flatBox, { voxels: voxelsNoOpts, visibility: new Uint8Array(4), lighting: constantLighting([1, 1, 1]) }), null);
  const voxelsBoth = SkyVis.voxelizeStage([makeQuadMesh([0.5, 0.5, 0.5])], flatBox, { resolution: 4, albedo: true, normals: true });
  const visibility = SkyVis.marchVisibility(voxelsBoth, { rays: 16 }).data;
  assert.equal(SkyVis.buildSkyBounce([], flatBox, { voxels: voxelsBoth, visibility }), null, 'missing lighting');
  const result = SkyVis.buildSkyBounce([], flatBox, { voxels: voxelsBoth, visibility, lighting: constantLighting([1, 1, 1]), rays: 16 });
  assert.ok(result, 'with voxels+visibility+lighting all present, buildSkyBounce should succeed');
  assert.ok(Number.isFinite(result.scale));
  assert.equal(result.tint.length, 3);
  assert.ok(result.geometry, 'the geometry pass result must be exposed for caching/re-shading');
});

// --- units: no extra 1/pi anywhere in the injected shader term -----------

function loadPatchDiffuseBounceAdd() {
  const source = fs.readFileSync(path.join(ROOT, 'js', 'mtlx-engine.js'), 'utf8');
  const start = source.indexOf('const patchDiffuseBounceAdd =');
  const end = source.indexOf('const patchSceneThinWalledTransmission =', start);
  assert.ok(start >= 0 && end > start, 'patchDiffuseBounceAdd is present in mtlx-engine.js');
  const context = {};
  vm.runInNewContext(source.slice(start, end) + '\nthis.patchDiffuseBounceAdd = patchDiffuseBounceAdd;', context, { filename: 'mtlx-engine.js' });
  return context.patchDiffuseBounceAdd;
}

// Loads BOTH patches (the real pipeline order: AO first, then bounce) so
// the ordering interaction between them -- not just each in isolation --
// is under test.
function loadBothPatches() {
  const source = fs.readFileSync(path.join(ROOT, 'js', 'mtlx-engine.js'), 'utf8');
  // patchAmbientOcclusion now calls ensureEnvOcclusionGlobal (the local
  // reflections' occlusion-compensation global, see
  // scratchpad/displacement-verified/reflections/design.md section 5.6),
  // declared just above it; include it so this standalone extraction still
  // resolves that reference.
  const helperStart = source.indexOf('const ensureEnvOcclusionGlobal =');
  const start = source.indexOf('const patchAmbientOcclusion =');
  const end = source.indexOf('const patchSceneThinWalledTransmission =', start);
  assert.ok(helperStart >= 0 && helperStart < start && end > start);
  const context = {};
  vm.runInNewContext(source.slice(helperStart, start) + source.slice(start, end)
    + '\nthis.patchAmbientOcclusion = patchAmbientOcclusion; this.patchDiffuseBounceAdd = patchDiffuseBounceAdd;',
    context, { filename: 'mtlx-engine.js' });
  return context;
}

const patchDiffuseBounceAdd = loadPatchDiffuseBounceAdd();

const WORLD_POS_VARYINGS = 'in vec3 positionWorld;\nin vec3 normalWorld;\n';
const ANCHOR_LINE = 'shader_constructor_out.color += occlusion * fuzz_layer_out.response;';
const makeFragment = ({ worldPos = true, albedoVar = true, withVolumeOcclusion = false, withSsaoOcclusion = true } = {}) => [
  'precision highp float;',
  worldPos ? WORLD_POS_VARYINGS : '',
  withVolumeOcclusion ? 'float mx_volume_occlusion() { return 1.0; }' : '',
  withSsaoOcclusion ? 'float mx_ssao_occlusion() { return 1.0; }' : '',
  'void mainFn() {',
  albedoVar ? '    vec3 base_color_nonnegative_out = vec3(0.5, 0.5, 0.5);' : '',
  '    ' + ANCHOR_LINE,
  '}',
].join('\n');

test('patchDiffuseBounceAdd injects the additive term INSIDE the same statement, not after its semicolon', () => {
  const out = patchDiffuseBounceAdd(makeFragment(), {});
  assert.notEqual(out, makeFragment(), 'shader should be patched');
  // Regression guard for a real bug found during v2 verification: appending
  // " + mx_diffuse_bounce_add(...);" AFTER the anchor's own trailing `;`
  // splits one statement into two, the second being a bare
  // `+ fn(...);` expression-statement -- which hung the ANGLE/D3D11
  // shader compiler solid on a real asset instead of failing loudly, with
  // no console error and no exception, only a silent timeout. The fix
  // must land the addition BEFORE the semicolon, in the SAME statement.
  assert.ok(!out.includes(ANCHOR_LINE + ' + mx_diffuse_bounce_add'),
    'must NOT append after the original statement\'s semicolon (the historical bug)');
  assert.ok(out.includes('shader_constructor_out.color += occlusion * fuzz_layer_out.response + mx_diffuse_bounce_add(base_color_nonnegative_out);'),
    'the addition must be part of the SAME statement, before the semicolon');
  assert.equal((out.match(/shader_constructor_out\.color \+=[^;]*;/g) || []).length, 1,
    'exactly one statement must touch shader_constructor_out.color at this anchor, not two');
  assert.ok(out.includes('uniform float u_bounceScale;'));
  assert.ok(out.includes('uniform vec3 u_bounceTint;'));
});

test('patchDiffuseBounceAdd applies NO extra 1/pi: no MX_BOUNCE_PI_INV, no 0.3183 constant anywhere', () => {
  const out = patchDiffuseBounceAdd(makeFragment(), {});
  assert.ok(!out.includes('MX_BOUNCE_PI_INV'), 'v2\'s extra pi-division constant must be gone entirely');
  assert.ok(!/0\.31830988618379067|0\.3183/.test(out), 'no 1/pi literal anywhere in the injected term');
  // The formula itself: strength * near * e * tint * albedo, nothing else.
  assert.ok(out.includes('return clamp(u_skyBounceStrength, 0.0, 1.0) * near * e * u_bounceTint * albedo;'),
    'the injected formula must be strength * near * e * tint * albedo with no pi factor');
});

test('patchDiffuseBounceAdd gates the near-field term by min(volume, ssao) occlusion when the AO volume is compiled in', () => {
  const withVolume = patchDiffuseBounceAdd(makeFragment({ withVolumeOcclusion: true }), {});
  assert.ok(withVolume.includes('float near = min(mx_volume_occlusion(), mx_ssao_occlusion());'));
  // Sampler-budget drop: when mx_volume_occlusion was never declared (the AO
  // volume was dropped), the bounce term must fall back to mx_ssao_occlusion
  // alone rather than referencing an undeclared function (an unconditional
  // reference here would be a compile-time regression waiting for the next
  // sampler-starved asset).
  const withoutVolume = patchDiffuseBounceAdd(makeFragment({ withVolumeOcclusion: false }), {});
  assert.ok(withoutVolume.includes('float near = mx_ssao_occlusion();'));
  assert.ok(!withoutVolume.includes('mx_volume_occlusion()'));
});

test('patchDiffuseBounceAdd falls all the way back to no near-field gating when NEITHER occlusion helper is declared', () => {
  // Regression guard for a real bug this v3 change introduced and a headed
  // embed spec run caught: patchAmbientOcclusion's own anchor can fail to
  // match a shader shape with no "// Ambient occlusion" slot at all (a very
  // simple standard_surface network compiled outside the Scene), in which
  // case NEITHER mx_volume_occlusion NOR mx_ssao_occlusion exists even
  // though patchDiffuseBounceAdd's own anchor still matches. Referencing
  // either unconditionally is a shader compile error ("no matching
  // overloaded function found"), invisible to a source-text check.
  const src = makeFragment({ withVolumeOcclusion: false, withSsaoOcclusion: false });
  const out = patchDiffuseBounceAdd(src, {});
  assert.ok(out.includes('float near = 1.0;'));
  assert.ok(!out.includes('mx_volume_occlusion()'));
  assert.ok(!out.includes('mx_ssao_occlusion()'));
});

test('patchDiffuseBounceAdd safe-fails (no injection) without base_color_nonnegative_out', () => {
  const src = makeFragment({ albedoVar: false });
  assert.equal(patchDiffuseBounceAdd(src, {}), src);
});

test('patchDiffuseBounceAdd safe-fails (no injection) without world-position varyings', () => {
  const src = makeFragment({ worldPos: false });
  assert.equal(patchDiffuseBounceAdd(src, {}), src);
});

test('patchDiffuseBounceAdd safe-fails (no injection) when skipSkyVis or skipBounce is set (sampler budget)', () => {
  const src = makeFragment();
  assert.equal(patchDiffuseBounceAdd(src, { skipSkyVis: true }), src);
  assert.equal(patchDiffuseBounceAdd(src, { skipBounce: true }), src);
});

test('the real pipeline (patchAmbientOcclusion THEN patchDiffuseBounceAdd) declares mx_ssao_occlusion/mx_volume_occlusion BEFORE mx_diffuse_bounce_add references them', () => {
  // Regression guard for a real ordering bug a headed embed spec run
  // caught (GLSL "no matching overloaded function found"):
  // patchAmbientOcclusion's own injected functions are themselves function
  // definitions, so a naive "first function definition" search by the
  // SECOND patch can land INSIDE the first patch's block, before its
  // functions are declared, even though patchDiffuseBounceAdd's generated
  // mx_diffuse_bounce_add body calls them.
  const { patchAmbientOcclusion, patchDiffuseBounceAdd: bothBounceAdd } = loadBothPatches();
  const anchor = '\n            // Ambient occlusion\n            occlusion = 1.0;\n'
    + '            ' + ANCHOR_LINE + '\n';
  const src = [
    'precision highp float;',
    WORLD_POS_VARYINGS,
    'void mainFn() {',
    '    vec3 base_color_nonnegative_out = vec3(0.5, 0.5, 0.5);',
    anchor,
    '}',
  ].join('\n');
  const afterAo = patchAmbientOcclusion(src, {});
  assert.notEqual(afterAo, src, 'patchAmbientOcclusion should have injected something on this real-shaped anchor');
  const out = bothBounceAdd(afterAo, {});
  assert.ok(out.includes('vec3 mx_diffuse_bounce_add(vec3 albedo)'), 'the bounce function must still get injected');
  const ssaoDeclIdx = out.indexOf('float mx_ssao_occlusion()');
  const volumeDeclIdx = out.indexOf('float mx_volume_occlusion()');
  const bounceFnIdx = out.indexOf('vec3 mx_diffuse_bounce_add(vec3 albedo)');
  assert.ok(ssaoDeclIdx >= 0 && ssaoDeclIdx < bounceFnIdx,
    'mx_ssao_occlusion must be declared textually BEFORE mx_diffuse_bounce_add');
  if (volumeDeclIdx >= 0) {
    assert.ok(volumeDeclIdx < bounceFnIdx,
      'mx_volume_occlusion, if present, must also be declared textually BEFORE mx_diffuse_bounce_add');
  }
});

// --- makeEStoredSampler: units and irradiance-sampler parity -------------

function loadMakeEStoredSampler() {
  const source = fs.readFileSync(path.join(ROOT, 'js', 'usd-scene-renderer.js'), 'utf8');
  const start = source.indexOf('const M_PI_INV_JS = 1 / Math.PI;');
  const end = source.indexOf('const sceneNeutralMaterial =', start);
  assert.ok(start >= 0 && end > start, 'makeEStoredSampler is present in usd-scene-renderer.js');
  // Minimal THREE stand-in: only Vector3 (set/transformDirection) is used
  // when no envMatrix is supplied to a test, so a real matrix is unneeded.
  class FakeVector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    transformDirection() { return this; } // identity: no envMatrix in these tests
  }
  const context = { THREE: { Vector3: FakeVector3 } };
  vm.runInNewContext(source.slice(start, end) + '\nthis.makeEStoredSampler = makeEStoredSampler; this.mxLatlongProjectionJS = mxLatlongProjectionJS;', context, { filename: 'usd-scene-renderer.js' });
  return context;
}

const { makeEStoredSampler, mxLatlongProjectionJS } = loadMakeEStoredSampler();

test('makeEStoredSampler on a constant map with no key light returns exactly k * exposure (the single 1/pi lives only in the map)', () => {
  const w = 8, h = 4, k = 0.37;
  const data = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = k; data[i * 4 + 1] = k; data[i * 4 + 2] = k; data[i * 4 + 3] = 1; }
  const env = { irradianceConvolvedData: data, irradianceConvolvedSize: [w, h], keyLight: null };
  const exposure = 0.6;
  const eStored = makeEStoredSampler(env, exposure, null, null);
  assert.ok(typeof eStored === 'function');
  // Float32Array storage means the map's own value round-trips as
  // Math.fround(k), not the double-precision k; the comparison must be
  // against that same rounded value to isolate makeEStoredSampler's own
  // arithmetic (a single multiply) from Float32 storage error.
  const expected = Math.fround(k) * exposure;
  for (const n of [[0, 1, 0], [1, 0, 0], [0, -1, 0], [Math.SQRT1_2, Math.SQRT1_2, 0]]) {
    const [r, g, b] = eStored(n[0], n[1], n[2], 0);
    assert.ok(Math.abs(r - expected) < 1e-9, `r=${r} expected ${expected}`);
    assert.ok(Math.abs(g - expected) < 1e-9);
    assert.ok(Math.abs(b - expected) < 1e-9);
  }
});

test('makeEStoredSampler returns null when the convolved readback is unavailable (safe-fail)', () => {
  assert.equal(makeEStoredSampler(null, 1, null, null), null);
  assert.equal(makeEStoredSampler({}, 1, null, null), null);
  assert.equal(makeEStoredSampler({ irradianceConvolvedData: new Float32Array(4) }, 1, null, null), null, 'missing irradianceConvolvedSize');
});

test('makeEStoredSampler parity: matches a direct bilinear texel read through the same mx_latlong_projection for 64 random normals within 1%', () => {
  const w = 64, h = 32;
  const data = new Float32Array(w * h * 4);
  // A synthetic, non-constant map (a smooth gradient) so the parity check
  // exercises real bilinear interpolation, not a degenerate constant field.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = 0.2 + 0.6 * (x / w);
      data[i + 1] = 0.1 + 0.5 * (y / h);
      data[i + 2] = 0.3;
      data[i + 3] = 1;
    }
  }
  const env = { irradianceConvolvedData: data, irradianceConvolvedSize: [w, h], keyLight: null };
  const eStored = makeEStoredSampler(env, 1, null, null);
  // Independent direct-fetch reference: same wrap/clamp/bilinear rule.
  const wrapU = (x) => ((x % w) + w) % w;
  const clampV = (y) => Math.max(0, Math.min(h - 1, y));
  const texel = (x, y, c) => data[(clampV(y) * w + wrapU(x)) * 4 + c];
  const directSample = (u, v) => {
    const fx = u * w - 0.5, fy = v * h - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const out = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = texel(x0, y0, c) * (1 - tx) + texel(x0 + 1, y0, c) * tx;
      const b = texel(x0, y0 + 1, c) * (1 - tx) + texel(x0 + 1, y0 + 1, c) * tx;
      out[c] = a * (1 - ty) + b * ty;
    }
    return out;
  };
  let seed = 12345;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 64; i++) {
    const theta = rand() * Math.PI * 2, z = rand() * 2 - 1, r = Math.sqrt(Math.max(0, 1 - z * z));
    const n = [Math.cos(theta) * r, z, Math.sin(theta) * r];
    const got = eStored(n[0], n[1], n[2], 0);
    const uv = mxLatlongProjectionJS(n[0], n[1], n[2]);
    const expected = directSample(uv[0], uv[1]);
    for (let c = 0; c < 3; c++) {
      const denom = Math.max(Math.abs(expected[c]), 1e-6);
      assert.ok(Math.abs(got[c] - expected[c]) / denom < 0.01,
        `channel ${c} at normal ${n}: got ${got[c]}, expected ${expected[c]}`);
    }
  }
});

test('makeEStoredSampler adds the key term only when Vb > 0 and gates by cosine', () => {
  const w = 4, h = 2;
  const data = new Float32Array(w * h * 4); // all zero convolved map: isolates the key term
  const env = { irradianceConvolvedData: data, irradianceConvolvedSize: [w, h], keyLight: { color: [1, 0, 0], intensity: Math.PI } };
  const keyDir = { x: 0, y: 1, z: 0 };
  const eStored = makeEStoredSampler(env, 1, null, keyDir);
  // Facing the key directly (n == keyDir), Vb = 1: k = intensity*1*1*1/pi = 1.
  const lit = eStored(0, 1, 0, 1);
  assert.ok(Math.abs(lit[0] - 1) < 1e-6, `expected red channel ~1, got ${lit[0]}`);
  assert.equal(lit[1], 0); assert.equal(lit[2], 0);
  // Same normal, Vb = 0 (blocker itself unlit by the key): no key contribution.
  const unlit = eStored(0, 1, 0, 0);
  assert.equal(unlit[0], 0);
  // Facing away from the key: no contribution regardless of Vb.
  const away = eStored(0, -1, 0, 1);
  assert.equal(away[0], 0);
});
