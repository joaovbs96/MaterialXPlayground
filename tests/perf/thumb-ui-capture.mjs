#!/usr/bin/env node
/* Screenshots of the Graph Editor node thumbnails (real GPU by default), for the small and the
   large size, in the dark and the light theme: the default document (root and NG_marble1), a
   synthetic showcase with long names, an interface card and a definition card, a mixed case
   (global small, one node large), the pill, the View menu and the node context menu. Every state
   also runs a card-intersection check. Output: scratchpad/thumbs/wp6b/. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startServer } from '../embed/lib/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELP = 'Usage: node tests/perf/thumb-ui-capture.mjs [--out <dir>] [--software] [--variants-only] [--sequence-only] [--shader-only]';
const PILL = '[data-mtlx-thumb-pill]';

function parseArgs(argv) {
  const out = { out: path.join(ROOT, 'scratchpad/thumbs/wp6b'), software: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else if (a === '--out') { if (argv[++i] == null) throw new Error('--out requires a value'); out.out = path.resolve(argv[i]); }
    else if (a === '--software') out.software = true;
    else if (a === '--variants-only' || a === '--sequence-only' || a === '--shader-only') continue;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

const SHOWCASE = [
  '<?xml version="1.0"?>',
  '<materialx version="1.39">',
  '  <nodedef name="ND_tint_color3" node="tint" nodegroup="color">',
  '    <input name="amount" type="float" value="0.5" />',
  '    <output name="out" type="color3" />',
  '  </nodedef>',
  '  <nodegraph name="NG_tint" nodedef="ND_tint_color3">',
  '    <constant name="base_tint" type="color3"><input name="value" type="color3" value="0.2, 0.4, 0.8" /></constant>',
  '    <multiply name="scale_tint" type="color3"><input name="in1" type="color3" nodename="base_tint" /><input name="in2" type="float" interfacename="amount" /></multiply>',
  '    <output name="out" type="color3" nodename="scale_tint" />',
  '  </nodegraph>',
  '  <fractal3d name="a_very_long_fractal_noise_pattern_node_name" type="float"><input name="amplitude" type="float" value="0.8" /></fractal3d>',
  '  <constant name="warm_orange_constant_with_a_long_name" type="color3"><input name="value" type="color3" value="1, 0.5, 0.1" /></constant>',
  '  <mix name="mix_the_two" type="color3">',
  '    <input name="fg" type="color3" nodename="warm_orange_constant_with_a_long_name" />',
  '    <input name="bg" type="color3" value="0.1, 0.1, 0.1" />',
  '    <input name="mix" type="float" nodename="a_very_long_fractal_noise_pattern_node_name" />',
  '  </mix>',
  '  <nodegraph name="NG_wrapper">',
  '    <input name="tint_in" type="color3" value="0.5, 0.5, 0.5" />',
  '    <multiply name="m" type="color3"><input name="in1" type="color3" interfacename="tint_in" /><input name="in2" type="float" value="0.5" /></multiply>',
  '    <output name="out" type="color3" nodename="m" />',
  '  </nodegraph>',
  '</materialx>',
].join('\n');

async function openGraph(browser, baseURL, theme, size, shader) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addInitScript(([t, sz, sh]) => {
    try {
      localStorage.setItem('mtlxTheme', t);
      localStorage.setItem('mtlxGraphThumbnailSize', sz);
      localStorage.removeItem('mtlxGraphThumbnails');
      if (sh) localStorage.setItem('mtlxGraphShaderThumbnails', 'true'); else localStorage.removeItem('mtlxGraphShaderThumbnails');
    } catch (e) { /* storage blocked */ }
  }, [theme, size, !!shader]);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`${baseURL}/index.html#!graph`);
  return { ctx, page };
}

async function waitSettled(page) {
  await page.waitForSelector('.react-flow__node', { timeout: 120000 });
  await page.waitForSelector('[data-mtlx-thumb]', { timeout: 120000 });
  await page.waitForSelector(PILL, { state: 'attached', timeout: 20000 }).catch(() => {});
  await page.waitForSelector(PILL, { state: 'detached', timeout: 180000 });
  await page.waitForFunction(() => document.querySelectorAll('[data-mtlx-thumb="pending"]').length === 0, null, { timeout: 60000 });
  await page.waitForTimeout(600);
}

