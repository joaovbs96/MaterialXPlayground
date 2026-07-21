#!/usr/bin/env node
// scripts/build-learn.mjs
//
// Builds the "Learn" MkDocs subsite (learn-src/) into the committed
// `/learn/` output, served at /learn/ alongside the SPA.
//
// Two steps:
//   1. Copy the shared header script + vendored Tailwind Play build into
//      learn-src/docs/assets/vendored/ (gitignored — regenerated every
//      build) so learn-src/overrides/main.html can reference them via
//      relative `url` paths instead of reaching back out of docs_dir at
//      build time. This mirrors scripts/vendor.mjs's copy-then-verify
//      approach, just for the two assets the Learn header needs.
//   2. Run `mkdocs build -f learn-src/mkdocs.yml --clean`, which writes to
//      `../learn` relative to learn-src/ (see site_dir in mkdocs.yml) —
//      i.e. the repo's committed `/learn/` directory.
//
// Requires Python + mkdocs-material installed separately (not an npm
// dependency):
//   python -m pip install -r learn-src/requirements.txt
//
// Usage:
//   npm run build:learn              copy the shared assets, then build.
//   node scripts/build-learn.mjs --check
//                                     verify the vendored copies match
//                                     their source, without copying or
//                                     building. Non-zero exit on drift.
//
// Design notes: Node >=18, ESM, zero runtime dependencies — same as
// scripts/vendor.mjs, which this script's shape intentionally mirrors.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const LEARN_SRC = path.join(REPO_ROOT, "learn-src");
const VENDORED_ROOT = path.join(LEARN_SRC, "docs", "assets", "vendored");

const CHECK_MODE = process.argv.includes("--check");

// Source -> vendored-copy pairs, mirroring what learn-src/overrides/main.html
// references via the `url` filter (assets/vendored/js/site-header.js and
// assets/vendored/vendor/tailwind/tailwind-play.min.js). Single source of
// truth for both the copy and --check code paths, so they can't drift.
const COPIES = [
  {
    src: path.join(REPO_ROOT, "js", "site-header.js"),
    dest: path.join(VENDORED_ROOT, "js", "site-header.js"),
  },
  {
    src: path.join(REPO_ROOT, "vendor", "tailwind", "tailwind-play.min.js"),
    dest: path.join(VENDORED_ROOT, "vendor", "tailwind", "tailwind-play.min.js"),
  },
];

function log(...args) {
  console.log(...args);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function copyAll() {
  for (const { src, dest } of COPIES) {
    if (!existsSync(src)) {
      fail(`error: source file not found: ${path.relative(REPO_ROOT, src)}`);
    }
    const data = await readFile(src);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, data);
    log(`copied ${path.relative(REPO_ROOT, src)} -> ${path.relative(REPO_ROOT, dest)}`);
  }
}

// --check: verify the vendored copies exist and are byte-identical to their
// source, without writing anything. Matches vendor.mjs's --check philosophy
// (catches "edited the copy instead of the source" or "source changed,
// forgot to rebuild" drift) but scoped to just these two files.
async function runCheck() {
  const problems = [];
  for (const { src, dest } of COPIES) {
    if (!existsSync(src)) {
      problems.push(`  - source missing: ${path.relative(REPO_ROOT, src)}`);
      continue;
    }
    if (!existsSync(dest)) {
      problems.push(`  - vendored copy missing: ${path.relative(REPO_ROOT, dest)} (run \`npm run build:learn\`)`);
      continue;
    }
    const [srcData, destData] = await Promise.all([readFile(src), readFile(dest)]);
    if (!srcData.equals(destData)) {
      problems.push(`  - ${path.relative(REPO_ROOT, dest)} is stale (differs from ${path.relative(REPO_ROOT, src)}) — re-run \`npm run build:learn\``);
    }
  }
  if (problems.length > 0) {
    fail(["error: learn-src/docs/assets/vendored/ is out of sync (--check failed):", ...problems].join("\n"));
  }
  log(`OK — learn-src/docs/assets/vendored/ matches its source(s) (${COPIES.length} file(s)).`);
}

function runMkdocsBuild() {
  log("running: mkdocs build -f learn-src/mkdocs.yml --clean");
  const result = spawnSync("mkdocs", ["build", "-f", "learn-src/mkdocs.yml", "--clean"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: true,
  });
  if (result.error) {
    fail(
      [
        `error: failed to run mkdocs — ${result.error.message}`,
        "Is mkdocs-material installed? Run: python -m pip install -r learn-src/requirements.txt",
      ].join("\n")
    );
  }
  if (result.status !== 0) {
    fail(`error: mkdocs build exited with status ${result.status}`);
  }
}

if (CHECK_MODE) {
  await runCheck();
} else {
  await copyAll();
  runMkdocsBuild();
  log("");
  log("Learn subsite built to /learn/. Regenerate any time with `npm run build:learn`.");
}
