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
- [done] **Large procedural materials resetting the GPU**: materials with over a thousand nodes could reset the GPU while their shader compiled. Integer inputs used as array indices, switch selectors or branch conditions, and mode selectors, are now turned into constants in the generated shader before it compiles, which also cuts their compile time several times over.
- [planned] **Absolute USD layer paths in the desktop app**: USD sublayers and references authored as absolute paths still show as missing in the desktop app, although their files are found on disk; textures with absolute paths work.
- [idea] **V-Ray dome textures**: some V-Ray exports do not write the dome light's HDR into the USD file; the Scene Viewer falls back to the default environment with a warning.

## Rendering Engine

- [done] **Displacement**: MaterialX displacement renders in the Material Viewer, Compare, the Graph Editor, embeds and the Scene Viewer. The mesh is subdivided and the displacement shader runs per vertex, with an on/off setting, a subdivision level and a choice of mesh or analytic normals. Node thumbnails and node docs previews do not show it yet.
- [in progress] **One renderer for both viewers**: both viewers run on one shared render session with one list of settings and Performance, Default and Quality levels. Shipped: shared environment, display, transparency, post effects and ambient occlusion, effects loaded on demand, and a Quality level in the Material Viewer and Compare that adds ambient occlusion, specular anti-aliasing, HDR post and colored transmission. Still open: shadows on preview materials, thickness and refraction at preview Quality, deciding which Quality effects join preview Default, Scene rollback when a rebuild fails to compile, UDIM with displacement on custom geometry, saving Scene settings inside VS Code, and separate displacement normal settings per surface.
- [planned] **MaterialXView parity**: close the remaining differences to the reference MaterialX viewer: per-image filter settings, mipmaps on float textures and extra vertex streams. Per-image wrap modes (uaddressmode and vaddressmode) already work, and document validation has its own entry.
- [planned] **Validate documents at load**: warn about duplicate inputs, unknown colorspaces and mix weights outside 0 to 1 when a document loads, instead of letting MaterialX drop them silently. Type mismatches are already reported, the Graph Editor has a Validate button that runs the MaterialX library's checks, and VS Code validates .mtlx files as you type.
- [done] **Correct transparency blending**: transparent layers are composited in linear light with one display transform at the end. Devices without float render targets fall back to blending in display space.
- [planned] **Faster, quieter texture loading**: decode EXR, HDR and TIFF textures off the main thread and keep objects neutral until their textures are ready. PNG and JPEG already decode in the background, and Scene Viewer loads can be cancelled.
- [idea] **Parallel shader generation**: MaterialX shader generation runs one material at a time on the page's main thread. Run it in a few Web Workers, each with its own copy of the MaterialX module, so scenes with many materials start compiling sooner and the page stays responsive meanwhile.
- [done] **KTX2 compressed textures**: GPU-compressed textures cut memory use by about four times, so large scenes can load at full resolution. Includes a script that converts a folder of textures once.
- [done] **Texture sampler budget**: glTF materials that reuse a texture share one image sampler, and duplicate image nodes are merged before shader generation, so heavily textured scenes stay within the GPU's sampler limit.
- [done] **Prefiltered environment reflections**: the environment is prefiltered into a GGX mip chain, as MaterialXView does, so smooth surfaces no longer sparkle under high contrast HDRIs.
- [done] **Shadows and document lights**: directional, point and spot lights authored in the document, shadow maps in the Scene Viewer, and contact shadows on the studio floor in the Material Viewer.
- [done] **Selectable display transform**: an sRGB mode matching MaterialXView next to tone mapped modes, with exposure in EV in every tool.
- [done] **UDIM textures**: UDIM tiled textures work in previews and scenes, within tile limits.
- [done] **Animated materials**: the time and frame inputs update live, as in MaterialXView.

## Scene Viewer

