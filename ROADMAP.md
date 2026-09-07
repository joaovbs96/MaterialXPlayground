<!--
Maintainers: this file is the single source of truth for the roadmap. The website's Roadmap page fetches it at view time, so add, update or remove items here and nowhere else.
Format: one item per bullet, `- [status] **Title**: one or two sentences.` Statuses: idea, planned, in progress, parked, done. Sections (## headings) are areas of the project. Keep titles short and stable so links keep working. HTML comments like this one are not rendered.
-->

# Roadmap

Where MaterialX Playground is heading: the rendering engine shared by the Material Viewer and the USD Scene Viewer, the tools around them, and the desktop and editor integrations. Items marked idea are open for discussion, planned items have an agreed shape, and in progress items have a branch.

## Rendering Engine

- [planned] **Material Viewer and Scene render session**: pull the view layer out of the Viewer closure into shared, scene-capable modules (peel pipeline done; texture pipeline, environment bridge, diagnostics, one handle contract) so feature parity is structural. Includes environment broadcast, key light toggle, GIF transparent option, HUD parity, anisotropic filtering and one decode colour policy.
- [in progress] **KTX2 compressed textures**: cook script that bakes `.ktx2` siblings next to source textures, resolver that prefers them, planner that counts compressed bytes. Branch `ktx2-textures`, pending the toktx verification at 4096.
- [planned] **Displacement**: Loop subdivision removed the tessellation blocker; remaining shape is bake the displacement network to a UV-space target, displace on the CPU with seam averaging, recompute normals, in Viewer and Scene.
- [planned] **Upstream MaterialXView parity gaps**: close the open gaps recorded in the parity audit against MaterialXView (desktop and web viewer): per-image sampler state, shadow maps, document-authored lights, `doc.validate()`, mipmaps on float textures, extra vertex streams.
- [planned] **Document validation at load**: report duplicate input names, unknown colorspaces, type mismatches and out-of-range mix weights in one Diagnostics list instead of letting MaterialX drop them silently.
- [planned] **Linear compositing for transparency**: the depth-peel composite runs in display space today; the linear path needs a linear-output mode for opaque MaterialX materials during the merged pass.
- [planned] **Texture pipeline in a worker with a quiet load**: both viewers decode textures on the main thread today; decode off the main thread, hold prims neutral until their textures bind, one progress line, cancelable texture work.

## Scene Viewer

- [planned] **UsdPreviewSurface to MaterialX**: convert the runtime's flattened UsdPreviewSurface payload into a MaterialX document using the standard `UsdPreviewSurface` and `UsdUVTexture` nodes, so both material kinds render through one pipeline.
- [idea] **glTF scenes through MaterialX**: a second stage adapter that reads glTF or GLB (hierarchy, meshes, cameras) and converts glTF PBR materials to `gltf_pbr` MaterialX, sharing the renderer with USD.
- [planned] **Runtime recovery after a wasm abort**: a malformed prim currently kills the whole USD module; recreate the module per stage and skip the offending prim, or rebuild the runtime with exception handling.
- [idea] **Triangle and prim budgets with GPU instancing**: nothing bounds geometry today; repeated meshes should share GPU buffers and instance matrices.
- [idea] **Variants and purposes in the UI**: the runtime exposes variant selection and a purpose policy; the viewer uses neither.
- [idea] **Stage lights**: read `UsdLux` lights and drive the MaterialX light rig from them (`extractStageLights` exists in the runtime).
- [idea] **Camera UX**: show camera frustums, open on a stage's single authored camera, expose field of view and clipping.
- [idea] **Scene embeds, compare and gallery**: the Scene route has no embed or compare mode and no gallery entry. Gallery would, likely, have to work differently for full scenes, in relation to individual materials.
- [idea] **Stage reload robustness**: repeated reloads in one long browser session hung twice during diagnosis runs; not yet reproduced or investigated.

## Material Viewer

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
