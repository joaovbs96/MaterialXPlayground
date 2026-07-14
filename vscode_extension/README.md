# MaterialX Playground (VS Code extension, v1)

Opens `.mtlx` files in this repo's MaterialX Playground web app (Material
Viewer or Node Graph Editor) inside a VS Code webview — sibling textures
and `xi:include` docs are resolved automatically, and the view live-
reloads as you edit the text. The **Material Viewer is read/view only**,
and switching to it always shows the Graph editor's current state — see
"Viewer/Graph sync" under Usage below. The **Node Graph Editor can write
back**: press **Ctrl+S** (Cmd+S on macOS) while it's the visible view to
save the current graph to the open `.mtlx` file — see "Node Graph Editor:
saving" under Usage below for what that does and doesn't do.

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
  Explorer) -> *Open With…* -> **MaterialX Playground**. Opens with the
  configured default view visible first (see Settings below).
- **Explorer context menu / Command Palette**: right-click a `.mtlx` file
  in the Explorer, or run from the Command Palette (`Ctrl+Shift+P`) with
  a `.mtlx` file active:
  - `Send to MaterialX Playground` — loads the file into both the
    Material Viewer and the Node Graph Editor at once; `materialx.defaultView`
    picks which one is shown first, and the header nav switches to the
    other, already-loaded view.
  - `MaterialX: Open Node Documentation` — opens the node-library docs
    view on its own, with no file involved.

### Node Graph Editor: saving

