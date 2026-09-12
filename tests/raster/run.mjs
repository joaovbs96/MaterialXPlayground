#!/usr/bin/env node
/* Portable Node/Playwright raster runner for repository fixtures. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../embed/lib/server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_OUT = path.join('render-results', 'raster-run');
const HELP = `Usage: node tests/raster/run.mjs [options]

  --out <dir>                 Output directory (default: render-results/raster-run)
  --fixtures <list>           emission,glass,color,shadow,transmission-thin,transmission-solid
  --checks <list>             emission,renderContract,glass,color,lifecycle,thin-wall,solid-transmission
  --backend <d3d11|swiftshader>  Browser rendering backend (default: d3d11)
  --chromium <path>           Chromium executable override
  --viewport <WxH>            Browser viewport (default: 680x460)
  --options <json>             Fixture options merged into each create call
  --dump-shaders              Save generated shaders and scalar uniforms
  --trace                     Log renderer pass boundaries
  --help                      Show this help
`;

function parse(argv) {
  const out = { out: DEFAULT_OUT, fixtures: ['emission', 'glass', 'color'], checks: [], backend: 'd3d11', viewport: [680, 460], options: {}, dumpShaders: false, trace: false };
  let fixturesSpecified = false, checksSpecified = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { console.log(HELP); process.exit(0); }
    if (a === '--out') { if (argv[++i] == null) throw new Error('--out requires a value'); out.out = argv[i]; }
    else if (a === '--fixtures') { fixturesSpecified = true; if (argv[++i] == null) throw new Error('--fixtures requires a value'); out.fixtures = argv[i].split(',').map(s => s.trim()).filter(Boolean); }
    else if (a === '--checks') { checksSpecified = true; if (argv[++i] == null) throw new Error('--checks requires a value'); out.checks = argv[i].split(',').map(s => s.trim()).filter(Boolean); }
    else if (a === '--backend') { if (argv[++i] == null) throw new Error('--backend requires a value'); out.backend = argv[i]; }
    else if (a === '--chromium') { if (argv[++i] == null) throw new Error('--chromium requires a value'); out.chromium = argv[i]; }
    else if (a === '--viewport') { if (argv[++i] == null) throw new Error('--viewport requires a value'); out.viewport = argv[i].split('x').map(Number); }
    else if (a === '--options') { if (argv[++i] == null) throw new Error('--options requires a value'); out.options = JSON.parse(argv[i]); }
    else if (a === '--dump-shaders') out.dumpShaders = true;
    else if (a === '--trace') out.trace = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!['d3d11', 'swiftshader'].includes(out.backend)) throw new Error('--backend must be d3d11 or swiftshader');
  if (out.viewport.length !== 2 || out.viewport.some(v => !Number.isInteger(v) || v < 64)) throw new Error('--viewport must be WxH');
  const validFixtures = new Set(['emission', 'glass', 'color', 'shadow', 'transmission-thin', 'transmission-solid']);
  const validChecks = new Set(['emission', 'renderContract', 'glass', 'color', 'lifecycle', 'thin-wall', 'solid-transmission']);
  if (fixturesSpecified && !out.fixtures.length) throw new Error('--fixtures cannot be empty');
  if (checksSpecified && !out.checks.length) throw new Error('--checks cannot be empty');
  if (!out.options || typeof out.options !== 'object' || Array.isArray(out.options)) throw new Error('--options must be a JSON object');
  for (const fixture of out.fixtures) if (!validFixtures.has(fixture)) throw new Error(`Unknown fixture: ${fixture}`);
  for (const check of out.checks) if (!validChecks.has(check)) throw new Error(`Unknown check: ${check}`);
  if (!out.checks.length) {
    out.checks = [...new Set(out.fixtures.flatMap(fixture => {
      const spec = fixtureSpec(fixture, {});
      return [spec.check, ...(spec.kind === 'emission' ? ['renderContract'] : [])];
    }).filter(check => check !== 'shadow'))];
  }
  const available = new Set(out.fixtures.flatMap(fixture => { const spec = fixtureSpec(fixture, {}); return [spec.check, ...(spec.kind === 'emission' || spec.kind === 'glass' ? ['renderContract', 'lifecycle'] : [])]; }));
  for (const check of out.checks) if (!available.has(check)) throw new Error(`Check '${check}' has no selected compatible fixture`);
  return out;
}

function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function sourceHashes() {
  return Object.fromEntries(['js/mtlx-engine.js', 'embed/gen/mtlx-engine.js', 'js/usd-scene-renderer.js', 'js/usd-scene-post.js', 'tests/raster/harness.html', 'tests/raster/harness.js', 'tests/raster/hdr-regressions.js', 'tests/raster/transmission-regressions.js', 'tests/raster/run.mjs'].filter(p => fs.existsSync(path.join(ROOT, p))).map(p => [p, sha256(path.join(ROOT, p))]));
}
function fixtureSpec(name, options) {
  if (name === 'transmission-thin') return { kind: 'transmission', options: { ...options, thin: true }, check: 'thin-wall' };
  if (name === 'transmission-solid') return { kind: 'transmission', options: { ...options, thin: false, solidGeometry: true }, check: 'solid-transmission' };
  if (!['emission', 'glass', 'color', 'shadow'].includes(name)) throw new Error(`Unknown fixture: ${name}`);
  return { kind: name, options, check: name };
}
function backendArgs(backend) { return backend === 'swiftshader' ? ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] : ['--headless=new', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']; }

async function main() {
  let args;
  try { args = parse(process.argv.slice(2)); } catch (e) { console.error(`Argument error: ${e.message}`); console.error(HELP); process.exitCode = 2; return; }
  const out = path.resolve(ROOT, args.out); fs.mkdirSync(out, { recursive: true });
  const sourceHashesBefore = sourceHashes();
  const report = { schemaVersion: 1, command: process.argv.slice(2), args, sourceHashesBefore, startedAt: new Date().toISOString(), fixtures: [], errors: [], console: [] };
  let server, browser;
  try {
    server = await startServer({ root: ROOT });
    const launch = { headless: false, args: backendArgs(args.backend) };
    if (args.chromium) launch.executablePath = path.resolve(args.chromium);
    browser = await chromium.launch(launch);
    const page = await browser.newPage({ viewport: { width: args.viewport[0], height: args.viewport[1] } });
    page.on('pageerror', e => report.errors.push({ type: 'pageerror', text: String(e?.stack || e) }));
    page.on('console', msg => report.console.push({ type: msg.type(), text: msg.text() }));
    await page.goto(`${server.baseURL}/tests/raster/harness.html`);
    await page.waitForFunction('window.__rasterReady || window.__bootError', null, { timeout: 120000 });
    const bootError = await page.evaluate('window.__bootError || null');
    if (bootError) throw new Error(bootError);
    if (args.trace) await page.evaluate(`() => { const O=THREE.WebGLRenderer; THREE.WebGLRenderer=function(...a){const r=new O(...a); for(const n of ['render','readRenderTargetPixels']){const f=r[n].bind(r);r[n]=(...x)=>{console.log('GL-BEGIN',n);try{return f(...x)}finally{console.log('GL-END',n)}}} return r}; THREE.WebGLRenderer.prototype=O.prototype }`);
    await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, 'tests/raster/hdr-regressions.js'), 'utf8') });
    await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT, 'tests/raster/transmission-regressions.js'), 'utf8') });
    for (const name of args.fixtures) {
      const spec = fixtureSpec(name, args.options); const entry = { name, kind: spec.kind, startedAt: new Date().toISOString() };
      try {
        entry.created = await page.evaluate(({ kind, options }) => RasterHarness.create(kind, options), spec);
        entry.pixels = await page.evaluate('RasterHarness.targetPixels()');
        if (!entry.created?.materials || !entry.created?.programs?.every(p => p.runnable) || entry.created?.glError !== 0) throw new Error('fixture create invariant failed: compiled materials/programs/GL');
        if (!entry.pixels?.same || entry.pixels.glError !== 0 || !(entry.pixels.max - entry.pixels.min > 10) || !(entry.pixels.nonZero > 0)) throw new Error('fixture target invariant failed: target/GL/spatial content');
        const snapshot = await page.evaluate('__fixture.handle.snapshot()');
        if (snapshot?.startsWith('data:image/png;base64,')) {
          const file = path.join(out, `${name}.png`);
          fs.writeFileSync(file, Buffer.from(snapshot.split(',', 2)[1], 'base64'));
          entry.snapshotPath = file;
        } else { entry.snapshotError = 'fixture snapshot was not a PNG data URL'; throw new Error(entry.snapshotError); }
        if (args.dumpShaders) {
          entry.shaders = await page.evaluate(`() => __fixture.handle.__debug().materials.filter(m=>m.userData?.mtlxSceneCompiled).map(m=>({path:m.userData.mtlxSceneMaterialPath,fs:m.fragmentShader,vs:m.vertexShader,uniforms:Object.fromEntries(Object.entries(m.uniforms||{}).filter(([k,u])=>typeof u.value==='number'||typeof u.value==='boolean').map(([k,u])=>[k,u.value]))}))`);
          fs.writeFileSync(path.join(out, `${name}-shaders.json`), JSON.stringify(entry.shaders, null, 2));
        }
        const requested = new Set(args.checks);
        if (requested.has('emission') && spec.kind === 'emission') entry.emission = await page.evaluate('HDRRegression.emission()');
        if (requested.has('renderContract') && (spec.kind === 'emission' || spec.kind === 'glass')) entry.renderContract = await page.evaluate('HDRRegression.renderContract()');
        if (requested.has('lifecycle') && (spec.kind === 'emission' || spec.kind === 'glass')) entry.lifecycle = await page.evaluate('HDRRegression.lifecycle()');
        if (requested.has('glass') && spec.kind === 'glass') entry.glass = await page.evaluate('HDRRegression.glass()');
        if (requested.has('color') && spec.kind === 'color') entry.color = await page.evaluate('HDRRegression.color()');
        if (requested.has(spec.check) && (spec.check === 'thin-wall' || spec.check === 'solid-transmission')) entry.transmission = await page.evaluate('TransmissionRegression.run()');
        entry.finalRenderer = await page.evaluate('RasterHarness.info()');
        if (entry.finalRenderer?.glError !== 0 || !entry.finalRenderer?.programs?.every(p => p.runnable) || !(entry.finalRenderer?.materials > 0)) throw new Error('final renderer invariant failed');
        const expected = [...requested].filter(check => check === spec.check || (['renderContract', 'lifecycle'].includes(check) && (spec.kind === 'emission' || spec.kind === 'glass')));
        const executed = expected.filter(check => Object.hasOwn(entry, check === 'thin-wall' || check === 'solid-transmission' ? 'transmission' : check));
        if (executed.length !== expected.length) throw new Error(`requested check did not execute: ${expected.filter(check => !executed.includes(check)).join(',')}`);
        entry.finishedAt = new Date().toISOString(); report.fixtures.push(entry);
      } catch (e) { entry.error = String(e?.stack || e); entry.finishedAt = new Date().toISOString(); report.fixtures.push(entry); report.errors.push({ fixture: name, text: entry.error }); }
      fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
    }
    report.backend = await page.evaluate(() => RasterHarness.info()?.renderer || null);
    report.shaderDiagnostics = report.console.filter(item => ['error', 'warning'].includes(item.type) && /THREE\.WebGLProgram:\s*shader error|(?:gl\.)?VALIDATE_STATUS\s*(?:[=:]\s*)?false|(?:shader|program)\s+(?:compil(?:e|ation)|link)\s+(?:failed|failure)|ERROR:\s*\d+:\d+|WebGL\s+INVALID_/i.test(item.text));
    report.sourceHashesAfter = sourceHashes();
    report.sourceMutation = JSON.stringify(report.sourceHashesBefore) !== JSON.stringify(report.sourceHashesAfter);
    if (report.sourceMutation) report.errors.push({ type: 'source-mutation', text: 'Source hashes changed during run' });
    if (report.shaderDiagnostics.length) report.errors.push({ type: 'shader-diagnostic', entries: report.shaderDiagnostics });
    report.status = report.errors.length ? 'failed' : 'passed';
  } catch (e) { report.status = 'failed'; report.failure = String(e?.stack || e); report.errors.push({ type: 'runner', text: report.failure }); }
  finally { report.sourceHashesAfter ??= sourceHashes(); report.sourceMutation = JSON.stringify(report.sourceHashesBefore) !== JSON.stringify(report.sourceHashesAfter); report.finishedAt = new Date().toISOString(); fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2)); if (browser) await browser.close().catch(() => {}); if (server) await server.close().catch(() => {}); }
  if (report.status !== 'passed') process.exitCode = 1;
}
main();
