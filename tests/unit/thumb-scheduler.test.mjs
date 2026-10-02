import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadModule() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'graph', 'thumb-scheduler.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.MtlxThumbScheduler;
}
const deepEq = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);
const { createScheduler } = loadModule();

const entry = (key, sig) => ({ key, sig, imageKey: key + '@' + sig, target: { id: key } });
const open = (now) => ({ now, previewBusy: false, cameraActive: false, hidden: false, active: true });
const noCache = () => false;

test('enable truth table: G x big x optIn x override x eligible', () => {
  for (const G of [true, false]) {
    for (const big of [true, false]) {
      for (const opt of [true, false]) {
        for (const ov of [undefined, 'on', 'off']) {
          for (const eligible of [true, false]) {
            const s = createScheduler();
            s.setGlobal(G);
            s.enterScope('S', big ? 51 : 50);
            if (opt && big) {
              // Opt in through the menu, then restore G to the case under test.
              if (!s.scopeOn('S')) s.toggleMenu('S');
              s.setGlobal(G);
            }
            const scopeOn = G && (!big || (opt && big));
            assert.equal(s.scopeOn('S'), scopeOn);
            if (ov) s.setOverride('S', 'n:a', ov === 'on');
            let expected = false;
            if (eligible) {
              if (ov === 'on') expected = true;
              else if (ov === 'off') expected = false;
              else expected = scopeOn;
            }
            const stored = ov && (ov === 'on') === scopeOn ? undefined : ov;
            assert.equal(s.isEnabled('S', 'n:a', eligible), eligible && (stored === 'on' || (stored !== 'off' && scopeOn)));
            assert.equal(s.isEnabled('S', 'n:a', eligible), expected);
          }
        }
      }
    }
  }
});

test('threshold is "more than 50" at entry only', () => {
  const s = createScheduler();
  s.enterScope('A', 50);
  assert.equal(s.scopeOn('A'), true);
  s.enterScope('A', 51);
  assert.equal(s.scopeOn('A'), false);
  s.keepScope('A');
  assert.equal(s.scopeOn('A'), false);
});

test('toggleMenu flips G in a small scope', () => {
  const s = createScheduler();
  s.enterScope('S', 3);
  assert.equal(s.toggleMenu('S'), false);
  assert.equal(s.getGlobal(), false);
  assert.equal(s.toggleMenu('S'), true);
  assert.equal(s.getGlobal(), true);
});

test('toggleMenu in a big scope uses optIn, turning on also sets G', () => {
  const s = createScheduler();
  s.setGlobal(false);
  s.enterScope('B', 80);
  assert.equal(s.toggleMenu('B'), true);
  assert.equal(s.getGlobal(), true);
  s.enterScope('Small', 3);
  assert.equal(s.scopeOn('Small'), true);
  assert.equal(s.toggleMenu('B'), false);
  assert.equal(s.getGlobal(), true);
  // Opt-in survives leaving and re-entering the big scope.
  s.toggleMenu('B');
  s.enterScope('B', 80);
  assert.equal(s.scopeOn('B'), true);
});

test('override is deleted when equal to the scope default', () => {
  const s = createScheduler();
  s.enterScope('S', 3);
  s.setOverride('S', 'n:a', false);
  assert.equal(s.isEnabled('S', 'n:a', true), false);
  s.setOverride('S', 'n:a', true);
  assert.equal(s.isEnabled('S', 'n:a', true), true);
  // Now flip the default: the stored state must be absent, so it follows the scope.
  s.toggleMenu('S');
  assert.equal(s.isEnabled('S', 'n:a', true), false);
  assert.equal(s.anyEnabled('S', ['n:a']), false);
});

test('multi-select overrides and anyEnabled', () => {
  const s = createScheduler();
  s.enterScope('S', 3);
  s.setOverrides('S', ['n:a', 'n:b'], false);
  assert.equal(s.anyEnabled('S', ['n:a', 'n:b']), false);
  assert.equal(s.anyEnabled('S', ['n:a', 'n:b', 'n:c']), true);
  assert.equal(s.anyEnabled('S', []), false);
  s.setGlobal(false);
  assert.equal(s.anyEnabled('S', ['n:a', 'n:b']), false);
  s.setOverrides('S', ['n:a', 'n:b'], true);
  assert.equal(s.anyEnabled('S', ['n:a', 'n:b']), true);
  assert.equal(s.isEnabled('S', 'n:b', true), true);
});

