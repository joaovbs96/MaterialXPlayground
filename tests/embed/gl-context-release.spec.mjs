// tests/embed/gl-context-release.spec.mjs: WebGL context lifetime. Discarded canvases
// must free their context (docs preview toggled 20 times stays flat), and the engine
// cap must suspend idle views instead of letting the browser evict arbitrary ones.

import { test, expect, WAIT_TIMEOUT } from './lib/test-base.mjs';

// Counts contexts per canvas and records the high-water mark. Liveness reads isContextLost()
// directly: the 'lost' events lag behind loseContext() until the page next gets a frame.
const COUNTER = () => {
  const reg = window.__gl = { created: 0, lost: 0, max: 0, items: [], evicted: 0, suspended: 0 };
  const live = () => reg.items.filter((i) => i.ref.deref() && !i.gl.isContextLost()).length;
  window.__glLive = live;
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    const c = orig.call(this, type, ...rest);
    if (c && /webgl/.test(type) && !this.__glTracked) {
      this.__glTracked = true;
      reg.created++;
      const rec = { ref: new WeakRef(this), gl: c, lost: false };
      reg.items.push(rec);
      this.addEventListener('webglcontextlost', () => { rec.lost = true; reg.lost++; });
      this.addEventListener('webglcontextrestored', () => { rec.lost = false; });
      reg.max = Math.max(reg.max, live());
    }
    return c;
  };
  // Browser evictions are 'lost' events the engine did not cause.
  window.addEventListener('mtlx-gl-context', (e) => {
    const d = e.detail || {};
    if (d.state !== 'lost') return;
    if (d.suspended) reg.suspended++; else reg.evicted++;
  });
};

const frames = (page, n = 8) => page.evaluate((n) => new Promise((resolve) => {
  let i = 0;
  const tick = () => (++i >= n ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
}), n);

const MTLX = `<?xml version="1.0"?>
<materialx version="1.39">
  <standard_surface name="surf" type="surfaceshader">
    <input name="base_color" type="color3" value="0.8, 0.3, 0.1" />
  </standard_surface>
  <surfacematerial name="mat" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="surf" />
  </surfacematerial>
</materialx>`;

test.describe('WebGL context lifetime', () => {
  test('docs preview mount/unmount x20 keeps the live context count flat', async ({ page, embedURL }) => {
    test.setTimeout(240000);
    await page.addInitScript(COUNTER);
    await page.goto(embedURL + '/index.html#/stdlib/procedural2d/worleynoise2d');
    const toggle = page.locator('[aria-label="Toggle 3D previews"]').first();
    await toggle.waitFor({ state: 'visible', timeout: WAIT_TIMEOUT });
    await page.waitForFunction(() => document.querySelector('canvas') && window.__gl.created >= 2, null, { timeout: WAIT_TIMEOUT });
    const base = await page.evaluate(() => window.__gl.created);
    for (let i = 1; i <= 20; i++) {
      await toggle.click();
      await page.waitForFunction(() => !document.querySelector('canvas'), null, { timeout: WAIT_TIMEOUT });
      await toggle.click();
      await page.waitForFunction((n) => window.__gl.created >= n, base + i, { timeout: WAIT_TIMEOUT });
    }
    await frames(page);
    const r = await page.evaluate(() => ({ live: window.__glLive(), max: window.__gl.max, lost: window.__gl.lost, created: window.__gl.created }));
    expect(r.created).toBeGreaterThanOrEqual(base + 20);
    expect(r.lost).toBeGreaterThanOrEqual(19);
    expect(r.live).toBeLessThanOrEqual(5);
    expect(r.max).toBeLessThanOrEqual(8);
  });

  test('context cap suspends idle views and the first view rebuilds on return', async ({ page, embedURL }) => {
    test.setTimeout(300000);
    const errors = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.addInitScript(COUNTER);
    await page.goto(embedURL + '/index.html#!viewer');
    await page.waitForFunction(() => !!window.__mtlxViewerHandle && window.getMxEnv && window.listDocRenderables, null, { timeout: WAIT_TIMEOUT });
    await page.evaluate(() => { window.__firstViewer = window.__mtlxViewerHandle; });
    for (const hash of ['#!compare', '#!graph', '#/stdlib/procedural2d/worleynoise2d']) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForTimeout(2500);
    }
    // 16 more views on their own canvases, each active just long enough to render a frame,
    // so the cap has to reclaim idle ones oldest first (the Viewer, left earlier, goes first).
    await page.evaluate(async (xml) => {
      window.__extra = [];
      const env = await window.getMxEnv();
      const doc = env.mx.createDocument();
      await window.mxExclusive(() => env.mx.readFromXmlString(doc, xml));
      if (doc.setDataLibrary) doc.setDataLibrary(env.stdlib);
      const { name, node } = window.listDocRenderables(doc)[0];
      for (let i = 0; i < 16; i++) {
        const canvas = document.createElement('canvas');
        canvas.style.cssText = 'position:fixed;left:0;top:0;width:128px;height:128px;opacity:0';
        document.body.appendChild(canvas);
        const view = await window.createMtlxRenderView({
          canvas, mx: env.mx, gen: env.gen, genContext: env.genContext, renderable: node,
          label: 'cap-' + i, materialName: name, needsLighting: true, geomName: 'sphere',
          isMounted: () => true, isActive: () => window.__act === i,
        });
        window.__act = i;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        window.__extra.push(view);
      }
    }, MTLX);
    const mid = await page.evaluate(() => ({
      live: window.__glLive(), max: window.__gl.max, evicted: window.__gl.evicted, suspended: window.__gl.suspended,
      firstLost: window.__firstViewer.glCtx.lost(),
    }));
    expect(mid.suspended).toBeGreaterThan(0);
    expect(mid.evicted).toBe(0);
    expect(mid.max).toBeLessThanOrEqual(14);
    expect(mid.firstLost).toBe(true);

    // Back to the first view: it must wake, rebuild and draw non-black pixels.
    await page.evaluate(() => { location.hash = '#!viewer'; });
    await page.waitForFunction(() => window.__mtlxViewerHandle && window.__mtlxViewerHandle !== window.__firstViewer, null, { timeout: WAIT_TIMEOUT });
    await frames(page, 20);
    const lit = await page.evaluate(() => {
      const img = window.__mtlxViewerHandle.snapshotPixels(64, 64);
      let n = 0;
      for (let q = 0; q < img.data.length; q += 4) if (img.data[q] + img.data[q + 1] + img.data[q + 2] > 12) n++;
      return n / (img.data.length / 4);
    });
    expect(lit).toBeGreaterThan(0.1);
    const end = await page.evaluate(() => ({ max: window.__gl.max, evicted: window.__gl.evicted }));
    expect(end.max).toBeLessThanOrEqual(14);
    expect(end.evicted).toBe(0);
    expect(errors.filter((e) => /Framebuffer not complete/i.test(e))).toEqual([]);
  });
});
