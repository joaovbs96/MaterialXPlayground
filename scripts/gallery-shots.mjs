#!/usr/bin/env node
// scripts/gallery-shots.mjs
//
// Headless thumbnail capture for the material gallery: reads
// gallery/manifest.json, drives the repo's pinned Playwright chromium
// against tests/embed/fixtures/harness.html (the same idiom
// tests/embed/lib/test-base.mjs uses), and screenshots one <materialx-
// viewer> per material into <out>/thumbs/<id>.jpg.
//
// Captures run on a pool of workers pulling from a shared cursor. Each
// capture still gets a FRESH page and a fresh viewer: reusing one warm
// viewer and swapping documents through the embed's load() command was
// measured slower (the long-lived page degrades: 13.3s -> ~16s per
// material) and it hangs outright on xi:include documents, which the
// `src` path resolves by crawling. See docs/local/GALLERY-ASSETS.md.
//
// Usage: node scripts/gallery-shots.mjs [--manifest <path>] [--out <dir>]
//                                       [--limit N] [--only <id>] [--jobs N]
//                                       [--reuse-from <url>] [--reuse-only]
//                                       [--prune-ids <id,id,...>] [--prune-ids-auto]
//
// --reuse-from makes a deploy incremental: it reads the manifest already
// published at that site and re-downloads every thumbnail whose material
// fingerprint is unchanged, so only new or edited materials get rendered.
// Rendering is CPU-bound software rasterization on a GPU-less runner
// (~13s each), so NOT rendering is worth far more than rendering faster.
// Any failure falls back to a full capture: slow, never wrong.
//
// --reuse-only downloads what is published and renders NOTHING, so it
// needs no browser. That is what the release artifacts use: the offline
// zip and the desktop app want real tiles but must not spend 13s a piece
// re-rendering what the site already published. Materials with no
// published tile keep the gallery's placeholder, exactly as before.
//
// --prune-ids trims an ALREADY populated <out> (manifest.json plus
// thumbs/) down to exactly the given ids: no network, no browser. It
// rewrites manifest.json to list only those materials (ids absent from
// the manifest are skipped, not an error) and deletes every thumb file
// not in the set. Used by the .vsix packaging step: the full gallery is
// too large to ship in the extension, but a handful of preset/example
// thumbnails at original resolution are worth it.
//
// --prune-ids-auto computes that id set itself: the union of
// vscode_extension/src/exampleCatalog.js's destNames (the "New Material
// from Example" catalog) and js/shared/mtlx-ui.jsx's MTLX_PRESETS entries
// (the preset picker's no-manifest fallback list, read as text since that
// file is JSX). This keeps the .vsix's preset picker listing the SAME
// materials it lists with no manifest at all (MTLX_PRESETS) or with the
// full manifest on the web - only pruned to a subset never shrinks what
// the picker shows, just what gets a real thumbnail vs. a placeholder.

import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startServer } from "../tests/embed/lib/server.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

const HARNESS_PATH = "/tests/embed/fixtures/harness.html";
// Scaled by --jobs below: N workers sharing the CPU inflate each
// capture roughly N-fold, and a fixed 60s budget turns that into mass
// timeouts rather than a slower-but-correct run.
// The heaviest shaders (anisotropic coat, OpenPBR car paint) compile for
// well over 30s on a GPU-less runner, and the compile blocks the renderer
// thread, so the screenshot itself needs a generous cap.
const PER_MATERIAL_TIMEOUT_BASE_MS = 240000;
const READY_WAIT_TIMEOUT_MS = 90000;
const SCREENSHOT_TIMEOUT_MS = 150000;
const SETTLE_WAIT_MS = 1500;
const MAX_ATTEMPTS = 3;

function log(...args) {
  console.log(...args);
}

