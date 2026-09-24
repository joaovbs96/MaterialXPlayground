#!/usr/bin/env node
// scripts/vendor.mjs
//
// CLI only. Collects pinned third-party assets registered in
// scripts/vendor-deps.mjs into the committed vendor/ folder for local
// (non-CDN) loading by the app and extension webview.
// Usage: npm run vendor | vendor -- --check | vendor -- --with-materialx | vendor -- --hash <url>

import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readVersionMeta, checkStamps } from "./lib/version.mjs";
import { loadResolvedDeps } from "./lib/vendor/registry.mjs";
import { expandNpmEntries, collectNpmDep, readPkgVersion } from "./lib/vendor/npm.mjs";
import { planFilesEntries, collectFilesDep } from "./lib/vendor/files.mjs";
import { collectZipDep } from "./lib/vendor/zip.mjs";
import { extractZipTree } from "./lib/zip.mjs";
import { regenerateKtx2Loader, KTX2_LOADER_REL } from "./lib/vendor/ktx2.mjs";
import { runMaterialx, checkMaterialxManifest } from "./lib/vendor/materialx-offline.mjs";
import { buildManifest, serializeManifest, sourceKindOf, renderGitignoreBlock, renderVscodeignoreBlock, spliceMarkedBlock, renderVendorDepsJs, normalizeLf } from "./lib/vendor/outputs.mjs";

export { runMaterialx };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const NODE_MODULES = path.join(REPO_ROOT, "node_modules");
const VENDOR_ROOT = path.join(REPO_ROOT, "vendor");
const MANIFEST_PATH = path.join(VENDOR_ROOT, "vendor-manifest.json");
const GITIGNORE_PATH = path.join(REPO_ROOT, ".gitignore");
const VSCODEIGNORE_PATH = path.join(REPO_ROOT, ".vscodeignore");
const VENDOR_DEPS_JS_PATH = path.join(REPO_ROOT, "js", "gen", "vendor-deps.js");
const MATERIALX_DIR_NAME = "materialx";

