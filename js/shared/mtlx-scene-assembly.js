// mtlx-scene-assembly.js, environment preparation shared by the page and the
// thumbnail worker: equirect prep, SH irradiance, key-light extraction and the
// GGX prefilter / irradiance convolution. THREE is a bare global read at call
// time. Load after mtlx-gen-core.js and mtlx-three-material.js.
(() => {
const { mtlxWarn, TONE_CURVE_GLSL } = MtlxGenCore;
const { envRadianceForShading, envIrradianceForShading, prepGeometry } = MtlxThreeMaterial;

// Host providers, each read lazily at the call site. Defaults are the
// behaviour of a page with no overrides; the engine installs real readers.
const HOST_DEFAULTS = {
    specularEnvMethod: () => 'prefilter',
    diffuseEnvMethod: () => 'convolve',
    keyLightEnabled: () => true,
    legacyPrefilterLatch: () => false,
    perfLog: () => false,
};
// All hooks are plain data, so a worker can mirror the page.
const SNAPSHOT_HOOKS = Object.keys(HOST_DEFAULTS);
const host = Object.assign({}, HOST_DEFAULTS);
const setHost = (providers) => {
    for (const k of Object.keys(providers || {})) {
        if (!(k in HOST_DEFAULTS)) throw new Error('MtlxSceneAssembly.setHost: unknown hook ' + k);
        if (typeof providers[k] !== 'function') throw new Error('MtlxSceneAssembly.setHost: hook ' + k + ' must be a function');
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
const getSpecularEnvMethod = () => host.specularEnvMethod();
const getDiffuseEnvMethod = () => host.diffuseEnvMethod();

// Synthesizes a small equirect environment (LDR, filter/mip-safe): a
// sky-to-ground gradient with a soft overhead "sun" for speculars.
// Keeps the viewer self-contained when no HDR is loaded.
const makeEnvTexture = (w, h, blurred) => {
    const data = new Uint8Array(w * h * 4);
    const sky = [150, 190, 235], horizon = [225, 225, 220], ground = [70, 66, 60];
    for (let y = 0; y < h; y++) {
        const v = y / (h - 1);                     // 0 top .. 1 bottom
        for (let x = 0; x < w; x++) {
            let r, g, b;
            if (v < 0.5) {
                const t = v / 0.5;
                r = sky[0] + (horizon[0] - sky[0]) * t;
                g = sky[1] + (horizon[1] - sky[1]) * t;
                b = sky[2] + (horizon[2] - sky[2]) * t;
            } else {
                const t = (v - 0.5) / 0.5;
                r = horizon[0] + (ground[0] - horizon[0]) * t;
                g = horizon[1] + (ground[1] - horizon[1]) * t;
                b = horizon[2] + (ground[2] - horizon[2]) * t;
            }
            if (!blurred) {
                // soft sun highlight near the top-center
                const u = x / (w - 1);
                const d = Math.hypot((u - 0.5), (v - 0.18));
                const sun = Math.max(0, 1 - d / 0.16);
                const s = sun * sun * 255;
                r = Math.min(255, r + s); g = Math.min(255, g + s); b = Math.min(255, b + s);
            }
            const i = (y * w + x) * 4;
            data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255;
        }
    }
    const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
    // Equirect mapping is irrelevant to the IBL sampler; the skybox gets
    // its own copy via makeBackgroundTexture (see env-prep header above).
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = blurred ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = !blurred;
    tex.needsUpdate = true;
    return tex;
};

// ---- Environment preparation: OFFICIAL VIEWER PARITY ----
// Conventions (see also makeBackgroundTexture, shIrradianceFromEquirect,
// BG_BASE/BG_SIGN): MaterialX latlong has v=0 at +Y (u=atan2(x,-z)/2PI+0.5);
// three's SphereGeometry/equirectUv put +Y at the OPPOSITE end of V, so a
// three-sampled texture always needs the opposite flipY of a MaterialX-
// sampled one. EXR decodes rows bottom-first, RGBE top-first,
// parseEnvBuffer normalizes both via flipY. Mips are essential (FIS
// specular LOD), padToRGBA fixes RGBELoader's un-mippable RGB16F while preserving flipY.
const padToRGBA = (tex) => {
    const img = tex.image;
    if (!img || !img.data) return tex;
    const n = img.width * img.height;
    if (img.data.length >= n * 4) return tex; // already RGBA
    const C = img.data.constructor;
    const out = new C(n * 4);
    const one = (C === Uint16Array) ? 0x3C00 /* half 1.0 */ : 1.0;
    for (let i = 0; i < n; i++) {
        out[i * 4] = img.data[i * 3];
        out[i * 4 + 1] = img.data[i * 3 + 1];
        out[i * 4 + 2] = img.data[i * 3 + 2];
        out[i * 4 + 3] = one;
    }
    const t = new THREE.DataTexture(out, img.width, img.height, THREE.RGBAFormat, tex.type);
    t.flipY = tex.flipY;
    return t;
};
const prepareEnv = (tex) => {
    const t = padToRGBA(tex);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8; // three clamps to the device max at upload
    t.encoding = THREE.LinearEncoding;
    t.needsUpdate = true;
    return t;
};
// Builds the skybox mesh's visible backdrop from a prepared radiance
// texture, separate from the IBL sampler because MaterialX and three's
// sphere put +Y at opposite ends of V (env-prep header): inverse flipY.
const makeBackgroundTexture = (src) => {
    const img = src.image;
    const bg = new THREE.DataTexture(img.data, img.width, img.height, src.format, src.type);
    bg.flipY = !src.flipY; // skybox sphere needs the opposite V orientation of the IBL texture
    bg.mapping = THREE.EquirectangularReflectionMapping;
    bg.wrapS = THREE.RepeatWrapping;
    bg.wrapT = THREE.ClampToEdgeWrapping;
    // Sampled directly by the skybox mesh, no mip chain needed.
    bg.minFilter = THREE.LinearFilter;
    bg.magFilter = THREE.LinearFilter;
    bg.generateMipmaps = false;
    bg.encoding = src.encoding;
    bg.needsUpdate = true;
    return bg;
};
// IEEE-754 float32 → float16 (for building half-float DataTextures).
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
const floatToHalf = (val) => {
    _f32[0] = val;
    const x = _u32[0];
    const sign = (x >> 16) & 0x8000;
    const exp = ((x >> 23) & 0xFF) - 127 + 15;
    if (exp <= 0) return sign;                 // underflow → signed 0
    if (exp >= 31) return sign | 0x7BFF;       // clamp to max half
    return sign | (exp << 10) | ((x & 0x7FFFFF) >> 13);
};
// r128's toHalfFloat does not clamp: a finite float above the half
// range comes back as an Inf/NaN pattern with an unreliable sign, so
// the unrecoverable overflow always clamps to the max finite half.
const sanitizeHalfEnvData = (data, stride) => {
    let replaced = 0;
    for (let i = 0; i < data.length; i += stride) {
        for (let c = 0; c < 3; c++) {
            const h = data[i + c];
            if ((h & 0x7C00) === 0x7C00) { data[i + c] = 0x7BFF; replaced++; }
            else if (h & 0x8000) { data[i + c] = 0; replaced++; }
        }
        if (stride === 4) data[i + 3] = 0x3C00; // half 1.0: an EXR's own alpha must not reach the backdrop
    }
    return replaced;
};
const halfToFloat = (h) => {
    const sign = (h & 0x8000) ? -1 : 1;
    const exp = (h >> 10) & 0x1F;
    const frac = h & 0x3FF;
    if (exp === 0) return sign * frac * Math.pow(2, -24);
    if (exp === 31) return frac ? NaN : sign * Infinity;
    return sign * (1 + frac / 1024) * Math.pow(2, exp - 15);
};
// True SH (l<=2) cosine-convolution irradiance (Ramamoorthi & Hanrahan
// 2001). Convention-preserving: output rows keep the input's row<->
// latitude mapping, so the result uploads with the source's flipY.
const shIrradianceFromEquirect = (tex) => {
    try {
        const srcImg = tex.image;
        const srcStride = srcImg.data.length / (srcImg.width * srcImg.height); // 3 or 4
        const srcIsHalf = srcImg.data.constructor === Uint16Array;
        const readPx = (idx) => [
            srcIsHalf ? halfToFloat(srcImg.data[idx]) : srcImg.data[idx],
            srcIsHalf ? halfToFloat(srcImg.data[idx + 1]) : srcImg.data[idx + 1],
            srcIsHalf ? halfToFloat(srcImg.data[idx + 2]) : srcImg.data[idx + 2],
        ];
        // Pass 0: pre-downsample box-average to a float buffer, capping
        // the Pass 1 projection loop below at <=128x64 texels regardless
        // of source size.
        let W = srcImg.width, H = srcImg.height, get;
        if (W > 128 || H > 64) {
            const dW = Math.min(W, 128), dH = Math.min(H, 64);
            const bx = Math.max(1, Math.floor(W / dW));
            const by = Math.max(1, Math.floor(H / dH));
            const buf = new Float32Array(dW * dH * 3);
            for (let y = 0; y < dH; y++) {
                for (let x = 0; x < dW; x++) {
                    let r = 0, g = 0, b = 0, cnt = 0;
                    for (let oy = 0; oy < by; oy++) {
                        for (let ox = 0; ox < bx; ox++) {
                            const spx = x * bx + ox, spy = y * by + oy;
                            if (spx >= W || spy >= H) continue;
                            const px = readPx((spy * W + spx) * srcStride);
                            r += px[0]; g += px[1]; b += px[2]; cnt++;
                        }
                    }
                    const o = (y * dW + x) * 3;
                    buf[o] = r / cnt; buf[o + 1] = g / cnt; buf[o + 2] = b / cnt;
                }
            }
            W = dW; H = dH;
            get = (x, y) => { const o = (y * W + x) * 3; return [buf[o], buf[o + 1], buf[o + 2]]; };
        } else {
            get = (x, y) => readPx((y * W + x) * srcStride);
        }
        // Pass 1: project radiance onto the 9 SH basis functions,
        // weighted by each texel's differential solid angle
        // dOmega = (2*PI/W)*(PI/H)*sin(theta) (texels shrink toward poles).
        const c = new Float64Array(9 * 3); // [coef*3 + channel], RGB per coefficient
        for (let y = 0; y < H; y++) {
            const theta = Math.PI * (y + 0.5) / H;
            const sinT = Math.sin(theta), cosT = Math.cos(theta);
            const dOmega = (2 * Math.PI / W) * (Math.PI / H) * sinT;
            for (let x = 0; x < W; x++) {
                const phi = 2 * Math.PI * (x + 0.5) / W;
                const sx = sinT * Math.cos(phi), sy = cosT, sz = sinT * Math.sin(phi);
                const [r, g, b] = get(x, y);
                const Y = [
                    0.282095,                              // Y00
                    0.488603 * sz,                          // Y1-1
                    0.488603 * sy,                          // Y10  (sy = up axis)
                    0.488603 * sx,                          // Y11
                    1.092548 * sx * sz,                     // Y2-2
                    1.092548 * sz * sy,                     // Y2-1
                    1.092548 * sx * sy,                     // Y21
                    0.315392 * (3 * sy * sy - 1),           // Y20
                    0.546274 * (sx * sx - sz * sz),         // Y22
                ];
                for (let i = 0; i < 9; i++) {
                    const yw = Y[i] * dOmega;
                    c[i * 3] += r * yw;
                    c[i * 3 + 1] += g * yw;
                    c[i * 3 + 2] += b * yw;
                }
            }
        }
        // Pass 2: evaluate cosine-convolved irradiance per output texel
        // using the Ramamoorthi-Hanrahan cosine-lobe coefficients, scaled
        // by 1/PI to match mx_environment_irradiance's expected units.
        const OW = 64, OH = 32;
        const A0 = Math.PI, A1 = (2 * Math.PI) / 3, A2 = Math.PI / 4;
        const A = [A0, A1, A1, A1, A2, A2, A2, A2, A2];
        const out = new Uint16Array(OW * OH * 4);
        for (let y = 0; y < OH; y++) {
            const theta = Math.PI * (y + 0.5) / OH;
            const sinT = Math.sin(theta), cosT = Math.cos(theta);
            for (let x = 0; x < OW; x++) {
                const phi = 2 * Math.PI * (x + 0.5) / OW;
                const sx = sinT * Math.cos(phi), sy = cosT, sz = sinT * Math.sin(phi);
                const Y = [
                    0.282095,
                    0.488603 * sz,
                    0.488603 * sy,
                    0.488603 * sx,
                    1.092548 * sx * sz,
                    1.092548 * sz * sy,
                    1.092548 * sx * sy,
                    0.315392 * (3 * sy * sy - 1),
                    0.546274 * (sx * sx - sz * sz),
                ];
                let r = 0, g = 0, b = 0;
                for (let i = 0; i < 9; i++) {
                    const aw = A[i] * Y[i];
                    r += aw * c[i * 3];
                    g += aw * c[i * 3 + 1];
                    b += aw * c[i * 3 + 2];
                }
                r = Number.isFinite(r) ? Math.max(0, r / Math.PI) : 0;
                g = Number.isFinite(g) ? Math.max(0, g / Math.PI) : 0;
                b = Number.isFinite(b) ? Math.max(0, b / Math.PI) : 0;
                const o = (y * OW + x) * 4;
                out[o] = floatToHalf(r);
                out[o + 1] = floatToHalf(g);
                out[o + 2] = floatToHalf(b);
                out[o + 3] = 0x3C00; // half 1.0, alpha unused by the IBL sampler
            }
        }
        // Row↔latitude convention mirrors the input, so upload with the
        // same flipY as the source texture.
        const out_tex = new THREE.DataTexture(out, OW, OH, THREE.RGBAFormat, THREE.HalfFloatType);
        out_tex.flipY = tex.flipY;
        return out_tex;
    } catch (e) {
        console.warn('SH irradiance projection failed:', e);
        return null;
    }
};
// Parses a raw environment ArrayBuffer into a bare DataTexture, shared
// by getEnvironment() and loadEnvironmentFromFile, one parser for both
// formats. Returns null on failure; callers decide how to surface it.
const parseEnvBuffer = (buf, ext) => {
    try {
        if (ext === '.hdr') {
            if (typeof THREE.RGBELoader === 'undefined') return null;
            // r128's RGBELoader defaults to UnsignedByteType (RGBE-
            // encoded data only built-in materials can decode);
            // HalfFloatType makes it decode to linear float at parse.
            const d = new THREE.RGBELoader().setDataType(THREE.HalfFloatType).parse(buf);
            if (!d || !d.data) return null;
            const replaced = sanitizeHalfEnvData(d.data, d.data.length / (d.width * d.height));
            if (replaced) console.info('[env-sanitize] clamped ' + replaced + ' overflowed half-float texel channel(s) in .hdr environment');
            const tex = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
            // RGBELoader keeps rows top-first, which already matches
            // MaterialX's v=0-at-top, no flip.
            tex.flipY = false;
            return tex;
        }
        if (ext === '.exr') {
            if (typeof THREE.EXRLoader === 'undefined') return null;
            // HalfFloatType, not FloatType (unlike loadExrTexture's
            // sampler use above): RGBA16F is core mip-able on WebGL2,
            // while RGBA32F needs optional extensions.
            const d = new THREE.EXRLoader().setDataType(THREE.HalfFloatType).parse(buf);
            if (!d || !d.data) return null;
            const replaced = sanitizeHalfEnvData(d.data, d.data.length / (d.width * d.height));
            if (replaced) console.info('[env-sanitize] clamped ' + replaced + ' overflowed half-float texel channel(s) in .exr environment');
            const tex = new THREE.DataTexture(d.data, d.width, d.height, d.format, d.type);
            // EXRLoader flips rows at decode (data row 0 = image bottom),
            // so flip at upload to restore MaterialX's v=0-at-top.
            tex.flipY = true;
            return tex;
        }
        return null; // unrecognized extension
    } catch (e) {
        return null;
    }
};
// ---- Automatic key-light extraction ----
// FIS specular IBL (16 samples, mip LOD) can't reproduce a crisp
// highlight from a tiny ultra-bright sun, it just blurs it. Official
// MaterialX HDRIs solve this offline with a "split" asset: sun removed
// from the image + a companion analytic directional_light. This
// reproduces that automatically for any loaded environment.
const KEYLIGHT_MIN_CONTRAST = 64;
const KEYLIGHT_RADIUS_RAD = 0.10;
// Shared data-space -> world direction mapping (extractKeyLight AND
// extractSoftKeyDir): gamma absorbs u_envMatrix's +90deg base, flipY
// matches the texture's row convention, negate flips TO-light into TRAVELS.
const dataDirToWorld = (tex, x, y, W, H) => {
    const U = (x + 0.5) / W;
    const gamma = 2 * Math.PI * U - Math.PI;
    const vRow = tex.flipY ? (H - 1 - y) : y;
    const thetaV = Math.PI * (vRow + 0.5) / H;
    const sinV = Math.sin(thetaV), cosV = Math.cos(thetaV);
    return new THREE.Vector3(sinV * Math.cos(gamma), cosV, sinV * Math.sin(gamma)).negate();
};
const extractKeyLight = (tex) => {
    try {
        const img = tex.image;
        const W = img.width, H = img.height;
        const stride = img.data.length / (W * H);
        const isHalf = img.data.constructor === Uint16Array;
        if (!Number.isInteger(W) || !Number.isInteger(H) || W < 1 || H < 1
            || !Number.isInteger(stride) || (stride !== 3 && stride !== 4)
            || (isHalf ? !(img.data instanceof Uint16Array) : !(img.data instanceof Float32Array))) return null;
        const rd = (i) => (isHalf ? halfToFloat(img.data[i]) : img.data[i]);
        const quantize = (v) => isHalf ? halfToFloat(floatToHalf(v)) : Math.fround(v);

        // Pass 1: per-texel luminance + solid-angle weight -> mean + peak.
        const lum = new Float32Array(W * H);
        let sumW = 0, sumLW = 0, peakL = -1, peakX = 0, peakY = 0;
        for (let y = 0; y < H; y++) {
            const theta = Math.PI * (y + 0.5) / H;
            const dOmega = Math.sin(theta) * (2 * Math.PI / W) * (Math.PI / H);
            for (let x = 0; x < W; x++) {
                const idx = (y * W + x) * stride;
                const r = rd(idx), g = rd(idx + 1), b = rd(idx + 2);
                // A failed extraction must leave the texture byte-identical.
                // Reject invalid radiance before either the cluster or annulus
                // can turn it into a partially-mutated environment.
                if (![r, g, b].every(v => Number.isFinite(v) && v >= 0)) return null;
                const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                lum[y * W + x] = L;
                sumW += dOmega; sumLW += L * dOmega;
                if (L > peakL) { peakL = L; peakX = x; peakY = y; }
            }
        }
        const meanL = sumW > 0 ? sumLW / sumW : 0;
        if (!(peakL >= KEYLIGHT_MIN_CONTRAST * Math.max(meanL, 1e-6))) return null; // no sun-like source

        // Peak direction (data space), used below for angular clustering.
        const pTheta = Math.PI * (peakY + 0.5) / H, pPhi = 2 * Math.PI * (peakX + 0.5) / W;
        const pDir = [Math.sin(pTheta) * Math.cos(pPhi), Math.cos(pTheta), Math.sin(pTheta) * Math.sin(pPhi)];

        // Pass 2: cluster around the peak (angle + luminance-floor gated).
        // The annulus is solid-angle weighted: equirect texels do not have
        // equal area, particularly near the poles.
        const Lfloor = Math.max(8 * meanL, 0.02 * peakL);
        let annR = 0, annG = 0, annB = 0, annW = 0;
        const clusterIdx = [];
        for (let y = 0; y < H; y++) {
            const theta = Math.PI * (y + 0.5) / H;
            const dOmega = Math.sin(theta) * (2 * Math.PI / W) * (Math.PI / H);
            const sinT = Math.sin(theta), cosT = Math.cos(theta);
            for (let x = 0; x < W; x++) {
                const phi = 2 * Math.PI * (x + 0.5) / W;
                const dx = sinT * Math.cos(phi), dy = cosT, dz = sinT * Math.sin(phi);
                const cosAng = dx * pDir[0] + dy * pDir[1] + dz * pDir[2];
                const ang = Math.acos(Math.min(1, Math.max(-1, cosAng)));
                const idx = (y * W + x) * stride;
                const L = lum[y * W + x];
                if (ang <= KEYLIGHT_RADIUS_RAD && L >= Lfloor) {
                    const r = rd(idx), g = rd(idx + 1), b = rd(idx + 2);
                    clusterIdx.push({ idx, x, y, dOmega, rgb: [r, g, b] });
                } else if (ang > KEYLIGHT_RADIUS_RAD && ang <= 2 * KEYLIGHT_RADIUS_RAD) {
                    annR += rd(idx) * dOmega; annG += rd(idx + 1) * dOmega; annB += rd(idx + 2) * dOmega; annW += dOmega;
                }
            }
        }
        if (!clusterIdx.length || !(annW > 0) || !Number.isFinite(annW)) return null;
        const annColor = [annR / annW, annG / annW, annB / annW];
        if (!annColor.every(v => Number.isFinite(v) && v >= 0)) return null;

        // Quantize the replacement before measuring removed energy, so the
        // analytic light receives exactly what the texture no longer
        // contains, including Float32/half storage conversion.
        let Er = 0, Eg = 0, Eb = 0;
        const moment = new THREE.Vector3();
        const writes = [];
        for (const entry of clusterIdx) {
            const retained = entry.rgb.map((value, channel) => quantize(Math.min(value, annColor[channel])));
            const removed = entry.rgb.map((value, channel) => value - retained[channel]);
            if (!retained.every(v => Number.isFinite(v) && v >= 0) || !removed.every(v => Number.isFinite(v) && v >= 0)) return null;
            Er += removed[0] * entry.dOmega; Eg += removed[1] * entry.dOmega; Eb += removed[2] * entry.dOmega;
            const Y = 0.2126 * removed[0] + 0.7152 * removed[1] + 0.0722 * removed[2];
            moment.addScaledVector(dataDirToWorld(tex, entry.x, entry.y, W, H), Y * entry.dOmega);
            writes.push({ idx: entry.idx, retained });
        }
        const maxE = Math.max(Er, Eg, Eb);
        if (!(maxE > 0) || !Number.isFinite(maxE) || ![Er, Eg, Eb].every(Number.isFinite)
            || !(moment.lengthSq() > 0) || !Number.isFinite(moment.lengthSq())) return null;
        const direction = moment.normalize();
        if (![direction.x, direction.y, direction.z].every(Number.isFinite)) return null;

        // Direction: removed-energy luminance moment, not the raw cluster
        // centroid, so a partially clamped edge texel weighs in proportion.
        for (const { idx, retained } of writes) {
            img.data[idx] = isHalf ? floatToHalf(retained[0]) : retained[0];
            img.data[idx + 1] = isHalf ? floatToHalf(retained[1]) : retained[1];
            img.data[idx + 2] = isHalf ? floatToHalf(retained[2]) : retained[2];
        }
        return { direction, color: [Er / maxE, Eg / maxE, Eb / maxE], intensity: maxE };
    } catch (e) {
        console.warn('key-light extraction failed:', e);
        return null;
    }
};
// Cheaper direction-only estimate for the studio shadow when
// extractKeyLight found nothing (or was skipped): luminance-weighted
// centroid of texels >= 2x mean, via the same helper as extractKeyLight.
const extractSoftKeyDir = (tex) => {
    try {
        const img = tex.image;
        const W = img.width, H = img.height;
        const stride = img.data.length / (W * H);
        const isHalf = img.data.constructor === Uint16Array;
        const rd = (i) => (isHalf ? halfToFloat(img.data[i]) : img.data[i]);

        const lum = new Float32Array(W * H);
        let sumW = 0, sumLW = 0;
        for (let y = 0; y < H; y++) {
            const theta = Math.PI * (y + 0.5) / H;
            const dOmega = Math.sin(theta) * (2 * Math.PI / W) * (Math.PI / H);
            for (let x = 0; x < W; x++) {
                const idx = (y * W + x) * stride;
                const L = 0.2126 * rd(idx) + 0.7152 * rd(idx + 1) + 0.0722 * rd(idx + 2);
                lum[y * W + x] = L;
                sumW += dOmega; sumLW += L * dOmega;
            }
        }
        const Lfloor = 2 * (sumW > 0 ? sumLW / sumW : 0);

        let cxW = 0, cyW = 0, cW = 0;
        for (let y = 0; y < H; y++) {
            const theta = Math.PI * (y + 0.5) / H;
            const dOmega = Math.sin(theta) * (2 * Math.PI / W) * (Math.PI / H);
            for (let x = 0; x < W; x++) {
                const L = lum[y * W + x];
                if (L < Lfloor) continue;
                const w = L * dOmega;
                cxW += x * w; cyW += y * w; cW += w;
            }
        }
        if (!Number.isFinite(cW) || cW <= 0) return null;
        return dataDirToWorld(tex, cxW / cW, cyW / cW, W, H);
    } catch (e) {
        return null;
    }
};
// Builds the full { radiance, irradiance, mips, background,
// prefilteredIrr, keyLight, softKeyDir } shape from a raw
// parseEnvBuffer() result, shared by getEnvironment() and loadEnvironmentFromFile.
// GGX-prefiltered radiance chain, MaterialXView's specular environment path.
// Each mip of the result is the environment convolved with the GGX lobe for
// the roughness that mx_latlong_alpha_to_lod maps to that level, so the
// shader's single textureLod replaces FIS's 16-sample estimate. The math is
// a straight port of libraries/pbrlib/genglsl/lib/mx_generate_prefilter_env.glsl
// and its helpers, kept function-for-function so the two cannot drift.
const PREFILTER_SAMPLES = 1024;
const PREFILTER_GLSL = [
    'precision highp float;',
    'const float M_PI = 3.1415926535897932;',
    'const float M_PI_INV = 0.31830988618379067;',
    'const float M_FLOAT_EPS = 1e-8;',
    'uniform sampler2D uSource;',
    'uniform float uMip;',
    'uniform float uMaxMip;',
    'uniform vec2 uTargetSize;',
    'out vec4 fragColor;',
    'float mx_square(float x) { return x * x; }',
    // Return the alpha associated with the given mip level in a prefiltered environment.
    'float mx_latlong_lod_to_alpha(float lod) {',
    '    float lodBias = lod / uMaxMip;',
    '    return (lodBias < 0.5) ? mx_square(lodBias) : 2.0 * (lodBias - 0.375);',
    '}',
    'vec3 mx_latlong_map_projection_inverse(vec2 uv) {',
    '    float latitude = (uv.y - 0.5) * M_PI;',
    '    float longitude = (uv.x - 0.5) * M_PI * 2.0;',
    '    float x = -cos(latitude) * sin(longitude);',
    '    float y = -sin(latitude);',
    '    float z = cos(latitude) * cos(longitude);',
    '    return vec3(x, y, z);',
    '}',
    'vec2 mx_latlong_projection(vec3 dir) {',
    '    float latitude = -asin(clamp(dir.y, -1.0, 1.0)) * M_PI_INV + 0.5;',
    '    float longitude = atan(dir.x, -dir.z) * M_PI_INV * 0.5 + 0.5;',
    '    return vec2(longitude, latitude);',
    '}',
    'vec3 mx_latlong_map_lookup(vec3 dir, float lod) {',
    '    return textureLod(uSource, mx_latlong_projection(normalize(dir)), lod).rgb;',
    '}',
    'float mx_latlong_compute_lod(vec3 dir, float pdf, float maxMipLevel, int envSamples) {',
    '    const float MIP_LEVEL_OFFSET = 1.5;',
    '    float effectiveMaxMipLevel = maxMipLevel - MIP_LEVEL_OFFSET;',
    '    float distortion = sqrt(1.0 - mx_square(dir.y));',
    '    return max(effectiveMaxMipLevel - 0.5 * log2(float(envSamples) * pdf * distortion), 0.0);',
    '}',
    'mat3 mx_orthonormal_basis(vec3 N) {',
    '    float sgn = (N.z < 0.0) ? -1.0 : 1.0;',
    '    float a = -1.0 / (sgn + N.z);',
    '    float b = N.x * N.y * a;',
    '    vec3 X = vec3(1.0 + sgn * N.x * N.x * a, sgn * b, -sgn * N.x);',
    '    vec3 Y = vec3(b, sgn + N.y * N.y * a, -N.y);',
    '    return mat3(X, Y, N);',
    '}',
    'float mx_golden_ratio_sequence(int i) {',
    '    const float GOLDEN_RATIO = 1.6180339887498948;',
    '    return fract((float(i) + 1.0) * GOLDEN_RATIO);',
    '}',
    'vec2 mx_spherical_fibonacci(int i, int numSamples) {',
    '    return vec2((float(i) + 0.5) / float(numSamples), mx_golden_ratio_sequence(i));',
    '}',
    'float mx_ggx_NDF(vec3 H, vec2 alpha) {',
    '    vec2 He = H.xy / alpha;',
    '    float denom = dot(He, He) + mx_square(H.z);',
    '    return 1.0 / (M_PI * alpha.x * alpha.y * mx_square(denom));',
    '}',
    'vec3 mx_ggx_importance_sample_VNDF(vec2 Xi, vec3 V, vec2 alpha) {',
    '    V = normalize(vec3(V.xy * alpha, V.z));',
    '    float phi = 2.0 * M_PI * Xi.x;',
    '    float z = (1.0 - Xi.y) * (1.0 + V.z) - V.z;',
    '    float sinTheta = sqrt(clamp(1.0 - z * z, 0.0, 1.0));',
    '    vec3 c = vec3(sinTheta * cos(phi), sinTheta * sin(phi), z);',
    '    vec3 H = c + V;',
    '    return normalize(vec3(H.xy * alpha, max(H.z, 0.0)));',
    '}',
    'float mx_ggx_VNDF_reflection_PDF(vec3 H, vec2 alpha, float G1V, float NdotV) {',
    '    return mx_ggx_NDF(H, alpha) * G1V / (4.0 * NdotV);',
    '}',
    'float mx_ggx_smith_G1(float cosTheta, float alpha) {',
    '    float cosTheta2 = mx_square(cosTheta);',
    '    float tanTheta2 = (1.0 - cosTheta2) / cosTheta2;',
    '    return 2.0 / (1.0 + sqrt(1.0 + mx_square(alpha) * tanTheta2));',
    '}',
    'float mx_ggx_smith_G2(float NdotL, float NdotV, float alpha) {',
    '    float alpha2 = mx_square(alpha);',
    '    float lambdaL = sqrt(alpha2 + (1.0 - alpha2) * mx_square(NdotL));',
    '    float lambdaV = sqrt(alpha2 + (1.0 - alpha2) * mx_square(NdotV));',
    '    return 2.0 * NdotL * NdotV / (lambdaL * NdotV + lambdaV * NdotL);',
    '}',
    'void main() {',
    '    vec2 uv = gl_FragCoord.xy / uTargetSize;',
    // +0.5 in longitude, because mx_latlong_map_projection_inverse is NOT
    // the inverse of mx_latlong_projection: measured, the two disagree by
    // exactly half the map. Writing texel uv as the value for the
    // un-corrected direction leaves the whole prefiltered chain rotated
    // 180 degrees against the lookup that reads it back.
    '    vec3 worldN = mx_latlong_map_projection_inverse(vec2(uv.x + 0.5, uv.y));',
    '    float alpha = mx_latlong_lod_to_alpha(uMip);',
    // A mirror lobe has no width to integrate; sampling it would just add
    // noise, so level 0 is the source unchanged.
    '    if (alpha <= 0.0) { fragColor = vec4(mx_latlong_map_lookup(worldN, 0.0), 1.0); return; }',
    '    vec3 V = vec3(0.0, 0.0, 1.0);',
    '    float NdotV = 1.0;',
    '    mat3 tangentToWorld = mx_orthonormal_basis(worldN);',
    '    float G1V = mx_ggx_smith_G1(NdotV, alpha);',
    '    vec3 radiance = vec3(0.0);',
    '    float weight = 0.0;',
    '    const int envRadianceSamples = ' + PREFILTER_SAMPLES + ';',
    '    for (int i = 0; i < envRadianceSamples; i++) {',
    '        vec2 Xi = mx_spherical_fibonacci(i, envRadianceSamples);',
    '        vec3 H = mx_ggx_importance_sample_VNDF(Xi, V, vec2(alpha));',
    '        vec3 L = -V + 2.0 * H.z * H;',
    '        float NdotL = clamp(L.z, M_FLOAT_EPS, 1.0);',
    '        float G = mx_ggx_smith_G2(NdotL, NdotV, alpha);',
    '        vec3 Lw = tangentToWorld * L;',
    '        float pdf = mx_ggx_VNDF_reflection_PDF(H, vec2(alpha), G1V, NdotV);',
    '        float lod = mx_latlong_compute_lod(Lw, pdf, uMaxMip, envRadianceSamples);',
    '        radiance += G * mx_latlong_map_lookup(Lw, lod);',
    '        weight += G;',
    '    }',
    '    fragColor = vec4(radiance / max(weight, M_FLOAT_EPS), 1.0);',
    '}',
].join('\n');

// Wraps a rendered mip chain as the prefiltered radiance texture; the thumbnail
// worker calls it with chains the page read back.
const makePrefilteredTexture = (mipmaps) => {
    const base = mipmaps[0];
    const tex = new THREE.DataTexture(base.data, base.width, base.height, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    // Always false, never copied from the source: the chain was written in
    // framebuffer space, where row 0 is v = 0, and readRenderTargetPixels
    // hands the rows back in that same order.
    tex.flipY = false;
    tex.encoding = THREE.LinearEncoding;
    tex.anisotropy = 8;
    // Levels are supplied, not derived: three uploads texture.mipmaps for a
    // DataTexture and turns generateMipmaps off itself when it does.
    tex.mipmaps = mipmaps;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
};

// Builds env.radiancePrefiltered once per environment, on the first view
// that has a renderer. three r128 ignores the mip level for a 2D render
// target (setRenderTarget's framebufferTexture2D call is cube-only), so each
// level is rendered into its own target, read back, and assembled into a
// DataTexture whose `mipmaps` array three uploads level by level.
// Fail-soft: any problem leaves the flag set and the FIS chain in place, so
// shading still works, just noisier.
// A caller with no renderer yet (materials that compile ahead of the
// renderer, e.g. the Scene's first pass) must not latch prefilterTried: that
// would permanently skip the prefiltered chain for the rest of the session.
// mtlx_scene_prefilter_fix=0 restores that old (buggy) latch-on-null behaviour.
const ensurePrefilteredEnv = (renderer, env) => {
    if (!env || !env.radiance || env.prefilterTried) return env;
    if (!renderer && !host.legacyPrefilterLatch()) return env;
    if (host.legacyPrefilterLatch()) env.prefilterTried = true;
    if (getSpecularEnvMethod() !== 'prefilter') return env;
    if (!renderer || !renderer.capabilities || !renderer.capabilities.isWebGL2) return env;
    env.prefilterTried = true;
    // Float targets are the only type readRenderTargetPixels can be relied
    // on to return here; without them the chain cannot be read back.
    if (!renderer.extensions.get('EXT_color_buffer_float')) {
        mtlxWarn('mtlx-engine: EXT_color_buffer_float missing, keeping the FIS specular environment.');
        return env;
    }
    const src = env.radiance;
    const w = src.image && src.image.width, h = src.image && src.image.height;
    if (!w || !h) return env;
    const levels = env.mips || (Math.trunc(Math.log2(Math.max(w, h))) + 1);
    const t0 = performance.now();
    const previousTarget = renderer.getRenderTarget();
    const material = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: 'in vec3 position;\nvoid main() { gl_Position = vec4(position, 1.0); }',
        fragmentShader: PREFILTER_GLSL,
        uniforms: {
            uSource: { value: src },
            uMip: { value: 0 },
            uMaxMip: { value: Math.max(1, levels - 1) },
            uTargetSize: { value: new THREE.Vector2(w, h) },
        },
        depthTest: false, depthWrite: false,
    });
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mipmaps = [];
    let failed = false;
    try {
        for (let level = 0; level < levels; level++) {
            const lw = Math.max(1, w >> level), lh = Math.max(1, h >> level);
            const target = new THREE.WebGLRenderTarget(lw, lh, {
                minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
                format: THREE.RGBAFormat, type: THREE.FloatType,
                depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
            });
            material.uniforms.uMip.value = level;
            material.uniforms.uTargetSize.value.set(lw, lh);
            renderer.setRenderTarget(target);
            renderer.render(scene, camera);
            const pixels = new Float32Array(lw * lh * 4);
            renderer.readRenderTargetPixels(target, 0, 0, lw, lh, pixels);
            target.dispose();
            // Half float keeps the chain linear-filterable in core WebGL2
            // (full float filtering needs OES_texture_float_linear) and
            // halves the upload, at a precision the source already has.
            const half = new Uint16Array(lw * lh * 4);
            for (let i = 0; i < half.length; i++) half[i] = floatToHalf(pixels[i]);
            mipmaps.push({ data: half, width: lw, height: lh });
        }
    } catch (error) {
        failed = true;
        mtlxWarn('mtlx-engine: GGX environment prefilter failed, keeping the FIS chain: ' + (error && error.message || error));
    }
    renderer.setRenderTarget(previousTarget);
    material.dispose();
    scene.children[0].geometry.dispose();
    if (failed || !mipmaps.length) return env;
    env.radiancePrefiltered = makePrefilteredTexture(mipmaps);
    if (host.perfLog()) {
        console.log('[mtlx-perf] env prefilter: ' + (performance.now() - t0).toFixed(1)
            + 'ms (' + levels + ' levels, ' + w + 'x' + h + ')');
    }
    return env;
};

// GPU cosine-convolved diffuse irradiance map: replaces the SH l<=2
// reconstruction above with a direct hemispherical integral baked into a
// 64x32 RGBA half-float lat-long map, same shape/lookup contract as
// shIrradianceFromEquirect's output (mx_environment_irradiance never
// changes). Reuses the GGX prefilter's render-target/readback pipeline and
// its +0.5 longitude convention (mx_latlong_map_projection_inverse is NOT
// the inverse of mx_latlong_projection; see PREFILTER_GLSL's comment above).
const IRRADIANCE_CONV_W = 128;
const IRRADIANCE_CONV_H = 64;
const IRRADIANCE_OUT_W = 64;
const IRRADIANCE_OUT_H = 32;
const IRRADIANCE_GLSL = [
    'precision highp float;',
    'const float M_PI = 3.1415926535897932;',
    'const float M_PI_INV = 0.31830988618379067;',
    'uniform sampler2D uSource;',
    'uniform float uSrcLod;',
    'uniform vec2 uTargetSize;',
    'out vec4 fragColor;',
    'vec3 mx_latlong_map_projection_inverse(vec2 uv) {',
    '    float latitude = (uv.y - 0.5) * M_PI;',
    '    float longitude = (uv.x - 0.5) * M_PI * 2.0;',
    '    float x = -cos(latitude) * sin(longitude);',
    '    float y = -sin(latitude);',
    '    float z = cos(latitude) * cos(longitude);',
    '    return vec3(x, y, z);',
    '}',
    'void main() {',
    '    vec2 uv = gl_FragCoord.xy / uTargetSize;',
    // Same +0.5 longitude rule as PREFILTER_GLSL: texel uv holds the
    // value for this direction, which is what mx_latlong_projection
    // reads back.
    '    vec3 N = normalize(mx_latlong_map_projection_inverse(vec2(uv.x + 0.5, uv.y)));',
    '    const int CW = ' + IRRADIANCE_CONV_W + ';',
    '    const int CH = ' + IRRADIANCE_CONV_H + ';',
    '    float dPhi = 2.0 * M_PI / float(CW);',
    '    float dTheta = M_PI / float(CH);',
    '    vec3 E = vec3(0.0);',
    '    for (int j = 0; j < CH; j++) {',
    '        float sv = (float(j) + 0.5) / float(CH);',
    '        for (int i = 0; i < CW; i++) {',
    '            float su = (float(i) + 0.5) / float(CW);',
    '            vec3 L = normalize(mx_latlong_map_projection_inverse(vec2(su + 0.5, sv)));',
    '            float NdotL = dot(N, L);',
    '            if (NdotL <= 0.0) continue;',
    // Lat-long solid angle: sin(polar) = cos(latitude) = sqrt(1 - L.y*L.y).
    '            float sinT = sqrt(max(0.0, 1.0 - L.y * L.y));',
    '            vec3 Li = textureLod(uSource, vec2(su, sv), uSrcLod).rgb;',
    '            E += Li * NdotL * sinT * dPhi * dTheta;',
    '        }',
    '    }',
    // The 1/PI matches mx_environment_irradiance's units, the same scale
    // shIrradianceFromEquirect's Pass 2 applies above.
    '    fragColor = vec4(max(E * M_PI_INV, vec3(0.0)), 1.0);',
    '}',
].join('\n');

// Wraps the 64x32 float readback as the convolved irradiance texture.
const makeConvolvedIrradianceTexture = (pixels) => {
    const half = new Uint16Array(pixels.length);
    for (let i = 0; i < half.length; i++) half[i] = floatToHalf(pixels[i]);
    const tex = new THREE.DataTexture(half, IRRADIANCE_OUT_W, IRRADIANCE_OUT_H, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    // Framebuffer space, same reasoning as ensurePrefilteredEnv's tex.
    tex.flipY = false;
    tex.encoding = THREE.LinearEncoding;
    tex.needsUpdate = true;
    return tex;
};

// Builds env.irradianceConvolved once per environment, on the first view
// that has a WebGL2 renderer with a float color-buffer extension. Fail-soft
// at every step: env.irradiance (the SH map) is never touched here, so any
// guard failure or thrown error leaves diffuse shading exactly as it was.
const ensureConvolvedIrradiance = (renderer, env) => {
    if (!env || !env.radiance || env.irradianceTried) return env;
    if (getDiffuseEnvMethod() !== 'convolve') return env;
    if (!renderer || !renderer.capabilities || !renderer.capabilities.isWebGL2) return env;
    env.irradianceTried = true;
    if (!renderer.extensions.get('EXT_color_buffer_float')) {
        mtlxWarn('mtlx-engine: EXT_color_buffer_float missing, keeping the SH irradiance.');
        return env;
    }
    const src = env.radiance;
    const srcW = (src.image && src.image.width) || IRRADIANCE_CONV_W;
    const srcH = (src.image && src.image.height) || IRRADIANCE_CONV_H;
    const t0 = performance.now();
    const previousTarget = renderer.getRenderTarget();
    let material = null, scene = null, target = null;
    try {
        material = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: 'in vec3 position;\nvoid main() { gl_Position = vec4(position, 1.0); }',
            fragmentShader: IRRADIANCE_GLSL,
            uniforms: {
                uSource: { value: src },
                uSrcLod: { value: Math.max(0, Math.log2(srcW / IRRADIANCE_CONV_W)) },
                uTargetSize: { value: new THREE.Vector2(IRRADIANCE_OUT_W, IRRADIANCE_OUT_H) },
            },
            depthTest: false, depthWrite: false,
        });
        scene = new THREE.Scene();
        scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
        const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        target = new THREE.WebGLRenderTarget(IRRADIANCE_OUT_W, IRRADIANCE_OUT_H, {
            minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat, type: THREE.FloatType,
            depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
        });
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        const pixels = new Float32Array(IRRADIANCE_OUT_W * IRRADIANCE_OUT_H * 4);
        renderer.readRenderTargetPixels(target, 0, 0, IRRADIANCE_OUT_W, IRRADIANCE_OUT_H, pixels);
        // Retained verbatim for the diffuse bounce v3 bake
        // (js/usd-scene-renderer.js's makeEStoredSampler): the SAME texel
        // data the shader samples through env.irradianceConvolved, so the
        // bake can evaluate the engine's own convolved irradiance at any
        // blocker normal by transliterating mx_latlong_projection and
        // bilinearly fetching this array, rather than approximating it with
        // a whole-sphere mean (see v3-design.md section 1/2 for why the
        // mean under-estimated the blockers by roughly 2x). 32 KB, no new
        // GPU work: this is the readback ensureConvolvedIrradiance already
        // performs for the half-float texture below.
        env.irradianceConvolvedData = pixels;
        env.irradianceConvolvedSize = [IRRADIANCE_OUT_W, IRRADIANCE_OUT_H];
        env.irradianceConvolved = makeConvolvedIrradianceTexture(pixels);
        if (host.perfLog()) {
            console.log('[mtlx-perf] env irradiance convolve: ' + (performance.now() - t0).toFixed(1)
                + 'ms (' + srcW + 'x' + srcH + ' -> ' + IRRADIANCE_OUT_W + 'x' + IRRADIANCE_OUT_H + ')');
        }
    } catch (error) {
        mtlxWarn('mtlx-engine: irradiance convolution failed, keeping the SH map: ' + (error && error.message || error));
    }
    renderer.setRenderTarget(previousTarget);
    if (target) target.dispose();
    if (material) material.dispose();
    if (scene && scene.children[0]) scene.children[0].geometry.dispose();
    return env;
};

// Runs the idempotent, retryable prefilter/convolve (no-op past the first
// try) then reads back the pair to bind, so the FIRST build matches what
// the shader was generated for, the same way setEnvironment already does.
const resolveShadingEnv = (renderer, env) => {
    ensurePrefilteredEnv(renderer, env);
    ensureConvolvedIrradiance(renderer, env);
    return { radiance: envRadianceForShading(env), irradiance: envIrradianceForShading(env) };
};

const buildEnvFromParsedTexture = (raw) => {
    // Extraction mutates raw's pixels (clamps the sun) BEFORE mips/SH/
    // background are built below, so it disappears from all three,
    // matching official "split" env assets.
    const keyLight = host.keyLightEnabled() ? extractKeyLight(raw) : null;
    // extractKeyLight only mutates raw on a SUCCESSFUL extraction (both
    // its null-return paths run before the clamp), so raw is still
    // pristine here whenever the soft fallback is actually needed.
    const softKeyDir = keyLight ? null : extractSoftKeyDir(raw);
    const radiance = prepareEnv(raw);
    const irrSrc = shIrradianceFromEquirect(raw);
    const irradiance = irrSrc ? prepareEnv(irrSrc) : radiance;
    const img = radiance.image;
    const mips = Math.trunc(Math.log2(Math.max(img.width, img.height))) + 1;
    // Correctly-oriented copy for the visible skybox mesh, see
    // makeBackgroundTexture and the env-prep header above.
    const background = makeBackgroundTexture(radiance);
    return { radiance, irradiance, irradianceConvolved: null, mips, background, prefilteredIrr: false, keyLight, softKeyDir };
};

// Mirrors the same curve onto three's BUILT-IN materials: the backdrop sky
// sphere, the studio parts and the shadow catcher. RawShaderMaterial bypasses
// three's epilogue entirely, so without this the background keeps its own curve
// and ignores exposure completely, which is what made the sky stop matching the
// objects in front of it. three calls CustomToneMapping() when
// renderer.toneMapping is CustomToneMapping; the sRGB OETF is left to
// renderer.outputEncoding, exactly as it is for MaterialX materials.
let BASE_TONEMAP_CHUNK = null;
const CUSTOM_TONEMAP_STUB = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
const applyThreeToneMappingChunk = (mode) => {
    if (!THREE.ShaderChunk || !THREE.ShaderChunk.tonemapping_pars_fragment) return false;
    if (BASE_TONEMAP_CHUNK === null) BASE_TONEMAP_CHUNK = THREE.ShaderChunk.tonemapping_pars_fragment;
    if (BASE_TONEMAP_CHUNK.indexOf(CUSTOM_TONEMAP_STUB) === -1) return false;
    const body = mode === 'lin_rec709'
        ? '\treturn color * toneMappingExposure;\n'
        : '\tvec3 _c = max(color * toneMappingExposure, vec3(0.0));\n'
            + TONE_CURVE_GLSL(mode, '\t')
            + '\treturn clamp(_c, vec3(0.0), vec3(1.0));\n';
    THREE.ShaderChunk.tonemapping_pars_fragment = BASE_TONEMAP_CHUNK.replace(
        CUSTOM_TONEMAP_STUB,
        'vec3 CustomToneMapping( vec3 color ) {\n' + body + '}'
    );
    return true;
};

// applyPeelMaterialMode(material, active): blend/depth flags for one
// material's peel-graph participation, mirrors createMtlxRenderView's
// original syncMeshMaterialMode. `active` is the caller's own peel
// verdict (e.g. viewIsTransparent && FORCE_TRANSPARENCY); u_peelMode is
// left at 0, createPeelPipeline.render raises it only during its passes.
const applyPeelMaterialMode = (material, active) => {
    if (!material) return;
    const blending = active ? THREE.NoBlending : THREE.NormalBlending;
    const changed = material.blending !== blending;
    material.blending = blending;
    material.transparent = false;
    material.depthTest = true;
    material.depthWrite = true;
    if (material.uniforms && material.uniforms.u_peelMode) material.uniforms.u_peelMode.value = 0;
    if (changed) material.needsUpdate = true;
};

// Full-scene mode: the GLB's camera has a FIXED vertical FOV sized for
// its authored 16:9 aspect; a NARROWER canvas would crop the sides. Fix:
// widen the vertical fov to preserve the authored horizontal half-fov.
const effectiveFullSceneVFov = (authoredFovDeg, authoredAspect, canvasAspect) => {
    if (canvasAspect >= authoredAspect) return authoredFovDeg;
    const authoredHalfVFov = (authoredFovDeg * Math.PI / 180) / 2;
    const authoredHalfHFov = Math.atan(Math.tan(authoredHalfVFov) * authoredAspect);
    const effHalfVFov = Math.atan(Math.tan(authoredHalfHFov) / canvasAspect);
    return effHalfVFov * 2 * 180 / Math.PI;
};

// Neutral-material env rotation: r128 lacks a scene.environment rotation knob (arrives r162+), so
// onBeforeCompile patches every neutral glTF material's shader to rotate its env queries via a live
// uEnvRotation uniform. The chunk is r128's own envmap_physical_pars_fragment plus exactly three
// lines: `uniform mat3 uEnvRotation;` and one `uEnvRotation *` rotation in each of
// getLightProbeIndirectIrradiance/Radiance, applied before every #ifdef branch. It's a bare
// RotationY(rad), not PI/2+rad like u_envMatrix, because MaterialX's longitude (atan2(x,-z)) leads
// three's equirectUv (atan2(z,x)) by +0.25 turn, cancelling u_envMatrix's own +90°. The two
// conventions still disagree VERTICALLY (three +Y at v=1, MaterialX v=0), unaddressed here; see the PMREM comment in createMtlxRenderView.
const NEUTRAL_ENV_ROTATION_CHUNK = `#if defined( USE_ENVMAP )
	#ifdef ENVMAP_MODE_REFRACTION
		uniform float refractionRatio;
	#endif
	uniform mat3 uEnvRotation;
	vec3 getLightProbeIndirectIrradiance( const in GeometricContext geometry, const in int maxMIPLevel ) {
		vec3 worldNormal = inverseTransformDirection( geometry.normal, viewMatrix );
		worldNormal = uEnvRotation * worldNormal;
		#ifdef ENVMAP_TYPE_CUBE
			vec3 queryVec = vec3( flipEnvMap * worldNormal.x, worldNormal.yz );
			#ifdef TEXTURE_LOD_EXT
				vec4 envMapColor = textureCubeLodEXT( envMap, queryVec, float( maxMIPLevel ) );
			#else
				vec4 envMapColor = textureCube( envMap, queryVec, float( maxMIPLevel ) );
			#endif
			envMapColor.rgb = envMapTexelToLinear( envMapColor ).rgb;
		#elif defined( ENVMAP_TYPE_CUBE_UV )
			vec4 envMapColor = textureCubeUV( envMap, worldNormal, 1.0 );
		#else
			vec4 envMapColor = vec4( 0.0 );
		#endif
		return PI * envMapColor.rgb * envMapIntensity;
	}
	float getSpecularMIPLevel( const in float roughness, const in int maxMIPLevel ) {
		float maxMIPLevelScalar = float( maxMIPLevel );
		float sigma = PI * roughness * roughness / ( 1.0 + roughness );
		float desiredMIPLevel = maxMIPLevelScalar + log2( sigma );
		return clamp( desiredMIPLevel, 0.0, maxMIPLevelScalar );
	}
	vec3 getLightProbeIndirectRadiance( const in vec3 viewDir, const in vec3 normal, const in float roughness, const in int maxMIPLevel ) {
		#ifdef ENVMAP_MODE_REFLECTION
			vec3 reflectVec = reflect( -viewDir, normal );
			reflectVec = normalize( mix( reflectVec, normal, roughness * roughness) );
		#else
			vec3 reflectVec = refract( -viewDir, normal, refractionRatio );
		#endif
		reflectVec = inverseTransformDirection( reflectVec, viewMatrix );
		reflectVec = uEnvRotation * reflectVec;
		float specularMIPLevel = getSpecularMIPLevel( roughness, maxMIPLevel );
		#ifdef ENVMAP_TYPE_CUBE
			vec3 queryReflectVec = vec3( flipEnvMap * reflectVec.x, reflectVec.yz );
			#ifdef TEXTURE_LOD_EXT
				vec4 envMapColor = textureCubeLodEXT( envMap, queryReflectVec, specularMIPLevel );
			#else
				vec4 envMapColor = textureCube( envMap, queryReflectVec, specularMIPLevel );
			#endif
			envMapColor.rgb = envMapTexelToLinear( envMapColor ).rgb;
		#elif defined( ENVMAP_TYPE_CUBE_UV )
			vec4 envMapColor = textureCubeUV( envMap, reflectVec, roughness );
		#endif
		return envMapColor.rgb * envMapIntensity;
	}
#endif`;

// See NEUTRAL_ENV_ROTATION_CHUNK's header comment above for the full
// derivation of why this is a bare RotationY(rad), no extra PI/2.
const envRotationMatrix3 = (rad) =>
    new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(rad));
// Attaches the live-rotatable env patch to one neutral glTF PBR
// material. getRad is read at ACTUAL compile time, not snapshotted at attach time.
const patchNeutralMaterialEnvRotation = (material, getRad) => {
    material.onBeforeCompile = (shader) => {
        shader.uniforms.uEnvRotation = { value: envRotationMatrix3(getRad()) };
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <envmap_physical_pars_fragment>',
            NEUTRAL_ENV_ROTATION_CHUNK
        );
        material.userData.envRotationUniform = shader.uniforms.uEnvRotation;
    };
    // r128's Material default already derives customProgramCacheKey
    // from onBeforeCompile.toString(), which already keys these apart;
    // set explicitly anyway as insurance against a future edit.
    material.customProgramCacheKey = () => 'neutralEnvRotation';
};