test('remapNode and remapScope carry overrides, optIn and bigAtEntry', () => {
  const s = createScheduler();
  s.enterScope('G1', 80);
  s.toggleMenu('G1');
  s.setOverride('G1', 'n:a', false);
  s.remapNode('G1', 'n:a', 'n:b');
  assert.equal(s.isEnabled('G1', 'n:b', true), false);
  assert.equal(s.isEnabled('G1', 'n:a', true), true);
  s.remapScope('G1', 'G2');
  assert.equal(s.scopeOn('G2'), true);
  assert.equal(s.isEnabled('G2', 'n:b', true), false);
  assert.equal(s.isEnabled('G1', 'n:b', true), s.scopeOn('G1'));
  assert.equal(s.scopeOn('G1'), true);
  s.enterScope('G1', 3);
  assert.equal(s.scopeOn('G1'), true);
  s.toggleMenu('G2');
  assert.equal(s.scopeOn('G2'), false);
});

test('resetSession clears overrides, optIn and bigAtEntry; keepScope does not', () => {
  const s = createScheduler();
  s.enterScope('S', 3);
  s.setOverride('S', 'n:a', false);
  s.enterScope('B', 90);
  s.toggleMenu('B');
  s.keepScope('S');
  assert.equal(s.isEnabled('S', 'n:a', true), false);
  assert.equal(s.scopeOn('B'), true);
  s.resetSession();
  assert.equal(s.isEnabled('S', 'n:a', true), true);
  assert.equal(s.scopeOn('B'), true);
  assert.equal(s.toggleMenu('B'), false);
});

test('invalidation drops a changed pending node and its dependents, enqueues misses only', () => {
  const s = createScheduler();
  s.applySignatures([entry('a', '1'), entry('b', '1'), entry('c', '1')], noCache);
  deepEq(s.pendingKeys(), ['a', 'b', 'c']);
  // b and c depend on a; a edit changes all three signatures.
  s.applySignatures([entry('a', '2'), entry('b', '2'), entry('c', '2')], noCache);
  deepEq(s.pendingKeys(), ['a', 'b', 'c']);
  deepEq(s.progress(), { done: 0, total: 3 });
  // Undo: signatures return to cached values, nothing to render.
  const cached = new Set(['a@1', 'b@1', 'c@1']);
  s.applySignatures([entry('a', '1'), entry('b', '1'), entry('c', '1')], (k) => cached.has(k));
  deepEq(s.pendingKeys(), []);
  assert.equal(s.progress(), null);
});

test('a key no longer desired is dropped from pending', () => {
  const s = createScheduler();
  s.applySignatures([entry('a', '1'), entry('b', '1')], noCache);
  s.applySignatures([entry('b', '1')], noCache);
  deepEq(s.pendingKeys(), ['b']);
  deepEq(s.progress(), { done: 0, total: 1 });
});

test('in-flight work is never cancelled, only flagged stale', () => {
  const s = createScheduler();
  s.applySignatures([entry('a', '1')], noCache);
  const job = s.nextJob(open(1000));
  assert.equal(job.key, 'a');
  assert.equal(s.isInFlightStale(), false);
  s.applySignatures([entry('a', '2')], noCache);
  assert.equal(s.isInFlightStale(), true);
  assert.equal(s.inFlightKey(), 'a');
  deepEq(s.pendingKeys(), ['a']);
  deepEq(s.progress(), { done: 0, total: 2 });
  // Back to the original sig before completion: no longer stale, the pending copy is dropped.
  s.applySignatures([entry('a', '1')], noCache);
  assert.equal(s.isInFlightStale(), false);
  deepEq(s.pendingKeys(), []);
  const done = s.complete('a');
  deepEq(done, { key: 'a', sig: '1', imageKey: 'a@1', stale: false });
  assert.equal(s.progress(), null);
});

