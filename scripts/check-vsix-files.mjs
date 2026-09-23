#!/usr/bin/env node
// Two-way guard on the packaged .vsix (vsce ls source paths, not the renamed
// in-vsix paths): required runtime files must be present, FORBIDDEN paths
// must be absent. MTLX_VSIX_FILE_LIST=path/to/list.txt reuses a captured listing.

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MTLX_VERSION, MTLX_VERSIONS } from "./lib/mtlx-versions.mjs";
import { VSCE_VERSION } from "./lib/vsce.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function log(...args) {
  console.log("[check-vsix-files]", ...args);
}

function fail(message) {
  console.error(`[check-vsix-files] ${message}`);
  process.exit(1);
}

function readRepoFile(relPath) {
  return readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

/** Extracts every quoted, relative (no scheme, no leading '/'), non-hash
 * path-like string from `text` that ends in one of `exts`. Good enough
 * for pulling src/href attribute values and array-literal string paths
 * out of plain JS/HTML source without a real parser. */
function extractPaths(text, exts) {
  const extAlt = exts.map((e) => e.replace(".", "\\.")).join("|");
  const re = new RegExp(`['"]([A-Za-z0-9_.\\-][A-Za-z0-9_.\\-/]*(?:${extAlt}))['"]`, "g");
  const out = new Set();
  let m;
  while ((m = re.exec(text))) {
    const p = m[1];
    if (/^[a-z][a-z0-9+.\-]*:/i.test(p)) continue; // scheme-qualified (https:, data:, ...)
    if (p.startsWith("/")) continue; // root-relative - not a repo-relative path
    out.add(p);
  }
  return out;
}

/** Every path listed in any `webviewSkip: [...]` array in `text` - the
 * webview never requests these, so the vsix need not ship them either. */
function extractSkippedPaths(text) {
  const out = new Set();
  const re = /webviewSkip:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(text))) {
    for (const p of extractPaths(m[1], [".js", ".css", ".jsx"])) out.add(p);
  }
  return out;
}

// Data files fetched by literal path, missed by the index.html/VIEW_DEPS
// scan above; each was confirmed with a grep before being added. MARKETPLACE.md
// is required now on purpose: this check fails on just that file until Stream D lands.
const RUNTIME_ASSETS = [
  "LICENSE",
  "vendor/vendor-manifest.json",
  "environment_map.mtlx",
  "materials/open_pbr_default.mtlx",
  "models/shaderball.glb",
  "models/shaderball_simple.glb",
  "models/shaderball_mtlx.glb",
  "models/cloth_base_mesh.glb",
  "env_maps/standard_shader_ball_env_512.exr",
  "vendor/three/draco/draco_decoder.wasm",
  "vendor/three/draco/draco_wasm_wrapper.js",
  "vendor/three/basis/basis_transcoder.js",
  "vendor/three/basis/basis_transcoder.wasm",
  "images/materialx-logo.svg",
  "js/gen/nodelib.json",
  "js/gen/nodelib-index.json",
  "js/gen/mtlx-versions.json",
  "vscode_extension/MARKETPLACE.md",
];

// Prefixes (directory, trailing slash) and exact files that must NEVER
// appear in the vsix - dev tooling, other build targets, or repo-only docs
// that .vscodeignore's allowlist is supposed to keep out.
const FORBIDDEN_PREFIXES = [
  "node_modules/",
  "scripts/",
  "tests/",
  "electron/",
  "docs/",
  "embed/",
  "gallery/",
  ".github/",
  ".claude/",
  "js/usd/",
  "vendor/usd-webview-bindings/",
  "vendor/basis-encoder/",
  ...MTLX_VERSIONS.map((v) => v.version)
    .filter((v) => v !== DEFAULT_MTLX_VERSION)
    .map((v) => `js/materialx/${v}/`),
];
const FORBIDDEN_FILES = ["CLAUDE.md"];

/** Every file package.json's manifest points at: the extension host entry
 * point, the icon, the language configuration/grammar, and every source
 * file under vscode_extension/src/ (globbed, so new files need no edit here). */
