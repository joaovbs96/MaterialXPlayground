// exr.mjs: minimal from-scratch OpenEXR encoder for a single-part,
// scanline, NO_COMPRESSION, half-float RGBA image. Streamed to disk so an
// 8K image (hundreds of MiB) never sits fully in memory. Layout verified
// against the repo's own vendored parser (js/vendor/EXRLoader.js), not
// just the OpenEXR spec, since that parser is what decodes it later.
'use strict';

import fs from 'fs';
import crypto from 'crypto';

function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function i32le(n) { const b = Buffer.alloc(4); b.writeInt32LE(n, 0); return b; }
function f32le(n) { const b = Buffer.alloc(4); b.writeFloatLE(n, 0); return b; }
function cstr(s) { return Buffer.concat([Buffer.from(s, 'ascii'), Buffer.from([0])]); }

function attr(name, type, valueBuf) {
    return Buffer.concat([cstr(name), cstr(type), u32le(valueBuf.length), valueBuf]);
}

function box2i(xMin, yMin, xMax, yMax) {
    return Buffer.concat([i32le(xMin), i32le(yMin), i32le(xMax), i32le(yMax)]);
}

// pixelType 1 = HALF (see EXRLoader.js parseChlist / setupDecoder).
function channelEntry(name, pixelType) {
    return Buffer.concat([cstr(name), i32le(pixelType), Buffer.from([0, 0, 0, 0]), i32le(1), i32le(1)]);
}

// Writes buf to ws respecting backpressure, and folds it into `hash`.
// Resolves once the OS accepted the write (or the internal buffer drained).
function writeAndHash(ws, hash, buf, state) {
    hash.update(buf);
    return new Promise((resolve, reject) => {
        const ok = ws.write(buf, (err) => { if (err) reject(err); });
        if (state.err) { reject(state.err); return; }
        if (ok) resolve(); else ws.once('drain', resolve);
    });
}

// Writes an uncompressed half-float RGBA scanline EXR (A,B,G,R channel
// order, alphabetical per OpenEXR convention; EXRLoader.js maps by name so
// order doesn't actually matter for correctness). Content is random but
// with the top exponent bit masked off every 16-bit sample so no texel can
// ever decode to Infinity/NaN (exponent field capped at 15, never 31).
// Returns { size, sha256 } computed while streaming, no re-read needed.
async function writeHalfRgbaExr(filePath, width, height) {
    const channels = ['A', 'B', 'G', 'R'];
    const chlistBody = Buffer.concat([...channels.map((n) => channelEntry(n, 1)), Buffer.from([0])]);
    const headerAttrs = Buffer.concat([
        attr('channels', 'chlist', chlistBody),
        attr('compression', 'compression', Buffer.from([0])), // NO_COMPRESSION
        attr('dataWindow', 'box2i', box2i(0, 0, width - 1, height - 1)),
        attr('displayWindow', 'box2i', box2i(0, 0, width - 1, height - 1)),
        attr('lineOrder', 'lineOrder', Buffer.from([0])), // INCREASING_Y
        attr('pixelAspectRatio', 'float', f32le(1)),
        attr('screenWindowCenter', 'v2f', Buffer.concat([f32le(0), f32le(0)])),
        attr('screenWindowWidth', 'float', f32le(1)),
        Buffer.from([0]), // header terminator (empty attribute name)
    ]);
    const preamble = Buffer.concat([Buffer.from([0x76, 0x2f, 0x31, 0x01]), Buffer.from([2, 0, 0, 0])]);
    const headerSize = preamble.length + headerAttrs.length;
    const bytesPerLine = width * 2 * channels.length; // 2 bytes/half * 4 channels
    const chunkSize = 8 + bytesPerLine; // int32 line_no + int32 data_len + data
    const offsetTable = Buffer.alloc(height * 8);
    let pos = BigInt(headerSize + offsetTable.length);
    for (let y = 0; y < height; y++) {
        offsetTable.writeBigInt64LE(pos, y * 8);
        pos += BigInt(chunkSize);
    }
    const totalSize = pos; // final running offset == total file size

    const state = { err: null };
    const ws = fs.createWriteStream(filePath);
    ws.on('error', (e) => { state.err = e; });
    const hash = crypto.createHash('sha256');

    await writeAndHash(ws, hash, preamble, state);
    await writeAndHash(ws, hash, headerAttrs, state);
    await writeAndHash(ws, hash, offsetTable, state);

    const head = Buffer.alloc(8);
    for (let y = 0; y < height; y++) {
        head.writeInt32LE(y, 0);
        head.writeUInt32LE(bytesPerLine, 4);
        await writeAndHash(ws, hash, Buffer.from(head), state);
        // A fresh buffer every row, never reused: writeAndHash's Promise
        // resolves as soon as ws.write() has BUFFERED the chunk (ok===true),
        // not once it's actually flushed -- for small/fast writes (never
        // backpressured) the loop can reach the next iteration and mutate a
        // shared buffer before the previous write's bytes are captured,
        // corrupting the file after its hash was already taken.
        const rowU16 = new Uint16Array(width * channels.length);
        crypto.randomFillSync(rowU16);
        for (let i = 0; i < rowU16.length; i++) rowU16[i] &= 0xBFFF; // never Inf/NaN
        const rowBuf = Buffer.from(rowU16.buffer, rowU16.byteOffset, rowU16.byteLength);
        await writeAndHash(ws, hash, rowBuf, state);
    }
    await new Promise((resolve, reject) => ws.end((err) => (err ? reject(err) : resolve())));
    if (state.err) throw state.err;
    return { size: Number(totalSize), sha256: hash.digest('hex') };
}

export { writeHalfRgbaExr };
