#!/usr/bin/env node
// scripts/gallery-shots.mjs
//
// Headless thumbnail capture for the material gallery: reads
// gallery/manifest.json, drives the repo's pinned Playwright chromium
// against tests/embed/fixtures/harness.html (the same idiom
// tests/embed/lib/test-base.mjs uses), and screenshots one <materialx-
// viewer> per material into <out>/thumbs/<id>.jpg.
//
// Usage: node scripts/gallery-shots.mjs [--manifest <path>] [--out <dir>]
//                                       [--limit N] [--only <id>]

import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { startServer } from "../tests/embed/lib/server.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const HARNESS_PATH = "/tests/embed/fixtures/harness.html";
const PER_MATERIAL_TIMEOUT_MS = 60000;
const READY_WAIT_TIMEOUT_MS = 45000;
const SETTLE_WAIT_MS = 1500;

function log(...args) {
  console.log(...args);
}

function parseArgs(argv) {
  let manifestPath = path.join(REPO_ROOT, "gallery", "manifest.json");
  let outDir = path.join(REPO_ROOT, "gallery");
  let limit = null;
  let only = null;
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
    }
  }
  return { manifestPath, outDir, limit, only };
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
        geometry: "shaderball",
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
  const { manifestPath, outDir, limit, only } = parseArgs(process.argv.slice(2));

  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  let materials = manifest.materials;
  if (only) materials = materials.filter((m) => m.id === only);
  else if (limit != null && Number.isFinite(limit)) materials = materials.slice(0, limit);

  if (materials.length === 0) {
    console.error("error: no materials selected (check --only/--limit against " + manifestPath + ")");
    process.exit(1);
  }

  await mkdir(path.join(outDir, "thumbs"), { recursive: true });

  const { baseURL, close } = await startServer({ root: REPO_ROOT });
  const browser = await chromium.launch({ headless: true });
  const ok = [];
  const failed = [];

  try {
    const context = await browser.newContext();
    for (const material of materials) {
      log(`capturing ${material.id} ...`);
      try {
        await withTimeout(captureOne(context, baseURL, outDir, material), PER_MATERIAL_TIMEOUT_MS, material.id);
        ok.push(material.id);
      } catch (err) {
        failed.push({ id: material.id, message: String((err && err.message) || err) });
        console.error(`  failed: ${material.id}: ${String((err && err.message) || err)}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await close().catch(() => {});
  }

  log("");
  log(`gallery thumbnails: ${ok.length} ok, ${failed.length} failed (of ${materials.length}).`);
  if (failed.length > 0) {
    log("failed: " + failed.map((f) => f.id).join(", "));
  }
  if (ok.length === 0) process.exit(1);
}

await main();
