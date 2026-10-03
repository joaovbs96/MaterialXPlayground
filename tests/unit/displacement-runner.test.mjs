import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const engineSource = fs.readFileSync(path.join(root, 'js/mtlx-engine.js'), 'utf8');
// The Scene's resolveDisplacementLevel was deleted in P6 S5; its frozen text is the oracle.
const sceneSource = fs.readFileSync(path.join(root, 'tests/unit/fixtures/scene-legacy-p5.js'), 'utf8');

// ---- createTriangleBudget, sliced verbatim from the engine. ----
const budgetStart = engineSource.indexOf('// Highest triangle count a preview mesh may reach');
const budgetEnd = engineSource.indexOf('\n// Loop-subdivides `source`', budgetStart);
assert.ok(budgetStart >= 0 && budgetEnd > budgetStart, 'could not slice createTriangleBudget from js/mtlx-engine.js');
const engineCtx = {};
vm.createContext(engineCtx);
vm.runInContext(
  engineSource.slice(budgetStart, budgetEnd)
    + '\nthis.createTriangleBudget = createTriangleBudget; this.pickSubdivisionLevel = pickSubdivisionLevel;',
  engineCtx
);

// ---- createDisplacementRunner, sliced verbatim; evaluateDisplacement and
// hasDisplacementFileRef are stubbed in the sandbox instead of pulled in,
// so the state machine (token/debounce/settle/notices) runs standalone. ----
const runnerStart = engineSource.indexOf('const createDisplacementRunner = ({');
const runnerEnd = engineSource.indexOf('\n\n// ------------------------------------------------------------------\n// tryRefreshRenderView', runnerStart);
assert.ok(runnerStart >= 0 && runnerEnd > runnerStart, 'could not slice createDisplacementRunner from js/mtlx-engine.js');
const runnerSource = engineSource.slice(runnerStart, runnerEnd);

// ---- the Scene's resolveDisplacementLevel, sliced read-only for parity. ----
const sceneStart = sceneSource.indexOf('const DISPLACEMENT_MESH_TRIANGLE_LIMIT = 700000;');
const sceneEnd = sceneSource.indexOf('\n        // Re-subdivides the PRE-subdivision cage', sceneStart);
assert.ok(sceneStart >= 0 && sceneEnd > sceneStart, 'could not slice resolveDisplacementLevel from js/usd-scene-renderer.js');
const makeSceneResolver = (enabled) => {
  const sandbox = { triangleLimitsEnabled: enabled };
  vm.createContext(sandbox);
  vm.runInContext(sceneSource.slice(sceneStart, sceneEnd) + '\nthis.resolveDisplacementLevel = resolveDisplacementLevel;', sandbox);
  return sandbox.resolveDisplacementLevel;
};

// A minimal stand-in for a THREE.BufferGeometry: only what build()/land()
// touch when level stays 0 (no subdivision, so no prepareDisplacementBase/
// BASE_GEOM_CACHE round trip is exercised here; that path is pinned
// separately by the ensureBaseGeometry/BASE_GEOM_CACHE behavior already
// covered elsewhere in this file's slice-based sibling tests).
const fakeGeometry = (count = 10) => ({
  getAttribute: (name) => (name === 'position' ? { count, array: new Float32Array(count * 3) } : null),
  getIndex: () => null,
  clone: function clone() { return fakeGeometry(count); },
  dispose: () => {},
});

// Builds a fresh createDisplacementRunner instance in its own vm context,
// with evaluateDisplacement stubbed to `evalImpl` (a (args) => Promise/value
// function) and hasDisplacementFileRef stubbed to always report false
// (filename-driven first-build races are out of scope for these tests).
const makeRunner = (opts = {}, evalImpl = async () => ({ offsets: null, notices: [] })) => {
  const sandbox = {
    setTimeout, clearTimeout, Promise, Symbol,
    evaluateDisplacement: (...args) => evalImpl(...args),
    hasDisplacementFileRef: () => false,
  };
  vm.createContext(sandbox);
  vm.runInContext(runnerSource + '\nthis.createDisplacementRunner = createDisplacementRunner;', sandbox);
  return sandbox.createDisplacementRunner({
    renderer: {}, isAlive: () => true,
    budget: { perMesh: 700000, pick: (tris, lvl) => ({ level: 0, capped: false, triangles: tris, allowed: true }) },
    cacheKey: () => 'k',
    debounceMs: 20, firstBuildTimeoutMs: 40,
    onGeometry: () => {}, onStatus: () => {},
    getWorldMatrix: () => null,
    ...opts,
  });
};

