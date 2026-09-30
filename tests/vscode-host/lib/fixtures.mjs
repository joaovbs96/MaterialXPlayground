// fixtures.mjs: generates every on-disk fixture the stress-test suite
// needs (textures, big .bin payloads, .mtlx documents) under a directory
// OUTSIDE the repo, plus a manifest.json recording each file's size and
// Node-side SHA-256 so the suite can compare webview-reported hashes
// against ground truth without re-hashing large files on every run.
'use strict';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { encodePNG } from './png.mjs';
import { writeHalfRgbaExr } from './exr.mjs';
import { bigMtlxDoc, manyMtlxDoc, outsideRefMtlxDoc } from './mtlx-docs.mjs';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const BIN_SIZES = [
    { name: 'bin_1mib.bin', bytes: 1 * MiB },
    { name: 'bin_64mib.bin', bytes: 64 * MiB },
    { name: 'bin_256mib.bin', bytes: 256 * MiB },
    { name: 'bin_512mib.bin', bytes: 512 * MiB },
    { name: 'bin_1gib.bin', bytes: 1 * GiB },
    { name: 'bin_1500mib.bin', bytes: 1536 * MiB },
];

function clamp8(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

function log(msg) { console.log('[fixtures] ' + msg); }

function loadManifest(manifestPath) {
    try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (e) {
        return {};
    }
}

function saveManifest(manifestPath, manifest) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

// Skips regeneration when the file already exists at the exact expected
// size AND the manifest still has a hash recorded for it (avoids
// rehashing multi-GB files just to confirm a skip).
function alreadyCurrent(filePath, expectedSize, manifest, relKey) {
    if (!fs.existsSync(filePath)) return false;
    const st = fs.statSync(filePath);
    if (st.size !== expectedSize) return false;
    return !!(manifest[relKey] && manifest[relKey].size === expectedSize && manifest[relKey].sha256);
}

async function writeRandomBin(filePath, size) {
    const CHUNK = 16 * MiB;
    const hash = crypto.createHash('sha256');
    const ws = fs.createWriteStream(filePath);
    const state = { err: null };
    ws.on('error', (e) => { state.err = e; });
    let written = 0;
    while (written < size) {
        const n = Math.min(CHUNK, size - written);
        const buf = crypto.randomBytes(n);
        hash.update(buf);
        await new Promise((resolve, reject) => {
            const ok = ws.write(buf, (err) => { if (err) reject(err); });
            if (state.err) { reject(state.err); return; }
            if (ok) resolve(); else ws.once('drain', resolve);
        });
        written += n;
    }
    await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
    if (state.err) throw state.err;
    return { size: written, sha256: hash.digest('hex') };
}

function hashBuffer(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function writePngRecordHash(filePath, buf) {
    fs.writeFileSync(filePath, buf);
    return { size: buf.length, sha256: hashBuffer(buf) };
}

// 4096x4096 RGB8 base color: a low-frequency gradient plus per-pixel
// random noise, so deflate compresses it like a real photo instead of
// either a flat color (trivial) or pure noise (incompressible).
function genBaseColorPng(width, height) {
    return encodePNG({
        width, height, bitDepth: 8, colorType: 2,
        fillRow: (y, row) => {
            for (let x = 0; x < width; x++) {
                const g = ((x * 3 + y * 5) >> 3) & 0xFF;
                const n = (Math.random() * 24 - 12) | 0;
                const o = x * 3;
                row[o] = clamp8(g + n);
                row[o + 1] = clamp8((g ^ 0x55) + n);
                row[o + 2] = clamp8((255 - g) + n);
            }
        },
    });
}

function genGrayPng(width, height, bitDepth) {
    const maxV = bitDepth === 16 ? 65535 : 255;
    return encodePNG({
        width, height, bitDepth, colorType: 0,
        fillRow: (y, row) => {
            for (let x = 0; x < width; x++) {
                const g = ((x + y) / (width + height)) * maxV;
                const n = (Math.random() * (maxV * 0.03)) - (maxV * 0.015);
                const v = Math.max(0, Math.min(maxV, Math.round(g + n)));
                if (bitDepth === 16) row.writeUInt16BE(v, x * 2); else row[x] = v;
            }
        },
    });
}

// 16-bit RGB tangent-space normal map: a mostly-upward normal with a
// small random tilt per pixel, encoded 0..65535 per PNG's big-endian
// 16-bit sample convention.
function genNormalPng(width, height) {
    return encodePNG({
        width, height, bitDepth: 16, colorType: 2,
        fillRow: (y, row) => {
            for (let x = 0; x < width; x++) {
                const nx = (Math.random() - 0.5) * 0.5;
                const ny = (Math.random() - 0.5) * 0.5;
                const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
                const o = x * 6;
                row.writeUInt16BE(Math.round((nx * 0.5 + 0.5) * 65535), o);
                row.writeUInt16BE(Math.round((ny * 0.5 + 0.5) * 65535), o + 2);
                row.writeUInt16BE(Math.round((nz * 0.5 + 0.5) * 65535), o + 4);
            }
        },
    });
}

function genSmallPng(index) {
    return encodePNG({
        width: 64, height: 64, bitDepth: 8, colorType: 2,
        fillRow: (y, row) => {
            for (let x = 0; x < 64; x++) {
                const o = x * 3;
                row[o] = (index * 7 + x) & 0xFF;
                row[o + 1] = (index * 13 + y) & 0xFF;
                row[o + 2] = (index * 29) & 0xFF;
            }
        },
    });
}

// Generates every fixture under fixturesDir, skipping files already
// present at the right size with a recorded hash. Returns the manifest
// (also written to <fixturesDir>/manifest.json) plus derived paths.
async function generateFixtures(fixturesDir) {
    const wsDir = path.join(fixturesDir, 'ws');
    const texDir = path.join(wsDir, 'textures');
    const smallDir = path.join(texDir, 'small');
    const matDir = path.join(wsDir, 'mat');
    const binDir = path.join(wsDir, 'bin');
    const outsideDir = path.join(fixturesDir, 'outside');
    for (const d of [wsDir, texDir, smallDir, matDir, binDir, outsideDir]) {
        fs.mkdirSync(d, { recursive: true });
    }

    const manifestPath = path.join(fixturesDir, 'manifest.json');
    const manifest = loadManifest(manifestPath);

    // --- big textures ---
    const bigTextures = [
        { key: 'basecolor_4k.png', dir: texDir, gen: () => genBaseColorPng(4096, 4096) },
        { key: 'roughness_4k.png', dir: texDir, gen: () => genGrayPng(4096, 4096, 8) },
        { key: 'normal_4k.png', dir: texDir, gen: () => genNormalPng(4096, 4096) },
        { key: 'displacement_8k.png', dir: texDir, gen: () => genGrayPng(8192, 8192, 16) },
    ];
    for (const t of bigTextures) {
        const filePath = path.join(t.dir, t.key);
        const relKey = 'ws/textures/' + t.key;
        if (manifest[relKey] && fs.existsSync(filePath) && fs.statSync(filePath).size === manifest[relKey].size) {
            log('skip (present): ' + relKey);
            continue;
        }
        log('generating ' + relKey + ' ...');
        const buf = t.gen();
        const rec = writePngRecordHash(filePath, buf);
        manifest[relKey] = rec;
        saveManifest(manifestPath, manifest);
        log(relKey + ' -> ' + rec.size + ' bytes, sha256 ' + rec.sha256.slice(0, 12) + '...');
    }

    // --- 8K EXR (deterministic exact size, so idempotency doesn't need a rehash) ---
    {
        const relKey = 'ws/textures/env_8k.exr';
        const filePath = path.join(texDir, 'env_8k.exr');
        if (alreadyCurrent(filePath, manifest[relKey] ? manifest[relKey].size : -1, manifest, relKey)) {
            log('skip (present): ' + relKey);
        } else {
            log('generating ' + relKey + ' (this is the ~512MiB one, may take a while)...');
            const rec = await writeHalfRgbaExr(filePath, 8192, 8192);
            manifest[relKey] = rec;
            saveManifest(manifestPath, manifest);
            log(relKey + ' -> ' + rec.size + ' bytes, sha256 ' + rec.sha256.slice(0, 12) + '...');
        }
    }

    // --- 200 small PNGs ---
    for (let i = 0; i < 200; i++) {
        const n = String(i).padStart(3, '0');
        const relKey = 'ws/textures/small/small_' + n + '.png';
        const filePath = path.join(smallDir, 'small_' + n + '.png');
        if (manifest[relKey] && fs.existsSync(filePath) && fs.statSync(filePath).size === manifest[relKey].size) continue;
        const buf = genSmallPng(i);
        manifest[relKey] = writePngRecordHash(filePath, buf);
    }
    saveManifest(manifestPath, manifest);
    log('small PNGs ready (200 files)');

    // --- outside/secret.png (must NOT be reachable from the ws workspace root) ---
    {
        const relKey = 'outside/secret.png';
        const filePath = path.join(outsideDir, 'secret.png');
        if (!(manifest[relKey] && fs.existsSync(filePath) && fs.statSync(filePath).size === manifest[relKey].size)) {
            const buf = genSmallPng(999);
            manifest[relKey] = writePngRecordHash(filePath, buf);
            saveManifest(manifestPath, manifest);
        }
    }

    // --- raw .bin files ---
    for (const b of BIN_SIZES) {
        const relKey = 'ws/bin/' + b.name;
        const filePath = path.join(binDir, b.name);
        if (alreadyCurrent(filePath, b.bytes, manifest, relKey)) {
            log('skip (present): ' + relKey + ' (' + b.bytes + ' bytes)');
            continue;
        }
        log('generating ' + relKey + ' (' + (b.bytes / MiB).toFixed(0) + ' MiB)...');
        const rec = await writeRandomBin(filePath, b.bytes);
        manifest[relKey] = rec;
        saveManifest(manifestPath, manifest);
        log(relKey + ' -> ' + rec.size + ' bytes, sha256 ' + rec.sha256.slice(0, 12) + '...');
    }

    // --- .mtlx documents (regenerated every run, cheap and text-only) ---
    fs.writeFileSync(path.join(matDir, 'big.mtlx'), bigMtlxDoc());
    fs.writeFileSync(path.join(matDir, 'many.mtlx'), manyMtlxDoc(200));
    fs.writeFileSync(path.join(matDir, 's7_outside.mtlx'), outsideRefMtlxDoc());

    saveManifest(manifestPath, manifest);
    log('fixture generation complete.');

    return {
        fixturesDir, wsDir, texDir, smallDir, matDir, binDir, outsideDir,
        manifestPath, manifest,
        bigMtlxPath: path.join(matDir, 'big.mtlx'),
        manyMtlxPath: path.join(matDir, 'many.mtlx'),
        s7MtlxPath: path.join(matDir, 's7_outside.mtlx'),
        binFiles: BIN_SIZES.map((b) => ({ name: b.name, path: path.join(binDir, b.name), expectedSize: b.bytes })),
    };
}

export { generateFixtures, BIN_SIZES };
