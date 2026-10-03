#!/usr/bin/env node
// scripts/check-render-parity.mjs: anti-drift guard for the render/quality
// settings manifest in js/shared/render-settings.js.
//
// (a) manifest shape: every row declares all 6 surfaces, every profile
//     defines all 3 levels with codec-valid values, keys unique, ui rows
//     have a label.
// (b) every storage/legacy key literal appears only in render-settings.js,
//     except PENDING files and ALLOW entries; no other 'mtlx*' localStorage
//     key literal goes undeclared.
// (c) option-list ratchet: display-transform/backdrop option arrays stay
//     out of every file except render-settings.js (PENDING/ALLOW excepted).
// (d) UI-coverage: every surface file that hosts render settings uses a
//     shared component, and no manifest row label is hard-coded loose.
// (e) writes/checks docs/RENDER-FEATURES.md.
// (f) embed build/runtime consistency: build-embed TARGETS vs viewer.html
//     REMAINING, embed.attr coverage, eager embed payload budget.
//
// Usage: node scripts/check-render-parity.mjs [--check]

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CHECK_MODE = process.argv.includes("--check");

function log(...args) { console.log("[check-render-parity]", ...args); }
function fail(message) {
  console.error(`[check-render-parity] ${message}`);
  process.exit(1);
}

const SURFACES = ["viewer", "compare", "docs", "graph", "embed", "scene"];
const LEVELS = ["performance", "default", "quality"];

// ---- Load the manifest in a Node vm with a stub window (same pattern as
// tests/unit/render-settings.test.mjs). ----
function loadManifest() {
  const source = readFileSync(path.join(REPO_ROOT, "js", "shared", "render-settings.js"), "utf8");
  const memory = {};
  const localStorage = {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(memory, k) ? memory[k] : null),
    setItem: (k, v) => { memory[k] = String(v); },
    removeItem: (k) => { delete memory[k]; },
  };
  const win = {
    location: { search: "" },
    localStorage,
    dispatchEvent: () => true,
    addEventListener: () => {},
    CustomEvent: function CustomEvent(type, init) { this.type = type; this.detail = init && init.detail; },
  };
  win.self = win;
  win.top = win;
  const sandbox = { window: win, localStorage, URLSearchParams, JSON, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.window.MtlxRenderSettings;
}

const M = loadManifest();
if (!M) fail("js/shared/render-settings.js did not export window.MtlxRenderSettings");

// ---------------------------------------------------------------------
// (a) manifest shape
// ---------------------------------------------------------------------
function checkManifestShape() {
  const problems = [];
  const seenKeys = new Set();

  const isSurfaceValueValid = (v) => {
    if (v === "yes") return true;
    if (v && typeof v === "object") {
      if (typeof v.na === "string" && v.na.length > 0) return true;
      if (typeof v.planned === "string" && /^P\d+$/.test(v.planned)) return true;
    }
    return false;
  };

  const isLevelValueValid = (P, value) => {
    if (value === undefined) return false;
    switch (P.codec) {
      case "bool01": case "boolOn": case "boolOnlyOne": case "boolTrueFalse":
        return typeof value === "boolean";
      case "number": case "int":
        return typeof value === "number" && value >= P.min && value <= P.max;
      case "enum":
        return P.options && P.options.indexOf(value) !== -1;
      case "sizeOrOriginal": case "gib":
        return P.options && P.options.indexOf(value) !== -1;
      case "jsonField":
        return true;
      default:
        return false;
    }
  };

  for (const row of M.ROWS) {
    if (seenKeys.has(row.key)) problems.push(`duplicate row key "${row.key}"`);
    seenKeys.add(row.key);

    if (row.ui === true && (typeof row.label !== "string" || !row.label.trim())) {
      problems.push(`row "${row.key}" has ui:true but no non-empty label`);
    }

    const surfaceKeys = Object.keys(row.surfaces || {});
    for (const s of SURFACES) {
      if (!surfaceKeys.includes(s)) { problems.push(`row "${row.key}" is missing surface "${s}"`); continue; }
      if (!isSurfaceValueValid(row.surfaces[s])) {
        problems.push(`row "${row.key}" surface "${s}" has an invalid value: ${JSON.stringify(row.surfaces[s])}`);
      }
      // A surface that says 'yes' must have a profile to read and write through.
      if (row.surfaces[s] === "yes" && !(row.profiles && row.profiles[M.PROFILE_OF[s]])) {
        problems.push(`row "${row.key}" is 'yes' for "${s}" but has no ${M.PROFILE_OF[s]} profile`);
      }
    }
    if (surfaceKeys.some((s) => !SURFACES.includes(s))) {
      problems.push(`row "${row.key}" declares an unknown surface: ${surfaceKeys.filter((s) => !SURFACES.includes(s)).join(", ")}`);
    }

    for (const profile of Object.keys(row.profiles || {})) {
      const P = row.profiles[profile];
      if (!P.levels) { problems.push(`row "${row.key}" profile "${profile}" has no levels`); continue; }
      for (const level of LEVELS) {
        const value = P.levels[level] !== undefined ? P.levels[level] : P.levels.default;
        if (!isLevelValueValid(P, value)) {
          problems.push(`row "${row.key}" profile "${profile}" level "${level}" is invalid for codec "${P.codec}": ${JSON.stringify(value)}`);
        }
      }
    }
  }

  if (problems.length) {
    fail(["manifest shape check (a) failed:", ...problems.map((p) => `  - ${p}`)].join("\n"));
  }
  log(`(a) manifest shape OK, ${M.ROWS.length} rows.`);
}

