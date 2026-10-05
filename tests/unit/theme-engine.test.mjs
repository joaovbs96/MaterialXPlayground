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
    // Dark tokens lifted to AA on purpose are no longer what the recipes derive.
    const lifted = base === 'dark' ? new Set(['fg-subtle','fg-faint','on-accent-muted','code-muted','line-strong','hud-line','scrollbar-thumb','graph-node-line','stage-fg-subtle','type-bsdf','type-float','type-integer','type-matrix44','type-nodegraph','line-control','success-fill']) : new Set();
    const d = Object.keys(data.themes[base]).filter((t) => !lifted.has(t)).map((t) => E.deltaE(a.tokens[t], data.themes[base][t]));
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
  // Dark now passes AA, so pin the three tokens to their old failing values.
  const map = { ...data.themes.dark, 'fg-subtle': '#6b7280', 'fg-faint': '#4b5563', 'type-float': '#3949ab' };
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

// ---- Custom themes based on a built-in theme (spec.from) ----
const pairsGen = require('../../js/gen/theme-pairs.js');
const deepMerge = (a, b) => {
  const o = JSON.parse(JSON.stringify(a || {}));
  for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(o[k], v) : v;
  return o;
};
const BASELINES = {};
for (const e of data.registry.filter((x) => x.base !== 'auto')) {
  if (e.id === 'dark') BASELINES.dark = { base: 'dark', tokens: data.themes.dark, params: data.params.dark, level: e.contrast };
  else if (e.id === 'light') BASELINES.light = { base: 'light', tokens: { ...data.themes.dark, ...data.themes.light }, params: deepMerge(data.params.dark, data.params.light), level: e.contrast };
  else {
    const g = require(`../../js/gen/themes/${e.id}.js`);
    BASELINES[e.id] = { base: g.base, tokens: g.tokens, params: g.params, level: e.contrast };
  }
}
const fromCustom = (id, overrides) => {
  const b = BASELINES[id];
  return E.resolveCustom({ base: b.base, from: id, overrides: overrides || {} }, { data, pairs: pairsGen.pairs, baseline: { tokens: b.tokens, params: b.params, level: b.level } });
};

test('generated presets carry their true seeds', () => {
  for (const id of ['hc-dark', 'hc-light', 'dim', 'paper']) {
    const g = require(`../../js/gen/themes/${id}.js`);
    const r = E.resolvePreset({ ...meta.presets[id], contrast: data.registry.find((e) => e.id === id).contrast }, { data, pairs: meta.contrast, name: id });
    assert.deepEqual(g.seeds, r.seeds, id);
    assert.deepEqual(Object.keys(g.seeds), Object.keys(data.seeds.dark));
  }
});

test('from without overrides reproduces the built-in theme exactly, for all six', () => {
  assert.deepEqual(Object.keys(BASELINES).sort(), ['dark', 'dim', 'hc-dark', 'hc-light', 'light', 'paper']);
  for (const [id, b] of Object.entries(BASELINES)) {
    const r = fromCustom(id);
    assert.equal(r.ok, true, id + ': ' + r.error);
    assert.deepEqual(r.tokens, b.tokens, id + ' tokens');
    assert.deepEqual(r.params, b.params, id + ' params');
    assert.deepEqual(r.adjusted, [], id);
    assert.ok(r.report.every((x) => x.pass), id);
  }
});

test('from: overriding a token at its current value changes nothing', () => {
  for (const [id, b] of Object.entries(BASELINES)) {
    const all = Object.keys(b.tokens);
    const names = id === 'light' || id === 'paper' ? all : all.filter((_, i) => i % Math.floor(all.length / 20) === 0).slice(0, 20);
    if (names.length < 20 && id !== 'light' && id !== 'paper') assert.fail('sample too small');
    for (const t of names) {
      const r = fromCustom(id, { [t]: b.tokens[t] });
      assert.equal(r.ok, true, id + ' ' + t + ': ' + r.error);
      assert.deepEqual(r.tokens, b.tokens, id + ' ' + t);
      assert.deepEqual(r.adjusted, [], id + ' ' + t);
    }
  }
});

test('from: a real override moves only that token plus the ones the report lists as adjusted', () => {
  for (const [id, b] of Object.entries(BASELINES)) {
    for (const [t, c] of [['accent-fill', '#b91c1c'], ['fg-muted', '#445566'], ['surface-raised', '#303a4a']]) {
      const r = fromCustom(id, { [t]: c });
      if (!r.ok) continue;
      const moved = Object.keys(b.tokens).filter((k) => r.tokens[k] !== b.tokens[k]);
      const allowed = new Set([t, ...r.adjusted.map((a) => a.token)]);
      assert.ok(moved.includes(t) || r.adjusted.some((a) => a.token === t), id + ' ' + t + ' moves');
      for (const k of moved) assert.ok(allowed.has(k), id + ' ' + t + ': unexpected move of ' + k);
      assert.ok(r.report.every((x) => x.pass), id + ' ' + t);
    }
  }
  assert.equal(fromCustom('dark', { 'accent-fill': '#b91c1c' }).tokens['accent-fill'] !== BASELINES.dark.tokens['accent-fill'], true);
});

test('from without a baseline fails with a clear message; the seeds path is unchanged', () => {
  const r = E.resolveCustom({ base: 'light', from: 'paper', overrides: {} }, { data, pairs: pairsGen.pairs });
  assert.equal(r.ok, false);
  assert.match(r.error, /paper/);
  const a = E.resolveCustom({ base: 'dark', seeds: data.seeds.dark, overrides: {}, modifiers: {} }, { data, pairs: pairsGen.pairs, level: 'AA' });
  assert.equal(a.ok, true);
});
