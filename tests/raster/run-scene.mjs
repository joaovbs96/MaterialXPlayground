#!/usr/bin/env node
/* Reusable full-folder USD scene capture runner. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { startServer } from '../embed/lib/server.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELP = `Usage: node tests/raster/run-scene.mjs --asset-root <dir> --stage <relative-path> --cameras <comma-names|first> --out <dir> [--backend d3d11|swiftshader] [--viewport WxH] [--chromium <path>]`;
const productSources = ['js/mtlx-engine.js', 'embed/gen/mtlx-engine.js', 'index.html', 'js/usd/usd-stage-loader.js', 'js/usd/usd-stage-worker.js', 'js/usd-scene-app.jsx', 'js/usd-scene-renderer.js', 'js/usd-scene-post.js', 'tests/embed/lib/server.mjs', 'tests/raster/run-scene.mjs'];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceHashes = () => Object.fromEntries(productSources.filter(p => fs.existsSync(path.join(ROOT, p))).map(p => [p, hash(path.join(ROOT, p))]));
function parse(argv) {
  const a = {
    backend: 'd3d11',
    viewport: [1280, 900]
  };
  const need = name => {
    const v = argv[i++];
    if (!v) throw new Error(`${name} requires a value`);
    return v;
  };
  let i = 0;
  while (i < argv.length) {
    const k = argv[i++];
    if (k === '--asset-root') a.assetRoot = need(k);else if (k === '--stage') a.stage = need(k);else if (k === '--cameras') a.cameras = need(k).split(',').map(x => x.trim()).filter(Boolean);else if (k === '--out') a.out = need(k);else if (k === '--backend') a.backend = need(k);else if (k === '--viewport') a.viewport = need(k).split('x').map(Number);else if (k === '--chromium') a.chromium = need(k);else if (k === '--help' || k === '-h') {
      console.log(HELP);
      process.exit(0);
    } else throw new Error(`Unknown argument: ${k}`);
  }
  if (!a.assetRoot || !a.stage || !a.cameras?.length || !a.out) throw new Error('--asset-root, --stage, --cameras, and --out are required');
  if (!['d3d11', 'swiftshader'].includes(a.backend)) throw new Error('--backend must be d3d11 or swiftshader');
  if (a.viewport.length !== 2 || a.viewport.some(v => !Number.isInteger(v) || v < 64)) throw new Error('--viewport must be WxH');
  return a;
}
function preflight(root, stage) {
  const real = fs.realpathSync(root);
  if (real !== root) throw new Error(`asset root is a symlink/reparse path: ${root}`);
  const files = [];
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, {
      withFileTypes: true
    })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink/reparse entry is forbidden: ${full}`);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) throw new Error(`dot directory is forbidden: ${full}`);
        pending.push(full);
      } else if (entry.isFile()) files.push(full);
    }
  }
  const entry = path.resolve(root, stage);
  if (!entry.startsWith(root + path.sep) || !fs.existsSync(entry) || !fs.statSync(entry).isFile()) throw new Error('stage must resolve to an existing file within asset root');
  const assetRef = /@([^@]+)@/g;
  const escaped = [];
  for (const file of files) {
    if (!/\.(usd[ac]?|usda|usdc|mtlx)$/i.test(file)) continue;
    const text = fs.readFileSync(file);
    if (text.includes(0)) continue;
    for (const match of text.toString('utf8').matchAll(assetRef)) {
      const ref = match[1].replaceAll('\\', '/');
      if (/^(?:[A-Za-z]:|\\\\|https?:)/.test(ref)) escaped.push({
        file,
        ref
      });else if (!path.resolve(path.dirname(file), ref).startsWith(root + path.sep)) escaped.push({
        file,
        ref
      });
    }
  }
  if (escaped.length) throw new Error(`USD resource escapes asset root: ${JSON.stringify(escaped[0])}`);
  return {
    realRoot: real,
    files: files.length,
    bytes: files.reduce((n, f) => n + fs.statSync(f).size, 0),
    usdStageFiles: files.filter(file => /\.usd[ac]?$|\.usda$|\.usdc$/i.test(file)).length,
    stage: entry,
    escapedRefs: escaped
  };
}
const backendArgs = b => b === 'swiftshader' ? ['--headless=new', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] : ['--headless=new', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'];
async function main() {
  let args;
  try {
    args = parse(process.argv.slice(2));
  } catch (e) {
    console.error(`Argument error: ${e.message}`);
    console.error(HELP);
    process.exitCode = 2;
    return;
  }
  const root = path.resolve(args.assetRoot);
  const out = path.resolve(ROOT, args.out);
  if (out === root || out.startsWith(root + path.sep)) throw new Error('--out must be outside the read-only asset root');
  const report = {
    schemaVersion: 1,
    command: process.argv.slice(2),
    args,
    gitHead: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8'
    }).trim(),
    sourceHashesBefore: sourceHashes(),
    startedAt: new Date().toISOString(),
    errors: [],
    cameras: []
  };
  const save = () => {
    fs.mkdirSync(out, {
      recursive: true
    });
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  };
  try {
    report.preflight = preflight(root, args.stage);
    fs.mkdirSync(out, {
      recursive: true
    });
    let server, browser;
    try {
      server = await startServer({
        root: ROOT
      });
      const launch = {
        headless: false,
        args: backendArgs(args.backend)
      };
      if (args.chromium) launch.executablePath = path.resolve(args.chromium);
      browser = await chromium.launch(launch);
      const page = await browser.newPage({
        viewport: {
          width: args.viewport[0],
          height: args.viewport[1]
        }
      });
      page.on('pageerror', e => report.errors.push({
        type: 'pageerror',
        text: String(e?.stack || e)
      }));
      page.on('console', msg => {
        const item = {
          type: msg.type(),
          text: msg.text()
        };
        (report.console ??= []).push(item);
      });
      page.on('requestfailed', r => report.errors.push({
        type: 'requestfailed',
        url: r.url(),
        text: r.failure()?.errorText || 'request failed'
      }));
      page.on('response', r => {
        if (r.status() >= 400) report.errors.push({
          type: 'http',
          status: r.status(),
          url: r.url()
        });
      });
      await page.goto(`${server.baseURL}/index.html#!scene`);
      await page.getByTestId('usd-scene-viewer').waitFor({
        state: 'visible',
        timeout: 120000
      });
      report.initialBrowser = await page.evaluate(() => ({
        viewport: {
          innerWidth,
          innerHeight
        },
        devicePixelRatio,
        localStorage: Object.fromEntries(Object.keys(localStorage).filter(k => k.startsWith('mtlx_scene_')).map(k => [k, localStorage.getItem(k)]))
      }));
      save();
      await page.locator('input[type=file][webkitdirectory]').setInputFiles(root);
      const stageRelative = path.relative(root, report.preflight.stage).replaceAll('\\', '/');
      const select = page.getByTestId('usd-scene-root-select');
      await select.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      const selectorCount = await select.count();
      if (selectorCount === 0) {
        if (report.preflight.usdStageFiles !== 1) throw new Error('root selector absent and asset inventory does not contain exactly one USD stage');
      } else {
        await select.waitFor({
          state: 'visible',
          timeout: 120000
        });
        await select.getByRole('combobox').click();
      }
      const candidates = selectorCount === 0 ? [] : await page.getByRole('option').evaluateAll(elements => elements.map(element => ({
        text: element.textContent?.trim() || '',
        title: (element.getAttribute('title') || '').split('\n', 1)[0],
        value: element.getAttribute('value') || ''
      })));
      const matches = candidates.filter(candidate => candidate.title === stageRelative || candidate.title.endsWith('/' + stageRelative) || candidate.value === stageRelative);
      if (selectorCount !== 0) {
        if (matches.length !== 1) throw new Error(`stage root selection expected one full-path match for ${stageRelative}, got ${matches.length}`);
        await page.getByRole('option', { name: matches[0].text, exact: true }).click();
      }
      await page.getByTestId('usd-scene-sidebar').getByRole('button', {
        name: /^Load (?!example)/
      }).click();
      const start = Date.now();
      while (Date.now() - start < 8 * 60 * 1000) {
        const status = await page.getByTestId('usd-scene-status').textContent().catch(() => '');
        if (/rendered/i.test(status)) break;
        if (/error/i.test(status)) throw new Error(status);
        await page.waitForTimeout(1000);
      }
      const status = await page.getByTestId('usd-scene-status').textContent();
      if (!/rendered/i.test(status || '')) throw new Error(`scene load timeout: ${status}`);
      const handle = await page.evaluate(() => !!globalThis.__mtlxUsdSceneHandle);
      if (!handle) throw new Error('scene handle unavailable');
      report.stageCounts = await page.getByTestId('usd-stage-counts').textContent().catch(() => null);
      report.rawWarnings = await page.evaluate(() => globalThis.__mtlxUsdSceneHandle?.warnings || []);
      report.settings = await page.evaluate(() => {
        const h = globalThis.__mtlxUsdSceneHandle,
          d = h.__debug(),
          r = d.renderer,
          gl = r.getContext(),
          ext = gl.getExtension('WEBGL_debug_renderer_info'),
          call = fn => {
            try {
              return fn();
            } catch (e) {
              return {
                error: String(e)
              };
            }
          };
        return {
          displayExposureEV: call(() => globalThis.getDisplayExposure()),
          sharedDisplayTransform: call(() => globalThis.getDisplayTransform()),
          sceneDisplayTransform: call(() => h.getSceneDisplayTransform()),
          presentation: call(() => h.getPresentation()),
          ambientOcclusion: call(() => h.getAmbientOcclusion()),
          shadows: call(() => h.getShadows()),
          transparency: call(() => globalThis.getUsdSceneTransparency()),
          skyVisibility: call(() => h.getSkyVisibility()),
          stageLights: call(() => h.getStageLights()),
          domeLight: call(() => h.getDomeLight()),
          cameras: call(() => h.getCameras()),
          textureStats: call(() => h.getTextureStats()),
          samplerReport: call(() => h.getSamplerReport()),
          rendererStats: {
            render: {
              ...r.info.render
            },
            memory: {
              ...r.info.memory
            }
          },
          gpu: {
            renderer: gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL || gl.RENDERER),
            vendor: gl.getParameter(ext?.UNMASKED_VENDOR_WEBGL || gl.VENDOR),
            maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
            drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight]
          }
        };
      });
      save();
      const names = args.cameras[0] === 'first' ? [report.settings.cameras?.[0]?.name] : args.cameras;
      for (const name of names) {
        if (!name) throw new Error('no authored camera available');
        const applied = await page.evaluate(n => {
          const h = globalThis.__mtlxUsdSceneHandle;
          const matches = (h.getCameras?.() || []).filter(x => x.name === n || x.primPath === n);
          if (matches.length !== 1) return {
            error: matches.length ? 'ambiguous camera' : 'camera not found'
          };
          const c = matches[0];
          return {
            authored: c,
            ok: h.applyCamera(c.primPath) === true,
            pose: h.getCamera?.(),
            lens: (() => {
              const cam = h.__debug()?.camera;
              return cam ? {
                fov: cam.fov,
                near: cam.near,
                far: cam.far,
                aspect: cam.aspect,
                zoom: cam.zoom,
                projectionMatrix: Array.from(cam.projectionMatrix?.elements || [])
              } : null;
            })()
          };
        }, name);
        if (!applied || !applied.ok || applied.pose?.cameraPath !== applied.authored.primPath) throw new Error(`camera application failed or mismatched: ${name}`);
        await page.waitForTimeout(500);
        const visual = await page.evaluate(() => {
          const h = globalThis.__mtlxUsdSceneHandle;
          const renderer = h?.__debug?.()?.renderer;
          const gl = renderer?.getContext?.();
          const c = renderer?.domElement;
          if (!gl || !c) return {
            error: 'renderer WebGL unavailable'
          };
          h.renderNow?.();
          const width = c.width,
            height = c.height;
          const pixels = new Uint8Array(width * height * 4);
          gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          const glError = gl.getError();
          let min = 255,
            max = 0,
            nonzero = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            const value = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
            min = Math.min(min, value);
            max = Math.max(max, value);
            if (value > 0) nonzero++;
          }
          return { min, max, nonzero, width, height, glError, defaultTarget: renderer.getRenderTarget() === null };
        });
        if (visual.error || visual.glError !== 0 || !visual.defaultTarget || visual.nonzero === 0 || visual.max - visual.min < 10) throw new Error(`camera canvas is blank or uniform: ${JSON.stringify(visual)}`);
        const captured = await page.evaluate(() => {
          const h = globalThis.__mtlxUsdSceneHandle;
          const pose = h.getCamera?.();
          const cam = h.__debug?.()?.camera;
          return {
            pose,
            lens: cam ? {
              fov: cam.fov,
              near: cam.near,
              far: cam.far,
              aspect: cam.aspect,
              zoom: cam.zoom,
              projectionMatrix: Array.from(cam.projectionMatrix?.elements || [])
            } : null
          };
        });
        if (!captured?.pose || captured.pose.cameraPath !== applied.authored.primPath) {
          throw new Error(`camera changed or mismatched at capture time: ${name}`);
        }
        const canvas = page.getByTestId('usd-scene-canvas').locator('canvas');
        const file = path.join(out, `${name.replaceAll(/[^A-Za-z0-9_.-]/g, '_')}.png`);
        await canvas.screenshot({
          path: file
        });
        if (!fs.existsSync(file)) throw new Error(`camera screenshot missing: ${file}`);
        report.cameras.push({
          requested: name,
          ...applied,
          appliedPose: applied.pose,
          appliedLens: applied.lens,
          pose: captured.pose,
          lens: captured.lens,
          file,
          visual,
          dimensions: await page.evaluate(() => {
            const c = document.querySelector('[data-testid="usd-scene-canvas"] canvas');
            return {
              viewport: [innerWidth, innerHeight],
              devicePixelRatio,
              canvas: [c?.width, c?.height, c?.clientWidth, c?.clientHeight]
            };
          })
        });
        save();
      }
      report.backend = await page.evaluate(() => {
        const h = globalThis.__mtlxUsdSceneHandle,
          d = h.__debug(),
          r = d.renderer,
          gl = r.getContext(),
          ext = gl.getExtension('WEBGL_debug_renderer_info');
        return {
          renderer: gl.getParameter(ext?.UNMASKED_RENDERER_WEBGL || gl.RENDERER),
          vendor: gl.getParameter(ext?.UNMASKED_VENDOR_WEBGL || gl.VENDOR),
          webgl2: r.capabilities.isWebGL2 === true,
          glError: gl.getError(),
          maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
          programs: (r.info.programs || []).map(p => ({
            runnable: gl.getProgramParameter(p.program, gl.LINK_STATUS) === true
          }))
        };
      });
      if (report.backend.glError !== 0 || report.backend.programs.some(p => !p.runnable) || !report.cameras.length) throw new Error('scene capture invariant failed');
    } finally {
      if (browser) await browser.close().catch(() => {});
      if (server) await server.close().catch(() => {});
    }
    report.shaderDiagnostics = (report.console || []).filter(item => ['error', 'warning'].includes(item.type) && /THREE\.WebGLProgram:\s*shader error|(?:gl\.)?VALIDATE_STATUS\s*(?:[=:]\s*)?false|(?:shader|program)\s+(?:compil(?:e|ation)|link)\s+(?:failed|failure)|ERROR:\s*\d+:\d+|WebGL\s+INVALID_/i.test(item.text));
    if (report.shaderDiagnostics.length) report.errors.push({
      type: 'shader-diagnostic',
      entries: report.shaderDiagnostics
    });
    report.sourceHashesAfter = sourceHashes();
    report.sourceMutation = JSON.stringify(report.sourceHashesBefore) !== JSON.stringify(report.sourceHashesAfter);
    if (report.sourceMutation) throw new Error('product source changed during capture');
    report.status = report.errors.length ? 'failed' : 'passed';
  } catch (e) {
    report.status = 'failed';
    report.failure = String(e?.stack || e);
    report.errors.push({
      type: 'runner',
      text: report.failure
    });
  } finally {
    report.sourceHashesAfter ??= sourceHashes();
    report.sourceMutation = JSON.stringify(report.sourceHashesBefore) !== JSON.stringify(report.sourceHashesAfter);
    report.finishedAt = new Date().toISOString();
    fs.mkdirSync(out, {
      recursive: true
    });
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
  }
  if (report.status !== 'passed') process.exitCode = 1;
}
main();
