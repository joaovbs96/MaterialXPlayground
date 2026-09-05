// main.js: Electron main process, serving the unmodified site over a
// pinned app:// origin (file:// cannot do this: see
// docs/local/ELECTRON.md for why).
'use strict';

const { app, BrowserWindow, protocol, session, shell, ipcMain, dialog, Menu, screen, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const docScanner = require('./doc-scanner');

// macOS diverges on window chrome and menu layout, both decided at
// startup; the existing one-off process.platform checks stay as they are.
const IS_MAC = process.platform === 'darwin';

function errMsg(e) {
    return e && e.message ? e.message : String(e);
}

// Main-to-renderer notice channel (js/shell.jsx's DesktopNoticeBar). A
// notice is { kind, level: 'info' | 'warn', text }; kind is how the
// shell dedupes (a new notice with the same kind replaces the old one).
function sendNotice(win, notice) {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send('mtlx-notice', notice);
}

function broadcastNotice(notice) {
    BrowserWindow.getAllWindows().forEach((win) => sendNotice(win, notice));
}

// Bumped by the onBeforeRequest blocker below every time it cancels a
// request; the MTLX_SMOKE harness reads this to prove the blocker (not
// just an unrelated network failure) is what refused its probe request.
let blockedRequestCount = 0;

const APP_SCHEME = 'app';
// Pinned forever: this origin keys every user's localStorage/IndexedDB
// (autosave records, texture blobs, prefs). Never change the host string.
const APP_HOST = 'playground';

// The four routable tools (source of truth: shellRouteFor in
// js/site-header.js), plus 'home': the mobile nav's own Home link uses
// '#!home' too, so it's the established hash for landing on Home, not
// just shellRouteFor's unmatched-hash fallback.
const ROUTE_HASHES = { docs: '#!docs', viewer: '#!viewer', compare: '#!compare', graph: '#!graph', home: '#!home' };
const DEFAULT_ROUTE = 'graph';

function urlForRoute(route) {
    const hash = ROUTE_HASHES[route] || ROUTE_HASHES[DEFAULT_ROUTE];
    return APP_SCHEME + '://' + APP_HOST + '/index.html' + hash;
}
// Debounce for the per-window disk watcher (startWatcher below), same
// precedent value as vscode_extension/src/editorProvider.js.
const RELOAD_DEBOUNCE_MS = 400;

// Every privilege flag below is load-bearing: standard+secure for blob:
// URLs, clipboard, and postMessage origin checks; supportFetchAPI, stream,
// and corsEnabled cover the site's fetch()/WASM/.data loading paths.
protocol.registerSchemesAsPrivileged([
    {
        scheme: APP_SCHEME,
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            stream: true,
            corsEnabled: true,
        },
    },
]);

// Electron 43 dropped the CLI flag, so remote debugging (used by the
// screenshot/diagnostic tooling) is opt-in via this env variable.
if (process.env.MTLX_DEBUG_PORT) {
    app.commandLine.appendSwitch('remote-debugging-port', process.env.MTLX_DEBUG_PORT);
}

// Synchronous because safeModeActive below must be decided before
// app.whenReady(); loadSettings() (used everywhere else in this file)
// just delegates here once the rest of the module has finished loading.
function readSettingsSync() {
    try {
        const parsed = JSON.parse(fsSync.readFileSync(getSettingsPath(), 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        return {};
    }
}

// Must be decided before app.whenReady(): disableHardwareAcceleration()
// is a no-op once Electron has finished starting up, and the normal
// settings read (loadSettings, inside whenReady below) runs too late.
const safeModeActive = process.argv.includes('--safe-mode') || readSettingsSync().safeMode === true;
if (safeModeActive) app.disableHardwareAcceleration();

function getSiteRoot() {
    if (process.env.MTLX_SITE_ROOT) return path.resolve(process.env.MTLX_SITE_ROOT);
    return path.join(process.resourcesPath, 'site');
}

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.data': 'application/octet-stream',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.obj': 'model/obj',
    '.exr': 'application/octet-stream',
    '.hdr': 'application/octet-stream',
    '.mtlx': 'application/xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.map': 'application/json; charset=utf-8',
};

function mimeFor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] || 'application/octet-stream';
}

// Strict CSP for HTML responses only. 'self' (not the app: scheme) so it
// resolves to exactly app://playground; see the Stream 4 report for the
// per-directive justification.
const APP_CSP =
    "default-src 'none'; " +
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "font-src 'self'; " +
    "img-src 'self' blob: data:; " +
    "connect-src 'self' blob: data:; " +
    "worker-src 'self' blob:; " +
    "frame-src 'self';";

// Resolves a request pathname against the site root, rejecting anything
// that escapes it. Directories (and the empty/root path) fall through to
// that directory's index.html; anything missing is a 404.
async function resolveSiteFile(root, pathname) {
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
    const resolved = relative === '' ? root : path.normalize(path.join(root, relative));
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (resolved !== root && !resolved.startsWith(rootWithSep)) {
        return { status: 403 };
    }

    let stat;
    try {
        stat = await fs.stat(resolved);
    } catch (e) {
        return { status: 404 };
    }

    const filePath = stat.isDirectory() ? path.join(resolved, 'index.html') : resolved;
    try {
        const fileStat = await fs.stat(filePath);
        if (fileStat.isDirectory()) return { status: 404 };
    } catch (e) {
        return { status: 404 };
    }
    return { status: 200, filePath };
}

function plainTextResponse(status, isHead, text) {
    return new Response(isHead ? null : text, {
        status,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
}

async function handleAppRequest(request) {
    const url = new URL(request.url);
    const isHead = request.method === 'HEAD';

    if (url.hostname !== APP_HOST) {
        return plainTextResponse(404, isHead, 'Not found');
    }

    const result = await resolveSiteFile(getSiteRoot(), url.pathname);
    if (result.status === 403) return plainTextResponse(403, isHead, 'Forbidden');
    if (result.status === 404) return plainTextResponse(404, isHead, 'Not found');

    const headers = { 'content-type': mimeFor(result.filePath) };
    if (path.extname(result.filePath).toLowerCase() === '.html') {
        headers['content-security-policy'] = APP_CSP;
    }
    if (isHead) return new Response(null, { status: 200, headers });

    const data = await fs.readFile(result.filePath);
    return new Response(data, { status: 200, headers });
}

// Per-window document state, keyed by BrowserWindow instance. currentPath
// is the on-disk .mtlx this window is bound to (null until an open/save);
// editDepth guards our own writes from re-triggering the disk watcher.
const windowStates = new Map();
function getWindowState(win) {
    let state = windowStates.get(win);
    if (!state) {
        state = {
            currentPath: null, dirty: false, watcher: null, editDepth: 0, forceClose: false, closeConfirmToken: null,
            // Renderer-hang bookkeeping (win.on('unresponsive')/'responsive'
            // below): hangTimer/hangPromptOpen/hangAbortController.
            hangTimer: null, hangPromptOpen: false, hangAbortController: null,
            // Set right before a self-inflicted forcefullyCrashRenderer()
            // (the hang dialog's Force Reload) so the render-process-gone
            // handler below does not also show its own crash dialog for it.
            selfInflictedCrash: false,
            // Per-window bounds-save debounce (armBoundsSave) and did-fail-load
            // retry counter (reset on did-finish-load).
            boundsSaveTimer: null,
            failLoadRetries: 0,
        };
        windowStates.set(win, state);
        win.on('closed', () => {
            if (state.watcher) state.watcher.close();
            if (state.boundsSaveTimer) clearTimeout(state.boundsSaveTimer);
            windowStates.delete(win);
        });
    }
    return state;
}

// Reflects currentPath/dirty in the OS window title; a no-op until a file
// is actually open, so the default page title is left alone until then.
function updateWindowTitle(win) {
    const state = getWindowState(win);
    if (!state.currentPath) return;
    const baseName = path.basename(state.currentPath, path.extname(state.currentPath));
    win.setTitle((state.dirty ? '* ' : '') + baseName);
}

function stopWatcher(win) {
    const state = getWindowState(win);
    if (state.watcher) {
        state.watcher.close();
        state.watcher = null;
    }
}

// Watches the bound .mtlx file for external edits and re-ingests it on
// change. editDepth > 0 means the change is OUR OWN write (saveMtlxForWindow),
// so it's skipped rather than treated as an external edit.
function startWatcher(win, filePath) {
    stopWatcher(win);
    const state = getWindowState(win);
    let debounceTimer = null;
    try {
        state.watcher = fsSync.watch(filePath, () => {
            if (getWindowState(win).editDepth > 0) return;
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                openMtlxFromDisk(filePath, win, true);
            }, RELOAD_DEBOUNCE_MS);
        });
    } catch (e) {
        console.error('[main] failed to watch "' + filePath + '": ' + errMsg(e));
    }
}

