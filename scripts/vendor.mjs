#!/usr/bin/env node
// scripts/vendor.mjs
//
// Collects pinned third-party assets into the committed vendor/ folder
// for local (non-CDN) loading by the app and extension webview.
// Usage: npm run vendor | vendor -- --check | vendor -- --with-materialx
//
// CI-verified source of truth (--check gates drift); vendor/materialx/
// is touched only by --with-materialx, else CDN fallback at runtime.

import { readFile, writeFile, mkdir, rm, readdir, stat, mkdtemp } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
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
const MTLX_GIT_URL = `https://github.com/${MTLX_REPO}.git`;
// Directory prefixes (POSIX git-tree paths). Whole directories are
// vendored, not just the files read today, because the preset crawler
// resolves xi:include siblings and relative texture paths at runtime.
const MTLX_INCLUDE_PREFIXES = ["documents/Specification/", "resources/Materials/Examples/", "resources/Images/"];
// Root-level files copied verbatim alongside the prefixes above. Apache-2.0
// requires the license to travel with the vendored content, which the deploy
// ships to the live site.
const MTLX_INCLUDE_FILES = ["LICENSE"];

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
  { pkg: "three", src: "examples/js/loaders/OBJLoader.js", dest: "three/OBJLoader.js" },
  { pkg: "three", src: "examples/js/controls/OrbitControls.js", dest: "three/OrbitControls.js" },
  // "three-147" is an npm alias (three-147: npm:three@0.147.0) — only this
  // version's examples/js/libs/fflate.min.js is vendored; the rest of the
  // three@0.147.0 tree is unused and intentionally left uncollected.
  { pkg: "three-147", src: "examples/js/libs/fflate.min.js", dest: "three/fflate.min.js" },

  { pkg: "three", src: "examples/js/loaders/DRACOLoader.js", dest: "three/DRACOLoader.js" },
  { pkg: "three", src: "examples/js/libs/draco/gltf/draco_wasm_wrapper.js", dest: "three/draco/draco_wasm_wrapper.js" },
  // WASM-only, like the KaTeX woff2-only filter above: the app hard-requires
  // WebAssembly anyway, so the 548KB draco_decoder.js JS fallback is never
  // vendored.
  { pkg: "three", src: "examples/js/libs/draco/gltf/draco_decoder.wasm", dest: "three/draco/draco_decoder.wasm" },

  { pkg: "katex", src: "dist/katex.min.css", dest: "katex/katex.min.css" },
  { pkg: "katex", src: "dist/katex.min.js", dest: "katex/katex.min.js" },
  // katex.min.css references url(fonts/...) relative to itself, so
  // fonts/ must sit alongside it. Only .woff2 is vendored — the app
  // needs WebAssembly (2017+) anyway, so older fallback formats are dead weight.
  { pkg: "katex", src: "dist/fonts", dest: "katex/fonts", recursive: true, filter: /\.woff2$/ },

  { pkg: "jszip", src: "dist/jszip.min.js", dest: "jszip/jszip.min.js" },

  { pkg: "utif", src: "UTIF.js", dest: "utif/UTIF.js" },

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
  { pkg: "utif", src: "LICENSE", dest: "utif/LICENSE.txt" },
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
  // The Draco decoder files above come bundled inside three@0.128.0, but
  // Draco itself is Google's project under a separate Apache-2.0 license,
  // not on npm, so its LICENSE is fetched from a pinned google/draco tag.
  {
    url: "https://raw.githubusercontent.com/google/draco/1.5.7/LICENSE",
    dest: "three/draco/LICENSE.txt",
    sha256: "d3709b0fb4b8a94bbb1d02b8a2e484f258b0d9c5c5a01f940391f3fe662cd1a4",
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
 * bytes — needs no git binary, so the manifest's per-file `sha` fields stay comparable against
 * any git tree of the upstream repo without shelling out per file. */
function gitBlobSha1(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`);
  return createHash("sha1").update(Buffer.concat([header, buffer])).digest("hex");
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
//
// Acquisition is a shallow, blobless, sparse git clone at the pinned tag:
// the git protocol is anonymous for public repos and not subject to the
// GitHub REST API rate limit (the previous git-trees API approach could
// 403 on shared CI runner IPs), and only blobs under MTLX_INCLUDE_PREFIXES
// are ever downloaded. Integrity comes from git's own object hashing.
// ---------------------------------------------------------------------------

/** Run git with the given args, throwing (not exiting) on failure so callers can clean up. */
function runGit(args) {
  const res = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (res.error) {
    throw new Error(`failed to run git (${res.error.message}) — git is required for --with-materialx`);
  }
  if (res.status !== 0) {
    throw new Error(`\`git ${args.join(" ")}\` exited ${res.status}:\n${(res.stderr || "").trim()}`);
  }
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

  const cloneRoot = await mkdtemp(path.join(tmpdir(), "mtlx-vendor-"));
  let caught = null;
  try {
    log(`sparse-cloning ${MTLX_GIT_URL} @ ${MTLX_TAG} (shallow, blobs fetched on demand) ...`);
    runGit(["clone", "--quiet", "--depth=1", "--filter=blob:none", "--sparse", "--branch", MTLX_TAG, MTLX_GIT_URL, cloneRoot]);
    runGit(["-C", cloneRoot, "sparse-checkout", "set", ...MTLX_INCLUDE_PREFIXES.map((p) => p.replace(/\/$/, ""))]);

    // Copy everything under the include prefixes into vendor/materialx/, hashing each file for
    // the manifest. (The clone also materializes the repo's root-level files — cone-mode sparse
    // checkouts always include them — but they are simply not copied.)
    const files = [];
    for (const prefix of MTLX_INCLUDE_PREFIXES) {
      const srcDir = path.join(cloneRoot, ...prefix.split("/").filter(Boolean));
      if (!existsSync(srcDir)) {
        throw new Error(`${prefix} is missing from the ${MTLX_TAG} clone — did the upstream repo layout change?`);
      }
      for (const rel of await listFilesRecursive(srcDir)) {
        const posixPath = prefix + rel.split(path.sep).join("/");
        const data = await readFile(path.join(srcDir, rel));
        const destAbs = path.join(MATERIALX_ROOT, ...posixPath.split("/"));
        await mkdir(path.dirname(destAbs), { recursive: true });
        await writeFile(destAbs, data);
        files.push({ path: posixPath, bytes: data.length, sha: gitBlobSha1(data) });
      }
    }
    for (const rel of MTLX_INCLUDE_FILES) {
      const srcAbs = path.join(cloneRoot, ...rel.split("/"));
      if (!existsSync(srcAbs)) {
        throw new Error(`${rel} is missing from the ${MTLX_TAG} clone. Did the upstream repo layout change?`);
      }
      const data = await readFile(srcAbs);
      const destAbs = path.join(MATERIALX_ROOT, ...rel.split("/"));
      await mkdir(path.dirname(destAbs), { recursive: true });
      await writeFile(destAbs, data);
      files.push({ path: rel, bytes: data.length, sha: gitBlobSha1(data) });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    const totalBytes = files.reduce((sum, f) => sum + f.bytes, 0);
    log(`copied ${files.length} file(s) from the sparse checkout under: ${MTLX_INCLUDE_PREFIXES.join(", ")} (plus ${MTLX_INCLUDE_FILES.join(", ")})`);

    const manifest = {
      tag: MTLX_TAG,
      generatedAt: new Date().toISOString(),
      fileCount: files.length,
      totalBytes,
      files,
    };
    // Written LAST, only now that the clone and every copy above succeeded.
    await writeFile(MATERIALX_MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");

    log("");
    log(`vendor/materialx/manifest.json written: ${files.length} file(s), ${totalBytes} bytes total.`);
  } catch (err) {
    caught = err;
  } finally {
    await rm(cloneRoot, { recursive: true, force: true });
  }
  if (caught) {
    fail(
      [
        `error: --with-materialx failed — manifest.json NOT written, app stays in remote mode:`,
        `  ${caught.message}`,
        "",
        "Re-run `npm run vendor:offline` to retry.",
      ].join("\n")
    );
  }
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
