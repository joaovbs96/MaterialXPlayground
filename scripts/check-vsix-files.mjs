#!/usr/bin/env node
// Two-way guard on the packaged .vsix (vsce ls source paths, not the renamed
// in-vsix paths): required runtime files must be present, FORBIDDEN paths
// must be absent. MTLX_VSIX_FILE_LIST=path/to/list.txt reuses a captured listing.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MTLX_VERSION, MTLX_VERSIONS } from "./lib/mtlx-versions.mjs";
import { VSCE_VERSION } from "./lib/vsce.mjs";
import { VENDOR_DEPS } from "./vendor-deps.mjs";
import { resolveDeps } from "./lib/vendor/registry.mjs";

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

/** VIEW_DEPS source split into [viewName, entrySource] pairs, one per
 * top-level key. Per view, so one view's webviewSkip can never hide the
 * same file listed (and requested) by another view. */
function splitViewDeps(viewDepsSrc) {
  const re = /^ {4}([A-Za-z0-9_]+): \{/gm;
  const starts = [];
  let m;
  while ((m = re.exec(viewDepsSrc))) starts.push({ view: m[1], at: m.index });
  if (!starts.length) fail("found no view entries inside VIEW_DEPS in js/shell.jsx - did its formatting change?");
  return starts.map((s, i) => [s.view, viewDepsSrc.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : viewDepsSrc.length)]);
}

// Views the webview can never open: js/site-header.js drops Home and the
// Learn/Integrate groups there. Their deps need not ship; every other view,
// including dependency-only bundles such as galleryDetail, is checked.
const WEBVIEW_UNREACHABLE_VIEWS = ["home", "whatIsMaterialx", "gallery", "roadmap", "builder", "vscode"];

// The only vendor/materialx/ paths .vscodeignore keeps: spec docs, manifest,
// license, and the curated examples exampleCatalog.js copies from. Kept
// equal to .vscodeignore by this check.
export const MATERIALX_KEEP_LIST = [
  "vendor/materialx/manifest.json",
  "vendor/materialx/LICENSE",
  "vendor/materialx/documents/Specification/MaterialX.StandardNodes.md",
  "vendor/materialx/documents/Specification/MaterialX.PBRSpec.md",
  "vendor/materialx/documents/Specification/MaterialX.NPRSpec.md",
  "vendor/materialx/resources/Materials/Examples/OpenPbr/open_pbr_default.mtlx",
  // Curated "New Material from Example" upstream set: no texture files,
  // no xi:include. See exampleCatalog.js's EXAMPLES_DEFS.
  "vendor/materialx/resources/Materials/Examples/StandardSurface/standard_surface_default.mtlx",
  "vendor/materialx/resources/Materials/Examples/StandardSurface/standard_surface_gold.mtlx",
  "vendor/materialx/resources/Materials/Examples/StandardSurface/standard_surface_glass.mtlx",
  "vendor/materialx/resources/Materials/Examples/StandardSurface/standard_surface_plastic.mtlx",
  "vendor/materialx/resources/Materials/Examples/StandardSurface/standard_surface_marble_solid.mtlx",
  "vendor/materialx/resources/Materials/Examples/OpenPbr/open_pbr_aluminum_brushed.mtlx",
  "vendor/materialx/resources/Materials/Examples/OpenPbr/open_pbr_glass.mtlx",
  "vendor/materialx/resources/Materials/Examples/OpenPbr/open_pbr_carpaint.mtlx",
  "vendor/materialx/resources/Materials/Examples/OpenPbr/open_pbr_velvet.mtlx",
  "vendor/materialx/resources/Materials/Examples/OpenPbr/open_pbr_pearl.mtlx",
];

