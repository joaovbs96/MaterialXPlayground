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

    // Picks the least-recently-visible OFF-SCREEN instance to evict,
    // preferring off-screen candidates so we never tear down something the
    // user is actively looking at just because it happened to activate
    // first. Falls back to "least-recently-visible overall" only if every
    // live instance is currently on-screen (cap set lower than the number
    // simultaneously visible — a misconfiguration, but shouldn't wedge).
    function pickEvictionCandidate(excluding) {
        var best = null;
        LIVE.forEach(function (inst) {
            if (inst === excluding || inst._visible) return;
            if (!best || inst._lastVisibleAt < best._lastVisibleAt) best = inst;
        });
        if (best) return best;
        LIVE.forEach(function (inst) {
            if (inst === excluding) return;
            if (!best || inst._lastVisibleAt < best._lastVisibleAt) best = inst;
        });
        return best;
    }

    // Attributes with a live postMessage handler in embed-boot.js's
    // HANDLERS map — changing these after mount updates the running
    // viewer in place. Everything else observed (src, autorotate,
    // controls, base) has no such handler, so a change instead rebuilds
    // the iframe's query string and reloads it (a real navigation, with a
    // fresh 'ready' handshake) — the only way to change those short of a
    // parallel protocol embed-boot.js doesn't speak.
    var LIVE_ATTRS = { geometry: 1, env: 1, exposure: 1, background: 1 };

    // (Custom elements require native `class`/`extends HTMLElement` —
    // there's no ES5-compatible way to subclass a built-in. This is still
    // "no build step": every current browser runs this syntax natively.)
    class MtlxViewerElement extends HTMLElement {
        static get observedAttributes() {
            return ['src', 'geometry', 'env', 'exposure', 'autorotate', 'controls', 'background', 'base', 'poster'];
        }

        constructor() {
            super();
            this._iframe = null;
            this._ready = false;
            this._queue = [];           // messages sent before 'ready'; flushed in order once it arrives.
            this._pending = new Map();  // id -> {resolve, reject}, for snapshot()'s Promise<Blob>.
            this._idCounter = 0;
            this._visible = false;
            this._lastVisibleAt = 0;
            this._observer = null;
            this._onMessageBound = null;
            this._expectedOrigin = null; // the IFRAME's own origin — only messages from here are trusted.
            this._slot = null;
            this._shadowBuilt = false;
        }

        // ---- lifecycle ----------------------------------------------------

        connectedCallback() {
            if (!this._shadowBuilt) this._buildShadow();
            if (this.eager) {
                this._activate();
            } else if (!this._observer) {
                this._observer = new IntersectionObserver(
                    (entries) => entries.forEach((e) => this._onIntersect(e)),
                    { root: null, rootMargin: MtlxViewerElement.rootMargin, threshold: 0 }
                );
                this._observer.observe(this);
            }
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
            else this._reloadIfActive(); // src, autorotate, controls, base
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

        get controls() { return this.getAttribute('controls') || ''; }
        set controls(v) { this._reflect('controls', Array.isArray(v) ? v.join(',') : v); }

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
                '.slot{position:absolute;inset:0;}' +
                'iframe{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;}' +
                '.placeholder{position:absolute;inset:0;display:flex;align-items:center;' +
                'justify-content:center;background-color:#111827;background-position:center;' +
                'background-size:cover;background-repeat:no-repeat;color:#9ca3af;' +
                'font:13px ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,sans-serif;' +
                'text-align:center;padding:12px;box-sizing:border-box;}';
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
            if (this.background) qp.set('background', '1');
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
                if (deg !== undefined) this._send('setEnvRotation', { degrees: deg });
            } else if (name === 'exposure') {
                var v = this._num('exposure');
                if (v !== undefined) this._send('setEnvExposure', { value: v });
            } else if (name === 'background') {
                this._send('setEnvBackground', { on: this.background });
            }
        }

        _reloadIfActive() {
            if (!this._iframe) return;
            var url;
            try {
                url = this._buildSrcUrl();
            } catch (e) {
                this._reportError(e);
                return;
            }
            if (url === this._iframe.src) return;
            this._ready = false;
            this._rejectAllPending(new Error('materialx-viewer: attribute change reloaded the iframe'));
            this._expectedOrigin = new URL(url).origin;
            this._iframe.src = url; // real navigation — src/autorotate/controls/base have no
            // live postMessage handler in embed-boot.js, so this is the only way to apply them.
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
                this._flushQueue();
                this.dispatchEvent(new CustomEvent('mtlx-ready', { detail: { version: msg.version || null } }));
            } else if (name === 'renderables') {
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
            }
        }

        // ---- public methods ---------------------------------------------
        // Each maps 1:1 to an embed-boot.js inbound message. Calls made
        // before the iframe is ready are queued (_send) and flushed in
        // order once 'ready' arrives.

        load(xml, opts) {
            opts = opts || {};
            this._send('load', { xml: xml, textures: opts.textures, name: opts.name });
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
