#!/usr/bin/env node
/* Times compile+link of one vs/fs pair on a fresh Chromium per sample, until
   KHR_parallel_shader_compile reports completion. Prints one line:
   label median min max ok. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, 'link-time.html');

const HELP = `Usage: node tests/perf/link-time.mjs --vs <file> --fs <file> [--samples N] [--backend d3d11|gl|vulkan|swiftshader] [--label name] [--json]`;

function parseArgs(argv) {
  const out = { vs: null, fs: null, samples: 3, backend: 'd3d11', label: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => { if (argv[++i] == null) throw new Error(`${a} requires a value`); return argv[i]; };
    if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    else if (a === '--vs') out.vs = next();
    else if (a === '--fs') out.fs = next();
    else if (a === '--samples') out.samples = Number(next());
    else if (a === '--backend') out.backend = next();
    else if (a === '--label') out.label = next();
    else if (a === '--json') out.json = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!out.vs || !out.fs) throw new Error('--vs and --fs are required');
  if (!out.label) out.label = path.basename(out.fs);
  return out;
}

function backendArgs(backend) {
  const base = ['--headless=new', '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-gpu-shader-disk-cache'];
  if (backend === 'swiftshader') return [...base, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  return [...base, `--use-angle=${backend}`];
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function sample(vsSource, fsSource, backend) {
  const browser = await chromium.launch({ headless: false, args: backendArgs(backend) });
  try {
    const page = await browser.newPage();
    await page.goto('file:///' + PAGE.replace(/\\/g, '/'));
    return await page.evaluate(([v, f]) => window.__linkTime(v, f), [vsSource, fsSource]);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); console.error(HELP); process.exitCode = 2; return; }
  const vsSource = fs.readFileSync(path.resolve(args.vs), 'utf8');
  const fsSource = fs.readFileSync(path.resolve(args.fs), 'utf8');
  const times = [];
  let ok = true;
  let info = '';
  for (let i = 0; i < args.samples; i += 1) {
    const r = await sample(vsSource, fsSource, args.backend);
    if (!r || r.error) { console.log(`${args.label} ERROR ${r && r.error}`); process.exitCode = 1; return; }
    times.push(r.ms);
    if (!r.ok) { ok = false; info = r.info; }
  }
  const row = { label: args.label, median: Math.round(median(times)), min: Math.round(Math.min(...times)), max: Math.round(Math.max(...times)), ok };
  if (args.json) console.log(JSON.stringify({ ...row, times }));
  else console.log(`${row.label} ${row.median} ${row.min} ${row.max} ${ok ? 'ok' : 'FAIL'}`);
  if (!ok) console.error(info);
}

main();
