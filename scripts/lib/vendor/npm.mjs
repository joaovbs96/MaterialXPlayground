// scripts/lib/vendor/npm.mjs
//
// npm-source vendor deps: files copied verbatim from node_modules/<pkg>.
// A glob dest key ("dist/fonts/*.woff2": "fonts/") expands to every match
// under the glob's static directory prefix, landing at dest + its path
// relative to that prefix.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, globSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** The literal path prefix before the first wildcard, up to and
 * including the last "/" (used to resolve a glob's destination dir). */
function globStaticPrefix(pattern) {
  const starIndex = pattern.search(/\*/);
  const prefix = starIndex === -1 ? pattern : pattern.slice(0, starIndex);
  const lastSlash = prefix.lastIndexOf("/");
  return lastSlash === -1 ? "" : prefix.slice(0, lastSlash + 1);
}

/** Expands a dep's npm file map into { srcAbs, destRel } pairs (dest
 * relative to vendor/). Reports every missing source path instead of
 * throwing on the first one. */
export async function expandNpmEntries(dep, nodeModulesDir) {
  const pkgDir = path.join(nodeModulesDir, dep.source.npm);
  const entries = [];
  const missing = [];

  for (const [srcPattern, destPattern] of Object.entries(dep.source.files)) {
    if (!srcPattern.includes("*")) {
      const srcAbs = path.join(pkgDir, srcPattern);
      if (!existsSync(srcAbs)) {
        missing.push(`node_modules/${dep.source.npm}/${srcPattern} (needed for vendor/${path.join(dep.dir, destPattern)})`);
        continue;
      }
      entries.push({ srcAbs, destRel: path.join(dep.dir, destPattern) });
      continue;
    }

    const staticPrefix = globStaticPrefix(srcPattern);
    const matches = existsSync(path.join(pkgDir, staticPrefix)) ? globSync(srcPattern, { cwd: pkgDir }) : [];
    if (matches.length === 0) {
      missing.push(`node_modules/${dep.source.npm}/${srcPattern} matched no files (needed for ${dep.id})`);
      continue;
    }
    for (const match of matches.sort()) {
      const matchPosix = toPosix(match);
      const relFromPrefix = matchPosix.slice(staticPrefix.length);
      entries.push({ srcAbs: path.join(pkgDir, match), destRel: path.join(dep.dir, destPattern, relFromPrefix) });
    }
  }
  return { entries, missing };
}

export async function readPkgVersion(dep, nodeModulesDir) {
  const pkgJsonPath = path.join(nodeModulesDir, dep.source.npm, "package.json");
  const raw = await readFile(pkgJsonPath, "utf8");
  return JSON.parse(raw).version;
}

/** Copies every expanded entry into vendor/ and returns manifest entries. */
export async function collectNpmDep(dep, nodeModulesDir, vendorRoot) {
  const { entries, missing } = await expandNpmEntries(dep, nodeModulesDir);
  if (missing.length > 0) {
    throw new Error([`${dep.id}: missing source path(s):`, ...missing.map((m) => `  - ${m}`)].join("\n"));
  }
  const version = await readPkgVersion(dep, nodeModulesDir);
  const manifestEntries = [];
  for (const entry of entries) {
    const destAbs = path.join(vendorRoot, entry.destRel);
    await mkdir(path.dirname(destAbs), { recursive: true });
    const data = await readFile(entry.srcAbs);
    await writeFile(destAbs, data);
    manifestEntries.push({
      path: toPosix(entry.destRel),
      dep: dep.id,
      source: `${dep.source.npm}@${version}`,
      sha256: sha256Of(data),
      bytes: data.length,
    });
  }
  return manifestEntries;
}
