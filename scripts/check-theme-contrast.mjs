#!/usr/bin/env node
// scripts/check-theme-contrast.mjs
// WCAG 2 contrast for every meta pair in every registry theme (presets resolved by the engine), at the entry's level:
// AA (text 4.5, large 3, ui 3) or AAA (text 7, large 4.5, ui 3). Fails on anything but the listed knownDarkFailures.
// Runtime sources (base auto, e.g. vscode) have no fixed palette: the engine enforces their level when it derives them.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const data = require("../js/shared/theme-tokens.js");
const engine = require("../js/shared/theme-engine.js");
const meta = await import("./theme-tokens-meta.mjs");

const known = new Set(meta.knownDarkFailures);
const registry = (data.registry && data.registry.length ? data.registry : Object.keys(data.themes).map((id) => ({ id, contrast: "AA" }))).filter((e) => e.base !== "auto");

// Hand-authored themes: a missing token falls back to dark, params per group fall back to dark.
function builtIn(id) {
  const tokens = { ...data.themes.dark, ...data.themes[id] };
  const params = {};
  for (const src of [data.params.dark, data.params[id]]) {
    for (const [g, v] of Object.entries(src || {})) params[g] = { ...params[g], ...v };
  }
  return { tokens, params };
}

function resolved(entry) {
  if (entry.id in data.themes) return builtIn(entry.id);
  const preset = meta.presets && meta.presets[entry.id];
  if (!preset) { console.error(`error: registry theme "${entry.id}" has no preset`); process.exit(1); }
  try {
    return engine.resolvePreset({ ...preset, contrast: entry.contrast }, { data, pairs: meta.contrast, name: entry.id });
  } catch (e) {
    console.error(`[check-theme-contrast] ${e.message}`);
    process.exit(1);
  }
}

const themes = registry.map((e) => ({ ...e, ...resolved(e), need: engine.LEVELS[e.contrast] }));
const rows = [];
const fails = Object.fromEntries(themes.map((t) => [t.id, 0]));
let fresh = 0;
for (const p of meta.contrast) {
  if (engine.LEVELS.AA[p.kind] == null) { console.error(`error: pair ${p.fg}|${p.bg} has unknown kind "${p.kind}"`); process.exit(1); }
  const cells = [];
  for (const t of themes) {
    const need = t.need[p.kind];
    const r = engine.measurePair(t.tokens, p, t.params);
    let status = "n/a";
    if (need) {
      if (r >= need) status = "pass";
      else if (t.id === "dark" && known.has(`${p.fg}|${p.bg}`)) { status = "known"; fails[t.id]++; }
      else { status = "FAIL"; fresh++; fails[t.id]++; }
    }
    cells.push(`${r.toFixed(2)} ${status}`.padEnd(10));
  }
  rows.push(`${p.fg.padEnd(24)} ${p.bg.padEnd(22)} ${p.kind.padEnd(10)} ${cells.join(" | ")}`);
}
console.log(`${"fg".padEnd(24)} ${"bg".padEnd(22)} ${"kind".padEnd(10)} ${themes.map((t) => `${t.id} ${t.contrast}`.padEnd(10)).join(" | ")}`);
console.log(rows.join("\n"));
console.log(`[check-theme-contrast] ${meta.contrast.length} pairs; failures: ${themes.map((t) => `${t.id} ${fails[t.id]}${t.id === "dark" ? ` (${known.size} known)` : ""}`).join(", ")}`);
const stale = [...known].filter((k) => !meta.contrast.some((p) => `${p.fg}|${p.bg}` === k));
if (stale.length) { console.error(`error: knownDarkFailures lists unknown pairs: ${stale.join(", ")}`); process.exit(1); }
if (fresh) { console.error(`[check-theme-contrast] ${fresh} failing pair(s) not allowed; fix the palette, the preset or the pair`); process.exit(1); }
