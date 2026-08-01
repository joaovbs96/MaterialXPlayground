# MaterialX Playground

[![Build, verify & deploy](https://github.com/joaovbs96/MaterialXPlayground/actions/workflows/deploy.yml/badge.svg)](https://github.com/joaovbs96/MaterialXPlayground/actions/workflows/deploy.yml) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE) [![MaterialX](https://img.shields.io/badge/MaterialX-v1.39.5-blue.svg)](https://github.com/AcademySoftwareFoundation/MaterialX)

MaterialX Playground is a set of in-browser tools to explore the standard MaterialX node library, preview materials in real-time 3D, and build node graphs visually, all without installing anything. Everything runs 100% client-side: no data leaves your browser. Shaders are generated and compiled live through the MaterialX v1.39.5 WebAssembly modules.

> This is an independent community project. It is **not affiliated with, endorsed by, or sponsored by** the [MaterialX](https://materialx.org/) project, the Academy Software Foundation, or the Linux Foundation. In case of any discrepancy, the [MaterialX specification](https://github.com/AcademySoftwareFoundation/MaterialX/tree/main/documents/Specification) is the definitive source of truth. See [Trademarks](#trademarks) below.

## Try it live

**[joaovbs96.github.io/MaterialXPlayground](https://joaovbs96.github.io/MaterialXPlayground/)**. You'll need a WebGL2-capable browser; it works best on desktop.

## Features

### 📖 Node Library & Documentation

![Node Library & Documentation](images/preview-docs.jpg)

A searchable, browsable reference for the entire MaterialX standard node library.

- **Every standard node**, organized by library (`stdlib`, `pbrlib`, `bxdf`, and more) and group (`npr`, `pbr`, etc.).
- **Per-signature documentation.** Nodes with multiple type signatures are documented individually, with the exact inputs, outputs, and defaults of each variant.
- **Port tables** generated directly from the node definitions (names, types, defaults), with descriptions pulled from the MaterialX specification where available and reconstructed from the `nodedef`s otherwise.
- **Live 3D preview** of each node, with editable parameters so you can see how inputs affect the result in real time.
- **Implementation-target matrix** showing which render targets (GLSL, ESSL, MSL, Slang, OSL, MDL) each node supports, distinguishing explicit per-target implementations from ones inherited from GLSL, with a view of nodegraph implementation sources.
- **Shareable permalinks.** Every node has its own URL (`index.html#/<library>/<group>/<node>`), so you can link straight to a specific node's docs, e.g. [`#/bxdf/pbr/standard_surface`](https://joaovbs96.github.io/MaterialXPlayground/index.html#/bxdf/pbr/standard_surface).
- **Export and hand-off.** Export any node (with your edited values) as a `.mtlx` document, or send it straight into the Node Graph Editor.

### 🖼️ Material Viewer

![Material Viewer](images/preview-material.jpg)

Load and inspect MaterialX materials in 3D.

- **Image-based lighting** from a built-in HDR environment, with a toggle to show or hide it as the visible backdrop (the lighting stays on either way).
- **Drag-and-drop loading.** Drop a `.mtlx` document anywhere on the page, alone or with loose textures, a folder of textures, or a `.zip`. Textures are matched by relative path, with a UV-checker fallback for anything unresolved.
- **Curated examples.** Load official MaterialX example materials, textures included, from a built-in presets list.
- **Interactive viewport** with orbit and zoom, optional turntable, selectable preview geometry (shaderball / sphere / cube), a material picker when a document defines several, save-as-PNG, and fullscreen.
- **Send to Graph Editor** to keep working on the current material in the Node Graph Editor.

### 🕸️ Node Graph Editor

![Node Graph Editor](images/preview-nodegraph.jpg)

Build MaterialX node graphs visually.

- **Drag-and-drop graph editing** built on React Flow, with an add-node search (filterable by type), automatic wiring, and keyboard shortcuts throughout.
- **Quick insert from a wire.** Drag a connection onto empty canvas to pick a compatible node, pre-filtered and wired up automatically.
- **Nested nodegraphs.** Enter and edit nodegraph scopes with breadcrumb navigation, group a selection into a new nodegraph in one step, or dissolve one back into its nodes.
- **Undo/redo** across edits, including structural ones.
- **Live 3D preview** of the selected node or output, with a pin option to freeze the preview on a specific node while you work elsewhere.
- **Copy/paste** that preserves the nodes' relative arrangement.
- **One-click automatic layout** of the current graph.
- **Document colorspace picker**, setting the working colorspace of the document.
- **Non-destructive disconnects.** Removing a connection or deleting an upstream node restores the input's previous value, or the definition default.
- **Document view** to inspect the generated MaterialX XML with syntax highlighting, and copy it.
- **Validate** the current document and see errors and warnings.
- **Import/export** `.mtlx`, with a `.zip` export option that bundles the textures used. Start from an empty document, a curated official example, or a material handed off from the docs pages or the Material Viewer.
- **Cross-links.** Open the current material in the Material Viewer, or jump from any node to its documentation page.

## Running locally

A fresh clone is the complete, runnable site: there is nothing to build or install. Just serve the folder with any static file server:

```bash
# Python 3
python -m http.server 8000

# or Node
npx serve .
```

Then open <http://localhost:8000/>. Serving over HTTP is required; opening `index.html` via `file://` won't work, because the app fetches its `.jsx`, WASM, and library files.

Development works the same way: edit a `.jsx`/`.js` file and reload. Sources are transformed in the browser by Babel Standalone, and every derived artifact (vendored libraries, pre-generated node-library data) is committed. Build tooling is only needed when you change one of those generated inputs; see [Generated files](#generated-files).

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

## Tech stack

- [MaterialX](https://github.com/AcademySoftwareFoundation/MaterialX) (WebAssembly build: core + GenShader)
- [React 18](https://react.dev/) (UMD) + [Babel Standalone](https://babeljs.io/docs/babel-standalone) (in-browser JSX)
- [three.js](https://threejs.org/) for the 3D previews
- [React Flow](https://reactflow.dev/) for the node graph editor, with [dagre](https://github.com/dagrejs/dagre) for automatic layout
- [Tailwind CSS](https://tailwindcss.com/) (vendored Play build) for styling
- [KaTeX](https://katex.org/) for math in the docs, [highlight.js](https://highlightjs.org/) for XML highlighting, [JSZip](https://stuk.github.io/jszip/) for zipped texture sets

All third-party JS/CSS libraries are vendored into a committed `vendor/` folder (pinned versions, refreshed via `npm run vendor`), so the app makes no CDN requests at runtime. The one runtime exception is MaterialX example/preset/texture content, fetched from `raw.githubusercontent.com` on demand. If a local `vendor/materialx/` snapshot is present (as in the packaged offline build), that too is read from disk and the app performs zero network access. See [docs/BUILDING.md](docs/BUILDING.md) for the details.

## Generated files

Some files in this repo are produced by scripts rather than written by hand: the vendored third-party libraries in `vendor/`, the pre-parsed node-library data in `js/gen/`, the extracted MaterialX version, and the VS Code webview mirror. All of them are committed, which is why a clone runs without any build step. They only need to be regenerated when one of their inputs changes (for example, bumping a library version), using `npm run build`; `npm run check` and CI then verify that the committed files match their inputs, so the two can't drift apart. See [docs/BUILDING.md](docs/BUILDING.md) for the full pipeline, deployment details, and a "what changed → what to run" table.

---

## Roadmap

- **Interactive tutorials subsite**: a guided, hands-on set of MaterialX tutorials, served alongside the app (in progress).
- **VS Code extension**: a custom `.mtlx` editor with live preview, validation, and hover docs, built on the same engine as the web app (in progress).
- **Rendering comparison**: render two documents side by side to easily visualize any differences between them.

Have a feature request or idea? File it on the [issue tracker](https://github.com/joaovbs96/MaterialXPlayground/issues).

## Contributing

Issues and pull requests are welcome. Please file bugs and feature requests via the [issue tracker](https://github.com/joaovbs96/MaterialXPlayground/issues).

## Asset credits

**Shader ball.** `models/shaderball.glb` and `models/shaderball_simple.glb` are GLB conversions of the ["Standard Shader Ball"](https://github.com/usd-wg/assets) by Chris Rydalch and André Mazzone (USD Working Group; original scene concept by Thomas Anagnostou), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). See [`models/LICENSE.txt`](models/LICENSE.txt) for the full attribution and modification notice.

**HDRI.** The built-in environment lighting is ["Studio Kontrast 04"](https://polyhaven.com/a/studio_kontrast_04) by Grzegorz Wronkowski, via [Poly Haven](https://polyhaven.com/), licensed [CC0](https://polyhaven.com/license). See [`env_maps/LICENSE.txt`](env_maps/LICENSE.txt).

**UV checker texture.** `images/CustomUVChecker_byValle_2K.png` was generated with the ["UV Checker Map Maker"](https://uvchecker.atlux.one) tool by Valle, whose [EULA](https://uvchecker.atlux.one/EULA.html) grants free use of the images it produces.

**Icons.** UI icons are from [Tabler Icons](https://tabler.io/icons) by Paweł Kuna, licensed [MIT](images/tabler-icons/LICENSE.txt), inlined as SVG paths in `js/shared/ui-commons.js`.

**MaterialX logo.** `images/materialx-logo.svg` is the official MaterialX project logo, © the Academy Software Foundation, from [AcademySoftwareFoundation/artwork](https://github.com/AcademySoftwareFoundation/artwork). It is used here only to identify the MaterialX project; see [Trademarks](#trademarks).

## License

Released under the [Apache License 2.0](LICENSE). The MaterialX standard libraries vendored under `libraries/` are © the Academy Software Foundation and its contributors, also under the Apache License 2.0.

## Trademarks

MaterialX™ is a trademark of the Academy Software Foundation, a project of the Linux Foundation. All other trademarks are the property of their respective owners.

References to MaterialX in this project are nominative and descriptive only, used to identify the technology this tool works with. The MaterialX logo appears in this project's interface solely to identify the MaterialX project and the version of the MaterialX libraries in use, and links to the official MaterialX documentation; this use does not imply any affiliation with or endorsement by the trademark holders. This project is **not affiliated with, endorsed by, or sponsored by** the MaterialX project, the Academy Software Foundation, or the Linux Foundation, and nothing here should be read as implying any official status. Where this document and any policy published by the Academy Software Foundation or the Linux Foundation (including the Linux Foundation Trademark Usage Guidelines) differ, the Foundation's policy governs.
