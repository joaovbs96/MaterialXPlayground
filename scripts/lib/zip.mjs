// ZIP reading on JSZip, lazy-imported so `npm run check` never loads it.
// Always load with checkCRC32 (off by default) and validate
// unsafeOriginalName: JSZip silently rewrites "../evil.txt" to "evil.txt".

import path from "node:path";

const DRIVE_LETTER_RE = /^[A-Za-z]:/;

/** false for empty names, control chars, backslashes, absolute paths, drive
 * letters, "."/".." segments, and Windows-illegal <>:"|?* (":" also blocks
 * NTFS alternate data streams). A trailing "/" (directory) is fine. */
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

/** Loads a zip buffer with CRC-32 verification on, returning JSZip's
 * `{ safeName: ZipObject }` file map. Lazy-imports jszip. */
async function loadZip(zipBuf) {
  const { default: JSZip } = await import("jszip");
  return JSZip.loadAsync(zipBuf, { checkCRC32: true });
}

/** Rejects any unsafe original name, skips directories, strips one shared
 * top folder, applies `include` globs, and rejects case-insensitive
 * duplicate paths. Returns files sorted by path. */
export async function extractZipTree(zipBuf, { include } = {}) {
  const zip = await loadZip(zipBuf);
  const entries = Object.values(zip.files);

  for (const entry of entries) {
    const rawName = entry.unsafeOriginalName ?? entry.name;
    if (!isSafeZipEntryName(rawName)) {
      throw new Error(`unsafe ZIP entry name: "${rawName}"`);
    }
  }

  const fileEntries = entries.filter((e) => !e.dir);
  let strippedPrefix = null;
  if (fileEntries.length > 0 && fileEntries.every((e) => e.name.includes("/"))) {
    const firstSegment = fileEntries[0].name.split("/")[0];
    if (fileEntries.every((e) => e.name.split("/")[0] === firstSegment)) {
      strippedPrefix = firstSegment;
    }
  }

  const files = [];
  const seen = new Map();
  for (const entry of fileEntries) {
    const relPath = strippedPrefix ? entry.name.slice(strippedPrefix.length + 1) : entry.name;
    if (include && !include.some((glob) => path.posix.matchesGlob(relPath, glob))) continue;

    const key = relPath.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`duplicate ZIP output path (case-insensitive): "${relPath}" and "${seen.get(key)}"`);
    }
    seen.set(key, relPath);

    const data = await entry.async("nodebuffer");
    files.push({ path: relPath, zipName: entry.name, data });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, strippedPrefix };
}

/** Extracts the given basenames out of an in-memory ZIP buffer, keyed by
 * basename -> Buffer. Only entries in `wantedNames` are inflated. */
export async function extractFromZip(zipBuf, wantedNames) {
  const zip = await loadZip(zipBuf);
  const wanted = new Set(wantedNames);
  const found = new Map();
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const rawName = entry.unsafeOriginalName ?? entry.name;
    if (!isSafeZipEntryName(rawName)) {
      throw new Error(`unsafe ZIP entry name: "${rawName}"`);
    }
    const baseName = entry.name.split("/").pop();
    if (wanted.has(baseName) && !found.has(baseName)) {
      found.set(baseName, await entry.async("nodebuffer"));
    }
  }
  return found;
}
