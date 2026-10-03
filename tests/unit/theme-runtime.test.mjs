import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadTheme() {
  const listeners = {};
  const context = {
    console,
    addEventListener: (t, h) => { (listeners[t] = listeners[t] || []).push(h); },
    removeEventListener: (t, h) => { listeners[t] = (listeners[t] || []).filter((x) => x !== h); },
  };
  context.self = context;
  vm.createContext(context);
  for (const f of ['theme-tokens.js', 'theme.js']) {
    const file = path.join(root, 'js', 'shared', f);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  return { T: context.MtlxTheme, listeners };
}

test('rgba quantizes alpha to 8 bits like legacy rgba()', () => {
  const { T } = loadTheme();
  assert.equal(T.rgba('surface-base', 0.16), 'rgb(var(--mtlx-surface-base) / calc(41 / 255))');
});

test('get returns the dark hex and var has the channel format', () => {
  const { T } = loadTheme();
  assert.equal(T.get('surface-base'), '#111827');
  assert.equal(T.var('surface-base'), 'rgb(var(--mtlx-surface-base))');
});

test('onChange subscribes and unsubscribes', () => {
  const { T, listeners } = loadTheme();
  let n = 0;
  const off = T.onChange(() => { n++; });
  assert.equal(listeners['mtlx-theme-change'].length, 1);
  listeners['mtlx-theme-change'][0]({ detail: { theme: 'dark' } });
  assert.equal(n, 1);
  off();
  assert.equal(listeners['mtlx-theme-change'].length, 0);
});