test('createTriangleBudget picks the same level/triangles/allowed as the Scene resolveDisplacementLevel, over a grid', () => {
  const grid = [
    { tris: 100, req: 0 },
    { tris: 100, req: 3 },
    { tris: 10000, req: 3 },
    { tris: 700000, req: 1 },
    { tris: 175001, req: 2 },
    { tris: 2000000, req: 0 },
    { tris: 1, req: 3 },
    { tris: 43750, req: 3 },
  ];
  for (const { tris, req } of grid) {
    const resolveDisplacementLevel = makeSceneResolver(true);
    const sceneResult = resolveDisplacementLevel({ indices: new Array(tris * 3).fill(0) }, req);
    const budget = engineCtx.createTriangleBudget({ perMesh: 700000, total: Infinity, enabled: true });
    const engineResult = budget.pick(tris, req);
    assert.equal(engineResult.level, sceneResult.level, `level mismatch at ${tris} tris, requested ${req}`);
    assert.equal(engineResult.triangles, sceneResult.triangles, `triangles mismatch at ${tris} tris, requested ${req}`);
    assert.equal(engineResult.allowed, sceneResult.allowed, `allowed mismatch at ${tris} tris, requested ${req}`);
  }
});

test('createTriangleBudget total tracks a running per-stage total like the Scene', () => {
  const resolveDisplacementLevel = makeSceneResolver(true);
  const budget = engineCtx.createTriangleBudget({ perMesh: 700000, total: 1000000, enabled: true });
  const meshes = [
    { tris: 100000, req: 2 },
    { tris: 50000, req: 2 },
    { tris: 200000, req: 2 },
    { tris: 900000, req: 1 },
  ];
  for (const { tris, req } of meshes) {
    const sceneResult = resolveDisplacementLevel({ indices: new Array(tris * 3).fill(0) }, req);
    const engineResult = budget.pick(tris, req);
    assert.equal(engineResult.level, sceneResult.level, `level mismatch at ${tris} tris, requested ${req}`);
    assert.equal(engineResult.allowed, sceneResult.allowed, `allowed mismatch at ${tris} tris, requested ${req}`);
  }
});

test('createTriangleBudget disabled matches the Scene with triangleLimitsEnabled false (unclamped)', () => {
  const resolveDisplacementLevel = makeSceneResolver(false);
  const budget = engineCtx.createTriangleBudget({ perMesh: 700000, total: Infinity, enabled: false });
  for (const { tris, req } of [{ tris: 2000000, req: 3 }, { tris: 1, req: 0 }]) {
    const sceneResult = resolveDisplacementLevel({ indices: new Array(tris * 3).fill(0) }, req);
    const engineResult = budget.pick(tris, req);
    assert.equal(engineResult.level, sceneResult.level);
    assert.equal(engineResult.allowed, sceneResult.allowed);
  }
});

test('runner state machine: evaluate lands "skipped" with the geometry-too-small notice', async () => {
  const runner = makeRunner();
  runner.setSource({ key: 'a', mode: 'auto' });
  runner.build(fakeGeometry(1), 0);
  await runner.evaluate();
  const state = runner.getState();
  assert.equal(state.state, 'skipped');
  assert.deepEqual(Array.from(state.notices), ['Displacement skipped: geometry has too few vertices']);
});

test('runner state machine: evaluate lands "failed" and forwards the evaluate result notices verbatim', async () => {
  const runner = makeRunner({}, async () => ({ offsets: null, notices: ['Displacement evaluation failed: boom'] }));
  runner.setSource({ key: 'a', mode: 'auto' });
  runner.build(fakeGeometry(10), 0);
  await runner.evaluate();
  const state = runner.getState();
  assert.equal(state.state, 'failed');
  assert.deepEqual(Array.from(state.notices), ['Displacement evaluation failed: boom']);
});

