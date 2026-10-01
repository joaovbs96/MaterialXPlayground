#!/usr/bin/env node
/* Render-level goldens for the Graph Editor shaderball scene: each target is built the
   way the graph sidebar builds it and rendered with createMtlxRenderView on
   'shaderball-scene' (square 476 CSS px host, DPR 1). Every frame is hashed from
   snapshotPixels twice (determinism). Output: <out>/index.json, <key>.png, contact-sheet.png.
   Real GPU by default. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startServer } from '../embed/lib/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELP = 'Usage: node tests/perf/dump-scene-pixels.mjs [--out <dir>] [--fixtures <dir>] [--only <substring>] [--size 476] [--software]';
const ENV_FILE = 'env_maps/studio_kontrast_04_1k.exr';

function parseArgs(argv) {
  const out = {
    out: path.join(ROOT, 'scratchpad/thumbs/scene-goldens-s0'),
    fixtures: path.join(ROOT, 'scratchpad/thumbs/scene-fixtures'),
    only: '', timeline: false, size: 476, software: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { if (argv[++i] == null) throw new Error(`${a} requires a value`); return argv[i]; };
    if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else if (a === '--out') out.out = next();
    else if (a === '--fixtures') out.fixtures = next();
    else if (a === '--only') out.only = next();
    else if (a === '--timeline') out.timeline = true;
    else if (a === '--size') out.size = Number(next());
    else if (a === '--software') out.software = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

const TARGETS = [
  { name: 'marble', file: 'marble.mtlx', target: { id: 'n:Marble_3D', scope: '' } },
  { name: 'textured_standard_surface', file: 'textured_standard_surface.mtlx', target: { id: 'n:Tiled_Brass', scope: '' } },
  { name: 'open_pbr', file: 'open_pbr.mtlx', target: { id: 'n:Car_Paint', scope: '' } },
  { name: 'glass', file: 'glass.mtlx', target: { id: 'n:Glass', scope: '' } },
  { name: 'displaced', file: 'displaced.mtlx', target: { id: 'n:Displaced', scope: '' } },
  { name: 'bsdf', file: 'closures.mtlx', target: { id: 'n:bsdf1', scope: '' } },
  { name: 'edf', file: 'closures.mtlx', target: { id: 'n:edf1', scope: '' } },
  { name: 'vdf', file: 'closures.mtlx', target: { id: 'n:vdf1', scope: '' }, expectUnrenderable: true },
  { name: 'nodegraph_surfaceshader', file: 'nodegraph_surface.mtlx', target: { id: 'o:surf_out', scope: 'NG_surf' } },
];
const FULL_MATRIX_TARGETS = ['marble', 'glass'];
const BASE = { display: 'srgb', ev: 0, envOverride: false, keyLight: true, transparency: false, backdrop: 'studio' };

function buildFrames(only) {
  const frames = [];
  const add = (t, tag, over) => frames.push({ key: `${t.name}__${tag}`, target: t.name, settings: Object.assign({}, BASE, over), fresh: tag === 'srgb_ev0' });
  for (const t of TARGETS) {
    if (only && !t.name.includes(only)) continue;
    add(t, 'srgb_ev0', {});
    if (t.expectUnrenderable) continue; // no ESSL implementation for any VDF node
    if (FULL_MATRIX_TARGETS.includes(t.name)) {
      for (const display of ['srgb', 'aces', 'lin_rec709']) {
        for (const ev of [0, 1]) if (display !== 'srgb' || ev !== 0) add(t, `${display}_ev${ev}`, { display, ev });
      }
    }
    add(t, 'env_override', { envOverride: true });
    add(t, 'keylight_off', { keyLight: false });
    add(t, 'env_override_keylight_off', { envOverride: true, keyLight: false });
    add(t, 'transparency_on', { transparency: true });
    add(t, 'backdrop_environment', { backdrop: 'environment' });
  }
  return frames;
}

// Runs in the page (serialized by toString): one frame, rendered and hashed twice.
async function renderFrame(job) {
  const win = window;
  const S = (win.__s0 = win.__s0 || { parsed: {}, files: {}, envOverride: null });
  const { frame, xml, target, fileNames, size, envUrl } = job;
  const need = ['parseMtlxDocument', 'getMxEnv', 'mxExclusive', 'buildPreviewRenderable', 'createMtlxRenderView', 'bindDroppedTextures',
    'setDisplayTransform', 'setDisplayExposure', 'setForceTransparency', 'setKeyLightEnabled', 'setEnvOverride', 'loadEnvironmentFromBuffer', 'getEnvironment'];
  const missing = need.filter((k) => typeof win[k] !== 'function');
  if (missing.length) throw new Error('missing page globals: ' + missing.join(','));
  const st = frame.settings;

  const sha256 = async (buf) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).map((b) => b.toString(16).padStart(2, '0')).join('');
  const diffStats = (a, b) => {
    let n = 0; let mx = 0;
    for (let q = 0; q < a.data.length; q += 4) {
      let m = 0;
      for (let c = 0; c < 4; c += 1) m = Math.max(m, Math.abs(a.data[q + c] - b.data[q + c]));
      if (m) { n += 1; if (m > mx) mx = m; }
    }
    return { pixels: n, max: mx };
  };
  const frames = (n) => new Promise((r) => { let i = 0; const t = () => (++i >= n ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); });

  // Texture files (real bytes served from the fixtures folder).
  const fileMap = {};
  for (const name of fileNames) {
    if (!S.files[name]) {
      const buf = await (await fetch(job.fixtureBase + name)).arrayBuffer();
      S.files[name] = new File([buf], name, { type: /\.png$/i.test(name) ? 'image/png' : 'image/jpeg', lastModified: 1700000000000 });
    }
    fileMap[name] = S.files[name];
  }

  // Global settings through the app's own setters, then env override.
  win.setDisplayTransform(st.display);
  win.setDisplayExposure(st.ev);
  win.setForceTransparency(st.transparency, { persist: false });
  win.setEnvOverride(null);
  win.setKeyLightEnabled(st.keyLight);
  if (st.envOverride) {
    const buf = await (await fetch(envUrl)).arrayBuffer();
    win.setEnvOverride(await win.loadEnvironmentFromBuffer(buf, '.exr', 'studio_kontrast_04_1k.exr', true));
  } else {
    await win.getEnvironment();
  }

  const key = job.fixtureKey;
  if (!S.parsed[key]) S.parsed[key] = await win.parseMtlxDocument(xml);
  const parsed = S.parsed[key];
  const env = await win.getMxEnv();
  const { mx, gen, lightData } = env;
  const compoundRoot = (() => { try { return !!win.MtlxRenderSettings.get('graphCompoundCompile', { surface: 'graph' }); } catch (e) { return false; } })();
  const needsFresh = !!(parsed.hasDefinitions || target.scope || compoundRoot);
  const freshCtx = needsFresh && typeof env.createGenContext === 'function' ? env.createGenContext() : null;
  const genContext = freshCtx || env.genContext;

  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:0;top:0;width:${size}px;height:${size}px;opacity:0;pointer-events:none`;
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%;height:100%;display:block';
  host.appendChild(canvas);
  document.body.appendChild(host);

  let built = null;
  let view = null;
  const rec = { notices: [] };
  try {
    built = await win.mxExclusive(() => win.buildPreviewRenderable(parsed, target));
    if (!built.renderable) { rec.error = 'no renderable: ' + (built.notice || ''); return rec; }
    if (job.sources) {
      const stageLightCount = typeof PREVIEW_STAGE_LIGHT_COUNT !== 'undefined' ? PREVIEW_STAGE_LIGHT_COUNT : win.PREVIEW_STAGE_LIGHT_COUNT;
      const featureOptions = typeof PREVIEW_FEATURE_OPTIONS !== 'undefined' ? PREVIEW_FEATURE_OPTIONS : win.PREVIEW_FEATURE_OPTIONS;
      const srcs = await win.generatePreviewSourcesWithinBudget({
        mx, gen, genContext, renderable: built.renderable, label: built.label || parsed.label,
        materialName: built.materialName || null, isMounted: () => true,
        stageLightCount, sceneFeatureOptions: featureOptions, allowConstInputs: true,
      });
      rec.sourceTransparent = !!(srcs && srcs.transparent);
      rec.displacementPresent = !!(srcs && srcs.displacement);
    }
    view = await win.createMtlxRenderView({
      canvas, mx, gen, genContext, renderable: built.renderable, lightData,
      materialName: built.materialName || null, label: built.label || 'scene-pixels',
      needsLighting: true, geomName: 'shaderball-scene', sceneOrbit: true, autoRotate: false,
      backdrop: st.backdrop,
      isMounted: () => true, isActive: () => true, debugKind: 'graph-preview',
    });
  } finally {
    if (built) { try { await win.mxExclusive(() => built.cleanup()); } catch (e) { /* best-effort */ } }
    if (freshCtx) { try { freshCtx.delete(); } catch (e) { /* best-effort */ } }
  }
  if (!view) { host.remove(); rec.error = rec.error || 'no view'; return rec; }
  try {
    const rep = win.bindDroppedTextures(view, fileMap);
    await Promise.all(rep.pending || []);
    if (rep.missing && rep.missing.length) rec.missingTextures = rep.missing;
    rec.viewTransparent = !!view.isTransparent;

    const grab = async () => {
      const img = view.snapshotPixels(size, size);
      return { img, hash: await sha256(img.data.buffer) };
    };
    // Settle: step frames until three consecutive reads match (env, prefilter, textures
    // and displacement can land a few frames late).
    if (job.timeline) {
      const tl = [];
      const seen = {};
      for (let i = 0; i < 40; i += 1) { await frames(4); await new Promise((r) => setTimeout(r, 200)); const g = await grab(); tl.push(g.hash.slice(0, 8)); if (!seen[g.hash]) seen[g.hash] = g.img; }
      const imgs = Object.values(seen);
      if (imgs.length > 1) {
        let n = 0; let mx = 0; let minX = 1e9; let maxX = -1; let minY = 1e9; let maxY = -1;
        for (let q = 0; q < imgs[0].data.length; q += 4) {
          let m = 0;
          for (let c = 0; c < 4; c += 1) m = Math.max(m, Math.abs(imgs[0].data[q + c] - imgs[1].data[q + c]));
          if (m) { n += 1; mx = Math.max(mx, m); const x = (q / 4) % size; const y = Math.floor(q / 4 / size); minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
        }
        rec.flipDiff = { pixels: n, max: mx, bbox: [minX, minY, maxX, maxY] };
      }
      rec.timeline = tl.join(' ');
    }
    let cur = null;
    let same = 0;
    let iters = 0;
    for (; iters < 20 && same < 2; iters += 1) {
      await frames(8);
      await new Promise((r) => setTimeout(r, 300));
      const g = await grab();
      same = cur && cur.hash === g.hash ? same + 1 : 0;
      cur = g;
    }
    await frames(8);
    await new Promise((r) => setTimeout(r, 300));
    rec.settleIters = iters + 1;
    const second = await grab();
    rec.hash = cur.hash;
    rec.hash2 = second.hash;
    rec.deterministic = cur.hash === second.hash;
    rec.repeatDiff = diffStats(cur.img, second.img);
    if (job.compare && S.imgs && S.imgs[frame.key]) rec.freshDiff = diffStats(cur.img, S.imgs[frame.key]);
    S.imgs = S.imgs || {};
    if (!job.compare) S.imgs[frame.key] = cur.img;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    c.getContext('2d').putImageData(cur.img, 0, 0);
    rec.png = c.toDataURL('image/png');
    rec.width = cur.img.width; rec.height = cur.img.height;
    rec.dpr = window.devicePixelRatio;
  } finally {
    view.dispose();
    host.remove();
  }
  return rec;
}

