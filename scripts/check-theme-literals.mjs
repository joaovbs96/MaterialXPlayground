#!/usr/bin/env node
// scripts/check-theme-literals.mjs
// Counts hard-coded color literals in tracked source. Report-only unless --strict
// is passed (then any non-allowlisted hit exits 1). Allowlist: scripts/theme-literal-allowlist.json.
// Usage: node scripts/check-theme-literals.mjs [--strict] [--verbose]

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

const INCLUDE = [/^js\//, /^index\.html$/, /^404\.html$/, /^embed\/[^/]+\.(js|css|html)$/, /^electron\/main\//, /^electron\/preload\.js$/];
const EXCLUDE = [/^js\/gen\//, /^js\/vendor\//, /^js\/materialx\//, /^vendor\//];
const TEXT_EXT = /\.(js|jsx|mjs|css|html)$/;

function area(f) {
  if (/^(embed|electron)\//.test(f)) return "hosts";
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
  for (const line of src.split(/\r?\n/)) {
    for (const m of line.matchAll(ALPHA_RE)) {
      const a = Number(m[1]);
      if (Math.abs(Math.round(a * 255) / 255 - a) < 1e-9) continue;
      if (allow.some((e) => e.file === file && (e.test ? e.test.test(m[0]) : m[0].includes(e.text)))) continue;
      alphaBad.push(`${file}: ${m[0]}`);
    }
    for (const [kind, re] of RULES) {
      re.lastIndex = 0;
      for (const m of line.matchAll(re)) {
        if (kind === "hex" && /^#\d+$/.test(m[0])) continue;
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
        if (VERBOSE) console.log(`${file}: ${kind}: ${m[0]}`);
      }
    }
  }
}

console.log("[check-theme-literals] hits per file:");
for (const [f, n] of [...perFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) console.log(`  ${String(n).padStart(5)}  ${f}`);
console.log("[check-theme-literals] hits per area:");
for (const a of ["shell", "docs", "viewer", "graph", "shared", "usd", "hosts"]) console.log(`  ${String(perArea.get(a) || 0).padStart(5)}  ${a}`);
console.log("[check-theme-literals] hits per kind: " + [...kinds].map(([k, n]) => `${k}=${n}`).join(", "));
console.log(`[check-theme-literals] total: ${total} (allowlisted: ${allowed})${STRICT ? " [strict]" : " [report only]"}`);
if (alphaBad.length) {
  console.error("[check-theme-literals] FAIL: non-8-bit alpha in rgb(var(--mtlx-*) / a). Use `/ calc(N / 255)` with N = Math.round(a * 255) (or MtlxTheme.rgba) so it matches legacy rgba():");
  for (const b of alphaBad) console.error("  " + b);
  process.exit(1);
}
if (STRICT && total > 0) process.exit(1);
