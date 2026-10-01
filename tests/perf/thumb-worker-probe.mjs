#!/usr/bin/env node
/* Parity probe for the node thumbnail worker: renders every pattern target of each
   fixture twice, once in js/graph/thumb-worker.js and once with the page engine
   (createMtlxRenderView on buffer2d), then reports per-target pixel differences and
   writes thumbnail/reference/diff PNGs plus a contact sheet. Real-GPU by default. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startServer } from '../embed/lib/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELP = 'Usage: node tests/perf/thumb-worker-probe.mjs [--out <dir>] [--fixtures <dir>] [--size 128] [--max-per-fixture 40] [--software] [--shader [--parity] [--goldens <dir>] [--no-prefiltered]]';

function parseArgs(argv) {
  const out = {
    out: path.join(ROOT, 'scratchpad/thumbs/wp5/out'),
    fixtures: path.join(ROOT, 'scratchpad/thumbs/fixtures'),
    size: 128, maxPerFixture: 40, software: false,
    shader: false, parity: false, prefiltered: true, goldens: path.join(ROOT, 'scratchpad/thumbs/scene-goldens-s0'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { if (argv[++i] == null) throw new Error(`${a} requires a value`); return argv[i]; };
    if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else if (a === '--out') out.out = next();
    else if (a === '--fixtures') out.fixtures = next();
    else if (a === '--size') out.size = Number(next());
    else if (a === '--max-per-fixture') out.maxPerFixture = Number(next());
    else if (a === '--software') out.software = true;
    else if (a === '--shader') out.shader = true;
    else if (a === '--parity') out.parity = true;
    else if (a === '--no-prefiltered') out.prefiltered = false;
    else if (a === '--goldens') out.goldens = next();
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

// Runs in the page (serialized by toString).
async function probeFixture(xml, fileNames, size, maxTargets, docSeq) {
  const win = window;
  const need = ['parseMtlxDocument', 'getMxEnv', 'mxExclusive', 'buildScope', 'docChildren', 'mxElName', 'mxElCat',
    'buildPreviewRenderable', 'createMtlxRenderView', 'bindDroppedTextures'];
  const missing = need.filter((k) => typeof win[k] !== 'function');
  if (missing.length) throw new Error('missing page globals: ' + missing.join(','));
  const VIEWABLE = win.MtlxGenCore.COLOR_VIEWABLE;

  // Deterministic test textures, one per referenced file name.
  const fileMap = {};
  const hash = (s) => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
  for (const name of fileNames) {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    const h = hash(name);
    const grad = g.createLinearGradient(0, 0, 256, 256);
    grad.addColorStop(0, `hsl(${h % 360},70%,40%)`);
    grad.addColorStop(1, `hsl(${(h >> 8) % 360},60%,70%)`);
    g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if ((x + y) % 2 === 0) g.fillRect(x * 32, y * 32, 32, 32);
    g.fillStyle = '#000'; g.fillRect(8, 8, 40, 20);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    fileMap[name] = new File([blob], name, { type: 'image/png', lastModified: 1700000000000 });
  }

  const parsed = await win.parseMtlxDocument(xml);
  const env = await win.getMxEnv();
  const { mx, gen, lightData } = env;
  const scopes = [''];
  for (const el of win.docChildren(parsed.doc)) if (win.mxElCat(el) === 'nodegraph') scopes.push(win.mxElName(el));

  // Eligible targets: pattern types only.
  const targets = [];
  for (const scope of scopes) {
    let descs;
    try { descs = await win.mxExclusive(() => win.buildScope(parsed, scope).descs); } catch (e) { continue; }
    for (const d of descs) {
      if (/^[dg]:/.test(d.id) && d.functional) continue;
      let type = d.type;
      if (!type || type === 'multioutput' || /^g:/.test(d.id)) {
        const outs = d.outputs || [];
        const pick = outs.find((o) => VIEWABLE.indexOf(o.type) !== -1) || outs[0];
        type = pick ? pick.type : '';
      }
      if (VIEWABLE.indexOf(type) === -1) continue;
      targets.push({ id: d.id, scope });
    }
  }
  const picked = targets.slice(0, maxTargets);

  // Worker.
  const base = document.baseURI;
  const abs = (p) => new URL(p, base).href;
  const version = env.version;
  const wasm = await (await fetch(abs(`js/materialx/${version}/JsMaterialXGenShader.wasm`))).arrayBuffer();
  const data = await (await fetch(abs(`js/materialx/${version}/JsMaterialXGenShader.data`))).arrayBuffer();
  const worker = new Worker(abs('js/graph/thumb-worker.js'), { type: 'module' });
  const waiters = [];
  const inbox = [];
  worker.onmessage = (e) => { inbox.push(e.data); waiters.splice(0).forEach((w) => w()); };
  worker.onerror = (e) => { inbox.push({ type: 'fatal', message: 'worker error: ' + e.message }); waiters.splice(0).forEach((w) => w()); };
  const take = async (pred, timeoutMs = 120000) => {
    const t0 = performance.now();
    for (;;) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      const f = inbox.findIndex((m) => m.type === 'fatal');
      if (f >= 0) throw new Error('worker fatal: ' + inbox[f].message);
      if (performance.now() - t0 > timeoutMs) throw new Error('timeout waiting for worker');
      await new Promise((r) => { waiters.push(r); setTimeout(r, 500); });
    }
  };
  worker.postMessage({
    v: 1, type: 'init',
    mtlx: { version, factoryUrl: abs(`js/materialx/${version}/JsMaterialXGenShader.js`), wasm, data },
    three: { url: abs('vendor/three/three.min.js') },
    loaders: {
      fflate: abs('vendor/three/fflate.min.js'), exr: abs('js/vendor/EXRLoader.js'), hdr: abs('vendor/three/RGBELoader.js'),
      pako: abs('vendor/pako/pako_inflate.min.js'), utif: abs('vendor/utif/UTIF.js'),
    },
    rigLights: lightData.length,
    buildId: String(win.__MTLX_BUILD || ''),
    host: { gen: win.MtlxGenCore.hostSnapshot(), three: win.MtlxThreeMaterial.hostSnapshot() },
  }, [wasm, data]);
  const ready = await take((m) => m.type === 'ready');
  const display = { transform: win.getDisplayTransform ? win.getDisplayTransform() : 'srgb', exposureEV: win.getDisplayExposure ? win.getDisplayExposure() : 0 };
  const keys = picked.map((t, i) => ({ key: 'k' + i, target: t }));
  worker.postMessage({ v: 1, type: 'setDocument', docSeq, xml, files: { add: fileMap, remove: [] }, settings: {}, display, keys });
  const sigMsg = await take((m) => m.type === 'signatures' && m.docSeq === docSeq);

  const readPixels = (source, w, h) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(source, 0, 0, w, h);
    return g.getImageData(0, 0, w, h);
  };
  const toPng = (img) => {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  };

  const compoundRoot = (() => { try { return !!win.MtlxRenderSettings.get('graphCompoundCompile', { surface: 'graph' }); } catch (e) { return false; } })();
  const results = [];
  let jobId = 0;
  for (let i = 0; i < picked.length; i++) {
    const target = picked[i];
    const rec = { id: target.id, scope: target.scope };
    try {
      jobId += 1;
      worker.postMessage({ v: 1, type: 'render', jobId, docSeq, key: keys[i].key, sig: sigMsg.sigs[keys[i].key], target, display, size });
      const res = await take((m) => (m.type === 'result' || m.type === 'error' || m.type === 'stale') && m.jobId === jobId);
      if (res.type !== 'result') { rec.workerError = res.kind ? res.kind + ': ' + res.message : res.type; results.push(rec); continue; }
      rec.ms = res.ms; rec.approx = !!res.approx; rec.notices = res.notices;
      const thumb = readPixels(res.bitmap, size, size);
      res.bitmap.close();

      // Reference: the sidebar pipeline on the flat 2D quad.
      const host = document.createElement('div');
      host.style.cssText = `position:fixed;left:0;top:0;width:${size}px;height:${size}px;opacity:0;pointer-events:none`;
      const canvas = document.createElement('canvas');
      canvas.style.cssText = 'width:100%;height:100%;display:block';
      host.appendChild(canvas);
      document.body.appendChild(host);
      const needsFresh = !!(parsed.hasDefinitions || target.scope || compoundRoot);
      const freshCtx = needsFresh && typeof env.createGenContext === 'function' ? env.createGenContext() : null;
      const genContext = freshCtx || env.genContext;
      let built = null;
      let view = null;
      try {
        built = await win.mxExclusive(() => win.buildPreviewRenderable(parsed, target));
        if (!built.renderable) { rec.refError = 'no renderable'; results.push(rec); continue; }
        view = await win.createMtlxRenderView({
          canvas, mx, gen, genContext, renderable: built.renderable, lightData,
          materialName: built.materialName || null, label: built.label || 'probe',
          needsLighting: true, geomName: 'buffer2d', autoRotate: false, backdrop: undefined,
          isMounted: () => true, isActive: () => true, debugKind: 'thumb-probe',
        });
      } finally {
        if (built) { try { await win.mxExclusive(() => built.cleanup()); } catch (e) { /* best-effort */ } }
        if (freshCtx) { try { freshCtx.delete(); } catch (e) { /* best-effort */ } }
      }
      if (!view) { rec.refError = 'no view'; host.remove(); results.push(rec); continue; }
      const rep = win.bindDroppedTextures(view, fileMap);
      await Promise.all(rep.pending || []);
      const ref = view.snapshotPixels(size, size);
      view.dispose();
      host.remove();

      const diff = new ImageData(size, size);
      let sum = 0, max = 0, over = 0;
      for (let p = 0; p < thumb.data.length; p += 4) {
        let m = 0;
        for (let c = 0; c < 4; c++) {
          const d = Math.abs(thumb.data[p + c] - ref.data[p + c]);
          sum += d; if (d > m) m = d;
        }
        if (m > max) max = m;
        if (m > 8) over += 1;
        const v = Math.min(255, m * 8);
        diff.data[p] = v; diff.data[p + 1] = v; diff.data[p + 2] = v; diff.data[p + 3] = 255;
      }
      rec.mean = sum / thumb.data.length;
      rec.max = max;
      rec.pixelsOver8 = over;
      rec.thumbPng = toPng(thumb);
      rec.refPng = toPng(ref);
      rec.diffPng = toPng(diff);
    } catch (e) {
      rec.error = String((e && e.message) || e);
    }
    results.push(rec);
  }
  // A stale docSeq must be answered with `stale`.
  worker.postMessage({ v: 1, type: 'render', jobId: 9999, docSeq: docSeq - 1, key: 'x', sig: 'x', target: { id: 'n:x' }, size });
  const stale = await take((m) => m.jobId === 9999);
  worker.terminate();
  return {
    loaders: ready.capabilities.loaders, viewable: ready.capabilities.viewableTypes,
    eligible: targets.length, sigError: sigMsg.error || null, signatures: Object.keys(sigMsg.sigs).length, missingSigs: sigMsg.missing, staleReply: stale.type,
    results,
  };
}

