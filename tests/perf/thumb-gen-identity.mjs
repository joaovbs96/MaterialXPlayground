#!/usr/bin/env node
/* Byte-identity gate for the thumbnail worker's GenContext choice: replays the worker's
   per-job flow (build, then fresh or shared context via previewCanShareContext) over every
   fixture target and compares vs/fs/uniform hashes with the page goldens. Orders: fixture,
   reversed, shuffled, scope-interleaved; then document mutations against fresh-context runs. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startServer } from '../embed/lib/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELP = 'Usage: node tests/perf/thumb-gen-identity.mjs [--fixtures <dir>] [--goldens <graph-preview-goldens.json>] [--negative-control]';

function parseArgs(argv) {
  const out = {
    fixtures: path.join(ROOT, 'scratchpad/thumbs/fixtures'),
    goldens: path.join(ROOT, 'scratchpad/thumbs/goldens-ec75a00/graph-preview-goldens.json'),
    negative: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { if (argv[++i] == null) throw new Error(`${a} requires a value`); return argv[i]; };
    if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else if (a === '--fixtures') out.fixtures = next();
    else if (a === '--goldens') out.goldens = next();
    else if (a === '--negative-control') out.negative = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

// Runs in the page (serialized by toString). jobs: [{ doc, scope, id }]; variant 'worker' mirrors
// thumb-worker.js buildSources, 'fresh' forces a new context per job.
async function runJobs(docs, jobs, variant) {
  const stable = (v) => {
    if (v === null || v === undefined) return null;
    if (ArrayBuffer.isView(v)) return { t: v.constructor.name, d: Array.from(v) };
    if (v instanceof Map) return { map: Array.from(v.entries()).map(([k, x]) => [k, stable(x)]) };
    if (Array.isArray(v)) return v.map(stable);
    if (typeof v === 'function') return '[fn]';
    if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
    if (typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = stable(v[k]);
      return o;
    }
    return v;
  };
  const sha256 = async (s) => {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const env = await window.getMxEnv();
  const { mx, gen } = env;
  const PB = window.MtlxPreviewBuild;
  const parsedByDoc = {};
  for (const name of Object.keys(docs)) parsedByDoc[name] = await window.parseMtlxDocument(docs[name]);
  const stats = { fresh: 0, shared: 0 };
  const out = {};
  for (const job of jobs) {
    const parsed = parsedByDoc[job.doc];
    const target = { id: job.id, scope: job.scope };
    const rec = {};
    const needsFresh = PB.previewNeedsFreshContext(parsed, target, false);
    let freshCtx = null;
    let built = null;
    try {
      built = await window.mxExclusive(() => window.buildPreviewRenderable(parsed, target));
      if (!built.renderable) { rec.noRenderable = true; rec.notice = built.notice || null; } else {
        if (variant === 'fresh' || (needsFresh && !PB.previewCanShareContext(parsed, false))) freshCtx = env.createGenContext();
        if (freshCtx) stats.fresh += 1; else stats.shared += 1;
        const srcs = await window.generatePreviewSourcesWithinBudget({
          mx, gen, genContext: freshCtx || env.genContext, renderable: built.renderable, label: built.label || parsed.label,
          materialName: built.materialName || null, isMounted: () => true,
          stageLightCount: window.MtlxGenCore.PREVIEW_STAGE_LIGHT_COUNT, sceneFeatureOptions: window.MtlxGenCore.PREVIEW_FEATURE_OPTIONS, allowConstInputs: true,
        });
        if (!srcs) rec.noSources = true;
        else {
          rec.vsSha = await sha256(srcs.vs);
          rec.fsSha = await sha256(srcs.fs);
          rec.uniformsSha = await sha256(JSON.stringify(stable(srcs.introspected)));
          rec.extrasSha = await sha256(JSON.stringify(stable({ vertexInputs: srcs.vertexInputs, geomprops: srcs.geomprops, constInputs: srcs.constInputs, featureSkips: srcs.featureSkips, maxLights: srcs.maxLights })));
        }
      }
    } catch (e) {
      rec.error = String((e && e.message) || e);
    } finally {
      if (built) { try { await window.mxExclusive(() => built.cleanup()); } catch (e) { /* best-effort */ } }
      if (freshCtx) { try { freshCtx.delete(); } catch (e) { /* best-effort */ } }
    }
    out[`${job.doc}|${job.scope || '(root)'}|${job.id}`] = rec;
  }
  return { out, stats };
}

// Runs in the page: every previewable target of one document, in dump order.
async function listTargets(xml) {
  const parsed = await window.parseMtlxDocument(xml);
  const scopes = [''];
  for (const el of window.docChildren(parsed.doc)) if (window.mxElCat(el) === 'nodegraph') scopes.push(window.mxElName(el));
  const res = [];
  for (const scope of scopes) {
    try {
      const descs = await window.mxExclusive(() => window.buildScope(parsed, scope).descs);
      for (const d of descs) res.push({ scope, id: d.id });
    } catch (e) { /* scope without targets */ }
  }
  return res;
}

