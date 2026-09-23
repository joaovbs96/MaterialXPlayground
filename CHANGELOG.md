# Changelog

Notable changes to MaterialX Playground, newest first. Versions are calendar-based (`YYYY.M.patch`); see [Versioning](https://github.com/joaovbs96/MaterialXPlayground/blob/main/README.md#versioning) in the README.

Full notes for every release, including every fix, are on the [GitHub Releases page](https://github.com/joaovbs96/MaterialXPlayground/releases). This file is a plain-language summary.

## Unreleased

- VS Code extension published to the Marketplace as a preview. If you installed it from a GitHub release before, uninstall `local.materialx-playground` first.
- Referenced textures and includes must now stay inside the opened workspace folder (or next to the file, if no folder is open).
- Validation now runs off the editor thread and no longer reads files named by an `xi:include`.
- Added support for VS Code's Restricted Mode.
- The extension package is smaller.

## 2026.9.4 (2026-09-15)

- Adjusted the wording of warnings shown while loading USD scenes in the Scene Viewer.

## 2026.9.3 (2026-09-15)

- Added a new Scene Viewer (experimental): load OpenUSD scenes whose materials are MaterialX, with lights, shadows, cameras, subdivision, transparency, screenshots and GIF recording.
- The Material Viewer can now record turntable GIFs.
- Saving in the Node Graph Editor now preserves your file's original formatting, comments and node order, changing only what you actually edited.
- Fixed the VS Code extension failing to open the Node Graph Editor, and fixed embeds not loading in Safari.

## 2026.9.2 (2026-09-14)

- Internal changes to how release packages are built and tested.
- This release's VS Code extension package was broken and has been removed; use v2026.9.3 or later instead.

## 2026.9.1 (2026-09-13)

- Added a desktop app for Windows, macOS and Linux, working fully offline with its own file menu, drag-and-drop opening, and crash recovery.
- Added a Material Gallery for browsing example and showcase materials, with search, filters, and a shared preset picker across tools.
- The Node Graph Editor can now create and edit node definitions, browse library nodes read-only, and autosave your work with a session browser.

## 2026.8.11 (2026-08-24)

- Added support for previewing materials on your own imported 3D models (`.obj`, `.glb`, `.gltf`).
- Added animated materials: MaterialX's time-based nodes now animate across every tool, with a new animated example.
- Added an introductory "What is MaterialX?" page, a procedural studio backdrop for the Viewer and Compare, and a visual refresh of the Node Specs and Node Graph Editor pages.

## 2026.8.10 (2026-08-21)

- Reworked the Viewer, Compare, Node Specs, Graph Editor and Embed Builder with docked panels, clearer settings, and a consistent look.
- The Node Graph Editor gained a menu bar, right-click menus, and in-place renaming of nodes.
- Fixed several small bugs, including a stale version number in the header and flicker in the Embed Builder.

## 2026.8.9 (2026-08-18)

- Added a dedicated page describing the VS Code extension, with a one-click download and setup steps.
- Updated the extension's own documentation to match its current behavior.

## 2026.8.8 (2026-08-18)

- Redesigned the home page with a live rotating material preview and clearer sections for tools, learning material, and integrations.
- Redesigned the site header with shorter tabs and grouped menus that hold up better on small screens.
- Embeds gained an option to disable zooming while still allowing drag-to-orbit.

## 2026.8.7 (2026-08-18)

- The embeddable viewer now stays quiet about settings that do not apply, instead of reporting them as errors.
- The default example material is now bundled with the site, so opening a viewer or embed no longer depends on GitHub being reachable.
- Expanded automated test coverage for the embeddable viewer.

## 2026.8.6 (2026-08-17)

- Added an embeddable version of the Material Viewer: a single script tag or a minimal page that other websites can drop in.
- The embed supports a custom camera, lighting, background, and material, plus a small API for controlling it from the host page.
- Added an Embed Builder tool that generates the embed code for you, with a live preview.

## 2026.8.5 (2026-08-16)

- The Compare tool can now load the same material under two different MaterialX versions to see how the render changes.
- A rendering error in the Graph Editor no longer blanks the whole page; it now offers a reload option instead.
- The site now detects when a new version has been published and offers to reload the page.

## 2026.8.4 (2026-08-11)

- The VS Code extension is now attached to every release as a downloadable, fully offline package.
- Fixed links inside the extension's preview panel that VS Code was blocking, and fixed the node documentation panel losing its place.

## 2026.8.3 (2026-08-11)

- Reworked transparent material rendering so overlapping transparent surfaces resolve in the correct order.
- Added a draped cloth preview geometry, useful for judging materials on a curved surface.
- Renamed the Compare tool and shader ball options for consistency across the site.

## 2026.8.2 (2026-08-09)

- Added the Material Compare tool: view two materials side by side, as a swipe, or as a live difference heatmap, with similarity statistics.
- Materials that translate between shading models now preview a live before-and-after comparison.
- Fixed several rendering bugs, including broken anisotropic highlights and upside-down textures.

## 2026.8.1 (2026-08-07)

- Redesigned node previews with a square viewport and an editable parameter panel alongside it.
- Added a flat "2D Buffer" preview mode, useful for patterns and other flat operations.
- The Node Graph Editor gained a delete-nodes button and a panel listing where a node's output is used.

## 2026.8.0 (2026-08-01)

First public release, built on MaterialX v1.39.5.

**[Try it live](https://joaovbs96.github.io/MaterialXPlayground/)**

### Node Library & Documentation

- Searchable reference for the entire MaterialX standard node library, organized by library and group, with each type signature documented individually.
- Port tables generated from the node definitions, with descriptions from the MaterialX specification where available.
- Live 3D preview of every node, with editable parameters.
- Implementation-target matrix per node (GLSL, ESSL, MSL, Slang, OSL, MDL), including nodegraph implementation sources.
- Shareable permalinks to every node's documentation.
- Export any node as `.mtlx` or send it to the Node Graph Editor.

### Material Viewer

- Drag-and-drop loading of `.mtlx` documents, alone or with textures (loose files, a folder, or a `.zip`).
- Image-based lighting from a built-in HDR environment, with an optional visible backdrop.
- Curated official MaterialX example materials, textures included.
- Interactive viewport: orbit and zoom, turntable, shaderball/sphere/cube geometry, material picker, save-as-PNG, fullscreen.
- Hand the current material off to the Node Graph Editor.

### Node Graph Editor

- Visual graph editing with add-node search, automatic wiring, and keyboard shortcuts.
- Quick insert from a wire, nested nodegraph editing with breadcrumbs, group and dissolve nodegraphs.
- Undo/redo, copy/paste, and one-click automatic layout.
- Live 3D preview of the selected node, with pinning.
- Document XML view with syntax highlighting, document validation, and a colorspace picker.
- Import/export `.mtlx`, including a `.zip` export that bundles textures; start from an empty document, a curated example, or a hand-off from the other pages.
- Cross-links to the Material Viewer and to each node's documentation.
