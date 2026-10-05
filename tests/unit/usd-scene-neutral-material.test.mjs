import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'usd-scene-renderer.js'), 'utf8');

// The Scene resolves files through the engine's exact resolvers (P6 S4); a
// window carrying the real ones, extracted from js/shared/mtlx-gen-core.js.
function engineResolverWindow() {
  const engine = fs.readFileSync(path.join(ROOT, 'js', 'shared', 'mtlx-gen-core.js'), 'utf8');
  const extract = (name) => {
    const idx = engine.indexOf('const ' + name + ' = ');
    assert.ok(idx >= 0, name + ' is present in mtlx-gen-core.js');
    let depth = 0;
    for (let i = idx; i < engine.length; i++) {
      const c = engine[i];
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') depth--;
      else if (c === ';' && depth === 0) return engine.slice(idx, i + 1);
    }
    throw new Error('unterminated ' + name);
  };
  const context = {};
  vm.runInNewContext(['normPath', 'joinRefPath', 'findFileForRef', 'findFilesForRef', 'preferKtx2Sibling'].map(extract).join('\n')
    + '\nthis.window = { normPath, joinRefPath, findFileForRef, findFilesForRef, preferKtx2Sibling };', context);
  return context.window;
}

// Slices a run of top-level renderer definitions and evaluates it with a stand-in THREE.
function slice(startMarker, endMarker, exportsText, context) {
  const start = SOURCE.indexOf(startMarker);
  const end = SOURCE.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, startMarker + ' is present in usd-scene-renderer.js');
  vm.runInNewContext(SOURCE.slice(start, end) + '\n' + exportsText, context, { filename: 'usd-scene-renderer.js' });
  return context;
}

function fakeThree() {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    normalize() { const l = Math.hypot(this.x, this.y, this.z) || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
  }
  class DataTexture { constructor(data, width, height, format) { Object.assign(this, { data, width, height, format }); } }
  class MeshMatcapMaterial { constructor(options) { Object.assign(this, options); this.isMeshMatcapMaterial = true; } }
  return { Vector3, DataTexture, MeshMatcapMaterial, RGBAFormat: 1023 };
}

test('the unsupported-material fallback is a lightless neutral grey, not normal shading', () => {
  const THREE = fakeThree();
  const context = slice('let sceneNeutralMatcap = null;', 'const sceneDjb2 =',
    'this.sceneNeutralMaterial = sceneNeutralMaterial;', { THREE, Math, Uint8Array });
  const a = context.sceneNeutralMaterial('/Looks/A');
  const b = context.sceneNeutralMaterial('/Looks/B');
  assert.equal(a.isMeshMatcapMaterial, true);
  assert.equal(a.name, 'USD unsupported material: /Looks/A');
  assert.equal(a.matcap, b.matcap, 'every fallback shares one matcap texture');
  assert.equal(a.matcap.needsUpdate, true);
  const { data, width } = a.matcap;
  // Grey everywhere (r = g = b), brighter toward the light than at the rim.
  for (let i = 0; i < data.length; i += 4) {
    assert.ok(data[i] === data[i + 1] && data[i] === data[i + 2] && data[i + 3] === 255);
  }
  const at = (x, y) => data[(y * width + x) * 4];
  const centre = at(width / 2, width / 2);
  assert.ok(centre > 40 && centre < 90, 'a mid-grey centre, got ' + centre);
  assert.ok(at(Math.round(width * 0.35), Math.round(width * 0.75)) > at(Math.round(width * 0.8), Math.round(width * 0.2)));
});

test('a package key in an inline document resolves against the published stage assets', () => {
  const context = slice('const sceneArray =', 'const sceneMatrix =',
    'this.api = { sceneFileMap, canonicalizeSceneFilenameInputs, sceneExactFile };', { Blob, Math, String, Object, Set, window: engineResolverWindow() });
  const { sceneFileMap, canonicalizeSceneFilenameInputs, sceneExactFile } = context.api;
  const stage = { assets: [{ path: 'models/glove.usdz[0/bc.jpg]', data: new Uint8Array(4) }] };
  const map = sceneFileMap([{ path: 'models/glove.usdz', data: new Uint8Array(4) }], stage);
  const xml = '<materialx><input name="file" type="filename" value="models/glove.usdz[0/bc.jpg]" /></materialx>';
  const out = canonicalizeSceneFilenameInputs(xml, '__inline_glove_new_mat.mtlx', map, true);
  const value = /value="([^"]*)"/.exec(out)[1];
  assert.equal(value, 'models/glove.usdz[0/bc.jpg]');
  assert.ok(sceneExactFile(map, value, ''), 'the texture is found in the file map');
});