function log(...a) {
  console.log(...a);
}
function fail(message) {
  console.error(message);
  process.exit(1);
}
function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
function toPosix(p) {
  return p.split(path.sep).join("/");
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Remove everything directly under vendor/ except materialx/ (left untouched, not recursed into). */
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

/** "new" if none of a dep's current paths existed in the previous manifest,
 * "unchanged" if every one matches by path+sha256, else "updated". Works
 * against the old manifest format too, which has no `dep` field. */
function depStatus(depEntries, oldEntriesByPath) {
  let anyOld = false;
  let allSame = depEntries.length > 0;
  for (const e of depEntries) {
    const old = oldEntriesByPath.get(e.path);
    if (old) {
      anyOld = true;
      if (old.sha256 !== e.sha256) allSame = false;
    } else {
      allSame = false;
    }
  }
  return !anyOld ? "new" : allSame ? "unchanged" : "updated";
}

function displayVersion(dep, entries) {
  if (dep.version !== undefined) return dep.version;
  const withSource = entries.find((e) => e.dep === dep.id);
  const m = withSource ? /^(.*)@([^@]+)$/.exec(withSource.source) : null;
  return m ? m[2] : "?";
}

/** Writes `lfContent` only if it differs (LF-normalized) from what's on
 * disk, and preserves the existing file's line-ending style (CRLF stays
 * CRLF) so a no-op `npm run vendor` never touches these files. */
async function writeIfChanged(filePath, existingRaw, lfContent) {
  if (existingRaw !== null && normalizeLf(existingRaw) === normalizeLf(lfContent)) return;
  const eol = existingRaw !== null && existingRaw.includes("\r\n") ? "\r\n" : "\n";
  await writeFile(filePath, eol === "\r\n" ? lfContent.replace(/\n/g, "\r\n") : lfContent);
}

async function writeGeneratedFiles(resolvedDeps, allEntries) {
  await mkdir(path.dirname(VENDOR_DEPS_JS_PATH), { recursive: true });
  const existingVendorDepsJs = existsSync(VENDOR_DEPS_JS_PATH) ? await readFile(VENDOR_DEPS_JS_PATH, "utf8") : null;
  await writeIfChanged(VENDOR_DEPS_JS_PATH, existingVendorDepsJs, renderVendorDepsJs(resolvedDeps, allEntries));

  const gitignoreRaw = existsSync(GITIGNORE_PATH) ? await readFile(GITIGNORE_PATH, "utf8") : null;
  await writeIfChanged(GITIGNORE_PATH, gitignoreRaw, spliceMarkedBlock(gitignoreRaw || "", renderGitignoreBlock(resolvedDeps)));

  const vscodeignoreRaw = existsSync(VSCODEIGNORE_PATH) ? await readFile(VSCODEIGNORE_PATH, "utf8") : null;
  await writeIfChanged(VSCODEIGNORE_PATH, vscodeignoreRaw, spliceMarkedBlock(vscodeignoreRaw || "", renderVscodeignoreBlock(resolvedDeps)));
}

export async function runCollect() {
  const resolvedDeps = await loadResolvedDeps();

  if (!existsSync(NODE_MODULES)) {
    fail([`error: node_modules/ not found at ${NODE_MODULES}`, "Run `npm install` first (this reads the exact-pinned devDependencies in package.json)."].join("\n"));
  }

  // Read the previous manifest BEFORE wiping vendor/ (cleanVendorExceptMaterialx
  // deletes it too, being directly under vendor/), so status lines below can
  // still compare against it.
  const previousManifest = existsSync(MANIFEST_PATH) ? JSON.parse(await readFile(MANIFEST_PATH, "utf8")) : null;
  const oldEntriesByPath = new Map((previousManifest?.entries || []).map((e) => [e.path, e]));

  await cleanVendorExceptMaterialx();

  const allEntries = [];
  const rows = [];
  for (const dep of resolvedDeps) {
    const kind = sourceKindOf(dep);
    let entries;
    if (kind === "npm") entries = await collectNpmDep(dep, NODE_MODULES, VENDOR_ROOT);
    else if (kind === "zip") entries = await collectZipDep(dep, VENDOR_ROOT);
    else entries = await collectFilesDep(dep, VENDOR_ROOT);

    for (const e of entries) {
      const existing = allEntries.find((o) => o.path === e.path);
      if (existing) {
        fail(`error: duplicate vendor output path "${e.path}" (deps "${existing.dep}" and "${e.dep}")`);
      }
    }
    allEntries.push(...entries);
    rows.push({
      id: dep.id,
      version: displayVersion(dep, entries),
      kind,
      fileCount: entries.length,
      bytes: entries.reduce((s, e) => s + e.bytes, 0),
      status: depStatus(entries, oldEntriesByPath),
    });
  }

  const manifest = buildManifest(resolvedDeps, allEntries);
  await writeFile(MANIFEST_PATH, serializeManifest(manifest));

  let ktx2Line;
  try {
    ktx2Line = regenerateKtx2Loader();
  } catch (err) {
    fail(`error: ${err.message}`);
  }

  await writeGeneratedFiles(resolvedDeps, allEntries);

  const idWidth = Math.max(...rows.map((r) => r.id.length));
  const versionWidth = Math.max(...rows.map((r) => r.version.length));
  const kindWidth = Math.max(...rows.map((r) => r.kind.length));
  for (const r of rows) {
    log(`  ${r.id.padEnd(idWidth)}  ${r.version.padEnd(versionWidth)}  ${r.kind.padEnd(kindWidth)}  ${String(r.fileCount).padStart(3)} file(s)  ${humanSize(r.bytes).padStart(9)}  ${r.status}`);
  }
  const totalBytes = allEntries.reduce((s, e) => s + e.bytes, 0);
  const statusCounts = rows.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {});
  const statusSummary = Object.entries(statusCounts)
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  log("");
  log(`${rows.length} dep(s), ${allEntries.length} file(s), ${humanSize(totalBytes)} total (${statusSummary})`);
  log(ktx2Line);
  log(`generated js/gen/vendor-deps.js, .gitignore + .vscodeignore vendor-deps blocks`);
  log(`manifest written to ${path.relative(REPO_ROOT, MANIFEST_PATH)}`);
}

