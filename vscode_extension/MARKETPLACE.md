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
- Open USD stages (`.usd`, `.usda`, `.usdc`, `.usdz`) in the experimental USD Scene Viewer, with their sublayers, references, payloads, MaterialX materials and textures loaded from the workspace. Double-click a surface to inspect its material, or open it in the Node Graph Editor. It opens automatically when you open a USD scene file, no different from the visual view opening for a `.mtlx` file.
- A "New Material from Example" command that copies a ready-made standard_surface or OpenPBR material (with any textures it needs) into your workspace, then opens it in the playground.
- XML syntax highlighting for `.mtlx` files, plus comment toggling and auto closing tags, in any text editor.
- Ready-made snippets for common patterns: a new document, a standard surface or OpenPBR material, a texture lookup, a normal map, a node graph with an output, and a typed input.
- Auto-complete for node names, node inputs, and the attributes each element actually supports (type, color space, units, node names, outputs and more), narrowed to what's valid at that spot as you type.
- A status bar item that shows whether the current document is valid, with a shortcut to the Problems panel.
- A toolbar button on `.mtlx` text editors that opens the visual view beside your text, like Markdown's preview button.
- `.mtlx` files show a recognizable file icon in the Explorer and on editor tabs, matching light and dark themes.
- An outline of materials, node graphs, node definitions and their inputs and outputs, with breadcrumbs and Go to Symbol.
- Go to Definition and Find All References for node, node graph, output, interface and node definition references in the text.
- Color swatches next to color values in the text editor, with a picker that writes the color back in the same format.
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
- `MaterialX Playground: New Material from Example` copies a chosen example material into a folder you pick and opens it, also available by right clicking a folder in the Explorer.
- `MaterialX Playground: Open in USD Scene Viewer` opens the current `.usd`, `.usda`, `.usdc` or `.usdz` file in the USD Scene Viewer, also available by right clicking the file in the Explorer or with Open With.

## Settings

All settings live under `MaterialX Playground` in VS Code's Settings UI.

| Setting | Default | What it does |
|---|---|---|
| `materialxPlayground.defaultView` | `graph` | Which view is shown first when you open a `.mtlx` file, the Node Graph Editor (`graph`) or the Material Viewer (`viewer`). Both views load the document either way. |
| `materialxPlayground.openBehavior` | `splitRight` | Where the visual view opens relative to the text editor. `splitRight` opens it beside the editor, reusing the same panel on repeat opens. `sameGroup` opens it in the active editor group instead. |
| `materialxPlayground.autoOpenPlayground` | `true` | Automatically opens the visual view beside the text editor whenever a `.mtlx` file is opened. |
| `materialxPlayground.autoOpenSceneViewer` | `true` | Automatically opens the USD Scene Viewer for a USD scene file (`.usd`, `.usda`, `.usdc`, `.usdz`). A text file opens the viewer beside the text editor; a binary file has its tab replaced by the viewer. |

The older `materialx.defaultView`, `materialx.openBehavior` and `materialx.autoOpenPlayground` names still work if you already set them; VS Code will show them as deprecated in favor of the names above.

## Keybindings

These apply while the Node Graph Editor is the active view.

| Keys (Windows / Linux) | Keys (macOS) | Action |
|---|---|---|
| Ctrl+S | Cmd+S | Save the graph to the open file. |
| Ctrl+Z | Cmd+Z | Undo, shared with the text editor's own undo history. |
| Ctrl+Shift+Z or Ctrl+Y | Cmd+Shift+Z | Redo. |

## Restricted Mode

The extension stays enabled in Restricted Mode (VS Code's workspace trust feature), but it does not open automatically when you open a `.mtlx` file or a USD scene file.

Run `MaterialX Playground: Open MaterialX Document` or `MaterialX Playground: Open in USD Scene Viewer` to open one by hand.

Hover documentation, validation and the node library documentation panel all work normally regardless of workspace trust.

## Limitations

- Only the Node Graph Editor edits the document. The Material Viewer is read only and always shows the graph editor's latest state.
- Referenced textures and included files must be inside the workspace folder that contains the document, or next to the document itself when no folder is open.
- Very large documents skip the deeper MaterialX validation step and only get basic XML checks.
- Documents that use `xi:include` also get XML checks only, not the deeper MaterialX validation.
- Only one MaterialX version ships with the extension, so the side by side Material Comparison view from the web app is not available here.
- Each open `.mtlx` file runs its own preview session, so memory use grows with the number of open tabs.
- The first preview after opening a file can take a few seconds while the underlying engine warms up.
- The USD Scene Viewer loads the files in the root layer's folder plus the files that text (`.usda`) layers and `.mtlx` documents reference, up to 4,000 files and 4 GiB. Files referenced only from binary `.usdc` layers must sit in the root layer's folder.
- The USD Scene Viewer shows the opened file only: there is no drag and drop or file picker, and the 3D preview in its material panel is not available in VS Code.
- Graph edits to a material opened from a USD scene cannot be saved into the USD file. Use Export .mtlx in the Node Graph Editor to save the material as a separate file.

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
