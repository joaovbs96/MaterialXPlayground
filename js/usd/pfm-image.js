// Float images for the scene importers: a PFM reader and a Radiance .hdr (RGBE)
// writer, so PFM environments and textures reach the renderer as .hdr assets.
// Pure ESM, no DOM, so node tests can import it.

// Reads a PFM file: "PF" is rgb, "Pf" is gray; the scale's sign gives the byte
// order (negative = little endian) and |scale| multiplies the samples. Rows are
// stored bottom to top; data comes back top row first, as rgb or gray floats.
export function readPfm(input) {
  const bytes = input instanceof Uint8Array ? input : ArrayBuffer.isView(input)
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
  let pos = 0;
  const word = () => {
    while (pos < bytes.length && /\s/.test(String.fromCharCode(bytes[pos]))) pos++;
    let s = "";
    while (pos < bytes.length && !/\s/.test(String.fromCharCode(bytes[pos]))) s += String.fromCharCode(bytes[pos++]);
    return s;
  };
  const magic = word();
  if (magic !== "PF" && magic !== "Pf") throw new Error("Not a PFM file (header \"" + magic.slice(0, 8) + "\")");
  const channels = magic === "PF" ? 3 : 1;
  const width = parseInt(word(), 10), height = parseInt(word(), 10);
  const scale = parseFloat(word());
  if (!(width > 0 && height > 0) || !Number.isFinite(scale) || scale === 0) throw new Error("Invalid PFM header");
  pos++; // the single whitespace byte after the scale
  const count = width * height * channels;
  if (bytes.length - pos < count * 4) throw new Error("PFM file is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset + pos, count * 4);
  const little = scale < 0;
  const mul = Math.abs(scale);
  const data = new Float32Array(count);
  const row = width * channels;
  for (let y = 0; y < height; y++) {
    const dst = (height - 1 - y) * row;
    for (let i = 0; i < row; i++) data[dst + i] = view.getFloat32((y * row + i) * 4, little) * mul;
  }
  return { width, height, channels, data };
}

// Gray or rgb float pixels as rgb.
export function toRgb({ width, height, channels, data }) {
  if (channels === 3) return { width, height, data };
  const out = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = data[i * channels];
  return { width, height, data: out };
}

function rgbe(r, g, b, out, o) {
  const m = Math.max(r, g, b);
  if (!(m > 1e-32)) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; return; }
  const e = Math.ceil(Math.log2(m) + 1e-12);
  let f = Math.pow(2, -e) * 256;
  if (m * f >= 256) f /= 2; // keeps the mantissa below 256
  const exp = Math.round(Math.log2(256 / f));
  out[o] = Math.max(0, Math.min(255, Math.floor(Math.max(0, r) * f)));
  out[o + 1] = Math.max(0, Math.min(255, Math.floor(Math.max(0, g) * f)));
  out[o + 2] = Math.max(0, Math.min(255, Math.floor(Math.max(0, b) * f)));
  out[o + 3] = exp + 128;
}

// Radiance .hdr bytes for rgb float pixels (top row first). Scanlines use the
// new-style run-length layout with literal runs only, which every reader
// (three's RGBELoader included) decodes; RGBE keeps about 8 bits of mantissa.
export function encodeRadianceHdr({ width, height, data }) {
  const header = "#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y " + height + " +X " + width + "\n";
  const rle = width >= 8 && width < 0x8000;
  const scan = new Uint8Array(width * 4);
  const chunks = [new TextEncoder().encode(header)];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      rgbe(data[i], data[i + 1], data[i + 2], scan, x * 4);
    }
    if (!rle) { chunks.push(scan.slice()); continue; }
    const line = new Uint8Array(4 + 4 * (width + Math.ceil(width / 128)));
    line.set([2, 2, width >> 8, width & 255]);
    let o = 4;
    for (let c = 0; c < 4; c++) {
      for (let x = 0; x < width; x += 128) {
        const n = Math.min(128, width - x);
        line[o++] = n;
        for (let k = 0; k < n; k++) line[o++] = scan[(x + k) * 4 + c];
      }
    }
    chunks.push(line.subarray(0, o));
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Decodes .hdr bytes written by encodeRadianceHdr (tests and round trips).
export function decodeRadianceHdr(bytes) {
  const text = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 512)));
  const m = /\n-Y (\d+) \+X (\d+)\n/.exec(text);
  if (!m) throw new Error("Unsupported .hdr header");
  const height = Number(m[1]), width = Number(m[2]);
  let pos = m.index + m[0].length;
  const data = new Float32Array(width * height * 3);
  const scan = new Uint8Array(width * 4);
  for (let y = 0; y < height; y++) {
    if (width >= 8 && width < 0x8000 && bytes[pos] === 2 && bytes[pos + 1] === 2) {
      pos += 4;
      for (let c = 0; c < 4; c++) {
        for (let x = 0; x < width;) {
          let n = bytes[pos++];
          if (n > 128) { n -= 128; const v = bytes[pos++]; for (let k = 0; k < n; k++) scan[(x++) * 4 + c] = v; }
          else for (let k = 0; k < n; k++) scan[(x++) * 4 + c] = bytes[pos++];
        }
      }
    } else { scan.set(bytes.subarray(pos, pos + width * 4)); pos += width * 4; }
    for (let x = 0; x < width; x++) {
      const e = scan[x * 4 + 3];
      const f = e ? Math.pow(2, e - 136) : 0;
      for (let c = 0; c < 3; c++) data[(y * width + x) * 3 + c] = e ? (scan[x * 4 + c] + 0.5) * f : 0;
    }
  }
  return { width, height, data };
}