- [done] **USD Scene Viewer**: load USD stages with MaterialX materials rendered through the MaterialX shader generator. Loading shows progress per phase and can be cancelled, and the viewer has Performance, Default and Quality presets, a hierarchy with type filters, a camera picker, and screenshot and 360 degree GIF capture.
- [done] **UsdPreviewSurface materials**: UsdPreviewSurface shader networks are converted to MaterialX UsdPreviewSurface documents, so they render through the same pipeline as MaterialX materials. Binary layers fall back to a flattened conversion.
- [done] **glTF scenes**: glTF and GLB files load with their PBR materials converted to MaterialX glTF PBR shaders, together with their cameras and KHR_lights_punctual lights. Supported materials include clearcoat, sheen, transmission, volume, IOR, specular, iridescence, anisotropy, dispersion, emissive strength, specular-glossiness and unlit, and Draco, KTX2 and quantized meshes load too. OBJ files load with MTL materials converted to OpenPBR.
- [done] **PBRT and Mitsuba scenes**: PBRT v4 `.pbrt` files (with includes and PLY meshes) and Mitsuba `.xml` scenes (Mitsuba 3 and 2, with older 0.5 and 0.6 files upgraded on load) open in the Scene Viewer, also as a `.zip`. Materials become OpenPBR (diffuse, coated diffuse and plastic, glass, and metals with real-world colors) with image and checkerboard textures as MaterialX graphs; area lights glow and rectangular ones also light the scene, and distant lights, constant skies and environment maps come along. Instancing, media and less common shapes, lights and materials are skipped with a warning.
- [done] **Export USD**: export a glTF, GLB, OBJ, PBRT or Mitsuba scene as USD from the Scene Viewer, as USDA, USDC or USDZ. Materials are written either as referenced MaterialX files or as UsdShade networks (USDZ uses networks, since it cannot hold .mtlx files). Cameras, lights in UsdLux units and double-sided meshes carry over.
- [idea] **Export from USD scenes**: stages loaded from USD cannot be re-exported yet, although export works for glTF, GLB, OBJ, PBRT and Mitsuba scenes.
- [idea] **Skinning and animation in USD export**: skinned meshes and animations are not written yet.
- [idea] **glTF tangents in USD export**: write authored glTF tangents as a primvar so normal maps keep their original orientation.
- [idea] **KTX2 textures in USDZ**: compressed textures are not packaged into USDZ yet.
- [planned] **Survive broken stages**: a malformed prim still makes the whole stage fail to load. The viewer itself recovers with a fresh USD runtime; the goal is to skip the bad prim and show the rest.
- [idea] **Geometry budgets and instancing**: stages already stop subdividing at a triangle budget; bound the geometry a stage can load overall and draw repeated meshes with GPU instancing.
- [idea] **Variants and purposes**: let the user pick variant selections and render purposes; the runtime already supports both.
- [done] **Stage lights**: UsdLux distant, sphere, disk, rect and cylinder lights drive the lighting, with shadows.
- [done] **Dome light fallback**: a dome light whose texture is empty, missing or was not exported (for example V-Ray domes set to use a texture) keeps the default environment at the dome's intensity, with a warning, so rotation still works.
- [idea] **Camera tools**: stages already open on or switch to any authored camera, glTF cameras included, and the orbit camera stays above the studio floor; still to do are camera frustums in the viewport and field of view and clipping controls.
- [done] **Subdivision surfaces**: meshes authored with a subdivision scheme are subdivided at a selectable level.
- [done] **PointInstancer**: instanced geometry from PointInstancer prims.
- [done] **Transparency, refraction and bloom**: depth peeled transparency, colored light transmission, refraction through thick glass and bloom.
- [done] **Glass from any BSDF**: materials whose transparency comes from their BSDFs rather than a standard surface input, such as Disney Principled glass and layered dielectric graphs, now render transparent.
- [done] **Ambient occlusion**: a baked world occlusion volume combined with screen-space ambient occlusion.
- [done] **Material preview from the viewport**: double click an object to open its material in a floating preview and graph panel at the click point, with the stage's embedded textures carried into the preview and the Graph Editor. The preview and Open in Graph Editor carry only the clicked object's material, with its custom node definitions and textures, and a view-only material can be reopened as an editable copy.
- [done] **Sidebar before loading**: the Scene, Hierarchy and Statistics sections are always visible and fill in when a scene loads.
- [done] **Scenes from zip and folders**: every scene format loads from a .zip, a folder or a drop.
- [done] **Scene lighting extras**: sky visibility and diffuse bounce add indirect light shading to scenes at the Default and Quality levels.
- [done] **Scene texture budget**: limits on texture resolution and memory keep large scenes within the GPU, preferring KTX2.
- [planned] **Faster first material preview**: the first preview after loading a scene still takes a couple of seconds; hand the preview the shaders the viewport already generated.
- [planned] **glTF texture transforms**: check KHR_texture_transform offsets against the flipped texture coordinates that glTF import applies.
- [parked] **Screen-space reflections**: implemented but hidden while its behaviour is tuned.
- [idea] **Embeds, compare and gallery for scenes**: none of these exist for the Scene Viewer yet. A scene gallery would likely work differently from the material gallery.
- [idea] **Reload robustness**: reloading stages many times in one session hung twice, before the USD runtime started restarting itself every eight loads and after a minute idle. Whether that fully fixes it is not confirmed.

## Material Viewer

