#!/usr/bin/env node
// scripts/vendor.mjs
//
// Collects pinned third-party assets into the committed vendor/ folder
// for local (non-CDN) loading by the app and extension webview.
// Usage: npm run vendor | vendor -- --check | vendor -- --with-materialx
//
// CI-verified source of truth (--check gates drift); vendor/materialx/
// is touched only by --with-materialx, else CDN fallback at runtime.

import { readFile, writeFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readVersionMeta, checkStamps } from "./lib/version.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const NODE_MODULES = path.join(REPO_ROOT, "node_modules");
const VENDOR_ROOT = path.join(REPO_ROOT, "vendor");
const MATERIALX_DIR_NAME = "materialx";
const MANIFEST_PATH = path.join(VENDOR_ROOT, "vendor-manifest.json");

const CHECK_MODE = process.argv.includes("--check");
const WITH_MATERIALX = process.argv.includes("--with-materialx");

// ---------------------------------------------------------------------------
// MTLX_TAG is derived from the vendored WASM build (via
// scripts/extract-mtlx-version.mjs → js/gen/mtlx-version.json), never
// hand-typed, so it can't disagree with the committed WASM files. MUST
// match MtlxSpecParser.SPEC_TAG in scripts/lib/spec-parser.js.
// ---------------------------------------------------------------------------
const MTLX_TAG = (await readVersionMeta()).tag;
const MTLX_REPO = "AcademySoftwareFoundation/MaterialX";
const MTLX_TREE_API_URL = `https://api.github.com/repos/${MTLX_REPO}/git/trees/${MTLX_TAG}?recursive=1`;
const MTLX_RAW_BASE = `https://raw.githubusercontent.com/${MTLX_REPO}/${MTLX_TAG}/`;
// Directory prefixes (POSIX git-tree paths). Whole directories are
// vendored, not just the files read today, because the preset crawler
// resolves xi:include siblings and relative texture paths at runtime.
const MTLX_INCLUDE_PREFIXES = ["documents/Specification/", "resources/Materials/Examples/", "resources/Images/"];
const MTLX_CONCURRENCY = 8;
const MTLX_RETRIES = 2;
const MTLX_RETRY_BASE_DELAY_MS = 500;

const MATERIALX_ROOT = path.join(VENDOR_ROOT, MATERIALX_DIR_NAME);
const MATERIALX_MANIFEST_PATH = path.join(MATERIALX_ROOT, "manifest.json");