async function composeSheet(items, cell) {
  const cols = 8;
  const labelH = 24;
  const rows = Math.ceil(items.length / cols);
  const c = document.createElement('canvas');
  c.width = cols * cell; c.height = rows * (cell + labelH);
  const g = c.getContext('2d');
  g.fillStyle = '#222'; g.fillRect(0, 0, c.width, c.height);
  g.font = '10px sans-serif'; g.textBaseline = 'top';
  const load = (u) => new Promise((r) => { const i = new Image(); i.onload = () => r(i); i.src = u; });
  for (let n = 0; n < items.length; n++) {
    const x = (n % cols) * cell;
    const y = Math.floor(n / cols) * (cell + labelH);
    const img = await load(items[n].png);
    g.drawImage(img, x, y, cell, cell);
    g.fillStyle = '#fff';
    g.fillText(items[n].label, x + 2, y + cell + 2);
    g.fillStyle = items[n].ok ? '#9cf' : '#f66';
    g.fillText(items[n].hash.slice(0, 12), x + 2, y + cell + 13);
  }
  return c.toDataURL('image/png');
}

const writeDataUrl = (file, url) => fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.out, { recursive: true });
  const frames = buildFrames(args.only);
  if (!frames.length) throw new Error('no frames selected');

  const server = await startServer({ root: ROOT });
  const launchArgs = args.software ? [] : ['--headless=new', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
  const browser = await chromium.launch(args.software ? { headless: true } : { headless: false, args: launchArgs });
  const index = { env: ENV_FILE, size: args.size, viewport: { width: 900, height: 900, deviceScaleFactor: 1 }, renderer: null, targets: {}, frames: {} };
  const sheet = [];
  let failures = 0;
  try {
    // A fresh page per target: disposed views leave their GL contexts alive until GC, and
    // past ~16 the browser starts losing contexts (black frames, incomplete framebuffers).
    let page = null;
    let glErrors = 0;
    const openPage = async () => {
      if (page) await page.context().close();
      const context = await browser.newContext({ viewport: { width: 900, height: 900 }, deviceScaleFactor: 1 });
      page = await context.newPage();
      page.on('pageerror', (e) => console.error('[pageerror]', e.message));
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        if (/Framebuffer not complete|CONTEXT_LOST|context lost/i.test(m.text())) glErrors += 1;
        else if (!/Failed to load resource/.test(m.text())) console.error('[console.error]', m.text().slice(0, 300));
      });
      await page.goto(`${server.baseURL}/index.html#!graph`);
      await page.waitForFunction(() => ['buildPreviewRenderable', 'parseMtlxDocument', 'getMxEnv', 'mxExclusive', 'createMtlxRenderView', 'setKeyLightEnabled', 'loadEnvironmentFromBuffer']
        .every((k) => typeof window[k] === 'function') && window.MtlxGenCore && window.MtlxThreeMaterial, null, { timeout: 120000 });
      await page.evaluate(() => window.getMxEnv());
      if (!index.renderer) {
        index.renderer = await page.evaluate(() => {
          const gl = document.createElement('canvas').getContext('webgl2');
          const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
          return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
        });
        console.log('renderer:', index.renderer);
      }
    };

    const fixtureBase = `${server.baseURL}/${path.relative(ROOT, args.fixtures).split(path.sep).join('/')}/`;
    const envUrl = `${server.baseURL}/${ENV_FILE}`;
    const seenTarget = new Set();
    for (const frame of frames) {
      const t = TARGETS.find((x) => x.name === frame.target);
      const xml = fs.readFileSync(path.join(args.fixtures, t.file), 'utf8');
      const names = new Set();
      for (const m of xml.matchAll(/type="filename"\s+value="([^"]+)"/g)) names.add(m[1].split('/').pop());
      const first = !seenTarget.has(t.name);
      if (first) await openPage();
      seenTarget.add(t.name);
      glErrors = 0;
      const job = { frame, xml, target: t.target, fileNames: [...names], size: args.size, envUrl, fixtureBase, fixtureKey: t.file, sources: first, timeline: args.timeline };
      const t0 = Date.now();
      let rec;
      try {
        rec = await page.evaluate(`(${renderFrame.toString()})(${JSON.stringify(job)})`);
        if (rec.png && frame.fresh) {
          // Independent fresh view of the baseline frame must hash the same.
          const again = await page.evaluate(`(${renderFrame.toString()})(${JSON.stringify(Object.assign({}, job, { sources: false, compare: true }))})`);
          rec.freshRepeatHash = again.hash || null;
          rec.freshRepeatEqual = again.hash === rec.hash;
          rec.freshDiff = again.freshDiff || null;
        }
      } catch (e) { rec = { error: String((e && e.message) || e) }; }
      const entry = { target: frame.target, settings: frame.settings };
      if (rec.error || !rec.png) {
        entry.error = String(rec.error || 'no pixels').split('\n')[0];
        if (!t.expectUnrenderable) failures += 1;
        console.log(`${t.expectUnrenderable ? 'EXPECTED-FAIL' : 'FAIL'} ${frame.key}: ${entry.error}`);
      } else {
        writeDataUrl(path.join(args.out, `${frame.key}.png`), rec.png);
        Object.assign(entry, { sha256: rec.hash, sha256Second: rec.hash2, deterministic: rec.deterministic, width: rec.width, height: rec.height, settleIters: rec.settleIters });
        entry.repeatDiff = rec.repeatDiff;
        entry.exactStable = rec.deterministic;
        if (rec.freshRepeatHash !== undefined) { entry.freshRepeatEqual = rec.freshRepeatEqual; entry.freshDiff = rec.freshDiff; }
        if (rec.missingTextures) entry.missingTextures = rec.missingTextures;
        if (glErrors) entry.glErrors = glErrors;
        const tol = (d) => !d || (d.max <= 1 && d.pixels <= 16);
        const ok = tol(rec.repeatDiff) && tol(rec.freshDiff) && !glErrors;
        if (!ok) failures += 1;
        sheet.push({ png: rec.png, label: frame.key, hash: rec.hash, ok });
        if (rec.timeline) console.log('   timeline:', rec.timeline, JSON.stringify(rec.flipDiff));
        console.log(`${ok ? (rec.deterministic ? 'ok  ' : 'okT ') : 'NOND'} ${frame.key} ${rec.hash.slice(0, 12)} ${((Date.now() - t0) / 1000).toFixed(1)}s settle=${rec.settleIters}${rec.deterministic ? '' : ' exact-unstable ' + JSON.stringify(rec.repeatDiff)}${rec.freshRepeatEqual === false ? ' fresh-diff ' + JSON.stringify(rec.freshDiff) : ''}`);
      }
      if (first) {
        index.targets[t.name] = { file: t.file, target: t.target, sourceTransparent: rec.sourceTransparent, viewTransparent: rec.viewTransparent, displacementPresent: rec.displacementPresent, unrenderable: rec.png ? undefined : entry.error };
      }
      index.frames[frame.key] = entry;
    }
    // Stable key order.
    index.frames = Object.fromEntries(Object.keys(index.frames).sort().map((k) => [k, index.frames[k]]));
    if (sheet.length) {
      if (!page) await openPage();
      const url = await page.evaluate(`(${composeSheet.toString()})(${JSON.stringify(sheet)}, 238)`);
      writeDataUrl(path.join(args.out, 'contact-sheet.png'), url);
    }
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
  index.summary = { frames: Object.keys(index.frames).length, failures };
  fs.writeFileSync(path.join(args.out, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  console.log(`frames=${index.summary.frames} failures=${failures}`);
  if (failures) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
