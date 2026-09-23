# MaterialX Playground for VS Code

Open `.mtlx` files right inside VS Code, with a 3D material preview and a visual node graph editor beside your text.

Edits stay in sync in both directions: change a value in the graph and the text updates, edit the text and the graph reloads.

Everything runs locally. The extension works fully offline and makes no network requests.

## Preview

This extension is published as a preview. Commands, settings and behavior may still change between releases.

Please report anything broken or confusing on the [issue tracker](https://github.com/joaovbs96/MaterialXPlayground/issues).

![VS Code with a .mtlx text editor on the left and the MaterialX Playground Node Graph Editor with a live 3D preview on the right.](https://joaovbs96.github.io/MaterialXPlayground/images/preview-vscode.jpg)

## What you get

- A visual editor for `.mtlx` files with the Node Graph Editor and the Material Viewer shown beside your text, kept in sync live.
- The Node Graph Editor edits the document: every settled change is written into the open file, and Ctrl+S saves it to disk.
- The Material Viewer is read only and always mirrors the graph editor's current state, including unsaved edits.
- XML and MaterialX validation with squiggles and entries in the Problems panel as you type.
- Hover documentation on node names in the text editor, with a link to the full node library reference.
- A standalone node library documentation panel you can browse without any file open.
- Textures and included files are found automatically from the workspace, no configuration needed.
- XML syntax highlighting for `.mtlx` files, plus comment toggling and auto closing tags, in any text editor.
- A status bar item that shows whether the current document is valid, with a shortcut to the Problems panel.
- No telemetry and no network access. Everything the extension needs ships inside the package.

## How it works

The extension opens the same `.mtlx` document in two connected views, the Node Graph Editor and the Material Viewer.

Typing in the text editor reloads both views a moment later.

Editing the graph writes the change straight back into the open document, so the text editor updates too and the file shows as unsaved until you save it.

Because both sides edit the same document, undo and redo are shared: undoing a graph edit is the same as undoing a text edit.

## Getting started

1. Install the extension and open a folder or file containing a `.mtlx` document.
2. Open a `.mtlx` file. The visual view opens automatically beside the text editor.
3. If it does not open, right click the file and choose Open With, then MaterialX Playground, or run a command below from the Command Palette (Ctrl+Shift+P / Cmd+Shift+P).

Available commands:

- `MaterialX Playground: Open MaterialX Document` opens the current `.mtlx` file in both views.
- `MaterialX Playground: Open Node Library Documentation` opens the node library reference on its own, with no file needed.
- `MaterialX Playground: Save Node Graph to File` saves the graph editor's current state to disk.
- `MaterialX Playground: Undo Node Graph Edit` and `MaterialX Playground: Redo Node Graph Edit` step through the shared undo history.

## Settings

All settings live under `MaterialX Playground` in VS Code's Settings UI.

| Setting | Default | What it does |
|---|---|---|
| `materialx.defaultView` | `graph` | Which view is shown first when you open a `.mtlx` file, the Node Graph Editor (`graph`) or the Material Viewer (`viewer`). Both views load the document either way. |
| `materialx.openBehavior` | `splitRight` | Where the visual view opens relative to the text editor. `splitRight` opens it beside the editor, reusing the same panel on repeat opens. `sameGroup` opens it in the active editor group instead. |
| `materialx.autoOpenPlayground` | `true` | Automatically opens the visual view beside the text editor whenever a `.mtlx` file is opened. |

## Keybindings

These apply while the Node Graph Editor is the active view.

| Keys (Windows / Linux) | Keys (macOS) | Action |
|---|---|---|
| Ctrl+S | Cmd+S | Save the graph to the open file. |
| Ctrl+Z | Cmd+Z | Undo, shared with the text editor's own undo history. |
| Ctrl+Shift+Z or Ctrl+Y | Cmd+Shift+Z | Redo. |

## Restricted Mode

The extension stays enabled in Restricted Mode (VS Code's workspace trust feature), but it does not open automatically when you open a `.mtlx` file.

Run `MaterialX Playground: Open MaterialX Document` to open it by hand.

Hover documentation, validation and the node library documentation panel all work normally regardless of workspace trust.

## Limitations

- Only the Node Graph Editor edits the document. The Material Viewer is read only and always shows the graph editor's latest state.
- Referenced textures and included files must be inside the workspace folder that contains the document, or next to the document itself when no folder is open.
- Very large documents skip the deeper MaterialX validation step and only get basic XML checks.
- Documents that use `xi:include` also get XML checks only, not the deeper MaterialX validation.
- Only one MaterialX version ships with the extension, so the side by side Material Comparison view from the web app is not available here.
- Each open `.mtlx` file runs its own preview session, so memory use grows with the number of open tabs.
- The first preview after opening a file can take a few seconds while the underlying engine warms up.

## Requirements

- Desktop VS Code 1.100 or later on Windows, macOS or Linux.
- A graphics driver capable of WebGL2, needed for the 3D previews.
- No account, sign in or extra download required. Everything ships inside the package.

## Upgrading from the GitHub release

If you previously installed this extension from a `.vsix` file attached to a GitHub release, uninstall the old `local.materialx-playground` extension first.

Its extension ID is different from the one now on the Marketplace, so the two could otherwise both stay installed at once.

## Links

- Website: [joaovbs96.github.io/MaterialXPlayground](https://joaovbs96.github.io/MaterialXPlayground/#!vscode)
- Issues: [github.com/joaovbs96/MaterialXPlayground/issues](https://github.com/joaovbs96/MaterialXPlayground/issues)
- Changelog: [github.com/joaovbs96/MaterialXPlayground/blob/main/CHANGELOG.md](https://github.com/joaovbs96/MaterialXPlayground/blob/main/CHANGELOG.md)
- License: [Apache 2.0](https://github.com/joaovbs96/MaterialXPlayground/blob/main/LICENSE)
