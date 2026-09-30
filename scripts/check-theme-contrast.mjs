#!/usr/bin/env node
// scripts/check-theme-contrast.mjs
// WCAG 2 contrast for every pair in theme-tokens-meta.mjs, in every theme.
// Fails on any light failure and on any dark failure not in knownDarkFailures (kinds: text 4.5, large 3, ui 3, decorative reported only).
import { createRequire } from "node:module";

const data = createRequire(import.meta.url)("../js/shared/theme-tokens.js");
const meta = await import("./theme-tokens-meta.mjs");

const NEED = { text: 4.5, large: 3, ui: 3, decorative: 0 };
const known = new Set(meta.knownDarkFailures);

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = (c) => { const [r, g, b] = c.map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

function value(theme, token) {
  const map = data.themes[theme] || {};
  return token in map ? map[token] : data.themes.dark[token];
}

function measure(theme, p) {
  const fg = rgb(value(theme, p.fg));
  let bg = rgb(value(theme, p.bg));
  if (p.alpha != null) {
    const under = rgb(value(theme, p.under));
    bg = bg.map((v, i) => Math.round(v * p.alpha + under[i] * (1 - p.alpha)));
  }
  return ratio(fg, bg);
}

const themes = Object.keys(data.themes);
const rows = [];
let lightFails = 0;
let darkFails = 0;
let fresh = 0;
for (const p of meta.contrast) {
  const need = NEED[p.kind];
  if (need == null) { console.error(`error: pair ${p.fg}|${p.bg} has unknown kind "${p.kind}"`); process.exit(1); }
  const cells = [];
  for (const theme of themes) {
    const r = measure(theme, p);
    const key = `${p.fg}|${p.bg}`;
    let status = "n/a";
    if (need) {
      if (r >= need) status = "pass";
      else if (theme === "dark" && known.has(key)) { status = "known"; darkFails++; }
      else { status = "FAIL"; fresh++; if (theme === "dark") darkFails++; else lightFails++; }
    }
    cells.push(`${r.toFixed(2)} ${status}`);
  }
  rows.push(`${p.fg.padEnd(24)} ${p.bg.padEnd(22)} ${p.kind.padEnd(10)} ${String(need || "-").padEnd(4)} ${cells.join("  |  ")}`);
}
console.log(`${"fg".padEnd(24)} ${"bg".padEnd(22)} ${"kind".padEnd(10)} ${"req".padEnd(4)} ${themes.join("  |  ")}`);
console.log(rows.join("\n"));
console.log(`[check-theme-contrast] ${meta.contrast.length} pairs, light failures ${lightFails}, dark failures ${darkFails} (${known.size} known)`);
const stale = [...known].filter((k) => !meta.contrast.some((p) => `${p.fg}|${p.bg}` === k));
if (stale.length) { console.error(`error: knownDarkFailures lists unknown pairs: ${stale.join(", ")}`); process.exit(1); }
if (fresh) { console.error(`[check-theme-contrast] ${fresh} failing pair(s) not allowed; fix the palette or the pair`); process.exit(1); }
