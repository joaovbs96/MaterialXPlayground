// mtlx-three-material.js, the three.js side of a MaterialX material shared by
// the page and the thumbnail worker: uniforms, textures, geometry, lights and
// the flat 2D camera. THREE, UTIF and the loaders are bare globals read at
// call time, so this loads in a bare context. Load after mtlx-gen-core.js.
(() => {
const {
    mxDataToPlainArray, normalizeSamplerAddressMode, STAGE_LIGHT_SLOTS, LIGHT_TYPE_DIRECTIONAL,
    displayTransformId, SHADOW_FACE_SLOTS, SHADOW_LIGHT_SLOTS_MAX, parseUniforms,
} = MtlxGenCore;

// Host providers, each read lazily at the call site. Defaults are the
// behaviour of a page with no overrides; the engine installs real readers.
const HOST_DEFAULTS = {
    keyLightRotation: (rad) => new THREE.Matrix4().makeRotationY(-rad),
    // A page with no override has no tilted domes, so the tilt is ignored here.
    envLookupMatrix: (rad) => new THREE.Matrix4().makeRotationY(Math.PI / 2 + rad),
    displayExposureScale: () => 1,
    displayTransform: () => 'srgb',
    clock: () => ({ time: 0, frame: 0 }),
    specularEnvMethod: () => 'prefilter',
    diffuseEnvMethod: () => 'convolve',
    sceneTextureFast: () => true,
    texturePerf: () => {},
};
// The hooks that are plain data, so a worker can mirror the page.
const SNAPSHOT_HOOKS = ['displayExposureScale', 'displayTransform', 'clock', 'specularEnvMethod', 'diffuseEnvMethod', 'sceneTextureFast'];
const host = Object.assign({}, HOST_DEFAULTS);
const setHost = (providers) => {
    for (const k of Object.keys(providers || {})) {
        if (!(k in HOST_DEFAULTS)) throw new Error('MtlxThreeMaterial.setHost: unknown hook ' + k);
        if (typeof providers[k] !== 'function') throw new Error('MtlxThreeMaterial.setHost: hook ' + k + ' must be a function');
        host[k] = providers[k];
    }
};
const hostSnapshot = () => {
    const snap = {};
    for (const k of SNAPSHOT_HOOKS) snap[k] = host[k]();
    return snap;
};
const setHostFromSnapshot = (obj) => {
    const providers = {};
    for (const k of SNAPSHOT_HOOKS) {
        if (!obj || !(k in obj)) continue;
        const v = obj[k];
        providers[k] = () => v;
    }
    setHost(providers);
};
const keyLightRotationMatrix = (rad, tilt) => host.keyLightRotation(rad, tilt);
const getSpecularEnvMethod = () => host.specularEnvMethod();
const getDiffuseEnvMethod = () => host.diffuseEnvMethod();
const sceneTextureFastPathEnabled = () => host.sceneTextureFast();
const addTexturePerf = (key, ms) => host.texturePerf(key, ms);
const displayExposureScale = () => host.displayExposureScale();
const getDisplayTransform = () => host.displayTransform();



// Shared 1x1 opaque-black dummy texture: the DEFAULT binding for the
// peel-depth samplers declared by injectPeelDiscard() below, so those
// uniforms always have SOME bound texture even though they're only
// sampled while u_peelMode != 0. Module-scope + lazily created.
let MTLX_DUMMY_TEX = null;
const getDummyTex = () => {
    if (!MTLX_DUMMY_TEX) {
        MTLX_DUMMY_TEX = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
        MTLX_DUMMY_TEX.needsUpdate = true;
    }
    return MTLX_DUMMY_TEX;
};

// White counterpart, depth==1.0 (far plane): the fail-safe default for
// u_opaqueDepth (see createMtlxSceneUniforms/renderFrame) so a stale/missing
// binding reads as "nothing there", never triggering the peel discard.
let MTLX_DUMMY_TEX_WHITE = null;
// Shadow matrix meaning "no shadow": maps every world position to the origin,
// so mx_shadow_occlusion samples the middle of a white moments map at depth
// 0.5 and always returns fully lit. An identity matrix is NOT safe here, it
// leaves fragmentDepth = worldZ * 0.5 + 0.5, which crosses the white map's
// stored depth of 1.0 and hard-cuts the scene at worldZ = 1.
let MTLX_SHADOW_OFF_MATRIX = null;
const shadowOffMatrix = () => {
    if (!MTLX_SHADOW_OFF_MATRIX) {
        MTLX_SHADOW_OFF_MATRIX = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
    }
    return MTLX_SHADOW_OFF_MATRIX.clone();
};
const getDummyTexWhite = () => {
    if (!MTLX_DUMMY_TEX_WHITE) {
        MTLX_DUMMY_TEX_WHITE = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
        MTLX_DUMMY_TEX_WHITE.needsUpdate = true;
    }
    return MTLX_DUMMY_TEX_WHITE;
};

// White 1x1x1 volume, so a material whose stage has no baked sky visibility
// still has something to sample. Paired with u_skyVisStrength 0 it is an exact
// no-op, which is what the Material Viewer runs with.
let MTLX_DUMMY_TEX3D_WHITE = null;
const getDummyTex3DWhite = () => {
    if (!MTLX_DUMMY_TEX3D_WHITE && THREE.DataTexture3D) {
        MTLX_DUMMY_TEX3D_WHITE = new THREE.DataTexture3D(new Uint8Array([255]), 1, 1, 1);
        MTLX_DUMMY_TEX3D_WHITE.format = THREE.RedFormat;
        MTLX_DUMMY_TEX3D_WHITE.type = THREE.UnsignedByteType;
        MTLX_DUMMY_TEX3D_WHITE.minFilter = THREE.LinearFilter;
        MTLX_DUMMY_TEX3D_WHITE.magFilter = THREE.LinearFilter;
        MTLX_DUMMY_TEX3D_WHITE.wrapS = THREE.ClampToEdgeWrapping;
        MTLX_DUMMY_TEX3D_WHITE.wrapT = THREE.ClampToEdgeWrapping;
        MTLX_DUMMY_TEX3D_WHITE.wrapR = THREE.ClampToEdgeWrapping;
        MTLX_DUMMY_TEX3D_WHITE.needsUpdate = true;
    }
    return MTLX_DUMMY_TEX3D_WHITE;
};

// Parses a dropped .exr Blob via THREE.EXRLoader (pinned to three@0.147.0,
// see index.html). setDataType(FloatType) is explicit: 0.147.0 defaults to
// HalfFloatType, silently swapping d.data to a Uint16Array otherwise.
const loadExrTexture = async (blob) => {
    if (typeof THREE.EXRLoader === 'undefined') {
        console.warn('mtlx-engine: THREE.EXRLoader unavailable (script blocked/offline); .exr textures keep the node default color.');
        return null;
    }
    try {
        const buf = await blob.arrayBuffer();
        const d = new THREE.EXRLoader().setDataType(THREE.FloatType).parse(buf);
        if (!d || !d.data) return null;
        // EXRLoader.parse writes scanlines bottom-up (row 0 = image bottom);
        // reverse row order so row 0 = top, matching every other loader here.
        const channels = d.data.length / (d.width * d.height);
        const stride = d.width * channels;
        for (let y = 0; y < d.height >> 1; y += 1) {
            const top = y * stride, bottom = (d.height - 1 - y) * stride;
            for (let i = 0; i < stride; i += 1) {
                const t = d.data[top + i];
                d.data[top + i] = d.data[bottom + i];
                d.data[bottom + i] = t;
            }
        }
        const tex = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
        tex.minFilter = tex.magFilter = THREE.LinearFilter;
        return tex;
    } catch (e) {
        console.warn('mtlx-engine: failed to parse dropped .exr texture, keeping the node default color:', e);
        return null;
    }
};

// Parses a dropped .hdr Blob via THREE.RGBELoader's synchronous .parse().
// Explicitly set to FloatType (not the default RGBE byte packing) so the
// MaterialX sampler, which has no RGBE decode step, reads linear values.
const loadHdrTexture = async (blob) => {
    if (typeof THREE.RGBELoader === 'undefined') {
        console.warn('mtlx-engine: THREE.RGBELoader unavailable; .hdr textures keep the node default color.');
        return null;
    }
    try {
        const buf = await blob.arrayBuffer();
        const d = new THREE.RGBELoader().setDataType(THREE.FloatType).parse(buf);
        if (!d || !d.data) return null;
        const tex = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
        tex.minFilter = tex.magFilter = THREE.LinearFilter;
        return tex;
    } catch (e) {
        console.warn('mtlx-engine: failed to parse dropped .hdr texture, keeping the node default color:', e);
        return null;
    }
};

// Compressions UTIF.js actually decodes (see vendor/utif/UTIF.js decode._decompress).
// 32946 (old Deflate) is not in that list but is the same zlib stream as 8,
// so it is remapped below before decodeImage runs.
const UTIF_SUPPORTED_COMPRESSION = new Set([1, 3, 4, 5, 6, 7, 8, 32767, 32773]);

// Parses a dropped .tif/.tiff Blob via UTIF.js into an 8bpc RGBA texture.
// Baseline decode only (8/16-bit, common compressions); exotic TIFFs throw
// so callers can warn instead of silently keeping an all-zero texture.
const loadTifTexture = async (blob, path) => {
    if (typeof UTIF === 'undefined') {
        console.warn('mtlx-engine: UTIF unavailable (script blocked/offline); .tif textures keep the node default color.');
        return null;
    }
    const label = path || '(unknown)';
    const buf = await blob.arrayBuffer();
    const ifds = UTIF.decode(buf);
    if (!ifds || !ifds.length) return null;
    const ifd = ifds[0];
    const compression = ifd.t259 && ifd.t259[0];
    if (compression === 32946) ifd.t259[0] = 8; // old Deflate: same zlib stream, UTIF applies the predictor itself
    UTIF.decodeImage(buf, ifd);
    const rgba = UTIF.toRGBA8(ifd);
    if (!UTIF_SUPPORTED_COMPRESSION.has(compression) && compression !== 32946) {
        throw new Error('TIF decode unsupported (compression ' + compression + ') for ' + label);
    }
    let allZero = true;
    for (let i = 0; i < rgba.length - 2 && allZero; i += 97) {
        if (rgba[i] !== 0 || rgba[i + 1] !== 0 || rgba[i + 2] !== 0) allZero = false;
    }
    if (allZero) throw new Error('TIF decode unsupported (compression ' + compression + ') for ' + label);
    const tex = new THREE.DataTexture(new Uint8Array(rgba), ifd.width, ifd.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    return tex;
};

// Scene snapshots can contain many UDIM tiles.  When a caller supplies a
// preview limit, decode/upload a bounded ImageBitmap while retaining the
// source image's color and alpha semantics.  The normal viewer path does not
// pass this option and keeps its existing TextureLoader behavior.
//
// Fast path (mtlx_scene_texture_fast, default on): reads the source
// dimensions from the file header (no pixel decode) and asks
// createImageBitmap to decode straight to the planned tier in one browser
// -native, off-main-thread call, instead of decoding at full size first just
// to learn the dimensions and then decoding again to resize. Same
// colorSpaceConversion/premultiplyAlpha/resizeQuality semantics as before;
// falls back to the old two-decode path if the header can't be read.
const loadBoundedBitmapTexture = async (blob, maxSize, samplerModes) => {
    if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap is unavailable for bounded scene texture preview');
    addTexturePerf('count', 1);
    const opts = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
    if (sceneTextureFastPathEnabled()) {
        let dims = null;
        try { dims = await readImageDimensions(blob); } catch (e) { dims = null; }
        if (dims && dims.width > 0 && dims.height > 0) {
            const needsResize = maxSize > 0 && Math.max(dims.width, dims.height) > maxSize;
            const decodeOpts = !needsResize ? opts : Object.assign({}, opts, {
                resizeWidth: Math.max(1, Math.round(dims.width * (maxSize / Math.max(dims.width, dims.height)))),
                resizeHeight: Math.max(1, Math.round(dims.height * (maxSize / Math.max(dims.width, dims.height)))),
                resizeQuality: 'high',
            });
            const t0 = performance.now();
            let image = null;
            try { image = await createImageBitmap(blob, decodeOpts); } catch (e) { image = null; }
            if (image) {
                addTexturePerf(needsResize ? 'resizeMs' : 'decodeMs', performance.now() - t0);
                const texture = new THREE.Texture(image);
                configureLoadedTexture(texture);
                // This path ignores samplerModes; the Scene's legacy binds kept that.
                // (r128 textures carry no userData of their own.)
                texture.userData = Object.assign(texture.userData || {}, { mtlxBoundedFastPath: true });
                return texture;
            }
            // Header parsed but the sized decode failed; fall through to the
            // slow path below rather than fail the whole texture.
        }
    }
    const t0 = performance.now();
    let source;
    try { source = await createImageBitmap(blob, opts); }
    catch (error) { throw new Error('The source image could not be decoded for bounded scene preview.'); }
    addTexturePerf('decodeMs', performance.now() - t0);
    let image = source;
    if (maxSize > 0 && Math.max(source.width, source.height) > maxSize) {
        const scale = maxSize / Math.max(source.width, source.height);
        const resizeOpts = Object.assign({}, opts, {
            resizeWidth: Math.max(1, Math.round(source.width * scale)),
            resizeHeight: Math.max(1, Math.round(source.height * scale)),
            resizeQuality: 'high',
        });
        const t1 = performance.now();
        try { image = await createImageBitmap(blob, resizeOpts); }
        catch (error) { if (source.close) source.close(); throw error; }
        addTexturePerf('resizeMs', performance.now() - t1);
        if (source.close) source.close();
    }
    const texture = new THREE.Texture(image);
    configureLoadedTexture(texture, samplerModes);
    return texture;
};

// Reads pixel dimensions straight out of an encoded image blob's header,
// without decoding the pixels. Returns { width, height } or null when the
// format/box cannot be parsed; callers then assume a conservative 4096
// square. Covers PNG, JPEG (SOF0/1/2, skipping APPn/COM segments), TIFF
// (both byte orders, tags 256/257 as SHORT or LONG), OpenEXR (dataWindow
// box2i) and Radiance HDR (the "-Y h +X w" resolution line).
const readImageDimensions = async (blob) => {
    try {
        const buf = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
        if (buf.length < 8) return null;
        // PNG: 8-byte signature, then an IHDR chunk with width/height at a
        // fixed offset (big-endian uint32 each).
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
            const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            if (buf.length >= 24) return { width: dv.getUint32(16), height: dv.getUint32(20) };
            return null;
        }
        // JPEG: walk markers; skip APPn/COM/other segments by their length
        // field, stop at the first SOFn (0..2) marker for width/height.
        if (buf[0] === 0xff && buf[1] === 0xd8) {
            const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            let offset = 2;
            while (offset + 9 < buf.length) {
                if (buf[offset] !== 0xff) { offset += 1; continue; }
                const marker = buf[offset + 1];
                if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
                if (marker === 0xd9) break; // EOI
                const segLen = dv.getUint16(offset + 2);
                if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                    return { height: dv.getUint16(offset + 5), width: dv.getUint16(offset + 7) };
                }
                offset += 2 + segLen;
            }
            return null;
        }
        // KTX2: 12-byte identifier, then a little-endian header:
        // vkFormat(4), typeSize(4), pixelWidth(4), pixelHeight(4), ...
        const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
        if (buf.length >= 44 && KTX2_IDENTIFIER.every((b, i) => buf[i] === b)) {
            const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            return { width: dv.getUint32(20, true), height: dv.getUint32(24, true) };
        }
        // TIFF: byte-order mark, then a 4-byte IFD offset, then the IFD
        // entry count and entries; tags 256 (width) and 257 (height) can be
        // SHORT (3) or LONG (4).
        const isLE = buf[0] === 0x49 && buf[1] === 0x49;
        const isBE = buf[0] === 0x4d && buf[1] === 0x4d;
        if (isLE || isBE) {
            const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            const ifdOffset = dv.getUint32(4, isLE);
            if (ifdOffset + 2 > buf.length) return null;
            const count = dv.getUint16(ifdOffset, isLE);
            let width = null, height = null;
            for (let i = 0; i < count; i += 1) {
                const entryOffset = ifdOffset + 2 + i * 12;
                if (entryOffset + 12 > buf.length) break;
                const tag = dv.getUint16(entryOffset, isLE);
                const type = dv.getUint16(entryOffset + 2, isLE);
                const value = type === 3 ? dv.getUint16(entryOffset + 8, isLE) : dv.getUint32(entryOffset + 8, isLE);
                if (tag === 256) width = value;
                else if (tag === 257) height = value;
            }
            return (width != null && height != null) ? { width, height } : null;
        }
        // OpenEXR: magic 0x76, 0x2f, 0x31, 0x01, then a version int, then a
        // sequence of null-terminated "name/type/size/data" attributes; the
        // dataWindow attribute is a box2i (4 int32: xMin,yMin,xMax,yMax).
        if (buf[0] === 0x76 && buf[1] === 0x2f && buf[2] === 0x31 && buf[3] === 0x01) {
            const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
            let offset = 8;
            const readCString = () => {
                const start = offset;
                while (offset < buf.length && buf[offset] !== 0) offset += 1;
                const str = String.fromCharCode.apply(null, buf.subarray(start, offset));
                offset += 1;
                return str;
            };
            while (offset < buf.length) {
                const name = readCString();
                if (!name) break;
                const type = readCString();
                if (offset + 4 > buf.length) break;
                const size = dv.getUint32(offset, true);
                offset += 4;
                if (name === 'dataWindow' && type === 'box2i' && offset + 16 <= buf.length) {
                    const xMin = dv.getInt32(offset, true), yMin = dv.getInt32(offset + 4, true);
                    const xMax = dv.getInt32(offset + 8, true), yMax = dv.getInt32(offset + 12, true);
                    return { width: xMax - xMin + 1, height: yMax - yMin + 1 };
                }
                offset += size;
            }
            return null;
        }
        // Radiance HDR: text header ending in a blank line, then a
        // resolution line such as "-Y 1024 +X 2048".
        if (buf[0] === 0x23 || String.fromCharCode(buf[0]) === '#') {
            const text = String.fromCharCode.apply(null, buf.subarray(0, Math.min(buf.length, 4096)));
            const m = text.match(/^[-+][XY]\s+(\d+)\s+[-+][XY]\s+(\d+)/m);
            if (m) {
                const first = Number(m[1]), second = Number(m[2]);
                // "-Y h +X w" is the common orientation; a leading X line
                // instead means the numbers are already width then height.
                if (/^-Y|^\+Y/.test(text.match(/^[-+][XY]\s+\d+\s+[-+][XY]\s+\d+/m)[0])) {
                    return { width: second, height: first };
                }
                return { width: first, height: second };
            }
            return null;
        }
        return null;
    } catch (e) { return null; }
};

// Converts a MaterialX default value into a three.js uniform. Returns
// null for types that can't be a plain default (filename/sampler/string).
// `data` should be plain JS already; a live wasm vector is tolerated too.
const mxValueToThreeUniform = (type, data) => {
    const arr = mxDataToPlainArray;
    switch (type) {
        case 'float': { const n = Number(data); return { value: isNaN(n) ? 0 : n }; }
        case 'integer': { const n = Number(data); return { value: isNaN(n) ? 0 : (n | 0) }; }
        case 'boolean': return { value: !!data };
        case 'vector2': { const a = arr(data) || [0, 0]; return { value: new THREE.Vector2(a[0], a[1]) }; }
        case 'color3':
        case 'vector3': { const a = arr(data) || [0, 0, 0]; return { value: new THREE.Vector3(a[0], a[1], a[2]) }; }
        case 'color4':
        case 'vector4': { const a = arr(data) || [0, 0, 0, 0]; return { value: new THREE.Vector4(a[0], a[1], a[2], a[3]) }; }
        case 'matrix33': { const a = arr(data); const m = new THREE.Matrix3(); if (a && a.length === 9) m.fromArray(a); return { value: m }; }
        case 'matrix44': { const a = arr(data); const m = new THREE.Matrix4(); if (a && a.length === 16) m.fromArray(a); return { value: m }; }
        default: return null;
    }
};

// The parameter UI's color picker speaks LINEAR, like MaterialX itself:
// hex bytes map byte/255 onto stored linear values, deliberately NOT an
// sRGB encode, keeps the picker in agreement with the 0-1 RGB spinners.
const linToSrgb = (c) => {
    const x = Math.max(0, Math.min(1, c));
    return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
};
const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const rgbToHex = (rgb) => '#' + rgb.slice(0, 3).map((c) => {
    const h = Math.round(Math.max(0, Math.min(1, Number(c) || 0)) * 255).toString(16);
    return h.length === 1 ? '0' + h : h;
}).join('');
const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

// MaterialXView parity: the generated GLSL takes `defaultval` and never
// reads it, so a filename sampler with no image binds a 1x1 texture of
// that value instead. Shared per value, like the env textures.
const DEFAULT_VALUE_TEXTURES = new Map();
// Membership lives here, not on the texture: r128's Texture has no
// userData (it ends at onUpdate), so tagging one throws.
const DEFAULT_VALUE_TEXTURE_SET = new WeakSet();
const defaultValueToRgba = (type, data) => {
    if (type === 'float') { const n = Number(data); return isNaN(n) ? null : [n, n, n, 1]; }
    const a = mxDataToPlainArray(data);
    if (!a) return null;
    const c = (i) => (Number(a[i]) || 0);
    switch (type) {
        case 'vector2': return [c(0), c(1), 0, 1];
        case 'color3':
        case 'vector3': return [c(0), c(1), c(2), 1];
        case 'color4':
        case 'vector4': return [c(0), c(1), c(2), a[3] == null ? 1 : c(3)];
        default: return null;
    }
};
// Mirrors ImageSamplingProperties::setProperties: strip the sampler's
// trailing `_file` and read the sibling `_default`, or `_default_cm_in`
// when a colorspace on the image node renamed it.
const getFilenameDefaultTexture = (introspected, samplerName) => {
    const cut = samplerName.lastIndexOf('_');
    if (cut <= 0) return null;
    const root = samplerName.slice(0, cut);
    let port = null;
    for (const u of introspected) {
        if (u.name === root + '_default') { port = u; break; }
        if (u.name === root + '_default_cm_in' && !port) port = u;
    }
    if (!port || port.data == null) return null;
    const rgba = defaultValueToRgba(port.type, port.data);
    if (!rgba) return null;
    return defaultValueTexture(rgba);
};
// Upstream's own caveat rides along: the default is assumed to be in the
// missing image's color space already, so nothing transforms it. Tracked
// so a live edit can tell our bake from a real image the user bound.
const defaultValueTexture = (rgba) => {
    const key = rgba.join(',');
    const hit = DEFAULT_VALUE_TEXTURES.get(key);
    if (hit) return hit;
    const t = new THREE.DataTexture(new Float32Array(rgba), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.needsUpdate = true;
    DEFAULT_VALUE_TEXTURE_SET.add(t);
    DEFAULT_VALUE_TEXTURES.set(key, t);
    return t;
};
const isFilenameDefaultTexture = (t) => !!t && DEFAULT_VALUE_TEXTURE_SET.has(t);
// A sampler still showing our bake may be re-baked; one holding a real
// image must not be. Null counts as ours (a node with no default).
const samplerHoldsDefault = (slot) => !!slot && (!slot.value || isFilenameDefaultTexture(slot.value));
// The generated GLSL ignores `defaultval`, so the sampler's 1x1 texture is
// what carries the value: editing a `_default` uniform live has to re-bake
// it. `value` is a plain number or array, not MaterialX heap data.
const rebindFilenameDefault = (uniforms, defaultUniformName, type, value) => {
    const m = /^(.*)_default(?:_cm_in)?$/.exec(defaultUniformName || '');
    if (!m) return false;
    const slot = uniforms ? uniforms[m[1] + '_file'] : null;
    if (!samplerHoldsDefault(slot)) return false;
    const rgba = defaultValueToRgba(type, value);
    if (!rgba) return false;
    slot.value = defaultValueTexture(rgba);
    return true;
};

// Configure a user-loaded texture the way the generated shaders expect
// to sample a `filename` input: repeat wrapping, no flipY, anisotropic
// filtering (three clamps to the device max at upload).
const configureLoadedTexture = (t, samplerModes, anisotropy) => {
    const modes = samplerModes || { u: 'periodic', v: 'periodic' };
    const wrap = (mode) => {
        switch (normalizeSamplerAddressMode(mode)) {
            case 'clamp': return THREE.ClampToEdgeWrapping;
            case 'mirror': return THREE.MirroredRepeatWrapping;
            default: return THREE.RepeatWrapping;
        }
    };
    t.wrapS = wrap(modes.u);
    t.wrapT = wrap(modes.v);
    t.flipY = false;
    t.anisotropy = anisotropy == null ? 8 : anisotropy;
    t.needsUpdate = true;
    return t;
};

// ---- Preview geometry ----
// Aliases three's attributes to MaterialX vertex-shader names, providing
// tangents (real when computable, constant +X fallback otherwise).
// Conventional UV geomprop names aliased to the "uv" attribute so
// geompropvalue(vector2) reads real texcoords instead of zeros.
const UV_GEOMPROP_ALIASES = ['i_geomprop_st', 'i_geomprop_uv', 'i_geomprop_UV0', 'i_geomprop_st0', 'i_geomprop_uv0', 'i_geomprop_map1'];
const aliasUvGeomprops = (geometry) => {
    const uv = geometry.getAttribute('uv');
    if (!uv) return;
    for (const name of UV_GEOMPROP_ALIASES) {
        if (!geometry.getAttribute(name)) geometry.setAttribute(name, uv);
    }
};

const prepGeometry = (geometry) => {
    // Already prepped (e.g. a cached shaderball clone), skip re-running
    // computeTangents only after both members of the tangent frame exist.
    // Older cached/custom geometry may carry i_tangent without the explicit
    // bitangent added by the scene path, so that case is repaired below.
    if (geometry.getAttribute('i_tangent') && geometry.getAttribute('i_bitangent')) {
        aliasUvGeomprops(geometry);
        return geometry;
    }
    aliasUvGeomprops(geometry);
    const position = geometry.getAttribute('position');
    if (!position) return geometry;
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    if (!geometry.getAttribute('uv')) {
        // MaterialX shaders read texcoords; give degenerate UVs
        // rather than an unbound attribute.
        const count = position.count;
        geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    aliasUvGeomprops(geometry);
    geometry.setAttribute('i_position', geometry.getAttribute('position'));
    geometry.setAttribute('i_normal', geometry.getAttribute('normal'));
    geometry.setAttribute('i_texcoord_0', geometry.getAttribute('uv'));
    let iTangent = null, iBitangent = null;
    const normal = geometry.getAttribute('normal');
    const writeFrame = (index, tx, ty, tz, sign, tangentOut, bitangentOut) => {
        let nx = normal.getX(index), ny = normal.getY(index), nz = normal.getZ(index);
        const nlen = Math.hypot(nx, ny, nz);
        if (nlen > 1e-10) { nx /= nlen; ny /= nlen; nz /= nlen; }
        else { nx = 0; ny = 0; nz = 1; }
        const ndot = tx * nx + ty * ny + tz * nz;
        tx -= ndot * nx; ty -= ndot * ny; tz -= ndot * nz;
        let tlen = Math.hypot(tx, ty, tz);
        if (tlen < 1e-10) {
            // Pick an axis least parallel to N, then form an orthogonal T.
            const ax = Math.abs(nx) < 0.9 ? 1 : 0;
            const ay = ax ? 0 : 1;
            tx = ay * nz; ty = ax * nz; tz = -ay * nx - ax * ny;
            tlen = Math.hypot(tx, ty, tz) || 1;
        }
        tx /= tlen; ty /= tlen; tz /= tlen;
        const bx = (ny * tz - nz * ty) * (sign < 0 ? -1 : 1);
        const by = (nz * tx - nx * tz) * (sign < 0 ? -1 : 1);
        const bz = (nx * ty - ny * tx) * (sign < 0 ? -1 : 1);
        tangentOut[index * 3] = tx; tangentOut[index * 3 + 1] = ty; tangentOut[index * 3 + 2] = tz;
        bitangentOut[index * 3] = bx; bitangentOut[index * 3 + 1] = by; bitangentOut[index * 3 + 2] = bz;
    };
    // Prefer Three's source tangent (vec4) when a legacy alias is already
    // present, so its handedness survives repair of the missing bitangent.
    const tangent = geometry.getAttribute('tangent') || geometry.getAttribute('i_tangent');
    if (tangent) {
        // Repair a geometry carrying the legacy 3-component tangent alias.
        // A supplied vec4 tangent retains the authored/Three handedness in w.
        const tangents = new Float32Array(position.count * 3);
        const bitangents = new Float32Array(position.count * 3);
        for (let i = 0; i < position.count; i++) {
            const tx = tangent.getX(i), ty = tangent.getY(i), tz = tangent.getZ(i);
            const sign = tangent.itemSize >= 4 ? (tangent.getW(i) < 0 ? -1 : 1) : 1;
            writeFrame(i, tx, ty, tz, sign, tangents, bitangents);
        }
        iTangent = new THREE.BufferAttribute(tangents, 3);
        iBitangent = new THREE.BufferAttribute(bitangents, 3);
    }
    // r128's computeTangents CONSOLE.ERRORs (not throws) when
    // index/position/normal/uv are missing, precheck so an ineligible
    // geometry goes straight to the fallback without the scary log.
    const canTangent = !!(geometry.getIndex()
        && position
        && normal
        && geometry.getAttribute('uv'));
    if (!iTangent && canTangent) {
        try {
            geometry.computeTangents();
            const t = geometry.getAttribute('tangent'); // vec4 (may be absent on silent failure)
            if (t) {
                const tri = new Float32Array(t.count * 3);
                const signs = new Float32Array(t.count);
                for (let i = 0; i < t.count; i++) {
                    tri[i * 3] = t.getX(i); tri[i * 3 + 1] = t.getY(i); tri[i * 3 + 2] = t.getZ(i);
                    signs[i] = t.itemSize >= 4 && t.getW(i) < 0 ? -1 : 1;
                }
                // Zero-UV-area triangles (and the sphere's poles) leave
                // computeTangents' normalize() dividing by zero, writing a
                // (0,0,0) tangent that NaNs the shader's normalize(i_tangent).
                // Repair those with a tangent orthogonal to the vertex normal.
                const nrm = geometry.getAttribute('normal');
                let repaired = 0;
                for (let i = 0; i < t.count; i++) {
                    const x = tri[i * 3], y = tri[i * 3 + 1], z = tri[i * 3 + 2];
                    if (x * x + y * y + z * z < 1e-10) {
                        const nx = nrm.getX(i), ny = nrm.getY(i), nz = nrm.getZ(i);
                        const ax = Math.abs(nx) < 0.9 ? 1 : 0, ay = ax ? 0 : 1;
                        let cx = -nz * ay, cy = nz * ax, cz = nx * ay - ny * ax;
                        const len = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
                        tri[i * 3] = cx / len; tri[i * 3 + 1] = cy / len; tri[i * 3 + 2] = cz / len;
                        repaired++;
                    }
                }
                if (repaired) console.warn('[mtlx] repaired ' + repaired + ' degenerate tangents (zero-UV-area triangles) on geometry');
                const bitri = new Float32Array(t.count * 3);
                for (let i = 0; i < t.count; i++) writeFrame(i, tri[i * 3], tri[i * 3 + 1], tri[i * 3 + 2], signs[i], tri, bitri);
                iTangent = new THREE.BufferAttribute(tri, 3);
                iBitangent = new THREE.BufferAttribute(bitri, 3);
            }
        } catch (e) { /* fall through to constant tangent */ }
    }
    // Three's computeTangents requires an index. For non-indexed USD meshes,
    // derive a frame directly per triangle so normal maps remain useful and
    // preserve mirrored-UV orientation instead of silently using +X.
    if (!iTangent && !geometry.getIndex() && position.count >= 3) {
        const uv = geometry.getAttribute('uv');
        const tangents = new Float32Array(position.count * 3);
        const bitangents = new Float32Array(position.count * 3);
        for (let base = 0; base + 2 < position.count; base += 3) {
            const ax = position.getX(base + 1) - position.getX(base);
            const ay = position.getY(base + 1) - position.getY(base);
            const az = position.getZ(base + 1) - position.getZ(base);
            const bx = position.getX(base + 2) - position.getX(base);
            const by = position.getY(base + 2) - position.getY(base);
            const bz = position.getZ(base + 2) - position.getZ(base);
            const du1 = uv.getX(base + 1) - uv.getX(base), dv1 = uv.getY(base + 1) - uv.getY(base);
            const du2 = uv.getX(base + 2) - uv.getX(base), dv2 = uv.getY(base + 2) - uv.getY(base);
            const det = du1 * dv2 - du2 * dv1;
            if (Math.abs(det) < 1e-10) continue;
            const inv = 1 / det;
            const tx = (ax * dv2 - bx * dv1) * inv;
            const ty = (ay * dv2 - by * dv1) * inv;
            const tz = (az * dv2 - bz * dv1) * inv;
            const cx = (bx * du1 - ax * du2) * inv;
            const cy = (by * du1 - ay * du2) * inv;
            const cz = (bz * du1 - az * du2) * inv;
            for (let j = 0; j < 3; j++) {
                const i = base + j;
                tangents[i * 3] = tx; tangents[i * 3 + 1] = ty; tangents[i * 3 + 2] = tz;
                bitangents[i * 3] = cx; bitangents[i * 3 + 1] = cy; bitangents[i * 3 + 2] = cz;
            }
        }
        for (let i = 0; i < position.count; i++) {
            const tx = tangents[i * 3], ty = tangents[i * 3 + 1], tz = tangents[i * 3 + 2];
            const nx = normal.getX(i), ny = normal.getY(i), nz = normal.getZ(i);
            const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
            const sign = bx * bitangents[i * 3] + by * bitangents[i * 3 + 1] + bz * bitangents[i * 3 + 2] < 0 ? -1 : 1;
            writeFrame(i, tx, ty, tz, sign, tangents, bitangents);
        }
        iTangent = new THREE.BufferAttribute(tangents, 3);
        iBitangent = new THREE.BufferAttribute(bitangents, 3);
    }
    if (!iTangent) {
        const vcount = position.count;
        const tangents = new Float32Array(vcount * 3);
        const bitangents = new Float32Array(vcount * 3);
        for (let i = 0; i < vcount; i++) {
            writeFrame(i, 1, 0, 0, 1, tangents, bitangents);
        }
        iTangent = new THREE.BufferAttribute(tangents, 3);
        iBitangent = new THREE.BufferAttribute(bitangents, 3);
    }
    geometry.setAttribute('i_tangent', iTangent);
    geometry.setAttribute('i_bitangent', iBitangent);
    return geometry;
};

// Sizes for the geomprop types this viewer can zero-fill. patchGeompropVaryings
// redeclares integer geomprop attributes as float/vecN (rounded back to int
// in the vertex shader), so they land here too and fill like any other stream.
const GEOMPROP_ITEM_SIZE = { float: 1, vec2: 2, vec3: 3, vec4: 4 };
// Binds each declared geompropvalue vertex input that the geometry does not
// already carry: vec2 aliases "uv", every other type (including integer
// geomprops, now reported as float/vecN) gets a zero- or default-filled
// attribute. `notify(text)` receives one notice per unbound geomprop;
// callers dedupe and surface it to the user.
const bindGeompropAttributes = (geometry, geomprops, notify, constants = null) => {
    if (!geometry || !geomprops || !geomprops.length) return geometry;
    const uv = geometry.getAttribute('uv');
    for (const { name, type, defaultValue } of geomprops) {
        const attrName = 'i_geomprop_' + name;
        if (geometry.getAttribute(attrName)) continue;
        if (type === 'vec2' && uv) {
            geometry.setAttribute(attrName, uv);
            continue;
        }
        const itemSize = GEOMPROP_ITEM_SIZE[type];
        // A constant the stage supplied wins, then the node's authored
        // default; only a stream we know nothing about stays at zero.
        const constant = constants && constants[name];
        const fill = Array.isArray(constant) ? constant
            : (Array.isArray(defaultValue) ? defaultValue : null);
        let filled = '';
        if (itemSize) {
            const count = geometry.getAttribute('position') ? geometry.getAttribute('position').count : 0;
            const data = new Float32Array(count * itemSize);
            if (fill && fill.length) {
                for (let i = 0; i < count; i += 1) {
                    for (let c = 0; c < itemSize; c += 1) data[i * itemSize + c] = Number(fill[Math.min(c, fill.length - 1)]) || 0;
                }
                filled = fill.slice(0, itemSize).join(', ');
            }
            geometry.setAttribute(attrName, new THREE.BufferAttribute(data, itemSize));
        }
        if (typeof notify === 'function') {
            notify(filled
                ? `geompropvalue "${name}" (${type}) has no geometry stream in this viewer and reads ${filled}`
                : `geompropvalue "${name}" (${type}) has no geometry stream in this viewer and reads zeros, so this material will not look as authored`);
        }
    }
    return geometry;
};
// Rig lights (fixed) + the active env's extracted key light (rotates
// live), padded to a FIXED length (rig.length + 1) for u_lightData,
// the array length must never change after a program's first bind.
// One LightData entry. Every field the merged struct declares must be
// present on every entry: three reads each declared member by name, so a
// missing one is a bind error rather than a default.
const makeLightEntry = (over) => Object.assign({
    type: 0,
    position: new THREE.Vector3(),
    direction: new THREE.Vector3(0, -1, 0),
    color: new THREE.Vector3(),
    intensity: 0,
    decay_rate: 2,
    inner_angle: 0,
    outer_angle: 0,
    sourceKind: 0,
}, over || {});
// Slot layout is fixed for the life of a program: [rig..., key, stage...].
// The key light keeps index rigCount so updateKeyLightUniformEntry can keep
// mutating it in place, and the stage lights occupy the reserved tail.
// envScale is u_envLightIntensity. The key light is energy SPLIT OUT of the
// environment map (extractKeyLight replaces the sun cluster with the local
// mean), so it has to carry the same gain as the map it came from; without it
// the sun and the sky drift apart by exactly the dome's intensity whenever
// that is not 1, which reads as one blown highlight over a correct scene.
// maxLights is the material's own MAX_LIGHT_SOURCES (see the light-limit
// tiers); absent, the full rig + key + stage reservation applies.
const currentLights = (rigLights, keyLight, rotRad, stageLights, envScale, lightScales = null, maxLights = null, envTilt = null) => {
    const rig = rigLights || [];
    const total = Number.isFinite(maxLights) && maxLights > rig.length
        ? maxLights : rig.length + 1 + STAGE_LIGHT_SLOTS;
    const stage = (stageLights || []).slice(0, Math.max(0, total - rig.length - 1));
    const out = rig.map((l) => makeLightEntry({
        type: l.type, direction: l.direction.clone(), color: l.color.clone(), intensity: l.intensity,
    }));
    if (keyLight) {
        out.push(makeLightEntry({
            type: LIGHT_TYPE_DIRECTIONAL,
            direction: keyLight.direction.clone().applyMatrix4(keyLightRotationMatrix(rotRad || 0, envTilt)),
            color: new THREE.Vector3(keyLight.color[0], keyLight.color[1], keyLight.color[2]),
            intensity: keyLight.intensity * (Number.isFinite(envScale) ? envScale : 1),
        }));
    } else {
        out.push(makeLightEntry({ type: LIGHT_TYPE_DIRECTIONAL }));
    }
    for (const l of stage) out.push(makeLightEntry(l));
    // The array length must equal MAX_LIGHT_SOURCES exactly; three walks
    // every declared index and an absent element throws.
    while (out.length < total) out.push(makeLightEntry());
    // Scene diagnostics may isolate one direct source without changing the
    // fixed slot layout. Absent scales preserve the ordinary lighting path.
    if (lightScales) {
        for (let i = 0; i < out.length; i++) {
            const scale = Number(lightScales[i]);
            out[i].intensity *= Number.isFinite(scale) ? Math.max(0, scale) : 1;
        }
    }
    return out;
};
// Slots actually evaluated. Stage lights sit past the key slot, so reaching
// them means counting it too; an unused key slot is inert (intensity 0).
const activeLightCount = (rigLights, keyLight, stageLights, maxLights = null) => {
    const rigCount = (rigLights || []).length;
    const slots = Number.isFinite(maxLights) && maxLights > rigCount
        ? maxLights - rigCount - 1 : STAGE_LIGHT_SLOTS;
    const stageCount = Math.min((stageLights || []).length, Math.max(0, slots));
    if (stageCount) return rigCount + 1 + stageCount;
    return rigCount + (keyLight ? 1 : 0);
};

// The radiance sampler the SHADING path binds. The backdrop, the PMREM
// probe and the key-light extraction all keep using env.radiance: only the
// specular lookup wants the prefiltered chain, and only when the shader was
// generated for it.
const envRadianceForShading = (env) => {
    if (!env) return null;
    if (getSpecularEnvMethod() === 'prefilter' && env.radiancePrefiltered) return env.radiancePrefiltered;
    return env.radiance;
};

// The irradiance sampler the SHADING path binds. env.irradiance (the SH
// map) always exists and is the fallback; env.irradianceConvolved only
// exists once ensureConvolvedIrradiance has succeeded on a WebGL2 renderer
// with the 'convolve' switch active.
const envIrradianceForShading = (env, method) => {
    if (!env) return null;
    if ((method || getDiffuseEnvMethod()) === 'convolve' && env.irradianceConvolved) return env.irradianceConvolved;
    return env.irradiance;
};

// Create a detached uniform map for one scene object. Every call returns a
// fresh map, so meshes may share the compiled Three.js program while retaining
// independent world/normal matrices and MaterialX values.
// Binds env radiance/irradiance to every declared sampler matching env
// naming; skips u_localEnv* (bound separately, gated by strength). Shared
// by createMtlxSceneUniforms and the Material Viewer's setEnvironment.
const bindEnvironmentSamplers = (uniforms, declared, env, diffuseMethod) => {
    const has = (name) => declared.some((u) => u.name === name);
    const radiance = envRadianceForShading(env) || getDummyTex();
    const irradiance = envIrradianceForShading(env, diffuseMethod) || radiance;
    if (has('u_envRadiance')) uniforms.u_envRadiance = { value: radiance };
    if (has('u_envIrradiance')) uniforms.u_envIrradiance = { value: irradiance };
    for (const u of declared) {
        if (!/sampler/i.test(u.type) || !/env/i.test(u.name) || /^u_localEnv/.test(u.name)) continue;
        // "u_envIrradiance" contains "radiance", so the irradiance test
        // must run first or the diffuse term binds the sharp radiance map.
        if (/irradiance|diffuse/i.test(u.name)) uniforms[u.name] = { value: irradiance };
        else if (/radiance|specular|prefilter/i.test(u.name)) uniforms[u.name] = { value: radiance };
    }
    return { radiance, irradiance };
};

const createMtlxSceneUniforms = ({ compiled, env = null, lightData = [], stageLights = null, shadowMap = null, shadowMatrix = null, ssaoMap = null, ssaoTexel = null, ssaoStrength = 1, thicknessMap = null, thicknessTexel = null, thicknessScale = 1, refractionTwoSided = false, sceneRadius = 1, envTilt = null, envRotationRad = 0, envExposure = 1, environmentIndirectScale = 1, environmentKeyScale = 1, lightScales = null, shadowDiagnosticVisibilityScale = 1, displayTransform = null, shadowAtlas = null, shadowMatrices = null, shadowTiles = null, shadowDepthPlanes = null, shadowDepthRanges = null, shadowSourceRadii = null, shadowTexelSizes = null, shadowFaceOrigins = null, shadowFaceValid = null, shadowFaceBasisX = null, shadowFaceBasisY = null, shadowFaceBasisZ = null, shadowSlotFace = null, shadowSlotFaceCount = null, shadowTransmittance = null, shadowRecordCells = null, skyVisMap = null, skyVisMin = null, skyVisSize = null, skyVisStrength = 1, skyVisCell = 0,
    aoVolumeMap = null, aoVolumeMin = null, aoVolumeSize = null, aoVolumeStrength = 1, aoVolumeCell = 0,
    skyBounceMap = null, skyBounceMin = null, skyBounceSize = null, skyBounceStrength = 0, skyBounceCell = 0, bounceScale = 0, bounceTint = null,
    localEnvMap = null, localEnvMips = 1, localEnvStrength = 0, localEnvProbe = null, localEnvBoxMin = null, localEnvBoxMax = null, localEnvParallax = 0, diffuseEnvMethod = null, displayExposureScaleOverride = null }) => {
    if (!compiled) throw new Error('Cannot create scene uniforms without compiled MaterialX source.');
    // Face arrays follow the generated size (sceneFeatureOptions.shadowFaceSlots).
    const faceSlots = compiled.shadowFaceSlots || SHADOW_FACE_SLOTS;
    const uniforms = {
        u_worldMatrix: { value: new THREE.Matrix4() },
        u_viewProjectionMatrix: { value: new THREE.Matrix4() },
        u_worldInverseTransposeMatrix: { value: new THREE.Matrix4() },
        u_viewPosition: { value: new THREE.Vector3() },
        u_peelMode: { value: 0 },
        u_peelHasPrev: { value: 0 },
        u_peelPrevDepth: { value: getDummyTex() },
        u_opaqueDepth: { value: getDummyTexWhite() },
        u_peelLinear: { value: 0 },
        // Injected by encodeDisplay, so these are never in MaterialX's own
        // introspection and cannot be gated on has() like the rest. The
        // transform defaults to the caller's, letting the Scene run a filmic
        // curve while the Material Viewer stays on plain sRGB for parity.
        u_displayExposure: { value: displayExposureScaleOverride != null ? displayExposureScaleOverride : displayExposureScale() },
        u_displayTransform: { value: displayTransformId(displayTransform || getDisplayTransform()) },
    };
    // A feature this source never generated declares no uniform for it, so
    // seeding one would only allocate. featureSkips carries what was gated
    // out, which has()/parseUniforms cannot see for a highp sampler3D.
    const featureSkips = (compiled && compiled.featureSkips) || {};
    if (!featureSkips.shadowMap) Object.assign(uniforms, {
        // Shadow atlas. Seeded whenever the source carries shadow sampling,
        // for the same sampler-unit reason as the sky volume below, and
        // defaulted to "no caster on any slot": an exact no-op.
        u_shadowAtlas: { value: shadowAtlas || getDummyTexWhite() },
        u_shadowMatrices: { value: shadowMatrices && shadowMatrices.length === faceSlots
            ? shadowMatrices : Array.from({ length: faceSlots }, () => new THREE.Matrix4()) },
        u_shadowTiles: { value: shadowTiles && shadowTiles.length === faceSlots
            ? shadowTiles : Array.from({ length: faceSlots }, () => new THREE.Vector4(0, 0, 1, 1)) },
        u_shadowDepthPlanes: { value: shadowDepthPlanes && shadowDepthPlanes.length === faceSlots
            ? shadowDepthPlanes : Array.from({ length: faceSlots }, () => new THREE.Vector4(0, 0, 0, 1)) },
        u_shadowDepthRanges: { value: shadowDepthRanges && shadowDepthRanges.length === faceSlots
            ? shadowDepthRanges : Array.from({ length: faceSlots }, () => new THREE.Vector2(0, 1)) },
        u_shadowSourceRadii: { value: shadowSourceRadii && shadowSourceRadii.length === faceSlots
            ? shadowSourceRadii : Array.from({ length: faceSlots }, () => new THREE.Vector4()) },
        u_shadowTexelWorldSize: { value: shadowTexelSizes && shadowTexelSizes.length === faceSlots
            ? shadowTexelSizes : new Array(faceSlots).fill(0) },
        // Light position for a cube-group face, and whether a face actually
        // holds rendered data (the renderer always reserves six per group,
        // but only allocates a cell where geometry actually falls in it).
        u_shadowFaceOrigin: { value: shadowFaceOrigins && shadowFaceOrigins.length === faceSlots
            ? shadowFaceOrigins : Array.from({ length: faceSlots }, () => new THREE.Vector3()) },
        u_shadowFaceValid: { value: shadowFaceValid && shadowFaceValid.length === faceSlots
            ? shadowFaceValid : new Array(faceSlots).fill(0) },
        u_shadowFaceBasisX: { value: shadowFaceBasisX && shadowFaceBasisX.length === faceSlots
            ? shadowFaceBasisX : Array.from({ length: faceSlots }, () => new THREE.Vector3(1, 0, 0)) },
        u_shadowFaceBasisY: { value: shadowFaceBasisY && shadowFaceBasisY.length === faceSlots
            ? shadowFaceBasisY : Array.from({ length: faceSlots }, () => new THREE.Vector3(0, 1, 0)) },
        u_shadowFaceBasisZ: { value: shadowFaceBasisZ && shadowFaceBasisZ.length === faceSlots
            ? shadowFaceBasisZ : Array.from({ length: faceSlots }, () => new THREE.Vector3(0, 0, 1)) },
        // Cloned, not aliased: applyShadowMatrix() writes into this uniform's
        // own array in place, and a diagnostic swap must never corrupt the
        // renderer's live shadowSlotFace/shadowSlotFaceCount state.
        u_shadowSlotFace: { value: shadowSlotFace && shadowSlotFace.length === SHADOW_LIGHT_SLOTS_MAX
            ? new Int32Array(shadowSlotFace) : new Int32Array(SHADOW_LIGHT_SLOTS_MAX).fill(-1) },
        u_shadowSlotFaceCount: { value: shadowSlotFaceCount && shadowSlotFaceCount.length === SHADOW_LIGHT_SLOTS_MAX
            ? new Int32Array(shadowSlotFaceCount) : new Int32Array(SHADOW_LIGHT_SLOTS_MAX).fill(0) },
        u_shadowDiagnosticVisibilityScale: { value: Number.isFinite(Number(shadowDiagnosticVisibilityScale))
            ? Math.max(0, Number(shadowDiagnosticVisibilityScale)) : 1 },
    });
    if (!featureSkips.occlusion) Object.assign(uniforms, {
        // Baked sky visibility. Seeded whenever the occlusion block was
        // generated, NOT through has(): parseUniforms' regex has no room for
        // a precision qualifier, so `uniform highp sampler3D` is invisible.
        // An unseeded sampler sits on texture unit 0 next to a sampler2D, and
        // ANGLE then rejects the entire draw with "Two textures of different
        // types use the same sampler location": the scene renders nothing.
        // A white 1x1x1 volume at strength 0 is an exact no-op.
        u_skyVisMap: { value: skyVisMap || getDummyTex3DWhite() },
        u_skyVisMin: { value: skyVisMin ? skyVisMin.clone() : new THREE.Vector3() },
        u_skyVisSize: { value: skyVisSize ? skyVisSize.clone() : new THREE.Vector3(1, 1, 1) },
        u_skyVisCell: { value: skyVisCell || 0 },
        u_skyVisStrength: { value: skyVisMap ? skyVisStrength : 0 },
        // Baked occlusion volume, same sampler-unit hazard as u_skyVisMap
        // above: a highp sampler3D is invisible to has()/parseUniforms, so
        // this is seeded alongside it. White at strength 0: no-op.
        u_aoVolumeMap: { value: aoVolumeMap || getDummyTex3DWhite() },
        u_aoVolumeMin: { value: aoVolumeMin ? aoVolumeMin.clone() : new THREE.Vector3() },
        u_aoVolumeSize: { value: aoVolumeSize ? aoVolumeSize.clone() : new THREE.Vector3(1, 1, 1) },
        u_aoVolumeCell: { value: aoVolumeCell || 0 },
        u_aoVolumeStrength: { value: aoVolumeMap ? aoVolumeStrength : 0 },
    });
    // Baked diffuse bounce is patched in independently of the
    // occlusion gate, so it is seeded whatever that gate did.
    Object.assign(uniforms, {
        // Baked diffuse bounce, same sampler-unit hazard as the two volumes
        // above: seeded unconditionally. Default value is irrelevant at
        // strength 0 (the additive term early-returns), so this reuses the
        // same dummy white volume rather than allocating a second one.
        u_skyBounceMap: { value: skyBounceMap || getDummyTex3DWhite() },
        u_skyBounceMin: { value: skyBounceMin ? skyBounceMin.clone() : new THREE.Vector3() },
        u_skyBounceSize: { value: skyBounceSize ? skyBounceSize.clone() : new THREE.Vector3(1, 1, 1) },
        u_skyBounceCell: { value: skyBounceCell || 0 },
        u_skyBounceStrength: { value: skyBounceMap ? skyBounceStrength : 0 },
        // Denormalizes the baked scalar SH1 encoding and reintroduces the
        // blockers' mean chroma (see patchDiffuseBounceAdd, shadeBounce in
        // js/usd-scene-skyvis.js): scale 0 is an exact no-op regardless of
        // strength or the baked volume's readiness.
        u_bounceScale: { value: Number.isFinite(bounceScale) ? Math.max(0, bounceScale) : 0 },
        u_bounceTint: { value: bounceTint ? bounceTint.clone() : new THREE.Vector3(1, 1, 1) },
    
    });
    if (compiled.payloadSupported) {
        // Scene RGB-T is opt-in at compile time and remains inactive until
        // the compositor sets these selectors.
        uniforms.u_peelRgbt = { value: 0 };
        uniforms.u_peelRgbtPass = { value: 0 };
        uniforms.u_peelRgbtLayer = { value: 0 };
    }
    applyIntrospectedUniformDefaults(uniforms, compiled.introspected || []);
    // Some callers (the Material Viewer's preview sources) never carry a
    // pre-parsed `declared` list, so fall back to parsing the generated
    // source directly; the Scene always passes `declared`.
    const declaredList = compiled.declared
        || parseUniforms(compiled.fs || '').concat(parseUniforms(compiled.vs || ''));
    const declared = new Set(declaredList.map((u) => u.name));
    const has = (name) => declared.has(name);
    const mips = env && env.mips != null ? env.mips : 1;
    if (has('u_time')) uniforms.u_time = { value: host.clock().time };
    if (has('u_frame')) uniforms.u_frame = { value: host.clock().frame };
    bindEnvironmentSamplers(uniforms, declaredList, env, diffuseEnvMethod);
    // envTilt: a dome light's orientation with its yaw factored out (the slider
    // owns the yaw). u_envMatrix is world to lat-long, so it carries the inverse.
    if (has('u_envMatrix')) {
        uniforms.u_envMatrix = { value: envTilt ? host.envLookupMatrix(envRotationRad, envTilt) : new THREE.Matrix4().makeRotationY(Math.PI / 2 + envRotationRad) };
    }
    if (has('u_envRadianceMips')) uniforms.u_envRadianceMips = { value: mips };
    if (has('u_envRadianceSamples')) uniforms.u_envRadianceSamples = { value: 16 };
    if (has('u_envLightIntensity')) uniforms.u_envLightIntensity = { value: envExposure * Math.max(0, Number(environmentIndirectScale) || 0) };
    // White moments read as fully lit, so materials are unaffected until a
    // real shadow map is bound. MaterialX applies the *0.5+0.5 itself, so the
    // matrix here is a raw world-to-light-clip transform. A white AO map at
    // strength 0 and a white transmittance record (an empty cell's clear
    // color, see mx_shadow_transmittance) are exact no-ops the same way.
    if (has('u_shadowTransmittance')) uniforms.u_shadowTransmittance = { value: shadowTransmittance || getDummyTexWhite() };
    if (has('u_shadowRecordCells')) {
        uniforms.u_shadowRecordCells = { value: shadowRecordCells && shadowRecordCells.length === faceSlots
            ? shadowRecordCells : Array.from({ length: faceSlots }, () => new THREE.Vector4(0, 0, 0, 0)) };
    }
    // Local environment reflections: a plain sampler2D, visible to has()
    // unlike the sampler3D volumes above, so this stays gated exactly like
    // u_ssaoMap. White at strength 0 (or coverage 0, see mx_local_env_mix's
    // own early return) is an exact no-op.
    if (has('u_localEnvRadiance')) uniforms.u_localEnvRadiance = { value: localEnvMap || getDummyTexWhite() };
    if (has('u_localEnvMips')) uniforms.u_localEnvMips = { value: Number.isFinite(localEnvMips) ? localEnvMips : 1 };
    if (has('u_localEnvStrength')) uniforms.u_localEnvStrength = { value: localEnvMap ? localEnvStrength : 0 };
    if (has('u_localEnvProbe')) uniforms.u_localEnvProbe = { value: localEnvProbe ? localEnvProbe.clone() : new THREE.Vector3() };
    if (has('u_localEnvBoxMin')) uniforms.u_localEnvBoxMin = { value: localEnvBoxMin ? localEnvBoxMin.clone() : new THREE.Vector3() };
    if (has('u_localEnvBoxMax')) uniforms.u_localEnvBoxMax = { value: localEnvBoxMax ? localEnvBoxMax.clone() : new THREE.Vector3() };
    if (has('u_localEnvParallax')) uniforms.u_localEnvParallax = { value: localEnvParallax ? 1 : 0 };
    if (has('u_ssaoMap')) uniforms.u_ssaoMap = { value: ssaoMap || getDummyTexWhite() };
    if (has('u_ssaoTexel')) uniforms.u_ssaoTexel = { value: ssaoTexel ? ssaoTexel.clone() : new THREE.Vector2() };
    if (has('u_ssaoStrength')) uniforms.u_ssaoStrength = { value: ssaoMap ? ssaoStrength : 0 };
    // Zero scale means zero path length, which is clear glass: the safe
    // reading when no back-face pass has run.
    if (has('u_thicknessMap')) uniforms.u_thicknessMap = { value: thicknessMap || getDummyTex() };
    if (has('u_thicknessTexel')) uniforms.u_thicknessTexel = { value: thicknessTexel ? thicknessTexel.clone() : new THREE.Vector2() };
    if (has('u_thicknessScale')) uniforms.u_thicknessScale = { value: thicknessMap ? thicknessScale : 0 };
    if (has('u_thicknessTargetValid')) uniforms.u_thicknessTargetValid = { value: thicknessMap ? 1 : 0 };
    if (has('u_thicknessReferencePath')) {
        // With u_thicknessMap dropped for the budget the per-frame target
        // update never runs, so seed the authored transmission_depth as the
        // permanent fallback path rather than a lit-as-clear 0.
        const authored = Number(uniforms.transmission_depth && uniforms.transmission_depth.value);
        uniforms.u_thicknessReferencePath = { value: has('u_thicknessMap') ? 0
            : (Number.isFinite(authored) && authored > 0 ? authored : 0) };
    }
    // Squares the tint for a closed solid, where the ray crosses the surface
    // twice. MaterialXView sets this from the geometry; a USD stage's
    // transmissive props are solids, so this follows the peel state.
    if (has('u_refractionTwoSided')) uniforms.u_refractionTwoSided = { value: !!refractionTwoSided };
    // mx_scene_refraction: u_opaqueColor/Levels bind per peel pass like
    // u_opaqueDepth (white default is an inert no-op); u_peelRefractsScene
    // starts off until applyThickness classifies a real thickness source.
    if (has('u_opaqueColor')) uniforms.u_opaqueColor = { value: getDummyTexWhite() };
    if (has('u_opaqueColorLevels')) uniforms.u_opaqueColorLevels = { value: 0 };
    if (has('u_peelRefractsScene')) uniforms.u_peelRefractsScene = { value: 0 };
    if (has('u_sceneRadius')) uniforms.u_sceneRadius = { value: Math.max(0, Number(sceneRadius) || 0) };
    // Screen-space reflections: off until the renderer's per-frame history
    // is valid (see applySsrHistory in js/usd-scene-renderer.js).
    if (has('u_ssrEnabled')) uniforms.u_ssrEnabled = { value: 0 };
    if (has('u_ssrStrength')) uniforms.u_ssrStrength = { value: 1 };
    if (has('u_ssrMaxRoughness')) uniforms.u_ssrMaxRoughness = { value: 0.5 };
    if (has('u_historyViewProjectionMatrix')) uniforms.u_historyViewProjectionMatrix = { value: new THREE.Matrix4() };
    if (has('u_historyViewProjectionInverseMatrix')) uniforms.u_historyViewProjectionInverseMatrix = { value: new THREE.Matrix4() };
    if (has('u_historyViewPosition')) uniforms.u_historyViewPosition = { value: new THREE.Vector3() };
    if (has('u_viewProjectionInverseMatrix')) uniforms.u_viewProjectionInverseMatrix = { value: new THREE.Matrix4() };
    if (has('u_shadowMap')) uniforms.u_shadowMap = { value: shadowMap || getDummyTexWhite() };
    if (has('u_shadowMatrix')) uniforms.u_shadowMatrix = { value: shadowMatrix ? shadowMatrix.clone() : shadowOffMatrix() };
    if (has('u_lightData')) {
        const entries = currentLights(lightData, env && env.keyLight, envRotationRad, stageLights,
            envExposure * Math.max(0, Number(environmentKeyScale) || 0), lightScales, compiled.maxLights, envTilt);
        uniforms.u_lightData = { value: entries };
    }
    if (has('u_numActiveLightSources')) uniforms.u_numActiveLightSources = { value: activeLightCount(lightData, env && env.keyLight, stageLights, compiled.maxLights) };
    return uniforms;
};

// ------------------------------------------------------------------
// applyIntrospectedUniformDefaults: uploads MaterialX's introspected
// defaults onto a three.js uniforms map. overwrite=false (view creation)
// skips explicit bindings and no-default entries; overwrite=true (fast-
// refresh) overwrites PublicUniforms only, in place, never PrivateUniforms.
// ------------------------------------------------------------------
const PREVIEW_TRANSFORM_UNIFORM_NAMES = new Set([
    'u_worldMatrix', 'u_viewProjectionMatrix', 'u_worldInverseTransposeMatrix', 'u_viewPosition',
]);
const applyIntrospectedUniformDefaults = (uniforms, introspected, { overwrite = false } = {}) => {
    if (!overwrite) {
        for (const u of introspected) {
            if (uniforms[u.name] || u.data == null) continue; // explicit bindings win; no default → leave for WebGL 0
            const tu = mxValueToThreeUniform(u.type, u.data);
            if (tu) uniforms[u.name] = tu;
        }
        // A filename sampler with no image samples a 1x1 texture of the
        // node's `default` input; null (three's empty texture, so black)
        // only when codegen published no default for it.
        for (const u of introspected) {
            if (u.type === 'filename' && !uniforms[u.name]) {
                uniforms[u.name] = { value: getFilenameDefaultTexture(introspected, u.name) };
            }
        }
        return;
    }
    // Fast-refresh: same values just recomputed from a re-generated
    // (but byte-identical-source) shader, overwrite in place.
    for (const u of introspected) {
        // ONLY the public block: PrivateUniforms (transforms, env,
        // lights) was bound at creation and must never be clobbered,
        // some defaults are non-null (u_numActiveLightSources=0 kills lights).
        if (u.block !== 'PublicUniforms') continue;
        if (u.data == null) continue;
        if (u.type === 'filename') continue;
        // Belt-and-suspenders: the transforms are private-block (so the
        // block guard above already skips them), but they're the one
        // thing that would visibly break every frame if ever touched.
        if (PREVIEW_TRANSFORM_UNIFORM_NAMES.has(u.name)) continue;
        const tu = mxValueToThreeUniform(u.type, u.data);
        if (!tu) continue;
        if (uniforms[u.name]) uniforms[u.name].value = tu.value;
        else uniforms[u.name] = tu;
    }
    // Fast-refresh keeps the live sampler bindings, so a `default` that
    // changed has to re-bake its 1x1 texture here as well.
    for (const u of introspected) {
        if (u.type !== 'filename') continue;
        const slot = uniforms[u.name];
        if (!samplerHoldsDefault(slot)) continue;
        slot.value = getFilenameDefaultTexture(introspected, u.name);
    }
};

// Per-frame transform uniforms, shared so the page and the worker agree.
const updateTransformUniforms = (uniforms, mesh, camera) => {
    mesh.updateMatrixWorld();
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    uniforms.u_worldMatrix.value.copy(mesh.matrixWorld);
    uniforms.u_viewProjectionMatrix.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    uniforms.u_worldInverseTransposeMatrix.value
        .copy(mesh.matrixWorld).invert().transpose();
    camera.getWorldPosition(uniforms.u_viewPosition.value);
};

// The sidebar and thumbnail preview material: one construction for both.
const createPreviewMaterial = (srcs, uniforms) => new THREE.RawShaderMaterial({
    vertexShader: srcs.vs,
    fragmentShader: srcs.fs,
    glslVersion: THREE.GLSL3,
    uniforms,
    side: THREE.DoubleSide,
    // Neutral literals: the caller's render-mode sync is the real source of truth.
    transparent: false,
    depthWrite: true,
});

// The fixed orthographic camera of the flat 2D (buffer2d) view.
const createFlat2dCamera = () => {
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
    camera.position.set(0, 0, 1);
    return camera;
};

globalThis.MtlxThreeMaterial = {
    setHost, hostSnapshot, setHostFromSnapshot, createFlat2dCamera, createPreviewMaterial,
    getDummyTex,
    shadowOffMatrix,
    getDummyTexWhite,
    getDummyTex3DWhite,
    loadExrTexture,
    loadHdrTexture,
    UTIF_SUPPORTED_COMPRESSION,
    loadTifTexture,
    loadBoundedBitmapTexture,
    readImageDimensions,
    mxValueToThreeUniform,
    linToSrgb,
    srgbToLin,
    rgbToHex,
    hexToRgb,
    DEFAULT_VALUE_TEXTURES,
    DEFAULT_VALUE_TEXTURE_SET,
    defaultValueToRgba,
    getFilenameDefaultTexture,
    defaultValueTexture,
    isFilenameDefaultTexture,
    samplerHoldsDefault,
    rebindFilenameDefault,
    configureLoadedTexture,
    UV_GEOMPROP_ALIASES,
    aliasUvGeomprops,
    prepGeometry,
    GEOMPROP_ITEM_SIZE,
    bindGeompropAttributes,
    makeLightEntry,
    currentLights,
    activeLightCount,
    envRadianceForShading,
    envIrradianceForShading,
    bindEnvironmentSamplers,
    createMtlxSceneUniforms,
    PREVIEW_TRANSFORM_UNIFORM_NAMES,
    applyIntrospectedUniformDefaults,
    updateTransformUniforms,
};
})();
