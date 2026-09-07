#!/usr/bin/env node
// scripts/cook-textures.mjs
//
// Converts every texture in a folder (recursively) to a .ktx2 sibling next
// to it. Skips .tx/.tex/.ktx2 sources and any source whose .ktx2 sibling
// already exists (unless --force). Never overwrites an existing .ktx2.
//
// Usage: node scripts/cook-textures.mjs <folder> [--quality fast|default|high] [--jobs N] [--dry-run] [--force]
//
// Decoders: no "sharp" devDependency is installed, so decoding runs inside
// a headless Chromium page (via the already-vendored @playwright/test
// devDependency) using createImageBitmap()+canvas for PNG/JPEG, the
// vendored vendor/three/RGBELoader.js for HDR and node_modules
// three/examples/js/loaders/EXRLoader.js for EXR, and vendor/utif/UTIF.js
// for TIFF (loaded into the same page — all three are plain non-module
// scripts that only need a THREE/UTIF global, not a bundler). This
// reuses the project's existing sanctioned rendering path instead of a
// hand-rolled binary image decoder.
//
// Encoder: the Basis Universal encoder wasm vendored at
// vendor/basis-encoder/basis_encoder.js (see scripts/vendor.mjs DOWNLOADS),
// which runs directly under plain Node (no DOM dependency).

import { readFile, writeFile, readdir, stat, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const SOURCE_EXTS = new Set([".png", ".jpg", ".jpeg", ".tif", ".tiff", ".exr", ".hdr"]);
const SRGB_NAME_HINTS = /(basecolor|albedo|diffuse|color|emissive)/i;

function parseArgs(argv) {
  const args = { folder: null, quality: "default", jobs: 1, dryRun: false, force: false, encoder: "auto" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--quality") args.quality = argv[++i];
    else if (a === "--jobs") args.jobs = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else if (a === "--encoder") args.encoder = argv[++i];
    else if (!args.folder) args.folder = a;
  }
  if (!args.folder || !["auto", "toktx", "basis"].includes(args.encoder)) {
    console.error("usage: node scripts/cook-textures.mjs <folder> [--quality fast|default|high] [--jobs N] [--dry-run] [--force] [--encoder auto|toktx|basis]");
    process.exit(1);
  }
  return args;
}

// Resolves a usable toktx binary: KTX_TOKTX env var, the repo-local install
// from scripts/setup-ktx.mjs, then PATH. Returns null if none is found.
function resolveToktx() {
  if (process.env.KTX_TOKTX && existsSync(process.env.KTX_TOKTX)) return process.env.KTX_TOKTX;

  const local = path.join(REPO_ROOT, "tools", "ktx", "bin", process.platform === "win32" ? "toktx.exe" : "toktx");
  if (existsSync(local)) return local;

  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["toktx"], { encoding: "utf8" });
  if (which.status === 0) {
    const first = which.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first) return first;
  }
  return null;
}

// Maps our fast/default/high knob to toktx's --uastc_quality 1..4 levels.
function qualityToUastcLevel(quality) {
  if (quality === "fast") return 1;
  if (quality === "high") return 4;
  return 2;
}

/** Recursively find source texture files under `dir`, skipping .ktx2 siblings unless --force. */
async function findSources(dir, force) {
  const out = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      // macOS side files (AppleDouble ._x, __MACOSX, .DS_Store) are not textures.
      if (/^(\._|__MACOSX$|\.DS_Store$)/.test(entry.name)) continue;
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!SOURCE_EXTS.has(ext)) continue;
      const stem = abs.slice(0, -ext.length);
      const ktx2Path = `${stem}.ktx2`;
      if (!force && existsSync(ktx2Path)) continue;
      out.push({ srcPath: abs, ktx2Path, ext });
    }
  }
  await walk(dir);
  return out;
}

function qualityToEffort(quality) {
  // BasisEncoder quality level, 1-255 (higher = slower/better). "default"
  // mirrors basisu's own CLI default of 128.
  if (quality === "fast") return 1;
  if (quality === "high") return 255;
  return 128;
}

