// scripts/lib/build-id.mjs
//
// Deterministic build id: a 16-hex sha256 fingerprint of index.html plus
// every js/** input, stamped into js/gen/build-id.json and index.html's
// window.__MTLX_BUILD literal. js/materialx/ is EXCLUDED for correctness,
// not speed: release.yml runs vendor:offline + vendor:versions before
// `npm run build`, so it (and vendor/materialx/) exist there but not in a
// plain deploy.yml push run. Excluding them keeps both runs' ids equal.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const JS_ROOT = path.join(REPO_ROOT, "js");
const INDEX_PATH = path.join(REPO_ROOT, "index.html");
const VENDOR_MANIFEST_PATH = path.join(REPO_ROOT, "vendor", "vendor-manifest.json");

export const BUILD_ID_META_PATH = "js/gen/build-id.json";
export const INDEX_STAMP_RE = /window\.__MTLX_BUILD = '([0-9a-f]{16}|dev)';/;

const INPUT_EXTENSIONS = new Set([".js", ".jsx", ".css", ".json"]);

function toPosix(p) {
  return p.split(path.sep).join("/");
}

// Strip a leading BOM and normalize CRLF -> LF: same shape as
// build-webview.mjs's normalizeEol, needed because .gitattributes leaves
// js/** unspecified and this machine has core.autocrlf=true.
function normalizeContent(s) {
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.replace(/\r\n/g, "\n");
}

/** Throws unless INDEX_STAMP_RE matches `content` exactly once. Mirrors the
 * exactly-once guard in stampAll (scripts/lib/version.mjs). */
function assertStampMatchesOnce(content) {
  const globalRe = new RegExp(INDEX_STAMP_RE.source, "g");
  const occurrences = content.match(globalRe);
  if (!occurrences || occurrences.length !== 1) {
    throw new Error(
      `index.html: expected exactly one match for the window.__MTLX_BUILD stamp (pattern ${INDEX_STAMP_RE}), found ${occurrences ? occurrences.length : 0}, check the embed-mode bootstrap script in index.html's <head>.`
    );
  }
}

/** Recursively collect absolute paths of js/** files matching
 * INPUT_EXTENSIONS, excluding js/materialx/ entirely and
 * js/gen/build-id.json specifically. Sorted by POSIX relative path. */
async function collectJsInputPaths() {
  const out = [];
  async function walk(dirAbs) {
    const entries = await readdir(dirAbs, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dirAbs, entry.name);
      const relToJs = toPosix(path.relative(JS_ROOT, abs));
      if (entry.isDirectory()) {
        if (relToJs === "materialx" || relToJs.startsWith("materialx/")) continue;
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!INPUT_EXTENSIONS.has(path.extname(entry.name))) continue;
      if (relToJs === "gen/build-id.json") continue;
      out.push(abs);
    }
  }
  await walk(JS_ROOT);
  out.sort((a, b) => toPosix(path.relative(REPO_ROOT, a)).localeCompare(toPosix(path.relative(REPO_ROOT, b))));
  return out;
}

/** Reads + normalizes index.html, asserts the stamp guard, and replaces
 * the captured token with the fixed literal 'dev': this is what makes
 * stamping converge (the just-written id can't feed back into itself). */
function canonicalizeIndexHtml(normalized) {
  assertStampMatchesOnce(normalized);
  return normalized.replace(INDEX_STAMP_RE, "window.__MTLX_BUILD = 'dev';");
}

/** Gathers every hash input as { posixPath, content } pairs, normalized
 * and sorted by posixPath. index.html is canonicalized first (see above). */
async function gatherInputs() {
  const indexNormalized = normalizeContent(await readFile(INDEX_PATH, "utf8"));
  const inputs = [{ posixPath: "index.html", content: canonicalizeIndexHtml(indexNormalized) }];

  for (const abs of await collectJsInputPaths()) {
    const content = normalizeContent(await readFile(abs, "utf8"));
    inputs.push({ posixPath: toPosix(path.relative(REPO_ROOT, abs)), content });
  }

  const vendorManifest = normalizeContent(await readFile(VENDOR_MANIFEST_PATH, "utf8"));
  inputs.push({ posixPath: toPosix(path.relative(REPO_ROOT, VENDOR_MANIFEST_PATH)), content: vendorManifest });

  inputs.sort((a, b) => a.posixPath.localeCompare(b.posixPath));
  return inputs;
}

function serializeMeta(id) {
  return JSON.stringify({ id }, null, 1) + "\n";
}

/** Computes the 16-hex build id: sha256 over every input as
 * `posixRelPath + "\0" + normalizedContent` (sorted by path, so a rename
 * changes the id too). Throws if index.html's stamp isn't unique. */
export async function computeBuildId() {
  const inputs = await gatherInputs();
  const hash = createHash("sha256");
  for (const { posixPath, content } of inputs) {
    hash.update(posixPath + "\0" + content);
  }
  return hash.digest("hex").slice(0, 16);
}

/** Writes js/gen/build-id.json and rewrites index.html's window.__MTLX_BUILD
 * token to `id`, in place. Throws if index.html's stamp doesn't match
 * exactly once. Returns only the repo-relative paths actually changed. */
export async function stampBuildId(id) {
  const changed = [];

  const metaAbs = path.join(REPO_ROOT, ...BUILD_ID_META_PATH.split("/"));
  const serialized = serializeMeta(id);
  let existing = null;
  try {
    existing = await readFile(metaAbs, "utf8");
  } catch {
    // Not yet written, fall through and create it.
  }
  if (existing !== serialized) {
    await mkdir(path.dirname(metaAbs), { recursive: true });
    await writeFile(metaAbs, serialized);
    changed.push(BUILD_ID_META_PATH);
  }

  const original = await readFile(INDEX_PATH, "utf8");
  assertStampMatchesOnce(original);
  const updated = original.replace(INDEX_STAMP_RE, `window.__MTLX_BUILD = '${id}';`);
  if (updated !== original) {
    await writeFile(INDEX_PATH, updated);
    changed.push("index.html");
  }

  return changed;
}

/** Read-only: compares js/gen/build-id.json and index.html's stamp against
 * a fresh computeBuildId(). Returns problem strings (empty = both agree),
 * mirroring checkStamps in scripts/lib/version.mjs. */
export async function checkBuildId() {
  const problems = [];
  const id = await computeBuildId();
  const expectedSerialized = serializeMeta(id);

  const metaAbs = path.join(REPO_ROOT, ...BUILD_ID_META_PATH.split("/"));
  let actualSerialized;
  try {
    actualSerialized = await readFile(metaAbs, "utf8");
  } catch {
    problems.push(`${BUILD_ID_META_PATH}: file not found, expected {"id": "${id}"}`);
    actualSerialized = null;
  }
  if (actualSerialized !== null && actualSerialized !== expectedSerialized) {
    problems.push(`${BUILD_ID_META_PATH}: found ${actualSerialized.trim()}, expected ${JSON.stringify({ id })}`);
  }

  const indexRaw = await readFile(INDEX_PATH, "utf8");
  const match = indexRaw.match(INDEX_STAMP_RE);
  if (!match) {
    problems.push(`index.html: could not find the window.__MTLX_BUILD stamp (pattern ${INDEX_STAMP_RE})`);
  } else if (match[1] !== id) {
    problems.push(`index.html: window.__MTLX_BUILD is '${match[1]}', expected '${id}'`);
  }

  return problems;
}
