# Transparency: how opacity and transmission render (and why the shader alone isn't enough)

**The symptom this solves**

Out of the box, no material in this preview ever rendered see-through, editing opacity
just darkened the ball toward black, fully black at `opacity = 0`. Not a bug specific to
this codebase: the stock MaterialX web viewer this preview was modeled on behaves the same way.

**How MaterialX decides transparency**

Transparency is decided at shader-generation time: `MaterialX::isTransparentSurface(renderable,
target)` inspects the resolved document and picks one of two pixel-shader epilogues via the
`hwTransparency` generator option:

- Opaque (`hwTransparency = false`): opacity is multiplied into the surface color, and the
  output is `vec4(surface.color, 1.0)`, alpha pinned to 1. This is why lowering opacity
  darkens toward black instead of fading: the shader scales RGB, not coverage.
- Transparent (`hwTransparency = true`): `outAlpha = clamp(1.0 - dot(surface.transparency,
  vec3(0.3333)), 0.0, 1.0)`, output `vec4(surface.color, outAlpha)`, plus a `u_alphaThreshold`
  discard (generator default `0.001`, delivered here through the introspected-uniform upload).

**Why writing alpha does nothing by itself**

Alpha blending is host-engine state, not shader code, no fragment shader can switch it on.
In three.js, `transparent: false` (the default) renders in the opaque pass with GL blending
disabled, so any alpha the shader writes is discarded at the blend stage. Relying on the
generated shader alone, as the stock viewer does, renders everything opaque even when
MaterialX generated the transparent-path shader.

**What this project does differently**

Three wires the stock approach lacks:

1. *The verdict reaches the material.* `generatePreviewSourcesUnlocked` (js/mtlx-engine.js)
   captures the `hwTransparency` value it wrote and returns it with the shader sources as
   `{ vs, fs, introspected, transparent }`. `applyMaterialInternal` stores the raw verdict as
   `viewIsTransparent`; the view handle stores it as `view.isTransparent`, and
   `tryRefreshRenderView`'s refresh gate compares it against the regenerated verdict so a
   flip always forces a rebuild.
2. *The verdict is re-evaluated when values change.* Value edits take a uniform-only fast
   path that skips regeneration to keep drags cheap, so an opaque-generated material would
   otherwise never become transparent no matter how far you dragged opacity. After each
   committed fast-path edit, `scheduleTransparencyRecheck` (js/graph-app.jsx) calls
   `checkTargetTransparency`, a single wasm-lock hold that rebuilds the renderable, re-runs
   `isTransparentSurface`, and cleans up, bumping the document revision only on a flip. It's
   name-agnostic (re-derives from the whole graph, so it catches interface-forwarded or
   custom-named inputs a name heuristic would miss) and never regens needlessly. Drags stay
   on the fast path, so crossing the boundary mid-drag still darkens until the commit lands
   (~300ms after release), then snaps to true blending. The viewer app needs no re-check,
   no editing UI means a doc-authored transparent material gets the right verdict on first
   generation.
3. *A verdict of "transparent" actually renders translucent,* via a depth-peel render graph
   instead of three.js's own per-material blend state (see "The depth-peel render graph" below).

**The depth-peel render graph**

Force Transparency ON does not set `material.transparent = true`. `syncMeshMaterialMode`
(js/mtlx-engine.js) always leaves the mesh material at `transparent: false, depthWrite: true`,
because mixing three.js's own blend state with the peel technique below would double-blend and
corrupt the peel discard's depth comparisons. Instead, `renderFrame` runs a fixed front-to-back
order-independent-transparency pass whenever a view's material is both transparent-verdict and
Force Transparency is on:

1. Render the opaque scene once, into `opaqueRT` (its depth texture anchors every peel
   comparison below).
2. Peel up to `PEEL_LAYERS` (8) nearest layers of the transparent mesh only: each pass discards
   anything at or in front of the previous layer (`u_peelPrevDepth`, baked into every generated
   shader by `injectPeelDiscard`, gated behind the `u_peelMode` uniform so toggling the setting
   never needs a regen/recompile), then under-composites that layer's color into `accumRT`
   (`accum.rgb += T * a * color; T *= 1 - a`, the standard depth-peel accumulation).
3. Composite `accumRT` over `opaqueRT` into the canvas.

