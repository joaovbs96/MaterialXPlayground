// tests/embed/lib/env-fixtures.mjs: synthesizes tiny .hdr and .exr
// buffers in memory (no binary fixtures committed) whose bright
// texels overflow the half-float range once loaded through the
// vendored loaders, to exercise the overflow sanitizer.

/** A 4x2 flat (uncompressed) Radiance RGBE file. Pixel 0 decodes to a
 * huge value (radiant overflow), pixel 1 to 0.5, the rest are black. */
export function makeHotHdr() {
  const header = Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 4\n', 'ascii');
  const pixels = Buffer.from([
    128, 128, 128, 146,
    128, 128, 128, 128,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0,
  ]);
  return Buffer.concat([header, pixels]);
}

/** A 4x2 flat (uncompressed) Radiance RGBE file with every pixel equal
 * to `value` (0..1). Used to isolate environment sampling: a constant
 * radiance cannot itself produce per-pixel noise. */
export function makeFlatHdr(value) {
  const header = Buffer.from('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 4\n', 'ascii');
  const mantissa = Math.max(0, Math.min(1, value));
  const rgbe = mantissa <= 0 ? [0, 0, 0, 0] : [
    Math.round(mantissa * 256),
    Math.round(mantissa * 256),
    Math.round(mantissa * 256),
    128,
  ];
  const pixels = Buffer.from(Array(8).fill(rgbe).flat());
  return Buffer.concat([header, pixels]);
}

/** A WxH flat (uncompressed) Radiance RGBE file with a deterministic
 * high-frequency pseudo-random pattern (alternating near-black/near-white
 * texels), used to give environment sampling real per-pixel contrast to
 * alias against (see env-footprint-lod.spec.mjs). */
export function makeNoiseHdr(w, h) {
  const header = Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`, 'ascii');
  const pixels = Buffer.alloc(w * h * 4);
  let state = 12345;
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let i = 0; i < w * h; i++) {
    const bright = rand() > 0.5;
    const mantissa = bright ? 255 : 0;
    pixels[i * 4 + 0] = mantissa;
    pixels[i * 4 + 1] = mantissa;
    pixels[i * 4 + 2] = mantissa;
    pixels[i * 4 + 3] = bright ? 128 : 0;
  }
  return Buffer.concat([header, pixels]);
}

const CHANNEL_ORDER = ['A', 'B', 'G', 'R'];

function chlistEntry(name) {
  const buf = Buffer.alloc(name.length + 1 + 4 + 1 + 3 + 4 + 4);
  let o = 0;
  buf.write(name, o, 'ascii'); o += name.length;
  buf.writeUInt8(0, o); o += 1; // name terminator
  buf.writeInt32LE(2, o); o += 4; // pixelType: FLOAT
  buf.writeUInt8(0, o); o += 1; // pLinear
  o += 3; // reserved
  buf.writeInt32LE(1, o); o += 4; // xSampling
  buf.writeInt32LE(1, o); o += 4; // ySampling
  return buf;
}

function attr(name, type, data) {
  const nameBuf = Buffer.from(name + '\0', 'ascii');
  const typeBuf = Buffer.from(type + '\0', 'ascii');
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeInt32LE(data.length, 0);
  return Buffer.concat([nameBuf, typeBuf, sizeBuf, data]);
}

function box2i(xMin, yMin, xMax, yMax) {
  const b = Buffer.alloc(16);
  b.writeInt32LE(xMin, 0); b.writeInt32LE(yMin, 4);
  b.writeInt32LE(xMax, 8); b.writeInt32LE(yMax, 12);
  return b;
}

/** A 4x2 uncompressed FLOAT RGBA OpenEXR scanline file. Pixel (0,0)
 * overflows the half range, pixel (1,0) is 0.5, alpha is 0.5 throughout. */
export function makeHotExr() {
  const W = 4, H = 2;
  const chlistData = Buffer.concat([...CHANNEL_ORDER.map(chlistEntry), Buffer.from([0])]);
  const attrs = Buffer.concat([
    attr('channels', 'chlist', chlistData),
    attr('compression', 'compression', Buffer.from([0])),
    attr('dataWindow', 'box2i', box2i(0, 0, W - 1, H - 1)),
    attr('displayWindow', 'box2i', box2i(0, 0, W - 1, H - 1)),
    attr('lineOrder', 'lineOrder', Buffer.from([0])),
    attr('pixelAspectRatio', 'float', (() => { const b = Buffer.alloc(4); b.writeFloatLE(1.0, 0); return b; })()),
    attr('screenWindowCenter', 'v2f', (() => { const b = Buffer.alloc(8); b.writeFloatLE(0, 0); b.writeFloatLE(0, 4); return b; })()),
    attr('screenWindowWidth', 'float', (() => { const b = Buffer.alloc(4); b.writeFloatLE(1.0, 0); return b; })()),
  ]);
  const header = Buffer.concat([attrs, Buffer.from([0])]); // header terminator

  const magicVersion = Buffer.alloc(8);
  magicVersion.writeInt32LE(20000630, 0);
  magicVersion.writeInt32LE(2, 4);

  const headerLen = magicVersion.length + header.length;
  const offsetTableLen = H * 8;
  const firstChunkOffset = headerLen + offsetTableLen;

  const dataSize = 4 /* channels */ * W * 4; // 64
  const chunkSize = 4 + 4 + dataSize; // y + dataSize + pixel data

  const offsetTable = Buffer.alloc(offsetTableLen);
  for (let y = 0; y < H; y++) {
    offsetTable.writeBigUInt64LE(BigInt(firstChunkOffset + y * chunkSize), y * 8);
  }

  const rows = [
    { R: [131072, 0.5, 0, 0], G: [131072, 0.5, 0, 0], B: [131072, 0.5, 0, 0], A: [0.5, 0.5, 0.5, 0.5] },
    { R: [0, 0, 0, 0], G: [0, 0, 0, 0], B: [0, 0, 0, 0], A: [0.5, 0.5, 0.5, 0.5] },
  ];

  const chunks = rows.map((row, y) => {
    const chunk = Buffer.alloc(chunkSize);
    let o = 0;
    chunk.writeInt32LE(y, o); o += 4;
    chunk.writeInt32LE(dataSize, o); o += 4;
    for (const ch of CHANNEL_ORDER) {
      for (let x = 0; x < W; x++) {
        chunk.writeFloatLE(row[ch][x], o); o += 4;
      }
    }
    return chunk;
  });

  return Buffer.concat([magicVersion, header, offsetTable, ...chunks]);
}
