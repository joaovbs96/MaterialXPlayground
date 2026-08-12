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
// setEnvExposure, setEnvBackground, resetCamera, snapshot.
// Outbound (iframe -> host): ready, renderables, error, snapshot.
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
    function parseControls(v) {
        if (!v) return [];
        return v.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    }

    var props = {
        embed: true,
        documentUrl: qs.get('src') || undefined,
        geometry: qs.get('geometry') || undefined,
        envRotation: parseNumber(qs.get('env')),
        envExposure: parseNumber(qs.get('exposure')),
        envBackground: qs.get('background') === '1',
        autoRotate: qs.get('autorotate') === '1',
        controls: parseControls(qs.get('controls')),
    };

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
    }

    function onRenderables(list) {
        post('renderables', {
            renderables: (list || []).map(function (r) {
                return { name: r.name, type: r.type };
            }),
        });
    }

    function onReady(version) {
        // Posted once — later reloads/renders don't repeat it. A host
        // waiting on the FIRST 'ready' (before ever sending 'load') is the
        // documented contract; a subsequent 'load' is followed by its own
        // 'renderables' (and 'error' on failure), which is what a host
        // actually needs to know a new document settled.
        if (readyPosted) return;
        readyPosted = true;
        post('ready', { version: version || null });
    }

    function onError(message) {
        post('error', { message: String(message) });
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

    function handleResetCamera() {
        if (currentHandle && currentHandle.resetCamera) {
            try { currentHandle.resetCamera(); } catch (e) { /* no-op view, e.g. flat2d */ }
        }
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
        resetCamera: handleResetCamera,
        snapshot: handleSnapshot,
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
