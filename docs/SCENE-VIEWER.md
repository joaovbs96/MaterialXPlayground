# How the Scene Viewer works

The Scene Viewer does not render USD structures directly, and it does not hand three.js a loaded file either. Every supported format is turned into one common, plain-JS structure (the neutral stage payload), and a single renderer draws that payload with three.js and MaterialX-generated shaders. Only USD files go through real OpenUSD structures, and only inside a worker.

```
 .usd/.usda/.usdc/.usdz              .gltf/.glb            .obj + .mtl        .pbrt + .ply         .xml + .obj
          │                              │                      │                   │                    │
  USD worker (OpenUSD wasm)        gltf-stage-loader     obj-stage-loader    pbrt-stage-loader   mitsuba-stage-loader
  composes the stage, then         (three GLTFLoader)    (three OBJLoader)   (three PLYLoader)   (three OBJLoader)
  Extract* calls flatten it              │                      │                   │                    │
          │                              └──────────┬───────────┴───────────────────┴────────────────────┘
          ▼                                         ▼
        ┌─────────────── neutral stage payload ───────────────┐
        │ meshes: typed arrays (positions, normals, uvs,      │
        │         indices, matrix, materialPath, geomprops)   │
        │ materials: a MaterialX document per material        │
        │ cameras, lights: USD-shaped records                 │
        │ assets: texture bytes      summary, warnings        │
        └──────────────────────────┬──────────────────────────┘
                                   ▼
             usd-scene-renderer.js (the "stage adapter")
             three.js BufferGeometry per mesh, and per material
             MaterialX → ESSL via the engine → RawShaderMaterial,
             rendered through the shared MtlxRender session
```

## Loaders: five formats, one output

- **USD** (`js/usd/usd-stage-loader.js`, `js/usd/usd-stage-worker.js`): the OpenUSD WebAssembly runtime runs in a persistent worker. It composes the stage (references, variants, payloads, MaterialX), then calls such as `ExtractMaterialPayloads` and `ExtractTransformsAtTime` flatten it into the payload. UsdShade networks come back as MaterialX documents; UsdPreviewSurface is converted to MaterialX.
- **PBRT v4** (`js/usd/pbrt-stage-loader.js`): our own parser reads the `.pbrt` text (plus `Include`/`Import` files) on the main thread; `plymesh` shapes go through three.js's `PLYLoader` (`.ply.gz` is inflated with pako first), `trianglemesh` shapes are read directly. Drop the `.pbrt` together with every file it names (usually a `models/` folder of `.ply` files). Details below.
- **Mitsuba** (`js/usd/mitsuba-stage-loader.js`): our own small XML reader parses a Mitsuba 3 or 2 scene `.xml` (0.5/0.6 files are upgraded first); `obj` shapes go through three.js's `OBJLoader` (the scene assigns the materials, any `mtllib` is ignored), `rectangle` shapes are tessellated. Drop the `.xml` together with its `models/` folder. Details below. Helpers both renderer importers share (paths, matrices, transform baking, camera lens, payload records) live in `js/usd/scene-import-common.js`.
- **glTF/GLB** (`js/usd/gltf-stage-loader.js`) and **OBJ + MTL** (`js/usd/obj-stage-loader.js`): three.js's own loaders parse the file on the main thread, then our code copies the geometry into the same typed arrays and builds one MaterialX document per material in `js/usd/mtlx-material-docs.js` (`gltf_pbr` for glTF, `open_pbr_surface` for OBJ/MTL). glTF cameras and punctual lights become the same USD-shaped records the USD path produces.

## PBRT v4 import

- **Handedness.** pbrt cameras look down +z; ours look down -z. When the scene's camera transform is a proper rotation (a left-handed pbrt scene), the world Z axis is mirrored once at import, baked into positions, normals, triangle winding, lights and the camera, so the view matches pbrt's image without a negative-scale root. Scenes whose camera transform already flips handedness (common for exports from right-handed tools) need no mirror. `pbrtHandedness()` holds the rule.
- **Camera.** `Camera "perspective"`: `fov` spans the shorter image axis (from `Film` `xresolution`/`yresolution`), turned into a 36 mm wide aperture and a focal length.
- **Materials** (one `open_pbr_surface` document each, `pbrtMaterialDocument()` in `mtlx-material-docs.js`): `diffuse`, `coateddiffuse` (diffuse base under a coat with `coat_ior` = eta), `dielectric` (full transmission, `specular_ior` = eta) and `conductor` (base color = normal-incidence reflectance from eta and k, `specular_color` = OpenPBR's F82 tint; named `metal-*` spectra use an RGB table from Tungsten's `ComplexIorData.hpp`). Roughness: pbrt alpha is `sqrt(r)` when `remaproughness` is true (the default) or `r` itself; the OpenPBR roughness is `sqrt(alpha)`.
- **Lights.** `AreaLightSource "diffuse"` makes the shape emissive: `emission_color` = L times `scale`, `emission_luminance` = 1, which is literal radiance in MaterialX's `uniform_edf`. Emitters light both faces here (pbrt's default is the front face only). A constant `LightSource "infinite"` becomes a uniform dome light (colour = L). Other lights, textures, instancing, analytic shapes, media and other material types are skipped with a warning.

