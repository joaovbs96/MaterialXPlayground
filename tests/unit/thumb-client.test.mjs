import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => fs.readFileSync(path.join(root, 'js', 'graph', f), 'utf8');
const SEP = '\u0000';

// A sandboxed page: fake timers, Worker, storage and engine globals.
function makeEnv({ stored = null, shader = null } = {}) {
  let clock = 1000;
  let nextId = 1;
  const timers = new Map();
  const workers = [];
  const store = new Map(stored == null ? [] : [['mtlxGraphThumbnails', stored]]);
  if (shader != null) store.set('mtlxGraphShaderThumbnails', shader);
  const envSrc = { id: 'default', url: 'hdr/room.hdr', ext: '.hdr' };
  const fetchCalls = [];
  class FakeWorker {
    constructor(url, o) {
      this.url = url; this.opts = o; this.posted = []; this.terminated = false;
      workers.push(this);
    }
    postMessage(m) { this.posted.push(m); }
    terminate() { this.terminated = true; }
    emit(m) { this.onmessage({ data: Object.assign({ v: 1 }, m) }); }
    types() { return this.posted.map((m) => m.type); }
  }
  const sandbox = {
    URL, Promise, JSON, Math, Date, Object, Array, Set, Map, Number, String, Error, Infinity, NaN, Uint8Array,
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: clock + (ms || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    performance: { now: () => clock },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
    },
    document: { baseURI: 'http://localhost/index.html', hidden: false },
    Worker: FakeWorker,
    fetch: async (url) => { fetchCalls.push(url); return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; },
    getMxEnv: async () => ({ version: '1.39.5', lightData: [{}, {}] }),
    MtlxVendor: { url: (id, f) => `http://localhost/vendor/${id}/${f}` },
    MtlxGenCore: { hostSnapshot: () => ({ lightLimit: true }) },
    MtlxThreeMaterial: { hostSnapshot: () => ({ specularEnvMethod: 'a', diffuseEnvMethod: 'b', sceneTextureFast: true }) },
    MtlxRenderSettings: { get: () => false },
    getEnvironmentSource: () => envSrc,
    getKeyLightEnabled: () => false,
    getTextureAnisotropy: () => 8,
    getForceTransparency: () => false,
    getDisplacementEnabled: () => true,
    getDisplayTransform: () => 'srgb',
    getDisplayExposure: () => 0,
    devicePixelRatio: 1,
    listeners: new Map(),
  };
  sandbox.addEventListener = (n, fn) => { sandbox.listeners.set(n, fn); };
  sandbox.removeEventListener = (n) => { sandbox.listeners.delete(n); };
  vm.createContext(sandbox);
  vm.runInContext(read('thumb-scheduler.js'), sandbox);
  vm.runInContext(read('thumb-client.js'), sandbox);
  const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  const advance = async (ms) => {
    const end = clock + ms;
    for (;;) {
      let best = null;
      for (const [id, t] of timers) if (t.at <= end && (!best || t.at < best.t.at)) best = { id, t };
      if (!best) break;
      timers.delete(best.id);
      clock = Math.max(clock, best.t.at);
      best.t.fn();
      await settle();
    }
    clock = end;
    await settle();
  };
  return { sandbox, workers, timers, fetchCalls, store, advance, settle, envSrc, Client: sandbox.MtlxThumbClient };
}

const card = (id, extra = {}) => Object.assign({ id, eligible: true, target: { id, scope: '' }, x: 0, y: 0 }, extra);
const keyOf = (id, scope = '') => scope + SEP + id;
const deepEq = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);
const bitmap = (w = 238, h = 238) => ({ width: w, height: h, closed: false, close() { this.closed = true; } });

// Brings a client to "worker ready, setDocument posted" for the given cards.
async function boot(env, client, cards) {
  client.noteXml('<materialx v="1"/>');
  client.setScope('', cards, { entered: true });
  await env.advance(0);
  const w = env.workers[0];
  w.emit({ type: 'ready', capabilities: {} });
  await env.settle();
  return w;
}
const answerSigs = (w, sigOf) => {
  const m = w.posted.filter((p) => p.type === 'setDocument' || p.type === 'requestSignatures').pop();
  const sigs = {};
  for (const k of m.keys) sigs[k.key] = sigOf(k.key);
  w.emit({ type: 'signatures', docSeq: m.docSeq, sigs, missing: [] });
  return m;
};
const renders = (w) => w.posted.filter((p) => p.type === 'render');

test('nothing is created while thumbnails are off', async () => {
  // Global preference off.
  let env = makeEnv({ stored: 'false' });
  let client = env.Client.create({});
  client.noteXml('<materialx/>');
  client.setScope('', [card('n:a'), card('n:b')], { entered: true });
  client.setVisible(['n:a']);
  client.noteActivity();
  client.noteFiles({ 'a.png': {} });
  client.noteCanvasIdle();
  await env.advance(10000);
  assert.equal(env.workers.length, 0);
  assert.equal(env.fetchCalls.length, 0);
  assert.equal(env.timers.size, 0);
  assert.equal(env.sandbox.listeners.size, 0);
  assert.equal(client.get(keyOf('n:a')).state, 'off');

  // Big scope at entry with no opt-in.
  env = makeEnv();
  client = env.Client.create({});
  const many = Array.from({ length: 51 }, (_, i) => card('n:' + i));
  client.noteXml('<materialx/>');
  client.setScope('', many, { entered: true });
  client.noteActivity();
  await env.advance(10000);
  assert.equal(env.workers.length, 0);
  assert.equal(env.timers.size, 0);
  const ms = client.menuState('');
  assert.equal(ms.checked, false);
  assert.equal(ms.big, true);
  assert.match(ms.title, /more than 50/);

  // Scope with no eligible cards.
  env = makeEnv();
  client = env.Client.create({});
  client.setScope('', [card('n:a', { eligible: false })], { entered: true });
  await env.advance(10000);
  assert.equal(env.workers.length, 0);
});

