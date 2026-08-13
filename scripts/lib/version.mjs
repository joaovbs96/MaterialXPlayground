// scripts/lib/version.mjs
//
// MaterialX version source of truth: the vendored WASM reports it once
// into js/gen/mtlx-version.json (extract-mtlx-version.mjs); everything
// else reads that JSON or gets it stamped in via stampAll.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_MTLX_VERSION } from "./mtlx-versions.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export const VERSION_META_PATH = path.join(REPO_ROOT, "js", "gen", "mtlx-version.json");
export const VERSIONS_META_PATH = path.join(REPO_ROOT, "js", "gen", "mtlx-versions.json");

// Bootstrap note: extractVersionFromWasm() below GENERATES
// js/gen/mtlx-version.json, so it cannot read that file to learn which
// version directory to load — it has to know the committed default up
// front. DEFAULT_MTLX_VERSION comes from scripts/lib/mtlx-versions.mjs
// (the single source of truth for the version registry), never a local
// literal here, so this can't independently drift from that table.
// Mirrors js/mtlx-engine.js's MTLX_DEFAULT_VERSION literal (stamped
// separately via STAMP_TABLE below); every other Node-side caller in
// this repo instead threads readVersionMeta().version through, once
// it's available.

/** Load the vendored WASM the same way the browser does (only
 * JsMaterialXGenShader.js — loading JsMaterialXCore.js too double-
 * registers embind types) and read its self-reported version. */
export async function extractVersionFromWasm() {
  const versionDir = path.join(REPO_ROOT, "js", "materialx", DEFAULT_MTLX_VERSION);
  const jsPath = path.join(versionDir, "JsMaterialXGenShader.js");
  // Without this check, a registry edit that promotes a not-yet-committed
  // version to the default (DEFAULT_MTLX_VERSION is the computed max —
  // see mtlx-versions.mjs) fails downstream as a raw ERR_MODULE_NOT_FOUND
  // from the dynamic import below, which reads like a broken install
  // rather than the actual problem. Fail here instead, naming exactly
  // what's missing and what to do about it.
  if (!existsSync(jsPath)) {
    throw new Error(
      [
        `MaterialX WASM directory not found: ${path.relative(REPO_ROOT, versionDir)} (expected to contain ${path.basename(jsPath)}).`,
        `DEFAULT_MTLX_VERSION (scripts/lib/mtlx-versions.mjs) is computed as the newest entry in MTLX_VERSIONS and currently resolves to ${DEFAULT_MTLX_VERSION}, but that version's build isn't committed here.`,
        `Either commit ${DEFAULT_MTLX_VERSION}'s built JsMaterialXGenShader.js/.wasm/.data as the new default (see "Promoting a new default" in docs/BUILDING.md), or remove/adjust its entry in scripts/lib/mtlx-versions.mjs so the default points back at a version whose WASM is actually committed.`,
      ].join("\n")
    );
  }
  const mod = await import(pathToFileURL(jsPath));
  const mx = await mod.default({
    // .wasm and .data live next to the .js.
    locateFile: (p) => path.join(REPO_ROOT, "js", "materialx", DEFAULT_MTLX_VERSION, p),
  });
  const version = mx.getVersionString();
  const versionIntegers = Array.from(mx.getVersionIntegers());
  return { version, tag: `v${version}`, versionIntegers };
}

const VERSION_SHAPE_RE = /^\d+\.\d+\.\d+$/;
const REGEN_HINT = "run `node scripts/extract-mtlx-version.mjs` (or `npm run build`) to (re)generate it.";

/** Read + validate js/gen/mtlx-version.json. No literal fallback:
 * failures mean the build hasn't run yet (or the file was hand-
 * edited badly) — throw an actionable error instead of guessing. */
