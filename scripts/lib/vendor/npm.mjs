// scripts/lib/vendor/npm.mjs
//
// npm-source vendor deps: files copied verbatim from node_modules/<pkg>.
// A glob dest key ("dist/fonts/*.woff2": "fonts/") expands to every match
// under the glob's static directory prefix, landing at dest + its path
// relative to that prefix.

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { globToRegExp, globStaticPrefix } from "../glob.mjs";

function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
function toPosix(p) {
  return p.split(path.sep).join("/");
}

async function listFilesRecursive(dir) {
  const out = [];
  async function walk(current, relPrefix) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      const rel = relPrefix ? path.join(relPrefix, entry.name) : entry.name;
      if (entry.isDirectory()) await walk(abs, rel);
      else if (entry.isFile()) out.push(rel);
    }
  }
  await walk(dir, "");
  return out.sort();
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
    const searchRoot = path.join(pkgDir, staticPrefix);
    const re = globToRegExp(srcPattern);
    if (!existsSync(searchRoot)) {
      missing.push(`node_modules/${dep.source.npm}/${staticPrefix} (needed for ${dep.id} glob "${srcPattern}")`);
      continue;
    }
    const files = await listFilesRecursive(searchRoot);
    let matched = 0;
    for (const relFile of files) {
      const fullSrcRel = toPosix(path.join(staticPrefix, relFile));
      if (!re.test(fullSrcRel)) continue;
      matched++;
      entries.push({ srcAbs: path.join(searchRoot, relFile), destRel: path.join(dep.dir, destPattern, relFile) });
    }
    if (matched === 0) {
      missing.push(`node_modules/${dep.source.npm}/${srcPattern} matched no files (needed for ${dep.id})`);
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