test('progress X/N: add mid-batch, drop mid-batch, stale completion, batch end', () => {
  const s = createScheduler();
  assert.equal(s.progress(), null);
  s.applySignatures([entry('a', '1'), entry('b', '1')], noCache);
  deepEq(s.progress(), { done: 0, total: 2 });
  s.nextJob(open(1000));
  // Add mid-batch.
  s.applySignatures([entry('a', '1'), entry('b', '1'), entry('c', '1')], noCache);
  deepEq(s.progress(), { done: 0, total: 3 });
  // Drop mid-batch.
  s.applySignatures([entry('a', '1'), entry('b', '1')], noCache);
  deepEq(s.progress(), { done: 0, total: 2 });
  // Stale completion still counts.
  s.applySignatures([entry('a', '9'), entry('b', '1')], noCache);
  deepEq(s.progress(), { done: 0, total: 3 });
  assert.equal(s.complete('a').stale, true);
  deepEq(s.progress(), { done: 1, total: 3 });
  const check = () => {
    const p = s.progress();
    return p.done + (s.inFlightKey() ? 1 : 0) + s.pendingKeys().length === p.total;
  };
  assert.ok(check());
  while (s.progress()) {
    const j = s.nextJob(open(5000));
    assert.ok(j);
    assert.ok(check());
    s.complete(j.key);
  }
  assert.equal(s.progress(), null);
  // A new batch starts from zero.
  s.applySignatures([entry('z', '1')], noCache);
  deepEq(s.progress(), { done: 0, total: 1 });
});

test('cache hits are never counted and a hit-only update starts no batch', () => {
  const s = createScheduler();
  s.applySignatures([entry('a', '1'), entry('b', '1')], (k) => k === 'a@1');
  deepEq(s.progress(), { done: 0, total: 1 });
  const s2 = createScheduler();
  s2.applySignatures([entry('a', '1')], () => true);
  assert.equal(s2.progress(), null);
});

test('quiet gate and busy flags', () => {
  const s = createScheduler({ quietMs: 400 });
  s.applySignatures([entry('a', '1')], noCache);
  s.noteActivity(1000);
  assert.equal(s.canDispatch(open(1399)), false);
  assert.equal(s.quietRemaining(1100), 300);
  assert.equal(s.canDispatch(open(1400)), true);
  for (const k of ['previewBusy', 'cameraActive', 'hidden']) {
    assert.equal(s.canDispatch({ ...open(2000), [k]: true }), false, k);
  }
  assert.equal(s.canDispatch({ ...open(2000), active: false }), false);
  assert.equal(s.nextJob({ ...open(2000), previewBusy: true }), null);
  s.noteActivity(1900);
  assert.equal(s.nextJob(open(2000)), null);
  assert.equal(s.nextJob(open(2300)).key, 'a');
  s.noteActivity(100);
  assert.equal(s.quietRemaining(2300), 0);
});

test('only one job in flight', () => {
  const s = createScheduler();
  s.applySignatures([entry('a', '1'), entry('b', '1')], noCache);
  const j = s.nextJob(open(1000));
  assert.equal(j.key, 'a');
  assert.equal(s.canDispatch(open(2000)), false);
  assert.equal(s.nextJob(open(2000)), null);
  assert.equal(s.complete('b'), null);
  assert.ok(s.complete('a'));
  assert.equal(s.nextJob(open(2000)).key, 'b');
});

test('visible entries go first by y then x, the rest keep their order', () => {
  const s = createScheduler();
  s.applySignatures(['a', 'b', 'c', 'd', 'e'].map((k) => entry(k, '1')), noCache);
  const order = s.priorityOrder(['e', 'c', 'b'], {
    b: { x: 50, y: 10 },
    c: { x: 10, y: 10 },
    e: { x: 0, y: 0 },
    a: { x: 0, y: 0 },
  });
  deepEq(order, ['e', 'c', 'b', 'a', 'd']);
  assert.equal(s.nextJob(open(1000)).key, 'e');
});