// Writes `xml` to state.currentPath, or prompts a save dialog when there
// is no bound file yet (or forceDialog asks for Save As). Returns
// { ok: true, path } / { ok: false, canceled: true } / { ok: false, error }.
async function saveMtlxForWindow(win, { xml, suggestedName, forceDialog } = {}) {
    const state = getWindowState(win);
    let target = state.currentPath;
    if (forceDialog || !state.currentPath) {
        const result = await dialog.showSaveDialog(win, {
            defaultPath: state.currentPath || path.join(app.getPath('documents'), suggestedName || 'document.mtlx'),
            filters: [{ name: 'MaterialX Document', extensions: ['mtlx'] }],
        });
        if (result.canceled || !result.filePath) return { ok: false, canceled: true };
        target = result.filePath;
    }

    state.editDepth++;
    try {
        await fs.writeFile(target, typeof xml === 'string' ? xml : '', 'utf8');
    } catch (e) {
        return { ok: false, error: errMsg(e) };
    } finally {
        state.editDepth--;
    }

    state.currentPath = target;
    state.dirty = false;
    // showRecentInSystem only gates what we push to the OS; our own
    // recentFiles list (addRecent below) always keeps working.
    if (showRecentInSystem) app.addRecentDocument(target);
    addRecent(target);
    startWatcher(win, target);
    updateWindowTitle(win);
    return { ok: true, path: target };
}

ipcMain.handle('mtlx-save', async (event, opts) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, error: 'no window' };
    return saveMtlxForWindow(win, opts || {});
});

ipcMain.on('mtlx-notify-edit', (event, dirty) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const state = getWindowState(win);
    state.dirty = !!dirty;
    updateWindowTitle(win);
});

// Renderer-side settings dialog (js/shell.jsx's DesktopSettingsDialog) reads
// through this instead of the unreachable native menu checkbox. platform is
// included because the renderer cannot read process.platform directly under
// contextIsolation; jumpListStatus is the last buildJumpList() outcome.
ipcMain.handle('mtlx-get-settings', () => ({
    openInNewWindow,
    showRecentInSystem,
    documentOpenView,
    safeMode,
    safeModeActive,
    windowBounds,
    platform: process.platform,
    jumpListStatus,
}));

// Renderer-side About dialog (js/shell.jsx's DesktopAboutDialog) reads
// these instead of the unreachable native menu's About item.
// Unpackaged dev runs read electron/package.json's committed version via
// app.getVersion(); dev.mjs resolves the real version from git instead
// and passes it through this env var, so prefer it when present.
ipcMain.handle('mtlx-get-about', () => ({
    appVersion: process.env.MTLX_DEV_VERSION || app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    safeModeActive,
}));

// Reuses setOpenInNewWindow so persistence and the native checkbox's
// rebuildMenu() stay in sync with whatever the dialog set.
ipcMain.on('mtlx-set-open-in-new-window', (event, value) => setOpenInNewWindow(value));

// Reuses setShowRecentInSystem so persistence, app.clearRecentDocuments()
// and the jump list rebuild stay in sync with whatever the dialog set.
ipcMain.on('mtlx-set-show-recent-in-system', (event, value) => setShowRecentInSystem(value));

// Reuses setDocumentOpenView so persistence stays in sync with whatever
// the dialog set.
ipcMain.on('mtlx-set-document-open-view', (event, value) => setDocumentOpenView(value));

// Reuses setSafeMode so persistence stays in sync with whatever the
// dialog set; takes effect on the next launch (see safeModeActive above).
ipcMain.on('mtlx-set-safe-mode', (event, value) => setSafeMode(value));

// Offered by the settings dialog's "Relaunch now" button right after
// toggling safe mode, so the change does not wait for a manual restart.
ipcMain.on('mtlx-relaunch', () => relaunchApp());

// Renderer-side Open Recent dialog (js/graph-app.jsx's in-app File menu)
// reads the same list the native Open Recent submenu is built from.
ipcMain.handle('mtlx-get-recents', () => recentFiles.slice());

// Opens a path chosen from the renderer's Open Recent dialog. Routed
// through openMtlxRouted so it honors the Open Files in New Window
// preference, unlike the native Open Recent submenu which always
// reuses the window the click happened in.
ipcMain.handle('mtlx-open-recent', (event, filePath) => {
    // Hardening: only ever act on a path we ourselves listed as recent,
    // and only a real .mtlx path, not whatever string the renderer sent.
    const isKnownRecent = typeof filePath === 'string'
        && recentFiles.some((p) => path.normalize(p) === path.normalize(filePath));
    if (!isKnownRecent || !/\.mtlx$/i.test(filePath)) {
        return { ok: false };
    }
    if (!fsSync.existsSync(filePath)) {
        recentFiles = recentFiles.filter((p) => p !== filePath);
        saveRecents(recentFiles);
        rebuildMenu();
        buildJumpList();
        return { ok: false, missing: true, path: filePath };
    }
    openMtlxRouted(filePath);
    return { ok: true };
});

// Drop-to-open (glue.js's __mtlxDesktopPathDrop, via preload's
// openPath): mirrors mtlx-open-recent's validation, then routes through
// openInNewWindow like any other OS-driven open.
ipcMain.handle('mtlx-open-path', (event, filePath) => {
    if (typeof filePath !== 'string' || !filePath || !fsSync.existsSync(filePath) || !/\.mtlx$/i.test(filePath)) {
        const sender = BrowserWindow.fromWebContents(event.sender);
        const base = typeof filePath === 'string' ? path.basename(filePath) : String(filePath);
        sendNotice(sender, {
            kind: 'open-path-rejected',
            level: 'warn',
            text: 'Could not open ' + base + ': the file is missing or is not a .mtlx document.',
        });
        return { ok: false };
    }
    if (openInNewWindow) {
        openMtlxRouted(filePath);
    } else {
        const sender = BrowserWindow.fromWebContents(event.sender);
        // main rebinds currentPath before the page confirms, so a dirty
        // target must never be reused; open a fresh window instead.
        const target = (sender && !getWindowState(sender).dirty)
            ? sender
            : (getRoutingTargetWindow() || createWindow(documentOpenView));
        openMtlxFromDisk(filePath, target, false);
    }
    return { ok: true };
});

// Renderer-side Reveal/Copy Path (js/graph-app.jsx's in-app File menu).
// No dialog here (unlike the native menu items below): the caller shows
// its own "not saved yet" message when ok is false.
ipcMain.handle('mtlx-reveal-document', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const filePath = win ? getWindowState(win).currentPath : null;
    if (!filePath) return { ok: false, path: null };
    shell.showItemInFolder(filePath);
    return { ok: true, path: filePath };
});

ipcMain.handle('mtlx-copy-document-path', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const filePath = win ? getWindowState(win).currentPath : null;
    if (!filePath) return { ok: false, path: null };
    clipboard.writeText(filePath);
    return { ok: true, path: filePath };
});

// Asks a window's renderer to hand back its current graph XML; used by
// saveFromMenu (the native Save/Save As menu items) below.
// timeoutMs is optional: saveFromMenu awaits indefinitely (no deadline),
// the close-confirm paths below pass SAVE_ON_CLOSE_TIMEOUT_MS. Either way
// the reply listener is removed on every exit, including a timeout.
function requestSaveFromRenderer(win, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const cleanup = () => {
            settled = true;
            if (timer) clearTimeout(timer);
            ipcMain.removeListener('mtlx-request-save-reply', listener);
        };
        const listener = (event, result) => {
            if (settled) return;
            if (BrowserWindow.fromWebContents(event.sender) !== win) return;
            cleanup();
            if (result && result.error) reject(new Error(result.error));
            else resolve(result && result.xml);
        };
        ipcMain.on('mtlx-request-save-reply', listener);
        if (timeoutMs) {
            timer = setTimeout(() => {
                if (settled) return;
                cleanup();
                reject(new Error('timed out'));
            }, timeoutMs);
        }
        win.webContents.send('mtlx-request-save');
    });
}

// Bounds the Save and Close renderer round trip below so a hung/broken
// graph-view contract can't leave the close prompt stuck forever.
const SAVE_ON_CLOSE_TIMEOUT_MS = 8000;

// Shown in place of Electron's default silent close-block (its reaction to
// a beforeunload preventDefault with no 'close' listener). forceClose lets
// the re-issued win.close() below skip straight past the guard.
async function confirmCloseWindow(win) {
    if (win.isDestroyed()) return;
    const state = getWindowState(win);
    const choice = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Save and Close', 'Discard', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        title: 'MaterialX Playground',
        message: 'This document has unsaved changes.',
        detail: 'Do you want to save the changes before closing?',
    });
    if (win.isDestroyed()) return;

    if (choice.response === 2) {
        // Cancel: leave the window open, and abandon any relaunch that
        // was waiting on this quit to actually proceed.
        relaunchPending = false;
        pendingSafeMode = false;
        return;
    }

    if (choice.response === 1) { // Discard
        state.forceClose = true;
        if (!win.isDestroyed()) win.close();
        return;
    }

    // The round trip can hang/throw, and a crashed renderer cannot answer
    // it at all; either way, degrade to a discard-or-cancel prompt instead
    // of leaving the window stuck mid-close.
    let xml;
    let saveFailed = win.webContents.isCrashed();
    if (!saveFailed) {
        try {
            xml = await requestSaveFromRenderer(win, SAVE_ON_CLOSE_TIMEOUT_MS);
        } catch (e) {
            console.error('[main] save-before-close failed: ' + errMsg(e));
            saveFailed = true;
        }
        if (win.isDestroyed()) return;
    }
    if (saveFailed) {
        const fallback = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Discard', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            title: 'MaterialX Playground',
            message: 'Could not save this document.',
            detail: 'Close it anyway and lose the unsaved changes?',
        });
        if (win.isDestroyed()) return;
        if (fallback.response === 0) {
            state.forceClose = true;
            win.close();
        }
        return;
    }

    const saveResult = await saveMtlxForWindow(win, { xml });
    if (win.isDestroyed()) return;
    if (saveResult.canceled) return; // Save As dialog canceled: stay open.
    if (!saveResult.ok) {
        dialog.showErrorBox('MaterialX Playground', 'Could not save: ' + saveResult.error);
        return;
    }
    // Same signal saveFromMenu sends: lets the renderer's own isDirty/undo
    // "saved" bookkeeping settle before the re-issued close below.
    win.webContents.send('mtlx-save-committed');
    state.forceClose = true;
    win.close();
}

