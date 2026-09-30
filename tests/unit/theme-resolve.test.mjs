import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = ['theme-tokens.js', 'theme.js'].map((f) => {
  const file = path.join(root, 'js', 'shared', f);
  return { file, code: fs.readFileSync(file, 'utf8') };
});

function makeStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m };
}

const PAGE = 'https://example.test/site/';

// One fake page. `storage` can be shared between pages to model a reload. `parsing` runs theme.js as a
// parser-inserted head script (document.write allowed); serve() then delivers requested preset files.
function load({ storage = makeStorage(), dark = true, globals = {}, body = true, classes = [], parsing = false } = {}) {
  const listeners = {};
  const observers = [];
  const bodyClasses = new Set(classes);
  const meta = { content: '', setAttribute(k, v) { if (k === 'content') this.content = v; } };
  const mqlHandlers = [];
  const mql = { matches: dark, addEventListener: (t, h) => { if (t === 'change') mqlHandlers.push(h); } };
  const docListeners = {};
  const document = {
    documentElement: { dataset: {} },
    body: body ? { classList: { contains: (c) => bodyClasses.has(c) } } : null,
    querySelector: (s) => (s === 'meta[name="theme-color"]' ? meta : null),
    addEventListener: (t, h) => { (docListeners[t] = docListeners[t] || []).push(h); },
    head: { children: [], appendChild(el) { this.children.push(el); } },
    createElement: (tag) => ({ tagName: tag, async: tag === 'script' }),
    readyState: parsing ? 'loading' : 'complete',
    currentScript: null,
    written: [],
    log: [],
    write(html) { this.written.push(html); this.log.push(html); },
  };
  class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } }
  class MutationObserver { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} }
  const context = {
    console,
    document,
    localStorage: storage,
    CustomEvent,
    MutationObserver,
    matchMedia: () => mql,
    addEventListener: (t, h) => { (listeners[t] = listeners[t] || []).push(h); },
    removeEventListener: (t, h) => { listeners[t] = (listeners[t] || []).filter((x) => x !== h); },
    dispatchEvent: (e) => { (listeners[e.type] || []).slice().forEach((h) => h(e)); return true; },
    ...globals,
  };
  context.self = context;
  vm.createContext(context);
  for (const s of SRC) {
    document.currentScript = parsing ? { src: PAGE + 'js/shared/' + path.basename(s.file), async: false } : null;
    vm.runInContext(s.code, context, { filename: s.file });
  }
  document.currentScript = null;
  const runPreset = (src, async) => {
    const id = /themes\/([\w-]+)\.js$/.exec(src)[1];
    const file = path.join(root, 'js', 'gen', 'themes', id + '.js');
    document.currentScript = { src, async };
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    document.currentScript = null;
  };
  return {
    T: context.MtlxTheme,
    ctx: context,
    document,
    meta,
    storage,
    setSystemDark(v) { mql.matches = v; mqlHandlers.forEach((h) => h({ matches: v })); },
    setBody(list) {
      bodyClasses.clear();
      list.forEach((c) => bodyClasses.add(c));
      observers.forEach((o) => o.cb([]));
    },
    // Delivers written and appended preset scripts, then fires pending stylesheet loads.
    serve() {
      for (let guard = 0; guard < 10; guard++) {
        let progressed = false;
        while (document.written.length) {
          const html = document.written.shift();
          for (const m of html.matchAll(/<script src="([^"]+)"/g)) { runPreset(m[1], false); progressed = true; }
        }
        for (const el of document.head.children) {
          if (el.served) continue;
          el.served = progressed = true;
          if (el.tagName === 'script') runPreset(el.src, el.async);
          else if (el.onload) el.onload();
        }
        if (!progressed) return;
      }
    },
    createBody(list) {
      bodyClasses.clear();
      list.forEach((c) => bodyClasses.add(c));
      document.body = { classList: { contains: (c) => bodyClasses.has(c) } };
      (docListeners.DOMContentLoaded || []).forEach((h) => h());
    },
  };
}

const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));

function record(T) {
  const seen = [];
  T.onChange((e) => seen.push(e));
  return seen;
}