function parseArgs(argv) {
  let manifestPath = path.join(REPO_ROOT, "gallery", "manifest.json");
  let outDir = path.join(REPO_ROOT, "gallery");
  let limit = null;
  let only = null;
  // DEFAULT 1, deliberately. Concurrency is implemented and works, but it
  // is NOT safe with the current capture: mtlx-ready fires before the first
  // paint, and the fixed SETTLE_WAIT_MS below is a wall-clock guess. Under
  // CPU contention the render misses that window and the screenshot catches
  // an unpainted viewport, which is SILENT corruption (exit 0, black tile).
  // Measured at --jobs 2 over all 54: 543s vs 720s (1.33x) but 8 thumbnails
  // came back blank (mean brightness ~25/255 against ~200 expected). The
  // same 8 are pixel-perfect at --jobs 1.
  //
  // Stability polling cannot rescue it either: a black frame is stable.
  // Making concurrency safe needs a real paint signal, and one exists --
  // the embed's snapshot() command routes to mtlx-engine.js's
  // handle.snapshot(), which does setUniforms(); renderFrame(); toDataURL()
  // synchronously, so it cannot return an unpainted frame. Switching the
  // capture to that is the prerequisite for raising this default.
  let jobs = 1;
  let reuseFrom = null;
  let reuseOnly = false;
  let pruneIds = null;
  let pruneIdsAuto = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--manifest" && argv[i + 1]) {
      manifestPath = path.resolve(argv[++i]);
    } else if (arg === "--out" && argv[i + 1]) {
      outDir = path.resolve(argv[++i]);
    } else if (arg === "--limit" && argv[i + 1]) {
      limit = Number(argv[++i]);
    } else if (arg === "--only" && argv[i + 1]) {
      only = argv[++i];
    } else if (arg === "--jobs" && argv[i + 1]) {
      jobs = Math.max(1, Number(argv[++i]) || 1);
    } else if (arg === "--reuse-from" && argv[i + 1]) {
      reuseFrom = String(argv[++i]).replace(/\/+$/, "");
    } else if (arg === "--reuse-only") {
      reuseOnly = true;
    } else if (arg === "--prune-ids" && argv[i + 1]) {
      pruneIds = String(argv[++i]).split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--prune-ids-auto") {
      pruneIdsAuto = true;
    }
  }
  return { manifestPath, outDir, limit, only, jobs, reuseFrom, reuseOnly, pruneIds, pruneIdsAuto };
}

/** Rewrites <outDir>/manifest.json to list only `ids`, and deletes every
 * file under <outDir>/thumbs not named "<id>.jpg" for one of them. Pure
 * filesystem, no network/browser: prunes a gallery already populated by
 * an earlier build-gallery.mjs + gallery-shots.mjs run. */
async function pruneGallery(manifestPath, outDir, ids) {
  const wanted = new Set(ids);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const kept = (manifest.materials || []).filter((m) => wanted.has(m.id));
  const keptIds = new Set(kept.map((m) => m.id));
  const missing = ids.filter((id) => !keptIds.has(id));

  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify({ ...manifest, materials: kept }, null, 2) + "\n");

  const thumbsDir = path.join(outDir, "thumbs");
  let removed = 0;
  let keptThumbs = 0;
  let entries = [];
  try {
    entries = await readdir(thumbsDir);
  } catch (e) {
    entries = []; // no thumbs/ at all: nothing to prune
  }
  for (const name of entries) {
    const id = name.replace(/\.jpg$/i, "");
    if (keptIds.has(id) && name.toLowerCase().endsWith(".jpg")) {
      keptThumbs++;
    } else {
      await unlink(path.join(thumbsDir, name)).catch(() => {});
      removed++;
    }
  }

  log(`gallery prune: manifest trimmed to ${kept.length} material(s), ${keptThumbs} thumbnail(s) kept, ${removed} removed.`);
  if (missing.length) log(`prune: ${missing.length} id(s) had no manifest entry (no thumbnail shipped): ${missing.join(", ")}`);
}

/** Gallery ids referenced by js/shared/mtlx-ui.jsx's MTLX_PRESETS array: the
 * preset picker's fallback list when no manifest ships at all. Parsed as
 * text (the file is JSX, not requireable from plain Node) - each entry's
 * `path`/`src` value's basename minus ".mtlx" IS its gallery id, the same
 * rule scripts/build-gallery.mjs uses. */
