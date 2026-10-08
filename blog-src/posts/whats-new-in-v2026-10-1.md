---
title: What's new in MaterialX Playground v2026.10.1
description: New scene formats and USD export in the Scene Viewer, improvements to rendering parity across tools, ShadingLanguageX in the Graph Editor, themes, a much bigger VS Code extension and a new home for the Playground on the web.
date: 2026-10-06
draft: true
image: blog/assets/release-2026-10/01-hero-social-1200x630.png
imageAlt: "Three tiles side by side: a brick material on the shader ball, two glossy blue carpaint balls in Compare, and the Open Chess Set in the Scene Viewer."
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
- **PBRT v4 and Mitsuba.** Scenes from these two research renderers open too. Drop a `.pbrt` file with the files it includes and its PLY meshes, or a Mitsuba scene `.xml` (Mitsuba 3 and 2, with older 0.5 and 0.6 files upgraded on load) with its OBJ meshes. A `.zip` of the whole scene works as well.
  - **Materials** become OpenPBR, including diffuse, coated diffuse and plastic, glass and metals (with real-world metal colors), and their image and checkerboard textures become MaterialX texture graphs.
  - **Lights:** area lights make their surfaces glow, and rectangular ones also light the scene. Distant lights, constant skies and environment maps come along, environment maps as a textured dome.
  - **Not yet:** instancing, participating media, other shape and light types, and less common materials are skipped, with a warning for each.

<figure>
  <img src="{{ pathPrefix }}assets/release-2026-10/02-pbrt-mitsuba-1600w.webp" alt="A grid of coffee maker renders, two rows of three. Each row compares a reference renderer, PrismRT and the Playground on the same scene." width="1600" height="1328">
  <figcaption>Top row: the Mitsuba scene. Bottom row: the pbrt-v4 scene. Left to right: the reference renderer (Mitsuba 3.9.1 at 4096 spp, pbrt-v4 at 1024 spp), PrismRT (exported USD and MaterialX, 2048 spp), and the Playground in real time (floor hidden, backdrop None). Coffee Maker scene by cekuhnen (CC BY 3.0), from Benedikt Bitterli's Rendering Resources.</figcaption>
</figure>

## And writes USD

There is a new **Export USD** option for scenes that came from glTF, GLB, OBJ, PBRT or Mitsuba. You can write a USDA text file, a USDC binary file or a USDZ package, and choose how the materials travel: as USD with the `.mtlx` files referenced next to it, or as MaterialX written directly into the stage as UsdShade networks (the option to use for USDZ). Cameras, lights and double-sided meshes come along, with lights converted to UsdLux units. Dome lights and environment maps are not exported yet.

<figure>
  <img src="{{ pathPrefix }}assets/release-2026-10/03-export-usd-1600w.webp" alt="The Scene Viewer with the Mitsuba coffee maker scene loaded and the Export USD dialog open, offering USD plus referenced .mtlx files and the USDA format." width="1600" height="1000" loading="lazy">
  <figcaption>Export USD from a Mitsuba scene: choose how materials travel and which USD format to write. Coffee Maker scene by cekuhnen (CC BY 3.0), from Benedikt Bitterli's Rendering Resources.</figcaption>
</figure>

## A Scene Viewer that is nicer to work in

- **Find things faster.** The hierarchy panel has one box for search and type filters, a camera picker and a combined Screenshot and Turntable capture button. The Scene card shows the file you loaded, its format, every file it pulled in (missing ones are marked), units, up axis and a Reload button.
- **Plain words.** The interface now says Scene, Scene selection and objects instead of USD-only terms, since it is no longer USD-only.
- **Materials one double-click away.** Double-click an object to open its material in a floating preview and node graph, with the scene's textures carried along. Opening it in the Graph Editor gives you a view-only copy with an Export .mtlx button for an editable one.
- **Better looking scenes.** True Catmull-Clark subdivision, diffuse bounce lighting, optional local reflections, a fallback material from `displayColor`, dome light rotation and a Material working space setting that can read untagged colors as ACEScg, which helps with scenes authored in Karma.
- **Quality presets.** Performance, Default and Quality presets in the toolbar and render settings.
- **Faster and sturdier loading.** Materials compile in parallel and textures decode concurrently. Scenes with gigabytes of textures no longer crash the tab, procedural materials with more than a thousand nodes no longer reset the GPU while compiling, and heavily textured glTF scenes stay within the GPU's texture sampler limit. Only the file you open and what it references are loaded, not every scene file in the folder.
- **Small fixes that add up.** Autodesk LookdevX converter nodes are repaired, the right root file is picked when you drop several, the authored camera is used on load, the shadow catcher grounds the model properly and the selection outline is smooth on high density displays.

<figure>
  <img src="{{ pathPrefix }}assets/release-2026-10/04-material-preview-1600w.webp" alt="The Scene Viewer showing the Open Chess Set with the black pawns outlined, and a floating panel with the pawn material graph next to a shader ball preview." width="1600" height="1000" loading="lazy">
  <figcaption>Double-click an object to open its material in a floating node graph and preview. Open Chess Set (CC BY 4.0, Academy Software Foundation), authored by Moeen and Mujtaba Sayed, contributed to MaterialX by SideFX.</figcaption>
