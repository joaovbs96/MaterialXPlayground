// scripts/lib/version.mjs
//
// Single source of truth for "what MaterialX version is this repo built
// against": the vendored WASM build (js/JsMaterialXGenShader.js/.wasm/.data)
// reports its own version through the JS API, so nothing else in this repo
// is allowed to hand-type a version literal. extract-mtlx-version.mjs reads
// it from the WASM once and writes it to js/gen/mtlx-version.json (a
// committed, generated file); everything else either reads that JSON
// (readVersionMeta, for code that can `import`/`require` at build/run time)
// or gets it rewritten into place by stampAll (for the handful of spots —
// plain <script>-tag globals, the README — that can't).
//
// Node >=18, ESM, zero runtime dependencies. Repo root is derived from
// import.meta.url so this module works from any working directory, same as
// scripts/vendor.mjs.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export const VERSION_META_PATH = path.join(REPO_ROOT, "js", "gen", "mtlx-version.json");

/** Instantiate the vendored MaterialX WASM build (same load pattern
 * js/mtlx-engine.js uses in the browser: only JsMaterialXGenShader.js —
 * loading JsMaterialXCore.js too would double-register embind types) and
 * read its self-reported version. This is the ONLY place in the whole build
 * pipeline allowed to treat the WASM as the version authority — every other
 * consumer derives from its output instead. */
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

/** Read + validate js/gen/mtlx-version.json. Deliberately has NO literal
 * fallback: the file is generated, so any failure to read/parse/validate it
 * means the build pipeline hasn't run yet (or the file was hand-edited into
 * a bad shape) — throw a clear, actionable error rather than silently
 * making up a version. */
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
// STAMP_TABLE: every place in the repo that carries its own literal copy of
// the MaterialX tag because it runs in a context that can't read
// js/gen/mtlx-version.json directly (plain <script> globals loaded before
// any module graph exists, a README string). Each entry's `re` must match
// the target file's content EXACTLY ONCE and capture the current tag as its
// first group — stampAll() and checkStamps() below both use it, so the
// "write" and "verify" paths can never disagree with each other.
//
// scripts/lib/spec-parser.js's SPEC_TAG fallback is deliberately NOT listed
// here — a separate phase moves it off a literal fallback entirely.
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
    describe: "intro line's WebAssembly version",
    re: /Built on the MaterialX (v[\d.]+) WebAssembly/,
    replacement: (meta) => `Built on the MaterialX ${meta.tag} WebAssembly`,
  },
  {
    path: "README.md",
    describe: "JsMaterialX* files' version note",
    re: /\(`\.js`\/`\.wasm`\/`\.data`, (v[\d.]+)\)/,
    replacement: (meta) => `(\`.js\`/\`.wasm\`/\`.data\`, ${meta.tag})`,
  },
];

/** Apply every STAMP_TABLE replacement in place. Errors (rather than
 * silently skipping) if any pattern fails to match exactly once, since that
 * means the target file's shape changed and STAMP_TABLE is now out of date.
 * Returns the list of files actually rewritten (files already matching
 * `meta` are left untouched — no spurious diffs). */
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

/** Extract the current value at each STAMP_TABLE location and compare it
 * against `meta.tag`. Read-only — never writes. Returns an array of problem
 * strings (empty = every stamp agrees), one per disagreement/missing file/
 * unmatched pattern, in the form "path: found vA.B.C, expected vX.Y.Z". */
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