test('size: global default small, overrides drop when equal to the global', () => {
  const s = createScheduler();
  assert.equal(s.getGlobalSize(), 'small');
  assert.equal(s.sizeOf('S', 'n:a'), 'small');
  s.setSizeOverride('S', 'n:a', 'large');
  assert.equal(s.sizeOf('S', 'n:a'), 'large');
  assert.equal(s.sizeOf('S', 'n:b'), 'small');
  s.setSizeOverride('S', 'n:a', 'small');
  assert.equal(s.sizeOf('S', 'n:a'), 'small');
  s.setSizeOverrides('S', ['n:a', 'n:b'], 'large');
  assert.equal(s.sizeOf('S', 'n:b'), 'large');
  // Flipping the global to large makes those overrides redundant, so they go.
  s.setGlobalSize('large');
  assert.equal(s.sizeOf('S', 'n:a'), 'large');
  s.setSizeOverride('S', 'n:a', 'small');
  assert.equal(s.sizeOf('S', 'n:a'), 'small');
  assert.equal(s.toggleMenuSize(), 'small');
  assert.equal(s.sizeOf('S', 'n:a'), 'small');
  assert.equal(s.sizeOf('S', 'n:b'), 'small');
});

test('size overrides follow rename, survive keepScope, clear on resetSession', () => {
  const s = createScheduler();
  s.setSizeOverride('G1', 'n:a', 'large');
  s.remapNode('G1', 'n:a', 'n:b');
  assert.equal(s.sizeOf('G1', 'n:b'), 'large');
  assert.equal(s.sizeOf('G1', 'n:a'), 'small');
  s.remapScope('G1', 'G2');
  assert.equal(s.sizeOf('G2', 'n:b'), 'large');
  assert.equal(s.sizeOf('G1', 'n:b'), 'small');
  s.keepScope('G2');
  assert.equal(s.sizeOf('G2', 'n:b'), 'large');
  s.resetSession();
  assert.equal(s.sizeOf('G2', 'n:b'), 'small');
  assert.equal(s.getGlobalSize(), 'small', 'the global preference outlives a new document');
});

// ---- Shader kind ----
const sEntry = (key, sig, kind) => Object.assign(entry(key, sig), { kind });
const shaderGate = (now, extra) => Object.assign(open(now), { sceneReady: true, parallelCompile: true }, extra);

test('kind truth table: defaultOn = scopeOn && (pattern || Gs)', () => {
  for (const G of [true, false]) {
    for (const Gs of [true, false]) {
      for (const big of [true, false]) {
        for (const ov of [undefined, 'on', 'off']) {
          for (const kind of ['pattern', 'shader']) {
            const s = createScheduler();
            s.setGlobal(G);
            s.setShaderGlobal(Gs);
            s.enterScope('S', big ? 51 : 3);
            const base = G && !big;
            const expectDefault = base && (kind === 'pattern' || Gs);
            assert.equal(s.defaultOn('S', kind), expectDefault);
            if (ov) s.setOverride('S', 'n:a', ov === 'on', kind);
            const expected = ov === 'on' ? true : ov === 'off' ? false : expectDefault;
            assert.equal(s.isEnabled('S', 'n:a', true, kind), expected);
            assert.equal(s.isEnabled('S', 'n:a', false, kind), false);
          }
        }
      }
    }
  }
});

test('the shader preference defaults off and toggleShaderMenu flips it', () => {
  const s = createScheduler();
  assert.equal(s.getShaderGlobal(), false);
  assert.equal(s.isEnabled('S', 'n:a', true, 'shader'), false);
  assert.equal(s.isEnabled('S', 'n:a', true, 'pattern'), true);
  assert.equal(s.toggleShaderMenu(), true);
  assert.equal(s.isEnabled('S', 'n:a', true, 'shader'), true);
  assert.equal(s.toggleShaderMenu(), false);
});

test('an override equal to the default of its own kind is deleted', () => {
  const s = createScheduler();
  s.enterScope('S', 3);
  // Pattern: default on, so "on" stores nothing and "off" stores an override.
  s.setOverride('S', 'p', true, 'pattern');
  assert.equal(s.isEnabled('S', 'p', true, 'pattern'), true);
  s.setOverride('S', 'p', false, 'pattern');
  assert.equal(s.isEnabled('S', 'p', true, 'pattern'), false);
  // Shader with Gs off: default off, so "on" is stored, "off" clears it.
  s.setOverride('S', 'm', true, 'shader');
  assert.equal(s.isEnabled('S', 'm', true, 'shader'), true);
  s.setShaderGlobal(true);
  // Now the default is on: setting "on" deletes the override, a later Gs off turns it off again.
  s.setOverride('S', 'm', true, 'shader');
  s.setShaderGlobal(false);
  assert.equal(s.isEnabled('S', 'm', true, 'shader'), false);
  s.setOverride('S', 'm', false, 'shader');
  s.setShaderGlobal(true);
  assert.equal(s.isEnabled('S', 'm', true, 'shader'), true);
});

