// tests/embed/lib/image-fixtures.mjs: synthesizes a tiny uncompressed
// baseline RGB TIFF buffer in memory (no binary fixtures committed), for
// specs exercising the engine's UTIF.js-backed loadTifTexture path.

/** A single-strip, uncompressed, 8-bit RGB TIFF (little-endian) of the
 * given size, every pixel set to `rgb` ([r, g, b], 0..255). */
export function makeSolidTif(width, height, rgb) {
  const pixelDataOffset = 8;
  const pixelDataLen = width * height * 3;
  const pixels = Buffer.alloc(pixelDataLen);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 3] = rgb[0];
    pixels[i * 3 + 1] = rgb[1];
    pixels[i * 3 + 2] = rgb[2];
  }

  // Tags, ascending by id: ImageWidth, ImageLength, BitsPerSample,
  // Compression, PhotometricInterpretation, StripOffsets, SamplesPerPixel,
  // RowsPerStrip, StripByteCounts.
  const SHORT = 3, LONG = 4;
  const entries = [
    { tag: 256, type: LONG, count: 1, value: width },
    { tag: 257, type: LONG, count: 1, value: height },
    { tag: 258, type: SHORT, count: 3, values: [8, 8, 8] },
    { tag: 259, type: SHORT, count: 1, value: 1 },   // no compression
    { tag: 262, type: SHORT, count: 1, value: 2 },   // RGB
    { tag: 273, type: LONG, count: 1, value: pixelDataOffset },
    { tag: 277, type: SHORT, count: 1, value: 3 },   // samples/pixel
    { tag: 278, type: LONG, count: 1, value: height },
    { tag: 279, type: LONG, count: 1, value: pixelDataLen },
  ];

  const ifdOffset = pixelDataOffset + pixelDataLen;
  const ifdLen = 2 + 12 * entries.length + 4;
  const bitsPerSampleOffset = ifdOffset + ifdLen;

  const ifd = Buffer.alloc(ifdLen + 6); // + BitsPerSample's out-of-line array
  let o = 0;
  ifd.writeUInt16LE(entries.length, o); o += 2;
  for (const e of entries) {
    ifd.writeUInt16LE(e.tag, o); o += 2;
    ifd.writeUInt16LE(e.type, o); o += 2;
    ifd.writeUInt32LE(e.count, o); o += 4;
    if (e.values) {
      ifd.writeUInt32LE(bitsPerSampleOffset, o); o += 4;
    } else {
      ifd.writeUInt32LE(e.value, o); o += 4;
    }
  }
  ifd.writeUInt32LE(0, o); o += 4; // next IFD offset (none)
  for (const v of entries.find((e) => e.tag === 258).values) {
    ifd.writeUInt16LE(v, o); o += 2;
  }

  const header = Buffer.alloc(8);
  header.write('II', 0, 'ascii');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(ifdOffset, 4);

  return Buffer.concat([header, pixels, ifd]);
}
