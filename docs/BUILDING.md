# How this repo is built

- Committed-artifact model: every generated file is checked into git, so a fresh clone runs with no build step. Exceptions are gitignored and fetched on demand: the USD runtime (`npm run vendor`, needed only for USD stages and any `fetchOnly` dependency), non-default MaterialX versions (`npm run vendor:versions`), the offline MaterialX snapshot (`npm run vendor:offline`) and the gallery data (`npm run gallery:data`).
- `npm run build` regenerates every derived file byte-for-byte.
- `npm run check` verifies the tree against its inputs without writing anything (CI runs both).

## Commands

- `npm ci`: install dependencies.
- `npm run build`: run every build step.
- `npm run check`: verify every step's output, read-only.
- `npm run build:<step>`: run one step (`vendor`, `nodelib`, `embed`, `embeddocs`, `tutorials`, `buildid`, `webview`).
- `npm run vendor`: same as `build:vendor`.
- `npm run vendor:versions`: fetch non-default MaterialX WASM versions for Compare.
- `npm run vendor:offline` (`vendor.mjs --with-materialx`): snapshot MaterialX spec/examples into gitignored `vendor/materialx/`, zero-network mode.

## Build steps

`npm run build` (`scripts/build.mjs`) runs these in order. Each also runs alone as `npm run build:<step>` and has a read-only `--check` mode.

1. **version** (`scripts/extract-mtlx-version.mjs`) - loads the vendored WASM under Node and reads its version. `JsMaterialXGenShader.wasm` is the single source of truth; this step writes `js/gen/mtlx-version.json` and stamps the literal into `js/mtlx-engine.js` (`MTLX_DEFAULT_VERSION`), `js/site-header.js`, `js/mtlx-assets.js`, `README.md`, and this file (see `STAMP_TABLE` in `scripts/lib/version.mjs`). Never hand-edit those stamped literals.
2. **versions** (`scripts/fetch-mtlx-versions.mjs`, check-only) - verifies the byte size of any non-default `js/materialx/<version>/` directory present against `scripts/lib/mtlx-versions.mjs`. A missing directory is fine. To populate one, run `npm run vendor:versions`.
3. **vendor** (`scripts/vendor.mjs`) - collects `scripts/vendor-deps.mjs` (`VENDOR_DEPS`) into `vendor/`, `vendor/vendor-manifest.json`, and `js/gen/vendor-deps.js`. `npm run vendor:offline` also adds gitignored `vendor/materialx/` for zero-network mode.
4. **nodelib** (`scripts/build-nodelib.mjs`) - pre-parses the node library into `js/gen/nodelib.json` and `js/gen/nodelib-index.json`. The docs view never parses MaterialX live.
5. **embed** (`scripts/build-embed.mjs`) - precompiles `js/mtlx-engine.js`, `js/shared/mtlx-ui.jsx`, `js/viewer-app.jsx` into `embed/gen/*.js` so the embed ships no Babel. Also enforces that `embed/viewer.html` carries every `vendor/three/**`/`js/vendor/**` script tag `index.html` loads.
6. **embeddocs** (`scripts/build-embed-docs.mjs`) - renders `docs/EMBEDDING.md` into `js/gen/embedding-docs.html`. Fails on any dangling internal anchor.
7. **tutorials** (`scripts/build-tutorials.mjs`) - builds the MkDocs subsite into `/tutorials/`. Only runs when `tutorials-src/mkdocs.yml` exists.
8. **buildid** (`scripts/lib/build-id.mjs`) - hashes `index.html`, `js/**` (except `js/materialx/` and `js/gen/build-id.json`), and `vendor/vendor-manifest.json` into `js/gen/build-id.json` and the `window.__MTLX_BUILD` stamp in `index.html`. Merge conflicts on either file: take either side and rerun `npm run build`.
9. **webview** (`scripts/build-webview.mjs`) - splices `vscode_extension/media/webview.html` from `index.html`.

## CI

- `.github/workflows/deploy.yml` runs on every push/PR to `main`: a clean `npm ci && npm run build` must be byte-identical to the commit.
- Then `npm run check` runs.
- Only after both pass does a push to `main` deploy to GitHub Pages.

## When to run what

| You changed... | Run |
| --- | --- |
| App code (`js/**.jsx`, CSS, HTML) | nothing, reload the browser |
| `js/mtlx-engine.js`, `js/viewer-app.jsx`, or `js/shared/mtlx-ui.jsx` | `npm run build:embed` |
| A pinned dependency in `package.json`, or an entry in `scripts/vendor-deps.mjs` | `npm install && npm run build` |
| Vendored WASM modules (`js/materialx/<version>/JsMaterialX*`) | `npm run build` |
| Want a non-default MaterialX version locally (Compare) | `npm run vendor:versions` |
| `libraries/` or anything affecting node docs | `npm run build:nodelib` |
| Tutorial content (`tutorials-src/`) | `npm run build:tutorials` |
| Anything under `index.html`, `js/**` (excluding `js/materialx/`), or `vendor/vendor-manifest.json` | `npm run build:buildid` (or `npm run build`) |
| `index.html` structure or webview-only fragments | `npm run build:webview` |
| Not sure | `npm run build` then `npm run check`, it's idempotent |

## Adding a third-party dependency

1. If it's an npm package, pin it first: `npm install -D -E <pkg>` (so CI's `npm ci` vendors the same version).
2. Add one entry to `VENDOR_DEPS` in `scripts/vendor-deps.mjs`.
3. Get the sha256 (and, for a zip, the file tree) with `node scripts/vendor.mjs --hash <url>`.
4. Run `npm run build`.