// Correlates a styled close-confirm round trip; only a response
// carrying this token is accepted (see requestStyledCloseConfirm).
let closeConfirmTokenSeq = 0;
const CLOSE_CONFIRM_TIMEOUT_MS = 4000;

// Resolves with the renderer's choice. Rejects on timeout (after telling
// the renderer to withdraw a late dialog) or if the renderer process
// dies; a 'shown' ack just cancels the timeout while the user decides.
function requestStyledCloseConfirm(win, token) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const listener = (event, payload) => {
            if (settled) return;
            if (BrowserWindow.fromWebContents(event.sender) !== win) return;
            if (!payload || payload.token !== token) return;
            if (payload.choice === 'shown') {
                clearTimeout(timer);
                return;
            }
            settled = true;
            clearTimeout(timer);
            ipcMain.removeListener('mtlx-close-confirm-response', listener);
            try { win.webContents.removeListener('render-process-gone', onGone); } catch (e) {}
            resolve(payload.choice);
        };
        const onGone = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            ipcMain.removeListener('mtlx-close-confirm-response', listener);
            reject(new Error('renderer process gone'));
        };
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            ipcMain.removeListener('mtlx-close-confirm-response', listener);
            try { win.webContents.removeListener('render-process-gone', onGone); } catch (e) {}
            try { win.webContents.send('mtlx-close-confirm-request', { withdraw: true }); } catch (e) {}
            reject(new Error('timed out'));
        }, CLOSE_CONFIRM_TIMEOUT_MS);
        win.webContents.once('render-process-gone', onGone);
        ipcMain.on('mtlx-close-confirm-response', listener);
        win.webContents.send('mtlx-close-confirm-request', { token: token });
    });
}

// Save-and-Close from the STYLED dialog, kept separate from
// confirmCloseWindow's own branch below: that fallback must stay
// byte-for-byte unchanged, so this duplicates it against the same helpers.
async function performStyledSaveAndClose(win) {
    if (win.isDestroyed()) return;
    const state = getWindowState(win);
    let xml;
    try {
        xml = await requestSaveFromRenderer(win, SAVE_ON_CLOSE_TIMEOUT_MS);
    } catch (e) {
        console.error('[main] save-before-close failed: ' + errMsg(e));
        if (win.isDestroyed()) return;
        const fallback = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Discard', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            title: 'MaterialX Playground',
            message: 'Could not save this document.',
            detail: 'Close it anyway and lose the unsaved changes?',
        });
        if (win.isDestroyed()) return;
        if (fallback.response === 0) {
            state.forceClose = true;
            win.close();
        }
        return;
    }
    if (win.isDestroyed()) return;

    const saveResult = await saveMtlxForWindow(win, { xml });
    if (win.isDestroyed()) return;
    if (saveResult.canceled) return; // Save As dialog canceled: stay open.
    if (!saveResult.ok) {
        dialog.showErrorBox('MaterialX Playground', 'Could not save: ' + saveResult.error);
        return;
    }
    win.webContents.send('mtlx-save-committed');
    state.forceClose = true;
    win.close();
}

// Primary close-guard entry (wired below): asks the renderer for its
// styled dialog first, falling back to confirmCloseWindow's native one
// only on timeout/IPC error; closeConfirmToken makes repeat clicks refocus.
async function requestCloseConfirmation(win) {
    if (win.isDestroyed()) return;
    const state = getWindowState(win);
    if (state.closeConfirmToken !== null) {
        win.focus();
        return;
    }
    const token = ++closeConfirmTokenSeq;
    state.closeConfirmToken = token;

    try {
        let choice;
        try {
            choice = await requestStyledCloseConfirm(win, token);
        } catch (e) {
            // Native dialog runs entirely in the main process, so it's
            // the one path guaranteed to work regardless of renderer state.
            await confirmCloseWindow(win);
            return;
        }

        if (choice === 'discard') {
            state.forceClose = true;
            if (!win.isDestroyed()) win.close();
        } else if (choice === 'save') {
            await performStyledSaveAndClose(win);
        } else {
            // 'cancel' (or anything unexpected): leave the window open,
            // and abandon any relaunch that was waiting on this quit.
            relaunchPending = false;
            pendingSafeMode = false;
        }
    } finally {
        if (state.closeConfirmToken === token) state.closeConfirmToken = null;
    }
}

// Reads filePath, scans it for xi:include/texture refs, and sends the
// result to win as 'mtlx-open-file'. isReload marks a host-driven re-feed
// of the same document; only the disk watcher passes true.
async function openMtlxFromDisk(filePath, win, isReload = false) {
    let xml;
    try {
        xml = (await fs.readFile(filePath)).toString('utf8');
    } catch (e) {
        dialog.showErrorBox('MaterialX Playground', 'Could not open "' + filePath + '": ' + errMsg(e));
        return;
    }
    if (win.isDestroyed()) return;

    const name = path.basename(filePath, path.extname(filePath));

    let scanned = { files: {}, warnings: [] };
    try {
        scanned = await docScanner.scan(filePath, xml);
    } catch (e) {
        console.error('[main] doc-scanner failed for "' + filePath + '": ' + errMsg(e));
    }
    if (win.isDestroyed()) return;
    scanned.warnings.forEach((w) => console.warn('[main] doc-scanner: ' + w));

    const files = {};
    for (const key of Object.keys(scanned.files)) {
        files[key] = Uint8Array.from(scanned.files[key]);
    }

    const state = getWindowState(win);
    state.currentPath = filePath;
    state.dirty = false;
    // showRecentInSystem only gates what we push to the OS; our own
    // recentFiles list (addRecent below) always keeps working.
    if (showRecentInSystem) app.addRecentDocument(filePath);
    addRecent(filePath);
    startWatcher(win, filePath);
    updateWindowTitle(win);

    const payload = { name, xml, files, reload: isReload };
    if (win.webContents.isLoading()) {
        win.webContents.once('did-finish-load', () => win.webContents.send('mtlx-open-file', payload));
    } else {
        win.webContents.send('mtlx-open-file', payload);
    }
}

// Finds the first argv entry that looks like an existing .mtlx path
// (Windows/Linux file-association launch args, and second-instance argv).
function getMtlxArg(argv) {
    for (const a of argv) {
        if (typeof a === 'string' && /\.mtlx$/i.test(a) && fsSync.existsSync(a)) return path.resolve(a);
    }
    return null;
}

// Finds a --mtlx-route=<route> argv entry (jump list tasks below, and
// second-instance argv from clicking one while the app is already open).
function getRouteArg(argv) {
    for (const a of argv) {
        if (typeof a !== 'string') continue;
        const m = /^--mtlx-route=(docs|viewer|compare|graph)$/.exec(a);
        if (m) return m[1];
    }
    return null;
}

// Shared deadline for the MTLX_SMOKE and MTLX_SMOKE_OPEN harnesses: a
// hung load or a hung renderer must fail fast instead of eating the
// whole CI job budget.
const SMOKE_DEADLINE_MS = 60000;

// app.exit() can race past a just-written console.log on Windows before
// the pipe flushes; queuing one more (empty) write and exiting from its
// callback guarantees the earlier write has actually landed first.
function finishSmoke(ok, message) {
    console.log('[smoke-open] ' + (ok ? 'OK ' : 'FAIL ') + message);
    process.stdout.write('', () => app.exit(ok ? 0 : 1));
}

