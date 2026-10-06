---
title: What's new in MaterialX Playground v2026.10.1
description: New scene formats and USD export in the Scene Viewer, one renderer behind every tool, ShadingLanguageX in the Graph Editor, themes, a much bigger VS Code extension and a new home for the Playground on the web.
date: 2026-10-06
draft: true
tags:
  - releases
  - scene-viewer
  - vscode
---

The last release, v2026.9.4, came out in mid September. A lot has landed since then, so this release is a big one. Here is what is new, grouped by what it means for you rather than by when it was written. Everything still runs in your browser on MaterialX 1.39.5, with nothing to install.

## The Scene Viewer opens more than USD

The Scene Viewer started as a viewer for OpenUSD stages with MaterialX materials. It now reads several scene formats and turns their materials into MaterialX on the way in.

- **glTF and GLB.** Scenes load with their cameras and KHR_lights_punctual lights. Their PBR materials become MaterialX `gltf_pbr` shaders, including anisotropy, specular-glossiness and unlit materials.
- **OBJ.** Meshes load with their MTL materials converted to OpenPBR (`open_pbr_surface`).
- **UsdPreviewSurface.** USD stages that use UsdPreviewSurface instead of MaterialX now render too: their shader networks are converted to MaterialX UsdPreviewSurface documents and go through the same pipeline.
- **PBRT v4.** Drop a `.pbrt` file together with the files it includes and its PLY meshes. Materials become OpenPBR, area lights become emissive surfaces and a constant infinite light becomes a dome light. This importer is new and covers the common cases: triangle and PLY meshes, the diffuse, coated diffuse, dielectric and conductor materials, and perspective cameras. Textures, instancing, participating media and most light types are not imported yet, and you get a warning when something is skipped.

## And writes USD

There is a new **Export USD** option for scenes that came from glTF, GLB, OBJ or PBRT. You can write a USDA text file, a USDC binary file or a USDZ package, and choose how the materials travel: as USD with the `.mtlx` files referenced next to it, or as MaterialX written directly into the stage as UsdShade networks (the option to use for USDZ). Cameras, lights and double-sided meshes come along, with lights converted to UsdLux units.

## A Scene Viewer that is nicer to work in

- **Find things faster.** The hierarchy panel has one box for search and type filters, a camera picker and a combined Screenshot and Turntable capture button. The Scene card shows the file you loaded, its format, every file it pulled in (missing ones are marked), units, up axis and a Reload button.
- **Plain words.** The interface now says Scene, Scene selection and objects instead of USD-only terms, since it is no longer USD-only.
- **Materials one double-click away.** Double-click an object to open its material in a floating preview and node graph, with the scene's textures carried along. Opening it in the Graph Editor gives you a view-only copy with an Export .mtlx button for an editable one.
- **Better looking scenes.** True Catmull-Clark subdivision, diffuse bounce lighting, optional local reflections, a fallback material from `displayColor`, dome light rotation and a Material working space setting that can read untagged colors as ACEScg, which helps with scenes authored in Karma.
- **Quality presets.** Performance, Default and Quality presets in the toolbar and render settings.
- **Faster and sturdier loading.** Materials compile in parallel and textures decode concurrently. Scenes with gigabytes of textures no longer crash the tab, procedural materials with more than a thousand nodes no longer reset the GPU while compiling, and heavily textured glTF scenes stay within the GPU's texture sampler limit. Only the file you open and what it references are loaded, not every scene file in the folder.
- **Small fixes that add up.** Autodesk LookdevX converter nodes are repaired, the right root file is picked when you drop several, the authored camera is used on load, the shadow catcher grounds the model properly and the selection outline is smooth on high density displays.

## One renderer behind every tool

The Material Viewer, Compare, Node Specs, the Graph Editor previews, embeds and the Scene Viewer now share one renderer and one set of render settings, with Performance, Default and Quality levels and the same settings panel everywhere.

- **Quality level.** The material previews gain colored transmission, HDR presentation, screen space ambient occlusion and specular anti-aliasing at the Quality level. Performance and Default look exactly as before.
- **Reflections are right the first time.** Rough metals blur their environment reflections as soon as a material loads, instead of looking mirror-like until the environment reloaded.
- **Displacement, first version.** MaterialX displacement now renders by subdividing the mesh, in the Scene Viewer, the Material Viewer and embeds. It is still being refined.
- **UDIM on your own models.** UDIM materials on imported models render every tile in the Material Viewer.
- **Textures.** EXR textures are no longer flipped, Deflate-compressed TIFFs and single-channel EXRs decode correctly, clamp and mirror address modes are honored, a Texture Anisotropy setting is new, and a "Loading textures" badge shows while textures arrive.
- **Kinder to your GPU.** Views you are not looking at release or suspend their WebGL contexts, so having many tools open no longer exhausts the browser's context limit, and a lost context recovers the same way in every tool.

