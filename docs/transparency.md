# Transparency: how opacity and transmission render (and why the shader alone isn't enough)

**The symptom this solves**

Out of the box, no material in this preview ever rendered see-through — editing opacity
just darkened the ball toward black, fully black at `opacity = 0`. Not a bug specific to
this codebase: the stock MaterialX web viewer this preview was modeled on behaves the same way.

**How MaterialX decides transparency**

Transparency is decided at shader-generation time: `MaterialX::isTransparentSurface(renderable,
target)` inspects the resolved document and picks one of two pixel-shader epilogues via the
`hwTransparency` generator option:

- Opaque (`hwTransparency = false`): opacity is multiplied into the surface color, and the
  output is `vec4(surface.color, 1.0)` — alpha pinned to 1. This is why lowering opacity
  darkens toward black instead of fading: the shader scales RGB, not coverage.
- Transparent (`hwTransparency = true`): `outAlpha = clamp(1.0 - dot(surface.transparency,
  vec3(0.3333)), 0.0, 1.0)`, output `vec4(surface.color, outAlpha)`, plus a `u_alphaThreshold`
  discard (generator default `0.001`, delivered here through the introspected-uniform upload).

**Why writing alpha does nothing by itself**

Alpha blending is host-engine state, not shader code — no fragment shader can switch it on.
In three.js, `transparent: false` (the default) renders in the opaque pass with GL blending
disabled, so any alpha the shader writes is discarded at the blend stage. Relying on the
generated shader alone, as the stock viewer does, renders everything opaque even when
MaterialX generated the transparent-path shader.

**What this project does differently**

Two wires the stock approach lacks:

1. *The verdict reaches the material.* `generatePreviewSourcesUnlocked` (js/mtlx-engine.js)
   captures the `hwTransparency` value it wrote and returns it with the shader sources as
   `{ vs, fs, introspected, transparent }`. `applyMaterialInternal` maps that onto the
   `RawShaderMaterial` (`transparent: true` + `depthWrite: false` when transparent AND
   Force Transparency is on — see below — stock defaults otherwise); the view handle
   stores it as `view.isTransparent`, and
   `tryRefreshRenderView`'s refresh gate compares it against the regenerated verdict so a
   flip always forces a rebuild.
2. *The verdict is re-evaluated when values change.* Value edits take a uniform-only fast
   path that skips regeneration to keep drags cheap, so an opaque-generated material would
   otherwise never become transparent no matter how far you dragged opacity. After each
   committed fast-path edit, `scheduleTransparencyRecheck` (js/graph-app.jsx) calls
   `checkTargetTransparency` — a single wasm-lock hold that rebuilds the renderable, re-runs
   `isTransparentSurface`, and cleans up — bumping the document revision only on a flip. It's
   name-agnostic (re-derives from the whole graph, so it catches interface-forwarded or
   custom-named inputs a name heuristic would miss) and never regens needlessly. Drags stay
   on the fast path, so crossing the boundary mid-drag still darkens until the commit lands
   (~300ms after release), then snaps to true blending. The viewer app needs no re-check —
   no editing UI means a doc-authored transparent material gets the right verdict on first
   generation.

**Opt-in via Settings**

The behavior above is gated behind Settings → Force Transparency (cogwheel in each
view's viewport controls), persisted in `localStorage` ('mtlxForceTransparency') and
**off by default** — off means official-viewer parity: the verdict stays write-only
and previews render opaque, matching the pre-feature behavior above; on enables the
`transparent`/`depthWrite: false` flags described above and below. The shader's alpha
output is generated regardless of the setting — only the blend flags are gated — so
toggling updates those flags on live materials in place: the change is instant and no
preview rebuild happens.

**Deliberate tradeoffs**

- Straight (non-premultiplied) alpha with three.js's default `NormalBlending`, matching the
  MaterialX epilogue — don't set `premultipliedAlpha`.
- `DoubleSide` + `transparent` + `depthWrite: false` (when the setting is on): r128 does
  no intra-mesh sorting, so back/front self-overlap artifacts on the ball are possible —
  accepted for preview quality, no depth-prepass.
- Transmission renders as tinted alpha-blend (`alpha = 1 − average transparency`), not
  refractive glass — MaterialX's own rasterizer-preview approximation, inherited from the
  in-wasm epilogue and identical to the official viewer.
- The docs page's node previews have their own live uniform-edit path that doesn't hook the
  re-check yet (known follow-up).

**Code map**

- js/mtlx-engine.js — `generatePreviewSourcesUnlocked` (verdict capture),
  `applyMaterialInternal` (material flags), `tryRefreshRenderView` (flip gate),
  `checkTargetTransparency` (commit-time re-check helper).
- js/graph-app.jsx — `scheduleTransparencyRecheck`, `applyParamEdit` (commit hook).