// MTLX_SMOKE_OPEN harness: opens filePath in a fresh window and polls the
// graph view's live XML until it reflects that file (or times out).
async function runSmokeOpen(filePath) {
    try {
        const win = createWindow(documentOpenView);
        await new Promise((resolve, reject) => {
            const loadTimer = setTimeout(() => {
                cleanup();
                reject(new Error('timed out after ' + SMOKE_DEADLINE_MS + ' ms waiting for initial load'));
            }, SMOKE_DEADLINE_MS);
            // -3 is Chromium's ABORTED, routinely fired by in-page
            // navigations; only a real main-frame failure should reject.
            const onFinish = () => { cleanup(); resolve(); };
            const onFail = (event, code, description, url, isMainFrame) => {
                if (!isMainFrame || code === -3) return;
                cleanup();
                reject(new Error(code + ' ' + description));
            };
            function cleanup() {
                clearTimeout(loadTimer);
                win.webContents.removeListener('did-finish-load', onFinish);
                win.webContents.removeListener('did-fail-load', onFail);
            }
            win.webContents.on('did-finish-load', onFinish);
            win.webContents.on('did-fail-load', onFail);
        });

        let probeName = null;
        try {
            const xmlText = await fs.readFile(filePath, 'utf8');
            const m = /<\w+\s+name="([^"]+)"/.exec(xmlText);
            if (m) probeName = m[1];
        } catch (e) {
            // Best-effort probe only; falls back to the non-empty check below.
        }

        await openMtlxFromDisk(filePath, win, false);

        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            let xmlText = '';
            try {
                xmlText = await win.webContents.executeJavaScript(
                    'window.__mtlxGetGraphXml ? window.__mtlxGetGraphXml() : ""'
                );
            } catch (e) {
                xmlText = '';
            }
            const ok = probeName ? String(xmlText).includes(probeName) : !!xmlText;
            if (ok) { finishSmoke(true, filePath); return; }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        finishSmoke(false, 'timed out waiting for graph XML');
    } catch (e) {
        finishSmoke(false, errMsg(e));
    }
}

// Path for our own menu-facing "Open Recent" list; additive to (not a
// replacement for) app.addRecentDocument's OS-level jump-list integration.
function getRecentsPath() {
    return path.join(app.getPath('userData'), 'mtlx-recents.json');
}

let recentFiles = [];

