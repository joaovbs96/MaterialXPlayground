# UDIM scene fixture

`root.usda` references `nested/asset.usda`, which references one external MaterialX document. `UdimQuad` has two face-varying quad faces using the same material: the first uses tile 1001 and the second uses tile 1011. The two PNGs are tiny asymmetric color swatches, so a renderer that selects the wrong tile or flips the V direction is observable in a screenshot. `ReuseTriangle` shares the same material at a second transform to exercise material reuse.