test('anyEnabled looks at the kind of each eligible card', () => {
  const s = createScheduler();
  s.enterScope('S', 3);
  const shaders = [{ id: 'a', kind: 'shader' }, { id: 'b', kind: 'shader' }];
  assert.equal(s.anyEnabled('S', shaders), false);
  assert.equal(s.anyEnabled('S', [{ id: 'p', kind: 'pattern' }, ...shaders]), true);
  assert.equal(s.anyEnabled('S', ['p']), true);
  s.setOverride('S', 'b', true, 'shader');
  assert.equal(s.anyEnabled('S', shaders), true);
  s.setOverride('S', 'b', false, 'shader');
  s.setShaderGlobal(true);
  assert.equal(s.anyEnabled('S', shaders), true);
  s.setOverride('S', 'a', false, 'shader');
  s.setOverride('S', 'b', false, 'shader');
  assert.equal(s.anyEnabled('S', shaders), false);
});

test('queue classes: visible patterns, other patterns, visible shaders, other shaders', () => {
  const s = createScheduler({ quietMs: 0 });
  s.applySignatures([
    sEntry('s2', '1', 'shader'), sEntry('p2', '1', 'pattern'), sEntry('s1', '1', 'shader'), sEntry('p1', '1', 'pattern'),
  ], noCache);
  deepEq(s.priorityOrder(['s1', 'p1'], {}), ['p1', 'p2', 's1', 's2']);
  const order = [];
  for (let i = 0; i < 4; i++) {
    const j = s.nextJob(shaderGate(1000 + i));
    order.push(j.key);
    s.complete(j.key);
  }
  assert.deepEqual(order, ['p1', 'p2', 's1', 's2']);
});

test('the shader class waits for sceneReady and parallelCompile, patterns never do', () => {
  const s = createScheduler({ quietMs: 0 });
  s.applySignatures([sEntry('s1', '1', 'shader')], noCache);
  assert.equal(s.nextJob(open(1000)), null);
  assert.equal(s.nextJob(shaderGate(1000, { parallelCompile: false })), null);
  assert.equal(s.wantsScene(shaderGate(1000, { sceneReady: false })), true);
  assert.equal(s.wantsScene(shaderGate(1000, { sceneReady: false, parallelCompile: false })), false);
  assert.equal(s.wantsScene(shaderGate(1000)), false);
  s.applySignatures([sEntry('s1', '1', 'shader'), sEntry('p1', '1', 'pattern')], noCache);
  assert.equal(s.wantsScene(shaderGate(1000, { sceneReady: false })), false, 'a pattern job is next');
  assert.equal(s.nextJob(open(1000)).key, 'p1');
});

test('preempt: a pending pattern job asks a running shader job to give way; requeue keeps X/N', () => {
  const s = createScheduler({ quietMs: 0 });
  s.applySignatures([sEntry('s1', '1', 'shader'), sEntry('s2', '1', 'shader')], noCache);
  deepEq(s.progress(), { done: 0, total: 2 });
  const job = s.nextJob(shaderGate(1000));
  assert.equal(job.key, 's1');
  assert.equal(s.inFlightKind(), 'shader');
  assert.equal(s.wantsPreempt(), false);
  s.applySignatures([sEntry('s1', '1', 'shader'), sEntry('s2', '1', 'shader'), sEntry('p1', '1', 'pattern')], noCache);
  assert.equal(s.wantsPreempt(), true);
  deepEq(s.progress(), { done: 0, total: 3 });
  s.complete('s1', { requeue: true });
  deepEq(s.progress(), { done: 0, total: 3 }, 'the requeued job is not counted done');
  assert.equal(s.wantsPreempt(), false);
  s.priorityOrder([], {});
  // The pattern goes first, then the requeued shader leads its class.
  const order = [];
  for (let i = 0; i < 3; i++) {
    const j = s.nextJob(shaderGate(1000 + i));
    order.push(j.key);
    s.complete(j.key);
  }
  assert.deepEqual(order, ['p1', 's1', 's2']);
  assert.equal(s.progress(), null);
});