// Tolerant of a missing/corrupt file: any failure just means "no recents
// yet", same as a fresh install.
function loadRecents() {
    try {
        const parsed = JSON.parse(fsSync.readFileSync(getRecentsPath(), 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

function saveRecents(list) {
    try {
        fsSync.writeFileSync(getRecentsPath(), JSON.stringify(list), 'utf8');
    } catch (e) {
        console.error('[main] failed to save recent files: ' + errMsg(e));
    }
}

// Dedupe+prepend+cap at 10, most-recent-first; persists and refreshes the
// Open Recent submenu immediately.
function addRecent(filePath) {
    recentFiles = [filePath].concat(recentFiles.filter((p) => p !== filePath)).slice(0, 10);
    saveRecents(recentFiles);
    rebuildMenu();
    buildJumpList();
}

function clearRecents() {
    recentFiles = [];
    saveRecents(recentFiles);
    app.clearRecentDocuments();
    rebuildMenu();
    buildJumpList();
}

// Sibling to mtlx-recents.json, same tolerant JSON-store pattern; holds
// menu-toggled preferences (currently just openInNewWindow).
function getSettingsPath() {
    return path.join(app.getPath('userData'), 'mtlx-settings.json');
}

// Current behavior: every OS-level open (file association, second launch)
// gets its own new window. false routes those into the existing window.
let openInNewWindow = true;

// Whether we publish recent files to the OS (Windows jump list, macOS Dock).
// Our own recentFiles list keeps working regardless; this only gates what
// we push out via app.addRecentDocument/app.setJumpList.
let showRecentInSystem = true;

// Which view a document lands in when opened without an explicit
// --mtlx-route (double-click, Explorer's plain Open, Open Recent, a
// second-instance file launch, macOS open-file). A route always wins.
let documentOpenView = 'graph';

// Persisted preference; safeModeActive (decided pre-ready, above) is
// this LAUNCH's actual state. Toggling this only takes effect after a
// relaunch, which is what the settings dialog's "Relaunch now" offers.
let safeMode = false;

// Last-known bounds of the last focused (or sole) window; see
// initialBounds()/persistWindowBounds() next to createWindow below.
let windowBounds = null;

// Delegates to the pre-ready reader above so the two never drift; kept
// as its own function since every other setting is read through it.
function loadSettings() {
    return readSettingsSync();
}

function saveSettings() {
    try {
        fsSync.writeFileSync(
            getSettingsPath(),
            JSON.stringify({ openInNewWindow, showRecentInSystem, documentOpenView, safeMode, windowBounds }),
            'utf8'
        );
    } catch (e) {
        console.error('[main] failed to save settings: ' + errMsg(e));
    }
}

// Wired to the File menu's checkbox item; persists and rebuilds the menu
// immediately so the checkbox reflects the new state.
function setOpenInNewWindow(value) {
    openInNewWindow = !!value;
    saveSettings();
    rebuildMenu();
}

// Wired to the settings dialog's checkbox. Turning it off clears whatever
// we already pushed to the OS instead of leaving stale entries behind;
// turning it on rebuilds the jump list so a fixed Windows setting shows
// up in the dialog without restarting the app.
function setShowRecentInSystem(value) {
    showRecentInSystem = !!value;
    saveSettings();
    if (!showRecentInSystem) app.clearRecentDocuments();
    buildJumpList();
}

// Wired to the settings dialog's view choice. Only affects opens with no
// explicit --mtlx-route; that always wins over this preference.
function setDocumentOpenView(value) {
    documentOpenView = value === 'viewer' ? 'viewer' : 'graph';
    saveSettings();
}

// Wired to the settings dialog's Safe mode checkbox. Persists only:
// applying it needs disableHardwareAcceleration() before whenReady, so
// it always takes effect on the NEXT launch, via relaunchApp below.
function setSafeMode(value) {
    safeMode = !!value;
    saveSettings();
}

// app.quit() below still runs each window's own dirty-close guard
// (win.on('close')), so a relaunch cannot silently drop unsaved work.
// The actual app.relaunch()/setSafeMode call is deferred to 'will-quit'
// (below) so a quit the user later cancels never leaves a relaunch armed.
let relaunchPending = false;
let pendingSafeMode = false;
function relaunchApp(opts) {
    relaunchPending = true;
    if (opts && opts.safeMode) pendingSafeMode = true;
    app.quit();
}

app.on('will-quit', () => {
    if (!relaunchPending) return;
    if (pendingSafeMode) setSafeMode(true);
    app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--safe-mode') });
});

// Forwards a command string to a window's renderer, for menu items with
// no main-process business logic of their own (New/Export/Undo/Redo).
function sendMenuCommand(win, cmd) {
    if (win) win.webContents.send('mtlx-menu-command', cmd);
}

// Save/Save As: asks the renderer for its current XML, then reuses the
// exact same write/dialog/watcher logic saveMtlxForWindow already has.
async function saveFromMenu(win, forceDialog) {
    if (!win) return;
    let xml;
    try {
        xml = await requestSaveFromRenderer(win);
    } catch (e) {
        dialog.showMessageBox(win, {
            type: 'info',
            title: 'MaterialX Playground',
            message: 'Save needs the graph editor to be open in this window.',
        });
        return;
    }
    const result = await saveMtlxForWindow(win, { xml, forceDialog });
    if (result.ok) {
        win.webContents.send('mtlx-save-committed');
    } else if (result.error) {
        dialog.showErrorBox('MaterialX Playground', 'Could not save: ' + result.error);
    }
}

// Shared by the native Reveal/Copy Path menu items below: the window's
// bound document path, or the saveFromMenu-style info dialog when there
// is none yet. The IPC handlers above deliberately do not reuse this.
function documentPathForMenu(win) {
    const filePath = getWindowState(win).currentPath;
    if (filePath) return filePath;
    dialog.showMessageBox(win, {
        type: 'info',
        title: 'MaterialX Playground',
        message: 'This document has not been saved to disk yet.',
    });
    return null;
}

// One item per known recent path, "prune on click" if the file is gone,
// a trailing Clear Recent, or a single disabled placeholder when empty.
function buildRecentSubmenu() {
    if (recentFiles.length === 0) {
        return [{ label: 'No Recent Documents', enabled: false }];
    }
    const items = recentFiles.map((filePath) => ({
        label: filePath,
        click: (menuItem, win) => {
            if (!fsSync.existsSync(filePath)) {
                console.warn('[main] recent file no longer exists: ' + filePath);
                recentFiles = recentFiles.filter((p) => p !== filePath);
                saveRecents(recentFiles);
                rebuildMenu();
                buildJumpList();
                return;
            }
            openMtlxFromDisk(filePath, win || createWindow(documentOpenView), false);
        },
    }));
    items.push({ type: 'separator' });
    items.push({ label: 'Clear Recent', click: () => clearRecents() });
    return items;
}

// Undo/Redo forward a command string instead of role: 'undo'/'redo' (that
// is Chromium's single global edit stack); the graph editor keeps its own
// document-level undo stack, same precedent as the VS Code extension bridge.
function buildMenuTemplate() {
    const iconPath = runtimeIconPath();

    return [
        // macOS puts About/Services/Hide/Quit in a leading app menu named
        // after the bundle. Prepending it does not disturb the MTLX_SMOKE
        // menu assertion, which looks up the menu LABELLED 'File' rather
        // than indexing position 0.
        ...(IS_MAC ? [{ role: 'appMenu' }] : []),
        {
            label: 'File',
            submenu: [
                { label: 'New', accelerator: 'CmdOrCtrl+N', click: (menuItem, win) => sendMenuCommand(win, 'new') },
                {
                    label: 'Open...',
                    accelerator: 'CmdOrCtrl+O',
                    click: async (menuItem, win) => {
                        const options = {
                            filters: [{ name: 'MaterialX Document', extensions: ['mtlx'] }],
                            properties: ['openFile'],
                        };
                        const result = win
                            ? await dialog.showOpenDialog(win, options)
                            : await dialog.showOpenDialog(options);
                        if (result.canceled || !result.filePaths[0]) return;
                        openMtlxFromDisk(result.filePaths[0], win || createWindow(documentOpenView), false);
                    },
                },
                { label: 'Open Recent', submenu: buildRecentSubmenu() },
                {
                    label: 'Open Files in New Window',
                    type: 'checkbox',
                    checked: openInNewWindow,
                    click: (menuItem) => setOpenInNewWindow(menuItem.checked),
                },
                { type: 'separator' },
                { label: 'Save', accelerator: 'CmdOrCtrl+S', click: (menuItem, win) => saveFromMenu(win, false) },
                {
                    label: 'Save As...',
                    accelerator: 'CmdOrCtrl+Shift+S',
                    click: (menuItem, win) => saveFromMenu(win, true),
                },
                {
                    label: 'Export...',
                    accelerator: 'CmdOrCtrl+E',
                    click: (menuItem, win) => sendMenuCommand(win, 'export'),
                },
                { type: 'separator' },
                {
                    label: IS_MAC ? 'Reveal in Finder' : process.platform === 'win32' ? 'Show in Explorer' : 'Show in File Manager',
                    click: (menuItem, win) => {
                        if (!win) return;
                        const filePath = documentPathForMenu(win);
                        if (filePath) shell.showItemInFolder(filePath);
                    },
                },
                {
                    label: 'Copy Path',
                    click: (menuItem, win) => {
                        if (!win) return;
                        const filePath = documentPathForMenu(win);
                        if (filePath) clipboard.writeText(filePath);
                    },
                },
                { type: 'separator' },
                { label: 'Close Window', role: 'close' },
                // Quit lives in the app menu on macOS (Cmd+Q is wired there
                // by role: 'appMenu'); repeating it in File reads wrong and
                // gives the accelerator two owners.
                ...(IS_MAC ? [] : [{ label: 'Quit', role: 'quit' }]),
            ],
        },
        {
            label: 'Edit',
            submenu: [
                { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: (menuItem, win) => sendMenuCommand(win, 'undo') },
                {
                    label: 'Redo',
                    accelerator: 'CmdOrCtrl+Shift+Z',
                    click: (menuItem, win) => sendMenuCommand(win, 'redo'),
                },
                {
                    label: 'Redo',
                    visible: false,
                    accelerator: 'CmdOrCtrl+Y',
                    acceleratorWorksWhenHidden: true,
                    click: (menuItem, win) => sendMenuCommand(win, 'redo'),
                },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' },
            ],
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'toggleDevTools' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
            ],
        },
        // macOS expects Minimize/Zoom/Bring All to Front, which the built-in
        // role supplies (and keeps the window list Cocoa manages for us).
        IS_MAC ? { role: 'windowMenu' } : {
            label: 'Window',
            submenu: [
                { role: 'minimize' },
                { role: 'close' },
            ],
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'MaterialX Playground Website',
                    click: () => shell.openExternal('https://joaovbs96.github.io/MaterialXPlayground/'),
                },
                {
                    label: 'GitHub Repository',
                    click: () => shell.openExternal('https://github.com/joaovbs96/MaterialXPlayground'),
                },
                { type: 'separator' },
                {
                    label: 'About MaterialX Playground',
                    click: (menuItem, win) => {
                        const options = {
                            type: 'info',
                            title: 'About MaterialX Playground',
                            message: 'MaterialX Playground',
                            detail: 'Version ' + app.getVersion() + '\nElectron ' + process.versions.electron +
                                '\nChromium ' + process.versions.chrome +
                                '\n\nhttps://joaovbs96.github.io/MaterialXPlayground/',
                            icon: iconPath,
                        };
                        if (win) dialog.showMessageBox(win, options);
                        else dialog.showMessageBox(options);
                    },
                },
            ],
        },
    ];
}

function rebuildMenu() {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

// Task icons ship outside app.asar (see electron/package.json's
// extraResources): Windows cannot read an icon file that lives inside
// the asar archive. Packaged runs resolve them next to the other
// extraResources under resourcesPath; unpackaged (electron:dev, no asar
// at all) runs resolve the same committed files straight out of
// electron/build/task-icons instead.
function getTaskIconsDir() {
    return app.isPackaged ? path.join(process.resourcesPath, 'task-icons') : path.join(__dirname, '..', 'build', 'task-icons');
}

// Same asar restriction as getTaskIconsDir: an icon file packed inside
// app.asar cannot be read as a real file, so electron/package.json ships
// these outside it too (extraResources) and this resolves the same pair.
function runtimeIconPath() {
    if (process.platform === 'darwin') return undefined;
    const file = process.platform === 'linux' ? 'icon.png' : 'icon.ico';
    return app.isPackaged ? path.join(process.resourcesPath, file) : path.join(__dirname, '..', 'build', file);
}

const JUMP_LIST_TASKS = [
    { route: 'docs', title: 'Node Specs', description: 'Open the Node Specs reference', icon: 'docs.ico' },
    { route: 'viewer', title: 'Viewer', description: 'Open the Viewer', icon: 'viewer.ico' },
    { route: 'compare', title: 'Compare', description: 'Open the Compare tool', icon: 'compare.ico' },
    { route: 'graph', title: 'Graph Editor', description: 'Open the Graph Editor', icon: 'graph.ico' },
];

// Windows' built-in { type: 'recent' } category was showing up empty:
// it depends on this app being registered as a file-type handler AND on
// Windows' own per-AppUserModelID recent-documents bookkeeping, and it
// clearly was not populating from app.addRecentDocument alone here. A
// custom category built from our own persisted recentFiles replaces it.
const RECENT_JUMP_LIST_LIMIT = 5;

// Most recent app.setJumpList() outcome, surfaced through mtlx-get-settings
// so the settings dialog can tell the user when Windows is blocking it.
// 'ok': succeeded. 'blocked': Windows denied it (customCategoryAccessDeniedError
// or missingFileTypeRegistration), almost always Start_TrackDocs being off.
// 'error': anything else unexpected.
let jumpListStatus = 'ok';

function classifyJumpListResult(result) {
    if (!result || result === 'ok') return 'ok';
    if (result === 'customCategoryAccessDeniedError' || result === 'missingFileTypeRegistration') return 'blocked';
    return 'error';
}

// Windows-only: a custom recent-documents category built from our own
// recentFiles, plus a tasks category for the four main tools, each
// opening (or re-routing) a window via --mtlx-route.
function buildJumpList() {
    if (process.platform !== 'win32') return;
    const iconsDir = getTaskIconsDir();
    const tasks = JUMP_LIST_TASKS.map((t) => ({
        type: 'task',
        program: process.execPath,
        args: '--mtlx-route=' + t.route,
        title: t.title,
        description: t.description,
        iconPath: path.join(iconsDir, t.icon),
        iconIndex: 0,
    }));
    const tasksCategory = { type: 'tasks', name: 'Tools', items: tasks };

    // 'task' items (not 'file'): a 'file' item needs the same file-type
    // registration the built-in category needed and can fail with
    // missingFileTypeRegistration/customCategoryAccessDeniedError. A task
    // just relaunches the exe with the path as an argument, reusing the
    // argv handling getMtlxArg already provides.
    // showRecentInSystem off: the recents category is omitted entirely,
    // not just left empty. Our own recentFiles list is untouched.
    const recentItems = showRecentInSystem
        ? recentFiles.slice(0, RECENT_JUMP_LIST_LIMIT).map((filePath) => ({
            type: 'task',
            program: process.execPath,
            args: '"' + filePath + '"',
            title: path.basename(filePath),
            description: filePath,
            iconPath: process.execPath,
            iconIndex: 0,
        }))
        : [];
    // Omitted entirely (not an empty category) when there are no recents.
    const categories = recentItems.length > 0
        ? [{ type: 'custom', name: 'Recent Documents', items: recentItems }, tasksCategory]
        : [tasksCategory];

    try {
        // setJumpList can return an error string instead of throwing;
        // either way this must never take startup down with it.
        const result = app.setJumpList(categories);
        jumpListStatus = classifyJumpListResult(result);
        if (result && result !== 'ok') {
            console.error('[main] setJumpList failed: ' + result);
            if (recentItems.length > 0) {
                // A custom category can fail in ways the built-in one does
                // not; fall back to it so the user is not left with less
                // than before this change.
                const fallback = app.setJumpList([{ type: 'recent' }, tasksCategory]);
                if (fallback && fallback !== 'ok') {
                    console.error('[main] setJumpList fallback failed: ' + fallback);
                }
            }
        }
    } catch (e) {
        jumpListStatus = 'error';
        console.error('[main] setJumpList threw: ' + errMsg(e));
    }
}

// Updated by every window's own 'focus'/'closed' handlers (see
// createWindow below); the single-window routing target for openMtlxRouted.
let lastFocusedWindow = null;

// The existing window an openInNewWindow:false open should land in: the
// most recently focused still-open window, else the first remaining one,
// else null (nothing open yet).
function getRoutingTargetWindow() {
    const wins = BrowserWindow.getAllWindows();
    if (wins.length === 0) return null;
    if (lastFocusedWindow && wins.includes(lastFocusedWindow)) return lastFocusedWindow;
    return wins[0];
}

// OS-driven opens (file association, second launch) funnel through here:
// a new window when the preference says so, otherwise the routing target
// above, focused either way so the user sees where the file landed.
function openMtlxRouted(filePath) {
    if (openInNewWindow) {
        openMtlxFromDisk(filePath, createWindow(documentOpenView), false);
        return;
    }
    let target = getRoutingTargetWindow();
    // main rebinds currentPath before the page confirms, so a dirty
    // target must never be reused; open a fresh window instead.
    if (!target || getWindowState(target).dirty) {
        openMtlxFromDisk(filePath, createWindow(documentOpenView), false);
        return;
    }
    if (target.isMinimized()) target.restore();
    target.focus();
    openMtlxFromDisk(filePath, target, false);
}

// Same as openMtlxRouted, but for a launch that carries BOTH a file and a
// --mtlx-route (our cascading context-menu submenu entries): the window
// lands on the requested route instead of losing it to the file argument.
// A new window opens straight onto that route; a reused window is
// hash-routed there first so the document lands in the view the user
// actually asked for, not whatever the window already had loaded.
function openMtlxRoutedTo(filePath, route) {
    if (!route) {
        openMtlxRouted(filePath);
        return;
    }
    if (openInNewWindow) {
        openMtlxFromDisk(filePath, createWindow(route), false);
        return;
    }
    const target = getRoutingTargetWindow();
    // main rebinds currentPath before the page confirms, so a dirty
    // target must never be reused; open a fresh window instead.
    if (!target || getWindowState(target).dirty) {
        openMtlxFromDisk(filePath, createWindow(route), false);
        return;
    }
    if (target.isMinimized()) target.restore();
    target.focus();
    setWindowRoute(target, route);
    openMtlxFromDisk(filePath, target, false);
}

// Changes an already-open window's tool without reloading the page (a
// plain loadURL would reload the whole app and lose state): the site's
// shell already listens for hashchange, so just set the hash in-page.
function setWindowRoute(win, route) {
    const hash = ROUTE_HASHES[route] || ROUTE_HASHES[DEFAULT_ROUTE];
    win.webContents.executeJavaScript('location.hash = ' + JSON.stringify(hash) + ';').catch((e) => {
        console.error('[main] failed to set route "' + route + '": ' + errMsg(e));
    });
}

// Jump list task clicks (and any other route-only launch) funnel through
// here: honors the same Open Files in New Window preference as
// openMtlxRouted, switching the existing window's tool in-page instead of
// reloading when the preference is off. Focused/restored either way.
function openRouteRouted(route) {
    if (openInNewWindow) {
        createWindow(route);
        return;
    }
    const target = getRoutingTargetWindow();
    if (!target) {
        createWindow(route);
        return;
    }
    if (target.isMinimized()) target.restore();
    target.focus();
    setWindowRoute(target, route);
}

// Window Controls Overlay theming: matches .mtlx-header's rgba(17,24,39,.95)
// blended over the same #111827 page background, and the gray-200 icon
// color from js/site-tokens.css; height matches --site-header-height.
const TITLEBAR_OVERLAY_COLOR = '#111827';
const TITLEBAR_OVERLAY_SYMBOL_COLOR = '#e5e7eb';
const TITLEBAR_OVERLAY_HEIGHT = 56;
// macOS traffic lights: x is the cluster's left edge. Kept in sync with
// the --mtlx-traffic-light-gutter reserve in js/site-header.css; change
// both or the header brand slides under the buttons.
const TRAFFIC_LIGHT_INSET_X = 20;

// Grace period before an unresponsive window gets a "not responding"
// prompt: shader compilation can legitimately freeze the renderer for
// several seconds, and that must not look like a real hang.
const UNRESPONSIVE_GRACE_MS = 20000;

// Caps repeated did-fail-load Retry clicks (a persistently broken load
// should stop offering a retry that will never succeed).
const DID_FAIL_LOAD_MAX_RETRIES = 3;

// Bounds persistence (windowBounds above): initialBounds() decides where
// the next createWindow() lands; armBoundsSave/persistWindowBounds below
// keep the persisted value current from resize/move/close.
const DEFAULT_WINDOW_WIDTH = 1440;
const DEFAULT_WINDOW_HEIGHT = 900;
const WINDOW_MIN_WIDTH = 1000;
const WINDOW_MIN_HEIGHT = 640;
// A saved rect must overlap its matching display's work area by at least
// this many pixels in both dimensions to be trusted; anything smaller
// reads as "mostly off-screen" (unplugged monitor, changed arrangement).
const BOUNDS_OVERLAP_MIN = 100;
const BOUNDS_SAVE_DEBOUNCE_MS = 500;

function rectOverlapSize(a, b) {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return { width: Math.max(0, width), height: Math.max(0, height) };
}

// Clamps rect into workArea (never bigger than it, never off its edges)
// and enforces the same minimum size createWindow itself enforces.
function clampRectToWorkArea(rect, workArea) {
    const width = Math.min(Math.max(rect.width, WINDOW_MIN_WIDTH), workArea.width);
    const height = Math.min(Math.max(rect.height, WINDOW_MIN_HEIGHT), workArea.height);
    const x = Math.min(Math.max(rect.x, workArea.x), workArea.x + workArea.width - width);
    const y = Math.min(Math.max(rect.y, workArea.y), workArea.y + workArea.height - height);
    return { x, y, width, height };
}

// Where the next createWindow() should land: a second-or-later window
// cascades from the last focused one instead of reusing the saved spot;
// only the first window of a launch considers the saved bounds at all.
function initialBounds() {
    const others = BrowserWindow.getAllWindows();
    if (others.length > 0) {
        const source = (lastFocusedWindow && others.includes(lastFocusedWindow)) ? lastFocusedWindow : others[0];
        const base = source.getNormalBounds();
        const display = screen.getDisplayMatching(base);
        const offset = clampRectToWorkArea(
            { x: base.x + 32, y: base.y + 32, width: base.width, height: base.height },
            display.workArea
        );
        return { x: offset.x, y: offset.y, width: offset.width, height: offset.height, maximized: false };
    }

    if (windowBounds && [windowBounds.x, windowBounds.y, windowBounds.width, windowBounds.height].every(Number.isFinite)) {
        const saved = { x: windowBounds.x, y: windowBounds.y, width: windowBounds.width, height: windowBounds.height };
        const display = screen.getDisplayMatching(saved);
        const overlap = rectOverlapSize(saved, display.workArea);
        if (overlap.width >= BOUNDS_OVERLAP_MIN && overlap.height >= BOUNDS_OVERLAP_MIN) {
            const clamped = clampRectToWorkArea(saved, display.workArea);
            return { ...clamped, maximized: !!windowBounds.maximized };
        }
    }

    // No usable saved rect: Electron centers on the primary display when
    // x/y are omitted entirely, which is preferable to guessing one.
    return { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT, maximized: false };
}

// Only the last focused (or the sole remaining) window's bounds are worth
// persisting; a background window's geometry is not what a relaunch
// should restore.
function shouldPersistBoundsFor(win) {
    const wins = BrowserWindow.getAllWindows();
    return wins.length === 1 || win === lastFocusedWindow;
}

// On close the window-count rule above is unreliable (windows are
// mid-teardown during a multi-window quit), so persist only for the
// last focused window, or when there is no other reliable focus target.
function shouldPersistBoundsOnClose(win) {
    return win === lastFocusedWindow || !lastFocusedWindow || lastFocusedWindow.isDestroyed();
}

// getNormalBounds (not getBounds) so a maximized window's RESTORED size
// is what gets saved, per electron.d.ts:2846's own doc comment.
function persistWindowBounds(win, shouldPersist) {
    if (!win || win.isDestroyed() || !shouldPersist(win)) return;
    const normal = win.getNormalBounds();
    windowBounds = { x: normal.x, y: normal.y, width: normal.width, height: normal.height, maximized: win.isMaximized() };
    saveSettings();
}

// Debounce timer lives on the window's own state so one window's resize
// spam never clobbers another's pending save.
function armBoundsSave(win) {
    const state = getWindowState(win);
    if (state.boundsSaveTimer) clearTimeout(state.boundsSaveTimer);
    state.boundsSaveTimer = setTimeout(() => {
        state.boundsSaveTimer = null;
        persistWindowBounds(win, shouldPersistBoundsFor);
    }, BOUNDS_SAVE_DEBOUNCE_MS);
}

function createWindow(route) {
    const bounds = initialBounds();
    const win = new BrowserWindow({
        width: bounds.width,
        height: bounds.height,
        ...(Number.isFinite(bounds.x) && Number.isFinite(bounds.y) ? { x: bounds.x, y: bounds.y } : {}),
        minWidth: WINDOW_MIN_WIDTH,
        minHeight: WINDOW_MIN_HEIGHT,
        backgroundColor: '#0b0f19',
        show: false,
        icon: runtimeIconPath(),
        // Hides the native title bar behind the site header, which becomes
        // the draggable bar (see js/site-header.js/.css); autoHideMenuBar
        // only hides the menu strip visually (Alt reveals it) and does not
        // unregister the application menu, so accelerators keep working.
        titleBarStyle: 'hidden',
        // Windows/Linux only: macOS ignores titleBarOverlay outright and
        // keeps its own traffic lights, so it is gated rather than left to
        // be silently dropped. On darwin the lights are positioned instead
        // (below), and js/site-header.css reserves the LEFT inset they need
        // -- the env(titlebar-area-*) padding that covers the overlay
        // buttons elsewhere resolves to zero here, since those vars only
        // exist when an overlay is active.
        ...(IS_MAC
            ? {
                trafficLightPosition: {
                    x: TRAFFIC_LIGHT_INSET_X,
                    // Centres the ~16px cluster in the header strip.
                    y: Math.round((TITLEBAR_OVERLAY_HEIGHT - 16) / 2),
                },
            }
            : {
                titleBarOverlay: {
                    color: TITLEBAR_OVERLAY_COLOR,
                    symbolColor: TITLEBAR_OVERLAY_SYMBOL_COLOR,
                    height: TITLEBAR_OVERLAY_HEIGHT,
                },
            }),
        autoHideMenuBar: true,
        webPreferences: {
            contextIsolation: true,
            // Sandboxed preloads only get a curated Node module subset
            // (no fs/path); preload.js needs real fs to read glue.js off
            // disk. contextIsolation (above) still walls off the page.
            sandbox: false,
            preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        },
    });

    // Always wired, even for a window that never opens a file: its
    // 'closed' cleanup (watcher teardown, map entry removal) must be in
    // place from the start.
    getWindowState(win);

    // Tracks the single-window routing target (openMtlxRouted below):
    // the most recently focused window, cleared again once it closes.
    win.on('focus', () => { lastFocusedWindow = win; });
    win.on('closed', () => {
        if (lastFocusedWindow === win) lastFocusedWindow = null;
    });

    // Bounds persistence (windowBounds): debounced on resize/move, and
    // immediate (any pending debounce dropped first) on close so the
    // last gesture before quitting is never lost to the timer.
    win.on('resize', () => armBoundsSave(win));
    win.on('move', () => armBoundsSave(win));
    win.on('close', () => {
        const state = getWindowState(win);
        if (state.boundsSaveTimer) { clearTimeout(state.boundsSaveTimer); state.boundsSaveTimer = null; }
        persistWindowBounds(win, shouldPersistBoundsOnClose);
    });

    // state.dirty (kept live by mtlx-notify-edit) gates this synchronously;
    // Electron otherwise silently blocks close when the page's own
    // beforeunload handler prevents unload, with no dialog at all.
    win.on('close', (event) => {
        const state = getWindowState(win);
        if (state.forceClose || !state.dirty) return;
        event.preventDefault();
        // This close attempt is being deferred to a confirmation dialog,
        // not guaranteed to happen; abandon any relaunch riding on it.
        relaunchPending = false;
        pendingSafeMode = false;
        requestCloseConfirmation(win).catch((e) => {
            console.error('[main] close confirmation failed: ' + errMsg(e));
        });
    });

    // The re-issued win.close() below re-runs the page's OWN beforeunload
    // handler, which still asks to cancel; forceClose overrides that too,
    // so the confirmed close is not blocked a second time.
    win.webContents.on('will-prevent-unload', (event) => {
        if (getWindowState(win).forceClose) event.preventDefault();
    });

    // Reloads this window from wherever it was: the same document, freshly
    // re-read from disk. Safe to call right after loadURL: openMtlxFromDisk
    // already defers its send until the new page's did-finish-load.
    function reloadCrashedWindow() {
        const state = getWindowState(win);
        const url = win.webContents.getURL();
        state.dirty = false;
        win.loadURL(url || urlForRoute(documentOpenView));
        if (state.currentPath) openMtlxFromDisk(state.currentPath, win, false);
    }

    // The renderer (not the whole app) crashed: offer to reload the
    // document or close the window. selfInflictedCrash skips this for
    // the hang prompt's own forcefullyCrashRenderer() call below.
    win.webContents.on('render-process-gone', (event, details) => {
        const state = getWindowState(win);
        if (state.selfInflictedCrash) { state.selfInflictedCrash = false; return; }
        if (details.reason === 'clean-exit' || state.forceClose) return;
        // A pending styled close-confirm round trip already has its own
        // render-process-gone listener that falls back to the native
        // dialog; do not also show this generic crash dialog for it.
        if (state.closeConfirmToken !== null) return;
        dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Reload', 'Close Window'],
            defaultId: 0,
            title: 'MaterialX Playground',
            message: "This window's page crashed (" + details.reason + ').',
            detail: 'Reload restores the document from disk. Unsaved graph edits are offered from the autosave.',
        }).then((result) => {
            if (result.response === 0) {
                reloadCrashedWindow();
            } else {
                state.forceClose = true;
                win.close();
            }
        });
    });

    // 'unresponsive' arms the grace timer (see UNRESPONSIVE_GRACE_MS
    // above); 'responsive' cancels it, or withdraws the prompt below
    // via the AbortSignal if the timer already fired.
    win.on('unresponsive', () => {
        const state = getWindowState(win);
        if (state.hangTimer) return;
        state.hangTimer = setTimeout(() => {
            state.hangTimer = null;
            if (state.hangPromptOpen) return;
            state.hangPromptOpen = true;
            const controller = new AbortController();
            state.hangAbortController = controller;
            dialog.showMessageBox(win, {
                type: 'warning',
                message: 'The page is not responding.',
                detail: 'Shader compilation can take a while. Wait unless it stays frozen.',
                buttons: ['Wait', 'Force Reload', 'Close Window'],
                defaultId: 0,
                cancelId: 0,
                signal: controller.signal,
            }).then((result) => {
                state.hangPromptOpen = false;
                state.hangAbortController = null;
                if (result.response === 1) {
                    state.selfInflictedCrash = true;
                    win.webContents.forcefullyCrashRenderer();
                    reloadCrashedWindow();
                } else if (result.response === 2) {
                    state.forceClose = true;
                    win.close();
                }
            });
        }, UNRESPONSIVE_GRACE_MS);
    });
    win.on('responsive', () => {
        const state = getWindowState(win);
        if (state.hangTimer) {
            clearTimeout(state.hangTimer);
            state.hangTimer = null;
        }
        if (state.hangAbortController) {
            state.hangAbortController.abort();
            state.hangAbortController = null;
        }
    });

    // Only a real main-frame failure matters; -3 is Chromium's ABORTED,
    // routinely fired by in-page navigations and not an actual failure.
    win.webContents.on('did-finish-load', () => {
        getWindowState(win).failLoadRetries = 0;
    });
    win.webContents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
        if (!isMainFrame || code === -3) return;
        const state = getWindowState(win);
        const canRetry = state.failLoadRetries < DID_FAIL_LOAD_MAX_RETRIES;
        dialog.showMessageBox(win, {
            type: 'warning',
            buttons: canRetry ? ['Retry', 'Close Window'] : ['Close Window'],
            defaultId: 0,
            title: 'MaterialX Playground',
            message: 'The app page failed to load (' + description + ').',
        }).then((result) => {
            if (canRetry && result.response === 0) {
                state.failLoadRetries++;
                win.loadURL(url || urlForRoute(documentOpenView));
            } else {
                state.forceClose = true;
                win.close();
            }
        });
    });

    win.once('ready-to-show', () => {
        if (bounds.maximized) win.maximize();
        win.show();
    });

    // Only http(s) targets go to the OS browser; app:// popups (e.g. a
    // site-relative license link opened with target=_blank) get a normal
    // child window with the same safe webPreferences.
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) {
            shell.openExternal(url);
            return { action: 'deny' };
        }
        if (url.startsWith(APP_SCHEME + '://')) {
            return { action: 'allow' };
        }
        return { action: 'deny' };
    });

    win.webContents.on('will-navigate', (event, url) => {
        if (url.startsWith(APP_SCHEME + '://')) return;
        event.preventDefault();
        if (/^https?:/i.test(url)) shell.openExternal(url);
    });

    // Once a file is open, its file-derived title (updateWindowTitle) is
    // the source of truth; block the site's own document.title writes.
    win.webContents.on('page-title-updated', (event) => {
        if (getWindowState(win).currentPath) event.preventDefault();
    });

    win.loadURL(urlForRoute(route));

    if (safeModeActive) {
        win.webContents.once('did-finish-load', () => {
            sendNotice(win, {
                kind: 'safe-mode',
                level: 'info',
                text: 'Safe mode: hardware acceleration is off, rendering is slower. Turn it off in Settings.',
            });
        });
    }

    if (process.env.MTLX_SMOKE === '1') {
        const smokeDeadline = setTimeout(() => {
            console.log('[smoke] FAIL timeout after ' + SMOKE_DEADLINE_MS + ' ms');
            app.exit(1);
        }, SMOKE_DEADLINE_MS);
        win.webContents.once('did-finish-load', async () => {
            const currentUrl = win.webContents.getURL();
            const title = win.webContents.getTitle();
            const appMenu = Menu.getApplicationMenu();
            const fileMenu = appMenu && appMenu.items.find((item) => item.label === 'File');
            const hasSave = fileMenu && fileMenu.submenu.items.some((item) => item.label === 'Save');
            const menuOk = !!(appMenu && fileMenu && hasSave);

            // Window Controls Overlay: the header bar must carry the
            // desktop-titlebar marker class and actually be a drag region,
            // or the whole overlay affordance is dead.
            let titlebarOk = false;
            try {
                titlebarOk = await win.webContents.executeJavaScript(
                    '(function () {' +
                    '  var bar = document.getElementById("mtlx-header-bar");' +
                    '  if (!bar) return false;' +
                    '  if (!bar.classList.contains("mtlx-desktop-titlebar")) return false;' +
                    '  var region = getComputedStyle(bar).getPropertyValue("app-region") || ' +
                    '    getComputedStyle(bar).getPropertyValue("-webkit-app-region");' +
                    '  return region.trim() === "drag";' +
                    '})()'
                );
            } catch (e) {
                titlebarOk = false;
            }

            // Offline enforcement: issue a probe request to an external host
            // via net.request (the page's own CSP would otherwise block a
            // fetch() before it ever reaches webRequest, which would test
            // the CSP instead of the hard blocker) and confirm it is both
            // refused AND that our blocker (via the counter it bumps) is
            // what refused it, not some unrelated network error.
            const blockedBefore = blockedRequestCount;
            let probeRefused = false;
            try {
                const { net } = require('electron');
                await new Promise((resolve) => {
                    const req = net.request({ url: 'https://example.com/mtlx-smoke-probe', session: session.defaultSession });
                    req.on('error', () => { probeRefused = true; resolve(); });
                    req.on('response', () => resolve());
                    req.end();
                });
            } catch (e) {
                probeRefused = true;
            }
            const blockerOk = probeRefused && blockedRequestCount > blockedBefore;

            // The empty write's callback only fires once the console.log
            // above has actually flushed, same race/fix as finishSmoke.
            if (currentUrl.startsWith(APP_SCHEME + '://' + APP_HOST + '/') && title && menuOk && titlebarOk && blockerOk) {
                console.log('[smoke] OK ' + title);
                clearTimeout(smokeDeadline);
                process.stdout.write('', () => app.quit());
            } else {
                console.log('[smoke] FAIL bad url, empty title, missing menu, bad titlebar, or blocker not enforced: ' + currentUrl);
                clearTimeout(smokeDeadline);
                process.stdout.write('', () => app.exit(1));
            }
        });
        win.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
            console.log('[smoke] FAIL ' + errorCode + ' ' + errorDescription);
            clearTimeout(smokeDeadline);
            process.stdout.write('', () => app.exit(1));
        });
    }

    return win;
}