export async function runCheck() {
  const problems = [];
  const resolvedDeps = await loadResolvedDeps();

  if (!existsSync(MANIFEST_PATH)) {
    fail(`error: ${path.relative(REPO_ROOT, MANIFEST_PATH)} not found. Run \`npm run vendor\` first.`);
  }
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const manifestEntries = manifest.entries || [];
  const manifestEntriesByPath = new Map(manifestEntries.map((e) => [e.path, e]));

  if (!manifest.deps) {
    problems.push('  - vendor-manifest.json has no "deps" (old format): registry changed since the last `npm run vendor`');
  } else {
    const manifestDepsById = new Map(manifest.deps.map((d) => [d.id, d]));
    const currentIds = new Set(resolvedDeps.map((d) => d.id));
    for (const dep of resolvedDeps) {
      const kind = sourceKindOf(dep);
      const md = manifestDepsById.get(dep.id);
      if (!md) {
        problems.push(`  - registry changed since the last \`npm run vendor\`: "${dep.id}" is new`);
        continue;
      }
      const zipMismatch = kind === "zip" && (md.source !== dep.source.zip || md.sha256 !== dep.source.sha256);
      if (md.kind !== kind || (kind !== "npm" && md.version !== dep.version) || zipMismatch) {
        problems.push(`  - registry changed since the last \`npm run vendor\`: "${dep.id}" differs from vendor-manifest.json`);
      }
      if (kind === "npm") {
        try {
          const installedVersion = await readPkgVersion(dep, NODE_MODULES);
          if (md.version !== installedVersion) {
            problems.push(`  - ${dep.id}: installed npm version (${installedVersion}) != vendor-manifest.json version (${md.version}). Re-run \`npm run vendor\`.`);
          }
        } catch (err) {
          problems.push(`  - ${dep.id}: could not read the installed npm version: ${err.message}`);
        }
      }
    }
    for (const md of manifest.deps) {
      if (!currentIds.has(md.id)) problems.push(`  - registry changed since the last \`npm run vendor\`: "${md.id}" was removed`);
    }
  }

  const expectedPaths = new Set();
  for (const dep of resolvedDeps) {
    const kind = sourceKindOf(dep);
    if (kind === "npm") {
      const { entries, missing } = await expandNpmEntries(dep, NODE_MODULES);
      problems.push(...missing.map((m) => `  - ${dep.id}: ${m}`));
      for (const entry of entries) {
        const relPath = toPosix(entry.destRel);
        expectedPaths.add(relPath);
        const manifestEntry = manifestEntriesByPath.get(relPath);
        if (!manifestEntry || !existsSync(entry.srcAbs)) continue;
        const srcSha = sha256Of(await readFile(entry.srcAbs));
        if (srcSha !== manifestEntry.sha256) {
          problems.push(`  - vendor/${relPath}: stale, node_modules source now hashes to ${srcSha}, manifest recorded ${manifestEntry.sha256}. Re-run \`npm run vendor\`.`);
        }
      }
    } else if (kind === "zip") {
      for (const entry of manifestEntries.filter((e) => e.dep === dep.id)) {
        expectedPaths.add(entry.path);
      }
    } else {
      for (const planned of planFilesEntries(dep)) {
        const relPath = toPosix(planned.destRel);
        expectedPaths.add(relPath);
        const manifestEntry = manifestEntriesByPath.get(relPath);
        if (manifestEntry && manifestEntry.sha256 !== planned.sha256) {
          problems.push(`  - vendor/${relPath}: manifest sha256 (${manifestEntry.sha256}) != pinned sha256 in scripts/vendor-deps.mjs (${planned.sha256})`);
        }
      }
    }
  }

  for (const relPath of expectedPaths) {
    if (!manifestEntriesByPath.has(relPath)) problems.push(`  - missing from manifest: ${relPath}`);
  }
  for (const relPath of manifestEntriesByPath.keys()) {
    if (!expectedPaths.has(relPath)) problems.push(`  - unexpected entry in manifest: ${relPath}`);
  }

  const depById = new Map(resolvedDeps.map((d) => [d.id, d]));
  for (const entry of manifestEntries) {
    if (!depById.has(entry.dep)) {
      problems.push(`  - vendor/${entry.path}: manifest entry references unknown dep "${entry.dep}"`);
      continue;
    }
    const destAbs = path.join(VENDOR_ROOT, entry.path.split("/").join(path.sep));
    if (!existsSync(destAbs)) {
      problems.push(`  - vendor/${entry.path}: file missing on disk (manifest says it should exist)`);
      continue;
    }
    const onDiskSha = sha256Of(await readFile(destAbs));
    if (onDiskSha !== entry.sha256) {
      problems.push(`  - vendor/${entry.path}: on-disk sha256 (${onDiskSha}) != manifest sha256 (${entry.sha256})`);
    }
  }

  for (const dep of resolvedDeps) {
    const depRelPaths = new Set(manifestEntries.filter((e) => e.dep === dep.id).map((e) => e.path.slice(dep.dir.length + 1)));
    if (dep.license.file && !depRelPaths.has(dep.license.file)) {
      problems.push(`  - ${dep.id}: license.file "${dep.license.file}" not among its vendored files`);
    }
    if (dep.module && dep.module.entry && !depRelPaths.has(dep.module.entry)) {
      problems.push(`  - ${dep.id}: module.entry "${dep.module.entry}" not among its vendored files`);
    }
  }

  const expectedVendorDepsJs = normalizeLf(renderVendorDepsJs(resolvedDeps, manifestEntries));
  const actualVendorDepsJs = existsSync(VENDOR_DEPS_JS_PATH) ? normalizeLf(await readFile(VENDOR_DEPS_JS_PATH, "utf8")) : null;
  if (actualVendorDepsJs !== expectedVendorDepsJs) {
    problems.push("  - js/gen/vendor-deps.js does not match scripts/vendor-deps.mjs. Run `npm run vendor`.");
  }

  const gitignoreRaw = existsSync(GITIGNORE_PATH) ? await readFile(GITIGNORE_PATH, "utf8") : "";
  if (normalizeLf(gitignoreRaw) !== spliceMarkedBlock(gitignoreRaw, renderGitignoreBlock(resolvedDeps))) {
    problems.push("  - .gitignore vendor-deps block is out of sync. Run `npm run vendor`.");
  }
  const vscodeignoreRaw = existsSync(VSCODEIGNORE_PATH) ? await readFile(VSCODEIGNORE_PATH, "utf8") : "";
  if (normalizeLf(vscodeignoreRaw) !== spliceMarkedBlock(vscodeignoreRaw, renderVscodeignoreBlock(resolvedDeps))) {
    problems.push("  - .vscodeignore vendor-deps block is out of sync. Run `npm run vendor`.");
  }

  if (!existsSync(path.join(VENDOR_ROOT, KTX2_LOADER_REL))) {
    problems.push(`  - vendor/${KTX2_LOADER_REL} is missing. Run \`npm run vendor\` (it is generated by scripts/gen-ktx2-loader.mjs).`);
  }

  if (problems.length > 0) {
    fail(["error: vendor/ is out of sync with scripts/vendor-deps.mjs (--check failed):", ...problems, "", "Run `npm run vendor` to resync."].join("\n"));
  }

  log(`OK: vendor/ matches scripts/vendor-deps.mjs spec and recorded hashes (${expectedPaths.size} file(s)).`);

  const { checked: materialxChecked, problems: mxProblems } = await checkMaterialxManifest();
  if (mxProblems.length > 0) {
    fail(["error: vendor/materialx/ is out of sync with its manifest:", ...mxProblems, "", "Re-run `npm run vendor:offline`."].join("\n"));
  }
  if (materialxChecked > 0) {
    log(`OK: vendor/materialx/ matches its manifest (${materialxChecked} file(s)).`);
  }

  const meta = await readVersionMeta();
  const stampProblems = await checkStamps(meta);
  if (stampProblems.length > 0) {
    fail([`error: MaterialX version literals are out of sync with MTLX_TAG ("${meta.tag}"):`, ...stampProblems.map((p) => `  - ${p}`), "", "Run `node scripts/extract-mtlx-version.mjs` to re-stamp."].join("\n"));
  }
  log(`OK: MaterialX version stamps agree (${meta.tag}).`);
}

