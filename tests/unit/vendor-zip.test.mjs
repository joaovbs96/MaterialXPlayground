// Unit coverage for scripts/lib/zip.mjs: a tiny in-test ZIP writer
// (local headers + central directory + EOCD, STORED and DEFLATE) plus
// the reader's safety and stripping rules.
import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";

import { crc32, listZipEntries, readZipEntry, extractFromZip, isSafeZipEntryName, extractZipTree } from "../../scripts/lib/zip.mjs";

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** Builds a minimal ZIP buffer from [{ name, data, method, badCrc, isDirectory }]. */
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method ?? 0;
    const nameBuf = Buffer.from(entry.name, "utf8");
    const rawData = entry.isDirectory ? Buffer.alloc(0) : Buffer.from(entry.data || "");
    const compressed = method === 8 ? zlib.deflateRawSync(rawData) : rawData;
    const crc = entry.badCrc ? (crc32(rawData) ^ 0xffffffff) >>> 0 : crc32(rawData);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOCAL_SIG, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(entry.flags ?? 0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localOffset = offset;
    localParts.push(localHeader, nameBuf, compressed);
    offset += localHeader.length + nameBuf.length + compressed.length;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CENTRAL_SIG, 0);
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(entry.flags ?? 0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, nameBuf);
  }

  const localBuf = Buffer.concat(localParts);
  const centralBuf = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);

  return Buffer.concat([localBuf, centralBuf, eocd]);
}

test("crc32 matches a known vector", () => {
  // CRC-32 (IEEE 802.3) of the ASCII string "123456789" is a standard test vector.
  assert.equal(crc32(Buffer.from("123456789")).toString(16), "cbf43926");
});

test("stored entry round-trips", () => {
  const zip = buildZip([{ name: "a.txt", data: "hello", method: 0 }]);
  const entries = listZipEntries(zip);
  assert.equal(entries.length, 1);
  assert.equal(readZipEntry(zip, entries[0]).toString(), "hello");
});

test("deflated entry round-trips", () => {
  const zip = buildZip([{ name: "a.txt", data: "hello deflated world", method: 8 }]);
  const entries = listZipEntries(zip);
  assert.equal(readZipEntry(zip, entries[0]).toString(), "hello deflated world");
});

test("single shared top folder is stripped", () => {
  const zip = buildZip([
    { name: "pkg/a.txt", data: "a" },
    { name: "pkg/sub/b.txt", data: "b" },
  ]);
  const { files, strippedPrefix } = extractZipTree(zip);
  assert.equal(strippedPrefix, "pkg");
  assert.deepEqual(files.map((f) => f.path).sort(), ["a.txt", "sub/b.txt"]);
});

test("two top folders are not stripped", () => {
  const zip = buildZip([
    { name: "pkg1/a.txt", data: "a" },
    { name: "pkg2/b.txt", data: "b" },
  ]);
  const { strippedPrefix } = extractZipTree(zip);
  assert.equal(strippedPrefix, null);
});

test("a root-level file prevents stripping", () => {
  const zip = buildZip([
    { name: "pkg/a.txt", data: "a" },
    { name: "root.txt", data: "r" },
  ]);
  const { strippedPrefix } = extractZipTree(zip);
  assert.equal(strippedPrefix, null);
});

test("directory entries are skipped", () => {
  const zip = buildZip([
    { name: "pkg/", isDirectory: true },
    { name: "pkg/a.txt", data: "a" },
  ]);
  const { files } = extractZipTree(zip);
  assert.deepEqual(files.map((f) => f.path), ["a.txt"]);
});

test("include filter keeps only matching post-strip paths", () => {
  const zip = buildZip([
    { name: "pkg/a.woff2", data: "a" },
    { name: "pkg/b.txt", data: "b" },
  ]);
  const { files } = extractZipTree(zip, { include: ["*.woff2"] });
  assert.deepEqual(files.map((f) => f.path), ["a.woff2"]);
});

test("bad CRC throws", () => {
  const zip = buildZip([{ name: "a.txt", data: "hello", badCrc: true }]);
  const entries = listZipEntries(zip);
  assert.throws(() => readZipEntry(zip, entries[0]), /CRC-32/);
});

for (const bad of ["../evil", "a/../../evil", "/abs", "C:/x", "C:x", "a\\b", "a//b", "./a", "a:b", "a/b?c"]) {
  test(`unsafe entry name rejected: ${JSON.stringify(bad)}`, () => {
    assert.equal(isSafeZipEntryName(bad), false);
    const zip = buildZip([{ name: bad, data: "x" }]);
    assert.throws(() => extractZipTree(zip), /unsafe ZIP entry name/);
  });
}

test("case-insensitive duplicate output path throws", () => {
  const zip = buildZip([
    { name: "pkg/A.txt", data: "a" },
    { name: "pkg/a.txt", data: "b" },
  ]);
  assert.throws(() => extractZipTree(zip), /duplicate ZIP output path/);
});

test("extractFromZip matches by basename", () => {
  const zip = buildZip([
    { name: "javascript/Wanted.wasm", data: "payload" },
    { name: "other/Skipped.txt", data: "skip" },
  ]);
  const found = extractFromZip(zip, ["Wanted.wasm"]);
  assert.equal(found.size, 1);
  assert.equal(found.get("Wanted.wasm").toString(), "payload");
});
