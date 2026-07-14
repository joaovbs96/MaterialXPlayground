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

        if (mode === 'graph') {
            // Mirrors js/shared/mtlx-ui.jsx's openInGraphEditor() exactly
            // — js/graph-app.jsx's 'mtlx-load-document' listener (and its
            // window.__mtlxPendingImport fallback for a payload that
            // arrives before the listener is registered) expects this
            // shape verbatim.
            window.__mtlxPendingImport = { xml: xml, name: name, files: blobMap };
            window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: window.__mtlxPendingImport }));
            location.hash = '#!graph';
        } else if (mode === 'viewer') {
            // Mirrors openInViewer() / js/viewer-app.jsx's
            // 'mtlx-view-document' listener, same reasoning as above.
            window.__mtlxPendingViewerImport = { xml: xml, name: name, files: blobMap };
            window.dispatchEvent(new CustomEvent('mtlx-view-document', { detail: window.__mtlxPendingViewerImport }));
            location.hash = '#!viewer';
        } else if (mode === 'docs') {
            // No document payload contract for the docs view (it has no
            // per-file state to import) — just make sure the hash agrees.
            location.hash = '#!docs';
        }
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
