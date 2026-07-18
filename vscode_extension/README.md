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
**Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y** (Cmd+Z / Cmd+Shift+Z on macOS) map to
the Node Graph Editor's own undo/redo while the editor is focused, instead
of VS Code's text-document undo/redo — see "Node Graph Editor: undo/redo"
under Usage below.

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
  - `Send to MaterialX Playground` — loads the file into both the
    Material Viewer and the Node Graph Editor at once; `materialx.defaultView`
    picks which one is shown first, and the header nav switches to the
    other, already-loaded view. Only available for `.mtlx` files — the
    Command Palette entry is hidden entirely unless a `.mtlx` file is
    active, and the command itself is disabled outside that context. See
    "Opening the playground" below for *where* it opens.
  - `MaterialX: Open Node Documentation` — opens the node-library docs
    view on its own, with no file involved. Available from the Command
    Palette at any time (no `.mtlx` file needed), and also from the
    Explorer/editor-tab context menu on a `.mtlx` file, right alongside
    `Send to MaterialX Playground`.

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

### Node Graph Editor: undo/redo

- **Ctrl+Z** (undo) and **Ctrl+Shift+Z** / **Ctrl+Y** (redo) — Cmd+Z /
  Cmd+Shift+Z on macOS — while the Node Graph Editor is the visible view
  are wired as real VS Code keybindings, same as Ctrl+S, scoped to the
  MaterialX Playground editor being active. They intentionally **shadow VS
  Code's own text-document undo/redo**: without this, those chords would
  hit the open `.mtlx` document's text-undo stack instead (Ctrl+S's own
  `WorkspaceEdit` writes push onto that same stack), silently reverting
  the file's text underneath the live graph session and letting live
  reload clobber whatever the graph editor had in memory. Instead they're
  routed to the graph editor's own in-page undo/redo, so the file on disk
  is untouched until you next press Ctrl+S. A focused text field (e.g. a
  parameter's label input) handles the chord itself first, as usual — its
  native undo, not the graph's. Outside the Node Graph Editor (Viewer,
  docs view, or no MaterialX Playground editor active) this is a no-op.

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
  comments, and `<>`/quotes auto-close and surround a selection. The
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
    like a node graph referencing a nonexistent node. Because this
    build's `validate()` binding is boolean-only (no message strings) and
    the WASM binding hands back no character offsets at all, the
    resulting diagnostics are a best-effort scan for dangling references
    and their squiggle lands near the *named* element rather than at an
    exact reported column — an accepted approximation, not a bug.
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
- **Hover documentation**: hovering a node **category** — an element tag
  name like `<standard_surface>` or `<mix>` (MaterialX nodes are just
  elements named by category), or the value of a `node="..."` attribute
  (`<nodedef>`/`<materialassign>` references) — shows that node's
  description straight from the MaterialX specification (parsed from the
  `MaterialX.PBRSpec.md` / `MaterialX.NPRSpec.md` /
  `MaterialX.StandardNodes.md` files — read from `vendor/materialx/` when
  present (the offline build, populated by `npm run vendor:offline`),
  otherwise fetched once from the MaterialX repository on GitHub and
  cached in memory for the rest of the session) plus an
  **Open documentation** link that opens/reuses the
  `MaterialX: Open Node Documentation` panel scoped directly to that
  node. Structural/document elements — `<materialx>`, `<nodegraph>`,
  `<input>`, `<output>`, `<nodedef>`, `<look>`, `<xi:include>`, and
  similar schema scaffolding — never produce a hover, only actual node
  categories do. A category with no matching spec entry (e.g. a custom
  node defined outside the standard libraries) still gets a headline plus
  the Open documentation link; the docs site resolves name-only
  permalinks by search rather than requiring an exact spec match.
- **Docs panels default to 3D previews off**: the node documentation
  panel's per-node 3D previews — whether opened via
  `MaterialX: Open Node Documentation` or a hover's Open documentation
  link above — start with 3D previews switched OFF. Each preview is its
  own WASM shader-gen + WebGL context, which is heavy to pile on top of a
  VS Code webview that, in practice, often already has a live MaterialX
  Playground editor tab running its own such session. Toggling previews
  on in the docs view's own UI sticks for the rest of that webview's
  session (it does not silently flip back off); this default is scoped
  to docs panels only — the Material Viewer/Node Graph Editor views never
  read this preference at all.

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
  docs view's Copy-link and open-in-new-tab actions.
- **Write-back is Node Graph Editor-only, and only on Ctrl+S.** The
  webview holds an in-memory copy of the document (plus any resolved
  includes/textures); nothing is saved back to the `.mtlx` file until you
  press Ctrl+S while the Node Graph Editor is the visible view (see "Node
  Graph Editor: saving" under Usage). The Material Viewer has no
  write-back at all. Live reload still flows text editor -> webview the
  rest of the time — and, unlike a normal unsaved-changes prompt, an
  external edit **silently replaces** unsaved graph-editor changes rather
  than asking first.
- The graph editor's **node-documentation dialog** (the "?" button on the
  parameter panel) renders the docs view INLINE inside the same webview —
  no iframe, no separate panel — identical to the website. The
  `MaterialX: Open Node Documentation` command-palette panel described
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
  `media/webview.html` (a hand-maintained mirror of `../index.html`'s
  `<head>`/`<body>`, kept in sync — see the comment at the top of that
  file) and wires up the extension<->webview messaging + live reload.
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
  with the same link/bold/italic/entity cleanup), extracting only the
  per-node DESCRIPTION text — not the full doc database (notes, port
  tables, references) `js/spec-parser.js` builds for the website itself —
  from the three spec `.md` files, vendor-first/remote-fallback like the
  site's own `js/mtlx-assets.js` resolver: read from `vendor/materialx/`
  when present, otherwise fetched once from GitHub. Merged in and cached
  in memory for the life of the extension host process as each file's
  text becomes available (synchronously for a vendored file, or
  asynchronously once its remote fetch settles).
- `src/hoverProvider.js` registers the hover provider: detects a node
  category under the cursor (an element tag name, excluding structural/
  document elements, or a `node="..."` attribute value), looks it up via
  `src/specDocs.js`, and renders a trusted `MarkdownString` with the
  description and an `Open documentation` command link.
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