- [parked] **Path tracing mode**: a physically based path tracer next to the real-time view, so materials can be checked against a ground-truth render of the same document, with progressive refinement while the camera is still.
- [done] **Material gallery**: browse, search and filter the MaterialX example materials with live previews, licenses, permalinks and zip downloads.
- [done] **Preset picker**: one dialog, backed by the gallery, to pick a starting material in the Material Viewer, Compare and Graph Editor.
- [done] **Custom preview models**: load OBJ, GLB and multi-file glTF models, including Draco compressed meshes.
- [done] **Viewer and Compare redesign**: Render settings and Environment settings live in viewport popovers as in the Scene Viewer, with a Default or Quality preset, and the sidebars are flatter with a Files loaded list. A Statistics footer shows shader size, uniforms, textures and build time, with a Diagnostics button for material notices, and Compare shows per-document Statistics tabs above its Difference Metrics.
- [idea] **More backdrop options**: a backdrop like the Standard Shader Ball's, next to today's Studio, Studio dark, Environment and None.
- [done] **Support for ShadingLanguageX (SLX) viewing**: open .mxsl files in the Material Viewer; they are compiled to MaterialX by the ShadingLanguageX WASM bindings and rendered like any .mtlx document.
- [done] **Material Compare**: view documents side by side with per-document statistics and difference metrics.
- [done] **Choosing the MaterialX version**: pick the 1.39.5 or 1.39.4 runtime in the Material Viewer, Compare and embeds.
- [done] **GIF and turntable capture**: record a 360 degree GIF or take a screenshot in the viewers and the Scene Viewer.

## Node Graph and Tools

- [done] **Node definition authoring**: create and edit nodedefs and their implementation graphs, convert a graph into a node definition, and browse library nodegraphs read-only.
- [done] **Lossless .mtlx round trip**: saving keeps node order, comments and the original file's formatting, and the attribution comment is optional.
- [done] **Autosave and session recovery**: the Graph Editor autosaves and offers a session browser with graph and render previews after a crash.
- [done] **Interface input editing**: edit ui attributes, default values and colorspace on nodegraph interface inputs.
- [done] **Duplicate nodes**: Shift+drag duplicates the clicked node or the selection and drops the copies where you release; Shift+D and a Duplicate menu item do the same.
- [done] **Selection shortcuts**: Shift+click adds to the selection, Ctrl+click removes from it, and V toggles thumbnails of the selected nodes.
- [done] **Texture formats**: PNG, JPEG, WebP, GIF, BMP, TGA, TIFF, EXR, HDR and KTX2 textures, and an option to convert every texture in a zip export to PNG, JPEG or EXR.
- [done] **Node thumbnails**: the Graph Editor shows a small or large preview on each pattern and data node, rendered in the background so editing stays responsive. They are on by default and can be switched from the View menu, per node from the right-click menu or with V. Graphs with more than 50 nodes open with them off, and you can turn them on for that graph. Shader and material nodes can also show a preview on the shader ball, through a separate View menu setting that is off by default; displacement and Force Transparency are not shown in thumbnails yet.
- [idea] **Recipes for common node tree patterns**: ability to insert commonly used sequences of nodes from a "gallery" of node patterns - e.g. a texcoord, connected to a place2d, connected to an image.
- [done] **Support for a ShadingLanguageX (SLX) node**: a Graph Editor node whose nodegraph is written as ShadingLanguageX code on the node; editing the nodegraph rewrites the code.
- [done] **Support for ShadingLanguageX (SLX) import**: open .mxsl files in the Node Graph Editor, compiled to MaterialX and shown as a node graph.
- [done] **SLX code view**: a docked ShadingLanguageX code panel in the Graph Editor shows the open document as editable SLX code, with completion, and Decompile and Compile buttons to go between graph and code.
- [done] **Support for ShadingLanguageX (SLX) export**: export the current graph as ShadingLanguageX source from Export Shader Code, alongside the original .mxsl when the document came from one. Very large graphs decompile slowly.
- [done] **Shader code export**: Export Shader Code writes GLSL ES, GLSL, Vulkan GLSL, WGSL, MSL, Slang, OSL and MDL.

## Node Documentation

- [done] **Implementation preview**: a View implementation button shows a node's implementation graph in an inline read-only panel, with fullscreen and a shortcut into the Graph Editor that returns to the same docs page.
- [done] **Search by port type**: filter the node list by input and output types, for example every node with a surfaceshader output.

## Website

