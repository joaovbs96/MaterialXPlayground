# Embedding the MaterialX Viewer

Drop a single MaterialX material into any web page as a self-contained, chromeless
3D preview — the "YouTube iframe" experience, but for `.mtlx` files. No build step, no
framework required on your side.

Two ways to use it:

- **Plain `<iframe>`** — zero JavaScript, configured entirely through the query string.
- **The `<materialx-viewer>` custom element** — one `<script>` tag, an HTML attribute API,
  and automatic lazy-loading if you're embedding more than a couple of materials on one page.

Both point at `embed/viewer.html`, which is a dedicated, minimal page: no site shell, no
Tailwind, no in-browser Babel, no hash router — just the 3D viewport and (optionally) its HUD.

## Quick start (no JavaScript)

```html
<iframe
  src="https://joaovbs96.github.io/MaterialXPlayground/embed/viewer.html?src=https://raw.githubusercontent.com/AcademySoftwareFoundation/MaterialX/v1.39.5/resources/Materials/Examples/StandardSurface/standard_surface_greysphere_calibration.mtlx&geometry=sphere&controls=geometry,env,fullscreen"
  width="640" height="480" style="border:0"
  loading="lazy" allow="fullscreen" allowfullscreen
  title="MaterialX material preview">
</iframe>
```

That's it — no `src=` on `.mtlx` at all also works: with no `src` param the viewer loads a
default OpenPBR material, which is a fine sanity check while you wire things up.

