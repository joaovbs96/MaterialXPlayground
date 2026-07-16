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
    // never fights it back off. Embed/chromeless iframes (the graph
    // editor's inline "?" docs dialog) force previews on regardless of
    // this key, and the Graph/Viewer views never read it at all — this
    // only affects docs panels/tabs.
    try {
        if (window.localStorage.getItem('mtlx_show_previews') === null) {
            window.localStorage.setItem('mtlx_show_previews', '0');
        }
    } catch (e) {
        // localStorage can throw (disabled storage, quota, etc.) — never
        // let this default block the rest of bootstrap from running.
    }

    // Decode a base64 string into a Uint8Array. Used for every binary
    // payload that crosses the extension<->webview postMessage boundary
    // (see the 'mtlx-fetch-result' and 'mtlx-open' handlers below) —
    // VS Code does NOT reliably deliver Node Buffers/typed arrays posted
    // from the extension host as typed arrays on this side; in practice
    // they arrive JSON-serialized into a plain object instead, which is
    // silently wrong for a Blob and loudly wrong for
    // WebAssembly.instantiate() (surfaced as "expected magic word
    // 00 61 73 6d, found 5b 6f 62 6a" — "[obj", i.e. "[object Object]"
    // stringified). Base64 text has no such ambiguity. These payloads are
    // at most a few MB, and atob() + a byte loop over that runs in the
    // tens of milliseconds — negligible next to correctness.
    function base64ToUint8(b64) {
        var binary = atob(b64);
        var out = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
    }

    // ------------------------------------------------------------------
    // fetch() bridge for the MaterialX Emscripten payloads.
    //
    // WHY: the Emscripten glue (js/JsMaterialXGenShader.js et al.) loads
    // its packed virtual filesystem and wasm binary via plain relative
    // fetch('./js/JsMaterialXGenShader.data' / '.wasm'). Under <base
    // href="${baseUri}"> those resolve to webview-resource URLs — and the
    // webview resource pipeline ALTERS these large binaries in transit:
    // the packed-FS slice offsets shift, so a standard-library file
    // unpacked from the .data payload fails to parse at its own EOF
    // ("XML parse error in /libraries/bxdf/disney_principled.mtlx at
    // character 7307" — that packed file's last byte), the stdlib ends up
    // null, and every downstream consumer breaks ("getNodeDefs is not
    // bound", no shader generation). Serving the bytes from the EXTENSION
    // HOST over postMessage (vscode.workspace.fs.readFile on the real
    // file, base64-encoded across the boundary — see base64ToUint8 above
    // for why a raw Uint8Array/Buffer doesn't survive the trip intact)
    // bypasses that pipeline entirely. The explicit Content-Type on the
    // synthesized Response keeps WebAssembly.instantiateStreaming() on
    // its fast path for the .wasm case (it requires 'application/wasm').
    //
    // Everything that doesn't match the payload pattern — including
    // Request-object inputs — passes through to the native fetch
    // untouched, and any host-side failure falls back to the native
    // fetch too, so this is never worse than the status quo. Host side:
    // wireCommonWebviewMessages() in vscode_extension/src/
    // editorProvider.js (which whitelists the path before reading).
    // 'mtlx-fetch-result' replies are settled by the window 'message'
    // listener further down. Ids are a private incrementing counter —
    // they cannot collide with the 'mtlx-open' flow, which has no id.
    var MTLX_PAYLOAD_RE = /(?:^|\/)js\/(JsMaterialX[\w.\-]*\.(?:data|wasm))$/;
    var pendingFetches = {}; // id -> { resolve, fallback, path }
    var nextFetchId = 1;
    // Not in a VS Code webview (vscodeApi unavailable): skip wrapping
    // entirely — plain browser fetch works fine there.
    if (vscodeApi && typeof window.fetch === 'function') {
        var nativeFetch = window.fetch.bind(window);
        window.fetch = function (input, init) {
            var url = typeof input === 'string' ? input : (input && input.url) || '';
            // Match on the URL's path only — strip any query/hash first.
            var match = MTLX_PAYLOAD_RE.exec(url.split(/[?#]/)[0]);
            if (!match) return nativeFetch(input, init);
            var relPath = 'js/' + match[1];
            return new Promise(function (resolve) {
                var id = nextFetchId++;
                pendingFetches[id] = {
                    resolve: resolve,
                    // On any host-side failure: fall back to the native
                    // fetch rather than failing the caller outright.
                    fallback: function () { resolve(nativeFetch(input, init)); },
                    path: relPath,
                };
                vscodeApi.postMessage({ type: 'mtlx-fetch', id: id, path: relPath });
            });
        };
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
        vscodeApi.postMessage({ type: 'mtlx-error', text: String(text).slice(0, MAX_ERROR_CHARS) });
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

    // ------------------------------------------------------------------
    // Link interception: <base href="${baseUri}"> (webview.html) makes
    // every relative href in the site resolve to a webview-resource URL,
    // which is exactly what local script/style/image tags need — but it
    // ALSO means a plain in-page hash link (e.g. <a href="#!graph">, the
    // site's own top nav) would, without help, be resolved against that
    // base and try to *navigate* the webview's frame to a new
    // webview-resource document instead of just updating location.hash
    // the way it does in a normal browser tab. Handle the cases the site
    // actually produces:
    //   - href starting with '#'   -> same-page hash navigation; do it
    //                                  ourselves via location.hash so the
    //                                  site's hash-based router sees it,
    //                                  and preventDefault so the webview
    //                                  doesn't also try to load
    //                                  "<baseUri>#!graph" as a document.
    //   - 'index.html#...' hrefs   -> same treatment. Cause: js/
    //                                  site-header.js:28 computes IS_SHELL
    //                                  from location.pathname, which under
    //                                  the webview's document URL can be
    //                                  false, so the header emits
    //                                  'index.html#!...'-style links.
    //                                  Letting those navigate would load
    //                                  the RAW site page inside the
    //                                  webview — without this bootstrap,
    //                                  without the fetch bridge — so any
    //                                  href whose pre-'#' part is empty or
    //                                  ends in 'index.html' (i.e. would
    //                                  target the SAME document) becomes a
    //                                  hash update instead.
    //   - http(s) links (external) -> leave alone; VS Code's webview host
    //                                  intercepts these itself and opens
    //                                  them in the user's real browser.
    document.addEventListener('click', function (event) {
        var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
        if (!anchor) return;
        var href = anchor.getAttribute('href');
        if (!href) return;
        var hashIdx = href.indexOf('#');
        if (hashIdx === -1) return;
        var beforeHash = href.slice(0, hashIdx);
        // A scheme (https:, mailto:, ...) means a true external link —
        // never intercept those, even if the path happens to end in
        // 'index.html'.
        if (/^[a-z][a-z0-9+.\-]*:/i.test(beforeHash)) return;
        if (beforeHash === '' || /index\.html$/i.test(beforeHash)) {
            event.preventDefault();
            location.hash = href.slice(hashIdx);
        }
        // http(s):// (and any other scheme) links: no-op here, VS Code
        // handles those.
    }, false);

    // ------------------------------------------------------------------
    // Extension -> webview payload delivery. editorProvider.js posts
    // { type: 'mtlx-open', mode, name, xml, filesB64 } (resolveCustomTextEditor's
    // sendUpdate()) once on initial load and again on every debounced
    // text-document change (live reload).
    //
    // lastDocName / lastBlobMap: remembered from the most recent
    // 'mtlx-open' payload, so the hashchange listener further down
    // (Graph -> Viewer sync on view switch) can hand the Viewer the same
    // name/texture-blob context the Graph editor itself was loaded with,
    // even though that sync fires long after this message handler
    // returns and the original payload is out of scope.
    var lastDocName = null;
    var lastBlobMap = null;

    // NOTE: this is NOT the only postMessage traffic this page can see —
    // the site's own graph-editor docs dialog embeds
    // index.html?embed=1#/... in an <iframe>, and code under js/docs/
    // posts messages for that iframe's own close/resize signaling. Those
    // have a different shape (no `.type === 'mtlx-open'`) and target the
    // iframe's parent window rather than this top-level webview document
    // — but the type check below is kept regardless, both as
    // defense-in-depth and because a future site change could add other
    // message shapes at this level.
    window.addEventListener('message', function (event) {
        var msg = event.data;
        if (!msg) return;

        // 'mtlx-fetch-result': the extension host answering an
        // 'mtlx-fetch' posted by the fetch() bridge above. Settle and
        // forget the pending entry; unknown/duplicate ids are ignored.
        if (msg.type === 'mtlx-fetch-result') {
            var pending = pendingFetches[msg.id];
            if (!pending) return;
            delete pendingFetches[msg.id];
            if (msg.ok && msg.bytesB64) {
                pending.resolve(new Response(base64ToUint8(msg.bytesB64), {
                    status: 200,
                    headers: {
                        'Content-Type': /\.wasm$/.test(pending.path)
                            ? 'application/wasm'
                            : 'application/octet-stream',
                    },
                }));
            } else {
                pending.fallback();
            }
            return;
        }

        // 'mtlx-save-result': the extension host answering an 'mtlx-save'
        // posted by the Ctrl/Cmd+S handler below. Settle the one in-flight
        // save (there is never more than one outstanding — the keydown
        // handler doesn't post a new 'mtlx-save' until the previous one
        // settles) and forget it; a stray/duplicate reply with nothing
        // pending is ignored.
        if (msg.type === 'mtlx-save-result') {
            if (!pendingSave) return;
            var settleSave = pendingSave;
            pendingSave = null;
            if (msg.ok) settleSave.resolve();
            else settleSave.reject(new Error(msg.error || 'save failed'));
            return;
        }

        // 'mtlx-request-save': the extension host asking this webview to
        // save, posted by editorProvider.js's saveActiveGraph() in
        // response to the materialxPlayground.saveGraph command (the
        // contributed Ctrl+S keybinding — see the comment above
        // requestGraphSave() for why that's the primary path now).
        // Reuses the exact same function the in-page keydown fallback
        // calls, guard and all.
        if (msg.type === 'mtlx-request-save') {
            requestGraphSave();
            return;
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
        if (msg.type === 'mtlx-request-undo' || msg.type === 'mtlx-request-redo') {
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
            return;
        }

        if (msg.type !== 'mtlx-open') return;

        var mode = msg.mode;
        var name = msg.name;
        var xml = msg.xml;
        var rawFiles = msg.filesB64 || null;

        // filesB64: { relPath: base64string } as sent by docScanner.js via
        // editorProvider.js's toMessageFilesB64(). See base64ToUint8 above
        // for why these cross the boundary as base64 text rather than raw
        // Uint8Array/Buffer values. Decode each entry and wrap it in the
        // { relPath: Blob } shape js/graph-app.jsx / js/viewer-app.jsx's
        // ingest() expects — the same shape their own drag-and-drop path
        // produces.
        var blobMap = null;
        if (rawFiles) {
            blobMap = {};
            Object.keys(rawFiles).forEach(function (key) {
                blobMap[key] = new Blob([base64ToUint8(rawFiles[key])]);
            });
        }

        lastDocName = name;
        lastBlobMap = blobMap;

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
            // A reused docs panel (the materialxPlayground.openDocs command's
            // singleton) is re-navigated this way; msg.hash is always
            // '#!docs' in practice today (the command only ever sends that).
            location.hash = msg.hash || '#!docs';
        }
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
