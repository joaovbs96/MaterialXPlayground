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
const meta = await import('../../scripts/theme-tokens-meta.mjs');
const SRC = ['theme-tokens.js', 'theme.js'].map((f) => path.join(root, 'js', 'shared', f));
const PAGE = 'https://example.test/site/';

// VS Code palettes: editor background, editor foreground, button background, focus border, kind.
const PALETTES = {
  'Dark Modern': { kind: 'dark', classes: ['vscode-dark'], vars: { '--vscode-editor-background': '#1f1f1f', '--vscode-editor-foreground': '#cccccc', '--vscode-button-background': '#0078d4', '--vscode-focusBorder': '#0078d4' } },
  'Light Modern': { kind: 'light', classes: ['vscode-light'], vars: { '--vscode-editor-background': '#ffffff', '--vscode-editor-foreground': '#3b3b3b', '--vscode-button-background': '#005fb8', '--vscode-focusBorder': '#005fb8' } },
  'Monokai': { kind: 'dark', classes: ['vscode-dark'], vars: { '--vscode-editor-background': '#272822', '--vscode-editor-foreground': '#f8f8f2', '--vscode-button-background': '#75715e', '--vscode-focusBorder': '#99947c' } },
  'Solarized Light': { kind: 'light', classes: ['vscode-light'], vars: { '--vscode-editor-background': '#fdf6e3', '--vscode-editor-foreground': '#657b83', '--vscode-button-background': '#ac9d57', '--vscode-focusBorder': '#b49471' } },
};
const HC_VARS = { '--vscode-editor-background': '#000000', '--vscode-editor-foreground': '#ffffff', '--vscode-button-background': '#000000', '--vscode-focusBorder': '#f38518' };

function makeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m };
}