function collectManifestFiles() {
  const required = new Set();
  const pkg = JSON.parse(readRepoFile("package.json"));

  if (pkg.main) required.add(pkg.main);
  if (pkg.icon) required.add(pkg.icon);
  for (const lang of pkg.contributes?.languages || []) {
    if (lang.configuration) required.add(lang.configuration.replace(/^\.\//, ""));
  }
  for (const grammar of pkg.contributes?.grammars || []) {
    if (grammar.path) required.add(grammar.path.replace(/^\.\//, ""));
  }

  const srcDir = path.join(REPO_ROOT, "vscode_extension", "src");
  for (const entry of readdirSync(srcDir)) {
    if (entry.endsWith(".js")) required.add(`vscode_extension/src/${entry}`);
  }

  return required;
}

/** Collects the runtime-loadable file set this vsix must ship, as
 * paths relative to the repo root (no leading "extension/"). */
function collectRequiredFiles() {
  const required = new Set();

  for (const p of RUNTIME_ASSETS) required.add(p);
  for (const p of collectManifestFiles()) required.add(p);

  // index.html's own script/link tags (loaded eagerly by webview.html,
  // spliced 1:1 from index.html by scripts/build-webview.mjs).
  const indexHtml = readRepoFile("index.html");
  for (const p of extractPaths(indexHtml, [".js", ".css", ".jsx", ".ico", ".png"])) required.add(p);

  // js/shell.jsx's VIEW_DEPS entries, minus each view's own webviewSkip
  // (loadViewDeps() never requests those inside the webview).
  const shellJsx = readRepoFile("js/shell.jsx");
  const viewDepsStart = shellJsx.indexOf("const VIEW_DEPS = {");
  if (viewDepsStart === -1) fail("could not find 'const VIEW_DEPS = {' in js/shell.jsx - did it move/rename?");
  const viewDepsEnd = shellJsx.indexOf("\n};", viewDepsStart);
  if (viewDepsEnd === -1) fail("could not find the end of VIEW_DEPS in js/shell.jsx");
  const viewDepsSrc = shellJsx.slice(viewDepsStart, viewDepsEnd);
  const skipped = extractSkippedPaths(viewDepsSrc);
  for (const p of extractPaths(viewDepsSrc, [".js", ".css", ".jsx"])) {
    if (!skipped.has(p)) required.add(p);
  }

  // The default MaterialX WASM build (the ONLY version .vscodeignore
  // keeps - see its comment). A silent miss here ships an extension
  // with no shader-gen engine at all.
  for (const f of ["JsMaterialXGenShader.js", "JsMaterialXGenShader.wasm", "JsMaterialXGenShader.data"]) {
    required.add(`js/materialx/${DEFAULT_MTLX_VERSION}/${f}`);
  }

  // vscode_extension/media/*: the generated webview.html and its
  // bootstrap script, loaded directly by editorProvider.js's buildHtml().
  required.add("vscode_extension/media/webview.html");
  required.add("vscode_extension/media/bootstrap.js");

  return required;
}

/** Returns the vsix's packaged file list as repo-relative paths (the
 * "extension/" prefix vsce adds is stripped). */
function getPackagedFiles() {
  const listFile = process.env.MTLX_VSIX_FILE_LIST;
  let raw;
  if (listFile) {
    log(`using pre-captured file list: ${listFile}`);
    raw = readFileSync(listFile, "utf8");
  } else {
    log(`running \`npx --yes @vscode/vsce@${VSCE_VERSION} ls --no-dependencies\`...`);
    const result = spawnSync(
      "npx",
      ["--yes", `@vscode/vsce@${VSCE_VERSION}`, "ls", "--no-dependencies"],
      { cwd: REPO_ROOT, encoding: "utf8", shell: true }
    );
    if (result.error) fail(`failed to run vsce: ${result.error.message}`);
    if (result.status !== 0) {
      fail(`vsce ls exited ${result.status}\n${result.stdout || ""}\n${result.stderr || ""}`);
    }
    raw = result.stdout;
  }

  const files = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // vsce ls prints paths prefixed with "extension/" (or, on some
    // versions, the bare relative path) - normalize both to repo-relative.
    const rel = trimmed.startsWith("extension/") ? trimmed.slice("extension/".length) : trimmed;
    files.add(rel.replaceAll("\\", "/"));
  }
  return files;
}

function main() {
  const required = collectRequiredFiles();
  const packaged = getPackagedFiles();
  if (packaged.size === 0) fail("packaged file list is empty - vsce ls produced no output");

  const missing = [...required].filter((p) => !packaged.has(p)).sort();
  const forbidden = [...packaged]
    .filter((p) => FORBIDDEN_FILES.includes(p) || FORBIDDEN_PREFIXES.some((prefix) => p.startsWith(prefix)))
    .sort();
  log(`checked ${required.size} required file(s) and ${FORBIDDEN_PREFIXES.length + FORBIDDEN_FILES.length} forbidden rule(s) against ${packaged.size} packaged file(s).`);

  if (missing.length > 0) {
    console.error("[check-vsix-files] MISSING from the vsix (loaded at runtime but not packaged):");
    for (const p of missing) console.error(`  - ${p}`);
  }
  if (forbidden.length > 0) {
    console.error("[check-vsix-files] FORBIDDEN paths leaked into the vsix:");
    for (const p of forbidden) console.error(`  - ${p}`);
  }
  if (missing.length > 0 || forbidden.length > 0) process.exit(1);

  log("OK - every runtime-loadable file is present and no forbidden path leaked in.");
}

main();
