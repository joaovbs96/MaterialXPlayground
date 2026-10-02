#!/usr/bin/env node
/* End-to-end probe for the node thumbnail controller (js/graph/thumb-client.js) in the real
   graph page: loads a fixture into the real graph page, waits for the page's own client to finish
   (pill appears then disappears), checks every card shows a canvas, and checks that nothing creates a Worker while the global
   preference is off. Real-GPU by default. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startServer } from '../embed/lib/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELP = 'Usage: node tests/perf/thumb-client-probe.mjs [--fixture <file.mtlx>] [--software]';

function parseArgs(argv) {
  const out = { fixture: path.join(ROOT, 'scratchpad/thumbs/fixtures/standard_surface_marble_solid.mtlx'), software: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else if (a === '--fixture') { if (argv[++i] == null) throw new Error('--fixture requires a value'); out.fixture = argv[i]; }
    else if (a === '--software') out.software = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const xml = fs.readFileSync(args.fixture, 'utf8');
  const server = await startServer({ root: ROOT });
  const launchArgs = args.software ? [] : ['--headless=new', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
  const browser = await chromium.launch(args.software ? { headless: true } : { headless: false, args: launchArgs });
  let failed = false;
  try {
    const ctx = await browser.newContext();
    const counter = () => {
      window.__workers = [];
      window.__fetches = [];
      const Orig = window.Worker;
      window.__posts = [];
      window.Worker = function (...a) {
        window.__workers.push((a[1] && a[1].name) || '');
        const w = new Orig(...a);
        const post = w.postMessage.bind(w);
        w.postMessage = (m, t) => { window.__posts.push(m && m.type); return post(m, t); };
        return w;
      };
      const of = window.fetch;
      window.fetch = (...a) => { window.__fetches.push(String((a[0] && a[0].url) || a[0])); return of.apply(window, a); };
    };
    const watch = (page) => {
      page.on('pageerror', (e) => console.error('[pageerror]', e.message));
      page.on('console', (m) => { if (m.type() === 'error') console.error('[console.error]', m.text().slice(0, 300)); });
      page.on('response', (r) => { if (r.status() >= 400) console.error('[http ' + r.status() + ']', r.url()); });
    };
    const ready = (page) => page.waitForFunction(() => window.MtlxThumbClient && window.MtlxThumbScheduler, null, { timeout: 120000 });

    // On: the page's own client renders the loaded document; observe worker, pill and cards.
    const page = await ctx.newPage();
    watch(page);
    await page.addInitScript(counter);
    await page.addInitScript((x) => { window.__mtlxPendingImport = { xml: x, name: 'probe' }; }, xml);
    const t0 = Date.now();
    await page.goto(`${server.baseURL}/index.html#!graph`);
    await ready(page);
    await page.waitForSelector('[data-mtlx-thumb]', { timeout: 120000 });
    await page.waitForSelector('[data-mtlx-thumb-pill]', { timeout: 120000 });
    await page.waitForSelector('[data-mtlx-thumb-pill]', { state: 'detached', timeout: 120000 });
    await page.waitForTimeout(500);
    const on = await page.evaluate(() => ({
      workers: window.__workers.filter((n) => n === 'mtlx-thumbnails').length,
      states: [...document.querySelectorAll('[data-mtlx-thumb]')].map((el) => el.getAttribute('data-mtlx-thumb')),
      canvases: document.querySelectorAll('[data-mtlx-thumb] canvas').length,
    }));
    const bad = on.states.filter((s) => s !== 'ready' && s !== 'approx');
    console.log(`cards=${on.states.length} canvases=${on.canvases} workers=${on.workers} ms=${Date.now() - t0}`);
    // The worker generates ahead while the sidebar preview compiles (informational).
    const posts = await page.evaluate(() => window.__posts.slice());
    const nPrep = posts.filter((t) => t === 'prepare').length;
    console.log('prepare posts:', nPrep);
    if (!on.states.length) { failed = true; console.log('no thumbnail cards found'); }
    if (bad.length) { failed = true; console.log('not ready:', JSON.stringify(bad)); }
    if (on.canvases !== on.states.length) { failed = true; console.log('canvas count does not match card count'); }
    if (on.workers !== 1) { failed = true; console.log('expected exactly one worker, saw', on.workers); }
    // Shader thumbnails default off: the pattern run above must not have touched the scene.
    const zero = await page.evaluate(() => ({
      glb: window.__fetches.filter((u) => /shaderball.glb/.test(u)).length,
      scenes: window.__posts.filter((t) => t === 'setScene').length,
    }));
    console.log('shader off:', JSON.stringify(zero));
    if (zero.glb || zero.scenes) { failed = true; console.log('FAIL: shader thumbnails off was not free'); }

    // Off: the global preference disables everything before load.
    const offCtx = await browser.newContext();
    const off = await offCtx.newPage();
    watch(off);
    await off.addInitScript(() => { localStorage.setItem('mtlxGraphThumbnails', 'false'); });
    await off.addInitScript(counter);
    await off.addInitScript((x) => { window.__mtlxPendingImport = { xml: x, name: 'probe' }; }, xml);
    await off.goto(`${server.baseURL}/index.html#!graph`);
    await ready(off);
    await off.waitForTimeout(5000);
    const o = await off.evaluate(() => ({
      workers: window.__workers.filter((n) => n === 'mtlx-thumbnails').length,
      fetches: window.__fetches.filter((u) => /thumb-worker/.test(u)).length,
      cards: document.querySelectorAll('[data-mtlx-thumb]').length,
    }));
    console.log('off:', JSON.stringify(o));
    if (o.workers !== 0 || o.fetches !== 0 || o.cards !== 0) { failed = true; console.log('FAIL: the off state was not free'); }

    // Shader thumbnails on: the UI marks the material and shader cards itself.
    const shCtx = await browser.newContext();
    const sh = await shCtx.newPage();
    watch(sh);
    await sh.addInitScript(counter);
    await sh.addInitScript(() => { localStorage.setItem('mtlxGraphShaderThumbnails', 'true'); });
    await sh.addInitScript((x) => { window.__mtlxPendingImport = { xml: x, name: 'probe' }; }, xml);
    const s0 = Date.now();
    await sh.goto(`${server.baseURL}/index.html#!graph`);
    await ready(sh);
    await sh.waitForSelector('[data-mtlx-thumb]', { timeout: 120000 });
    await sh.waitForFunction(() => document.querySelectorAll('[data-mtlx-thumb="pending"]').length === 0 && !document.querySelector('[data-mtlx-thumb-pill]'), null, { timeout: 240000, polling: 250 });
    const shOn = await sh.evaluate(() => ({
      states: [...document.querySelectorAll('[data-mtlx-thumb]')].map((el) => el.getAttribute('data-mtlx-thumb')),
      glb: window.__fetches.filter((u) => /shaderball.glb/.test(u)).length,
      scenes: window.__posts.filter((t) => t === 'setScene').length,
    }));
    console.log('shader on:', JSON.stringify(shOn), 'ms=' + (Date.now() - s0));
    if (shOn.states.some((st) => st !== 'ready' && st !== 'approx')) { failed = true; console.log('FAIL: a shader card did not finish'); }
    if (shOn.glb !== 1 || shOn.scenes < 1) { failed = true; console.log('FAIL: expected one GLB fetch and a setScene'); }
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
