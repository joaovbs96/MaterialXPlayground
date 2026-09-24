// scripts/lib/vendor/zip.mjs
//
// zip-source vendor deps: one release zip, verified by its own sha256,
// then extracted (shared top folder stripped, `include` applied) into
// vendor/<dir>/. See scripts/lib/zip.mjs for the ZIP reader itself.

import { writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { extractZipTree } from "../zip.mjs";

function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
function toPosix(p) {
  return p.split(path.sep).join("/");
}

export async function collectZipDep(dep, vendorRoot) {
  const res = await fetch(dep.source.zip);
  if (!res.ok) {
    throw new Error(`${dep.id}: failed to download ${dep.source.zip} - HTTP ${res.status} ${res.statusText}`);
  }
  const zipData = Buffer.from(await res.arrayBuffer());
  const actualSha256 = sha256Of(zipData);
  if (actualSha256 !== dep.source.sha256) {
    throw new Error(
      [
        `${dep.id}: sha256 mismatch for ${dep.source.zip}`,
        `  expected: ${dep.source.sha256}`,
        `  actual:   ${actualSha256}`,
        `Verify the new content is expected, then update the sha256 in scripts/vendor-deps.mjs. See: node scripts/vendor.mjs --hash ${dep.source.zip}`,
      ].join("\n")
    );
  }

  const { files } = extractZipTree(zipData, { include: dep.source.include });
  const manifestEntries = [];
  for (const file of files) {
    const destRel = path.join(dep.dir, ...file.path.split("/"));
    const destAbs = path.join(vendorRoot, destRel);
    await mkdir(path.dirname(destAbs), { recursive: true });
    await writeFile(destAbs, file.data);
    manifestEntries.push({
      path: toPosix(destRel),
      dep: dep.id,
      source: `${dep.source.zip}!/${file.zipName}`,
      sha256: sha256Of(file.data),
      bytes: file.data.length,
    });
  }
  return manifestEntries;
}
