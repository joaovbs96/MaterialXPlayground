// glue.js: main-world glue between the Electron preload's mtlxDesktop
// bridge and the UNMODIFIED site, installed via webFrame.executeJavaScript.
// Ported from vscode_extension/media/bootstrap.js's handleOpen('both') contract.
(function () {
    'use strict';
    if (window.__mtlxGlueInstalled) return;
    window.__mtlxGlueInstalled = true;
    if (!window.mtlxDesktop) return;

    // Mirrors bootstrap.js's handleOpen('both') exactly, but skips base64:
    // contextBridge/IPC carry Uint8Array/TypedArrays by copy natively, unlike
    // the webview postMessage channel bootstrap.js has to work around.
    window.mtlxDesktop.onOpenFile(function (payload) {
        if (!payload) return;
        var rawFiles = payload.files || null;
        var blobMap = null;
        if (rawFiles) {
            blobMap = {};
            Object.keys(rawFiles).forEach(function (key) {
                blobMap[key] = new Blob([rawFiles[key]]);
            });
        }
        var loaded = { xml: payload.xml, name: payload.name, files: blobMap };
        window.__mtlxPendingImport = loaded;
        window.__mtlxPendingViewerImport = loaded;
        window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: loaded }));
        window.dispatchEvent(new CustomEvent('mtlx-view-document', { detail: loaded }));
    });

    // js/graph-app.jsx calls this with the serialized XML STRING on every
    // settled edit (not a boolean): any call simply means "now dirty".
    // The desktop bridge itself clears dirty again on a successful save.
    window.__mtlxNotifyEdit = function () {
        window.mtlxDesktop.notifyEdit(true);
    };

    // Wired for a future native Save menu item (phase 5); nothing in this
    // phase triggers onRequestSave/onSaveCommitted yet.
    window.mtlxDesktop.onRequestSave(function () {
        if (typeof window.__mtlxGetGraphXml !== 'function') {
            return Promise.reject(new Error('graph view is not open'));
        }
        return window.__mtlxGetGraphXml();
    });
    window.mtlxDesktop.onSaveCommitted(function () {
        if (typeof window.__mtlxMarkGraphSaved === 'function') window.__mtlxMarkGraphSaved();
    });
})();