// Instantiates a PER-VIEW copy of a loaded shaderball GLTF. mode: 'full'
// (shaderball.glb, embedded camera) or 'simple' (ball only). Returns null on a
// missing 'material_surface' mesh. The caller owns the URL and the load.
const instantiateShaderballGltf = (gltf, mode /* 'full' | 'simple' */) => {
    // Object3D.clone(true) deep-clones the node hierarchy but only
    // shallow-copies each mesh's geometry/material (shared by reference), so
    // two concurrent views need the traverse below to un-share state.
    const group = gltf.scene.clone(true);
    let glbCamera = null;
    let surfaceMesh = null;
    const ownedMaterials = [];
    group.traverse((obj) => {
        if (mode === 'full' && obj.isCamera && !glbCamera) {
            glbCamera = obj;
            return;
        }
        if (!obj.isMesh) return;
        if (obj.name === 'material_surface') {
            // The generated MaterialX material lands here (both GLBs
            // author this primitive with a NULL material),
            // createMtlxRenderView assigns it via applyMaterialInternal.
            surfaceMesh = obj;
            return;
        }
        if (/^backplane/.test(obj.name)) {
            // Emitter panels: NULL glTF material + baked vertex COLOR_0,
            // self-lit "light card" look. toneMapped:true keeps them on
            // the same ACES curve as the MaterialX surface (encodeDisplay).
            const m = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: true });
            obj.material = m;
            ownedMaterials.push(m);
            return;
        }
        if (obj.material) {
            // Every other glTF-materialed mesh: clone() so this view
            // OWNS its material instance, without it, setEnvExposure's
            // envMapIntensity mutation would leak across cached views.
            const wasArray = Array.isArray(obj.material);
            const clones = (wasArray ? obj.material : [obj.material]).map((m) => m.clone());
            obj.material = wasArray ? clones : clones[0];
            ownedMaterials.push(...clones);
        }
    });
    if (!surfaceMesh) return null;

    // Per-view geometry clone: prepGeometry MUTATES the geometry (adds
    // i_position/i_normal/etc aliases), clone first so the cache's
    // original geometry stays pristine for other views.
    surfaceMesh.geometry = prepGeometry(surfaceMesh.geometry.clone());

    if (mode === 'simple') {
        // Whole-scene analog of normalizeGeometry: centers the bounding
        // sphere at radius 1 so this preset frames like sphere/cube.
        // Wraps in a group transform since meshes keep internal transforms.
        const bs = new THREE.Box3().setFromObject(group).getBoundingSphere(new THREE.Sphere());
        const outer = new THREE.Group();
        outer.add(group);
        if (bs.radius > 0) {
            const s = 1 / bs.radius;
            outer.scale.setScalar(s);
            outer.position.copy(bs.center).multiplyScalar(-s);
        }
        return { group: outer, surfaceMesh, glbCamera: null, ownedMaterials };
    }

    return { group, surfaceMesh, glbCamera, ownedMaterials };
};

