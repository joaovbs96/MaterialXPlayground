#!/usr/bin/env node
// scripts/build-embed.mjs
// Precompiles the three JS/JSX sources the embeddable viewer needs into
// embed/gen/*.js at build time, so an embedded page never ships
// @babel/standalone (3+ MB) or re-transforms source on every page load.
// Mirrors scripts/build-webview.mjs's generator + byte-compare + failure
// messaging conventions; `npm run check` (--check) fails CI on drift.
// Usage: node scripts/build-embed.mjs [--check] — --check verifies only,
// writes nothing.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import * as Babel from "@babel/standalone";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

let cliValues;
try {
  ({ values: cliValues } = parseArgs({
    args: process.argv.slice(2),
    options: { check: { type: "boolean" } },
    strict: true,
  }));
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
const CHECK_MODE = !!cliValues.check;

// ---------------------------------------------------------------------
// Drift guard: embed/viewer.html is HAND-WRITTEN (see its own header
// comment for why — unlike webview.html, there's no source page to splice
// it from), so nothing here regenerates it. What CAN be checked
// mechanically: every `vendor/three/**` or `js/vendor/**` <script> tag
// index.html loads must also appear somewhere in embed/viewer.html, or be
// named below with a one-line reason it's deliberately left out. This
// catches "someone added a three.js loader/patch to index.html and the
// embed silently lost it" — the failure mode is a viewer that 404s or
// throws at runtime, not a build error, if nothing catches it.
//
// Entries: relative path exactly as it appears in an index.html <script
// src="...">, mapped to why embed/viewer.html doesn't load it. Empty
// today — every such script index.html loads is also loaded by
// embed/viewer.html.
const INTENTIONALLY_EXCLUDED = {
  // "vendor/three/example.js": "one-line reason",
};

// Matches `<script ... src="PATH">` tags where PATH starts with
// `vendor/three/`, `vendor/utif/` or `js/vendor/`, the script families this
// guard tracks (three.js core + its loaders, plus the UTIF.js TIFF decoder).
// Deliberately narrow: index.html also loads vendor/react/**,
// vendor/tailwind/**, vendor/babel/**, etc., none of which this guard is about.
const TRACKED_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*"((?:vendor\/three|vendor\/utif|js\/vendor)\/[^"]+)"[^>]*>/g;

function extractTrackedScripts(html) {
  const found = new Set();
  let m;
  while ((m = TRACKED_SCRIPT_RE.exec(html)) !== null) {
    found.add(m[1]);
  }
  return found;
}

/** Verifies every vendor/three/** or js/vendor/** script index.html loads
 * is also present in embed/viewer.html (or explicitly excluded above).
 * Runs unconditionally (both normal and --check mode) — it's a fast, pure
 * read-and-compare independent of the JSX transform pipeline below, so
 * there's no reason to gate it on --check the way the byte-compare is. */
async function checkEmbedHtmlScripts() {
  const indexHtml = await readFile(path.join(REPO_ROOT, "index.html"), "utf8");
  const embedHtmlPath = path.join(REPO_ROOT, "embed", "viewer.html");
  if (!existsSync(embedHtmlPath)) {
    fail("error: embed/viewer.html is missing — it is hand-written (see its own header comment), not generated; it must be created and committed directly.");
  }
  const embedHtml = await readFile(embedHtmlPath, "utf8");

  const indexScripts = extractTrackedScripts(indexHtml);
  const embedScripts = extractTrackedScripts(embedHtml);

  const missing = [...indexScripts].filter(
    (src) => !embedScripts.has(src) && !Object.prototype.hasOwnProperty.call(INTENTIONALLY_EXCLUDED, src)
  );
  if (missing.length > 0) {
    fail(
      "error: index.html loads the following vendor/three/** or js/vendor/** script(s) that embed/viewer.html does not:\n" +
        missing.map((src) => `  - ${src}`).join("\n") +
        "\nEither add a matching <script src=\"...\"> to embed/viewer.html (root-relative, per its <base href=\"../\"> — see that file's header comment), " +
        "or add an entry to INTENTIONALLY_EXCLUDED in scripts/build-embed.mjs with a one-line reason."
    );
  }

  // Stale entries in INTENTIONALLY_EXCLUDED (naming a script index.html no
  // longer loads) aren't a correctness problem, but they're silent rot —
  // flag them too so the list stays honest.
  const staleExclusions = Object.keys(INTENTIONALLY_EXCLUDED).filter((src) => !indexScripts.has(src));
  if (staleExclusions.length > 0) {
    fail(
      "error: scripts/build-embed.mjs's INTENTIONALLY_EXCLUDED names script(s) index.html no longer loads — remove the stale entry:\n" +
        staleExclusions.map((src) => `  - ${src}`).join("\n")
    );
  }

  log(`OK — embed/viewer.html covers every vendor/three/** and js/vendor/** script index.html loads (${indexScripts.size} tracked, ${Object.keys(INTENTIONALLY_EXCLUDED).length} intentionally excluded).`);
}

