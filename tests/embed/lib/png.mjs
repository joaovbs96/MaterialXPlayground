// tests/embed/lib/png.mjs: a minimal PNG decoder for reading a pixel
// back out of an elementHandle.screenshot() buffer in Node. 8-bit,
// non-interlaced RGB/RGBA only, every standard row filter type.

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Reverses a single row's filter in place against the previous
// (already-reconstructed) row. Both rows are `bpp`-aligned Buffers.
function unfilterRow(filterType, row, prevRow, bpp) {
  for (let x = 0; x < row.length; x++) {
    const a = x >= bpp ? row[x - bpp] : 0;
    const b = prevRow[x];
    const c = x >= bpp ? prevRow[x - bpp] : 0;
    let recon;
    if (filterType === 0) recon = row[x];
    else if (filterType === 1) recon = row[x] + a;
    else if (filterType === 2) recon = row[x] + b;
    else if (filterType === 3) recon = row[x] + Math.floor((a + b) / 2);
    else if (filterType === 4) recon = row[x] + paeth(a, b, c);
    else throw new Error('decodePNG: unexpected row filter type ' + filterType);
    row[x] = recon & 0xff;
  }
}

/** Decodes a PNG Buffer into { width, height, getPixel(x, y) }.
 * getPixel returns { r, g, b, a } (a = 255 without an alpha channel).
 * Throws on anything outside 8-bit, non-interlaced RGB/RGBA. */
export function decodePNG(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error('decodePNG: not a PNG (bad signature)');
  }
  let offset = 8;
  let ihdr = null;
  const idatParts = [];
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'IDAT') idatParts.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!ihdr) throw new Error('decodePNG: missing IHDR chunk');

  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  if (bitDepth !== 8) throw new Error('decodePNG: unsupported bit depth ' + bitDepth);
  if (interlace !== 0) throw new Error('decodePNG: interlaced PNG not supported');

  let channels;
  if (colorType === 2) channels = 3; // RGB
  else if (colorType === 6) channels = 4; // RGBA
  else throw new Error('decodePNG: unsupported color type ' + colorType);

  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const rowBytes = width * channels;
  const pixels = Buffer.alloc(rowBytes * height);
  let prevRow = Buffer.alloc(rowBytes);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[pos];
    pos += 1;
    const row = Buffer.from(raw.subarray(pos, pos + rowBytes));
    pos += rowBytes;
    unfilterRow(filterType, row, prevRow, channels);
    row.copy(pixels, y * rowBytes);
    prevRow = row;
  }

  return {
    width,
    height,
    channels,
    getPixel(x, y) {
      const o = y * rowBytes + x * channels;
      return {
        r: pixels[o],
        g: pixels[o + 1],
        b: pixels[o + 2],
        a: channels === 4 ? pixels[o + 3] : 255,
      };
    },
  };
}
