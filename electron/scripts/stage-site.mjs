#!/usr/bin/env node
// stage-site.mjs: copies the runtime payload (the unmodified site) into
// electron/dist-site/ for packaging, per docs/local/ELECTRON.md's staging
// include list. dist-site/ is cleaned first and is gitignored output.
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ELECTRON_DIR, '..');
const DEST = path.join(ELECTRON_DIR, 'dist-site');

// Top-level files copied as-is.
const ROOT_FILES = ['index.html', 'favicon.ico', 'environment_map.mtlx', 'apple-touch-icon.png', 'LICENSE'];
// Top-level directories copied, each filtered through shouldSkip.
const ROOT_DIRS = ['js', 'vendor', 'models', 'env_maps', 'materials', 'examples', 'embed', 'images'];
// Generated, never committed, and absent on a machine that has not run
// `npm run gallery:data`. Without it the packaged app shows the gallery's
// "not generated" card and its preset picker falls back to MTLX_PRESETS,
// so release CI populates it (from the published site, not by rendering)
// before packing. Optional so a local pack still works without it.
const OPTIONAL_ROOT_DIRS = ['gallery'];

// js/materialx/1.39.4 and every JsMaterialXCore.* file are dead weight
// (js/mtlx-engine.js only ever loads JsMaterialXGenShader.*, a superset
// of Core); images/og_image.png is only used for the web's og:image meta.
function shouldSkip(relativePath) {
    const p = relativePath.split(path.sep).join('/');
    if (p === 'js/materialx/1.39.4') return true;
    if (/^js\/materialx\/[^/]+\/JsMaterialXCore(-[\d.]+)?\.(js|wasm)$/.test(p)) return true;
    if (p === 'images/og_image.png') return true;
    return false;
}

async function copyDir(src, dest, relBase) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        const relPath = relBase ? relBase + '/' + entry.name : entry.name;
        if (shouldSkip(relPath)) continue;
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            await copyDir(srcPath, destPath, relPath);
        } else if (entry.isFile()) {
            await fs.copyFile(srcPath, destPath);
        }
    }
}

async function dirSize(dir) {
    let total = 0;
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
        return 0;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) total += await dirSize(full);
        else if (entry.isFile()) total += (await fs.stat(full)).size;
    }
    return total;
}

function formatBytes(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

async function main() {
    await fs.rm(DEST, { recursive: true, force: true });
    await fs.mkdir(DEST, { recursive: true });

    for (const file of ROOT_FILES) {
        await fs.copyFile(path.join(REPO_ROOT, file), path.join(DEST, file));
    }
    for (const dir of ROOT_DIRS) {
        await copyDir(path.join(REPO_ROOT, dir), path.join(DEST, dir), dir);
    }
    for (const dir of OPTIONAL_ROOT_DIRS) {
        const src = path.join(REPO_ROOT, dir);
        if (!existsSync(src)) {
            console.warn(`[stage-site] ${dir}/ absent, skipping (run \`npm run gallery:data\` to include it)`);
            continue;
        }
        await copyDir(src, path.join(DEST, dir), dir);
    }

    console.log('[stage-site] staged into ' + DEST);
    const lines = [];
    for (const file of ROOT_FILES) {
        const size = (await fs.stat(path.join(DEST, file))).size;
        lines.push(file + ': ' + formatBytes(size));
    }
    for (const dir of ROOT_DIRS) {
        lines.push(dir + '/: ' + formatBytes(await dirSize(path.join(DEST, dir))));
    }
    for (const line of lines) console.log('[stage-site]   ' + line);
    console.log('[stage-site] total: ' + formatBytes(await dirSize(DEST)));
}

main().catch((err) => {
    console.error('[stage-site] failed:', err);
    process.exit(1);
});
