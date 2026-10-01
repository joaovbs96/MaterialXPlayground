import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { startServer } from '../embed/lib/server.mjs';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const INIT = () => {
  const reg = (window.__ctx = { created: 0, lost: 0, restored: 0, loseCalls: 0, items: [], errs: [] });
  const wrap = (proto, name) => {
    const orig = proto.getContext;
    proto.getContext = function (type, ...r) {
      const c = orig.call(this, type, ...r);
      if (c && /webgl/.test(type) && !this.__tracked) {
        this.__tracked = true; reg.created++;
        const rec = { ref: new WeakRef(this), lost: false, stack: (new Error().stack || '').split('\n').slice(2, 5).join('|').slice(0, 220) };
        reg.items.push(rec);
        this.addEventListener('webglcontextlost', () => { rec.lost = true; reg.lost++; });
        this.addEventListener('webglcontextrestored', () => { rec.lost = false; reg.restored++; });
        const ge = c.getExtension;
        c.getExtension = function (n) { const e = ge.call(this, n); if (n === 'WEBGL_lose_context' && e && !e.__w) { const l = e.loseContext.bind(e); e.__w = 1; return new Proxy(e, { get(t, k) { return k === 'loseContext' ? () => { reg.loseCalls++; return l(); } : t[k].bind ? t[k].bind(t) : t[k]; } }); } return e; };
      }
      return c;
    };
  };
  wrap(HTMLCanvasElement.prototype); if (window.OffscreenCanvas) wrap(OffscreenCanvas.prototype);
  window.__live = () => reg.items.filter((i) => !i.lost && i.ref.deref()).length;
  window.addEventListener('error', (e) => reg.errs.push(e.message));
  const ce = console.error; console.error = (...a) => { reg.errs.push(a.join(' ').slice(0, 120)); ce.apply(console, a); };
};
export async function boot(url = '#!graph', { engine = true } = {}) {
  const server = await startServer({ root: ROOT });
  const browser = await chromium.launch({ headless: false, args: ['--headless=new', '--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu-rasterization'] });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => { if (/mtlx-gl/.test(m.text()) || (m.type() === 'error' && /Framebuffer|lost/i.test(m.text()))) console.log('[console]', m.text().slice(0, 160)); });
  await page.addInitScript(INIT);
  await page.goto(`${server.baseURL}/index.html${url}`);
  if (!engine) return { server, browser, page };
  await page.waitForFunction(() => ['buildPreviewRenderable', 'parseMtlxDocument', 'getMxEnv', 'mxExclusive', 'createMtlxRenderView'].every((k) => typeof window[k] === 'function'), null, { timeout: 120000 });
  await page.evaluate(() => window.getMxEnv());
  return { server, browser, page };
}
