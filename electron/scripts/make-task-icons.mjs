#!/usr/bin/env node
// make-task-icons.mjs: one-time generator for the taskbar jump list task
// icons. Run this manually from electron/ with the electron BINARY itself
// (not plain node), with ELECTRON_RUN_AS_NODE unset:
//   node_modules/.bin/electron scripts/make-task-icons.mjs
// then commit its output (electron/build/task-icons/*.ico); re-run it if
// the glyphs ever change.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ELECTRON_DIR, 'build', 'task-icons');

// Rasterization needs a real Chromium to render SVG, so this script uses
// the electron devDependency itself (already required for the app) via an
// in-page canvas, instead of adding a new SVG rasterizer dep. Run this
// file with the electron.exe binary directly (see the npm script below),
// not with plain node: node's require('electron') only resolves to the
// binary path string and never boots the real app/BrowserWindow.
const require = createRequire(import.meta.url);
const electron = require('electron');

if (typeof electron === 'string') {
    console.error('[make-task-icons] run this with the electron binary, not node (see npm run icons:tasks)');
    process.exit(1);
}

const { app, BrowserWindow } = electron;
// No real GPU in every environment this may run in; software rendering
// still rasterizes flat vector glyphs fine and avoids a GPU-process crash.
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('in-process-gpu');
app.disableHardwareAcceleration();
const { Jimp, ResizeStrategy } = await import('jimp');
const pngToIco = (await import('png-to-ico')).default;

// Brand blue (--site-blue-400 in js/site-tokens.css), matched exactly so
// the taskbar tasks read as the same tool color as the site nav.
const BLUE = '#60a5fa';

// Tabler outline glyph inner paths, copied byte-for-byte from
// js/shared/ui-commons.js (MTLX_ICON_PATHS) / js/site-header.js's NAV
// icon constants, cross-checked against the NAV table (site-header.js
// ~line 199) so each tool gets the right glyph.
const TASKS = [
    {
        name: 'docs',
        title: 'Node Specs',
        filled: false,
        inner:
            '<path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" /><path d="M10 13l-1 2l1 2" /><path d="M14 13l1 2l-1 2" />',
    },
    {
        // Filled camera glyph (fill=currentColor, no stroke), unlike the
        // other three outline glyphs; matches ICON_NAV_VIEWER exactly.
        name: 'viewer',
        title: 'Viewer',
        filled: true,
        inner:
            '<path d="M15 3a2 2 0 0 1 1.995 1.85l.005 .15a1 1 0 0 0 .883 .993l.117 .007h1a3 3 0 0 1 2.995 2.824l.005 .176v9a3 3 0 0 1 -2.824 2.995l-.176 .005h-14a3 3 0 0 1 -2.995 -2.824l-.005 -.176v-9a3 3 0 0 1 2.824 -2.995l.176 -.005h1a1 1 0 0 0 1 -1a2 2 0 0 1 1.85 -1.995l.15 -.005h6zm-3 7a3 3 0 0 0 -2.985 2.698l-.011 .152l-.004 .15l.004 .15a3 3 0 1 0 2.996 -3.15z" />',
    },
    {
        name: 'compare',
        title: 'Compare',
        filled: false,
        inner:
            '<path d="M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2z" /><path d="M12 4l0 16" />',
    },
    {
        name: 'graph',
        title: 'Graph Editor',
        filled: false,
        inner:
            '<path d="M3 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" /><path d="M15 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" /><path d="M15 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" /><path d="M8.7 10.7l6.6 -3.4" /><path d="M8.7 13.3l6.6 3.4" />',
    },
];

const RENDER_SIZE = 256;
const ICO_SIZES = [48, 32, 24, 16];

function svgFor(task) {
    const attrs = task.filled
        ? 'fill="' + BLUE + '"'
        : 'fill="none" stroke="' + BLUE + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="' +
        RENDER_SIZE +
        '" height="' +
        RENDER_SIZE +
        '" ' +
        attrs +
        '>' +
        task.inner +
        '</svg>'
    );
}

// One BrowserWindow reused for every glyph (create/destroy per glyph was
// observed to crash the software-rendered GPU channel on the second
// window in this sandboxed environment); loadURL per glyph instead.
function openRenderWindow() {
    return new BrowserWindow({
        width: RENDER_SIZE,
        height: RENDER_SIZE,
        show: false,
        webPreferences: { offscreen: false },
    });
}

// Renders one SVG string to a transparent PNG buffer at RENDER_SIZE by
// rasterizing it into an in-page <canvas> and reading back toDataURL, not
// via win.webContents.capturePage(): capturePage on a transparent window
// under software rendering was observed to composite the window's own
// background instead of preserving alpha, yielding an opaque square.
// Canvas rasterization never touches window compositing, so it keeps
// alpha regardless of GPU/software rendering state.
async function renderSvgToPng(win, svg) {
    const svgDataUrl = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
    const html =
        '<!doctype html><html><head><style>html,body{margin:0;background:transparent;}</style></head>' +
        '<body><canvas id="c" width="' + RENDER_SIZE + '" height="' + RENDER_SIZE + '"></canvas></body></html>';
    await win.loadURL('data:text/html,' + encodeURIComponent(html));
    const dataUrl = await win.webContents.executeJavaScript(
        'new Promise((resolve, reject) => {' +
        'const img = new Image();' +
        'img.onload = () => {' +
        'const canvas = document.getElementById("c");' +
        'const ctx = canvas.getContext("2d");' +
        'ctx.clearRect(0, 0, canvas.width, canvas.height);' +
        'ctx.drawImage(img, 0, 0, canvas.width, canvas.height);' +
        'resolve(canvas.toDataURL("image/png"));' +
        '};' +
        'img.onerror = () => reject(new Error("svg image failed to load"));' +
        'img.src = ' + JSON.stringify(svgDataUrl) + ';' +
        '})'
    );
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    return Buffer.from(base64, 'base64');
}

// app.exit() can race past a just-written console.log on Windows before
// the pipe flushes, same trap main.js's finishSmoke works around; queuing
// one more (empty) write and exiting from its callback fixes it here too.
function finish(ok) {
    process.stdout.write('', () => app.exit(ok ? 0 : 1));
}

async function main() {
    await fs.mkdir(OUT_DIR, { recursive: true });

    const win = openRenderWindow();
    for (const task of TASKS) {
        console.log('[make-task-icons] rendering ' + task.name + '...');
        const pngBuffer = await renderSvgToPng(win, svgFor(task));
        const master = await Jimp.read(pngBuffer);

        const sizedBuffers = await Promise.all(
            ICO_SIZES.map((size) =>
                master.clone().resize({ w: size, h: size, mode: ResizeStrategy.BICUBIC }).getBuffer('image/png')
            )
        );
        const icoBuffer = await pngToIco(sizedBuffers);
        const outPath = path.join(OUT_DIR, task.name + '.ico');
        await fs.writeFile(outPath, icoBuffer);
        console.log('[make-task-icons] wrote build/task-icons/' + task.name + '.ico (' + ICO_SIZES.join(', ') + ') for ' + task.title);
    }
    win.destroy();

    finish(true);
}

app.whenReady().then(() => {
    main().catch((err) => {
        console.error('[make-task-icons] failed:', err && err.stack ? err.stack : err);
        finish(false);
    });
});
