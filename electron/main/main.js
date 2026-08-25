// main.js: Electron main process, serving the unmodified site over a
// pinned app:// origin (file:// cannot do this: see
// docs/local/ELECTRON.md for why).
'use strict';

const { app, BrowserWindow, protocol, session, shell, ipcMain, dialog, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const docScanner = require('./doc-scanner');

function errMsg(e) {
    return e && e.message ? e.message : String(e);
}

const APP_SCHEME = 'app';
// Pinned forever: this origin keys every user's localStorage/IndexedDB
// (autosave records, texture blobs, prefs). Never change the host string.
const APP_HOST = 'playground';
// #!graph: same default view as the VS Code extension. Without a route
// hash the site lands on its marketing home page instead, where neither
// view (nor __mtlxGetGraphXml/onOpenFile's consumers) is ever mounted.
const START_URL = APP_SCHEME + '://' + APP_HOST + '/index.html#!graph';
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
        state = { currentPath: null, dirty: false, watcher: null, editDepth: 0, forceClose: false, closeConfirmToken: null };
        windowStates.set(win, state);
        win.on('closed', () => {
            if (state.watcher) state.watcher.close();
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
    app.addRecentDocument(target);
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
// through this instead of the unreachable native menu checkbox.
ipcMain.handle('mtlx-get-settings', () => ({ openInNewWindow }));

// Renderer-side About dialog (js/shell.jsx's DesktopAboutDialog) reads
// these instead of the unreachable native menu's About item.
ipcMain.handle('mtlx-get-about', () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
}));

// Reuses setOpenInNewWindow so persistence and the native checkbox's
// rebuildMenu() stay in sync with whatever the dialog set.
ipcMain.on('mtlx-set-open-in-new-window', (event, value) => setOpenInNewWindow(value));

// Asks a window's renderer to hand back its current graph XML; used by
// saveFromMenu (the native Save/Save As menu items) below.
function requestSaveFromRenderer(win) {
    return new Promise((resolve, reject) => {
        const listener = (event, result) => {
            if (BrowserWindow.fromWebContents(event.sender) !== win) return;
            ipcMain.removeListener('mtlx-request-save-reply', listener);
            if (result && result.error) reject(new Error(result.error));
            else resolve(result && result.xml);
        };
        ipcMain.on('mtlx-request-save-reply', listener);
        win.webContents.send('mtlx-request-save');
    });
}

// Bounds the Save and Close renderer round trip below so a hung/broken
// graph-view contract can't leave the close prompt stuck forever.
const SAVE_ON_CLOSE_TIMEOUT_MS = 8000;

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('timed out')), ms)),
    ]);
}

// Shown in place of Electron's default silent close-block (its reaction to
// a beforeunload preventDefault with no 'close' listener). forceClose lets
// the re-issued win.close() below skip straight past the guard.
async function confirmCloseWindow(win) {
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

    if (choice.response === 2) return; // Cancel: leave the window open.

    if (choice.response === 1) { // Discard
        state.forceClose = true;
        win.close();
        return;
    }

    // The renderer round trip can hang or throw if the graph-view contract
    // ever drifts; timeout/catch degrades to a discard-or-cancel prompt
    // instead of leaving the window stuck mid-close.
    let xml;
    try {
        xml = await withTimeout(requestSaveFromRenderer(win), SAVE_ON_CLOSE_TIMEOUT_MS);
    } catch (e) {
        console.error('[main] save-before-close failed: ' + errMsg(e));
        const fallback = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Discard', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            title: 'MaterialX Playground',
            message: 'Could not save this document.',
            detail: 'Close it anyway and lose the unsaved changes?',
        });
        if (fallback.response === 0) {
            state.forceClose = true;
            win.close();
        }
        return;
    }

    const saveResult = await saveMtlxForWindow(win, { xml });
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
    const state = getWindowState(win);
    let xml;
    try {
        xml = await withTimeout(requestSaveFromRenderer(win), SAVE_ON_CLOSE_TIMEOUT_MS);
    } catch (e) {
        console.error('[main] save-before-close failed: ' + errMsg(e));
        const fallback = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Discard', 'Cancel'],
            defaultId: 1,
            cancelId: 1,
            title: 'MaterialX Playground',
            message: 'Could not save this document.',
            detail: 'Close it anyway and lose the unsaved changes?',
        });
        if (fallback.response === 0) {
            state.forceClose = true;
            win.close();
        }
        return;
    }

    const saveResult = await saveMtlxForWindow(win, { xml });
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
            win.close();
        } else if (choice === 'save') {
            await performStyledSaveAndClose(win);
        }
        // 'cancel' (or anything unexpected): leave the window open.
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

    const name = path.basename(filePath, path.extname(filePath));

    let scanned = { files: {}, warnings: [] };
    try {
        scanned = await docScanner.scan(filePath, xml);
    } catch (e) {
        console.error('[main] doc-scanner failed for "' + filePath + '": ' + errMsg(e));
    }
    scanned.warnings.forEach((w) => console.warn('[main] doc-scanner: ' + w));

    const files = {};
    for (const key of Object.keys(scanned.files)) {
        files[key] = Uint8Array.from(scanned.files[key]);
    }

    const state = getWindowState(win);
    state.currentPath = filePath;
    state.dirty = false;
    app.addRecentDocument(filePath);
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
        const win = createWindow();
        await new Promise((resolve, reject) => {
            win.webContents.once('did-finish-load', resolve);
            win.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
                reject(new Error(errorCode + ' ' + errorDescription));
            });
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
}