- [done] **About dialog**: credits for every bundled library and asset, and a link to the MaterialX release in use, in the web app, VS Code and the desktop app.
- [done] **Desktop app page**: a page for the desktop app with its features and download links for Windows, macOS and Linux from the latest release.
- [done] **VS Code page refresh**: the VS Code extension page lists everything the extension does today, including the sidebar, formatting, themes and the Scene Viewer.
- [done] **Blog**: a blog on the website for updates, deep dives and tips, written in Markdown, with tags, search and an Atom feed. Web only.
- [done] **Interactive tour**: the MaterialX Playground tour under About lets you write a material one line at a time and take it through every tool.
- [done] **Header reorganization**: the menu now reads Viewers, Graph Editor, Node Specs, Learn, Integrate and About.
- [done] **Embeddable viewer and Embed Builder**: a materialx-viewer element puts a live MaterialX preview on any web page, and the Embed Builder writes the snippet for you.
- [done] **What is MaterialX? page**: a Learn page with live viewer panes that explains the basics.
- [planned] **Pages search engines can find**: the tools and the node docs all live behind one address today, so search engines see a single page. Give every MaterialX node in the docs and every tool its own page with its own title and description, plus sitemaps for all of them.
- [planned] **Faster first load**: compile the app ahead of time instead of in the browser, so pages appear sooner on a first visit.

## Themes

- [done] **Theme colors**: Moved every color in the app, the embed and the integrations onto one set of named theme colors (surfaces, borders, text, accent, status), with the dark look unchanged, checked with before and after screenshots of every view.
- [done] **Light mode**: A light theme with a light, dark or system switch that follows the operating system's setting live unless you override it, on the website, in the desktop app, in VS Code and in embeds (as a `theme` attribute). The 3D viewport backdrop stays a separate setting.
- [done] **Custom themes and presets**: A theme can be a partial set of colors, and the missing ones are derived from a few seed colors (background, foreground and accent). A contrast check adjusts text and control colors that would be hard to read and rejects a theme it cannot fix. The built-in presets are made with the same engine: High contrast dark and High contrast light (WCAG AAA text), Dim and Paper, loaded only when chosen.
- [done] **Follow the VS Code theme**: A Match VS Code theme reads your editor's background, text and button colors, derives every other color from them with the same contrast check as the presets, and follows theme changes live. High contrast editor themes use the High contrast presets. It is on by default in the extension, with a setting to override it.
- [done] **Theme editor and sharing**: An in-app editor for your own themes, import and export, and theme settings shared across the website, the desktop app, VS Code and embeds. A custom theme is three base colors, optional per-color overrides and two sliders (contrast and tint), checked to WCAG AA when saved, and travels as a short theme code that you can paste into another app or into an embed's `theme` attribute.
- [done] **Legacy site stylesheet retired**: The old site-wide stylesheet is gone, and the app, the VS Code extension and the blog now take every color from the theme.
- [idea] **Visual regression tests for themes**: A committed screenshot suite that checks the dark, light and preset themes, including runs in the real desktop app and in real VS Code.

## Desktop App

- [done] **Desktop app**: an experimental desktop app for Windows, macOS and Linux ships with every release. It has native open and save, recent files, file watching, a Windows jump list and the app's light, dark and custom themes, and CI builds and smoke-tests the installers.
- [done] **Mac verification**: traffic-light gutter, Reveal in Finder, ad-hoc signing on the runner, general testing and validation.
- [done] **Opens scenes from disk**: opening or dropping a scene file reads every file it references straight from disk, including mapped and network drives and absolute or UNC paths, so a single .gltf, .usd, .obj or .pbrt is enough.
- [done] **File associations**: MaterialX, USD, glTF, GLB, OBJ, MTL and PBRT files open in the desktop app (Open with, double-click), and a lone .mtl opens as a MaterialX document in the Graph Editor.

## Tutorials

- [planned] **Initial batch of tutorials**: 101-styled intro to MaterialX, covering both devs (on C++, Python and Java Script bindings) and artists.

## VSCode Extension

- [done] **Auto-complete on VSCode**: snippets for common material patterns plus auto-complete for node names, node inputs, and reference attributes (type, node name, node graph, output, interface name, color space, node definition) while editing `.mtlx` files directly.
- [done] **Scene Viewer in VS Code**: open .usd, .usda, .usdc, .usdz, .gltf, .glb and .obj files, with progress and cancel.
- [done] **A real .mtlx editor**: live validation, hover documentation for nodes, rename, formatting, clickable file links, an outline with go to definition and find references, and color swatches with a picker.
- [done] **Sidebar and commands**: Actions, Insert Node, the document's textures and files, and an outline in sync with the Graph Editor, plus Open in Graph Editor, Open in Material Viewer, Open in Scene Viewer, Open Node Library Documentation, New MaterialX Document and New Material from Example.
- [done] **Restricted Mode**: workspace trust is supported, referenced files stay inside the workspace, and validation runs off the editor thread.
- [idea] **ShadingLanguageX (SLX) in the VSCode extension**: open .mxsl files in the extension, compiled to MaterialX and shown in the viewer and graph editor as view-only documents, with the ShadingLanguageX export target available there too.
- [in progress] **Officially Releasing extension on VSCode Extensions**: publish the extension on the VS Code Marketplace so it is easier to find, install and update. A publish workflow for the VS Code Marketplace and Open VSX is ready; the first listing goes out with a release.