async function runHash(url) {
  const res = await fetch(url);
  if (!res.ok) fail(`error: failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
  const data = Buffer.from(await res.arrayBuffer());
  const sha256 = sha256Of(data);
  log(`sha256: ${sha256}`);
  log(`bytes:  ${data.length}`);

  const isZip = data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
  if (isZip) {
    let files, strippedPrefix;
    try {
      ({ files, strippedPrefix } = await extractZipTree(data));
    } catch (err) {
      fail(`error: ${err.message}`);
      return;
    }
    log("");
    log(`zip tree (${files.length} file(s)${strippedPrefix ? `, stripped top folder "${strippedPrefix}/"` : ""}):`);
    for (const f of files) log(`  ${f.path}  (${f.data.length} bytes)`);
    log("");
    log("source: { zip: " + JSON.stringify(url) + ", sha256: " + JSON.stringify(sha256) + " }");
  } else {
    const basename = path.posix.basename(new URL(url).pathname) || "file";
    log("");
    log("paste-ready files entry (one element of source.files):");
    log("{ url: " + JSON.stringify(url) + ", sha256: " + JSON.stringify(sha256) + ", as: " + JSON.stringify(basename) + " }");
  }
}

// ---------------------------------------------------------------------------
// CLI entry point. Functions are also exported for scripts/build.mjs and
// .github/workflows/deploy.yml to call in-process.
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
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        check: { type: "boolean" },
        "with-materialx": { type: "boolean" },
        hash: { type: "string" },
      },
      strict: true,
    }));
  } catch (err) {
    fail(`error: ${err.message}`);
  }

  if (values.hash !== undefined) {
    await runHash(values.hash);
  } else if (values.check) {
    await runCheck();
  } else {
    await runCollect();
    if (values["with-materialx"]) {
      await runMaterialx();
    }
  }
}