function clearRecents() {
    recentFiles = [];
    saveRecents(recentFiles);
    rebuildMenu();
}

// Sibling to mtlx-recents.json, same tolerant JSON-store pattern; holds
// menu-toggled preferences (currently just openInNewWindow).
function getSettingsPath() {
    return path.join(app.getPath('userData'), 'mtlx-settings.json');
}

// Current behavior: every OS-level open (file association, second launch)
// gets its own new window. false routes those into the existing window.
let openInNewWindow = true;

// Tolerant of a missing/corrupt file: any failure just means defaults,
// same as a fresh install.
function loadSettings() {
    try {
        const parsed = JSON.parse(fsSync.readFileSync(getSettingsPath(), 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
        return {};
    }
}

function saveSettings() {
    try {
        fsSync.writeFileSync(getSettingsPath(), JSON.stringify({ openInNewWindow }), 'utf8');
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
                return;
            }
            openMtlxFromDisk(filePath, win || createWindow(), false);
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
    const iconPath = process.platform === 'darwin' ? undefined : path.join(__dirname, '..', 'build', 'icon.ico');

    return [
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
                        openMtlxFromDisk(result.filePaths[0], win || createWindow(), false);
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
                { label: 'Close Window', role: 'close' },
                { label: 'Quit', role: 'quit' },
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
        {
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
        openMtlxFromDisk(filePath, createWindow(), false);
        return;
    }
    const target = getRoutingTargetWindow() || createWindow();
    if (target.isMinimized()) target.restore();
    target.focus();
    openMtlxFromDisk(filePath, target, false);
}

// Window Controls Overlay theming: matches .mtlx-header's rgba(17,24,39,.95)
// blended over the same #111827 page background, and the gray-200 icon
// color from js/site-tokens.css; height matches --site-header-height.
const TITLEBAR_OVERLAY_COLOR = '#111827';
const TITLEBAR_OVERLAY_SYMBOL_COLOR = '#e5e7eb';
const TITLEBAR_OVERLAY_HEIGHT = 56;

function createWindow() {
    const win = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1000,
        minHeight: 640,
        backgroundColor: '#0b0f19',
        show: false,
        icon: process.platform === 'darwin' ? undefined : path.join(__dirname, '..', 'build', 'icon.ico'),
        // Hides the native title bar behind the site header, which becomes
        // the draggable bar (see js/site-header.js/.css); autoHideMenuBar
        // only hides the menu strip visually (Alt reveals it) and does not
        // unregister the application menu, so accelerators keep working.
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: TITLEBAR_OVERLAY_COLOR,
            symbolColor: TITLEBAR_OVERLAY_SYMBOL_COLOR,
            height: TITLEBAR_OVERLAY_HEIGHT,
        },
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

    // state.dirty (kept live by mtlx-notify-edit) gates this synchronously;
    // Electron otherwise silently blocks close when the page's own
    // beforeunload handler prevents unload, with no dialog at all.
    win.on('close', (event) => {
        const state = getWindowState(win);
        if (state.forceClose || !state.dirty) return;
        event.preventDefault();
        requestCloseConfirmation(win);
    });

    // The re-issued win.close() below re-runs the page's OWN beforeunload
    // handler, which still asks to cancel; forceClose overrides that too,
    // so the confirmed close is not blocked a second time.
    win.webContents.on('will-prevent-unload', (event) => {
        if (getWindowState(win).forceClose) event.preventDefault();
    });

    win.once('ready-to-show', () => win.show());

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

    win.loadURL(START_URL);

    if (process.env.MTLX_SMOKE === '1') {
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

            // The empty write's callback only fires once the console.log
            // above has actually flushed, same race/fix as finishSmoke.
            if (currentUrl.startsWith(APP_SCHEME + '://' + APP_HOST + '/') && title && menuOk && titlebarOk) {
                console.log('[smoke] OK ' + title);
                process.stdout.write('', () => app.quit());
            } else {
                console.log('[smoke] FAIL bad url, empty title, missing menu, or bad titlebar: ' + currentUrl);
                process.stdout.write('', () => app.exit(1));
            }
        });
        win.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
            console.log('[smoke] FAIL ' + errorCode + ' ' + errorDescription);
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
        if (filePath) {
            openMtlxRouted(filePath);
        } else if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
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

    app.whenReady().then(() => {
        protocol.handle(APP_SCHEME, handleAppRequest);

        // Every export/download shows a native save dialog with the
        // suggested filename, instead of silently landing in Downloads.
        session.defaultSession.on('will-download', (event, item) => {
            item.setSaveDialogOptions({
                defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
            });
        });

        recentFiles = loadRecents();
        openInNewWindow = loadSettings().openInNewWindow !== false;
        rebuildMenu();

        if (process.env.MTLX_SMOKE_OPEN) {
            runSmokeOpen(path.resolve(process.env.MTLX_SMOKE_OPEN));
            return;
        }

        const win = createWindow();
        const argFile = pendingOpenFilePath || getMtlxArg(process.argv);
        pendingOpenFilePath = null;
        if (argFile) openMtlxFromDisk(argFile, win, false);

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}
