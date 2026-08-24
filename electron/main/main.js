// main.js: Electron main process, serving the unmodified site over a
// pinned app:// origin (file:// cannot do this: see
// docs/local/ELECTRON.md for why).
'use strict';

const { app, BrowserWindow, protocol, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const APP_SCHEME = 'app';
// Pinned forever: this origin keys every user's localStorage/IndexedDB
// (autosave records, texture blobs, prefs). Never change the host string.
const APP_HOST = 'playground';
const START_URL = APP_SCHEME + '://' + APP_HOST + '/index.html';

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
            preload: path.join(__dirname, '..', 'preload', 'preload.js'),
        },
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

app.whenReady().then(() => {
    protocol.handle(APP_SCHEME, handleAppRequest);

    // Every export/download shows a native save dialog with the
    // suggested filename, instead of silently landing in Downloads.
    session.defaultSession.on('will-download', (event, item) => {
        item.setSaveDialogOptions({
            defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
        });
    });

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
