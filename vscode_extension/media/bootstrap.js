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
    // the way it does in a normal browser tab. Handle the two cases the
    // site actually produces:
    //   - href starting with '#'   -> same-page hash navigation; do it
    //                                  ourselves via location.hash so the
    //                                  site's hash-based router sees it,
    //                                  and preventDefault so the webview
    //                                  doesn't also try to load
    //                                  "<baseUri>#!graph" as a document.
    //   - http(s) links (external) -> leave alone; VS Code's webview host
    //                                  intercepts these itself and opens
    //                                  them in the user's real browser.
    document.addEventListener('click', function (event) {
        var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
        if (!anchor) return;
        var href = anchor.getAttribute('href');
        if (!href) return;
        if (href.charAt(0) === '#') {
            event.preventDefault();
            location.hash = href;
        }
        // http(s):// (and any other scheme) links: no-op here, VS Code
        // handles those.
    }, false);

    // ------------------------------------------------------------------
    // Extension -> webview payload delivery. editorProvider.js posts
    // { type: 'mtlx-open', mode, name, xml, files } (resolveCustomTextEditor's
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
        if (!msg || msg.type !== 'mtlx-open') return;

        var mode = msg.mode;
        var name = msg.name;
        var xml = msg.xml;
        var rawFiles = msg.files || null;

        // files: { relPath: Uint8Array } as sent by docScanner.js via
        // editorProvider.js's toMessageFiles(). VS Code (>=1.57)
        // structured-clones typed arrays across the extension<->webview
        // boundary natively, so `rawFiles[key]` arrives here as a real
        // Uint8Array, not base64 text. Convert to the { relPath: Blob }
        // shape js/graph-app.jsx / js/viewer-app.jsx's ingest() expects
        // — the same shape their own drag-and-drop path produces.
        var blobMap = null;
        if (rawFiles) {
            blobMap = {};
            Object.keys(rawFiles).forEach(function (key) {
                blobMap[key] = new Blob([rawFiles[key]]);
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