// ---------------------------------------------------------------------------
// COPIES: files copied verbatim from node_modules/<pkg>/<src> to
// vendor/<dest>. `pkg` also locates package.json for the manifest's
// provenance string (pkg@version).
// ---------------------------------------------------------------------------
const COPIES = [
  { pkg: "react", src: "umd/react.production.min.js", dest: "react/react.production.min.js" },
  { pkg: "react-dom", src: "umd/react-dom.production.min.js", dest: "react/react-dom.production.min.js" },
  { pkg: "@babel/standalone", src: "babel.min.js", dest: "babel/babel.min.js" },

  { pkg: "three", src: "build/three.min.js", dest: "three/three.min.js" },
  { pkg: "three", src: "examples/js/loaders/RGBELoader.js", dest: "three/RGBELoader.js" },
  { pkg: "three", src: "examples/js/loaders/GLTFLoader.js", dest: "three/GLTFLoader.js" },
  { pkg: "three", src: "examples/js/controls/OrbitControls.js", dest: "three/OrbitControls.js" },
  // "three-147" is an npm alias (three-147: npm:three@0.147.0) — only this
  // version's examples/js/libs/fflate.min.js is vendored; the rest of the
  // three@0.147.0 tree is unused and intentionally left uncollected.
  { pkg: "three-147", src: "examples/js/libs/fflate.min.js", dest: "three/fflate.min.js" },

  { pkg: "katex", src: "dist/katex.min.css", dest: "katex/katex.min.css" },
  { pkg: "katex", src: "dist/katex.min.js", dest: "katex/katex.min.js" },
  // katex.min.css references url(fonts/...) relative to itself, so
  // fonts/ must sit alongside it. Only .woff2 is vendored — the app
  // needs WebAssembly (2017+) anyway, so older fallback formats are dead weight.
  { pkg: "katex", src: "dist/fonts", dest: "katex/fonts", recursive: true, filter: /\.woff2$/ },

  { pkg: "jszip", src: "dist/jszip.min.js", dest: "jszip/jszip.min.js" },

  { pkg: "reactflow", src: "dist/style.css", dest: "reactflow/style.css" },
  { pkg: "reactflow", src: "dist/umd/index.js", dest: "reactflow/index.js" },

  { pkg: "dagre", src: "dist/dagre.min.js", dest: "dagre/dagre.min.js" },

  // @highlightjs/cdn-assets is the npm mirror of the cdnjs single-file
  // build (the plain `highlight.js` package ships an unbundled ESM tree
  // instead, which is not usable via a plain <script> tag).
  { pkg: "@highlightjs/cdn-assets", src: "highlight.min.js", dest: "highlightjs/highlight.min.js" },
  { pkg: "@highlightjs/cdn-assets", src: "languages/xml.min.js", dest: "highlightjs/xml.min.js" },

  // ---------------------------------------------------------------------------
  // Explicit LICENSE entries are required: cleanVendorExceptMaterialx()
  // wipes vendor/ (except materialx/) before copyAll() repopulates it, so
  // without these, `npm run vendor` would delete and never restore them.
  // ---------------------------------------------------------------------------
  { pkg: "react", src: "LICENSE", dest: "react/LICENSE.txt" },
  { pkg: "@babel/standalone", src: "LICENSE", dest: "babel/LICENSE.txt" },
  { pkg: "three", src: "LICENSE", dest: "three/LICENSE.txt" },
  { pkg: "katex", src: "LICENSE", dest: "katex/LICENSE.txt" },
  { pkg: "jszip", src: "LICENSE.markdown", dest: "jszip/LICENSE.markdown" },
  { pkg: "reactflow", src: "LICENSE", dest: "reactflow/LICENSE.txt" },
  { pkg: "dagre", src: "LICENSE", dest: "dagre/LICENSE.txt" },
  { pkg: "@highlightjs/cdn-assets", src: "LICENSE", dest: "highlightjs/LICENSE.txt" },
];

// ---------------------------------------------------------------------------
// DOWNLOADS: files fetched by URL (not on npm) and verified against a
// pinned sha256 before writing to vendor/, so an upstream change is
// caught as a verification failure instead of silently vendored.
// ---------------------------------------------------------------------------
const DOWNLOADS = [
  {
    url: "https://cdn.tailwindcss.com/3.4.17",
    dest: "tailwind/tailwind-play.min.js",
    sha256: "176e894661aa9cdc9a5cba6c720044cbbf7b8bd80d1c9a142a7c24b1b6c50d15",
  },
  // Tailwind's LICENSE isn't on npm either, so it's fetched from the
  // GitHub tag matching the pinned Play CDN version above and verified
  // against a pinned sha256 the same way.
  {
    url: "https://raw.githubusercontent.com/tailwindlabs/tailwindcss/v3.4.17/LICENSE",
    dest: "tailwind/LICENSE.txt",
    sha256: "60e0b68c0f35c078eef3a5d29419d0b03ff84ec1df9c3f9d6e39a519a5ae7985",
  },
];

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

/** git's own blob hashing scheme: sha1("blob <byteLength>\0" + content). Pure function of the
 * bytes — needs no git binary and no network call, so it can be used to compare local files
 * against a GitHub git-trees API `sha` field for free. */