test('a pattern job in flight is never preempted and a stale shader job is not requeued', () => {
  const s = createScheduler({ quietMs: 0 });
  s.applySignatures([sEntry('p1', '1', 'pattern'), sEntry('s1', '1', 'shader')], noCache);
  assert.equal(s.nextJob(shaderGate(1000)).key, 'p1');
  assert.equal(s.wantsPreempt(), false);
  s.complete('p1');
  assert.equal(s.nextJob(shaderGate(1001)).key, 's1');
  s.applySignatures([sEntry('s1', '2', 'shader')], noCache);
  assert.equal(s.isInFlightStale(), true);
  s.complete('s1', { requeue: true });
  deepEq(s.pendingKeys(), ['s1']);
  assert.equal(s.nextJob(shaderGate(1002)).sig, '2');
});

test('a shader job whose image key changed (scene change) is stale even with the same signature', () => {
  const s = createScheduler({ quietMs: 0 });
  s.applySignatures([sEntry('s1', '1', 'shader')], noCache);
  s.nextJob(shaderGate(1000));
  s.applySignatures([Object.assign(sEntry('s1', '1', 'shader'), { imageKey: 's1@1|scene2' })], noCache);
  assert.equal(s.isInFlightStale(), true);
  deepEq(s.pendingKeys(), ['s1']);
});

const win = (now, n, extra) => shaderGate(now, Object.assign({ patternWindow: n }, extra));

test('window: up to patternWindow pattern jobs in flight, the default stays one', () => {
  const s = createScheduler({ quietMs: 0 });
  const ents = [];
  for (let i = 0; i < 10; i++) ents.push(sEntry('p' + i, '1', 'pattern'));
  s.applySignatures(ents, noCache);
  assert.equal(s.nextJob(open(1000)).key, 'p0');
  assert.equal(s.nextJob(open(1000)), null, 'no window means one at a time');
  s.complete('p0');
  const keys = [];
  for (let i = 0; i < 12; i++) { const j = s.nextJob(win(1000, 8)); if (j) keys.push(j.key); }
  assert.equal(keys.length, 8);
  assert.equal(s.inFlightCount(), 8);
  const p = s.progress();
  assert.equal(p.done + s.inFlightCount() + s.pendingKeys().length, p.total, 'X + inFlight + pending == N');
  s.complete('p3');
  assert.equal(s.nextJob(win(1000, 8)).key, 'p9');
  assert.equal(s.nextJob(win(1000, 8)), null);
});

test('window: the gate closes new dispatches only, in-flight jobs finish and count', () => {
  const s = createScheduler({ quietMs: 0 });
  s.applySignatures([sEntry('a', '1', 'pattern'), sEntry('b', '1', 'pattern'), sEntry('c', '1', 'pattern')], noCache);
  s.nextJob(win(1000, 8));
  s.nextJob(win(1000, 8));
  assert.equal(s.nextJob(win(1000, 8, { previewBusy: true })), null);
  assert.equal(s.inFlightCount(), 2);
  s.complete('b');
  s.complete('a');
  deepEq(s.progress(), { done: 2, total: 3 });
  assert.equal(s.nextJob(win(1000, 8)).key, 'c');
  s.complete('c');
  assert.equal(s.progress(), null);
});

test('window: stale is tracked per job and a re-queued key waits for its stale run', () => {
  const s = createScheduler({ quietMs: 0 });
  s.applySignatures([sEntry('a', '1', 'pattern'), sEntry('b', '1', 'pattern')], noCache);
  s.nextJob(win(1000, 8));
  s.nextJob(win(1000, 8));
  s.applySignatures([sEntry('a', '2', 'pattern'), sEntry('b', '1', 'pattern')], noCache);
  assert.equal(s.isStale('a'), true);
  assert.equal(s.isStale('b'), false);
  deepEq(s.pendingKeys(), ['a']);
  deepEq(s.progress(), { done: 0, total: 3 });
  assert.equal(s.nextJob(win(1000, 8)), null, 'the same key is never in flight twice');
  assert.equal(s.complete('a').stale, true);
  assert.equal(s.nextJob(win(1000, 8)).sig, '2');
  s.complete('b');
  s.complete('a');
  assert.equal(s.progress(), null);
});

