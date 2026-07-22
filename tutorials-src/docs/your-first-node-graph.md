<!--
  Screenshot placeholders: the `![...]` images below reference
  assets/img/*.jpg, which do not exist yet (only assets/img/.gitkeep is
  committed, to keep the directory in git). Drop the real PNG/JPG
  screenshots described by each alt text into tutorials-src/docs/assets/img/
  with the matching filename before/after publishing — this file is left
  wired up to them (correct paths, correct alt text) so no markdown edits
  should be needed once the images exist.
-->

# Your First Node Graph

This walkthrough builds a simple red material from scratch in the
[Node Graph Editor](../#!graph){ target=_blank } — the same material as
the minimal example in [Tour the Playground](getting-started.md), but
constructed by hand so you get a feel for the editor itself.

## 1. Open the Node Graph Editor

Open the [Node Graph Editor](../#!graph){ target=_blank } with a blank
document (use "New" if you already have something loaded).

![Empty node graph editor with the node palette open](assets/img/new-graph.jpg)

## 2. Add a `standard_surface` Node

Open the node palette and search for `standard_surface`. Drag it onto the
canvas — this is the shader node that defines the material's surface
response (base color, roughness, metalness, and so on).

![Dragging standard_surface from the palette onto the canvas](assets/img/add-standard-surface.jpg)

## 3. Set the Base Color to Red

Select the `standard_surface` node and open its inputs panel. Set:

- `base` to `1.0`
- `base_color` to `(0.8, 0.1, 0.1)`

=== "Author (Node Graph)"
    Edit the `base_color` input directly on the `standard_surface` node —
    click the color swatch and pick a red, or type the RGB values.

    ![standard_surface node with base_color set to red](assets/img/set-base-color.jpg)

=== "Looks (Rendered Result)"
    The live 3D preview updates immediately as you edit the input — no
    separate "render" step.

    ![3D preview showing a red-shaded sphere](assets/img/preview-red.jpg)

## 4. Add a `surfacematerial` Node

Search the palette for `surfacematerial` and drag it onto the canvas.
Connect the `standard_surface` node's output to the `surfacematerial`
node's `surfaceshader` input by dragging from one port to the other.

![Connecting standard_surface's output to surfacematerial's input](assets/img/connect-material.jpg)

!!! note
    `surfacematerial` is what makes the shader assignable to geometry —
    without it, the graph defines a shader but not a renderable material.
    This mirrors the `standard_surface` + `surfacematerial` pair in the
    [minimal `.mtlx` example](getting-started.md#try-it-a-minimal-material).

## 5. Check the Result

With `surfacematerial` connected, the preview panel renders your red
material on the default preview mesh.

![Final graph: standard_surface connected to surfacematerial, red preview](assets/img/final-graph.jpg)

??? details "Want to See the Underlying XML?"
    Use the Document view (XML view/export) in the graph editor's toolbar
    to see the exact `.mtlx` markup your graph produced — it should look
    very close to the hand-written example in
    [Tour the Playground](getting-started.md#try-it-a-minimal-material).

## 6. Save Your Work

Export or save the document from the graph editor's toolbar to get a
`.mtlx` file you can reopen later, load in the
[Material Viewer](../#!viewer){ target=_blank }, or share.

## Next Steps

- Browse the [Node Library](../#!docs){ target=_blank } for other shader
  and pattern nodes to try (texture lookups, noise, math operations, ...).
- Try nesting a sub-graph as its own `nodegraph` for reusable pieces.
- Explore the implementation-target matrix on any node's documentation
  page to see which renderers support it.
