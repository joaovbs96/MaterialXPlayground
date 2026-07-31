#!/usr/bin/env node
// scripts/build-nodelib.mjs
//
// Pre-generates the Node Library docs (nodelib.json = spec-derived node
// database, nodelib-index.json = version groups, auto port tables, and
// impl-target matrix) instead of parsing live in-browser via WASM. Both
// are committed; --check verifies without writing, so CI catches drift.
// Needs network unless vendor/materialx/ is populated.
// Usage: node scripts/build-nodelib.mjs [--check]

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

/** Shared by the write path and --check compare (mirrors
 * scripts/extract-mtlx-version.mjs's serialize()). Explicit '\n' is safe
 * on Windows since writeFile never translates newlines. */
function serialize(x) {
  return JSON.stringify(x, null, 1) + "\n";
}

/** Instantiates the vendored WASM build (mirrors version.mjs's
 * extractVersionFromWasm() / mtlx-engine.js's getMxEnv()), plus a
 * GenContext + stdlib for walking nodedefs. Returns { mx, stdlib }. */
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

/** Builds Layer 1 (db) and Layer 2 (index) in memory only; the caller
 * decides whether to write them or byte-compare against disk (--check). */
async function build() {
  const meta = await readVersionMeta();

  const require = createRequire(import.meta.url);
  const MtlxSpecParser = require("./lib/spec-parser.js");
  MtlxSpecParser.SPEC_TAG = meta.tag;

  const { mx, stdlib } = await loadMxEnv();

  // Layer 1: spec-derived node database (description/notes/port_tables from
  // the spec markdown, joined against the WASM nodedefs).
  const db = await MtlxSpecParser.buildNodeDatabase({ mx, stdlib });

  // Layer 2: signature/version groups, auto tables, and the impl matrix.
  // A document with stdlib attached as a DATA LIBRARY (same pattern as
  // js/graph/model.jsx) is needed for getMatchingNodeDefs() to work.
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

        // Repeat category names (e.g. `mix`) overwrite in place; JS keeps
        // first-insertion key order. sigGroups/impl are identical across
        // duplicates (name-based lookup) — only undocumented-ness can differ.
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

/** Runs sanity checks against the in-memory db/index (never committed
 * files), so --check catches stale files AND bad generation. Collects
 * every failure and returns them as an array of strings (empty = ok). */
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

  // Pin known-good resolved paths so a regression in
  // nodedef-extract.mjs's repoPathFromSourceUri/resolveImplFile is
  // caught here instead of silently shipping broken GitHub links.
  const imageFloat = (index.nodes.image?.impl || []).find((r) => r.type === "float");
  check(!!imageFloat, "index.nodes['image'] has no float-signature impl row");
  if (imageFloat) {
    check((imageFloat.files || {}).genosl === "libraries/stdlib/genosl/mx_image_float.osl",
      `image (float) files.genosl is ${JSON.stringify((imageFloat.files || {}).genosl)}, expected 'libraries/stdlib/genosl/mx_image_float.osl'`);
  }
  const addFloat = (index.nodes.add?.impl || []).find((r) => r.type === "float");
  check(!!addFloat, "index.nodes['add'] has no float-signature impl row");
  if (addFloat) {
    const files = addFloat.files || {};
    check(!!files.essl && files.essl === files.genglsl,
      `add (float) files.essl (${JSON.stringify(files.essl)}) does not equal files.genglsl (${JSON.stringify(files.genglsl)})`);
  }
  const tiledimageRow = (index.nodes.tiledimage?.impl || [])[0];
  check(!!tiledimageRow && tiledimageRow.graphFile === "libraries/stdlib/stdlib_ng.mtlx",
    `index.nodes['tiledimage'].impl[0].graphFile is ${JSON.stringify(tiledimageRow && tiledimageRow.graphFile)}, expected 'libraries/stdlib/stdlib_ng.mtlx'`);
  const surfaceShaderRow = (index.nodes.standard_surface?.impl || [])[0];
  check(!!surfaceShaderRow && surfaceShaderRow.graphFile === "libraries/bxdf/standard_surface.mtlx",
    `index.nodes['standard_surface'].impl[0].graphFile is ${JSON.stringify(surfaceShaderRow && surfaceShaderRow.graphFile)}, expected 'libraries/bxdf/standard_surface.mtlx'`);

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