// Adopts the GLB's embedded camera into the shell camera. DETACHED: the GLB
// camera sits under a root node baking a 0.01 scale, so it is read in world
// space. Returns the authored state recomputeCameraFov and the orbit need.
const adoptSceneCamera = (camera, sceneInst, aspect) => {
    const gc = sceneInst.glbCamera;
    sceneInst.group.updateMatrixWorld(true); // the group isn't in a scene yet; compute its world matrices standalone first
    gc.getWorldPosition(camera.position);
    gc.getWorldQuaternion(camera.quaternion);
    const authoredPose = { position: camera.position.clone(), quaternion: camera.quaternion.clone() };
    // gc.near/far are already in THREE.PerspectiveCamera's units, copy verbatim.
    camera.near = gc.near;
    camera.far = gc.far;
    // The `|| 1.7778` fallback only matters for a GLB that omits aspectRatio.
    const authoredFov = gc.fov;
    const authoredAspect = gc.aspect || 1.7778;
    // Aspect from the CANVAS, not the GLB's own; effectiveFullSceneVFov widens
    // the fov instead of cropping.
    camera.aspect = aspect;
    camera.fov = effectiveFullSceneVFov(authoredFov, authoredAspect, camera.aspect);
    camera.updateProjectionMatrix();
    return { authoredFov, authoredAspect, authoredPose };
};

