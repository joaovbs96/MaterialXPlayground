// createSceneRebuildProgress (js/usd-scene-renderer.js): the state machine
// behind handle.onRebuildProgress, plus the queue's isBusy() the geometry end
// signal relies on.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'js/usd-scene-renderer.js'), 'utf8');

function load() {
  const start = source.indexOf('const createSceneRebuildProgress =');
  const end = source.indexOf('\nconst sceneResolvedDisplacementMode =', start);
  assert.ok(start >= 0 && end > start, 'rebuild progress helpers exist');
  const context = {};
  vm.runInNewContext(source.slice(start, end)
    + '\nthis.createSceneRebuildProgress = createSceneRebuildProgress;'
    + '\nthis.createSceneRebuildQueue = createSceneRebuildQueue;', context);
  return context;
}

const { createSceneRebuildProgress, createSceneRebuildQueue } = load();
const plain = (value) => JSON.parse(JSON.stringify(value));

function recorder() {
  const events = [];
  const tracker = createSceneRebuildProgress((event) => events.push(plain(event)));
  return { events, tracker };
}

test('start, progress and end carry kind, phase, done, total and label', () => {
  const { events, tracker } = recorder();
  tracker.start('materials', 'Updating materials', 3);
  tracker.progress('materials', 1, 3);
  tracker.progress('materials', 2, 5, 'Loading textures');
  tracker.end('materials');
  assert.deepEqual(events, [
    { kind: 'materials', phase: 'start', done: 0, total: 3, label: 'Updating materials' },
    { kind: 'materials', phase: 'progress', done: 1, total: 3, label: 'Updating materials' },
    { kind: 'materials', phase: 'progress', done: 2, total: 5, label: 'Loading textures' },
    { kind: 'materials', phase: 'end', done: 2, total: 5, label: 'Loading textures' },
  ]);
  assert.deepEqual(plain(tracker.snapshot()), []);
});

test('progress for an idle kind is ignored (the initial load path)', () => {
  const { events, tracker } = recorder();
  tracker.progress('geometry', 4, 10);
  tracker.end('geometry');
  assert.equal(events.length, 0);
});

test('a restart supersedes the old state and a single end still clears it', () => {
  const { events, tracker } = recorder();
  tracker.start('materials', 'Updating materials', 4);
  tracker.progress('materials', 3, 4);
  tracker.start('materials', 'Updating materials', 4);
  assert.deepEqual(plain(tracker.snapshot()), [{ kind: 'materials', done: 0, total: 4, label: 'Updating materials' }]);
  tracker.end('materials');
  tracker.end('materials');
  assert.equal(events.filter((e) => e.phase === 'end').length, 1);
  assert.equal(tracker.isActive('materials'), false);
});

test('done is clamped to total, unknown totals stay 0 (indeterminate)', () => {
  const { events, tracker } = recorder();
  tracker.start('geometry', 'Rebuilding geometry');
  tracker.progress('geometry', 7);
  assert.equal(events[1].total, 0);
  assert.equal(events[1].done, 7);
  tracker.progress('geometry', 9, 4);
  assert.equal(events[2].done, 4);
});

test('endAll ends every live kind and a throwing listener cannot break the tracker', () => {
  const ends = [];
  const tracker = createSceneRebuildProgress((event) => {
    if (event.phase === 'end') ends.push(event.kind);
    throw new Error('listener failure');
  });
  tracker.start('materials', 'Updating materials', 2);
  tracker.start('geometry', 'Rebuilding geometry', 1);
  tracker.endAll();
  assert.deepEqual(ends.sort(), ['geometry', 'materials']);
  assert.deepEqual(plain(tracker.snapshot()), []);
});

test('the rebuild queue reports busy until the last coalesced pass settles', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let builds = 0;
  const queue = createSceneRebuildQueue({
    build: async () => { builds += 1; if (builds === 1) await gate; },
    commit: async () => {},
  });
  const first = queue.request();
  assert.equal(queue.isBusy(), true);
  queue.request();
  release();
  await first;
  await queue.whenSettled();
  assert.equal(queue.isBusy(), false);
  assert.equal(builds, 2);
});
