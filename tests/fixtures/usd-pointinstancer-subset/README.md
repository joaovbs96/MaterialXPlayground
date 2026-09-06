# PointInstancer GeomSubset fixture

`root.usda` references `nested/instanced.usda`, whose PointInstancer references
`nested/prototype.usda`. The prototype contains one two-face Mesh with a red
parent material binding and a `BlueFace` GeomSubset binding on its second
face. Two instances share that prototype, so the extraction test can check
both instance matrices and the per-template group ranges.

The focused test is an expected failure against the pinned native runtime:
the runtime expands the prototype into 12 sequential triangle corners and
retains the inherited red group, but drops the explicit blue subset group.