// World bounding sphere of the ball assembly: 'shader_ball' by name, falling
// back to the mesh's parent, then sceneGroup. withFramingGeometry(fn) runs fn
// against the undisplaced geometry. Callers cache the result.
const ballBoundingSphere = (sceneGroup, mesh, withFramingGeometry) => {
    const ballNode = sceneGroup.getObjectByName('shader_ball')
        || (mesh && mesh.parent)
        || sceneGroup;
    ballNode.updateMatrixWorld(true);
    const box = withFramingGeometry(() => new THREE.Box3().setFromObject(ballNode));
    return box.getBoundingSphere(new THREE.Sphere());
};

// Pure form of the view's recomputeCameraFov. getSphere is lazy (only called
// while fullscreenFit is on) so the caller's sphere cache keeps its timing.
const fullSceneFov = ({
    authoredFov, authoredAspect, aspect, fitDist, fitRadius, fullscreenFit, getSphere, cameraPosition,
}) => {
    let fov = effectiveFullSceneVFov(authoredFov, authoredAspect, aspect);
    // Scene-orbit default framing: fits the ball PROPER
    // to the actual viewport aspect (authored ~16:9 fov
    // overflows wider canvases). REPLACES the base fov here.
    if (fitDist != null && fitRadius != null && fitDist > fitRadius) {
        const theta = Math.asin(Math.min(1, fitRadius / fitDist));
        const vForV = 2 * theta;
        const vForH = 2 * Math.atan(Math.tan(theta) / aspect);
        const SCENE_FIT_MARGIN = 1.15; // ball ~1/1.15 of the limiting dimension - tight hero framing
        fov = Math.max(vForV, vForH) * 180 / Math.PI * SCENE_FIT_MARGIN;
    }
    if (fullscreenFit) {
        const sphere = getSphere();
        const dist = sphere ? cameraPosition.distanceTo(sphere.center) : 0;
        if (sphere && dist > sphere.radius) {
            // Angular radius of the ball as seen from the
            // camera: asin(r/d), clamped to 1 against fp
            // overshoot when dist is barely larger than radius.
            const theta = Math.asin(Math.min(1, sphere.radius / dist));
            // The ball must fit BOTH axes: vertical
            // half-fov covers theta directly; horizontal
            // half-fov converts back via the same tan/atan.
            const vFovForVertical = 2 * theta;
            const vFovForHorizontal = 2 * Math.atan(Math.tan(theta) / aspect);
            const FIT_MARGIN = 1.06; // ~6% breathing room so the ball doesn't touch the frame edge
            const fitFovDeg = Math.max(vFovForVertical, vFovForHorizontal) * 180 / Math.PI * FIT_MARGIN;
            fov = Math.max(fov, fitFovDeg); // only ever widen -- never crop back below the everyday framing
        }
    }
    return fov;
};

