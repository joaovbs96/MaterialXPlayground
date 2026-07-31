#!/usr/bin/env node
// scripts/extract-mtlx-version.mjs
//
// The MaterialX version must never be hand-typed: the vendored WASM
// build is the single source of truth. Extracts it to
// js/gen/mtlx-version.json and stamps the literal copies elsewhere
// that can't read that JSON at runtime (script-tag globals, README);
// vendor.mjs/specDocs.js read it directly instead. The JSON file is
// committed despite being generated so --check can catch a stale
// commit (builds regenerate/re-stamp it every run) before it ships.
//
// Usage: no args regenerates + stamps; --check verifies only and
// exits non-zero on drift.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVersionFromWasm, readVersionMeta, VERSION_META_PATH, stampAll, checkStamps } from "./lib/version.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const RELATIVE_META_PATH = path.relative(REPO_ROOT, VERSION_META_PATH);

const CHECK_MODE = process.argv.includes("--check");

function log(...args) {
  console.log(...args);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Same serialization used for both the write path and the --check byte-compare, so the two can
 * never disagree over formatting. */
function serialize(meta) {
  return JSON.stringify(meta, null, 1) + "\n";
}

async function runExtract() {
  const meta = await extractVersionFromWasm();

  await mkdir(path.dirname(VERSION_META_PATH), { recursive: true });
  await writeFile(VERSION_META_PATH, serialize(meta));
  log(`wrote ${RELATIVE_META_PATH}: ${JSON.stringify(meta)}`);

  const changed = await stampAll(meta);
  if (changed.length > 0) {
    log(`stamped ${changed.length} file(s): ${changed.join(", ")}`);
  } else {
    log("stamped 0 file(s) — every literal already matched.");
  }
}

async function runCheck() {
  const liveMeta = await extractVersionFromWasm();
  const liveSerialized = serialize(liveMeta);

  if (!existsSync(VERSION_META_PATH)) {
    fail(`error: ${RELATIVE_META_PATH} not found — stale, rerun \`node scripts/extract-mtlx-version.mjs\`.`);
  }
  const committedRaw = await readFile(VERSION_META_PATH, "utf8");
  if (committedRaw !== liveSerialized) {
    fail(
      [
        `error: ${RELATIVE_META_PATH} is stale — rerun \`node scripts/extract-mtlx-version.mjs\`.`,
        `  WASM reports: ${JSON.stringify(liveMeta)}`,
        `  committed file has: ${committedRaw.trim()}`,
      ].join("\n")
    );
  }
  log(`OK — ${RELATIVE_META_PATH} matches the vendored WASM (${liveMeta.tag}).`);

  const meta = await readVersionMeta();
  const stampProblems = await checkStamps(meta);
  if (stampProblems.length > 0) {
    fail(
      [
        `error: MaterialX version literals are out of sync with ${RELATIVE_META_PATH} (${meta.tag}):`,
        ...stampProblems.map((p) => `  - ${p}`),
        "",
        "Run `node scripts/extract-mtlx-version.mjs` to re-stamp.",
      ].join("\n")
    );
  }
  log(`OK — all stamped MaterialX version literals agree (${meta.tag}).`);
}

if (CHECK_MODE) {
  await runCheck();
} else {
  await runExtract();
}
