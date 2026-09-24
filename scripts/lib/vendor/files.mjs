// scripts/lib/vendor/files.mjs
//
// files-source vendor deps: individual URLs fetched and verified against
// a pinned sha256 before being written to vendor/<dir>/.

import { writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** { destRel, url, sha256 } for every files-source entry of a dep;
 * pure, no I/O, what --check needs to know the expected paths. */
export function planFilesEntries(dep) {
  return dep.source.files.map((f) => ({ destRel: path.join(dep.dir, f.as), url: f.url, sha256: f.sha256 }));
}

export async function collectFilesDep(dep, vendorRoot) {
  const manifestEntries = [];
  for (const planned of planFilesEntries(dep)) {
    const res = await fetch(planned.url);
    if (!res.ok) {
      throw new Error(`${dep.id}: failed to download ${planned.url} - HTTP ${res.status} ${res.statusText}`);
    }
    const data = Buffer.from(await res.arrayBuffer());
    const actualSha256 = sha256Of(data);
    if (actualSha256 !== planned.sha256) {
      throw new Error(
        [
          `${dep.id}: sha256 mismatch for ${planned.url}`,
          `  expected: ${planned.sha256}`,
          `  actual:   ${actualSha256}`,
          `Verify the new content is expected, then update the sha256 in scripts/vendor-deps.mjs. See: node scripts/vendor.mjs --hash ${planned.url}`,
        ].join("\n")
      );
    }
    const destAbs = path.join(vendorRoot, planned.destRel);
    await mkdir(path.dirname(destAbs), { recursive: true });
    await writeFile(destAbs, data);
    manifestEntries.push({ path: toPosix(planned.destRel), dep: dep.id, source: planned.url, sha256: actualSha256, bytes: data.length });
  }
  return manifestEntries;
}