// Scene-orbit setup on an OrbitControls instance: restores the authored pose,
// pivots on the ball, sets distance limits and the containment box. `sphere`
// is the caller's cached ballBoundingSphere (computed here when omitted).
// Returns the clamp box and the fit inputs for fullSceneFov.
const configureSceneOrbit = ({ camera, controls, sceneGroup, mesh, authoredPose, withFramingGeometry, sphere }) => {
    // OrbitControls' constructor already ran update()
    // against its placeholder (0,0,0) target and re-aimed
    // the camera, restore the authored pose first.
    if (authoredPose) {
        camera.position.copy(authoredPose.position);
        camera.quaternion.copy(authoredPose.quaternion);
    }
    if (sphere === undefined) sphere = ballBoundingSphere(sceneGroup, mesh, withFramingGeometry);
    // Pivot on the authored view ray at the ball's depth:
    // orientation is unchanged by OrbitControls' first
    // lookAt (zero roll), and the orbit pivots at the ball.
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    let d = sphere ? sphere.center.clone().sub(camera.position).dot(fwd) : 0;
    if (!(d > 0)) d = sphere ? camera.position.distanceTo(sphere.center) : 0.5;
    controls.target.copy(camera.position).addScaledVector(fwd, d);
    controls.minDistance = Math.min(d, sphere ? sphere.radius * 1.5 : d * 0.5);
    // Auto-rotate stays OFF regardless of autoRotate: the
    // rotate button is hidden here and setAutoRotate no-ops
    // for fullScene, a stale `rotating` could start a turntable.
    controls.autoRotate = false;
    // Containment: sceneGroup bounds == the backdrop box.
    // Inset 2% per axis, then union the authored camera
    // position so the default pose is always legal.
    const box = new THREE.Box3().setFromObject(sceneGroup);
    const size = box.getSize(new THREE.Vector3());
    box.min.x += size.x * 0.02; box.max.x -= size.x * 0.02;
    box.min.y += size.y * 0.02; box.max.y -= size.y * 0.02;
    box.min.z += size.z * 0.02; box.max.z -= size.z * 0.02;
    box.expandByPoint(camera.position);
    // Zoom-out limit: the ray-box EXIT distance from the
    // pivot through the camera, always >= the authored
    // distance so the initial framing stays reachable.
    const back = camera.position.clone().sub(controls.target).normalize();
    const exit = box.containsPoint(controls.target)
        ? new THREE.Ray(controls.target.clone(), back).intersectBox(box, new THREE.Vector3())
        : null;
    controls.maxDistance = exit ? controls.target.distanceTo(exit) : d * 4;
    // Captures setup distance + ball radius for the fit-to-
    // ball fov. Radius = HALF the largest AABB extent, not
    // Box3.getBoundingSphere() (which framed ~1.7x too far).
    let fitCenter = null, fitRadius = null;
    if (mesh) {
        mesh.updateMatrixWorld(true);
        const bb = withFramingGeometry(() => new THREE.Box3().setFromObject(mesh));
        fitCenter = bb.getCenter(new THREE.Vector3());
        const bs = bb.getSize(new THREE.Vector3());
        fitRadius = Math.max(bs.x, bs.y, bs.z) / 2;
    } else if (sphere) {
        fitCenter = sphere.center;
        fitRadius = sphere.radius;
    }
    return {
        clampBox: box,
        fitDist: fitCenter ? camera.position.distanceTo(fitCenter) : null,
        fitRadius,
    };
};

