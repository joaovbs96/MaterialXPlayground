# MaterialX Playground — Tutorials

Welcome to the tutorials and guides for the **MaterialX Playground** — an
interactive, open-source, in-browser playground to browse the standard
MaterialX node library, preview materials in real-time 3D, and build node
graphs visually.

This section is prose-and-screenshots documentation. For the interactive
app itself — the Node Library, the Material Viewer, and the Node Graph
Editor — use the tabs at the top of the page.

!!! tip "Jump Straight In"
    Prefer to learn by doing? Open the
    [Node Graph Editor](../#!graph){ target=_blank } or the
    [Material Viewer](../#!viewer){ target=_blank } directly and come back
    here whenever you get stuck.

## What You'll Find Here

- **[Tour the Playground](getting-started.md)** — a tour of the three views
  (Node Library & Documentation, Material Viewer, Node Graph Editor) and
  how they fit together, plus a minimal `.mtlx` file to try in the viewer.
- **[Your first node graph](your-first-node-graph.md)** — a step-by-step
  walkthrough that builds a simple red material from scratch in the graph
  editor.

## How the Playground Is Organized

The playground has three main views, all reachable from the header:

- **Node Library & Documentation** — every standard MaterialX node, with
  per-signature docs, port tables, live 3D previews, an
  implementation-target matrix, and shareable permalinks
  (e.g. `#/stdlib/math/add`).
- **Material Viewer** — load and preview `.mtlx` materials with real-time
  rendering.
- **Node Graph Editor** — visually build MaterialX graphs with nested
  nodegraphs, a live 3D preview, validation, and XML view/export.

!!! note
    Everything runs client-side in your browser — nothing you load or
    build is uploaded anywhere.
