// Single source of truth for the vsce version CI installs and packages
// with: read from the locked .github/vsce/package.json so it can never
// drift from the lockfile actually used to install it.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const VSCE_PACKAGE_JSON = path.join(REPO_ROOT, ".github", "vsce", "package.json");

const pkg = JSON.parse(readFileSync(VSCE_PACKAGE_JSON, "utf8"));
const version = pkg.dependencies && pkg.dependencies["@vscode/vsce"];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(
    `.github/vsce/package.json's "@vscode/vsce" dependency ("${version}") is not an exact X.Y.Z version.`
  );
}

export const VSCE_VERSION = version;
