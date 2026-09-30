// png.mjs: minimal from-scratch PNG encoder (no dependencies but Node's
// own zlib). Supports grayscale/RGB at 8 or 16 bit depth, filter type
// None on every scanline. Used only to generate stress-test fixtures.
'use strict';

import zlib from 'zlib';

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Standard PNG/zlib CRC-32 table (polynomial 0xEDB88320), built once.
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

function ihdr(width, height, bitDepth, colorType) {
    const b = Buffer.alloc(13);
    b.writeUInt32BE(width, 0);
    b.writeUInt32BE(height, 4);
    b.writeUInt8(bitDepth, 8);
    b.writeUInt8(colorType, 9);
    b.writeUInt8(0, 10);
    b.writeUInt8(0, 11);
    b.writeUInt8(0, 12);
    return chunk('IHDR', b);
}

// colorType: 0 = grayscale, 2 = truecolor (RGB). Only what this harness needs.
function samplesPerPixel(colorType) {
    if (colorType === 0) return 1;
    if (colorType === 2) return 3;
    throw new Error('unsupported PNG colorType ' + colorType);
}

// opts: { width, height, bitDepth (8|16), colorType (0|2), fillRow(y, rowBuf),
// level (zlib compression level, default 6) }. fillRow writes exactly
// width*samplesPerPixel*bytesPerSample bytes (big-endian samples for 16-bit,
// per the PNG spec) into rowBuf.
function encodePNG(opts) {
    const { width, height, bitDepth, colorType, fillRow, level } = opts;
    const spp = samplesPerPixel(colorType);
    const bytesPerSample = bitDepth === 16 ? 2 : 1;
    const rowBytes = width * spp * bytesPerSample;
    const raw = Buffer.alloc((rowBytes + 1) * height);
    for (let y = 0; y < height; y++) {
        const off = y * (rowBytes + 1);
        raw[off] = 0; // filter type: None
        fillRow(y, raw.subarray(off + 1, off + 1 + rowBytes));
    }
    const idat = zlib.deflateSync(raw, { level: level == null ? 6 : level });
    return Buffer.concat([
        SIGNATURE,
        ihdr(width, height, bitDepth, colorType),
        chunk('IDAT', idat),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

export { encodePNG };
