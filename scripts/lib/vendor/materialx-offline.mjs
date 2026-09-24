// scripts/lib/vendor/materialx-offline.mjs
//
// --with-materialx: populates vendor/materialx/ from the MaterialX repo.
// Entirely separate from the lib-vendoring in scripts/vendor.mjs, moved
// here verbatim. Never invoked unless the --with-materialx flag is set.
//
// Acquisition is a shallow, blobless, sparse git clone at the pinned tag:
// the git protocol is anonymous for public repos and not subject to the
// GitHub REST API rate limit (the previous git-trees API approach could
// 403 on shared CI runner IPs), and only blobs under MTLX_INCLUDE_PREFIXES
// are ever downloaded. Integrity comes from git's own object hashing.

import { readFile, writeFile, mkdir, rm, readdir, stat, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readVersionMeta } from "../version.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const VENDOR_ROOT = path.join(REPO_ROOT, "vendor");
const MATERIALX_DIR_NAME = "materialx";
const MATERIALX_ROOT = path.join(VENDOR_ROOT, MATERIALX_DIR_NAME);
export const MATERIALX_MANIFEST_PATH = path.join(MATERIALX_ROOT, "manifest.json");

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

function log(...args) {
  console.log(...args);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** git's own blob hashing scheme: sha1("blob <byteLength>\0" + content). Pure function of the
 * bytes, needs no git binary, so the manifest's per-file `sha` fields stay comparable against
 * any git tree of the upstream repo without shelling out per file. */
function gitBlobSha1(buffer) {
  const header = Buffer.from(`blob ${buffer.length}\0`);
  return createHash("sha1").update(Buffer.concat([header, buffer])).digest("hex");
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

/** Run git with the given args, throwing (not exiting) on failure so callers can clean up. */
function runGit(args) {
  const res = spawnSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (res.error) {
    throw new Error(`failed to run git (${res.error.message}, git is required for --with-materialx)`);
  }
  if (res.status !== 0) {
    throw new Error(`\`git ${args.join(" ")}\` exited ${res.status}:\n${(res.stderr || "").trim()}`);
  }
}

export async function runMaterialx() {
  const MTLX_TAG = (await readVersionMeta()).tag;

  log("");
  log(`--with-materialx: vendoring MaterialX repo content @ ${MTLX_TAG} into vendor/materialx/ ...`);

  // Delete any existing manifest FIRST: its presence is the app's strict-local-mode marker, so a
  // manifest must never survive a failed/partial re-vend (leftover files staying behind is fine,
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
    // the manifest. (The clone also materializes the repo's root-level files, cone-mode sparse
    // checkouts always include them, but they are simply not copied.)
    const files = [];
    for (const prefix of MTLX_INCLUDE_PREFIXES) {
      const srcDir = path.join(cloneRoot, ...prefix.split("/").filter(Boolean));
      if (!existsSync(srcDir)) {
        throw new Error(`${prefix} is missing from the ${MTLX_TAG} clone (did the upstream repo layout change?)`);
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
        `error: --with-materialx failed, manifest.json NOT written, app stays in remote mode:`,
        `  ${caught.message}`,
        "",
        "Re-run `npm run vendor:offline` to retry.",
      ].join("\n")
    );
  }
}

/** vendor/materialx/'s on-disk file-size check, used by scripts/vendor.mjs --check.
 * Absence is a valid remote-mode state, not a failure, so it's skipped entirely. */
export async function checkMaterialxManifest() {
  const problems = [];
  let checked = 0;
  if (!existsSync(MATERIALX_MANIFEST_PATH)) {
    return { checked, problems };
  }
  const mxManifest = JSON.parse(await readFile(MATERIALX_MANIFEST_PATH, "utf8"));
  for (const file of mxManifest.files) {
    checked++;
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
  return { checked, problems };
}