// A second launch (double-clicking another .mtlx, or a second app start)
// hands its argv to the FIRST instance via 'second-instance' below and
// exits here instead of opening its own protocol handler/window.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    // Set by 'open-file' when macOS launches us with a file before
    // app.whenReady() has resolved; consumed once, inside whenReady below.
    let pendingOpenFilePath = null;

    app.on('second-instance', (event, argv) => {
        const filePath = getMtlxArg(argv);
        const route = getRouteArg(argv);
        if (filePath) {
            openMtlxRoutedTo(filePath, route);
            return;
        }
        if (route) {
            openRouteRouted(route);
            return;
        }
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow('home');
        } else {
            const win = BrowserWindow.getAllWindows()[0];
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });

    // macOS "Open With" / dock-drop launch path; must be registered
    // before whenReady to catch a launch-time open per Electron's docs.
    app.on('open-file', (event, filePath) => {
        event.preventDefault();
        if (!app.isReady()) {
            pendingOpenFilePath = path.resolve(filePath);
            return;
        }
        openMtlxRouted(path.resolve(filePath));
    });

    // GPU-process crash notices, plus a safe-mode offer after repeated
    // crashes. Never force a reload: Chromium restarts the GPU process
    // on its own and the site already handles lost/restored contexts.
    let gpuCrashTimestamps = [];
    let gpuCrashPromptOpen = false;
    let gpuPromptCooldownUntil = 0;
    const GPU_CRASH_WINDOW_MS = 60000;
    const GPU_CRASH_THRESHOLD = 3;
    const GPU_PROMPT_COOLDOWN_MS = 5 * 60000;
    app.on('child-process-gone', async (event, details) => {
        if (details.type !== 'GPU' || details.reason === 'clean-exit') return;
        const now = Date.now();
        gpuCrashTimestamps = gpuCrashTimestamps.filter((t) => now - t < GPU_CRASH_WINDOW_MS);
        gpuCrashTimestamps.push(now);

        broadcastNotice({
            kind: 'gpu-restart',
            level: 'warn',
            text: 'The graphics process restarted (' + details.reason + '). If a view stays blank, use View > Reload.',
        });

        if (gpuCrashTimestamps.length < GPU_CRASH_THRESHOLD || safeModeActive || gpuCrashPromptOpen || now < gpuPromptCooldownUntil) return;
        gpuCrashPromptOpen = true;
        const win = BrowserWindow.getFocusedWindow();
        const options = {
            type: 'warning',
            buttons: ['Relaunch in Safe Mode', 'Not Now'],
            defaultId: 0,
            cancelId: 1,
            title: 'MaterialX Playground',
            message: 'The graphics process keeps crashing. Relaunch in safe mode (software rendering)?',
        };
        const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
        gpuCrashPromptOpen = false;
        // Reset the crash tally and hold off on prompting again for a
        // while either way, so an unstable GPU cannot re-prompt on a loop.
        gpuCrashTimestamps = [];
        gpuPromptCooldownUntil = Date.now() + GPU_PROMPT_COOLDOWN_MS;
        if (result.response === 0) {
            // The GPU prompt path must not persist safeMode before the
            // quit actually proceeds; relaunchApp defers that to will-quit.
            relaunchApp({ safeMode: true });
        }
    });

    app.whenReady().then(() => {
        protocol.handle(APP_SCHEME, handleAppRequest);

        // Every export/download shows a native save dialog with the
        // suggested filename, instead of silently landing in Downloads.
        session.defaultSession.on('will-download', (event, item) => {
            item.setSaveDialogOptions({
                defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
            });
        });

        // Hard offline enforcement: cancel every request whose scheme is
        // not one this app itself serves or generates in-page. This does
        // not touch shell.openExternal (the OS browser fetches those URLs,
        // never through this session) and does not touch DevTools (its
        // devtools: scheme is allow-listed below).
        const ALLOWED_REQUEST_SCHEMES = [APP_SCHEME + ':', 'devtools:', 'blob:', 'data:'];
        session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
            const allowed = ALLOWED_REQUEST_SCHEMES.some((scheme) => details.url.startsWith(scheme));
            if (!allowed) {
                blockedRequestCount++;
                console.error('[main] blocked non-local request: ' + details.url);
                callback({ cancel: true });
                return;
            }
            callback({ cancel: false });
        });

        recentFiles = loadRecents();
        const settings = loadSettings();
        openInNewWindow = settings.openInNewWindow !== false;
        showRecentInSystem = settings.showRecentInSystem !== false;
        documentOpenView = settings.documentOpenView === 'viewer' ? 'viewer' : 'graph';
        safeMode = settings.safeMode === true;
        windowBounds = settings.windowBounds && typeof settings.windowBounds === 'object' ? settings.windowBounds : null;
        rebuildMenu();

        // Must match electron/package.json's build.appId exactly: Windows
        // keys a jump list to the AppUserModelID, which electron-builder
        // stamps onto the installed shortcut from this same appId.
        // Without this call the jump list silently does not appear at
        // all, with no error anywhere.
        app.setAppUserModelId('com.joaovbs96.materialxplayground');
        buildJumpList();

        if (process.env.MTLX_SMOKE_OPEN) {
            runSmokeOpen(path.resolve(process.env.MTLX_SMOKE_OPEN));
            return;
        }

        const argFile = pendingOpenFilePath || getMtlxArg(process.argv);
        const argRoute = getRouteArg(process.argv);
        pendingOpenFilePath = null;
        // Always honor an explicit route: it must not be dropped just
        // because a file argument is also present (see openMtlxRoutedTo
        // above). With no route: a file open lands in documentOpenView,
        // and a bare launch lands on Home (the renderer itself hops to
        // the graph editor if a crash-recovery draft is waiting).
        const launchRoute = argRoute || (argFile ? documentOpenView : 'home');
        const win = createWindow(launchRoute);
        if (argFile) openMtlxFromDisk(argFile, win, false);

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow('home');
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}
