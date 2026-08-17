// embed/embed-boot.js — postMessage adapter between embed/viewer.html and
// whatever page iframes it. Hand-written, no build step (unlike
// embed/gen/*.js). Mounts MaterialViewerApp with the controlled props
// (js/viewer-app.jsx) driven by the query string and by inbound
// postMessage commands, and forwards the app's onView/onRenderables/
// onReady/onError callbacks back to the host as outbound messages.
//
// Protocol (see the Embeddable MaterialX Viewer plan, "postMessage
// protocol"): every message this file sends or accepts is
// { type: 'mtlx-embed:<name>', ... }. The prefix lets this listener ignore
// any OTHER postMessage traffic the host page's own scripts generate
// (bootstrap.js:510-513 does the same thing for its own message types),
// instead of accidentally reacting to a foreign message shaped like ours.
//
// Inbound (host -> iframe): load, setGeometry, setEnvRotation,
// setEnvExposure, setEnvBackground, setTransparent, setTheme, resetCamera,
// snapshot, setMaterial, setCamera, getCamera.
// Outbound (iframe -> host): ready, renderables, error, snapshot, camera.
(function () {
    'use strict';

    var qs = new URLSearchParams(window.location.search);

    // ------------------------------------------------------------------
    // Origin handling.
    //
    // `?origin=<https://host.example>` names the ONE parent origin this
    // embed expects. When present: inbound messages from any OTHER origin
    // are dropped outright, and every outbound postMessage targets that
    // exact origin (never '*') — this is the safe, verifiable
    // configuration, and the one a production embed should use.
    //
    // When ABSENT: inbound messages are accepted from any origin (there is
    // no way to know the right one), and outbound messages target '*'.
    // TRADEOFF, spelled out rather than left implicit: an embed with no
    // `origin` param is discoverable by any other frame/window that can
    // reach this iframe (e.g. a malicious sibling frame) — it can send
    // this page commands (load a different document, change geometry) and
    // observe the replies. This is acceptable ONLY because the protocol
    // never carries anything secret: no auth tokens, no user data, nothing
    // beyond the .mtlx XML/textures the host itself chose to load and
    // render-state numbers/booleans. A future consumer with stricter
    // requirements should always pass `origin`.
    var EXPECTED_ORIGIN = qs.get('origin') || null;
    var MSG_PREFIX = 'mtlx-embed:';

    function targetOrigin() {
        return EXPECTED_ORIGIN || '*';
    }

    // No-op when not actually embedded (viewer.html opened directly) —
    // avoids posting to (and looping messages back from) ourselves.
    var embedded = window.parent && window.parent !== window;

    function post(name, payload) {
        if (!embedded) return;
        var msg = Object.assign({ type: MSG_PREFIX + name }, payload || {});
        try {
            window.parent.postMessage(msg, targetOrigin());
        } catch (e) {
            // Structured-clone failure or a torn-down parent frame — never
            // let a bad outbound payload break the viewer itself.
            console.error('[embed] postMessage failed:', e);
        }
    }

    // Echoes the inbound message's `id` (if any) onto an outbound payload —
    // the request/response correlation scheme 'snapshot' needs when a host
    // fires several requests in flight. Mirrors the `id` field on
    // vscode_extension/media/bootstrap.js's pendingFetches entries.
    function withId(payload, inboundMsg) {
        if (inboundMsg && inboundMsg.id !== undefined) {
            return Object.assign({ id: inboundMsg.id }, payload);
        }
        return payload;
    }

    // ------------------------------------------------------------------
    // Query-string -> initial controlled props (js/viewer-app.jsx). Every
    // one is optional; an absent/unparseable param leaves the
    // corresponding prop undefined, which is that prop's documented
    // uncontrolled default.
    function parseNumber(v) {
        if (v == null || v === '') return undefined;
        var n = Number(v);
        return isNaN(n) ? undefined : n;
    }
    // Accepts the common boolean spellings, case-insensitive, not just a
    // literal '1': background=true/autorotate=on/transparent=yes all mean
    // the same as =1. Anything unrecognized keeps the default untouched.
    var TRUE_WORDS = ['1', 'true', 'yes', 'on'];
    var FALSE_WORDS = ['0', 'false', 'no', 'off'];
    function parseBool(v, def) {
        if (v == null) return def;
        var s = String(v).trim().toLowerCase();
        if (TRUE_WORDS.indexOf(s) !== -1) return true;
        if (FALSE_WORDS.indexOf(s) !== -1) return false;
        return def;
    }
    var KNOWN_CONTROLS = ['geometry', 'material', 'rotate', 'reset', 'env', 'screenshot', 'settings', 'fullscreen'];
    // `none`/`all` are case-insensitive shorthands (TRUE_WORDS/FALSE_WORDS
    // spirit). `all` is derived from KNOWN_CONTROLS, not a second list, so
    // it can't drift if a control is added/removed later.
    function parseControls(v) {
        if (!v) return [];
        var known = [];
        var unknown = [];
        var hasNone = false;
        var hasAll = false;
        v.split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (name) {
            var lower = name.toLowerCase();
            if (lower === 'none') { hasNone = true; }
            else if (lower === 'all') { hasAll = true; }
            else if (KNOWN_CONTROLS.indexOf(name) !== -1) { known.push(name); }
            else { unknown.push(name); }
        });
        if (unknown.length) {
            post('error', { message: 'Unknown control name(s) ignored: ' + unknown.join(', ') + '. Valid values: ' + KNOWN_CONTROLS.join(', ') + ', all, none.' });
        }
        // `none` + `all` together is a direct contradiction: assume `all`,
        // the more permissive reading, and say so rather than guessing
        // silently either way.
        if (hasNone && hasAll) {
            post('error', { message: '`controls` had both `all` and `none`; showing all controls.' });
            return KNOWN_CONTROLS.slice();
        }
        // `all` plus explicit names: the names are redundant, not
        // contradictory, so just note it and use `all`.
        if (hasAll) {
            if (known.length) {
                post('error', { message: '`all` already includes every control; ignoring redundant name(s): ' + known.join(', ') + '.' });
            }
            return KNOWN_CONTROLS.slice();
        }
        // `none` plus explicit names is contradictory. Listing a name is a
        // clear positive intent, so the explicit names win over `none`.
        if (hasNone) {
            if (known.length) {
                post('error', { message: '`none` conflicts with explicit control name(s) (' + known.join(', ') + '); showing those and ignoring `none`.' });
            }
            return known;
        }
        return known;
    }

    // Theming (docs/EMBEDDING.md "Theming"): accent/surface/text/radius map
    // to the CSS custom properties embed/embed-controls.css consumes,
    // applied straight onto <html> so a cross-origin host can reach them.
    var THEME_VARS = { accent: '--mtlx-accent', surface: '--mtlx-surface', text: '--mtlx-text', radius: '--mtlx-radius' };
    // Rejects a supported-but-hostile value even if CSS.supports() below
    // would accept it, e.g. a url() that would let an embed phone home.
    var UNSAFE_THEME_PATTERN = /url\(|;|\}|\/\*|expression/i;
    function themeValueOk(name, value) {
        if (UNSAFE_THEME_PATTERN.test(value)) return false;
        return name === 'radius' ? CSS.supports('border-radius', value) : CSS.supports('color', value);
    }
    // Applies one theme param, or reports+skips it (leaving whatever was
    // there before, default or previously-applied) if it fails validation.
    function applyTheme(name, value) {
        if (value == null || value === '') return;
        if (!themeValueOk(name, value)) {
            post('error', { message: 'Invalid `' + name + '` value "' + value + '" rejected (failed CSS validation).' });
            return;
        }
        document.documentElement.style.setProperty(THEME_VARS[name], value);
    }
    Object.keys(THEME_VARS).forEach(function (name) { applyTheme(name, qs.get(name)); });

    // `wheel` -> props.wheelMode (js/mtlx-engine.js's view factory option).
    // Defaults to 'scroll': an embed sitting inside a scrollable host page
    // should not hijack the page's wheel scroll unless asked to via `zoom`.
    var WHEEL_MODES = ['scroll', 'zoom'];
    function parseWheelMode(v) {
        if (v == null || v === '') return 'scroll';
        var lower = String(v).trim().toLowerCase();
        if (WHEEL_MODES.indexOf(lower) !== -1) return lower;
        post('error', { message: 'Unknown `wheel` value "' + v + '". Valid values: ' + WHEEL_MODES.join(', ') + '.' });
        return 'scroll';
    }

    // `version` -> props.mtlxVersion, validated against the known-version
    // list (window.MtlxAssets is guaranteed populated: viewer.html awaits
    // MtlxAssets.ready first). Invalid: prop stays unset, engine default applies.
    function parseVersion(v) {
        if (!v) return undefined;
        var known = window.MtlxAssets.MTLX_VERSIONS || [window.MtlxAssets.MTLX_DEFAULT_VERSION];
        if (known.indexOf(v) === -1) {
            post('error', { message: 'Unknown `version` value "' + v + '". Valid values: ' + known.join(', ') + '.' });
            return undefined;
        }
        return v;
    }

    // `camera` -> an initial pose, "px,py,pz,tx,ty,tz" (six comma-separated
    // finite numbers). Not a prop: applied to the view handle directly in
    // onView(), once, since js/viewer-app.jsx has no controlled prop for it.
    function parseCameraParam(v) {
        if (!v) return undefined;
        var parts = v.split(',').map(function (s) { return Number(s.trim()); });
        var allFinite = parts.every(function (n) { return !isNaN(n) && isFinite(n); });
        if (parts.length !== 6 || !allFinite) {
            post('error', { message: 'Invalid `camera` value "' + v + '"; expected 6 comma-separated finite numbers: px,py,pz,tx,ty,tz.' });
            return undefined;
        }
        return { position: parts.slice(0, 3), target: parts.slice(3, 6) };
    }
    var initialCameraPose = parseCameraParam(qs.get('camera'));
    var initialCameraApplied = false; // applied once, to the first view build only, see onView().

    var props = {
        embed: true,
        documentUrl: qs.get('src') || undefined,
        geometry: qs.get('geometry') || undefined,
        material: qs.get('material') || undefined,
        envRotation: parseNumber(qs.get('env')),
        envExposure: parseNumber(qs.get('exposure')),
        envBackground: parseBool(qs.get('background'), false),
        autoRotate: parseBool(qs.get('autorotate'), false),
        controls: parseControls(qs.get('controls')),
        transparent: parseBool(qs.get('transparent'), false),
        wheelMode: parseWheelMode(qs.get('wheel')),
        mtlxVersion: parseVersion(qs.get('version')),
    };

    // Respects the OS-level motion preference: an embed that starts
    // spinning unprompted is what this query exists to prevent. The HUD
    // rotate button, if shown, still lets a visitor start it deliberately.
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        props.autoRotate = false;
    }

    // Layer 1 of 4 (docs/EMBEDDING.md's transparent param note): an inline
    // style wins over embed/viewer.html's stylesheet rule. Layers 2-3 are
    // viewer-app.jsx's own class; layer 4 is mtlx-viewer.js's :host rule.
    function applyPageBackground(isTransparent) {
        var bg = isTransparent ? 'transparent' : '';
        document.documentElement.style.background = bg;
        document.body.style.background = bg;
    }
    applyPageBackground(props.transparent);

    // Live env state, tracked here (not just handed to the engine once) so
    // it survives a view REBUILD (a geometry/material change disposes the
    // old handle and creates a new one — see js/viewer-app.jsx's render
    // effect). This mirrors ViewportControls' own viewEpoch-driven
    // reapply effect (js/shared/mtlx-ui.jsx), which solves the identical
    // problem for the in-app HUD; embed-boot.js needs its own copy because
    // a fully chromeless embed (no `controls` at all) never mounts
    // ViewportControls, so that effect never runs.
    var envState = {
        rotationDeg: props.envRotation,
        exposure: props.envExposure,
        background: props.envBackground,
    };

    var currentHandle = null;
    var readyPosted = false;

    // ------------------------------------------------------------------
    // MaterialViewerApp callback props -> outbound messages.

    function onView(handle) {
        currentHandle = handle;
        if (!handle) return;
        // Reapply tracked env state to the freshly (re)built view — see
        // the envState comment above.
        if (typeof envState.rotationDeg === 'number' && handle.setEnvRotation) {
            handle.setEnvRotation(envState.rotationDeg * Math.PI / 180);
        }
        if (typeof envState.exposure === 'number' && handle.setEnvExposure) {
            handle.setEnvExposure(envState.exposure);
        }
        if (typeof envState.background === 'boolean' && handle.setEnvBackground) {
            handle.setEnvBackground(envState.background);
        }
        // Applies the `camera` query param's pose to the FIRST view build
        // only, unlike envState above: later rebuilds (geometry/material
        // switches) keep whatever pose the visitor has since orbited to.
        if (initialCameraPose && !initialCameraApplied) {
            initialCameraApplied = true;
            if (handle.setCamera) handle.setCamera(initialCameraPose);
        }
    }

    // Correlates a 'load' call with the renderables/error it eventually
    // produces (handleLoad/onRenderables/onError). Pragmatic: the app only
    // ever processes one load at a time, so the NEXT one answers it.
    var pendingLoadId = null;

    function onRenderables(list) {
        var payload = {
            renderables: (list || []).map(function (r) {
                return { name: r.name, type: r.type };
            }),
        };
        if (pendingLoadId != null) {
            payload.id = pendingLoadId;
            pendingLoadId = null;
        }
        post('renderables', payload);
    }

    function onReady(version) {
        // Posted once — later reloads/renders don't repeat it. A host
        // waiting on the FIRST 'ready' (before ever sending 'load') is the
        // documented contract; a subsequent 'load' is followed by its own
        // 'renderables' (and 'error' on failure), which is what a host
        // actually needs to know a new document settled.
        if (readyPosted) return;
        readyPosted = true;
        // `search` lets the host detect a stripped query string (e.g. a
        // clean-URL rewrite), see mtlx-viewer.js's 'ready' handling.
        post('ready', { version: version || null, search: window.location.search });
    }

    function onError(message) {
        var payload = { message: String(message) };
        if (pendingLoadId != null) {
            payload.id = pendingLoadId;
            pendingLoadId = null;
        }
        post('error', payload);
    }

    // ------------------------------------------------------------------
    // Mount. window.MaterialViewerApp is set by embed/gen/viewer-app.js,
    // guaranteed loaded before this script (embed/viewer.html's sequenced
    // script loader).
    var reactRoot = ReactDOM.createRoot(document.getElementById('root'));
    function render() {
        reactRoot.render(React.createElement(window.MaterialViewerApp, Object.assign({}, props, {
            onView: onView,
            onRenderables: onRenderables,
            onReady: onReady,
            onError: onError,
        })));
    }
    render();

    // ------------------------------------------------------------------
    // Inbound commands.

    // Decodes the 'load' message's optional texture map into the
    // { relPath: Blob } shape js/viewer-app.jsx's ingest()/handleImport
    // expect (the same shape drag-and-drop and the VS Code bridge already
    // produce). Each entry may be a real Blob/File (postMessage structured-
    // clones those natively between same-page realms — no base64 hop
    // needed here, unlike bootstrap.js's extension-host boundary), a raw
    // ArrayBuffer, or a base64 string (for hosts whose own postMessage
    // wrapper only carries JSON-safe values).
    function decodeTextures(textures) {
        if (!textures) return null;
        var out = {};
        Object.keys(textures).forEach(function (relPath) {
            var v = textures[relPath];
            if (v instanceof Blob) {
                out[relPath] = v;
            } else if (v instanceof ArrayBuffer) {
                out[relPath] = new Blob([v]);
            } else if (typeof v === 'string') {
                var binary = atob(v);
                var bytes = new Uint8Array(binary.length);
                for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                out[relPath] = new Blob([bytes]);
            }
        });
        return out;
    }

    function handleLoad(msg) {
        if (typeof msg.xml !== 'string' || !msg.xml) {
            post('error', withId({ message: '"load" requires a string `xml` field.' }, msg));
            return;
        }
        // See the pendingLoadId comment above onRenderables(): only set once
        // the load actually proceeds, so a rejected load above never leaves
        // a dangling id for some unrelated later renderables/error to catch.
        if (msg.id !== undefined) pendingLoadId = msg.id;
        // Routes through the SAME contract the VS Code webview and the
        // site's own "Send to Viewer" button use (js/shared/mtlx-ui.jsx's
        // openInViewer(), consumed by js/viewer-app.jsx:326-354) — not a
        // parallel loading path. See vscode_extension/media/bootstrap.js's
        // 'mtlx-open'/mode:'viewer' handling for the precedent this mirrors.
        var payload = { xml: msg.xml, name: msg.name || 'material', files: decodeTextures(msg.textures) };
        window.__mtlxPendingViewerImport = payload;
        window.dispatchEvent(new CustomEvent('mtlx-view-document', { detail: payload }));
    }

    function handleSetGeometry(msg) {
        if (typeof msg.geometry !== 'string') return;
        props.geometry = msg.geometry;
        render();
    }

    function handleSetEnvRotation(msg) {
        var deg = Number(msg.degrees);
        if (isNaN(deg)) return;
        envState.rotationDeg = deg;
        if (currentHandle && currentHandle.setEnvRotation) {
            currentHandle.setEnvRotation(deg * Math.PI / 180);
        }
    }

    function handleSetEnvExposure(msg) {
        var v = Number(msg.value);
        if (isNaN(v)) return;
        envState.exposure = v;
        if (currentHandle && currentHandle.setEnvExposure) {
            currentHandle.setEnvExposure(v);
        }
    }

    function handleSetEnvBackground(msg) {
        var on = !!msg.on;
        envState.background = on;
        if (currentHandle && currentHandle.setEnvBackground) {
            currentHandle.setEnvBackground(on);
        }
    }

    // Live `transparent` update (LIVE_ATTRS): flips layer 1 directly, then
    // re-renders so viewer-app.jsx's own class and geometry guard (layers
    // 2-3) follow.
    function handleSetTransparent(msg) {
        var on = !!msg.on;
        props.transparent = on;
        applyPageBackground(on);
        render();
    }

    // Live theme update (LIVE_ATTRS): re-validates before applying, same
    // as the initial query-param pass, so a bad live value still can't
    // reach the stylesheet.
    function handleSetTheme(msg) {
        if (!THEME_VARS.hasOwnProperty(msg.name)) return;
        applyTheme(msg.name, msg.value);
    }

    function handleResetCamera() {
        if (currentHandle && currentHandle.resetCamera) {
            try { currentHandle.resetCamera(); } catch (e) { /* no-op view, e.g. flat2d */ }
        }
    }

    // Live `material` update: js/viewer-app.jsx re-resolves the `material`
    // controlled prop against the current renderables list on every render.
    function handleSetMaterial(msg) {
        if (typeof msg.material !== 'string') return;
        props.material = msg.material;
        render();
    }

    // Live camera positioning, host-driven (distinct from the `camera`
    // query param's one-time initial pose applied in onView()).
    function handleSetCamera(msg) {
        if (!currentHandle || !currentHandle.setCamera) {
            post('error', withId({ message: 'No live view to position.' }, msg));
            return;
        }
        var ok = currentHandle.setCamera({ position: msg.position, target: msg.target });
        if (!ok) {
            post('error', withId({ message: 'Invalid camera pose: `position`/`target` must each be a 3-number finite array.' }, msg));
        }
    }

    function handleGetCamera(msg) {
        var pose = currentHandle && currentHandle.getCamera ? currentHandle.getCamera() : null;
        if (!pose) {
            post('error', withId({ message: 'No live view to read the camera from.' }, msg));
            return;
        }
        post('camera', withId(pose, msg));
    }

    // Snapshot: handle.snapshot() (js/mtlx-engine.js) returns a synchronous
    // data: URL (renderer.domElement.toDataURL). Converted to a Blob before
    // posting — a Blob structured-clones over postMessage without the ~33%
    // base64 size penalty a data: URL string would carry in the message.
    function handleSnapshot(msg) {
        if (!currentHandle || !currentHandle.snapshot) {
            post('error', withId({ message: 'No live view to snapshot.' }, msg));
            return;
        }
        var dataUrl;
        try {
            dataUrl = currentHandle.snapshot();
        } catch (e) {
            post('error', withId({ message: 'Snapshot failed: ' + (e && e.message || e) }, msg));
            return;
        }
        fetch(dataUrl)
            .then(function (r) { return r.blob(); })
            .then(function (blob) { post('snapshot', withId({ blob: blob }, msg)); })
            .catch(function (e) {
                post('error', withId({ message: 'Snapshot failed: ' + (e && e.message || e) }, msg));
            });
    }

    var HANDLERS = {
        load: handleLoad,
        setGeometry: handleSetGeometry,
        setEnvRotation: handleSetEnvRotation,
        setEnvExposure: handleSetEnvExposure,
        setEnvBackground: handleSetEnvBackground,
        setTransparent: handleSetTransparent,
        setTheme: handleSetTheme,
        resetCamera: handleResetCamera,
        snapshot: handleSnapshot,
        setMaterial: handleSetMaterial,
        setCamera: handleSetCamera,
        getCamera: handleGetCamera,
    };

    window.addEventListener('message', function (event) {
        if (EXPECTED_ORIGIN && event.origin !== EXPECTED_ORIGIN) return;
        var msg = event.data;
        if (!msg || typeof msg.type !== 'string' || msg.type.indexOf(MSG_PREFIX) !== 0) return;
        var name = msg.type.slice(MSG_PREFIX.length);
        var handler = HANDLERS[name];
        if (handler) handler(msg);
    }, false);
})();
