# MaterialEggs parity: dropped and parked items

Decided by the project owner on 2026-09-21 during the Karma parity round on the USD Scene viewer. Each entry records what was found, why it stops here, and what a future resume would need. Evidence directories are under scratchpad/displacement-verified (not tracked); the summary here is the durable record.

## Dropped

### Diffuse bounce (indirect light) term

Three implementations were built and committed (fa73f24, 75ee6b4, ae3d661) and all verified correct in isolation, but none exceeded 1 to 2 percent of Karma's beauty on egg_brown where Karma's indirect diffuse is 19 percent on the color chart, 25 to 28 percent on the gray sphere and 9 to 27 percent on the egg shadow side. An instrumented run finally read the per-cell values and found three mechanical defects in the current version: the key light contribution to blocker cells uses the travel direction with the wrong sign (js/usd-scene-renderer.js near the blocker irradiance sampler), the cyc wall receives the 0.5 albedo fallback instead of 0.8, and the SH1 projection is normalised over the full sphere instead of the hemisphere. A hand calculation with those corrected gives 0.197 of direct against Karma's 0.23. The feature stays in the code behind the Scene setting "Diffuse bounce" (default on at strength 1.0 with its small effect; it is safe and tested). Resume point: apply the three fixes with a unit test that asserts the key contribution on an up-facing blocker and the wall albedo, then re-measure the chart against Karma beauty (target about 0.90 of beauty after the ACEScg colour setting and the layering factor).

### Subsurface red excess

The viewer's subsurface share on shadow and side regions of egg_brown is higher and redder than Karma's (0.30 versus 0.22 of the render). It is not an occlusion defect: occlusion is applied once on the aggregate closure, which is linear in each term, so subsurface receives the same occlusion as diffuse. The difference is the MaterialX library approximation (indirect subsurface rendered as diffuse tinted by the subsurface colour, no depth falloff) against Karma's volumetric scattering. A renderer capability gap. Resume point: a proper subsurface approximation (screen-space or pre-integrated) is a feature, not a fix.

### Crystal facets

The cut facets of egg_crystal are displaced correctly (height texture sampled on all vertices, level 0 resolves the facet frequency) but are invisible because the viewer draws the glass without refraction or local reflections, so the backdrop shows straight through. Folded into the refraction feature; nothing to do on the displacement side.

### Dispersion

egg_crystal authors transmission_dispersion = 10, which survives extraction but is unused by the bundled scalar-IOR shading. MaterialX's standard shading does not support dispersion well at present. Dropped.

### Depth of field

Karma renders at f/22 with focus at 0.406 m; the effect is a slight softening of the backdrop grid. Cosmetic. Dropped.

### VDB volume (egg_jade)

No practical WebGL2 path in this viewer beyond a bounding-box density approximation. Dropped.

## Parked

### Raster test harness renders black

tests/raster/run.mjs renders every fixture as all-zero pixels on genuine d3d11 and on SwiftShader for the bundles of d75d0e6, 3f1a9ab and main (eff263e) alike; programs link, no GL error, no page errors; the suite is not wired into any CI workflow. Classified as a local or harness problem, not a regression. Substitute gate used meanwhile: unit suite, embed canary specs, Scene captures, and a headed Viewer page render with a nonzero-pixel check (scratchpad/displacement-verified/raster-check/viewer-smoke.mjs). Needs its own ticket.

## Kept for reference: measurement lessons from this round

- Never reimplement the lat-long projection or the EXR row order for a measurement; use the engine's own convolution and lookup. Three hand-written variants each produced a confident wrong conclusion (a bogus 1.235 factor, a bogus key-light bug, a bogus dome flip).
- Isolated material variants (specular off, base off) are non-additive by design because of standard_surface layering; treat them as bounds, not shares.
- The Scene harness can store an app error in React state and then wait forever; read the error state instead of assuming a hang.