async function mtlxPresetGalleryIds() {
  const text = await readFile(path.join(REPO_ROOT, "js", "shared", "mtlx-ui.jsx"), "utf8");
  const start = text.indexOf("const MTLX_PRESETS = [");
  if (start === -1) return [];
  const end = text.indexOf("\n];", start);
  const block = text.slice(start, end === -1 ? undefined : end);
  const ids = [];
  const re = /(?:path|src):\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(block))) ids.push(m[1].split("/").pop().replace(/\.mtlx$/i, ""));
  return ids;
}

/** The id set --prune-ids-auto keeps: exampleCatalog.js's destNames union
 * MTLX_PRESETS' ids, so the .vsix's preset picker (manifest mode) never
 * lists fewer materials than either its own fallback (no manifest) or the
 * full web manifest would. */
async function autoPruneIds() {
  const { getCatalog } = require(path.join(REPO_ROOT, "vscode_extension", "src", "exampleCatalog.js"));
  const catalogIds = getCatalog().map((e) => e.destName);
  const presetIds = await mtlxPresetGalleryIds();
  return [...new Set([...catalogIds, ...presetIds])];
}

/** Races `promise` against a timeout, rejecting with a labeled error if
 * the timeout wins. Never leaves a dangling timer. */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms capturing "${label}"`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Downloads thumbnails whose fingerprint matches the already-published
 * manifest, and returns the materials that still need rendering. Never
 * throws: an unreachable or absent previous deploy just means capturing
 * everything, which is what the very first release does anyway. */
async function reusePublished(reuseFrom, materials, outDir) {
  const reused = [];
  let prev = null;
  try {
    const res = await fetch(`${reuseFrom}/gallery/manifest.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    prev = await res.json();
  } catch (err) {
    log(`reuse: no usable manifest at ${reuseFrom} (${String((err && err.message) || err)}); rendering everything.`);
    return { reused, remaining: materials };
  }

  const prevHash = new Map((prev.materials || []).map((m) => [m.id, m.hash]));
  const remaining = [];
  for (const m of materials) {
    if (!m.hash || prevHash.get(m.id) !== m.hash) {
      remaining.push(m);
      continue;
    }
    try {
      const res = await fetch(`${reuseFrom}/gallery/thumbs/${m.id}.jpg`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0) throw new Error("empty body");
      await writeFile(path.join(outDir, "thumbs", `${m.id}.jpg`), buf);
      reused.push(m.id);
    } catch (err) {
      remaining.push(m); // published tile missing or corrupt: render it again
    }
  }
  log(`reuse: ${reused.length} unchanged thumbnail(s) downloaded, ${remaining.length} to render.`);
  return { reused, remaining };
}

function docUrlFor(baseURL, material) {
  return material.origin === "materialx" ? `${baseURL}/vendor/materialx/${material.docPath}` : `${baseURL}/${material.docPath}`;
}

/** Opens the harness on a fresh page, mounts one eager <materialx-viewer>
 * pointed at the material's document, waits for mtlx-ready plus a settle
 * window, then screenshots the element to <out>/thumbs/<id>.jpg. */