test('enabling creates exactly one worker and posts init then setDocument', async () => {
  const env = makeEnv();
  const client = env.Client.create({});
  const w = await boot(env, client, [card('n:a'), card('n:b')]);
  assert.equal(env.workers.length, 1);
  assert.equal(w.opts.type, 'module');
  assert.equal(w.opts.name, 'mtlx-thumbnails');
  deepEq(w.types(), ['init', 'setDocument']);
  const init = w.posted[0];
  assert.equal(init.mtlx.version, '1.39.5');
  assert.equal(init.rigLights.length, 2);
  assert.match(init.three.url, /vendor\/three\/three\.min\.js$/);
  assert.equal(env.fetchCalls.length, 2);
  const doc = w.posted[1];
  assert.equal(doc.xml, '<materialx v="1"/>');
  deepEq(doc.keys.map((k) => k.key), [keyOf('n:a'), keyOf('n:b')]);
  deepEq(doc.settings, { compoundRoot: false });
  assert.equal(client.get(keyOf('n:a')).state, 'pending');
  // A per-node opt-in works in a big scope too.
  const env2 = makeEnv();
  const c2 = env2.Client.create({});
  c2.noteXml('<materialx/>');
  c2.setScope('', Array.from({ length: 51 }, (_, i) => card('n:' + i)), { entered: true });
  await env2.advance(1000);
  assert.equal(env2.workers.length, 0);
  c2.setOverride('', 'n:3', true);
  await env2.advance(1000);
  assert.equal(env2.workers.length, 1);
  c2.dispose();
  client.dispose();
});

test('activity delays the post and identical XML is not reposted', async () => {
  const env = makeEnv();
  const client = env.Client.create({});
  const w = await boot(env, client, [card('n:a')]);
  answerSigs(w, () => 'S1');
  await env.settle();
  await env.advance(1000);
  const count = () => w.posted.filter((m) => m.type === 'setDocument').length;
  assert.equal(count(), 1);

  client.noteXml('<materialx v="2"/>');
  await env.advance(300);
  client.noteActivity();
  await env.advance(300);
  assert.equal(count(), 1, 'still inside the quiet period');
  client.noteActivity();
  await env.advance(300);
  assert.equal(count(), 1);
  await env.advance(150);
  assert.equal(count(), 2);

  // The same text again, and activity without a change, post nothing.
  client.noteXml('<materialx v="2"/>');
  client.noteActivity();
  await env.advance(2000);
  assert.equal(count(), 2);
  assert.equal(w.posted.filter((m) => m.type === 'requestSignatures').length, 0);
  client.dispose();
});

test('cache hits skip rendering; a stale result is cached but not shown', async () => {
  const env = makeEnv();
  const client = env.Client.create({});
  const A = keyOf('n:a');
  const w = await boot(env, client, [card('n:a')]);
  answerSigs(w, () => 'S1');
  await env.advance(0);
  assert.equal(renders(w).length, 1);
  const bm1 = bitmap();
  const job1 = renders(w)[0];
  assert.equal(job1.size, 238, 'always the large size, times the device pixel ratio (1 here), even when the global size is small');
  assert.equal(job1.sig, 'S1');
  w.emit({ type: 'result', jobId: job1.jobId, key: A, sig: 'S1', bitmap: bm1, notices: [], approx: false });
  await env.settle();
  assert.equal(client.get(A).state, 'ready');
  assert.equal(client.get(A).bitmap, bm1);
  const stable = client.get(A);
  assert.equal(client.get(A), stable, 'get returns a stable object');

  // A re-parse with the same signature is a cache hit: no render.
  client.noteXml('<materialx v="2"/>');
  await env.advance(500);
  answerSigs(w, () => 'S1');
  await env.advance(1000);
  assert.equal(renders(w).length, 1);
  assert.equal(client.get(A).state, 'ready');

  // Start a render for S2, then change the node again before the result lands.
  client.noteXml('<materialx v="3"/>');
  await env.advance(500);
  answerSigs(w, () => 'S2');
  await env.advance(0);
  const job2 = renders(w)[1];
  assert.equal(job2.sig, 'S2');
  client.noteXml('<materialx v="4"/>');
  await env.advance(500);
  answerSigs(w, () => 'S3');
  await env.settle();
  const bm2 = bitmap();
  w.emit({ type: 'result', jobId: job2.jobId, key: A, sig: 'S2', bitmap: bm2, notices: [], approx: false });
  await env.settle();
  assert.notEqual(client.get(A).bitmap, bm2, 'stale image is not displayed');
  assert.equal(client.get(A).state, 'pending');
  assert.equal(client.get(A).bitmap, bm1, 'the old image stays while pending');
  assert.equal(bm2.closed, false);
  // Going back to S2 is now a cache hit.
  client.noteXml('<materialx v="5"/>');
  await env.advance(500);
  const before = renders(w).length;
  answerSigs(w, () => 'S2');
  await env.advance(1000);
  assert.equal(renders(w).length, before);
  assert.equal(client.get(A).bitmap, bm2);
  client.dispose();
});