// Worker-only checks: a KTX2-only texture must fall back with approx set.
async function probeKtx2(xml, size) {
  const win = window;
  const env = await win.getMxEnv();
  const abs = (p) => new URL(p, document.baseURI).href;
  const wasm = await (await fetch(abs(`js/materialx/${env.version}/JsMaterialXGenShader.wasm`))).arrayBuffer();
  const data = await (await fetch(abs(`js/materialx/${env.version}/JsMaterialXGenShader.data`))).arrayBuffer();
  const worker = new Worker(abs('js/graph/thumb-worker.js'), { type: 'module' });
  const next = () => new Promise((r) => { worker.onmessage = (e) => r(e.data); });
  let p = next();
  worker.postMessage({
    v: 1, type: 'init', mtlx: { version: env.version, factoryUrl: abs(`js/materialx/${env.version}/JsMaterialXGenShader.js`), wasm, data },
    three: { url: abs('vendor/three/three.min.js') }, loaders: {}, rigLights: env.lightData.length, buildId: 'probe',
    host: { gen: win.MtlxGenCore.hostSnapshot(), three: win.MtlxThreeMaterial.hostSnapshot() },
  }, [wasm, data]);
  await p;
  p = next();
  const keys = [{ key: 'a', target: { id: 'n:image_color', scope: 'NG_brass1' } }];
  worker.postMessage({
    v: 1, type: 'setDocument', docSeq: 1, xml, settings: {}, keys,
    files: { add: { 'brass_color.ktx2': new Blob([new Uint8Array(32)]) }, remove: [] },
  });
  const sigs = await p;
  p = next();
  worker.postMessage({ v: 1, type: 'render', jobId: 1, docSeq: 1, key: 'a', sig: sigs.sigs.a, target: keys[0].target, size, display: { transform: 'srgb', exposureEV: 0 } });
  const res = await p;
  const out = { type: res.type, approx: res.approx, notices: res.notices, message: res.message };
  worker.terminate();
  return out;
}