// Fake webview page: <html style> vars, body classes, MutationObserver, timers, document.write. `parsing` runs the
// head scripts parser-inserted; serve() delivers written and appended scripts (presets, the source, the engine).
function load({ vscode = true, pref = 'vscode', kind, vars = {}, classes = [], body = true, parsing = true, computed = true, dark = true, storage = makeStorage() } = {}) {
  const listeners = {};
  const docListeners = {};
  const observers = [];
  const timers = [];
  const cssVars = new Map(Object.entries(vars));
  const bodyClasses = new Set(classes);
  const meta = { content: '', setAttribute(k, v) { if (k === 'content') this.content = v; } };
  const mqlHandlers = [];
  const mql = { matches: dark, addEventListener: (t, h) => { if (t === 'change') mqlHandlers.push(h); } };
  const html = { dataset: {}, style: { getPropertyValue: (n) => cssVars.get(n) || '' }, appendChild() { throw new Error('style must go to head'); } };
  const makeBody = () => ({ classList: { contains: (c) => bodyClasses.has(c) } });
  const document = {
    documentElement: html,
    body: body ? makeBody() : null,
    querySelector: (s) => (s === 'meta[name="theme-color"]' ? meta : null),
    addEventListener: (t, h) => { (docListeners[t] = docListeners[t] || []).push(h); },
    // js/shared/theme-custom.js (custom themes) is kept apart in `ext` so preset assertions stay exact; serve() runs it.
    ext: [],
    head: { children: [], appendChild(el) { if (/theme-custom.js$/.test(el.src || '')) document.ext.push(el); else this.children.push(el); } },
    createElement: (tag) => ({ tagName: tag, async: tag === 'script', textContent: '' }),
    readyState: parsing ? 'loading' : 'complete',
    currentScript: null,
    written: [],
    log: [],
    write(h) { if (/theme-custom.js/.test(h)) this.ext.push({ src: /src="([^"]+)"/.exec(h)[1], async: false }); else { this.written.push(h); this.log.push(h); } },
  };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  class MutationObserver {
    constructor(cb) { this.cb = cb; this.targets = []; observers.push(this); }
    observe(target, opts) { this.targets.push({ target, opts }); }
  }
  const globals = { __MTLX_THEME_PREF__: pref };
  if (vscode) globals.__MTLX_VSCODE__ = true;
  if (kind) globals.__MTLX_VSCODE_THEME_KIND__ = kind;
  const context = {
    console: { warn() {}, log() {}, error() {} },
    document,
    localStorage: storage,
    CustomEvent,
    MutationObserver,
    matchMedia: () => mql,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    addEventListener: (t, h) => { (listeners[t] = listeners[t] || []).push(h); },
    removeEventListener: (t, h) => { listeners[t] = (listeners[t] || []).filter((x) => x !== h); },
    dispatchEvent: (e) => { (listeners[e.type] || []).slice().forEach((h) => h(e)); return true; },
    ...globals,
  };
  if (computed) context.getComputedStyle = (el) => ({ getPropertyValue: (n) => (el === html ? ' ' + (cssVars.get(n) || '') : '') });
  context.self = context;
  vm.createContext(context);
  for (const file of SRC) {
    document.currentScript = parsing ? { src: PAGE + 'js/shared/' + path.basename(file), async: false } : null;
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  document.currentScript = null;
  const run = (src, async) => {
    const file = path.join(root, src.replace(PAGE, '').replace(/[?#].*$/, ''));
    document.currentScript = { src, async };
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    document.currentScript = null;
  };
  const fire = (target) => observers.forEach((o) => { if (o.targets.some((t) => t.target === target)) o.cb([]); });
  const page = {
    T: context.MtlxTheme,
    ctx: context,
    document,
    html,
    meta,
    timers,
    serve() {
      for (let guard = 0; guard < 10; guard++) {
        let progressed = false;
        while (document.ext.length) { const el = document.ext.shift(); run(el.src, el.async); progressed = true; }
        while (document.written.length) {
          const h = document.written.shift();
          for (const m of h.matchAll(/<script src="([^"]+)"/g)) { run(m[1], false); progressed = true; }
        }
        for (const el of document.head.children) {
          if (el.served || el.tagName === 'style') continue;
          el.served = progressed = true;
          if (el.tagName === 'script') run(el.src, el.async);
          else if (el.onload) el.onload();
        }
        if (!progressed) return;
      }
    },
    flush() { while (timers.length) timers.shift()(); },
    style() { return document.head.children.find((el) => el.tagName === 'style'); },
    // VS Code rewrites the <html> style vars and the body class together on a theme change.
    setTheme(nextVars, nextClasses) {
      cssVars.clear();
      Object.entries(nextVars).forEach(([k, v]) => cssVars.set(k, v));
      if (nextClasses) { bodyClasses.clear(); nextClasses.forEach((c) => bodyClasses.add(c)); }
      fire(html);
      if (document.body) fire(document.body);
    },
    createBody(list) {
      bodyClasses.clear();
      list.forEach((c) => bodyClasses.add(c));
      document.body = makeBody();
      (docListeners.DOMContentLoaded || []).forEach((h) => h());
    },
    setSystemDark(v) { mql.matches = v; mqlHandlers.forEach((h) => h({ matches: v })); },
  };
  return page;
}

const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));

function record(T) {
  const seen = [];
  T.onChange((e) => seen.push(e));
  return seen;
}

const derivedMap = (p) => p.ctx.MTLX_THEME_TOKENS.themes.vscode;
const derivedParams = (p) => p.ctx.MTLX_THEME_TOKENS.params.vscode;

function assertAA(map, params, label) {
  for (const pair of meta.contrast) {
    const need = E.LEVELS.AA[pair.kind];
    if (!need) continue;
    const r = E.measurePair(map, pair, params);
    assert.ok(r >= need, `${label}: ${pair.fg}|${pair.bg} ${r.toFixed(2)} < ${need}`);
  }
}

for (const [name, pal] of Object.entries(PALETTES)) {
  test(`${name}: derived before first paint, full map, AA, right base`, () => {
    const p = load({ kind: pal.kind, vars: pal.vars, body: false });
    const seen = record(p.T);
    assert.equal(p.T.current(), pal.kind, 'the base paints until the source ran, never the opposite base');
    assert.equal(p.document.log[0], '<script src="' + PAGE + 'js/gen/themes/vscode.js"></script>');
    p.serve();
    assert.equal(p.document.log[1], '<script src="' + PAGE + 'js/shared/theme-engine.js"></script>');
    assert.equal(p.timers.length, 0, 'the first derivation is synchronous');
    assert.equal(p.T.current(), 'vscode');
    assert.equal(p.T.currentBase(), pal.kind);
    assert.equal(p.html.dataset.theme, 'vscode');
    assert.equal(p.html.dataset.themeBase, pal.kind);
    const map = derivedMap(p);
    same(Object.keys(map), Object.keys(data.themes.dark));
    assert.ok(Object.values(map).every((v) => /^#[0-9a-f]{6}$/.test(v)));
    assert.equal(map['surface-base'], pal.vars['--vscode-editor-background']);
    assert.equal(p.T.get('surface-base'), pal.vars['--vscode-editor-background']);
    assert.equal(p.meta.content, pal.vars['--vscode-editor-background']);
    assertAA(map, derivedParams(p), name);
    // Status hues and params come from the base theme; type colors too, unless the contrast pass had to move them.
    for (const t of ['success-hue', 'warning-hue', 'error-hue', 'experimental-hue', 'brand-logo-inner']) assert.equal(map[t], data.themes[pal.kind][t], t);
    assert.equal(p.T.typeFallback().lightness, data.params[pal.kind].typeFallback.lightness);
    const s = E.readVscode(p.ctx);
    const r = E.deriveVscode(s, { pairs: meta.contrast, overrides: meta.sources.vscode.overrides });
    same(r.tokens, map);
    assert.equal(r.fallback, 0, 'the editor colors were used');
    for (const t of Object.keys(map).filter((k) => k.startsWith('type-') && !r.moved[k])) assert.equal(map[t], data.themes[pal.kind][t], t);
    const css = p.style().textContent;
    assert.ok(css.startsWith(':root[data-theme="vscode"] {\n  --mtlx-surface-base: '));
    assert.equal(css, E.themeCss('vscode', map, derivedParams(p), Object.keys(data.themes.dark)));
    assert.equal(p.document.head.children.filter((el) => el.tagName === 'style').length, 1);
    assert.equal(JSON.stringify(seen), JSON.stringify([{ theme: 'vscode', base: pal.kind, preference: 'vscode' }]));
  });
}

test('seeds: editor background and foreground, button background, the documented fallbacks, alpha', () => {
  const s = (vars, extra) => E.readVscode(load({ vars, parsing: false, ...extra }).ctx);
  assert.equal(s({}), null);
  const a = s({ '--vscode-editor-background': '#1F1F1F', '--vscode-foreground': '#cccccc', '--vscode-focusBorder': '#0078d4' }, { classes: ['vscode-dark'] });
  assert.equal(a.background, '#1f1f1f');
  assert.equal(a.foreground, '#cccccc', 'falls back to --vscode-foreground');
  assert.equal(a.accent, '#0078d4', 'falls back to --vscode-focusBorder');
  const b = s({ '--vscode-editor-background': '#ffffff', '--vscode-textLink-foreground': '#006ab1' }, { computed: false });
  assert.equal(b.accent, '#006ab1', 'then --vscode-textLink-foreground; <html style> read without getComputedStyle');
  assert.equal(b.foreground, null);
  assert.equal(b.base, 'light', 'no class and no kind: by background luminance');
  const c = s({ '--vscode-editor-background': '#1e1e1e', '--vscode-button-background': '#0e639c80' }, { classes: ['vscode-dark'] });
  assert.equal(c.accent, E.composite('#0e639c', '#1e1e1e', 128 / 255), 'alpha composites over the background');
  assert.equal(E.parseCssColor('rgb(1, 2, 3)'), '#010203');
  assert.equal(E.parseCssColor('rgba(255 255 255 / 50%)', '#000000'), '#808080');
  assert.equal(E.parseCssColor('#abc'), '#aabbcc');
  assert.equal(E.parseCssColor('var(--x)'), null);
  assert.equal(s({ '--vscode-editor-background': '#fdf6e3' }, { classes: ['vscode-dark'] }).base, 'dark', 'the body class wins over luminance');
  assert.equal(s({ '--vscode-editor-background': '#1e1e1e' }, { body: false, kind: 'light' }).base, 'light', 'the injected kind before the body exists');
});

test('focus comes from --vscode-focusBorder and the contrast pass still runs on it', () => {
  const p = load({ kind: 'dark', vars: { ...PALETTES['Dark Modern'].vars, '--vscode-focusBorder': '#2a2a2a' } });
  p.serve();
  const map = derivedMap(p);
  assert.notEqual(map.focus, '#2a2a2a', 'too dark on the ground: lifted');
  assert.ok(E.contrast(map.focus, map['surface-base']) >= 3);
  const q = load({ kind: 'dark', vars: PALETTES['Dark Modern'].vars });
  q.serve();
  assert.equal(derivedMap(q).focus, '#0078d4');
});

for (const [kind, cls, id, base] of [['highContrast', 'vscode-high-contrast', 'hc-dark', 'dark'], ['highContrastLight', 'vscode-high-contrast-light', 'hc-light', 'light']]) {
  test(`high contrast (${kind}) resolves to ${id}, never derives`, () => {
    const p = load({ kind, vars: HC_VARS, body: false });
    assert.equal(p.T.current(), base);
    p.serve();
    assert.equal(p.T.current(), id);
    assert.equal(p.T.currentBase(), base);
    assert.equal(p.style(), undefined);
    assert.ok(!p.document.log.some((h) => h.includes('vscode.js')));
    const map = { ...data.themes.dark, ...p.ctx.MTLX_THEME_TOKENS.themes[id] };
    for (const pair of meta.contrast) {
      const need = E.LEVELS.AAA[pair.kind];
      if (need) assert.ok(E.measurePair(map, pair, p.ctx.MTLX_THEME_TOKENS.params[id]) >= need, `${pair.fg}|${pair.bg}`);
    }
    const q = load({ vars: HC_VARS, classes: [cls, 'vscode-dark'] });
    q.serve();
    assert.equal(q.T.current(), id, 'the body class also maps');
  });
}

test('live: a VS Code theme change re-derives once, debounced, and fires onChange once', () => {
  const p = load({ kind: 'dark', vars: PALETTES['Dark Modern'].vars, classes: ['vscode-dark'] });
  p.serve();
  const seen = record(p.T);
  const before = derivedMap(p);
  p.setTheme(PALETTES['Light Modern'].vars, ['vscode-light']);
  p.setTheme(PALETTES['Light Modern'].vars, ['vscode-light']);
  assert.equal(p.timers.length, 1, 'one debounced re-derivation');
  assert.equal(derivedMap(p), before);
  p.flush();
  assert.equal(p.T.current(), 'vscode');
  assert.equal(p.T.currentBase(), 'light');
  assert.equal(p.html.dataset.themeBase, 'light');
  assert.equal(p.T.get('surface-base'), '#ffffff');
  assert.equal(p.T.typeFallback().lightness, 34);
  assert.ok(p.style().textContent.includes('--mtlx-surface-base: 255 255 255;'));
  assert.equal(JSON.stringify(seen), JSON.stringify([{ theme: 'vscode', base: 'light', preference: 'vscode' }]));
  p.setTheme(PALETTES['Light Modern'].vars, ['vscode-light']);
  p.flush();
  assert.equal(seen.length, 1, 'unchanged seeds and kind: no re-derivation, no event');
  p.setTheme(PALETTES['Solarized Light'].vars, ['vscode-light']);
  p.flush();
  assert.equal(seen.length, 2);
  assertAA(derivedMap(p), derivedParams(p), 'Solarized Light live');
});

test('live: high contrast and back while following VS Code', () => {
  const p = load({ kind: 'dark', vars: PALETTES['Dark Modern'].vars, classes: ['vscode-dark'] });
  p.serve();
  p.setTheme(HC_VARS, ['vscode-high-contrast']);
  p.serve();
  p.flush();
  assert.equal(p.T.current(), 'hc-dark');
  p.setTheme(PALETTES.Monokai.vars, ['vscode-dark']);
  p.flush();
  assert.equal(p.T.current(), 'vscode');
  assert.equal(derivedMap(p)['surface-base'], '#272822');
});

test('vars not set yet: the injected base paints, then one observer pass derives', () => {
  const p = load({ kind: 'light', vars: {}, body: false });
  p.serve();
  assert.equal(p.T.current(), 'light');
  assert.equal(p.html.dataset.themeBase, 'light');
  assert.equal(p.style(), undefined);
  const seen = record(p.T);
  p.setTheme(PALETTES['Solarized Light'].vars);
  assert.equal(p.timers.length, 0);
  assert.equal(p.T.current(), 'vscode');
  assert.equal(p.T.currentBase(), 'light');
  assert.equal(seen.length, 1);
  p.createBody(['vscode-light']);
  p.flush();
  assert.equal(seen.length, 1, 'the body appearing with the same kind changes nothing');
});

test('switching to vscode after boot loads the source and the engine on demand', () => {
  const p = load({ pref: 'dark', kind: 'dark', vars: PALETTES.Monokai.vars, classes: ['vscode-dark'], parsing: false });
  const seen = record(p.T);
  assert.equal(p.document.head.children.length, 0, 'the engine is not loaded for other preferences');
  p.T.setPreference('vscode');
  assert.equal(p.T.current(), 'dark');
  assert.equal(p.document.head.children[0].src, 'js/gen/themes/vscode.js');
  p.serve();
  assert.equal(p.document.head.children[1].src, 'js/shared/theme-engine.js');
  assert.equal(p.T.current(), 'vscode');
  assert.equal(p.T.get('surface-base'), '#272822');
  assert.equal(JSON.stringify(seen), JSON.stringify([{ theme: 'vscode', base: 'dark', preference: 'vscode' }]));
  p.T.setPreference('light');
  p.T.setPreference('vscode');
  assert.equal(p.T.current(), 'vscode', 'derived once, applied at once');
  assert.equal(p.document.head.children.filter((el) => el.tagName === 'script').length, 2);
});

test('outside VS Code: vscode behaves as system and list() hides it', () => {
  const p = load({ vscode: false, pref: 'vscode', dark: false, vars: PALETTES['Dark Modern'].vars });
  assert.equal(p.T.getPreference(), 'vscode');
  assert.equal(p.T.current(), 'light');
  p.setSystemDark(true);
  assert.equal(p.T.current(), 'dark');
  p.serve();
  assert.equal(p.document.log.length, 0);
  assert.equal(p.document.head.children.length, 0, 'no source, no engine');
  assert.equal(p.ctx.MtlxThemeEngine, undefined);
  assert.ok(!p.T.list().some((e) => e.id === 'vscode'));
  assert.equal(p.T.list()[0].id, 'light');
  const q = load({ vscode: false, pref: 'light', dark: true, parsing: false });
  const seen = record(q.T);
  q.T.setPreference('vscode');
  assert.equal(q.T.current(), 'dark');
  assert.equal(JSON.stringify(seen), JSON.stringify([{ theme: 'dark', base: 'dark', preference: 'vscode' }]));
});

test('in VS Code: list() offers vscode first; only it carries hosts', () => {
  const p = load({ pref: 'dark', parsing: false });
  const list = p.T.list();
  assert.equal(JSON.stringify(list[0]), JSON.stringify({ id: 'vscode', label: 'Match VS Code', base: 'auto', group: 'standard', contrast: 'AA', hosts: ['vscode'] }));
  assert.ok(list.slice(1).every((e) => !('hosts' in e)));
  same(list.map((e) => e.id), data.registry.map((e) => e.id));
  assert.equal(data.registry[0].id, 'vscode');
});

test('fallbacks: an unusable accent falls back to the base accent, every result passes AA', () => {
  const s = { background: '#777777', foreground: '#ffffff', accent: '#777777', focus: null, base: 'dark', hc: false };
  const r = E.deriveVscode(s, { pairs: meta.contrast, overrides: meta.sources.vscode.overrides });
  assert.ok(r.report.every((x) => x.pass));
  for (const base of ['dark', 'light']) {
    const b = E.deriveVscode({ base, hc: false }, { pairs: meta.contrast, overrides: meta.sources.vscode.overrides });
    assert.ok(b.report.every((x) => x.pass), `${base} base seeds pass AA with the source overrides`);
  }
});

test('the generated source carries the meta pairs and overrides', () => {
  const gen = require('../../js/gen/themes/vscode.js');
  assert.equal(gen.id, 'vscode');
  assert.deepEqual(gen.source.pairs, meta.contrast);
  assert.deepEqual(gen.source.overrides, meta.sources.vscode.overrides);
  assert.equal(gen.source.contrast, data.registry.find((e) => e.id === 'vscode').contrast);
});

test('themeCss matches the build format of a generated preset', () => {
  const gen = require('../../js/gen/themes/hc-dark.js');
  const css = fs.readFileSync(path.join(root, 'js', 'gen', 'themes', 'hc-dark.css'), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(css.endsWith(E.themeCss('hc-dark', gen.tokens, gen.params, Object.keys(data.themes.dark))));
});
