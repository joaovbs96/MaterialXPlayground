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

// One fake page. `storage` can be shared between pages to model a reload.
function load({ storage = makeStorage(), dark = true, globals = {}, body = true, classes = [] } = {}) {
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
  for (const s of SRC) vm.runInContext(s.code, context, { filename: s.file });
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
    createBody(list) {
      bodyClasses.clear();
      list.forEach((c) => bodyClasses.add(c));
      document.body = { classList: { contains: (c) => bodyClasses.has(c) } };
      (docListeners.DOMContentLoaded || []).forEach((h) => h());
    },
  };
}

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
  assert.equal(p.T.current(), 'dark');
  p.setBody(['vscode-high-contrast', 'vscode-high-contrast-light']);
  assert.equal(p.T.current(), 'light');
  assert.equal(seen.map((e) => e.theme).join(), ['light', 'dark', 'light', 'dark', 'light'].join());
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
  assert.equal(load({ body: false, globals: { __MTLX_VSCODE__: true, __MTLX_VSCODE_THEME_KIND__: 'highContrastLight' } }).T.current(), 'light');
  assert.equal(load({ body: false, globals: { __MTLX_VSCODE__: true, __MTLX_VSCODE_THEME_KIND__: 'highContrast' } }).T.current(), 'dark');
  assert.equal(load({ body: false, globals: { __MTLX_VSCODE__: true } }).T.current(), 'dark');
});

test('onChange fires once per actual change', () => {
  const p = load({ dark: true });
  const seen = record(p.T);
  p.setSystemDark(true);
  assert.equal(seen.length, 0);
  p.T.setPreference('dark');
  assert.equal(seen.length, 1);
  assert.equal(JSON.stringify(seen[0]), JSON.stringify({ theme: 'dark', preference: 'dark' }));
  p.T.setPreference('dark');
  assert.equal(seen.length, 1);
  p.T.setPreference('light');
  assert.equal(seen.length, 2);
  p.T.setPreference('bogus');
  assert.equal(seen.length, 2);
  p.setSystemDark(false);
  assert.equal(seen.length, 2);
});
