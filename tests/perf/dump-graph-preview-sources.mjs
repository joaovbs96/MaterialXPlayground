#!/usr/bin/env node
/* Byte-identity goldens for Graph Editor preview shader generation: for every
   previewable target of each fixture it runs the page's own parse, preview
   builder and budgeted generator, then hashes vs, fs and the uniform set.
   Output: <out>/graph-preview-goldens.json (rerunnable, deterministic). */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startServer } from '../embed/lib/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELP = 'Usage: node tests/perf/dump-graph-preview-sources.mjs --out <dir> [--fixtures <dir>]';
const FULL_TEXT_TARGETS = 3;

function parseArgs(argv) {
  const out = { out: null, fixtures: path.join(ROOT, 'scratchpad/thumbs/fixtures') };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { if (argv[++i] == null) throw new Error(`${a} requires a value`); return argv[i]; };
    if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else if (a === '--out') out.out = next();
    else if (a === '--fixtures') out.fixtures = next();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!out.out) throw new Error('--out is required');
  return out;
}

// Runs in the page (serialized by toString): one record per target of one fixture.
async function dumpFixture(xml) {
  const need = ['buildPreviewRenderable', 'parseMtlxDocument', 'generatePreviewSourcesWithinBudget', 'getMxEnv', 'mxExclusive', 'buildScope', 'docChildren', 'mxElName', 'mxElCat'];
  const missing = need.filter((k) => typeof window[k] !== 'function');
  if (missing.length) throw new Error('missing page globals: ' + missing.join(','));
  const stageLightCount = typeof PREVIEW_STAGE_LIGHT_COUNT !== 'undefined' ? PREVIEW_STAGE_LIGHT_COUNT : window.PREVIEW_STAGE_LIGHT_COUNT;
  const featureOptions = typeof PREVIEW_FEATURE_OPTIONS !== 'undefined' ? PREVIEW_FEATURE_OPTIONS : window.PREVIEW_FEATURE_OPTIONS;
  if (stageLightCount === undefined || !featureOptions) throw new Error('PREVIEW_* constants not reachable');

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

  const parsed = await window.parseMtlxDocument(xml);
  const env = await window.getMxEnv();
  const { mx, gen } = env;
  const compoundRoot = (() => { try { return !!window.MtlxRenderSettings.get('graphCompoundCompile', { surface: 'graph' }); } catch (e) { return false; } })();

  const scopes = [''];
  for (const el of window.docChildren(parsed.doc)) if (window.mxElCat(el) === 'nodegraph') scopes.push(window.mxElName(el));

  const records = [];
  for (const scope of scopes) {
    let descs;
    try { descs = await window.mxExclusive(() => window.buildScope(parsed, scope).descs); }
    catch (e) { records.push({ scope, id: '(scope)', error: String((e && e.message) || e) }); continue; }
    for (const d of descs) {
      const target = { id: d.id, scope };
      const rec = { scope, id: d.id };
      const needsFreshCtx = !!(parsed.hasDefinitions || scope || compoundRoot);
      const freshCtx = (needsFreshCtx && typeof env.createGenContext === 'function') ? env.createGenContext() : null;
      const genContext = freshCtx || env.genContext;
      let built = null;
      try {
        built = await window.mxExclusive(() => window.buildPreviewRenderable(parsed, target));
        if (!built.renderable) {
          rec.noRenderable = true;
          rec.notice = built.notice || null;
        } else {
          rec.defaultGeom = built.defaultGeom || null;
          rec.label = built.label || null;
          const srcs = await window.generatePreviewSourcesWithinBudget({
            mx, gen, genContext, renderable: built.renderable, label: built.label || parsed.label,
            materialName: built.materialName || null, isMounted: () => true,
            stageLightCount, sceneFeatureOptions: featureOptions, allowConstInputs: true,
          });
          if (!srcs) { rec.noSources = true; }
          else {
            rec.vsSha = await sha256(srcs.vs);
            rec.fsSha = await sha256(srcs.fs);
            rec.vsLen = String(srcs.vs).length;
            rec.fsLen = String(srcs.fs).length;
            rec.uniformsSha = await sha256(JSON.stringify(stable(srcs.introspected)));
            rec.transparent = !!srcs.transparent;
            rec.extrasSha = await sha256(JSON.stringify(stable({ vertexInputs: srcs.vertexInputs, geomprops: srcs.geomprops, constInputs: srcs.constInputs, featureSkips: srcs.featureSkips, maxLights: srcs.maxLights })));
            rec.notices = stable(srcs.notices) || [];
            rec.samplerBudget = stable(srcs.samplerBudget) || null;
            rec._vs = srcs.vs; rec._fs = srcs.fs;
          }
        }
      } catch (e) {
        rec.error = String((e && e.message) || e);
      } finally {
        if (built) { try { await window.mxExclusive(() => built.cleanup()); } catch (e) { /* best-effort */ } }
        if (freshCtx) { try { freshCtx.delete(); } catch (e) { /* best-effort */ } }
      }
      records.push(rec);
    }
  }
  return records;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });
  const fixDir = path.resolve(args.fixtures);
  const files = fs.readdirSync(fixDir).filter((f) => f.endsWith('.mtlx')).sort();
  if (!files.length) throw new Error(`no .mtlx fixtures in ${fixDir}`);

  const server = await startServer({ root: ROOT });
  const browser = await chromium.launch({ headless: true });
  const result = { fixtures: {} };
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('[pageerror]', e.message));
    await page.goto(`${server.baseURL}/index.html#!graph`);
    await page.waitForFunction(() => ['buildPreviewRenderable', 'parseMtlxDocument', 'generatePreviewSourcesWithinBudget', 'getMxEnv', 'mxExclusive', 'buildScope']
      .every((k) => typeof window[k] === 'function'), null, { timeout: 120000 });
    await page.evaluate(() => window.getMxEnv());

    for (const f of files) {
      const xml = fs.readFileSync(path.join(fixDir, f), 'utf8');
      const records = await page.evaluate(`(${dumpFixture.toString()})(${JSON.stringify(xml)})`);
      let withText = 0;
      const targets = {};
      let ok = 0; let noRenderable = 0; let errors = 0;
      for (const r of records) {
        const key = `${r.scope || '(root)'}|${r.id}`;
        const vs = r._vs; const fsrc = r._fs;
        delete r._vs; delete r._fs;
        if (r.vsSha) ok += 1; else if (r.error) errors += 1; else noRenderable += 1;
        if (vs && withText < FULL_TEXT_TARGETS) {
          const base = `${f.replace(/\.mtlx$/, '')}.${String(withText).padStart(2, '0')}`;
          fs.mkdirSync(path.join(outDir, 'text'), { recursive: true });
          fs.writeFileSync(path.join(outDir, 'text', `${base}.vert`), vs);
          fs.writeFileSync(path.join(outDir, 'text', `${base}.frag`), fsrc);
          r.textFile = base;
          withText += 1;
        }
        const sorted = {};
        for (const k of Object.keys(r).sort()) sorted[k] = r[k];
        targets[key] = sorted;
      }
      const sortedTargets = {};
      for (const k of Object.keys(targets).sort()) sortedTargets[k] = targets[k];
      result.fixtures[f] = { targetCount: records.length, renderables: ok, noRenderable, errors, targets: sortedTargets };
      console.log(`${f}  targets=${records.length}  renderables=${ok}  noRenderable=${noRenderable}  errors=${errors}`);
    }
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
  fs.writeFileSync(path.join(outDir, 'graph-preview-goldens.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`out: ${path.join(outDir, 'graph-preview-goldens.json')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
