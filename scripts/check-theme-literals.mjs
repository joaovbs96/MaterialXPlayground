#!/usr/bin/env node
// scripts/check-theme-literals.mjs
// Counts hard-coded color literals in tracked source. Report-only unless --strict
// is passed (then any non-allowlisted hit exits 1). Allowlist: scripts/theme-literal-allowlist.json.
// Usage: node scripts/check-theme-literals.mjs [--strict] [--verbose]

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");
const VERBOSE = process.argv.includes("--verbose");

const PREFIXES = "ring-offset|bg|text|border|ring|fill|stroke|from|via|to|divide|outline|shadow|placeholder|accent|caret|decoration";
const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const START = String.raw`(?<![\w-])(?:[\w[\]&>*.-]+:)*`;
const RULES = [
  ["palette-class", new RegExp(String.raw`${START}(?:${PREFIXES})-(?:white|black|(?:${PALETTE})-\d{2,3})(?:\/\d+)?(?![\w-])`, "g")],
  ["arbitrary-class", new RegExp(String.raw`${START}(?:${PREFIXES})-\[(?:#|rgba?\(|hsla?\()[^\]]*\]`, "g")],
  ["hex", /(?<![\w&#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])/g],
  ["rgb-hsl", /\b(?:rgb|rgba|hsl|hsla)\(\s*[\d.]/g],
  ["0xhex", /\b0x[0-9a-fA-F]{6}\b/g],
];

const INCLUDE = [/^js\//, /^index\.html$/, /^404\.html$/, /^embed\/[^/]+\.(js|css|html)$/, /^electron\/main\//, /^electron\/preload\.js$/, /^blog-src\//];
const EXCLUDE = [/^js\/gen\//, /^js\/vendor\//, /^js\/materialx\//, /^vendor\//, /^blog-src\/node_modules\//];
const TEXT_EXT = /\.(js|jsx|mjs|css|html|njk)$/;

function area(f) {
  if (/^(embed|electron)\//.test(f)) return "hosts";
  if (/^blog-src\//.test(f)) return "blog";
  if (/^js\/shared\//.test(f)) return "shared";
  if (/^js\/usd\//.test(f) || /^js\/usd-scene-/.test(f)) return "usd";
  if (/^js\/graph\//.test(f) || f === "js/graph-app.jsx") return "graph";
  if (/^js\/docs\//.test(f) || /^js\/(docs-app|node-preview)/.test(f)) return "docs";
  if (/^js\/(viewer-app|compare-app|embed-controls|mtlx-engine|mxslc|vscode-app)/.test(f)) return "viewer";
  return "shell";
}

function loadAllowlist() {
  const list = JSON.parse(readFileSync(path.join(REPO_ROOT, "scripts", "theme-literal-allowlist.json"), "utf8"));
  return list.map((e) => {
    const m = /^\/(.*)\/([a-z]*)$/.exec(e.match);
    return { file: e.file, test: m ? new RegExp(m[1], m[2]) : null, text: m ? null : e.match };
  });
}

function trackedFiles() {
  const r = spawnSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error("[check-theme-literals] git ls-files failed");
    process.exit(1);
  }
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean)
    .filter((f) => TEXT_EXT.test(f) && INCLUDE.some((re) => re.test(f)) && !EXCLUDE.some((re) => re.test(f)))
    .filter((f) => !/^embed\/gen\//.test(f));
}

const blankText = (t) => t.replace(/[^\n]/g, " ");

function stripCssComments(src) {
  return src.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, blankText);
}

// Blanks comments, keeping newlines. Tracks strings, templates and regex literals; HTML comments first.
function stripJsComments(src) {
  const chars = src.replace(/<!--[\s\S]*?(?:-->|$)/g, blankText).split("");
  const n = chars.length;
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (chars[k] !== "\n") chars[k] = " ";
  };
  const stack = [];
  let i = 0;
  let prev = "";
  while (i < n) {
    const c = chars[i];
    const d = chars[i + 1];
    if (c === "/" && d === "/" && chars[i - 1] !== ":") {
      let j = i;
      while (j < n && chars[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      let j = i + 2;
      while (j < n && !(chars[j] === "*" && chars[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && chars[j] !== c && chars[j] !== "\n") j += chars[j] === "\\" ? 2 : 1;
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === "`" || (c === "}" && stack.length && stack[stack.length - 1] === 0)) {
      if (c === "}") stack.pop();
      let j = i + 1;
      let opened = false;
      while (j < n) {
        if (chars[j] === "\\") { j += 2; continue; }
        if (chars[j] === "`") break;
        if (chars[j] === "$" && chars[j + 1] === "{") { stack.push(0); opened = true; j += 2; break; }
        j++;
      }
      i = j + (opened ? 0 : 1);
      prev = "`";
      continue;
    }
    if (stack.length) {
      if (c === "{") stack[stack.length - 1]++;
      else if (c === "}") stack[stack.length - 1]--;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};".includes(prev))) {
      let j = i + 1;
      let cls = false;
      while (j < n && chars[j] !== "\n") {
        if (chars[j] === "\\") { j += 2; continue; }
        if (chars[j] === "[") cls = true;
        else if (chars[j] === "]") cls = false;
        else if (chars[j] === "/" && !cls) break;
        j++;
      }
      i = j + 1;
      prev = "/";
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return chars.join("");
}

// A hex-looking token that is really an anchor, url(#id), selector or id lookup.
function hexIsNotColor(line, m) {
  const before = line.slice(0, m.index);
  const after = line.slice(m.index + m[0].length);
  if (/(?:href|src|id|for|name|xlink:href)\s*=\s*["']?$/i.test(before) || /url\(\s*["']?$/.test(before)) return true;
  if (/(?:querySelector(?:All)?|getElementById|closest|matches)\(\s*["'`][^"'`]*$/.test(before)) return true;
  return /^\s*(?:\{|[>+~.:[]|,\s*[.#\w[:>][^;{}]*\{)/.test(after);
}

// Token class typos (e.g. accent-accent-base): Tailwind ignores unknown classes. Always fatal.
const TOKEN_KEYS = new Set(Object.keys(createRequire(import.meta.url)("../js/shared/theme-tokens.js").themes.dark));
const TOKEN_GROUPS = new Set([...TOKEN_KEYS].map((k) => k.split("-")[0]));
const TOKEN_CLASS_RE = new RegExp(String.raw`${START}(?:ring-offset|bg|text|border|ring|fill|stroke|from|via|to|divide|outline|shadow|placeholder|accent|caret|decoration)-([a-z][\w-]*?)(?:\/[\w.[\]-]+)?(?![\w\/-])`, "g");
const unknownBad = [];

const allow = loadAllowlist();
// Always fatal: legacy rgba() quantized alpha to 8 bits, raw floats shift pixels.
const ALPHA_RE = /rgb\(var\(--mtlx-[\w-]+\)\s*\/\s*(\d*\.?\d+)\s*\)/g;
const alphaBad = [];
const perFile = new Map();
const perArea = new Map();
const kinds = new Map();
let total = 0;
let allowed = 0;

for (const file of trackedFiles()) {
  let src;
  try {
    src = readFileSync(path.join(REPO_ROOT, file), "utf8");
  } catch {
    continue;
  }
  src = /\.css$/.test(file) ? stripCssComments(src) : stripJsComments(src);
  let ln = 0;
  for (const line of src.split(/\r?\n/)) {
    ln++;
    for (const m of line.matchAll(ALPHA_RE)) {
      const a = Number(m[1]);
      if (Math.abs(Math.round(a * 255) / 255 - a) < 1e-9) continue;
      if (allow.some((e) => e.file === file && (e.test ? e.test.test(m[0]) : m[0].includes(e.text)))) continue;
      alphaBad.push(`${file}: ${m[0]}`);
    }
    if (/\.(jsx?|html|njk)$/.test(file) &&!/^js\/shared\/theme-(tokens|engine)\.js$/.test(file)) {
      for (const m of line.matchAll(TOKEN_CLASS_RE)) {
        const r = m[1];
        if (TOKEN_KEYS.has(r) || !TOKEN_GROUPS.has(r.split("-")[0])) continue;
        unknownBad.push(`${file}:${ln}: unknown token class ${m[0]}`);
      }
    }
    for (const [kind, re] of RULES) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        if (kind === "hex" && hexIsNotColor(line, m)) continue;
        const ok = allow.some((a) => a.file === file && (a.test ? a.test.test(m[0]) : m[0].includes(a.text)));
        if (ok) {
          allowed++;
          continue;
        }
        total++;
        perFile.set(file, (perFile.get(file) || 0) + 1);
        const a = area(file);
        perArea.set(a, (perArea.get(a) || 0) + 1);
        kinds.set(kind, (kinds.get(kind) || 0) + 1);
        if (VERBOSE) console.log(`${file}:${ln}: ${kind}: ${m[0]}`);
      }
    }
  }
}

console.log("[check-theme-literals] hits per file:");
for (const [f, n] of [...perFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) console.log(`  ${String(n).padStart(5)}  ${f}`);
console.log("[check-theme-literals] hits per area:");
for (const a of ["shell", "docs", "viewer", "graph", "shared", "usd", "hosts", "blog"]) console.log(`  ${String(perArea.get(a) || 0).padStart(5)}  ${a}`);
console.log("[check-theme-literals] hits per kind: " + [...kinds].map(([k, n]) => `${k}=${n}`).join(", "));
console.log(`[check-theme-literals] total: ${total} (allowlisted: ${allowed})${STRICT ? " [strict]" : " [report only]"}`);
if (alphaBad.length) {
  console.error("[check-theme-literals] FAIL: non-8-bit alpha in rgb(var(--mtlx-*) / a). Use `/ calc(N / 255)` with N = Math.round(a * 255) (or MtlxTheme.rgba) so it matches legacy rgba():");
  for (const b of alphaBad) console.error("  " + b);
  process.exit(1);
}
if (unknownBad.length) {
  console.error("[check-theme-literals] FAIL: unknown token class (typo, Tailwind silently ignores it):");
  for (const b of unknownBad) console.error("  " + b);
  process.exit(1);
}
if (STRICT && total > 0) process.exit(1);