test('image cache is a 64 MB byte budget: oldest go first, closed, current ones stay', async () => {
  const env = makeEnv();
  const client = env.Client.create({});
  const A = keyOf('n:a');
  const w = await boot(env, client, [card('n:a')]);
  const bms = [];
  for (let v = 1; v <= 5; v++) {
    if (v > 1) { client.noteXml('<materialx v="' + v + '"/>'); await env.advance(500); }
    answerSigs(w, () => 'S' + v);
    await env.advance(0);
    const job = renders(w)[v - 1];
    assert.equal(job.sig, 'S' + v);
    const bm = bitmap(2048, 2048); // 16 MB each
    bms.push(bm);
    w.emit({ type: 'result', jobId: job.jobId, key: A, sig: 'S' + v, bitmap: bm, notices: [], approx: false });
    await env.settle();
  }
  assert.equal(bms[0].closed, true, 'the oldest image is evicted and closed once 64 MB is exceeded');
  for (let i = 1; i < 5; i++) assert.equal(bms[i].closed, false);
  assert.equal(client.get(A).bitmap, bms[4], 'the current image stays');
  client.dispose();
});

test('errors stick to a signature and approximate results are flagged', async () => {
  const env = makeEnv();
  const client = env.Client.create({});
  const [A, B] = [keyOf('n:a'), keyOf('n:b')];
  const w = await boot(env, client, [card('n:a'), card('n:b', { y: 5 })]);
  answerSigs(w, (k) => (k === A ? 'S1' : 'T1'));
  await env.advance(0);
  const j1 = renders(w)[0];
  w.emit({ type: 'error', jobId: j1.jobId, key: j1.key, sig: j1.sig, kind: 'compile', message: 'bad shader' });
  await env.settle();
  assert.equal(client.get(j1.key).state, 'error');
  assert.equal(client.get(j1.key).title, 'bad shader');
  const j2 = renders(w)[1];
  w.emit({ type: 'result', jobId: j2.jobId, key: j2.key, sig: j2.sig, bitmap: bitmap(), notices: ['KTX2 note'], approx: true });
  await env.settle();
  assert.equal(client.get(j2.key).state, 'approx');
  // Same signature after a re-parse: still errored, not retried.
  const n = renders(w).length;
  client.noteXml('<materialx v="2"/>');
  await env.advance(500);
  answerSigs(w, (k) => (k === A ? 'S1' : 'T1'));
  await env.advance(1000);
  assert.equal(renders(w).length, n);
  assert.equal(client.get(j1.key).state, 'error');
  void B;
  client.dispose();
});

test('crash recovery: recreate lazily, then give up after three crashes', async () => {
  const env = makeEnv();
  const client = env.Client.create({});
  const A = keyOf('n:a');
  let w = await boot(env, client, [card('n:a')]);
  answerSigs(w, () => 'S1');
  await env.advance(0);
  assert.equal(renders(w).length, 1);

  w.onerror({ message: 'boom' });
  await env.settle();
  assert.equal(w.terminated, true);
  assert.equal(client.get(A).state, 'error');
  assert.equal(client.get(A).title, 'Renderer crashed on this node');

  // Recreated lazily with init and the document again.
  await env.advance(500);
  assert.equal(env.workers.length, 2);
  w = env.workers[1];
  w.emit({ type: 'ready', capabilities: {} });
  await env.settle();
  deepEq(w.types(), ['init', 'setDocument']);
  assert.equal(w.posted[1].xml, '<materialx v="1"/>');

  w.emit({ type: 'fatal', message: 'wasm abort' });
  await env.advance(500);
  assert.equal(env.workers.length, 3);
  w = env.workers[2];
  w.emit({ type: 'ready', capabilities: {} });
  await env.settle();
  assert.equal(client.menuState('').disabled, false);
  w.emit({ type: 'fatal', message: 'again' });
  await env.advance(5000);
  assert.equal(env.workers.length, 3, 'no fourth worker');
  const ms = client.menuState('');
  assert.equal(ms.disabled, true);
  assert.equal(ms.title, 'Thumbnails stopped after repeated errors');
  assert.equal(client.isEnabled('', 'n:a', true), false);
  assert.equal(env.timers.size, 0);
  client.dispose();
});

test('context loss re-queues once, then backs off after three losses', async () => {
  const env = makeEnv();
  const client = env.Client.create({});
  const A = keyOf('n:a');
  const w = await boot(env, client, [card('n:a')]);
  answerSigs(w, () => 'S1');
  await env.advance(0);
  let job = renders(w)[0];
  w.emit({ type: 'error', jobId: job.jobId, key: A, sig: 'S1', kind: 'context', message: 'lost' });
  await env.advance(0);
  assert.equal(renders(w).length, 2, 'retried once');
  job = renders(w)[1];
  w.emit({ type: 'error', jobId: job.jobId, key: A, sig: 'S1', kind: 'context', message: 'lost' });
  await env.advance(1000);
  assert.equal(renders(w).length, 2, 'second loss on the same signature is an error');
  assert.equal(client.get(A).state, 'error');
  client.dispose();
});

test('the gate holds jobs back and polling stops when nothing is pending', async () => {
  const env = makeEnv();
  let busy = true;
  const client = env.Client.create({ getPreviewBusy: () => busy });
  const A = keyOf('n:a');
  const w = await boot(env, client, [card('n:a')]);
  answerSigs(w, () => 'S1');
  await env.advance(2000);
  assert.equal(renders(w).length, 0, 'preview busy');
  assert.ok(env.timers.size > 0, 'polling while a job is pending');
  busy = false;
  await env.advance(300);
  assert.equal(renders(w).length, 1);
  w.emit({ type: 'result', jobId: renders(w)[0].jobId, key: A, sig: 'S1', bitmap: bitmap(), notices: [], approx: false });
  await env.settle();
  // Only the idle terminate timer is left.
  assert.equal(env.timers.size, 1);
  await env.advance(121000);
  assert.equal(w.terminated, true, 'worker released after the idle period');
  assert.equal(env.timers.size, 0);
  client.dispose();
});

