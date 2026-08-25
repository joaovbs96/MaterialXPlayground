// preload.js: context-isolated bridge between the main process and the
// site. Sets the host flag, buffers open-file/save-request payloads, and
// exposes mtlxDesktop plus installs glue.js into the page's main world.
'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

contextBridge.exposeInMainWorld('__MTLX_ELECTRON__', true);

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
    getSettings: () => ipcRenderer.invoke('mtlx-get-settings'),
    setOpenInNewWindow: (value) => ipcRenderer.send('mtlx-set-open-in-new-window', !!value),
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
