#!/usr/bin/env node
/* Dumps the final vs/fs pair exactly as submitted to WebGL for one material
   subject, with no engine edits: an init script wraps
   WebGL2RenderingContext.prototype.shaderSource and records every call.
   The largest fragment shader plus the vertex shader attached to the same
   program is written to <out>/<label>.vert|.frag. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startServer } from '../embed/lib/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const HELP = `Usage: node tests/perf/dump-shaders.mjs --subject <folder> --out <dir> [--label name] [--set k=v]...`;

function parseArgs(argv) {
  const out = { subject: null, out: null, label: null, settings: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { if (argv[++i] == null) throw new Error(`${a} requires a value`); return argv[i]; };
    if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else if (a === '--subject') out.subject = next();
    else if (a === '--out') out.out = next();
    else if (a === '--label') out.label = next();
    else if (a === '--set') { const p = next(); const eq = p.indexOf('='); out.settings[p.slice(0, eq)] = p.slice(eq + 1); }
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!out.subject) throw new Error('--subject is required');
  if (!out.out) throw new Error('--out is required');
  if (!out.label) out.label = path.basename(path.resolve(out.subject));
  return out;
}

const RECORDER = () => {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });
  const subject = path.resolve(args.subject);
  const server = await startServer({ root: ROOT });
  const browser = await chromium.launch({
    headless: false,
    args: ['--headless=new', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-gpu-shader-disk-cache'],
  });
  try {
    const context = await browser.newContext();
    await context.addInitScript((kv) => {
      try { for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); } catch (e) { /* ignore */ }
    }, { mtlxPerfLog: '1', ...args.settings });
    await context.addInitScript(RECORDER);
    const page = await context.newPage();
    await page.goto(`${server.baseURL}/index.html#!viewer`);
    const dirInput = page.locator('input[type=file][webkitdirectory]').first();
    await dirInput.waitFor({ state: 'attached', timeout: 60000 });
    await dirInput.setInputFiles(subject);
    await page.waitForEvent('console', {
      predicate: (msg) => /^\[mtlx-perf\] (createMtlxRenderView total|applyMaterial total):/.test(msg.text()),
      timeout: 300000,
    });
    await page.waitForTimeout(1500);

    const picked = await page.evaluate(() => {
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
      return {
        frag: best.source,
        vert: vert ? vert.source : null,
        counts: { shaders: store.shaders.length, programs: new Set(store.programs.map((p) => p.program)).size },
      };
    });
    if (!picked) throw new Error('no shaders recorded');
    fs.writeFileSync(path.join(outDir, `${args.label}.frag`), picked.frag);
    if (picked.vert) fs.writeFileSync(path.join(outDir, `${args.label}.vert`), picked.vert);
    console.log(`${args.label}  fragBytes=${picked.frag.length}  vertBytes=${picked.vert ? picked.vert.length : 0}  shaders=${picked.counts.shaders}  programs=${picked.counts.programs}`);
    console.log(`out: ${outDir}`);
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

main();
