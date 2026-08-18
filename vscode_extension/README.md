# MaterialX Playground (VS Code extension, v1)

Opens `.mtlx` files in this repo's MaterialX Playground web app (Material
Viewer or Node Graph Editor) inside a VS Code webview: sibling textures
and `xi:include` docs are resolved automatically, and the view live-
reloads as you edit the text. The **Material Viewer is read/view only**,
and switching to it always shows the Graph editor's current state (see
"Viewer/Graph sync" under Usage below). The **Node Graph Editor edits the
document**: every settled graph edit is written straight into the open
`.mtlx` document buffer, so a text editor on the same file updates live
and the tab shows unsaved changes; **Ctrl+S** (Cmd+S on macOS) saves the
file to disk (see "Node Graph Editor: editing and saving" under Usage
below). **Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y** (Cmd+Z / Cmd+Shift+Z on macOS)
while the Node Graph Editor is focused run VS Code's own document
undo/redo, so graph edits and hand-typed edits share one history (see
"Node Graph Editor: undo/redo" under Usage below).

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
- **Explorer context menu / editor tab context menu / Command Palette**:
  right-click a `.mtlx` file (in the Explorer or an editor tab), or run
  from the Command Palette (`Ctrl+Shift+P`):
  - `MaterialX Playground: Open MaterialX Document` — loads the file into both the
    Material Viewer and the Node Graph Editor at once; `materialx.defaultView`
    picks which one is shown first, and the header nav switches to the
    other, already-loaded view. Only available for `.mtlx` files — the
    Command Palette entry is hidden entirely unless a `.mtlx` file is
    active, and the command itself is disabled outside that context. See
    "Opening the playground" below for *where* it opens.
  - `MaterialX Playground: Open Node Library Documentation` — opens the node-library docs
    view on its own, with no file involved. Available from the Command
    Palette at any time (no `.mtlx` file needed), and also from the
    Explorer/editor-tab context menu on a `.mtlx` file, right alongside
    `MaterialX Playground: Open MaterialX Document`.

### Opening the playground

- **Placement** (`materialx.openBehavior`, default `"splitRight"`): when
  a text editor for the same `.mtlx` file is already open and visible,
  the playground opens **beside it**, reusing an existing right-hand
  editor group on repeat opens instead of creating a fresh split every
  time. Set this to `"sameGroup"` to instead always open in the active
  editor group (the previous behavior). If there's no open text editor
  for the file to split against (e.g. an Explorer right-click on a file
  nothing has opened yet), or a playground tab for the file is already
  open somewhere, the extension falls back sensibly — opening in the
  active group, or revealing the existing playground tab, respectively —
  regardless of this setting.
- **Auto-open** (`materialx.autoOpenPlayground`, default `true`): when
  enabled, opening (or switching to) a `.mtlx` file automatically opens
  the playground beside it, without stealing keyboard focus from the text
  editor. This fires once per file per "open": closing the playground tab
  by hand does not pop it back open just by switching away from and back
  to the same `.mtlx` editor — only closing and reopening the `.mtlx`
  file itself re-arms it.

### Node Graph Editor: editing and saving

- **Graph edits sync into the document buffer as you make them.**
  Whenever a coalesced graph edit settles (a short debounce after the
  last change: dragging a slider only updates the live preview, and the
  edit lands in the document once, shortly after you release it), the
  Node Graph Editor serializes the whole document and the extension
  replaces the open `.mtlx` document's text with it via a
  `WorkspaceEdit`. Nothing is written to disk at that point: the tab
  shows the unsaved-changes dot, any text editor open on the same file
  updates live, and VS Code's normal dirty-file handling applies from
  there. The written XML is the app's own canonical serialization:
  attribute order and whitespace may differ from what hand-editing the
  file would produce, even when the graph itself is unchanged.
