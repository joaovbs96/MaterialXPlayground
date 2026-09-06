# Scene Viewer example fixture

`root.usda` is the selected root layer. It references `nested/nested.usda` using a relative asset path. The nested layer adds a Z rotation, two authored standard surface MaterialX sources, and two meshes.

`QuadWithSubset/Quad` contains two quad faces. Its `BlueFace` `GeomSubset` assigns the blue material to the second face, while the parent binding assigns red to the first. `SharedMaterialTriangle/Triangle` uses the same red material on a separate draw with a different local translation. This keeps the example useful for checking face triangulation, subset precedence, material source provenance, and per draw transforms.