Every `<iframe>` example in this doc sets `style="border:0"`, since browsers draw a default
border around iframes; that matters especially for a `transparent` embed (see
[Transparent background](#transparent-background)).

The site's Embed Builder page (linked from the home page) builds one of these snippets
interactively instead: configure every option below through a form, plus the
custom-element-only `poster`/`eager` attributes and a fixed-or-responsive sizing choice,
preview it live against the real custom element, then copy a ready-to-paste `<iframe>` or
`<script>`+`<materialx-viewer>` snippet. Its Help button opens this document rendered
in-page, for reference while you work.

### Query parameters

| Param | Type / values | Default | Description |
| --- | --- | --- | --- |
| `src` | URL | *(the built-in default material)* | The `.mtlx` document to load. Fetched by the iframe itself, so it must be reachable cross-origin (same-origin, or served with CORS headers, see [Loading a document without CORS](#loading-a-document-without-cors) if it isn't). The iframe also crawls the document for the textures and `xi:include` files it references, fetching each one resolved against the document's own URL and restricted to http(s) URLs on the same origin as the document, under the same CORS requirement. A reference that is cross-origin, fails to fetch, or is otherwise blocked falls back to the image node's default color and is reported through `mtlx-error`. |
| `version` | one of the versions in `js/gen/mtlx-versions.json` (currently `1.39.5`, `1.39.4`) | `1.39.5` | Which MaterialX engine build parses and renders the document. Validated against that version list; an unrecognized value falls back to the default and is reported through `mtlx-error`. See [Self-hosting](#self-hosting) for where non-default builds come from on a self-hosted deploy. |
| `geometry` | `shaderball`, `shaderball-scene`, `shaderball-mtlx`, `sphere`, `cube`, `cloth` | `shaderball-scene` | Preview geometry. `shaderball-scene` includes its own authored backdrop room baked into the model itself and is the heaviest option (1.86 MB GLB); it ignores the `backdrop` param entirely, see the row below. Every other geometry instead gets whichever backdrop `backdrop` selects. `sphere` and `cube` need no model download at all. An unrecognized value falls back to the default and is also reported through the `mtlx-error` event (see [Events](#events)), so a typo doesn't fail silently. |
| `geometryUrl` | URL to a `.obj`, `.glb`, or single-file `.gltf` model | *(none; uses the `geometry` param above)* | Custom preview model. Fetched by the iframe itself, under the same CORS requirement as `src`. On success the preview switches to the custom model, and the `geometry` HUD control (when shown) gains a "Custom Model" entry so a visitor can switch back to a built-in geometry. A fetch or parse failure keeps the configured geometry and is reported through `mtlx-error`. Draco or KTX2 compressed assets, and `.gltf` files referencing external `.bin` or texture files, are not supported: export a single-file `.glb` instead. |
| `material` | string: a renderable name, or an index | *(the first renderable)* | Which renderable to display in a multi-material document. Resolved in order: an exact name match, then a case-insensitive name match, then a non-negative integer index (`"0"`, `"1"`, …). An unresolved value falls back to the first renderable and is reported through `mtlx-error`. Re-resolved every time a new document loads. |
| `env` | number (degrees) | *(engine default)* | Environment map rotation. |
| `exposure` | number | *(engine default)* | Environment exposure multiplier. |
| `autorotate` | boolean | off | Turntable auto-rotation. If the visitor's OS has "reduce motion" turned on, rotation starts paused regardless of this value; the Rotate HUD control, if shown, still starts it on request. |
| `wheel` | `scroll`, `zoom`, `none` | `scroll` | Plain mouse-wheel behavior over the viewport. `scroll` (the default) leaves a plain wheel event to scroll the *host page*, since an embed has no business hijacking the scroll of the page it's sitting in; zooming instead needs Ctrl+wheel (Cmd+wheel on Mac; a macOS trackpad pinch works too, since it arrives as a synthetic ctrl+wheel event), and a plain wheel briefly shows a hint pointing that out. While the embed is in fullscreen, a plain wheel zooms directly, since there's no host page left to scroll at that point. `zoom` restores plain-wheel zooming everywhere. `none` disables zooming entirely (wheel, Ctrl+wheel and touch pinch); dragging to orbit still works and a plain wheel scrolls the host page. An unrecognized value falls back to `scroll` and is reported through `mtlx-error`. |
| `camera` | `"px,py,pz,tx,ty,tz"` (six comma-separated numbers) | *(the engine's default framing)* | Initial camera position (`px,py,pz`) and orbit target (`tx,ty,tz`), in world units. Applied once, to the first view that gets built; later geometry/material switches keep whatever pose the visitor has since orbited to. It also becomes the pose the HUD Reset button and the `resetCamera` message return to, in place of the engine's authored default framing; a later `setCamera` call, or a live `.camera` attribute change, rebases that pose again to wherever it moved the camera. A malformed value (wrong count, non-numeric) is ignored and reported through `mtlx-error`. Easiest way to get six real numbers: orbit the material into place in a running viewer and read the pose back with `el.getCamera()` (see [Methods](#methods)). The site's Embed Builder page does this for you: its "Use current view" button reads the live preview's pose and fills it into the generated snippets, so the resulting embed's Reset returns to that captured view. |
| `controls` | comma-separated list, see below | `none` (fully chromeless) | Which HUD buttons to show over the viewport. Accepts the eight names below plus the `none`/`all` keywords. Omitting the param entirely is identical to `controls=none`. Unrecognized names are dropped and reported through `mtlx-error`; recognized ones still work. |
| `backdrop` | `studio`, `environment`, `none` | `studio` | What surrounds the preview geometry. `studio` is a plain white photo-studio room, the new default look for every geometry except `shaderball-scene` (which has its own authored room and ignores this param entirely, see the `geometry` row above). `environment` shows the HDRI environment map itself as the visible backdrop, identical to the legacy `background=1`. `none` is a plain dark void, identical to the legacy `background=0`. The environment's own lighting is always on regardless of which mode is showing; only its visibility as a backdrop changes. `transparent` below overrides `backdrop` entirely, forcing it off so the host page shows through instead of any of the three. An unrecognized value falls back to `studio` and is reported through `mtlx-error`. |
| `background` | boolean | off | Legacy alias for `backdrop` above, kept working for existing embeds. With no `backdrop` param present, `background=1` resolves to `backdrop=environment` and `background=0` resolves to `backdrop=none`, exactly this param's old meaning. If `backdrop` is present, it wins and this param is ignored. One deliberate change either way: leaving *both* params unset used to mean the old dark void and now means the new `studio` room, since `studio` is `backdrop`'s default. New embeds should set `backdrop` directly. |
| `envmap` | URL to a `.hdr` or `.exr` file | *(the default HDRI environment)* | Custom environment map. Fetched by the iframe itself, under the same CORS requirement as `src`; the extension is sniffed from the URL with any query string or fragment stripped first, so a signed or query-string URL still resolves. Replaces the default environment for both lighting and (when `backdrop` is `environment`) the visible backdrop; the current `env`/`exposure`/`backdrop` settings carry over, and it's reapplied automatically across later geometry/material switches. Absent or cleared restores the default. A fetch/decode failure, or an extension other than `.hdr`/`.exr`, leaves whatever environment was already showing untouched and is reported through `mtlx-error`. |
| `transparent` | boolean | off | Makes the page itself see-through, so the host page's own background shows behind the rendered geometry, instead of whatever `backdrop` would otherwise show (the studio room, by default). See [Transparent background](#transparent-background). |
| `forcetransparency` | boolean | *(off, or the visitor's last Settings choice)* | Renders materials that have opacity or transmission with real alpha blending instead of the default opaque preview. Not the same feature as `transparent` above. See [Force transparency](#force-transparency). |
| `accent` | CSS color | `#3b82f6` | HUD accent color (active state, focus outline, slider fill). See [Theming](#theming). |
| `surface` | CSS color | `#1f2937` | HUD button/panel background color. See [Theming](#theming). |
| `text` | CSS color | `#d1d5db` | HUD text/icon color. See [Theming](#theming). |
| `radius` | CSS `<length>` | `4px` | HUD button/select corner radius. See [Theming](#theming). |
| `origin` | origin URL (scheme + host + port) | *(none — accepts/broadcasts to any origin)* | Locks the embed's postMessage protocol to one parent origin. Only meaningful if you're scripting the iframe directly with `postMessage`; the `<materialx-viewer>` element sets this for you. See [Security](#security). |

Every `boolean` param accepts `1`, `true`, `yes`, or `on` for true, and `0`, `false`, `no`,
or `off` for false, case-insensitively (so `autorotate=on` and `background=TRUE` both work,
not just a literal `1`). Anything else falls back to the default shown above.

Geometry labels shown in the HUD's own dropdown (source: `GEOM_LABELS` in
`js/shared/mtlx-ui.jsx`), for reference:

| `geometry` value | HUD label |
| --- | --- |
| `shaderball-scene` *(default)* | Std. Shader Ball w/ Backdrop |
| `shaderball` | Std. Shader Ball |
| `shaderball-mtlx` | MaterialX Shader Ball |
| `sphere` | Sphere |
| `cube` | Cube |
| `cloth` | Cloth |

`controls` accepts any comma-separated combination of:

| Name | Adds |
| --- | --- |
| `geometry` | The geometry-picker dropdown. |
| `material` | The material-picker dropdown. Shown only when the loaded document has two or more renderables; otherwise there's nothing to switch between, so it's hidden even if requested. |
| `rotate` | The auto-rotate toggle. |
| `reset` | A "reset camera" button. Returns to the pose set via `camera`/`setCamera` (or the `.camera` attribute), if one was ever provided, instead of the engine's default framing; also restores the host-provided `env`/`exposure` values, if any. |
| `env` | The environment popover (rotation, exposure, backdrop picker, HDR import, key-light toggle). |
| `screenshot` | A "save PNG" button. |
| `settings` | The settings popover (force-transparency, etc.). |
| `fullscreen` | A fullscreen toggle button. Requires `allowfullscreen` on the `<iframe>` itself — see [Limitations](#limitations). |

`rotate` and the Environment panel's backdrop picker have no effect on the default `shaderball-scene` geometry (auto-rotate is disabled for the full scene, and its authored room ignores `backdrop` entirely, occluding the sky sphere too), so both are hidden while it's selected and come back as soon as the geometry changes to something else. Neither is reported through `mtlx-error`: `shaderball-scene` is the default geometry, so reporting it would make every `controls=all` embed noisy from the moment it loads.

Two extra keywords, both case-insensitive (`ALL`/`None` work the same as `all`/`none`):

- **`none`** - no controls at all. This is also what an absent `controls` param means, so
  `controls=none` and omitting the param entirely are exactly the same thing; `none` just
  makes that choice explicit and self-documenting in the URL.
- **`all`** - every control above, equivalent to spelling out all eight names. It's derived
  from the actual list of controls internally, so it stays correct automatically if a control
  is ever added or removed.

Combining `controls` names with these keywords is still resolved to something sensible, and
always reported through the `mtlx-error` event so the mistake isn't silent:

| Combination | Result | Why |
| --- | --- | --- |
| `none,all` (either order) | All eight controls | A direct contradiction between the two keywords; `all` is the more permissive reading, so it wins. |
| `all,geometry` (`all` plus specific names) | All eight controls | The named controls are already included in `all`, so they're redundant rather than conflicting - reported, then ignored. |
| `none,geometry` (`none` plus specific names) | Just `geometry` | Contradictory, but naming a control is a clear, specific positive intent, so the explicit name(s) win over `none`. |

### Transparent background

`transparent=1` makes the iframe itself see-through, so the host page shows behind the rendered geometry instead of whatever `backdrop` would otherwise show:

```html
<iframe
  src="https://joaovbs96.github.io/MaterialXPlayground/embed/viewer.html?geometry=sphere&transparent=1"
  width="480" height="360" loading="lazy" style="border:0"
  title="MaterialX material preview">
</iframe>
```

**Geometry constraint.** `shaderball-scene`, the default geometry, is an authored room (walls, floor, backdrop) that fills the whole frame, so it can never look transparent. Requesting `transparent=1` against it (including by simply omitting `geometry` altogether) falls back to `shaderball` instead, and reports the substitution through `mtlx-error`. The geometries that do work with `transparent` are `shaderball`, `sphere`, `cube`, `cloth`, and `shaderball-mtlx`.

**Backdrop suppression.** Separately from the geometry constraint above, `transparent=1` also forces `backdrop` off for whichever geometry it renders against: a `studio` room or an `environment` sky would otherwise fill the frame with something opaque, defeating the point of `transparent` entirely. This is a narrower rule than the geometry one above: it never changes what geometry loads, it only turns the backdrop off behind it, so `transparent=1&geometry=sphere&backdrop=studio` still renders the sphere, just with the studio room switched off rather than falling back to a different geometry.

### Force transparency

Despite the similar name, `forcetransparency` is unrelated to `transparent` above: it changes
how *materials* render, not the page background. A material with opacity or transmission
normally renders opaque, matching the official MaterialX viewer; `forcetransparency=1` instead
renders it with real alpha blending (front-to-back depth-peeled order-independent transparency).
This is experimental.

```html
<iframe
  src="https://joaovbs96.github.io/MaterialXPlayground/embed/viewer.html?geometry=shaderball-scene&forcetransparency=1"
  width="480" height="360" loading="lazy" style="border:0"
  title="MaterialX material preview">
</iframe>
```

Unlike `transparent`, there is no geometry constraint: it works with every `geometry` value,
including the default `shaderball-scene`. It is also gated per material, not per geometry, so an
opaque material in the same document renders exactly the same either way.

This mirrors the "Force Transparency" toggle in the viewer's own Settings HUD panel, and, like
that toggle, persists to the visitor's browser storage for this site (`localStorage`, shared by
origin). An embed that sets `forcetransparency` writes that same shared preference, so it can
also change the starting state of the next unrelated embed or page view on the same origin,
unless that one passes its own explicit `forcetransparency` value too. Omitting the param
entirely leaves whatever that shared preference already is untouched.

## The `<materialx-viewer>` custom element

For anything beyond a single static embed — a docs page with several materials, a product
grid, a listing that scrolls — use the wrapper element instead of hand-writing iframes. It
maps attributes to the same query string above, exposes methods over `postMessage`, and
(critically) lazily instantiates its iframe only when scrolled near the viewport, with a
page-wide cap on how many can be live at once. See [Performance](#performance) for why that
matters.

```html
<script src="https://joaovbs96.github.io/MaterialXPlayground/embed/mtlx-viewer.js"></script>

<materialx-viewer
  src="https://raw.githubusercontent.com/AcademySoftwareFoundation/MaterialX/v1.39.5/resources/Materials/Examples/StandardSurface/standard_surface_greysphere_calibration.mtlx"
  geometry="sphere"
  controls="geometry,env,fullscreen"
  style="width: 640px; height: 480px;">
</materialx-viewer>
```

One `<script>` tag covers every `<materialx-viewer>` on the page — the element self-registers
once and no-ops on a second load. By default it sizes itself `width:100%` with a 16:9
`aspect-ratio`; override with ordinary CSS (as above) or a host rule targeting the tag.

### Attributes / properties

Every attribute has a matching JS property (`el.geometry = 'sphere'` behaves exactly like
`el.setAttribute('geometry', 'sphere')`). "Live-updates?" means changing it after the iframe
is already showing something updates the running view in place; everything else instead
reloads the iframe (a real navigation, with a fresh `ready` handshake).

| Attribute | Property | Type | Default | Live-updates? |
| --- | --- | --- | --- | --- |
| `src` | `.src` | URL string | — | No (reload) |
| `version` | `.version` | see the `version` query param above | `1.39.5` | No (reload) |
| `geometry` | `.geometry` | see table above | `shaderball-scene` | Yes |
| `material` | `.material` | string: a renderable name, or an index | (first renderable) | Yes |
| `env` | `.env` | number (degrees) | — | Yes |
| `exposure` | `.exposure` | number | — | Yes |
| `autorotate` | `.autorotate` | boolean | off | No (reload) |
| `wheel` | `.wheel` | `scroll`, `zoom`, `none` | `scroll` | No (reload) |
| `camera` | `.camera` | `"px,py,pz,tx,ty,tz"` | (none) | Yes |
| `controls` | `.controls` | comma list (or an array via the property), plus `all`/`none` | `none` | No (reload) |
| `backdrop` | `.backdrop` | `studio`, `environment`, `none` | `studio` | Yes |
| `background` | `.background` | boolean | off | Yes |
| `envmap` | `.envmap` | URL string (`.hdr`/`.exr`) | (none) | Yes |
| `geometryurl` | `.geometryUrl` | URL string (`.obj`/`.glb`/`.gltf`) | (none) | Yes |
| `transparent` | `.transparent` | boolean | off | Yes |
| `forcetransparency` | `.forceTransparency` | boolean | off | Yes |
| `accent` | `.accent` | CSS color | `#3b82f6` | Yes |
| `surface` | `.surface` | CSS color | `#1f2937` | Yes |
| `text` | `.text` | CSS color | `#d1d5db` | Yes |
| `radius` | `.radius` | CSS `<length>` | `4px` | Yes |
| `base` | `.base` | URL string | the directory `mtlx-viewer.js` was loaded from | — (read once per activation) |
| `poster` | `.poster` | URL string | — | — (placeholder image only, before the iframe activates) |
| `eager` | `.eager` | boolean | off | — (read once, on connect. Creates the iframe immediately instead of waiting to scroll into view; the `IntersectionObserver` still runs alongside it, so an evicted instance can come back once it's visible again.) |

`camera`, unlike the rest of the live-updating attributes, has a one-time-vs-live split: as a
query param on a plain `<iframe>` it only ever seeds the *initial* pose (see the table above).
As a `<materialx-viewer>` attribute it also does that on first load, but changing it afterward
repositions the running camera in place (a `setCamera` postMessage, not a reload).

`envmap` live-updates the same way: changing the attribute afterward swaps the environment in
place through a `setEnvMap { url }` postMessage, not a reload; clearing the attribute restores
the default environment.

Setting `autorotate` doesn't override a visitor's OS-level "reduce motion" preference: with
that preference on, rotation still starts paused and only spins if the visitor presses the
Rotate HUD control themselves (when `rotate` is in `controls`).

Two read-only diagnostic properties, not reflected as attributes: `el.ready` (`true` once the
iframe has posted `ready`) and `el.active` (`true` while the element currently owns a live
iframe/WebGL context).

Boolean attributes on the element itself (`autorotate`, `background`, `transparent`,
`forcetransparency`, `eager`) follow the ordinary HTML convention: presence means true,
regardless of value, so `transparent="0"` is still on. Use `el.removeAttribute('transparent')`,
or the property (`el.transparent = false`), to turn one off. This is a different rule from the
`boolean` query params above, which do parse the value (`1`/`true`/`yes`/`on`).

`base` only needs setting explicitly if `mtlx-viewer.js` isn't loaded as a plain, synchronous
`<script src>` next to `viewer.html` (for example, if you copy the script into a bundler or
inject it dynamically) — normally it's inferred automatically from where the script itself
was loaded from.

### Methods

| Method | Returns | Notes |
| --- | --- | --- |
| `el.load(xml, opts?)` | `Promise<{ name, type }[]>` | Loads a `.mtlx` document by sending its XML text over `postMessage` — see [Loading a document without CORS](#loading-a-document-without-cors). `opts.textures` is an optional `{ relPath: Blob \| ArrayBuffer \| base64-string }` map; `opts.name` sets the material's display name. The promise resolves with that document's renderables array once it finishes parsing (the same array `mtlx-renderables` carries), or rejects if the embed reports a load error, or if the iframe is torn down or reloaded before it answers. |
| `el.setEnvRotation(radians)` | — | **Radians**, matching the underlying engine API — note this differs from the `env` attribute/query param, which is degrees. |
| `el.setEnvExposure(value)` | — | |
| `el.setEnvBackground(bool)` | — | |
| `el.resetCamera()` | — | Returns to the `camera`-baseline pose (see the `camera` param above) if one was ever set, otherwise the engine's default framing. |
| `el.getCamera()` | `Promise<{ position: [x,y,z], target: [tx,ty,tz] }>` | Resolves with the current camera pose. Rejects if there's no live view to read it from (a fixed-camera geometry, or the iframe isn't up yet). |
| `el.setCamera(pose)` | (none) | Repositions the camera live and rebases what the HUD Reset button/`resetCamera` return to, onto this new pose. `pose.position`/`pose.target` are each an optional 3-number array; either can be omitted to leave that half alone. Fire-and-forget: an invalid pose is reported through `mtlx-error` rather than a rejection. |
| `el.snapshot()` | `Promise<Blob>` | Resolves with a PNG snapshot of the current frame. |

Calls made before the iframe reports `ready` (including calls that trigger the iframe's
first creation, e.g. calling `load()` on a not-yet-visible, non-`eager` element) are queued
and flushed in order once it does — you never need to wait for `mtlx-ready` yourself before
calling these.

### Events

Dispatched as `CustomEvent`s on the element itself:

| Event | `detail` | Fires when |
| --- | --- | --- |
| `mtlx-ready` | `{ version: string \| null }` | The MaterialX engine finished loading inside the iframe (once per iframe activation). |
| `mtlx-renderables` | `[{ name, type }, ...]` — the array itself is the `detail` | A document finished parsing; lists its renderable materials/shaders. Fires for the page's own initial document and for every later `load()` call alike. When it's answering a `load()`, the underlying `postMessage` reply carries that call's correlation id on the wire (that's what settles `load()`'s returned promise); the event's own `detail` is unaffected, still just the plain array. |
| `mtlx-error` | `{ message: string }` | A load/parse/compile failure, a `postMessage` error, a client-side error (e.g. `base` couldn't be determined), or a configuration mistake the viewer recovered from on its own: an unrecognized `geometry`, an unknown `controls` name, `transparent` requested against a geometry that can't support it, an `accent`/`surface`/`text`/`radius` value that failed validation, an unresolved `material`, a malformed `camera` pose, a failed or unsupported `envmap`, a failed or unsupported `geometryUrl`, or an unrecognized `wheel`/`version`/`backdrop`/`forcetransparency` value. |

```js
const el = document.querySelector('materialx-viewer');
el.addEventListener('mtlx-ready', (e) => console.log('engine version', e.detail.version));
el.addEventListener('mtlx-renderables', (e) => console.log('materials:', e.detail));
el.addEventListener('mtlx-error', (e) => console.error('viewer error:', e.detail.message));
```

## Theming

Four params (`accent`, `surface`, `text`, `radius`) map to CSS custom properties consumed by
`embed/embed-controls.css` (the HUD strip's own stylesheet), which defines them on `:root`
with the defaults below as fallbacks:

| Param / attribute | Variable | Affects | Default |
| --- | --- | --- | --- |
| `accent` | `--mtlx-accent` | Active/on state color for buttons and toggles, focus outline, slider fill. | `#3b82f6` |
| `surface` | `--mtlx-surface` | HUD button/panel background color. | `#1f2937` |
| `text` | `--mtlx-text` | HUD text and icon color. | `#d1d5db` |
| `radius` | `--mtlx-radius` | HUD button/select corner radius (the panel uses `radius + 2px`). | `4px` |

Since normal CSS on your page can't cross the iframe boundary, these are read from the query
string (or the matching `<materialx-viewer>` attribute) and applied *inside* the framed
document as inline styles on its `<html>` element — that's what makes them reachable by a
cross-origin host, not just a [self-hosted](#self-hosting) copy.

**Validation.** Each value is checked with the browser's own `CSS.supports()` before it's
applied: `accent`/`surface`/`text` must pass `CSS.supports('color', value)`, and `radius` must
pass `CSS.supports('border-radius', value)`. On top of that, any value containing `url(`, `;`,
`}`, `/*`, or `expression` is rejected outright even if `CSS.supports()` would otherwise accept
it, since a value landing in a stylesheet is worth extra caution (a `url()` in particular could
make the embed phone home). A rejected value is dropped, reported through `mtlx-error`, and
leaves whatever was already applied (the default, or a prior valid value) untouched — the
other, valid params in the same request still apply normally.

```html
<iframe
  src="https://joaovbs96.github.io/MaterialXPlayground/embed/viewer.html?geometry=sphere&controls=geometry,env&accent=%232563eb&surface=%23ffffff&text=%23111111&radius=2px"
  width="480" height="360" loading="lazy" style="border:0"
  title="MaterialX material preview">
</iframe>
```

That example themes the HUD to a light, blue-accented look, e.g. to match a host page's own
light theme (note the colors are URL-encoded: `#` becomes `%23`). The Embed Builder page has
color pickers for all four and URL-encodes them for you, if you'd rather not hand-encode
hex values. The same four values work as `<materialx-viewer>` attributes:

```html
<materialx-viewer
  src="…" geometry="sphere" controls="geometry,env"
  accent="#2563eb" surface="#ffffff" text="#111111" radius="2px"
  style="width: 480px; height: 360px;">
</materialx-viewer>
```

Self-hosting is still an option too, if you'd rather set a permanent site-wide default instead
of passing params on every embed: edit `embed/embed-controls.css` directly, or serve your own
stylesheet after it that redeclares the variables:

```css
:root {
  --mtlx-accent: #f97316;
  --mtlx-radius: 8px;
}
```

## Loading a document without CORS

`src=`/`.src` makes the **iframe** fetch the document, which only works if it's same-origin
with the embed or served with CORS headers that allow it (GitHub's `raw.githubusercontent.com`
does; a plain S3 bucket or internal file server often doesn't).

That same fetch also covers any textures or `xi:include` files the document itself
references, but only when they resolve to an http(s) URL on the document's own origin, not
just anywhere CORS happens to allow; a document and its textures need to live together on
one host for `src=` alone to render it with textures intact. The
[wood-tiled MaterialX example](https://raw.githubusercontent.com/AcademySoftwareFoundation/MaterialX/v1.39.5/resources/Materials/Examples/StandardSurface/standard_surface_wood_tiled.mtlx)
is a working case for this: `raw.githubusercontent.com` hosts both the document and its
texture images on one origin, so `src=` renders it fully textured with no extra work. When
your textures live somewhere else, `el.load()` with an explicit `opts.textures` map (below)
remains the path for handing them across.

`el.load(xmlString)` sidesteps this entirely: you read/fetch the `.mtlx` text yourself, on
your own page — no cross-origin restriction applies there, since you're not making a
cross-origin request *into* the iframe — and hand the resulting string across over
`postMessage` instead.

```html
<script src="https://joaovbs96.github.io/MaterialXPlayground/embed/mtlx-viewer.js"></script>
<materialx-viewer id="v" geometry="sphere" style="width: 640px; height: 480px;"></materialx-viewer>

<script>
  const el = document.getElementById('v');
  fetch('/private/my-material.mtlx') // same-origin with YOUR page, not the embed
    .then((r) => r.text())
    .then((xml) => el.load(xml))
    .then((renderables) => console.log('loaded, renderables:', renderables))
    .catch((err) => console.error('load failed:', err));

  // With textures:
  // el.load(xml, { textures: { 'textures/brick_albedo.png': someBlob } });

  // Or with await, inside an async function:
  // const renderables = await el.load(xml);
</script>
```

**When to use which:**

- **`src=`** — simplest option. Use it when the document is same-origin with wherever you
  host the embed, or already served with permissive CORS headers (public MaterialX examples
  on GitHub, most CDNs and object storage with a CORS policy configured).
- **`load()`** — use it when you can't add CORS headers to the `.mtlx` host: an internal
  server, a signed/authenticated URL, a file the user just picked with `<input type="file">`,
  etc.

## Performance

Each `<materialx-viewer>` (or hand-written `<iframe>`) is a **separate, independent iframe**:
its own ~3.8 MB MaterialX WASM instance, and its own WebGL context. Browsers cap the number
of live WebGL contexts at roughly 8–16 depending on browser/GPU — go over that and the oldest
contexts get silently evicted, breaking whichever viewers held them.

The custom element handles this for you:

- An `IntersectionObserver` defers creating an element's iframe until it scrolls near the
  viewport (`rootMargin: '200px'` — activates slightly before it's actually visible), instead
  of instantiating every viewer on the page up front.
- A page-wide LRU cap — `MaterialXViewerElement.maxLiveIframes`, default **6** — tears down
  the least-recently-visible *off-screen* instance before creating a new one past the limit,
  so a long page of materials never exceeds the browser's context ceiling. Adjust it globally:
  ```js
  MaterialXViewerElement.maxLiveIframes = 4; // set before or after elements exist
  ```

A hand-written `<iframe>` gets none of this — fine for one or two static embeds (use
`loading="lazy"` as shown in the Quick start snippet), but reach for the custom element for
anything with more than a couple of viewers on one page.

For a grid/listing use case, set `poster="…"` on each element (a static preview image) — it
shows in place of the plain placeholder until that instance actually activates.

**Real measured transfer sizes** (cold cache, from the Network panel):

| Configuration | Bytes transferred |
| --- | --- |
| `?geometry=sphere` (no HUD, no geometry download) | 5,628,322 (~5.37 MiB) |
| `?geometry=shaderball&controls=geometry,rotate,reset,env,screenshot,settings,fullscreen` (full HUD) | ~5.79 MiB |

The floor is the ~3.84 MB WASM module itself — every *live* iframe pays that once. Compare
against the ~10.8 MB the same material costs inside the full playground app (Babel, Tailwind,
site header, and the default heavier geometry all add up) — the embed exists specifically to
avoid that.

## Self-hosting

The hosted default is `https://joaovbs96.github.io/MaterialXPlayground/embed/viewer.html` —
nothing to set up. To self-host instead (e.g. from the offline release zip), serve at least
these directories from your web root:

- `embed/` — the viewer page, the precompiled engine/UI bundles (`embed/gen/*.js`), the
  wrapper element (`embed/mtlx-viewer.js`), and `embed/embed.css`.
- `js/` — the MaterialX engine and shared UI helpers, including `js/materialx/` (the WASM
  module itself — the largest asset by far) and `js/vendor/` (the EXR loader).
- `models/` — the preview geometry GLBs (`shaderball`, `cloth`, etc.).
- `env_maps/` — the default HDRI environment.
- `vendor/three/` and `vendor/react/` — the rendering and UI runtime.

**The directory depth matters.** `embed/viewer.html` sets `<base href="../">` so that
`js/mtlx-engine.js`'s asset resolution (which is written for a root-level page, e.g.
`./js/materialx/…`, `models/…`) still works from one directory down. That means `embed/`
must sit **exactly one level below** the same root that contains `js/`, `models/`,
`env_maps/`, and `vendor/` — don't flatten the tree or nest `embed/` any deeper.

The [offline release zip](https://github.com/joaovbs96/MaterialXPlayground/releases/latest)
attached to every GitHub release already contains the full tree in this shape — unzip it and
serve the folder as-is with any static file server.

### Non-default MaterialX engine versions

Only the default engine build, `js/materialx/1.39.5/`, is committed to the repo, so it's
always present. Every other version in `js/gen/mtlx-versions.json` (currently just
`1.39.4`) is fetched from upstream at build time instead and isn't committed: a plain
`git clone` doesn't have it on disk. The offline release zip already has that fetch baked
into its build, so it bundles every supported version; the hosted site's own deploy runs
the same step before publishing. If you're self-hosting from a fresh clone rather than the
zip, run `npm run vendor:versions` before building, or `version=` requests for anything but
the default will fail to load. The param itself still validates fine (it's checked
against the version list, not against what's actually on disk), so the failure surfaces as
an ordinary load error through `mtlx-error` rather than the "unknown version" one.

Separately, and unrelated to which engine `version` you request: `js/mtlx-assets.js`
resolves other MaterialX resources, like the built-in default material `src` falls back to,
from a local `vendor/materialx/` mirror when one's present (the offline build ships one),
or a pinned `raw.githubusercontent.com` URL otherwise. The engine build itself is always
fetched same-origin, as described above, regardless of that mode.

### Your server must preserve query strings

Every param in this doc (`src`, `version`, `geometry`, `material`, `controls`, `origin`, the
theme colors, all of it) travels as a query string on the request for `embed/viewer.html`. If
your server rewrites or redirects that URL and drops the query string, the viewer boots with
zero params: no `src` falls back to the built-in default material, no `controls` means fully
chromeless, and so on, with nothing visibly erroring.

The common cause is a "clean URLs" feature: `serve` (the npm package) has `cleanUrls` on by
default since v14, and Vercel has its own `cleanUrls` setting; both 301-redirect
`/embed/viewer.html?...` to `/embed/viewer`, discarding everything after the `?`. Turn it off.
For `serve`, add a `serve.json` next to the directory you serve:

```json
{ "cleanUrls": false }
```

This repo ships its own root-level `serve.json` with that setting, so `npx serve .` works
correctly for local development out of the box. For Vercel, set `"cleanUrls": false` in
`vercel.json` instead.

`<materialx-viewer>` detects a dropped query string automatically: it compares the params it
put into the iframe's URL against what `embed/embed-boot.js` reports receiving, and fires
`mtlx-error` naming exactly which ones went missing. A hand-written `<iframe>` has no such
check (nothing on your page runs inside it to compare against); if the viewer loads with
unexpected defaults, check the Network panel for a redirect on the `viewer.html` request.

## Security

Pass `origin=<https://your-site.example>` (or, using the custom element, it's set for you
automatically to `window.location.origin`) to lock the embed's `postMessage` protocol to one
parent:

- Inbound: the embed drops any message whose `event.origin` doesn't match `origin` exactly.
- Outbound: every reply targets that exact origin instead of `'*'`.

The custom element adds a second layer on top of that: it verifies every inbound message's
`event.source` is actually *its own* iframe's `contentWindow` (not some other frame on the
page) before acting on it or dispatching a DOM event, so multiple `<materialx-viewer>`
instances on one page can't cross-talk even without `origin` set.

Without `origin`, the embed accepts commands from — and broadcasts to — any frame that can
reach it. That's the default because a hand-written `<iframe>` has no way to know its host's
origin in advance. It's an acceptable default because the protocol never carries anything
secret: no auth tokens, no user data — only the `.mtlx` XML/textures/render-state the host
itself chose to send. Pass `origin` explicitly wherever that assumption doesn't hold.

## Limitations

Stated plainly, so nothing here surprises you at integration time:

- **No zip ingest.** The embed never loads the zip library, to save the ~100 KB — you can't
  hand it a `.zip` via `src=` or `load()`. Load an already-extracted `.mtlx` string plus a
  `{ relPath: Blob }` texture map instead.
- **Window-level drag-and-drop is disabled.** The embed doesn't listen for files dropped
  anywhere on the page (unlike the full playground app) — there's no host page to hijack, and
  no sidebar UI in chromeless mode to show a drop's result anyway.
- **Fullscreen needs `allowfullscreen` on the `<iframe>`.** Without it, the browser silently
  denies the Fullscreen API and the engine falls back to a non-native CSS "maximize". The
  `<materialx-viewer>` element sets this (and `allow="fullscreen"`) on its iframe
  automatically; a hand-written `<iframe>` must add both attributes itself, as in every
  example above.
- **Animated materials.** `time` and `frame` nodes run on a clock that matches MaterialXView:
  seconds since the page loaded and a per-frame counter, sent to the shader as 32-bit
  floats. After a couple of days with the same page open (kiosk-style embeds), the animation
  timing gets coarser; reloading the page resets it.