test('default is system and follows matchMedia live', () => {
  const p = load({ dark: true });
  const seen = record(p.T);
  assert.equal(p.T.getPreference(), 'system');
  assert.equal(p.T.current(), 'dark');
  assert.equal(p.document.documentElement.dataset.theme, 'dark');
  assert.equal(p.meta.content, '#111827');
  p.setSystemDark(false);
  assert.equal(p.T.current(), 'light');
  assert.equal(p.document.documentElement.dataset.theme, 'light');
  assert.equal(p.meta.content, '#f3f4f6');
  assert.equal(p.T.get('surface-base'), '#f3f4f6');
  assert.equal(p.T.typeFallback().lightness, 34);
  p.setSystemDark(true);
  assert.equal(p.T.current(), 'dark');
  assert.equal(p.T.typeFallback().lightness, 62);
  assert.equal(seen.map((e) => e.theme).join(), ['light', 'dark'].join());
});

test('missing matchMedia defaults to dark', () => {
  const p = load({ globals: { matchMedia: undefined } });
  assert.equal(p.T.current(), 'dark');
});

test('manual light persists, survives a reload and ignores system changes', () => {
  const p = load({ dark: true });
  p.T.setPreference('light');
  assert.equal(p.T.current(), 'light');
  assert.equal(p.storage.getItem('mtlxTheme'), 'light');
  p.setSystemDark(false);
  p.setSystemDark(true);
  assert.equal(p.T.current(), 'light');

  const q = load({ storage: p.storage, dark: true });
  assert.equal(q.T.getPreference(), 'light');
  assert.equal(q.T.current(), 'light');
  q.setSystemDark(true);
  assert.equal(q.T.current(), 'light');
});

test('setPreference system resumes following the system', () => {
  const p = load({ dark: true });
  p.T.setPreference('light');
  p.T.setPreference('system');
  assert.equal(p.storage.getItem('mtlxTheme'), 'system');
  assert.equal(p.T.current(), 'dark');
  p.setSystemDark(false);
  assert.equal(p.T.current(), 'light');
});

test('persist:false does not write and an installed persist hook replaces localStorage', () => {
  const p = load();
  p.T.setPreference('light', { persist: false });
  assert.equal(p.storage.getItem('mtlxTheme'), null);
  const calls = [];
  p.ctx.__mtlxThemePersist = (v) => calls.push(v);
  p.T.setPreference('dark');
  assert.equal(calls.join(), 'dark');
  assert.equal(p.storage.getItem('mtlxTheme'), null);
});

test('injected preference in an embed never persists (auto, light, dark)', () => {
  for (const [pref, expectPref, expectTheme] of [['auto', 'system', 'dark'], ['light', 'light', 'light'], ['dark', 'dark', 'dark']]) {
    const p = load({ globals: { __MTLX_THEME_PREF__: pref, __MTLX_EMBED: true } });
    assert.equal(p.T.getPreference(), expectPref);
    assert.equal(p.T.current(), expectTheme);
    p.T.setPreference('light');
    p.T.setPreference('dark');
    assert.equal(p.storage.m.size, 0);
  }
});

test('the no-persist flag blocks storage reads and writes', () => {
  const storage = makeStorage();
  storage.setItem('mtlxTheme', 'light');
  const p = load({ storage, globals: { __MTLX_THEME_NO_PERSIST__: true } });
  assert.equal(p.T.getPreference(), 'system');
  p.T.setPreference('dark');
  assert.equal(storage.getItem('mtlxTheme'), 'light');
});

test('an injected preference wins over the stored one', () => {
  const storage = makeStorage();
  storage.setItem('mtlxTheme', 'dark');
  const p = load({ storage, globals: { __MTLX_THEME_PREF__: 'light' } });
  assert.equal(p.T.current(), 'light');
});

test('a storage event from another tab is followed without writing back', () => {
  const p = load();
  const seen = record(p.T);
  p.ctx.dispatchEvent({ type: 'storage', key: 'mtlxTheme', newValue: 'light' });
  assert.equal(p.T.current(), 'light');
  assert.equal(p.T.getPreference(), 'light');
  assert.equal(p.storage.getItem('mtlxTheme'), null);
  assert.equal(seen.length, 1);
});

