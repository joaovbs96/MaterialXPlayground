#!/usr/bin/env node
// scripts/build-tutorials.mjs
//
// Builds the "Tutorials" MkDocs subsite (tutorials-src/) into the committed
// `/tutorials/` output, served at /tutorials/ alongside the SPA.
//
// Two steps:
//   1. Copy the shared header script + its plain-CSS stylesheets (design
//      tokens + component styles — no Tailwind dependency) into
//      tutorials-src/docs/assets/vendored/ (gitignored — regenerated every
//      build) so tutorials-src/overrides/main.html can reference them via
//      relative `url` paths instead of reaching back out of docs_dir at
//      build time. This mirrors scripts/vendor.mjs's copy-then-verify
//      approach, just for the assets the Tutorials header needs.
//   2. Run `mkdocs build -f tutorials-src/mkdocs.yml --clean`, which writes to
//      `../tutorials` relative to tutorials-src/ (see site_dir in mkdocs.yml) —
//      i.e. the repo's committed `/tutorials/` directory.
//
// Requires Python + mkdocs-material installed separately (not an npm
// dependency):
//   python -m pip install -r tutorials-src/requirements.txt
//
// Usage:
//   npm run build:tutorials          copy the shared assets, then build.
//   node scripts/build-tutorials.mjs --check
//                                     verify the vendored copies match
//                                     their source, without copying or
//                                     building. Non-zero exit on drift.
//
// Design notes: Node >=18, ESM, zero runtime dependencies — same as
// scripts/vendor.mjs, which this script's shape intentionally mirrors.

import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const TUTORIALS_SRC = path.join(REPO_ROOT, "tutorials-src");
const VENDORED_ROOT = path.join(TUTORIALS_SRC, "docs", "assets", "vendored");
// Material's built-in search copies its full lunr language-pack tree into the
// output on every build; this site's search is English-only, so it's unused.
const LUNR_PACKS_DIR = path.join(REPO_ROOT, "tutorials", "assets", "javascripts", "lunr");
// mkdocs also emits a gzipped copy of the sitemap alongside the plain one.
const SITEMAP_GZ_PATH = path.join(REPO_ROOT, "tutorials", "sitemap.xml.gz");

const CHECK_MODE = process.argv.includes("--check");

// Source -> vendored-copy pairs, mirroring what tutorials-src/overrides/main.html
// references via the `url` filter (assets/vendored/js/site-header.js,
// assets/vendored/js/site-tokens.css, assets/vendored/js/site-header.css).
// Single source of truth for both the copy and --check code paths, so they
// can't drift.
const COPIES = [
  {
    src: path.join(REPO_ROOT, "js", "site-header.js"),
    dest: path.join(VENDORED_ROOT, "js", "site-header.js"),
  },
  {
    src: path.join(REPO_ROOT, "js", "site-tokens.css"),
    dest: path.join(VENDORED_ROOT, "js", "site-tokens.css"),
  },
  {
    src: path.join(REPO_ROOT, "js", "site-header.css"),
    dest: path.join(VENDORED_ROOT, "js", "site-header.css"),
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
      problems.push(`  - vendored copy missing: ${path.relative(REPO_ROOT, dest)} (run \`npm run build:tutorials\`)`);
      continue;
    }
    const [srcData, destData] = await Promise.all([readFile(src), readFile(dest)]);
    if (!srcData.equals(destData)) {
      problems.push(`  - ${path.relative(REPO_ROOT, dest)} is stale (differs from ${path.relative(REPO_ROOT, src)}) — re-run \`npm run build:tutorials\``);
    }
  }
  if (problems.length > 0) {
    fail(["error: tutorials-src/docs/assets/vendored/ is out of sync (--check failed):", ...problems].join("\n"));
  }
  log(`OK — tutorials-src/docs/assets/vendored/ matches its source(s) (${COPIES.length} file(s)).`);
}

function runMkdocsBuild() {
  log("running: mkdocs build -f tutorials-src/mkdocs.yml --clean");
  const result = spawnSync("mkdocs", ["build", "-f", "tutorials-src/mkdocs.yml", "--clean"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: true,
  });
  if (result.error) {
    fail(
      [
        `error: failed to run mkdocs — ${result.error.message}`,
        "Is mkdocs-material installed? Run: python -m pip install -r tutorials-src/requirements.txt",
      ].join("\n")
    );
  }
  if (result.status !== 0) {
    fail(`error: mkdocs build exited with status ${result.status}`);
  }
}

// Material for MkDocs copies its full lunr language-pack tree (non-English
// stemmers + CJK/Thai segmenters, ~965 KB across 34 files) into the output on
// every build. This site's search is English-only ("lang":["en"]) and English
// support is bundled in the search worker itself — none of the lunr/ files are
// ever fetched at runtime. Prune the directory post-build so it stays out of
// the committed /tutorials/ output (also gitignored as a backstop). If a
// non-English search language is ever added, remove this call and its
// .gitignore entry.
async function prunePacks() {
  await rm(LUNR_PACKS_DIR, { recursive: true, force: true });
  log(`pruned ${path.relative(REPO_ROOT, LUNR_PACKS_DIR)} (English-only search)`);
}

// mkdocs gzips the sitemap and writes it alongside the plain sitemap.xml, but
// the gzip header embeds the build time, so the compressed bytes differ on
// every rebuild even when the underlying sitemap content is unchanged. That
// nondeterminism would permanently trip CI's byte-identical gate against the
// committed /tutorials/ tree. The plain sitemap.xml has no such header and
// stays deterministic, so it remains; prune the .gz post-build (also
// gitignored as a backstop) since crawlers don't need it.
async function pruneSitemapGz() {
  await rm(SITEMAP_GZ_PATH, { force: true });
  log(`pruned ${path.relative(REPO_ROOT, SITEMAP_GZ_PATH)} (nondeterministic gzip header)`);
}

if (CHECK_MODE) {
  await runCheck();
} else {
  await copyAll();
  runMkdocsBuild();
  await prunePacks();
  await pruneSitemapGz();
  log("");
  log("Tutorials subsite built to /tutorials/. Regenerate any time with `npm run build:tutorials`.");
}
