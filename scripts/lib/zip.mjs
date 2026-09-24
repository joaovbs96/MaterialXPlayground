// scripts/lib/zip.mjs
//
// Minimal ZIP reader (STORED + DEFLATE only), no archive dependency.
// Used by scripts/fetch-mtlx-versions.mjs and scripts/lib/vendor/zip.mjs.
// Reads central-directory entries, then re-reads each entry's OWN local
// header to find where its compressed data actually starts (the local
// header's name/extra-field lengths often differ from the central
// directory's copy of the same fields).

import zlib from "node:zlib";
import { globToRegExp } from "./glob.mjs";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_LENGTH = 65535;

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

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Scans backward for the End Of Central Directory record; its comment
 * field is variable-length, so it's not reliably the file's last 22 bytes. */
function findEndOfCentralDirectory(zipBuf) {
  const searchFloor = Math.max(0, zipBuf.length - (EOCD_MIN_SIZE + MAX_COMMENT_LENGTH));
  for (let offset = zipBuf.length - EOCD_MIN_SIZE; offset >= searchFloor; offset--) {
    if (zipBuf.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("not a valid ZIP: End Of Central Directory record not found");
}

/** Lists every central-directory entry. Throws on ZIP64 markers
 * (unsupported) and on encrypted entries (flag bit 0 set). */
export function listZipEntries(zipBuf) {
  const eocdOffset = findEndOfCentralDirectory(zipBuf);
  const entryCount = zipBuf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = zipBuf.readUInt32LE(eocdOffset + 16);
  if (entryCount === 0xffff || centralDirOffset === 0xffffffff) {
    throw new Error("ZIP64 archives are not supported");
  }

  const entries = [];
  let pos = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    if (zipBuf.readUInt32LE(pos) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error(`not a valid ZIP: expected central directory signature at offset ${pos} (entry ${i + 1}/${entryCount})`);
    }
    const flags = zipBuf.readUInt16LE(pos + 8);
    const method = zipBuf.readUInt16LE(pos + 10);
    const entryCrc32 = zipBuf.readUInt32LE(pos + 16);
    const compressedSize = zipBuf.readUInt32LE(pos + 20);
    const uncompressedSize = zipBuf.readUInt32LE(pos + 24);
    const nameLength = zipBuf.readUInt16LE(pos + 28);
    const extraLength = zipBuf.readUInt16LE(pos + 30);
    const commentLength = zipBuf.readUInt16LE(pos + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(pos + 42);
    const name = zipBuf.toString("utf8", pos + 46, pos + 46 + nameLength);

    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error(`ZIP64 archives are not supported (entry "${name}")`);
    }
    if (flags & 1) {
      throw new Error(`encrypted ZIP entries are not supported (entry "${name}")`);
    }

    entries.push({
      name,
      method,
      crc32: entryCrc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      flags,
      isDirectory: name.endsWith("/"),
    });

    pos += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Reads + decompresses one entry (from listZipEntries), verifying its
 * size and CRC-32; error messages name the entry. */
export function readZipEntry(zipBuf, entry) {
  const { localHeaderOffset, method, compressedSize, uncompressedSize, name } = entry;
  if (zipBuf.readUInt32LE(localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(`entry "${name}": expected local file header signature at offset ${localHeaderOffset}`);
  }
  const localNameLength = zipBuf.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = zipBuf.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
  const compressed = zipBuf.subarray(dataStart, dataStart + compressedSize);

  let data;
  if (method === 0) {
    data = Buffer.from(compressed);
  } else if (method === 8) {
    data = zlib.inflateRawSync(compressed);
    if (data.length !== uncompressedSize) {
      throw new Error(`entry "${name}": inflated size (${data.length}) != uncompressed size in ZIP record (${uncompressedSize})`);
    }
  } else {
    throw new Error(`entry "${name}": unsupported ZIP compression method ${method} (only STORED=0 and DEFLATE=8 are handled)`);
  }

  const actualCrc32 = crc32(data);
  if (actualCrc32 !== entry.crc32) {
    throw new Error(`entry "${name}" failed CRC-32 verification (expected ${entry.crc32.toString(16)}, got ${actualCrc32.toString(16)})`);
  }
  return data;
}

/** Extracts the given basenames out of an in-memory ZIP buffer, keyed by
 * basename -> Buffer. Only entries in `wantedNames` are inflated. */
export function extractFromZip(zipBuf, wantedNames) {
  const wanted = new Set(wantedNames);
  const found = new Map();
  for (const entry of listZipEntries(zipBuf)) {
    const baseName = entry.name.split("/").pop();
    if (wanted.has(baseName) && !found.has(baseName)) {
      found.set(baseName, readZipEntry(zipBuf, entry));
    }
  }
  return found;
}

const DRIVE_LETTER_RE = /^[A-Za-z]:/;

/** false for empty names, NUL/control chars, backslashes, a leading
 * "/", a drive letter, or any "."/".." segment. Directory entries
 * (trailing "/") are otherwise fine. Also rejects ":" anywhere (NTFS
 * alternate data streams, e.g. "a:b") and the characters <>"|?*, which
 * are illegal in a Windows path component regardless of position. */
export function isSafeZipEntryName(name) {
  if (!name) return false;
  if (/[\0-\x1f]/.test(name)) return false;
  if (name.includes("\\")) return false;
  if (name.startsWith("/")) return false;
  if (DRIVE_LETTER_RE.test(name)) return false;
  if (/[:<>"|?*]/.test(name)) return false;
  const stripped = name.endsWith("/") ? name.slice(0, -1) : name;
  for (const seg of stripped.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return false;
  }
  return true;
}

/** Extracts a full zip tree: validates every entry name first, skips
 * directories, strips one shared top-level folder when every file is
 * inside it, applies `include` globs, and rejects duplicate output
 * paths (case-insensitively). Returns files sorted by path. */
export function extractZipTree(zipBuf, { include } = {}) {
  const entries = listZipEntries(zipBuf);
  for (const entry of entries) {
    if (!isSafeZipEntryName(entry.name)) {
      throw new Error(`unsafe ZIP entry name: "${entry.name}"`);
    }
  }

  const fileEntries = entries.filter((e) => !e.isDirectory);
  let strippedPrefix = null;
  if (fileEntries.length > 0 && fileEntries.every((e) => e.name.includes("/"))) {
    const firstSegment = fileEntries[0].name.split("/")[0];
    if (fileEntries.every((e) => e.name.split("/")[0] === firstSegment)) {
      strippedPrefix = firstSegment;
    }
  }

  const includeMatchers = include ? include.map(globToRegExp) : null;

  const files = [];
  const seen = new Map();
  for (const entry of fileEntries) {
    const relPath = strippedPrefix ? entry.name.slice(strippedPrefix.length + 1) : entry.name;
    if (includeMatchers && !includeMatchers.some((re) => re.test(relPath))) continue;

    const key = relPath.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`duplicate ZIP output path (case-insensitive): "${relPath}" and "${seen.get(key)}"`);
    }
    seen.set(key, relPath);

    files.push({ path: relPath, zipName: entry.name, data: readZipEntry(zipBuf, entry) });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, strippedPrefix };
}
