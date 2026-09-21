#!/usr/bin/env node
/* Milestone 0 compile-speed harness. Plain Node/Playwright script (not a
   test spec): measures cold-compile time for one material or one scene,
   sample by sample, each in a fresh browser. Modelled on tests/raster/run.mjs
   (backend args, source hashes, console capture) and reuses the embed test
   server. See docs/local (Milestone 0 notes) for context. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startServer } from '../embed/lib/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT_ROOT = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\compile-speed';

const HELP = `Usage: node tests/perf/compile-bench.mjs --mode material|scene --subject <folder> [options]

  --mode material|scene       What to measure (required)
  --subject <folder>          material: folder holding the .mtlx; scene: the scene folder (required)
  --root <basename>           scene mode: root .usda basename to pick, if more than one
  --mtlx <basename>           material mode: which .mtlx to pick, if the folder holds several
  --samples N                 Samples to run, each a fresh browser (default 3)
  --set key=value             localStorage entry applied before any page script (repeatable)
  --out <dir>                 Output dir (default: ${DEFAULT_OUT_ROOT}\\<label>)
  --label <name>              Report label (default: derived from --subject)
  --backend d3d11|swiftshader Browser rendering backend (default: d3d11)
  --baseline <path>           Previous still PNG to diff the new still against
  --display-flip              Scene mode: after 'rendered', flip the global display
                               transform and measure ms to the Scene's own ready signal
  --warm-cache                One persistent browser profile for the whole run: sample 1
                               is cold, the browser is closed, later samples relaunch warm
  --help                      Show this help
`;

function parseArgs(argv) {
  const out = { mode: null, subject: null, root: null, mtlx: null, samples: 3, sets: [], out: null, label: null,
    backend: 'd3d11', baseline: null, displayFlip: false, warmCache: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { if (argv[++i] == null) throw new Error(`${a} requires a value`); return argv[i]; };
    if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else if (a === '--mode') out.mode = next();
    else if (a === '--subject') out.subject = next();
    else if (a === '--root') out.root = next();
    else if (a === '--mtlx') out.mtlx = next();
    else if (a === '--samples') out.samples = Number(next());
    else if (a === '--set') out.sets.push(next());
    else if (a === '--out') out.out = next();
    else if (a === '--label') out.label = next();
    else if (a === '--backend') out.backend = next();
    else if (a === '--baseline') out.baseline = next();
    else if (a === '--display-flip') out.displayFlip = true;
    else if (a === '--warm-cache') out.warmCache = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (out.mode !== 'material' && out.mode !== 'scene') throw new Error('--mode must be material or scene');
  if (!out.subject) throw new Error('--subject is required');
  if (!Number.isInteger(out.samples) || out.samples < 1) throw new Error('--samples must be a positive integer');
  if (!['d3d11', 'swiftshader'].includes(out.backend)) throw new Error('--backend must be d3d11 or swiftshader');
  out.settings = {};
  for (const pair of out.sets) {
    const eq = pair.indexOf('=');
    if (eq < 0) throw new Error(`--set expects key=value, got: ${pair}`);
    out.settings[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  if (!out.label) out.label = path.basename(path.resolve(out.subject)) + '-' + out.mode;
  if (!out.out) out.out = path.join(DEFAULT_OUT_ROOT, out.label);
  return out;
}

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function sourceHashes() {
  return Object.fromEntries(['js/mtlx-engine.js', 'js/usd-scene-renderer.js', 'js/graph/preview.jsx']
    .filter((p) => fs.existsSync(path.join(ROOT, p)))
    .map((p) => [p, sha256(path.join(ROOT, p))]));
}
function backendArgs(backend, { keepShaderDiskCache = false } = {}) {
  if (backend === 'swiftshader') {
    return ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'];
  }
  const args = ['--headless=new', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
  // --warm-cache needs the driver's real on-disk shader cache: normal runs
  // disable it so every sample compiles cold, independent of a prior run.
  if (!keepShaderDiskCache) args.push('--disable-gpu-shader-disk-cache');
  return args;
}

// Item 7: intercepts WebGL2 shaderSource the way tests/perf/dump-shaders.mjs
// does, so material mode can hash the final vs/fs exactly as submitted.
const SHADER_RECORDER = () => {
  const store = { shaders: [], programs: [] };
  window.__shaderDump = store;
  const G = WebGL2RenderingContext.prototype;
  const ids = new WeakMap();
  let nextId = 1;
  const idOf = (obj) => { if (!ids.has(obj)) ids.set(obj, nextId++); return ids.get(obj); };
  const origSource = G.shaderSource;
  G.shaderSource = function (shader, source) {
    try {
      const type = this.getShaderParameter(shader, this.SHADER_TYPE);
      store.shaders.push({ id: idOf(shader), vertex: type === this.VERTEX_SHADER, source: String(source) });
    } catch (e) { /* ignore */ }
    return origSource.apply(this, arguments);
  };
  const origAttach = G.attachShader;
  G.attachShader = function (program, shader) {
    try { store.programs.push({ program: idOf(program), shader: idOf(shader) }); } catch (e) { /* ignore */ }
    return origAttach.apply(this, arguments);
  };
};

