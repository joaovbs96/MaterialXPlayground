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
    window.addEventListener('error', function (event) {
        var where = event && event.filename ? ' (' + event.filename + ':' + event.lineno + ')' : '';
        postError(((event && event.message) || 'Unknown error') + where);
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

    // 'mtlx-open-scene': sceneProvider.js posts { root, name, fileUrls, mtimes }
    // for a USD stage (initial load and every watched change). Every file is
    // fetched here and handed to js/usd-scene-app.jsx as File objects whose
    // lastModified is the file's mtime (the USD worker's input cache key).
    var sceneSeq = 0;
    function handleOpenScene(msg) {
        var mySeq = ++sceneSeq;
        var mtimes = msg.mtimes || {};
        fetchTextureBlobs(msg.fileUrls || {}, 'Scene file', 6).then(function (result) {
            if (mySeq !== sceneSeq) return; // superseded by a newer scene payload
            var files = {};
            Object.keys(result.blobs).forEach(function (key) {
                var modified = typeof mtimes[key] === 'number' ? mtimes[key] : Date.now();
                files[key] = new File([result.blobs[key]], key.slice(key.lastIndexOf('/') + 1), { lastModified: modified });
            });
            var payload = { files: files, root: msg.root, name: msg.name };
            window.__mtlxPendingSceneImport = payload;
            window.dispatchEvent(new CustomEvent('mtlx-load-scene', { detail: payload }));
        });
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

    // Test transport only: the same pointerdown + dblclick a user makes at
    // the scene viewport's centre, then polls the material preview panel and
    // reports its state as 'mtlx-test-material-preview'.
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
        var canvas = document.querySelector('[data-testid="usd-scene-canvas"]');
        if (!canvas) { send({ fatal: 'no scene canvas' }); return; }
        var r = canvas.getBoundingClientRect();
        var x = r.left + r.width / 2;
        var y = r.top + r.height / 2;
        canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true, button: 0, pointerType: 'mouse' }));
        canvas.dispatchEvent(new MouseEvent('dblclick', { clientX: x, clientY: y, bubbles: true, button: 0, detail: 2 }));
        (function poll() {
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
        })();
    }

    // NOTE: this is NOT the only postMessage traffic this page can see —
    // the type check below (`.type === 'mtlx-open'`, etc.) is kept as
    // defense-in-depth against any future/foreign message shapes that
    // might arrive on this top-level webview document.
    window.addEventListener('message', function (event) {
        var msg = event.data;
        if (!msg) return;
        if (msg.type === 'mtlx-save-result') { handleSaveResult(msg); return; }
        if (msg.type === 'mtlx-save-file-result') { handleSaveFileResult(msg); return; }
        if (msg.type === 'mtlx-request-save') { handleRequestSave(msg); return; }
        if (msg.type === 'mtlx-request-undo' || msg.type === 'mtlx-request-redo') { handleRequestUndoRedo(msg); return; }
        if (msg.type === 'mtlx-test-trigger-download') { handleTestTriggerDownload(msg); return; }
        if (msg.type === 'mtlx-test-trigger-snapshot') { handleTestTriggerSnapshot(msg); return; }
        if (msg.type === 'mtlx-test-trigger-graph-save') { handleTestTriggerGraphSave(msg); return; }
        if (msg.type === 'mtlx-test-trigger-material-preview') { handleTestTriggerMaterialPreview(msg); return; }
        if (msg.type === 'mtlx-open-scene') { handleOpenScene(msg); return; }
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
