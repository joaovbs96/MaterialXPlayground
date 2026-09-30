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
| `vscode: false` | not packaged in the `.vsix`; every other dep gets a `!vendor/<dir>/**` line in the generated `.vscodeignore` allowlist block |
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

The diff after `npm run build` touches `scripts/vendor-deps.mjs`, `vendor/vendor-manifest.json`, `vendor/<dir>/**` (unless `fetchOnly`), `js/gen/vendor-deps.js`, `.gitignore` (only when `fetchOnly`), `.vscodeignore` (a new allow line unless `vscode: false`), the build-id stamp, `vscode_extension/media/webview.html`, and `package.json`/`package-lock.json` (npm deps only). The extension packaging checks (`scripts/check-vsix-files.mjs` and the vsix checks in `release.yml`/`publish-marketplace.yml`) read the registry too, so they need no edit: every manifest file of a shipped dep is required, and the folder of every `vscode: false` dep is forbidden.

## MaterialX WASM modules

- `js/materialx/<version>/` holds the MaterialX WebAssembly modules. Only the default version is committed; others are fetched on demand via `npm run vendor:versions`, for Material Compare's per-pane version picker only.
- `JsMaterialXGenShader*` (`.js`/`.wasm`/`.data`, v1.39.5) is the only module anything loads. The `.data` is the packed standard library.
- `JsMaterialXCore.{js,wasm}` is unused (GenShader is a strict superset), and ships no `.data`.
- `JsMaterialX{Core,GenShader}-<version>.js` are byte-identical duplicates kept only to mirror the upstream zip.
- `libraries/` vendors the MaterialX standard library (stdlib, pbrlib, bxdf, cmlib, lights, nprlib, targets) the WASM resolves node definitions against.
- `models/` ships `shaderball.glb` and `shaderball_simple.glb` (committed, no download step); the generated material applies only to the mesh named `material_surface`.

**`vendor/materialx/`** is the full offline snapshot from `npm run vendor:offline` (spec docs, example `.mtlx` files, reference images; see the `vendor` build step above), gitignored and produced on demand. Only a small, explicit set of those files are actually reachable from the VS Code extension (the webview's viewer, graph editor, and docs views, the extension host's spec parser, and the curated upstream examples the "New Material from Example" command offers via `vscode_extension/src/exampleCatalog.js`), so `.vscodeignore` lists just those explicit `vendor/materialx/...` paths instead of allowlisting the whole folder; `scripts/check-vsix-files.mjs`'s `MATERIALX_KEEP_LIST` requires exactly that same set and forbids every other `vendor/materialx/` path (in particular `resources/Images/`) from leaking into the `.vsix`. The two lists (`.vscodeignore`'s allowlist and `MATERIALX_KEEP_LIST`) must stay in sync by hand; `check-vsix-files.mjs` is what actually enforces that they match. Adding another curated example needs a coordinated edit to `exampleCatalog.js`, `MATERIALX_KEEP_LIST`, and `.vscodeignore`. The website's separate offline release zip (`.github/workflows/release.yml`) still ships the complete snapshot, since the web app itself can reach all of it.

## Adding or promoting a MaterialX version

`scripts/lib/mtlx-versions.mjs` is hand-maintained. `.vscodeignore` is an allowlist (everything is excluded unless a `!` line names it), so only the `.gitignore` line can be forgotten: missing it commits several MB of WASM into git.

### Adding a non-default version

1. Get the numbers: `node scripts/vendor.mjs --hash https://github.com/AcademySoftwareFoundation/MaterialX/releases/download/<tag>/MaterialX_JavaScript.zip` prints the zip's sha256 (`zipSha256`), byte size (`zipBytes`), and every file's size (`files`).
2. Add the entry to `MTLX_VERSIONS` in `scripts/lib/mtlx-versions.mjs`: `version`, `tag`, `zipSha256`, `zipBytes`, `files`.
3. Add `js/materialx/<version>/` to `.gitignore`, otherwise a broad `git add` stages the WASM.
4. No `.vscodeignore` edit: its allowlist names only the default version's three files, so other versions never ship in the `.vsix`.
5. Run `npm run vendor:versions`, then `npm run build && npm run check`.

### Promoting a new default

`DEFAULT_MTLX_VERSION` is computed as the numeric max of `MTLX_VERSIONS`, never hand-picked. Adding a newer entry makes it the default immediately, so its WASM must be committed in the same change.

1. Add the new version's registry entry (steps 1-2 above).
2. Commit the new default's GenShader `.js`/`.wasm`/`.data` under `js/materialx/<newVersion>/`, removing its `.gitignore` line, and point the three `!js/materialx/<version>/JsMaterialXGenShader.*` lines in `.vscodeignore` (and `scripts/check-vsix-files.mjs`) at the new version.
3. Untrack the old default: add its `js/materialx/<oldVersion>/` line to `.gitignore`, then `git rm -r --cached js/materialx/<oldVersion>/`.
4. Run `npm run build` then `npm run check`.