function pickLargestFragVert() {
  const store = window.__shaderDump;
  if (!store) return null;
  const byId = new Map(store.shaders.map((s) => [s.id, s]));
  let best = null;
  for (const s of store.shaders) {
    if (s.vertex) continue;
    if (!best || s.source.length > best.source.length) best = s;
  }
  if (!best) return null;
  const prog = store.programs.find((p) => p.shader === best.id);
  let vert = null;
  if (prog) {
    const mate = store.programs.find((p) => p.program === prog.program && p.shader !== best.id);
    if (mate) vert = byId.get(mate.shader) || null;
  }
  return { frag: best.source, vert: vert ? vert.source : null };
}

function sha256Text(s) { return crypto.createHash('sha256').update(String(s || '')).digest('hex'); }

// Scene mode only: tracks 'longtask' entries via PerformanceObserver, so we
// can tell whether material swap-in (geometry-first) blocks the main thread
// after the neutral-geometry frame is already up.
const LONGTASK_RECORDER = () => {
  const store = { tasks: [] };
  window.__mtlxLongtasks = store;
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        store.tasks.push({ start: entry.startTime, duration: entry.duration });
      }
    });
    obs.observe({ type: 'longtask', buffered: true });
  } catch (e) { /* longtask not supported: leave store.tasks empty */ }
};

function summarizeLongtasks(tasks, geometryFirstAt) {
  if (!tasks || !tasks.length) return { longestTaskMs: null, longestTaskAfterGeometryFirstMs: null };
  const longestTaskMs = Math.max(...tasks.map((t) => t.duration));
  let longestTaskAfterGeometryFirstMs = null;
  if (typeof geometryFirstAt === 'number') {
    const after = tasks.filter((t) => t.start >= geometryFirstAt).map((t) => t.duration);
    longestTaskAfterGeometryFirstMs = after.length ? Math.max(...after) : null;
  }
  return { longestTaskMs, longestTaskAfterGeometryFirstMs };
}

// --warm-cache: one persistent profile dir for the whole run, outside the
// repo. Sample 1 launches cold and populates the disk cache; the caller
// fully closes the browser between samples so later samples relaunch warm.
async function launchSession({ backend, warmCache, profileDir }) {
  if (warmCache) {
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false, args: backendArgs(backend, { keepShaderDiskCache: true }),
    });
    return { browser: null, context, close: () => context.close() };
  }
  const browser = await chromium.launch({ headless: false, args: backendArgs(backend) });
  const context = await browser.newContext();
  return { browser, context, close: () => browser.close() };
}

// [mtlx-perf] createMtlxRenderView total: 123.4ms (target: label)
const PERF_LINE = /^\[mtlx-perf\] (.+?): ([\d.]+)ms(?: \(target: (.+)\))?$/;

// Smallest tier of the scene texture-size dropdown (512/1024/2048/4096/Inf),
// key from SCENE_TEXTURE_MAX_SIZE_KEY in js/usd-scene-renderer.js. Keeps a
// heavy real-asset texture set from dominating the timed run.
const SCENE_TEXTURE_MAX_SIZE_KEY = 'mtlx_scene_texture_size';
const SCENE_TEXTURE_MAX_SIZE_SMALLEST = '512';

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function applyInitScripts(context, settings) {
  // Always on: the engine and model.jsx only publish [mtlx-perf] logs
  // when this key is truthy at load time.
  const entries = { mtlxPerfLog: '1', ...settings };
  await context.addInitScript((kv) => {
    try { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); } catch (e) { /* ignore */ }
  }, entries);
  await context.addInitScript(SHADER_RECORDER);
}