// Canonicalize to LF: the transform runs on whatever line endings the
// source happens to have on disk (a Windows autocrlf=true checkout would
// otherwise leak CRLF into the emitted output and break the --check
// byte-compare against a Linux-generated commit — same hazard documented
// in .gitattributes for js/gen/** and webview.html).
const normalizeEol = (s) => s.replace(/\r\n/g, "\n");

function log(...args) {
  console.log("[build-embed]", ...args);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ---------------------------------------------------------------------
// Sources -> outputs. Exactly what js/shell.jsx's VIEW_DEPS.viewer needs
// (babelScripts: ['js/shared/mtlx-ui.jsx'], app: 'js/viewer-app.jsx')
// plus js/mtlx-engine.js, which index.html:240 loads eagerly (not listed
// in VIEW_DEPS — see js/shell.jsx:107-108).
//
// `wrap: true` mirrors loadJsxApp's IIFE injection (js/shell.jsx:94) for
// the two lazy-loaded files; `wrap: false` mirrors js/mtlx-engine.js's
// eager <script type="text/mtlx-babel"> tag (index.html:240), which runs
// unwrapped at top level. Getting this backwards changes scoping
// semantics silently — see js/shell.jsx:70-100.
const TARGETS = [
  { src: "js/mtlx-engine.js", out: "embed/gen/mtlx-engine.js", wrap: false },
  { src: "js/shared/mtlx-ui.jsx", out: "embed/gen/mtlx-ui.js", wrap: true },
  { src: "js/embed-controls.jsx", out: "embed/gen/embed-controls.js", wrap: true },
  { src: "js/viewer-app.jsx", out: "embed/gen/viewer-app.js", wrap: true },
];

// The exact config js/shell.jsx:79-83 (loadJsxApp) and index.html's own
// Babel bootstrap both use. React preset ONLY — never add preset-env:
// index.html:212-227 documents that preset-env lowers the dynamic
// import() at js/mtlx-engine.js:68 to require(), which throws "require is
// not defined" the first time getMxEnv() runs in a browser.
function transform(src, filename) {
  // Precomputes exactly what compact: "auto" (Babel's default) would
  // compute itself — true once the source string exceeds 500K chars —
  // and passes it explicitly. Output bytes are identical either way; the
  // only difference is "auto" also prints a "[BABEL] Note: ... has
  // deoptimised the styling of <file>" console.error the moment it flips
  // to true, which this build would otherwise reprint on every run for
  // js/mtlx-engine.js.
  const { code } = Babel.transform(src, {
    presets: [["react", { runtime: "classic" }]],
    sourceType: "script",
    filename,
    compact: src.length > 500000,
  });
  return code;
}

/** Transforms one target in memory and returns its final output text
 * (normalized, optionally IIFE-wrapped). Never writes anything — the
 * caller decides whether to write (normal mode) or byte-compare against
 * the committed file (--check mode). */
async function buildOne(target) {
  const srcPath = path.join(REPO_ROOT, target.src);
  const source = normalizeEol(await readFile(srcPath, "utf8"));

  let code;
  try {
    code = transform(source, target.src);
  } catch (err) {
    fail(`error: Babel transform of ${target.src} failed: ${err.message}`);
  }
  code = normalizeEol(code);

  // Preset-env regression guard (index.html:212-227): if a future edit to
  // this script (or to @babel/standalone's defaults) ever lowers the
  // dynamic import(), catch it here instead of shipping a build that
  // throws "require is not defined" the first time getMxEnv() runs.
  if (target.src === "js/mtlx-engine.js") {
    if (!/\bimport\s*\(/.test(code)) {
      fail(
        `error: transformed ${target.src} no longer contains a dynamic import( — ` +
          "the WASM loader (mtlx-engine.js:68) must stay a native import(); check that " +
          "scripts/build-embed.mjs's Babel config still uses ONLY the react preset (no preset-env)."
      );
    }
    if (/\brequire\s*\(/.test(code)) {
      fail(
        `error: transformed ${target.src} contains require( — this is the preset-env ` +
          "regression index.html:212-227 warns about: preset-env lowers the dynamic import() at " +
          "mtlx-engine.js:68 to require(), which throws \"require is not defined\" the first time " +
          "getMxEnv() runs in a browser. Check scripts/build-embed.mjs uses ONLY the react preset."
      );
    }
  }

  // Same classic-script invariant js/shell.jsx:87 enforces at runtime for
  // lazy-loaded files: a module-flavored transform cannot run as a
  // classic <script>, and these outputs are always injected/loaded as one.
  if (/^\s*(import|export)\s/m.test(code)) {
    fail(
      `error: transformed ${target.src} contains a static import/export statement — ` +
        "cannot emit as a classic script (see js/shell.jsx:87 for the runtime equivalent of this check)."
    );
  }

  const body = target.wrap ? ";(function () {\n" + code + "\n})();" : code;

  if (Buffer.byteLength(body) < 1024) {
    fail(`error: transformed ${target.src} is suspiciously small (< 1KB) — a silent empty transform must not pass.`);
  }

  return normalizeEol(body);
}

// ---------------------------------------------------------------------
// Theme-token utilities. The embed has no Tailwind, so every token class
// class listed below gets a plain rule, mirroring Tailwind 3.4 output.
// A class embed.css never mirrored was a no-op, so it must stay unlisted.
// Each batch that renames a mirrored palette class to a token adds the
// token class here and deletes the old embed.css rule. Plain classes only.
const THEME_CSS_OUT = "embed/gen/theme-utilities.css";
const EMBED_MIRRORED_TOKEN_CLASSES = [
  "bg-chrome/70", // was bg-gray-900/70
  "bg-error-bg/90", // was bg-red-950/90
  "bg-hud-raised/90", // was bg-gray-800/90
  "bg-hud/70", // was bg-gray-900/70
  "bg-stage", // was bg-gray-900
  "bg-surface-base", // was bg-gray-900
  "bg-surface-sunken", // was bg-gray-900
  "bg-veil/70", // was bg-gray-900/70
  "border-error-border/60", // was border-red-800/60
  "border-hud-line", // was border-gray-600
  "border-line-strong", // was border-gray-600
  "text-error-text-strong", // was text-red-200
  "text-fg-secondary", // was text-gray-300
  "text-hud-fg", // was text-gray-300
];
const THEME_CLASS_RE =
  /(?<![\w:/.[-])(bg|text|border|ring|fill|stroke|placeholder|divide|outline|from|via|to|accent|caret|decoration)-([a-z][a-z0-9-]*)(?:\/(\d{1,3}|\[\d*\.?\d+\]))?(?![\w-])/g;

function themeDecls(prefix, color) {
  const fade = color.replace(/ \/ [^)]*\)$/, " / 0)");
  switch (prefix) {
    case "bg": return [["background-color", color]];
    case "text": return [["color", color]];
    case "border": case "divide": return [["border-color", color]];
    case "ring": return [["--tw-ring-color", color]];
    case "fill": return [["fill", color]];
    case "stroke": return [["stroke", color]];
    case "outline": return [["outline-color", color]];
    case "accent": return [["accent-color", color]];
    case "caret": return [["caret-color", color]];
    case "decoration": return [["text-decoration-color", color]];
    case "placeholder": return [["color", color]];
    case "from": return [["--tw-gradient-from", `${color} var(--tw-gradient-from-position)`], ["--tw-gradient-to", `${fade} var(--tw-gradient-to-position)`], ["--tw-gradient-stops", "var(--tw-gradient-from), var(--tw-gradient-to)"]];
    case "via": return [["--tw-gradient-to", `${fade} var(--tw-gradient-to-position)`], ["--tw-gradient-stops", `var(--tw-gradient-from), ${color} var(--tw-gradient-via-position), var(--tw-gradient-to)`]];
    case "to": return [["--tw-gradient-to", `${color} var(--tw-gradient-to-position)`]];
    default: return null;
  }
}

const cssEscape = (c) => c.replace(/[^A-Za-z0-9_-]/g, (ch) => "\\" + ch);

/** Returns { css, count }: one Tailwind-equivalent rule per listed token
 * class, sorted by class name. */
function buildThemeUtilities(sources) {
  const req = createRequire(import.meta.url);
  const tokens = new Set(Object.keys(req(path.join(REPO_ROOT, "js/shared/theme-tokens.js")).themes.dark));
  const found = new Map();
  for (const src of sources) {
    for (const m of src.matchAll(THEME_CLASS_RE)) {
      if (tokens.has(m[2])) found.set(m[0], m);
    }
  }
  for (const cls of EMBED_MIRRORED_TOKEN_CLASSES) {
    if (!found.has(cls)) {
      fail(`error: EMBED_MIRRORED_TOKEN_CLASSES lists "${cls}" but no embed/gen/*.js source uses it (or it is not a token class); remove it or fix the name.`);
    }
  }
  for (const cls of [...found.keys()]) {
    if (!EMBED_MIRRORED_TOKEN_CLASSES.includes(cls)) found.delete(cls);
  }
  const rules = [];
  for (const cls of [...found.keys()].sort()) {
    const [, prefix, token, alphaRaw] = found.get(cls);
    let alpha = "1";
    if (alphaRaw) alpha = alphaRaw[0] === "[" ? alphaRaw.slice(1, -1) : String(Number(alphaRaw) / 100);
    const decls = themeDecls(prefix, `rgb(var(--mtlx-${token}) / ${alpha})`).map(([k, v]) => `${k}: ${v};`).join(" ");
    let sel = "." + cssEscape(cls);
    if (prefix === "placeholder") sel += "::placeholder";
    if (prefix === "divide") sel += " > :not([hidden]) ~ :not([hidden])";
    rules.push(`${sel} { ${decls} }`);
  }
  const css =
    "/* GENERATED FILE, DO NOT EDIT BY HAND.\n" +
    "   Generated from embed/gen/*.js by scripts/build-embed.mjs (`npm run build:embed`).\n" +
    "   Theme-token utility classes for the Tailwind-free embed. */\n" +
    rules.join("\n") + "\n";
  return { css, count: rules.length };
}

async function main() {
  // Runs first and unconditionally — see its header comment for why this
  // isn't gated on CHECK_MODE like the byte-compare below.
  await checkEmbedHtmlScripts();

  const outputs = [];
  for (const target of TARGETS) {
    outputs.push({ target, output: await buildOne(target) });
  }
  const theme = buildThemeUtilities(outputs.map((o) => o.output));
  outputs.push({ target: { out: THEME_CSS_OUT }, output: theme.css });
  log(`${THEME_CSS_OUT}: ${theme.count} rules`);

  if (CHECK_MODE) {
    for (const { target, output } of outputs) {
      const outPath = path.join(REPO_ROOT, target.out);
      const relOut = target.out;
      if (!existsSync(outPath)) {
        fail(`${relOut} is stale — run \`npm run build:embed\` (or \`npm run build\`) and commit`);
      }
      const committed = normalizeEol(await readFile(outPath, "utf8"));
      if (committed !== output) {
        let firstDiffLine = null;
        const committedLines = committed.split("\n");
        const outputLines = output.split("\n");
        for (let i = 0; i < Math.max(committedLines.length, outputLines.length); i++) {
          if (committedLines[i] !== outputLines[i]) {
            firstDiffLine = i + 1;
            break;
          }
        }
        fail(
          `${relOut} is stale — run \`npm run build:embed\` (or \`npm run build\`) and commit` +
            (firstDiffLine ? ` (first differing line: ${firstDiffLine})` : "")
        );
      }
      log(`OK — ${relOut} matches a fresh build.`);
    }
    return;
  }

  await mkdir(path.join(REPO_ROOT, "embed", "gen"), { recursive: true });
  for (const { target, output } of outputs) {
    const outPath = path.join(REPO_ROOT, target.out);
    await writeFile(outPath, output);
    log(`wrote ${target.out}: ${Buffer.byteLength(output)} bytes`);
  }
}

await main();