async function captureOne(context, baseURL, outDir, material) {
  const page = await context.newPage();
  try {
    await page.goto(`${baseURL}${HARNESS_PATH}`);
    const idx = await page.evaluate(
      (attrs) => window.createViewer(attrs),
      {
        eager: true,
        src: docUrlFor(baseURL, material),
        geometry: "shaderball-scene",
        controls: "none",
        style: "width:512px;height:512px;display:block;",
      }
    );
    await page.waitForFunction(
      (i) => window.__viewers[i].__events.some((e) => e.type === "mtlx-ready"),
      idx,
      { timeout: READY_WAIT_TIMEOUT_MS }
    );
    await page.waitForTimeout(SETTLE_WAIT_MS);
    const handle = await page.evaluateHandle((i) => window.__viewers[i], idx);
    const element = handle.asElement();
    if (!element) throw new Error("viewer element handle not found");
    // A page clip, not element.screenshot(): the element variant waits for
    // the box to hold still across two animation frames, and a SwiftShader
    // render loop stretches those frames past the 30s cap on a GPU-less CI runner.
    const box = await element.boundingBox();
    if (!box) throw new Error("viewer element has no layout box");
    await page.screenshot({ type: "jpeg", quality: 80, clip: box, timeout: SCREENSHOT_TIMEOUT_MS, path: path.join(outDir, "thumbs", `${material.id}.jpg`) });
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const { manifestPath, outDir, limit, only, jobs, reuseFrom, reuseOnly, pruneIds, pruneIdsAuto } = parseArgs(process.argv.slice(2));

  if (pruneIds || pruneIdsAuto) {
    const ids = pruneIdsAuto ? await autoPruneIds() : pruneIds;
    await pruneGallery(manifestPath, outDir, ids);
    return;
  }

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  let materials = manifest.materials;
  if (only) materials = materials.filter((m) => m.id === only);
  else if (limit != null && Number.isFinite(limit)) materials = materials.slice(0, limit);

  if (materials.length === 0) {
    console.error("error: no materials selected (check --only/--limit against " + manifestPath + ")");
    process.exit(1);
  }

  await mkdir(path.join(outDir, "thumbs"), { recursive: true });

  const overallStarted = Date.now();
  let reusedCount = 0;
  if (reuseFrom) {
    const { reused, remaining } = await reusePublished(reuseFrom, materials, outDir);
    reusedCount = reused.length;
    materials = remaining;
    if (materials.length === 0) {
      log(`gallery thumbnails: ${reusedCount} reused, 0 rendered. Nothing changed.`);
      return; // no browser, no server: the whole point of reusing
    }
    if (reuseOnly) {
      // Not an error: a material published after the last deploy simply has
      // no tile yet, and the gallery renders a placeholder for it.
      log(`gallery thumbnails: ${reusedCount} reused, ${materials.length} left unrendered (--reuse-only).`);
      for (const m of materials) log(`  no published tile: ${m.id}`);
      return;
    }
  }
  if (reuseOnly) {
    console.error("error: --reuse-only requires --reuse-from");
    process.exit(1);
  }

  const { baseURL, close } = await startServer({ root: REPO_ROOT });
  const browser = await chromium.launch({
    headless: true,
    // Chromium's default /dev/shm is 64MB under Docker, which surfaces as
    // "Target crashed" mid-screenshot. Harmless outside a container.
    args: ["--disable-dev-shm-usage"],
  });
  const ok = [];
  const failed = [];
  const started = Date.now();

  // Shared cursor rather than fixed slices: materials vary from ~7s to
  // ~25s, so a static split would leave workers idle at the tail.
  let cursor = 0;
  const workerCount = Math.min(jobs, materials.length);

  async function runWorker() {
    const context = await browser.newContext();
    try {
      for (;;) {
        const index = cursor++;
        if (index >= materials.length) break;
        const material = materials[index];
        log(`capturing ${material.id} ...`);

        let lastErr = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          try {
            await withTimeout(captureOne(context, baseURL, outDir, material), PER_MATERIAL_TIMEOUT_BASE_MS * workerCount, material.id);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            if (attempt < MAX_ATTEMPTS) {
              console.error(`  retry ${attempt}/${MAX_ATTEMPTS - 1} for ${material.id}: ${String((err && err.message) || err)}`);
            }
          }
        }

        if (lastErr) {
          const msg = String((lastErr && lastErr.message) || lastErr);
          failed.push({ id: material.id, message: msg });
          console.error(`  failed: ${material.id}: ${msg}`);
        } else {
          ok.push(material.id);
        }
      }
    } finally {
      await context.close().catch(() => {});
    }
  }

  try {
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  } finally {
    await browser.close().catch(() => {});
    await close().catch(() => {});
  }

  const elapsed = (Date.now() - started) / 1000;
  log("");
  log(`gallery thumbnails: ${ok.length} ok, ${failed.length} failed (of ${materials.length} rendered)${reusedCount ? `, ${reusedCount} reused` : ""}.`);
  log(`elapsed ${elapsed.toFixed(1)}s with ${workerCount} worker(s), ${(elapsed / materials.length).toFixed(2)}s per rendered material.`);
  if (reusedCount) log(`total including reuse: ${((Date.now() - overallStarted) / 1000).toFixed(1)}s`);
  if (failed.length > 0) {
    log("failed: " + failed.map((f) => f.id).join(", "));
    // A partial run must fail the build: in CI the output directory is
    // fresh, so a missing tile would ship as a placeholder with a green check.
    process.exit(1);
  }
}

await main();
