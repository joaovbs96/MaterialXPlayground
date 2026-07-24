#!/usr/bin/env node
// scripts/build.mjs
//
// Single build orchestrator: the one entry point CI (and humans) call to
// (re)generate every derived/committed artifact in this repo, and to verify
// none of them have drifted. Wraps the individual scripts under scripts/ —
// it does not duplicate their logic, just sequences them.
//
// Usage:
//   node scripts/build.mjs                      = `node scripts/build.mjs all`
//   node scripts/build.mjs [step] [--check] [--with-materialx]
//
//     step: all | version | stamp | vendor | nodelib | tutorials | webview
//           (default: all)
//     --check          verify every step is up to date WITHOUT writing
//                       anything; non-zero exit on any drift. Wired into
//                       `npm run check`.
//     --with-materialx only meaningful for the `vendor`/`all` steps — also
//                       populates vendor/materialx/ (see scripts/vendor.mjs).
//
// Step order (for `all`): version -> vendor -> nodelib -> tutorials -> webview.
// version runs first because every other step derives from the
// WASM-extracted MaterialX version: vendor's MTLX_TAG (--with-materialx)
// and nodelib's spec-tag/version stamp both read js/gen/mtlx-version.json,
// which the version step (re)generates. Running anything else first risks
// building against a stale version file. webview runs last: it derives
// only from index.html (see scripts/build-webview.mjs), nothing downstream
// depends on it.
//
// The `stamp` step (re-stamp every literal copy of the MaterialX tag across
// the repo — see scripts/lib/version.mjs) is a step in its own right here
// for ad-hoc use (`node scripts/build.mjs stamp`), but `all` does NOT run it
// as a separate step: `node scripts/extract-mtlx-version.mjs` (the `version`
// step's default-mode entry point) already extracts the version AND stamps
// every dependent literal in one call, so re-stamping again right after
// would just be redundant work against the same already-fresh meta.
//
// tutorials auto-activates the moment scripts/build-tutorials.mjs and
// tutorials-src/mkdocs.yml exist (today they live on a separate branch — see
// .github/workflows/deploy.yml's header comment). Until that branch merges,
// this step is a harmless, always-succeeding no-op here so `npm run build`
// and `npm run check` never fail on a fresh `main` checkout.
//
// CI (.github/workflows/deploy.yml) calls `npm run build` then verifies the
// working tree is clean (a stale committed artifact would show up as a
// diff), then `npm run check` (the same drift checks, but read-only and
// re-derived from source rather than relying on `git diff`).

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

const VALID_STEPS = ["all", "version", "stamp", "vendor", "nodelib", "tutorials", "webview"];
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

/** Run `node <scriptPath> [...extraArgs]` with stdio inherited, treating both
 * a spawn error (e.g. the binary couldn't be launched) and a non-zero exit
 * status as failure of `stepName`. Never returns on failure — exits the
 * process immediately so a failed step can't let a later step run. */
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
    // version first — everything else derives from the WASM-extracted
    // version (see header comment). `stamp` is deliberately NOT run as a
    // separate step here: the version step's own default mode (extract +
    // stampAll) already re-stamps every literal, so a follow-up stamp step
    // would just redo the same work against the same fresh meta.
    await runVersionStep();
    await runVendorStep();
    await runNodelibStep();
    await runTutorialsStep();
    await runWebviewStep();
  } else if (STEP === "version") {
    await runVersionStep();
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