const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const shuffle = (arr, rand) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};

// With negative, sharing is forced everywhere: the run must then FAIL, proving the gate can see stale compounds.
async function openPage(browser, baseURL, negative) {
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(`${baseURL}/index.html#!graph`);
  await page.waitForFunction(() => ['buildPreviewRenderable', 'parseMtlxDocument', 'generatePreviewSourcesWithinBudget', 'getMxEnv', 'mxExclusive', 'buildScope']
    .every((k) => typeof window[k] === 'function') && window.MtlxPreviewBuild && window.MtlxPreviewBuild.previewCanShareContext, null, { timeout: 120000 });
  await page.evaluate(() => window.getMxEnv());
  if (negative) await page.evaluate(() => { window.MtlxPreviewBuild.previewCanShareContext = () => true; });
  return page;
}

const run = (page, docs, jobs, variant) => page.evaluate(`(${runJobs.toString()})(${JSON.stringify(docs)}, ${JSON.stringify(jobs)}, ${JSON.stringify(variant)})`);

// Mutations of the fixture text; each returns null when its anchor is missing.
const bump = (v) => String(Math.round((Number(v) + 0.37) * 1e4) / 1e4);
const MUTATIONS = [
  { name: 'rename nodegraph', doc: 'standard_surface_brick_procedural.mtlx', apply: (x) => {
    const m = /<nodegraph name="([^"]+)"/.exec(x);
    return m ? x.split(`"${m[1]}"`).join(`"${m[1]}_renamed"`) : null;
  } },
  { name: 'edit node inside nodegraph', doc: 'standard_surface_marble_solid.mtlx', apply: (x) => {
    const start = x.indexOf('<nodegraph');
    const end = x.indexOf('</nodegraph>');
    if (start < 0 || end < 0) return null;
    const body = x.slice(start, end);
    let hit = false;
    const next = body.replace(/(<input name="[^"]+" type="float" value=")([-0-9.]+)"/, (all, a, v) => { hit = true; return `${a}${bump(v)}"`; });
    return hit ? x.slice(0, start) + next + x.slice(end) : null;
  } },
  { name: 'edit local nodedef and its graph', doc: 'synth_local_nodedef.mtlx', apply: (x) => {
    let n = 0;
    const next = x.replace(/(<(?:input|nodedef)[^>]*? value=")([-0-9.]+)"/g, (all, a, v) => { n += 1; return `${a}${bump(v)}"`; });
    return n ? next : null;
  } },
  { name: 'swap node category inside nodegraph', doc: 'standard_surface_marble_solid.mtlx', apply: (x) => {
    if (!x.includes('<sin name="sin"')) return null;
    return x.replace(/<sin name="sin"/, '<cos name="sin"').replace('</sin>', '</cos>');
  } },
  { name: 'swap functional graph wiring', doc: 'synth_local_nodedef.mtlx', apply: (x) => x.replace('interfacename="fg"', 'interfacename="TMP"').replace('interfacename="bg"', 'interfacename="fg"').replace('interfacename="TMP"', 'interfacename="bg"') },
  { name: 'edit local nodedef graph body only', doc: 'synth_shadow_nodedef.mtlx', apply: (x) => {
    const start = x.indexOf('<nodegraph');
    if (start < 0) return null;
    let hit = false;
    const tail = x.slice(start).replace(/(<input name="[^"]+" type="(?:float|color3)" value=")([-0-9.,\s]+)"/, (all, a, v) => {
      hit = true; return `${a}${v.includes(',') ? v.split(',').map((p) => bump(p)).join(', ') : bump(v)}"`;
    });
    return hit ? x.slice(0, start) + tail : null;
  } },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const goldens = JSON.parse(fs.readFileSync(args.goldens, 'utf8')).fixtures;
  const files = fs.readdirSync(args.fixtures).filter((f) => f.endsWith('.mtlx')).sort();
  const docs = {};
  for (const f of files) docs[f] = fs.readFileSync(path.join(args.fixtures, f), 'utf8');

  const server = await startServer({ root: ROOT });
  const browser = await chromium.launch({ headless: false, args: ['--headless=new', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
  let failures = 0;
  const report = (label, ok, extra) => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); };
  const compare = (got, want, keys) => {
    const bad = [];
    for (const k of keys) {
      const g = got[k] || {}; const w = want[k] || {};
      for (const f of ['vsSha', 'fsSha', 'uniformsSha', 'extrasSha']) {
        if (g[f] !== w[f]) { bad.push(`${k}.${f}`); break; }
      }
      if (!!g.noRenderable !== !!w.noRenderable || !!g.error !== !!w.error) bad.push(`${k}.status`);
    }
    return bad;
  };
  try {
    // Target lists and golden table keyed like runJobs output.
    const page0 = await openPage(browser, server.baseURL, args.negative);
    const jobs = [];
    for (const f of files) for (const t of await page0.evaluate(`(${listTargets.toString()})(${JSON.stringify(docs[f])})`)) jobs.push({ doc: f, scope: t.scope, id: t.id });
    await page0.context().close();
    const want = {};
    for (const f of files) {
      for (const [k, v] of Object.entries(goldens[f].targets)) want[`${f}|${k}`] = v;
    }
    const keys = jobs.map((j) => `${j.doc}|${j.scope || '(root)'}|${j.id}`);
    const missing = keys.filter((k) => !want[k]);
    console.log(`targets=${jobs.length} goldens=${Object.keys(want).length} unmatched=${missing.length}`);
    if (missing.length) { report('target list matches goldens', false, missing.slice(0, 3).join(',')); }

    const scoped = jobs.filter((j) => j.scope);
    const rand = rng(12345);
    const byScope = new Map();
    for (const j of jobs) { const k = `${j.doc}|${j.scope}`; if (!byScope.has(k)) byScope.set(k, []); byScope.get(k).push(j); }
    const interleaved = [];
    for (let i = 0; ; i += 1) {
      let any = false;
      for (const list of byScope.values()) if (list[i]) { interleaved.push(list[i]); any = true; }
      if (!any) break;
    }
    const orders = [
      ['fixture order', jobs],
      ['reversed', jobs.slice().reverse()],
      ['shuffled seed 1', shuffle(jobs, rng(1))],
      ['shuffled seed 2', shuffle(jobs, rng(2))],
      ['scope-interleaved', interleaved],
      ['scoped first, then root', scoped.concat(jobs.filter((j) => !j.scope))],
      ['two passes', jobs.concat(shuffle(jobs, rand))],
    ];
    for (const [label, order] of orders) {
      const page = await openPage(browser, server.baseURL, args.negative);
      const res = await run(page, docs, order, 'worker');
      const bad = compare(res.out, want, keys.filter((k) => res.out[k]));
      report(`${label} (${order.length} jobs, shared=${res.stats.shared} fresh=${res.stats.fresh}) vs goldens`, bad.length === 0, bad.slice(0, 4).join(' '));
      await page.context().close();
    }

    // Mutations: shared-context worker flow after warming on the original docs vs all-fresh on the mutated doc.
    const page = await openPage(browser, server.baseURL, args.negative);
    await run(page, docs, shuffle(jobs, rng(7)), 'worker');
    for (const mut of MUTATIONS) {
      const x = mut.apply(docs[mut.doc]);
      if (!x) { report(`mutation: ${mut.name}`, false, 'anchor missing'); continue; }
      const mdocs = { [mut.doc]: x };
      const mjobs = (await page.evaluate(`(${listTargets.toString()})(${JSON.stringify(x)})`)).map((t) => ({ doc: mut.doc, scope: t.scope, id: t.id }));
      const shuffled = shuffle(mjobs, rng(99));
      const fresh = await run(page, mdocs, mjobs, 'fresh');
      const worker1 = await run(page, mdocs, shuffled, 'worker');
      // Original doc again, then the mutated one, then the original once more on the same shared context.
      const back = await run(page, { [mut.doc]: docs[mut.doc] }, jobs.filter((j) => j.doc === mut.doc), 'worker');
      const worker2 = await run(page, mdocs, mjobs, 'worker');
      const k1 = mjobs.map((j) => `${j.doc}|${j.scope || '(root)'}|${j.id}`);
      const bad1 = compare(worker1.out, fresh.out, k1);
      const bad2 = compare(worker2.out, fresh.out, k1);
      const kb = jobs.filter((j) => j.doc === mut.doc).map((j) => `${j.doc}|${j.scope || '(root)'}|${j.id}`);
      const bad3 = compare(back.out, want, kb);
      const changed = k1.filter((k) => fresh.out[k] && want[k] && (fresh.out[k].fsSha !== want[k].fsSha || fresh.out[k].uniformsSha !== want[k].uniformsSha)).length;
      report(`mutation: ${mut.name} (${mjobs.length} jobs, ${changed} outputs changed, shared=${worker1.stats.shared})`, bad1.length + bad2.length + bad3.length === 0,
        [...bad1.map((b) => 'w1:' + b), ...bad2.map((b) => 'w2:' + b), ...bad3.map((b) => 'back:' + b)].slice(0, 4).join(' '));
    }
    await page.context().close();
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
  console.log(failures ? `FAILED (${failures})` : 'ALL IDENTICAL');
  process.exit(args.negative ? (failures ? 0 : 1) : (failures ? 1 : 0));
}

main().catch((e) => { console.error(e); process.exit(1); });