test('turning thumbnails off releases everything', async () => {
  const env = makeEnv();
  const seen = [];
  const client = env.Client.create({ onProgress: (p) => seen.push(p) });
  const w = await boot(env, client, [card('n:a')]);
  answerSigs(w, () => 'S1');
  await env.advance(0);
  assert.equal(env.sandbox.listeners.size, 5);
  deepEq(seen[seen.length - 1], { done: 0, total: 1 });
  assert.equal(client.toggleMenu(''), false);
  await env.settle();
  assert.equal(w.terminated, true);
  assert.equal(env.sandbox.listeners.size, 0);
  assert.equal(env.timers.size, 0);
  assert.equal(seen[seen.length - 1], null);
  assert.equal(env.store.get('mtlxGraphThumbnails'), 'false');
  assert.equal(client.get(keyOf('n:a')).state, 'off');
  client.dispose();
});

test('rename keeps the image, override remap follows the node', async () => {
  const env = makeEnv();
  const client = env.Client.create({});
  const w = await boot(env, client, [card('n:a'), card('n:b')]);
  answerSigs(w, () => 'S1');
  await env.advance(0);
  const job = renders(w)[0];
  w.emit({ type: 'result', jobId: job.jobId, key: job.key, sig: 'S1', bitmap: bitmap(), notices: [], approx: false });
  await env.settle();
  client.setOverride('', 'n:b', false);
  client.remapNode('', 'n:b', 'n:z');
  assert.equal(client.isEnabled('', 'n:z', true), false);
  assert.equal(client.isEnabled('', 'n:b', true), true);
  client.remapNode('', job.key.split(SEP)[1], 'n:y');
  assert.equal(client.get(keyOf('n:y')).state, 'ready');
  assert.equal(client.get(job.key).state, 'off');
  client.dispose();
});

test('a size change re-renders nothing: no worker message, same bitmap, never pending', async () => {
  const env = makeEnv();
  const client = env.Client.create({});
  const A = keyOf('n:a');
  const w = await boot(env, client, [card('n:a')]);
  answerSigs(w, () => 'S1');
  await env.advance(0);
  const bm = bitmap(238, 238);
  const job = renders(w)[0];
  w.emit({ type: 'result', jobId: job.jobId, key: A, sig: 'S1', bitmap: bm, notices: [], approx: false });
  await env.settle();
  assert.equal(client.get(A).size, 'small');
  const postedBefore = w.posted.length;
  const seen = [];
  const off = client.subscribe(A, () => seen.push(client.get(A)));

  client.setSizeOverride('', 'n:a', 'large');
  await env.advance(2000);
  assert.equal(client.get(A).size, 'large');
  assert.equal(client.get(A).state, 'ready');
  assert.equal(client.get(A).bitmap, bm, 'the same bitmap serves both sizes');
  client.toggleMenuSize();
  client.setSizeOverride('', 'n:a', 'small');
  client.toggleMenuSize();
  await env.advance(2000);
  assert.equal(w.posted.length, postedBefore, 'nothing is posted to the worker for size changes');
  assert.ok(seen.every((e) => e.state === 'ready' && e.bitmap === bm), 'the card never drops to pending or loses its image');
  assert.equal(bm.closed, false);
  off();
  client.dispose();
});

