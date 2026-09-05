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
        var loaded = { xml: payload.xml, name: payload.name, files: blobMap, reload: payload.reload };
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

    // Wired to the native Save/Save As menu items (main.js's saveFromMenu),
    // which drive onRequestSave and onSaveCommitted via the IPC round trip.
    window.mtlxDesktop.onRequestSave(function () {
        if (typeof window.__mtlxGetGraphXml !== 'function') {
            return Promise.reject(new Error('graph view is not open'));
        }
        return window.__mtlxGetGraphXml();
    });
    window.mtlxDesktop.onSaveCommitted(function () {
        if (typeof window.__mtlxMarkGraphSaved === 'function') window.__mtlxMarkGraphSaved();
    });

    // New/Export/Undo/Redo forward here from the native menu (main.js's
    // sendMenuCommand); an editable-focused field gets the OS text-edit
    // command instead, mirroring graph-app.jsx's own Ctrl+C/V/Z guard.
    window.mtlxDesktop.onMenuCommand(function (cmd) {
        if (cmd === 'undo' || cmd === 'redo') {
            var active = document.activeElement;
            var isEditable = active && (active.isContentEditable
                || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || ''));
            if (isEditable) {
                document.execCommand(cmd);
                return;
            }
        }
        window.dispatchEvent(new CustomEvent('mtlx-desktop-command', { detail: { cmd: cmd } }));
    });

    // Shell-level styled close-confirm dialog (js/shell.jsx). Token is
    // kept here, not exposed to shell.jsx, and echoed back so a stale
    // response after the native fallback wins is a no-op in main.
    var pendingCloseConfirmToken = null;
    window.mtlxDesktop.onCloseConfirmRequest(function (payload) {
        pendingCloseConfirmToken = payload && payload.token;
        window.dispatchEvent(new CustomEvent('mtlx-desktop-close-confirm', { detail: payload }));
    });
    window.__mtlxRespondCloseConfirm = function (choice) {
        window.mtlxDesktop.respondCloseConfirm({ token: pendingCloseConfirmToken, choice: choice });
    };

    // Shell-level settings dialog (js/shell.jsx's DesktopSettingsDialog),
    // opened from the header cog (js/site-header.js).
    window.__mtlxGetDesktopSettings = function () {
        return window.mtlxDesktop.getSettings();
    };
    window.__mtlxSetOpenInNewWindow = function (value) {
        window.mtlxDesktop.setOpenInNewWindow(value);
    };
    window.__mtlxSetShowRecentInSystem = function (value) {
        window.mtlxDesktop.setShowRecentInSystem(value);
    };
    window.__mtlxSetDocumentOpenView = function (value) {
        window.mtlxDesktop.setDocumentOpenView(value);
    };
    window.__mtlxSetSafeMode = function (value) {
        window.mtlxDesktop.setSafeMode(value);
    };
    window.__mtlxRelaunch = function () {
        window.mtlxDesktop.relaunch();
    };

    // Shell-level notice bar (js/shell.jsx's DesktopNoticeBar): safe-mode
    // startup and crash-recovery notices pushed from main (GPU restarts,
    // etc), one CustomEvent per notice.
    window.mtlxDesktop.onNotice(function (notice) {
        window.dispatchEvent(new CustomEvent('mtlx-desktop-notice', { detail: notice }));
    });

    // Shell-level About dialog (js/shell.jsx's DesktopAboutDialog),
    // opened from the header help button (js/site-header.js).
    window.__mtlxGetAbout = function () {
        return window.mtlxDesktop.getAbout();
    };

    // Graph editor's in-app Open Recent dialog (js/graph-app.jsx), since
    // the native Open Recent submenu is unreachable behind titleBarStyle
    // 'hidden'. getRecents is read fresh every time the dialog opens.
    window.__mtlxGetRecents = function () {
        return window.mtlxDesktop.getRecents();
    };
    window.__mtlxOpenRecent = function (filePath) {
        return window.mtlxDesktop.openRecent(filePath);
    };
})();
