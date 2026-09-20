import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'js/usd-scene-renderer.js'), 'utf8');

function loadQueue() {
  const start = source.indexOf('const createSceneRebuildQueue =');
  const end = source.indexOf('\nconst sceneArray =', start);
  assert.ok(start >= 0 && end > start, 'queue helper source exists');
  const script = source.slice(start, end) + '\nthis.createSceneRebuildQueue = createSceneRebuildQueue;';
  const context = {};
  vm.runInNewContext(script, context);
  return context.createSceneRebuildQueue;
}

test('rapid displacement rebuild requests serialize and commit only the latest pass', async () => {
  const createQueue = loadQueue();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let builds = 0;
  let commits = 0;
  let active = 0;
  let maxActive = 0;
  const queue = createQueue({
    build: async () => {
      builds += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (builds === 1) await firstGate;
      active -= 1;
    },
    commit: async () => { commits += 1; },
    isStopped: () => false,
    onError: (error) => { throw error; },
  });

  const settled = queue.request();
  queue.request();
  queue.request();
  releaseFirst();
  await settled;

  assert.equal(maxActive, 1);
  assert.equal(builds, 2);
  assert.equal(commits, 1);
});

test('cancelling an in-flight displacement rebuild prevents its commit', async () => {
  const createQueue = loadQueue();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let commits = 0;
  const queue = createQueue({
    build: async () => { await gate; },
    commit: async () => { commits += 1; },
    isStopped: () => false,
    onError: (error) => { throw error; },
  });

  const settled = queue.request();
  queue.cancel();
  release();
  await settled;
  await queue.whenSettled();
  assert.equal(commits, 0);
});


test('auto displacement modes resolve from evaluated offsets', () => {
  const start = source.indexOf('const createSceneRebuildQueue =');
  const end = source.indexOf('\nconst sceneArray =', start);
  const context = {};
  vm.runInNewContext(source.slice(start, end)
    + '\nthis.resolveMode = sceneResolvedDisplacementMode;', context);
  assert.equal(context.resolveMode({ mode: 'float' }, { offsets: new Float32Array([0, 1, 2]) }), 'float');
  assert.equal(context.resolveMode({ mode: 'auto' }, { offsets: new Float32Array([0.2, 0.2, 0.2]) }), 'float');
  assert.equal(context.resolveMode({ mode: 'auto' }, { offsets: new Float32Array([0, 0.1, 0]) }), 'vector3');
});
test('scene displacement integration preserves current geometry contracts', () => {
  assert.match(source, /geomprops: welded\.geomprops/);
  assert.match(source, /sceneGeompropConstants\(effectiveRecord\)/);
  assert.match(source, /object\.userData\.castsShadow = record\.castsShadow !== false/);
  assert.match(source, /whenDisplacementSettled: \(\) => sceneRebuildQueue\.whenSettled\(\)/);
  assert.match(source, /await requestSceneRebuild\(\);[\s\S]{0,180}if \(stopped \|\| !isMounted\(\)\) return;/);
});