async function runMaterialSample({ server, backend, subject, mtlxName, sampleIndex, outDir, captureStill, warmCache, profileDir }) {
  const session = await launchSession({ backend, warmCache, profileDir });
  const { context } = session;
  const consoleLines = [];
  const consoleErrors = [];
  try {
    await applyInitScripts(context, runMaterialSample.__settings || {});
    const page = await context.newPage();
    page.on('console', (msg) => {
      const text = msg.text();
      consoleLines.push(text);
      if (msg.type() === 'error') consoleErrors.push(text);
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err && err.stack || err)));

    await page.goto(`${server.baseURL}/index.html#!viewer`);
    const dirInput = page.locator('input[type=file][webkitdirectory]').first();
    await dirInput.waitFor({ state: 'attached', timeout: 60000 });
    await dirInput.setInputFiles(subject);

    // If the folder held several .mtlx documents the app shows a "Pick a
    // document" combobox; best-effort selection by basename below. Single-
    // document folders (the supported case) skip this entirely.
    if (mtlxName) {
      const picker = page.getByText('Pick a document', { exact: true }).locator('xpath=following-sibling::*[1]').getByRole('combobox');
      if (await picker.count()) {
        await picker.first().click();
        const option = page.getByRole('option', { name: new RegExp(mtlxName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') });
        if (await option.count()) await option.first().click();
      }
    }

    const label = mtlxName || path.basename(subject);
    const totalLine = await page.waitForEvent('console', {
      predicate: (msg) => /^\[mtlx-perf\] (createMtlxRenderView total|applyMaterial total):/.test(msg.text()),
      timeout: 180000,
    }).then((msg) => msg.text());
    void totalLine;

    // Give the compositor a moment past the perf-log line before the still.
    await page.waitForTimeout(500);

    const fields = { genGenerateMs: null, glCompileSubmitMs: null, glCompileWaitMs: null, glCompileMs: null, totalMs: null };
    for (const line of consoleLines) {
      const m = PERF_LINE.exec(line);
      if (!m) continue;
      const name = m[1];
      const ms = Number(m[2]);
      if (name === 'gen.generate') fields.genGenerateMs = ms;
      else if (name === 'GL compile submit') fields.glCompileSubmitMs = ms;
      else if (name === 'GL compile wait') fields.glCompileWaitMs = ms;
      else if (name === 'GL compile') fields.glCompileMs = ms;
      else if (name === 'createMtlxRenderView total' || name === 'applyMaterial total') fields.totalMs = ms;
    }

    let stillPath = null;
    if (captureStill) {
      await page.waitForTimeout(2000);
      const canvas = page.locator('canvas').last();
      stillPath = path.join(outDir, `still-sample${sampleIndex}.png`);
      await canvas.screenshot({ path: stillPath });
    }

    // Item 7: hash the largest fragment shader (plus its vertex shader)
    // exactly as submitted to WebGL, to check byte-stability across samples.
    const picked = await page.evaluate(pickLargestFragVert);
    const sourceHash = picked ? sha256Text((picked.frag || '') + ' ' + (picked.vert || '')) : null;

    return { sample: sampleIndex, label, fields, stillPath, consoleErrors, sourceHash, cold: !warmCache || sampleIndex === 1 };
  } finally {
    await session.close().catch(() => {});
  }
}

async function runSceneSample({ server, backend, subject, rootBasename, sampleIndex, outDir, captureStill, settings, displayFlip, warmCache, profileDir }) {
  const session = await launchSession({ backend, warmCache, profileDir });
  const { context } = session;
  const consoleLines = [];
  const consoleErrors = [];
  try {
    await applyInitScripts(context, { ...settings, [SCENE_TEXTURE_MAX_SIZE_KEY]: SCENE_TEXTURE_MAX_SIZE_SMALLEST });
    await context.addInitScript(LONGTASK_RECORDER);
    const page = await context.newPage();
    page.on('console', (msg) => {
      const text = msg.text();
      consoleLines.push(text);
      if (msg.type() === 'error') consoleErrors.push(text);
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err && err.stack || err)));

    await page.goto(`${server.baseURL}/index.html#!scene`);
    await page.locator('[data-testid="usd-scene-viewer"]').waitFor({ state: 'visible', timeout: 60000 });
    await page.locator('input[type=file][webkitdirectory]').setInputFiles(subject);

    const rootSelectVisible = await page.getByTestId('usd-scene-root-select').isVisible().catch(() => false);
    if (rootSelectVisible && rootBasename) {
      const rootCombobox = page.getByTestId('usd-scene-root-select').getByRole('combobox');
      await rootCombobox.click();
      const options = await page.getByRole('option').allTextContents();
      const selected = options.find((l) => l.endsWith('/' + rootBasename) || l === rootBasename);
      if (selected) await page.getByRole('option', { name: selected, exact: true }).click();
    }

    const start = Date.now();
    await page.getByTestId('usd-scene-sidebar').getByRole('button', { name: /^Load (?!example)/ }).click();
    await page.getByTestId('usd-scene-status').filter({ hasText: 'rendered' }).waitFor({ state: 'attached', timeout: 1200000 });
    const wallMs = Date.now() - start;

    // Auto-rotate defaults to off (useViewToggle('setAutoRotate', false)),
    // so nothing to disable here; just let the camera/frame settle.
    await page.waitForTimeout(2000);

    const scenePerf = await page.evaluate(() => window.__mtlxScenePerf || null);
    const prefilterLine = consoleLines.find((l) => l.startsWith('[mtlx-perf] env prefilter:'));
    if (scenePerf) scenePerf.envPrefilterMs = prefilterLine ? Number((/: ([\d.]+)ms/.exec(prefilterLine) || [])[1]) : null;
    const longtaskData = await page.evaluate(() => ({
      tasks: (window.__mtlxLongtasks && window.__mtlxLongtasks.tasks) || [],
      geometryFirstAt: (window.__mtlxScenePerf && window.__mtlxScenePerf.firstGeometryFrameMs) || null,
    }));
    const longtasks = summarizeLongtasks(longtaskData.tasks, longtaskData.geometryFirstAt);
    // window.__mtlxUsdSceneHandle.warnings: the same array the Diagnostics
    // panel (usd-material-warnings) renders from, see js/usd-scene-app.jsx.
    const warnings = await page.evaluate(() => {
      const handle = window.__mtlxUsdSceneHandle;
      return (handle && Array.isArray(handle.warnings)) ? handle.warnings.map(String) : [];
    });

    let stillPath = null;
    if (captureStill) {
      const canvas = page.locator('[data-testid="usd-scene-viewer"] canvas').first();
      stillPath = path.join(outDir, `still-sample${sampleIndex}.png`);
      await canvas.screenshot({ path: stillPath });
    }

    // Item 7: per-material vs+fs hash straight from scenePerf, no separate
    // WebGL interception needed in scene mode.
    const materialHashes = {};
    for (const m of (scenePerf && scenePerf.materials) || []) {
      if (m && m.label) materialHashes[m.label] = m.srcHash || null;
    }

    // Item 4 harness support: flip the GLOBAL display transform and time the
    // Scene's own display-transform-ready signal (js/usd-scene-renderer.js's
    // report(), recorded under window.__mtlxSceneDisplayTransformEvents
    // while mtlxPerfLog is on).
    let flipMs = null;
    let flipStillPath = null;
    if (displayFlip) {
      const before = await page.evaluate(() => ({
        mode: window.getDisplayTransform ? window.getDisplayTransform() : null,
        values: (window.getDisplayTransformValues && window.getDisplayTransformValues()) || [],
        eventsBefore: (window.__mtlxSceneDisplayTransformEvents || []).length,
      }));
      const nextMode = before.values.find((v) => v !== before.mode) || before.values[0];
      const flipStart = await page.evaluate((mode) => {
        window.setDisplayTransform(mode);
        return performance.now();
      }, nextMode);
      await page.waitForFunction((fromCount) => {
        const events = window.__mtlxSceneDisplayTransformEvents || [];
        return events.slice(fromCount).some((e) => e.status === 'ready' || e.status === 'error');
      }, before.eventsBefore, { timeout: 60000 });
      const readyAt = await page.evaluate((fromCount) => {
        const events = window.__mtlxSceneDisplayTransformEvents || [];
        const hit = events.slice(fromCount).find((e) => e.status === 'ready' || e.status === 'error');
        return hit ? hit.at : null;
      }, before.eventsBefore);
      flipMs = (readyAt != null) ? (readyAt - flipStart) : null;
      await page.waitForTimeout(500);
      if (captureStill) {
        const canvas = page.locator('[data-testid="usd-scene-viewer"] canvas').first();
        flipStillPath = path.join(outDir, `still-flip.png`);
        await canvas.screenshot({ path: flipStillPath });
      }
    }

    return { sample: sampleIndex, wallMs, scenePerf, warnings, stillPath, consoleErrors,
      materialHashes, flipMs, flipStillPath, longtasks, cold: !warmCache || sampleIndex === 1 };
  } finally {
    await session.close().catch(() => {});
  }
}

async function computeStillMetrics(server, stillPath, baselinePath) {
  if (!stillPath || !baselinePath || !fs.existsSync(baselinePath)) return null;
  const browser = await chromium.launch({ headless: false, args: backendArgs('d3d11') });
  try {
    const page = await browser.newPage();
    await page.goto('about:blank');
    await page.addScriptTag({ path: path.join(ROOT, 'js', 'shared', 'image-metrics.js') });
    const aB64 = fs.readFileSync(stillPath).toString('base64');
    const bB64 = fs.readFileSync(baselinePath).toString('base64');
    const result = await page.evaluate(async ({ aB64, bB64 }) => {
      const decode = (b64) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width; canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          resolve({ data: ctx.getImageData(0, 0, img.width, img.height).data, w: img.width, h: img.height });
        };
        img.onerror = reject;
        img.src = 'data:image/png;base64,' + b64;
      });
      const a = await decode(aB64);
      const b = await decode(bB64);
      if (a.w !== b.w || a.h !== b.h) return { error: `size mismatch ${a.w}x${a.h} vs ${b.w}x${b.h}` };
      return window.MtlxImageMetrics.computeMetrics(a.data, b.data, a.w, a.h);
    }, { aB64, bB64 });
    return result;
  } finally {
    await browser.close().catch(() => {});
  }
}

