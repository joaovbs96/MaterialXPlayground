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
// Also writes/checks js/gen/mtlx-versions.json — the full version
// registry (scripts/lib/mtlx-versions.mjs) reduced to what the browser
// needs (js/mtlx-assets.js reads it to populate the Compare view's
// per-pane dropdown). It's generated here rather than by
// scripts/fetch-mtlx-versions.mjs because it's static metadata (just
// version numbers) that needs no network and no downloaded WASM.
//
// Usage: no args regenerates + stamps; --check verifies only and
// exits non-zero on drift.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVersionFromWasm, readVersionMeta, VERSION_META_PATH, VERSIONS_META_PATH, stampAll, checkStamps } from "./lib/version.mjs";
import { MTLX_VERSIONS, DEFAULT_MTLX_VERSION } from "./lib/mtlx-versions.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const RELATIVE_META_PATH = path.relative(REPO_ROOT, VERSION_META_PATH);
const RELATIVE_VERSIONS_META_PATH = path.relative(REPO_ROOT, VERSIONS_META_PATH);

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

/** js/gen/mtlx-versions.json's shape: { default, versions: [{ version }] }. */
function buildVersionsManifest() {
  return {
    default: DEFAULT_MTLX_VERSION,
    versions: MTLX_VERSIONS.map((entry) => ({ version: entry.version })),
  };
}

/** DEFAULT_MTLX_VERSION (scripts/lib/mtlx-versions.mjs, computed as the max by numeric version
 * components) must equal what the committed WASM actually reports. If someone adds a newer entry
 * to MTLX_VERSIONS without re-vendoring js/materialx/<version>/ as the new committed default,
 * these two silently disagree unless this is checked explicitly — fail loudly instead. */
function assertRegistryDefaultMatchesWasm(liveVersion) {
  if (DEFAULT_MTLX_VERSION !== liveVersion) {
    fail(
      [
        `error: DEFAULT_MTLX_VERSION in scripts/lib/mtlx-versions.mjs ("${DEFAULT_MTLX_VERSION}") does not match the version reported by`,
        `the committed WASM in js/materialx/${DEFAULT_MTLX_VERSION}/ ("${liveVersion}").`,
        "This usually means a newer entry was added to MTLX_VERSIONS without re-vendoring the committed default:",
        `js/materialx/${DEFAULT_MTLX_VERSION}/ must actually contain the ${DEFAULT_MTLX_VERSION} build (see docs/BUILDING.md), or`,
        "DEFAULT_MTLX_VERSION must not yet claim to be the default until it is.",
      ].join("\n")
    );
  }
}

async function runExtract() {
  const meta = await extractVersionFromWasm();
  assertRegistryDefaultMatchesWasm(meta.version);

  await mkdir(path.dirname(VERSION_META_PATH), { recursive: true });
  await writeFile(VERSION_META_PATH, serialize(meta));
  log(`wrote ${RELATIVE_META_PATH}: ${JSON.stringify(meta)}`);

  const versionsManifest = buildVersionsManifest();
  await writeFile(VERSIONS_META_PATH, serialize(versionsManifest));
  log(`wrote ${RELATIVE_VERSIONS_META_PATH}: ${JSON.stringify(versionsManifest)}`);

  const changed = await stampAll(meta);
  if (changed.length > 0) {
    log(`stamped ${changed.length} file(s): ${changed.join(", ")}`);
  } else {
    log("stamped 0 file(s) — every literal already matched.");
  }
}

async function runCheck() {
  const liveMeta = await extractVersionFromWasm();
  assertRegistryDefaultMatchesWasm(liveMeta.version);
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

  const liveVersionsManifest = buildVersionsManifest();
  const liveVersionsSerialized = serialize(liveVersionsManifest);
  if (!existsSync(VERSIONS_META_PATH)) {
    fail(`error: ${RELATIVE_VERSIONS_META_PATH} not found — stale, rerun \`node scripts/extract-mtlx-version.mjs\`.`);
  }
  const committedVersionsRaw = await readFile(VERSIONS_META_PATH, "utf8");
  if (committedVersionsRaw !== liveVersionsSerialized) {
    fail(
      [
        `error: ${RELATIVE_VERSIONS_META_PATH} is stale — rerun \`node scripts/extract-mtlx-version.mjs\`.`,
        `  registry reports: ${JSON.stringify(liveVersionsManifest)}`,
        `  committed file has: ${committedVersionsRaw.trim()}`,
      ].join("\n")
    );
  }
  log(`OK — ${RELATIVE_VERSIONS_META_PATH} matches scripts/lib/mtlx-versions.mjs (default ${liveVersionsManifest.default}).`);

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