function gitBlobSha1(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`);
  return createHash("sha1").update(Buffer.concat([header, buffer])).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run `fn` up to `retries + 1` times with exponential backoff between attempts. */
async function withRetries(fn, retries = MTLX_RETRIES, baseDelayMs = MTLX_RETRY_BASE_DELAY_MS) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(baseDelayMs * Math.pow(2, attempt));
      }
    }
  }
  throw lastErr;
}

/** Run `worker` over `items` with at most `concurrency` in flight at once. */
async function pooledMap(items, worker, concurrency) {
  let nextIndex = 0;
  async function runNext() {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  }
  const poolSize = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: poolSize }, runNext));
}

async function readPkgVersion(pkgName) {
  const pkgJsonPath = path.join(NODE_MODULES, pkgName, "package.json");
  const raw = await readFile(pkgJsonPath, "utf8");
  return JSON.parse(raw).version;
}

/** Recursively list files under `dir` (absolute path), returning paths relative to `dir`. */
async function listFilesRecursive(dir) {
  const out = [];
  async function walk(current, relPrefix) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = relPrefix ? path.join(relPrefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  await walk(dir, "");
  return out.sort();
}

/** Expand COPIES into a flat list of { pkg, srcAbs, destRel } file entries (directories expanded). */
async function expandCopyEntries() {
  const entries = [];
  const missing = [];
  for (const copy of COPIES) {
    const pkgDir = path.join(NODE_MODULES, copy.pkg);
    const srcAbs = path.join(pkgDir, copy.src);
    if (!existsSync(srcAbs)) {
      missing.push(`  - node_modules/${copy.pkg}/${copy.src}  (needed for vendor/${copy.dest})`);
      continue;
    }
    if (copy.recursive) {
      const st = await stat(srcAbs);
      if (!st.isDirectory()) {
        missing.push(`  - node_modules/${copy.pkg}/${copy.src}  (expected a directory, found a file)`);
        continue;
      }
      const files = await listFilesRecursive(srcAbs);
      for (const relFile of files) {
        if (copy.filter && !copy.filter.test(relFile)) continue;
        entries.push({
          pkg: copy.pkg,
          srcAbs: path.join(srcAbs, relFile),
          destRel: path.join(copy.dest, relFile),
        });
      }
    } else {
      entries.push({ pkg: copy.pkg, srcAbs, destRel: copy.dest });
    }
  }
  return { entries, missing };
}

/** Validate node_modules exists and every COPIES source path resolves; report ALL problems at once. */
async function validateSources() {
  const problems = [];

  if (!existsSync(NODE_MODULES)) {
    fail(
      [
        `error: node_modules/ not found at ${NODE_MODULES}`,
        "Run `npm install` first (this reads the exact-pinned devDependencies in package.json).",
      ].join("\n")
    );
  }

  // Every referenced package must at least be present with a package.json.
  const pkgNames = [...new Set(COPIES.map((c) => c.pkg))];
  for (const pkgName of pkgNames) {
    const pkgJsonPath = path.join(NODE_MODULES, pkgName, "package.json");
    if (!existsSync(pkgJsonPath)) {
      problems.push(`  - node_modules/${pkgName}/package.json not found (is "${pkgName}" in devDependencies? did npm install run?)`);
    }
  }

  const { missing } = await expandCopyEntries();
  problems.push(...missing);

  if (problems.length > 0) {
    fail(
      [
        "error: vendor.mjs source validation failed — missing source path(s):",
        ...problems,
        "",
        "If a package's published dist layout has changed, update the COPIES table in scripts/vendor.mjs to match.",
      ].join("\n")
    );
  }
}

/** Remove everything directly under vendor/ except the materialx/ directory (left untouched, not recursed into). */
async function cleanVendorExceptMaterialx() {
  if (!existsSync(VENDOR_ROOT)) {
    await mkdir(VENDOR_ROOT, { recursive: true });
    return;
  }
  const entries = await readdir(VENDOR_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === MATERIALX_DIR_NAME) continue;
    await rm(path.join(VENDOR_ROOT, entry.name), { recursive: true, force: true });
  }
}

async function copyAll() {
  const { entries } = await expandCopyEntries();
  const manifestEntries = [];
  for (const entry of entries) {
    const destAbs = path.join(VENDOR_ROOT, entry.destRel);
    await mkdir(path.dirname(destAbs), { recursive: true });
    const data = await readFile(entry.srcAbs);
    await writeFile(destAbs, data);
    const version = await readPkgVersion(entry.pkg);
    manifestEntries.push({
      path: toPosix(entry.destRel),
      source: `${entry.pkg}@${version}`,
      sha256: sha256Of(data),
      bytes: data.length,
    });
  }
  return manifestEntries;
}

async function downloadAll() {
  const manifestEntries = [];
  for (const dl of DOWNLOADS) {
    log(`downloading ${dl.url} ...`);
    const res = await fetch(dl.url);
    if (!res.ok) {
      fail(`error: failed to download ${dl.url} — HTTP ${res.status} ${res.statusText}`);
    }
    const data = Buffer.from(await res.arrayBuffer());
    const actualSha256 = sha256Of(data);
    if (actualSha256 !== dl.sha256) {
      fail(
        [
          `error: sha256 mismatch for ${dl.url}`,
          `  expected: ${dl.sha256}`,
          `  actual:   ${actualSha256}`,
          "The upstream file changed since this hash was pinned. Verify the new content is expected,",
          "then update the sha256 in the DOWNLOADS table in scripts/vendor.mjs.",
        ].join("\n")
      );
    }
    const destAbs = path.join(VENDOR_ROOT, dl.dest);
    await mkdir(path.dirname(destAbs), { recursive: true });
    await writeFile(destAbs, data);
    manifestEntries.push({
      path: toPosix(dl.dest),
      source: dl.url,
      sha256: actualSha256,
      bytes: data.length,
    });
  }
  return manifestEntries;
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

async function writeManifest(entries) {
  entries.sort((a, b) => a.path.localeCompare(b.path));
  // No timestamp field here on purpose: runCheck never reads one, and a
  // volatile generatedAt would make every `npm run vendor` re-run produce a
  // spurious diff even when nothing about the vendored content changed.
  const manifest = {
    generatedBy: "scripts/vendor.mjs",
    entries,
  };
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

// ---------------------------------------------------------------------------
// --with-materialx: populates vendor/materialx/ from the MaterialX repo.
// Entirely separate code path from the lib-vendoring above — never invoked
// unless the --with-materialx flag is present.
// ---------------------------------------------------------------------------

/** Fetch the recursive git tree for MTLX_TAG (one unauthenticated GitHub API call). */
async function fetchMaterialxTree() {
  log(`fetching MaterialX repo tree @ ${MTLX_TAG} (git-trees API) ...`);
  const res = await fetch(MTLX_TREE_API_URL, {
    headers: {
      "User-Agent": "MaterialXPlayground-vendor-script",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    fail(
      [
        `error: failed to fetch MaterialX git tree — HTTP ${res.status} ${res.statusText}`,
        `  ${MTLX_TREE_API_URL}`,
        res.status === 403
          ? "  (this is likely an unauthenticated GitHub API rate limit — wait and retry)"
          : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  const data = await res.json();
  if (data.truncated) {
    fail(
      "error: MaterialX git tree response was truncated by the GitHub API (too many entries for a " +
        "single non-paginated request) — scripts/vendor.mjs's --with-materialx needs a paginated tree " +
        "fetch to handle this; it currently assumes the whole tree fits in one response."
    );
  }
  return data.tree; // [{ path, mode, type, sha, size, url }, ...] — path is always POSIX.
}

/** Select every blob whose path falls under one of MTLX_INCLUDE_PREFIXES. */
function selectMaterialxBlobs(tree) {
  return tree.filter((entry) => entry.type === "blob" && MTLX_INCLUDE_PREFIXES.some((prefix) => entry.path.startsWith(prefix)));
}

/** Download one tree blob into vendor/materialx/<path>, skipping the network if the local file's
 * git-blob-sha1 already matches the tree's recorded sha (idempotent resume). */
async function downloadMaterialxBlob(entry) {
  const destRel = entry.path.split("/").join(path.sep);
  const destAbs = path.join(MATERIALX_ROOT, destRel);

  if (existsSync(destAbs)) {
    const existing = await readFile(destAbs);
    if (gitBlobSha1(existing) === entry.sha) {
      return { path: entry.path, bytes: existing.length, sha: entry.sha, skipped: true };
    }
  }

  const url = MTLX_RAW_BASE + entry.path;
  const data = await withRetries(async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return Buffer.from(await res.arrayBuffer());
  });
  const actualSha = gitBlobSha1(data);
  if (actualSha !== entry.sha) {
    throw new Error(`sha mismatch for ${entry.path}: tree says ${entry.sha}, downloaded content hashes to ${actualSha}`);
  }
  await mkdir(path.dirname(destAbs), { recursive: true });
  await writeFile(destAbs, data);
  return { path: entry.path, bytes: data.length, sha: actualSha, skipped: false };
}

/** Download every selected blob through a small concurrency pool; collects per-file errors rather
 * than aborting on the first one, so a single flaky file doesn't hide problems with the rest. */
async function downloadAllMaterialxBlobs(blobs) {
  const results = [];
  const errors = [];
  await pooledMap(
    blobs,
    async (entry) => {
      try {
        results.push(await downloadMaterialxBlob(entry));
      } catch (err) {
        errors.push(`  - ${entry.path}: ${err.message}`);
      }
    },
    MTLX_CONCURRENCY
  );
  return { results, errors };
}

export async function runMaterialx() {
  log("");
  log(`--with-materialx: vendoring MaterialX repo content @ ${MTLX_TAG} into vendor/materialx/ ...`);

  // Delete any existing manifest FIRST: its presence is the app's strict-local-mode marker, so a
  // manifest must never survive a failed/partial re-vend (leftover files staying behind is fine —
  // without the marker the app just stays in remote mode).
  if (existsSync(MATERIALX_MANIFEST_PATH)) {
    await rm(MATERIALX_MANIFEST_PATH, { force: true });
  }
  await mkdir(MATERIALX_ROOT, { recursive: true });

  const tree = await fetchMaterialxTree();
  const blobs = selectMaterialxBlobs(tree);
  log(`selected ${blobs.length} file(s) from the tree under: ${MTLX_INCLUDE_PREFIXES.join(", ")}`);

  const { results: blobResults, errors: blobErrors } = await downloadAllMaterialxBlobs(blobs);

  const allErrors = [...blobErrors];
  if (allErrors.length > 0) {
    fail(
      [
        `error: --with-materialx failed to download ${allErrors.length} file(s) — manifest.json NOT written, app stays in remote mode:`,
        ...allErrors,
        "",
        "Re-run `npm run vendor:offline` to retry — files already downloaded with matching content are skipped (fast resume).",
      ].join("\n")
    );
  }

  const allResults = [...blobResults];
  const skippedCount = allResults.filter((r) => r.skipped).length;
  log(`downloaded ${allResults.length - skippedCount} file(s), skipped ${skippedCount} already-up-to-date file(s).`);

  const files = allResults.map((r) => ({ path: r.path, bytes: r.bytes, sha: r.sha })).sort((a, b) => a.path.localeCompare(b.path));
  const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);

  const manifest = {
    tag: MTLX_TAG,
    generatedAt: new Date().toISOString(),
    fileCount: files.length,
    totalBytes,
    files,
  };
  // Written LAST, only now that every download above has succeeded.
  await writeFile(MATERIALX_MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

  log("");
  log(`vendor/materialx/manifest.json written: ${files.length} file(s), ${totalBytes} bytes total.`);
}

export async function runCollect() {
  await validateSources();
  await cleanVendorExceptMaterialx();

  log(`copying ${COPIES.length} vendor source(s) into ${path.relative(REPO_ROOT, VENDOR_ROOT)}/ ...`);
  const copyManifest = await copyAll();

  const downloadManifest = await downloadAll();

  const manifest = await writeManifest([...copyManifest, ...downloadManifest]);

  log("");
  log(`vendor/ collected: ${manifest.entries.length} file(s).`);
  log(`manifest written to ${path.relative(REPO_ROOT, MANIFEST_PATH)}`);
}

// ---------------------------------------------------------------------------
// --check: verifies, without writing anything, that vendor/ matches the
// COPIES/DOWNLOADS spec, on-disk hashes match the manifest, node_modules
// sources haven't drifted from it, and MaterialX version stamps agree.
// ---------------------------------------------------------------------------
export async function runCheck() {
  if (!existsSync(MANIFEST_PATH)) {
    fail(`error: ${path.relative(REPO_ROOT, MANIFEST_PATH)} not found. Run \`npm run vendor\` first.`);
  }
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const manifestByPath = new Map(manifest.entries.map((e) => [e.path, e]));

  const problems = [];

  // Expected COPIES entries (requires node_modules for source-drift checks).
  await validateSources();
  const { entries: copyEntries } = await expandCopyEntries();
  const expectedPaths = new Set([...copyEntries.map((e) => toPosix(e.destRel)), ...DOWNLOADS.map((d) => toPosix(d.dest))]);

  for (const expectedPath of expectedPaths) {
    if (!manifestByPath.has(expectedPath)) {
      problems.push(`  - missing from manifest: ${expectedPath}`);
    }
  }
  for (const manifestPath of manifestByPath.keys()) {
    if (!expectedPaths.has(manifestPath)) {
      problems.push(`  - unexpected entry in manifest (no longer in vendor.mjs spec): ${manifestPath}`);
    }
  }

  for (const entry of copyEntries) {
    const relPath = toPosix(entry.destRel);
    const manifestEntry = manifestByPath.get(relPath);
    if (!manifestEntry) continue; // already reported above

    const destAbs = path.join(VENDOR_ROOT, entry.destRel);
    if (!existsSync(destAbs)) {
      problems.push(`  - vendor/${relPath}: file missing on disk (manifest says it should exist)`);
      continue;
    }
    const onDisk = await readFile(destAbs);
    const onDiskSha256 = sha256Of(onDisk);
    if (onDiskSha256 !== manifestEntry.sha256) {
      problems.push(`  - vendor/${relPath}: on-disk sha256 (${onDiskSha256}) != manifest sha256 (${manifestEntry.sha256})`);
    }

    const srcData = await readFile(entry.srcAbs);
    const srcSha256 = sha256Of(srcData);
    if (srcSha256 !== manifestEntry.sha256) {
      problems.push(
        `  - vendor/${relPath}: stale — node_modules source now hashes to ${srcSha256}, manifest/vendor recorded ${manifestEntry.sha256}. Re-run \`npm run vendor\`.`
      );
    }
  }

  for (const dl of DOWNLOADS) {
    const relPath = toPosix(dl.dest);
    const manifestEntry = manifestByPath.get(relPath);
    if (!manifestEntry) continue; // already reported above

    if (manifestEntry.sha256 !== dl.sha256) {
      problems.push(`  - vendor/${relPath}: manifest sha256 (${manifestEntry.sha256}) != pinned sha256 in vendor.mjs (${dl.sha256})`);
    }

    const destAbs = path.join(VENDOR_ROOT, dl.dest);
    if (!existsSync(destAbs)) {
      problems.push(`  - vendor/${relPath}: file missing on disk (manifest says it should exist)`);
      continue;
    }
    const onDisk = await readFile(destAbs);
    const onDiskSha256 = sha256Of(onDisk);
    if (onDiskSha256 !== dl.sha256) {
      problems.push(`  - vendor/${relPath}: on-disk sha256 (${onDiskSha256}) != pinned sha256 (${dl.sha256})`);
    }
  }

  // vendor/materialx/ (only populated by --with-materialx): if its manifest
  // exists, verify each listed file's on-disk byte size — absence is a
  // valid remote-mode state, not a --check failure, so it's skipped.
  let materialxChecked = 0;
  if (existsSync(MATERIALX_MANIFEST_PATH)) {
    const mxManifest = JSON.parse(await readFile(MATERIALX_MANIFEST_PATH, "utf8"));
    for (const file of mxManifest.files) {
      materialxChecked++;
      const destAbs = path.join(MATERIALX_ROOT, file.path.split("/").join(path.sep));
      if (!existsSync(destAbs)) {
        problems.push(`  - vendor/materialx/${file.path}: file missing on disk (manifest says it should exist)`);
        continue;
      }
      const onDiskSize = (await stat(destAbs)).size;
      if (onDiskSize !== file.bytes) {
        problems.push(`  - vendor/materialx/${file.path}: on-disk size (${onDiskSize}) != manifest size (${file.bytes})`);
      }
    }
  }

  if (problems.length > 0) {
    fail(["error: vendor/ is out of sync with scripts/vendor.mjs (--check failed):", ...problems, "", "Run `npm run vendor` to resync."].join("\n"));
  }

  log(`OK — vendor/ matches scripts/vendor.mjs spec and recorded hashes (${expectedPaths.size} file(s)).`);
  if (materialxChecked > 0) {
    log(`OK — vendor/materialx/ matches its manifest (${materialxChecked} file(s)).`);
  }

  const stampProblems = await checkStamps(await readVersionMeta());
  if (stampProblems.length > 0) {
    fail(
      [
        `error: MaterialX version literals are out of sync with MTLX_TAG ("${MTLX_TAG}"):`,
        ...stampProblems.map((p) => `  - ${p}`),
        "",
        "Run `node scripts/extract-mtlx-version.mjs` to re-stamp.",
      ].join("\n")
    );
  }
  log(`OK — MaterialX version stamps agree (${MTLX_TAG}).`);
}

// ---------------------------------------------------------------------------
// CLI entry point. Functions are also exported for a future build
// orchestrator to call directly; only auto-run when this file is the
// actual process entry point, not when something else imports it.
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
    await runCollect();
    if (WITH_MATERIALX) {
      await runMaterialx();
    }
  }
}
