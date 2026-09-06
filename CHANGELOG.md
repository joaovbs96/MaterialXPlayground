# Changelog

Notable changes to MaterialX Playground, newest first. Versions are calendar-based (`YYYY.M.patch`); see [Versioning](README.md#versioning) in the README.

## Unreleased

### Material Viewer

- Record button: export a 360° turntable GIF (size, duration, frame rate and dithering options; encoded off the main thread).

### USD Scene Viewer

- Record button with the same 360° turntable GIF export.

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
