import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../../js/shared/theme-engine.js');
const data = require('../../js/shared/theme-tokens.js');
const meta = await import('../../scripts/theme-tokens-meta.mjs');

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

test('color utilities: hex round trip, OKLab/OKLCH, mix, contrast, composite', () => {
  assert.equal(E.toHex(E.parseHex('#3B82F6')), '#3b82f6');
  for (const hex of ['#111827', '#f3f4f6', '#3b82f6', '#fcd34d', '#000000', '#ffffff']) {
    assert.equal(E.fromOklab(E.toOklab(hex)), hex);
    assert.equal(E.fromOklch(E.toOklch(hex)), hex);
  }
  assert.ok(Math.abs(E.toOklab('#ffffff')[0] - 1) < 1e-4);
  assert.equal(E.mix('#111827', '#f3f4f6', 0), '#111827');
  assert.equal(E.mix('#111827', '#f3f4f6', 1), '#f3f4f6');
  assert.ok(E.toOklch(E.lighten('#3b82f6', 0.1))[0] > E.toOklch('#3b82f6')[0]);
  assert.ok(E.toOklch(E.darken('#3b82f6', 0.1))[0] < E.toOklch('#3b82f6')[0]);
  assert.equal(E.contrast('#000000', '#ffffff').toFixed(2), '21.00');
  assert.equal(E.composite('#ffffff', '#000000', 0.5), '#808080');
  assert.equal(E.deltaE('#123456', '#123456'), 0);
  assert.throws(() => E.parseHex('red'), /not #rrggbb/);
});

test('derivation is deterministic and reproduces the hand-authored dark and light maps closely', () => {
  for (const base of ['dark', 'light']) {
    const a = E.deriveTheme({ base });
    const b = E.deriveTheme({ base, seeds: { ...data.seeds[base] } });
    assert.deepEqual(a.tokens, b.tokens);
    assert.deepEqual(Object.keys(a.tokens), Object.keys(data.themes.dark));
    const d = Object.keys(data.themes[base]).map((t) => E.deltaE(a.tokens[t], data.themes[base][t]));
    assert.ok(mean(d) < 0.5, `${base} mean deltaE ${mean(d)}`);
    assert.ok(Math.max(...d) < 2, `${base} max deltaE ${Math.max(...d)}`);
    for (const [t, src] of Object.entries(a.sources)) {
      if (src === 'base') assert.equal(a.tokens[t], data.themes[base][t], t);
    }
    assert.deepEqual(a.params, data.params[base]);
  }
});

test('overrides win over recipes, missing seeds come from the base, params merge over the base', () => {
  const r = E.deriveTheme({ base: 'dark', seeds: { background: '#000000' }, overrides: { 'surface-raised': '#ABCDEF', 'type-float': '#010203' }, params: { alpha: { hudPopover: 1 } } });
  assert.equal(r.tokens['surface-raised'], '#abcdef');
  assert.equal(r.sources['surface-raised'], 'override');
  assert.equal(r.tokens['type-float'], '#010203');
  assert.equal(r.tokens['surface-base'], '#000000');
  assert.equal(r.tokens.fg, data.seeds.dark.foreground);
  assert.equal(r.tokens['accent-base'], data.seeds.dark.accent);
  assert.equal(r.sources.chip, 'recipe');
  assert.equal(r.tokens['type-bsdf'], data.themes.dark['type-bsdf']);
  assert.equal(r.params.alpha.hudPopover, 1);
  assert.equal(r.params.alpha.accentFillTranslucent, data.params.dark.alpha.accentFillTranslucent);
  assert.throws(() => E.deriveTheme({ base: 'dark', overrides: { 'not-a-token': '#000000' } }), /unknown token/);
});

test('recipes follow the seeds: a new background moves the neutral ladder, a new accent the accent ladder', () => {
  const r = E.deriveTheme({ base: 'dark', seeds: { background: '#202020', accent: '#e11d48' } });
  assert.notEqual(r.tokens['surface-raised'], data.themes.dark['surface-raised']);
  assert.ok(E.toOklch(r.tokens['surface-raised'])[0] > E.toOklch('#202020')[0]);
  const hue = E.toOklch('#e11d48')[2];
  assert.ok(Math.abs(E.toOklch(r.tokens['accent-fg'])[2] - hue) < 15);
  assert.equal(r.tokens['success'], data.themes.dark.success);
});

test('the contrast pass moves only failing foregrounds, minimally, and reaches the target', () => {
  const map = { ...data.themes.dark };
  const pairs = meta.contrast.filter((p) => ['fg-subtle', 'fg-faint', 'type-float'].includes(p.fg));
  const out = E.enforceContrast(map, pairs, 'AA', { params: data.params.dark });
  const changed = Object.keys(map).filter((t) => out.tokens[t] !== map[t]);
  assert.deepEqual(changed.sort(), ['fg-faint', 'fg-subtle', 'type-float']);
  for (const p of pairs) assert.ok(E.measurePair(out.tokens, p, data.params.dark) >= E.LEVELS.AA[p.kind], `${p.fg}|${p.bg}`);
  for (const t of changed) {
    const [L, C, h] = E.toOklch(out.tokens[t]);
    const [L0] = E.toOklch(map[t]);
    assert.ok(L > L0, `${t} got lighter on a dark ground`);
    const back = E.fromOklch([L - 0.004, C, h]);
    const worst = Math.min(...pairs.filter((p) => p.fg === t).map((p) => E.measurePair({ ...out.tokens, [t]: back }, p, data.params.dark) / E.LEVELS.AA[p.kind]));
    assert.ok(worst < 1, `${t} is not moved further than needed`);
  }
  assert.equal(out.tokens['surface-raised'], map['surface-raised']);
  assert.equal(out.moved['fg-subtle'].from, map['fg-subtle']);
});

test('the contrast pass darkens on light grounds and uses AAA thresholds', () => {
  const map = { ...data.themes.light };
  const pairs = [{ fg: 'fg-muted', bg: 'surface-base', kind: 'text' }];
  const out = E.enforceContrast(map, pairs, 'AAA', {});
  assert.ok(E.contrast(out.tokens['fg-muted'], map['surface-base']) >= 7);
  assert.ok(E.toOklch(out.tokens['fg-muted'])[0] < E.toOklch(map['fg-muted'])[0]);
});

test('an unreachable pair or a failing seed foreground fails loudly, naming the pair', () => {
  const map = { ...data.themes.dark, 'on-accent': '#ffffff', 'accent-fill': '#3b82f6' };
  assert.throws(() => E.enforceContrast(map, [{ fg: 'on-accent', bg: 'accent-fill', kind: 'text' }], 'AAA', { name: 'x' }), /x: pair on-accent\|accent-fill .*cannot be satisfied/);
  const low = { ...data.themes.dark, fg: '#303848' };
  assert.throws(() => E.enforceContrast(low, [{ fg: 'fg', bg: 'surface-base', kind: 'text' }], 'AA', {}), /fg\|surface-base fails .* seed/);
});

test('every preset resolves at its registry level and matches the generated files', () => {
  for (const entry of data.registry.filter((e) => !(e.id in data.themes) && e.base !== 'auto')) {
    const r = E.resolvePreset({ ...meta.presets[entry.id], contrast: entry.contrast }, { pairs: meta.contrast, name: entry.id });
    assert.ok(r.report.every((row) => row.pass), entry.id);
    assert.equal(r.base, entry.base);
    const gen = require(`../../js/gen/themes/${entry.id}.js`);
    assert.equal(gen.id, entry.id);
    assert.deepEqual(gen.tokens, r.tokens);
    assert.deepEqual(gen.params, r.params);
    assert.equal(r.tokens['brand-logo-inner'], '#ffffff');
  }
});