function printTable(rows) {
  const widths = {};
  for (const row of rows) for (const k of Object.keys(row)) widths[k] = Math.max((widths[k] || k.length), String(row[k]).length);
  const keys = Object.keys(rows[0] || {});
  console.log(keys.map((k) => k.padEnd(widths[k])).join('  '));
  for (const row of rows) console.log(keys.map((k) => String(row[k]).padEnd(widths[k])).join('  '));
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`Argument error: ${e.message}`); console.error(HELP); process.exitCode = 2; return; }
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });
  const subject = path.resolve(args.subject);

  let mtlxName = args.mtlx;
  if (args.mode === 'material' && !mtlxName) {
    const mtlxFiles = fs.readdirSync(subject).filter((f) => f.toLowerCase().endsWith('.mtlx'));
    if (mtlxFiles.length > 1) {
      console.error(`Warning: ${mtlxFiles.length} .mtlx files in ${subject} and no --mtlx given; the viewer's default pick will be used. Pass --mtlx <basename> to be explicit (best-effort combobox selection, single-mtlx folders are the well-tested path).`);
    }
  }

  const server = await startServer({ root: ROOT });
  const report = {
    label: args.label, mode: args.mode, subject, settings: args.settings, backend: args.backend,
    sourceHashes: sourceHashes(), samples: [], median: {}, stillMetrics: null, consoleErrors: [],
  };
  // --warm-cache: one temp profile dir for the whole run, outside the repo,
  // reused across samples so the driver's disk cache carries over.
  const profileDir = args.warmCache
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'mxpt-warmcache-'))
    : null;
  try {
    for (let i = 1; i <= args.samples; i += 1) {
      const captureStill = i === 1;
      let result;
      if (args.mode === 'material') {
        runMaterialSample.__settings = args.settings;
        result = await runMaterialSample({ server, backend: args.backend, subject, mtlxName, sampleIndex: i, outDir, captureStill, warmCache: args.warmCache, profileDir });
      } else {
        result = await runSceneSample({ server, backend: args.backend, subject, rootBasename: args.root, sampleIndex: i, outDir, captureStill, settings: args.settings, displayFlip: args.displayFlip, warmCache: args.warmCache, profileDir });
      }
      report.samples.push(result);
      report.consoleErrors.push(...(result.consoleErrors || []).map((text) => ({ sample: i, text })));
    }

    if (args.mode === 'material') {
      const keys = ['genGenerateMs', 'glCompileSubmitMs', 'glCompileWaitMs', 'glCompileMs', 'totalMs'];
      for (const k of keys) {
        const values = report.samples.map((s) => s.fields && s.fields[k]).filter((v) => typeof v === 'number');
        report.median[k] = median(values);
      }
    } else {
      const keys = ['materialPhaseMs', 'bindPhaseMs', 'gpuProgramMs', 'distinctPrograms', 'firstGeometryFrameMs', 'frameAvgMs', 'envPrefilterMs', 'stageLightSamples', 'stageLightSlots'];
      for (const k of keys) {
        const values = report.samples.map((s) => s.scenePerf && s.scenePerf[k]).filter((v) => typeof v === 'number');
        report.median[k] = values.length ? median(values) : null;
      }
      report.median.wallMs = median(report.samples.map((s) => s.wallMs).filter((v) => typeof v === 'number'));
      report.median.longestTaskMs = median(report.samples.map((s) => s.longtasks && s.longtasks.longestTaskMs).filter((v) => typeof v === 'number'));
      report.median.longestTaskAfterGeometryFirstMs = median(report.samples.map((s) => s.longtasks && s.longtasks.longestTaskAfterGeometryFirstMs).filter((v) => typeof v === 'number'));
      if (args.displayFlip) report.median.flipMs = median(report.samples.map((s) => s.flipMs).filter((v) => typeof v === 'number'));
      // Union of every sample's warnings list; a real regression should show
      // up in every sample, but a union avoids hiding a one-off addition.
      const warningSet = new Set();
      for (const s of report.samples) for (const w of (s.warnings || [])) warningSet.add(w);
      report.warnings = [...warningSet];
    }

    // Item 7a: byte-stability across samples. Material mode compares the
    // largest-fragment hash; scene mode compares per-material hashes so a
    // one-material regression is named instead of just failing the whole run.
    if (args.mode === 'material') {
      const hashes = report.samples.map((s) => s.sourceHash).filter(Boolean);
      report.sourcesStableAcrossSamples = hashes.length > 0 && hashes.every((h) => h === hashes[0]);
    } else {
      const labels = new Set();
      for (const s of report.samples) for (const label of Object.keys(s.materialHashes || {})) labels.add(label);
      const differing = [];
      for (const label of labels) {
        const values = report.samples.map((s) => (s.materialHashes || {})[label]).filter((v) => v != null);
        if (values.length > 1 && !values.every((v) => v === values[0])) differing.push(label);
      }
      report.sourcesStableAcrossSamples = differing.length === 0;
      if (differing.length) report.sourcesUnstableMaterials = differing;
    }

    // Item 7b: cold (sample 1 under --warm-cache) vs warm (later samples on
    // the same reused profile) split, reported separately from the plain median.
    if (args.warmCache) {
      const coldSamples = report.samples.filter((s) => s.cold);
      const warmSamples = report.samples.filter((s) => !s.cold);
      const keys = args.mode === 'material'
        ? ['genGenerateMs', 'glCompileSubmitMs', 'glCompileWaitMs', 'glCompileMs', 'totalMs']
        : ['materialPhaseMs', 'bindPhaseMs', 'gpuProgramMs', 'distinctPrograms'];
      const pick = (samples, key) => median(samples.map((s) => (args.mode === 'material' ? (s.fields || {})[key] : (s.scenePerf || {})[key])).filter((v) => typeof v === 'number'));
      report.warmCache = {
        coldSamples: coldSamples.map((s) => s.sample), warmSamples: warmSamples.map((s) => s.sample),
        cold: Object.fromEntries(keys.map((k) => [k, pick(coldSamples, k)])),
        warm: Object.fromEntries(keys.map((k) => [k, pick(warmSamples, k)])),
      };
      if (args.mode !== 'material') {
        report.warmCache.cold.wallMs = median(coldSamples.map((s) => s.wallMs).filter((v) => typeof v === 'number'));
        report.warmCache.warm.wallMs = median(warmSamples.map((s) => s.wallMs).filter((v) => typeof v === 'number'));
      } else {
        report.warmCache.cold.wallMs = null; report.warmCache.warm.wallMs = null;
      }
    }

    const firstStill = report.samples[0] && report.samples[0].stillPath;
    if (firstStill && args.baseline) {
      report.stillMetrics = await computeStillMetrics(server, firstStill, path.resolve(args.baseline));
    }

    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

    printTable([{ metric: 'median', ...report.median }]);
    if (report.warnings) console.log(`scene warnings (${report.warnings.length}):`, JSON.stringify(report.warnings));
    console.log(`console errors: ${report.consoleErrors.length}`);
    if (report.stillMetrics) console.log('still metrics:', JSON.stringify(report.stillMetrics));
    console.log(`sources stable across samples: ${report.sourcesStableAcrossSamples}`);
    if (report.sourcesUnstableMaterials) console.log('unstable materials:', JSON.stringify(report.sourcesUnstableMaterials));
    if (report.warmCache) console.log('warm-cache cold vs warm:', JSON.stringify(report.warmCache));
    console.log(`report: ${path.join(outDir, 'report.json')}`);
  } finally {
    await server.close().catch(() => {});
    if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

main();