test('window: shader jobs wait for every pattern job, requeue of a shader job is unaffected', () => {
  const s = createScheduler({ quietMs: 0 });
  s.applySignatures([sEntry('p1', '1', 'pattern'), sEntry('s1', '1', 'shader'), sEntry('s2', '1', 'shader')], noCache);
  assert.equal(s.nextJob(win(1000, 8)).key, 'p1');
  assert.equal(s.nextJob(win(1000, 8)), null, 'a shader does not start beside a pattern job');
  assert.equal(s.wantsScene(win(1000, 8, { sceneReady: false })), false);
  s.complete('p1');
  assert.equal(s.nextJob(win(1000, 8)).key, 's1');
  assert.equal(s.nextJob(win(1000, 8)), null, 'one shader job at a time');
  s.applySignatures([sEntry('s1', '1', 'shader'), sEntry('s2', '1', 'shader'), sEntry('p2', '1', 'pattern')], noCache);
  assert.equal(s.wantsPreempt(), true);
  s.complete('s1', { requeue: true });
  deepEq(s.progress(), { done: 1, total: 4 });
  s.priorityOrder([], {});
  assert.equal(s.nextJob(win(1000, 8)).key, 'p2');
  assert.equal(s.nextJob(win(1000, 8)), null);
});

test('prepare: head pattern jobs only, in priority order, never shader or in-flight ones', () => {
  const s = createScheduler({ quietMs: 400 });
  s.noteActivity(1000);
  s.applySignatures([sEntry('s1', '1', 'shader'), sEntry('p1', '1', 'pattern'), sEntry('p2', '1', 'pattern'), sEntry('p3', '1', 'pattern')], noCache);
  s.priorityOrder([], {});
  assert.equal(s.canPrepare({ now: 1100, previewBusy: false, cameraActive: false }), true, 'quiet period');
  assert.equal(s.canPrepare({ now: 1500, previewBusy: false, cameraActive: false }), false, 'gate open: render instead');
  assert.equal(s.canPrepare({ now: 1500, previewBusy: true, cameraActive: false }), true);
  assert.equal(s.canPrepare({ now: 1500, previewBusy: false, cameraActive: true }), true);
  deepEq(s.prepareCandidates(2).map((j) => j.key), ['p1', 'p2']);
  assert.equal(s.prepareCandidates(8).length, 3, 'the shader job is never a candidate');
  assert.equal(s.prepareCandidates(1)[0].sig, '1');
  deepEq(s.prepareCandidates(1)[0].target, { id: 'p1' });
  s.nextJob({ now: 2000, previewBusy: false, cameraActive: false, hidden: false, active: true, patternWindow: 8 });
  assert.equal(s.canPrepare({ now: 2000, previewBusy: true }), false, 'nothing is prepared while a job is in flight');
});

test('early scene: only with the gate open, a shader pending and no pattern left to post', () => {
  const s = createScheduler({ quietMs: 0 });
  const g = (o) => Object.assign({ now: 1000, previewBusy: false, cameraActive: false, hidden: false, active: true, sceneReady: false, parallelCompile: true, patternWindow: 8 }, o);
  assert.equal(s.wantsSceneEarly(g()), false, 'nothing pending');
  s.applySignatures([sEntry('p1', '1', 'pattern'), sEntry('s1', '1', 'shader')], noCache);
  s.priorityOrder([], {});
  assert.equal(s.wantsSceneEarly(g()), false, 'a pattern job is still to post');
  s.nextJob(g());
  assert.equal(s.wantsSceneEarly(g()), true, 'patterns all posted, a shader waits');
  assert.equal(s.wantsSceneEarly(g({ previewBusy: true })), false);
  assert.equal(s.wantsSceneEarly(g({ cameraActive: true })), false);
  assert.equal(s.wantsSceneEarly(g({ sceneReady: true })), false);
  assert.equal(s.wantsSceneEarly(g({ parallelCompile: false })), false);
  assert.equal(s.wantsSceneEarly(g({ hidden: true })), false);
});
