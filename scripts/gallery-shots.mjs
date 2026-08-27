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
//                                       [--reuse-from <site base url>]
//
// --reuse-from makes a deploy incremental: it reads the manifest already
// published at that site and re-downloads every thumbnail whose material
// fingerprint is unchanged, so only new or edited materials get rendered.
// Rendering is CPU-bound software rasterization on a GPU-less runner
// (~13s each), so NOT rendering is worth far more than rendering faster.
// Any failure falls back to a full capture: slow, never wrong.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startServer } from "../tests/embed/lib/server.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const HARNESS_PATH = "/tests/embed/fixtures/harness.html";
// Scaled by --jobs below: N workers sharing the CPU inflate each
// capture roughly N-fold, and a fixed 60s budget turns that into mass
// timeouts rather than a slower-but-correct run.
const PER_MATERIAL_TIMEOUT_BASE_MS = 60000;
const READY_WAIT_TIMEOUT_MS = 45000;
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
    }
  }
  return { manifestPath, outDir, limit, only, jobs, reuseFrom };
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
    await element.screenshot({ type: "jpeg", quality: 80, path: path.join(outDir, "thumbs", `${material.id}.jpg`) });
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const { manifestPath, outDir, limit, only, jobs, reuseFrom } = parseArgs(process.argv.slice(2));

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