// Data files fetched by literal path, missed by the index.html/VIEW_DEPS
// scan above; each was confirmed with a grep before being added. MARKETPLACE.md
// is required now on purpose: this check fails on just that file until Stream D lands.
const RUNTIME_ASSETS = [
  // vsce's LicenseProcessor renames the repo's root LICENSE to
  // LICENSE.txt inside the packaged vsix; vsce ls still reports the
  // SOURCE path checked here. js/shell.jsx's AboutDialog fetches 'LICENSE'
  // first (so the web/Electron hosts are unaffected) and falls back to
  // 'LICENSE.txt' - see checkRenamedRootFileFallbacks() below, which fails
  // this script if that fallback is ever removed.
  "LICENSE",
  "vendor/vendor-manifest.json",
  "environment_map.mtlx",
  "materials/open_pbr_default.mtlx",
  "models/shaderball.glb",
  "models/shaderball_simple.glb",
  "models/shaderball_mtlx.glb",
  "models/cloth_base_mesh.glb",
  "env_maps/standard_shader_ball_env_512.exr",
  "images/materialx-logo.svg",
  "js/gen/nodelib.json",
  "js/gen/nodelib-index.json",
  "js/gen/mtlx-versions.json",
  "vscode_extension/MARKETPLACE.md",
  // USD Scene Viewer: reached only through dynamic import()/Worker URLs,
  // which the VIEW_DEPS scan above cannot see.
  "js/usd/usd-stage-loader.js",
  "js/usd/usd-stage-worker.js",
  "js/usd/usd-webview-worker-shim.js",
  // glTF/OBJ scene roots (js/usd-scene-sources.js import()s the loaders; the
  // loaders and the stage worker import the MaterialX converters).
  "js/usd/gltf-stage-loader.js",
  "js/usd/obj-stage-loader.js",
  "js/usd/mtlx-material-docs.js",
];

// Vendored files come from the registry (scripts/vendor-deps.mjs): every manifest
// file of a dep that ships is required; the dir of every `vscode: false` dep is forbidden.
const RESOLVED_DEPS = resolveDeps(VENDOR_DEPS);
const SHIPPED_DEP_IDS = new Set(RESOLVED_DEPS.filter((d) => d.vscode !== false).map((d) => d.id));
const VENDOR_REQUIRED = JSON.parse(readRepoFile("vendor/vendor-manifest.json")).entries
  .filter((e) => SHIPPED_DEP_IDS.has(e.dep)).map((e) => "vendor/" + e.path);
const VENDOR_FORBIDDEN = RESOLVED_DEPS.filter((d) => d.vscode === false).map((d) => "vendor/" + d.dir + "/");

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
  ".github/",
  ".claude/",
  ...VENDOR_FORBIDDEN,
  ...MTLX_VERSIONS.map((v) => v.version)
    .filter((v) => v !== DEFAULT_MTLX_VERSION)
    .map((v) => `js/materialx/${v}/`),
];
const FORBIDDEN_FILES = ["CLAUDE.md"];