test('VS Code: system follows the body class live', () => {
  const p = load({ globals: { __MTLX_VSCODE__: true }, classes: ['vscode-dark'] });
  const seen = record(p.T);
  assert.equal(p.T.current(), 'dark');
  p.setBody(['vscode-light']);
  assert.equal(p.T.current(), 'light');
  p.setBody(['vscode-dark']);
  assert.equal(p.T.current(), 'dark');
  p.setBody(['vscode-light']);
  p.setBody(['vscode-high-contrast']);
  assert.equal(p.T.current(), 'light', 'the old theme stays until the preset has loaded');
  p.serve();
  assert.equal(p.T.current(), 'hc-dark');
  assert.equal(p.document.documentElement.dataset.themeBase, 'dark');
  p.setBody(['vscode-high-contrast', 'vscode-high-contrast-light']);
  p.serve();
  assert.equal(p.T.current(), 'hc-light');
  assert.equal(p.T.currentBase(), 'light');
  p.setBody(['vscode-high-contrast']);
  assert.equal(p.T.current(), 'hc-dark', 'a loaded preset applies at once');
  assert.equal(seen.map((e) => e.theme).join(), ['light', 'dark', 'light', 'hc-dark', 'hc-light', 'hc-dark'].join());
});

test('VS Code: a manual preference ignores body class changes', () => {
  const p = load({ globals: { __MTLX_VSCODE__: true }, classes: ['vscode-dark'] });
  p.T.setPreference('dark');
  p.setBody(['vscode-light']);
  assert.equal(p.T.current(), 'dark');
});

test('VS Code: the injected kind is used before the body exists', () => {
  const p = load({ body: false, globals: { __MTLX_VSCODE__: true, __MTLX_VSCODE_THEME_KIND__: 'light' } });
  assert.equal(p.T.current(), 'light');
  p.createBody(['vscode-dark']);
  assert.equal(p.T.current(), 'dark');
  p.setBody(['vscode-light']);
  assert.equal(p.T.current(), 'light');
  for (const [kind, id, base] of [['highContrastLight', 'hc-light', 'light'], ['highContrast', 'hc-dark', 'dark']]) {
    const q = load({ body: false, parsing: true, globals: { __MTLX_VSCODE__: true, __MTLX_VSCODE_THEME_KIND__: kind } });
    assert.equal(q.T.current(), base);
    q.serve();
    assert.equal(q.T.current(), id);
  }
  assert.equal(load({ body: false, globals: { __MTLX_VSCODE__: true } }).T.current(), 'dark');
});

test('onChange fires once per actual change', () => {
  const p = load({ dark: true });
  const seen = record(p.T);
  p.setSystemDark(true);
  assert.equal(seen.length, 0);
  p.T.setPreference('dark');
  assert.equal(seen.length, 1);
  assert.equal(JSON.stringify(seen[0]), JSON.stringify({ theme: 'dark', base: 'dark', preference: 'dark' }));
  p.T.setPreference('dark');
  assert.equal(seen.length, 1);
  p.T.setPreference('light');
  assert.equal(seen.length, 2);
  p.T.setPreference('bogus');
  assert.equal(seen.length, 2);
  p.setSystemDark(false);
  assert.equal(seen.length, 2);
});

test('list() is a copy of the registry and currentBase() follows the applied theme', () => {
  const p = load({ dark: false });
  const list = p.T.list();
  same(list.map((e) => e.id), ['light', 'dark', 'hc-dark', 'hc-light', 'dim', 'paper']);
  same(list.map((e) => e.base), ['light', 'dark', 'dark', 'light', 'dark', 'light']);
  same(list.filter((e) => e.group === 'accessibility').map((e) => e.contrast), ['AAA', 'AAA']);
  assert.ok(list.every((e) => typeof e.label === 'string' && e.label));
  list[0].id = 'mutated';
  assert.equal(p.T.list()[0].id, 'light');
  assert.equal(p.T.current(), 'light');
  assert.equal(p.T.currentBase(), 'light');
  assert.equal(p.document.documentElement.dataset.themeBase, 'light');
});