// ---- Shader thumbnails on the shaderball scene (--shader) ----
const SHADER_TARGETS = [
  { name: 'marble', file: 'marble.mtlx', target: { id: 'n:Marble_3D', scope: '' } },
  { name: 'textured_standard_surface', file: 'textured_standard_surface.mtlx', target: { id: 'n:Tiled_Brass', scope: '' } },
  { name: 'open_pbr', file: 'open_pbr.mtlx', target: { id: 'n:Car_Paint', scope: '' } },
  { name: 'glass', file: 'glass.mtlx', target: { id: 'n:Glass', scope: '' } },
  { name: 'bsdf', file: 'closures.mtlx', target: { id: 'n:bsdf1', scope: '' } },
  { name: 'edf', file: 'closures.mtlx', target: { id: 'n:edf1', scope: '' } },
  { name: 'nodegraph_surfaceshader', file: 'nodegraph_surface.mtlx', target: { id: 'o:surf_out', scope: 'NG_surf' } },
];

// Runs in the page (serialized by toString): worker vs the S0 reference frames, with and without the room downscale.
async function probeShader(job) {
  const win = window;
  const size = job.size;
  const abs = (p) => new URL(p, document.baseURI).href;
  const env = await win.getMxEnv();
  await win.getEnvironment();
  const version = env.version;

  // A page view once, so the page's prefiltered chains exist to be sent along.
  if (job.prefiltered) {
    const parsed = await win.parseMtlxDocument(job.fixtures.marble.xml);
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;width:' + size + 'px;height:' + size + 'px;opacity:0';
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'width:100%;height:100%;display:block';
    host.appendChild(canvas);
    document.body.appendChild(host);
    const built = await win.mxExclusive(() => win.buildPreviewRenderable(parsed, { id: 'n:Marble_3D', scope: '' }));
    const view = await win.createMtlxRenderView({
      canvas, mx: env.mx, gen: env.gen, genContext: env.genContext, renderable: built.renderable, lightData: env.lightData,
      materialName: built.materialName || null, label: 'prefilter-seed', needsLighting: true, geomName: 'shaderball-scene',
      sceneOrbit: true, autoRotate: false, isMounted: () => true, isActive: () => true, debugKind: 'graph-preview',
    });
    await win.mxExclusive(() => built.cleanup());
    if (view) view.dispose();
    host.remove();
  }
  const src = win.getEnvironmentSource();
  const envBytes = await (await fetch(abs(src.url))).arrayBuffer();

  const wasm = await (await fetch(abs('js/materialx/' + version + '/JsMaterialXGenShader.wasm'))).arrayBuffer();
  const data = await (await fetch(abs('js/materialx/' + version + '/JsMaterialXGenShader.data'))).arrayBuffer();
  const glbBytes = await (await fetch(abs('models/shaderball.glb'))).arrayBuffer();
  const worker = new Worker(abs('js/graph/thumb-worker.js'), { type: 'module' });
  const waiters = [];
  const inbox = [];
  worker.onmessage = (e) => { inbox.push(Object.assign({ at: performance.now() }, e.data)); waiters.splice(0).forEach((w) => w()); };
  worker.onerror = (e) => { inbox.push({ type: 'fatal', message: 'worker error: ' + e.message }); waiters.splice(0).forEach((w) => w()); };
  const take = async (pred, timeoutMs = 60000) => {
    const t0 = performance.now();
    for (;;) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      const fi = inbox.findIndex((m) => m.type === 'fatal');
      if (fi >= 0) throw new Error('worker fatal: ' + inbox[fi].message);
      if (performance.now() - t0 > timeoutMs) throw new Error('timeout waiting for worker; inbox ' + JSON.stringify(inbox.map((m) => m.type + ':' + (m.kind || m.stage || '') + ':' + (m.message || ''))));
      await new Promise((r) => { waiters.push(r); setTimeout(r, 500); });
    }
  };
  const rig = env.lightData.map((l) => ({ type: l.type, direction: l.direction.toArray(), color: l.color.toArray(), intensity: l.intensity }));
  worker.postMessage({
    v: 1, type: 'init',
    mtlx: { version, factoryUrl: abs('js/materialx/' + version + '/JsMaterialXGenShader.js'), wasm, data },
    three: { url: abs('vendor/three/three.min.js') },
    loaders: {
      fflate: abs('vendor/three/fflate.min.js'), exr: abs('js/vendor/EXRLoader.js'), hdr: abs('vendor/three/RGBELoader.js'),
      pako: abs('vendor/pako/pako_inflate.min.js'), utif: abs('vendor/utif/UTIF.js'),
    },
    scene: {
      gltfLoader: abs('vendor/three/GLTFLoader.js'), orbitControls: abs('vendor/three/OrbitControls.js'),
      renderEnvironment: abs('js/shared/render-environment.js'), renderSession: abs('js/shared/render-session.js'),
    },
    rigLights: rig,
    buildId: String(win.__MTLX_BUILD || ''),
    host: { gen: win.MtlxGenCore.hostSnapshot(), three: win.MtlxThreeMaterial.hostSnapshot(), assembly: win.MtlxSceneAssembly.hostSnapshot() },
  }, [wasm, data]);
  const ready = await take((m) => m.type === 'ready');
  const out = { parallelCompile: ready.capabilities.parallelCompile, prefilteredSent: !!src.prefiltered, variants: {} };

  const display = { transform: 'srgb', exposureEV: 0 };
  const setScene = async (sceneKey, extra) => {
    const t0 = performance.now();
    worker.postMessage({
      v: 1, type: 'setScene', sceneKey, size,
      env: { id: src.id, ext: src.ext, bytes: envBytes.slice(0), keyLight: win.getKeyLightEnabled(), prefiltered: src.prefiltered || undefined },
      glb: { id: 'shaderball', bytes: glbBytes.slice(0) },
      opts: Object.assign({ anisotropy: win.getTextureAnisotropy(), forceTransparency: false, displacement: true }, extra || {}),
    });
    const m = await take((x) => x.type === 'sceneReady' || (x.type === 'error' && x.kind === 'scene'));
    if (m.type === 'error') throw new Error('setScene: ' + m.message);
    return { ms: m.ms, wallMs: performance.now() - t0, gpuMB: +(m.gpuBytesEstimate / 1048576).toFixed(1) };
  };

  // Documents and files, one setDocument per fixture.
  const files = {};
  for (const name of job.textureNames) {
    const buf = await (await fetch(job.fixtureBase + name)).arrayBuffer();
    files[name] = new File([buf], name, { type: 'image/jpeg', lastModified: 1700000000000 });
  }
  let docSeq = 100;
  const docs = {};
  let currentDoc = null;
  const loadDoc = async (fixture) => {
    if (docs[fixture.file] && currentDoc === fixture.file) return docs[fixture.file];
    currentDoc = fixture.file;
    docSeq += 1;
    const keys = fixture.targets.map((t) => ({ key: t.name, target: t.target }));
    worker.postMessage({ v: 1, type: 'setDocument', docSeq, xml: fixture.xml, files: { add: files, remove: [] }, settings: {}, display, keys });
    const sm = await take((m) => m.type === 'signatures' && m.docSeq === docSeq);
    docs[fixture.file] = { docSeq, sigs: sm.sigs };
    return docs[fixture.file];
  };

  const pixelsOf = (bitmap) => {
    const c = document.createElement('canvas');
    c.width = bitmap.width; c.height = bitmap.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    return g.getImageData(0, 0, c.width, c.height);
  };
  const toPng = (img) => {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d').putImageData(img, 0, 0);
    return c.toDataURL('image/png');
  };
  const goldens = {};
  for (const t of job.targets) {
    const blob = await (await fetch(job.goldenBase + t.name + '__srgb_ev0.png')).blob();
    const bm = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    goldens[t.name] = pixelsOf(bm);
    bm.close();
  }

  let jobId = 0;
  const renderOne = async (t, extra) => {
    const fixture = job.fixtures[t.file];
    const doc = await loadDoc(fixture);
    jobId += 1;
    const id = jobId;
    const t0 = performance.now();
    worker.postMessage(Object.assign({ v: 1, type: 'render', jobId: id, docSeq: doc.docSeq, key: t.name, sig: doc.sigs[t.name] || '', target: t.target, display, size, kind: 'shader', sceneKey: job.sceneKey }, extra || {}));
    return { id, t0 };
  };
  const wait = (id) => take((m) => (m.type === 'result' || m.type === 'error' || m.type === 'stale') && m.jobId === id);
  const compare = (a, b) => {
    const diff = new ImageData(a.width, a.height);
    let max = 0, over1 = 0, over8 = 0, nz = 0;
    for (let p = 0; p < a.data.length; p += 4) {
      let m = 0;
      for (let c = 0; c < 4; c++) m = Math.max(m, Math.abs(a.data[p + c] - b.data[p + c]));
      if (m > max) max = m;
      if (m > 0) nz += 1;
      if (m > 1) over1 += 1;
      if (m > 8) over8 += 1;
      const v = Math.min(255, m * 8);
      diff.data[p] = v; diff.data[p + 1] = v; diff.data[p + 2] = v; diff.data[p + 3] = 255;
    }
    return { max, over1, over8, nz, diff };
  };

  const runVariant = async (label, sceneKey, extraOpts) => {
    job.sceneKey = sceneKey;
    const sc = await setScene(sceneKey, extraOpts);
    const rows = [];
    for (const t of job.targets) {
      const row = { name: t.name };
      const r = await renderOne(t);
      const res = await wait(r.id);
      if (res.type !== 'result') { row.error = res.kind ? res.kind + ': ' + res.message : res.type + ' ' + (res.reason || ''); rows.push(row); continue; }
      row.wallMs = Math.round(performance.now() - r.t0);
      row.timings = { genMs: Math.round(res.timings.genMs), linkMs: Math.round(res.timings.linkMs), renderMs: Math.round(res.timings.renderMs) };
      row.approx = res.approxReasons;
      row.notices = res.notices;
      const img = pixelsOf(res.bitmap);
      res.bitmap.close();
      const cmp = compare(img, goldens[t.name]);
      row.max = cmp.max; row.over1 = cmp.over1; row.over8 = cmp.over8;
      row.png = { worker: toPng(img), diff: toPng(cmp.diff) };
      rows.push(row);
    }
    return { label, setScene: sc, rows };
  };

  const runCancel = async () => {
    // Cancel tests on cold sources: the open_pbr fixture with a unique constant gets its own link.
    const cold = (n) => {
      const file = 'cold' + n;
      job.fixtures[file] = { file, xml: job.coldBase.replace('</open_pbr_surface>', '<input name="' + ['emission_luminance', 'transmission_weight', 'fuzz_weight', 'specular_weight'][n - 1] + '" type="float" value="0.5" /></open_pbr_surface>'), targets: [{ name: 'cold', target: { id: 'n:Car_Paint', scope: '' } }] };
      return { name: 'cold', file, target: { id: 'n:Car_Paint', scope: '' } };
    };
    const cancelTest = {};
    {
      const r = await renderOne(cold(1));
      const t0 = performance.now();
      worker.postMessage({ v: 1, type: 'cancel', jobId: r.id });
      const res = await wait(r.id);
      cancelTest.immediate = { reply: res.type, reason: res.reason || null, ms: Math.round(performance.now() - t0) };
    }
    const coldTwo = cold(2);
    {
      const r = await renderOne(coldTwo);
      const st = await take((m) => m.type === 'stage' && m.stage === 'compile' && m.jobId === r.id);
      const t0 = performance.now();
      worker.postMessage({ v: 1, type: 'cancel', jobId: r.id });
      const res = await wait(r.id);
      cancelTest.atCompile = { reply: res.type, reason: res.reason || null, msAfterCancel: Math.round(performance.now() - t0), msToCompileStage: Math.round(st.at - r.t0) };
    }
    {
      // Immediate re-render while the cancelled link is still running, then once it has finished.
      const r = await renderOne(coldTwo);
      const res = await wait(r.id);
      if (res.type === 'result') { cancelTest.rerenderImmediately = { ms: Math.round(performance.now() - r.t0), linkMs: Math.round(res.timings.linkMs) }; res.bitmap.close(); }
      else cancelTest.rerenderImmediately = { error: res.type + ' ' + (res.message || '') };
    }
    const coldFour = cold(4);
    {
      const r = await renderOne(coldFour);
      await take((m) => m.type === 'stage' && m.stage === 'compile' && m.jobId === r.id);
      worker.postMessage({ v: 1, type: 'cancel', jobId: r.id });
      await wait(r.id);
      await new Promise((x) => setTimeout(x, 7000));
    }
    {
      const r = await renderOne(coldFour);
      const res = await wait(r.id);
      if (res.type === 'result') { cancelTest.rerenderAfterCancel = { ms: Math.round(performance.now() - r.t0), linkMs: Math.round(res.timings.linkMs) }; res.bitmap.close(); }
      else cancelTest.rerenderAfterCancel = { error: res.type + ' ' + (res.message || '') };
    }
    {
      const r = await renderOne(cold(3));
      const res = await wait(r.id);
      if (res.type === 'result') { cancelTest.coldBaseline = { ms: Math.round(performance.now() - r.t0), linkMs: Math.round(res.timings.linkMs) }; res.bitmap.close(); }
      else cancelTest.coldBaseline = { error: res.type + ' ' + (res.message || '') };
    }
    {
      const r = await renderOne(job.targets.find((t) => t.name === 'glass'), { sceneKey: 'wrong-key' });
      const res = await wait(r.id);
      cancelTest.mismatch = { type: res.type, kind: res.kind || null };
    }
    out.cancelTest = cancelTest;
  };

  // Full parity matrix: every S0 frame, room textures capped (default) then full size.
  const runParity = async () => {
    const abs2 = (p) => new URL(p, document.baseURI).href;
    const ovBytes = await (await fetch(abs2('env_maps/studio_kontrast_04_1k.exr'))).arrayBuffer();
    const refs = {};
    for (const f of job.frames) {
      const blob = await (await fetch(job.goldenBase + f.key + '.png')).blob();
      const bm = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      refs[f.key] = pixelsOf(bm);
      bm.close();
    }
    const fileOf = (name) => job.targets.find((t) => t.name === name).file;
    const sortKey = (f) => [f.settings.envOverride ? 1 : 0, f.settings.keyLight ? 1 : 0, f.settings.transparency ? 1 : 0, f.settings.display, f.settings.ev, fileOf(f.target), f.key].join('|');
    const frames = job.frames.slice().sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
    const setSceneP = async (sceneKey, st, roomMax) => {
      worker.postMessage({
        v: 1, type: 'setScene', sceneKey, size,
        env: st.envOverride
          ? { id: 'override:studio_kontrast_04_1k.exr', ext: '.exr', bytes: ovBytes.slice(0), keyLight: st.keyLight }
          : { id: src.id, ext: src.ext, bytes: envBytes.slice(0), keyLight: st.keyLight, prefiltered: src.prefiltered || undefined },
        glb: { id: 'shaderball', bytes: glbBytes.slice(0) },
        opts: { anisotropy: win.getTextureAnisotropy(), forceTransparency: st.transparency, displacement: true, roomTextureMax: roomMax },
      });
      const m = await take((x) => x.type === 'sceneReady' || (x.type === 'error' && x.kind === 'scene'));
      if (m.type === 'error') throw new Error('setScene: ' + m.message);
    };
    const runMatrix = async (label, roomMax) => {
      const rows = {};
      const imgs = {};
      let cur = null;
      for (const f of frames) {
        const st = f.settings;
        const sk = [label, st.envOverride, st.keyLight, st.transparency].join('|');
        if (sk !== cur) { cur = sk; job.sceneKey = sk; await setSceneP(sk, st, roomMax); }
        const t = job.targets.find((x) => x.name === f.target);
        const r = await renderOne(t, { display: { transform: st.display, exposureEV: st.ev } });
        const res = await wait(r.id);
        if (res.type !== 'result') { rows[f.key] = { error: res.kind ? res.kind + ': ' + res.message : res.type + ' ' + (res.reason || '') }; continue; }
        const img = pixelsOf(res.bitmap);
        res.bitmap.close();
        const cmp = compare(img, refs[f.key]);
        imgs[f.key] = img;
        rows[f.key] = { max: cmp.max, over1: cmp.over1, over8: cmp.over8, nz: cmp.nz, approx: res.approxReasons || [], wallMs: Math.round(performance.now() - r.t0) };
        if (job.sheetKeys.includes(f.key)) rows[f.key].png = { worker: toPng(img), ref: toPng(refs[f.key]), diff: toPng(cmp.diff) };
      }
      return { rows, imgs };
    };
    const capped = await runMatrix('capped', 1024);
    job.sceneKey = 'cancel-base';
    await setSceneP('cancel-base', { envOverride: false, keyLight: true, transparency: false }, 1024);
    await runCancel();
    const full = await runMatrix('full', 0);
    const room = {};
    for (const key of Object.keys(full.imgs)) {
      const a = capped.imgs[key], b = full.imgs[key], r = refs[key];
      if (!a || !b) continue;
      let explained = 0, unexplained = 0, cappedVsFull = 0, cappedOff = 0;
      for (let p = 0; p < r.data.length; p += 4) {
        let dc = 0, df = 0, dcf = 0;
        for (let c = 0; c < 4; c++) {
          dc = Math.max(dc, Math.abs(a.data[p + c] - r.data[p + c]));
          df = Math.max(df, Math.abs(b.data[p + c] - r.data[p + c]));
          dcf = Math.max(dcf, Math.abs(a.data[p + c] - b.data[p + c]));
        }
        if (dcf) cappedVsFull += 1;
        if (dc) { cappedOff += 1; if (df === 0) explained += 1; else unexplained += 1; }
      }
      room[key] = { cappedOff, explainedByDownscale: explained, alsoOffAtFullSize: unexplained, cappedVsFull };
    }
    const tt = job.targets.find((x) => x.name === 'marble');
    const trimPair = async (tag, st) => {
      job.sceneKey = tag + '-1';
      await setSceneP(tag + '-1', st, 1024);
      const r1 = await renderOne(tt); const a1 = await wait(r1.id);
      const i1 = pixelsOf(a1.bitmap); a1.bitmap.close();
      worker.postMessage({ v: 1, type: 'trim' });
      const r2 = await renderOne(tt); const a2 = await wait(r2.id);
      const i2 = pixelsOf(a2.bitmap); a2.bitmap.close();
      const tc = compare(i1, i2);
      return { max: tc.max, differingPixels: tc.nz, byteIdentical: tc.nz === 0, wallMsAfterTrim: Math.round(performance.now() - r2.t0) };
    };
    out.trim = await trimPair('trim', { envOverride: false, keyLight: true, transparency: false });
    out.trimEnvOverride = await trimPair('trimov', { envOverride: true, keyLight: true, transparency: false });
    worker.terminate();
    out.parity = { capped: capped.rows, full: full.rows, room };
    return out;
  };
  if (job.parity) return await runParity();
  out.variants.down = await runVariant('downscale1024', 'probe-a', {});
  out.refs = {};
  for (const t of job.targets) out.refs[t.name] = toPng(goldens[t.name]);

  await runCancel();

  // Same pipeline with the room textures at full size, to show the rest is exact.
  out.variants.full = await runVariant('fullsize', 'probe-b', { roomTextureMax: 0 });

  // trim then a render must give the same bytes.
  worker.postMessage({ v: 1, type: 'trim' });
  {
    const t = job.targets[0];
    const r = await renderOne(t);
    const res = await wait(r.id);
    if (res.type === 'result') {
      const img = pixelsOf(res.bitmap);
      res.bitmap.close();
      const full = out.variants.full.rows.find((x) => x.name === t.name);
      const cmp = compare(img, goldens[t.name]);
      out.trim = { max: cmp.max, over1: cmp.over1, matchesFullVariant: full ? full.max === cmp.max && full.over1 === cmp.over1 : null, wallMs: Math.round(performance.now() - r.t0) };
    } else out.trim = { error: res.type + ' ' + (res.message || '') };
  }
  worker.terminate();
  return out;
}

