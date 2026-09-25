# MaterialX Playground for VS Code

Build, preview and debug MaterialX materials without leaving your editor.

MaterialX Playground puts a live node graph editor and a real-time 3D preview right next to your `.mtlx` file, kept in sync with the text in both directions: change a value in the graph and the XML updates, edit the XML and the graph and render follow. It opens whole USD, glTF and OBJ scenes so you can see your materials in context, and it makes writing MaterialX by hand faster with smart completion, validation and inline docs. Everything runs on your machine: no account, no telemetry, no network access.

![A .mtlx file in the text editor on the left, with the Node Graph Editor and a live 3D preview on the right.](https://joaovbs96.github.io/MaterialXPlayground/images/preview-vscode.jpg)

## Highlights

- **Edit visually.** A full node graph editor beside your text, with nested node graphs, undo shared with the text editor, and Ctrl+S to save.
- **See it render.** A real-time 3D preview with image-based lighting, several preview shapes, screenshots and turntable GIFs.
- **Open whole scenes.** The Scene Viewer renders USD (`.usd`, `.usda`, `.usdc`, `.usdz`), glTF (`.gltf`, `.glb`) and OBJ files with their materials and textures. Double-click a surface to inspect its material.
- **Write MaterialX faster.** Completion that knows every node, input and attribute, snippets for common patterns, and color pickers on color values.
- **Catch mistakes early.** Validation as you type, hover docs for every node, an outline of your document, and Go to Definition across nodes and node graphs.
- **Start from an example.** Copy one of 14 ready-made standard_surface and OpenPBR materials, textures included, into your project with one command.

![The Scene Viewer rendering a scene with MaterialX materials.](https://joaovbs96.github.io/MaterialXPlayground/images/preview-scene.jpg)

## Get started

1. Open a folder with `.mtlx` or scene files and choose **Trust** when VS Code asks. In an untrusted folder the viewers do not open on their own.
2. Open a `.mtlx` file and the playground opens beside it. Scene files open in the Scene Viewer.
3. No MaterialX files yet? Run **MaterialX Playground: New Material from Example** from the Command Palette.

## Commands

| Command | What it does |
|---|---|
| Open in Graph Editor | Opens the current `.mtlx` file in the playground's Node Graph Editor. Also in the Explorer right-click menu and the editor tab's right-click menu. |
| Open in Material Viewer | Opens the current `.mtlx` file in the playground's Material Viewer. Also in the Explorer right-click menu and the editor tab's right-click menu. |
| Open in Scene Viewer | Opens the current USD, glTF or OBJ file in the Scene Viewer. |
| New Material from Example | Copies an example material, with its textures, into a folder you pick. |
| Open Node Library Documentation | Browses every MaterialX node, no file needed. |

All commands start with "MaterialX Playground:" in the Command Palette. In the Node Graph Editor, Ctrl+S saves and Ctrl+Z / Ctrl+Y undo and redo (Cmd on macOS).

## Settings

| Setting | Default | What it does |
|---|---|---|
| `materialxPlayground.autoOpenPlayground` | `true` | Opens the playground when you open a `.mtlx` file. |
| `materialxPlayground.autoOpenSceneViewer` | `true` | Opens the Scene Viewer when you open a scene file. |
| `materialxPlayground.openBehavior` | `splitRight` | Opens beside the text (`splitRight`) or in the same editor group (`sameGroup`). |
| `materialxPlayground.defaultView` | `graph` | Shows the Node Graph Editor (`graph`) or the Material Viewer (`viewer`) first. |

Settings from earlier versions (`materialx.*`) keep working.

## Good to know

- This is a preview release. Things may still change, and feedback is very welcome on the [issue tracker](https://github.com/joaovbs96/MaterialXPlayground/issues).
- The Material Viewer is read only; you edit in the Node Graph Editor or the text.
- Textures and included files must live inside the folder you opened.
- Scene files load only the file you opened and what it references, recursively; unrelated files sitting next to it are never loaded. Binary scene files (`.usdc`, binary `.usd`) load the files they reference on demand: when the scene asks for a file that wasn't sent, it is found and the scene reloads with it.
- Loading a scene shows its progress, from finding the referenced files to the first frame, and can be cancelled at any step.
- In the Scene Viewer, the material panel shows the node graph only; there is no 3D preview pane, and "Open in Graph Editor" opens the material view only, with a banner and an Export .mtlx button to save an editable copy.
- Documents that use `xi:include`, and very large documents, get XML checks only.
- Requires VS Code 1.100 or later on Windows, macOS or Linux, and a graphics driver with WebGL2.
- Installed an earlier `.vsix` from GitHub? Uninstall `local.materialx-playground` first, because the extension ID changed.

## Links

[Website](https://joaovbs96.github.io/MaterialXPlayground/#!vscode) · [Issues](https://github.com/joaovbs96/MaterialXPlayground/issues) · [Changelog](https://github.com/joaovbs96/MaterialXPlayground/blob/main/CHANGELOG.md) · [License (Apache 2.0)](https://github.com/joaovbs96/MaterialXPlayground/blob/main/LICENSE)