- **Ctrl+S / Cmd+S** while the Node Graph Editor is the visible view
  serializes the current graph and writes it back to the open `.mtlx`
  file (then saves the file to disk) — the same document VS Code's tab
  and the text editor show. This is wired as a real VS Code keybinding
  (scoped to the MaterialX Playground editor being active), not just an
  in-webview key listener, so it works reliably rather than racing VS
  Code's own webview-save handling — see "How Ctrl+S saves the Node
  Graph Editor" below. The written XML is the app's own canonical
  serialization: attribute order and whitespace may differ from what
  hand-editing the file would produce, even when the graph itself is
  unchanged. Ctrl+S in the Material Viewer or the docs view is a no-op
  (there's nothing there to save).
- Because the `.mtlx` file is the source of truth, any external change to
  it — hand-editing the text, another tool writing the file, `git
  checkout`, etc. — is picked up by live reload and replaces whatever's
  currently in the graph editor, **silently, with no "unsaved changes?"
  confirmation**. Save graph edits you want to keep with Ctrl+S before
  making (or accepting) an external change to the same file, or they'll
  be lost without warning.

### Viewer/Graph sync

- Both views load the same document, but only one is mounted/visible at a
  time. Switching to the **Material Viewer always shows the Node Graph
  Editor's current state** — including edits not yet saved with Ctrl+S —
  at the moment you switch: it's a one-way sync (Graph -> Viewer), read
  the instant the Viewer becomes visible. The Viewer never edits, so
  nothing needs to flow back the other way, and an external file change
  already reloads both views regardless.
- This means the Viewer **recompiles its shader on every switch** to it
  (same cost as any fresh load) — the site's background WASM warm-up is
  what keeps that from stalling the UI, not something instantaneous.

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
  which view (Material Viewer or Node Graph Editor) is shown first when a
  `.mtlx` file is opened. The document is loaded into both views either
  way; this only picks the initially visible one — use the header nav to
  switch to the other.

## Requirements

- **Network access.** The webview loads the same CDN-hosted libraries the
  site does in a browser (Tailwind, React, Babel standalone, three.js and
  its loaders/controls, KaTeX, JSZip, React Flow, dagre — lazy-loaded per
  view). There is no offline/vendored fallback in v1.

## v1 limitations

- **Write-back is Node Graph Editor-only, and only on Ctrl+S.** The
  webview holds an in-memory copy of the document (plus any resolved
  includes/textures); nothing is saved back to the `.mtlx` file until you
  press Ctrl+S while the Node Graph Editor is the visible view (see "Node
  Graph Editor: saving" under Usage). The Material Viewer has no
  write-back at all. Live reload still flows text editor -> webview the
  rest of the time — and, unlike a normal unsaved-changes prompt, an
  external edit **silently replaces** unsaved graph-editor changes rather
  than asking first.
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

- `src/extension.js` registers the custom editor and its three commands
  (send-to-playground, save-graph, open-docs).
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
  (`js/shared/mtlx-ui.jsx`), setting BOTH globals and dispatching BOTH
  events so the document is loaded into both views — the webview is, as
  far as the site's own code can tell, just another caller of that same
  hand-off, once per view.

### How the extension serves the MaterialX WASM payloads

The site's Emscripten glue loads its packed standard-library filesystem
and wasm binary (`js/JsMaterialX*.data` / `*.wasm`, ~1.5 MB / ~2 MB) via
plain `fetch()`. VS Code's webview resource pipeline alters those large
binaries in transit — the packed-FS slice offsets shift and the MaterialX
standard libraries fail to parse, which breaks the docs view and all
shader generation. So `media/bootstrap.js` intercepts exactly those
fetches and asks the extension host for the bytes instead
(`'mtlx-fetch'` -> `wireCommonWebviewMessages` in
`src/editorProvider.js`, which whitelists the path and reads the file
with `vscode.workspace.fs.readFile`), bypassing the pipeline. Any bridge
failure falls back to the webview's native `fetch`, so it is never worse
than not having the bridge.

### How Ctrl+S saves the Node Graph Editor

The primary path is a `package.json`-contributed keybinding:
`materialxPlayground.saveGraph` bound to `ctrl+s` / `cmd+s`, gated with
`"when": "activeCustomEditorId == 'materialxPlayground.editor'"` so it
only fires while a MaterialX Playground editor tab is active. A plain
in-webview keydown listener is NOT a reliable Ctrl+S responder on its
own — VS Code's workbench keybinding service can route the chord to its
own "save this webview" handling before, or instead of, the page ever
seeing the keydown — so the contributed keybinding, dispatched through
VS Code's own command system, is what makes Ctrl+S actually work.

`src/extension.js` registers that command as
`saveActiveGraph()` (`src/editorProvider.js`), which looks up the
currently-active panel/document — tracked in a module-level
`activePanelInfo`, updated on panel creation and on every
`onDidChangeViewState` where `panel.active` is true, and cleared on
dispose — and posts `{ type: 'mtlx-request-save' }` to that panel's
webview (or shows an info message if no MaterialX Playground editor is
active). `media/bootstrap.js` handles that message by calling
`requestGraphSave()`, the same function its own belt-and-suspenders
in-page keydown listener calls (kept for platforms/embeddings where the
chord IS delivered in-iframe). Either way, `requestGraphSave()` guards on
the Node Graph Editor actually being the mounted/visible view (via
`window.__mtlxGetGraphXml`, a hook `js/graph-app.jsx` exposes solely for
this extension) before doing anything — otherwise it's a silent no-op.
When it proceeds, it calls `window.__mtlxGetGraphXml()` to serialize the
current graph, then posts `{ type: 'mtlx-save', xml }` to the extension
host. `resolveCustomTextEditor` in `src/editorProvider.js` replaces the
open document's full text with that XML via a `WorkspaceEdit`, calls
`document.save()`, and replies `{ type: 'mtlx-save-result', ok }`; on
success the webview also calls `window.__mtlxMarkGraphSaved()` so the
graph editor's own unsaved-changes tracking agrees the session is saved.
That write-back fires the same `onDidChangeTextDocument` event live
reload watches, so `editorProvider.js` records the text it just wrote and
skips the resend for that one change — otherwise the graph editor would
immediately re-ingest its own just-saved output and lose undo
history/selection over data it JUST wrote.

### How the Viewer stays in sync with the Graph editor

`media/bootstrap.js` remembers the `name`/texture-blob map from the most
recent `mtlx-open` message and listens for `hashchange`. Whenever the
hash becomes `#!viewer` and `window.__mtlxGetGraphXml` exists (the Graph
editor has a live session), it re-serializes the graph and dispatches the
same `window.__mtlxPendingViewerImport` + `'mtlx-view-document'` contract
`mtlx-open` and the site's own "Send to Viewer" button use — so the
Viewer always reflects the Graph editor's latest state, including
unsaved edits, the instant it becomes visible.

### Diagnostics

Uncaught errors and unhandled promise rejections inside the webview are
forwarded to the **MaterialX Playground** output channel (View -> Output,
then pick it from the dropdown) — check there first when a view renders
blank or a shader never compiles.
