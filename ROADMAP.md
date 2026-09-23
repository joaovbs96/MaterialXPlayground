<!--
Maintainers: this file is the single source of truth for the roadmap. The website's Roadmap page fetches it at view time, so add, update or remove items here and nowhere else.
Format: one item per bullet, `- [status] **Title**: one or two sentences.` Statuses: idea, planned, in progress, parked, done. Sections (## headings) are areas of the project. Keep titles short and stable so links keep working. HTML comments like this one are not rendered.
-->

# Roadmap

Where MaterialX Playground is heading, grouped by area: the rendering engine shared by the Material Viewer and the Scene Viewer, the tools around them, and the desktop and editor integrations. Everything here is open for discussion, including the order and whether an item belongs at all. Missing something? Open an issue on the [GitHub issues page](https://github.com/joaovbs96/MaterialXPlayground/issues) to suggest, question or voice your support for an item.

## Known issues

- [parked] **Bump and heighttonormal speckle**: MaterialX 1.39 computes heighttonormal from screen derivatives per UV unit, so high resolution height maps at the default scale produce per pixel noise on bumps (Stirling tires and sand, Playground skirting). An opt-in texel-space variant exists behind a flag; the default follows upstream.
- [parked] **Sub-pixel flake sparkle**: procedural flakes smaller than a pixel (Stirling car paint) alias into white specks in a single-sample rasterizer; a supersampling or accumulation pass is the fix.
- [done] **Glossy sparkle under high contrast HDRIs**: fixed by the prefiltered environment reflections.
- [done] **Large procedural materials resetting the GPU**: materials with over a thousand nodes could reset the GPU while their shader compiled. Integer inputs used as array indices, switch selectors or branch conditions are now folded to constants before shader generation, which also cuts their compile time several times over.

## Rendering Engine

- [in progress] **Displacement**: render MaterialX displacement in every tool by subdividing the mesh and evaluating the displacement shader per vertex, with one global on/off setting and a subdivision level.
- [planned] **One renderer for both viewers**: the Material Viewer and the Scene Viewer still keep separate copies of some rendering code. Move it into shared modules so every feature (transparency, textures, environment, diagnostics) works the same in both.
- [planned] **MaterialXView parity**: close the remaining differences to the reference MaterialX viewer: per-image sampler settings, document validation, mipmaps on float textures, extra vertex streams.
- [planned] **Validate documents at load**: warn about duplicate inputs, unknown colorspaces and mix weights outside 0 to 1 instead of letting MaterialX drop them silently. Type mismatches are already reported.
- [planned] **Correct transparency blending**: blend transparent layers in linear light instead of display space.
- [planned] **Faster, quieter texture loading**: decode textures off the main thread, keep objects neutral until their textures are ready, allow cancelling.
- [idea] **Parallel shader generation**: MaterialX shader generation runs one material at a time on the page's main thread. Run it in a few Web Workers, each with its own copy of the MaterialX module, so scenes with many materials start compiling sooner and the page stays responsive meanwhile.
- [done] **KTX2 compressed textures**: GPU-compressed textures cut memory use by about four times, so large scenes can load at full resolution. Includes a script that converts a folder of textures once.
- [done] **Texture sampler budget**: glTF materials that reuse a texture share one image sampler, and duplicate image nodes are merged before shader generation, so heavily textured scenes stay within the GPU's sampler limit.
- [done] **Prefiltered environment reflections**: the environment is prefiltered into a GGX mip chain, as MaterialXView does, so smooth surfaces no longer sparkle under high contrast HDRIs.
- [done] **Shadows and document lights**: shadow maps, plus directional, point and spot lights authored in the document.
- [done] **Selectable display transform**: an sRGB mode matching MaterialXView next to tone mapped modes, with exposure in EV in every tool.

## Scene Viewer

- [done] **USD Scene Viewer**: load USD stages with MaterialX materials rendered through the MaterialX shader generator, with per phase load progress and a render settings popover.
- [done] **UsdPreviewSurface materials**: UsdPreviewSurface shader networks are converted to MaterialX UsdPreviewSurface documents, so they render through the same pipeline as MaterialX materials. Binary layers fall back to a flattened conversion.
- [done] **glTF scenes**: glTF and GLB files load with their PBR materials converted to MaterialX glTF PBR shaders, including anisotropy, specular-glossiness and unlit materials, together with their cameras and KHR_lights_punctual lights. OBJ files load with MTL materials converted to OpenPBR.
- [planned] **Survive broken stages**: a malformed prim currently takes down the whole USD runtime. Recover and skip the offending prim instead.
- [idea] **Geometry budgets and instancing**: stages already stop subdividing at a triangle budget; bound the geometry a stage can load overall and draw repeated meshes with GPU instancing.
- [idea] **Variants and purposes**: let the user pick variant selections and render purposes; the runtime already supports both.
- [done] **Stage lights**: UsdLux distant, sphere, disk, rect and cylinder lights drive the lighting, with shadows.
- [idea] **Camera tools**: stages already open on or switch to any authored camera, glTF cameras included, and the orbit camera stays above the studio floor; still to do are camera frustums in the viewport and field of view and clipping controls.
- [done] **Subdivision surfaces**: meshes authored with a subdivision scheme are subdivided at a selectable level.
- [done] **PointInstancer**: instanced geometry from PointInstancer prims.
- [done] **Transparency, refraction and bloom**: depth peeled transparency, colored light transmission, refraction through thick glass and bloom.
- [done] **Ambient occlusion**: a baked world occlusion volume combined with screen-space ambient occlusion.
- [done] **Material preview from the viewport**: double click an object to open its material in a floating preview and graph panel at the click point, with the stage's embedded textures carried into the preview and the Graph Editor.
- [planned] **Faster first material preview**: the first preview after loading a scene still takes a couple of seconds; hand the preview the shaders the viewport already generated.
- [planned] **glTF texture transforms**: check KHR_texture_transform offsets against the flipped texture coordinates that glTF import applies.
- [parked] **Screen-space reflections**: implemented but hidden while its behaviour is tuned.
- [idea] **Embeds, compare and gallery for scenes**: none of these exist for the Scene Viewer yet. A scene gallery would likely work differently from the material gallery.
- [idea] **Reload robustness**: reloading stages many times in one session has hung twice; not yet reproduced.

## Material Viewer

- [parked] **Path tracing mode**: a physically based path tracer next to the real-time view, so materials can be checked against a ground-truth render of the same document, with progressive refinement while the camera is still.
- [done] **Material gallery**: browse, search and filter the MaterialX example materials with live previews, licenses, permalinks and zip downloads.
- [done] **Preset picker**: one dialog, backed by the gallery, to pick a starting material in the Viewer, Compare and Graph Editor.
- [done] **Custom preview models**: load OBJ, GLB and multi-file glTF models, including Draco compressed meshes.
- [idea] **More backdrop options**: something similar to the backdrop of the Standard Shaderball.
- [idea] **Support for ShadingLanguageX (SLX) viewing**: via SLX WASM bindings, support for directly rendering a .slx file.

## Node Graph and Tools

- [done] **Node definition authoring**: create and edit nodedefs and their implementation graphs, convert a graph into a node definition, and browse library nodegraphs read-only.
- [done] **Lossless .mtlx round trip**: saving keeps node order, comments and the original file's formatting, and the attribution comment is optional.
- [done] **Autosave and session recovery**: the Graph Editor autosaves and offers a session browser with graph and render previews after a crash.
- [done] **Interface input editing**: edit ui attributes, default values and colorspace on nodegraph interface inputs.
- [done] **Texture formats**: TIFF textures, and an option to convert every texture in a zip export to PNG, JPEG or EXR.
- [idea] **Recipes for common node tree patterns**: ability to insert commonly used sequences of nodes from a "gallery" of node patterns - e.g. a texcoord, connected to a place2d, connected to an image.
- [idea] **Support for a ShadingLanguageX (SLX) node**: via SLX WASM bindings, support for a 'scripted' ShadingLanguageX node, which for export/rendering would be compiled down to actual MaterialX syntax
- [idea] **Support for ShadingLanguageX (SLX) import**: via SLX WASM bindings, support for importing a .slx as a node graph.
- [idea] **Support for ShadingLanguageX (SLX) export**: via SLX WASM bindings, support for exporting a node graph as a .slx file.

## Node Documentation

- [done] **Implementation preview**: a View implementation button shows a node's implementation graph in an inline read-only panel, with fullscreen and a shortcut into the Graph Editor that returns to the same docs page.
- [done] **Search by port type**: filter the node list by input and output types, for example every node with a surfaceshader output.

## Website

- [done] **About dialog**: credits for every bundled library and asset, and a link to the MaterialX release in use, in the web app, VS Code and the desktop app.

## Desktop App

- [done] **Electron merge**: an experimental desktop build is merged, with native open and save, recent files, file watching and a Windows jump list, and CI builds and smoke-tests installers for Windows, macOS and Linux on every release.
- [done] **Mac verification**: traffic-light gutter, Reveal in Finder, ad-hoc signing on the runner, general testing and validation.

## Tutorials

- [planned] **Initial batch of tutorials**: 101-styled intro to MaterialX, covering both devs (on C++, Python and Java Script bindings) and artists.

## VSCode Extension

- [idea] **Auto-complete on VSCode**: auto-completion capabilities to assist direct text editing on VSCode.
- [in progress] **Officially Releasing extension on VSCode Extensions**: publish the extension on the VS Code Marketplace so it is easier to find, install and update. The publishing pipeline is being set up.
