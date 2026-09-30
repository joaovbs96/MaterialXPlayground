// bootstrap.js — webview-side glue between the VS Code extension host
// (vscode_extension/src/editorProvider.js) and the UNMODIFIED site
// (../../index.html et al.), loaded into the same page via
// media/webview.html. Runs first, before any site script (see the
// <script> tag order in webview.html) — plain script, no <script
// type="module">, no bundler: document.currentScript and top-level
// function declarations are relied on below exactly because this runs
// synchronously as the very first thing in <head>.
(function () {
    'use strict';

    // acquireVsCodeApi() is a webview-only global injected by VS Code; it
    // throws if called more than once per webview, so grab it exactly
    // once here, guarded for the (non-webview) case this file is ever
    // loaded outside VS Code.
    var vscodeApi = null;
    if (typeof acquireVsCodeApi === 'function') {
        vscodeApi = acquireVsCodeApi();
    }

    // Texture fetches (handleOpen further down) use this directly.
    // window.fetch is never wrapped here anymore -- the webview resource
    // pipeline (asWebviewUri) has been verified safe for the large
    // MaterialX WASM payloads too, so there is no bridge left to bypass.
    var siteFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;

    // Test seam, inert unless the extension host set MTLX_TEST_TRANSPORT=1
    // (editorProvider.js's buildHtml() then appends ?transportTest=1 to
    // this very script's own src). Read from document.currentScript here,
    // synchronously at load -- the same currentScript-validity caveat as
    // initialHash/docsOnly further down applies (see their comments).
    var isTransportTest = !!(document.currentScript
        && /[?&]transportTest=1(?:&|$)/.test(document.currentScript.getAttribute('src') || ''));

    // Flag that the site is running inside the VS Code webview. Unused by
    // the site today (index.html/js/** are read-only reference for this
    // extension), but cheap to set in case a future site change wants to
    // branch on it — e.g. to hide a browser-only affordance.
    window.__MTLX_VSCODE__ = true;

    // Default the docs view's 3D previews OFF, once per webview state.
    // The site's node-documentation grid (js/docs/) reads/writes
    // localStorage 'mtlx_show_previews' as a hard kill-switch for its
    // per-node Node3DPreview (each preview is its own WASM shader-gen +
    // WebGL context) — '0' means off, anything else (including unset)
    // means on. Outside VS Code that's a reasonable default (a browser
    // tab is cheap to open/close), but a VS Code docs panel is usually
    // opened alongside a live custom-editor webview that's ALREADY
    // running its own WASM/WebGL instance (see docScanner/editorProvider
    // and the "Multiple open .mtlx tabs" note in README.md) — piling a
    // grid of per-node 3D previews on top, inside the same constrained
    // webview host process, is heavy enough to want off by default here.
    // Only touches the key if it has NEVER been set in this webview's
    // storage (=== null), so: this fires once per fresh webview state,
    // and the user's own later in-UI "3D previews: On" toggle (which
    // writes '1') sticks for the rest of that session — this default
    // never fights it back off. The graph editor's inline chromeless docs
    // dialog forces previews on regardless of this key, and the
    // Graph/Viewer views never read it at all — this only affects docs
    // panels/tabs.
    try {
        if (window.localStorage.getItem('mtlx_show_previews') === null) {
            window.localStorage.setItem('mtlx_show_previews', '0');
        }
    } catch (e) {
        // localStorage can throw (disabled storage, quota, etc.) — never
        // let this default block the rest of bootstrap from running.
    }

    // Decode a base64 string into a Uint8Array. Used for the filesB64
    // payload that crosses the extension<->webview postMessage boundary
    // (see the 'mtlx-open' handler below): VS Code does NOT reliably
    // deliver Node Buffers/typed arrays posted from the extension host as
    // typed arrays on this side; in practice they arrive JSON-serialized
    // into a plain object instead, which is silently wrong for a Blob.
    // Base64 text has no such ambiguity. These payloads are at most a few
    // MB, and atob() + a byte loop over that runs in the tens of
    // milliseconds, negligible next to correctness.
    function base64ToUint8(b64) {
        var binary = atob(b64);
        var out = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
    }

    // Inverse of base64ToUint8, chunked so a large export never builds one
    // giant per-byte string: each chunk is a multiple of 3 bytes (so btoa
    // never pads mid-stream) before being base64-encoded and joined.
    function uint8ToBase64(bytes) {
        var CHUNK_BYTES = 30000;
        var parts = [];
        for (var i = 0; i < bytes.length; i += CHUNK_BYTES) {
            var slice = bytes.subarray(i, i + CHUNK_BYTES);
            var binary = '';
            for (var j = 0; j < slice.length; j++) binary += String.fromCharCode(slice[j]);
            parts.push(btoa(binary));
        }
        return parts.join('');
    }

    // ------------------------------------------------------------------
    // Host-side save bridge: a VS Code webview's `<a download>` click does
    // NOT produce a downloaded file (verified empirically -- nothing lands
    // in the OS Downloads folder or the webview's own storage within 15s,
    // no error, no crash). js/shared/mtlx-ui.jsx's downloadBlob/
    // downloadSnapshot call this instead of clicking a synthetic anchor
    // whenever window.__MTLX_VSCODE__ is set and this function exists.
    // Reads the Blob, base64-encodes it (uint8ToBase64 above -- chunked,
    // never one giant per-byte string), and asks the extension host to
    // write it via a native Save dialog (editorProvider.js's
    // wireCommonWebviewMessages 'mtlx-save-file' handler). The returned
    // promise always RESOLVES (never rejects) with { ok, path, error } --
    // a user cancel is ok:false with no error, not a thrown rejection, so
    // callers never need a .catch for the ordinary "user closed the
    // dialog" case.
    var pendingSaveFiles = {}; // id -> resolve
    var nextSaveFileId = 1;
    window.__mtlxHostSave = function (blob, filename) {
        if (!vscodeApi) return Promise.resolve({ ok: false, error: 'not running inside VS Code' });
        return blob.arrayBuffer().then(function (buf) {
            var bytesB64 = uint8ToBase64(new Uint8Array(buf));
            return new Promise(function (resolve) {
                var id = nextSaveFileId++;
                pendingSaveFiles[id] = resolve;
                vscodeApi.postMessage({
                    type: 'mtlx-save-file',
                    id: id,
                    name: filename,
                    mime: blob.type || 'application/octet-stream',
                    bytesB64: bytesB64,
                });
            });
        });
    };

    // 'mtlx-save-file-result': the extension host's reply to the above.
    // Settles and forgets the matching pending entry; unknown/duplicate
    // ids are ignored.
    function handleSaveFileResult(msg) {
        var pending = pendingSaveFiles[msg.id];
        if (!pending) return;
        delete pendingSaveFiles[msg.id];
        pending({ ok: msg.ok, path: msg.path, error: msg.error });
    }

    // Test-transport only: the stress-test harness's testApi.
    // triggerDownload(name, text) asks the extension host to post this to
    // the active panel, which calls the SITE's real, unmodified
    // downloadBlob (js/shared/mtlx-ui.jsx, exported onto window) with a
    // small text Blob -- exercising the exact same code path a real
    // export button uses, not a bootstrap-only stand-in.
    function handleTestTriggerDownload(msg) {
        if (!isTransportTest) return;
        var blob = new Blob([String(msg.text || '')], { type: 'text/plain' });
        if (typeof window.downloadBlob === 'function') {
            window.downloadBlob(blob, String(msg.name || 'probe.txt'));
        } else {
            postError('mtlx-test-trigger-download: window.downloadBlob is not available yet');
        }
    }

    // Test-transport only: mirrors handleTestTriggerDownload but exercises
    // the OTHER export path, downloadSnapshot(), against the Viewer's live
    // render-view handle -- window.__mtlxViewerHandle, js/viewer-app.jsx's
    // own pre-existing "test and console access" hook (set once the
    // Viewer has actually rendered a frame), not something added for this
    // harness. That render is async (WASM shader-gen + WebGL compile), so
    // this polls for the handle to exist rather than assuming it's ready
    // the instant the view mounts; gives up after 20s.
    function handleTestTriggerSnapshot(msg) {
        if (!isTransportTest) return;
        var deadline = Date.now() + 20000;
        (function poll() {
            if (typeof window.downloadSnapshot === 'function' && window.__mtlxViewerHandle) {
                window.downloadSnapshot(window.__mtlxViewerHandle, String(msg.baseName || 'probe'));
                return;
            }
            if (Date.now() > deadline) {
                postError('mtlx-test-trigger-snapshot: viewer handle never became available');
                return;
            }
            setTimeout(poll, 300);
        })();
    }

    // Test-transport only: average colour of an 8x8 patch (msg.x/msg.y are
    // fractions of the frame) of the live viewer's snapshot.
    function handleTestTriggerPixel(msg) {
        if (!isTransportTest || !vscodeApi) return;
        var send = function (report) { vscodeApi.postMessage({ type: 'mtlx-test-pixel', report: report }); };
        var view = window.__mtlxViewerHandle;
        var url = view && typeof view.snapshot === 'function' ? view.snapshot() : null;
        if (!url) { send({ error: 'no viewer snapshot' }); return; }
        var img = new Image();
        img.onload = function () {
            var c = document.createElement('canvas');
            c.width = img.width; c.height = img.height;
            var g = c.getContext('2d');
            g.drawImage(img, 0, 0);
            var fx = typeof msg.x === 'number' ? msg.x : 0.5;
            var fy = typeof msg.y === 'number' ? msg.y : 0.5;
            var d = g.getImageData(Math.floor(img.width * fx) - 4, Math.floor(img.height * fy) - 4, 8, 8).data;
            var sum = [0, 0, 0];
            for (var i = 0; i < d.length; i += 4) { sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2]; }
            var t = document.createElement('canvas');
            t.width = 160; t.height = Math.round(160 * img.height / img.width);
            t.getContext('2d').drawImage(img, 0, 0, t.width, t.height);
            send({ r: sum[0] / 64, g: sum[1] / 64, b: sum[2] / 64, width: img.width, height: img.height, opens: openSeq, thumb: t.toDataURL('image/png') });
        };
        img.onerror = function () { send({ error: 'snapshot decode failed' }); };
        img.src = url;
    }

    // ------------------------------------------------------------------
    // Error forwarding: surface uncaught errors / unhandled rejections in
    // the extension host's "MaterialX Playground" OutputChannel (see
    // wireCommonWebviewMessages() in src/editorProvider.js) — the webview
    // devtools console is awkward to reach, and this gives users a place
    // to copy diagnostics from. Each message is truncated and the total
    // is capped so a render-loop error can't flood the channel.
    var errorPostCount = 0;
    var MAX_ERROR_POSTS = 50;
    var MAX_ERROR_CHARS = 500;
    function postError(text) {
        if (!vscodeApi || errorPostCount >= MAX_ERROR_POSTS) return;
        errorPostCount++;
        var truncated = String(text).slice(0, MAX_ERROR_CHARS);
        vscodeApi.postMessage({ type: 'mtlx-error', text: truncated });
        // Mirrored on a dedicated channel only in test-transport mode, so
        // the stress-test harness doesn't have to share the general
        // error-forwarding pipeline with every other error source.
        if (isTransportTest) {
            vscodeApi.postMessage({ type: 'mtlx-test-error', text: truncated });
        }
    }
    // Benign browser noise, not an actual bug: these ResizeObserver
    // messages fire on ordinary layout churn and carry no useful signal,
    // so they're dropped instead of spamming the Output channel on every
    // webview open.
    var BENIGN_ERROR_RE = /^ResizeObserver loop (completed with undelivered notifications|limit exceeded)/;
    window.addEventListener('error', function (event) {
        var message = (event && event.message) || 'Unknown error';
        if (BENIGN_ERROR_RE.test(message)) return;
        var where = event && event.filename ? ' (' + event.filename + ':' + event.lineno + ')' : '';
        postError(message + where);
    });
    window.addEventListener('unhandledrejection', function (event) {
        postError('Unhandled rejection: ' + String(event && event.reason));
    });

    // ------------------------------------------------------------------
    // Ctrl/Cmd+S: save the Node Graph view's current document back to the
    // open .mtlx file. The PRIMARY path is now a package.json-contributed
    // VS Code keybinding (materialxPlayground.saveGraph, when:
    // activeCustomEditorId == 'materialxPlayground.editor') — a webview's
    // in-iframe keydown listener is NOT reliably the first/only responder
    // for a chord the workbench keybinding service also wants (it can
    // route Ctrl+S to VS Code's own "save this webview" handling before,
    // or instead of, this page ever seeing the keydown at all). The
    // contributed command posts { type: 'mtlx-request-save' } to this
    // webview (see the message listener further down), which calls
    // requestGraphSave() below exactly as the in-page keydown does.
    //
    // The in-page keydown listener below is kept as belt-and-suspenders —
    // some platforms/embeddings do deliver the chord in-iframe — still
    // registered at the document level in the CAPTURE phase, before the
    // key can reach a focused input, React Flow's own keydown handling,
    // or bubble up to VS Code's webview host. Always
    // preventDefault+stopPropagation on the chord itself, view or no
    // view, so a stray "save this webview as a plain text editor" never
    // happens.
    //
    // js/graph-app.jsx (its VS Code extension bridge mount effect) exposes
    // window.__mtlxGetGraphXml when — and only while — the graph view is
    // mounted; that's also how requestGraphSave() tells the graph view is
    // the one currently showing, since js/shell.jsx unmounts views it
    // isn't displaying. Anywhere else (viewer, docs, or the graph view not
    // yet mounted), a save request — from either path — is a silent
    // no-op: no reply is posted back to the host in that case (rather than
    // an 'mtlx-error' text), since a user hitting Ctrl+S while looking at
    // the Viewer/docs view isn't a mistake worth surfacing, and the
    // contributed keybinding's `when` clause can legitimately still race
    // the graph view finishing its mount right after the editor opens.
    //
    // pendingSave holds the resolve/reject pair for the single in-flight
    // 'mtlx-save' round trip; settled by the 'mtlx-save-result' handler in
    // the message listener further down. There is never more than one
    // outstanding — requestGraphSave() doesn't post another 'mtlx-save'
    // until the previous one settles (see the guard below).
    var pendingSave = null;
    function requestGraphSave() {
        if (pendingSave) return; // a save is already in flight — drop the repeat
        if (!vscodeApi) return;
        if (location.hash.indexOf('#!graph') !== 0 || typeof window.__mtlxGetGraphXml !== 'function') {
            // Graph view isn't the visible/mounted one — nothing to save,
            // and nothing posted back (see the comment above this
            // function for why silence is the right response here).
            return;
        }
        Promise.resolve()
            .then(function () { return window.__mtlxGetGraphXml(); })
            .then(function (xml) {
                return new Promise(function (resolve, reject) {
                    pendingSave = { resolve: resolve, reject: reject };
                    vscodeApi.postMessage({ type: 'mtlx-save', xml: xml });
                });
            })
            .then(function () {
                if (typeof window.__mtlxMarkGraphSaved === 'function') window.__mtlxMarkGraphSaved();
            })
            .catch(function (e) {
                postError('Save failed: ' + String((e && e.message) || e));
            });
    }
    // Exposed so js/graph-app.jsx's File > Save menu item can trigger the
    // same path as the Ctrl+S chord / materialxPlayground.saveGraph command.
    window.__mtlxRequestGraphSave = requestGraphSave;

    // Called by js/graph-app.jsx's flushUndoSnapshot whenever a coalesced
    // graph edit settles (350ms debounce, collapsing e.g. a slider drag into
    // one call), to sync the real .mtlx document buffer in the extension
    // host — this keeps the VS Code tab's "unsaved changes" dot in sync and
    // live-syncs any other open view of the same file (e.g. a plain text
    // editor split). Separate from 'mtlx-save' (Ctrl+S), which additionally
    // writes to disk. No debounce needed here — the caller already debounced
    // — and no reply/pending-promise mechanism like pendingSave: fire and
    // forget.
    window.__mtlxNotifyEdit = function (xml) {
        if (!vscodeApi) return;
        vscodeApi.postMessage({ type: 'mtlx-sync', xml: xml });
    };

    // Selection sync (E18). js/graph-app.jsx calls this only from USER
    // selection handlers (never for a host 'mtlx-select'), so no echo loop;
    // path is the element name path ("NG_main/tinted") or null when cleared.
    window.__mtlxNotifySelection = function (path) {
        if (!vscodeApi) return;
        vscodeApi.postMessage({ type: 'mtlx-selection', path: typeof path === 'string' ? path : null });
    };

    // "Open Text Editor" toolbar/menu action (js/graph-app.jsx): asks the
    // host to open or reveal this document's plain text editor beside the
    // Node Graph view.
    window.__mtlxOpenTextEditor = function () {
        if (!vscodeApi) return;
        vscodeApi.postMessage({ type: 'mtlx-open-text' });
    };

    // Host 'mtlx-select' { path, scope, id }: kept in __mtlxPendingSelect for a
    // graph view that mounts later, and dispatched to a mounted one.
    function handleSelect(msg) {
        var detail = { path: String(msg.path || ''), scope: String(msg.scope || ''), id: String(msg.id || '') };
        if (!detail.id) return;
        window.__mtlxPendingSelect = detail;
        window.dispatchEvent(new CustomEvent('mtlx-select', { detail: detail }));
    }

    // Test-transport only: the graph's selection state (graph-app.jsx's
    // __mtlxGraphSelectionState), and a real DOM click on one node card.
    function handleTestTriggerGraphSelection() {
        if (!isTransportTest || !vscodeApi) return;
        var get = window.__mtlxGraphSelectionState;
        vscodeApi.postMessage({ type: 'mtlx-test-graph-selection', report: typeof get === 'function' ? get() : { error: 'graph not mounted' } });
    }
    function handleTestTriggerGraphClick(msg) {
        if (!isTransportTest || !vscodeApi) return;
        var id = String(msg.id || '');
        var cards = document.querySelectorAll('.react-flow__node');
        var hit = null;
        for (var i = 0; i < cards.length; i++) { if (cards[i].getAttribute('data-id') === id) { hit = cards[i]; break; } }
        if (!hit) {
            vscodeApi.postMessage({ type: 'mtlx-test-graph-selection', report: { error: 'no card ' + id, clicked: false } });
            return;
        }
        var r = hit.getBoundingClientRect();
        var x0 = r.left + 8, y0 = r.top + 8;
        var at = function (x, y, buttons) {
            return { bubbles: true, cancelable: true, composed: true, button: 0, buttons: buttons, clientX: x, clientY: y, view: window, pointerId: 1, pointerType: 'mouse', isPrimary: true };
        };
        // A human click: pointer + mouse events, with the 1-4 px jitter real mice make between down and up.
        hit.dispatchEvent(new PointerEvent('pointerdown', at(x0, y0, 1)));
        hit.dispatchEvent(new MouseEvent('mousedown', at(x0, y0, 1)));
        var last = [0, 0];
        (Array.isArray(msg.jitter) ? msg.jitter : []).forEach(function (d) {
            last = d;
            hit.dispatchEvent(new PointerEvent('pointermove', at(x0 + d[0], y0 + d[1], 1)));
            hit.dispatchEvent(new MouseEvent('mousemove', at(x0 + d[0], y0 + d[1], 1)));
        });
        hit.dispatchEvent(new PointerEvent('pointerup', at(x0 + last[0], y0 + last[1], 0)));
        hit.dispatchEvent(new MouseEvent('mouseup', at(x0 + last[0], y0 + last[1], 0)));
        hit.dispatchEvent(new MouseEvent('click', at(x0 + last[0], y0 + last[1], 0)));
        vscodeApi.postMessage({ type: 'mtlx-test-graph-selection', report: { clicked: id } });
    }
    document.addEventListener('keydown', function (event) {
        var isSaveChord = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey
            && (event.key === 's' || event.key === 'S');
        if (!isSaveChord) return;
        event.preventDefault();
        event.stopPropagation();
        requestGraphSave();
    }, true);

    // Route the webview straight to the requested view (viewer/graph/docs)
    // BEFORE the site's own boot (js/shell.jsx reads location.hash for
    // its routing). document.currentScript is only valid synchronously
    // while THIS script is the one executing, which holds here because
    // this is a plain, non-async, non-deferred <script src> tag and the
    // very first one in webview.html's <head>.
    var initialHash = document.currentScript && document.currentScript.getAttribute('data-initial-hash');
    if (initialHash) {
        location.hash = initialHash;
    }

    // Flags this webview as the document-less, standalone "MaterialX:
    // Open Node Documentation" panel, as opposed to the file-backed
    // custom editor — set synchronously here (document.currentScript is
    // only valid while THIS script is still executing, same caveat as
    // initialHash just above), so it's in place BEFORE js/site-header.js
    // builds the header on first paint. '1' <-> true mirrors
    // data-initial-hash's own string-attribute encoding. Consumed by
    // js/site-header.js's nav-item filter, which additionally hides the
    // Viewer/Graph tabs when this is set — the standalone docs panel has
    // no .mtlx document behind it for those views to show.
    window.__MTLX_DOCS_ONLY__ = (document.currentScript && document.currentScript.getAttribute('data-docs-only')) === '1';

    // Same mechanism for the USD scene editor (sceneProvider.js): js/site-header.js
    // then shows only the Scene Viewer and Graph Editor tabs.
    window.__MTLX_SCENE_ONLY__ = (document.currentScript && document.currentScript.getAttribute('data-scene-only')) === '1';

    // Test transport only: js/usd-scene-app.jsx calls this once per settled
    // stage load with its counts, forwarded as 'mtlx-test-scene'.
    if (isTransportTest) {
        window.__mtlxSceneReport = function (report) {
            if (vscodeApi) vscodeApi.postMessage({ type: 'mtlx-test-scene', report: report });
        };
    }

    // Test transport only: js/shell.jsx's AboutDialog calls this once its
    // license fetch settles, forwarded as 'mtlx-test-about'.
    if (isTransportTest) {
        window.__mtlxAboutReport = function (report) {
            if (vscodeApi) vscodeApi.postMessage({ type: 'mtlx-test-about', report: report });
        };
    }

    // Test-transport only: opens the About dialog the same way the header
    // help button does, so the license fetch (and __mtlxAboutReport above)
    // runs through the real, unmodified site code path.
    function handleTestTriggerAbout(msg) {
        if (!isTransportTest) return;
        window.dispatchEvent(new CustomEvent('mtlx-about'));
    }

    // 'mtlx-switch-view': the extension host asking an ALREADY-OPEN
    // playground tab to switch to a different view, posted by
    // editorProvider.js's openInGraphEditor/openInMaterialViewer command
    // handlers (extension.js) when they find and reuse an existing panel
    // for the target file instead of opening a new one. The site itself
    // routes views entirely off location.hash (js/shell.jsx), so this is
    // just that.
    function handleSwitchView(msg) {
        if (typeof msg.hash === 'string' && msg.hash) location.hash = msg.hash;
    }

    // 'mtlx-docs-filter' (W1): the host's node-category filter for the Node
    // Library Documentation panel, keyed to the active .mtlx document.
    // js/docs-app.jsx listens for this exact window event name/shape. Also
    // kept in __mtlxPendingDocsFilter (same pattern as __mtlxPendingSelect
    // above) since the host sends this right after opening a fresh docs
    // panel, before the React app has mounted and attached its listener --
    // without this the very first filter after a cold open was lost.
    function handleDocsFilter(msg) {
        var detail = { file: msg.file || null, categories: Array.isArray(msg.categories) ? msg.categories : null };
        window.__mtlxPendingDocsFilter = detail;
        window.dispatchEvent(new CustomEvent('mtlx-docs-filter', { detail: detail }));
    }

    // Test-transport only: reports the docs page's file-filter chip state
    // (js/docs-app.jsx's __mtlxDocsFilterState), so a smoke scenario can
    // assert the actual page state instead of just "a message was sent".
    function handleTestTriggerDocsFilter(msg) {
        if (!isTransportTest || !vscodeApi) return;
        var get = window.__mtlxDocsFilterState;
        vscodeApi.postMessage({
            type: 'mtlx-test-docs-filter',
            report: typeof get === 'function' ? get() : { error: 'docs page not mounted' },
        });
    }

    // Test-transport only: reports the webview's current location.hash,
    // so the openViewCommands smoke scenario can prove
    // openInGraphEditor/openInMaterialViewer actually switched the
    // visible view (including the reuse-an-open-tab case above).
    function handleTestTriggerViewHash(msg) {
        if (!isTransportTest || !vscodeApi) return;
        vscodeApi.postMessage({ type: 'mtlx-test-view-hash', hash: location.hash });
    }

    // Test-transport only: reports document.body's COMPUTED padding/margin
    // (getComputedStyle, not the stylesheet rule) -- the fullWidth smoke
    // scenario's proof that the reset in scripts/build-webview.mjs's
    // FOCUS_CSS_BLOCK actually beats VS Code's injected default webview
    // styles in the real, running webview.
    function handleTestTriggerFullWidth(msg) {
        if (!isTransportTest || !vscodeApi) return;
        var style = window.getComputedStyle(document.body);
        vscodeApi.postMessage({
            type: 'mtlx-test-full-width',
            report: {
                paddingLeft: style.paddingLeft,
                paddingRight: style.paddingRight,
                marginLeft: style.marginLeft,
                marginRight: style.marginRight,
            },
        });
    }

    // Test transport only: recent console warnings/errors, CSP violations and
    // failed resource loads, attached to the material preview report below.
    var testLog = [];
    function pushTestLog(kind, text) {
        testLog.push(kind + ': ' + String(text).slice(0, 300));
        if (testLog.length > 60) testLog.shift();
    }
    if (isTransportTest) {
        ['warn', 'error'].forEach(function (level) {
            var orig = console[level];
            console[level] = function () {
                try { pushTestLog(level, Array.prototype.map.call(arguments, String).join(' ')); } catch (e) { /* never break logging */ }
                return orig.apply(console, arguments);
            };
        });
        document.addEventListener('securitypolicyviolation', function (e) {
            pushTestLog('csp', e.violatedDirective + ' ' + e.blockedURI);
        });
        window.addEventListener('error', function (e) {
            var t = e && e.target;
            if (t && t !== window && (t.src || t.href)) pushTestLog('resource', t.src || t.href);
        }, true);
    }

    // Extension + VS Code versions, read the same synchronous-currentScript
    // way as the flags above. Consumed by js/shell.jsx's AboutDialog
    // for its VS Code version block (Extension X / VS Code Y).
    window.__MTLX_VSCODE_VERSIONS__ = {
        extension: (document.currentScript && document.currentScript.getAttribute('data-extension-version')) || '',
        vscode: (document.currentScript && document.currentScript.getAttribute('data-vscode-version')) || '',
    };

    // Theme preference and VS Code theme kind, read synchronously here so
    // they exist before js/shared/theme.js runs. Edits made in a webview
    // control go to the extension, which owns the setting and echoes it
    // back to every webview as 'mtlx-theme-preference'.
    var themeAttr = function (name) { return (document.currentScript && document.currentScript.getAttribute(name)) || ''; };
    window.__MTLX_THEME_PREF__ = themeAttr('data-theme-pref') || 'vscode';
    window.__MTLX_VSCODE_THEME_KIND__ = themeAttr('data-vscode-theme-kind') || 'dark';
    window.__mtlxThemePersist = function (pref) {
        if (vscodeApi) vscodeApi.postMessage({ type: 'mtlx-set-theme-preference', value: pref });
    };

    // ------------------------------------------------------------------
    // Link interception: <base href="${baseUri}"> (webview.html) makes
    // every relative href in the site resolve to a webview-resource URL,
    // which is exactly what local script/style/image tags need — but it
    // ALSO means any relative <a href> (same-page hash links, and
    // 'index.html#...' links — js/site-header.js's IS_SHELL check reads
    // location.pathname, which is false under the webview's document URL,
    // so the header emits those) would, without help, *navigate* the
    // webview's frame to a webview-resource document instead of just
    // updating location.hash. VS Code's workbench blocks such frame
    // navigations outright ("frame-src 'self'"), breaking the page. So:
    // an href with a real scheme (https:, mailto:, vscode:, ...) is a true
    // external link — leave it alone, VS Code's webview host opens it in
    // the user's real browser. Everything else is document-relative and
    // gets intercepted: apply its hash (if any) to our own location.hash
    // for the site's router, and always preventDefault so the frame never
    // navigates.
    document.addEventListener('click', function (event) {
        var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
        if (!anchor) return;
        var href = anchor.getAttribute('href');
        if (!href) return;
        // A scheme (https:, mailto:, vscode:, ...) means a true external
        // link — never intercept; VS Code's webview host opens http(s)
        // links in the user's real browser itself.
        if (/^[a-z][a-z0-9+.\-]*:/i.test(href)) return;
        // Everything else is document-relative. Under <base href="${baseUri}">
        // a relative navigation would load a raw webview-resource document
        // (no bootstrap, no fetch bridge) — and VS Code's workbench blocks
        // such frame navigations outright ("frame-src 'self'"). So: never
        // let one through. If the href carries a hash, apply it as an
        // in-page hash update for the site's router; otherwise swallow it.
        event.preventDefault();
        var hashIdx = href.indexOf('#');
        if (hashIdx !== -1) {
            location.hash = href.slice(hashIdx);
        }
    }, false);

    // ------------------------------------------------------------------
    // Extension -> webview payload delivery. editorProvider.js posts
    // { type: 'mtlx-open', mode, name, xml, filesB64, fileUrls }
    // (resolveCustomTextEditor's sendUpdate()) once on initial load and
    // again on every debounced text-document change (live reload).
    //
    // lastDocName / lastBlobMap: remembered from the most recent
    // 'mtlx-open' payload, so the hashchange listener further down
    // (Graph -> Viewer sync on view switch) can hand the Viewer the same
    // name/texture-blob context the Graph editor itself was loaded with,
    // even though that sync fires long after this message handler
    // returns and the original payload is out of scope.
    var lastDocName = null;
    var lastBlobMap = null;

    // One function per window 'message' type this webview handles; the
    // listener registered below (after these declarations) is reduced to
    // a dispatch over them. Split out of what was previously one large
    // inline handler purely for readability — every closure capture
    // (pendingSave, lastDocName/lastBlobMap, vscodeApi, ...) and every
    // early-return guard is unchanged from before the split.

    // 'mtlx-save-result': the extension host answering an 'mtlx-save'
    // posted by the Ctrl/Cmd+S handler below. Settle the one in-flight
    // save (there is never more than one outstanding — the keydown
    // handler doesn't post a new 'mtlx-save' until the previous one
    // settles) and forget it; a stray/duplicate reply with nothing
    // pending is ignored.
    function handleSaveResult(msg) {
        if (!pendingSave) return;
        var settleSave = pendingSave;
        pendingSave = null;
        if (msg.ok) settleSave.resolve();
        else settleSave.reject(new Error(msg.error || 'save failed'));
    }

    // 'mtlx-request-save': the extension host asking this webview to
    // save, posted by editorProvider.js's saveActiveGraph() in response
    // to the materialxPlayground.saveGraph command (the contributed
    // Ctrl+S keybinding — see the comment above requestGraphSave() for
    // why that's the primary path now). Reuses the exact same function
    // the in-page keydown fallback calls, guard and all.
    function handleRequestSave() {
        requestGraphSave();
    }

    // 'mtlx-request-undo' / 'mtlx-request-redo': the extension host
    // asking this webview to undo/redo, posted by editorProvider.js's
    // undoActiveGraph()/redoActiveGraph() in response to the
    // materialxPlayground.undoGraph/redoGraph commands (the contributed
    // Ctrl+Z/Ctrl+Shift+Z/Ctrl+Y keybindings). Same primary-path
    // rationale as Ctrl+S above — the workbench keybinding service, not
    // this page, is the reliable responder for a chord VS Code also
    // wants — but these keybindings additionally SHADOW VS Code's own
    // text-document undo/redo while our editor is active. Undo/redo now
    // defer to VS Code's own NATIVE document undo/redo (requested via
    // 'mtlx-native-undo'/'mtlx-native-redo', handled host-side in
    // editorProvider.js) rather than a separate JS-side graph undo
    // stack: the document buffer is kept continuously in sync via
    // window.__mtlxNotifyEdit ('mtlx-sync', see above), so the native
    // stack already reflects every graph edit. The guards below (graph
    // view visible, not focused in a text field) still matter because
    // the contributed keybinding fires unconditionally regardless of
    // webview-internal DOM focus.
    function handleRequestUndoRedo(msg) {
        // No-op unless the Graph view is the visible/mounted one —
        // same guard requestGraphSave() uses.
        if (location.hash.indexOf('#!graph') !== 0) return;
        var isUndo = msg.type === 'mtlx-request-undo';
        // No-op when focus is in an editable element: a text field's
        // native undo already handled the chord in-page (e.g. a label
        // being typed into), so this contributed keybinding firing on
        // top of it must not ALSO undo a graph edit.
        var active = document.activeElement;
        var isEditable = active && (
            active.isContentEditable
            || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || '')
        );
        if (isEditable) return;
        vscodeApi.postMessage({ type: isUndo ? 'mtlx-native-undo' : 'mtlx-native-redo' });
    }

    // openSeq: bumped once per 'mtlx-open' message received. Texture
    // fetches (fetchTextureBlobs below) are async, so a newer message can
    // arrive and finish before an older one's fetches settle: handleOpen
    // captures mySeq per call and re-checks it before dispatching, so
    // only the latest 'mtlx-open' ever reaches the site.
    var openSeq = 0;

    // Fetches every fileUrls entry with the page's plain fetch (siteFetch,
    // captured above), at most 4 requests in flight at once. A failed
    // fetch is reported through postError() (a warning line, not a thrown
    // error) and simply left out of `blobs`, same as a missing texture
    // today. Resolves once every entry has settled, with per-file
    // blob/failure/timing maps (timings feed the test-transport report).
    function fetchTextureBlobs(fileUrls, label, maxConcurrency) {
        var keys = fileUrls ? Object.keys(fileUrls) : [];
        var blobs = {};
        var failures = {};
        var timings = {};
        var next = 0;
        var what = label || 'Texture';

        function now() {
            return (window.performance && performance.now) ? performance.now() : Date.now();
        }

        function runOne() {
            if (next >= keys.length) return Promise.resolve();
            var key = keys[next++];
            var url = fileUrls[key];
            var start = now();
            if (!siteFetch) {
                timings[key] = 0;
                failures[key] = 'fetch is not available';
                postError(what + ' "' + key + '" could not be loaded: fetch is not available');
                return runOne();
            }
            return siteFetch(url)
                .then(function (res) {
                    if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'));
                    return res.blob();
                })
                .then(function (blob) {
                    timings[key] = now() - start;
                    blobs[key] = blob;
                })
                .catch(function (e) {
                    timings[key] = now() - start;
                    var reason = String((e && e.message) || e);
                    failures[key] = reason;
                    postError(what + ' "' + key + '" could not be loaded: ' + reason);
                })
                .then(runOne);
        }

        var starters = [];
        var concurrency = Math.min(maxConcurrency || 4, keys.length);
        for (var i = 0; i < concurrency; i++) starters.push(runOne());
        return Promise.all(starters).then(function () {
            return { blobs: blobs, failures: failures, timings: timings };
        });
    }

    // Hex SHA-256 of an ArrayBuffer, for the test-transport files report
    // below. Only ever called in test-transport mode.
    function sha256Hex(buffer) {
        return crypto.subtle.digest('SHA-256', buffer).then(function (digest) {
            var bytes = new Uint8Array(digest);
            var hex = '';
            for (var i = 0; i < bytes.length; i++) {
                var h = bytes[i].toString(16);
                hex += h.length === 1 ? '0' + h : h;
            }
            return hex;
        });
    }

    // Test-transport only: { size, sha256, ms } per successfully fetched
    // texture blob, from fetchTextureBlobs' result. Computed BEFORE
    // dispatching the document to the site, so the harness's report
    // reflects exactly what the site is about to receive.
    function buildTestFilesReport(result) {
        var keys = Object.keys(result.blobs);
        var files = {};
        return Promise.all(keys.map(function (key) {
            var blob = result.blobs[key];
            return blob.arrayBuffer().then(sha256Hex).then(function (hex) {
                files[key] = { size: blob.size, sha256: hex, ms: result.timings[key] };
            });
        })).then(function () {
            return files;
        });
    }

    // Dispatches an already-fully-built document payload to the site,
    // exactly the window.__mtlxPendingImport / __mtlxPendingViewerImport +
    // event contract js/shared/mtlx-ui.jsx's openInGraphEditor()/
    // openInViewer() use for their own "send to viewer"/"send to editor"
    // buttons. Split out of handleOpen so the async texture-fetch wait in
    // handleOpen is easy to see is the only thing gating this.
    function dispatchOpen(mode, name, xml, blobMap, hash) {
        if (mode === 'both') {
            // Primary path: materialxPlayground.open sends one document
            // to BOTH views at once. The site is a multi-view SPA where
            // each view consumes its own pending global + event when it
            // mounts — window.__mtlxPendingImport +
            // 'mtlx-load-document' for js/graph-app.jsx,
            // window.__mtlxPendingViewerImport + 'mtlx-view-document'
            // for js/viewer-app.jsx (js/shared/mtlx-ui.jsx's own
            // openInGraphEditor()/openInViewer() set exactly these).
            // Setting both means whichever view the user is (or later
            // switches to) already has the document; a view that's
            // already mounted picks it up off the event, an unmounted
            // one picks it up off the pending global at mount — the
            // site's own contract, unchanged. Do NOT touch location.hash
            // here: the initial view was already routed by
            // data-initial-hash at boot (see initialHash above), and a
            // live-reload resend must not yank the user away from
            // whichever view they're currently looking at.
            var payload = { xml: xml, name: name, files: blobMap };
            window.__mtlxPendingImport = payload;
            window.__mtlxPendingViewerImport = payload;
            window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: payload }));
            window.dispatchEvent(new CustomEvent('mtlx-view-document', { detail: payload }));
        } else if (mode === 'graph') {
            // Kept for robustness (e.g. a stale/future host sending a
            // single-view payload) — mirrors js/shared/mtlx-ui.jsx's
            // openInGraphEditor() exactly: js/graph-app.jsx's
            // 'mtlx-load-document' listener (and its
            // window.__mtlxPendingImport fallback for a payload that
            // arrives before the listener is registered) expects this
            // shape verbatim.
            window.__mtlxPendingImport = { xml: xml, name: name, files: blobMap };
            window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: window.__mtlxPendingImport }));
            location.hash = '#!graph';
        } else if (mode === 'viewer') {
            // Kept for robustness, same reasoning as 'graph' above.
            // Mirrors openInViewer() / js/viewer-app.jsx's
            // 'mtlx-view-document' listener.
            window.__mtlxPendingViewerImport = { xml: xml, name: name, files: blobMap };
            window.dispatchEvent(new CustomEvent('mtlx-view-document', { detail: window.__mtlxPendingViewerImport }));
            location.hash = '#!viewer';
        } else if (mode === 'docs') {
            // No document payload contract for the docs view (it has no
            // per-file state to import) — just make sure the hash agrees.
            // A reused docs panel (the materialxPlayground.openDocs
            // command's singleton) is re-navigated this way. hash is NOT
            // always '#!docs' in practice: the hover "Open Interactive
            // Documentation" deep link (extension.js builds the hash,
            // editorProvider.js's openDocsPanel forwards it as this same
            // 'mtlx-open'/mode:'docs' message) routinely sends
            // '#/<category>?sig=…' through this exact path — the
            // '#!docs' fallback below only fires when hash itself is
            // falsy (a no-arg/category-less open: Command Palette,
            // explorer context menu, or a reused panel with nothing more
            // specific to show).
            location.hash = hash || '#!docs';
        }
    }

    // 'mtlx-open': editorProvider.js posts { type: 'mtlx-open', mode,
    // name, xml, filesB64, fileUrls } (resolveCustomTextEditor's
    // sendUpdate()) once on initial load and again on every debounced
    // text-document change (live reload), or { type: 'mtlx-open', mode:
    // 'docs', hash } for a docs-panel (re)navigation. filesB64 (included
    // .mtlx documents) decodes synchronously into Blobs, same as always;
    // fileUrls (textures, a webview resource URL per docScanner.js map
    // key) are fetched here, with the page's true fetch, and merged into
    // the same blob map before dispatchOpen() runs: this is what lets a
    // 4K/8K texture set load without ever base64-encoding it through
    // postMessage. lastDocName/lastBlobMap are remembered here
    // (module-scoped, not function-local) so the hashchange listener
    // further down (Graph -> Viewer sync on view switch) can hand the
    // Viewer the same name/texture-blob context the Graph editor itself
    // was loaded with, even though that sync fires long after this
    // function returns and the original payload is out of scope.
    //
    // Stale guard: openSeq is bumped on every call, and mySeq is
    // re-checked once the (async) texture fetch settles, so a newer
    // 'mtlx-open' arriving while an older one is still fetching wins, and
    // the older one's dispatch (and lastDocName/lastBlobMap update) is
    // dropped rather than overwriting the newer state.
    function handleOpen(msg) {
        var mySeq = ++openSeq;
        var mode = msg.mode;
        var name = msg.name;
        var xml = msg.xml;
        var rawFiles = msg.filesB64 || null;
        var fileUrls = msg.fileUrls || null;
        var hash = msg.hash;

        // filesB64: { relPath: base64string } as sent by docScanner.js via
        // editorProvider.js's toMessageFilesB64(), included .mtlx
        // documents only now (textures travel as fileUrls instead). See
        // base64ToUint8 above for why these cross the boundary as base64
        // text rather than raw Uint8Array/Buffer values. Decode each
        // entry and wrap it in the { relPath: Blob } shape
        // js/graph-app.jsx / js/viewer-app.jsx's ingest() expects, the
        // same shape their own drag-and-drop path produces.
        var blobMap = null;
        if (rawFiles) {
            blobMap = {};
            Object.keys(rawFiles).forEach(function (key) {
                blobMap[key] = new Blob([base64ToUint8(rawFiles[key])]);
            });
        }

        var startedAt = (window.performance && performance.now) ? performance.now() : Date.now();
        fetchTextureBlobs(fileUrls).then(function (result) {
            if (mySeq !== openSeq) return; // superseded by a newer mtlx-open

            var textureKeys = Object.keys(result.blobs);
            if (textureKeys.length) {
                if (blobMap === null) blobMap = {};
                textureKeys.forEach(function (key) { blobMap[key] = result.blobs[key]; });
            }

            function finish() {
                if (mySeq !== openSeq) return; // superseded while the test report was being built
                lastDocName = name;
                lastBlobMap = blobMap;
                dispatchOpen(mode, name, xml, blobMap, hash);
            }

            if (isTransportTest) {
                buildTestFilesReport(result).then(function (filesReport) {
                    var totalMs = ((window.performance && performance.now) ? performance.now() : Date.now()) - startedAt;
                    if (vscodeApi) {
                        vscodeApi.postMessage({
                            type: 'mtlx-test-files',
                            seq: mySeq,
                            files: filesReport,
                            failures: result.failures,
                            totalMs: totalMs,
                        });
                    }
                    finish();
                });
            } else {
                finish();
            }
        });
    }

    // ------------------------------------------------------------------
    // Scene Viewer loads (sceneProvider.js has the protocol). One open or
    // reload is a host seq; on-demand rounds resend the set with the same
    // seq and a higher round. Progress reaches js/usd-scene-app.jsx as
    // 'mtlx-scene-host-progress' events, files as 'mtlx-load-scene'.
    var scene = { seq: 0, round: 0, cancelled: false, token: 0, controller: null };
    // url (with its ?v=mtime-size buster) -> { promise, blob, loaded }: each
    // file is fetched once and reused across rounds and file-change reloads.
    var sceneBlobs = {};
    var SCENE_FETCH_CONCURRENCY = 6;
    var SCENE_STREAM_MAX_BYTES = 256 * 1024 * 1024; // larger files skip byte-level progress
    var sceneFetchStats = { started: 0, completed: 0, aborted: 0, inFlight: 0, bytes: 0 };
    // Test transport only: ms to pause between streamed chunks in
    // fetchSceneBlob's pump(), set from 'mtlx-open-scene's throttleMs field
    // (editorProvider.js's testApi.setSceneFetchThrottle, stamped on by
    // sceneProvider.js). Zero outside test mode, and isTransportTest also
    // gates the pump() check itself, so this is inert for a real user.
    var sceneFetchThrottleMs = 0;
    var pendingSceneMissing = {}; // requestId -> resolve
    var nextSceneMissingId = 1;

    function emitSceneProgress(detail) {
        window.__mtlxSceneHostProgress = detail; // read by a view that mounts late
        window.dispatchEvent(new CustomEvent('mtlx-scene-host-progress', { detail: detail }));
    }

    // False for a message from an older seq, or for the seq the user cancelled.
    function adoptSceneSeq(seq) {
        if (typeof seq !== 'number') return !scene.cancelled;
        if (seq < scene.seq) return false;
        if (seq > scene.seq) {
            scene.seq = seq;
            scene.round = 0;
            scene.cancelled = false;
        }
        return !scene.cancelled;
    }

    function handleSceneProgress(msg) {
        if (!adoptSceneSeq(msg.seq)) return;
        emitSceneProgress({ seq: msg.seq, round: 0, phase: 'collect', found: Number(msg.found) || 0, bytes: Number(msg.bytes) || 0 });
    }

    // One file as a Blob, from the cache when this exact URL was fetched
    // before. Streams files up to SCENE_STREAM_MAX_BYTES so byte progress
    // moves while a big file downloads.
    function fetchSceneBlob(url, signal) {
        var hit = sceneBlobs[url];
        if (hit) return hit.promise;
        var entry = { promise: null, blob: null, loaded: 0 };
        sceneFetchStats.started++;
        sceneFetchStats.inFlight++;
        entry.promise = siteFetch(url, { signal: signal }).then(function (res) {
            if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'));
            var length = Number(res.headers.get('content-length')) || 0;
            if (!res.body || typeof res.body.getReader !== 'function' || length > SCENE_STREAM_MAX_BYTES) return res.blob();
            var reader = res.body.getReader();
            var chunks = [];
            function pump() {
                return reader.read().then(function (step) {
                    if (step.done) return new Blob(chunks);
                    chunks.push(step.value);
                    entry.loaded += step.value.byteLength;
                    sceneFetchStats.bytes += step.value.byteLength;
                    if (isTransportTest && sceneFetchThrottleMs > 0) {
                        return new Promise(function (resolve) { setTimeout(resolve, sceneFetchThrottleMs); }).then(pump);
                    }
                    return pump();
                });
            }
            return pump();
        }).then(function (blob) {
            entry.blob = blob;
            entry.loaded = blob.size;
            sceneFetchStats.completed++;
            sceneFetchStats.inFlight--;
            return blob;
        }, function (e) {
            if (sceneBlobs[url] === entry) delete sceneBlobs[url];
            sceneFetchStats.inFlight--;
            if (e && e.name === 'AbortError') sceneFetchStats.aborted++;
            throw e;
        });
        sceneBlobs[url] = entry;
        return entry.promise;
    }

    // 'mtlx-open-scene': fetches the set (cached files are not fetched again)
    // with fetch progress, then hands js/usd-scene-app.jsx File objects whose
    // lastModified is the file's mtime (the USD worker's input cache key).
    function handleOpenScene(msg) {
        if (!adoptSceneSeq(msg.seq)) return;
        if (isTransportTest) sceneFetchThrottleMs = Number(msg.throttleMs) || 0;
        scene.round = Number(msg.round) || 0;
        var token = ++scene.token;
        if (!scene.controller) scene.controller = new AbortController();
        var signal = scene.controller.signal;
        var urls = msg.fileUrls || {};
        var mtimes = msg.mtimes || {};
        var sizes = msg.sizes || {};
        var keys = Object.keys(urls);
        var bytesTotal = keys.reduce(function (sum, key) { return sum + (Number(sizes[key]) || 0); }, 0);
        var done = 0;
        var blobs = {};
        var current = function () { return token === scene.token && !scene.cancelled; };
        function report() {
            if (!current()) return;
            var bytes = 0;
            keys.forEach(function (key) {
                var entry = sceneBlobs[urls[key]];
                if (entry) bytes += entry.blob ? entry.blob.size : entry.loaded;
            });
            emitSceneProgress({
                seq: msg.seq, round: scene.round, phase: 'fetch', done: done, total: keys.length,
                bytesDone: Math.min(bytes, bytesTotal), bytesTotal: bytesTotal,
            });
        }
        report();
        var timer = setInterval(report, 150);
        var next = 0;
        function runOne() {
            if (!current() || next >= keys.length) return Promise.resolve();
            var key = keys[next++];
            return fetchSceneBlob(urls[key], signal).then(function (blob) {
                blobs[key] = blob;
            }, function (e) {
                if (!(e && e.name === 'AbortError') && current()) {
                    postError('Scene file "' + key + '" could not be loaded: ' + String((e && e.message) || e));
                }
            }).then(function () {
                done++;
                return runOne();
            });
        }
        var starters = [];
        for (var i = 0; i < Math.min(SCENE_FETCH_CONCURRENCY, keys.length); i++) starters.push(runOne());
        Promise.all(starters).then(function () {
            clearInterval(timer);
            if (!current()) return;
            report();
            // Keep only what this set still uses, so memory tracks the scene.
            var keep = {};
            keys.forEach(function (key) { keep[urls[key]] = true; });
            Object.keys(sceneBlobs).forEach(function (url) {
                if (!keep[url] && sceneBlobs[url].blob) delete sceneBlobs[url];
            });
            var files = {};
            Object.keys(blobs).forEach(function (key) {
                var modified = typeof mtimes[key] === 'number' ? mtimes[key] : Date.now();
                files[key] = new File([blobs[key]], key.slice(key.lastIndexOf('/') + 1), { lastModified: modified });
            });
            var payload = { files: files, root: msg.root, name: msg.name, seq: msg.seq, round: scene.round };
            window.__mtlxPendingSceneImport = payload;
            window.dispatchEvent(new CustomEvent('mtlx-load-scene', { detail: payload }));
        });
    }

    // Called by js/usd-scene-app.jsx's Cancel: stops the host's collection
    // and every fetch in flight; nothing more loads until Reload.
    window.__mtlxSceneCancel = function () {
        scene.cancelled = true;
        scene.token++;
        if (scene.controller) {
            scene.controller.abort();
            scene.controller = null;
        }
        Object.keys(pendingSceneMissing).forEach(function (id) {
            var resolve = pendingSceneMissing[id];
            delete pendingSceneMissing[id];
            resolve({ added: 0, cancelled: true });
        });
        if (vscodeApi) vscodeApi.postMessage({ type: 'mtlx-scene-cancel', seq: scene.seq });
    };
    window.__mtlxSceneReload = function () {
        if (vscodeApi) vscodeApi.postMessage({ type: 'mtlx-scene-reload' });
    };

    // Asks the host for files the loaded scene reported missing ({ asset,
    // introducedBy } entries). Resolves { added, stillMissing }; when added
    // is above 0 a bigger set follows as a new 'mtlx-open-scene' round.
    window.__mtlxSceneReportMissing = function (missing) {
        if (!vscodeApi || !Array.isArray(missing) || !missing.length || scene.cancelled) return Promise.resolve({ added: 0 });
        var id = nextSceneMissingId++;
        return new Promise(function (resolve) {
            var timer = setTimeout(function () {
                if (!pendingSceneMissing[id]) return;
                delete pendingSceneMissing[id];
                resolve({ added: 0, timedOut: true });
            }, 30000);
            pendingSceneMissing[id] = function (result) { clearTimeout(timer); resolve(result); };
            vscodeApi.postMessage({ type: 'mtlx-scene-missing', seq: scene.seq, requestId: id, missing: missing.slice(0, 512) });
        });
    };
    function handleSceneMissingResult(msg) {
        var resolve = pendingSceneMissing[msg.requestId];
        if (!resolve) return;
        delete pendingSceneMissing[msg.requestId];
        resolve({ added: Number(msg.added) || 0, stillMissing: Number(msg.stillMissing) || 0 });
    }

    // Test transport only: waits for a scene file fetch to be in flight,
    // clicks the progress Cancel button, then reports whether loading
    // stopped ('mtlx-test-scene-cancel').
    function handleTestTriggerSceneCancel(msg) {
        if (!isTransportTest || !vscodeApi) return;
        var started = Date.now();
        var timeoutMs = Number(msg.timeoutMs) || 60000;
        var settleMs = Number(msg.settleMs) || 4000;
        function snapshot() {
            return {
                started: sceneFetchStats.started, completed: sceneFetchStats.completed, aborted: sceneFetchStats.aborted,
                inFlight: sceneFetchStats.inFlight, bytes: sceneFetchStats.bytes,
            };
        }
        (function poll() {
            var button = document.querySelector('[data-testid="usd-scene-progress-cancel"]');
            var ready = button && sceneFetchStats.inFlight > 0 && sceneFetchStats.bytes > 0;
            if (!ready) {
                if (Date.now() - started > timeoutMs) {
                    vscodeApi.postMessage({ type: 'mtlx-test-scene-cancel', report: { clicked: false, stats: snapshot(), buttonFound: !!button } });
                    return;
                }
                setTimeout(poll, 50);
                return;
            }
            var atCancel = snapshot();
            button.click();
            setTimeout(function () {
                var after = snapshot();
                var cancelledPanel = document.querySelector('[data-testid="usd-scene-cancelled"]');
                vscodeApi.postMessage({
                    type: 'mtlx-test-scene-cancel',
                    report: {
                        clicked: true, atCancel: atCancel, after: after,
                        cancelledShown: !!cancelledPanel,
                        cancelledText: cancelledPanel ? cancelledPanel.textContent : '',
                        reloadShown: !!document.querySelector('[data-testid="usd-scene-reload"]'),
                        progressShown: !!document.querySelector('[data-testid="usd-scene-progress"]'),
                    },
                });
            }, settleMs);
        })();
    }

    // Test transport only: posts one 'mtlx-save' exactly like requestGraphSave
    // (minus its view guards) and reports the host's answer as
    // 'mtlx-test-graph-save', so the harness can prove a USD editor refuses it.
    function handleTestTriggerGraphSave(msg) {
        if (!isTransportTest || !vscodeApi || pendingSave) return;
        new Promise(function (resolve, reject) {
            pendingSave = { resolve: resolve, reject: reject };
            vscodeApi.postMessage({ type: 'mtlx-save', xml: String(msg.xml || '') });
        }).then(function () {
            vscodeApi.postMessage({ type: 'mtlx-test-graph-save', ok: true });
        }, function (e) {
            vscodeApi.postMessage({ type: 'mtlx-test-graph-save', ok: false, error: String((e && e.message) || e) });
        });
    }

    // Test transport only: the same pointerdown + dblclick a user makes at the
    // viewport's centre (or on a mesh row when msg.target is 'tree'), then polls
    // the material preview panel and reports it as 'mtlx-test-material-preview'.
    function handleTestTriggerMaterialPreview(msg) {
        if (!isTransportTest || !vscodeApi) return;
        var started = Date.now();
        var timeoutMs = Number(msg.timeoutMs) || 30000;
        var deps = 'not requested';
        function snapshot() {
            var panel = document.querySelector('[data-testid="usd-scene-material-preview"]');
            var text = panel ? (panel.textContent || '') : '';
            var clicks = (window.__mtlxUsdSceneDoubleClicks || []).filter(function (c) { return c.event === 'dblclick'; });
            return {
                panel: !!panel,
                panelHidden: panel ? panel.classList.contains('hidden') : null,
                depsSpinner: /Loading preview/.test(text),
                depsErrorShown: !!(panel && panel.querySelector('[data-testid="usd-scene-material-preview-error"]')),
                graphLoading: /Loading graph/.test(text),
                graphPreview: !!(panel && panel.querySelector('.mtlx-graph-preview')),
                nodes: panel ? panel.querySelectorAll('.react-flow__node').length : 0,
                previewUnavailable: /Preview unavailable in VS Code/.test(text),
                previewPaneAbsent: !(panel && (panel.querySelector('[data-testid="mtlx-graph-preview-divider"]') || panel.querySelector('[aria-label*="3D preview"]'))),
                hasGraphPreview: typeof window.MtlxGraphPreview,
                hasReactFlow: !!window.ReactFlow,
                hasDagre: !!window.dagre,
                deps: deps,
                dblReason: clicks.length ? clicks[clicks.length - 1].reason : null,
                lastDblClick: clicks.length ? JSON.stringify(clicks[clicks.length - 1]).slice(0, 300) : null,
                text: text.slice(0, 300),
                elapsedMs: Date.now() - started,
            };
        }
        function send(extra) {
            vscodeApi.postMessage({ type: 'mtlx-test-material-preview', report: Object.assign(snapshot(), extra || {}, { log: testLog.slice(-30) }) });
        }
        function poll() {
            // Observed only once the panel exists, so this never starts the
            // load itself (mtlxLoadViewDeps is memoized: same promise).
            if (deps === 'not requested' && document.querySelector('[data-testid="usd-scene-material-preview"]') && typeof window.mtlxLoadViewDeps === 'function') {
                deps = 'pending';
                window.mtlxLoadViewDeps('galleryDetail').then(function () { deps = 'resolved'; }, function (e) { deps = 'rejected: ' + String((e && e.message) || e); });
            }
            var s = snapshot();
            // The Scene Viewer pre-warms this panel hidden with a stub document,
            // so only a visible panel showing the clicked material counts.
            var shown = s.panel && !s.panelHidden && !/preview-warmup/.test(s.text);
            var settled = (shown && ((s.nodes > 0 && !s.graphLoading) || s.depsErrorShown)) || (!!s.dblReason && s.dblReason !== 'ok');
            if (settled || Date.now() - started > timeoutMs) { send({ settled: settled }); return; }
            setTimeout(poll, 500);
        }
        if (msg.target === 'tree') {
            // The outliner row of the first mesh bound to a material; a narrow
            // webview starts with the sidebar collapsed, so open it first.
            var rowSelector = '[data-testid="usd-scene-tree-row"][data-kind="mesh"][data-has-material="true"]';
            var expand = document.querySelector('button[title="Expand the scene viewer panel"]');
            if (!document.querySelector(rowSelector) && expand) expand.click();
            (function waitForRow() {
                var row = document.querySelector(rowSelector);
                if (!row && Date.now() - started < 5000) { setTimeout(waitForRow, 100); return; }
                if (!row) { send({ fatal: 'no mesh row in the scene tree', via: 'tree' }); return; }
                row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, button: 0, detail: 2 }));
                poll();
            })();
        } else {
            var canvas = document.querySelector('[data-testid="usd-scene-canvas"]');
            if (!canvas) { send({ fatal: 'no scene canvas' }); return; }
            var r = canvas.getBoundingClientRect();
            var x = r.left + r.width / 2;
            var y = r.top + r.height / 2;
            // Dispatch on whatever is under that point, like a real click: the WebGL
            // canvas, since the viewer ignores double-clicks that miss it.
            var hit = document.elementFromPoint(x, y) || canvas;
            hit.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, button: 0, pointerType: 'mouse' }));
            hit.dispatchEvent(new MouseEvent('dblclick', { clientX: x, clientY: y, bubbles: true, button: 0, detail: 2 }));
            poll();
        }
    }

    // NOTE: this is NOT the only postMessage traffic this page can see —
    // the type check below (`.type === 'mtlx-open'`, etc.) is kept as
    // defense-in-depth against any future/foreign message shapes that
    // might arrive on this top-level webview document.
    window.addEventListener('message', function (event) {
        var msg = event.data;
        if (!msg) return;
        if (msg.type === 'mtlx-theme-preference') {
            window.__MTLX_THEME_PREF__ = msg.value;
            if (window.MtlxTheme) window.MtlxTheme.setPreference(msg.value, { persist: false });
            return;
        }
        if (msg.type === 'mtlx-save-result') { handleSaveResult(msg); return; }
        if (msg.type === 'mtlx-save-file-result') { handleSaveFileResult(msg); return; }
        if (msg.type === 'mtlx-request-save') { handleRequestSave(msg); return; }
        if (msg.type === 'mtlx-request-undo' || msg.type === 'mtlx-request-redo') { handleRequestUndoRedo(msg); return; }
        if (msg.type === 'mtlx-test-trigger-download') { handleTestTriggerDownload(msg); return; }
        if (msg.type === 'mtlx-test-trigger-snapshot') { handleTestTriggerSnapshot(msg); return; }
        if (msg.type === 'mtlx-test-trigger-pixel') { handleTestTriggerPixel(msg); return; }
        if (msg.type === 'mtlx-test-trigger-graph-save') { handleTestTriggerGraphSave(msg); return; }
        if (msg.type === 'mtlx-test-trigger-material-preview') { handleTestTriggerMaterialPreview(msg); return; }
        if (msg.type === 'mtlx-test-trigger-about') { handleTestTriggerAbout(msg); return; }
        if (msg.type === 'mtlx-test-trigger-docs-filter') { handleTestTriggerDocsFilter(msg); return; }
        if (msg.type === 'mtlx-switch-view') { handleSwitchView(msg); return; }
        if (msg.type === 'mtlx-test-trigger-view-hash') { handleTestTriggerViewHash(msg); return; }
        if (msg.type === 'mtlx-test-trigger-full-width') { handleTestTriggerFullWidth(msg); return; }
        if (msg.type === 'mtlx-open-scene') { handleOpenScene(msg); return; }
        if (msg.type === 'mtlx-scene-progress') { handleSceneProgress(msg); return; }
        if (msg.type === 'mtlx-scene-missing-result') { handleSceneMissingResult(msg); return; }
        if (msg.type === 'mtlx-test-trigger-scene-cancel') { handleTestTriggerSceneCancel(msg); return; }
        if (msg.type === 'mtlx-docs-filter') { handleDocsFilter(msg); return; }
        if (msg.type === 'mtlx-select') { handleSelect(msg); return; }
        if (msg.type === 'mtlx-test-trigger-graph-selection') { handleTestTriggerGraphSelection(msg); return; }
        if (msg.type === 'mtlx-test-trigger-graph-click') { handleTestTriggerGraphClick(msg); return; }
        if (msg.type !== 'mtlx-open') return;
        handleOpen(msg);
    }, false);

    // ------------------------------------------------------------------
    // Graph -> Viewer sync when the user switches to the Viewer. Both
    // views live in this ONE webview/document — only one is mounted at a
    // time (js/shell.jsx unmounts whichever view it isn't displaying) —
    // so "always in sync" means: at the moment the Viewer becomes
    // visible, pull the Graph editor's CURRENT (possibly unsaved,
    // possibly never-saved) state and hand it to the Viewer, the same
    // window.__mtlxPendingViewerImport + 'mtlx-view-document' contract
    // 'mtlx-open' above already uses (and the site's own "Send to
    // Viewer" button uses — js/shared/mtlx-ui.jsx openInViewer()). The
    // reverse direction (Viewer -> Graph) needs nothing: the Viewer is
    // read-only, and an external file edit already reloads BOTH views
    // via editorProvider.js's live-reload / this file's 'mtlx-open'
    // handling above — there's no Viewer-only state that could ever need
    // to flow back.
    //
    // window.__mtlxGetGraphXml only exists while the Graph editor is
    // mounted (see the Ctrl+S section above), which doubles here as "the
    // user actually had a live graph session to sync from" — if the
    // Graph view was never opened this tab, lastBlobMap/lastDocName are
    // still whatever the last 'mtlx-open' set (or null on a fresh panel;
    // the Viewer's own mount-time __mtlxPendingViewerImport from that
    // same 'mtlx-open' already covers that case, so this listener simply
    // has nothing new to contribute and no-ops via the typeof check).
    //
    // NOTE: the Viewer rebuilds its material and recompiles its shader on
    // EVERY switch — same WASM/shader-gen cost as any fresh load. That
    // cost is real; what keeps it from stalling the UI is the site's own
    // background WASM warm-up kicked off at boot (unrelated to this
    // listener), not anything special done here.
    window.addEventListener('hashchange', function () {
        if (location.hash.indexOf('#!viewer') !== 0) return;
        if (typeof window.__mtlxGetGraphXml !== 'function') return;
        Promise.resolve()
            .then(function () { return window.__mtlxGetGraphXml(); })
            .then(function (xml) {
                var payload = { xml: xml, name: lastDocName || 'document', files: lastBlobMap };
                window.__mtlxPendingViewerImport = payload;
                window.dispatchEvent(new CustomEvent('mtlx-view-document', { detail: payload }));
            })
            .catch(function (e) {
                postError('Graph -> Viewer sync failed: ' + String((e && e.message) || e));
            });
    }, false);

    // ------------------------------------------------------------------
    // Tell the extension host we're ready to receive the initial
    // payload. Sent from DOMContentLoaded (not top-level/immediately) so
    // the message/click listeners above are guaranteed registered first,
    // and so editorProvider.js's onDidReceiveMessage('ready') handler —
    // which calls docScanner.scan() and posts the result straight back —
    // has a real listener waiting on this side by the time its response
    // arrives.
    document.addEventListener('DOMContentLoaded', function () {
        if (vscodeApi) {
            vscodeApi.postMessage({ type: 'ready' });
        }
    });
})();
