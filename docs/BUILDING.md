# How this repo is built

The repo follows a **committed-artifact model**: every generated file is checked in, so *consumers* (a fresh clone, the deployed site, the VS Code extension) never run a build — only *contributors who change an input* do, and CI proves the two never drift. The invariant is:

> The committed tree is always the complete, runnable artifact. `npm run build` regenerates all derived state byte-for-byte, and `npm run check` (also run in CI) fails if anything has drifted.

## Build steps

`npm run build` runs `scripts/build.mjs`, which sequences five steps — each also available individually, and each with a read-only `--check` mode:

**1. `version` (`scripts/extract-mtlx-version.mjs`)** — the MaterialX version is never hand-typed anywhere in this repo. This step instantiates the vendored WebAssembly module under Node, calls its `getVersionString()`, and writes the result to `js/gen/mtlx-version.json` (`{version, tag, versionIntegers}`). It then *stamps* the few places that need the value as a literal (the header badge fallback in `js/site-header.js`, `js/mtlx-assets.js`, and two lines in the README/docs — which is why those version strings must not be edited by hand). Node-side consumers (`scripts/vendor.mjs`, the VS Code extension's `specDocs.js`) read the JSON directly. Swapping in a new WASM build and running `npm run build` propagates the new version everywhere; `--check` re-extracts from the WASM and fails on any disagreement.

**2. `vendor` (`scripts/vendor.mjs`)** — collects the third-party runtime libraries from `node_modules` (versions pinned in `package.json` devDependencies) into the committed `vendor/` folder, along with each package's license file, and records every file's sha256 in `vendor/vendor-manifest.json`. The one direct download is the Tailwind Play build (plus its license), fetched by URL and verified against a pinned sha256. `npm run vendor:offline` (or `--with-materialx`) additionally snapshots MaterialX spec/example/texture content into `vendor/materialx/` — gitignored, produced on demand — via a shallow sparse git clone of the MaterialX repo at the pinned tag (anonymous git, no GitHub API calls, so it can't hit API rate limits in CI); its presence flips the app (and the nodelib build below) into fully offline, zero-network operation. `--check` verifies the manifest's path set and hashes against both the on-disk files and the current `node_modules` sources.

**3. `nodelib` (`scripts/build-nodelib.mjs`)** — pre-parses the entire node-library documentation dataset so the docs view never has to. Under Node it instantiates the MaterialX WASM once, loads the standard libraries, fetches and parses the three specification markdown files (from `vendor/materialx/` when present, otherwise from GitHub at the pinned tag), and walks every nodedef, implementation, and nodegraph to produce two committed files:

- `js/gen/nodelib.json` — per-node spec prose and port tables (descriptions, notes, references, spec permalinks), joined from the parsed specification and the nodedef walk.
- `js/gen/nodelib-index.json` — per-node signature groups (types, versions, defaults), auto-generated port tables for undocumented nodes, fallback port listings, and the implementation-target matrix (including target inheritance), plus the global target list.

The docs view fetches these two JSONs instead of parsing anything live — browsing the node library is fully WASM-free (the ~3.7 MB engine now loads only if 3D previews are enabled). Generation is deterministic (stable serialization, no timestamps) and finishes with sanity assertions (node counts, schema shape, spot-checks like `standard_surface`'s signatures); `--check` regenerates both files in memory and fails on any byte difference from the committed copies.

**4. `tutorials` (`scripts/build-tutorials.mjs`)** — builds the MkDocs-based tutorials subsite from `tutorials-src/` into the committed `/tutorials/` directory. This step activates automatically when `tutorials-src/mkdocs.yml` exists in the checkout and is skipped otherwise (the tutorials currently live on a separate branch; requires a pip-installed `mkdocs-material`, pinned in `tutorials-src/requirements.txt`).

**5. `webview` (`scripts/build-webview.mjs`)** — regenerates `vscode_extension/media/webview.html` from `index.html`. The VS Code extension's webview needs the exact same `<head>`/`<body>` skeleton as the real site plus a handful of webview-only insertions (a Content-Security-Policy meta tag, a `<base>` tag, a bootstrap `<script>` tag, and a focus-outline CSS rule VS Code's Chromium needs but a real browser doesn't) — this step splices those fragments into a copy of `index.html` at two content-based anchors, so the mirror can never silently drift out of sync with the real site. `--check` fails on any byte difference from the committed file.

## Verification and deployment

`npm run check` runs every step's `--check` without writing anything. CI (`.github/workflows/deploy.yml`) runs on every push and pull request to `main`: it does a clean `npm ci && npm run build`, requires the rebuilt tree to be **byte-identical to the commit** (a stale committed artifact fails the run with instructions to rebuild), then runs `npm run check` — and only after all of that does a push to `main` deploy to GitHub Pages. A broken or stale build never deploys.

## When to run what

| You changed... | Run |
| --- | --- |
| App code (`js/**.jsx`, CSS, HTML) | nothing — reload the browser |
| A pinned dependency version in `package.json` | `npm install && npm run build:vendor` |
| The vendored WASM modules (`js/JsMaterialX*`) | `npm run build` (re-extracts the version, re-stamps, regenerates the nodelib data) |
| `libraries/` or anything affecting node docs | `npm run build:nodelib` |
| Tutorial content (`tutorials-src/`) | `npm run build:tutorials` |
| `index.html` structure or webview-only fragments (`scripts/build-webview.mjs`) | `npm run build:webview` |
| Not sure | `npm run build` then `npm run check` — it's all idempotent |

## The standard library, spec data, and WASM modules

**`libraries/`** vendors the MaterialX standard library (`stdlib`, `pbrlib`, `bxdf`, `cmlib`, `lights`, `nprlib`, `targets`), which the WASM loads to resolve node definitions, implementations, and target inheritance.

**`js/JsMaterialXCore*` and `js/JsMaterialXGenShader*`** (`.js`/`.wasm`/`.data`, v1.39.5) are the MaterialX WebAssembly modules themselves, obtained from the official MaterialX build and committed manually. They predate, and are not managed by, `scripts/vendor.mjs` — but they are the **single source of truth for the MaterialX version**: the build's `version` step extracts it from the module at build time and every other occurrence in the repo is generated or stamped from that (see the `version` step above).

**`models/`** ships two GLB exports of the ASWF/USD-WG Standard Shader Ball (see [Asset credits](../README.md#asset-credits) in the README, and `models/LICENSE.txt`), committed in-repo — no download step: `shaderball.glb`, the full scene used by the Node Graph Editor's live preview (backdrop, grid, emissive panels, and an embedded camera), and `shaderball_simple.glb`, a plain ball used by the Material Viewer and docs previews. In both, the generated MaterialX material is applied only to the mesh named `material_surface`; every other mesh keeps its authored glTF material.