// ---------------------------------------------------------------------
// (b) storage key literal scan
// ---------------------------------------------------------------------
// Files where guarded storage keys are still read/written directly
// (empty since P5: the Scene routes through the store).
const PENDING_FILES = [];

// { key, file, reason }: legitimate non-manifest uses of an 'mtlx*' key.
const ALLOW = [
  { key: "mtlx_preview_geom_choice", file: "js/node-preview.jsx", reason: "Auto-pick UI flag, not a manifest row (per-node experimental geometry)" },
  { key: "mtlx_preview_geom_choice", file: "js/mtlx-engine.js", reason: "declared as a legacy geometry seed key literal in a comment/array historically; guarded generically" },
  { key: "mtlx_graph_preview_geom", file: "js/graph/preview.jsx", reason: "Auto-pick UI flag, not a manifest row (per-node-type experimental geometry)" },
  { key: "mtlx_preview_geom_override", file: "js/node-preview.jsx", reason: "superseded slot, best-effort cleanup only" },
  { key: "mtlx_preview_geom_by_node", file: "js/node-preview.jsx", reason: "superseded slot, best-effort cleanup only" },
  { key: "mtlx_preview_geom", file: "js/node-preview.jsx", reason: "superseded slot, best-effort cleanup only" },
  { key: "mtlxRecordGif", file: "js/shared/mtlx-ui.jsx", reason: "GIF export UI state, not a render/quality setting" },
  { key: "mtlx_export_attribution", file: "js/shared/mtlx-ui.jsx", reason: "export UI preference, not a render/quality setting" },
  { key: "mtlx_scene_material_preview_rect", file: "js/usd-scene-app.jsx", reason: "docked panel layout state" },
  { key: "mtlx_scene_render_settings_tab", file: "js/usd-scene-app.jsx", reason: "settings dialog UI state" },
  { key: "mtlx_scene_material_preview_split", file: "js/usd-scene-app.jsx", reason: "docked panel layout state" },
  { key: "mtlx_light_limit", file: "js/mtlx-engine.js", reason: "debug kill switch, not a user-facing setting" },
  { key: "mtlxDebugShaders", file: "js/mtlx-engine.js", reason: "debug flag" },
  { key: "mtlxDebugShaders", file: "js/usd-scene-app.jsx", reason: "debug flag" },
  { key: "mtlxPerfLog", file: "js/mtlx-engine.js", reason: "debug flag" },
  { key: "mtlxPerfLog", file: "js/shell.jsx", reason: "debug flag" },
  { key: "mtlxPerfLog", file: "js/graph/model.jsx", reason: "debug flag" },
  { key: "mtlx_specular_env", file: "js/mtlx-engine.js", reason: "side-by-side comparison test hook, not in the manifest yet" },
  { key: "mtlx_scene_texture_fast", file: "js/mtlx-engine.js", reason: "debug kill switch" },
  { key: "mtlx_texture_decode_limit", file: "js/mtlx-engine.js", reason: "debug kill switch" },
  { key: "mtlx_scene_prefilter_fix", file: "js/mtlx-engine.js", reason: "debug kill switch" },
  { key: "mtlx_feature_gated_shaders", file: "js/usd-scene-renderer.js", reason: "debug kill switch, not a user-facing setting" },
  { key: "mtlx_show_previews", file: "js/docs-app.jsx", reason: "docs-only UI preference, out of scope for the P1 manifest" },
  { key: "mtlxDisplacementNormalEps", file: "js/shared/mesh-displacement.js", reason: "debug tuning epsilon, out of scope for the P1 manifest" },
];

function listSourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      const rel = path.relative(REPO_ROOT, full).split(path.sep).join("/");
      const st = statSync(full);
      if (st.isDirectory()) {
        if (rel === "js/gen" || rel === "embed/gen" || rel === "js/vendor" || rel === "node_modules") continue;
        walk(full);
      } else if (/\.(js|jsx)$/.test(entry)) {
        out.push(rel);
      }
    }
  };
  walk(path.join(REPO_ROOT, "js"));
  for (const entry of readdirSync(path.join(REPO_ROOT, "embed"))) {
    if (/\.js$/.test(entry)) out.push(`embed/${entry}`);
  }
  return out;
}

function checkStorageKeyScan() {
  const manifestKeys = new Set(M.storageKeys());
  const problems = [];
  const files = listSourceFiles();
  const allowSet = new Set(ALLOW.map((e) => `${e.key}|${e.file}`));

  // Any other 'mtlx*' literal used as a localStorage key not declared
  // anywhere in the manifest.
  const keyLiteralRe = /localStorage\.(?:getItem|setItem|removeItem)\(\s*['"](mtlx[A-Za-z0-9_]*)['"]/g;

  for (const file of files) {
    const rel = file;
    const abs = path.join(REPO_ROOT, rel);
    const text = readFileSync(abs, "utf8");

    // Manifest keys appearing outside render-settings.js, as a whole quoted
    // literal (not merely a substring of a longer, unrelated key name).
    if (rel !== "js/shared/render-settings.js") {
      for (const key of manifestKeys) {
        const literalRe = new RegExp(`['"]${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"]`);
        if (!literalRe.test(text)) continue;
        if (PENDING_FILES.includes(rel)) continue;
        if (allowSet.has(`${key}|${rel}`)) continue;
        problems.push(`storage key "${key}" appears in ${rel}, which is not PENDING or ALLOW-listed`);
      }
    }

    // Undeclared 'mtlx*' localStorage key literals.
    let m;
    while ((m = keyLiteralRe.exec(text))) {
      const key = m[1];
      if (manifestKeys.has(key)) continue;
      if (PENDING_FILES.includes(rel)) continue;
      if (allowSet.has(`${key}|${rel}`)) continue;
      problems.push(`undeclared localStorage key "${key}" used in ${rel} (not in the manifest, not PENDING, not ALLOW-listed)`);
    }
  }

  if (problems.length) {
    fail(["storage key scan (b) failed:", ...problems.map((p) => `  - ${p}`)].join("\n"));
  }
  log(`(b) storage key scan OK, ${manifestKeys.size} manifest keys, ${files.length} files scanned.`);
}

// ---------------------------------------------------------------------
// (c) option-list ratchet: literal display-transform or backdrop option
// arrays only in js/shared/render-settings.js; elsewhere use row.options.
// ---------------------------------------------------------------------
const OPTION_LIST_PENDING_FILES = [];

// Known second copies not yet folded into the manifest: real gaps, kept
// visible here (not silently ignored) rather than allowed forever.
const OPTION_LIST_ALLOW = [
  {
    file: "js/mtlx-engine.js",
    reason: "DISPLAY_TRANSFORM_VALUES is the engine's own validation copy; " +
      "mtlx-engine.js has no load-time dependency on render-settings.js's ROWS shape today, only get/set. Follow-up.",
  },
];

function checkOptionListRatchet() {
  const problems = [];
  const files = listSourceFiles();
  const displayTransformRow = M.ROWS.find((r) => r.key === "displayTransform");
  const backdropRow = M.ROWS.find((r) => r.key === "backdrop");
  const patterns = [
    { name: "display transform", options: displayTransformRow.options },
    { name: "backdrop", options: backdropRow.options },
  ];
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  for (const file of files) {
    if (file === "js/shared/render-settings.js") continue;
    const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
    for (const { name, options } of patterns) {
      const re = new RegExp(options.map((v) => `['"]${escapeRe(v)}['"]`).join("\\s*,\\s*"));
      if (!re.test(text)) continue;
      if (OPTION_LIST_PENDING_FILES.includes(file)) continue;
      if (OPTION_LIST_ALLOW.some((e) => e.file === file)) continue;
      problems.push(`literal ${name} option list found in ${file}, outside js/shared/render-settings.js (not PENDING, not ALLOW-listed)`);
    }
  }

  if (problems.length) {
    fail(["option-list ratchet (c) failed:", ...problems.map((p) => `  - ${p}`)].join("\n"));
  }
  log(`(c) option-list ratchet OK, ${files.length} files scanned.`);
}

// ---------------------------------------------------------------------
// (d) UI-coverage: every settings surface references a shared component,
// and no row's label is hard-coded without rowMeta(...) call nearby.
// ---------------------------------------------------------------------
const UI_COVERAGE_FILES = [
  "js/viewer-app.jsx",
  "js/compare-app.jsx",
  "js/node-preview.jsx",
  "js/graph/preview.jsx",
  "js/embed-controls.jsx",
];
const UI_COVERAGE_TOKENS = ["RenderSettingsSection", "SettingsDialog", "ViewportControls", "EmbedRenderSettings"];
const UI_COVERAGE_SAFE_NEARBY = ["rowMeta(", "RenderSettingsSection", "EmbedRenderSettings"];

// (file, label) pairs where the label text is a pre-existing, unrelated
// string (a tooltip/title on a different control) that happens to match a
// manifest row's label, not a duplicated settings row.
const UI_COVERAGE_ALLOW = [
  { file: "js/graph/preview.jsx", label: "Preview Geometry", reason: "title on the geometry-picker trigger button, not the settings row" },
];

function checkUiCoverage() {
  const problems = [];
  for (const file of UI_COVERAGE_FILES) {
    const abs = path.join(REPO_ROOT, file);
    const text = readFileSync(abs, "utf8");
    if (!UI_COVERAGE_TOKENS.some((tok) => text.includes(tok))) {
      problems.push(`${file} hosts render settings but references none of: ${UI_COVERAGE_TOKENS.join(", ")}`);
      continue;
    }
    for (const row of M.ROWS) {
      if (row.ui !== true) continue;
      const label = row.label;
      if (UI_COVERAGE_ALLOW.some((e) => e.file === file && e.label === label)) continue;
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Only JSX text child (>Label<) or quoted string literal counts as
      // hard-coded; bare identifier substring (resolveViewerBackdrop) is not.
      const re = new RegExp(`>\\s*${escaped}\\s*<|['"]${escaped}['"]`, "g");
      let m;
      while ((m = re.exec(text))) {
        const idx = m.index;
        // A fallback idiom (`x.label || 'Label'`, `(x && x.label) || 'Label'`)
        // is always safe regardless of how far back its rowMeta(...) call
        // sits: the `||` right before the literal IS the tell.
        const before = text.slice(Math.max(0, idx - 6), idx);
        if (/\|\|\s*$/.test(before)) continue;
        const windowStart = Math.max(0, idx - 300);
        const windowEnd = Math.min(text.length, idx + m[0].length + 300);
        const context = text.slice(windowStart, windowEnd);
        if (!UI_COVERAGE_SAFE_NEARBY.some((tok) => context.includes(tok))) {
          problems.push(`literal label "${label}" found in ${file} with no rowMeta(...)/RenderSettingsSection/EmbedRenderSettings nearby - looks like a reintroduced hand-built row`);
        }
      }
    }
  }

  if (problems.length) {
    fail(["UI-coverage check (d) failed:", ...problems.map((p) => `  - ${p}`)].join("\n"));
  }
  log(`(d) UI-coverage OK, ${UI_COVERAGE_FILES.length} files scanned.`);
}

// ---------------------------------------------------------------------
// (e) docs/RENDER-FEATURES.md
// ---------------------------------------------------------------------
function surfaceCell(v) {
  if (v === "yes") return "yes";
  if (v && v.na) return `na (${v.na})`;
  if (v && v.planned) return `planned (${v.planned})`;
  return String(v);
}

function renderStorageKeysCell(row) {
  const parts = [];
  for (const profile of Object.keys(row.profiles)) {
    const P = row.profiles[profile];
    let s = P.storage ? `${profile}: \`${P.storage}\`` : `${profile}: per view, not saved`;
    if (P.field) s += ` (field \`${P.field}\`)`;
    if (P.legacy && P.legacy.length) s += ` (legacy: ${P.legacy.map((k) => `\`${k}\``).join(", ")})`;
    parts.push(s);
  }
  return parts.join("<br>");
}

function generateRenderFeaturesDoc() {
  const groups = {};
  for (const row of M.ROWS) {
    const g = row.group || "other";
    (groups[g] = groups[g] || []).push(row);
  }
  const lines = [];
  lines.push("<!-- GENERATED by scripts/check-render-parity.mjs, do not hand-edit. -->");
  lines.push("# Render/Quality Settings (Surface Parity)");
  lines.push("");
  lines.push("One row per setting in `js/shared/render-settings.js`, one table per group. `yes` = the surface reads/writes this setting today; `na (reason)` = does not apply; `planned (P<n>)` = scheduled for a later phase.");
  lines.push("");
  for (const g of Object.keys(groups).sort()) {
    lines.push(`## ${g}`);
    lines.push("");
    lines.push(`| Setting | ${SURFACES.join(" | ")} | Storage keys |`);
    lines.push(`| --- | ${SURFACES.map(() => "---").join(" | ")} | --- |`);
    for (const row of groups[g]) {
      const cells = SURFACES.map((s) => surfaceCell(row.surfaces[s]));
      lines.push(`| ${row.label || row.key} | ${cells.join(" | ")} | ${renderStorageKeysCell(row)} |`);
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

function checkRenderFeaturesDoc() {
  const outPath = path.join(REPO_ROOT, "docs", "RENDER-FEATURES.md");
  const content = generateRenderFeaturesDoc();
  if (CHECK_MODE) {
    let existing;
    try { existing = readFileSync(outPath, "utf8"); } catch (e) { fail(`docs/RENDER-FEATURES.md is missing (run \`node scripts/build.mjs render\`)`); }
    if (existing !== content) {
      fail("docs/RENDER-FEATURES.md is out of date with js/shared/render-settings.js, run `node scripts/build.mjs render`");
    }
    log("(e) docs/RENDER-FEATURES.md matches the manifest.");
  } else {
    writeFileSync(outPath, content, "utf8");
    log("(e) docs/RENDER-FEATURES.md regenerated.");
  }
}

// ---------------------------------------------------------------------
// (f) embed build/runtime consistency
// ---------------------------------------------------------------------
// Current eager embed payload (bytes), now including embed/gen/*.js and
// embed/embed-boot.js, is ~2,282,131; budget is that measured total x 1.03.
// Raised for P4c: createTextureSession (js/mtlx-engine.js, precompiled into
// embed/gen/mtlx-engine.js) adds the refcounted-source/wrapper/idle-LRU
// texture pipeline and the exact:true resolvers.
// Raise deliberately (with a comment on why) if the payload grows further.
const EMBED_PAYLOAD_BUDGET = 2350595;

const EAGER_EMBED_FILES = [
  "vendor/react/react.production.min.js",
  "vendor/react/react-dom.production.min.js",
  "vendor/three/three.min.js",
  "vendor/three/RGBELoader.js",
  "vendor/three/fflate.min.js",
  "js/vendor/EXRLoader.js",
  "vendor/pako/pako_inflate.min.js",
  "vendor/utif/UTIF.js",
  "vendor/three/GLTFLoader.js",
  "vendor/three/DRACOLoader.js",
  "vendor/three/KTX2Loader.js",
  "vendor/three/OBJLoader.js",
  "vendor/three/OrbitControls.js",
  "js/mtlx-assets.js",
  "js/shared/ui-commons.js",
  "js/shared/gif-encoder.js",
  "js/shared/mesh-subdivision.js",
  "js/shared/mesh-displacement.js",
  "js/shared/mesh-udim.js",
  "js/shared/mtlx-turntable.js",
  "js/shared/render-settings.js",
  "js/shared/render-environment.js",
  "js/shared/render-session.js",
  "embed/gen/embed-controls.js",
  "embed/gen/mtlx-engine.js",
  "embed/gen/mtlx-ui.js",
  "embed/gen/viewer-app.js",
  "embed/embed-boot.js",
];

function checkEmbedConsistency() {
  const problems = [];

  // build-embed TARGETS vs viewer.html REMAINING.
  const buildEmbedSrc = readFileSync(path.join(REPO_ROOT, "scripts", "build-embed.mjs"), "utf8");
  const viewerHtml = readFileSync(path.join(REPO_ROOT, "embed", "viewer.html"), "utf8");
  const targetOutMatches = [...buildEmbedSrc.matchAll(/out:\s*"([^"]+)"/g)].map((m) => m[1]);
  const remainingMatch = viewerHtml.match(/var REMAINING = \[([^\]]*)\]/);
  if (!remainingMatch) {
    problems.push("could not find REMAINING array in embed/viewer.html");
  } else {
    const remaining = [...remainingMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    // mtlx-engine.js loads via a separate fetchAndRunInline call, not REMAINING;
    // embed-boot.js is REMAINING's last entry but not a build-embed output.
    const targetsMinusEngine = targetOutMatches.filter((t) => t !== "embed/gen/mtlx-engine.js");
    const remainingMinusBoot = remaining.filter((r) => r !== "embed/embed-boot.js");
    const engineInRemaining = viewerHtml.includes("fetchAndRunInline('embed/gen/mtlx-engine.js')");
    if (!engineInRemaining) problems.push("embed/viewer.html no longer eagerly loads embed/gen/mtlx-engine.js via fetchAndRunInline");
    const a = JSON.stringify(targetsMinusEngine.slice().sort());
    const b = JSON.stringify(remainingMinusBoot.slice().sort());
    if (a !== b) {
      problems.push(`build-embed TARGETS outputs (${a}) do not match embed/viewer.html REMAINING (${b})`);
    }
  }

  // Every row's embed.attr is in observedAttributes and mentioned in docs/EMBEDDING.md.
  const mtlxViewerSrc = readFileSync(path.join(REPO_ROOT, "embed", "mtlx-viewer.js"), "utf8");
  const observedMatch = mtlxViewerSrc.match(/observedAttributes\(\)\s*{\s*return \[([\s\S]*?)\];/);
  const observed = observedMatch ? [...observedMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
  const embeddingDocs = readFileSync(path.join(REPO_ROOT, "docs", "EMBEDDING.md"), "utf8");
  for (const row of M.ROWS) {
    if (!row.embed || !row.embed.attr) continue;
    if (!observed.includes(row.embed.attr)) {
      problems.push(`row "${row.key}" embed.attr "${row.embed.attr}" is missing from embed/mtlx-viewer.js observedAttributes`);
    }
    if (!embeddingDocs.includes(row.embed.attr)) {
      problems.push(`row "${row.key}" embed.attr "${row.embed.attr}" is not mentioned in docs/EMBEDDING.md`);
    }
  }

  // Eager embed payload budget.
  let total = 0;
  for (const f of EAGER_EMBED_FILES) {
    try {
      total += statSync(path.join(REPO_ROOT, f)).size;
    } catch (e) {
      problems.push(`eager embed payload file missing: ${f}`);
    }
  }
  if (total > EMBED_PAYLOAD_BUDGET) {
    problems.push(`eager embed payload is ${total} bytes, over budget ${EMBED_PAYLOAD_BUDGET} bytes (raise EMBED_PAYLOAD_BUDGET deliberately if this growth is intended)`);
  }

  if (problems.length) {
    fail(["embed consistency check (f) failed:", ...problems.map((p) => `  - ${p}`)].join("\n"));
  }
  log(`(f) embed consistency OK, eager payload ${total}/${EMBED_PAYLOAD_BUDGET} bytes.`);
}

// ---------------------------------------------------------------------
// (g) handle-contract guard (P3-DESIGN.md section 4 S5, "guard (c)"):
// an unambiguous HANDLE_CONTRACT name must not reappear as an
// object-literal key/shorthand in js/mtlx-engine.js outside the preview
// content object that feeds MtlxRender.buildHandle. dispose,
// resize and snapshot are too generic (unrelated literals reuse them,
// e.g. the peel pipeline's `{render, dispose}`) so they are excluded;
// the unit test covers those instead. Scene files are PENDING.
// ---------------------------------------------------------------------
// Emptied in P6 S3: the Scene builds its handle through buildHandle too.
const HANDLE_GUARD_PENDING_FILES = [];
// Files whose handle literals feed buildHandle: core names are allowed only
// inside their `session`/`content` literals (the engine has only `content`).
const HANDLE_GUARD_FILES = ["js/mtlx-engine.js", "js/usd-scene-renderer.js", "js/usd-scene-app.jsx"];
const HANDLE_GUARD_GENERIC_NAMES = new Set(["dispose", "resize", "snapshot"]);
// Verified non-handle keys that reuse a contract name, one entry per site.
const HANDLE_GUARD_ALLOW = [
  { file: "js/usd-scene-renderer.js", name: "setResizeSuspended", reason: "sizer adapter handed to MtlxRender.createCaptureController (createSizer's interface)" },
  { file: "js/usd-scene-renderer.js", name: "whenSettled", reason: "createSceneRebuildQueue's own fence, not a handle" },
];

function loadHandleContract() {
  const source = readFileSync(path.join(REPO_ROOT, "js", "shared", "render-session.js"), "utf8");
  const sandbox = { window: { addEventListener: () => {}, removeEventListener: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.window.MtlxRender.HANDLE_CONTRACT;
}

// Finds the char range of `const <name> = {` through the `};` line at the
// same indentation; returns null when the block is not present.
function findObjectLiteralRange(text, constName) {
  const startRe = new RegExp(`\\n( *)const ${constName} = \\{`);
  const m = startRe.exec(text);
  if (!m) return null;
  const closeRe = new RegExp(`\\n${m[1]}\\};`, "g");
  closeRe.lastIndex = m.index + m[0].length;
  const close = closeRe.exec(text);
  if (!close) return null;
  return [m.index, close.index + close[0].length];
}

// Scoped to js/mtlx-engine.js only (design: "live for the engine"), not
// the whole repo: consumer files legitimately reuse these words for their
// OWN unrelated objects (e.g. embed-boot.js's postMessage dispatch table),
// which is not the regression this guard exists to catch.
function checkHandleContractGuard() {
  const problems = [];
  const names = loadHandleContract().filter((n) => !HANDLE_GUARD_GENERIC_NAMES.has(n) && n !== "__debug");
  for (const file of HANDLE_GUARD_FILES) {
    const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
    const allowedRanges = [findObjectLiteralRange(text, "session"), findObjectLiteralRange(text, "content")].filter(Boolean);
    if (file === "js/mtlx-engine.js" && !findObjectLiteralRange(text, "content")) {
      problems.push(`no \`const content = {\` literal found in ${file}; update this guard`);
    }
    const inAllowedRange = (idx) => allowedRanges.some(([s, e]) => idx >= s && idx < e);
    for (const name of names) {
      const keyRe = new RegExp(`(?:^|[{,]\\s*)${name}\\s*:`, "gm");
      let m;
      while ((m = keyRe.exec(text))) {
        const idx = m.index + m[0].indexOf(name);
        if (inAllowedRange(idx)) continue;
        if (HANDLE_GUARD_ALLOW.some((a) => a.file === file && a.name === name)) continue;
        problems.push(`handle-contract name "${name}" defined as an object-literal key in ${file} (outside the session/content passed to buildHandle)`);
      }
    }
  }
  if (problems.length) {
    fail(["handle-contract guard (g) failed:", ...problems.map((p) => `  - ${p}`)].join("\n"));
  }
  log(`(g) handle-contract guard OK, ${names.length} names checked in ${HANDLE_GUARD_FILES.join(", ")}.`);
}

// ---------------------------------------------------------------------
// (h) renderer-creation guard (P3-DESIGN.md section 4 S5, "guard (d)"):
// `new THREE.WebGLRenderer(`, `getContext('webgl2'` and
// `toneMappingExposure =` only in js/shared/render-session.js, plus a
// short, verified allowlist.
// ---------------------------------------------------------------------
const RENDERER_CREATION_PATTERNS = [
  "new THREE.WebGLRenderer(",
  "getContext('webgl2'",
  "toneMappingExposure =",
];
// Emptied in P6 S2: the Scene acquires its renderer through the session.
const RENDERER_CREATION_PENDING_FILES = [];
// Verified one-off sites: a warm-compile probe context, the KTX2 basis
// support probe, shell.jsx's WebGL2-availability probe, and Compare's
// GPU diff readback, none of which build/own the actual view's renderer.
const RENDERER_CREATION_ALLOW = [
  { file: "js/mtlx-engine.js", pattern: "getContext('webgl2'", reason: "warm-compile probe context (getWarmContext)" },
  { file: "js/mtlx-engine.js", pattern: "new THREE.WebGLRenderer(", reason: "KTX2 basis-transcode support probe (getKtx2Loader), throwaway and disposed" },
  { file: "js/shell.jsx", pattern: "getContext('webgl2'", reason: "startup WebGL2-availability probe" },
  { file: "js/compare-app.jsx", pattern: "getContext('webgl2'", reason: "GPU diff readback context" },
  { file: "js/compare-app.jsx", pattern: "new THREE.WebGLRenderer(", reason: "GPU diff readback renderer, verified compare-app.jsx:402/407" },
];

function checkRendererCreationGuard() {
  const problems = [];
  const files = listSourceFiles();
  const allowSet = new Set(RENDERER_CREATION_ALLOW.map((e) => `${e.file}|${e.pattern}`));
  for (const file of files) {
    if (file === "js/shared/render-session.js") continue;
    if (RENDERER_CREATION_PENDING_FILES.includes(file)) continue;
    const abs = path.join(REPO_ROOT, file);
    const text = readFileSync(abs, "utf8");
    for (const pattern of RENDERER_CREATION_PATTERNS) {
      if (!text.includes(pattern)) continue;
      if (allowSet.has(`${file}|${pattern}`)) continue;
      problems.push(`"${pattern}" found in ${file}, outside js/shared/render-session.js (not PENDING, not ALLOW-listed)`);
    }
  }
  if (problems.length) {
    fail(["renderer-creation guard (h) failed:", ...problems.map((p) => `  - ${p}`)].join("\n"));
  }
  log(`(h) renderer-creation guard OK, ${files.length} files scanned.`);
}

// ---------------------------------------------------------------------
// (i) resolver/texture-session duplication ledger (P4-DESIGN.md section 6
// "Slices", every slice's note): the engine copies below intentionally
// duplicate a Scene function's behavior (P4c's exact:true resolvers and
// texture session) rather than the Scene calling the shared one yet, since
// P4 does not touch js/usd-scene-renderer.js. PENDING until the Scene
// switches over (P6, per P4-DESIGN.md section 3 "Scene in P6"). This does
// not fail the build: it is a visible ledger so the duplication cannot
// silently rot, checked by confirming BOTH named symbols still exist.
// ---------------------------------------------------------------------
const RESOLVER_DUPLICATION_PENDING = [
  { engine: "joinRefPath", scene: "sceneJoinPath", note: "P4c: exact-mode path join/resolve" },
  { engine: "findFileForRef", scene: "sceneExactFile", note: "P4c: exact-mode single-file resolve" },
  { engine: "preferKtx2Sibling", scene: "sceneKtx2SiblingPath", note: "P4c: ktx2 sibling substitution" },
  { engine: "findFilesForRef", scene: "sceneUdimTiles", note: "P4c: exact-mode UDIM tile resolve" },
  { engine: "resolveIncludes", scene: "resolveSceneIncludes", note: "P4c: exact-mode xi:include resolution" },
  { engine: "planTextureSession", scene: "planTextureSize", note: "P4c: texture tier/budget ladder math" },
  { engine: "decodeTextureSource", scene: "decodeUnboundedSceneTexture", note: "P4c: per-format texture decode matrix" },
];

function checkResolverDuplicationLedger() {
  const problems = [];
  const engineText = readFileSync(path.join(REPO_ROOT, "js", "mtlx-engine.js"), "utf8");
  const sceneText = readFileSync(path.join(REPO_ROOT, "js", "usd-scene-renderer.js"), "utf8");
  for (const entry of RESOLVER_DUPLICATION_PENDING) {
    if (!new RegExp(`\\bconst ${entry.engine}\\b`).test(engineText)) {
      problems.push(`ledger entry "${entry.engine}" (${entry.note}) is missing from js/mtlx-engine.js; update or remove this PENDING entry`);
    }
    if (!new RegExp(`\\bconst ${entry.scene}\\b`).test(sceneText)) {
      problems.push(`ledger entry "${entry.scene}" (${entry.note}) is missing from js/usd-scene-renderer.js; update or remove this PENDING entry`);
    }
  }
  if (problems.length) {
    fail(["resolver duplication ledger (i) failed:", ...problems.map((p) => `  - ${p}`)].join("\n"));
  }
  log(`(i) resolver duplication ledger OK, ${RESOLVER_DUPLICATION_PENDING.length} PENDING pairs tracked (Scene consolidation: P6).`);
}

// ---------------------------------------------------------------------
// (j) IIFE guard (plan guard (d), P6 S2): js/shared/render-*.js and
// js/usd-scene-*.js run as one IIFE, so no top-level name can collide with
// the engine's unwrapped globals. First statement `(`, last `})(...);`.
// ---------------------------------------------------------------------
function checkIifeGuard() {
  const problems = [];
  const files = listSourceFiles().filter((f) => /^js\/shared\/render-[^/]+\.js$/.test(f) || /^js\/usd-scene-[^/]+\.js$/.test(f));
  for (const file of files) {
    const text = readFileSync(path.join(REPO_ROOT, file), "utf8");
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
      .filter((line) => line.trim() !== "" && !/^\s*\/\//.test(line));
    const first = code.length ? code[0].trim() : "";
    const last = code.length ? code[code.length - 1].trim() : "";
    if (!first.startsWith("(") || !/^\}\)\([^)]*\);$/.test(last)) {
      problems.push(`${file} is not a single IIFE (first statement "${first.slice(0, 40)}", last "${last.slice(0, 40)}")`);
    }
  }
  if (problems.length) {
    fail(["IIFE guard (j) failed:", ...problems.map((p) => `  - ${p}`)].join("\n"));
  }
  log(`(j) IIFE guard OK, ${files.length} files.`);
}

checkManifestShape();
checkStorageKeyScan();
checkOptionListRatchet();
checkUiCoverage();
checkRenderFeaturesDoc();
checkEmbedConsistency();
checkHandleContractGuard();
checkRendererCreationGuard();
checkResolverDuplicationLedger();
checkIifeGuard();
log(`OK${CHECK_MODE ? " --check" : ""}`);