// ---------------------------------------------------------------------------
// Worker-thread entry point: owns one Chromium page + one Basis encoder
// instance and cooks a static slice of the file list handed to it.
// ---------------------------------------------------------------------------
async function runWorkerSlice({ files, quality, dryRun, encoder, toktxPath }) {
  const results = [];
  if (files.length === 0) return results;
  const useToktx = encoder === "toktx";

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.addScriptTag({ path: path.join(REPO_ROOT, "vendor/three/three.min.js") });
  await page.addScriptTag({ path: path.join(REPO_ROOT, "node_modules/three/examples/js/loaders/RGBELoader.js") });
  // The site's vendored EXRLoader fork needs the fflate global for ZIP and
  // PIZ compressed files; the npm copy has the same requirement, unmet here.
  await page.addScriptTag({ path: path.join(REPO_ROOT, "vendor/three/fflate.min.js") });
  await page.addScriptTag({ path: path.join(REPO_ROOT, "js/vendor/EXRLoader.js") });
  await page.addScriptTag({ path: path.join(REPO_ROOT, "vendor/utif/UTIF.js") });

  // The basis wasm encoder is only needed for the fallback path; skip its
  // (non-trivial) init cost when every file in this slice uses toktx.
  let basis = null;
  if (!useToktx) {
    const basisMod = await import(pathToFileURL(path.join(REPO_ROOT, "vendor/basis-encoder/basis_encoder.js")).href);
    const BASIS = basisMod.default;
    global.self = global.self || global;
    basis = await BASIS();
    basis.initializeBasis();
  }

  const tmpDir = useToktx ? await mkdtemp(path.join(os.tmpdir(), "cook-textures-")) : null;

  for (const file of files) {
    const started = Date.now();
    try {
    const bytes = await readFile(file.srcPath);
    const b64 = bytes.toString("base64");

    const decoded = await page.evaluate(
      async ({ b64, ext, skipCap, needsPngExport: wantsPngExport, useToktx }) => {
        function b64ToBuf(s) {
          const bin = atob(s);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          return arr.buffer;
        }
        const buf = b64ToBuf(b64);

        // Returns rgba as a base64 string, never a plain array: a plain
        // array of a 4096x4096 RGBA buffer (67M numbers) blows Playwright's
        // evaluate() JSON round-trip past a worker's heap limit.
        function bufToB64(u8) {
          let binary = "";
          const chunk = 0x8000;
          for (let i = 0; i < u8.length; i += chunk) binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
          return btoa(binary);
        }

        let width, height, rgba;
        if (ext === ".png" || ext === ".jpg" || ext === ".jpeg") {
          const mime = ext === ".png" ? "image/png" : "image/jpeg";
          const blob = new Blob([buf], { type: mime });
          const bitmap = await createImageBitmap(blob, { imageOrientation: "none", colorSpaceConversion: "none" });
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(bitmap, 0, 0);
          const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
          width = bitmap.width; height = bitmap.height; rgba = img.data;
        } else if (ext === ".tif" || ext === ".tiff") {
          const ifds = UTIF.decode(buf);
          UTIF.decodeImage(buf, ifds[0]);
          width = ifds[0].width; height = ifds[0].height; rgba = UTIF.toRGBA8(ifds[0]);
        } else if (ext === ".hdr") {
          const parsed = new THREE.RGBELoader().parse(buf);
          // parsed.data is Float32Array RGBE->RGB already resolved by the loader (RGB, 3 comps);
          // widen to RGBA8 via a simple Reinhard tonemap so it survives an 8bpc UASTC transcode
          // path the same way our runtime bounded-tier decode already clamps unbounded HDR data.
          const { width: w, height: h, data } = parsed;
          const out = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < w * h; i++) {
            const r = data[i * 3], g = data[i * 3 + 1], b = data[i * 3 + 2];
            out[i * 4] = Math.round((r / (1 + r)) * 255);
            out[i * 4 + 1] = Math.round((g / (1 + g)) * 255);
            out[i * 4 + 2] = Math.round((b / (1 + b)) * 255);
            out[i * 4 + 3] = 255;
          }
          width = w; height = h; rgba = out;
        } else if (ext === ".exr") {
          const parsed = new THREE.EXRLoader().setDataType(THREE.FloatType).parse(buf);
          const { width: w, height: h, data } = parsed;
          const out = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < w * h; i++) {
            const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
            out[i * 4] = Math.round((r / (1 + r)) * 255);
            out[i * 4 + 1] = Math.round((g / (1 + g)) * 255);
            out[i * 4 + 2] = Math.round((b / (1 + b)) * 255);
            out[i * 4 + 3] = Math.round((a ?? 1) * 255);
          }
          width = w; height = h; rgba = out;
        } else {
          throw new Error(`unsupported extension ${ext}`);
        }

        // The vendored basis_encoder.wasm hard-caps total source texels at
        // BASISU_ENCODER_MAX_SOURCE_IMAGE_PIXELS (12,582,912 = 4096x3072):
        // above that, encode() fails silently (returns 0). Box-downscale via
        // canvas to the largest size under the cap that preserves aspect
        // ratio, rather than fail the whole cook for large (e.g. 4096x4096)
        // sources — this only affects the ENCODED .ktx2, never the source.
        const MAX_SOURCE_PIXELS = 12582912;
        let downscaledFrom = null;
        if (!skipCap && width * height > MAX_SOURCE_PIXELS) {
          const scale = Math.sqrt(MAX_SOURCE_PIXELS / (width * height));
          const newW = Math.max(1, Math.floor(width * scale));
          const newH = Math.max(1, Math.floor(height * scale));
          const srcCanvas = document.createElement("canvas");
          srcCanvas.width = width; srcCanvas.height = height;
          srcCanvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
          const dstCanvas = document.createElement("canvas");
          dstCanvas.width = newW; dstCanvas.height = newH;
          const dstCtx = dstCanvas.getContext("2d");
          dstCtx.imageSmoothingQuality = "high";
          dstCtx.drawImage(srcCanvas, 0, 0, width, height, 0, 0, newW, newH);
          downscaledFrom = { width, height };
          rgba = dstCtx.getImageData(0, 0, newW, newH).data;
          width = newW; height = newH;
        }

        // Block-compressed KTX2 requires the base level's width and height
        // to each be a multiple of 4; resize (never pad, that would shift
        // UVs) down to the nearest multiple of 4 that fits inside the
        // source size.
        let resizedFrom = null;
        const mod4W = width - (width % 4);
        const mod4H = height - (height % 4);
        if (mod4W !== width || mod4H !== height) {
          const newW = Math.max(4, mod4W);
          const newH = Math.max(4, mod4H);
          const srcCanvas2 = document.createElement("canvas");
          srcCanvas2.width = width; srcCanvas2.height = height;
          srcCanvas2.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
          const dstCanvas2 = document.createElement("canvas");
          dstCanvas2.width = newW; dstCanvas2.height = newH;
          const dstCtx2 = dstCanvas2.getContext("2d");
          dstCtx2.imageSmoothingQuality = "high";
          dstCtx2.drawImage(srcCanvas2, 0, 0, width, height, 0, 0, newW, newH);
          resizedFrom = { width, height };
          rgba = dstCtx2.getImageData(0, 0, newW, newH).data;
          width = newW; height = newH;
        }

        // For toktx, non-PNG/JPEG sources (TIFF/EXR/HDR) are handed over as
        // a temporary 8-bit PNG rather than raw pixels: toktx reads PNG and
        // JPEG directly and we reuse the same decode path for every format.
        // A PNG/JPEG source that got resized above also needs this export:
        // otherwise toktx would re-read the original (un-resized) file.
        const needsPngExport = wantsPngExport || (useToktx && !!resizedFrom);
        let pngB64 = null;
        if (needsPngExport) {
          const canvas = document.createElement("canvas");
          canvas.width = width; canvas.height = height;
          canvas.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
          const buf = new Uint8Array(await blob.arrayBuffer());
          pngB64 = bufToB64(buf);
        }

        return { width, height, rgbaB64: needsPngExport ? null : bufToB64(rgba), pngB64, downscaledFrom, resizedFrom };
      },
      { b64, ext: file.ext, skipCap: useToktx, useToktx, needsPngExport: useToktx && ![".png", ".jpg", ".jpeg"].includes(file.ext) }
    );

    const { width, height, downscaledFrom, resizedFrom } = decoded;
    if (downscaledFrom) {
      console.log(`  note: ${path.basename(file.srcPath)} is ${downscaledFrom.width}x${downscaledFrom.height} (${downscaledFrom.width * downscaledFrom.height} texels), above the encoder's 12,582,912-texel limit; downscaled to ${width}x${height} for the .ktx2 only`);
    }
    if (resizedFrom) {
      console.log(`  note: ${path.basename(file.srcPath)}: ${resizedFrom.width}x${resizedFrom.height} resized to ${width}x${height} (block compression needs multiples of 4)`);
    }
    const seconds = (Date.now() - started) / 1000;

    if (dryRun) {
      results.push({ file, width, height, seconds, outBytes: 0, dryRun: true });
      continue;
    }

    const isColor = SRGB_NAME_HINTS.test(path.basename(file.srcPath));
    let outBytes;

    if (useToktx) {
      let toktxInput = file.srcPath;
      let tempPng = null;
      if (decoded.pngB64) {
        tempPng = path.join(tmpDir, `${path.basename(file.srcPath)}.png`);
        await writeFile(tempPng, Buffer.from(decoded.pngB64, "base64"));
        toktxInput = tempPng;
        if ([".tif", ".tiff"].includes(file.ext)) {
          console.log(`  note: ${path.basename(file.srcPath)} was written as an 8-bit PNG for toktx (16-bit sources are truncated)`);
        }
      }

      const toktxArgs = [
        "--t2",
        "--encode", "uastc",
        "--uastc_quality", String(qualityToUastcLevel(quality)),
        "--genmipmap",
        "--zcmp", "18",
        "--assign_oetf", isColor ? "srgb" : "linear",
        file.ktx2Path,
        toktxInput,
      ];
      const result = spawnSync(toktxPath, toktxArgs, { encoding: "utf8" });
      if (tempPng) await rm(tempPng, { force: true });
      if (result.status !== 0) {
        throw new Error(`toktx failed for ${file.srcPath}: ${result.stderr || result.stdout}`);
      }
      const st = await stat(file.ktx2Path);
      outBytes = { length: st.size };
    } else {
      const rgba = new Uint8Array(Buffer.from(decoded.rgbaB64, "base64"));
      const enc = new basis.BasisEncoder();
      enc.setSliceSourceImage(0, rgba, width, height, basis.ktx2_supercompression ? 0 : 0);
      enc.setCreateKTX2File(true);
      enc.setUASTC(true);
      enc.setMipGen(true);
      enc.setPerceptual(isColor);
      enc.setKTX2AndBasisSRGBTransferFunc(isColor);
      enc.setYFlip(false);
      enc.setQualityLevel(qualityToEffort(quality));
      enc.setPrintStats(false);
      enc.setDebug(false);
      enc.setStatusOutput(false);

      const outVec = new Uint8Array(width * height * 8 + 1024 * 1024);
      const actualSize = enc.encode(outVec);
      const encoded = Buffer.from(outVec.buffer, outVec.byteOffset, actualSize);
      await writeFile(file.ktx2Path, encoded);
      enc.delete();
      outBytes = encoded;
    }

    const totalSeconds = (Date.now() - started) / 1000;
    results.push({ file, width, height, seconds: totalSeconds, outBytes: outBytes.length, dryRun: false });
    } catch (err) {
      // One bad file must not abort the folder; report it in the summary.
      const firstLine = String(err && err.message ? err.message : err).split(/\r?\n/)[0];
      results.push({ file, error: firstLine, seconds: (Date.now() - started) / 1000 });
    }
  }

  await page.close();
  await browser.close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  return results;
}

