// main.js: Electron main process, serving the unmodified site over a
// pinned app:// origin (file:// cannot do this: see
// docs/local/ELECTRON.md for why).
'use strict';

const { app, BrowserWindow, protocol, session, shell, ipcMain, dialog } = require('electron');
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
        state = { currentPath: null, dirty: false, watcher: null, editDepth: 0 };
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
                openMtlxFromDisk(filePath, win);
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

// Asks a window's renderer to hand back its current graph XML, for a
// future native Save menu item (phase 5); nothing calls this yet.
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

// Reads filePath, scans it for xi:include/texture refs, and sends the
// result to win as 'mtlx-open-file'; used for the initial launch-time
// open, file association re-opens, and the disk watcher's re-ingest.
async function openMtlxFromDisk(filePath, win) {
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
    startWatcher(win, filePath);
    updateWindowTitle(win);

    const payload = { name, xml, files };
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

        await openMtlxFromDisk(filePath, win);

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

function createWindow() {
    const win = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1000,
        minHeight: 640,
        backgroundColor: '#0b0f19',
        show: false,
        icon: process.platform === 'darwin' ? undefined : path.join(__dirname, '..', 'build', 'icon.ico'),
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
        win.webContents.once('did-finish-load', () => {
            const currentUrl = win.webContents.getURL();
            const title = win.webContents.getTitle();
            if (currentUrl.startsWith(APP_SCHEME + '://' + APP_HOST + '/') && title) {
                console.log('[smoke] OK ' + title);
                app.quit();
            } else {
                console.log('[smoke] FAIL bad url or empty title: ' + currentUrl);
                app.exit(1);
            }
        });
        win.webContents.once('did-fail-load', (event, errorCode, errorDescription) => {
            console.log('[smoke] FAIL ' + errorCode + ' ' + errorDescription);
            app.exit(1);
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
            const win = createWindow();
            openMtlxFromDisk(filePath, win);
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
        const win = BrowserWindow.getAllWindows()[0] || createWindow();
        openMtlxFromDisk(path.resolve(filePath), win);
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

        if (process.env.MTLX_SMOKE_OPEN) {
            runSmokeOpen(path.resolve(process.env.MTLX_SMOKE_OPEN));
            return;
        }

        const win = createWindow();
        const argFile = pendingOpenFilePath || getMtlxArg(process.argv);
        pendingOpenFilePath = null;
        if (argFile) openMtlxFromDisk(argFile, win);

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });
}
