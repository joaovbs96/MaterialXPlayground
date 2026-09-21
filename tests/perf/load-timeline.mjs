#!/usr/bin/env node
/* Load-timeline harness: measures navigation-to-first-render for the
   no-bundler shell (Babel Standalone JSX, MaterialX wasm, three.js r128).
   Modelled on tests/perf/compile-bench.mjs (launch flags, static server,
   [mtlx-perf] console parsing) but reports the FULL page-load timeline
   instead of just shader-compile time. Plain Node/Playwright script. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startServer } from '../embed/lib/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT_ROOT = 'C:\\Users\\joaov\\AppData\\Local\\Temp\\mxpt-renders\\load-timeline';

const HELP = `Usage: node tests/perf/load-timeline.mjs --mode viewer|scene|home [options]

  --mode viewer|scene|home   What page/view to measure (required)
  --subject <folder>         viewer: material folder; scene: scene folder (omit for viewer's default empty load)
  --root <basename>          scene mode: root .usda basename, if more than one
  --samples N                Cold samples, each a fresh browser (default 3)
  --warm                     After the cold samples, do one more navigation in
                              the SAME browser/profile (HTTP cache + shader cache warm)
  --set key=value             localStorage entry applied before any page script (repeatable)
  --out <dir>                Output dir (default: ${DEFAULT_OUT_ROOT}\\<label>)
  --label <name>              Report label (default: derived from mode/subject)
  --help                      Show this help
`;

function parseArgs(argv) {
  const out = { mode: null, subject: null, root: null, samples: 3, warm: false, sets: [], out: null, label: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { if (argv[++i] == null) throw new Error(`${a} requires a value`); return argv[i]; };
    if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else if (a === '--mode') out.mode = next();
    else if (a === '--subject') out.subject = next();
    else if (a === '--root') out.root = next();
    else if (a === '--samples') out.samples = Number(next());
    else if (a === '--warm') out.warm = true;
    else if (a === '--set') out.sets.push(next());
    else if (a === '--out') out.out = next();
    else if (a === '--label') out.label = next();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!['viewer', 'scene', 'home'].includes(out.mode)) throw new Error('--mode must be viewer, scene or home');
  if (!Number.isInteger(out.samples) || out.samples < 1) throw new Error('--samples must be a positive integer');
  out.settings = {};
  for (const pair of out.sets) {
    const eq = pair.indexOf('=');
    if (eq < 0) throw new Error(`--set expects key=value, got: ${pair}`);
    out.settings[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  if (!out.label) out.label = out.mode + (out.subject ? '-' + path.basename(path.resolve(out.subject)) : '-default');
  if (!out.out) out.out = path.join(DEFAULT_OUT_ROOT, out.label);
  return out;
}

function backendArgs() {
  // Same real-GPU headless flags as compile-bench.mjs's d3d11 backend, plus
  // shader disk cache disabled so cold samples never see a warm driver cache.
  return ['--headless=new', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-gpu-shader-disk-cache'];
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const PERF_LINE = /^\[mtlx-perf\] (.+?): ([\d.]+)ms(?: \(target: (.+)\))?$/;

// Injected before any page script. Traps `window.Babel` with a setter so the
// moment babel-standalone's UMD bundle assigns the global, its .transform is
// wrapped to record { file, sourceLen, ms }. Covers loadJsxApp's calls AND
// babel-standalone's own internal transformScriptTags() pass over the two
// <script type="text/babel"> tags in index.html, since both go through the
// same Babel.transform entry point once the global exists.
const BABEL_TRAP = () => {
  window.__babelCalls = [];
  window.__mtlxLongtasks = [];
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__mtlxLongtasks.push({ start: e.startTime, duration: e.duration });
    });
    obs.observe({ type: 'longtask', buffered: true });
  } catch (e) { /* longtask not supported */ }
  // babel-standalone assigns `global.Babel = {}` ONCE, then populates its
  // methods (.transform etc.) onto that same object afterwards, rather than
  // reassigning window.Babel — so a setter trap on window.Babel alone only
  // ever sees an empty object. Trap `.transform` on the object itself too.
  const wrap = (v) => {
    if (!v || v.__mtlxWrapped) return;
    v.__mtlxWrapped = true;
    const origTransform = v.transform.bind(v);
    const wrapped = (source, opts) => {
      const t0 = performance.now();
      const result = origTransform(source, opts);
      window.__babelCalls.push({
        file: (opts && opts.filename) || '(inline script tag)',
        sourceLen: (source || '').length,
        ms: performance.now() - t0,
      });
      return result;
    };
    // Redefine as a plain data property (not an accessor) so the wrap
    // itself does not re-trigger the transform setter below.
    Object.defineProperty(v, 'transform', { configurable: true, writable: true, value: wrapped });
  };
  let real = window.__BabelReal;
  Object.defineProperty(window, 'Babel', {
    configurable: true,
    get() { return real; },
    set(v) {
      real = v;
      if (!v) return;
      if (typeof v.transform === 'function') { wrap(v); return; }
      let t;
      Object.defineProperty(v, 'transform', {
        configurable: true,
        get() { return t; },
        set(fn) { t = fn; wrap(v); },
      });
    },
  });
};