// gallery/ is mostly forbidden too, but the package job trims it down to
// exactly two allowed shapes before `vsce package` runs (see .vscodeignore
// and scripts/gallery-shots.mjs's --prune-ids): the trimmed manifest, and
// its thumbnails at original resolution. Both are optional (absent on a
// plain checkout), so they are checked here, not added to RUNTIME_ASSETS.
function isForbiddenGalleryPath(p) {
  if (!p.startsWith("gallery/")) return false;
  if (p === "gallery/manifest.json") return false;
  if (/^gallery\/thumbs\/[^/]+\.jpg$/.test(p)) return false;
  return true;
}

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
    if (lang.icon?.light) required.add(lang.icon.light.replace(/^\.\//, ""));
    if (lang.icon?.dark) required.add(lang.icon.dark.replace(/^\.\//, ""));
  }
  for (const grammar of pkg.contributes?.grammars || []) {
    if (grammar.path) required.add(grammar.path.replace(/^\.\//, ""));
  }
  for (const snippet of pkg.contributes?.snippets || []) {
    if (snippet.path) required.add(snippet.path.replace(/^\.\//, ""));
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
  for (const p of VENDOR_REQUIRED) required.add(p);
  for (const p of collectManifestFiles()) required.add(p);

  // Only require the trimmed MaterialX snapshot when it's actually on disk:
  // a plain checkout with no `npm run vendor:offline` run has no vendor/materialx
  // at all, and that's a valid (remote-mode) state, not a packaging bug.
  if (existsSync(path.join(REPO_ROOT, "vendor", "materialx"))) {
    for (const p of MATERIALX_KEEP_LIST) required.add(p);
  }

  // index.html's own script/link tags (loaded eagerly by webview.html,
  // spliced 1:1 from index.html by scripts/build-webview.mjs).
  const indexHtml = readRepoFile("index.html");
  for (const p of extractPaths(indexHtml, [".js", ".css", ".jsx", ".ico", ".png"])) required.add(p);

  // js/shell.jsx's VIEW_DEPS entries, each minus its OWN webviewSkip
  // (loadViewDeps() never requests those inside the webview).
  const shellJsx = readRepoFile("js/shell.jsx");
  const viewDepsStart = shellJsx.indexOf("const VIEW_DEPS = {");
  if (viewDepsStart === -1) fail("could not find 'const VIEW_DEPS = {' in js/shell.jsx - did it move/rename?");
  const viewDepsEnd = shellJsx.indexOf("\n};", viewDepsStart);
  if (viewDepsEnd === -1) fail("could not find the end of VIEW_DEPS in js/shell.jsx");
  const viewDepsSrc = shellJsx.slice(viewDepsStart, viewDepsEnd);
  for (const [view, block] of splitViewDeps(viewDepsSrc)) {
    if (WEBVIEW_UNREACHABLE_VIEWS.includes(view)) continue;
    const skipped = extractSkippedPaths(block);
    for (const p of extractPaths(block, [".js", ".css", ".jsx"])) {
      if (!skipped.has(p)) required.add(p);
    }
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

// Anything under vendor/materialx/ that isn't one of the six keep-list
// files is forbidden - covers resources/Images/ and any other leftover
// from the full upstream snapshot, without hand-listing every subpath.
function isForbiddenMaterialxPath(p) {
  return p.startsWith("vendor/materialx/") && !MATERIALX_KEEP_LIST.includes(p);
}

// vsce renames these unextensioned root files when packaging (see
// @vscode/vsce's processors): LICENSE -> LICENSE.txt, README -> README.md,
// CHANGELOG -> CHANGELOG.md. Any webview code that fetches the bare name
// 404s once installed unless it also falls back to the renamed form.
// Checked against js/shell.jsx, the only place today that fetches a
// repo-root file by name (the About dialog).
const RENAMED_ROOT_FILES = { LICENSE: "LICENSE.txt", README: "README.md", CHANGELOG: "CHANGELOG.md" };

function checkRenamedRootFileFallbacks() {
  const problems = [];
  const shellJsx = readRepoFile("js/shell.jsx");
  for (const [bare, renamed] of Object.entries(RENAMED_ROOT_FILES)) {
    const fetchesBare = new RegExp(`fetch\\(['"]${bare}['"]\\)`).test(shellJsx);
    if (!fetchesBare) continue;
    if (!shellJsx.includes(renamed)) {
      problems.push(`js/shell.jsx fetches '${bare}' with no fallback to '${renamed}' - it will 404 in the packaged extension`);
    }
  }
  return problems;
}

function main() {
  const required = collectRequiredFiles();
  const packaged = getPackagedFiles();
  if (packaged.size === 0) fail("packaged file list is empty - vsce ls produced no output");

  const missing = [...required].filter((p) => !packaged.has(p)).sort();
  const forbidden = [...packaged]
    .filter(
      (p) =>
        FORBIDDEN_FILES.includes(p) ||
        FORBIDDEN_PREFIXES.some((prefix) => p.startsWith(prefix)) ||
        isForbiddenMaterialxPath(p) ||
        isForbiddenGalleryPath(p)
    )
    .sort();
  const renameProblems = checkRenamedRootFileFallbacks();
  log(`checked ${required.size} required file(s) and ${FORBIDDEN_PREFIXES.length + FORBIDDEN_FILES.length} forbidden rule(s) against ${packaged.size} packaged file(s).`);

  if (missing.length > 0) {
    console.error("[check-vsix-files] MISSING from the vsix (loaded at runtime but not packaged):");
    for (const p of missing) console.error(`  - ${p}`);
  }
  if (forbidden.length > 0) {
    console.error("[check-vsix-files] FORBIDDEN paths leaked into the vsix:");
    for (const p of forbidden) console.error(`  - ${p}`);
  }
  if (renameProblems.length > 0) {
    console.error("[check-vsix-files] renamed-root-file fetches with no fallback:");
    for (const p of renameProblems) console.error(`  - ${p}`);
  }
  if (missing.length > 0 || forbidden.length > 0 || renameProblems.length > 0) process.exit(1);

  log("OK - every runtime-loadable file is present and no forbidden path leaked in.");
}

main();
