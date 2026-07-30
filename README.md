# MaterialX Playground

[![Build, verify & deploy](https://github.com/joaovbs96/MaterialXPlayground/actions/workflows/deploy.yml/badge.svg)](https://github.com/joaovbs96/MaterialXPlayground/actions/workflows/deploy.yml) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE) [![MaterialX](https://img.shields.io/badge/MaterialX-v1.39.5-blue.svg)](https://github.com/AcademySoftwareFoundation/MaterialX)

MaterialX Playground is a set of in-browser tools to explore the standard MaterialX node library, preview materials in real-time 3D, and build node graphs visually, all without installing anything. Everything runs 100% client-side: no server, no account, no data leaves your browser. Shaders are generated and compiled live in your browser through the MaterialX WebAssembly modules.

Built on the MaterialX v1.39.5 WebAssembly modules (core and shader generation).

> This is an independent community project. It is **not affiliated with, endorsed by, or sponsored by** the [MaterialX](https://materialx.org/) project, the Academy Software Foundation, or the Linux Foundation. In case of any discrepancy, the [MaterialX specification](https://github.com/AcademySoftwareFoundation/MaterialX/tree/main/documents/Specification) is the definitive source of truth. See [Trademarks](#trademarks) below.

---

## Try it live

**[joaovbs96.github.io/MaterialXPlayground](https://joaovbs96.github.io/MaterialXPlayground/)** — everything runs client-side in the browser, there's nothing to install. For example, this deep link opens the `standard_surface` node's documentation directly: [`index.html#/bxdf/pbr/standard_surface`](https://joaovbs96.github.io/MaterialXPlayground/index.html#/bxdf/pbr/standard_surface).

You'll need a WebGL2-capable browser; it works best on desktop.

---

## Features

### 📖 Node Library & Documentation

![Node Library & Documentation](images/preview-docs.jpg)

A searchable, browsable reference for the entire MaterialX standard node library.

- **Every standard node**, organized by library (`stdlib`, `pbrlib`, `bxdf`, and more) and group (`npr`, `pbr`, etc.).
- **Per-signature documentation.** Nodes with multiple type signatures are shown individually, so you see exactly the inputs, outputs, and defaults of the variant you are searching for.
- **Port tables** generated directly from the node definitions (names, types, defaults, descriptions), with prose pulled from the MaterialX specification where available and reconstructed from the `nodedef`s where it isn't.
- **Live 3D preview** of each node, with editable parameters so you can see how inputs affect the result in real time.
- **Implementation-target matrix** showing which render targets (GLSL, ESSL, MSL, Slang, OSL, MDL) each node supports, including coverage inherited through target inheritance (e.g. MSL/Slang/ESSL falling back to the GLSL implementation), distinguished from explicit per-target overrides.
- **Shareable permalinks.** Every node has its own URL (`index.html#/<library>/<group>/<node>`), so you can link straight to a specific node's docs.
- **Export and hand-off.** Export any node (with your edited values) as a `.mtlx` document, or send it straight into the Node Graph Editor.

### 🖼️ Material Viewer

![Material Viewer](images/preview-material.jpg)

Load and inspect MaterialX materials in 3D.

- **Image-based lighting** from a built-in HDR environment (always on). A toggle shows or hides that environment as the visible backdrop; the lighting itself is unaffected either way.
- **Drag-and-drop loading.** Drop a `.mtlx` document anywhere on the page, on its own or together with loose textures, a folder of textures, or a `.zip`. Textures are matched by relative path, with a UV-checker fallback for anything unresolved.
- **Interactive viewport** with orbit (drag) and zoom (wheel/pinch), an optional turntable rotation, selectable preview geometry (shaderball / sphere / cube), a material picker when a document defines several, a save-PNG-preview button, and fullscreen.
- **Send to Graph Editor** to keep working on the current material in the Node Graph Editor.

### 🕸️ Node Graph Editor

![Node Graph Editor](images/preview-nodegraph.jpg)

Build MaterialX node graphs visually.

- **Drag-and-drop graph editing** built on React Flow, with an add-node search (filterable by type) and automatic wiring.
- **Quick insert from a wire.** Drag a connection from any port and release it over empty canvas to pick a compatible node, pre-filtered and wired up automatically.
- **Nested nodegraphs.** Enter and edit nodegraph scopes with breadcrumb navigation back out, and group the current selection into a new nodegraph in one step.
- **Undo/redo** across edits, including structural ones.
- **Live 3D preview** of the selected node or output, with a pin option to freeze the preview on a specific node while you work elsewhere.
- **Copy/paste** that preserves the relative arrangement of a group of nodes.
- **One-click automatic layout** of the current graph.
- **Document colorspace picker**, setting the fallback colorspace for inputs that don't author their own.
- **Non-destructive disconnects.** Removing a connection or deleting an upstream node restores the input's previous literal value where possible, and falls back to the definition default otherwise.
- **Document view** to inspect the generated MaterialX XML with syntax highlighting, and copy it.
- **Validate** the current document and see errors and warnings.
- **Import/export** `.mtlx`, including materials handed off from the docs previewer or the Material Viewer.

---

## Running locally

A fresh clone is immediately servable — the committed tree **is** the complete, runnable site. The app code itself has no build step (the `.jsx` sources are transformed in the browser by Babel Standalone; there is no bundler or transpile-on-disk), and every *derived* artifact — the vendored third-party libraries, the pre-generated node-library data, the extracted MaterialX version — is committed to the repo. You only need the build tooling when you change one of those inputs; see [How this repo is built](#how-this-repo-is-built). To run the site, just serve the clone over HTTP (opening `index.html` directly via `file://` won't work, because the app fetches its `.jsx`, WASM, and library files).

Any static file server works, for example:

```bash
# Python 3
python -m http.server 8000

# or Node (fetches the `serve` package from npm on first use, so that
# first run needs network access — the Python command above doesn't)
npx serve .
```

Then open <http://localhost:8000/>.

> **Maintainers:** day-to-day app-code edits need no tooling at all — edit a `.jsx`/`.js` file and reload. The build pipeline (`npm run build` / `npm run check`) only comes into play when a *generated input* changes; see [How this repo is built](#how-this-repo-is-built) below.

### URLs / routing

The app is a hash-routed single page:

| View | URL |
| --- | --- |
| Home | `index.html` (or `#!home`) |
| Node Library & Documentation | `index.html#!docs` (deep links: `#/<library>/<group>/<node>`) |
| Material Viewer | `index.html#!viewer` |
| Node Graph Editor | `index.html#!graph` |

### Debugging

Verbose console output is off by default. Two opt-in flags can be set in the browser console (reload afterwards):

```js
localStorage.setItem('mtlxDebugShaders', '1'); // log generated GLSL, uniforms, and preview documents
localStorage.setItem('mtlxPerfLog', '1');      // log graph-editor timing (scope builds, layout, previews)
```

Remove the keys (`localStorage.removeItem(...)`) and reload to turn them off again.

---

## Tech stack

- [MaterialX](https://github.com/AcademySoftwareFoundation/MaterialX) (WebAssembly build: core + GenShader)
- [React 18](https://react.dev/) (UMD) + [Babel Standalone](https://babeljs.io/docs/babel-standalone) (in-browser JSX)
- [three.js](https://threejs.org/) for the 3D previews
- [React Flow](https://reactflow.dev/) for the node graph editor, with [dagre](https://github.com/dagrejs/dagre) for automatic layout
- [Tailwind CSS](https://tailwindcss.com/) (vendored Play build) for styling
- [KaTeX](https://katex.org/) for math in the docs, [highlight.js](https://highlightjs.org/) for XML highlighting, [JSZip](https://stuk.github.io/jszip/) for zipped texture sets

All third-party JS/CSS libraries are vendored: `npm run vendor` installs pinned versions from npm (see `package.json` devDependencies) and copies the needed dist files (and licenses) into a committed `vendor/` folder, served locally alongside the app — no CDN requests at runtime. The one direct download is the Tailwind Play build, fetched by URL and verified against a pinned sha256. MaterialX *example/preset/texture* content is the one runtime exception: the web app fetches it from `raw.githubusercontent.com` on demand unless a local `vendor/materialx/` snapshot is present, in which case it's read from disk instead and the app performs zero network access (see `js/mtlx-assets.js`). A packaged offline build ships that snapshot. The specification markdown itself is no longer fetched by the web app at all — it's parsed at build time into the committed `js/gen/` node-library data (the VS Code extension's hover docs still fetch spec files remotely, vendor-snapshot-first).

---

## How this repo is built

The repo follows a **committed-artifact model**: every generated file (vendored libraries, pre-parsed node-library data, the extracted MaterialX version, the VS Code webview mirror) is checked in, so consumers never run a build — only contributors who change an input do, and CI proves the two never drift. See **[docs/BUILDING.md](docs/BUILDING.md)** for the full build pipeline, verification/deployment details, and a "what changed → what to run" table.

---

## Roadmap

- **Interactive tutorials subsite** — a guided, hands-on set of MaterialX tutorials, served alongside the app (in progress).
- **VS Code extension** — a custom `.mtlx` editor with live preview, validation, and hover docs, built on the same engine as the web app (in progress).

Have a feature request or idea? File it on the [issue tracker](https://github.com/joaovbs96/MaterialXPlayground/issues).

## Contributing

Issues and pull requests are welcome. Please file bugs and feature requests via the [issue tracker](https://github.com/joaovbs96/MaterialXPlayground/issues).

## Asset credits

**Shader ball.** `models/shaderball.glb` and `models/shaderball_simple.glb` are GLB exports of the ["Standard Shader Ball"](https://github.com/usd-wg/assets) by Chris Rydalch and André Mazzone (USD Working Group), original scene concept by Thomas Anagnostou, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The committed files are converted/exported to glTF Binary (`.glb`) from the original scene — see [`models/LICENSE.txt`](models/LICENSE.txt) for the full attribution and modification notice CC BY 4.0 requires.

**HDRI.** The built-in environment lighting is ["Studio Kontrast 04"](https://polyhaven.com/a/studio_kontrast_04) by Grzegorz Wronkowski, via [Poly Haven](https://polyhaven.com/), licensed [CC0](https://polyhaven.com/license). See [`env_maps/LICENSE.txt`](env_maps/LICENSE.txt).

**UV checker texture.** `images/CustomUVChecker_byValle_2K.png` was generated with the ["UV Checker Map Maker"](https://uvchecker.atlux.one) tool by Valle. The tool has no license of its own, but its [EULA](https://uvchecker.atlux.one/EULA.html) grants free use of the images it produces.

**Icons.** UI icons are from [Tabler Icons](https://tabler.io/icons) by Paweł Kuna, licensed [MIT](images/tabler-icons/LICENSE.txt), inlined as SVG paths in `js/mtlx-engine.js`.

**MaterialX logo.** `images/materialx-logo.svg` is the official MaterialX project logo, © the Academy Software Foundation, obtained from the Academy Software Foundation's official MaterialX project materials ([AcademySoftwareFoundation/artwork](https://github.com/AcademySoftwareFoundation/artwork)). The MaterialX name and logo are trademarks of the Academy Software Foundation / the Linux Foundation and are used here only to identify the MaterialX project. See [Trademarks](#trademarks).

## License

Released under the [Apache License 2.0](LICENSE). The MaterialX standard libraries vendored under `libraries/` are © the Academy Software Foundation and its contributors, also under the Apache License 2.0.

## Trademarks

MaterialX™ is a trademark of the Academy Software Foundation, a project of the Linux Foundation. All other trademarks are the property of their respective owners.

References to MaterialX in this project are nominative and descriptive only, used to identify the technology this tool works with. The MaterialX logo appears in this project's interface solely to identify the MaterialX project and the version of the MaterialX libraries in use, and links to the official MaterialX documentation; this use does not imply any affiliation with or endorsement by the trademark holders. This project is **not affiliated with, endorsed by, or sponsored by** the MaterialX project, the Academy Software Foundation, or the Linux Foundation, and nothing here should be read as implying any official status. Where this document and any policy published by the Academy Software Foundation or the Linux Foundation (including the Linux Foundation Trademark Usage Guidelines) differ, the Foundation's policy governs.
