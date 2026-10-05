import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const E = require('../../js/shared/theme-engine.js');
const data = require('../../js/shared/theme-tokens.js');
const pairs = require('../../js/gen/theme-pairs.js');
const groupsGen = require('../../js/gen/theme-groups.js');
const meta = await import('../../scripts/theme-tokens-meta.mjs');
const PAGE = 'https://example.test/site/';
const TOKENS = Object.keys(data.themes.dark);

function makeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m };
}

// Fake page: theme-tokens.js and theme.js as head scripts (`parsing`: parser-inserted, document.write allowed).
// serve() runs written and appended scripts by path (theme-custom.js, theme-pairs.js, the engine, theme-groups.js, preset
// files) and fires the load of appended stylesheets.
// `custom` (default) then loads theme-custom.js the way a first listCustom() does, so the sync API is the real one.
function page({ storage = makeStorage(), dark = true, globals = {}, parsing = false, custom = true } = {}) {
  const listeners = {};
  const mql = { matches: dark, addEventListener() {} };
  const meta = { content: '', setAttribute(k, v) { if (k === 'content') this.content = v; } };
  const head = {
    children: [],
    appendChild(el) { el.parentNode = this; this.children.push(el); },
    removeChild(el) { this.children = this.children.filter((x) => x !== el); el.parentNode = null; },
  };
  const document = {
    documentElement: { dataset: {} },
    body: { classList: { contains: () => false } },
    querySelector: (s) => (s === 'meta[name="theme-color"]' ? meta : null),
    addEventListener() {},
    head,
    createElement: (tag) => ({ tagName: tag, async: tag === 'script', textContent: '' }),
    readyState: parsing ? 'loading' : 'complete',
    currentScript: null,
    written: [],
    log: [],
    write(html) { this.written.push(html); this.log.push(html); },
  };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  const context = {
    console: { warn() {}, log() {}, error() {} },
    document,
    localStorage: storage,
    CustomEvent,
    matchMedia: () => mql,
    addEventListener: (t, h) => { (listeners[t] = listeners[t] || []).push(h); },
    removeEventListener: (t, h) => { listeners[t] = (listeners[t] || []).filter((x) => x !== h); },
    dispatchEvent: (e) => { (listeners[e.type] || []).slice().forEach((h) => h(e)); return true; },
    ...globals,
  };
  context.self = context;
  vm.createContext(context);
  const run = (src, async) => {
    const file = path.join(root, src.replace(PAGE, '').replace(/[?#].*$/, ''));
    document.currentScript = { src, async };
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    document.currentScript = null;
  };
  for (const f of ['js/shared/theme-tokens.js', 'js/shared/theme.js']) run(parsing ? PAGE + f : f, false);
  const p = {
    T: context.MtlxTheme,
    ctx: context,
    document,
    storage,
    listeners,
    serve() {
      for (let guard = 0; guard < 20; guard++) {
        let progressed = false;
        while (document.written.length) {
          for (const m of document.written.shift().matchAll(/<script src="([^"]+)"/g)) { run(m[1], false); progressed = true; }
        }
        for (const el of head.children.slice()) {
          if (el.served || (el.tagName !== 'script' && el.tagName !== 'link')) continue;
          el.served = progressed = true;
          if (el.tagName === 'script') run(el.src, el.async);
          if (el.onload) el.onload();
        }
        if (!progressed) return;
      }
    },
    // Runs an API call that loads scripts on demand, delivers them, and awaits the result.
    async call(fn) { const r = fn(); p.serve(); return r; },
    style(id) { return head.children.find((el) => el.tagName === 'style' && el.id === 'mtlx-theme-' + id); },
    events(type) { const seen = []; context.addEventListener(type, (e) => seen.push(e.detail)); return seen; },
  };
  p.serve();
  if (custom) { context.MtlxTheme.listCustom(); p.serve(); }
  p.T = context.MtlxTheme;
  return p;
}

const SPEC = {
  id: 'custom:ocean',
  label: 'Ocean é 🌊',
  base: 'dark',
  seeds: { background: '#0b1d2a', foreground: '#e6f1f8', accent: '#2563eb' },
  overrides: { 'fg-muted': '#9fb3c2', 'focus': '#5ab8ff' },
};
const LIGHT = { id: 'custom:sand', label: 'Sand', base: 'light', seeds: { background: '#f6f1e7', foreground: '#2b2620', accent: '#2659c9' } };

// Forged codes: the documented byte layout, built independently of theme.js. `from` is a base theme id (no seeds
// are written unless given); `tail` are the modifier bytes or anything trailing.
const SEEDS9 = [0x11, 0x18, 0x27, 0xf3, 0xf4, 0xf6, 0x3b, 0x82, 0xf6];
function forge({ base = 0x0c, from = '', seeds = from ? [] : SEEDS9, slug = 'x', label = 'X', overrides = [], tail = [] } = {}) {
  const b = [base, from.length, ...Buffer.from(from, 'latin1'), ...seeds, slug.length, ...Buffer.from(slug, 'latin1'), Buffer.byteLength(label), ...Buffer.from(label), overrides.length];
  for (const [name, rgb] of overrides) b.push(name.length, ...Buffer.from(name, 'latin1'), ...rgb);
  b.push(...tail);
  return 'mtlx2.' + Buffer.from(b).toString('base64url');
}
const PAPER = { id: 'custom:warm', label: 'Warm paper', base: 'light', from: 'paper', overrides: { 'fg-muted': '#4a4540' } };

const plain = (x) => JSON.parse(JSON.stringify(x));

function rejects(T, fn, re) {
  assert.throws(fn, (e) => { assert.ok(e && typeof e.message === 'string', 'throws an Error'); assert.match(e.message, re); assert.ok(e.message.length < 90, 'short message: ' + e.message); return true; });
}

test('encode and decode round trip, base at a fixed position, modifiers default to 0', () => {
  const { T } = page();
  const code = T.encodeTheme(SPEC);
  assert.match(code, /^mtlx2\.D[A-Za-z0-9_-]+$/);
  assert.match(T.encodeTheme(LIGHT), /^mtlx2\.L/);
  const back = plain(T.decodeTheme(code));
  assert.deepEqual(back, { v: 1, id: 'custom:ocean', label: 'Ocean é 🌊', base: 'dark', seeds: SPEC.seeds, overrides: { 'fg-muted': '#9fb3c2', 'focus': '#5ab8ff' }, modifiers: { contrast: 0, tint: 0 } });
  assert.equal(T.encodeTheme(back), code);
  assert.equal(T.decodeTheme('  ' + code + '\n').id, 'custom:ocean', 'surrounding whitespace from a paste is fine');
  const mod = T.encodeTheme({ ...SPEC, modifiers: { contrast: -0.35, tint: 0.6 } });
  assert.deepEqual(plain(T.decodeTheme(mod).modifiers), { contrast: -0.35, tint: 0.6 });
  assert.equal(mod.length > code.length, true);
  assert.deepEqual(plain(T.decodeTheme(T.encodeTheme({ ...SPEC, modifiers: { contrast: 0.33, tint: 0.01 } })).modifiers), { contrast: 0.35, tint: 0 }, 'quantized to 0.05');
  assert.equal(T.encodeTheme({ ...SPEC, modifiers: { contrast: 0, tint: 0 } }), code, 'default modifiers are not encoded');
  assert.deepEqual(plain(T.decodeTheme(forge({ slug: 'x', label: 'X' })).seeds), { background: '#111827', foreground: '#f3f4f6', accent: '#3b82f6' });
  const all = {};
  TOKENS.forEach((t, i) => { all[t] = '#' + (i * 99991 % 0xffffff).toString(16).padStart(6, '0'); });
  const big = T.encodeTheme({ ...SPEC, label: 'x'.repeat(40), id: 'custom:' + 'a'.repeat(40), overrides: all, modifiers: { contrast: 1, tint: 1 } });
  assert.ok(big.length < 8192, 'a theme overriding every token fits the length bound (' + big.length + ')');
  assert.deepEqual(plain(T.decodeTheme(big).overrides), all);
});

test('malformed, oversized and damaged codes are rejected with short messages', () => {
  const { T } = page();
  const good = T.encodeTheme(SPEC);
  for (const c of ['', 'hello', 'mtlx2.', 'mtlx2.A', 'mtlx2.' + good.slice(6) + '=', 'mtlx2.ab cd', 'MTLX1.' + good.slice(6), null, 42, {}]) rejects(T, () => T.decodeTheme(c), /not a theme code|damaged/i);
  rejects(T, () => T.decodeTheme('mtlx3.' + good.slice(6)), /newer version/);
  rejects(T, () => T.decodeTheme('mtlx1.' + good.slice(6)), /older version and can no longer be read/);
  rejects(T, () => T.decodeTheme('mtlx2.' + 'A'.repeat(8200)), /too long/);
  rejects(T, () => T.decodeTheme(good.slice(0, -5)), /damaged/i);
  rejects(T, () => T.decodeTheme(forge({ tail: [20, 0, 7] })), /damaged/i);
  rejects(T, () => T.decodeTheme(forge({ base: 0x0d })), /damaged/i);
  rejects(T, () => T.decodeTheme(forge({ tail: [41, 0] })), /damaged/i);
  rejects(T, () => T.decodeTheme(forge({ tail: [20, 21] })), /damaged/i);
  rejects(T, () => T.decodeTheme(forge({ overrides: [['fg', [1, 2, 3]], ['fg', [1, 2, 3]]] })), /damaged/i);
  // Non-canonical base64url (stray low bits) is rejected, so one theme has exactly one code.
  const last = good.slice(-1), alt = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bumped = good.slice(0, -1) + alt[(alt.indexOf(last) + 1) % 64];
  assert.throws(() => T.decodeTheme(bumped));
});

test('unknown tokens, non-hex colors and script-like payloads are rejected', () => {
  const { T } = page();
  rejects(T, () => T.decodeTheme(forge({ overrides: [['not-a-token', [1, 2, 3]]] })), /Unknown color role "not-a-token"/);
  rejects(T, () => T.decodeTheme(forge({ overrides: [['</style>', [1, 2, 3]]] })), /Unknown color role "\?\?style\?"/);
  rejects(T, () => T.decodeTheme(forge({ overrides: [['__proto__', [1, 2, 3]]] })), /Unknown color role/);
  rejects(T, () => T.decodeTheme(forge({ slug: 'a"b' })), /Theme id/);
  rejects(T, () => T.decodeTheme(forge({ slug: '' })), /Theme id/);
  rejects(T, () => T.decodeTheme(forge({ label: '</style><script>' })), /not allowed/);
  rejects(T, () => T.decodeTheme(forge({ label: 'a\u0000b' })), /not allowed/);
  rejects(T, () => T.decodeTheme(forge({ label: '' })), /Name must be/);
  rejects(T, () => T.decodeTheme(forge({ label: 'x'.repeat(41) })), /Name must be/);
  const bin = 'mtlx2.' + Buffer.from([0x0c, 1, 2, 3, 4, 5, 6, 7, 8, 9, 1, 0x78, 2, 0xc3, 0x28, 0]).toString('base64url');
  rejects(T, () => T.decodeTheme(bin), /damaged/i);
  const spec = (patch) => ({ ...SPEC, ...patch });
  for (const bad of ['red', '#12345g', '#fff', 'url(x)', 'expression(alert(1))', '#123456;}', 'rgb(1,2,3)', '</style>', 123, null]) {
    rejects(T, () => T.encodeTheme(spec({ seeds: { ...SPEC.seeds, accent: bad } })), /#rrggbb/);
    rejects(T, () => T.encodeTheme(spec({ overrides: { fg: bad } })), /#rrggbb/);
  }
  rejects(T, () => T.encodeTheme(spec({ overrides: { 'url(': '#000000' } })), /Unknown color role/);
  rejects(T, () => T.encodeTheme(spec({ extra: 1 })), /Unknown theme field "extra"/);
  rejects(T, () => T.encodeTheme(spec({ seeds: { ...SPEC.seeds, glow: '#000000' } })), /Unknown seed/);
  rejects(T, () => T.encodeTheme(spec({ base: 'auto' })), /Base must be/);
  rejects(T, () => T.encodeTheme(spec({ id: 'ocean' })), /Theme id/);
  rejects(T, () => T.encodeTheme(spec({ id: 'custom:Ocean' })), /Theme id/);
  rejects(T, () => T.encodeTheme(spec({ label: 'Hi <b>' })), /not allowed/);
  rejects(T, () => T.encodeTheme(spec({ label: 'a\ud800' })), /not allowed/);
  rejects(T, () => T.encodeTheme(spec({ v: 2 })), /version/);
  rejects(T, () => T.encodeTheme(spec({ overrides: [] })), /must be an object/);
});

test('invalid modifier values are rejected', () => {
  const { T } = page();
  for (const m of [{ contrast: 1.5 }, { contrast: -1.01 }, { tint: -0.1 }, { tint: 2 }, { tint: NaN }, { contrast: Infinity }, { contrast: '0.5' }, { contrast: null }, { glow: 0.5 }, []]) {
    rejects(page().T, () => T.encodeTheme({ ...SPEC, modifiers: m }), /Contrast|Tint|modifier|Modifiers/);
  }
  assert.deepEqual(plain(T.decodeTheme(T.encodeTheme({ ...SPEC, modifiers: { contrast: -1, tint: 1 } })).modifiers), { contrast: -1, tint: 1 });
});

test('modifiers at 0 reproduce the previous derivation exactly', () => {
  const seedSets = [{}, SPEC.seeds, LIGHT.seeds, ...Object.values(meta.presets).map((p) => p.seeds)];
  for (const base of ['dark', 'light']) {
    for (const seeds of seedSets) {
      const a = E.deriveTheme({ base, seeds, data });
      for (const modifiers of [{ contrast: 0, tint: 0 }, {}, undefined]) {
        assert.deepEqual(E.deriveTheme({ base, seeds, data, modifiers }).tokens, a.tokens);
      }
    }
  }
  for (const [id, preset] of Object.entries(meta.presets)) {
    const gen = require('../../js/gen/themes/' + id + '.js');
    const r = E.resolvePreset({ ...preset, contrast: data.registry.find((e) => e.id === id).contrast }, { data, pairs: meta.contrast });
    assert.deepEqual(r.tokens, gen.tokens, id + ' resolves byte-identically');
  }
});

test('contrast -1 / +1 and tint 1 move neutrals only and stay AA after enforcement', () => {
  const GRAY = { background: '#121212', foreground: '#eeeeee', accent: '#db2777' };
  const base = E.deriveTheme({ base: 'dark', seeds: GRAY, data });
  const soft = E.deriveTheme({ base: 'dark', seeds: GRAY, data, modifiers: { contrast: -1 } });
  const crisp = E.deriveTheme({ base: 'dark', seeds: GRAY, data, modifiers: { contrast: 1 } });
  const tint = E.deriveTheme({ base: 'dark', seeds: GRAY, data, modifiers: { tint: 1 } });
  const L = (h) => E.toOklch(h)[0];
  assert.ok(L(soft.tokens['surface-raised']) < L(base.tokens['surface-raised']) && L(crisp.tokens['surface-raised']) > L(base.tokens['surface-raised']));
  assert.ok(L(soft.tokens['fg-muted']) < L(base.tokens['fg-muted']) && L(crisp.tokens['fg-muted']) > L(base.tokens['fg-muted']));
  assert.ok(E.toOklch(tint.tokens['surface-raised'])[1] > E.toOklch(base.tokens['surface-raised'])[1]);
  for (const t of ['success', 'error-fill', 'type-float', 'accent-fill', 'surface-base', 'fg']) {
    for (const d of [soft, crisp, tint]) assert.equal(d.tokens[t], base.tokens[t], t + ' is not a derived neutral');
  }
  const ov = E.deriveTheme({ base: 'dark', seeds: SPEC.seeds, data, overrides: { 'surface-raised': '#203040' }, modifiers: { contrast: 1, tint: 1 } });
  assert.equal(ov.tokens['surface-raised'], '#203040', 'overrides are untouched');
  for (const spec of [SPEC, LIGHT, { ...LIGHT, seeds: { background: '#ffffff', foreground: '#000000', accent: '#c2410c' } }]) {
    for (const modifiers of [{ contrast: -1, tint: 0 }, { contrast: 1, tint: 0 }, { contrast: 0, tint: 1 }, { contrast: -1, tint: 1 }, { contrast: 1, tint: 1 }]) {
      const r = E.resolveCustom({ ...spec, overrides: spec.overrides || {}, modifiers }, { data, pairs: pairs.pairs, level: 'AA' });
      assert.equal(r.ok, true, spec.id + ' ' + JSON.stringify(modifiers) + ': ' + r.error);
      assert.ok(r.report.every((x) => x.pass), 'every pair passes AA');
    }
  }
});

test('saveCustom reports contrast adjustments, persists the code and fires the change event', async () => {
  const p = page();
  const seen = p.events('mtlx-custom-themes-change');
  const r = await p.call(() => p.T.saveCustom({ ...SPEC, overrides: { 'fg-muted': '#2a3540' } }));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.error, null);
  const adj = r.adjusted.filter((a) => a.fg === 'fg-muted');
  assert.ok(adj.length >= 1);
  assert.equal(adj[0].from, '#2a3540');
  assert.match(adj[0].to, /^#[0-9a-f]{6}$/);
  assert.ok(TOKENS.includes(adj[0].bg));
  assert.deepEqual(plain(r.spec.overrides), { 'fg-muted': '#2a3540' }, 'the saved spec keeps the user values; the pass runs on every apply');
  const stored = JSON.parse(p.storage.getItem('mtlxCustomThemes'));
  assert.equal(stored.length, 1);
  assert.equal(p.T.decodeTheme(stored[0].code).id, 'custom:ocean');
  assert.deepEqual(plain(stored[0]), { code: stored[0].code, id: 'custom:ocean', label: 'Ocean é 🌊', base: 'dark' }, 'the web store keeps labels beside the codes');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].themes[0].id, 'custom:ocean');
  assert.equal(p.ctx.MtlxThemeEngine !== undefined, true, 'the engine loads on demand');
});

test('an unfixable pair is rejected and nothing is saved', async () => {
  const p = page();
  const r = await p.call(() => p.T.saveCustom({ ...SPEC, seeds: { background: '#777777', foreground: '#808080', accent: '#2563eb' } }));
  assert.equal(r.ok, false);
  assert.match(r.error, /contrast/i);
  assert.ok(r.error.length < 160);
  assert.equal(p.storage.getItem('mtlxCustomThemes'), null);
  assert.equal(p.T.listCustom().length, 0);
  const bad = await p.T.saveCustom({ ...SPEC, seeds: { ...SPEC.seeds, accent: 'url(x)' } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /#rrggbb/);
});

test('list() puts custom themes after the presets in save order; previewDraft and clearDraft', async () => {
  const p = page();
  await p.call(() => p.T.saveCustom(LIGHT));
  await p.call(() => p.T.saveCustom(SPEC));
  await p.call(() => p.T.saveCustom({ ...LIGHT, label: 'Sand 2' }));
  const list = p.T.list();
  const presets = list.filter((e) => e.group !== 'custom').map((e) => e.id);
  assert.deepEqual(plain(presets), data.registry.filter((e) => !e.hosts).map((e) => e.id));
  assert.deepEqual(plain(list.slice(presets.length)), [
    { id: 'custom:sand', label: 'Sand 2', base: 'light', group: 'custom', contrast: 'AA' },
    { id: 'custom:ocean', label: 'Ocean é 🌊', base: 'dark', group: 'custom', contrast: 'AA' },
  ]);
  assert.deepEqual(plain(p.T.listCustom()).map((s) => s.id), ['custom:sand', 'custom:ocean']);

  assert.equal(p.T.current(), 'dark');
  const changes = p.events('mtlx-theme-change');
  const rep = await p.T.previewDraft({ base: 'light', seeds: LIGHT.seeds, modifiers: { tint: 0.5 } });
  assert.equal(rep.ok, true);
  assert.ok(rep.report.length > 50 && rep.report.every((x) => x.pass));
  assert.equal(p.document.documentElement.dataset.theme, 'custom:__draft');
  assert.equal(p.document.documentElement.dataset.themeBase, 'light');
  assert.equal(p.T.get('surface-base'), '#f6f1e7');
  assert.ok(p.style('custom:__draft'));
  await p.T.previewDraft({ base: 'dark', seeds: SPEC.seeds });
  assert.equal(p.T.currentBase(), 'dark');
  assert.equal(changes.length, 2, 'each draft update notifies');
  const bad = await p.T.previewDraft({ base: 'dark', seeds: { ...SPEC.seeds, accent: 'nope' } });
  assert.equal(bad.ok, false);
  assert.equal(p.T.get('surface-base'), '#0b1d2a', 'an invalid draft leaves the last preview');
  p.T.clearDraft();
  assert.equal(p.T.current(), 'dark');
  assert.equal(p.style('custom:__draft'), undefined);
  assert.equal(p.T.get('surface-base'), '#111827');
  assert.equal(p.storage.getItem('mtlxTheme'), null, 'a draft never persists');
});

test('setPreference to a custom theme applies it; deleting the active theme falls back to system', async () => {
  const p = page({ dark: true });
  await p.call(() => p.T.saveCustom(LIGHT));
  p.T.setPreference('custom:sand');
  assert.equal(p.T.current(), 'custom:sand');
  assert.equal(p.T.currentBase(), 'light');
  assert.equal(p.storage.getItem('mtlxTheme'), 'custom:sand');
  // Only validated #rrggbb channels and numeric params reach the stylesheet.
  const css = p.style('custom:sand').textContent;
  assert.match(css, /^:root\[data-theme="custom:sand"\] \{\n/);
  for (const line of css.trim().split('\n').slice(1, -1)) assert.match(line, /^ {2}--mtlx-[a-z0-9-]+: (\d{1,3} \d{1,3} \d{1,3}|\d+(\.\d+)?);$/);
  assert.equal(p.T.deleteCustom('custom:sand'), true);
  assert.equal(p.T.getPreference(), 'system');
  assert.equal(p.storage.getItem('mtlxTheme'), 'system');
  assert.equal(p.T.current(), 'dark');
  assert.equal(p.style('custom:sand'), undefined);
  assert.deepEqual(JSON.parse(p.storage.getItem('mtlxCustomThemes')), []);
  assert.equal(p.T.deleteCustom('custom:sand'), false);
  p.T.setPreference('custom:gone');
  assert.equal(p.T.getPreference(), 'system', 'unknown custom ids are ignored');
});

test('store adapter: injected list and host hook win over localStorage; setCustomThemes persist:false writes nothing', async () => {
  const p0 = page();
  const ocean = p0.T.encodeTheme(SPEC), sand = p0.T.encodeTheme(LIGHT);
  const storage = makeStorage({ mtlxCustomThemes: JSON.stringify([sand]) });
  const calls = [];
  const p = page({ storage, globals: { __MTLX_CUSTOM_THEMES__: [ocean, 'garbage'], __mtlxCustomThemesPersist: (codes) => calls.push(codes) } });
  assert.deepEqual(plain(p.T.listCustom()).map((s) => s.id), ['custom:ocean'], 'the injected list wins; invalid codes are skipped');
  await p.call(() => p.T.saveCustom(LIGHT));
  assert.deepEqual(plain(calls), [[ocean, sand]]);
  assert.equal(storage.getItem('mtlxCustomThemes'), JSON.stringify([sand]), 'localStorage untouched with a host hook');
  const seen = p.events('mtlx-custom-themes-change');
  p.T.setCustomThemes([sand], { persist: false });
  assert.equal(calls.length, 1);
  assert.deepEqual(plain(p.T.listCustom()).map((s) => s.id), ['custom:sand']);
  assert.equal(seen.length, 1);
  p.T.setCustomThemes([sand, ocean]);
  assert.deepEqual(plain(calls[1]), [sand, ocean]);

  const w = page({ storage: makeStorage({ mtlxCustomThemes: JSON.stringify([sand, 'x', 42]) }) });
  assert.deepEqual(plain(w.T.listCustom()).map((s) => s.id), ['custom:sand'], 'web reads localStorage');
  await w.call(() => w.T.saveCustom(SPEC));
  assert.deepEqual(JSON.parse(w.storage.getItem('mtlxCustomThemes')).map((e) => e.code), [sand, ocean]);
  const broken = page({ storage: makeStorage({ mtlxCustomThemes: '{not json' }) });
  assert.deepEqual(plain(broken.T.listCustom()), []);
});

test('a custom preference applies before first paint (parser-inserted engine)', () => {
  const p0 = page();
  const code = p0.T.encodeTheme(LIGHT);
  const storage = makeStorage({ mtlxCustomThemes: JSON.stringify([code]), mtlxTheme: 'custom:sand' });
  const p = page({ storage, parsing: true, dark: true });
  // page() already delivered the written scripts synchronously, as the parser does before the body.
  assert.deepEqual(p.document.log.map((h) => /src="([^"]+)"/.exec(h)[1].replace(PAGE, '')), ['js/shared/theme-custom.js', 'js/gen/theme-pairs.js', 'js/shared/theme-engine.js']);
  assert.equal(p.document.head.children.filter((el) => el.tagName === 'script').length, 0, 'nothing loaded after parsing');
  assert.equal(p.T.getPreference(), 'custom:sand');
  assert.equal(p.T.current(), 'custom:sand');
  assert.equal(p.document.documentElement.dataset.theme, 'custom:sand');
  assert.equal(p.document.documentElement.dataset.themeBase, 'light');
  assert.equal(p.T.get('surface-base'), '#f6f1e7');
  assert.ok(p.style('custom:sand'));
  // A deleted (missing) custom preference falls back to the default.
  const q = page({ storage: makeStorage({ mtlxTheme: 'custom:sand' }), parsing: true, dark: true });
  assert.equal(q.T.getPreference(), 'system');
  assert.equal(q.T.current(), 'dark');
  assert.ok(!q.document.log.some((h) => h.includes('theme-engine')), 'no engine without a custom theme');
});

test('pages without custom themes never load the engine', () => {
  const p = page({ parsing: true });
  assert.ok(p.document.log.every((h) => !h.includes('theme-engine') && !h.includes('theme-pairs')));
  assert.equal(p.ctx.MtlxThemeEngine, undefined);
  const e = page({ parsing: true, globals: { __MTLX_THEME_NO_PERSIST__: true, __MTLX_THEME_PREF__: 'dark' } });
  assert.deepEqual(plain(e.document.log), [], 'an embed without a code loads nothing');
});

test('embeds apply a code from the theme attribute and never persist', async () => {
  const p0 = page();
  const code = p0.T.encodeTheme({ ...LIGHT, modifiers: { contrast: 0.5 } });
  const storage = makeStorage();
  const hook = [];
  const globals = { __MTLX_THEME_NO_PERSIST__: true, __MTLX_THEME_PREF__: code, __mtlxCustomThemesPersist: (c) => hook.push(c), __mtlxThemePersist: (c) => hook.push(c) };
  const p = page({ storage, parsing: true, dark: true, globals });
  assert.equal(p.T.current(), 'custom:sand');
  assert.equal(p.document.documentElement.dataset.themeBase, 'light');
  await p.call(() => p.T.saveCustom(SPEC));
  p.T.setPreference('custom:ocean');
  p.T.deleteCustom('custom:ocean');
  assert.equal(storage.m.size, 0, 'nothing written to localStorage');
  assert.equal(hook.length, 0, 'no host hook called');
  for (const bad of ['mtlx2.garbage', 'mtlx2.' + 'A'.repeat(9000), 'mtlx9.AAAA']) {
    const b = page({ parsing: true, dark: false, globals: { __MTLX_THEME_NO_PERSIST__: true, __MTLX_THEME_PREF__: bad } });
    assert.equal(b.T.current(), 'dark', 'an invalid code is dark');
    assert.equal(b.ctx.MtlxThemeEngine, undefined);
  }
  // A code set live (embed-boot setTheme) loads theme-custom.js, the pairs and the engine on demand.
  const live = page({ dark: true, custom: false, globals: { __MTLX_THEME_NO_PERSIST__: true, __MTLX_THEME_PREF__: 'dark' } });
  live.T.setPreference(code, { persist: false });
  live.serve();
  assert.equal(live.T.current(), 'custom:sand');
  live.T.setPreference('mtlx2.nope', { persist: false });
  assert.equal(live.T.current(), 'dark');
});

test('a code whose colors cannot reach AA shows its base theme', () => {
  const code = forge({ base: 0x2c, seeds: [0x80, 0x80, 0x80, 0x88, 0x88, 0x88, 0x20, 0x40, 0xc0], slug: 'flat', label: 'Flat' });
  const p = page({ parsing: true, dark: true, globals: { __MTLX_THEME_NO_PERSIST__: true, __MTLX_THEME_PREF__: code } });
  assert.equal(p.T.current(), 'light');
  assert.equal(p.style('custom:flat'), undefined);
});

test('bindEmbed passes a custom theme to <materialx-viewer> as its code', async () => {
  const p = page();
  await p.call(() => p.T.saveCustom(SPEC));
  p.T.setPreference('custom:ocean');
  const el = {};
  p.T.bindEmbed(el);
  assert.equal(el.theme, p.T.encodeTheme(SPEC));
  p.T.setPreference('system');
  assert.equal(el.theme, 'auto');
});

test('getTokenGroups loads labelled groups covering every token once', async () => {
  const p = page();
  const g = await p.call(() => p.T.getTokenGroups());
  assert.deepEqual(plain(g), plain(groupsGen));
  const ids = g.flatMap((x) => x.tokens.map((t) => t.id));
  assert.deepEqual(plain(ids).sort(), TOKENS.slice().sort());
  for (const x of g) {
    assert.ok(x.label && x.group);
    for (const t of x.tokens) assert.ok(typeof t.label === 'string' && t.label.length > 0 && t.label.length <= 40, t.id);
  }
  assert.equal(g[0].group, 'surface');
  assert.equal(g[0].tokens[0].label, 'Page background');
  g[0].label = 'mutated';
  assert.equal((await p.T.getTokenGroups())[0].label, 'Surfaces', 'callers get copies');
});

test('another tab saving custom themes updates this one', async () => {
  const p = page();
  const code = p.T.encodeTheme(SPEC);
  (p.listeners.storage || []).forEach((h) => h({ key: 'mtlxCustomThemes', newValue: JSON.stringify([code]) }));
  assert.deepEqual(plain(p.T.listCustom()).map((s) => s.id), ['custom:ocean']);
  assert.equal(p.storage.getItem('mtlxCustomThemes'), null, 'not written back');
});

test('theme-custom.js loads only when needed: list() uses cached labels, hosts get labels once it loads', async () => {
  const code = page().T.encodeTheme(SPEC);
  const entry = { code, id: 'custom:ocean', label: 'Ocean', base: 'dark' };
  const ext = (q) => q.document.log.concat(q.document.head.children.map((el) => el.src || '')).some((h) => /theme-custom.js/.test(h));

  // Web, custom themes saved but a preset active: nothing extra before first paint, labels come from the store.
  const p = page({ parsing: true, custom: false, storage: makeStorage({ mtlxCustomThemes: JSON.stringify([entry]), mtlxTheme: 'paper' }) });
  assert.equal(ext(p), false);
  assert.deepEqual(plain(p.T.list().filter((e) => e.group === 'custom')), [{ id: 'custom:ocean', label: 'Ocean', base: 'dark', group: 'custom', contrast: 'AA' }]);
  assert.equal(ext(p), false, 'labelled entries need no decoding');
  assert.equal(p.ctx.MtlxThemeEngine, undefined);
  assert.throws(() => p.T.decodeTheme(code), /still loading/);
  const seen = p.events('mtlx-custom-themes-change');
  assert.deepEqual(plain(p.T.listCustom()), []);
  p.serve();
  assert.equal(seen.length, 1, 'loading theme-custom.js announces the list');
  assert.equal(p.T.decodeTheme(code).id, 'custom:ocean');
  assert.deepEqual(plain(p.T.listCustom()).map((x) => x.id), ['custom:ocean']);

  // Host-injected codes have no labels: list() loads theme-custom.js and the change event follows.
  const h = page({ custom: false, globals: { __MTLX_CUSTOM_THEMES__: [code], __mtlxCustomThemesPersist() {} } });
  const hs = h.events('mtlx-custom-themes-change');
  assert.equal(h.T.list().filter((e) => e.group === 'custom').length, 0);
  h.serve();
  assert.equal(hs.length, 1);
  assert.deepEqual(plain(h.T.list().filter((e) => e.group === 'custom').map((e) => e.label)), ['Ocean é 🌊']);

  // setPreference to a custom id before the module is in loads it, then applies.
  const s = page({ custom: false, storage: makeStorage({ mtlxCustomThemes: JSON.stringify([entry]) }) });
  s.T.setPreference('custom:ocean');
  s.serve();
  assert.equal(s.T.current(), 'custom:ocean');
  assert.equal(s.storage.getItem('mtlxTheme'), 'custom:ocean');

  // A malformed cached entry is never listed; it marks the store for decoding instead.
  const m = page({ custom: false, storage: makeStorage({ mtlxCustomThemes: JSON.stringify([{ id: 'custom:x', label: '<b>', base: 'dark' }]) }) });
  assert.equal(m.T.list().filter((e) => e.group === 'custom').length, 0);

  // No custom themes at all: a pending custom preference loads nothing.
  const n = page({ parsing: true, custom: false, storage: makeStorage({ mtlxTheme: 'custom:ocean' }) });
  assert.equal(ext(n), false);
  assert.equal(n.T.current(), 'dark');
});

// ---- Themes based on a built-in theme (from) ----
const BUILTIN = {
  dark: { base: 'dark', level: 'AA' }, light: { base: 'light', level: 'AA' }, 'hc-dark': { base: 'dark', level: 'AAA' },
  'hc-light': { base: 'light', level: 'AAA' }, dim: { base: 'dark', level: 'AA' }, paper: { base: 'light', level: 'AA' },
};
const builtinMap = (id) => (id === 'dark' ? data.themes.dark : id === 'light' ? { ...data.themes.dark, ...data.themes.light } : require('../../js/gen/themes/' + id + '.js').tokens);
const fromSpec = (id, extra = {}) => ({ id: 'custom:from-' + id, label: 'From ' + id, base: BUILTIN[id].base, from: id, ...extra });

test('from-based codes round trip, start with the base character and carry no seeds or modifier bytes', () => {
  const { T } = page();
  const code = T.encodeTheme(PAPER);
  assert.match(code, /^mtlx2\.L/);
  assert.match(T.encodeTheme(fromSpec('hc-dark')), /^mtlx2\.D/);
  const back = plain(T.decodeTheme(code));
  assert.deepEqual(back, { v: 1, id: 'custom:warm', label: 'Warm paper', base: 'light', from: 'paper', overrides: { 'fg-muted': '#4a4540' } });
  assert.equal(T.encodeTheme(back), code);
  const bare = T.encodeTheme(fromSpec('dim'));
  assert.deepEqual(plain(T.decodeTheme(bare)), { v: 1, id: 'custom:from-dim', label: 'From dim', base: 'dark', from: 'dim', overrides: {} });
  assert.ok(bare.length < T.encodeTheme(SPEC).length, 'no seed bytes');
  for (const id of Object.keys(BUILTIN)) assert.equal(T.decodeTheme(T.encodeTheme(fromSpec(id))).from, id);
  // The seeds mode still round trips beside it, with and without overrides and modifiers.
  for (const spec of [SPEC, LIGHT, { ...LIGHT, modifiers: { contrast: 0.5, tint: 0.25 } }, { ...SPEC, overrides: {} }]) {
    assert.equal(T.encodeTheme(T.decodeTheme(T.encodeTheme(spec))), T.encodeTheme(spec));
    assert.equal(T.decodeTheme(T.encodeTheme(spec)).from, undefined);
  }
});

test('either from or seeds: forged and API-built mixes are rejected', () => {
  const { T } = page();
  rejects(T, () => T.encodeTheme({ ...PAPER, seeds: LIGHT.seeds }), /no seeds/);
  rejects(T, () => T.encodeTheme({ ...PAPER, modifiers: { tint: 0.5 } }), /no modifiers/);
  rejects(T, () => T.encodeTheme({ ...PAPER, modifiers: {} }), /no modifiers/);
  rejects(T, () => T.encodeTheme({ ...PAPER, from: 'vscode' }), /built-in/);
  rejects(T, () => T.encodeTheme({ ...PAPER, from: 'custom:ocean' }), /built-in/);
  rejects(T, () => T.encodeTheme({ ...PAPER, from: 'nope' }), /Unknown base theme "nope"/);
  rejects(T, () => T.encodeTheme({ ...PAPER, from: 5 }), /built-in/);
  rejects(T, () => T.encodeTheme({ ...PAPER, base: 'dark' }), /Base does not match/);
  // Forged bytes: seeds after a from id, modifier bytes after a from-based theme, from naming a bad theme, a bad base.
  rejects(T, () => T.decodeTheme(forge({ base: 0x2c, from: 'paper', seeds: SEEDS9 })), /damaged|Theme id|Name/i);
  rejects(T, () => T.decodeTheme(forge({ base: 0x2c, from: 'paper', tail: [20, 0] })), /damaged/i);
  rejects(T, () => T.decodeTheme(forge({ base: 0x2c, from: 'paper', tail: [1] })), /damaged/i);
  rejects(T, () => T.decodeTheme(forge({ from: 'vscode' })), /built-in/);
  rejects(T, () => T.decodeTheme(forge({ from: 'custom:x' })), /built-in/);
  rejects(T, () => T.decodeTheme(forge({ from: 'nope' })), /Unknown base theme "nope"/);
  rejects(T, () => T.decodeTheme(forge({ from: '<script>alert(1)</script>-padding-padding' })), /Unknown base theme "\?script\?alert\?1\?\?\?script"/);
  rejects(T, () => T.decodeTheme(forge({ base: 0x0c, from: 'paper' })), /Base does not match/);
  rejects(T, () => T.decodeTheme(forge({ base: 0x2c, from: 'dark' })), /Base does not match/);
  rejects(T, () => T.decodeTheme('mtlx2.' + 'A'.repeat(8200)), /too long/);
  assert.equal(T.decodeTheme(forge({ base: 0x2c, from: 'paper' })).from, 'paper');
});

test('a from-based code resolves to the exact map of its built-in theme', async () => {
  for (const id of Object.keys(BUILTIN)) {
    const p = page();
    const code = p.T.encodeTheme(fromSpec(id));
    const r = await p.call(() => p.T.resolveCustomTheme(code));
    assert.equal(r.ok, true, id + ': ' + r.error);
    assert.deepEqual(plain(r.tokens), plain(builtinMap(id)), id);
    assert.deepEqual(plain(r.adjusted), [], id);
    assert.ok(r.report.length > 50 && r.report.every((x) => x.pass), id);
    if (id !== 'dark' && id !== 'light') assert.deepEqual(plain(r.params), plain(require('../../js/gen/themes/' + id + '.js').params), id + ' params');
    const o = await p.call(() => p.T.resolveCustomTheme(fromSpec(id, { overrides: { focus: builtinMap(id).focus } })));
    assert.deepEqual(plain(o.tokens), plain(builtinMap(id)), id + ' with an override at its current value');
  }
  const p = page();
  await assert.rejects(p.T.resolveCustomTheme('mtlx2.nope'), /Damaged|Not a theme/);
  const seeded = await p.call(() => p.T.resolveCustomTheme(SPEC));
  assert.equal(seeded.ok, true);
  assert.equal(seeded.tokens['surface-base'], '#0b1d2a');
  const draft = await p.call(() => p.T.resolveCustomTheme({ base: 'dark', from: 'dim', overrides: { focus: '#ff00aa' } }));
  assert.equal(draft.tokens.focus, '#ff00aa');
  assert.equal(draft.tokens['surface-base'], builtinMap('dim')['surface-base']);
});

test('saving and applying a from-based theme: level follows the base theme, nothing is re-derived', async () => {
  const p = page();
  const r = await p.call(() => p.T.saveCustom(PAPER));
  assert.equal(r.ok, true, r.error);
  await p.call(() => p.T.saveCustom(fromSpec('hc-dark')));
  const lv = Object.fromEntries(p.T.list().filter((e) => e.group === 'custom').map((e) => [e.id, e.contrast]));
  assert.deepEqual(lv, { 'custom:warm': 'AA', 'custom:from-hc-dark': 'AAA' });
  p.T.setPreference('custom:from-hc-dark');
  assert.equal(p.T.current(), 'custom:from-hc-dark');
  assert.deepEqual(plain(p.ctx.MTLX_THEME_TOKENS.themes['custom:from-hc-dark']), plain(builtinMap('hc-dark')));
  assert.equal(JSON.parse(p.storage.getItem('mtlxCustomThemes'))[0].base, 'light');
});

test('an embed applies a Paper-based code before first paint', () => {
  const p0 = page();
  const code = p0.T.encodeTheme(PAPER);
  const p = page({ parsing: true, dark: true, globals: { __MTLX_THEME_NO_PERSIST__: true, __MTLX_THEME_PREF__: code } });
  const written = p.document.log.filter((h) => h.startsWith('<script')).map((h) => /src="([^"]+)"/.exec(h)[1].replace(PAGE, ''));
  assert.deepEqual(written, ['js/shared/theme-custom.js', 'js/gen/theme-pairs.js', 'js/shared/theme-engine.js', 'js/gen/themes/paper.js']);
  assert.equal(p.document.head.children.filter((el) => el.tagName === 'script').length, 0, 'nothing loaded after parsing');
  assert.equal(p.T.current(), 'custom:warm');
  assert.equal(p.document.documentElement.dataset.theme, 'custom:warm');
  assert.equal(p.document.documentElement.dataset.themeBase, 'light');
  const expected = { ...builtinMap('paper'), 'fg-muted': '#4a4540' };
  assert.equal(p.T.get('surface-base'), expected['surface-base']);
  assert.equal(p.T.get('fg-muted'), '#4a4540');
  assert.ok(p.style('custom:warm'));
  assert.deepEqual(plain(p.ctx.MTLX_THEME_TOKENS.themes['custom:warm']), plain(expected));
  assert.deepEqual(plain(p.ctx.MTLX_THEME_TOKENS.params['custom:warm']), plain(require('../../js/gen/themes/paper.js').params));
  assert.equal(p.storage.m.size, 0);
});

test('stored version 1 codes are skipped with one warning', () => {
  const warns = [];
  const console = { warn: (m) => warns.push(String(m)), log() {}, error() {} };
  const p0 = page();
  const v2 = p0.T.encodeTheme(SPEC);
  const v1 = 'mtlx1.' + v2.slice(6);
  const web = page({ globals: { console }, storage: makeStorage({ mtlxCustomThemes: JSON.stringify([{ code: v1, id: 'custom:old', label: 'Old', base: 'dark' }, { code: v1, id: 'custom:old2', label: 'Old 2', base: 'dark' }, { code: v2, id: 'custom:ocean', label: 'Ocean', base: 'dark' }]) }) });
  assert.deepEqual(plain(web.T.listCustom()).map((x) => x.id), ['custom:ocean']);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /older version/);
  warns.length = 0;
  const host = page({ globals: { console, __MTLX_CUSTOM_THEMES__: [v1, v2], __mtlxCustomThemesPersist() {} } });
  assert.deepEqual(plain(host.T.listCustom()).map((x) => x.id), ['custom:ocean']);
  assert.equal(warns.length, 1);
});
