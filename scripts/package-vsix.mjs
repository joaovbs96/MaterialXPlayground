#!/usr/bin/env node
// Drift guard between release.yml's `package` job and
// package-prerelease.yml's `package` job: every command signature below
// must appear in both files' job text, verbatim, offline, no network.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const WORKFLOWS = path.join(REPO_ROOT, ".github", "workflows");

function log(...args) {
  console.log("[package-vsix]", ...args);
}

function fail(message) {
  console.error(`[package-vsix] ${message}`);
  process.exit(1);
}

/** Extracts one top-level job's body from a workflow file's text, bounded
 * by the next top-level job key (both at 2-space indent under `jobs:`). */
function extractJob(text, jobName, nextJobName) {
  const re = new RegExp(`\\r?\\n  ${jobName}:\\r?\\n([\\s\\S]*?)\\r?\\n  ${nextJobName}:\\r?\\n`);
  const m = text.match(re);
  if (!m) fail(`could not find job "${jobName}" bounded by "${nextJobName}"`);
  return m[1];
}

const releaseText = readFileSync(path.join(WORKFLOWS, "release.yml"), "utf8");
const preText = readFileSync(path.join(WORKFLOWS, "package-prerelease.yml"), "utf8");

const releaseJob = extractJob(releaseText, "package", "desktop");
const preJob = extractJob(preText, "package", "smoke");

// Command fragments release.yml's package job runs to build and check the
// .vsix that this workflow's package job must keep reproducing. Not every
// release.yml fragment applies here (offline-zip-only steps are skipped on
// purpose): this list is the intersection both files must keep verbatim.
const SIGNATURES = [
  "npm ci",
  "npm audit --audit-level=high",
  "npm run vendor:offline",
  "npm run build",
  "git diff --exit-code",
  '[ -z "$(git status --porcelain)" ]',
  "npm run check",
  "node scripts/build-gallery.mjs",
  "--reuse-from",
  "--reuse-only",
  "node scripts/gallery-shots.mjs --prune-ids-auto",
  "cp .github/vsce/package.json .github/vsce/package-lock.json",
  "npm ci --ignore-scripts --no-audit --no-fund",
  "package --no-dependencies",
  "--readme-path vscode_extension/MARKETPLACE.md --changelog-path CHANGELOG.md",
  "--pre-release",
  "extension/vendor/materialx/manifest.json",
  "extension/js/gen/mtlx-version.json",
  "extension/environment_map.mtlx",
  "extension/vscode_extension/src/extension.js",
  "extension/readme.md",
  "extension/changelog.md",
  "extension/LICENSE.txt",
  "extension/vendor/vendor-manifest.json",
  "MTLX_VENDOR_DEPS).filter((d)=>d.vscode===false)",
  "extension/gallery/(manifest\\.json|thumbs/[^/]+\\.jpg)",
  "extension/vendor/materialx/resources/Images/",
  'PUB" != "local"',
  "sed -n 1p",
  'Id="Microsoft.VisualStudio.Code.PreRelease" Value="true"',
  "JsMaterialXGenShader.js JsMaterialXGenShader.wasm JsMaterialXGenShader.data",
];

const missing = [];
for (const sig of SIGNATURES) {
  const inRelease = releaseJob.includes(sig);
  const inPre = preJob.includes(sig);
  if (!inRelease) missing.push(`release.yml's package job no longer contains: ${sig}`);
  if (!inPre) missing.push(`package-prerelease.yml's package job is missing: ${sig}`);
}

if (missing.length) {
  fail(
    "packaging commands drifted between release.yml and package-prerelease.yml:\n" +
      missing.map((m) => `  - ${m}`).join("\n")
  );
}

log(`ok: ${SIGNATURES.length} packaging command signatures match in both workflows`);