async function applyInitScripts(context, settings) {
  const entries = { mtlxPerfLog: '1', ...settings };
  await context.addInitScript((kv) => {
    try { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); } catch (e) { /* ignore */ }
  }, entries);
  await context.addInitScript(BABEL_TRAP);
}

function groupResources(entries) {
  const groups = { 'vendor libs': [], 'app JS/JSX': [], 'wasm+data': [], models: [], 'env maps': [], textures: [], other: [] };
  for (const r of entries) {
    const name = r.name;
    let bucket = 'other';
    if (/\/vendor\//.test(name) || /cdn\.jsdelivr|unpkg|cdnjs/.test(name)) bucket = 'vendor libs';
    else if (/\.wasm(\?|$)/.test(name) || /\.data(\?|$)/.test(name)) bucket = 'wasm+data';
    else if (/\.glb(\?|$)|\.gltf(\?|$)/.test(name)) bucket = 'models';
    else if (/environment_map|\.hdr(\?|$)|\.exr(\?|$)/.test(name)) bucket = 'env maps';
    else if (/\.(png|jpg|jpeg|tif|tiff|webp|ktx2?)(\?|$)/i.test(name)) bucket = 'textures';
    else if (/\.(js|jsx)(\?|$)/.test(name)) bucket = 'app JS/JSX';
    groups[bucket].push(r);
  }
  const summary = {};
  for (const [k, list] of Object.entries(groups)) {
    summary[k] = {
      count: list.length,
      transferBytes: list.reduce((a, r) => a + (r.transferSize || 0), 0),
      durationMsSum: list.reduce((a, r) => a + (r.duration || 0), 0),
    };
  }
  const biggest = [...entries].sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0)).slice(0, 5)
    .map((r) => ({ name: r.name.replace(/^.*\/\/[^/]+/, ''), transferBytes: r.transferSize || 0, durationMs: Math.round(r.duration) }));
  return { summary, biggest };
}

async function collectCommon(page, extra) {
  return page.evaluate((extra) => {
    const nav = performance.getEntriesByType('navigation')[0] || null;
    const paints = performance.getEntriesByType('paint').map((p) => ({ name: p.name, startTime: p.startTime }));
    const resources = performance.getEntriesByType('resource').map((r) => ({
      name: r.name, transferSize: r.transferSize, duration: r.duration, startTime: r.startTime, responseEnd: r.responseEnd,
    }));
    const longtasks = window.__mtlxLongtasks || [];
    const babelCalls = window.__babelCalls || [];
    // Eager <script type="text/babel"> tags (js/mtlx-engine.js, js/shell.jsx)
    // never call the public Babel.transform reference the wrap patches (see
    // BABEL_TRAP's comment); approximate their transform+eval-start time as
    // the gap between their own network fetch ending and their first
    // executed statement (a perf.mark planted at the top of each file).
    const marks = performance.getEntriesByType('mark').map((m) => ({ name: m.name, startTime: m.startTime }));
    const eagerGaps = [];
    for (const [file, markName] of [['js/mtlx-engine.js', 'mtlx-engine-exec-start'], ['js/shell.jsx', 'shell-exec-start']]) {
      const mark = marks.find((m) => m.name === markName);
      const res = resources.find((r) => r.name.endsWith('/' + file));
      if (mark && res) eagerGaps.push({ file, fetchEndMs: res.responseEnd, execStartMs: mark.startTime, gapMs: mark.startTime - res.responseEnd });
    }
    return { nav, paints, resources, longtasks, babelCalls, marks, eagerGaps, ...extra };
  }, extra);
}