// Renderer display state for one transform mode: output encoding, tone
// mapping (our CustomToneMapping chunk when available) and exposure.
const applyRendererDisplay = (renderer, { mode, exposureScale }) => {
    // CustomToneMapping carries our own chunk (applyThreeToneMappingChunk),
    // so these materials run the SAME curve and exposure as the
    // MaterialX surface instead of only agreeing in 'aces'.
    const customTone = applyThreeToneMappingChunk(mode);
    if ('outputEncoding' in renderer) renderer.outputEncoding = mode === 'lin_rec709' ? THREE.LinearEncoding : THREE.sRGBEncoding;
    renderer.toneMapping = customTone ? THREE.CustomToneMapping
        : (mode === 'aces' ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping);
    renderer.toneMappingExposure = exposureScale;
};

// Driver shader pre-warm on a hidden context supplied by the host (getContext
// returns { gl, ext } or a falsy value). Holds the warmed-sources record.
const createShaderPrewarmer = ({ getContext, perfLog }) => {
    // Shader sources already pre-warmed this session, repeating would only
    // add pointless background wait. Keyed by a fast djb2 hash; collisions
    // are harmless (worst case, one un-warmed sync compile).
    const MTLX_WARMED_SOURCES = new Set();
    // Deliberately no size gate: standard_surface/OpenPBR previews run
    // ~80-106 KB, and skipping pre-warm above some cutoff would freeze the UI 2.5-2.9s synchronously.
    const warmKey = (vs, fs) => {
        let h = 5381;
        const s = vs + ' ' + fs;
        for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
        return s.length + ':' + h;
    };

    // Pre-compiles vs/fs on the hidden warm context; never throws. The
    // submitted source must match byte-for-byte what three.js's WebGLProgram
    // submits for display, or the driver cache misses (harmless, no speed win).
    // timeoutMs overrides WAIT_TIMEOUT_MS for one call: the Scene's parallel
    // compile mode (mtlx_scene_parallel_compile) stretches this per submission
    // so a driver busy with many queued programs is not mistaken for a stall.
    const prewarm = async ({ vs, fs, isMounted, label, timeoutMs }) => {
        const ctx = getContext();
        if (!ctx) return 'skipped';
        const key = warmKey(vs, fs);
        if (MTLX_WARMED_SOURCES.has(key)) {
            if (perfLog()) {
                console.log('[mtlx-perf] GL prewarm skipped, source already warmed this session (target: ' + label + ')');
            }
            return 'skipped';
        }
        const { gl, ext } = ctx;

        const __warmPerfStart = perfLog() ? performance.now() : 0;
        let warmProgram = null, warmVShader = null, warmFShader = null;
        try {
            warmVShader = gl.createShader(gl.VERTEX_SHADER);
            gl.shaderSource(warmVShader, '#version 300 es\n' + vs);
            gl.compileShader(warmVShader);
            warmFShader = gl.createShader(gl.FRAGMENT_SHADER);
            gl.shaderSource(warmFShader, '#version 300 es\n' + fs);
            gl.compileShader(warmFShader);
            warmProgram = gl.createProgram();
            gl.attachShader(warmProgram, warmVShader);
            gl.attachShader(warmProgram, warmFShader);
            gl.linkProgram(warmProgram);
        } catch (e) {
            // Defensive only: any failure here just skips the warm-up, falls
            // through to today's (unwarmed) compile behavior.
            try { if (warmProgram) gl.deleteProgram(warmProgram); } catch (e2) { /* context lost etc. */ }
            try { if (warmVShader) gl.deleteShader(warmVShader); } catch (e2) { /* ditto */ }
            try { if (warmFShader) gl.deleteShader(warmFShader); } catch (e2) { /* ditto */ }
            return 'skipped';
        }
        if (perfLog()) {
            console.log('[mtlx-perf] GL compile submit: '
                + (performance.now() - __warmPerfStart).toFixed(1) + 'ms (target: ' + label + ')');
        }
        const cleanup = () => {
            try { if (warmProgram) gl.deleteProgram(warmProgram); } catch (e) { /* context lost etc. */ }
            try { if (warmVShader) gl.deleteShader(warmVShader); } catch (e) { /* ditto */ }
            try { if (warmFShader) gl.deleteShader(warmFShader); } catch (e) { /* ditto */ }
        };

        const WAIT_POLL_MS = 50, WAIT_POLL_FAST_MS = 16, WAIT_POLL_FAST_TICKS = 6;
        const WAIT_TIMEOUT_MS = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 15000;
        const __waitStart = performance.now();
        let timedOut = false;

        // isProgram() is the silent validity check: false for a
        // deleted/invalid handle WITHOUT a GL error (unlike getProgramParameter,
        // which logs "GL_INVALID_VALUE" once per pre-warm on Chrome).
        const isWarmDone = () => {
            try {
                if (gl.isContextLost()) return true;
                if (!gl.isProgram(warmProgram)) return true;
                const v = gl.getProgramParameter(warmProgram, ext.COMPLETION_STATUS_KHR);
                // A GL error (invalid/deleted program) returns null WITHOUT
                // throwing, treat it as "nothing left to wait for" instead
                // of polling (and console-spamming) until the timeout cap.
                return (v === null) ? true : !!v;
            } catch (e) {
                // Disposed/invalid handle, nothing left to wait for.
                return true;
            }
        };

        // Check once immediately, before the first sleep, a fast background
        // compile may already be done before we'd otherwise pay a single poll
        // tick of latency.
        let tick = 0;
        for (;;) {
            if (isWarmDone()) break;
            // Safety cap: on timeout, stop polling and proceed; the real
            // compile then blocks for whatever time remains, so this is
            // never WORSE than not pre-warming, only equal or better.
            if ((performance.now() - __waitStart) > WAIT_TIMEOUT_MS) {
                timedOut = true;
                break;
            }
            // Escalating poll interval: fast compiles resolve within about a
            // frame, so the first ~6 ticks poll at 16ms; the 50ms tick only
            // matters for multi-second compiles.
            const pollMs = tick < WAIT_POLL_FAST_TICKS ? WAIT_POLL_FAST_MS : WAIT_POLL_MS;
            tick++;
            await new Promise((resolve) => setTimeout(resolve, pollMs));
            // Lifecycle bail: a superseded build must stop and clean up rather
            // than keep polling GL objects for a view nobody wants.
            if (!isMounted()) {
                cleanup();
                return 'bailed';
            }
        }
        if (perfLog()) {
            console.log('[mtlx-perf] GL compile wait: '
                + (performance.now() - __waitStart).toFixed(1) + 'ms (target: ' + label + ')');
        }
        if (!timedOut) MTLX_WARMED_SOURCES.add(key);
        cleanup();
        return 'done';
    };

    const clearWarmed = () => { MTLX_WARMED_SOURCES.clear(); };
    return { prewarm, clearWarmed };
};

