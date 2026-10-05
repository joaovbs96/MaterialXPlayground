# How the Scene Viewer works

The Scene Viewer does not render USD structures directly, and it does not hand three.js a loaded file either. Every supported format is turned into one common, plain-JS structure (the neutral stage payload), and a single renderer draws that payload with three.js and MaterialX-generated shaders. Only USD files go through real OpenUSD structures, and only inside a worker.

```
 .usd/.usda/.usdc/.usdz              .gltf/.glb            .obj + .mtl
          │                              │                      │
  USD worker (OpenUSD wasm)        gltf-stage-loader     obj-stage-loader
  composes the stage, then         (three GLTFLoader)    (three OBJLoader)
  Extract* calls flatten it              │                      │
          │                              └──────────┬───────────┘
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

## Loaders: three formats, one output

- **USD** (`js/usd/usd-stage-loader.js`, `js/usd/usd-stage-worker.js`): the OpenUSD WebAssembly runtime runs in a persistent worker. It composes the stage (references, variants, payloads, MaterialX), then calls such as `ExtractMaterialPayloads` and `ExtractTransformsAtTime` flatten it into the payload. UsdShade networks come back as MaterialX documents; UsdPreviewSurface is converted to MaterialX.
- **glTF/GLB** (`js/usd/gltf-stage-loader.js`) and **OBJ + MTL** (`js/usd/obj-stage-loader.js`): three.js's own loaders parse the file on the main thread, then our code copies the geometry into the same typed arrays and builds one MaterialX document per material in `js/usd/mtlx-material-docs.js` (`gltf_pbr` for glTF, `open_pbr_surface` for OBJ/MTL). glTF cameras and punctual lights become the same USD-shaped records the USD path produces.

## Renderer: one path for every format

`js/usd-scene-renderer.js` only ever sees the payload; it does not know which format a scene came from. It builds three.js geometry per mesh, and every material goes through the same MaterialX shader generation as the Material Viewer (`js/mtlx-engine.js`), then renders through the shared render session (`js/shared/render-session.js`, `MtlxRender`). That is why the Scene Viewer and the Material Viewer share render settings, effects and the session code.

## USD keeps a live stage, glTF and OBJ do not

For USD scenes the composed stage stays alive in the worker after loading. Changing a variant, toggling a payload or scrubbing time asks the worker for an updated snapshot, so the payload is a view of the stage, not a replacement for it.

glTF and OBJ scenes have no stage behind them: the payload is all there is.

## Export USD runs the pipe backwards

"Export USD" (`js/usd/usd-stage-export.js` plus the worker's `exportStage` handler) takes the payload of a glTF or OBJ scene and asks the OpenUSD runtime (`ExportStage`, from the USDBindings release) to build a real USD stage from it for the first time. The materials are written either as referenced `.mtlx` files or flattened into native UsdShade networks.

Export is limited to glTF and OBJ scenes for now partly because of the previous section: a USD scene's payload is a flattened view of a richer stage (variants, references, payloads), so exporting it would lose structure the original file already has.
