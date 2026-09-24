// Unit coverage for scripts/lib/zip.mjs: fixtures built with JSZip
// itself, plus byte-patching for the cases JSZip won't produce on its
// own (an unsafe name it silently rewrites, a corrupted CRC).
import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";

import { extractFromZip, isSafeZipEntryName, extractZipTree } from "../../scripts/lib/zip.mjs";

/** Builds a zip buffer from [{ name, data, method, isDirectory }]. */
async function buildZip(entries) {
  const zip = new JSZip();
  for (const entry of entries) {
    if (entry.isDirectory) {
      zip.folder(entry.name);
      continue;
    }
    zip.file(entry.name, entry.data ?? "", { compression: entry.method === "DEFLATE" ? "DEFLATE" : "STORE" });
  }
  return zip.generateAsync({ type: "nodebuffer" });
}

/** Replaces every occurrence of `oldText` with `newText` (same byte
 * length required) in-place, patching both the local header and the
 * central directory copy of a zip entry name. */
function patchBytes(buf, oldText, newText) {
  const oldBuf = Buffer.from(oldText);
  const newBuf = Buffer.from(newText);
  assert.equal(oldBuf.length, newBuf.length, "patch must preserve byte length");
  let from = 0;
  let count = 0;
  for (;;) {
    const at = buf.indexOf(oldBuf, from);
    if (at === -1) break;
    newBuf.copy(buf, at);
    from = at + oldBuf.length;
    count++;
  }
  assert.ok(count > 0, `"${oldText}" not found in buffer`);
  return buf;
}

test("stored entry round-trips", async () => {
  const zip = await buildZip([{ name: "a.txt", data: "hello", method: "STORE" }]);
  const { files } = await extractZipTree(zip);
  assert.equal(files.length, 1);
  assert.equal(files[0].data.toString(), "hello");
});

test("deflated entry round-trips", async () => {
  const zip = await buildZip([{ name: "a.txt", data: "hello deflated world", method: "DEFLATE" }]);
  const { files } = await extractZipTree(zip);
  assert.equal(files[0].data.toString(), "hello deflated world");
});

test("single shared top folder is stripped", async () => {
  const zip = await buildZip([
    { name: "pkg/a.txt", data: "a" },
    { name: "pkg/sub/b.txt", data: "b" },
  ]);
  const { files, strippedPrefix } = await extractZipTree(zip);
  assert.equal(strippedPrefix, "pkg");
  assert.deepEqual(files.map((f) => f.path).sort(), ["a.txt", "sub/b.txt"]);
});

test("two top folders are not stripped", async () => {
  const zip = await buildZip([
    { name: "pkg1/a.txt", data: "a" },
    { name: "pkg2/b.txt", data: "b" },
  ]);
  const { strippedPrefix } = await extractZipTree(zip);
  assert.equal(strippedPrefix, null);
});

test("a root-level file prevents stripping", async () => {
  const zip = await buildZip([
    { name: "pkg/a.txt", data: "a" },
    { name: "root.txt", data: "r" },
  ]);
  const { strippedPrefix } = await extractZipTree(zip);
  assert.equal(strippedPrefix, null);
});

test("directory entries are skipped", async () => {
  const zip = await buildZip([
    { name: "pkg", isDirectory: true },
    { name: "pkg/a.txt", data: "a" },
  ]);
  const { files } = await extractZipTree(zip);
  assert.deepEqual(files.map((f) => f.path), ["a.txt"]);
});

test("include filter keeps only matching post-strip paths", async () => {
  const zip = await buildZip([
    { name: "pkg/a.woff2", data: "a" },
    { name: "pkg/b.txt", data: "b" },
  ]);
  const { files } = await extractZipTree(zip, { include: ["*.woff2"] });
  assert.deepEqual(files.map((f) => f.path), ["a.woff2"]);
});

test("bad CRC is rejected", async () => {
  const zip = await buildZip([{ name: "a.txt", data: "hello-crc-target", method: "STORE" }]);
  patchBytes(zip, "hello-crc-target", "hemmo-crc-target");
  await assert.rejects(() => extractZipTree(zip), /crc|corrupt/i);
});

for (const bad of ["../evil", "a/../../evil", "/abs", "C:/x", "C:x", "a\\b", "a//b", "./a", "a:b", "a/b?c"]) {
  test(`isSafeZipEntryName rejects: ${JSON.stringify(bad)}`, () => {
    assert.equal(isSafeZipEntryName(bad), false);
  });
}

test("a JSZip-rewritten unsafe name (../evil.txt) is rejected, not silently extracted", async () => {
  // JSZip normalizes "../evil.txt" down to "evil.txt" while loading, so the
  // check must read the entry's ORIGINAL raw name, not the sanitized one.
  const zip = await buildZip([{ name: "aa/evil.txt", data: "x", method: "STORE" }]);
  patchBytes(zip, "aa/evil.txt", "../evil.txt");
  await assert.rejects(() => extractZipTree(zip), /unsafe ZIP entry name/);
});

test("case-insensitive duplicate output path throws", async () => {
  const zip = await buildZip([
    { name: "pkg/A.txt", data: "a" },
    { name: "pkg/a.txt", data: "b" },
  ]);
  await assert.rejects(() => extractZipTree(zip), /duplicate ZIP output path/);
});

test("extractFromZip matches by basename", async () => {
  const zip = await buildZip([
    { name: "javascript/Wanted.wasm", data: "payload" },
    { name: "other/Skipped.txt", data: "skip" },
  ]);
  const found = await extractFromZip(zip, ["Wanted.wasm"]);
  assert.equal(found.size, 1);
  assert.equal(found.get("Wanted.wasm").toString(), "payload");
});
