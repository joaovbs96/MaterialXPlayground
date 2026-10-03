import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// P6 S4: the Scene's EXR/HDR/TIF/KTX2 and bitmap textures go through its
// texture session (acquireSceneTexture / bindSceneTexture); a stub session
// records each acquire so sampler modes, tiers and the KTX2 fallback are checked.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadSceneTextureGlue(acquireImpl) {
  const source = fs.readFileSync(path.join(root, 'js', 'usd-scene-renderer.js'), 'utf8');
  const start = source.indexOf('    const sceneTextureBytes = (tex, ext) => {');
  const end = source.indexOf('    const udimWarnings = new Set();', start);
  assert.ok(start >= 0 && end > start, 'Scene texture glue source is present');
  const calls = [];
  const context = {
    console,
    plannedTextureSize: 64,
    stopped: false,
    isMounted: () => true,
    warnings: [],
    udimWarnings: new Set(),
    calls,
    textureSession: { acquire: (hit, opts) => { calls.push({ hit, opts }); return acquireImpl(hit, opts); } },
  };
  vm.runInNewContext(
    source.slice(start, end)
      + '\nthis.acquireSceneTexture = acquireSceneTexture; this.bindSceneTexture = bindSceneTexture; this.sceneTextureBytes = sceneTextureBytes;',
    context,
    { filename: path.join(root, 'js', 'usd-scene-renderer.js') },
  );
  return context;
}

test('unbounded EXR scene textures acquire with their sampler modes at the planned tier', async () => {
  const texture = { image: { width: 8, height: 4 }, generateMipmaps: false };
  const ctx = loadSceneTextureGlue(async () => ({ texture }));
  const modes = { u: 'clamp', v: 'mirror' };
  const result = await ctx.acquireSceneTexture({ path: 'textures/gold.exr', blob: {} }, 'exr', null, modes);
  assert.equal(result.tex, texture);
  assert.equal(result.bytes, 8 * 4 * 16);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].opts.samplerModes, modes);
  assert.equal(ctx.calls[0].opts.tier, 64);
  assert.equal(ctx.calls[0].opts.fastPathSamplerQuirk, undefined);
});

test('an invalid KTX2 base level falls back to the original file with the same sampler modes', async () => {
  const fallbackTexture = { image: { width: 4, height: 4 }, generateMipmaps: true };
  const ctx = loadSceneTextureGlue(async (hit) => {
    if (hit.key.endsWith('.ktx2')) { const e = new Error('bad base'); e.ktx2InvalidBaseLevel = true; throw e; }
    return { texture: fallbackTexture };
  });
  const modes = { u: 'clamp', v: 'periodic' };
  const result = await ctx.acquireSceneTexture({ path: 'textures/gold.ktx2', blob: {} }, 'ktx2', { path: 'textures/gold.png', blob: {} }, modes);
  assert.equal(result.tex, fallbackTexture);
  assert.equal(result.bytes, Math.ceil(4 * 4 * 4 * 4 / 3));
  assert.deepEqual(ctx.calls.map((c) => c.hit.key), ['textures/gold.ktx2', 'textures/gold.png']);
  assert.ok(ctx.calls.every((c) => c.opts.samplerModes === modes));
  assert.ok(ctx.warnings.some((w) => w.includes('falling back to textures/gold.png')));
});

test('KTX2 bytes are the sum of the kept mip levels', () => {
  const ctx = loadSceneTextureGlue(async () => null);
  const tex = { image: { width: 64, height: 64 }, mipmaps: [{ data: new Uint8Array(100) }, { data: new Uint8Array(25) }] };
  assert.equal(ctx.sceneTextureBytes(tex, 'ktx2'), 125);
});

test('bitmap textures bind through the session with their authored sampler modes', async () => {
  const texture = { image: { width: 4, height: 4 } };
  const ctx = loadSceneTextureGlue(() => Promise.resolve({ texture }));
  const uniforms = { u_tex: { value: null } };
  const job = ctx.bindSceneTexture(uniforms, 'u_tex', { path: 'a.png', blob: {} }, null);
  await job;
  assert.equal(uniforms.u_tex.value, texture);
  assert.equal(ctx.calls[0].opts.fastPathSamplerQuirk, undefined);
  assert.equal(ctx.calls[0].opts.tier, 64);
});