## Graph Editor, Node Specs and ShadingLanguageX

- **Node thumbnails.** Pattern and data nodes can show a small preview of their output, rendered in the background so editing stays responsive. Turn them on from the View menu or per node from the right-click menu. Shader and material nodes can show a shader ball preview through a separate setting.
- **ShadingLanguageX.** [ShadingLanguageX](https://github.com/jakethorn/ShadingLanguageX) (`.mxsl`) is a compact, code-like way to write MaterialX node graphs, created by Jacob Thorn, who also built its support in the Playground. Thank you, Jacob! The Playground now speaks it:
  - Open `.mxsl` files in the Material Viewer and the Graph Editor, compiled to MaterialX.
  - Export any graph as ShadingLanguageX from Export Shader Code.
  - A docked **code view** shows the document as editable ShadingLanguageX with completion. Compile turns your code into a graph and Decompile turns the graph back into code.
  - A **code node** keeps its nodegraph as ShadingLanguageX right on the node.
- **Node Specs.** A View implementation button shows a node's implementation graph inline, with a shortcut into the Graph Editor that brings you back to the same page. You can also filter the node list by port type, for example every node with a `surfaceshader` output.

## Themes

The Playground is no longer dark only.

- A **Light, Dark or System** switch in the header. System follows your operating system live.
- Presets: **Dim**, **Paper**, **High contrast dark** and **High contrast light**, the last two meeting WCAG AAA for text.
- Your **own themes** from three base colors, with contrast and tint sliders and a contrast check to WCAG AA. Every theme travels as a short code you can share.
- **Embeds** take a `theme` attribute, with a built-in name or a theme code.
- In the **desktop app**, the window frame and title bar follow the theme.

## A much bigger VS Code extension

- **The Scene Viewer in VS Code.** Open `.usd`, `.usda`, `.usdc`, `.usdz`, `.gltf`, `.glb` and `.obj` files in the Scene Viewer. Binary USD files load what they reference on demand, and loading shows its progress and can be cancelled.
- **A real editor for `.mtlx` files.** Snippets, auto-complete that only offers what is valid where you are typing, rename, formatting, clickable file links, an outline with go to definition and find references, and color swatches with a picker.
- **A sidebar.** Actions, an Insert Node panel, the textures and files your document uses, and an outline that stays in sync with the text and the Graph Editor.
- **New commands.** Open in Graph Editor, Open in Material Viewer, New MaterialX Document and New Material from Example, which copies a ready-made Standard Surface or OpenPBR material into your workspace.
- **Matches your editor.** The Match VS Code theme takes its colors from your VS Code theme and follows it live.
- **Safer by default.** Restricted Mode is supported, referenced files must stay inside your workspace and validation runs off the editor thread.
- **Coming to the Marketplace.** The extension is ready for the VS Code Marketplace and Open VSX. Until it is listed, install the `.vsix` from the releases page. The extension ID changed, so if you installed an earlier build, uninstall `local.materialx-playground` first. Settings moved from `materialx.*` to `materialxPlayground.*`; the old names still work.

## A new home on the web

- **A reorganized menu.** The header now reads Viewers, Graph Editor, Node Specs, Learn, Integrate and About.
- **The MaterialX Playground tour.** Under About, an interactive tour lets you write a material one line at a time, see that the file and the graph are the same thing, and then take your material through every tool.
- **A desktop app page** with downloads for Windows, macOS and Linux and install steps for each.
- **A refreshed VS Code extension page** that covers everything above.
- **Build Info & Licenses** in the header lists every bundled library and asset and the MaterialX release in use.
- **This blog.** Posts like this one, with an Atom feed and the latest posts on the home page.

## Try it

Everything above is live on this site now: open the [Material Viewer]({{ appRoot }}#!viewer), the [Scene Viewer]({{ appRoot }}#!scene) or the [Graph Editor]({{ appRoot }}#!graph) and try it out. The desktop app and the VS Code extension are on the [releases page](https://github.com/joaovbs96/MaterialXPlayground/releases).

The [roadmap]({{ appRoot }}#!roadmap) shows what comes next, and the [issue tracker](https://github.com/joaovbs96/MaterialXPlayground/issues) is open for bug reports and ideas.