## Mitsuba import

- **Versions.** Scenes with `version` 3.x and 2.x are read as they are. Older files (0.5, 0.6) get the same upgrade Mitsuba 3 applies (`upgrade_tree` in its `xml.cpp`): every `name` attribute except on `<default>` goes from camelCase to snake_case (`toWorld` to `to_world`, `intIOR` to `int_ior`), `<lookAt>` becomes `<lookat>`, a `diffuse` bsdf's `diffuse_reflectance` becomes `reflectance`, and ids starting with `_` are renamed. `<default>` values replace `$name` references in every attribute.
- **Coordinates.** Mitsuba is right-handed like the Scene Viewer, so geometry is never mirrored. Its camera looks down +z of `to_world` with +x pointing to the image left (`lookat` builds the columns left, up, direction, origin); ours looks down -z with +x to the right, so the camera matrix is `to_world` times a flip of x and z (a rotation, not a mirror). Scale in `to_world` is dropped.
- **Camera.** `sensor "perspective"`: `fov` spans the axis named by `fov_axis` (`x` by default, also `y`, `diagonal`, `smaller`, `larger`), with the aspect from the film's `width`/`height` (Mitsuba's defaults 768 x 576). Without `fov`, `focal_length` (default `50mm`, 35 mm equivalent) sets a diagonal fov.
- **Materials** (one `open_pbr_surface` document per bsdf id or inline bsdf, `mitsubaMaterialDocument()` in `mtlx-material-docs.js`): `diffuse` (`base_color` = reflectance, `specular_weight` 0); `plastic`/`roughplastic` (OpenPBR's ordinary dielectric base, `specular_ior` = int_ior/ext_ior, defaults polypropylene in air; `base_color` is solved per channel so OpenPBR's hemispherical diffuse albedo `b (1 - E_spec)` matches Mitsuba's `R / (1 - k Fdr_int) (1 - Fdr_ext)^2 / eta^2`, with `k = R` when `nonlinear` is set and 1 otherwise, clamped to [0, 1] with a note; `roughplastic` uses the smooth-interface Fresnel terms, `mitsubaPlasticBaseColor()`); `conductor`/`roughconductor` (the PBRT importer's F0 plus F82 mapping and named-metal RGB table, `material="none"` is a perfect mirror, `specular_reflectance` multiplies `base_color`); `dielectric`/`roughdielectric`/`thindielectric` (full transmission, `specular_ior` = int_ior/ext_ior). Named IORs use Mitsuba's table (unknown names: 1.5). Roughness is `sqrt(alpha)`; anisotropic `alpha_u`/`alpha_v` are averaged, and the Beckmann distribution is rendered with OpenPBR's GGX. `twosided` unwraps to its (front) bsdf and makes the mesh double-sided.
- **Normals.** `face_normals` = true gives flat shading (the mesh is split per face); otherwise the OBJ's own normals are used, or smooth ones are computed with no crease angle, as Mitsuba does.
- **Lights.** An `emitter "area"` child makes the shape emissive exactly like pbrt's area lights (`emission_color` = radiance, `emission_luminance` = 1), lit from both faces here (Mitsuba emits from the front face only). A top-level `emitter "constant"` becomes a uniform dome light. Textures, other shapes, emitters and bsdfs, media, instances, `<include>` and spectral files are skipped with a warning.

## Renderer: one path for every format

`js/usd-scene-renderer.js` only ever sees the payload; it does not know which format a scene came from. It builds three.js geometry per mesh, and every material goes through the same MaterialX shader generation as the Material Viewer (`js/mtlx-engine.js`), then renders through the shared render session (`js/shared/render-session.js`, `MtlxRender`). That is why the Scene Viewer and the Material Viewer share render settings, effects and the session code.

## USD keeps a live stage, glTF, OBJ, PBRT and Mitsuba do not

For USD scenes the composed stage stays alive in the worker after loading. Changing a variant, toggling a payload or scrubbing time asks the worker for an updated snapshot, so the payload is a view of the stage, not a replacement for it.

glTF, OBJ, PBRT and Mitsuba scenes have no stage behind them: the payload is all there is.

## Export USD runs the pipe backwards

"Export USD" (`js/usd/usd-stage-export.js` plus the worker's `exportStage` handler) takes the payload of a glTF, OBJ, PBRT or Mitsuba scene and asks the OpenUSD runtime (`ExportStage`, from the USDBindings release) to build a real USD stage from it for the first time. The materials are written either as referenced `.mtlx` files or flattened into native UsdShade networks.

Export is limited to glTF, OBJ, PBRT and Mitsuba scenes for now partly because of the previous section: a USD scene's payload is a flattened view of a richer stage (variants, references, payloads), so exporting it would lose structure the original file already has.