const fit = async (page) => {
  await page.mouse.click(700, 160);
  await page.keyboard.press('f');
  await page.waitForTimeout(900);
};

// No two cards may intersect (flow units, 0.5 unit tolerance); also reports the tightest vertical gap.
async function checkOverlap(page, label) {
  const r = await page.evaluate(() => {
    const vp = document.querySelector('.react-flow__viewport');
    const z = new DOMMatrix(getComputedStyle(vp).transform).a || 1;
    const rs = Array.from(document.querySelectorAll('.react-flow__node')).map((el) => {
      const b = el.firstElementChild.getBoundingClientRect();
      return { id: el.getAttribute('data-id'), x: b.x / z, y: b.y / z, w: b.width / z, h: b.height / z };
    });
    const hits = [];
    let minGap = Infinity;
    for (let i = 0; i < rs.length; i += 1) {
      for (let j = i + 1; j < rs.length; j += 1) {
        const a = rs[i], b = rs[j];
        const dx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w));
        const dy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));
        if (dx < -0.5 && dy < -0.5) hits.push(a.id + ' x ' + b.id);
        else if (dx < 0) minGap = Math.min(minGap, dy);
      }
    }
    return { cards: rs.length, hits, minGap };
  });
  console.log(`[${label}] cards=${r.cards} intersecting pairs=${r.hits.length}${r.hits.length ? ' ' + r.hits.join(', ') : ''} tightest vertical gap=${Number.isFinite(r.minGap) ? r.minGap.toFixed(1) : 'n/a'}`);
  if (r.hits.length) process.exitCode = 1;
}