- **Ctrl+S / Cmd+S** while the Node Graph Editor is the visible view
  serializes the current graph, writes it to the document, and saves the
  file to disk. This is wired as a real VS Code keybinding (scoped to
  the MaterialX Playground editor being active), not just an in-webview
  key listener, so it works reliably rather than racing VS Code's own
  webview-save handling (see "How Ctrl+S saves the Node Graph Editor"
  below). Because the buffer is already in sync, plain Ctrl+S in the
  text editor saves the same content. Ctrl+S in the Material Viewer or
  the docs view is a no-op (there's nothing there to save).
- **Live reload runs the other way.** Any change to the open document's
  text (typing in the text editor, a formatter, VS Code reloading a
  clean file after an on-disk change) is picked up on a short debounce
  and reloaded into both views. The extension's own buffer syncs and
  saves are excluded from that reload, so the graph editor never
  re-ingests its own output.

### Node Graph Editor: undo/redo

- **Ctrl+Z** (undo) and **Ctrl+Shift+Z** / **Ctrl+Y** (redo), Cmd+Z /
  Cmd+Shift+Z on macOS, while the Node Graph Editor is the visible view
  are wired as real VS Code keybindings, same as Ctrl+S, scoped to the
  MaterialX Playground editor being active. They run **VS Code's own
  document undo/redo** on the open `.mtlx` document; the graph editor
  keeps no separate undo stack under VS Code. Because every graph edit is
  already synced into that document, its native undo history holds graph
  edits and hand-typed edits alike, in one sequence. The resulting text
  change flows back into the webview through the normal live-reload path,
  immediately (the reload debounce is skipped for undo/redo), so the
  graph re-renders the undone or redone state. A focused text field (e.g.
  a parameter's label input) handles the chord itself first, as usual:
  its native undo, not the document's. Outside the Node Graph Editor
  (Viewer, docs view, or no MaterialX Playground editor active) this is a
  no-op.

### Viewer/Graph sync

- Both views load the same document, but only one is mounted/visible at a
  time. Switching to the **Material Viewer always shows the Node Graph
  Editor's current state** — including edits not yet saved to disk —
  at the moment you switch: it's a one-way sync (Graph -> Viewer), read
  the instant the Viewer becomes visible. The Viewer never edits, so
  nothing needs to flow back the other way, and an external file change
  already reloads both views regardless.
- This means the Viewer **recompiles its shader on every switch** to it
  (same cost as any fresh load) — the site's background WASM warm-up is
  what keeps that from stalling the UI, not something instantaneous.

### Optional: opening `.mtlx` files straight into the Playground

Nothing needs configuring for the default experience: the custom editor
is registered with `"priority": "option"`, so a `.mtlx` file opens in VS
Code's normal text editor, and `materialx.autoOpenPlayground` (default
`true`, see "Opening the playground" above) opens the Playground beside
it. If you would rather have `.mtlx` files open straight into the
Playground with no text editor, make it the default editor in your
`settings.json`:

```json
"workbench.editorAssociations": {
    "*.mtlx": "materialxPlayground.editor"
}
```

Auto-open only triggers when a `.mtlx` text editor becomes active, so in
this mode the Playground opens on its own; the text editor stays
reachable through *Open With…* -> *Text Editor*.

## Language features (`.mtlx` editing, validation, hover docs)

These work in **any** editor for a `.mtlx` file — including VS Code's plain
built-in text editor, not just the MaterialX Playground custom editor
above — because they're registered against the `mtlx` language id
(`.mtlx` files activate it automatically), independent of the custom
editor.

- **Syntax highlighting**: `.mtlx` files get XML-style syntax highlighting
  (the bundled grammar just includes VS Code's own built-in `text.xml`
  grammar — no MaterialX-specific tokenizing to maintain) plus
  language-aware editing behavior: `Ctrl+/` toggles `<!-- -->` block
  comments, quotes auto-close, and `<>`/quotes surround a selection. The
  language mode shows as "MaterialX" in the status bar.
- **Live validation** (Problems squiggles + status bar), in two tiers,
  re-run on a 400ms debounce as you type:
  - **Tier 1 — XML well-formedness.** A small, dependency-free scanner
    (this extension ships **zero** npm dependencies) that tokenizes tags
    and attributes to catch mismatched/unclosed tags, malformed
    attributes, duplicate attributes, and stray unescaped `&`/`<` —
    with precise `{line, character}` squiggle ranges.
  - **Tier 2 — MaterialX semantic validation.** Runs only once tier 1 is
    clean: loads the same bundled MaterialX WASM build the Material
    Viewer/Node Graph Editor use (headless, inside the extension host)
    and actually parses + `validate()`s the document — catching things
    like a node graph referencing a nonexistent node. The message-holder
    overload of `validate()` gives back MaterialX's real diagnostic text
    but no character offsets, so each squiggle is placed by locating the
    named element in the document text (when several elements share a
    name, the one whose other attributes best match wins); it can
    occasionally land on the wrong occurrence of a common name. That is
    an accepted approximation of the binding, not a bug.
  - If the WASM build fails to load — most commonly a CRLF-corrupted
    `JsMaterialXGenShader.data` archive from a bad Windows checkout of
    this binary file — tier 2 silently and **permanently** degrades to
    tier-1-only for the rest of that session (retrying on every
    keystroke would be both slow and pointless). XML validation keeps
    working regardless, and the reason is logged once to the
    **MaterialX Playground** output channel.
  - A status bar item, visible only while a `.mtlx` editor is active,
    shows `$(check) MaterialX` when the open document is clean or
    `$(error) MaterialX: N` with a tooltip listing the first few issues;
    click it to jump to the Problems panel.
- **Hover documentation**: hovering a node **category** in a `.mtlx`
  text editor, an element tag name like `<standard_surface>` or `<mix>`
  (MaterialX nodes are just elements named by category), or the value of
  a `node="..."` attribute (`<nodedef>`/`<materialassign>` references),
  shows that node's description plus its port table (inputs/outputs,
  matched to the hovered element's own signature when derivable)
  straight from the MaterialX specification (parsed from the
  `MaterialX.PBRSpec.md` / `MaterialX.NPRSpec.md` /
  `MaterialX.StandardNodes.md` files — read from `vendor/materialx/` when
  present (the offline build, populated by `npm run vendor:offline`),
  otherwise fetched once from the MaterialX repository on GitHub and
  cached in memory for the rest of the session) plus an
  **Interactive Documentation** link that opens/reuses the
  `MaterialX Playground: Open Node Library Documentation` panel scoped
  directly to that node. When the node has a known spec page, an
  **Official Specification** link to it follows. Structural/document
  elements — `<materialx>`, `<nodegraph>`, `<input>`, `<output>`,
  `<nodedef>`, `<look>`, `<xi:include>`, and similar schema scaffolding —
  never produce a hover, only actual node categories do. A category with
  no matching spec entry (e.g. a custom node defined outside the
  standard libraries) still gets a headline plus the Interactive
  Documentation link; the docs site resolves name-only permalinks by
  search rather than requiring an exact spec match.
- **Docs panels default to 3D previews off**: the node documentation
  panel's per-node 3D previews — whether opened via
  `MaterialX Playground: Open Node Library Documentation` or a hover's
  Interactive Documentation link above — start with 3D previews switched
  OFF. Each preview is its own WASM shader-gen + WebGL context, which is
  heavy to pile on top of a VS Code webview that, in practice, often
  already has a live MaterialX Playground editor tab running its own
  such session. Toggling previews on in the docs view's own UI sticks
  for the rest of that webview's session (it does not silently flip back
  off); this default is scoped to docs panels only — the Material
  Viewer/Node Graph Editor views never read this preference at all.

