# MaterialX Playground (VS Code extension, v1)

Opens `.mtlx` files in this repo's MaterialX Playground web app (Material
Viewer or Node Graph Editor) inside a VS Code webview — sibling textures
and `xi:include` docs are resolved automatically, and the view live-
reloads as you edit the text. **v1 is read/view only** — edits made in
the webview (e.g. dragging a node in the graph editor) are not written
back to the file on disk.

This extension is plain CommonJS JavaScript, no build step, no npm
dependencies — it runs directly out of a checkout of this repo.

## Running it (development)

1. Open this repo's root folder in VS Code (the folder containing
   `index.html`, `js/`, and `vscode_extension/`).
2. Press **F5** (or Run and Debug -> **"Run Extension"**). This uses the
   `.vscode/launch.json` config at the repo root, which launches a second
   "Extension Development Host" window with the extension loaded from
   `vscode_extension/`.
3. In that new window, open (or create) a `.mtlx` file.

## Usage

- **Open With…**: right-click a `.mtlx` file (in the editor tab or the
  Explorer) -> *Open With…* -> **MaterialX Playground**. Opens the
  configured default view (see Settings below).
- **Explorer context menu / Command Palette**: right-click a `.mtlx` file
  in the Explorer, or run from the Command Palette (`Ctrl+Shift+P`) with
  a `.mtlx` file active:
  - `MaterialX: Open in Material Viewer`
  - `MaterialX: Open in Node Graph Editor`
  - `MaterialX: Open Node Documentation` — opens the node-library docs
    view on its own, with no file involved.

### Making it the default editor for `.mtlx` files

The custom editor is registered with `"priority": "option"`, so it won't
auto-take-over `.mtlx` files (it shows up in *Open With…* instead of
replacing the default text editor). To make it the default, add to your
`settings.json`:

```json
"workbench.editorAssociations": {
    "*.mtlx": "materialxPlayground.editor"
}
```

## Settings

- `materialx.defaultView` (`"viewer"` | `"graph"`, default `"viewer"`) —
  which view a `.mtlx` file opens into when launched via *Open With…* /
  double-click, rather than one of the explicit "Open in ..." commands.

## Requirements

- **Network access.** The webview loads the same CDN-hosted libraries the
  site does in a browser (Tailwind, React, Babel standalone, three.js and
  its loaders/controls, KaTeX, JSZip, React Flow, dagre — lazy-loaded per
  view). There is no offline/vendored fallback in v1.

## v1 limitations

- **No write-back.** The webview holds an in-memory copy of the document
  (plus any resolved includes/textures); nothing you do inside the
  Material Viewer or Node Graph Editor is saved back to the `.mtlx` file.
  Live reload only flows one direction: text editor -> webview.
- The graph editor's **node-documentation dialog** (the little popup that
  embeds `index.html?embed=1#/...` in an iframe) may render blank —
  it depends on the same-origin webview-resource iframe path working
  end-to-end, which hasn't been exercised under VS Code's webview host.
- **`localStorage`-backed preferences** (e.g. remembered UI toggles) may
  not persist across VS Code sessions/reloads — webview storage semantics
  differ from a normal browser tab.
- **First shader compile** after opening a file is a background WASM
  warm-up (MaterialX standard libraries + shader generation) and can take
  a few seconds before the render updates.
- **Multiple open `.mtlx` tabs** each get their own webview (own WASM
  instance, own WebGL context) — memory and GPU context usage multiply
  per open tab. `retainContextWhenHidden` is enabled so backgrounded tabs
  don't lose their state, at the cost of keeping that memory around.
- This extension runs the site straight from the repo checkout
  (`vscode_extension/src/editorProvider.js`'s `repoRootUri` points one
  directory up, at `../`). Packaging this as a `.vsix` for distribution
  would need the site's files copied INTO the extension first — an
  installed extension cannot reach outside its own install directory at
  runtime.

## How it works (brief)

- `src/extension.js` registers the custom editor and the three commands.
- `src/editorProvider.js` builds the webview's HTML from
  `media/webview.html` (a hand-maintained mirror of `../index.html`'s
  `<head>`/`<body>`, kept in sync — see the comment at the top of that
  file) and wires up the extension<->webview messaging + live reload.
- `src/docScanner.js` is a Node-side port of the site's own
  `xi:include`/texture-reference crawler (`js/mtlx-engine.js`
  `resolveIncludes`, `js/graph-app.jsx` `extractFilenameRefs` +
  `loadPreset`'s BFS), so the same resolution logic runs against the real
  filesystem instead of an in-memory drag-and-drop file map.
- `media/bootstrap.js` runs first inside the webview and adapts the
  extension's message into the exact
  `window.__mtlxPendingImport`/`__mtlxPendingViewerImport` +
  `'mtlx-load-document'`/`'mtlx-view-document'` contract the site's own
  "Send to Viewer"/"Send to Editor" buttons use
  (`js/shared/mtlx-ui.jsx`), so the webview is, as far as the site's own
  code can tell, just another caller of that same hand-off.