// Wheel-zoom around a card in the middle of the view, then clip up to three neighbouring cards.
async function zoomCrop(page, shot, name, pickIds) {
  const cards = page.locator('.react-flow__node:has([data-mtlx-thumb])');
  const n = await cards.count();
  if (!n) return;
  const first = await cards.nth(Math.floor(n / 2)).boundingBox();
  if (!first) return;
  await page.mouse.move(first.x + first.width / 2, first.y + 40);
  for (let i = 0; i < 4; i += 1) { await page.mouse.wheel(0, -300); await page.waitForTimeout(120); }
  await page.waitForTimeout(600);
  const boxes = [];
  const all = page.locator('.react-flow__node');
  for (let i = 0; i < await all.count(); i += 1) {
    const id = await all.nth(i).getAttribute('data-id');
    if (pickIds && !pickIds.includes(id)) continue;
    const bb = await all.nth(i).boundingBox();
    if (bb && bb.x >= 356 && bb.x + bb.width <= 1276 && bb.y + bb.height / 2 >= 130 && bb.y + bb.height / 2 <= 960) boxes.push(bb);
  }
  boxes.sort((m, k) => m.x - k.x || m.y - k.y);
  const pick = boxes.slice(0, 3);
  if (!pick.length) { console.log('zoomCrop: no card in view for', name); return; }
  const x0 = Math.max(352, Math.min(...pick.map((q) => q.x)) - 24), y0 = Math.max(98, Math.min(...pick.map((q) => q.y)) - 24);
  const x1 = Math.min(1280, Math.max(...pick.map((q) => q.x + q.width)) + 24), y1 = Math.min(975, Math.max(...pick.map((q) => q.y + q.height)) + 24);
  await shot(name, { clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
}

const CANVAS_CLIP = { x: 352, y: 98, width: 928, height: 872 };

async function run(browser, baseURL, theme, size, outDir, opts) {
  const { ctx, page } = await openGraph(browser, baseURL, theme, size);
  const tag = `${size}-${theme}`;
  const shot = (name, o) => page.screenshot(Object.assign({ path: path.join(outDir, `${name}-${tag}.png`) }, o));
  const counts = () => page.evaluate(() => {
    const c = {};
    document.querySelectorAll('[data-mtlx-thumb]').forEach((e) => { const k = e.getAttribute('data-mtlx-thumb-size') + ':' + e.getAttribute('data-mtlx-thumb'); c[k] = (c[k] || 0) + 1; });
    return c;
  });
  try {
    await page.waitForSelector(PILL, { state: 'visible', timeout: 120000 });
    await shot('pill', { clip: { x: 0, y: 800, width: 520, height: 200 } });
    await waitSettled(page);
    await checkOverlap(page, `${tag} root`);
    await shot('graph-full');

    // Inside the nodegraph: many pattern nodes.
    await page.locator('.react-flow__node[data-id^="g:"]').first().dblclick({ position: { x: 30, y: 30 } });
    await page.waitForSelector('.react-flow__node[data-id^="n:"]', { timeout: 60000 });
    await waitSettled(page);
    await fit(page);
    const hs = await page.evaluate(() => {
      const set = new Set();
      document.querySelectorAll('[data-mtlx-thumb-size="small"]').forEach((e) => set.add(e.parentElement.offsetHeight));
      return Array.from(set);
    });
    console.log(`[${tag}] nodegraph thumbnails:`, JSON.stringify(await counts()), 'small header heights:', JSON.stringify(hs));
    await checkOverlap(page, `${tag} nodegraph`);
    await shot('graph-nodegraph');
    await zoomCrop(page, shot, 'graph-zoom');

    await fit(page);
    await page.locator('[role="menubar"] button', { hasText: /^View$/ }).first().click();
    await page.waitForTimeout(300);
    await shot('menu-view', { clip: { x: 0, y: 0, width: 640, height: 300 } });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    const target = page.locator('.react-flow__node:has([data-mtlx-thumb])').nth(6);
    const tb = await target.boundingBox();
    if (tb) {
      await page.mouse.click(tb.x + 10, tb.y + 4, { button: 'right' });
      await page.waitForTimeout(400);
      await shot('menu-node', { clip: { x: Math.max(0, tb.x - 60), y: Math.max(0, tb.y - 40), width: 560, height: 560 } });
      await page.keyboard.press('Escape');
    }

    if (opts.mixed && tb) {
      // Global small, one node large through the context menu; auto layout (A) makes room for it.
      await page.mouse.click(tb.x + 10, tb.y + 4, { button: 'right' });
      await page.waitForTimeout(300);
      await page.getByText('Large Thumbnail', { exact: true }).click();
      await page.waitForTimeout(500);
      await page.mouse.click(700, 160);
      await page.keyboard.press('a');
      await page.waitForTimeout(900);
      await fit(page);
      console.log(`[${tag}] mixed thumbnails:`, JSON.stringify(await counts()));
      await checkOverlap(page, `${tag} mixed`);
      await shot('graph-mixed');
      return;
    }

    // Showcase: long names, a definition card and an interface card.
    await page.evaluate((x) => window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: { xml: x, name: 'showcase' } })), SHOWCASE);
    await page.waitForSelector('.react-flow__node[data-id="n:mix_the_two"]', { timeout: 60000 });
    await waitSettled(page);
    await fit(page);
    await checkOverlap(page, `${tag} showcase root`);
    await shot('showcase-root', { clip: CANVAS_CLIP });
    await zoomCrop(page, shot, 'showcase-zoom', ['n:a_very_long_fractal_noise_pattern_node_name', 'n:warm_orange_constant_with_a_long_name', 'g:NG_tint', 'n:mix_the_two']);
    await fit(page);
    await page.locator('.react-flow__node[data-id="g:NG_wrapper"]').dblclick({ position: { x: 30, y: 30 } });
    await page.waitForSelector('.react-flow__node[data-id="i:tint_in"]', { timeout: 60000 });
    await waitSettled(page);
    await fit(page);
    await checkOverlap(page, `${tag} showcase iface`);
    await shot('showcase-iface', { clip: CANVAS_CLIP });
  } finally {
    await ctx.close().catch(() => {});
  }
}