## Settings

- `materialx.defaultView` (`"viewer"` | `"graph"`, default `"graph"`) —
  which view (Material Viewer or Node Graph Editor) is shown first when a
  `.mtlx` file is opened. The document is loaded into both views either
  way; this only picks the initially visible one — use the header nav to
  switch to the other.
- `materialx.openBehavior` (`"splitRight"` | `"sameGroup"`, default
  `"splitRight"`) — where the playground opens when a text editor for the
  same `.mtlx` file is visible: `"splitRight"` opens it beside that
  editor, reusing an existing right-hand editor group instead of
  splitting again on every open; `"sameGroup"` opens it in the active
  editor group instead (the previous behavior). See "Opening the
  playground" under Usage above for the fallback behavior when there's
  nothing to split against.
- `materialx.autoOpenPlayground` (boolean, default `true`) —
  automatically open the playground beside the text editor whenever a
  `.mtlx` file is opened. See "Opening the playground" under Usage above
  for exactly when this re-triggers.

## Requirements

- **One-time setup: `npm install && npm run vendor`.** The webview loads
  the same third-party libraries the site does in a browser (Tailwind,
  React, Babel standalone, three.js and its loaders/controls, KaTeX,
  JSZip, React Flow, dagre — lazy-loaded per view), but all of them are
  vendored into a committed `vendor/` folder at pinned versions and served
  locally — no network access needed to run the webview itself. The one
  exception is MaterialX spec/template/example documents: these are
  fetched from `raw.githubusercontent.com` on demand unless a local
  `vendor/materialx/` snapshot is present, in which case they're read
  from disk instead. A packaged offline build
  ships that snapshot and performs zero network access. Run `npm run
  vendor:offline` to populate that snapshot yourself.

