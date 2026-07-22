#!/usr/bin/env node
// scripts/build-nodelib.mjs
//
// Pre-generates the "Node Library" documentation data at build time instead
// of parsing it live in the browser via WASM. Writes two committed files:
//
//   js/gen/nodelib.json       ("Layer 1") — the spec-derived node database,
//                             structurally identical to what the old
//                             in-browser live spec-parser used to produce:
//                             { library: { nodegroup: { category: {
//                               description, notes, section, references,
//                               port_tables, spec_url } } } }
//
//   js/gen/nodelib-index.json ("Layer 2") — per-category signature/version
//                             groups (groupDefVersions), auto-generated port
//                             tables for undocumented nodes
//                             (buildAutoTablesFromDefs), def-port fallback
//                             rows for undocumented nodes with no auto
//                             tables (buildDefPorts), and the
//                             implementation-target matrix (buildImplRows),
//                             plus the sorted union of every shading-
//                             language target seen (allTargets):
//                             { meta: {tag, version}, allTargets: [...],
//                               nodes: { category: { sigGroups, autoTables?,
//                               defPorts?, impl } } }
//
// Both files are produced by instantiating the vendored MaterialX WASM build
// directly in Node (no browser) — see scripts/lib/version.mjs's
// extractVersionFromWasm() for the base load pattern this mirrors, and
// scripts/lib/spec-parser.js / scripts/lib/nodedef-extract.mjs for the
// actual database/index construction this script wires together.
//
// Generating Layer 1 needs network access for the 3 spec markdown files
// UNLESS vendor/materialx/ is populated (this repo's checkout has it
// populated by `npm run vendor:offline` — scripts/lib/spec-parser.js's
// readSpecDoc() logs "spec docs: local vendor/materialx (<file>)" when that
// local-read path is taken, vs. "spec docs: remote fetch (<file>@<tag>)"
// when it falls back to raw.githubusercontent.com).
//
// Both output files are committed to the repo (same contract as
// js/gen/mtlx-version.json / scripts/extract-mtlx-version.mjs): `npm run
// build` (or this script directly) regenerates them, and --check verifies
// they're not stale WITHOUT writing anything, so a stale commit is caught in
// CI rather than silently shipping wrong/outdated node docs.
//
// Usage:
//   node scripts/build-nodelib.mjs           (Re)generate js/gen/nodelib.json
//                                             and js/gen/nodelib-index.json
//                                             from the vendored WASM + spec
//                                             docs.
//   node scripts/build-nodelib.mjs --check   Verify only: rebuild both files
//                                             in memory and byte-compare
//                                             against the committed copies.
//                                             Writes nothing. Non-zero exit
//                                             on any drift (or on any sanity
//                                             assertion failure).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { readVersionMeta } from "./lib/version.mjs";
import {
  vecToArray,
  isUndocumented,
  groupDefVersions,
  dedupeDefsBySignature,
  buildAutoTablesFromDefs,
  buildDefPorts,
  buildImplIndex,
  buildImplRows,
} from "./lib/nodedef-extract.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const NODELIB_PATH = path.join(REPO_ROOT, "js", "gen", "nodelib.json");
const NODELIB_INDEX_PATH = path.join(REPO_ROOT, "js", "gen", "nodelib-index.json");
const RELATIVE_NODELIB_PATH = path.relative(REPO_ROOT, NODELIB_PATH);
const RELATIVE_NODELIB_INDEX_PATH = path.relative(REPO_ROOT, NODELIB_INDEX_PATH);

const CHECK_MODE = process.argv.includes("--check");