// Side-by-side composite of several captured PNGs (left to right).
async function composite(browser, outDir, outName, names, vertical = false) {
  if (names.some((n) => !fs.existsSync(path.join(outDir, n + '.png')))) { console.log('composite skipped, missing input for', outName); return; }
  const read = (n) => `data:image/png;base64,${fs.readFileSync(path.join(outDir, `${n}.png`)).toString('base64')}`;
  const page = await (await browser.newContext({ viewport: { width: 200, height: 200 } })).newPage();
  const imgs = names.map((n) => `<img src="${read(n)}" style="display:block">`).join('');
  await page.setContent(`<body style="margin:0;background:#888;display:flex;${vertical ? 'flex-direction:column;' : ''}gap:8px;align-items:flex-start">${imgs}</body>`);
  await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete));
  const dims = await page.evaluate((vertical) => {
    const im = Array.from(document.images);
    const sum = (f) => im.reduce((a, i) => a + f(i), 0) + 8 * (im.length - 1);
    return vertical
      ? { w: Math.max(...im.map((i) => i.naturalWidth)), h: sum((i) => i.naturalHeight) }
      : { w: sum((i) => i.naturalWidth), h: Math.max(...im.map((i) => i.naturalHeight)) };
  }, vertical);
  await page.setViewportSize({ width: dims.w, height: dims.h });
  await page.screenshot({ path: path.join(outDir, `${outName}.png`) });
  await page.context().close();
}

// The same showcase cards with no preview, a small and a large one, at the same zoom, side by side.
const VARIANT_CARDS = [
  { id: 'n:a_very_long_fractal_noise_pattern_node_name', scope: '' },
  { id: 'g:NG_wrapper', scope: '' },
  { id: 'g:NG_tint', scope: '' },
  { id: 'i:tint_in', scope: 'NG_wrapper' },
];
const VARIANTS = [['off', 'No preview'], ['small', 'Small preview'], ['large', 'Large preview']];

async function frameAndShoot(page, id, file) {
  const card = page.locator(`.react-flow__node[data-id="${id}"]`);
  const bb = await card.boundingBox();
  await page.mouse.click(bb.x + 40, bb.y + 8, { button: 'right' });
  await page.getByText('Frame Node', { exact: true }).click();
  await page.waitForTimeout(900);
  await page.mouse.click(1200, 150);
  await card.screenshot({ path: file });
}