## v1 limitations

- **The webview hides browser-only / multi-document UI** that doesn't make
  sense when the editor is bound to a single already-opened `.mtlx` file:
  the Home nav, New/Import/Presets, drag & drop, the Viewer's file sidebar
  (the Viewer fills the tab instead, and its material picker moves to the
  viewport overlay), the Send-to-Viewer/Send-to-Editor buttons (both views
  are always in sync already — see "Viewer/Graph sync" below), and the
  docs view's Copy-link and open-in-new-tab actions. The header nav itself
  drops the Docs tab too, leaving only Viewer and Graph — node
  documentation stays reachable through the graph editor's own
  node-documentation dialog and hover links, or the separate
  `MaterialX Playground: Open Node Library Documentation` command, rather
  than through a nav tab duplicating that content in-line.
- **Only the Node Graph Editor edits the document; the Material Viewer
  is read-only.** Graph edits sync into the open `.mtlx` document buffer
  as they settle and Ctrl+S saves to disk (see "Node Graph Editor:
  editing and saving" under Usage). Each sync replaces the whole
  document with the app's own serialization, so attribute order and
  formatting can differ from hand-written XML.
- The graph editor's **node-documentation dialog** (the "?" button on the
  parameter panel) renders the docs view INLINE inside the same webview —
  no iframe, no separate panel — identical to the website. The
  `MaterialX Playground: Open Node Library Documentation` command-palette panel described
  above still exists separately, for browsing the node library without a
  file open.
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
- **Only the default MaterialX version ships in the `.vsix`**
  (`.vscodeignore` drops the others), so the Material Comparison view,
  the one feature that needs several versions side by side, stays
  web-only; the webview nav has just Viewer and Graph.
- The repo root is the extension's `package.json`/install root, so a
  packaged `.vsix` (`vsce package`) bundles the site's files alongside
  `vscode_extension/` automatically — no separate copy step needed.

## How it works (brief)

- `src/extension.js` registers the custom editor, its commands
  (send-to-playground, save-graph, undo/redo-graph, open-docs — the last
  accepts an optional node-category argument, see hover documentation
  above), the diagnostic collection + status bar (`src/validator.js`),
  and the hover provider (`src/hoverProvider.js`).
