<!--
Maintainers: this file is the single source of truth for the roadmap. The website's Roadmap page fetches it at view time, so add, update or remove items here and nowhere else.
Format: one item per bullet, `- [status] **Title**: one or two sentences.` Statuses: idea, planned, in progress, parked, done. Sections (## headings) are areas of the project. Keep titles short and stable so links keep working. HTML comments like this one are not rendered.
-->

# Roadmap

Where MaterialX Playground is heading, grouped by area: the rendering engine shared by the Material Viewer and the Scene Viewer, the tools around them, and the desktop and editor integrations. Everything here is open for discussion, including the order and whether an item belongs at all. Missing something? Open an issue on the [GitHub issues page](https://github.com/joaovbs96/MaterialXPlayground/issues) to suggest, question or voice your support for an item.

## Rendering Engine

- [planned] **One renderer for both viewers**: the Material Viewer and the Scene Viewer still keep separate copies of some rendering code. Move it into shared modules so every feature (transparency, textures, environment, diagnostics) works the same in both.
- [in progress] **KTX2 compressed textures**: GPU-compressed textures cut memory use by about four times, so large scenes can load at full resolution. Includes a script that converts a folder of textures once. Branch `ktx2-textures`.
- [planned] **Displacement**: render MaterialX displacement by baking it to a texture and moving the mesh vertices on the CPU, in both viewers.
- [planned] **MaterialXView parity**: close the known differences to the reference MaterialX viewer: per-image sampler settings, shadows, lights authored in the document, document validation, mipmaps on float textures, extra vertex streams.
- [planned] **Validate documents at load**: warn about duplicate inputs, unknown colorspaces, type mismatches and mix weights outside 0 to 1 instead of letting MaterialX drop them silently.
- [planned] **Correct transparency blending**: blend transparent layers in linear light instead of display space.
- [planned] **Faster, quieter texture loading**: decode textures off the main thread, keep objects neutral until their textures are ready, show one progress line, allow cancelling.

## Scene Viewer

- [planned] **UsdPreviewSurface materials**: convert UsdPreviewSurface materials to MaterialX so they render through the same pipeline as MaterialX materials.
- [idea] **glTF scenes**: load glTF and GLB files, converting their PBR materials to MaterialX and sharing the renderer with USD.
- [planned] **Survive broken stages**: a malformed prim currently takes down the whole USD runtime. Recover and skip the offending prim instead.
- [idea] **Geometry budgets and instancing**: bound the amount of geometry a stage can load and draw repeated meshes with GPU instancing.
- [idea] **Variants and purposes**: let the user pick variant selections and render purposes; the runtime already supports both.
- [idea] **Stage lights**: read UsdLux lights from the stage and use them for lighting.
- [idea] **Camera tools**: show camera frustums, open on the stage's authored camera, expose field of view and clipping.
- [idea] **Embeds, compare and gallery for scenes**: none of these exist for the Scene Viewer yet. A scene gallery would likely work differently from the material gallery.
- [idea] **Reload robustness**: reloading stages many times in one session has hung twice; not yet reproduced.

## Material Viewer

- [planned] **Path tracing mode**: a physically based path tracer next to the real-time view, so materials can be checked against a ground-truth render of the same document, with progressive refinement while the camera is still.
- [idea] **More backdrop options**: something similar to the backdrop of the Standard Shaderball.
- [idea] **Support for ShadingLanguageX (SLX) viewing**: via SLX WASM bindings, support for directly rendering a .slx file.

## Node Graph and Tools

- [idea] **Recipes for common node tree patterns**: ability to insert commonly used sequences of nodes from a "gallery" of node patterns - e.g. a texcoord, connected to a place2d, connected to an image.
- [idea] **Support for a ShadingLanguageX (SLX) node**: via SLX WASM bindings, support for a 'scripted' ShadingLanguageX node, which for export/rendering would be compiled down to actual MaterialX syntax
- [idea] **Support for ShadingLanguageX (SLX) import**: via SLX WASM bindings, support for importing a .slx as a node graph.
- [idea] **Support for ShadingLanguageX (SLX) export**: via SLX WASM bindings, support for exporting a node graph as a .slx file.

## Desktop App

- [planned] **Electron merge**: stability round complete; awaiting further testing, merging, further testing/validating the CI and actually releasing.
- [idea] **Mac verification**: traffic-light gutter, Reveal in Finder, ad-hoc signing on the runner, general testing and validation.

## Tutorials

- [planned] **Initial batch of tutorials**: 101-styled intro to MaterialX, covering both devs (on C++, Python and Java Script bindings) and artists.

## VSCode Extension

- [idea] **Auto-complete on VSCode**: auto-completion capabilities to assist direct text editing on VSCode.
- [planned] **Officially Releasing extension on VSCode Extensions**: makes the extension easier to find, use and update.
