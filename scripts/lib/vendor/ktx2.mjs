// scripts/lib/vendor/ktx2.mjs
//
// vendor/three/KTX2Loader.js is generated (inlined jsm KTX2Loader stack),
// not vendored verbatim, so cleaning vendor/ wipes it; this wrapper
// regenerates it every collect. scripts/gen-ktx2-loader.mjs itself is
// unchanged, this just spawns it and reports.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const KTX2_LOADER_REL = "three/KTX2Loader.js";

export function regenerateKtx2Loader() {
  const res = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "gen-ktx2-loader.mjs")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (res.status !== 0) {
    throw new Error(`gen-ktx2-loader.mjs failed:\n${res.stderr || res.stdout}`);
  }
  return `generated vendor/${KTX2_LOADER_REL}`;
}