- `src/editorProvider.js` builds the webview's HTML from
  `media/webview.html` (generated from `../index.html` by
  `scripts/build-webview.mjs` — see the comment at the top of that file,
  and [How this repo is built](../docs/BUILDING.md) in the root docs)
  and wires up the extension<->webview messaging + live reload.
  Also backs the document-less docs panel singleton
  (`materialxPlayground.openDocs`), threading an arbitrary `location.hash`
  (`#!docs`, or `#/<category>` for a hover's deep link) through to a
  fresh panel or a re-navigated existing one.
- `src/docScanner.js` is a Node-side port of the site's own
  `xi:include`/texture-reference crawler (`js/mtlx-engine.js`
  `resolveIncludes`, `js/graph-app.jsx` `extractFilenameRefs` +
  `loadPreset`'s BFS), so the same resolution logic runs against the real
  filesystem instead of an in-memory drag-and-drop file map.
- `src/validator.js` is the two-tier `.mtlx` diagnostics engine described
  under "Live validation" above: a dependency-free XML tokenizer (tier 1)
  plus `src/mtlxNode.js`, a headless (no rendering/WebGL touched) loader
  for the bundled MaterialX WASM build used for tier 2's actual
  parse/`validate()` pass.
- `src/specDocs.js` is a trimmed, Node-side port of `js/spec-parser.js`'s
  markdown state machine (anchors/headings -> following paragraph text,
  Port-column tables, with the same link/bold/italic/entity cleanup),
  extracting the per-node DESCRIPTION text and PORT TABLES — not the full
  doc database (notes, references) `js/spec-parser.js` builds for the
  website itself — from the three spec `.md` files, vendor-first/remote-fallback like the
  site's own `js/mtlx-assets.js` resolver: read from `vendor/materialx/`
  when present, otherwise fetched once from GitHub. Merged in and cached
  in memory for the life of the extension host process as each file's
  text becomes available (synchronously for a vendored file, or
  asynchronously once its remote fetch settles).
- `src/hoverProvider.js` registers the hover provider: detects a node
  category under the cursor (an element tag name, excluding structural/
  document elements, or a `node="..."` attribute value), looks it up via
  `src/specDocs.js`, and renders a trusted `MarkdownString` with the
  description, an `Interactive Documentation` command link, and, when
  the node has a known spec page, an `Official Specification` link.
- `media/bootstrap.js` runs first inside the webview and adapts the
  extension's message into the exact
  `window.__mtlxPendingImport`/`__mtlxPendingViewerImport` +
  `'mtlx-load-document'`/`'mtlx-view-document'` contract the site's own
  "Send to Viewer"/"Send to Editor" buttons use
  (`js/shared/mtlx-ui.jsx`), setting BOTH globals and dispatching BOTH
  events so the document is loaded into both views — the webview is, as
  far as the site's own code can tell, just another caller of that same
  hand-off, once per view. It also exposes `window.__mtlxNotifyEdit`,
  which `js/graph-app.jsx`'s `flushUndoSnapshot` calls with the
  serialized document each time a coalesced edit settles; bootstrap
  posts that as `'mtlx-sync'` and `resolveCustomTextEditor` applies it
  to the document with a `WorkspaceEdit` (no `document.save()`).

### How the extension serves the MaterialX WASM payloads

The site's Emscripten glue loads its packed standard-library filesystem
and wasm binary (`js/materialx/<version>/JsMaterialX*.data` / `*.wasm`,
~1.5 MB / ~2 MB) via plain `fetch()`. VS Code's webview resource pipeline alters those large
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
Both the `'mtlx-save'` and `'mtlx-sync'` writes fire the same
`onDidChangeTextDocument` event live reload watches, as do any
save-participant edits VS Code applies inside `document.save()`.
`editorProvider.js` therefore keeps a `hostEditDepth` counter,
incremented before each of its own `applyEdit` calls and decremented
once the operation settles, and skips scheduling a resend while it is
above zero; otherwise the graph editor would immediately re-ingest its
own just-written output and lose undo history/selection over data it
JUST wrote.

### How undo/redo works

`materialxPlayground.undoGraph` / `redoGraph` (Ctrl+Z / Ctrl+Shift+Z /
Ctrl+Y, gated with the same `activeCustomEditorId` `when` clause as
Ctrl+S) post `'mtlx-request-undo'` / `'mtlx-request-redo'` to the active
panel. `media/bootstrap.js` no-ops unless the Graph view is visible and
focus is not in an editable element, then posts `'mtlx-native-undo'` /
`'mtlx-native-redo'` back. `editorProvider.js` runs VS Code's own `undo`
/ `redo` command on the document, deliberately outside the
`hostEditDepth` suppression, cancels any pending debounced resend, and
calls `sendUpdate()` right away so the graph re-renders the result
without waiting for the debounce.

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
