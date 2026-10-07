// expandSceneZips (js/usd/scene-import-common.js): zip paths are kept, .usdz
// is never expanded, nested zips and side files are skipped.
import assert from 'node:assert/strict';
import test from 'node:test';

import { expandSceneZips } from '../../js/usd/scene-import-common.js';

const fakeZip = (names) => ({
  files: Object.fromEntries(names.map((n) => [n, { dir: n.endsWith('/'), async: async () => new Blob([n]) }])),
});
const loader = (zips) => async (data) => { if (!zips[data]) throw new Error('bad zip'); return fakeZip(zips[data]); };

test('keeps inner paths and leaves non-zip entries and .usdz alone', async () => {
  const entries = [{ path: 'a.zip', data: 'a' }, { path: 'pkg.usdz', data: 'u' }, { path: 'x.obj', data: 'o' }];
  const { files, warnings } = await expandSceneZips(entries, loader({
    a: ['coffee/', 'coffee/scene-v4.pbrt', 'coffee/models/m.ply', '__MACOSX/coffee/._m.ply', 'inner.usdz', 'deep.zip'],
  }));
  assert.deepEqual(files.map((f) => f.path), ['coffee/scene-v4.pbrt', 'coffee/models/m.ply', 'inner.usdz', 'pkg.usdz', 'x.obj']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /deep\.zip/);
});

test('a corrupt zip reports its name', async () => {
  await assert.rejects(expandSceneZips([{ path: 'dir/bad.zip', data: 'z' }], loader({})), /bad\.zip.*bad zip/);
});