test('runner state machine: a superseded evaluate is dropped by the later one (token supersede)', async () => {
  let resolveFirst;
  const first = new Promise((res) => { resolveFirst = res; });
  let calls = 0;
  const runner = makeRunner({}, async () => {
    calls += 1;
    if (calls === 1) { await first; return { offsets: null, notices: ['first'] }; }
    return { offsets: null, notices: ['second'] };
  });
  runner.setSource({ key: 'a', mode: 'auto' });
  runner.build(fakeGeometry(10), 0);
  const p1 = runner.evaluate();
  const p2 = runner.evaluate(); // supersedes p1's token before p1's evaluateDisplacement resolves
  resolveFirst();
  await Promise.all([p1, p2]);
  assert.deepEqual(Array.from(runner.getState().notices), ['second']);
});

test('runner state machine: cancel() resolves settled() immediately, even mid-evaluation', async () => {
  let resolveEval;
  const pending = new Promise((res) => { resolveEval = res; });
  const runner = makeRunner({}, () => pending);
  runner.setSource({ key: 'a', mode: 'auto' });
  runner.build(fakeGeometry(10), 0);
  const evalPromise = runner.evaluate();
  assert.equal(runner.getState().state, 'pending');
  runner.cancel();
  await runner.settled(); // cancel() already cleared runInFlight, so this resolves right away
  resolveEval({ offsets: null, notices: [] });
  await evalPromise; // drains the now-superseded evaluate cleanly
});

test('runner state machine: off() cancels and reports state "off" without touching notices', () => {
  const runner = makeRunner();
  runner.setSource({ key: 'a', mode: 'auto' });
  runner.build(fakeGeometry(10), 0);
  runner.off();
  assert.equal(runner.getState().state, 'off');
});

test('runner state machine: reset() clears state to "none" and drops the source key/notices', () => {
  const runner = makeRunner();
  runner.setSource({ key: 'a', mode: 'auto' });
  assert.equal(runner.getSourceKey(), 'a');
  runner.reset();
  assert.equal(runner.getState().state, 'none');
  assert.equal(runner.getSourceKey(), null);
  assert.deepEqual(Array.from(runner.getState().notices), []);
});

test('runner state machine: debouncedEvaluate only runs the latest call, at debounceMs', async () => {
  const seen = [];
  const runner = makeRunner({ debounceMs: 15 }, async () => { seen.push('ran'); return { offsets: null, notices: [] }; });
  runner.setSource({ key: 'a', mode: 'auto' });
  runner.build(fakeGeometry(10), 0);
  const p1 = runner.debouncedEvaluate(() => true); // superseded, never runs
  const p2 = runner.debouncedEvaluate(() => true); // the one that actually evaluates
  await Promise.all([p1, p2]);
  assert.deepEqual(seen, ['ran']);
});

test('runner state machine: debouncedEvaluate skips the evaluate when prepare() returns false', async () => {
  let ran = false;
  const runner = makeRunner({ debounceMs: 10 }, async () => { ran = true; return { offsets: null, notices: [] }; });
  runner.setSource({ key: 'a', mode: 'auto' });
  runner.build(fakeGeometry(10), 0);
  await runner.debouncedEvaluate(() => false);
  assert.equal(ran, false);
});

test('runner state machine: runFirstBuild races a slow evaluate against firstBuildTimeoutMs, then lands it in the background', async () => {
  let resolveEval;
  const pending = new Promise((res) => { resolveEval = res; });
  const events = [];
  const runner = makeRunner(
    { firstBuildTimeoutMs: 10, onStatus: (state) => events.push(state) },
    () => pending
  );
  runner.setSource({ key: 'a', mode: 'auto' });
  runner.build(fakeGeometry(10), 0);
  await runner.runFirstBuild(); // resolves once the 10ms timeout wins the race
  assert.equal(runner.getState().state, 'pending');
  resolveEval({ offsets: null, notices: ['late'] });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(runner.getState().state, 'failed');
  assert.deepEqual(Array.from(runner.getState().notices), ['late']);
});

test('runner state machine: runFirstBuild skipped over budget reports the capped notice', async () => {
  const runner = makeRunner({
    budget: { perMesh: 10, pick: () => ({ level: 0, capped: true, triangles: 999, allowed: false }) },
  });
  runner.setSource({ key: 'a', mode: 'auto' });
  runner.build(fakeGeometry(10), 0);
  await runner.runFirstBuild();
  assert.equal(runner.getState().state, 'skipped');
  assert.match(runner.getState().notices[0], /Displacement skipped: base mesh has \d+ triangles, above the \d+ triangle budget/);
});
