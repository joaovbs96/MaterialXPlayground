// preload.js: context-isolated bridge between the main process and the
// site. Sets the host flag, buffers open-file/save-request payloads, and
// exposes mtlxDesktop plus installs glue.js into the page's main world.
'use strict';

const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

contextBridge.exposeInMainWorld('__MTLX_ELECTRON__', true);
// Platform, exposed the same synchronous way: js/site-header.js builds its
// markup at load time, so it cannot wait on the async mtlxDesktop bridge,
// and contextIsolation hides process.platform from the page. Only the
// macOS title bar needs it (traffic lights sit where the header's brand
// goes), so this is the value that decides that layout.
contextBridge.exposeInMainWorld('__MTLX_PLATFORM__', process.platform);

// Buffered like the site's own window.__mtlxPendingImport pattern: main
// may send 'mtlx-open-file' before the page registers onOpenFile, so the
// payload is held until a callback shows up.
let openFileCallback = null;
let pendingOpenFilePayload = null;
ipcRenderer.on('mtlx-open-file', (event, payload) => {
    if (openFileCallback) openFileCallback(payload);
    else pendingOpenFilePayload = payload;
});

// Renderer answering a future main-initiated save request (phase 5's
// native Save menu); 'graph view is not open' mirrors bootstrap.js's own
// silent no-op reasoning when no callback has been registered yet.
let requestSaveCallback = null;
ipcRenderer.on('mtlx-request-save', async () => {
    if (!requestSaveCallback) {
        ipcRenderer.send('mtlx-request-save-reply', { error: 'graph view is not open' });
        return;
    }
    try {
        const xml = await requestSaveCallback();
        ipcRenderer.send('mtlx-request-save-reply', { xml });
    } catch (e) {
        ipcRenderer.send('mtlx-request-save-reply', { error: e && e.message ? e.message : String(e) });
    }
});
let saveCommittedCallback = null;
ipcRenderer.on('mtlx-save-committed', () => { if (saveCommittedCallback) saveCommittedCallback(); });

// Native menu items with no main-process logic of their own (New/Export/
// Undo/Redo) forward a command string here for glue.js to route in-page.
let menuCommandCallback = null;
ipcRenderer.on('mtlx-menu-command', (event, cmd) => { if (menuCommandCallback) menuCommandCallback(cmd); });

// Same buffering idea as onOpenFile above, but an ARRAY: several notices
// (e.g. a safe-mode startup notice plus a GPU restart) can arrive before
// the shell's DesktopNoticeBar registers its callback.
let noticeCallback = null;
let pendingNotices = [];
ipcRenderer.on('mtlx-notice', (event, notice) => {
    if (noticeCallback) noticeCallback(notice);
    else pendingNotices.push(notice);
});

// Main asking this window to show the styled close-confirm dialog
// (main.js's requestCloseConfirmation); glue.js echoes the token back
// so a stale reply after the native fallback wins is dropped there.
let closeConfirmCallback = null;
ipcRenderer.on('mtlx-close-confirm-request', (event, payload) => {
    if (closeConfirmCallback) closeConfirmCallback(payload);
});

const api = {
    saveMtlx: (opts) => ipcRenderer.invoke('mtlx-save', opts),
    notifyEdit: (dirty) => ipcRenderer.send('mtlx-notify-edit', !!dirty),
    onOpenFile: (callback) => {
        openFileCallback = callback;
        if (pendingOpenFilePayload) {
            const payload = pendingOpenFilePayload;
            pendingOpenFilePayload = null;
            callback(payload);
        }
    },
    onRequestSave: (callback) => { requestSaveCallback = callback; },
    onSaveCommitted: (callback) => { saveCommittedCallback = callback; },
    onMenuCommand: (callback) => { menuCommandCallback = callback; },
    onCloseConfirmRequest: (callback) => { closeConfirmCallback = callback; },
    respondCloseConfirm: (payload) => ipcRenderer.send('mtlx-close-confirm-response', payload),
    onNotice: (callback) => {
        noticeCallback = callback;
        if (pendingNotices.length) {
            const queued = pendingNotices;
            pendingNotices = [];
            queued.forEach((notice) => callback(notice));
        }
    },
    getSettings: () => ipcRenderer.invoke('mtlx-get-settings'),
    getAbout: () => ipcRenderer.invoke('mtlx-get-about'),
    setOpenInNewWindow: (value) => ipcRenderer.send('mtlx-set-open-in-new-window', !!value),
    setShowRecentInSystem: (value) => ipcRenderer.send('mtlx-set-show-recent-in-system', !!value),
    setDocumentOpenView: (value) => ipcRenderer.send('mtlx-set-document-open-view', value),
    setSafeMode: (value) => ipcRenderer.send('mtlx-set-safe-mode', !!value),
    relaunch: () => ipcRenderer.send('mtlx-relaunch'),
    getRecents: () => ipcRenderer.invoke('mtlx-get-recents'),
    openRecent: (filePath) => ipcRenderer.invoke('mtlx-open-recent', filePath),
    // Resolves a dropped File to its real filesystem path (glue.js's
    // __mtlxDesktopPathDrop); '' when it throws or the File is not
    // backed by a real file (e.g. one constructed in JS).
    getPathForFile: (file) => {
        try {
            const p = webUtils.getPathForFile(file);
            return typeof p === 'string' ? p : '';
        } catch (e) {
            return '';
        }
    },
    openPath: (filePath) => ipcRenderer.invoke('mtlx-open-path', filePath),
    revealDocument: () => ipcRenderer.invoke('mtlx-reveal-document'),
    copyDocumentPath: () => ipcRenderer.invoke('mtlx-copy-document-path'),
};
contextBridge.exposeInMainWorld('mtlxDesktop', api);

// Install glue.js into the page's main world (preload runs before the
// page's own scripts, so webFrame's main-world context already exists).
// The DOMContentLoaded call is belt-and-suspenders; glue.js is idempotent.
const glueSource = fs.readFileSync(path.join(__dirname, 'glue.js'), 'utf8');
function installGlue() {
    webFrame.executeJavaScript(glueSource).catch((e) => console.error('[preload] glue install failed:', e));
}
installGlue();
document.addEventListener('DOMContentLoaded', installGlue);
