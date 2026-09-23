#!/usr/bin/env node
// scripts/run-unit-tests.mjs: runs `node --test` over tests/unit/*.test.mjs,
// skipping files listed in QUARANTINE below. A quarantined file that no
// longer exists fails the run, so the list cannot silently rot.
//
// Usage: node scripts/run-unit-tests.mjs

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const UNIT_DIR = path.join(REPO_ROOT, "tests", "unit");

// { file, reason } for each unit test file skipped in this run. Every
// entry's file must exist on disk, or this script exits non-zero.
const QUARANTINE = [
  {
    file: "mtlx-engine-aces-transform.test.mjs",
    reason: "reads scratchpad/displacement-verified/color-parity/brown-chart/chart_table.json, a local-only fixture not committed to git",
  },
];

const allFiles = readdirSync(UNIT_DIR)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

let hadError = false;
for (const entry of QUARANTINE) {
  if (!existsSync(path.join(UNIT_DIR, entry.file))) {
    console.error(`run-unit-tests: quarantined file no longer exists: ${entry.file}`);
    hadError = true;
  }
}
if (hadError) process.exit(1);

const quarantinedFiles = new Set(QUARANTINE.map((e) => e.file));
const runFiles = allFiles.filter((f) => !quarantinedFiles.has(f));

if (QUARANTINE.length) {
  console.log("run-unit-tests: quarantined:");
  for (const entry of QUARANTINE) console.log(`  ${entry.file}: ${entry.reason}`);
}
console.log(`run-unit-tests: running ${runFiles.length} of ${allFiles.length} files in tests/unit/`);

const result = spawnSync(
  process.execPath,
  ["--test", ...runFiles.map((f) => path.join(UNIT_DIR, f))],
  { cwd: REPO_ROOT, stdio: "inherit" }
);

process.exit(result.status == null ? 1 : result.status);