function summarizeLongtasks(tasks) {
  if (!tasks || !tasks.length) return { count: 0, totalMs: 0, longest: [] };
  const totalMs = tasks.reduce((a, t) => a + t.duration, 0);
  const longest = [...tasks].sort((a, b) => b.duration - a.duration).slice(0, 5)
    .map((t) => ({ startMs: Math.round(t.start), durationMs: Math.round(t.duration) }));
  return { count: tasks.length, totalMs, longest };
}

function summarizeBabel(calls) {
  const total = calls.reduce((a, c) => a + c.ms, 0);
  const perFile = calls.map((c) => ({ file: c.file, ms: Math.round(c.ms * 10) / 10, sourceLen: c.sourceLen }));
  return { totalMs: total, calls: perFile };
}

async function runHomeSample({ server, sampleIndex, warm, settings }) {
  const browser = await chromium.launch({ headless: false, args: backendArgs() });
  try {
    const context = await browser.newContext();
    await applyInitScripts(context, settings);
    const page = await context.newPage();
    await page.goto(`${server.baseURL}/index.html`);
    // "shell mounted"-looking state: the header/root has rendered something.
    await page.locator('#root').waitFor({ state: 'attached', timeout: 60000 });
    await page.waitForFunction(() => document.getElementById('root') && document.getElementById('root').children.length > 0, { timeout: 60000 });
    const shellMountedAt = await page.evaluate(() => performance.now());
    await page.waitForTimeout(300);
    const common = await collectCommon(page, { shellMountedAt });

    let warmResult = null;
    if (warm) {
      const page2 = await context.newPage();
      await page2.goto(`${server.baseURL}/index.html`);
      await page2.waitForFunction(() => document.getElementById('root') && document.getElementById('root').children.length > 0, { timeout: 60000 });
      const shellMountedAt2 = await page2.evaluate(() => performance.now());
      await page2.waitForTimeout(300);
      warmResult = await collectCommon(page2, { shellMountedAt: shellMountedAt2 });
      await page2.close();
    }
    return { sample: sampleIndex, ...common, warmResult };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function runViewerSample({ server, subject, sampleIndex, warm, settings }) {
  const browser = await chromium.launch({ headless: false, args: backendArgs() });
  try {
    const context = await browser.newContext();
    await applyInitScripts(context, settings);
    const consoleLines = [];
    const page = await context.newPage();
    page.on('console', (msg) => consoleLines.push(msg.text()));
    await page.goto(`${server.baseURL}/index.html#!viewer`);

    let doneAt = null;
    if (subject) {
      const dirInput = page.locator('input[type=file][webkitdirectory]').first();
      await dirInput.waitFor({ state: 'attached', timeout: 60000 });
      await dirInput.setInputFiles(subject);
      const totalMsg = await page.waitForEvent('console', {
        predicate: (msg) => /^\[mtlx-perf\] (createMtlxRenderView total|applyMaterial total):/.test(msg.text()),
        timeout: 180000,
      });
      void totalMsg;
      doneAt = await page.evaluate(() => performance.now());
    } else {
      // No material loaded: the viewer's own default/empty state. Wait for
      // the file-drop input to attach (view fully mounted) as "loaded".
      await page.locator('input[type=file][webkitdirectory]').first().waitFor({ state: 'attached', timeout: 60000 });
      doneAt = await page.evaluate(() => performance.now());
    }
    await page.waitForTimeout(500);
    const common = await collectCommon(page, { doneAt });

    const perf = {};
    for (const line of consoleLines) {
      const m = PERF_LINE.exec(line);
      if (!m) continue;
      (perf[m[1]] = perf[m[1]] || []).push(Number(m[2]));
    }

    let warmResult = null;
    if (warm) {
      const consoleLines2 = [];
      const page2 = await context.newPage();
      page2.on('console', (msg) => consoleLines2.push(msg.text()));
      await page2.goto(`${server.baseURL}/index.html#!viewer`);
      let doneAt2 = null;
      if (subject) {
        const dirInput2 = page2.locator('input[type=file][webkitdirectory]').first();
        await dirInput2.waitFor({ state: 'attached', timeout: 60000 });
        await dirInput2.setInputFiles(subject);
        await page2.waitForEvent('console', {
          predicate: (msg) => /^\[mtlx-perf\] (createMtlxRenderView total|applyMaterial total):/.test(msg.text()),
          timeout: 180000,
        });
        doneAt2 = await page2.evaluate(() => performance.now());
      } else {
        await page2.locator('input[type=file][webkitdirectory]').first().waitFor({ state: 'attached', timeout: 60000 });
        doneAt2 = await page2.evaluate(() => performance.now());
      }
      await page2.waitForTimeout(500);
      const common2 = await collectCommon(page2, { doneAt: doneAt2 });
      const perf2 = {};
      for (const line of consoleLines2) {
        const m = PERF_LINE.exec(line);
        if (!m) continue;
        (perf2[m[1]] = perf2[m[1]] || []).push(Number(m[2]));
      }
      warmResult = { ...common2, perf: perf2 };
      await page2.close();
    }

    return { sample: sampleIndex, ...common, perf, warmResult };
  } finally {
    await browser.close().catch(() => {});
  }
}

const SCENE_TEXTURE_MAX_SIZE_KEY = 'mtlx_scene_texture_size';

async function runSceneOnPage(page, { subject, root, textureSize }, settingsExtra) {
  const consoleLines = [];
  page.on('console', (msg) => consoleLines.push(msg.text()));
  await page.goto(page.context()._mtlxBaseURL + '/index.html#!scene');
  await page.locator('[data-testid="usd-scene-viewer"]').waitFor({ state: 'visible', timeout: 60000 });
  await page.locator('input[type=file][webkitdirectory]').setInputFiles(subject);
  const rootSelectVisible = await page.getByTestId('usd-scene-root-select').isVisible().catch(() => false);
  if (rootSelectVisible && root) {
    const rootCombobox = page.getByTestId('usd-scene-root-select').getByRole('combobox');
    await rootCombobox.click();
    const options = await page.getByRole('option').allTextContents();
    const selected = options.find((l) => l.endsWith('/' + root) || l === root);
    if (selected) await page.getByRole('option', { name: selected, exact: true }).click();
  }
  await page.getByTestId('usd-scene-sidebar').getByRole('button', { name: /^Load (?!example)/ }).click();
  await page.getByTestId('usd-scene-status').filter({ hasText: 'rendered' }).waitFor({ state: 'attached', timeout: 600000 });
  const renderedAt = await page.evaluate(() => performance.now());
  await page.waitForTimeout(1000);
  const scenePerf = await page.evaluate(() => window.__mtlxScenePerf || null);
  const scenePhases = await page.evaluate(() => window.__mtlxScenePhases || null);
  const common = await collectCommon(page, { renderedAt, scenePerf, scenePhases });
  return common;
}

async function runSceneSample({ server, subject, root, sampleIndex, warm, settings, textureSize }) {
  const browser = await chromium.launch({ headless: false, args: backendArgs() });
  try {
    const context = await browser.newContext();
    context._mtlxBaseURL = server.baseURL;
    await applyInitScripts(context, { ...settings, [SCENE_TEXTURE_MAX_SIZE_KEY]: textureSize });
    const page = await context.newPage();
    const common = await runSceneOnPage(page, { subject, root, textureSize }, settings);

    let warmResult = null;
    if (warm) {
      const page2 = await context.newPage();
      warmResult = await runSceneOnPage(page2, { subject, root, textureSize }, settings);
      await page2.close();
    }
    return { sample: sampleIndex, ...common, warmResult };
  } finally {
    await browser.close().catch(() => {});
  }
}

function printTable(rows, keys) {
  const widths = {};
  for (const row of rows) for (const k of keys) widths[k] = Math.max((widths[k] || k.length), String(row[k] ?? '').length);
  console.log(keys.map((k) => k.padEnd(widths[k])).join('  '));
  for (const row of rows) console.log(keys.map((k) => String(row[k] ?? '').padEnd(widths[k])).join('  '));
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`Argument error: ${e.message}`); console.error(HELP); process.exitCode = 2; return; }
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });
  const server = await startServer({ root: ROOT });
  const report = { label: args.label, mode: args.mode, subject: args.subject || null, settings: args.settings, samples: [] };

  try {
    for (let i = 1; i <= args.samples; i += 1) {
      const doWarm = args.warm && i === args.samples;
      let result;
      if (args.mode === 'home') result = await runHomeSample({ server, sampleIndex: i, warm: doWarm, settings: args.settings });
      else if (args.mode === 'viewer') result = await runViewerSample({ server, subject: args.subject ? path.resolve(args.subject) : null, sampleIndex: i, warm: doWarm, settings: args.settings });
      else result = await runSceneSample({ server, subject: path.resolve(args.subject), root: args.root, sampleIndex: i, warm: doWarm, settings: args.settings, textureSize: args.settings.mtlx_scene_texture_size || '512' });
      report.samples.push(result);
    }

    // Derived per-sample summaries (cold only; warm reported separately).
    for (const s of report.samples) {
      s.resourceGroups = groupResources(s.resources || []);
      s.longtaskSummary = summarizeLongtasks(s.longtasks);
      s.babelSummary = summarizeBabel(s.babelCalls || []);
      if (s.warmResult) {
        s.warmResult.resourceGroups = groupResources(s.warmResult.resources || []);
        s.warmResult.longtaskSummary = summarizeLongtasks(s.warmResult.longtasks);
        s.warmResult.babelSummary = summarizeBabel(s.warmResult.babelCalls || []);
      }
    }

    report.median = {
      babelTotalMs: median(report.samples.map((s) => s.babelSummary.totalMs)),
      longtaskCount: median(report.samples.map((s) => s.longtaskSummary.count)),
      longtaskTotalMs: median(report.samples.map((s) => s.longtaskSummary.totalMs)),
    };
    if (args.mode === 'home') {
      report.median.shellMountedAtMs = median(report.samples.map((s) => s.shellMountedAt));
      report.median.firstContentfulPaintMs = median(report.samples.map((s) => (s.paints.find((p) => p.name === 'first-contentful-paint') || {}).startTime));
    } else if (args.mode === 'viewer') {
      report.median.doneAtMs = median(report.samples.map((s) => s.doneAt));
      for (const key of ['gen.generate', 'GL compile submit', 'GL compile wait', 'GL compile', 'wasm instantiate', 'stdlib+GenContext', 'env prefilter', 'WebGLRenderer init', 'createMtlxRenderView total', 'applyMaterial total']) {
        const values = report.samples.map((s) => s.perf[key] && s.perf[key][0]).filter((v) => typeof v === 'number');
        if (values.length) report.median[key] = median(values);
      }
    } else {
      report.median.renderedAtMs = median(report.samples.map((s) => s.renderedAt));
      for (const key of ['materialPhaseMs', 'bindPhaseMs', 'gpuProgramMs', 'firstGeometryFrameMs']) {
        const values = report.samples.map((s) => s.scenePerf && s.scenePerf[key]).filter((v) => typeof v === 'number');
        if (values.length) report.median[key] = median(values);
      }
    }

    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

    console.log(`\n=== ${args.label} (${args.mode}) ===`);
    printTable([report.median], Object.keys(report.median));
    for (const s of report.samples) {
      console.log(`\n-- sample ${s.sample} resource groups --`);
      printTable(Object.entries(s.resourceGroups.summary).map(([k, v]) => ({ group: k, ...v })), ['group', 'count', 'transferBytes', 'durationMsSum']);
      console.log(`biggest 5:`, JSON.stringify(s.resourceGroups.biggest));
      console.log(`babel: total=${s.babelSummary.totalMs.toFixed(1)}ms calls=${s.babelSummary.calls.length}`);
      console.log(`eager-script fetch-to-exec gaps (approx transform+eval-start):`, JSON.stringify(s.eagerGaps));
      console.log(`longtasks: count=${s.longtaskSummary.count} totalMs=${s.longtaskSummary.totalMs.toFixed(1)}`);
      if (s.warmResult) {
        console.log(`  warm: babel=${s.warmResult.babelSummary.totalMs.toFixed(1)}ms longtasks=${s.warmResult.longtaskSummary.count}/${s.warmResult.longtaskSummary.totalMs.toFixed(1)}ms`);
      }
    }
    console.log(`\nreport: ${path.join(outDir, 'report.json')}`);
  } finally {
    await server.close().catch(() => {});
  }
}

main();
