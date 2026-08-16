# How this repo is built

The repo follows a **committed-artifact model**: every generated file is checked in, so *consumers* (a fresh clone, the deployed site, the VS Code extension) never run a build — only *contributors who change an input* do, and CI proves the two never drift. The invariant is:

> The committed tree is always the complete, runnable artifact. `npm run build` regenerates all derived state byte-for-byte, and `npm run check` (also run in CI) fails if anything has drifted.

## Build steps

`npm run build` runs `scripts/build.mjs`, which sequences seven steps — each also available individually, and each with a read-only `--check` mode:

**1. `version` (`scripts/extract-mtlx-version.mjs`)** — the MaterialX version is never hand-typed anywhere in this repo. This step instantiates the vendored WebAssembly module under Node, calls its `getVersionString()`, and writes the result to `js/gen/mtlx-version.json` (`{version, tag, versionIntegers}`). It then *stamps* the few places that need the value as a literal (the header badge fallback in `js/site-header.js`, `js/mtlx-assets.js`, and two lines in the README/docs — which is why those version strings must not be edited by hand). Node-side consumers (`scripts/vendor.mjs`, the VS Code extension's `specDocs.js`) read the JSON directly. Swapping in a new WASM build and running `npm run build` propagates the new version everywhere; `--check` re-extracts from the WASM and fails on any disagreement.

**2. `versions` (verify-only; `scripts/fetch-mtlx-versions.mjs`)** — never downloads anything as part of `npm run build`. In `--check` mode (i.e. `npm run check`) it verifies the on-disk byte size of every non-default MaterialX version directory (`js/materialx/<version>/`) that happens to be present, against the pins in `scripts/lib/mtlx-versions.mjs` — an entirely absent directory is treated as valid, so a plain clone that never fetched anything still passes. To actually populate a non-default version, run `npm run vendor:versions` explicitly: it downloads that version's release zip from the upstream MaterialX repo, verifies the zip's sha256 against the pin, unzips just the three GenShader files, and writes them to `js/materialx/<version>/`. See the WASM modules entry below for which version is committed to git.

**3. `vendor` (`scripts/vendor.mjs`)** — collects the third-party runtime libraries from `node_modules` (versions pinned in `package.json` devDependencies) into the committed `vendor/` folder, along with each package's license file, and records every file's sha256 in `vendor/vendor-manifest.json`. The one direct download is the Tailwind Play build (plus its license), fetched by URL and verified against a pinned sha256. `npm run vendor:offline` (or `--with-materialx`) additionally snapshots MaterialX spec/example/texture content into `vendor/materialx/` — gitignored, produced on demand — via a shallow sparse git clone of the MaterialX repo at the pinned tag (anonymous git, no GitHub API calls, so it can't hit API rate limits in CI); its presence flips the app (and the nodelib build below) into fully offline, zero-network operation. `--check` verifies the manifest's path set and hashes against both the on-disk files and the current `node_modules` sources.

**4. `nodelib` (`scripts/build-nodelib.mjs`)** — pre-parses the entire node-library documentation dataset so the docs view never has to. Under Node it instantiates the MaterialX WASM once, loads the standard libraries, fetches and parses the three specification markdown files (from `vendor/materialx/` when present, otherwise from GitHub at the pinned tag), and walks every nodedef, implementation, and nodegraph to produce two committed files:

- `js/gen/nodelib.json` — per-node spec prose and port tables (descriptions, notes, references, spec permalinks), joined from the parsed specification and the nodedef walk.
- `js/gen/nodelib-index.json` — per-node signature groups (types, versions, defaults), auto-generated port tables for undocumented nodes, fallback port listings, and the implementation-target matrix (including target inheritance), plus the global target list.

The docs view fetches these two JSONs instead of parsing anything live — browsing the node library is fully WASM-free (the ~3.7 MB engine now loads only if 3D previews are enabled). Generation is deterministic (stable serialization, no timestamps) and finishes with sanity assertions (node counts, schema shape, spot-checks like `standard_surface`'s signatures); `--check` regenerates both files in memory and fails on any byte difference from the committed copies.

**5. `tutorials` (`scripts/build-tutorials.mjs`)** — builds the MkDocs-based tutorials subsite from `tutorials-src/` into the committed `/tutorials/` directory. This step activates automatically when `tutorials-src/mkdocs.yml` exists in the checkout and is skipped otherwise (the tutorials currently live on a separate branch; requires a pip-installed `mkdocs-material`, pinned in `tutorials-src/requirements.txt`).

**6. `buildid` (`scripts/lib/build-id.mjs`)**: computes a deterministic build id: a 16-hex-char sha256 fingerprint over `index.html` (with its `window.__MTLX_BUILD` token canonicalized to the literal `dev` first, so stamping the computed id back in doesn't change the next run's input), every `js/**.{js,jsx,css,json}` file except `js/gen/build-id.json` itself and everything under `js/materialx/`, and `vendor/vendor-manifest.json`. `js/materialx/` and `vendor/materialx/` are excluded on purpose: `.github/workflows/release.yml` runs `vendor:offline`/`vendor:versions` before `npm run build`, so those directories exist there but not in a plain `deploy.yml` push run, and excluding them is what makes both compute the same id. Every input is read as UTF-8 with a leading BOM stripped and CRLF normalized to LF before hashing, so the id can't depend on which OS produced the checkout. The id is written to `js/gen/build-id.json` and stamped into the `window.__MTLX_BUILD` literal in `index.html`'s embed-mode bootstrap script. `--check` recomputes the id in memory and fails if either committed artifact disagrees. Must run after `version` and `nodelib` (both write files it hashes) and before `webview` (which splices `index.html`, including this step's stamp). A merge conflict on `js/gen/build-id.json` or the `window.__MTLX_BUILD` line in `index.html` can be resolved by taking either side and re-running `npm run build`: both files are fully regenerated from other inputs, so neither side's exact text needs to be preserved.

**7. `webview` (`scripts/build-webview.mjs`)** — regenerates `vscode_extension/media/webview.html` from `index.html`. The VS Code extension's webview needs the exact same `<head>`/`<body>` skeleton as the real site plus a handful of webview-only insertions (a Content-Security-Policy meta tag, a `<base>` tag, a bootstrap `<script>` tag, and a focus-outline CSS rule VS Code's Chromium needs but a real browser doesn't) — this step splices those fragments into a copy of `index.html` at two content-based anchors, so the mirror can never silently drift out of sync with the real site. `--check` fails on any byte difference from the committed file.

## Verification and deployment

`npm run check` runs every step's `--check` without writing anything. CI (`.github/workflows/deploy.yml`) runs on every push and pull request to `main`: it does a clean `npm ci && npm run build`, requires the rebuilt tree to be **byte-identical to the commit** (a stale committed artifact fails the run with instructions to rebuild), then runs `npm run check` — and only after all of that does a push to `main` deploy to GitHub Pages. A broken or stale build never deploys.

## When to run what

| You changed... | Run |
| --- | --- |
| App code (`js/**.jsx`, CSS, HTML) | nothing — reload the browser |
| A pinned dependency version in `package.json` | `npm install && npm run build:vendor` |
| The vendored WASM modules (`js/materialx/<version>/JsMaterialX*`) | `npm run build` (re-extracts the version, re-stamps, regenerates the nodelib data) |
| You want a non-default MaterialX version available locally (e.g. to exercise Compare's multi-version rendering) | `npm run vendor:versions` |
| `libraries/` or anything affecting node docs | `npm run build:nodelib` |
| Tutorial content (`tutorials-src/`) | `npm run build:tutorials` |
| Anything about to be committed under `index.html`, `js/**` (excluding `js/materialx/`), or `vendor/vendor-manifest.json` | `npm run build:buildid` (or `npm run build`), so `js/gen/build-id.json` and index.html's stamp don't go stale |
| `index.html` structure or webview-only fragments (`scripts/build-webview.mjs`) | `npm run build:webview` |
| Not sure | `npm run build` then `npm run check` — it's all idempotent |

## The standard library, spec data, and WASM modules

**`libraries/`** vendors the MaterialX standard library (`stdlib`, `pbrlib`, `bxdf`, `cmlib`, `lights`, `nprlib`, `targets`), which the WASM loads to resolve node definitions, implementations, and target inheritance.

**`js/materialx/<version>/`** holds the MaterialX WebAssembly modules, obtained from the official MaterialX build and committed manually for the default version (license at `js/materialx/LICENSE.txt`). It predates, and is not managed by, `scripts/vendor.mjs`, but `JsMaterialXGenShader.wasm` is the **single source of truth for the MaterialX version**: the build's `version` step extracts it from the module at build time and every other occurrence in the repo is generated or stamped from that (see the `version` step above).

Each version directory holds the complete upstream distribution, all seven files from `MaterialX_JavaScript.zip`, pinned by byte size in `scripts/lib/mtlx-versions.mjs`:

- **`JsMaterialXGenShader*`** (`.js`/`.wasm`/`.data`, v1.39.5) is the only module anything loads. The `.data` is the packed standard library.
- **`JsMaterialXCore.{js,wasm}`** is currently unused. `JsMaterialXGenShader` is a strict superset of it (verified: every symbol in Core is present in GenShader), so Core offers no capability the site does not already have, only a smaller binary. Note it ships **no `.data`**, so it carries no standard library and cannot resolve node definitions on its own.
- **`JsMaterialX{Core,GenShader}-<version>.js`** are byte-identical duplicates of the two unsuffixed `.js` files. They are kept only so each directory mirrors the upstream zip exactly.

Only that default version is committed to git. Every other entry in `scripts/lib/mtlx-versions.mjs` (currently also 1.39.4) is fetched into its own `js/materialx/<version>/` directory on demand by `npm run vendor:versions` — downloaded from the matching upstream GitHub release asset, verified against a pinned sha256, unzipped, and left gitignored (see the `versions` build step above). These extra versions exist solely for the Material Compare view's per-pane version picker; every other consumer (docs, presets, the header version badge) stays pinned to the default.

**`models/`** ships two GLB exports of the ASWF/USD-WG Standard Shader Ball (see [Asset credits](../README.md#asset-credits) in the README, and `models/LICENSE.txt`), committed in-repo — no download step: `shaderball.glb`, the full scene used by the Node Graph Editor's live preview (backdrop, grid, emissive panels, and an embedded camera), and `shaderball_simple.glb`, a plain ball used by the Material Viewer and docs previews. In both, the generated MaterialX material is applied only to the mesh named `material_surface`; every other mesh keeps its authored glTF material.

## Adding or promoting a MaterialX version

`scripts/lib/mtlx-versions.mjs` is hand-maintained (see its header comment). Every entry needs three coordinated manual edits, and missing either ignore line fails silently rather than loudly: it either commits several MB of WASM straight into git, or bloats the packaged `.vsix` with a version the extension never loads.

### Adding a non-default version

1. **Get the numbers — don't guess them.** Download the release zip for the new tag and inspect it:

   ```powershell
   $tag = "v1.39.6"
   Invoke-WebRequest -Uri "https://github.com/AcademySoftwareFoundation/MaterialX/releases/download/$tag/MaterialX_JavaScript.zip" -OutFile mtlx.zip
   (Get-FileHash mtlx.zip -Algorithm SHA256).Hash.ToLower()   # -> zipSha256
   (Get-Item mtlx.zip).Length                                  # -> zipBytes
   Expand-Archive mtlx.zip -DestinationPath mtlx-extracted
   Get-ChildItem -Recurse mtlx-extracted -Filter JsMaterialXGenShader.* | Select-Object Name, Length
   ```

   (`sha256sum mtlx.zip` and `unzip -l mtlx.zip` do the same job on macOS/Linux.) The three `Select-Object` rows are the `files` byte sizes for the GenShader `.js`/`.wasm`/`.data` trio.
2. **Add the entry** to `MTLX_VERSIONS` in `scripts/lib/mtlx-versions.mjs`: `version`, `tag`, `zipSha256`, `zipBytes`, `files`.
3. **Add a line to `.gitignore`**: `js/materialx/<version>/`. Skip this and the fetched build looks like an ordinary new directory to git — a broad `git add` silently stages several MB of WASM.
4. **Add a line to `.vscodeignore`**: `js/materialx/<version>/**`. Skip this and the version ships inside the packaged `.vsix` even though the webview's nav has no Compare view to use it — a silent multi-MB size regression on every release.
5. Run `npm run vendor:versions` to fetch it locally, then `npm run build && npm run check` to confirm everything — including `js/gen/mtlx-versions.json`, the browser-facing mirror of the registry — is clean.

### Promoting a new default

`DEFAULT_MTLX_VERSION` (also in `scripts/lib/mtlx-versions.mjs`) is **computed** as the numeric max across `MTLX_VERSIONS`, never hand-picked. The moment a newer entry is added, it becomes the default, and the `version` build step (`scripts/lib/version.mjs`) immediately tries to load that version's WASM from `js/materialx/<newVersion>/` — so that directory has to actually contain the build in the *same* change, or the build breaks (see the pre-check in Item 2b below for the friendlier error this now gives when it doesn't).

1. Follow steps 1-2 above to add the new version's registry entry (this alone makes it the default).
2. Commit the new default's actual GenShader `.js`/`.wasm`/`.data` files under `js/materialx/<newVersion>/` — fetch them the same way as step 1, or via `npm run vendor:versions` before it becomes the default — then `git add` the directory. If it already had `.gitignore`/`.vscodeignore` lines from being a non-default version, remove those lines now; the new default must be committed.
3. The version that was previously default is no longer committed — add its `js/materialx/<oldVersion>/` line to both `.gitignore` and `.vscodeignore` (step 3/4 above), then untrack the directory that's still sitting in the working tree: `git rm -r --cached js/materialx/<oldVersion>/`.
4. Run `npm run build` — this re-extracts the version from the new default's WASM and re-stamps every literal copy (the header badge, `js/mtlx-assets.js`, `js/site-header.js`, `js/mtlx-engine.js`, and the WASM modules note above) — then `npm run check` to confirm the tree is clean.
