# Tour the Playground

The playground has three main views, all reachable from the tabs in the
header. This page is a quick tour of each, plus a minimal `.mtlx` file you
can paste straight into the viewer to try things out.

## The Three Views

### Node Library & Documentation

Browse every standard MaterialX node: per-signature docs, port tables,
live 3D previews, an implementation-target matrix, and shareable
permalinks. Every node has a stable URL of the form `#/<library>/<group>/<name>` —
for example, the `add` node in the `math` group of the standard library is
[`#/stdlib/math/add`](../#/stdlib/math/add){ target=_blank }. Bookmark or
share these links directly.

[Open the Node Library →](../#!docs){ target=_blank }

### Material Viewer

Load an existing `.mtlx` document (drag-and-drop, file picker, or paste
XML) and preview it with real-time rendering, including environment
lighting and camera controls.

[Open the Material Viewer →](../#!viewer){ target=_blank }

### Node Graph Editor

Visually build MaterialX graphs: drag nodes from the palette, wire ports
together, nest nodegraphs, and get a live 3D preview as you go, alongside
validation and XML view/export. This is where
[Your first node graph](your-first-node-graph.md) picks up.

[Open the Node Graph Editor →](../#!graph){ target=_blank }

## Try It: A Minimal Material

Copy the document below and paste it into the Material Viewer (or save it
as a `.mtlx` file and load it) to see a simple red `standard_surface`
material:

```xml
<?xml version="1.0"?>
<materialx version="1.39" colorspace="lin_rec709">
  <standard_surface name="SR_red" type="surfaceshader">
    <input name="base" type="float" value="1.0" />
    <input name="base_color" type="color3" value="0.8, 0.1, 0.1" />
  </standard_surface>
  <surfacematerial name="M_red" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="SR_red" />
  </surfacematerial>
</materialx>
```

??? details "What's Happening in This Document?"
    - `standard_surface` is MaterialX's standard physically-based shader
      node — `base`/`base_color` control the diffuse response.
    - `surfacematerial` wraps a shader node so it can be assigned to
      geometry; the viewer renders it on its default preview mesh.
    - Look up either node's full port list on the
      [Node Library](../#!docs){ target=_blank } — e.g.
      [`#/pbrlib/shader/standard_surface`](../#/pbrlib/shader/standard_surface){ target=_blank }.

### Or Build It in Code

The same document can be constructed with any MaterialX language binding:

=== "C++"

    ```cpp
    --8<-- "red_material.cpp"
    ```

=== "Python"

    ```python
    --8<-- "red_material.py"
    ```

=== "JavaScript"

    ```js
    --8<-- "red_material.js"
    ```

!!! tip
    Once it loads, open the same document in the
    [Node Graph Editor](../#!graph){ target=_blank } to see it as a graph —
    the Viewer and Graph Editor share the same underlying document, so you
    can switch between them at any time.

Next: [Your first node graph](your-first-node-graph.md) builds this same
kind of material step by step, from scratch, in the graph editor.