## Preset picker thumbnails in the .vsix

`gallery/` is otherwise forbidden from the extension (too large: 50+ full-res renders). `release.yml`'s `package` job runs `scripts/gallery-shots.mjs --prune-ids-auto` after staging the offline zip but before `vsce package`, trimming the already-populated `gallery/manifest.json` and `gallery/thumbs/` down to the Material Viewer presets (`MTLX_PRESETS`) plus the `vscode_extension/src/exampleCatalog.js` entries, at their original resolution. `.vscodeignore` allows only `gallery/manifest.json` and `gallery/thumbs/*.jpg`; `scripts/check-vsix-files.mjs`'s `isForbiddenGalleryPath` rejects anything else under `gallery/`. Both files are optional: a plain checkout with no gallery data ships the extension with letter-placeholder icons. The desktop app is unaffected: `electron/scripts/lib/ensure-gallery.mjs` already ships the full gallery for its own Material Gallery view.

Fingerprints in `gallery/manifest.json` (`scripts/build-gallery.mjs`) normalize CRLF to LF before hashing, so a Windows checkout (`core.autocrlf`) reuses the same published thumbnail as a Linux CI checkout instead of re-rendering under a different hash. `scripts/gallery-shots.mjs` renders with plain headless Chromium (SwiftShader) by default; set `MTLX_GALLERY_GPU=1` to render with new-headless plus real GPU flags instead, for local renders that need to look like an actual browser.

## Pre-release .vsix builds from a branch

`.github/workflows/package-prerelease.yml` is a manual `workflow_dispatch` (**"Use workflow from"** set to any branch) that packages a pre-release `.vsix` from that branch's tip and uploads it as a downloadable workflow artifact (14-day retention). It reproduces `release.yml`'s `package` job (build, the stale-artifact gate, `npm run check`, the gallery reuse-from-the-live-site path, `--prune-ids-auto`, the locked `vsce`, the `.vsix` content sanity checks) plus `scripts/check-vsix-files.mjs`, always passing `--pre-release`, then optionally runs the real VS Code smoke test (`tests/vscode-host/smoke.mjs`) against the packaged `.vsix`, same as `vscode-extension-tests.yml`'s `smoke` job. Nothing is published: no release, tag, Marketplace, or Open VSX upload.

PR CI runs `--suite core` (about a dozen extension-logic scenarios plus one render check, defined as `CORE_SCENARIOS` in `smoke-suite.js`); the pre-release and release workflows and local runs default to `--suite full`.

The smoke runs pass `--software-gl` (Chromium SwiftShader switches; GPU-less runners otherwise blocklist WebGL2) and print a START/END line per scenario; each scenario has its own timeout and the suite stops at `MTLX_SMOKE_DEADLINE_S` (default 900) with a pass/fail table.

Version: `YYYY.M.patch` like a real release, but with `patch` offset by `900000 + <run number>` so it can never collide with or sort below a real release cut in the same month. The artifact is named `materialx-playground-<version>-pre-<branch>-<sha7>.vsix`. Because `release.yml`'s packaging commands are duplicated here rather than shared (extracting a composite action into the production release pipeline was judged too risky to do without a way to exercise it locally), `scripts/package-vsix.mjs` checks on every run that the two workflows' packaging commands haven't drifted apart; a failure there means one of the two workflows was edited without the other.

## Desktop test builds from a branch

`.github/workflows/package-desktop.yml` builds an unsigned desktop (Electron) installer from any branch. In the Actions tab pick **"Package desktop test build"**, set **"Use workflow from"** to the branch, choose the platform (windows, macos, linux or all) and run it. Download the installer from the run's artifacts (`materialx-playground-desktop-<os>-<branch>-<sha7>`, kept 14 days). Nothing is published. A `verify` job builds once and fails fast on stale committed artifacts; the platform jobs then repeat `release.yml`'s `desktop` job steps, which must be kept in sync. Builds are unsigned: on Windows use SmartScreen "More info" then "Run anyway"; on macOS right-click Open, or run `xattr -dr com.apple.quarantine "/Applications/MaterialX Playground.app"`. The workflow only appears in the Actions tab once it is on the default branch.

## Publishing to the VS Code Marketplace

`.github/workflows/publish-marketplace.yml` is a manual `workflow_dispatch` that publishes the exact `.vsix` GitHub already attached to a release. It never rebuilds anything. Run it with **"Use workflow from"** set to the release's tag (not a branch), and only after `release.yml`'s `upload` job has attached that tag's `.vsix` to the release. The same `verify` job feeds two independent publish jobs, `publish` (Marketplace) and `publish-openvsx` (Open VSX); either can succeed while the other fails, and both can be re-run separately.