`patchTransmissionAlpha` (js/mtlx-engine.js) rewrites the generated fragment shader, only while
`u_peelMode != 0`, so the alpha that feeds this accumulation reads as glass instead of a flat
haze: raw `outAlpha` barely varies by view angle on its own (measured directly, not assumed), so
a transmissive material would otherwise render either fully opaque (no fold) or a uniform low
ghost (the old fold, which zeroed out for a fully white `transmission_color`). The current fold
first derives a transmission-weighted base (`alpha' = a * (1 - tT)`, `tT = transmission_weight *
average(transmission_color)`), then mixes that base toward full opacity by a Schlick-style
`pow(1 - abs(NdotV), 5)` rim term computed from the shader's own `normalWorld`/`positionWorld`/
`u_viewPosition`, so grazing angles read as a reflective edge and a 0.05 floor keeps clear-glass
sheen above `u_alphaThreshold`. `abs(NdotV)` (not a plain clamp to `[0, 1]`) matters here: the
peel loop also draws inward-facing back walls of the same `DoubleSide` mesh, whose `dot(N, V)`
is negative, and a plain clamp would misread every one of those layers as maximally grazing.
`mx_surface_transmission`'s own environment-radiance refraction approximation is scaled by
`PEEL_REFRACTION_SCALE` (0.5) while peeling, a deliberate energy compromise: that RGB term is a
guess at what's behind the surface, and the peel's own alpha compositing is now ALSO showing the
real scene behind it, so showing both at full strength would double-count.

**Opt-in via Settings, and the non-persisting embed path**

The behavior above is gated behind Settings -> Force Transparency (cogwheel in each view's
viewport controls), persisted in `localStorage` (`mtlxForceTransparency`) and **off by
default**, off means official-viewer parity: the verdict stays write-only and previews render
opaque, matching the pre-feature behavior above; on enables the depth-peel graph described
above. The shader's alpha output is generated regardless of the setting, only the render path
is gated, so toggling updates a live material in place: the change is instant and no preview
rebuild happens.

`setForceTransparency(v, { persist })` (js/mtlx-engine.js) defaults to `persist: true`, matching
a visitor's direct gesture on a Settings toggle or the embed HUD's own checkbox. `embed/embed-
boot.js`'s two host-driven paths, the initial `forcetransparency` query param and the live
`setForceTransparency` postMessage command, both pass `persist: false`: a host embedding this
viewer (including this site's own graph editor and What is MaterialX previews, which always set
the `forceTransparency` attribute on their `<materialx-viewer>` elements) applies the flag to
that one instance without silently overwriting every other tab or page's shared preference on
this origin. Omitting the param entirely still starts an embed from whatever that shared
preference already is.

**Deliberate tradeoffs**

- Straight (non-premultiplied) alpha, matching the MaterialX epilogue, don't set
  `premultipliedAlpha`.
- `DoubleSide` peeling: r128 does no intra-mesh sorting, so relying on draw order alone would
  self-overlap on the ball; the peel loop's own depth comparisons are what keep layers ordered
  correctly instead, at the cost of a fixed `PEEL_LAYERS` (8) budget, accepted for preview
  quality.
- `u_refractionTwoSided` is `false`, matching upstream MaterialXView's `LightHandler` default
  (`true` would square the transmission tint in `mx_surface_transmission`, visibly affecting
  only tinted transmission, not clear glass).
- Transmission's RGB still comes from an environment-map refraction approximation, not real
  scene geometry visible through the surface, MaterialX's own rasterizer-preview technique,
  inherited from the in-wasm epilogue. The alpha channel's Fresnel rim (above) is this project's
  own addition on top of that, tuned by rendering real glass materials, not derived from the
  MaterialX spec.
- The docs page's node previews have their own live uniform-edit path that doesn't hook the
  re-check yet (known follow-up).

**Code map**

- js/mtlx-engine.js, `generatePreviewSourcesUnlocked` (verdict capture), `applyMaterialInternal`
  (material creation), `syncMeshMaterialMode` (blend/depth flags, peel gating),
  `tryRefreshRenderView` (flip gate), `checkTargetTransparency` (commit-time re-check helper),
  `patchTransmissionAlpha` (alpha fold and Fresnel rim), `injectPeelDiscard` (per-layer discard,
  baked into every shader), `renderFrame` (the peel/composite render graph),
  `setForceTransparency`/`getForceTransparency` (the persisted flag and its non-persisting mode).
- js/graph-app.jsx, `scheduleTransparencyRecheck`, `applyParamEdit` (commit hook).
- embed/embed-boot.js, the `forcetransparency` query param and `setForceTransparency` postMessage
  handler, both applying the flag with `persist: false`.
