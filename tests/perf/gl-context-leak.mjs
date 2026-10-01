// Diagnostic (not CI): mode dispose|destroy|hold|idle (idle = only the newest view active, exercises the cap); prints live WebGL context counts per view. Real GPU needed.
import fs from 'node:fs';
import { boot, ROOT } from './gl-context-lib.mjs';
const mode = process.argv[2] || 'dispose'; const N = +(process.argv[3] || 24);
const xml = fs.readFileSync(ROOT + '/materials/open_pbr_default.mtlx', 'utf8');
const { server, browser, page } = await boot();
const out = await page.evaluate(async ({ xml, mode, N }) => {
  const frames = (n) => new Promise((r) => { let i = 0; const t = () => (++i >= n ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); });
  const parsed = await parseMtlxDocument(xml);
  const rows = []; const held = []; let current = 0;
  const base = window.__ctx.created;
  for (let i = 1; i <= N; i++) {
    const env = await getMxEnv();
    const host = document.createElement('div'); host.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:200px;opacity:0';
    const canvas = document.createElement('canvas'); canvas.style.cssText = 'width:100%;height:100%'; host.appendChild(canvas); document.body.appendChild(host);
    const built = await mxExclusive(() => buildPreviewRenderable(parsed, null));
    const view = await createMtlxRenderView({ canvas, mx: env.mx, gen: env.gen, genContext: env.genContext, renderable: built.renderable, lightData: env.lightData, materialName: built.materialName || null, label: 'leak', needsLighting: true, geomName: 'shaderball-scene', sceneOrbit: true, autoRotate: false, isMounted: () => true, isActive: () => current === i, debugKind: 'graph-preview' });
    current = i;
    await mxExclusive(() => built.cleanup());
    await frames(6); await new Promise((r) => setTimeout(r, 150));
    const img = view.snapshotPixels(64, 64); let nb = 0; for (let q = 0; q < img.data.length; q += 4) if (img.data[q] + img.data[q + 1] + img.data[q + 2] > 12) nb++;
    const gl = canvas.getContext('webgl2'); const lostSelf = gl ? gl.isContextLost() : 'nogl';
    rows.push({ i, createdSince: window.__ctx.created - base, lostEvents: window.__ctx.lost, live: window.__live(), nonblack: +(nb / 4096).toFixed(2), selfLost: lostSelf });
    if (mode === 'dispose') { view.dispose(); host.remove(); } else if (mode === 'destroy') { view.destroy(); host.remove(); } else held.push({ view, host });
  }
  let wake = null;
  if (mode === 'idle') {
    const before = { lost: window.__ctx.lost, restored: window.__ctx.restored };
    const lostIdx = held.findIndex((h) => h.view.glCtx.lost());
    if (lostIdx >= 0) { current = lostIdx + 1; await frames(30); await new Promise((r) => setTimeout(r, 500)); }
    wake = { suspendedView: lostIdx + 1, restoredEvents: window.__ctx.restored - before.restored, stillLost: lostIdx >= 0 ? held[lostIdx].view.glCtx.lost() : null, live: window.__live() };
  }
  return { wake, rows, loseCalls: window.__ctx.loseCalls, errs: window.__ctx.errs.slice(0, 5), items: window.__ctx.items.map((x) => x.lost + ':' + x.stack.slice(0, 80)).slice(0, 4) };
}, { xml, mode, N });
console.log(mode); for (const r of out.rows) console.log(JSON.stringify(r)); console.log('wake', JSON.stringify(out.wake)); console.log('loseCalls', out.loseCalls, out.errs, out.items);
await browser.close(); server.close && server.close();