globalThis.MtlxSceneAssembly = {
    setHost,
    hostSnapshot,
    setHostFromSnapshot,
    makeEnvTexture,
    padToRGBA,
    prepareEnv,
    makeBackgroundTexture,
    floatToHalf,
    sanitizeHalfEnvData,
    halfToFloat,
    shIrradianceFromEquirect,
    parseEnvBuffer,
    KEYLIGHT_MIN_CONTRAST,
    KEYLIGHT_RADIUS_RAD,
    dataDirToWorld,
    extractKeyLight,
    extractSoftKeyDir,
    PREFILTER_SAMPLES,
    PREFILTER_GLSL,
    ensurePrefilteredEnv,
    makePrefilteredTexture,
    IRRADIANCE_CONV_W,
    IRRADIANCE_CONV_H,
    IRRADIANCE_OUT_W,
    IRRADIANCE_OUT_H,
    IRRADIANCE_GLSL,
    ensureConvolvedIrradiance,
    makeConvolvedIrradianceTexture,
    resolveShadingEnv,
    buildEnvFromParsedTexture,
    applyThreeToneMappingChunk,
    applyPeelMaterialMode,
    effectiveFullSceneVFov,
    NEUTRAL_ENV_ROTATION_CHUNK,
    envRotationMatrix3,
    patchNeutralMaterialEnvRotation,
    instantiateShaderballGltf,
    adoptSceneCamera,
    ballBoundingSphere,
    fullSceneFov,
    configureSceneOrbit,
    applyRendererDisplay,
    createShaderPrewarmer,
};
})();
