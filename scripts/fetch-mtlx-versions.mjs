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
// dependency, so this implements a minimal ZIP reader: locate the End
// Of Central Directory record, walk central-directory entries for the
// wanted names, then re-read each entry's OWN local header (its name/
// extra-field lengths often differ from the central directory's copy)
// to find where the compressed data actually starts. Supports STORED
// (0) and DEFLATE (8, via node:zlib.inflateRawSync) and verifies the
// CRC-32 of the inflated bytes against the central directory record —
// the integrity check that catches a truncated/corrupt extraction.

import { writeFile, mkdir } from "node:fs/promises";
import { existsSync, statSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MTLX_VERSIONS, DEFAULT_MTLX_VERSION, mtlxVersionAssetUrl } from "./lib/mtlx-versions.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const MATERIALX_ROOT = path.join(REPO_ROOT, "js", "materialx");

const CHECK_MODE = process.argv.includes("--check");

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
// Minimal ZIP reader (STORED + DEFLATE only) — no archive dependency.
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_LENGTH = 65535;

/** CRC-32 (IEEE 802.3) lookup table, built once. */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Scans backward for the End Of Central Directory record. Its comment
 * field is variable-length (0-65535 bytes), so the record is NOT
 * reliably the last 22 bytes of the file — scan rather than assume. */
function findEndOfCentralDirectory(zipBuf) {
  const searchFloor = Math.max(0, zipBuf.length - (EOCD_MIN_SIZE + MAX_COMMENT_LENGTH));
  for (let offset = zipBuf.length - EOCD_MIN_SIZE; offset >= searchFloor; offset--) {
    if (zipBuf.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("not a valid ZIP: End Of Central Directory record not found");
}

/** Reads + decompresses one entry, starting from its LOCAL header (not
 * the central directory's): the local header's own name/extra-field
 * lengths are re-read here because they frequently differ from the
 * central directory's copy of the same fields — using the central
 * directory's lengths to locate the data is the classic bug. */
function readZipEntryData(zipBuf, localHeaderOffset, compressionMethod, compressedSize, uncompressedSize) {
  if (zipBuf.readUInt32LE(localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(`not a valid ZIP: expected local file header signature at offset ${localHeaderOffset}`);
  }
  const localNameLength = zipBuf.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = zipBuf.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
  const compressed = zipBuf.subarray(dataStart, dataStart + compressedSize);

  if (compressionMethod === 0) {
    return Buffer.from(compressed);
  }
  if (compressionMethod === 8) {
    const inflated = zlib.inflateRawSync(compressed);
    if (inflated.length !== uncompressedSize) {
      throw new Error(`inflated size (${inflated.length}) != uncompressed size in ZIP record (${uncompressedSize})`);
    }
    return inflated;
  }
  throw new Error(`unsupported ZIP compression method ${compressionMethod} (only STORED=0 and DEFLATE=8 are handled)`);
}

/** Extracts the given basenames out of an in-memory ZIP buffer, keyed
 * by basename -> Buffer. Only entries in `wantedNames` are inflated;
 * everything else in the archive is skipped untouched. */
function extractFromZip(zipBuf, wantedNames) {
  const eocdOffset = findEndOfCentralDirectory(zipBuf);
  const entryCount = zipBuf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = zipBuf.readUInt32LE(eocdOffset + 16);

  const wanted = new Set(wantedNames);
  const found = new Map();

  let pos = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    if (zipBuf.readUInt32LE(pos) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error(`not a valid ZIP: expected central directory signature at offset ${pos} (entry ${i + 1}/${entryCount})`);
    }
    const compressionMethod = zipBuf.readUInt16LE(pos + 10);
    const expectedCrc32 = zipBuf.readUInt32LE(pos + 16);
    const compressedSize = zipBuf.readUInt32LE(pos + 20);
    const uncompressedSize = zipBuf.readUInt32LE(pos + 24);
    const nameLength = zipBuf.readUInt16LE(pos + 28);
    const extraLength = zipBuf.readUInt16LE(pos + 30);
    const commentLength = zipBuf.readUInt16LE(pos + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(pos + 42);
    const name = zipBuf.toString("utf8", pos + 46, pos + 46 + nameLength);

    // Entries may carry a directory prefix inside the zip; match on the
    // basename so e.g. "javascript/JsMaterialXGenShader.wasm" still
    // resolves to the wanted "JsMaterialXGenShader.wasm".
    const baseName = name.split("/").pop();
    if (wanted.has(baseName) && !found.has(baseName)) {
      const data = readZipEntryData(zipBuf, localHeaderOffset, compressionMethod, compressedSize, uncompressedSize);
      const actualCrc32 = crc32(data);
      if (actualCrc32 !== expectedCrc32) {
        throw new Error(
          `ZIP entry "${name}" failed CRC-32 verification (expected ${expectedCrc32.toString(16)}, got ${actualCrc32.toString(16)}) — the download may be truncated or corrupt`
        );
      }
      found.set(baseName, data);
    }

    pos += 46 + nameLength + extraLength + commentLength;
  }

  return found;
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
    extracted = extractFromZip(zipData, wantedNames);
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
  if (CHECK_MODE) {
    await runCheck();
  } else {
    await runFetch();
  }
}