Field reference:

| Field | Meaning |
| --- | --- |
| `id` | unique, lowercase, hyphenated |
| `name` | display name (About dialog) |
| `version` | required for non-npm sources; forbidden for npm |
| `dir` | output subdirectory, defaults to `id` |
| `source.npm` + `source.files` | pull from `node_modules`, pinned via `package.json` |
| `source.files` (array) | pull single files by URL, each pinned by sha256 |
| `source.zip` | pull a release zip by URL, pinned by sha256 |
| `license` | `{ url, file? }` |
| `fetchOnly` | never committed, fetched every build, added to the generated `.gitignore` block |
| `vscode: false` | not packaged in the `.vsix`, added to the generated `.vscodeignore` block |
| `module` | `{ entry, kind }`, enables `await MtlxVendor.load(id)` instead of an eager `<script>` tag |
| `{version}` | placeholder substituted into URLs and `license.url` |

npm-sourced file with a license:

```js
{
  id: "example-lib",
  name: "Example Lib",
  source: { npm: "example-lib", files: { "dist/example-lib.min.js": "example-lib.min.js", LICENSE: "LICENSE.txt" } },
  license: { url: "https://github.com/example/example-lib/blob/HEAD/LICENSE", file: "LICENSE.txt" },
}
```

Single file fetched by URL, pinned by sha256:

```js
{
  id: "example-font",
  name: "Example Font",
  version: "2.1.0",
  source: { files: [{ url: "https://example.com/fonts/v{version}/example-font.woff2", sha256: "<paste from --hash>", as: "example-font.woff2" }] },
  license: { url: "https://example.com/fonts/LICENSE" },
}
```

Release zip, fetched at build time only, never committed:

```js
{
  id: "example-wasm",
  name: "Example WASM",
  version: "1.2.0",
  source: { zip: "https://github.com/<owner>/<repo>/releases/download/v{version}/example_package.zip", sha256: "<paste from --hash>" },
  license: { url: "https://github.com/<owner>/<repo>/releases/tag/v{version}" },
  fetchOnly: true,
  vscode: false,
  module: { entry: "Example.js", kind: "emscripten-esm" },
}
```

A dependency with `module` loads on demand: `await MtlxVendor.load("example-wasm")` (`js/shared/vendor-runtime.js`).

The diff after `npm run build` touches `scripts/vendor-deps.mjs`, `vendor/vendor-manifest.json`, `vendor/<dir>/**` (unless `fetchOnly`), `js/gen/vendor-deps.js`, `.gitignore`/`.vscodeignore` (only when `fetchOnly`/`vscode: false`), the build-id stamp, `vscode_extension/media/webview.html`, and `package.json`/`package-lock.json` (npm deps only).

## MaterialX WASM modules

- `js/materialx/<version>/` holds the MaterialX WebAssembly modules. Only the default version is committed; others are fetched on demand via `npm run vendor:versions`, for Material Compare's per-pane version picker only.
- `JsMaterialXGenShader*` (`.js`/`.wasm`/`.data`, v1.39.5) is the only module anything loads. The `.data` is the packed standard library.
- `JsMaterialXCore.{js,wasm}` is unused (GenShader is a strict superset), and ships no `.data`.
- `JsMaterialX{Core,GenShader}-<version>.js` are byte-identical duplicates kept only to mirror the upstream zip.
- `libraries/` vendors the MaterialX standard library (stdlib, pbrlib, bxdf, cmlib, lights, nprlib, targets) the WASM resolves node definitions against.
- `models/` ships `shaderball.glb` and `shaderball_simple.glb` (committed, no download step); the generated material applies only to the mesh named `material_surface`.

## Adding or promoting a MaterialX version

`scripts/lib/mtlx-versions.mjs` is hand-maintained. Missing an ignore line fails silently: it either commits several MB of WASM into git, or bloats the `.vsix`.

### Adding a non-default version

1. Get the numbers: `node scripts/vendor.mjs --hash https://github.com/AcademySoftwareFoundation/MaterialX/releases/download/<tag>/MaterialX_JavaScript.zip` prints the zip's sha256 (`zipSha256`), byte size (`zipBytes`), and every file's size (`files`).
2. Add the entry to `MTLX_VERSIONS` in `scripts/lib/mtlx-versions.mjs`: `version`, `tag`, `zipSha256`, `zipBytes`, `files`.
3. Add `js/materialx/<version>/` to `.gitignore`, otherwise a broad `git add` stages the WASM.
4. Add `js/materialx/<version>/**` to `.vscodeignore`, otherwise it ships inside the `.vsix` unused.
5. Run `npm run vendor:versions`, then `npm run build && npm run check`.

### Promoting a new default

`DEFAULT_MTLX_VERSION` is computed as the numeric max of `MTLX_VERSIONS`, never hand-picked. Adding a newer entry makes it the default immediately, so its WASM must be committed in the same change.

1. Add the new version's registry entry (steps 1-2 above).
2. Commit the new default's GenShader `.js`/`.wasm`/`.data` under `js/materialx/<newVersion>/`, removing any `.gitignore`/`.vscodeignore` lines it had as a non-default version.
3. Untrack the old default: add its `js/materialx/<oldVersion>/` line to `.gitignore` and `.vscodeignore`, then `git rm -r --cached js/materialx/<oldVersion>/`.
4. Run `npm run build` then `npm run check`.
