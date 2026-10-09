// Pure state machine for node thumbnails: enable state, render queue, dispatch
// gate and X/N progress. No timers or DOM; callers pass `now` in milliseconds.
// scopeOn = G && (!bigAtEntry || optIn); defaultOn = scopeOn && (kind !== 'shader' || Gs);
// enabled = eligible && (override || defaultOn). Cards are 'pattern' or 'shader' jobs.
// Queue priority: visible patterns, other patterns, visible shaders, other shaders.
(function () {
  'use strict';

  const SEP = '\u0000';
  const okey = (scope, id) => scope + SEP + id;

  function createScheduler(options) {
    const cfg = options || {};
    const quietMs = cfg.quietMs == null ? 400 : cfg.quietMs;
    const bigThreshold = cfg.bigThreshold == null ? 50 : cfg.bigThreshold;

    // Enable state.
    let G = true;
    let Gs = false; // shader and material nodes on the shaderball, off by default
    const bigAtEntry = new Map();
    const optIn = new Set();
    const overrides = new Map();
    // Size: global 'small' | 'large' plus session overrides; an override equal to the global is dropped.
    let sizeG = 'small';
    const sizeOv = new Map();

    const setGlobal = (on) => { G = !!on; };
    const getGlobal = () => G;
    const enterScope = (scope, cardCount) => { bigAtEntry.set(scope, cardCount > bigThreshold); };
    // Undo and external reload keep the previous evaluation; nothing to recompute.
    const keepScope = () => {};
    const isBig = (scope) => bigAtEntry.get(scope) === true;
    const scopeOn = (scope) => G && (!isBig(scope) || optIn.has(scope));

    const kindOf = (k) => (k === 'shader' ? 'shader' : 'pattern');
    const defaultOn = (scope, kind) => scopeOn(scope) && (kindOf(kind) !== 'shader' || Gs);
    const setShaderGlobal = (on) => { Gs = !!on; };
    const getShaderGlobal = () => Gs;
    // Like the main menu, the switch drops the per-node overrides of shader cards.
    const toggleShaderMenu = () => {
      for (const [k, v] of Array.from(overrides)) if (v.kind === 'shader') overrides.delete(k);
      Gs = !Gs;
      return Gs;
    };

    // The menu switches every card, so per-node overrides (V) go: of this scope for a
    // big-scope opt-in, of every scope when G flips.
    const toggleMenu = (scope) => {
      const prefix = isBig(scope) ? scope + SEP : '';
      for (const k of Array.from(overrides.keys())) if (k.startsWith(prefix)) overrides.delete(k);
      if (scopeOn(scope)) {
        if (isBig(scope)) optIn.delete(scope);
        else G = false;
      } else {
        if (isBig(scope)) optIn.add(scope);
        G = true;
      }
      return scopeOn(scope);
    };

    const isEnabled = (scope, id, eligible, kind) => {
      if (!eligible) return false;
      const ov = overrides.get(okey(scope, id));
      if (ov) return ov.on;
      return defaultOn(scope, kind);
    };

    const setOverride = (scope, id, desiredOn, kind) => {
      const k = okey(scope, id);
      if (!!desiredOn === defaultOn(scope, kind)) overrides.delete(k);
      else overrides.set(k, { on: !!desiredOn, kind: kindOf(kind) });
    };
    const setOverrides = (scope, ids, on, kind) => { for (const id of ids) setOverride(scope, id, on, kind); };

    const norm = (v) => (v === 'small' ? 'small' : 'large');
    const setGlobalSize = (v) => {
      sizeG = norm(v);
      for (const [k, val] of Array.from(sizeOv)) if (val === sizeG) sizeOv.delete(k);
    };
    const getGlobalSize = () => sizeG;
    const sizeOf = (scope, id) => sizeOv.get(okey(scope, id)) || sizeG;
    const setSizeOverride = (scope, id, v) => {
      const k = okey(scope, id);
      if (norm(v) === sizeG) sizeOv.delete(k); else sizeOv.set(k, norm(v));
    };
    const setSizeOverrides = (scope, ids, v) => { for (const id of ids) setSizeOverride(scope, id, v); };
    const toggleMenuSize = () => { sizeG = sizeG === 'large' ? 'small' : 'large'; setGlobalSize(sizeG); return sizeG; };

    // Items are ids (patterns) or { id, kind }.
    const anyEnabled = (scope, eligibleIds) => {
      if (!eligibleIds || !eligibleIds.length) return false;
      for (const item of eligibleIds) {
        const id = typeof item === 'object' ? item.id : item;
        const ov = overrides.get(okey(scope, id));
        if (ov && ov.on) return true;
        if (!ov && defaultOn(scope, typeof item === 'object' ? item.kind : 'pattern')) return true;
      }
      return false;
    };

    const remapNode = (scope, oldId, newId) => {
      if (oldId === newId) return;
      const a = okey(scope, oldId);
      if (sizeOv.has(a)) { sizeOv.set(okey(scope, newId), sizeOv.get(a)); sizeOv.delete(a); }
      if (!overrides.has(a)) return;
      overrides.set(okey(scope, newId), overrides.get(a));
      overrides.delete(a);
    };

    const remapScope = (oldScope, newScope) => {
      if (oldScope === newScope) return;
      const prefix = oldScope + SEP;
      const moved = [];
      for (const [k, v] of overrides) if (k.startsWith(prefix)) moved.push([k, v]);
      for (const [k, v] of moved) {
        overrides.delete(k);
        overrides.set(newScope + SEP + k.slice(prefix.length), v);
      }
      for (const [k, v] of Array.from(sizeOv)) {
        if (!k.startsWith(prefix)) continue;
        sizeOv.delete(k);
        sizeOv.set(newScope + SEP + k.slice(prefix.length), v);
      }
      if (optIn.has(oldScope)) { optIn.delete(oldScope); optIn.add(newScope); }
      if (bigAtEntry.has(oldScope)) { bigAtEntry.set(newScope, bigAtEntry.get(oldScope)); bigAtEntry.delete(oldScope); }
    };

    const resetSession = () => { overrides.clear(); sizeOv.clear(); optIn.clear(); bigAtEntry.clear(); };

    // Queue. pending: key -> entry (insertion ordered); inFlight: key -> job (one shader job, or up to
    // the gate's patternWindow pattern jobs).
    const pending = new Map();
    const inFlight = new Map();
    let batchActive = false;
    let doneCount = 0;
    let totalCount = 0;

    const maybeEndBatch = () => {
      if (batchActive && pending.size === 0 && inFlight.size === 0) {
        batchActive = false;
        doneCount = 0;
        totalCount = 0;
      }
    };

    const dropPending = (key) => {
      if (pending.delete(key)) totalCount--;
    };

    const applySignatures = (entries, cacheHas) => {
      const desired = new Map();
      for (const e of entries || []) desired.set(e.key, e);
      for (const [key, p] of Array.from(pending)) {
        const d = desired.get(key);
        if (!d || d.sig !== p.sig || (cacheHas && cacheHas(p.imageKey))) dropPending(key);
      }
      for (const job of inFlight.values()) {
        const d = desired.get(job.key);
        job.stale = !d || d.sig !== job.sig || (job.kind === 'shader' && d.imageKey !== job.imageKey);
      }
      for (const e of desired.values()) {
        if (cacheHas && cacheHas(e.imageKey)) continue;
        const p = pending.get(e.key);
        if (p && p.sig === e.sig) { pending.set(e.key, e); continue; }
        const fl = inFlight.get(e.key);
        if (fl && fl.sig === e.sig && !fl.stale) continue;
        if (!batchActive) { batchActive = true; doneCount = 0; totalCount = 0; }
        pending.set(e.key, e);
        totalCount++;
      }
      maybeEndBatch();
    };

    const isShader = (e) => e.kind === 'shader';
    const priorityOrder = (visibleKeys, positions) => {
      const vis = new Set(visibleKeys || []);
      const pos = positions || {};
      const classes = [[], [], [], [], []]; // requeued shaders, visible patterns, other patterns, visible shaders, other shaders
      for (const [key, e] of pending) {
        const ci = e.requeued ? 0 : (isShader(e) ? 3 : 1) + (vis.has(key) ? 0 : 1);
        classes[ci].push([key, e]);
      }
      const coord = (k, f) => {
        const p = pos[k];
        return p && typeof p[f] === 'number' ? p[f] : Infinity;
      };
      const byPos = (a, b) => (coord(a[0], 'y') - coord(b[0], 'y')) || (coord(a[0], 'x') - coord(b[0], 'x'));
      classes[1].sort(byPos);
      classes[3].sort(byPos);
      pending.clear();
      // Patterns run before shaders; a requeued shader leads the shader class.
      for (const ci of [1, 2, 0, 3, 4]) for (const [k, e] of classes[ci]) pending.set(k, e);
      return Array.from(pending.keys());
    };

    // Gate.
    let lastActivity = -Infinity;
    const noteActivity = (now) => { if (now > lastActivity) lastActivity = now; };
    const windowOf = (g) => Math.max(1, ((g && g.patternWindow) | 0) || 1);
    const shaderInFlight = () => { for (const j of inFlight.values()) if (j.kind === 'shader') return true; return false; };
    const canDispatch = (g) => {
      const s = g || {};
      if (inFlight.size >= windowOf(s) || shaderInFlight()) return false;
      if (s.previewBusy || s.cameraActive || s.hidden || !s.active) return false;
      return s.now - lastActivity >= quietMs;
    };
    // Milliseconds until the quiet period is over (0 when already quiet).
    const quietRemaining = (now) => Math.max(0, lastActivity + quietMs - now);

    // The entry that goes next: the first pattern not already in flight, else the first shader (pending is
    // priority ordered). A shader only goes when nothing else is in flight.
    const headEntry = () => {
      let shader = null;
      for (const [key, e] of pending) {
        if (!isShader(e)) { if (!inFlight.has(key)) return [key, e]; continue; }
        if (!shader) shader = [key, e];
      }
      return shader && inFlight.size === 0 ? shader : null;
    };
    const headKind = () => { const h = headEntry(); return h ? (isShader(h[1]) ? 'shader' : 'pattern') : null; };
    const shaderGateOpen = (g) => !!(g && g.sceneReady) && g.parallelCompile !== false;
    // True when the next job is a shader job that only waits for its scene.
    const wantsScene = (g) => {
      const h = headEntry();
      return !!h && isShader(h[1]) && canDispatch(g) && !(g && g.sceneReady) && g.parallelCompile !== false;
    };

    // The gate is closed for a reason that needs no GL (busy preview, camera, quiet period) and only
    // pattern jobs wait: the worker may generate their sources ahead.
    const canPrepare = (g) => {
      const s = g || {};
      if (inFlight.size) return false;
      if (!(s.previewBusy || s.cameraActive || s.now - lastActivity < quietMs)) return false;
      for (const e of pending.values()) if (!isShader(e)) return true;
      return false;
    };
    // Head pattern jobs in queue order; skip(sig) leaves out the ones already prepared.
    const prepareCandidates = (n, skip) => {
      const out = [];
      for (const [key, e] of pending) {
        if (out.length >= n) break;
        if (isShader(e) || (skip && skip(e.sig))) continue;
        out.push({ key, sig: e.sig, target: e.target });
      }
      return out;
    };
    // True when only shader jobs are left to post and the gate is open: their scene can be built now.
    const wantsSceneEarly = (g) => {
      const s = g || {};
      if (s.sceneReady || s.parallelCompile === false || s.previewBusy || s.cameraActive || s.hidden || !s.active) return false;
      if (s.now - lastActivity < quietMs || shaderInFlight()) return false;
      let shader = false;
      for (const e of pending.values()) { if (!isShader(e)) return false; shader = true; }
      return shader;
    };

    const nextJob = (gate) => {
      if (!pending.size || !canDispatch(gate)) return null;
      const h = headEntry();
      if (!h) return null;
      if (isShader(h[1]) && !shaderGateOpen(gate)) return null;
      const [key, e] = h;
      pending.delete(key);
      const kind = isShader(e) ? 'shader' : 'pattern';
      inFlight.set(key, { key, sig: e.sig, imageKey: e.imageKey, target: e.target, kind, stale: false });
      return { key, sig: e.sig, imageKey: e.imageKey, target: e.target, kind };
    };

    // A shader job is cheap to abandon, so a pattern job that appears while one runs takes over.
    const wantsPreempt = () => {
      if (!shaderInFlight()) return false;
      for (const e of pending.values()) if (!isShader(e)) return true;
      return false;
    };

    // Returns { key, sig, imageKey, stale } for the finished job, or null if it is not the in-flight one.
    // requeue puts it back at the head of the shader class without counting it done.
    const complete = (jobKey, o) => {
      const done = inFlight.get(jobKey);
      if (!done) return null;
      inFlight.delete(jobKey);
      if (o && o.requeue && !done.stale) {
        const entry = { key: done.key, sig: done.sig, imageKey: done.imageKey, target: done.target, kind: done.kind, requeued: true };
        const rest = Array.from(pending);
        pending.clear();
        pending.set(entry.key, entry);
        for (const [k, e] of rest) pending.set(k, e);
      } else {
        doneCount++;
        maybeEndBatch();
      }
      return { key: done.key, sig: done.sig, imageKey: done.imageKey, stale: done.stale };
    };

    const progress = () => (batchActive ? { done: doneCount, total: totalCount } : null);

    return {
      setGlobal, getGlobal, setShaderGlobal, getShaderGlobal, toggleShaderMenu, defaultOn, enterScope, keepScope, isBig, scopeOn, toggleMenu, isEnabled,
      setOverride, setOverrides, anyEnabled, setGlobalSize, getGlobalSize, sizeOf, setSizeOverride, setSizeOverrides, toggleMenuSize, remapNode, remapScope, resetSession,
      applySignatures, priorityOrder, noteActivity, canDispatch, quietRemaining, nextJob, complete, progress, wantsPreempt, wantsScene, wantsSceneEarly, canPrepare, prepareCandidates, headKind,
      pendingKeys: () => Array.from(pending.keys()),
      inFlightKey: () => { for (const j of inFlight.values()) return j.key; return null; },
      inFlightKind: () => { for (const j of inFlight.values()) return j.kind; return null; },
      isInFlightStale: () => { for (const j of inFlight.values()) return j.stale; return false; },
      inFlightKeys: () => Array.from(inFlight.keys()),
      inFlightCount: () => inFlight.size,
      isStale: (key) => { const j = inFlight.get(key); return !!(j && j.stale); },
    };
  }

  const api = { createScheduler };
  globalThis.MtlxThumbScheduler = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})();
