# How the Scene Viewer works

The Scene Viewer does not render USD structures directly, and it does not hand three.js a loaded file either. Every supported format is turned into one common, plain-JS structure (the neutral stage payload), and a single renderer draws that payload with three.js and MaterialX-generated shaders. Only USD files go through real OpenUSD structures, and only inside a worker.

```
 .usd/.usda/.usdc/.usdz              .gltf/.glb            .obj + .mtl        .pbrt + .ply
          │                              │                      │                   │
  USD worker (OpenUSD wasm)        gltf-stage-loader     obj-stage-loader    pbrt-stage-loader
  composes the stage, then         (three GLTFLoader)    (three OBJLoader)   (three PLYLoader)
  Extract* calls flatten it              │                      │                   │
          │                              └──────────┬───────────┴───────────────────┘
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

## Loaders: four formats, one output

- **USD** (`js/usd/usd-stage-loader.js`, `js/usd/usd-stage-worker.js`): the OpenUSD WebAssembly runtime runs in a persistent worker. It composes the stage (references, variants, payloads, MaterialX), then calls such as `ExtractMaterialPayloads` and `ExtractTransformsAtTime` flatten it into the payload. UsdShade networks come back as MaterialX documents; UsdPreviewSurface is converted to MaterialX.
- **PBRT v4** (`js/usd/pbrt-stage-loader.js`): our own parser reads the `.pbrt` text (plus `Include`/`Import` files) on the main thread; `plymesh` shapes go through three.js's `PLYLoader` (`.ply.gz` is inflated with pako first), `trianglemesh` shapes are read directly. Drop the `.pbrt` together with every file it names (usually a `models/` folder of `.ply` files). Details below.
- **glTF/GLB** (`js/usd/gltf-stage-loader.js`) and **OBJ + MTL** (`js/usd/obj-stage-loader.js`): three.js's own loaders parse the file on the main thread, then our code copies the geometry into the same typed arrays and builds one MaterialX document per material in `js/usd/mtlx-material-docs.js` (`gltf_pbr` for glTF, `open_pbr_surface` for OBJ/MTL). glTF cameras and punctual lights become the same USD-shaped records the USD path produces.

## PBRT v4 import

- **Handedness.** pbrt cameras look down +z; ours look down -z. When the scene's camera transform is a proper rotation (a left-handed pbrt scene), the world Z axis is mirrored once at import, baked into positions, normals, triangle winding, lights and the camera, so the view matches pbrt's image without a negative-scale root. Scenes whose camera transform already flips handedness (common for exports from right-handed tools) need no mirror. `pbrtHandedness()` holds the rule.
- **Camera.** `Camera "perspective"`: `fov` spans the shorter image axis (from `Film` `xresolution`/`yresolution`), turned into a 36 mm wide aperture and a focal length.
- **Materials** (one `open_pbr_surface` document each, `pbrtMaterialDocument()` in `mtlx-material-docs.js`): `diffuse`, `coateddiffuse` (diffuse base under a coat with `coat_ior` = eta), `dielectric` (full transmission, `specular_ior` = eta) and `conductor` (base color = normal-incidence reflectance from eta and k, `specular_color` = OpenPBR's F82 tint; named `metal-*` spectra use an RGB table from Tungsten's `ComplexIorData.hpp`). Roughness: pbrt alpha is `sqrt(r)` when `remaproughness` is true (the default) or `r` itself; the OpenPBR roughness is `sqrt(alpha)`.
- **Lights.** `AreaLightSource "diffuse"` makes the shape emissive: `emission_color` = L times `scale`, `emission_luminance` = 1, which is literal radiance in MaterialX's `uniform_edf`. Emitters light both faces here (pbrt's default is the front face only). A constant `LightSource "infinite"` becomes a uniform dome light (colour = L). Other lights, textures, instancing, analytic shapes, media and other material types are skipped with a warning.

## Renderer: one path for every format

`js/usd-scene-renderer.js` only ever sees the payload; it does not know which format a scene came from. It builds three.js geometry per mesh, and every material goes through the same MaterialX shader generation as the Material Viewer (`js/mtlx-engine.js`), then renders through the shared render session (`js/shared/render-session.js`, `MtlxRender`). That is why the Scene Viewer and the Material Viewer share render settings, effects and the session code.

## USD keeps a live stage, glTF, OBJ and PBRT do not

For USD scenes the composed stage stays alive in the worker after loading. Changing a variant, toggling a payload or scrubbing time asks the worker for an updated snapshot, so the payload is a view of the stage, not a replacement for it.

glTF, OBJ and PBRT scenes have no stage behind them: the payload is all there is.

## Export USD runs the pipe backwards

"Export USD" (`js/usd/usd-stage-export.js` plus the worker's `exportStage` handler) takes the payload of a glTF, OBJ or PBRT scene and asks the OpenUSD runtime (`ExportStage`, from the USDBindings release) to build a real USD stage from it for the first time. The materials are written either as referenced `.mtlx` files or flattened into native UsdShade networks.

Export is limited to glTF, OBJ and PBRT scenes for now partly because of the previous section: a USD scene's payload is a flattened view of a richer stage (variants, references, payloads), so exporting it would lose structure the original file already has.