function log(...args) {
  console.log(...args);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Same serialization used for both the write path and the --check
 * byte-compare (mirrors scripts/extract-mtlx-version.mjs's serialize()), so
 * the two can never disagree over formatting. Explicit '\n' (LF, not CRLF —
 * writeFile on a plain string never translates newlines, so this is safe on
 * Windows checkouts). */
function serialize(x) {
  return JSON.stringify(x, null, 1) + "\n";
}

/** Instantiate the vendored MaterialX WASM build with a live ESSL generator
 * context, mirroring scripts/lib/version.mjs's extractVersionFromWasm() /
 * js/mtlx-engine.js's getMxEnv() load pattern, but additionally building a
 * GenContext + stdlib (needed to walk nodedefs here, not just read the
 * version string). Returns { mx, stdlib }. */
async function loadMxEnv() {
  const jsPath = path.join(REPO_ROOT, "js", "JsMaterialXGenShader.js");
  const mod = await import(pathToFileURL(jsPath));
  const mx = await mod.default({
    // .wasm and .data live next to the .js.
    locateFile: (p) => path.join(REPO_ROOT, "js", p),
  });
  const gen = mx.EsslShaderGenerator.create();
  const ctx = new mx.GenContext(gen);
  const stdlib = mx.loadStandardLibraries(ctx);
  return { mx, stdlib };
}

/** Build both Layer 1 (db) and Layer 2 (index) in memory. Never writes
 * anything — the caller decides whether to write (normal mode) or
 * byte-compare against the committed files (--check mode) after running
 * the sanity assertions below. */
async function build() {
  const meta = await readVersionMeta();

  const require = createRequire(import.meta.url);
  const MtlxSpecParser = require("./lib/spec-parser.js");
  MtlxSpecParser.SPEC_TAG = meta.tag;

  const { mx, stdlib } = await loadMxEnv();

  // Layer 1: spec-derived node database (description/notes/port_tables from
  // the spec markdown, joined against the WASM nodedefs).
  const db = await MtlxSpecParser.buildNodeDatabase({ mx, stdlib });

  // Layer 2: per-category signature/version groups, auto tables/def-port
  // fallbacks for undocumented nodes, and the implementation-target matrix.
  // A fresh document with the stdlib attached as a DATA LIBRARY (referenced,
  // not contained — same pattern as js/graph/model.jsx, js/node-preview.jsx)
  // is what getMatchingNodeDefs(category) needs to resolve nodedefs by name.
  const doc = mx.createDocument();
  doc.setDataLibrary(stdlib);

  const implIndex = buildImplIndex({ mx, stdlib });

  const nodes = {};
  const allTargetsSet = new Set();

  for (const lib of Object.keys(db)) {
    for (const group of Object.keys(db[lib])) {
      for (const category of Object.keys(db[lib][group])) {
        const defs = vecToArray(doc.getMatchingNodeDefs(category));
        const sigGroups = groupDefVersions(defs);

        const entry = { sigGroups };

        if (isUndocumented(db[lib][group][category])) {
          const autoTables = buildAutoTablesFromDefs(dedupeDefsBySignature(defs));
          if (autoTables.length) {
            entry.autoTables = autoTables;
          } else {
            const defPorts = buildDefPorts(defs);
            if (defPorts.length) entry.defPorts = defPorts;
          }
        }

        const impl = buildImplRows(implIndex, defs);
        entry.impl = impl;
        impl.forEach((row) => {
          row.targets.forEach((t) => allTargetsSet.add(t));
          row.inherited.forEach((t) => allTargetsSet.add(t));
        });

        // Overwrite-in-place on a repeat category name (e.g. `mix` appears
        // under more than one nodegroup) — plain-object key insertion order
        // in JS is determined by the FIRST assignment, so this still leaves
        // `nodes` in first-appearance order (required below) even though
        // the stored value reflects the LAST (lib, group) that visited it.
        // doc.getMatchingNodeDefs(category) queries by name across the
        // whole document regardless of which (lib, group) triggered the
        // call, so sigGroups/impl are identical either way; only the
        // undocumented-ness check (db[lib][group][category]) can vary
        // across duplicate names.
        nodes[category] = entry;
      }
    }
  }

  const allTargets = [...allTargetsSet].sort();
  const index = {
    meta: { tag: meta.tag, version: meta.version },
    allTargets,
    nodes,
  };

  return { db, index };
}

/** Run every sanity assertion against the freshly-computed (in-memory) db/
 * index — never against the committed files on disk, so --check mode
 * catches both "stale file" AND "generation itself produced garbage".
 * Collects every failure (rather than stopping at the first) so one run
 * reports everything wrong at once. Returns an array of problem strings
 * (empty = all good). */
function runSanityChecks(db, index) {
  const problems = [];
  const check = (cond, msg) => { if (!cond) problems.push(msg); };

  // Layer-1 category count (total categories across all lib/group pairs) >= 200.
  let categoryCount = 0;
  for (const lib of Object.keys(db)) {
    for (const group of Object.keys(db[lib])) {
      categoryCount += Object.keys(db[lib][group]).length;
    }
  }
  check(categoryCount >= 200, `Layer-1 category count is ${categoryCount}, expected >= 200`);

  // Every Layer-1 entry has EXACTLY the keys {description, notes, section,
  // references, port_tables, spec_url} — no more, no fewer.
  const EXPECTED_KEYS = ["description", "notes", "section", "references", "port_tables", "spec_url"];
  const EXPECTED_KEY_SET = new Set(EXPECTED_KEYS);
  const SPEC_URL_RE = /^https:\/\/github\.com\/AcademySoftwareFoundation\/MaterialX\/blob\/v[\d.]+\/documents\/Specification\/MaterialX\.\w+\.md#/;
  let specUrlProblems = 0;
  let keyShapeProblems = 0;
  for (const lib of Object.keys(db)) {
    for (const group of Object.keys(db[lib])) {
      for (const category of Object.keys(db[lib][group])) {
        const entry = db[lib][group][category];
        const keys = Object.keys(entry);
        const sameSize = keys.length === EXPECTED_KEYS.length;
        const sameSet = sameSize && keys.every((k) => EXPECTED_KEY_SET.has(k));
        if (!sameSet) {
          keyShapeProblems++;
          if (keyShapeProblems <= 5) {
            problems.push(`db.${lib}.${group}.${category} has keys [${keys.join(", ")}], expected exactly [${EXPECTED_KEYS.join(", ")}]`);
          }
        }
        if (!SPEC_URL_RE.test(entry.spec_url || "")) {
          specUrlProblems++;
          if (specUrlProblems <= 5) {
            problems.push(`db.${lib}.${group}.${category}.spec_url does not match the expected pattern: ${JSON.stringify(entry.spec_url)}`);
          }
        }
      }
    }
  }
  if (keyShapeProblems > 5) problems.push(`... and ${keyShapeProblems - 5} more Layer-1 entries with the wrong key shape`);
  if (specUrlProblems > 5) problems.push(`... and ${specUrlProblems - 5} more Layer-1 entries with a malformed spec_url`);

  // Total version entries summed across every category's sigGroups[*].versions >= 750.
  let totalVersions = 0;
  for (const category of Object.keys(index.nodes)) {
    for (const g of index.nodes[category].sigGroups) {
      totalVersions += g.versions.length;
    }
  }
  check(totalVersions >= 750, `Total sigGroups version-entry count is ${totalVersions}, expected >= 750`);

  // standard_surface: at least 2 versions on its first sigGroup, at least
  // one marked isDefaultVersion, at least one version's inputTypes or
  // defaults has a key named 'base'.
  const ss = index.nodes["standard_surface"];
  check(!!ss, "index.nodes['standard_surface'] is missing");
  if (ss) {
    const firstGroup = ss.sigGroups[0];
    check(!!firstGroup && firstGroup.versions.length >= 2,
      `index.nodes['standard_surface'].sigGroups[0].versions.length is ${firstGroup ? firstGroup.versions.length : "undefined"}, expected >= 2`);
    if (firstGroup) {
      check(firstGroup.versions.some((v) => v.isDefaultVersion === true),
        "index.nodes['standard_surface'].sigGroups[0].versions has no entry with isDefaultVersion: true");
      check(firstGroup.versions.some((v) => Object.prototype.hasOwnProperty.call(v.inputTypes || {}, "base")
          || Object.prototype.hasOwnProperty.call(v.defaults || {}, "base")),
        "index.nodes['standard_surface'].sigGroups[0].versions has no version with a 'base' key in inputTypes or defaults");
    }
  }

  // open_pbr_surface exists.
  check(!!index.nodes["open_pbr_surface"], "index.nodes['open_pbr_surface'] is missing");

  // multiply has more than one signature group.
  const mul = index.nodes["multiply"];
  check(!!mul && mul.sigGroups.length > 1,
    `index.nodes['multiply'].sigGroups.length is ${mul ? mul.sigGroups.length : "undefined"} (node missing?), expected > 1`);

  // allTargets includes genglsl, genosl, genmdl, genmsl.
  for (const t of ["genglsl", "genosl", "genmdl", "genmsl"]) {
    check(index.allTargets.includes(t), `index.allTargets is missing '${t}' (got: [${index.allTargets.join(", ")}])`);
  }

  return problems;
}

async function main() {
  const { db, index } = await build();

  const problems = runSanityChecks(db, index);
  if (problems.length > 0) {
    console.error("Sanity checks failed — refusing to write anything:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  const dbSerialized = serialize(db);
  const indexSerialized = serialize(index);

  if (CHECK_MODE) {
    let stale = false;

    for (const [relPath, absPath, serialized] of [
      [RELATIVE_NODELIB_PATH, NODELIB_PATH, dbSerialized],
      [RELATIVE_NODELIB_INDEX_PATH, NODELIB_INDEX_PATH, indexSerialized],
    ]) {
      if (!existsSync(absPath)) {
        console.error(`${relPath} — js/gen is stale — run \`npm run build:nodelib\` (or \`npm run build\`) and commit`);
        stale = true;
        continue;
      }
      const committed = await readFile(absPath, "utf8");
      if (committed !== serialized) {
        console.error(`${relPath} — js/gen is stale — run \`npm run build:nodelib\` (or \`npm run build\`) and commit`);
        stale = true;
      }
    }

    if (stale) process.exit(1);
    log(`OK — ${RELATIVE_NODELIB_PATH} and ${RELATIVE_NODELIB_INDEX_PATH} match a fresh build.`);
    return;
  }

  await mkdir(path.dirname(NODELIB_PATH), { recursive: true });
  await writeFile(NODELIB_PATH, dbSerialized);
  await writeFile(NODELIB_INDEX_PATH, indexSerialized);
  log(`wrote ${RELATIVE_NODELIB_PATH}: ${Buffer.byteLength(dbSerialized)} bytes`);
  log(`wrote ${RELATIVE_NODELIB_INDEX_PATH}: ${Buffer.byteLength(indexSerialized)} bytes`);
}

await main();