async function captureVariants(browser, baseURL, theme, outDir) {
  const tmp = path.join(outDir, 'variants-tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const files = {};
  let bg = '#888';
  for (const [variant] of VARIANTS) {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
    await ctx.addInitScript(([t, v]) => {
      try {
        localStorage.setItem('mtlxTheme', t);
        localStorage.setItem('mtlxGraphThumbnailSize', v === 'large' ? 'large' : 'small');
        if (v === 'off') localStorage.setItem('mtlxGraphThumbnails', 'false'); else localStorage.removeItem('mtlxGraphThumbnails');
      } catch (e) { /* storage blocked */ }
    }, [theme, variant]);
    const page = await ctx.newPage();
    await page.goto(`${baseURL}/index.html#!graph`);
    await page.waitForSelector('.react-flow__node', { timeout: 120000 });
    if (variant !== 'off') await waitSettled(page); else await page.waitForTimeout(2000);
    await page.evaluate((x) => window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: { xml: x, name: 'showcase' } })), SHOWCASE);
    await page.waitForSelector('.react-flow__node[data-id="n:mix_the_two"]', { timeout: 60000 });
    if (variant === 'off') await page.waitForTimeout(2500); else await waitSettled(page);
    bg = await page.evaluate(() => getComputedStyle(document.querySelector('.react-flow')).backgroundColor);
    files[variant] = [];
    for (const c of VARIANT_CARDS) {
      if (c.scope && !(await page.locator(`.react-flow__node[data-id="${c.id}"]`).count())) {
        await fit(page);
        const wrapper = page.locator(`.react-flow__node[data-id="g:${c.scope}"]`);
        const wb = await wrapper.boundingBox();
        const k = wb.width / 240; // the card is zoomed after fit; aim at the category row, away from the name
        await wrapper.dblclick({ position: { x: 150 * k, y: 32 * k } });
        await page.waitForSelector(`.react-flow__node[data-id="${c.id}"]`, { timeout: 60000 });
        if (variant !== 'off') await waitSettled(page); else await page.waitForTimeout(1500);
      }
      const file = path.join(tmp, `${theme}-${variant}-${c.id.replace(/[^a-z0-9]/gi, '_')}.png`);
      await frameAndShoot(page, c.id, file);
      files[variant].push(file);
    }
    await ctx.close();
  }
  // Columns share one zoom: every card image is shown at its 1.2x CSS width (288px).
  const fg = theme === 'dark' ? '#d1d5db' : '#1f2937';
  const cols = VARIANTS.map(([v, label]) => `<div style="display:flex;flex-direction:column;gap:14px;align-items:flex-start"><div style="font:600 14px system-ui;color:${fg}">${label}</div>${files[v].map((f) => `<img style="display:block;width:288px" src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}">`).join('')}</div>`).join('');
  const page = await (await browser.newContext({ viewport: { width: 400, height: 400 }, deviceScaleFactor: 2 })).newPage();
  await page.setContent(`<body style="margin:0;padding:14px;background:${bg};display:inline-flex;gap:28px;align-items:flex-start">${cols}</body>`);
  await page.waitForFunction(() => Array.from(document.images).every((i) => i.complete));
  const dims = await page.evaluate(() => ({ w: Math.ceil(document.body.getBoundingClientRect().width), h: Math.ceil(document.body.getBoundingClientRect().height) }));
  await page.setViewportSize({ width: dims.w, height: dims.h });
  await page.screenshot({ path: path.join(outDir, `variants-${theme}.png`) });
  await page.context().close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

// The NG_marble1 card goes large -> small -> large (after the worker has been idle long enough to
// release its GL context). The image must stay visible and the worker must get no render job.
async function captureSequence(browser, baseURL, theme, outDir) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addInitScript(([t]) => {
    try { localStorage.setItem('mtlxTheme', t); localStorage.setItem('mtlxGraphThumbnailSize', 'large'); localStorage.removeItem('mtlxGraphThumbnails'); } catch (e) { /* storage blocked */ }
    window.__renderJobs = 0;
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (m, ...rest) { if (m && m.type === 'render') window.__renderJobs += 1; return post.call(this, m, ...rest); };
  }, [theme]);
  const page = await ctx.newPage();
  await page.goto(`${baseURL}/index.html#!graph`);
  await waitSettled(page);
  await page.waitForTimeout(12000);
  const card = page.locator('.react-flow__node[data-id="g:NG_marble1"]');
  const inkOf = () => page.evaluate(() => {
    const cv = document.querySelector('.react-flow__node[data-id="g:NG_marble1"] canvas');
    if (!cv) return 'no canvas';
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n += 1;
    return `${cv.width}x${cv.height} opaque=${n}`;
  });
  const names = [];
  const step = async (label) => {
    await page.waitForTimeout(700);
    const name = `ng-sequence-${label}-${theme}`;
    await card.screenshot({ path: path.join(outDir, name + '.png') });
    names.push(name);
    console.log(`[sequence ${theme}] ${label}: ${await inkOf()} renderJobs=${await page.evaluate(() => window.__renderJobs)}`);
  };
  await step('1-large');
  for (const label of ['2-small', '3-large']) {
    const bb = await card.boundingBox();
    await page.mouse.click(bb.x + 100, bb.y + 8, { button: 'right' });
    await page.getByText('Large Thumbnail', { exact: true }).click();
    await step(label);
  }
  await ctx.close();
  await composite(browser, outDir, `ng-sequence-${theme}`, names);
}