</figure>

## Rendering parity across tools

The Material Viewer, Compare, Node Specs, the Graph Editor previews, embeds and the Scene Viewer now render more consistently, with the same render settings, Performance, Default and Quality levels, and the same settings panel everywhere.

<figure>
  <img src="{{ pathPrefix }}assets/release-2026-10/01-hero-1600w.webp" alt="Three panels, each with the Render settings popover open: the Material Viewer showing a brick material on the shader ball (top left), Compare showing two carpaint balls side by side (top right) and the Scene Viewer showing the Open Chess Set close up (bottom)." width="1600" height="1455" loading="lazy">
  <figcaption>The same render settings in every tool. Top left: Material Viewer. Top right: Compare. Bottom: Scene Viewer. Open Chess Set (CC BY 4.0, Academy Software Foundation), authored by Moeen and Mujtaba Sayed.</figcaption>
</figure>

- **Quality level.** The material previews gain colored transmission, HDR presentation, screen space ambient occlusion and specular anti-aliasing at the Quality level. Performance and Default look exactly as before.
- **Reflections are right the first time.** Rough metals blur their environment reflections as soon as a material loads, instead of looking mirror-like until the environment reloaded.
- **Displacement, first version.** MaterialX displacement now renders by subdividing the mesh, in the Scene Viewer, the Material Viewer and embeds. It is still being refined.
- **UDIM on your own models.** UDIM materials on imported models render every tile in the Material Viewer.
- **Textures.** TGA textures now load everywhere, EXR textures are no longer flipped, Deflate-compressed TIFFs and single-channel EXRs decode correctly, clamp and mirror address modes are honored, a Texture Anisotropy setting is new, and a "Loading textures" badge shows while textures arrive.
- **Kinder to your GPU.** Views you are not looking at release or suspend their WebGL contexts, so having many tools open no longer exhausts the browser's context limit, and a lost context recovers the same way in every tool.

<figure>
  <img src="{{ pathPrefix }}assets/release-2026-10/05-disney-glass-1600w.webp" alt="Two views of the same shader ball, a Disney Principled glass material. On the left it looks like opaque white plastic, on the right it is see-through glass." width="1600" height="585" loading="lazy">
  <figcaption>Disney Principled glass now renders transparent. Left: before. Right: v2026.10.1. Both use the Default preset with Force Transparency on.</figcaption>
</figure>

## Graph Editor, Node Specs and ShadingLanguageX

- **Node thumbnails.** Pattern and data nodes can show a small preview of their output, rendered in the background so editing stays responsive. Turn them on from the View menu or per node from the right-click menu. Shader and material nodes can show a shader ball preview through a separate setting.
- **ShadingLanguageX.** [ShadingLanguageX](https://github.com/jakethorn/ShadingLanguageX) (`.mxsl`) is a compact, code-like way to write MaterialX node graphs, created by Jacob Thorn, who also built its support in the Playground. Thank you, Jacob! The Playground now speaks it:
  - Open `.mxsl` files in the Material Viewer and the Graph Editor, compiled to MaterialX.
  - Export any graph as ShadingLanguageX from Export Shader Code.
  - A docked **code view** shows the document as editable ShadingLanguageX with completion. Compile turns your code into a graph and Decompile turns the graph back into code.
  - A **code node** keeps its nodegraph as ShadingLanguageX right on the node.
- **Node Specs.** A View implementation button shows a node's implementation graph inline, with a shortcut into the Graph Editor that brings you back to the same page. You can also filter the node list by port type, for example every node with a `surfaceshader` output.

<figure>
  <img src="{{ pathPrefix }}assets/release-2026-10/06-node-thumbnails-1600w.webp" alt="The Graph Editor inside a marble node graph of 19 nodes, every pattern node showing a small preview of its output with the final marble on the shader ball at the right." width="1600" height="1000" loading="lazy">
  <figcaption>Node thumbnails: see what every node produces right in the graph (the marble example, Large Thumbnails on). Example: standard_surface_marble_solid from the MaterialX examples (Academy Software Foundation).</figcaption>
</figure>

## Themes

The Playground is no longer dark only.

- A **Light, Dark or System** switch in the header. System follows your operating system live.
- Presets: **Dim**, **Paper**, **High contrast dark** and **High contrast light**, the last two meeting WCAG AAA for text.
- Your **own themes** from three base colors, with contrast and tint sliders and a contrast check to WCAG AA. Every theme travels as a short code you can share.
- **Embeds** take a `theme` attribute, with a built-in name or a theme code.
- In the **desktop app**, the window frame and title bar follow the theme.

<figure>
  <img src="{{ pathPrefix }}assets/release-2026-10/07-themes-1600w.webp" alt="The first slide of the MaterialX Playground tour, one picture cut into six vertical bands, each band in a different theme." width="1600" height="1000" loading="lazy">
  <figcaption>Light, dark, presets and your own themes. Left to right: Light, Dark, Dim, Paper, High contrast dark, High contrast light. Captured in the desktop app.</figcaption>
</figure>

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