// ---------------------------------------------------------------------------
// Worker-thread bootstrap: when spawned as a worker, run the assigned slice
// and post the results back, then exit.
// ---------------------------------------------------------------------------
if (!isMainThread) {
  runWorkerSlice(workerData)
    .then((results) => parentPort.postMessage({ ok: true, results }))
    .catch((err) => parentPort.postMessage({ ok: false, error: String(err && err.stack ? err.stack : err) }));
} else {
  main();
}

function splitEvenly(items, n) {
  const buckets = Array.from({ length: n }, () => []);
  items.forEach((item, i) => buckets[i % n].push(item));
  return buckets.filter((b) => b.length > 0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const folder = path.resolve(args.folder);
  if (!existsSync(folder)) {
    console.error(`error: folder not found: ${folder}`);
    process.exit(1);
  }

  const sources = await findSources(folder, args.force);
  if (sources.length === 0) {
    console.log("no source textures to cook (all up to date, or none found).");
    return;
  }

  const jobs = Math.min(args.jobs, sources.length);
  const slices = splitEvenly(sources, jobs);

  // Resolve the encoder once for the whole run: toktx when requested/found,
  // the wasm fallback otherwise (loudly, since it caps source pixels).
  let encoder = args.encoder;
  let toktxPath = null;
  if (encoder === "toktx" || encoder === "auto") {
    toktxPath = resolveToktx();
    if (toktxPath) {
      encoder = "toktx";
    } else if (encoder === "toktx") {
      console.error("error: --encoder toktx requested but no toktx binary found (KTX_TOKTX, tools/ktx/bin, or PATH). Run `npm run setup:ktx`.");
      process.exit(1);
    } else {
      console.warn("");
      console.warn("WARNING: toktx not found, falling back to the vendored wasm encoder.");
      console.warn("WARNING: the wasm encoder hard-caps source images at 12,582,912 pixels (e.g. 4096x4096 will be downscaled to ~3547x3547).");
      console.warn("WARNING: run `npm run setup:ktx` to install toktx and get true 4096x4096 output.");
      console.warn("");
      encoder = "basis";
    }
  }

  console.log(`cooking ${sources.length} texture(s) from ${folder} with ${slices.length} worker(s), quality=${args.quality}, encoder=${encoder}${args.dryRun ? " (dry run)" : ""} ...`);

  const allResults = [];
  if (slices.length === 1 && jobs === 1) {
    // Run in-process (still through the same code path) to avoid a worker
    // thread's startup cost for the common single-job case.
    const results = await runWorkerSlice({ files: slices[0], quality: args.quality, dryRun: args.dryRun, encoder, toktxPath });
    allResults.push(...results);
  } else {
    const workerPromises = slices.map(
      (slice) =>
        new Promise((resolve, reject) => {
          const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { files: slice, quality: args.quality, dryRun: args.dryRun, encoder, toktxPath } });
          worker.on("message", (msg) => {
            if (msg.ok) resolve(msg.results);
            else reject(new Error(msg.error));
          });
          worker.on("error", reject);
        })
    );
    const perWorkerResults = await Promise.all(workerPromises);
    for (const r of perWorkerResults) allResults.push(...r);
  }

  let totalBytes = 0;
  for (const r of allResults) {
    const rel = path.relative(folder, r.file.srcPath);
    const outRel = path.relative(folder, r.file.ktx2Path);
    if (r.error) {
      console.log(`  [FAILED] ${rel}: ${r.error}`);
    } else if (r.dryRun) {
      console.log(`  [dry-run] ${rel} -> ${outRel}  ${r.width}x${r.height}  ${r.seconds.toFixed(2)}s`);
    } else {
      console.log(`  ${rel} -> ${outRel}  ${r.width}x${r.height}  ${r.seconds.toFixed(2)}s  ${(r.outBytes / 1024).toFixed(1)} KiB`);
      totalBytes += r.outBytes;
    }
  }

  console.log("");
  const failed = allResults.filter((r) => r.error).length;
  if (failed) console.log(`${failed} texture(s) FAILED, see the lines above.`);
  console.log(`done: ${allResults.length - failed} texture(s) cooked${args.dryRun ? " (dry run, nothing written)" : `, ${(totalBytes / (1024 * 1024)).toFixed(2)} MiB total`}.`);
}