// Shader states: shader thumbnails ON, a document with several shader nodes, mid-render and settled.
const SHADER_DOC = [
  '<?xml version="1.0"?>',
  '<materialx version="1.39" colorspace="lin_rec709">',
  '  <open_pbr_surface name="OpenPBR_gold" type="surfaceshader">',
  '    <input name="base_color" type="color3" value="0.9, 0.62, 0.2" />',
  '    <input name="base_metalness" type="float" value="1" />',
  '    <input name="specular_roughness" type="float" value="0.25" />',
  '  </open_pbr_surface>',
  '  <surfacematerial name="Gold" type="material"><input name="surfaceshader" type="surfaceshader" nodename="OpenPBR_gold" /></surfacematerial>',
  '  <standard_surface name="SR_glass" type="surfaceshader">',
  '    <input name="base" type="float" value="0.0" />',
  '    <input name="specular_roughness" type="float" value="0.01" />',
  '    <input name="specular_IOR" type="float" value="1.52" />',
  '    <input name="transmission" type="float" value="1" />',
  '  </standard_surface>',
  '  <surfacematerial name="Glass" type="material"><input name="surfaceshader" type="surfaceshader" nodename="SR_glass" /></surfacematerial>',
  '  <oren_nayar_diffuse_bsdf name="bsdf1" type="BSDF"><input name="color" type="color3" value="0.2, 0.6, 0.9" /><input name="roughness" type="float" value="0.5" /></oren_nayar_diffuse_bsdf>',
  '  <uniform_edf name="edf1" type="EDF"><input name="color" type="color3" value="1.0, 0.7, 0.2" /></uniform_edf>',
  '  <fractal3d name="noise_pattern" type="float"><input name="amplitude" type="float" value="0.8" /></fractal3d>',
  '  <surfacematerial name="Empty_material" type="material" />',
  '</materialx>',
].join('\n');

