// scripts/lib/version.mjs
//
// MaterialX version source of truth: the vendored WASM reports it once
// into js/gen/mtlx-version.json (extract-mtlx-version.mjs); everything
// else reads that JSON or gets it stamped in via stampAll.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export const VERSION_META_PATH = path.join(REPO_ROOT, "js", "gen", "mtlx-version.json");

/** Load the vendored WASM the same way the browser does (only
 * JsMaterialXGenShader.js — loading JsMaterialXCore.js too double-
 * registers embind types) and read its self-reported version. */
export async function extractVersionFromWasm() {
  const jsPath = path.join(REPO_ROOT, "js", "JsMaterialXGenShader.js");
  const mod = await import(pathToFileURL(jsPath));
  const mx = await mod.default({
    // .wasm and .data live next to the .js.
    locateFile: (p) => path.join(REPO_ROOT, "js", p),
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
    if (found !== meta.tag) {
      problems.push(`${entry.path}: found ${found}, expected ${meta.tag}`);
    }
  }
  return problems;
}
