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
// (Track B empties this).
const PENDING_FILES = ["js/usd-scene-renderer.js", "js/usd-scene-app.jsx"];

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
    let s = `${profile}: \`${P.storage}\``;
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
// Current eager embed payload (bytes) is ~1,331,221; budget is that plus
// 3%. Raise deliberately (with a comment on why) if the eager payload
// grows for a good reason (it is the embed's cold-load cost).
const EMBED_PAYLOAD_BUDGET = 1371158;

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
  "js/shared/mtlx-turntable.js",
  "js/shared/render-settings.js",
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

checkManifestShape();
checkStorageKeyScan();
checkRenderFeaturesDoc();
checkEmbedConsistency();
log(`OK${CHECK_MODE ? " --check" : ""}`);
