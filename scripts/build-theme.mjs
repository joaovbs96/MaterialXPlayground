#!/usr/bin/env node
// scripts/build-theme.mjs
// Generates js/gen/theme-tokens.css (dark as :root, light as :root[data-theme="light"]; custom properties only, an omitted
// token falls back to dark) and, per preset registry id, js/gen/themes/<id>.css + .js resolved by js/shared/theme-engine.js.
// Registry ids with base auto are runtime sources: js/gen/themes/<id>.js carries their pairs and overrides, no CSS.
// Usage: node scripts/build-theme.mjs [--check] (--check verifies, writes nothing).

import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(REPO_ROOT, "js", "gen", "theme-tokens.css");
const PRESET_DIR = path.join(REPO_ROOT, "js", "gen", "themes");
const CHECK_MODE = process.argv.includes("--check");

const require = createRequire(import.meta.url);
const data = require("../js/shared/theme-tokens.js");
const engine = require("../js/shared/theme-engine.js");
const meta = await import("./theme-tokens-meta.mjs");
const TOKEN_NAMES = Object.keys(data.themes.dark);

{
  const metaKeys = new Set(Object.keys(meta.tokens));
  const missing = TOKEN_NAMES.filter((t) => !metaKeys.has(t));
  const orphan = [...metaKeys].filter((t) => !(t in data.themes.dark));
  if (missing.length || orphan.length) {
    fail(`error: theme meta out of sync (no meta: ${missing.join(", ") || "none"}; orphan meta: ${orphan.join(", ") || "none"})`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function channels(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) fail(`error: theme token value "${hex}" is not #rrggbb`);
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

function kebab(s) {
  return s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
}

function themeBlock(name, map, params = (data.params && data.params[name]) || {}) {
  const selector = name === "dark" ? ':root, :root[data-theme="dark"]' : `:root[data-theme="${name}"]`;
  const lines = [];
  for (const token of TOKEN_NAMES) {
    if (name === "dark" && !(token in map)) fail(`error: dark theme is missing token "${token}"`);
    if (token in map) lines.push(`  --mtlx-${token}: ${channels(map[token])};`);
  }
  for (const key of Object.keys(map)) {
    if (!TOKEN_NAMES.includes(key)) fail(`error: theme "${name}" sets unknown token "${key}"`);
  }
  for (const [group, values] of Object.entries(params)) {
    for (const [k, v] of Object.entries(values)) {
      lines.push(`  --mtlx-${kebab(group)}-${kebab(k)}: ${v};`);
    }
  }
  return `${selector} {\n${lines.join("\n")}\n}\n`;
}

function render() {
  const header =
    "/* GENERATED FILE, DO NOT EDIT BY HAND.\n" +
    "   Generated from js/shared/theme-tokens.js by scripts/build-theme.mjs\n" +
    "   (`npm run build:theme`, part of `npm run build`). Custom properties only. */\n";
  const blocks = Object.entries(data.themes).map(([name, map]) => themeBlock(name, map));
  return header + blocks.join("\n");
}

// ---- Presets ----
const registry = data.registry || [];
const sourceIds = registry.filter((e) => e.base === "auto").map((e) => e.id);
const presetIds = registry.filter((e) => !(e.id in data.themes) && e.base !== "auto").map((e) => e.id);
{
  for (const e of registry) {
    if (!/^[a-z][a-z0-9-]*$/.test(e.id)) fail(`error: registry id "${e.id}" must be lowercase kebab-case`);
    if (!["dark", "light", "auto"].includes(e.base)) fail(`error: registry "${e.id}" has base "${e.base}"`);
    if (!engine.LEVELS[e.contrast]) fail(`error: registry "${e.id}" has contrast level "${e.contrast}"`);
    if (e.hosts !== undefined && !(Array.isArray(e.hosts) && e.hosts.length)) fail(`error: registry "${e.id}" hosts must be a non-empty array`);
  }
  const srcDefs = meta.sources || {};
  for (const id of sourceIds) {
    if (!srcDefs[id]) fail(`error: registry "${id}" (base auto) has no source in scripts/theme-tokens-meta.mjs`);
    if (id in data.themes || (meta.presets || {})[id]) fail(`error: source "${id}" must not also be a theme or a preset`);
    for (const [base, over] of Object.entries(srcDefs[id].overrides || {})) {
      if (base !== "dark" && base !== "light") fail(`error: source "${id}" overrides base "${base}"`);
      for (const t of Object.keys(over)) if (!(t in data.themes.dark)) fail(`error: source "${id}" overrides unknown token "${t}"`);
    }
  }
  for (const id of Object.keys(srcDefs)) {
    if (!sourceIds.includes(id)) fail(`error: source "${id}" is not a base auto registry entry`);
  }
  for (const name of Object.keys(data.themes)) {
    if (!registry.some((e) => e.id === name)) fail(`error: theme "${name}" is not in the registry`);
  }
  const defs = meta.presets || {};
  for (const id of presetIds) {
    if (!defs[id]) fail(`error: registry "${id}" has no preset in scripts/theme-tokens-meta.mjs`);
    if (defs[id].base !== registry.find((e) => e.id === id).base) fail(`error: preset "${id}" base differs from its registry base`);
  }
  for (const id of Object.keys(defs)) {
    if (!presetIds.includes(id)) fail(`error: preset "${id}" is not in the registry`);
  }
}

// Resolves one preset (derive, then the contrast pass at its registry level); throws name the failing pair.
function resolvePreset(id) {
  const entry = registry.find((e) => e.id === id);
  try {
    return engine.resolvePreset({ ...meta.presets[id], contrast: entry.contrast }, { data, pairs: meta.contrast, name: id });
  } catch (e) {
    fail(`[build-theme] ${e.message}`);
  }
}

const GEN_NOTE = (id) =>
  `GENERATED FILE, DO NOT EDIT BY HAND. Theme "${id}" resolved from the presets in scripts/theme-tokens-meta.mjs\n` +
  "   by scripts/build-theme.mjs (js/shared/theme-engine.js: recipes, then the contrast pass).";

function presetCss(id, r) {
  return `/* ${GEN_NOTE(id)} */\n` + themeBlock(id, r.tokens, r.params);
}

// Registers the map, adds the stylesheet (document.write while the head parses, else a <link>), then calls
// MTLX_THEME_TOKENS.loaded(id) so js/shared/theme.js switches only once the colors are in. Node gets the data.
function presetJs(id, r) {
  const body = (o) => JSON.stringify(o, null, 4).replace(/\n/g, "\n    ");
  return `// ${GEN_NOTE(id).replace(/\n {3}/, "\n// ")}
(function (root) {
    'use strict';
    var id = ${JSON.stringify(id)};
    var base = ${JSON.stringify(r.base)};
    var tokens = ${body(r.tokens)};
    var params = ${body(r.params)};
    if (typeof module === 'object' && module.exports) { module.exports = { id: id, base: base, tokens: tokens, params: params }; return; }
    var d = root.MTLX_THEME_TOKENS;
    var doc = root.document;
    if (!d || !doc) return;
    d.themes[id] = tokens;
    d.params[id] = params;
    var me = doc.currentScript;
    var href = me && me.src ? me.src.replace(/\\.js([?#].*)?$/, '.css') : 'js/gen/themes/' + id + '.css';
    var done = function () { if (typeof d.loaded === 'function') d.loaded(id); };
    if (doc.readyState === 'loading' && me && !me.async) {
        doc.write('<link rel="stylesheet" href="' + href + '">');
        done();
        return;
    }
    var link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.onload = done;
    link.onerror = function () { if (root.console) root.console.warn('[theme] could not load ' + href); };
    link.href = href;
    doc.head.appendChild(link);
})(typeof self !== 'undefined' ? self : this);
`;
}

// Runtime source: registers { contrast, overrides, pairs } as MTLX_THEME_TOKENS.sources[id], then loads the engine
// (document.write while the head parses, else a <script>) whose startSource(id) derives and applies the theme.
function sourceJs(id) {
  const entry = registry.find((e) => e.id === id);
  const pairs = meta.contrast.map((p) => {
    const o = { fg: p.fg, bg: p.bg, kind: p.kind };
    for (const k of ["alpha", "alphaParam", "under"]) if (p[k] !== undefined) o[k] = p[k];
    return o;
  });
  const overrides = JSON.stringify(meta.sources[id].overrides || {}, null, 4).replace(/\n/g, "\n        ");
  const list = pairs.map((p) => JSON.stringify(p)).join(",\n            ");
  return `// GENERATED FILE, DO NOT EDIT BY HAND. Theme source "${id}" (registry base auto) from scripts/theme-tokens-meta.mjs
// by scripts/build-theme.mjs: contrast pairs and overrides for js/shared/theme-engine.js, which derives it at runtime.
(function (root) {
    'use strict';
    var id = ${JSON.stringify(id)};
    var source = {
        contrast: ${JSON.stringify(entry.contrast)},
        overrides: ${overrides},
        pairs: [
            ${list},
        ],
    };
    if (typeof module === 'object' && module.exports) { module.exports = { id: id, source: source }; return; }
    var d = root.MTLX_THEME_TOKENS;
    var doc = root.document;
    if (!d || !doc) return;
    (d.sources = d.sources || {})[id] = source;
    var start = function (E) { E.startSource(id, { root: root, data: d, source: source }); };
    if (root.MtlxThemeEngine) { start(root.MtlxThemeEngine); return; }
    d.onEngine = start;
    var me = doc.currentScript;
    var src = me && me.src ? me.src.replace(/js\\/gen\\/themes\\/[^/]+\\.js([?#].*)?$/, 'js/shared/theme-engine.js') : 'js/shared/theme-engine.js';
    if (doc.readyState === 'loading' && me && !me.async) { doc.write('<script src="' + src + '"><\\/script>'); return; }
    var s = doc.createElement('script');
    s.src = src;
    doc.head.appendChild(s);
})(typeof self !== 'undefined' ? self : this);
`;
}

function outputs() {
  const files = new Map([[OUTPUT_PATH, render()]]);
  for (const id of sourceIds) files.set(path.join(PRESET_DIR, `${id}.js`), sourceJs(id));
  for (const id of presetIds) {
    const r = resolvePreset(id);
    files.set(path.join(PRESET_DIR, `${id}.css`), presetCss(id, r));
    files.set(path.join(PRESET_DIR, `${id}.js`), presetJs(id, r));
    const moved = Object.keys(r.moved);
    console.log(`[build-theme] ${id}: ${r.base} base, ${registry.find((e) => e.id === id).contrast}, contrast pass moved ${moved.length} token(s)${moved.length ? ": " + moved.join(", ") : ""}`);
  }
  return files;
}

const rel = (p) => path.relative(REPO_ROOT, p).replace(/\\/g, "/");
const expected = outputs();
let existing = [];
try {
  existing = (await readdir(PRESET_DIR)).map((f) => path.join(PRESET_DIR, f));
} catch { /* no presets yet */ }
const stale = existing.filter((p) => !expected.has(p));

if (CHECK_MODE) {
  for (const [file, text] of expected) {
    let actual = null;
    try {
      actual = (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
    } catch {
      fail(`[build-theme] ${rel(file)} is missing; run \`npm run build:theme\``);
    }
    if (actual !== text) fail(`[build-theme] ${rel(file)} is out of date; run \`npm run build:theme\``);
  }
  if (stale.length) fail(`[build-theme] stale preset output: ${stale.map(rel).join(", ")}; run \`npm run build:theme\``);
  console.log(`[build-theme] js/gen/theme-tokens.css, ${presetIds.length} preset(s) and ${sourceIds.length} source(s) are up to date`);
} else {
  await mkdir(PRESET_DIR, { recursive: true });
  for (const [file, text] of expected) await writeFile(file, text);
  for (const p of stale) await unlink(p);
  console.log(`[build-theme] wrote js/gen/theme-tokens.css (${TOKEN_NAMES.length} tokens), ${presetIds.length} preset(s) and ${sourceIds.length} source(s) in js/gen/themes/`);
}
