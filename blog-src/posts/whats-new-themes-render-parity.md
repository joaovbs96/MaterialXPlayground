---
title: "What's new: themes, one renderer, node thumbnails and SLX code"
description: Light mode and custom themes, one renderer behind both viewers, live node thumbnails in the Graph Editor, ShadingLanguageX code in the graph, and refreshed pages for the desktop app and the VS Code extension.
date: 2026-10-05
draft: true
tags:
  - release
  - themes
  - rendering
  - graph-editor
---

This release is one of the biggest since the Playground started. It touches almost every view, so here is a tour of the highlights. The full list of changes is in the [changelog](https://github.com/joaovbs96/MaterialXPlayground/blob/main/CHANGELOG.md).

## Themes

Until now the Playground had a single dark look. It now has a full theme system that works the same on the website, in the desktop app, in VS Code and in embeds.

### Light mode

Pick Light, Dark or System from the theme menu in the header. System follows your operating system live, so the Playground switches when your computer does. The 3D viewport backdrop stays a separate setting, so your renders do not change when the page does.

### Presets

Four built-in presets sit next to Light and Dark:

- **Dim**, a softer dark theme.
- **Paper**, a warm light theme.
- **High contrast dark** and **High contrast light**, which meet WCAG AAA contrast for text.

### Match VS Code

Inside the VS Code extension the Playground now reads your editor's background, text and button colors and builds a matching theme from them. It follows theme changes live, and high contrast editor themes switch to the high contrast presets. This is on by default, and a setting lets you pick a fixed theme instead.

### Your own themes

The theme editor lets you make your own theme from three base colors (background, text and accent), with optional overrides for individual colors and two sliders for contrast and tint. Every theme is checked for readable contrast when you save it. A custom theme travels as a short theme code: paste it into another app, or into an embed's `theme` attribute, to get the same look there.

## One renderer for both viewers

The Material Viewer and the Scene Viewer used to render in slightly different ways, so the same material could look different in each. Both now run on one shared renderer with one list of render settings.

Settings are grouped into three levels:

- **Performance** for slower machines and big scenes.
- **Default**, the balanced setting most people should keep.
- **Quality**, which adds effects such as ambient occlusion and colored transmission where the hardware allows.

A side effect of the shared renderer: rough metals now blur their reflections correctly from the very first frame, instead of looking mirror-like until the environment was reloaded.

## Node thumbnails in the Graph Editor

The Graph Editor can now show a small live preview on top of each pattern and data node, so you can see what every step of a graph produces at a glance. Thumbnails render in the background, so editing stays responsive.

- Turn them on for the whole graph from the View menu, or for a single node from its right-click menu.
- Shader and material nodes can show a shader ball preview through a separate View menu setting, off by default.
- Thumbnails switch themselves off when a graph has more than 50 nodes.

## ShadingLanguageX in the graph

[ShadingLanguageX](https://github.com/jakethorn/ShadingLanguageX) (SLX) is a compact, code-like way to write MaterialX node graphs. The Graph Editor now speaks it in two new ways.

### The SLX code view

A docked code panel shows the open document as editable SLX code, with completion. Decompile turns the graph into code and Compile turns your edited code back into a graph, so you can switch between the two views as you work.

### The SLX code node

A new node holds its nodegraph as SLX code right on the node. Edit the code and the node's graph follows; edit the graph and the code is rewritten to match.

For comparison, this is the kind of MaterialX document the Playground works with under the hood:

```xml
<?xml version="1.0"?>
<materialx version="1.39">
  <standard_surface name="SR_copper" type="surfaceshader">
    <input name="base_color" type="color3" value="0.95, 0.64, 0.54" />
    <input name="metalness" type="float" value="1.0" />
    <input name="specular_roughness" type="float" value="0.25" />
  </standard_surface>
  <surfacematerial name="M_copper" type="material">
    <input name="surfaceshader" type="surfaceshader" nodename="SR_copper" />
  </surfacematerial>
</materialx>
```

## New and refreshed pages

### The desktop app page

The desktop app for Windows, macOS and Linux now has its own [page]({{ appRoot }}#!desktop), with download buttons for your system, install steps and a list of everything it does offline.

### The VS Code extension page

The [VS Code extension page]({{ appRoot }}#!vscode) has been rewritten to cover everything the extension does today, including the sidebar, document formatting, themes and the Scene Viewer for USD, glTF and OBJ files.

## Try it

Open the [Material Viewer]({{ appRoot }}#!viewer) or the [Graph Editor]({{ appRoot }}#!graph) and pick a theme from the header. As always, bug reports and ideas are welcome on the [issue tracker](https://github.com/joaovbs96/MaterialXPlayground/issues).
