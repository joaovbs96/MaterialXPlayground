// Page-side controller for node thumbnails (globalThis.MtlxThumbClient). It owns the
// scheduler, the worker (js/graph/thumb-worker.js), the ImageBitmap cache and a per-key store.
// Zero cost when off: no worker, fetch, post, signature request or timer while nothing is enabled.
//
// Feed: noteXml(xml), noteEdit(getXml), noteFiles({path: Blob}), noteActivity(), noteCanvasIdle().
// noteEdit reads the document when the edit settles (EDIT_SYNC_MS) instead of waiting for the undo snapshot.
// Scope: setScope(scope, cards, { entered }), setVisible(ids). A card is
// { id, eligible, kind?: 'pattern' | 'shader', target: { id, scope, originId?, originScope? }, x, y };
// pass every card of the scope.
// Toggles: menuState(scope), toggleMenu(scope), isEnabled(scope, id, eligible),
// setOverride(scope, id, on, kind), setOverrides(scope, ids, on, kind), remapNode, remapScope, resetSession().
// Shader thumbnails (shader and material nodes on the shaderball, default off, persisted):
// shaderMenuState(scope) -> { checked, disabled, title }, toggleShaderMenu(); isEnabled takes a kind too.
// Size: sizeMenuState(), toggleMenuSize(), sizeOf(scope, id), setSizeOverride(s)(scope, id(s), small|large).
// Store: subscribe(key, fn) -> unsubscribe, get(key) -> { state, size?, bitmap?, title? } with key =
// scope + '\u0000' + id (see keyOf). state is off | pending | ready | error | approx. Shader entries
// also carry kind: 'shader' and, while pending, phase: queued | generate | compile | render.
// Progress: onProgress({ done, total } | null). Also: dispose().
//
// Protocol (v: 1). To the worker: init, setDocument, requestSignatures, render, setHost, setDisplay,
// setScene, prepare, cancel, trim, releaseScene. From the worker: ready, signatures, result, error, stale,
// stage, sceneReady, prepared, windowOff, fatal. While the gate is closed the worker generates the
// sources of the head pattern jobs ahead (prepare, no GL work); a render then hits its cache.
// Pattern jobs run up to PATTERN_WINDOW at a time (the worker links them in parallel); windowOff from
// the worker or a crash with several jobs in flight drops to one. The scene (GLB and environment bytes)
// is sent when only shader jobs are left and the gate is open. The page owns the queue; the
// gate (quiet period, preview idle, camera still, visible tab, active view) is polled only while
// jobs are pending and the gate is closed.
(function () {
  'use strict';

  const G = globalThis;
  const SEP = '\u0000';
  const THUMBS_STORAGE_KEY = 'mtlxGraphThumbnails';
  const CACHE_BYTES_MAX = 64 * 1024 * 1024; // image cache budget, width * height * 4 per bitmap
  const SHADER_THUMBS_STORAGE_KEY = 'mtlxGraphShaderThumbnails'; // 'true' | 'false', default off
  const THUMB_SIZE_STORAGE_KEY = 'mtlxGraphThumbnailSize'; // 'small' | 'large'
  const SIDE = { small: 64, large: 238 }; // CSS sides; large is NODE_W less the card border (js/graph/style.jsx)
  const IDLE_TERMINATE_MS = 120000;
  const POLL_MS = 150;
  const EDIT_SYNC_MS = 120; // an edit is read and synced this long after the last one; renders still wait for the quiet period
  const EDIT_RETRY_MS = 100;
  const EDIT_TRIES_MAX = 10;
  const PREPARE_BATCH = 8;
  const PREPARE_MAX = 32;
  const PATTERN_WINDOW = 8;
  const INIT_TIMEOUT_MS = 90000;
  const CRASH_WINDOW_MS = 5 * 60000;
  const CRASH_LIMIT = 3;
  const CTX_WINDOW_MS = 60000;
  const CTX_LIMIT = 3;
  const CTX_BACKOFF_MS = 30000;
  const OFF = Object.freeze({ state: 'off' });
  const NO_PARALLEL = 'Not supported: this browser cannot compile shaders in the background';
  const keyOf = (scope, id) => scope + SEP + id;

  const hash32 = (s) => {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(16);
  };

  function create(options) {
    const opts = options || {};
    const sched = G.MtlxThumbScheduler.createScheduler();
    const now = () => (G.performance && G.performance.now ? G.performance.now() : Date.now());

    // Global preference. Default ON.
    try {
      if (G.localStorage.getItem(THUMBS_STORAGE_KEY) === 'false') sched.setGlobal(false);
    } catch (e) { /* private mode / storage disabled */ }
    try {
      const sz = G.localStorage.getItem(THUMB_SIZE_STORAGE_KEY);
      if (sz === 'small' || sz === 'large') sched.setGlobalSize(sz);
    } catch (e) { /* private mode / storage disabled */ }
    try {
      if (G.localStorage.getItem(SHADER_THUMBS_STORAGE_KEY) === 'true') sched.setShaderGlobal(true);
    } catch (e) { /* private mode / storage disabled */ }
    const persistShader = () => {
      try { G.localStorage.setItem(SHADER_THUMBS_STORAGE_KEY, String(sched.getShaderGlobal())); } catch (e) { /* private mode */ }
    };
    const persistGlobalSize = () => {
      try { G.localStorage.setItem(THUMB_SIZE_STORAGE_KEY, sched.getGlobalSize()); } catch (e) { /* private mode */ }
    };
    const persistGlobal = () => {
      try { G.localStorage.setItem(THUMBS_STORAGE_KEY, String(sched.getGlobal())); } catch (e) { /* private mode */ }
    };

    let disabledReason = '';
    let running = false;
    let disposed = false;

    // Current scope.
    const cur = { scope: '', cards: [], byId: new Map(), eligibleIds: [], eligibleKinds: [], enabledSig: '', visible: new Set(), pos: new Map() };

    // Store, cache and per-key bookkeeping.
    const entries = new Map();
    const listeners = new Map();
    const cache = new Map(); // imageKey -> { bitmap, approx, title }
    const errors = new Map(); // key -> { sig, message }
    const ctxRetried = new Set();
    let lastKeys = [];
    let lastSigs = {};
    let lastMissing = new Set();
    let lastParseError = '';
    let lastXmlStale = false;
    const desiredSig = new Map();
    const desiredImageKey = new Map();
    let progressKey = '';

    const notify = (key) => {
      const set = listeners.get(key);
      if (set) for (const fn of Array.from(set)) { try { fn(); } catch (e) { /* listener error */ } }
    };
    const sizeOfKey = (key) => {
      const i = key.indexOf(SEP);
      return sched.sizeOf(key.slice(0, i), key.slice(i + 1));
    };
    const kindOfCard = (c) => (c && c.kind === 'shader' ? 'shader' : 'pattern');
    const kindOfKey = (key) => {
      const i = key.indexOf(SEP);
      if (key.slice(0, i) !== cur.scope) return 'pattern';
      return kindOfCard(cur.byId.get(key.slice(i + 1)));
    };
    const setEntry = (key, next) => {
      const prev = entries.get(key) || OFF;
      const size = next.state === 'off' ? undefined : sizeOfKey(key);
      const shader = next.state !== 'off' && kindOfKey(key) === 'shader';
      let phase;
      if (shader && next.state === 'pending') phase = next.phase || (jobByKey(key) || OFF).phase || 'queued';
      if (prev.state === next.state && prev.bitmap === next.bitmap && prev.title === next.title && prev.size === size && prev.phase === phase && (prev.kind === 'shader') === shader) return;
      const obj = { state: next.state };
      if (shader) obj.kind = 'shader';
      if (phase) obj.phase = phase;
      if (size) obj.size = size;
      if (next.bitmap) obj.bitmap = next.bitmap;
      if (next.title) obj.title = next.title;
      if (next.state === 'off') entries.delete(key); else entries.set(key, obj);
      notify(key);
    };
    const emitProgress = () => {
      const p = sched.progress();
      const k = p ? p.done + '/' + p.total : '';
      if (k === progressKey) return;
      progressKey = k;
      if (opts.onProgress) { try { opts.onProgress(p); } catch (e) { /* host error */ } }
    };

    const cacheTouch = (ik) => {
      const hit = cache.get(ik);
      if (hit) { cache.delete(ik); cache.set(ik, hit); }
      return hit;
    };
    const cacheHas = (ik) => cache.has(ik);
    const bytesOf = (v) => ((v.bitmap && v.bitmap.width) || 0) * ((v.bitmap && v.bitmap.height) || 0) * 4;
    const cacheBytes = () => { let n = 0; for (const v of cache.values()) n += bytesOf(v); return n; };
    // Oldest first; the keys wanted by the current scope are never evicted.
    const evictCache = () => {
      let total = cacheBytes();
      if (total <= CACHE_BYTES_MAX) return;
      const protectedKeys = new Set(desiredImageKey.values());
      for (const [ik, v] of Array.from(cache)) {
        if (total <= CACHE_BYTES_MAX) break;
        if (protectedKeys.has(ik)) continue;
        cache.delete(ik);
        total -= bytesOf(v);
        for (const [key, e] of Array.from(entries)) if (e.bitmap === v.bitmap) setEntry(key, { state: 'off' });
        try { v.bitmap.close(); } catch (e) { /* already closed */ }
      }
    };

    // Inputs read from the page.
    const readDisplay = () => {
      let transform = 'srgb';
      let exposureEV = 0;
      try { if (typeof G.getDisplayTransform === 'function') transform = G.getDisplayTransform(); } catch (e) { /* default */ }
      try { if (typeof G.getDisplayExposure === 'function') exposureEV = Number(G.getDisplayExposure()) || 0; } catch (e) { /* default */ }
      return { transform, exposureEV };
    };
    const readSettings = () => {
      let compoundRoot = false;
      try { compoundRoot = !!G.MtlxRenderSettings.get('graphCompoundCompile', { surface: 'graph' }); } catch (e) { /* default */ }
      return { compoundRoot };
    };
    const arr = (v) => (v && typeof v.toArray === 'function' ? v.toArray() : Array.from(v || []));
    const hostSnapshots = () => {
      const snap = { gen: null, three: null, assembly: null };
      try { snap.assembly = G.MtlxSceneAssembly.hostSnapshot(); } catch (e) { /* not loaded */ }
      try { snap.gen = G.MtlxGenCore.hostSnapshot(); } catch (e) { /* not loaded */ }
      try { snap.three = G.MtlxThreeMaterial.hostSnapshot(); } catch (e) { /* not loaded */ }
      return snap;
    };
    // Only the stable parts of the host affect the pixels; the clock and display hooks do not.
    const readHostKey = () => {
      const s = hostSnapshots();
      const t = s.three || {};
      try { return hash32(JSON.stringify([s.gen, t.specularEnvMethod, t.diffuseEnvMethod, t.sceneTextureFast])); } catch (e) { return ''; }
    };
    // Always rendered at the large size; the small card scales the same bitmap down when it draws.
    const renderPx = () => Math.round(SIDE.large * Math.min(G.devicePixelRatio || 1, 2));
    const imageKeyOf = (sig, display, hostKey, px) => sig + '|' + display.transform + '|' + display.exposureEV + '|' + hostKey + '|' + px;

    // The shaderball scene inputs. A shader image key is the pattern key plus this scene key.
    const readSceneInputs = () => {
      const o = { envId: '', keyLight: false, anisotropy: 1, forceTransparency: false, displacement: true };
      try { const src = G.getEnvironmentSource(); o.envId = String((src && src.id) || ''); } catch (e) { /* not loaded */ }
      try { o.keyLight = !!G.getKeyLightEnabled(); } catch (e) { /* default */ }
      try { o.anisotropy = Number(G.getTextureAnisotropy()) || 1; } catch (e) { /* default */ }
      try { o.forceTransparency = !!G.getForceTransparency(); } catch (e) { /* default */ }
      try { o.displacement = !!G.getDisplacementEnabled(); } catch (e) { /* default */ }
      return o;
    };
    const sceneKeyOf = (o) => hash32(JSON.stringify([o.envId, o.keyLight, o.anisotropy, o.forceTransparency, o.displacement, String(G.__MTLX_BUILD || '')]));
    const absUrl = (rel) => new URL(rel, G.document.baseURI).href;
    const copyBytes = (b) => (b instanceof ArrayBuffer ? b.slice(0) : b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

    // Worker state.
    let worker = null;
    let workerReady = false;
    let starting = null;
    let wEpoch = 0;
    let docSeq = 0;
    let latestXml = null;
    let postedXml = null;
    let latestFiles = {};
    let workerFiles = new Map();
    let postedSettingsKey = null;
    let sigQueue = [];
    let sigDocSeq = 0;
    let xmlProvider = null; // () => xml, set by noteEdit until the document is read
    let lastEditAt = -Infinity;
    let editTries = 0;
    let prepareBusy = false;
    const preparedSigs = new Set();
    const inflightJobs = new Map(); // jobId -> { jobId, key, sig, imageKey, kind, phase?, cancelling?, requeue? }
    let windowOff = false; // session flag, set when parallel links stop paying off
    let jobSeq = 0;
    let curSceneKey = ''; // scene key the queued shader jobs want ('' while none is enabled)
    let workerSceneKey = null; // scene key the worker reported ready
    let workerEnvTag = '';
    let glbPosted = false;
    let sceneBusy = false;
    let parallelCompile = null; // worker capability, null until known
    let watchTimer = 0;
    let lastSceneInputs = '';
    let dirty = false;
    let syncBusy = false;
    let syncAgain = false;
    let syncTimer = 0;
    let pumpTimer = 0;
    let idleTimer = 0;
    let backoffUntil = 0;
    const crashes = [];
    const ctxLosses = [];
    let listenersOn = false;

    const jobByKey = (key) => { for (const j of inflightJobs.values()) if (j.key === key) return j; return null; };
    const shaderJob = () => { for (const j of inflightJobs.values()) if (j.kind === 'shader') return j; return null; };
    const windowNow = () => (parallelCompile !== false && !windowOff ? PATTERN_WINDOW : 1);

    const clearTimers = () => {
      clearTimeout(syncTimer); syncTimer = 0;
      clearTimeout(pumpTimer); pumpTimer = 0;
      clearTimeout(idleTimer); idleTimer = 0;
      clearTimeout(watchTimer); watchTimer = 0;
    };

    function killWorker() {
      wEpoch++;
      clearTimeout(idleTimer); idleTimer = 0;
      if (worker) {
        if (worker.__clear) worker.__clear();
        try { worker.terminate(); } catch (e) { /* already gone */ }
      }
      worker = null;
      workerReady = false;
      starting = null;
      sigQueue = [];
      postedXml = null;
      postedSettingsKey = null;
      prepareBusy = false;
      preparedSigs.clear();
      workerFiles = new Map();
      workerSceneKey = null;
      workerEnvTag = '';
      glbPosted = false;
      sceneBusy = false;
      clearTimeout(watchTimer); watchTimer = 0;
      for (const j of inflightJobs.values()) sched.complete(j.key);
      inflightJobs.clear();
    }

    const enabledCards = () => {
      const out = [];
      for (const c of cur.cards) {
        if (c.eligible && sched.isEnabled(cur.scope, c.id, true, kindOfCard(c))) out.push(c);
      }
      return out;
    };
    const computeEnabledSig = () => enabledCards().map((c) => c.id).join(';');
    const anyOn = () => !disabledReason && sched.anyEnabled(cur.scope, cur.eligibleKinds);

    // Creates, or re-creates, the worker. Resolves to the worker once it is ready, or null.
    function ensureWorker() {
      if (worker && workerReady) return Promise.resolve(worker);
      if (starting) return starting;
      const ep = ++wEpoch;
      const p = (async () => {
        let w = null;
        try {
          const env = await G.getMxEnv();
          if (ep !== wEpoch) return null;
          const active = opts.getVersion ? opts.getVersion() : undefined;
          if (active && env.version && active !== env.version) {
            disableSession('Thumbnails need the default MaterialX version.');
            return null;
          }
          const version = env.version;
          const abs = (rel) => new URL(rel, G.document.baseURI).href;
          let importable = (u) => u;
          let workerUrl = abs('js/graph/thumb-worker.js');
          if (G.__MTLX_VSCODE__) {
            const link = await import(abs('js/shared/worker-module-link.js'));
            importable = link.importableUrl;
            workerUrl = await link.linkWorkerModule(workerUrl);
          }
          const grab = async (rel) => {
            const r = await G.fetch(abs(rel));
            if (!r.ok) throw new Error(rel + ' returned HTTP ' + r.status);
            return r.arrayBuffer();
          };
          const [wasm, data] = await Promise.all([
            grab('js/materialx/' + version + '/JsMaterialXGenShader.wasm'),
            grab('js/materialx/' + version + '/JsMaterialXGenShader.data'),
          ]);
          if (ep !== wEpoch) return null;
          const vend = async (id, file) => {
            try { return await importable(G.MtlxVendor.url(id, file)); } catch (e) { return null; }
          };
          const factoryUrl = await importable(abs('js/materialx/' + version + '/JsMaterialXGenShader.js'));
          const threeUrl = await vend('three', 'three.min.js');
          const scene = {
            gltfLoader: await vend('three', 'GLTFLoader.js'),
            orbitControls: await vend('three', 'OrbitControls.js'),
            renderEnvironment: await importable(abs('js/shared/render-environment.js')),
            renderSession: await importable(abs('js/shared/render-session.js')),
          };
          const loaders = {
            fflate: await vend('three-147', 'fflate.min.js'),
            exr: await importable(abs('js/vendor/EXRLoader.js')),
            hdr: await vend('three', 'RGBELoader.js'),
            pako: await vend('pako', 'pako_inflate.min.js'),
            utif: await vend('utif', 'UTIF.js'),
          };
          if (ep !== wEpoch) return null;
          w = new G.Worker(workerUrl, { type: 'module', name: 'mtlx-thumbnails' });
          worker = w;
          const ready = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Thumbnail worker did not start.')), INIT_TIMEOUT_MS);
            w.__clear = () => clearTimeout(timer);
            w.__onReady = (m) => { clearTimeout(timer); resolve(m); };
            w.__onFail = (e) => { clearTimeout(timer); reject(e); };
          });
          w.onmessage = (ev) => onWorkerMessage(w, ev.data);
          w.onerror = (ev) => { if (ev && ev.preventDefault) ev.preventDefault(); onCrash(w, 'worker error: ' + ((ev && ev.message) || '')); };
          w.onmessageerror = () => onCrash(w, 'message error');
          const host = hostSnapshots();
          w.postMessage({
            v: 1, type: 'init',
            mtlx: { version, factoryUrl, wasm, data },
            three: { url: threeUrl },
            loaders,
            scene,
            rigLights: (env.lightData || []).map((l) => ({ type: l.type, direction: arr(l.direction), color: arr(l.color), intensity: l.intensity })),
            buildId: String(G.__MTLX_BUILD || ''),
            host: { gen: host.gen, three: host.three, assembly: host.assembly },
          }, [wasm, data]);
          await ready;
          if (ep !== wEpoch) return null;
          workerReady = true;
          return w;
        } catch (e) {
          if (ep === wEpoch) {
            if (w) onCrash(w, String((e && e.message) || e));
            else onCrash(null, String((e && e.message) || e));
          }
          return null;
        } finally {
          if (starting === p) starting = null;
        }
      })();
      starting = p;
      return p;
    }

    // Boots the worker as soon as something is enabled, so it overlaps the document load and the quiet period.
    function warmWorker() {
      if (!worker && !starting && running && !disposed) ensureWorker();
    }

    function disableSession(reason) {
      disabledReason = reason;
      stopRunning();
      syncStates();
    }

    function onCrash(w, message) {
      if (w && w !== worker) return;
      const t = now();
      crashes.push(t);
      while (crashes.length && t - crashes[0] > CRASH_WINDOW_MS) crashes.shift();
      // One job lost is the culprit; with several in flight run one at a time so the next crash names it.
      if (inflightJobs.size === 1) {
        const lost = inflightJobs.values().next().value;
        errors.set(lost.key, { sig: lost.sig, message: 'Renderer crashed on this node' });
      } else if (inflightJobs.size > 1) windowOff = true;
      const failed = w && w.__onFail;
      killWorker();
      if (failed) failed(new Error(message));
      if (crashes.length >= CRASH_LIMIT) { disableSession('Thumbnails stopped after repeated errors'); return; }
      if (running) {
        dirty = true;
        if (lastKeys.length) evaluate();
        armQuiet();
      }
    }

    function onWorkerMessage(w, m) {
      if (w !== worker || !m || m.v !== 1 || disposed) return;
      switch (m.type) {
        case 'ready':
          if (m.capabilities && typeof m.capabilities.parallelCompile === 'boolean') parallelCompile = m.capabilities.parallelCompile;
          if (w.__onReady) w.__onReady(m);
          break;
        case 'sceneReady':
          if (w.__onScene) { const cb = w.__onScene; w.__onScene = null; cb.resolve(m); }
          break;
        case 'stage': {
          const j = inflightJobs.get(m.jobId);
          if (j && j.phase !== m.stage) {
            j.phase = m.stage;
            const prev = entries.get(j.key);
            if (desiredSig.get(j.key) === j.sig) setEntry(j.key, { state: 'pending', bitmap: prev && prev.bitmap, phase: m.stage });
          }
          break;
        }
        case 'windowOff': windowOff = true; break;
        case 'prepared': prepareBusy = false; pump(); break;
        case 'signatures': {
          const snap = sigQueue.shift();
          if (!snap || sigQueue.length) break;
          sigDocSeq = m.docSeq;
          lastKeys = snap.keys;
          lastSigs = m.sigs || {};
          lastMissing = new Set(m.missing || []);
          lastParseError = m.error || '';
          lastXmlStale = snap.xml !== latestXml;
          evaluate();
          pump();
          break;
        }
        case 'result': onResult(m); break;
        case 'error':
          if (m.kind === 'scene' && m.jobId == null) {
            if (w.__onScene) { const cb = w.__onScene; w.__onScene = null; cb.reject(new Error(m.message || 'The thumbnail scene failed')); }
          } else onJobError(m);
          break;
        case 'stale': {
          const mine = inflightJobs.get(m.jobId) || null;
          if (mine && mine.requeue && m.reason === 'cancelled') {
            sched.complete(mine.key, { requeue: true });
            inflightJobs.delete(mine.jobId);
            setEntry(mine.key, { state: 'pending', bitmap: (entries.get(mine.key) || OFF).bitmap });
            emitProgress();
            pump();
            break;
          }
          if (mine) { sched.complete(mine.key); inflightJobs.delete(mine.jobId); }
          dirty = true;
          emitProgress();
          armQuiet();
          break;
        }
        case 'fatal': onCrash(w, m.message || 'fatal'); break;
        default: break;
      }
    }

    // Recomputes every enabled key's desired image from the last signatures.
    function evaluate() {
      if (!running) return;
      const display = readDisplay();
      const hk = readHostKey();
      const enabled = new Set(enabledCards().map((c) => keyOf(cur.scope, c.id)));
      const queue = [];
      desiredSig.clear();
      desiredImageKey.clear();
      let sceneKey = '';
      for (const k of lastKeys) if (enabled.has(k.key) && kindOfKey(k.key) === 'shader') { sceneKey = sceneKeyOf(readSceneInputs()); break; }
      curSceneKey = sceneKey;
      for (const k of lastKeys) {
        const key = k.key;
        if (!enabled.has(key)) continue;
        const sig = lastSigs[key];
        const prev = entries.get(key);
        if (!sig) {
          if (lastXmlStale) setEntry(key, { state: 'pending', bitmap: prev && prev.bitmap });
          else setEntry(key, { state: 'error', title: lastParseError || 'No thumbnail for this node', bitmap: prev && prev.bitmap });
          continue;
        }
        const kind = kindOfKey(key);
        if (kind === 'shader' && parallelCompile === false) {
          setEntry(key, { state: 'error', title: NO_PARALLEL, bitmap: prev && prev.bitmap });
          continue;
        }
        const ik = imageKeyOf(sig, display, hk, renderPx()) + (kind === 'shader' ? '|' + sceneKey : '');
        desiredSig.set(key, sig);
        desiredImageKey.set(key, ik);
        const hit = cacheTouch(ik);
        if (hit) { setEntry(key, { state: hit.approx ? 'approx' : 'ready', bitmap: hit.bitmap, title: hit.title }); continue; }
        const er = errors.get(key);
        if (er && er.sig === sig && (kind !== 'shader' || er.scene === sceneKey)) { setEntry(key, { state: 'error', title: er.message, bitmap: prev && prev.bitmap }); continue; }
        setEntry(key, { state: 'pending', bitmap: prev && prev.bitmap });
        queue.push({ key, sig, imageKey: ik, target: k.target, kind });
      }
      sched.applySignatures(queue, cacheHas);
      emitProgress();
      checkInflight();
    }

    // A shader job gives way to a changed scene or document, a pending pattern job or a busy preview.
    function checkInflight() {
      const sj = shaderJob();
      if (!sj || sj.cancelling) return;
      if (sched.isStale(sj.key)) { cancelInflight(false); return; }
      if (sched.wantsPreempt() || (opts.getPreviewBusy && opts.getPreviewBusy())) cancelInflight(true);
    }
    function cancelInflight(requeue) {
      const sj = shaderJob();
      if (!sj || sj.cancelling || !worker) return;
      sj.cancelling = true;
      sj.requeue = requeue;
      worker.postMessage({ v: 1, type: 'cancel', jobId: sj.jobId });
    }
    function armWatch() {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        watchTimer = 0;
        if (!shaderJob()) return;
        checkInflight();
        armWatch();
      }, POLL_MS);
    }

    function onResult(m) {
      const job = inflightJobs.get(m.jobId);
      if (!job) { if (m.bitmap && m.bitmap.close) m.bitmap.close(); return; }
      inflightJobs.delete(job.jobId);
      sched.complete(job.key);
      if (m.bitmap) {
        const title = (m.notices && m.notices.length) ? m.notices.join('\n') : '';
        cache.delete(job.imageKey);
        cache.set(job.imageKey, { bitmap: m.bitmap, approx: !!m.approx, title });
        if (desiredSig.get(job.key) === job.sig && desiredImageKey.get(job.key) === job.imageKey) {
          setEntry(job.key, { state: m.approx ? 'approx' : 'ready', bitmap: m.bitmap, title });
        }
        evictCache();
      }
      emitProgress();
      afterJob();
    }

    function onJobError(m) {
      const job = inflightJobs.get(m.jobId);
      if (!job) return;
      inflightJobs.delete(job.jobId);
      sched.complete(job.key);
      if (m.kind === 'context') {
        const t = now();
        ctxLosses.push(t);
        while (ctxLosses.length && t - ctxLosses[0] > CTX_WINDOW_MS) ctxLosses.shift();
        if (ctxLosses.length >= CTX_LIMIT) { backoffUntil = t + CTX_BACKOFF_MS; ctxLosses.length = 0; }
        const rk = job.key + SEP + job.sig;
        if (!ctxRetried.has(rk)) {
          ctxRetried.add(rk);
          evaluate();
          afterJob();
          return;
        }
      }
      errors.set(job.key, { sig: job.sig, message: m.message || 'Thumbnail failed' });
      const prev = entries.get(job.key);
      if (desiredSig.get(job.key) === job.sig) setEntry(job.key, { state: 'error', title: m.message || 'Thumbnail failed', bitmap: prev && prev.bitmap });
      emitProgress();
      afterJob();
    }

    const afterJob = () => { pump(); };

    // Sends the shaderball GLB (once per worker) and the environment bytes when the worker's scene
    // differs from the wanted one. Only ever called when the next job is a shader job.
    async function ensureScene() {
      if (sceneBusy || !worker || !workerReady) return;
      sceneBusy = true;
      const w = worker;
      const ep = wEpoch;
      let failed = '';
      try {
        const o = readSceneInputs();
        const key = sceneKeyOf(o);
        const msg = { v: 1, type: 'setScene', sceneKey: key, size: renderPx(), opts: { anisotropy: o.anisotropy, forceTransparency: o.forceTransparency, displacement: o.displacement } };
        const xfer = [];
        if (!glbPosted) {
          const r = await G.fetch(absUrl('models/shaderball.glb'));
          if (!r.ok) throw new Error('models/shaderball.glb returned HTTP ' + r.status);
          const bytes = await r.arrayBuffer();
          msg.glb = { id: 'shaderball', bytes };
          xfer.push(bytes);
        }
        const tag = o.envId + '|' + o.keyLight;
        if (tag !== workerEnvTag) {
          const src = G.getEnvironmentSource();
          let bytes;
          if (src.buf) bytes = copyBytes(src.buf);
          else {
            const r = await G.fetch(absUrl(src.url));
            if (!r.ok) throw new Error(src.url + ' returned HTTP ' + r.status);
            bytes = await r.arrayBuffer();
          }
          msg.env = { id: src.id, ext: src.ext, bytes, keyLight: o.keyLight, prefiltered: src.prefiltered || undefined };
          xfer.push(bytes);
        }
        if (ep !== wEpoch) return;
        const done = new Promise((resolve, reject) => { w.__onScene = { resolve, reject }; });
        w.postMessage(msg, xfer);
        await done;
        if (ep !== wEpoch) return;
        workerSceneKey = key;
        glbPosted = true;
        workerEnvTag = tag;
      } catch (e) {
        failed = String((e && e.message) || e) || 'The thumbnail scene failed';
      } finally {
        if (ep === wEpoch) sceneBusy = false;
      }
      if (ep !== wEpoch || disposed) return;
      if (failed) {
        for (const [key, sig] of desiredSig) if (kindOfKey(key) === 'shader') errors.set(key, { sig, message: failed, scene: curSceneKey });
        evaluate();
      }
      pump();
    }

    function schedulePump(delay) {
      if (pumpTimer) return;
      pumpTimer = setTimeout(() => { pumpTimer = 0; pump(); }, delay);
    }

    function armIdle() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { idleTimer = 0; if (!inflightJobs.size && !dirty && !sched.pendingKeys().length) killWorker(); }, IDLE_TERMINATE_MS);
    }

    // Returns true when a job was posted.
    function pump() {
      clearTimeout(pumpTimer); pumpTimer = 0;
      if (!running || dirty) return false;
      if (!worker && !starting) {
        // Work is pending but the worker was released: bring it back through a sync.
        if (sched.pendingKeys().length) { dirty = true; armQuiet(); }
        return false;
      }
      if (!worker || !workerReady || sigQueue.length) return false;
      const t = now();
      if (t < backoffUntil && sched.pendingKeys().length) { schedulePump(backoffUntil - t); return false; }
      const vis = [];
      const pos = {};
      for (const c of cur.cards) {
        const key = keyOf(cur.scope, c.id);
        if (cur.visible.has(c.id)) vis.push(key);
        pos[key] = { x: c.x, y: c.y };
      }
      sched.priorityOrder(vis, pos);
      const gate = {
        now: t,
        previewBusy: !!(opts.getPreviewBusy && opts.getPreviewBusy()),
        cameraActive: !!(opts.getCameraActive && opts.getCameraActive()),
        hidden: !!(G.document && G.document.hidden),
        active: opts.isViewActive ? !!opts.isViewActive() : true,
        sceneReady: workerSceneKey !== null && workerSceneKey === curSceneKey,
        parallelCompile: parallelCompile !== false,
        patternWindow: windowNow(),
      };
      if (sched.wantsScene(gate)) { ensureScene(); return false; }
      let posted = false;
      for (let job = sched.nextJob(gate); job; job = sched.nextJob(gate)) {
        clearTimeout(idleTimer); idleTimer = 0;
        const display = displayOf(job.imageKey);
        const rec = { jobId: ++jobSeq, key: job.key, sig: job.sig, imageKey: job.imageKey, kind: job.kind };
        inflightJobs.set(rec.jobId, rec);
        const msg = {
          v: 1, type: 'render', jobId: rec.jobId, docSeq: sigDocSeq,
          key: job.key, sig: job.sig, target: job.target, display, size: display.px, kind: job.kind,
        };
        if (job.kind === 'shader') msg.sceneKey = workerSceneKey;
        else if (gate.patternWindow > 1) msg.parallel = true;
        worker.postMessage(msg);
        if (job.kind === 'shader') {
          setEntry(job.key, { state: 'pending', bitmap: (entries.get(job.key) || OFF).bitmap, phase: 'queued' });
          armWatch();
        }
        posted = true;
      }
      // Only shader jobs left and the gate open: build their scene now, behind the pattern jobs just posted.
      if (sched.wantsSceneEarly(gate)) ensureScene();
      if (posted) { emitProgress(); return true; }
      // Results re-pump, so nothing polls while jobs are in flight.
      if (inflightJobs.size) return false;
      if (sched.pendingKeys().length) {
        maybePrepare(gate);
        schedulePump(Math.max((G.document && G.document.hidden) ? 1000 : POLL_MS, sched.quietRemaining(t)));
      }
      else { emitProgress(); armIdle(); }
      return false;
    }

    // Asks the worker to generate the head pattern jobs while the gate is closed (one batch at a time).
    function maybePrepare(gate) {
      if (prepareBusy || preparedSigs.size >= PREPARE_MAX || !worker || !workerReady || !sched.canPrepare(gate)) return;
      const jobs = sched.prepareCandidates(PREPARE_BATCH, (sig) => preparedSigs.has(sig));
      if (!jobs.length) return;
      for (const j of jobs) preparedSigs.add(j.sig);
      prepareBusy = true;
      worker.postMessage({ v: 1, type: 'prepare', docSeq: sigDocSeq, jobs: jobs.map((j) => ({ sig: j.sig, target: j.target })) });
    }

    // imageKey is sig|transform|exposureEV|hostKey|px, plus |sceneKey for shader jobs.
    function displayOf(ik) {
      const parts = ik.split('|');
      return { transform: parts[1], exposureEV: Number(parts[2]) || 0, px: Number(parts[4]) || SIDE.large };
    }

    // Debounce: one timer, pushed out by activity.
    const editRemaining = () => Math.max(0, lastEditAt + EDIT_SYNC_MS - now());
    function armQuiet() {
      if (!running) return;
      clearTimeout(syncTimer);
      syncTimer = setTimeout(onQuiet, xmlProvider ? editRemaining() : sched.quietRemaining(now()));
    }
    // Reads the edited document. A throw (transient preview nodes) retries; after EDIT_TRIES_MAX the
    // undo snapshot's noteXml is left to deliver it.
    function pullEdit() {
      try {
        const x = xmlProvider();
        xmlProvider = null; editTries = 0;
        if (typeof x === 'string') latestXml = x;
        return true;
      } catch (e) {
        if (++editTries < EDIT_TRIES_MAX) return false;
        xmlProvider = null; editTries = 0;
        return true;
      }
    }
    function onQuiet() {
      syncTimer = 0;
      if (!running || !dirty) return;
      if (xmlProvider) {
        if (editRemaining() > 0) { armQuiet(); return; }
        if (!pullEdit()) { syncTimer = setTimeout(onQuiet, EDIT_RETRY_MS); return; }
      } else if (sched.quietRemaining(now()) > 0) { armQuiet(); return; }
      doSync();
    }

    async function doSync() {
      if (syncBusy) { syncAgain = true; return; }
      syncBusy = true;
      try {
        do {
          syncAgain = false;
          if (!running || !anyOn()) break;
          if (latestXml == null) { dirty = false; break; }
          const w = await ensureWorker();
          if (!w || !running || !anyOn()) break;
          postSync(w);
        } while (syncAgain);
      } finally { syncBusy = false; }
    }

    function filesDelta() {
      const add = {};
      const remove = [];
      let changed = false;
      for (const p of Object.keys(latestFiles)) {
        if (workerFiles.get(p) !== latestFiles[p]) { add[p] = latestFiles[p]; changed = true; }
      }
      for (const p of workerFiles.keys()) if (!(p in latestFiles)) { remove.push(p); changed = true; }
      return { add, remove, changed };
    }

    function postSync(w) {
      const cards = enabledCards();
      const keys = cards.map((c) => ({ key: keyOf(cur.scope, c.id), target: c.target }));
      if (!keys.length) { dirty = false; return; }
      const display = readDisplay();
      const settings = readSettings();
      const settingsKey = JSON.stringify(settings);
      const files = filesDelta();
      const docChanged = latestXml !== postedXml || files.changed || settingsKey !== postedSettingsKey;
      clearTimeout(idleTimer); idleTimer = 0;
      // The worker runs messages in order; a long shader job would hold the new document back.
      if (docChanged && shaderJob()) cancelInflight(true);
      if (docChanged) {
        preparedSigs.clear();
        w.postMessage({ v: 1, type: 'setDocument', docSeq: ++docSeq, xml: latestXml, files: { add: files.add, remove: files.remove }, settings, display, keys });
        postedXml = latestXml;
        postedSettingsKey = settingsKey;
        for (const p of files.remove) workerFiles.delete(p);
        for (const p of Object.keys(files.add)) workerFiles.set(p, files.add[p]);
      } else {
        w.postMessage({ v: 1, type: 'requestSignatures', docSeq, keys });
      }
      sigQueue.push({ keys, xml: latestXml });
      dirty = false;
    }

    // Everything the user can see changing state: off entries for disabled cards, pending for
    // enabled ones that have nothing yet.
    function syncStates() {
      for (const c of cur.cards) {
        const key = keyOf(cur.scope, c.id);
        const on = !disabledReason && c.eligible && sched.isEnabled(cur.scope, c.id, true, kindOfCard(c));
        const prev = entries.get(key);
        if (!on) { if (prev) setEntry(key, { state: 'off' }); continue; }
        if (!prev) {
          const ik = desiredImageKey.get(key);
          const hit = ik ? cacheTouch(ik) : null;
          if (hit) setEntry(key, { state: hit.approx ? 'approx' : 'ready', bitmap: hit.bitmap, title: hit.title });
          else setEntry(key, { state: 'pending' });
        }
      }
    }

    function stopRunning() {
      if (!running) { emitProgress(); return; }
      running = false;
      clearTimers();
      detachListeners();
      killWorker();
      dirty = false;
      xmlProvider = null; editTries = 0;
      sched.applySignatures([], cacheHas);
      desiredSig.clear();
      desiredImageKey.clear();
      lastKeys = [];
      emitProgress();
    }

    function startRunning() {
      if (running) return;
      running = true;
      attachListeners();
    }

    // Called after anything that can change what is enabled.
    function reconcile() {
      syncStates();
      if (!anyOn()) { cur.enabledSig = ''; stopRunning(); return; }
      cur.enabledSig = computeEnabledSig();
      startRunning();
      dirty = true;
      armQuiet();
      warmWorker();
    }

    // Display and settings listeners, attached only while something is enabled.
    let lastHostKey = '';
    let lastSettingsKey = '';
    const onDisplay = () => { if (running && lastKeys.length) { evaluate(); pump(); } };
    const onSettings = () => {
      if (!running) return;
      const hk = readHostKey();
      const sk = JSON.stringify(readSettings());
      const hostChanged = hk !== lastHostKey;
      const settingsChanged = sk !== lastSettingsKey;
      if (!hostChanged && !settingsChanged) { onSceneInputs(); return; }
      onSceneInputsQuiet();
      lastHostKey = hk;
      lastSettingsKey = sk;
      if (hostChanged && worker && workerReady) {
        const host = hostSnapshots();
        worker.postMessage({ v: 1, type: 'setHost', gen: host.gen, three: host.three, assembly: host.assembly });
      }
      if (settingsChanged) { dirty = true; armQuiet(); } else if (lastKeys.length) { evaluate(); pump(); }
    };
    // Scene inputs (environment, key light, anisotropy, transparency, displacement) only move shader keys.
    const onSceneInputs = () => {
      if (!running) return;
      const sk = JSON.stringify(readSceneInputs());
      if (sk === lastSceneInputs) return;
      lastSceneInputs = sk;
      if (lastKeys.length) { evaluate(); pump(); }
    };
    const onSceneInputsQuiet = () => { lastSceneInputs = JSON.stringify(readSceneInputs()); };
    const onHidden = () => {
      if (G.document && G.document.hidden && running && worker && workerReady) worker.postMessage({ v: 1, type: 'trim' });
    };
    const EVENTS = [
      ['mtlx-display-transform', onDisplay], ['mtlx-display-exposure', onDisplay],
      ['mtlx-settings-changed', onSettings], ['mtlx-render-setting', onSettings],
      ['mtlx-environment-changed', onSceneInputs],
    ];
    function attachListeners() {
      if (listenersOn || !G.addEventListener) return;
      listenersOn = true;
      lastHostKey = readHostKey();
      lastSettingsKey = JSON.stringify(readSettings());
      lastSceneInputs = JSON.stringify(readSceneInputs());
      for (const [name, fn] of EVENTS) G.addEventListener(name, fn);
      if (G.document && G.document.addEventListener) G.document.addEventListener('visibilitychange', onHidden);
    }
    function detachListeners() {
      if (!listenersOn) return;
      listenersOn = false;
      for (const [name, fn] of EVENTS) G.removeEventListener(name, fn);
      if (G.document && G.document.removeEventListener) G.document.removeEventListener('visibilitychange', onHidden);
    }

    // ---- Public API ----
    const noteXml = (xml) => {
      if (xml === latestXml) return;
      latestXml = xml;
      xmlProvider = null; editTries = 0;
      if (!running) return;
      sched.noteActivity(now());
      dirty = true;
      armQuiet();
    };

    // An edit happened: getXml() returns the document text (it may throw while preview nodes exist).
    const noteEdit = (getXml) => {
      if (!running || typeof getXml !== 'function') return;
      xmlProvider = getXml;
      lastEditAt = now();
      sched.noteActivity(lastEditAt);
      dirty = true;
      armQuiet();
    };

    const noteFiles = (fileMap) => {
      latestFiles = fileMap || {};
      if (!running) return;
      if (filesDelta().changed) { dirty = true; armQuiet(); }
    };

    const noteActivity = () => {
      if (!running) return;
      sched.noteActivity(now());
      if (dirty) armQuiet();
    };

    const setScope = (scope, cards, o) => {
      const entered = !!(o && o.entered);
      const list = cards || [];
      if (entered) sched.enterScope(scope, list.length); else sched.keepScope(scope);
      const scopeChanged = scope !== cur.scope;
      cur.scope = scope;
      cur.cards = list;
      cur.byId = new Map();
      cur.eligibleIds = [];
      cur.eligibleKinds = [];
      let sig = '';
      for (const c of list) {
        cur.byId.set(c.id, c);
        if (c.eligible) { cur.eligibleIds.push(c.id); cur.eligibleKinds.push({ id: c.id, kind: kindOfCard(c) }); }
      }
      const nowOn = anyOn();
      if (nowOn) sig = computeEnabledSig();
      const changed = entered || scopeChanged || sig !== cur.enabledSig;
      cur.enabledSig = sig;
      if (!nowOn) { syncStates(); stopRunning(); return; }
      syncStates();
      startRunning();
      if (changed) { dirty = true; armQuiet(); warmWorker(); }
    };

    const setVisible = (ids) => {
      cur.visible = new Set(ids || []);
    };

    const menuState = (scope) => {
      if (disabledReason) return { checked: false, big: false, disabled: true, title: disabledReason };
      const big = sched.isBig(scope);
      const checked = sched.scopeOn(scope);
      return { checked, big, disabled: false, title: big && !checked ? 'Off in this graph: more than 50 nodes' : '' };
    };

    const toggleMenu = (scope) => {
      if (disabledReason) return false;
      const on = sched.toggleMenu(scope);
      persistGlobal();
      reconcile();
      return on;
    };

    // A size change is a layout and draw change only: entries get the new size, nothing is posted.
    const refreshSizes = () => {
      for (const [key, e] of Array.from(entries)) setEntry(key, e);
    };
    const sizeMenuState = () => ({ checked: sched.getGlobalSize() === 'large', disabled: !!disabledReason });
    const toggleMenuSize = () => {
      if (disabledReason) return false;
      sched.toggleMenuSize();
      persistGlobalSize();
      refreshSizes();
      return sched.getGlobalSize() === 'large';
    };
    const sizeOf = (scope, id) => sched.sizeOf(scope, id);
    const setSizeOverride = (scope, id, size) => { sched.setSizeOverride(scope, id, size); refreshSizes(); };
    const setSizeOverrides = (scope, ids, size) => { sched.setSizeOverrides(scope, ids, size); refreshSizes(); };

    const isEnabled = (scope, id, eligible, kind) => !disabledReason && sched.isEnabled(scope, id, eligible, kind);

    const setOverride = (scope, id, on, kind) => { sched.setOverride(scope, id, on, kind); reconcile(); };
    const setOverrides = (scope, ids, on, kind) => { sched.setOverrides(scope, ids, on, kind); reconcile(); };

    const shaderMenuState = (scope) => {
      const checked = sched.getShaderGlobal();
      if (disabledReason || !sched.scopeOn(scope)) return { checked, disabled: true, title: 'Turn on Node Thumbnails first' };
      if (parallelCompile === false) return { checked, disabled: true, title: NO_PARALLEL };
      return { checked, disabled: false, title: 'Render shader and material nodes on the shaderball. Each one compiles for a few seconds and uses extra GPU memory.' };
    };
    const toggleShaderMenu = () => {
      if (disabledReason) return false;
      sched.toggleShaderMenu();
      persistShader();
      reconcile();
      // Nothing shader-related is left to show: free the worker's scene and GL memory.
      if (!sched.getShaderGlobal() && worker && workerReady && !enabledCards().some((c) => kindOfCard(c) === 'shader')) {
        worker.postMessage({ v: 1, type: 'releaseScene' });
        workerSceneKey = null; workerEnvTag = ''; glbPosted = false;
      }
      return sched.getShaderGlobal();
    };

    const moveKey = (oldKey, newKey) => {
      for (const m of [entries, errors, desiredSig, desiredImageKey]) {
        if (m.has(oldKey)) { m.set(newKey, m.get(oldKey)); m.delete(oldKey); }
      }
      notify(oldKey);
      notify(newKey);
    };
    const remapNode = (scope, oldId, newId) => {
      sched.remapNode(scope, oldId, newId);
      if (oldId !== newId) moveKey(keyOf(scope, oldId), keyOf(scope, newId));
    };
    const remapScope = (oldScope, newScope) => {
      sched.remapScope(oldScope, newScope);
      if (oldScope === newScope) return;
      const prefix = oldScope + SEP;
      for (const k of Array.from(entries.keys())) if (k.startsWith(prefix)) moveKey(k, newScope + SEP + k.slice(prefix.length));
      if (cur.scope === oldScope) cur.scope = newScope;
    };

    const resetSession = () => {
      sched.resetSession();
      for (const k of Array.from(entries.keys())) setEntry(k, { state: 'off' });
      errors.clear();
      ctxRetried.clear();
      cur.enabledSig = '';
      latestXml = null;
      latestFiles = {};
      xmlProvider = null;
      stopRunning();
    };

    const subscribe = (key, fn) => {
      let set = listeners.get(key);
      if (!set) { set = new Set(); listeners.set(key, set); }
      set.add(fn);
      return () => {
        set.delete(fn);
        if (!set.size && listeners.get(key) === set) listeners.delete(key);
      };
    };
    const get = (key) => entries.get(key) || OFF;

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      stopRunning();
      clearTimers();
      for (const v of cache.values()) { try { v.bitmap.close(); } catch (e) { /* already closed */ } }
      cache.clear();
      entries.clear();
      listeners.clear();
    };

    return {
      noteXml, noteEdit, noteFiles, noteActivity, noteCanvasIdle: noteActivity,
      setScope, setVisible,
      menuState, toggleMenu, shaderMenuState, toggleShaderMenu, sizeMenuState, toggleMenuSize, sizeOf, setSizeOverride, setSizeOverrides, isEnabled, setOverride, setOverrides, remapNode, remapScope, resetSession,
      subscribe, get, keyOf, dispose,
    };
  }

  const api = { create, THUMBS_STORAGE_KEY, THUMB_SIZE_STORAGE_KEY, SHADER_THUMBS_STORAGE_KEY };
  G.MtlxThumbClient = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})();
