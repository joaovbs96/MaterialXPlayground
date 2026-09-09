#!/usr/bin/env node
// make-icon.mjs: one-time generator for the desktop app icon. Run this
// manually and commit its output (build/icon.png, build/icon.ico);
// re-run it if the source artwork ever changes.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jimp, ResizeStrategy } from 'jimp';
import pngToIco from 'png-to-ico';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ELECTRON_DIR, '..');
const BUILD_DIR = path.join(ELECTRON_DIR, 'build');

// images/logo.png (317x317) is the largest of the app's existing icon
// sources (favicon.ico is 256x256, apple-touch-icon.png is 180x180) and
// shares the same circular mark, so it is the least-lossy source here.
const SOURCE = path.join(REPO_ROOT, 'images', 'logo.png');
const ICO_SIZES = [256, 128, 64, 48, 32, 16];

async function main() {
    await fs.mkdir(BUILD_DIR, { recursive: true });

    const source = await Jimp.read(SOURCE);

    // icon.png is an upscale (317 -> 512); every ICO size below is a
    // downsize from the pristine source instead, for sharper results.
    const upscaled = source.clone().resize({ w: 512, h: 512, mode: ResizeStrategy.BICUBIC });
    const pngBuffer = await upscaled.getBuffer('image/png');
    await fs.writeFile(path.join(BUILD_DIR, 'icon.png'), pngBuffer);
    console.log('[make-icon] wrote build/icon.png (512x512) from ' + path.relative(REPO_ROOT, SOURCE));

    const sizedBuffers = await Promise.all(
        ICO_SIZES.map((size) => source.clone().resize({ w: size, h: size, mode: ResizeStrategy.BICUBIC }).getBuffer('image/png'))
    );
    const icoBuffer = await pngToIco(sizedBuffers);
    await fs.writeFile(path.join(BUILD_DIR, 'icon.ico'), icoBuffer);
    console.log('[make-icon] wrote build/icon.ico (' + ICO_SIZES.join(', ') + ')');
}

main().catch((err) => {
    console.error('[make-icon] failed:', err);
    process.exit(1);
});