test('setPreference to a preset keeps the old theme until its files arrived, then switches and persists', () => {
  const p = load({ dark: false });
  const seen = record(p.T);
  p.T.setPreference('hc-dark');
  assert.equal(p.T.current(), 'light');
  assert.equal(p.document.documentElement.dataset.theme, 'light');
  assert.equal(p.storage.getItem('mtlxTheme'), 'hc-dark');
  assert.equal(seen.length, 0);
  const [script] = p.document.head.children;
  assert.equal(script.src, 'js/gen/themes/hc-dark.js');
  p.serve();
  const link = p.document.head.children[1];
  assert.equal(link.tagName, 'link');
  assert.equal(link.href, 'js/gen/themes/hc-dark.css');
  assert.equal(p.T.current(), 'hc-dark');
  assert.equal(p.T.currentBase(), 'dark');
  assert.equal(p.document.documentElement.dataset.theme, 'hc-dark');
  assert.equal(p.document.documentElement.dataset.themeBase, 'dark');
  assert.equal(p.T.get('surface-base'), '#000000');
  assert.equal(p.meta.content, '#000000');
  assert.equal(p.T.param('alpha', 'hudPopover', 0), 1);
  assert.equal(p.T.typeFallback().lightness, 62);
  assert.equal(JSON.stringify(seen), JSON.stringify([{ theme: 'hc-dark', base: 'dark', preference: 'hc-dark' }]));
  p.setSystemDark(true);
  assert.equal(p.T.current(), 'hc-dark');
});

test('a stored preset is document.written during head parsing and survives a reload', () => {
  const storage = makeStorage();
  storage.setItem('mtlxTheme', 'hc-light');
  const p = load({ storage, parsing: true, dark: true });
  same(p.document.log, ['<script src="' + PAGE + 'js/gen/themes/hc-light.js"></script>']);
  assert.equal(p.T.current(), 'light', 'the preset base paints until the preset script ran');
  assert.equal(p.document.documentElement.dataset.themeBase, 'light');
  p.serve();
  assert.equal(p.document.log[1], '<link rel="stylesheet" href="' + PAGE + 'js/gen/themes/hc-light.css">');
  assert.equal(p.T.current(), 'hc-light');
  assert.equal(p.T.getPreference(), 'hc-light');
  assert.equal(p.document.documentElement.dataset.theme, 'hc-light');
  assert.equal(p.T.get('surface-base'), '#ffffff');
  assert.equal(p.T.typeFallback().lightness, 34);
  assert.equal(p.document.head.children.length, 0);
});

test('a preset requested while parsing is not document.written from a later callback', () => {
  const p = load({ parsing: true, dark: true, globals: { __MTLX_VSCODE__: true }, classes: ['vscode-dark'] });
  p.setBody(['vscode-high-contrast']);
  assert.equal(p.document.log.length, 0);
  assert.equal(p.document.head.children[0].src, PAGE + 'js/gen/themes/hc-dark.js');
});

test('switching away before a preset loaded keeps the newer choice', () => {
  const p = load({ dark: true });
  p.T.setPreference('paper');
  p.T.setPreference('light');
  p.serve();
  assert.equal(p.T.current(), 'light');
  p.T.setPreference('paper');
  assert.equal(p.T.current(), 'paper', 'loaded once, applied at once');
  assert.equal(p.T.currentBase(), 'light');
});

test('unknown stored and injected ids resolve to the default; auto is system', () => {
  const storage = makeStorage();
  storage.setItem('mtlxTheme', 'no-such-theme');
  const p = load({ storage, dark: false });
  assert.equal(p.T.getPreference(), 'system');
  assert.equal(p.T.current(), 'light');
  const q = load({ globals: { __MTLX_THEME_PREF__: 'solarized' } });
  assert.equal(q.T.getPreference(), 'system');
  q.T.setPreference('auto');
  assert.equal(q.T.getPreference(), 'system');
  q.T.setPreference('dim', { persist: false });
  assert.equal(q.T.getPreference(), 'dim');
  assert.equal(q.storage.getItem('mtlxTheme'), 'system', 'persist:false keeps the stored value');
});

test('an injected preset preference loads and never persists', () => {
  const p = load({ parsing: true, globals: { __MTLX_THEME_PREF__: 'dim', __MTLX_EMBED: true } });
  p.serve();
  assert.equal(p.T.current(), 'dim');
  assert.equal(p.storage.m.size, 0);
});

test('bindEmbed passes registry ids through and maps system to auto', () => {
  const p = load();
  const el = { theme: '' };
  p.T.bindEmbed(el);
  assert.equal(el.theme, 'auto');
  p.T.setPreference('light');
  assert.equal(el.theme, 'light');
  p.T.setPreference('hc-dark');
  p.serve();
  assert.equal(el.theme, 'hc-dark');
});
