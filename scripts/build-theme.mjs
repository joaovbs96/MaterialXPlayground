#!/usr/bin/env node
// scripts/build-theme.mjs
// Generates js/gen/theme-tokens.css from js/shared/theme-tokens.js.
// Only custom properties are emitted (never color-scheme or other properties).
// Usage: node scripts/build-theme.mjs [--check] (--check verifies, writes nothing).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(REPO_ROOT, "js", "gen", "theme-tokens.css");
const CHECK_MODE = process.argv.includes("--check");

const data = createRequire(import.meta.url)("../js/shared/theme-tokens.js");
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

function themeBlock(name, map) {
  const selector = name === "dark" ? ':root, :root[data-theme="dark"]' : `:root[data-theme="${name}"]`;
  const lines = [];
  for (const token of TOKEN_NAMES) {
    if (name === "dark" && !(token in map)) fail(`error: dark theme is missing token "${token}"`);
    if (token in map) lines.push(`  --mtlx-${token}: ${channels(map[token])};`);
  }
  for (const key of Object.keys(map)) {
    if (!TOKEN_NAMES.includes(key)) fail(`error: theme "${name}" sets unknown token "${key}"`);
  }
  const params = (data.params && data.params[name]) || {};
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

const expected = render();
if (CHECK_MODE) {
  let actual = "";
  try {
    actual = (await readFile(OUTPUT_PATH, "utf8")).replace(/\r\n/g, "\n");
  } catch {
    fail("[build-theme] js/gen/theme-tokens.css is missing; run `npm run build:theme`");
  }
  if (actual !== expected) fail("[build-theme] js/gen/theme-tokens.css is out of date; run `npm run build:theme`");
  console.log("[build-theme] js/gen/theme-tokens.css is up to date");
} else {
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, expected);
  console.log(`[build-theme] wrote js/gen/theme-tokens.css (${TOKEN_NAMES.length} tokens)`);
}