async function composeShaderSheet(items, cell) {
  const labelH = 26;
  const c = document.createElement('canvas');
  c.width = cell * 3 + 8; c.height = items.length * (cell + labelH);
  const g = c.getContext('2d');
  g.fillStyle = '#222'; g.fillRect(0, 0, c.width, c.height);
  g.font = '11px sans-serif'; g.textBaseline = 'top';
  const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
  for (let n = 0; n < items.length; n++) {
    const y = n * (cell + labelH);
    const [a, b, d] = await Promise.all([load(items[n].worker), load(items[n].ref), load(items[n].diff)]);
    g.drawImage(a, 0, y, cell, cell);
    g.drawImage(b, cell + 4, y, cell, cell);
    g.drawImage(d, cell * 2 + 8, y, cell, cell);
    g.fillStyle = '#fff';
    g.fillText(items[n].label, 2, y + cell + 2);
    g.fillStyle = '#9cf';
    g.fillText(items[n].stats + '  (worker | reference | diff x8)', 2, y + cell + 14);
  }
  return c.toDataURL('image/png');
}

async function mainShader(args) {
  const outDir = path.join(ROOT, args.parity ? 'scratchpad/thumbs/s6' : 'scratchpad/thumbs/s3');
  fs.mkdirSync(outDir, { recursive: true });
  const fixtureDir = path.join(ROOT, 'scratchpad/thumbs/scene-fixtures');
  const server = await startServer({ root: ROOT });
  const browser = await chromium.launch(args.software ? { headless: true } : { headless: false, args: ['--headless=new', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
  try {
    const context = await browser.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.error('[console.' + m.type() + ']', m.text().slice(0, 300)); });
    await page.goto(server.baseURL + '/index.html#!graph');
    await page.waitForFunction(() => ['buildPreviewRenderable', 'parseMtlxDocument', 'getMxEnv', 'mxExclusive', 'createMtlxRenderView', 'getEnvironmentSource']
      .every((k) => typeof window[k] === 'function') && window.MtlxGenCore && window.MtlxThreeMaterial && window.MtlxSceneAssembly, null, { timeout: 120000 });
    const fixtures = {};
    const names = new Set();
    const targetList = args.parity ? SHADER_TARGETS.concat([{ name: 'displaced', file: 'displaced.mtlx', target: { id: 'n:Displaced', scope: '' } }]) : SHADER_TARGETS;
    for (const t of targetList) {
      if (!fixtures[t.file]) {
        const xml = fs.readFileSync(path.join(fixtureDir, t.file), 'utf8');
        fixtures[t.file] = { file: t.file, xml, targets: [] };
        for (const m of xml.matchAll(/type="filename"\s+value="([^"]+)"/g)) names.add(m[1].split('/').pop());
      }
      fixtures[t.file].targets.push(t);
    }
    fixtures.marble = fixtures['marble.mtlx'];
    const job = {
      size: 476, prefiltered: args.prefiltered, coldBase: fixtures['open_pbr.mtlx'].xml, targets: targetList, parity: args.parity, fixtures, textureNames: [...names],
      fixtureBase: server.baseURL + '/scratchpad/thumbs/scene-fixtures/',
      goldenBase: server.baseURL + '/' + path.relative(ROOT, args.goldens).split(path.sep).join('/') + '/',
    };
    if (args.parity) {
      const idx = JSON.parse(fs.readFileSync(path.join(args.goldens, 'index.json'), 'utf8'));
      const names = new Set(targetList.map((t) => t.name));
      job.frames = Object.entries(idx.frames).filter(([, v]) => names.has(v.target) && !v.error).map(([key, v]) => ({ key, target: v.target, settings: v.settings }));
      const subset = new Set(['srgb_ev0', 'aces_ev0', 'env_override', 'keylight_off']);
      job.sheetKeys = job.frames.filter((fr) => { const tag = fr.key.slice(fr.target.length + 2); return tag === 'srgb_ev0' || (['marble', 'glass'].includes(fr.target) && subset.has(tag)); }).map((fr) => fr.key);
    }
    const r = await page.evaluate('(' + probeShader.toString() + ')(' + JSON.stringify(job) + ')');
    const write = (file, url) => fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
    if (args.parity) {
      const total = 476 * 476;
      const sheetItems = [];
      const summary = { capped: {}, full: {} };
      for (const label of ['capped', 'full']) {
        const rows = r.parity[label];
        let bad = 0, graded = 0, worst = 0;
        for (const key of Object.keys(rows)) {
          const row = rows[key];
          if (row.error) { console.log(label + ' ' + key + ': ERROR ' + row.error); bad += 1; continue; }
          const approx = row.approx.length > 0;
          const pass = row.max === 0 || (row.max <= 2 && row.over1 / total < 0.001);
          row.approximate = approx; row.pass = pass; row.pctOver1 = +(100 * row.over1 / total).toFixed(4);
          if (!approx) { graded += 1; if (!pass) bad += 1; worst = Math.max(worst, row.max); }
          console.log(label + ' ' + key + ': max ' + row.max + ' nz ' + row.nz + ' >1 ' + row.over1 + (approx ? ' APPROX ' + JSON.stringify(row.approx) : (pass ? '' : ' FAIL')));
          if (label === 'full' && row.png) sheetItems.push({ label: key, stats: 'max ' + row.max + ' >1:' + row.over1, worker: row.png.worker, ref: row.png.ref, diff: row.png.diff });
        }
        summary[label] = { frames: Object.keys(rows).length, graded, failing: bad, worstMaxGraded: worst, approxFrames: Object.keys(rows).filter((k) => rows[k].approximate) };
        console.log(label + ' summary: ' + JSON.stringify(summary[label]));
      }
      console.log('room: ' + JSON.stringify(r.parity.room));
      console.log('cancel:', JSON.stringify(r.cancelTest));
      console.log('trim:', JSON.stringify(r.trim), 'trimEnvOverride:', JSON.stringify(r.trimEnvOverride));
      if (sheetItems.length) {
        const url = await page.evaluate('(' + composeShaderSheet.toString() + ')(' + JSON.stringify(sheetItems) + ', 238)');
        write(path.join(outDir, 'contact-sheet.png'), url);
        console.log('contact sheet:', path.join(outDir, 'contact-sheet.png'));
      }
      const slim = JSON.parse(JSON.stringify(Object.assign({}, r, { summary }), (k, v) => (k === 'png' ? undefined : v)));
      fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(slim, null, 2));
      return;
    }
    const sheet = [];
    for (const v of Object.values(r.variants)) {
      console.log('variant ' + v.label + ': setScene ' + Math.round(v.setScene.ms) + ' ms (wall ' + Math.round(v.setScene.wallMs) + '), gpu estimate ' + v.setScene.gpuMB + ' MB');
      for (const row of v.rows) {
        if (row.error) { console.log('  ' + row.name + ': ERROR ' + row.error); continue; }
        console.log('  ' + row.name + ': max ' + row.max + ', >1 ' + row.over1 + ', >8 ' + row.over8 + ', gen/link/render ' + row.timings.genMs + '/' + row.timings.linkMs + '/' + row.timings.renderMs + ' ms, wall ' + row.wallMs + ', approx ' + JSON.stringify(row.approx) + (row.notices && row.notices.length ? ' notices ' + row.notices.length : ''));
        write(path.join(outDir, v.label + '__' + row.name + '.worker.png'), row.png.worker);
        write(path.join(outDir, v.label + '__' + row.name + '.diff.png'), row.png.diff);
        if (v.label === 'downscale1024') sheet.push({ label: row.name, stats: 'max ' + row.max + ' >1:' + row.over1 + ' >8:' + row.over8, worker: row.png.worker, ref: r.refs[row.name], diff: row.png.diff });
      }
    }
    console.log('cancel:', JSON.stringify(r.cancelTest));
    console.log('trim:', JSON.stringify(r.trim), 'parallelCompile', r.parallelCompile, 'prefilteredSent', r.prefilteredSent);
    if (sheet.length) {
      const url = await page.evaluate('(' + composeShaderSheet.toString() + ')(' + JSON.stringify(sheet) + ', 238)');
      write(path.join(outDir, 'contact-sheet.png'), url);
      console.log('contact sheet:', path.join(outDir, 'contact-sheet.png'));
    }
    const slim = JSON.parse(JSON.stringify(r, (k, v) => (k === 'png' || k === 'refs' ? undefined : v)));
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(slim, null, 2));
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

function composeSheet(items, size) {
  const cols = 3;
  const cell = size + 8;
  const rows = Math.ceil(items.length / cols);
  const labelH = 28;
  const groupW = cell * 3 + 16;
  const rowH = size + labelH;
  const c = document.createElement('canvas');
  c.width = groupW * cols; c.height = rowH * rows;
  const g = c.getContext('2d');
  g.fillStyle = '#222'; g.fillRect(0, 0, c.width, c.height);
  g.font = '11px sans-serif'; g.textBaseline = 'top';
  const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
  return (async () => {
    for (let n = 0; n < items.length; n++) {
      const it = items[n];
      const x = (n % cols) * groupW;
      const y = Math.floor(n / cols) * rowH;
      const [a, b, d] = await Promise.all([load(it.thumbPng), load(it.refPng), load(it.diffPng)]);
      g.drawImage(a, x, y, size, size);
      g.drawImage(b, x + cell, y, size, size);
      g.drawImage(d, x + cell * 2, y, size, size);
      g.fillStyle = '#fff';
      g.fillText(it.label, x + 2, y + size + 2);
      g.fillStyle = '#9cf';
      g.fillText('mean ' + it.mean.toFixed(2) + ' max ' + it.max + ' (thumb | ref | diff x8)', x + 2, y + size + 14);
    }
    return c.toDataURL('image/png');
  })();
}

const writeDataUrl = (file, url) => fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.shader) { await mainShader(args); return; }
  fs.mkdirSync(args.out, { recursive: true });
  const files = fs.readdirSync(args.fixtures).filter((f) => f.endsWith('.mtlx')).sort();
  if (!files.length) throw new Error(`no .mtlx fixtures in ${args.fixtures}`);

  const server = await startServer({ root: ROOT });
  const launchArgs = args.software ? [] : ['--headless=new', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
  const browser = await chromium.launch(args.software ? { headless: true } : { headless: false, args: launchArgs });
  const summary = [];
  const sheetItems = [];
  try {
    const page = await (await browser.newContext()).newPage();
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('[console.error]', m.text().slice(0, 300)); });
    await page.goto(`${server.baseURL}/index.html#!graph`);
    await page.waitForFunction(() => ['buildPreviewRenderable', 'parseMtlxDocument', 'getMxEnv', 'mxExclusive', 'buildScope', 'createMtlxRenderView']
      .every((k) => typeof window[k] === 'function') && window.MtlxGenCore && window.MtlxThreeMaterial, null, { timeout: 120000 });
    await page.evaluate(() => window.getMxEnv());

    let docSeq = 1;
    for (const f of files) {
      const xml = fs.readFileSync(path.join(args.fixtures, f), 'utf8');
      const names = new Set();
      for (const m of xml.matchAll(/type="filename"\s+value="([^"]+)"/g)) {
        const v = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').split('/').pop();
        names.add(v.replace('<UDIM>', '1001'));
      }
      docSeq += 1;
      const r = await page.evaluate(`(${probeFixture.toString()})(${JSON.stringify(xml)}, ${JSON.stringify([...names])}, ${args.size}, ${args.maxPerFixture}, ${docSeq})`);
      const dir = path.join(args.out, f.replace(/\.mtlx$/, ''));
      fs.mkdirSync(dir, { recursive: true });
      let ok = 0, ident = 0, worst = null;
      const rows = [];
      for (const rec of r.results) {
        const safe = `${rec.scope || 'root'}__${rec.id}`.replace(/[^A-Za-z0-9_.-]/g, '_');
        if (rec.thumbPng) {
          writeDataUrl(path.join(dir, `${safe}.thumb.png`), rec.thumbPng);
          writeDataUrl(path.join(dir, `${safe}.ref.png`), rec.refPng);
          writeDataUrl(path.join(dir, `${safe}.diff.png`), rec.diffPng);
          ok += 1;
          if (rec.max === 0) ident += 1;
          if (!worst || rec.max > worst.max) worst = rec;
          sheetItems.push({ thumbPng: rec.thumbPng, refPng: rec.refPng, diffPng: rec.diffPng, mean: rec.mean, max: rec.max, label: `${f.replace(/^standard_surface_|\.mtlx$/g, '')} ${rec.scope ? rec.scope + '/' : ''}${rec.id}` });
        }
        const row = { id: rec.id, scope: rec.scope, mean: rec.mean, max: rec.max, over8: rec.pixelsOver8, ms: rec.ms, approx: rec.approx, workerError: rec.workerError, refError: rec.refError, error: rec.error };
        rows.push(row);
      }
      fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ sigError: r.sigError, loaders: r.loaders, eligible: r.eligible, signatures: r.signatures, missingSigs: r.missingSigs, staleReply: r.staleReply, rows }, null, 2));
      const errs = rows.filter((x) => x.workerError || x.refError || x.error);
      summary.push({ fixture: f, eligible: r.eligible, probed: r.results.length, compared: ok, identical: ident, worstMax: worst ? worst.max : null, worstId: worst ? worst.id : null, errors: errs.length, staleReply: r.staleReply });
      console.log(`${f}  eligible=${r.eligible} probed=${r.results.length} compared=${ok} identical=${ident} worstMax=${worst ? worst.max : '-'} (${worst ? worst.id : '-'}) errors=${errs.length} stale=${r.staleReply}`);
      for (const e of errs.slice(0, 6)) console.log('   ', e.scope || 'root', e.id, e.workerError || e.refError || e.error);
      if (r.sigError) console.log('   sigError:', r.sigError);
      if (f === files[0]) console.log('   loaders:', JSON.stringify(r.loaders));
    }

    const brass = fs.readFileSync(path.join(args.fixtures, 'standard_surface_brass_tiled.mtlx'), 'utf8').replace('brass_color.jpg', 'brass_color.ktx2');
    const ktx = await page.evaluate(`(${probeKtx2.toString()})(${JSON.stringify(brass)}, 64)`);
    console.log('ktx2-only fallback:', JSON.stringify(ktx));
    summary.push({ ktx2: ktx });

    if (sheetItems.length) {
      const url = await page.evaluate(`(${composeSheet.toString()})(${JSON.stringify(sheetItems)}, ${args.size})`);
      const sheet = path.join(args.out, 'contact-sheet.png');
      writeDataUrl(sheet, url);
      console.log('contact sheet:', sheet);
    }
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
  fs.writeFileSync(path.join(args.out, 'summary.json'), JSON.stringify(summary, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
