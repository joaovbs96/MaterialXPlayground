#!/usr/bin/env node
// scripts/build.mjs — CI/human entry point that (re)generates every
// derived/committed artifact in this repo and verifies none drifted.
//
// Usage: node scripts/build.mjs [step] [--check] [--with-materialx]
//   step: all | version | versions | stamp | vendor | nodelib | tutorials | webview
//
// Order for `all`: version -> versions -> vendor -> nodelib -> tutorials -> webview.
// version runs first: vendor/nodelib read js/gen/mtlx-version.json.
//
// `versions` is the non-default MaterialX WASM builds (js/materialx/<v>/
// for every entry in scripts/lib/mtlx-versions.mjs other than the
// committed default) — NEVER fetched here, only verified. Downloads only
// ever happen via the explicit `npm run vendor:versions` (which CI calls
// separately); see scripts/fetch-mtlx-versions.mjs.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readVersionMeta, stampAll, checkStamps } from "./lib/version.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const CHECK_MODE = argv.includes("--check");
const WITH_MATERIALX = argv.includes("--with-materialx");
const STEP = argv.find((a) => !a.startsWith("--")) || "all";

const VALID_STEPS = ["all", "version", "versions", "stamp", "vendor", "nodelib", "tutorials", "webview"];
if (!VALID_STEPS.includes(STEP)) {
  console.error(`error: unknown step "${STEP}" — expected one of: ${VALID_STEPS.join(", ")}`);
  process.exit(1);
}

const BUILD_TUTORIALS_PATH = path.join(REPO_ROOT, "scripts", "build-tutorials.mjs");
const TUTORIALS_MKDOCS_PATH = path.join(REPO_ROOT, "tutorials-src", "mkdocs.yml");

function log(...args) {
  console.log("[build]", ...args);
}

function failStep(stepName, detail) {
  console.error(`[build] step "${stepName}" failed${detail ? `: ${detail}` : ""}`);
  process.exit(1);
}

/** Runs `node <scriptPath> [...extraArgs]` with stdio inherited. A spawn
 * error or non-zero exit fails `stepName` and exits immediately, so a
 * failed step can't let a later step run. */
function runNodeScript(stepName, scriptPath, extraArgs = []) {
  const result = spawnSync(process.execPath, [scriptPath, ...extraArgs], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.error) {
    failStep(stepName, result.error.message);
  }
  if (result.status !== 0) {
    failStep(stepName, `exit code ${result.status}`);
  }
}

async function runVersionStep() {
  log(`version: extracting MaterialX version from vendored WASM${CHECK_MODE ? " (--check)" : ""} ...`);
  runNodeScript(
    "version",
    path.join(REPO_ROOT, "scripts", "extract-mtlx-version.mjs"),
    CHECK_MODE ? ["--check"] : []
  );
}

/** Never downloads (see header comment) — in normal mode this is a
 * no-op; in --check mode it verifies on-disk byte sizes for whichever
 * non-default versions happen to be present, treating absence as valid. */
async function runVersionsStep() {
  if (!CHECK_MODE) {
    log("versions: skipped — non-default MaterialX WASM builds are fetched only via `npm run vendor:versions`, never by `npm run build`.");
    return;
  }
  log("versions: verifying non-default MaterialX WASM builds (js/materialx/<version>/) (--check) ...");
  try {
    const { runCheck } = await import("./fetch-mtlx-versions.mjs");
    await runCheck();
  } catch (err) {
    failStep("versions", err.message);
  }
}

async function runStampStep() {
  log(`stamp: ${CHECK_MODE ? "verifying" : "applying"} MaterialX version literals ...`);
  let meta;
  try {
    meta = await readVersionMeta();
  } catch (err) {
    failStep("stamp", err.message);
  }
  if (CHECK_MODE) {
    const problems = await checkStamps(meta);
    if (problems.length > 0) {
      failStep("stamp", ["version literals out of sync:", ...problems.map((p) => `  - ${p}`)].join("\n"));
    }
  } else {
    await stampAll(meta);
  }
}

async function runVendorStep() {
  const { runCollect, runCheck, runMaterialx } = await import("./vendor.mjs");
  log(`vendor: ${CHECK_MODE ? "checking" : "collecting"} vendored third-party assets${WITH_MATERIALX ? " (--with-materialx)" : ""} ...`);
  try {
    if (CHECK_MODE) {
      await runCheck();
    } else {
      await runCollect();
      if (WITH_MATERIALX) {
        await runMaterialx();
      }
    }
  } catch (err) {
    failStep("vendor", err.message);
  }
}

async function runNodelibStep() {
  log(`nodelib: ${CHECK_MODE ? "verifying" : "generating"} js/gen/nodelib.json + nodelib-index.json ...`);
  runNodeScript(
    "nodelib",
    path.join(REPO_ROOT, "scripts", "build-nodelib.mjs"),
    CHECK_MODE ? ["--check"] : []
  );
}

async function runTutorialsStep() {
  const active = existsSync(BUILD_TUTORIALS_PATH) && existsSync(TUTORIALS_MKDOCS_PATH);
  if (!active) {
    log("tutorials: skipped (tutorials-src/mkdocs.yml not present)");
    return;
  }
  log(`tutorials: ${CHECK_MODE ? "verifying" : "building"} tutorials subsite ...`);
  runNodeScript("tutorials", BUILD_TUTORIALS_PATH, CHECK_MODE ? ["--check"] : []);
}

async function runWebviewStep() {
  log(`webview: ${CHECK_MODE ? "verifying" : "generating"} vscode_extension/media/webview.html from index.html ...`);
  runNodeScript(
    "webview",
    path.join(REPO_ROOT, "scripts", "build-webview.mjs"),
    CHECK_MODE ? ["--check"] : []
  );
}

async function main() {
  if (STEP === "all") {
    // version first — everything else derives from it (see header comment).
    // `stamp` isn't run separately here: the version step's default mode
    // already re-stamps every literal, so a follow-up stamp step would be redundant.
    await runVersionStep();
    await runVersionsStep();
    await runVendorStep();
    await runNodelibStep();
    await runTutorialsStep();
    await runWebviewStep();
  } else if (STEP === "version") {
    await runVersionStep();
  } else if (STEP === "versions") {
    await runVersionsStep();
  } else if (STEP === "stamp") {
    await runStampStep();
  } else if (STEP === "vendor") {
    await runVendorStep();
  } else if (STEP === "nodelib") {
    await runNodelibStep();
  } else if (STEP === "tutorials") {
    await runTutorialsStep();
  } else if (STEP === "webview") {
    await runWebviewStep();
  }

  log(`${STEP}${CHECK_MODE ? " --check" : ""}: OK`);
}

await main();