async function runShader(browser, baseURL, theme, size, outDir, state) {
  const { ctx, page } = await openGraph(browser, baseURL, theme, size, true);
  const tag = `${size}-${theme}`;
  const shot = (name, o) => page.screenshot(Object.assign({ path: path.join(outDir, `${name}-${tag}.png`) }, o));
  const counts = () => page.evaluate(() => {
    const c = {};
    document.querySelectorAll('[data-mtlx-thumb]').forEach((e) => { const k = e.getAttribute('data-mtlx-thumb'); c[k] = (c[k] || 0) + 1; });
    return c;
  });
  const t0 = Date.now();
  try {
    await page.waitForSelector('.react-flow__node', { timeout: 120000 });
    // Default marble document at the root: wait for every thumbnail, shader ones included.
    await page.waitForSelector('[data-mtlx-thumb]', { timeout: 120000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-mtlx-thumb="pending"]').length === 0 && !document.querySelector('[data-mtlx-thumb-pill]'), null, { timeout: 120000, polling: 250 });
    console.log(`[shader ${tag}] marble root settled after ${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify(await counts()));
    await page.waitForTimeout(500);
    await checkOverlap(page, `${tag} shader marble root`);
    await shot('shader-marble-root');
    await page.evaluate((x) => window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: { xml: x, name: 'shaders' } })), SHADER_DOC);
    await page.waitForSelector('.react-flow__node[data-id="n:OpenPBR_gold"]', { timeout: 60000 });
    const t1 = Date.now();
    if (state === 'pending') {
      const seen = new Set();
      const shots = [];
      while (Date.now() - t1 < 90000) {
        const ph = await page.evaluate(() => Array.from(document.querySelectorAll('.react-flow__node [data-mtlx-thumb="pending"]')).map((e) => e.getAttribute('title')));
        const key = Array.from(new Set(ph)).sort().join('|');
        if (key && !seen.has(key)) { seen.add(key); await fit(page); await shot('shader-pending-' + shots.length, { clip: CANVAS_CLIP }); shots.push('shader-pending-' + shots.length); console.log(`[shader ${tag}] pending titles: ${key}`); }
        if (!ph.length && Date.now() - t1 > 3000) break;
        await page.waitForTimeout(400);
      }
      return shots;
    }
    await page.waitForFunction(() => document.querySelectorAll('[data-mtlx-thumb="pending"]').length === 0 && !document.querySelector('[data-mtlx-thumb-pill]'), null, { timeout: 120000, polling: 250 });
    console.log(`[shader ${tag}] shader document settled after ${((Date.now() - t1) / 1000).toFixed(1)}s`, JSON.stringify(await counts()));
    await page.waitForTimeout(600);
    await fit(page);
    await checkOverlap(page, `${tag} shader doc`);
    await shot('shader-doc', { clip: CANVAS_CLIP });
    await page.locator('[role="menubar"] button', { hasText: /^View$/ }).first().click();
    await page.waitForTimeout(300);
    await shot('shader-menu-view', { clip: { x: 0, y: 0, width: 640, height: 340 } });
    await page.keyboard.press('Escape');
  } finally {
    await ctx.close().catch(() => {});
  }
  return [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.out, { recursive: true });
  const server = await startServer({ root: ROOT });
  const launchArgs = args.software ? [] : ['--headless=new', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
  const browser = await chromium.launch(args.software ? { headless: true } : { headless: false, args: launchArgs });
  try {
    if (process.argv.includes('--shader-only')) {
      for (const size of ['small', 'large']) {
        for (const theme of ['dark', 'light']) await runShader(browser, server.baseURL, theme, size, args.out, 'settled');
        await composite(browser, args.out, `shader-${size}-dark-vs-light`, [`shader-doc-${size}-dark`, `shader-doc-${size}-light`]);
      }
      const shots = await runShader(browser, server.baseURL, 'dark', 'large', args.out, 'pending');
      await composite(browser, args.out, 'shader-pending', shots.map((n) => n + '-large-dark'));
      return;
    }
    if (process.argv.includes('--sequence-only')) {
      for (const theme of ['dark', 'light']) await captureSequence(browser, server.baseURL, theme, args.out);
      return;
    }
    if (process.argv.includes('--variants-only')) {
      for (const theme of ['dark', 'light']) await captureVariants(browser, server.baseURL, theme, args.out);
      await composite(browser, args.out, 'variants-dark-vs-light', ['variants-dark', 'variants-light'], true);
      return;
    }
    for (const size of ['small', 'large']) {
      for (const theme of ['dark', 'light']) await run(browser, server.baseURL, theme, size, args.out, { mixed: false });
    }
    for (const theme of ['dark', 'light']) {
      // Mixed run: the global size is small, the override above makes one node large.
      const sub = path.join(args.out, 'mixed-tmp');
      fs.mkdirSync(sub, { recursive: true });
      await run(browser, server.baseURL, theme, 'small', sub, { mixed: true });
      fs.copyFileSync(path.join(sub, `graph-mixed-small-${theme}.png`), path.join(args.out, `graph-mixed-${theme}.png`));
    }
    fs.rmSync(path.join(args.out, 'mixed-tmp'), { recursive: true, force: true });
    for (const size of ['small', 'large']) {
      for (const name of ['graph-full', 'graph-nodegraph', 'graph-zoom', 'showcase-root', 'showcase-zoom', 'showcase-iface']) {
        await composite(browser, args.out, `${name}-${size}-dark-vs-light`, [`${name}-${size}-dark`, `${name}-${size}-light`]);
      }
    }
    for (const theme of ['dark', 'light']) {
      for (const name of ['graph-zoom', 'showcase-zoom', 'graph-nodegraph']) {
        await composite(browser, args.out, `${name}-small-vs-large-${theme}`, [`${name}-small-${theme}`, `${name}-large-${theme}`]);
      }
    }
    for (const theme of ['dark', 'light']) await captureVariants(browser, server.baseURL, theme, args.out);
    await composite(browser, args.out, 'variants-dark-vs-light', ['variants-dark', 'variants-light'], true);
    for (const theme of ['dark', 'light']) await captureSequence(browser, server.baseURL, theme, args.out);
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
  console.log('wrote', fs.readdirSync(args.out).filter((f) => f.endsWith('.png')).length, 'png files to', args.out);
}

main().catch((e) => { console.error(e); process.exit(1); });
