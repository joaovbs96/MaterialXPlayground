#!/usr/bin/env node
// scripts/fetch-mtlx-versions.mjs
//
// Downloads the non-default MaterialX JS/WASM builds pinned in
// scripts/lib/mtlx-versions.mjs into js/materialx/<version>/. The
// default version is committed directly (see scripts/lib/version.mjs)
// and this script never touches it.
//
// Usage: node scripts/fetch-mtlx-versions.mjs [--check]
//   (no flag)  fetch + verify every non-default version not already
//              present at the correct byte sizes; no-op if all are.
//   --check    verify on-disk byte sizes only, never hits the network.
//              A version directory that's entirely ABSENT is valid —
//              a plain clone hasn't run this script yet — so `npm run
//              check` still passes without js/materialx/1.39.4/ etc.
//
// The repo deliberately vendors everything and adds no archive npm
// dependency, so this uses the minimal ZIP reader in scripts/lib/zip.mjs
// (shared with scripts/vendor.mjs's zip-source dependencies).

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, statSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MTLX_VERSIONS, DEFAULT_MTLX_VERSION, mtlxVersionAssetUrl } from "./lib/mtlx-versions.mjs";
import { extractFromZip } from "./lib/zip.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const MATERIALX_ROOT = path.join(REPO_ROOT, "js", "materialx");

function log(...args) {
  console.log(...args);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** Entries this script is responsible for — everything except the
 * committed default, which lives in git and is never fetched. */
function fetchableVersions() {
  return MTLX_VERSIONS.filter((entry) => entry.version !== DEFAULT_MTLX_VERSION);
}

function targetDir(entry) {
  return path.join(MATERIALX_ROOT, entry.version);
}

// ---------------------------------------------------------------------------
// Fetch + verify + extract one pinned version.
// ---------------------------------------------------------------------------

function directoryIsComplete(entry) {
  const dir = targetDir(entry);
  return Object.entries(entry.files).every(([name, expectedBytes]) => {
    const filePath = path.join(dir, name);
    return existsSync(filePath) && statSync(filePath).size === expectedBytes;
  });
}

async function downloadVersion(entry) {
  const url = mtlxVersionAssetUrl(entry);
  log(`downloading ${url} ...`);
  const res = await fetch(url);
  if (!res.ok) {
    fail(`error: failed to download ${url} — HTTP ${res.status} ${res.statusText}`);
  }
  const zipData = Buffer.from(await res.arrayBuffer());

  const actualZipSha256 = sha256Of(zipData);
  if (actualZipSha256 !== entry.zipSha256) {
    fail(
      [
        `error: sha256 mismatch for ${url}`,
        `  expected: ${entry.zipSha256}`,
        `  actual:   ${actualZipSha256}`,
        "The upstream release asset changed since this hash was pinned. Verify the new content is expected,",
        "then update zipSha256/zipBytes/files for this version in scripts/lib/mtlx-versions.mjs.",
      ].join("\n")
    );
  }
  if (zipData.length !== entry.zipBytes) {
    fail(
      `error: downloaded zip for ${entry.version} is ${zipData.length} bytes, expected ${entry.zipBytes} (pinned in scripts/lib/mtlx-versions.mjs) — ` +
        "the sha256 matched but the byte count didn't, which shouldn't be possible; investigate before trusting this download."
    );
  }

  const wantedNames = Object.keys(entry.files);
  let extracted;
  try {
    extracted = await extractFromZip(zipData, wantedNames);
  } catch (err) {
    fail(`error: failed to unzip ${url}: ${err.message}`);
  }
  for (const name of wantedNames) {
    if (!extracted.has(name)) {
      fail(`error: ${url} does not contain an entry named "${name}" (or a path ending in it)`);
    }
  }
  for (const [name, expectedBytes] of Object.entries(entry.files)) {
    const actualBytes = extracted.get(name).length;
    if (actualBytes !== expectedBytes) {
      fail(
        `error: extracted ${name} for ${entry.version} is ${actualBytes} bytes, expected ${expectedBytes} (pinned in scripts/lib/mtlx-versions.mjs)`
      );
    }
  }

  const dir = targetDir(entry);
  await mkdir(dir, { recursive: true });
  for (const name of wantedNames) {
    await writeFile(path.join(dir, name), extracted.get(name));
  }
  log(`wrote js/materialx/${entry.version}/ (${wantedNames.length} file(s), from ${url})`);
}

export async function runFetch() {
  const targets = fetchableVersions();
  for (const entry of targets) {
    if (directoryIsComplete(entry)) {
      log(`js/materialx/${entry.version}/ already present at the expected sizes — skipping.`);
      continue;
    }
    await downloadVersion(entry);
  }
  log(`OK — ${targets.length} non-default MaterialX version(s) available in js/materialx/.`);
}

// ---------------------------------------------------------------------------
// --check: verify on-disk byte sizes only. A version directory that is
// entirely absent is valid (mirrors vendor.mjs's existsSync(MATERIALX_
// MANIFEST_PATH) opt-in for vendor/materialx/), so a plain clone that
// never ran `npm run vendor:versions` still passes.
// ---------------------------------------------------------------------------
export async function runCheck() {
  const targets = fetchableVersions();
  const problems = [];
  let presentCount = 0;

  for (const entry of targets) {
    const dir = targetDir(entry);
    if (!existsSync(dir)) continue; // absence is valid — not yet fetched

    presentCount++;
    for (const [name, expectedBytes] of Object.entries(entry.files)) {
      const filePath = path.join(dir, name);
      if (!existsSync(filePath)) {
        problems.push(`  - js/materialx/${entry.version}/${name}: file missing on disk (the directory exists but is incomplete)`);
        continue;
      }
      const onDiskBytes = statSync(filePath).size;
      if (onDiskBytes !== expectedBytes) {
        problems.push(`  - js/materialx/${entry.version}/${name}: on-disk size (${onDiskBytes}) != expected size (${expectedBytes})`);
      }
    }
  }

  if (problems.length > 0) {
    fail(
      [
        "error: js/materialx/<version>/ is out of sync with scripts/lib/mtlx-versions.mjs (--check failed):",
        ...problems,
        "",
        "Run `npm run vendor:versions` to refetch.",
      ].join("\n")
    );
  }

  log(`OK — ${presentCount}/${targets.length} non-default MaterialX version(s) present on disk and byte-correct (absence is allowed).`);
}

// ---------------------------------------------------------------------------
// CLI entry point. Functions are also exported for scripts/build.mjs to
// call in-process; only auto-run when this file is the actual process
// entry point (mirrors scripts/vendor.mjs's isEntryModule()).
// ---------------------------------------------------------------------------
function isEntryModule() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  let values;
  try {
    ({ values } = parseArgs({ args: process.argv.slice(2), options: { check: { type: "boolean" } }, strict: true }));
  } catch (err) {
    fail(`error: ${err.message}`);
  }

  if (values.check) {
    await runCheck();
  } else {
    await runFetch();
  }
}