test('the worker copies the GL bitmap into a 2D canvas (a bitmap straight from a released WebGL context goes blank)', () => {
  const src = fs.readFileSync(path.join(root, 'js', 'graph', 'thumb-worker.js'), 'utf8');
  const i = src.indexOf('state.canvas.transferToImageBitmap()');
  assert.ok(i > 0);
  const tail = src.slice(i, i + 400);
  assert.match(tail, /getContext\('2d'\)\.drawImage\(glBitmap/);
  assert.match(tail, /glBitmap\.close\(\)/);
  assert.match(tail, /copy\.transferToImageBitmap\(\)/);
});

test('global size persists, scales with the device pixel ratio and follows toggleMenuSize', async () => {
  let env = makeEnv();
  env.sandbox.devicePixelRatio = 3;
  let client = env.Client.create({});
  assert.deepEqual(JSON.parse(JSON.stringify(client.sizeMenuState())), { checked: false, disabled: false });
  assert.equal(client.toggleMenuSize(), true);
  assert.equal(env.store.get('mtlxGraphThumbnailSize'), 'large');
  const w = await boot(env, client, [card('n:a')]);
  answerSigs(w, () => 'S1');
  await env.advance(0);
  assert.equal(renders(w)[0].size, 476, '238 css px at a capped ratio of 2');
  assert.equal(client.get(keyOf('n:a')).size, 'large');
  client.dispose();

  env = makeEnv();
  env.store.set('mtlxGraphThumbnailSize', 'large');
  client = env.Client.create({});
  assert.equal(client.sizeMenuState().checked, true);
  assert.equal(client.sizeOf('', 'n:a'), 'large');
  client.dispose();
});

// ---- Shader thumbnails ----
const shaderCard = (id) => card(id, { kind: 'shader' });
const setScenes = (w) => w.posted.filter((p) => p.type === 'setScene');
const cancels = (w) => w.posted.filter((p) => p.type === 'cancel');
const resultOf = (w, job) => w.emit({ type: 'result', jobId: job.jobId, bitmap: bitmap(), approx: false, notices: [] });

async function bootShader(env, client, cards, caps = { parallelCompile: true }) {
  client.noteXml('<materialx v="1"/>');
  client.setScope('', cards, { entered: true });
  await env.advance(0);
  const w = env.workers[0];
  w.emit({ type: 'ready', capabilities: caps });
  await env.settle();
  return w;
}
const sigFor = (k) => 'S:' + k.slice(1);

test('shader thumbnails off: no scene message, no GLB or environment fetch, no shader job', async () => {
  const env = makeEnv();
  const client = env.Client.create({});
  assert.equal(client.shaderMenuState('').checked, false);
  const w = await bootShader(env, client, [card('n:a'), shaderCard('s:m')]);
  const m = answerSigs(w, sigFor);
  deepEq(m.keys.map((k) => k.key), [keyOf('n:a')]);
  await env.advance(1000);
  assert.equal(renders(w).length, 1);
  assert.equal(renders(w)[0].kind, 'pattern');
  assert.equal(setScenes(w).length, 0);
  assert.equal(env.fetchCalls.filter((u) => /shaderball|hdr/.test(u)).length, 0);
  // Init carries URLs and plain arrays only.
  const init = w.posted[0];
  assert.match(init.scene.gltfLoader, /GLTFLoader/);
  assert.match(init.scene.renderSession, /render-session/);
});

test('shader thumbnails on: patterns first, setScene behind them and before the first shader render', async () => {
  const env = makeEnv({ shader: 'true' });
  const client = env.Client.create({});
  const w = await bootShader(env, client, [shaderCard('s:m'), card('n:a')]);
  answerSigs(w, sigFor);
  await env.advance(1000);
  assert.equal(renders(w).length, 1);
  assert.equal(renders(w)[0].key, keyOf('n:a'));
  assert.equal(setScenes(w).length, 1, 'the scene is built while the last pattern job runs');
  resultOf(w, renders(w)[0]);
  await env.advance(1000);
  const sc = setScenes(w);
  assert.equal(sc.length, 1);
  assert.equal(sc[0].glb.id, 'shaderball');
  assert.equal(sc[0].env.id, 'default');
  assert.equal(renders(w).length, 1, 'no shader render before sceneReady');
  w.emit({ type: 'sceneReady', sceneKey: sc[0].sceneKey, ms: 5, gpuBytesEstimate: 1 });
  await env.advance(1000);
  const r = renders(w);
  assert.equal(r.length, 2);
  assert.equal(r[1].kind, 'shader');
  assert.equal(r[1].sceneKey, sc[0].sceneKey);
  assert.equal(w.posted.indexOf(sc[0]) < w.posted.indexOf(r[1]), true);
  assert.equal(client.get(keyOf('s:m')).kind, 'shader');
  assert.equal(client.get(keyOf('s:m')).phase, 'queued');
  w.emit({ type: 'stage', jobId: r[1].jobId, stage: 'compile' });
  assert.equal(client.get(keyOf('s:m')).phase, 'compile');
  resultOf(w, r[1]);
  await env.settle();
  assert.equal(client.get(keyOf('s:m')).state, 'ready');
  assert.equal(client.get(keyOf('s:m')).phase, undefined);
});

test('a pattern job that appears preempts a running shader job, which is requeued', async () => {
  const env = makeEnv({ shader: 'true' });
  const progress = [];
  const client = env.Client.create({ onProgress: (p) => progress.push(p) });
  const w = await bootShader(env, client, [shaderCard('s:m')]);
  answerSigs(w, () => 'S1');
  await env.advance(1000);
  w.emit({ type: 'sceneReady', sceneKey: setScenes(w)[0].sceneKey, ms: 1, gpuBytesEstimate: 1 });
  await env.advance(1000);
  const job = renders(w)[0];
  assert.equal(job.kind, 'shader');
  // The user adds a pattern node: the page re-syncs and cancels the shader job first.
  client.setScope('', [shaderCard('s:m'), card('n:b')], { entered: false });
  client.noteXml('<materialx v="2"/>');
  await env.advance(1000);
  assert.equal(cancels(w).length, 1);
  assert.equal(cancels(w)[0].jobId, job.jobId);
  w.emit({ type: 'stale', jobId: job.jobId, reason: 'cancelled' });
  await env.settle();
  assert.equal(progress[progress.length - 1].done, 0, 'a cancelled shader job is not counted done');
  answerSigs(w, () => 'S1');
  await env.advance(1000);
  const r = renders(w);
  assert.equal(r[r.length - 1].kind, 'pattern', 'the pattern job goes first');
  resultOf(w, r[r.length - 1]);
  await env.advance(1000);
  const again = renders(w);
  assert.equal(again[again.length - 1].kind, 'shader');
  assert.equal(again[again.length - 1].key, keyOf('s:m'));
});

test('a busy preview cancels and requeues the running shader job', async () => {
  const env = makeEnv({ shader: 'true' });
  let busy = false;
  const client = env.Client.create({ getPreviewBusy: () => busy });
  const w = await bootShader(env, client, [shaderCard('s:m')]);
  answerSigs(w, () => 'S1');
  await env.advance(1000);
  w.emit({ type: 'sceneReady', sceneKey: setScenes(w)[0].sceneKey, ms: 1, gpuBytesEstimate: 1 });
  await env.advance(1000);
  const job = renders(w)[0];
  busy = true;
  await env.advance(500);
  assert.equal(cancels(w).length, 1);
  w.emit({ type: 'stale', jobId: job.jobId, reason: 'cancelled' });
  await env.advance(1000);
  assert.equal(renders(w).length, 1, 'held back while the preview is busy');
  busy = false;
  await env.advance(1000);
  assert.equal(renders(w).length, 2);
  assert.equal(renders(w)[1].key, keyOf('s:m'));
});

test('an environment change moves only the shader image keys', async () => {
  const env = makeEnv({ shader: 'true' });
  const client = env.Client.create({});
  const w = await bootShader(env, client, [card('n:a'), shaderCard('s:m')]);
  answerSigs(w, sigFor);
  await env.advance(1000);
  resultOf(w, renders(w)[0]);
  await env.advance(1000);
  const sc1 = setScenes(w)[0];
  w.emit({ type: 'sceneReady', sceneKey: sc1.sceneKey, ms: 1, gpuBytesEstimate: 1 });
  await env.advance(1000);
  resultOf(w, renders(w)[1]);
  await env.settle();
  const patBitmap = client.get(keyOf('n:a')).bitmap;
  assert.ok(patBitmap && client.get(keyOf('s:m')).bitmap);
  env.envSrc.id = 'override:1';
  env.sandbox.listeners.get('mtlx-environment-changed')();
  await env.advance(1000);
  assert.equal(client.get(keyOf('n:a')).bitmap, patBitmap, 'pattern image untouched');
  assert.equal(client.get(keyOf('n:a')).state, 'ready');
  assert.notEqual(client.get(keyOf('s:m')).state, 'ready', 'the shader image is stale');
  const sc2 = setScenes(w)[1];
  assert.ok(sc2 && sc2.sceneKey !== sc1.sceneKey);
  assert.equal(sc2.glb, undefined, 'the GLB is sent once per worker');
  assert.equal(sc2.env.id, 'override:1');
  assert.equal(env.fetchCalls.filter((u) => /shaderball/.test(u)).length, 1);
});

test('shaderMenuState and toggleShaderMenu persist and gate on the scope and on parallel compile', async () => {
  const env = makeEnv();
  const client = env.Client.create({});
  client.setScope('', [card('n:a')], { entered: true });
  let ms = client.shaderMenuState('');
  assert.equal(ms.checked, false);
  assert.equal(ms.disabled, false);
  assert.match(ms.title, /Render shader and material nodes/);
  assert.equal(client.toggleShaderMenu(), true);
  assert.equal(env.store.get('mtlxGraphShaderThumbnails'), 'true');
  assert.equal(client.shaderMenuState('').checked, true);
  client.toggleMenu('');
  ms = client.shaderMenuState('');
  assert.equal(ms.disabled, true);
  assert.equal(ms.title, 'Turn on Node Thumbnails first');
  client.toggleMenu('');
  client.dispose();
  const env2 = makeEnv({ shader: 'true' });
  const client2 = env2.Client.create({});
  const w = await bootShader(env2, client2, [card('n:a'), shaderCard('s:m')], { parallelCompile: false });
  ms = client2.shaderMenuState('');
  assert.equal(ms.disabled, true);
  assert.match(ms.title, /^Not supported/);
  answerSigs(w, sigFor);
  await env2.advance(1000);
  assert.equal(client2.get(keyOf('s:m')).state, 'error');
  assert.equal(setScenes(w).length, 0);
  client2.dispose();
});

test('turning shader thumbnails off releases the scene when no shader override remains', async () => {
  const env = makeEnv({ shader: 'true' });
  const client = env.Client.create({});
  const w = await bootShader(env, client, [card('n:a'), shaderCard('s:m')]);
  assert.equal(client.toggleShaderMenu(), false);
  assert.equal(w.posted.filter((p) => p.type === 'releaseScene').length, 1);
  assert.equal(env.store.get('mtlxGraphShaderThumbnails'), 'false');
});

const manyCards = (n) => Array.from({ length: n }, (_, i) => card('n:' + i));
const okResult = (job) => ({ type: 'result', jobId: job.jobId, key: job.key, sig: job.sig, bitmap: bitmap(), notices: [], approx: false });

test('pattern jobs go out in a window of eight with the parallel flag, refilled as results land', async () => {
  const env = makeEnv();
  const client = env.Client.create({});
  const w = await boot(env, client, manyCards(12));
  answerSigs(w, (k) => 'S' + k.slice(-1) + k.length);
  await env.advance(0);
  assert.equal(renders(w).length, 8);
  assert.ok(renders(w).every((r) => r.parallel === true && r.kind === 'pattern'));
  // Results may come back in any order; each one frees one slot.
  const first = renders(w).slice();
  w.emit(okResult(first[5]));
  await env.settle();
  assert.equal(renders(w).length, 9);
  w.emit(okResult(first[0]));
  w.emit(okResult(first[7]));
  await env.settle();
  assert.equal(renders(w).length, 11);
  client.dispose();
});

test('without parallel compile the window is one and jobs carry no parallel flag', async () => {
  const env = makeEnv();
  const client = env.Client.create({});
  client.noteXml('<materialx v="1"/>');
  client.setScope('', manyCards(3), { entered: true });
  await env.advance(0);
  const w = env.workers[0];
  w.emit({ type: 'ready', capabilities: { parallelCompile: false } });
  await env.settle();
  answerSigs(w, (k) => 'S' + k.length + k.slice(-1));
  await env.advance(0);
  assert.equal(renders(w).length, 1);
  assert.equal(renders(w)[0].parallel, undefined);
  w.emit(okResult(renders(w)[0]));
  await env.settle();
  assert.equal(renders(w).length, 2);
  client.dispose();
});

test('windowOff from the worker drops to one job at a time without touching the ones in flight', async () => {
  const env = makeEnv();
  const client = env.Client.create({});
  const w = await boot(env, client, manyCards(12));
  answerSigs(w, (k) => 'S' + k.length + k.slice(-1));
  await env.advance(0);
  assert.equal(renders(w).length, 8);
  w.emit({ type: 'windowOff', reason: 'program cache miss' });
  const flight = renders(w).slice();
  for (let i = 0; i < 7; i++) { w.emit(okResult(flight[i])); await env.settle(); }
  assert.equal(renders(w).length, 8, 'nothing new until the window drains to zero');
  w.emit(okResult(flight[7]));
  await env.settle();
  assert.equal(renders(w).length, 9);
  assert.equal(renders(w)[8].parallel, undefined);
  client.dispose();
});

test('a stale result inside the window is cached but not shown; the other jobs are unaffected', async () => {
  const env = makeEnv();
  const client = env.Client.create({});
  const w = await boot(env, client, manyCards(3));
  answerSigs(w, (k) => 'S1' + k.slice(-1));
  await env.advance(0);
  assert.equal(renders(w).length, 3);
  const [a, b, c] = renders(w);
  client.noteXml('<materialx v="2"/>');
  await env.advance(500);
  answerSigs(w, (k) => (k.endsWith('n:0') ? 'S2' : 'S1' + k.slice(-1)));
  await env.settle();
  w.emit(okResult(b));
  w.emit(okResult(a));
  await env.settle();
  assert.equal(client.get(a.key).state, 'pending', 'the stale image is not displayed');
  assert.equal(client.get(b.key).state, 'ready');
  w.emit(okResult(c));
  await env.advance(1000);
  const again = renders(w).filter((r) => r.key === a.key);
  assert.equal(again.length, 2);
  assert.equal(again[1].sig, 'S2');
  client.dispose();
});

test('a crash with several jobs in flight blames none of them and runs one at a time afterwards', async () => {
  const env = makeEnv();
  const client = env.Client.create({});
  let w = await boot(env, client, manyCards(4));
  answerSigs(w, (k) => 'S' + k.length + k.slice(-1));
  await env.advance(0);
  assert.equal(renders(w).length, 4);
  w.emit({ type: 'fatal', message: 'wasm abort' });
  await env.advance(500);
  assert.equal(env.workers.length, 2);
  for (let i = 0; i < 4; i++) assert.notEqual(client.get(keyOf('n:' + i)).state, 'error');
  w = env.workers[1];
  w.emit({ type: 'ready', capabilities: {} });
  await env.settle();
  answerSigs(w, (k) => 'S' + k.length + k.slice(-1));
  await env.advance(0);
  assert.equal(renders(w).length, 1);
  client.dispose();
});

test('the worker starts with the scope, not after the quiet period, and only when something is enabled', async () => {
  const env = makeEnv();
  const client = env.Client.create({});
  client.noteXml('<materialx/>');
  client.setScope('', [card('n:a')], { entered: true });
  client.noteActivity();
  await env.advance(0);
  assert.equal(env.workers.length, 1, 'booting overlaps the quiet period');
  deepEq(env.workers[0].types(), ['init']);
  env.workers[0].emit({ type: 'ready', capabilities: {} });
  await env.advance(500);
  deepEq(env.workers[0].types(), ['init', 'setDocument']);
  client.dispose();

  // Off: a global opt-out, an unopted big scope and a scope without eligible cards start nothing.
  const off = makeEnv({ stored: 'false' });
  const c1 = off.Client.create({});
  c1.setScope('', [card('n:a')], { entered: true });
  const big = makeEnv();
  const c2 = big.Client.create({});
  c2.setScope('', Array.from({ length: 51 }, (_, i) => card('n:' + i)), { entered: true });
  const none = makeEnv();
  const c3 = none.Client.create({});
  c3.setScope('', [card('n:a', { eligible: false })], { entered: true });
  for (const e of [off, big, none]) {
    await e.advance(5000);
    assert.equal(e.workers.length, 0);
    assert.equal(e.fetchCalls.length, 0);
    assert.equal(e.timers.size, 0);
  }
  // Opting in from the menu starts it at once, turning it off again releases it.
  c2.toggleMenu('');
  await big.advance(0);
  assert.equal(big.workers.length, 1);
  c2.toggleMenu('');
  assert.equal(big.workers[0].terminated, true);
  for (const c of [c1, c2, c3]) c.dispose();
});

test('prepare: generation runs ahead while the gate is closed, in batches of eight, never for shader jobs', async () => {
  const env = makeEnv({ shader: 'true' });
  let busy = true;
  const client = env.Client.create({ getPreviewBusy: () => busy });
  const cards = manyCards(10).concat([card('s:1', { kind: 'shader' })]);
  const w = await boot(env, client, cards);
  const doc = w.posted.find((m) => m.type === 'setDocument');
  answerSigs(w, (k) => 'S' + k.length + k.slice(2));
  await env.advance(200);
  const prep = () => w.posted.filter((m) => m.type === 'prepare');
  assert.equal(renders(w).length, 0, 'the preview is busy');
  assert.equal(prep().length, 1);
  assert.equal(prep()[0].docSeq, doc.docSeq);
  assert.equal(prep()[0].jobs.length, 8);
  deepEq(Object.keys(prep()[0].jobs[0]).sort(), ['sig', 'target']);
  assert.ok(prep()[0].jobs.every((j) => typeof j.sig === 'string' && j.target && !/^s:/.test(j.target.id)));
  await env.advance(1000);
  assert.equal(prep().length, 1, 'the next batch waits for the worker to finish this one');
  w.emit({ type: 'prepared', docSeq: doc.docSeq, n: 8 });
  await env.advance(200);
  assert.equal(prep().length, 2);
  assert.equal(prep()[1].jobs.length, 2, 'only the pattern jobs not yet prepared');
  w.emit({ type: 'prepared', docSeq: doc.docSeq, n: 2 });
  await env.advance(1000);
  assert.equal(prep().length, 2, 'nothing left to prepare, and a shader job never is');
  assert.equal(w.posted.filter((m) => m.type === 'setScene').length, 0, 'no scene work while the preview is busy');
  busy = false;
  await env.advance(300);
  assert.equal(renders(w).filter((r) => r.kind !== 'shader').length, 8);
  client.dispose();
});

test('prepare: a new document starts a fresh set and an open gate prepares nothing', async () => {
  const env = makeEnv();
  let busy = true;
  const client = env.Client.create({ getPreviewBusy: () => busy });
  const w = await boot(env, client, manyCards(3));
  answerSigs(w, (k) => 'A' + k.slice(-1));
  await env.advance(200);
  const prep = () => w.posted.filter((m) => m.type === 'prepare');
  assert.equal(prep().length, 1);
  w.emit({ type: 'prepared', docSeq: prep()[0].docSeq, n: 3 });
  client.noteXml('<materialx v="2"/>');
  await env.advance(500);
  const docs = w.posted.filter((m) => m.type === 'setDocument');
  assert.equal(docs.length, 2);
  answerSigs(w, (k) => 'B' + k.slice(-1));
  await env.advance(200);
  assert.equal(prep().length, 2);
  assert.equal(prep()[1].docSeq, docs[1].docSeq, 'the new docSeq, so a late batch for the old one is dropped by the worker');
  assert.ok(prep()[1].jobs.every((j) => /^B/.test(j.sig)));
  busy = false;
  w.emit({ type: 'prepared', docSeq: docs[1].docSeq, n: 3 });
  await env.advance(300);
  assert.equal(renders(w).length, 3);
  const before = prep().length;
  client.noteXml('<materialx v="3"/>');
  await env.advance(500);
  answerSigs(w, (k) => 'C' + k.slice(-1));
  await env.advance(200);
  assert.equal(prep().length, before, 'an open gate prepares nothing');
  client.dispose();
});

test('a crash drops the prepare bookkeeping with the worker', async () => {
  const env = makeEnv();
  const client = env.Client.create({ getPreviewBusy: () => true });
  let w = await boot(env, client, manyCards(2));
  answerSigs(w, (k) => 'A' + k.slice(-1));
  await env.advance(200);
  assert.equal(w.posted.filter((m) => m.type === 'prepare').length, 1);
  w.emit({ type: 'fatal', message: 'wasm abort' });
  await env.advance(500);
  w = env.workers[1];
  w.emit({ type: 'ready', capabilities: {} });
  await env.settle();
  answerSigs(w, (k) => 'A' + k.slice(-1));
  await env.advance(200);
  assert.equal(w.posted.filter((m) => m.type === 'prepare').length, 1, 'the new worker is told again');
  client.dispose();
});

test('edit latency: the document is read at the edit settle time, retried on transients, and a drag posts nothing', async () => {
  const env = makeEnv();
  const client = env.Client.create({});
  const w = await boot(env, client, [card('n:a')]);
  answerSigs(w, () => 'S1');
  await env.advance(1000);
  const docs = () => w.posted.filter((m) => m.type === 'setDocument');
  assert.equal(docs().length, 1);

  client.noteEdit(() => '<materialx v="2"/>');
  await env.advance(100);
  assert.equal(docs().length, 1);
  await env.advance(60);
  assert.equal(docs().length, 2, 'posted well inside 500 ms, without waiting for the undo snapshot');
  assert.equal(docs()[1].xml, '<materialx v="2"/>');
  // The undo snapshot later hands over the same text: nothing more is posted.
  client.noteXml('<materialx v="2"/>');
  await env.advance(1500);
  assert.equal(docs().length, 2);

  // A transient serialize failure retries, then succeeds.
  let calls = 0;
  client.noteEdit(() => { if (++calls < 3) { const e = new Error('transient'); e.transient = true; throw e; } return '<materialx v="3"/>'; });
  await env.advance(1000);
  assert.equal(calls, 3);
  assert.equal(docs().length, 3);
  assert.equal(docs()[2].xml, '<materialx v="3"/>');

  // A stream of edits and activity (a drag) posts nothing until it stops.
  for (let i = 0; i < 30; i++) {
    client.noteEdit(() => '<materialx v="d' + i + '"/>');
    client.noteActivity();
    await env.advance(50);
  }
  assert.equal(docs().length, 3);
  await env.advance(200);
  assert.equal(docs().length, 4);
  assert.equal(docs()[3].xml, '<materialx v="d29"/>');

  // A provider that never succeeds gives up; the explicit text still wins.
  client.noteEdit(() => { throw new Error('transient'); });
  await env.advance(3000);
  client.noteXml('<materialx v="z"/>');
  await env.advance(500);
  assert.equal(docs().length, 5);
  assert.equal(docs()[4].xml, '<materialx v="z"/>');
  client.dispose();
});

test('early scene: setScene goes out with the gate open once every pattern job is posted, never while the preview is busy', async () => {
  const env = makeEnv({ shader: 'true' });
  let busy = true;
  const client = env.Client.create({ getPreviewBusy: () => busy });
  const w = await boot(env, client, [card('n:a'), card('s:1', { kind: 'shader' })]);
  answerSigs(w, (k) => 'S' + k.slice(-1));
  await env.advance(1000);
  assert.equal(w.posted.filter((m) => m.type === 'setScene').length, 0);
  busy = false;
  await env.advance(200);
  assert.equal(renders(w).length, 1, 'the pattern job goes first');
  assert.equal(w.posted.filter((m) => m.type === 'setScene').length, 1, 'the scene does not wait for the shader job to reach the head');
  client.dispose();
});
