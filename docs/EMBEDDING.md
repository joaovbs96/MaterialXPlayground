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
  width="640" height="480"
  loading="lazy" allow="fullscreen" allowfullscreen
  title="MaterialX material preview">
</iframe>
```

That's it — no `src=` on `.mtlx` at all also works: with no `src` param the viewer loads a
default OpenPBR material, which is a fine sanity check while you wire things up.

### Query parameters

| Param | Type / values | Default | Description |
| --- | --- | --- | --- |
| `src` | URL | *(the built-in default material)* | The `.mtlx` document to load. Fetched by the iframe itself, so it must be reachable cross-origin (same-origin, or served with CORS headers — see [Loading a document without CORS](#loading-a-document-without-cors) if it isn't). |
| `geometry` | `shaderball`, `shaderball-scene`, `shaderball-mtlx`, `sphere`, `cube`, `cloth` | `shaderball-scene` | Preview geometry. `shaderball-scene` includes a full backdrop scene and is the heaviest option (1.86 MB GLB); `sphere` and `cube` need no model download at all. An unrecognized value falls back to the default rather than erroring. |
| `env` | number (degrees) | *(engine default)* | Environment map rotation. |
| `exposure` | number | *(engine default)* | Environment exposure multiplier. |
| `autorotate` | `1` to enable | off | Turntable auto-rotation. |
| `controls` | comma-separated list — see below | *(none — fully chromeless)* | Which HUD buttons to show over the viewport. Omit entirely for a bare render with no UI at all. |
| `background` | `1` to enable | off | Shows the environment map itself as the visible backdrop. Lighting from it is always on regardless of this flag. |
| `origin` | origin URL (scheme + host + port) | *(none — accepts/broadcasts to any origin)* | Locks the embed's postMessage protocol to one parent origin. Only meaningful if you're scripting the iframe directly with `postMessage`; the `<materialx-viewer>` element sets this for you. See [Security](#security). |

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
| `rotate` | The auto-rotate toggle. |
| `reset` | A "reset camera" button. |
| `env` | The environment popover (rotation, exposure, background toggle, HDR import, key-light toggle). |
| `screenshot` | A "save PNG" button. |
| `settings` | The settings popover (force-transparency, etc.). |
| `fullscreen` | A fullscreen toggle button. Requires `allowfullscreen` on the `<iframe>` itself — see [Limitations](#limitations). |

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
| `geometry` | `.geometry` | see table above | `shaderball-scene` | Yes |
| `env` | `.env` | number (degrees) | — | Yes |
| `exposure` | `.exposure` | number | — | Yes |
| `autorotate` | `.autorotate` | boolean | off | No (reload) |
| `controls` | `.controls` | comma list (or an array via the property) | — | No (reload) |
| `background` | `.background` | boolean | off | Yes |
| `base` | `.base` | URL string | the directory `mtlx-viewer.js` was loaded from | — (read once per activation) |
| `poster` | `.poster` | URL string | — | — (placeholder image only, before the iframe activates) |
| `eager` | `.eager` | boolean | off | — (read once, on connect — skips the `IntersectionObserver` and creates the iframe immediately instead of waiting for scroll) |

Two read-only diagnostic properties, not reflected as attributes: `el.ready` (`true` once the
iframe has posted `ready`) and `el.active` (`true` while the element currently owns a live
iframe/WebGL context).

`base` only needs setting explicitly if `mtlx-viewer.js` isn't loaded as a plain, synchronous
`<script src>` next to `viewer.html` (for example, if you copy the script into a bundler or
inject it dynamically) — normally it's inferred automatically from where the script itself
was loaded from.

### Methods

| Method | Returns | Notes |
| --- | --- | --- |
| `el.load(xml, opts?)` | — | Loads a `.mtlx` document by sending its XML text over `postMessage` — see [Loading a document without CORS](#loading-a-document-without-cors). `opts.textures` is an optional `{ relPath: Blob \| ArrayBuffer \| base64-string }` map; `opts.name` sets the material's display name. |
| `el.setEnvRotation(radians)` | — | **Radians**, matching the underlying engine API — note this differs from the `env` attribute/query param, which is degrees. |
| `el.setEnvExposure(value)` | — | |
| `el.setEnvBackground(bool)` | — | |
| `el.resetCamera()` | — | |
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
| `mtlx-renderables` | `[{ name, type }, ...]` — the array itself is the `detail` | A document finished parsing; lists its renderable materials/shaders. |
| `mtlx-error` | `{ message: string }` | A load/parse/compile failure, a `postMessage` error, or a client-side error (e.g. `base` couldn't be determined). |

```js
const el = document.querySelector('materialx-viewer');
el.addEventListener('mtlx-ready', (e) => console.log('engine version', e.detail.version));
el.addEventListener('mtlx-renderables', (e) => console.log('materials:', e.detail));
el.addEventListener('mtlx-error', (e) => console.error('viewer error:', e.detail.message));
```

## Loading a document without CORS

`src=`/`.src` makes the **iframe** fetch the document, which only works if it's same-origin
with the embed or served with CORS headers that allow it (GitHub's `raw.githubusercontent.com`
does; a plain S3 bucket or internal file server often doesn't).

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
    .then((xml) => el.load(xml));

  // With textures:
  // el.load(xml, { textures: { 'textures/brick_albedo.png': someBlob } });
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