export async function readVersionMeta() {
  const relPath = path.relative(REPO_ROOT, VERSION_META_PATH);

  let raw;
  try {
    raw = await readFile(VERSION_META_PATH, "utf8");
  } catch (err) {
    throw new Error(`${relPath} not found — ${REGEN_HINT}`);
  }

  let meta;
  try {
    meta = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${relPath} is not valid JSON — ${REGEN_HINT}`);
  }

  if (!meta || typeof meta !== "object" || typeof meta.version !== "string" || !VERSION_SHAPE_RE.test(meta.version)) {
    throw new Error(`${relPath}: "version" is missing or not in X.Y.Z form (got ${JSON.stringify(meta && meta.version)}) — ${REGEN_HINT}`);
  }
  if (meta.tag !== `v${meta.version}`) {
    throw new Error(`${relPath}: "tag" (${JSON.stringify(meta.tag)}) is not "v" + version (${JSON.stringify("v" + meta.version)}) — ${REGEN_HINT}`);
  }

  return meta;
}

// ---------------------------------------------------------------------------
// STAMP_TABLE: files with their own literal copy of the MaterialX tag,
// since they can't read js/gen/mtlx-version.json directly (script
// globals, README) — shared by stampAll() and checkStamps() below.
// ---------------------------------------------------------------------------
export const STAMP_TABLE = [
  {
    path: "js/mtlx-assets.js",
    describe: "DEFAULT_TAG literal",
    re: /var DEFAULT_TAG = '(v[\d.]+)';/,
    replacement: (meta) => `var DEFAULT_TAG = '${meta.tag}';`,
  },
  {
    path: "js/site-header.js",
    describe: "MTLX_TAG fallback literal",
    re: /var MTLX_TAG = \(window\.MtlxAssets && window\.MtlxAssets\.MTLX_TAG\) \|\| '(v[\d.]+)';/,
    replacement: (meta) => `var MTLX_TAG = (window.MtlxAssets && window.MtlxAssets.MTLX_TAG) || '${meta.tag}';`,
  },
  {
    path: "README.md",
    describe: "MaterialX version badge",
    re: /MaterialX-(v[\d.]+)-/,
    replacement: (meta) => `MaterialX-${meta.tag}-`,
  },
  {
    path: "docs/BUILDING.md",
    describe: "JsMaterialX* files' version note",
    re: /\(`\.js`\/`\.wasm`\/`\.data`, (v[\d.]+)\)/,
    replacement: (meta) => `(\`.js\`/\`.wasm\`/\`.data\`, ${meta.tag})`,
  },
  {
    path: "js/mtlx-engine.js",
    describe: "MTLX_DEFAULT_VERSION literal",
    // A bare X.Y.Z (no "v") — it's a js/materialx/<version>/ path
    // segment, not a display tag — so it's compared against
    // meta.version rather than the default meta.tag via expect().
    re: /const MTLX_DEFAULT_VERSION = '(\d[\d.]*)';/,
    replacement: (meta) => `const MTLX_DEFAULT_VERSION = '${meta.version}';`,
    expect: (meta) => meta.version,
  },
];

/** Applies every STAMP_TABLE replacement in place; errors (rather than
 * skipping) if a pattern doesn't match exactly once, meaning the file's
 * shape changed. Returns only the files actually rewritten. */
export async function stampAll(meta) {
  const changedFiles = [];
  for (const entry of STAMP_TABLE) {
    const absPath = path.join(REPO_ROOT, entry.path);
    const original = await readFile(absPath, "utf8");

    const globalRe = new RegExp(entry.re.source, "g");
    const occurrences = original.match(globalRe);
    if (!occurrences || occurrences.length !== 1) {
      throw new Error(
        `${entry.path}: expected exactly one match for ${entry.describe} (pattern ${entry.re}), found ${occurrences ? occurrences.length : 0} — update STAMP_TABLE in scripts/lib/version.mjs if this file's shape changed`
      );
    }

    const updated = original.replace(entry.re, () => entry.replacement(meta));
    if (updated !== original) {
      await writeFile(absPath, updated);
      changedFiles.push(entry.path);
    }
  }
  return changedFiles;
}

/** Compares each STAMP_TABLE location's current value against
 * `meta.tag`; read-only, never writes. Returns problem strings (empty
 * = all agree), e.g. "path: found vA.B.C, expected vX.Y.Z". */
export async function checkStamps(meta) {
  const problems = [];
  for (const entry of STAMP_TABLE) {
    const absPath = path.join(REPO_ROOT, entry.path);
    let content;
    try {
      content = await readFile(absPath, "utf8");
    } catch (err) {
      problems.push(`${entry.path}: file not found (expected to check ${entry.describe})`);
      continue;
    }

    const match = content.match(entry.re);
    if (!match) {
      problems.push(`${entry.path}: could not find ${entry.describe} (pattern ${entry.re}) — update STAMP_TABLE in scripts/lib/version.mjs if this file's shape changed`);
      continue;
    }

    const found = match[1];
    const expected = entry.expect ? entry.expect(meta) : meta.tag;
    if (found !== expected) {
      problems.push(`${entry.path}: found ${found}, expected ${expected}`);
    }
  }
  return problems;
}