**One-time setup for the Marketplace** (done once for the whole repo, outside this codebase, in Entra ID and the Marketplace publisher portal):

- Create a federated credential on an Entra ID app registration with issuer `https://token.actions.githubusercontent.com`, subject `repo:joaovbs96/MaterialXPlayground:environment:github-marketplace`, and audience `api://AzureADTokenExchange`. This is what lets the `publish` job log in without a stored secret.
- Add `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` as **environment secrets** of the `github-marketplace` environment, not repository secrets. The environment's tag policy is what keeps this identity scoped to a real release.
- Add that app registration's identity as a **Contributor member of the MaterialXPlayground publisher** in the Marketplace publisher management page, and confirm `az account set -s <subscription>` actually resolves for it. The identity also needs a role on the subscription itself, not just publisher membership.
- Consider a **required reviewer** on the `github-marketplace` environment so the run pauses after `verify` and before the Azure login, giving a human a chance to read the verify job's step summary first.

**One-time setup for Open VSX** (done once for the whole repo, outside this codebase, on open-vsx.org):

- Create an Eclipse account at `accounts.eclipse.org` with the same GitHub username used to log into open-vsx.org, then log into open-vsx.org via GitHub and sign the Publisher Agreement from the profile settings page.
- Create the namespace once, from any machine with the token below: `npx ovsx create-namespace MaterialXPlayground -p <token>`. The namespace name must equal `publisher` in `package.json` (`MaterialXPlayground`); Open VSX has no separate publisher identity to match.
- Generate a personal access token at `https://open-vsx.org/user-settings/tokens` and add it as the **environment secret** `OVSX_PAT` of a new `open-vsx` environment, not a repository secret. Give `open-vsx` the same tag-only deployment policy as `github-marketplace` so the token is only reachable from a real release tag.
- Open VSX also offers OIDC "trusted publishing" (registered at `https://open-vsx.org/user-settings/trusted-publishers`), which would drop the `OVSX_PAT` secret entirely. `publish-openvsx` does not use it: it needs `id-token: write`, which conflicts with this job's sparse-checkout-only `contents: read` permission, and the feature is very new (introduced in `ovsx` 1.1.0). Revisit if that changes.
- The `open-vsx` environment needs no Contributor-style role grant: the PAT alone is enough to publish to a namespace once the account is a namespace owner.

**Channel rules**: the Marketplace channel (release vs. pre-release) is fixed at packaging time by the GitHub release's pre-release checkbox. `release.yml` reads `github.event.release.prerelease` when it packages the `.vsix`, and `publish-marketplace.yml` re-derives the same flag from the packaged `.vsix` itself rather than re-reading the release. A given version string can be published to only one channel; publishing it to the other channel later is a Marketplace-side conflict, not something either workflow resolves. Never re-run `release.yml`'s `upload` job for a version already on the Marketplace. The attached `.vsix` is exactly what a later publish run ships, so replacing it after the fact would silently change what that version means. `publish-openvsx` passes the same pre-release flag it reads from `verify`'s output to `ovsx publish --pre-release`.

**Failure modes**:

- Missing or draft release, or its `.vsix` asset not uploaded yet: the `verify` job's "Check the GitHub release" step fails before touching Azure or Open VSX.
- The tag isn't `v<major>.<minor>.<patch>`, or the workflow was dispatched from a branch instead of a tag: fails immediately in "Check the ref is a release tag".
- The `.vsix` publisher is still `local`, or its build id or extension sources differ from the tag's commit: the `inspect` step fails, usually because the tag was cut before the publisher change landed, or the release was built from a different commit than the tag points at.
- Empty `AZURE_*` secrets: the `publish` job's Azure login step fails with a named error instead of a generic Azure CLI stack trace.
- `az account set` fails: the identity has the federated credential but no role assignment on the subscription. Grant it one and re-dispatch.
- `vsce publish` itself fails (for example the version is already published): read the Marketplace error directly. This workflow does not retry or pass `--skip-duplicate`.
- Empty `OVSX_PAT`: `publish-openvsx` posts an `::warning::` with the one-time setup steps above and skips its install and publish steps without failing the run, so a run started before Open VSX is set up still leaves the Marketplace publish untouched.
- `ovsx publish` itself fails (for example the version is already published): read the Open VSX error directly; this job does not retry either.
- To re-run just one side after a fix, use **Actions -> this run -> Re-run jobs -> Re-run failed jobs**, or re-dispatch the whole workflow from the same tag; `verify` is cheap and idempotent.
