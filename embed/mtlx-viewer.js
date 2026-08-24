// embed/mtlx-viewer.js — <materialx-viewer>, a hand-written custom element
// that wraps embed/viewer.html in a lazily-instantiated iframe. Zero
// dependencies, no build step (unlike embed/gen/*.js) — ships as-authored,
// drop in with a single <script src="…/embed/mtlx-viewer.js"> tag:
//
//   <materialx-viewer src="/assets/marble.mtlx" geometry="shaderball"
//                      controls="geometry,fullscreen"></materialx-viewer>
//
// This is the OTHER half of embed/embed-boot.js's postMessage protocol —
// every message name/shape below is chosen to match its HANDLERS map and
// outbound post() calls exactly. See that file's header comment for the
// full protocol rationale (id correlation, origin handling).
//
// Why an iframe at all, and why lazy: see the "Embeddable MaterialX
// Viewer" plan. Short version — the main app can't be mounted into a host
// page's own JS context without breaking it (Tailwind Preflight, a
// last-wins THREE global, ~130 unprefixed globals), so each viewer is its
// own iframe: its own 3.84 MB WASM instance AND its own WebGL context.
// Browsers cap live WebGL contexts around 8-16, so a page with a grid of
// materials MUST NOT eagerly instantiate all of them — hence the
// IntersectionObserver + LRU cap below.
(function () {
    'use strict';

    if (customElements.get('materialx-viewer')) return; // script loaded twice — no-op the second time.

    // Every message this element sends/receives is { type: 'mtlx-embed:<name>', ... } —
    // must match embed/embed-boot.js's MSG_PREFIX byte-for-byte.
    var MSG_PREFIX = 'mtlx-embed:';

    // document.currentScript is only reliable synchronously, at the top of
    // a classic (non-module) script's initial evaluation — it's null from
    // inside any callback/promise/timer. Captured here, once, at load time,
    // so <materialx-viewer> instances constructed later (possibly long
    // after this script finished running) can still self-locate. This is
    // the default `base`: the directory this very script was loaded from,
    // which is where embed/viewer.html is expected to live alongside it
    // (same deploy, same "embed/" directory) unless a consumer overrides
    // `base` for a split/self-hosted layout.
    var SELF_SRC = (document.currentScript && document.currentScript.src) || '';
    var DEFAULT_BASE = SELF_SRC ? new URL('.', SELF_SRC).href : null;

    // ------------------------------------------------------------------
    // Module-level LRU over every *live* (iframe-instantiated) instance.
    // Configurable via MaterialXViewerElement.maxLiveIframes (a static
    // property, not an attribute — this is a page-wide budget, not a
    // per-element one). Default ~6, comfortably under the 8-16 browser
    // WebGL-context ceiling the plan calls out, leaving headroom for
    // anything else on the page holding a context.
    var LIVE = new Set();

    // True while the instance is actually laid out. False when an ancestor
    // is display:none, which is how the shell hides a view the visitor has
    // navigated away from.
    function isRendered(inst) {
        try { return inst.getClientRects().length > 0; } catch (e) { return true; }
    }

    // Eviction order: not rendered at all first, then rendered but scrolled
    // off-screen, then anything. Least-recently-visible within each tier.
    // Tier 0 stops a hidden view's viewer outranking the page you are on:
    // it was visible seconds ago, so _lastVisibleAt alone reads it as fresh.
    function pickEvictionCandidate(excluding) {
        var tiers = [null, null, null];
        LIVE.forEach(function (inst) {
            if (inst === excluding) return;
            var t = !isRendered(inst) ? 0 : (!inst._visible ? 1 : 2);
            if (!tiers[t] || inst._lastVisibleAt < tiers[t]._lastVisibleAt) tiers[t] = inst;
        });
        return tiers[0] || tiers[1] || tiers[2];
    }

    // Attributes with a live postMessage handler in embed-boot.js's
    // HANDLERS map — changing these after mount updates the running
    // viewer in place. Everything else observed (src, autorotate,
    // controls, base, wheel, version) has no such handler, so a change
    // instead rebuilds the iframe's query string and reloads it (a real
    // navigation, with a fresh 'ready' handshake) — the only way to change
    // those short of a parallel protocol embed-boot.js doesn't speak.
    var LIVE_ATTRS = {
        geometry: 1, env: 1, exposure: 1, background: 1, backdrop: 1, transparent: 1,
        accent: 1, surface: 1, text: 1, radius: 1, material: 1, camera: 1,
        envmap: 1, forcetransparency: 1, geometryurl: 1,
    };
    // Theme attributes forwarded verbatim as `setTheme` messages — see
    // embed-boot.js's THEME_VARS/applyTheme, which does the actual
    // CSS.supports() validation on the other side of the iframe boundary.
    var THEME_ATTRS = { accent: 1, surface: 1, text: 1, radius: 1 };

    // (Custom elements require native `class`/`extends HTMLElement` —
    // there's no ES5-compatible way to subclass a built-in. This is still
    // "no build step": every current browser runs this syntax natively.)
    class MtlxViewerElement extends HTMLElement {
        static get observedAttributes() {
            return ['src', 'geometry', 'env', 'exposure', 'autorotate', 'controls', 'background', 'backdrop', 'transparent', 'base', 'poster',
                'accent', 'surface', 'text', 'radius', 'material', 'camera', 'wheel', 'version', 'envmap', 'forcetransparency', 'geometryurl'];
        }

        constructor() {
            super();
            this._iframe = null;
            this._ready = false;
            this._reloadNeeded = false; // a reload was requested while a load was already in flight.
            this._queue = [];           // messages sent before 'ready'; flushed in order once it arrives.
            this._pending = new Map();  // id -> {resolve, reject}, for load()/getCamera()/snapshot()'s promises.
            this._idCounter = 0;
            this._visible = false;
            this._lastVisibleAt = 0;
            this._observer = null;
            this._onMessageBound = null;
            this._expectedOrigin = null; // the IFRAME's own origin — only messages from here are trusted.
            this._slot = null;
            this._shadowBuilt = false;
            this._paramLossReported = false; // at most one dropped-query-string report per navigation.
        }

        // ---- lifecycle ----------------------------------------------------

        connectedCallback() {
            if (!this._shadowBuilt) this._buildShadow();
            // Always observe, eager included: eviction can tear the iframe
            // down later, and this is the only path a still-connected
            // element has to notice it should come back (see _onIntersect).
            if (!this._observer) {
                this._observer = new IntersectionObserver(
                    (entries) => entries.forEach((e) => this._onIntersect(e)),
                    { root: null, rootMargin: MtlxViewerElement.rootMargin, threshold: 0 }
                );
                this._observer.observe(this);
            }
            if (this.eager) this._activate(); // skip waiting for the observer's first tick.
        }

        disconnectedCallback() {
            if (this._observer) {
                this._observer.disconnect();
                this._observer = null;
            }
            this._deactivate();
            this._queue = [];
        }

        attributeChangedCallback(name, oldVal, newVal) {
            if (oldVal === newVal) return;
            if (name === 'poster') {
                this._updatePlaceholder();
                return;
            }
            if (LIVE_ATTRS[name]) this._liveUpdate(name);
            else this._reloadIfActive(); // src, autorotate, controls, base, wheel, version
        }

        // ---- attribute/property reflection --------------------------------
        // Every getter/setter pair just proxies the attribute, so setting
        // either the attribute OR the property (`el.geometry = 'sphere'`)
        // goes through attributeChangedCallback uniformly.

        get src() { return this.getAttribute('src') || ''; }
        set src(v) { this._reflect('src', v); }

        get geometry() { return this.getAttribute('geometry') || ''; }
        set geometry(v) { this._reflect('geometry', v); }

        get env() { return this._num('env'); }
        set env(v) { this._reflect('env', v == null ? null : String(v)); }

        get exposure() { return this._num('exposure'); }
        set exposure(v) { this._reflect('exposure', v == null ? null : String(v)); }

        get autorotate() { return this.hasAttribute('autorotate'); }
        set autorotate(v) { this._reflectBool('autorotate', v); }

        get background() { return this.hasAttribute('background'); }
        set background(v) { this._reflectBool('background', v); }

        // 'studio' (default), 'environment', or 'none'; live, see
        // LIVE_ATTRS/_liveUpdate. `background` above is the legacy boolean
        // alias for this - see docs/EMBEDDING.md for how the two resolve.
        get backdrop() { return this.getAttribute('backdrop') || ''; }
        set backdrop(v) { this._reflect('backdrop', v); }

        // Page transparency, not the environment skybox toggle above (see
        // docs/EMBEDDING.md). Only meaningful with a compatible geometry;
        // an incompatible one falls back inside the iframe and reports.
        get transparent() { return this.hasAttribute('transparent'); }
        set transparent(v) { this._reflectBool('transparent', v); }

        // Material rendering mode (depth-peeled OIT for opacity/transmission),
        // NOT the page transparency above: works with every geometry,
        // including shaderball-scene. See docs/EMBEDDING.md.
        get forceTransparency() { return this.hasAttribute('forcetransparency'); }
        set forceTransparency(v) { this._reflectBool('forcetransparency', v); }

        get controls() { return this.getAttribute('controls') || ''; }
        set controls(v) { this._reflect('controls', Array.isArray(v) ? v.join(',') : v); }

        // Theming (docs/EMBEDDING.md): four CSS custom properties, forwarded
        // as query params/setTheme messages. Validated on the iframe side
        // (embed-boot.js) — this element passes the raw string through.
        get accent() { return this.getAttribute('accent') || ''; }
        set accent(v) { this._reflect('accent', v); }

        get surface() { return this.getAttribute('surface') || ''; }
        set surface(v) { this._reflect('surface', v); }

        get text() { return this.getAttribute('text') || ''; }
        set text(v) { this._reflect('text', v); }

        get radius() { return this.getAttribute('radius') || ''; }
        set radius(v) { this._reflect('radius', v); }

        // Renderable name/index to show (js/viewer-app.jsx's `material`
        // controlled prop), live, see LIVE_ATTRS.
        get material() { return this.getAttribute('material') || ''; }
        set material(v) { this._reflect('material', v); }

        // "px,py,pz,tx,ty,tz", live: see LIVE_ATTRS/_liveUpdate. Setting
        // this after mount repositions the camera; on initial load it seeds
        // the starting pose (embed-boot.js's `camera` query param).
        get camera() { return this.getAttribute('camera') || ''; }
        set camera(v) { this._reflect('camera', v); }

        // 'scroll' (default) or 'zoom': not live, joins the reload path.
        get wheel() { return this.getAttribute('wheel') || ''; }
        set wheel(v) { this._reflect('wheel', v); }

        // MaterialX WASM build version: not live, joins the reload path.
        get version() { return this.getAttribute('version') || ''; }
        set version(v) { this._reflect('version', v); }

        // Environment map URL (.hdr/.exr), live: see LIVE_ATTRS/_liveUpdate.
        // Removing the attribute restores the default environment.
        get envmap() { return this.getAttribute('envmap') || ''; }
        set envmap(v) { this._reflect('envmap', v); }

        // Custom model URL (.obj/.glb/.gltf), live: see LIVE_ATTRS/_liveUpdate.
        // Removing the attribute restores the configured/default geometry.
        get geometryUrl() { return this.getAttribute('geometryurl') || ''; }
        set geometryUrl(v) { this._reflect('geometryurl', v); }

        get base() {
            var b = this.getAttribute('base') || DEFAULT_BASE;
            if (!b) return '';
            return b.charAt(b.length - 1) === '/' ? b : b + '/';
        }
        set base(v) { this._reflect('base', v); }

        get poster() { return this.getAttribute('poster') || ''; }
        set poster(v) { this._reflect('poster', v); }

        get eager() { return this.hasAttribute('eager'); }
        set eager(v) { this._reflectBool('eager', v); }

        // Diagnostics — not part of the required API, but cheap and useful
        // for a host page (or a test) that wants to know whether a given
        // instance currently owns a live iframe/WebGL context.
        get ready() { return this._ready; }
        get active() { return !!this._iframe; }

        _reflect(name, v) {
            if (v == null || v === '') this.removeAttribute(name);
            else this.setAttribute(name, v);
        }
        _reflectBool(name, v) {
            if (v) this.setAttribute(name, '');
            else this.removeAttribute(name);
        }
        _num(name) {
            var raw = this.getAttribute(name);
            if (raw == null || raw === '') return undefined; // mirrors embed-boot.js's parseNumber().
            var n = Number(raw);
            return isNaN(n) ? undefined : n;
        }

        // "px,py,pz,tx,ty,tz" -> { position: [px,py,pz], target: [tx,ty,tz] },
        // mirroring embed-boot.js's parseCameraParam(). Returns null (and lets
        // the caller report) on the wrong count or a non-finite number.
        _parseCameraAttr(raw) {
            if (!raw) return null;
            var parts = raw.split(',').map((s) => Number(s.trim()));
            var allFinite = parts.every((n) => !isNaN(n) && isFinite(n));
            if (parts.length !== 6 || !allFinite) return null;
            return { position: parts.slice(0, 3), target: parts.slice(3, 6) };
        }

        // ---- shadow DOM chrome ---------------------------------------------
        // A shadow root keeps the placeholder/iframe wrapper's own styling
        // isolated from the host page's CSS in both directions — belt and
        // braces alongside the iframe boundary, which is what actually keeps
        // the RENDERED VIEWER safe from the host (see the plan's Tailwind-
        // Preflight finding). display:block + a default aspect-ratio so the
        // element has sane size with zero host CSS; a host rule targeting
        // the tag/class/id, or an inline style, overrides it normally.

        _buildShadow() {
            var shadow = this.attachShadow({ mode: 'open' });
            var style = document.createElement('style');
            style.textContent =
                ':host{display:block;position:relative;width:100%;aspect-ratio:16/9;' +
                'background:#111827;overflow:hidden;box-sizing:border-box;}' +
                // Layer 4 of 4 (docs/EMBEDDING.md): outside the iframe entirely, so this
                // applies regardless of the framed document's own state.
                ':host([transparent]){background:transparent;}' +
                '.slot{position:absolute;inset:0;}' +
                'iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;}' +
                '.placeholder{position:absolute;inset:0;display:flex;align-items:center;' +
                'justify-content:center;background-color:#111827;background-position:center;' +
                'background-size:cover;background-repeat:no-repeat;color:#9ca3af;' +
                'font:13px ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif;' +
                'text-align:center;padding:12px;box-sizing:border-box;}' +
                ':host([transparent]) .placeholder{background-color:transparent;}';
            shadow.appendChild(style);
            var slot = document.createElement('div');
            slot.className = 'slot';
            shadow.appendChild(slot);
            this._slot = slot;
            this._shadowBuilt = true;
            this._showPlaceholder();
        }

        _showPlaceholder() {
            if (!this._slot || this._iframe) return;
            var div = document.createElement('div');
            div.className = 'placeholder';
            var poster = this.poster;
            if (poster) div.style.backgroundImage = 'url("' + poster.replace(/"/g, '\\"') + '")';
            else div.textContent = 'MaterialX Viewer';
            this._slot.textContent = '';
            this._slot.appendChild(div);
        }

        _updatePlaceholder() {
            if (!this._iframe) this._showPlaceholder();
        }

        // ---- visibility / LRU activation -----------------------------------

        _onIntersect(entry) {
            this._visible = entry.isIntersecting;
            if (entry.isIntersecting) {
                this._lastVisibleAt = performance.now();
                if (!this._iframe) this._activate();
            }
            // Leaving the viewport does NOT tear anything down by itself —
            // only eviction (below, triggered by some OTHER instance needing
            // the budget) does. This is the "release off-screen ones past a
            // configurable limit" behavior, not "release the instant it's
            // off-screen".
        }

        _activate() {
            if (this._iframe) return;
            if (LIVE.size >= MtlxViewerElement.maxLiveIframes) {
                var victim = pickEvictionCandidate(this);
                if (victim) victim._deactivate();
            }
            this._createIframe();
        }

        _createIframe() {
            var url;
            try {
                url = this._buildSrcUrl();
            } catch (e) {
                this._reportError(e);
                return;
            }
            var iframe = document.createElement('iframe');
            iframe.setAttribute('allow', 'fullscreen');
            iframe.setAttribute('allowfullscreen', ''); // legacy boolean form — mtlx-engine.js's
            // nativeFullscreenAvailable() checks document.fullscreenEnabled, which is false in an
            // iframe lacking either of these, and it silently falls back to CSS-maximize instead.
            iframe.setAttribute('title', 'MaterialX Viewer');
            iframe.src = url;

            this._expectedOrigin = new URL(url).origin;
            this._onMessageBound = (e) => this._onMessage(e);
            window.addEventListener('message', this._onMessageBound);

            this._slot.textContent = '';
            this._slot.appendChild(iframe);
            this._iframe = iframe;
            this._ready = false;
            this._paramLossReported = false;
            LIVE.add(this);
        }

        _deactivate() {
            if (!this._iframe) return;
            if (this._onMessageBound) {
                window.removeEventListener('message', this._onMessageBound);
                this._onMessageBound = null;
            }
            this._iframe.remove();
            this._iframe = null;
            this._ready = false;
            this._reloadNeeded = false;
            this._expectedOrigin = null;
            LIVE.delete(this);
            this._rejectAllPending(new Error('materialx-viewer: iframe torn down'));
            this._showPlaceholder();
        }

        // ---- iframe URL -----------------------------------------------------

        _buildSrcUrl() {
            var base = this.base;
            if (!base) {
                throw new Error(
                    'materialx-viewer: cannot determine the embed base URL — ' +
                    '<script src="…/embed/mtlx-viewer.js"> was not loaded as a classic ' +
                    'script (document.currentScript unavailable), and no `base` attribute ' +
                    'was set. Add base="https://…/embed/" explicitly.'
                );
            }
            var url = new URL('viewer.html', base);
            var qp = url.searchParams;
            if (this.src) qp.set('src', this.src);
            if (this.geometry) qp.set('geometry', this.geometry);
            if (this.env !== undefined) qp.set('env', String(this.env));
            if (this.exposure !== undefined) qp.set('exposure', String(this.exposure));
            if (this.autorotate) qp.set('autorotate', '1');
            if (this.controls) qp.set('controls', this.controls);
            if (this.backdrop) qp.set('backdrop', this.backdrop);
            if (this.background) qp.set('background', '1');
            if (this.transparent) qp.set('transparent', '1');
            if (this.forceTransparency) qp.set('forcetransparency', '1');
            if (this.material) qp.set('material', this.material);
            if (this.camera) qp.set('camera', this.camera);
            if (this.wheel) qp.set('wheel', this.wheel);
            if (this.version) qp.set('version', this.version);
            if (this.envmap) qp.set('envmap', this.envmap);
            if (this.geometryUrl) qp.set('geometryUrl', this.geometryUrl);
            Object.keys(THEME_ATTRS).forEach((name) => {
                if (this[name]) qp.set(name, this[name]);
            });
            // The host's OWN origin — lets embed-boot.js target replies at this
            // exact origin instead of '*'. See its header comment.
            qp.set('origin', window.location.origin);
            return url.href;
        }

        _liveUpdate(name) {
            if (!this._iframe) return; // not instantiated yet — the new value is picked up
            // naturally whenever it IS created, via _buildSrcUrl() reading current attributes.
            if (name === 'geometry') {
                this._send('setGeometry', { geometry: this.geometry });
            } else if (name === 'env') {
                var deg = this._num('env');
                // Absent/cleared: send the engine default, not nothing, so
                // resetting to default actually moves the live preview back.
                this._send('setEnvRotation', { degrees: deg !== undefined ? deg : 0 });
            } else if (name === 'exposure') {
                var v = this._num('exposure');
                this._send('setEnvExposure', { value: v !== undefined ? v : 1 });
            } else if (name === 'background') {
                this._send('setEnvBackground', { on: this.background });
            } else if (name === 'backdrop') {
                // Absent/cleared: send the default explicitly, same reasoning
                // as `env`/`exposure` above - so clearing the attribute
                // actually moves the live preview back to the studio room.
                this._send('setBackdrop', { mode: this.backdrop || 'studio' });
            } else if (name === 'transparent') {
                this._send('setTransparent', { on: this.transparent });
            } else if (name === 'forcetransparency') {
                this._send('setForceTransparency', { on: this.forceTransparency });
            } else if (name === 'material') {
                this._send('setMaterial', { material: this.material });
            } else if (name === 'envmap') {
                this._send('setEnvMap', { url: this.envmap });
            } else if (name === 'geometryurl') {
                this._send('setGeometryUrl', { url: this.geometryUrl || '' });
            } else if (name === 'camera') {
                if (!this.camera) return; // cleared/absent: nothing to apply, nothing to report
                var pose = this._parseCameraAttr(this.camera);
                if (pose) this._send('setCamera', pose);
                else this._reportError(new Error('materialx-viewer: invalid `camera` attribute "' + this.camera + '"; expected 6 comma-separated finite numbers: px,py,pz,tx,ty,tz.'));
            } else if (THEME_ATTRS[name]) {
                this._send('setTheme', { name: name, value: this[name] });
            }
        }

        _reloadIfActive() {
            if (!this._iframe) return;
            if (!this._ready) {
                // A load is already in flight; reassigning src now would
                // abort it and restart the download from scratch. Deferred:
                // _handleInbound('ready') applies it once that load finishes.
                this._reloadNeeded = true;
                return;
            }
            this._applyReload();
        }

        // Returns whether a real navigation started, so _handleInbound's
        // deferred-reload path knows whether to complete the ready
        // handshake itself (no navigation means no future 'ready' will).
        _applyReload() {
            var url;
            try {
                url = this._buildSrcUrl();
            } catch (e) {
                this._reportError(e);
                return false;
            }
            // Net no-op: a reload-attr was toggled on then off again
            // before this ever ran. Current iframe content already
            // matches, so there's nothing to (re)navigate to.
            if (url === this._iframe.src) return false;
            this._ready = false;
            this._paramLossReported = false;
            this._queue = []; // superseded: the reload's own query string
            // already carries every current LIVE_ATTR value.
            this._rejectAllPending(new Error('materialx-viewer: attribute change reloaded the iframe'));
            this._expectedOrigin = new URL(url).origin;
            this._iframe.src = url; // real navigation — src/autorotate/controls/base have no
            // live postMessage handler in embed-boot.js, so this is the only way to apply them.
            return true;
        }

        // ---- outbound postMessage / queueing --------------------------------

        _send(name, payload) {
            var id = 'm' + (++this._idCounter);
            var msg = Object.assign({ type: MSG_PREFIX + name, id: id }, payload || {});
            if (this._ready) this._postRaw(msg);
            else {
                this._queue.push(msg);
                this._ensureActive();
            }
            return id;
        }

        _postRaw(msg) {
            if (!this._iframe || !this._iframe.contentWindow) return;
            try {
                this._iframe.contentWindow.postMessage(msg, this._expectedOrigin || '*');
            } catch (e) {
                console.error('[materialx-viewer] postMessage failed:', e);
            }
        }

        _flushQueue() {
            var q = this._queue;
            this._queue = [];
            q.forEach((msg) => this._postRaw(msg));
        }

        // A public method call (load/snapshot/…) is an explicit signal of
        // intent from the host page — it forces activation even if the
        // element hasn't scrolled near the viewport yet (and is not `eager`),
        // rather than silently dropping the call. Still subject to the LRU
        // cap via _activate().
        _ensureActive() {
            if (this._iframe || !this.isConnected) return;
            this._activate();
        }

        _rejectAllPending(err) {
            this._pending.forEach((p) => p.reject(err));
            this._pending.clear();
        }

        _reportError(err) {
            console.error('[materialx-viewer]', err);
            this.dispatchEvent(new CustomEvent('mtlx-error', { detail: { message: String(err && err.message || err) } }));
        }

        // Detects a host that stripped the query string (serve/Vercel cleanUrls),
        // by comparing params THIS element sent vs what embed-boot.js reports back.
        // `msg.search` absent (older cached embed-boot.js): do nothing, not an error.
        _checkDroppedParams(msg) {
            if (typeof msg.search !== 'string' || this._paramLossReported || !this._iframe) return;
            var sent = new URL(this._iframe.src).searchParams;
            var got = new URLSearchParams(msg.search);
            var missing = [];
            sent.forEach((_v, key) => {
                if (!got.has(key) && missing.indexOf(key) === -1) missing.push(key);
            });
            if (!missing.length) return;
            this._paramLossReported = true;
            this._reportError(new Error(
                'materialx-viewer: the server dropped the embed\'s query parameters (missing: ' +
                missing.join(', ') + '). The host is rewriting URLs, e.g. serve/Vercel cleanUrls. ' +
                'Disable that, or the viewer loads with default settings.'
            ));
        }

        // ---- inbound postMessage --------------------------------------------

        _onMessage(event) {
            if (!this._iframe || event.source !== this._iframe.contentWindow) return; // not OUR iframe.
            if (this._expectedOrigin && event.origin !== this._expectedOrigin) return;
            var msg = event.data;
            if (!msg || typeof msg.type !== 'string' || msg.type.indexOf(MSG_PREFIX) !== 0) return;
            this._handleInbound(msg.type.slice(MSG_PREFIX.length), msg);
        }

        _handleInbound(name, msg) {
            if (name === 'ready') {
                this._ready = true;
                this._checkDroppedParams(msg);
                if (this._reloadNeeded) {
                    // Something changed mid-load; apply it now instead of
                    // reporting this now-superseded state as ready. If it
                    // turned out to be a no-op, this ready IS real; fall through.
                    this._reloadNeeded = false;
                    if (this._applyReload()) return;
                }
                this._flushQueue();
                this.dispatchEvent(new CustomEvent('mtlx-ready', { detail: { version: msg.version || null } }));
            } else if (name === 'renderables') {
                // Resolves a pending load() (see below) when this renderables
                // message is its answer; dispatched as a DOM event regardless,
                // including the initial page-load document, which carries no id.
                if (msg.id != null && this._pending.has(msg.id)) {
                    this._pending.get(msg.id).resolve(msg.renderables || []);
                    this._pending.delete(msg.id);
                }
                this.dispatchEvent(new CustomEvent('mtlx-renderables', { detail: msg.renderables || [] }));
            } else if (name === 'error') {
                if (msg.id != null && this._pending.has(msg.id)) {
                    this._pending.get(msg.id).reject(new Error(msg.message || 'materialx-viewer error'));
                    this._pending.delete(msg.id);
                }
                this.dispatchEvent(new CustomEvent('mtlx-error', { detail: { message: msg.message } }));
            } else if (name === 'snapshot') {
                if (msg.id != null && this._pending.has(msg.id)) {
                    this._pending.get(msg.id).resolve(msg.blob);
                    this._pending.delete(msg.id);
                }
            } else if (name === 'camera') {
                if (msg.id != null && this._pending.has(msg.id)) {
                    this._pending.get(msg.id).resolve({ position: msg.position, target: msg.target });
                    this._pending.delete(msg.id);
                }
            }
        }

        // ---- public methods ---------------------------------------------
        // Each maps 1:1 to an embed-boot.js inbound message. Calls made
        // before the iframe is ready are queued (_send) and flushed in
        // order once 'ready' arrives.

        // Resolves with the new document's renderables array once the
        // embed answers this load (id-correlated, like snapshot() below);
        // rejects on a matching 'error'. Teardown/reload rejects it too.
        load(xml, opts) {
            opts = opts || {};
            return new Promise((resolve, reject) => {
                var id = this._send('load', { xml: xml, textures: opts.textures, name: opts.name });
                this._pending.set(id, { resolve: resolve, reject: reject });
            });
        }

        // Takes RADIANS — matches js/mtlx-engine.js's handle.setEnvRotation(rad)
        // (the API this ultimately drives). embed-boot.js's wire format is
        // degrees (matching the `env` query param/attribute), so this
        // converts before sending; the `env` attribute itself talks degrees
        // directly to embed-boot.js without going through this method.
        setEnvRotation(rad) {
            this._send('setEnvRotation', { degrees: rad * 180 / Math.PI });
        }

        setEnvExposure(x) {
            this._send('setEnvExposure', { value: x });
        }

        setEnvBackground(on) {
            this._send('setEnvBackground', { on: !!on });
        }

        resetCamera() {
            this._send('resetCamera', {});
        }

        // Resolves with { position: [x,y,z], target: [x,y,z] }, or rejects
        // if there's no live view (a flat2d/fixed-scene geometry, or the
        // iframe isn't up yet). Same id-correlated pattern as snapshot().
        getCamera() {
            return new Promise((resolve, reject) => {
                var id = this._send('getCamera', {});
                this._pending.set(id, { resolve: resolve, reject: reject });
            });
        }

        // Fire-and-forget: embed-boot.js validates and reports a bad pose
        // via 'error' (surfaced as an mtlx-error event), not a rejection.
        setCamera(pose) {
            pose = pose || {};
            this._send('setCamera', { position: pose.position, target: pose.target });
        }

        snapshot() {
            return new Promise((resolve, reject) => {
                var id = this._send('snapshot', {});
                this._pending.set(id, { resolve: resolve, reject: reject });
            });
        }
    }

    // Page-wide configuration — static, not per-instance. A host can adjust
    // either before or after elements exist; both are read fresh at the
    // point they're needed (activation time / observer-construction time).
    MtlxViewerElement.maxLiveIframes = 6;
    MtlxViewerElement.rootMargin = '200px'; // preload margin — activate slightly before on-screen.

    customElements.define('materialx-viewer', MtlxViewerElement);
    window.MaterialXViewerElement = MtlxViewerElement; // for MaterialXViewerElement.maxLiveIframes = N, etc.
})();
