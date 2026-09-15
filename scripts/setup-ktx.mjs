#!/usr/bin/env node
// scripts/setup-ktx.mjs
//
// Downloads the pinned KTX-Software v4.4.2 release asset for the current
// platform, verifies its sha256 against a pinned table, and installs it
// into tools/ktx/ so scripts/cook-textures.mjs can shell out to toktx.
//
// Usage: node scripts/setup-ktx.mjs

import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const VERSION = "4.4.2";
const TOOLS_DIR = path.join(REPO_ROOT, "tools", "ktx");
const DOWNLOAD_DIR = path.join(TOOLS_DIR, "download");

// sha256 of each release asset, computed once after downloading it from
// https://github.com/KhronosGroup/KTX-Software/releases/download/v4.4.2/.
// The release only publishes .sha1 for some assets, so these are pinned
// here ourselves. Only the Windows x64 asset has been verified on this
// machine; the rest are recorded from a first download but untested here.
const ASSETS = {
  "win32-x64": {
    file: `KTX-Software-${VERSION}-Windows-x64.exe`,
    sha256: "1f323b0fec19794f5e6c0425a61d4b1da396872a10be862d105f4f4b2d2957fe",
  },
  "win32-arm64": {
    file: `KTX-Software-${VERSION}-Windows-arm64.exe`,
    sha256: null, // not yet downloaded/pinned on this machine
  },
  "linux-x64": {
    file: `KTX-Software-${VERSION}-Linux-x86_64.tar.bz2`,
    sha256: null,
  },
  "linux-arm64": {
    file: `KTX-Software-${VERSION}-Linux-arm64.tar.bz2`,
    sha256: null,
  },
  "darwin-arm64": {
    file: `KTX-Software-${VERSION}-Darwin-arm64.pkg`,
    sha256: null,
  },
  "darwin-x64": {
    file: `KTX-Software-${VERSION}-Darwin-x86_64.pkg`,
    sha256: null,
  },
};

function assetKey() {
  const plat = process.platform;
  const arch = process.arch;
  if (plat === "win32") return arch === "arm64" ? "win32-arm64" : "win32-x64";
  if (plat === "linux") return arch === "arm64" ? "linux-arm64" : "linux-x64";
  if (plat === "darwin") return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  throw new Error(`unsupported platform: ${plat}/${arch}`);
}

async function sha256File(filePath) {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

async function downloadAsset(asset) {
  await mkdir(DOWNLOAD_DIR, { recursive: true });
  const dest = path.join(DOWNLOAD_DIR, asset.file);
  if (existsSync(dest)) {
    const actual = await sha256File(dest);
    if (!asset.sha256 || actual === asset.sha256) {
      console.log(`already downloaded and verified: ${asset.file}`);
      return dest;
    }
    console.log(`existing ${asset.file} hash mismatch, re-downloading`);
    await rm(dest);
  }

  const url = `https://github.com/KhronosGroup/KTX-Software/releases/download/v${VERSION}/${asset.file}`;
  console.log(`downloading ${url} ...`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  await pipeline(res.body, createWriteStream(dest));

  const actual = await sha256File(dest);
  if (asset.sha256 && actual !== asset.sha256) {
    throw new Error(`sha256 mismatch for ${asset.file}: expected ${asset.sha256}, got ${actual}`);
  }
  if (!asset.sha256) {
    console.log(`note: no pinned hash for ${asset.file} yet; computed sha256: ${actual}`);
  }
  return dest;
}

function toktxPath() {
  return process.platform === "win32" ? path.join(TOOLS_DIR, "bin", "toktx.exe") : path.join(TOOLS_DIR, "bin", "toktx");
}

async function installWindows(exePath) {
  if (existsSync(toktxPath())) {
    console.log("toktx already installed, skipping install step.");
    return;
  }
  await mkdir(TOOLS_DIR, { recursive: true });

  // NSIS silent install. The /D= flag must be the last argument, unquoted,
  // and use an absolute path per NSIS rules.
  console.log(`running silent installer into ${TOOLS_DIR} ...`);
  const result = spawnSync(exePath, ["/S", `/D=${TOOLS_DIR}`], { stdio: "inherit" });

  if (!existsSync(toktxPath())) {
    console.warn("silent install did not produce tools/ktx/bin/toktx.exe.");
    console.warn(`installer exit status: ${JSON.stringify({ status: result.status, error: result.error && String(result.error) })}`);
    console.warn("this NSIS installer appears to require elevation (UAC) even with /S, which cannot be approved headlessly.");

    const sevenZip = spawnSync(process.platform === "win32" ? "where" : "which", ["7z"], { encoding: "utf8" });
    if (sevenZip.status === 0 && sevenZip.stdout.trim()) {
      console.log("7z found on PATH, falling back to archive extraction ...");
      const extractDir = path.join(TOOLS_DIR, "_7z-extract");
      await mkdir(extractDir, { recursive: true });
      const ex = spawnSync("7z", ["x", "-y", `-o${extractDir}`, exePath], { stdio: "inherit" });
      if (ex.status !== 0 || !existsSync(toktxPath())) {
        throw new Error("7z extraction did not produce tools/ktx/bin/toktx.exe either; stopping per instructions.");
      }
      return;
    }
    throw new Error("7z not found on PATH and the silent installer requires elevation; stopping per instructions.");
  }
}

async function installLinux(tarPath) {
  if (existsSync(toktxPath())) {
    console.log("toktx already installed, skipping install step.");
    return;
  }
  await mkdir(TOOLS_DIR, { recursive: true });
  const result = spawnSync("tar", ["xjf", tarPath, "-C", TOOLS_DIR, "--strip-components=1"], { stdio: "inherit" });
  if (result.status !== 0 || !existsSync(toktxPath())) {
    throw new Error("tar extraction did not produce tools/ktx/bin/toktx.");
  }
}

async function installMac(pkgPath) {
  // Untested on this machine (Windows host). Implemented per spec:
  // pkgutil --expand-full extracts the flat package payload without
  // requiring root, unlike `installer -pkg`.
  if (existsSync(toktxPath())) {
    console.log("toktx already installed, skipping install step.");
    return;
  }
  await mkdir(TOOLS_DIR, { recursive: true });
  const result = spawnSync("pkgutil", ["--expand-full", pkgPath, TOOLS_DIR], { stdio: "inherit" });
  if (result.status !== 0 || !existsSync(toktxPath())) {
    console.warn("pkgutil expansion did not produce tools/ktx/bin/toktx; this path is UNTESTED, payload layout inside the .pkg may need adjusting (e.g. a nested Payload~ + bin/ prefix).");
    throw new Error("macOS install failed or produced an unexpected layout.");
  }
}

async function main() {
  const key = assetKey();
  const asset = ASSETS[key];
  if (!asset) throw new Error(`no asset configured for platform key ${key}`);

  const downloaded = await downloadAsset(asset);

  if (key.startsWith("win32")) await installWindows(downloaded);
  else if (key.startsWith("linux")) await installLinux(downloaded);
  else await installMac(downloaded);

  if (!existsSync(toktxPath())) {
    console.error("setup-ktx: toktx is still not present after install; see warnings above.");
    process.exit(1);
  }

  const ver = spawnSync(toktxPath(), ["--version"], { encoding: "utf8" });
  console.log((ver.stdout || ver.stderr || "").trim());
  console.log(`toktx ready at ${toktxPath()}`);
}

main().catch((err) => {
  console.error(`setup-ktx: ${err.message}`);
  process.exit(1);
});
