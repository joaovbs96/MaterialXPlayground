# Roadmap

This file is the single source of truth for the project roadmap. The website's Roadmap page reads it at view time, so add, update or remove items here and nowhere else.

Format: one item per bullet, `- [status] **Title**: one or two sentences.` Statuses: `idea`, `planned`, `in progress`, `parked`, `done`. Keep titles short and stable so links to them keep working. Sections are areas of the project.

## USD Scene Viewer

- [in progress] **KTX2 compressed textures**: cook script that bakes `.ktx2` siblings next to source textures, resolver that prefers them, planner that counts compressed bytes. Branch `ktx2-textures`, pending the toktx verification at 4096.
- [planned] **UsdPreviewSurface to MaterialX**: convert the runtime's flattened UsdPreviewSurface payload into a MaterialX document using the standard `UsdPreviewSurface` and `UsdUVTexture` nodes, so both material kinds render through one pipeline.
- [idea] **glTF scenes through MaterialX**: a second stage adapter that reads glTF or GLB (hierarchy, meshes, cameras) and converts glTF PBR materials to `gltf_pbr` MaterialX, sharing the renderer with USD.
- [planned] **Material Viewer and Scene render session**: pull the view layer out of the Viewer closure into shared, scene-capable modules (peel pipeline done; texture pipeline, environment bridge, diagnostics, one handle contract) so feature parity is structural. Includes environment broadcast, key light toggle, GIF transparent option, HUD parity, anisotropic filtering and one decode colour policy.
- [planned] **Document validation at load**: report duplicate input names, unknown colorspaces, type mismatches and out-of-range mix weights in one Diagnostics list instead of letting MaterialX drop them silently.
- [planned] **Runtime recovery after a wasm abort**: a malformed prim currently kills the whole USD module; recreate the module per stage and skip the offending prim, or rebuild the runtime with exception handling.
- [planned] **Texture pipeline in a worker with a quiet load**: decode off the main thread, hold prims neutral until their textures bind, one progress line, cancelable texture work.
- [planned] **Linear compositing for Scene transparency**: the depth-peel composite runs in display space today; the linear path needs a linear-output mode for opaque MaterialX materials during the merged pass.
- [idea] **Triangle and prim budgets with GPU instancing**: nothing bounds geometry today; repeated meshes should share GPU buffers and instance matrices.
- [idea] **Single-channel textures as R8**: masks upload as RGBA today; a red-only format saves about a third of a texture-heavy scene's memory.
- [idea] **Variants, payloads and purposes in the UI**: the runtime exposes variant selection and payload loading; the viewer does not.
- [idea] **Stage lights**: read `UsdLux` lights and drive the MaterialX light rig from them (`extractStageLights` exists in the runtime).
- [idea] **Camera UX**: show camera frustums, open on a stage's single authored camera, expose field of view and clipping.
- [idea] **Scene embeds, compare and gallery**: the Scene route has no embed or compare mode and no gallery entry.
- [parked] **Displacement**: Loop subdivision removed the tessellation blocker; remaining shape is bake the displacement network to a UV-space target, displace on the CPU with seam averaging, recompute normals, in Viewer and Scene.
- [parked] **Stirling asset look**: sub-pixel `flake3d`, unclamped BSDF mix weights and default bump scale are authored behaviour; only progressive accumulation or a mix-weight clamp decision could change it.
- [idea] **Stage reload robustness**: repeated reloads in one long browser session hung twice during diagnosis runs; never root-caused.
- [done] **Round 5**: texture tiers to Original with a memory budget, TIF, EXR and HDR decode in the Scene, type-mismatch diagnostics, Scene Force Transparency, camera import and selector, runtime provisioning through `npm run vendor`, Node minimum 22.12.

## Material Viewer

- [planned] **Upstream MaterialXView parity gaps**: texcoord index clamp, extra vertex streams (partly done through geomprop aliasing), matrix uniform defaults, float texture mips; the audit lives in the local parity notes.
- [idea] **Texture resolution tier in the Viewer**: the Scene has tiers and a budget, the Viewer loads at source size.
- [idea] **Progressive supersampling when the camera is still**: jittered accumulation would converge sub-pixel procedurals and edges the way a path tracer does.

## Path Tracer

- [parked] **Round one leftovers**: SSS time-box (marble overbrightness isolated to the random walk), split-shade specular pdf sign, below-hemisphere NEE asymmetry, origin epsilon scaling, firefly clamp versus HDR sun measurement, megakernel retirement, sampler-budget fallback redo, base ring as a bare-surface document.
- [parked] **Ketchup subsurface**: black plus fireflies; reference-first plan written, waits on the SSS time-box.
- [idea] **Polish ledger**: WebGPU backend, blue noise, denoiser wiring, live animation, HUD improvements, knob cull, an ANGLE Vulkan option for Electron.

## Node Graph and Tools

- [in progress] **Feature batch verification**: zip scan fix, texture-format export, TIF import, interface editing and graph autosave are on local branches awaiting the manual checklist before push.
- [parked] **Graph Editor restyle**: the Viewer and Compare restyle shipped; the Graph Editor spec is ready on the design canvas.
- [in progress] **Builder redesign**: settled decisions (defaults template first, version dropdown, masonry layout) on branch `builder-redesign`, uncommitted.
- [idea] **Docked chrome and dropdown standardization follow-ups**: both landed; remaining items are the silent test traps documented in memory.

## Desktop App

- [planned] **Electron merge**: stability round complete on `electron-app`; awaiting the manual checklist, then merge to main without a release tag, then a push so the desktop smoke workflow can prove the CI step.
- [idea] **Mac verification**: traffic-light gutter, Reveal in Finder, ad-hoc signing on the runner.

## Site and Infrastructure

- [planned] **Roadmap page**: this file rendered on the website at view time.
- [idea] **Gallery deploy**: the live site gets gallery data only on release; local pack warns until then.
- [idea] **Home and header redesign PR**: implemented on branch `home-redesign`, pending review.
- [done] **Onboarding**: `npm ci`, `npm run vendor`, `npm run build`; Node 22.12 or newer; clone outside synced folders.
