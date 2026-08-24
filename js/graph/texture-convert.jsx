// js/graph/texture-convert.jsx: texture format conversion for the graph
// view's zip export (Experimental "Texture format" option): decode/encode
// LDR raster via canvas, decode EXR/HDR via vendored THREE loaders, encode
// EXR via a minimal hand-written writer, and rewrite exported filename refs.
// No top-level import/export: self-exports via Object.assign(window, {}).
// No transfer curve either direction: LDR bytes <-> float is a plain
// /255 or *255 scale; an EXR opened in an external viewer expecting
// scene-linear data may render an sRGB-tagged source too dark.

        // IEEE-754 float32 -> float16. Copy of js/mtlx-engine.js:2126-2137
        // (kept private there); duplicated here so this file has no
        // dependency on load order relative to the engine script.
        const _f32 = new Float32Array(1);
        const _u32 = new Uint32Array(_f32.buffer);
        const floatToHalf = (val) => {
            _f32[0] = val;
            const x = _u32[0];
            const sign = (x >> 16) & 0x8000;
            const exp = ((x >> 23) & 0xFF) - 127 + 15;
            if (exp <= 0) return sign;                 // underflow -> signed 0
            if (exp >= 31) return sign | 0x7BFF;       // clamp to max half
            return sign | (exp << 10) | ((x & 0x7FFFFF) >> 13);
        };

        // Decodes any browser-supported raster Blob to a canvas sized to
        // its natural dimensions. createImageBitmap is the fast path; the
        // Image+object-URL fallback covers browsers/blob types it rejects.
        const decodeToCanvas = async (blob) => {
            let src = null;
            if (typeof createImageBitmap === 'function') {
                try { src = await createImageBitmap(blob); } catch (e) { src = null; }
            }
            if (!src) {
                src = await new Promise((resolve, reject) => {
                    const url = URL.createObjectURL(blob);
                    const img = new Image();
                    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
                    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
                    img.src = url;
                });
            }
            const w = src.width || src.naturalWidth;
            const h = src.height || src.naturalHeight;
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            canvas.getContext('2d').drawImage(src, 0, 0);
            return canvas;
        };

        // Promisified canvas.toBlob. Resolves { ok:false } (never rejects)
        // when the browser hands back null, e.g. tainted or zero-size
        // canvas, so callers treat it like any other unconvertible source.
        const encodeCanvas = (canvas, fmt) => new Promise((resolve) => {
            const mime = fmt === 'jpeg' ? 'image/jpeg' : 'image/png';
            const quality = fmt === 'jpeg' ? 0.92 : undefined;
            canvas.toBlob((blob) => resolve(blob ? { ok: true, blob } : { ok: false }), mime, quality);
        });

        // Decodes an .exr/.hdr Blob to a flat Float32Array RGBA buffer.
        // Mirrors js/mtlx-engine.js's loadExrTexture/loadHdrTexture (same
        // loaders/parse/guard contract) but normalizes stride to RGBA.
        const decodeToFloatRGBA = async (blob, ext) => {
            if (ext === 'exr' && typeof THREE.EXRLoader === 'undefined') {
                console.warn('texture-convert: THREE.EXRLoader unavailable; cannot convert .exr source.');
                return null;
            }
            if (ext === 'hdr' && typeof THREE.RGBELoader === 'undefined') {
                console.warn('texture-convert: THREE.RGBELoader unavailable; cannot convert .hdr source.');
                return null;
            }
            if (ext !== 'exr' && ext !== 'hdr') return null;
            try {
                const buf = await blob.arrayBuffer();
                const Loader = ext === 'exr' ? THREE.EXRLoader : THREE.RGBELoader;
                const d = new Loader().setDataType(THREE.FloatType).parse(buf);
                if (!d || !d.data) return null;
                const { width, height } = d;
                const stride = d.data.length / (width * height);
                if (stride !== 1 && stride !== 3 && stride !== 4) return null; // unexpected layout
                const out = new Float32Array(width * height * 4);
                for (let i = 0; i < width * height; i++) {
                    if (stride === 1) {
                        const v = d.data[i];
                        out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 1;
                    } else if (stride === 3) {
                        out[i * 4] = d.data[i * 3]; out[i * 4 + 1] = d.data[i * 3 + 1];
                        out[i * 4 + 2] = d.data[i * 3 + 2]; out[i * 4 + 3] = 1;
                    } else {
                        out[i * 4] = d.data[i * 4]; out[i * 4 + 1] = d.data[i * 4 + 1];
                        out[i * 4 + 2] = d.data[i * 4 + 2]; out[i * 4 + 3] = d.data[i * 4 + 3];
                    }
                }
                return { data: out, width, height };
            } catch (e) {
                console.warn('texture-convert: failed to parse .' + ext + ' texture for conversion:', e);
                return null;
            }
        };

        // Float RGBA -> LDR canvas: clamp(v,0,1)*255 per channel, no curve.
        const floatRGBAToCanvas = (data, w, h) => {
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            const imgData = ctx.createImageData(w, h);
            for (let i = 0; i < w * h * 4; i++) {
                imgData.data[i] = Math.max(0, Math.min(1, data[i])) * 255;
            }
            ctx.putImageData(imgData, 0, 0);
            return canvas;
        };

        // LDR canvas -> float RGBA: v/255 per channel, no curve.
        const canvasToFloatRGBA = (canvas) => {
            const w = canvas.width, h = canvas.height;
            const imgData = canvas.getContext('2d').getImageData(0, 0, w, h);
            const data = new Float32Array(w * h * 4);
            for (let i = 0; i < data.length; i++) data[i] = imgData.data[i] / 255;
            return { data, width: w, height: h };
        };

        // Minimal single-part scanline EXR writer: HALF pixel type,
        // NO_COMPRESSION, channels B/G/R only (alpha dropped). Sizes below
        // are computed from the attribute list itself, not hardcoded.
        const encodeExr = (width, height, rgbaF32) => {
            const CHANNELS = ['B', 'G', 'R'];
            const COMP = { B: 2, G: 1, R: 0 };
            const strBytes = (s) => { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; };

            const channelsPayload = new Uint8Array(3 * 18 + 1);
            {
                let o = 0;
                for (const c of CHANNELS) {
                    channelsPayload[o++] = c.charCodeAt(0);
                    channelsPayload[o++] = 0; // name NUL
                    const dv = new DataView(channelsPayload.buffer, o, 16);
                    dv.setInt32(0, 1, true);   // pixelType = HALF
                    dv.setUint8(4, 0);         // pLinear
                    dv.setUint8(5, 0); dv.setUint8(6, 0); dv.setUint8(7, 0); // reserved
                    dv.setInt32(8, 1, true);   // xSampling
                    dv.setInt32(12, 1, true);  // ySampling
                    o += 16;
                }
                channelsPayload[o] = 0; // chlist terminator
            }
            const box2i = (x0, y0, x1, y1) => {
                const p = new Uint8Array(16);
                const dv = new DataView(p.buffer);
                dv.setInt32(0, x0, true); dv.setInt32(4, y0, true);
                dv.setInt32(8, x1, true); dv.setInt32(12, y1, true);
                return p;
            };
            const f32Bytes = (v) => { const p = new Uint8Array(4); new DataView(p.buffer).setFloat32(0, v, true); return p; };
            const dataWindow = box2i(0, 0, width - 1, height - 1);

            const attrs = [
                ['channels', 'chlist', channelsPayload],
                ['compression', 'compression', new Uint8Array([0])],
                ['dataWindow', 'box2i', dataWindow],
                ['displayWindow', 'box2i', dataWindow],
                ['lineOrder', 'lineOrder', new Uint8Array([0])],
                ['pixelAspectRatio', 'float', f32Bytes(1.0)],
                ['screenWindowCenter', 'v2f', new Uint8Array(8)], // {0.0, 0.0}
                ['screenWindowWidth', 'float', f32Bytes(1.0)],
            ];

            let headerSize = 8; // magic(4) + version(4)
            for (const [name, type, payload] of attrs) headerSize += name.length + 1 + type.length + 1 + 4 + payload.length;
            headerSize += 1; // header terminator

            const rowDataSize = width * 3 * 2; // 3 channels * 2 bytes/half
            const chunkSize = 8 + rowDataSize;
            const firstChunkOffset = headerSize + height * 8; // + offset table
            const total = firstChunkOffset + height * chunkSize;

            const buf = new ArrayBuffer(total);
            const bytes = new Uint8Array(buf);
            const view = new DataView(buf);
            let o = 0;
            bytes[o++] = 0x76; bytes[o++] = 0x2F; bytes[o++] = 0x31; bytes[o++] = 0x01;
            view.setInt32(o, 2, true); o += 4;
            for (const [name, type, payload] of attrs) {
                bytes.set(strBytes(name), o); o += name.length; bytes[o++] = 0;
                bytes.set(strBytes(type), o); o += type.length; bytes[o++] = 0;
                view.setInt32(o, payload.length, true); o += 4;
                bytes.set(payload, o); o += payload.length;
            }
            bytes[o++] = 0; // header terminator

            for (let y = 0; y < height; y++) {
                const off = firstChunkOffset + y * chunkSize;
                view.setUint32(o, off >>> 0, true); o += 4;
                view.setUint32(o, 0, true); o += 4; // high 32 bits, always 0 here
            }

            for (let y = 0; y < height; y++) {
                view.setInt32(o, y, true); o += 4;
                view.setInt32(o, rowDataSize, true); o += 4;
                for (const ch of CHANNELS) {
                    const comp = COMP[ch];
                    for (let x = 0; x < width; x++) {
                        view.setUint16(o, floatToHalf(rgbaF32[(y * width + x) * 4 + comp]), true);
                        o += 2;
                    }
                }
            }
            return new Blob([buf], { type: 'image/x-exr' });
        };

        // Rewrites <input type="filename" value="..."> refs across the doc.
        // Reuses mtlx-ui.jsx's extractFilenameRefs scope-split (root and
        // per-nodegraph fileprefix) but splices tags into byte-identical xml.
        const rewriteFilenameRefs = (xml, mapRef) => {
            const rootAttrs = (/<materialx\b([^>]*)>/.exec(xml) || [])[1] || '';
            const rootPrefix = (/\bfileprefix\s*=\s*"([^"]*)"/.exec(rootAttrs) || [])[1] || '';

            const rewriteScope = (text, prefix) => text.replace(/<input\b[^>]*>/g, (tag) => {
                if (!/\btype\s*=\s*"filename"/.test(tag)) return tag;
                const m = /\bvalue(\s*=\s*)"([^"]*)"/.exec(tag);
                const raw = m && m[2];
                if (!raw) return tag;
                const resolved = (prefix + raw).replace(/\\/g, '/').replace(/^\.?\/+/, '');
                const newExt = mapRef(resolved);
                if (!newExt) return tag; // not converted: byte-identical tag
                const newValue = raw.replace(/\.[A-Za-z0-9]+$/, '.' + newExt);
                return tag.slice(0, m.index) + 'value' + m[1] + '"' + newValue + '"' + tag.slice(m.index + m[0].length);
            });

            let out = '';
            let cursor = 0;
            const NG = /<nodegraph\b([^>]*)>([\s\S]*?)<\/nodegraph>/g;
            let ngm;
            while ((ngm = NG.exec(xml)) !== null) {
                out += rewriteScope(xml.slice(cursor, ngm.index), rootPrefix);
                const ngPrefix = (/\bfileprefix\s*=\s*"([^"]*)"/.exec(ngm[1]) || [])[1] || '';
                out += '<nodegraph' + ngm[1] + '>' + rewriteScope(ngm[2], rootPrefix + ngPrefix) + '</nodegraph>';
                cursor = ngm.index + ngm[0].length;
            }
            out += rewriteScope(xml.slice(cursor), rootPrefix);
            return out;
        };

        // Converts one texture Blob from srcExt to the target format.
        // Resolves { keep:true } when already matching, { ok:true, blob, ext }
        // on success, or { ok:false } for unconvertible sources or errors.
        const convertTextureBlob = async (blob, srcExt, target) => {
            try {
                const ext = String(srcExt || '').toLowerCase().replace(/^\./, '');
                if ((ext === 'png' && target === 'png') ||
                    ((ext === 'jpg' || ext === 'jpeg') && target === 'jpeg') ||
                    (ext === 'exr' && target === 'exr')) {
                    return { keep: true };
                }
                const isLdr = ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp' || ext === 'gif' || ext === 'bmp';
                if (isLdr && (target === 'png' || target === 'jpeg')) {
                    const canvas = await decodeToCanvas(blob);
                    const result = await encodeCanvas(canvas, target);
                    if (!result.ok) return { ok: false };
                    return { ok: true, blob: result.blob, ext: target === 'jpeg' ? 'jpg' : 'png' };
                }
                if (isLdr && target === 'exr') {
                    const canvas = await decodeToCanvas(blob);
                    const { data, width, height } = canvasToFloatRGBA(canvas);
                    return { ok: true, blob: encodeExr(width, height, data), ext: 'exr' };
                }
                if ((ext === 'exr' || ext === 'hdr') && (target === 'png' || target === 'jpeg')) {
                    const decoded = await decodeToFloatRGBA(blob, ext);
                    if (!decoded) return { ok: false };
                    const canvas = floatRGBAToCanvas(decoded.data, decoded.width, decoded.height);
                    const result = await encodeCanvas(canvas, target);
                    if (!result.ok) return { ok: false };
                    return { ok: true, blob: result.blob, ext: target === 'jpeg' ? 'jpg' : 'png' };
                }
                if (ext === 'hdr' && target === 'exr') {
                    const decoded = await decodeToFloatRGBA(blob, 'hdr');
                    if (!decoded) return { ok: false };
                    return { ok: true, blob: encodeExr(decoded.width, decoded.height, decoded.data), ext: 'exr' };
                }
                return { ok: false }; // e.g. tga/tif/tiff: not convertible in this feature
            } catch (e) {
                return { ok: false };
            }
        };

Object.assign(window, { floatToHalf, decodeToCanvas, encodeCanvas, decodeToFloatRGBA, floatRGBAToCanvas, canvasToFloatRGBA, encodeExr, rewriteFilenameRefs, convertTextureBlob });
