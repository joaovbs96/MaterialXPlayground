// mtlx-engine.js — MaterialX WASM environment, shader introspection,
// environment lighting, preview geometry, and the encapsulated
// createMtlxRenderView() pipeline (generate ESSL -> three.js scene ->
// bind defaults/env/lights -> compile-check -> render loop). Shared by
// index.html (per-node previews) and material-viewer.html (.mtlx files).
// Public API exported onto window at the bottom.

// ------------------------------------------------------------------
// MaterialX 3D Preview Component
// ------------------------------------------------------------------
// IMPORTANT: load ONLY JsMaterialXGenShader.js. It is a SUPERSET of
// JsMaterialXCore.js (core document model + shader generation). If you
// also load and initialize JsMaterialXCore, embind tries to register
// the shared C++ types (VectorBase, Vector2, ...) a second time and
// throws "Cannot register public name 'VectorBase' twice". One module.
//
// The whole MaterialX runtime is initialized ONCE and cached at module
// scope: re-initializing per node select would re-download the wasm and
// reload the standard libraries every time.
let mxEnvPromise = null;
const getMxEnv = () => {
    if (!mxEnvPromise) {
        mxEnvPromise = import('./js/JsMaterialXGenShader.js')
            .then((mod) => mod.default({
                // .wasm and .data live next to the .js (in ./js/).
                locateFile: (path) => './js/' + path,
            }))
            .then((mx) => {
                // Expose the MaterialX library version (from the JS API)
                // for the top-menu badge; broadcast so the UI can update
                // whenever the WASM finishes loading.
                try {
                    const ver = (mx.getVersionString && mx.getVersionString()) || null;
                    if (ver) {
                        window.__mtlxVersion = ver;
                        window.dispatchEvent(new CustomEvent('mtlx-version', { detail: ver }));
                    }
                } catch (e) { /* version is optional */ }
                // WebGL 2 targets ESSL (GLSL ES 3.00) — NOT the desktop
                // GLSL generator, whose #version 400 output won't compile
                // in a browser. Build the generator + context once and
                // load the prepackaged standard libraries (from the .data
                // virtual filesystem) through it. loadStandardLibraries
                // also registers the source-code search path on the
                // context, so no manual registerSourceCodeSearchPath call.
                const gen = mx.EsslShaderGenerator.create();
                const genContext = new mx.GenContext(gen);
                const stdlib = mx.loadStandardLibraries(genContext);
                // OFFICIAL PARITY: the viewer sets hwSrgbEncodeOutput so
                // MaterialX itself emits the linear→sRGB encode in the
                // pixel shader — it uses NO tone mapping at all. (If this
                // build ignores the option, a fallback encode is injected
                // at generation time — see the /srgb/ test there.)
                try { genContext.getOptions().hwSrgbEncodeOutput = true; } catch (e) { /* option absent */ }

                // Direct light, exactly like the official viewer's
                // registerLights(): bind the directional_light nodedef to
                // light-type id 1 and pass the light values as the
                // u_lightData struct array. Values come from a local
                // ./light_rig.mtlx when present (copy the official
                // viewer's Lights/san_giuseppe_bridge_split.mtlx there
                // for exact parity), else a neutral default.
                return fetch('./environment_map.mtlx')
                    .then((r) => (r.ok ? r.text() : null))
                    .catch(() => null)
                    .then((rigXml) => {
                        const lightData = [];
                        try {
                            const HwGen = mx.HwShaderGenerator;
                            const ldef = stdlib.getNodeDef ? stdlib.getNodeDef('ND_directional_light') : null;
                            if (HwGen && HwGen.bindLightShader && ldef) {
                                try { HwGen.unbindLightShaders(genContext); } catch (e) { /* fresh ctx */ }
                                HwGen.bindLightShader(ldef, 1, genContext);
                                try {
                                    const opts = genContext.getOptions();
                                    opts.hwMaxActiveLightSources = Math.max(opts.hwMaxActiveLightSources || 0, 1);
                                } catch (e) { /* keep default */ }
                                // Parse directional_light instances from the rig.
                                const rigLights = [];
                                if (rigXml) {
                                    const blocks = rigXml.match(/<directional_light\b[\s\S]*?<\/directional_light>/g) || [];
                                    for (const bl of blocks) {
                                        const inp = (nm) => {
                                            const m = bl.match(new RegExp('<input\\\\s+name="' + nm + '"[^>]*value="([^"]*)"'));
                                            return m ? m[1] : null;
                                        };
                                        const v3 = (str, fb) => {
                                            if (!str) return fb;
                                            const p = str.split(',').map((x) => parseFloat(x.trim()));
                                            return p.length === 3 && !p.some(isNaN) ? p : fb;
                                        };
                                        rigLights.push({
                                            direction: v3(inp('direction'), [0, -1, 0]),
                                            color: v3(inp('color'), [1, 1, 1]),
                                            intensity: parseFloat(inp('intensity')) || 1.0,
                                        });
                                    }
                                }
                                if (!rigLights.length) {
                                    rigLights.push({ direction: [0.35, -0.85, -0.4], color: [1, 1, 1], intensity: 1.0 });
                                }
                                // Official rotates light directions by the
                                // same +90° Y it applies to the env map.
                                const rot = new THREE.Matrix4().makeRotationY(Math.PI / 2);
                                for (const l of rigLights) {
                                    const dir = new THREE.Vector3(l.direction[0], l.direction[1], l.direction[2])
                                        .normalize().transformDirection(rot);
                                    lightData.push({
                                        type: 1,
                                        direction: dir,
                                        color: new THREE.Vector3(l.color[0], l.color[1], l.color[2]),
                                        intensity: l.intensity,
                                    });
                                }
                            }
                        } catch (e) {
                            console.warn('direct-light registration unavailable:', e);
                            lightData.length = 0;
                        }
                        return { mx, gen, genContext, stdlib, lightData };
                    });
            });
    }
    return mxEnvPromise;
};

// Flip to true to log the generated GLSL + discovered uniforms to the
// console — the fastest way to diagnose a black/!runnable shader.
const DEBUG_SHADERS = true;
// version) instead of guessing. Returns [{ type, name }, ...].
const parseUniforms = (src) => {
    const out = [];
    const re = /uniform\s+(\w+)\s+(u_\w+)\s*(?:\[\s*\d+\s*\])?\s*;/g;
    let m;
    while ((m = re.exec(src)) !== null) out.push({ type: m[1], name: m[2] });
    return out;
};

// three.js RawShaderMaterial + glslVersion:GLSL3 prepends its own
// "#version 300 es"; MaterialX ESSL output already has one. Strip the
// generated version line to avoid a duplicate-directive compile error.
const stripVersion = (src) => src.replace(/^\s*#version[^\n]*\n/, '');

// Inject a display transform at the end of the generated PIXEL shader.
// three.js's renderer.outputEncoding / toneMapping only affect BUILT-IN
// materials (they're shader-chunk features) — RawShaderMaterial output
// is written to the sRGB display completely raw, so MaterialX's linear
// radiance looks much too dark (mid-tones roughly halved). We find the
// shader's `out vec4` variable and append a linear→sRGB encode just
// before main()'s closing brace (MaterialX emits main last, so the
// file's last '}' closes it).
const encodeDisplay = (src) => {
    const m = src.match(/\bout\s+vec4\s+(\w+)\s*;/);
    if (!m) return src;
    const v = m[1];
    const idx = src.lastIndexOf('}');
    if (idx === -1) return src;
    // FALLBACK ONLY (when hwSrgbEncodeOutput isn't honored): the
    // OFFICIAL viewer applies NO tone mapping — just MaterialX's own
    // linear→sRGB encode. Match its piecewise IEC 61966-2-1 curve
    // exactly; an ACES (or any) tone map here makes highlights and
    // overall response visibly diverge from the reference.
    const inject =
        '\n    // Injected by previewer: linear -> sRGB (official-parity, no tonemap).\n' +
        '    {\n' +
        '        vec3 _c = max(' + v + '.rgb, vec3(0.0));\n' +
        '        vec3 _lo = _c * 12.92;\n' +
        '        vec3 _hi = 1.055 * pow(_c, vec3(1.0 / 2.4)) - 0.055;\n' +
        '        ' + v + ' = vec4(mix(_hi, _lo, step(_c, vec3(0.0031308))), ' + v + '.a);\n' +
        '    }\n';
    return src.slice(0, idx) + inject + src.slice(idx);
};

// Emscripten throws C++ exceptions as NUMBERS (raw exception pointers),
// not Error objects — a bare catch that stringifies one shows "5247184"
// or "undefined" instead of the real MaterialX message. Decode the
// pointer via mx.getExceptionMessage when available; otherwise fall
// back to normal Error/String handling. ALWAYS route caught MaterialX
// errors through this.
const mxErr = (mx, e) => {
    try {
        if (typeof e === 'number' && mx && typeof mx.getExceptionMessage === 'function') {
            const msg = mx.getExceptionMessage(e);
            // getExceptionMessage may return a string or [type, message]
            if (Array.isArray(msg)) return msg.filter(Boolean).join(': ');
            if (msg) return String(msg);
        }
    } catch (_) { /* fall through to generic handling */ }
    if (e && e.message) return e.message;
    return String(e);
};

// CRITICAL WRITE PRIMITIVE — verified against the deployed
// wasm: the JS binding of setValueString is the TYPED
// setValue(value, type="string"), so writing a value RETYPES the
// input to "string". This single binding quirk caused every
// string-typed export and the colorspace nodedef failures. Writing
// the raw `value` attribute never touches the type.
const mxWriteValue = (inp, str, type) => {
    try {
        if (typeof inp.setAttribute === 'function') {
            inp.setAttribute('value', String(str));
            return;
        }
    } catch (e) { /* fall through */ }
    try {
        // Two-arg form sets value AND the correct type explicitly.
        inp.setValueString(String(str), type || inp.getType());
        return;
    } catch (e) { /* fall through */ }
    inp.setValueString(String(str));
    try { if (type) inp.setType(type); } catch (e) { /* best-effort */ }
};

// MaterialX JS marshals std::vector either as a real JS array or as a
// {size(), get(i)} object depending on the binding; normalize to array.
const vecToArray = (v) => {
    if (!v) return [];
    if (Array.isArray(v)) return v;
    if (typeof v.size === 'function') {
        const out = [];
        for (let i = 0; i < v.size(); i++) out.push(v.get(i));
        return out;
    }
    return [];
};

// Enumerate a ShaderStage's uniform variables via MaterialX shader
// introspection — the official viewer's approach (§7.1). Returns
// [{ name, type, data }] where data is the raw getData() payload of
// the recorded default (null when the uniform has no default, e.g.
// the per-frame transform matrices). Every access is defensive:
// exact embind shapes vary across MaterialX JS builds.
const collectMxUniforms = (stage) => {
    const out = [];
    const blocks = []; // { key, blk }
    let blockMap = null;
    try { blockMap = stage.getUniformBlocks && stage.getUniformBlocks(); } catch (e) { /* older binding */ }
    if (blockMap) {
        if (typeof blockMap.keys === 'function') {
            for (const k of vecToArray(blockMap.keys())) {
                try { blocks.push({ key: String(k), blk: blockMap.get(k) }); } catch (e) { /* skip */ }
            }
        } else {
            for (const k of Object.keys(blockMap)) blocks.push({ key: k, blk: blockMap[k] });
        }
    } else {
        // HW shader generators register exactly these two blocks
        // (HW::PUBLIC_UNIFORMS / HW::PRIVATE_UNIFORMS).
        for (const name of ['PublicUniforms', 'PrivateUniforms']) {
            try { const b = stage.getUniformBlock(name); if (b) blocks.push({ key: name, blk: b }); } catch (e) { /* absent */ }
        }
    }
    for (const entry of blocks) {
        const b = entry.blk;
        let n = 0;
        try { n = (typeof b.size === 'function') ? b.size() : 0; } catch (e) { /* skip block */ }
        for (let i = 0; i < n; i++) {
            try {
                const v = b.get(i);
                const name = (v.getVariable && v.getVariable()) || (v.getName && v.getName());
                if (!name) continue;
                let type = null;
                try {
                    const t = v.getType && v.getType();
                    type = t ? ((t.getName && t.getName()) || String(t)) : null;
                } catch (e) { /* type unreadable */ }
                let data = null;
                try {
                    const val = v.getValue && v.getValue();
                    if (val && val.getData) data = val.getData();
                } catch (e) { /* no default recorded */ }
                // The MaterialX element path (e.g. "preview_node/amplitude")
                // ties the uniform back to a node input — used by the
                // dynamic parameter UI.
                let path = null;
                try { path = (v.getPath && v.getPath()) || null; } catch (e) { /* absent */ }
                out.push({ name, type, data, path, block: entry.key });
            } catch (e) { /* skip unreadable entry */ }
        }
    }
    return out;
};

// Convert a MaterialX default value (by MaterialX type name) into a
// three.js uniform. Returns null for types that can't be a plain
// default (filename/sampler/string) — env samplers are bound
// separately and the rest are safely skipped.
const mxValueToThreeUniform = (type, data) => {
    const arr = (d) => {
        if (Array.isArray(d)) return d;
        if (d && typeof d.data === 'function') { try { return Array.from(d.data()); } catch (e) { /* not iterable */ } }
        if (d && typeof d.size === 'function') { const o = []; for (let i = 0; i < d.size(); i++) o.push(d.get(i)); return o; }
        return null;
    };
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

// sRGB <-> linear for the parameter UI's color pickers: MaterialX
// color values are LINEAR, while <input type="color"> speaks 8-bit
// sRGB hex. Converting at the picker boundary keeps the uniform
// values in the space the shader expects.
const linToSrgb = (c) => {
    const x = Math.max(0, Math.min(1, c));
    return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
};
const srgbToLin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const rgbToHex = (rgb) => '#' + rgb.slice(0, 3).map((c) => {
    const h = Math.round(linToSrgb(c) * 255).toString(16);
    return h.length === 1 ? '0' + h : h;
}).join('');
const hexToRgb = (hex) => [1, 3, 5].map((i) => srgbToLin(parseInt(hex.slice(i, i + 2), 16) / 255));

// Shared default texture for `filename` (image) inputs: a UV checker
// generated on a canvas, so image nodes preview out of the box instead
// of sampling an unbound (black) sampler. One instance is reused for
// every filename uniform and restored by "Reset to default".
let defaultTexture = null;
const getDefaultTexture = () => {
    if (defaultTexture) return defaultTexture;
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const n = 8, sz = 256 / n;
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            ctx.fillStyle = (x + y) % 2 ? '#7d7d7d' : '#c8c8c8';
            ctx.fillRect(x * sz, y * sz, sz, sz);
        }
    }
    // Orientation markers so UV flips are visible at a glance.
    ctx.fillStyle = '#d33'; ctx.fillRect(0, 0, sz, sz);                    // U0 V0
    ctx.fillStyle = '#36c'; ctx.fillRect((n - 1) * sz, 0, sz, sz);         // U1 V0
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.flipY = false; // MaterialX image convention; keep loads consistent
    t.needsUpdate = true;
    defaultTexture = t;
    return t;
};
// Configure a user-loaded texture the same way as the default.
const configureLoadedTexture = (t) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.flipY = false;
    t.needsUpdate = true;
    return t;
};

// ---- Preview geometry ----
// Alias three's attributes to the names the MaterialX vertex shader
// expects, and provide tangents (real ones when computable, constant
// +X fallback otherwise). Works on any BufferGeometry.
const prepGeometry = (geometry) => {
    if (!geometry.getAttribute('uv')) {
        // MaterialX shaders read texcoords; give degenerate UVs
        // rather than an unbound attribute.
        const count = geometry.getAttribute('position').count;
        geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    }
    geometry.setAttribute('i_position', geometry.getAttribute('position'));
    geometry.setAttribute('i_normal', geometry.getAttribute('normal'));
    geometry.setAttribute('i_texcoord_0', geometry.getAttribute('uv'));
    let iTangent = null;
    // r128's computeTangents CONSOLE.ERRORs (rather than throwing) when
    // index/position/normal/uv are missing — precheck so a geometry
    // that can't have real tangents goes straight to the fallback
    // without the scary log.
    const canTangent = !!(geometry.getIndex()
        && geometry.getAttribute('position')
        && geometry.getAttribute('normal')
        && geometry.getAttribute('uv'));
    if (canTangent) {
        try {
            geometry.computeTangents();
            const t = geometry.getAttribute('tangent'); // vec4 (may be absent on silent failure)
            if (t) {
                const tri = new Float32Array(t.count * 3);
                for (let i = 0; i < t.count; i++) {
                    tri[i * 3] = t.getX(i); tri[i * 3 + 1] = t.getY(i); tri[i * 3 + 2] = t.getZ(i);
                }
                iTangent = new THREE.BufferAttribute(tri, 3);
            }
        } catch (e) { /* fall through to constant tangent */ }
    }
    if (!iTangent) {
        const vcount = geometry.getAttribute('position').count;
        const tangents = new Float32Array(vcount * 3);
        for (let i = 0; i < vcount; i++) tangents[i * 3] = 1;
        iTangent = new THREE.BufferAttribute(tangents, 3);
    }
    geometry.setAttribute('i_tangent', iTangent);
    return geometry;
};

// Center a geometry at the origin and scale it to bounding radius 1
// so all preview shapes frame identically.
const normalizeGeometry = (geometry) => {
    geometry.computeBoundingSphere();
    const bs = geometry.boundingSphere;
    if (bs && bs.radius > 0) {
        geometry.translate(-bs.center.x, -bs.center.y, -bs.center.z);
        const s = 1 / bs.radius;
        geometry.scale(s, s, s);
    }
    return geometry;
};

// The official MaterialX shaderball, fetched once and cached. The GLB
// may contain several meshes (ball, base, ...) with node transforms —
// bake each mesh's world matrix and concatenate into one non-indexed
// BufferGeometry so it can share the single preview material.
const SHADERBALL_URL = 'https://raw.githubusercontent.com/AcademySoftwareFoundation/MaterialX/gh-pages/Geometry/shaderball.glb';
let shaderballPromise = null;
const getShaderballGeometry = () => {
    if (!shaderballPromise) {
        shaderballPromise = new Promise((resolve) => {
            if (!THREE.GLTFLoader) return resolve(null);
            new THREE.GLTFLoader().load(SHADERBALL_URL, (gltf) => {
                try {
                    const parts = [];
                    gltf.scene.updateMatrixWorld(true);
                    gltf.scene.traverse((obj) => {
                        if (obj.isMesh && obj.geometry) {
                            const g = obj.geometry.clone().toNonIndexed();
                            g.applyMatrix4(obj.matrixWorld);
                            parts.push(g);
                        }
                    });
                    if (!parts.length) return resolve(null);
                    // Manual attribute concat (BufferGeometryUtils isn't loaded).
                    const total = parts.reduce((n, g) => n + g.getAttribute('position').count, 0);
                    const pos = new Float32Array(total * 3);
                    const nrm = new Float32Array(total * 3);
                    const uv = new Float32Array(total * 2);
                    let off = 0;
                    for (const g of parts) {
                        const p = g.getAttribute('position');
                        const n = g.getAttribute('normal');
                        const u = g.getAttribute('uv');
                        pos.set(p.array, off * 3);
                        if (n) nrm.set(n.array, off * 3);
                        if (u) uv.set(u.array, off * 2);
                        off += p.count;
                    }
                    const merged = new THREE.BufferGeometry();
                    merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
                    merged.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
                    merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
                    // computeTangents REQUIRES an index; the merge is
                    // non-indexed, so give it a trivial sequential one —
                    // real tangents instead of the constant fallback.
                    const idx = new Uint32Array(total);
                    for (let ii = 0; ii < total; ii++) idx[ii] = ii;
                    merged.setIndex(new THREE.BufferAttribute(idx, 1));
                    resolve(normalizeGeometry(merged));
                } catch (e) {
                    console.warn('shaderball merge failed:', e);
                    resolve(null);
                }
            }, undefined, (e) => {
                console.warn('shaderball load failed:', e);
                resolve(null);
            });
        });
    }
    return shaderballPromise;
};

// Build the selected preview geometry; shaderball falls back to the
// sphere when the GLB can't be fetched.
const buildPreviewGeometry = async (which) => {
    if (which === 'cube') {
        return normalizeGeometry(new THREE.BoxGeometry(1.3, 1.3, 1.3));
    }
    if (which === 'shaderball') {
        const g = await getShaderballGeometry();
        if (g) return g.clone();
    }
    return new THREE.SphereGeometry(1, 64, 64);
};

// Resolve how to preview a node from its nodedefs. Handles:
//  - overloaded defs (e.g. add: float/color3/vector3/... variants)
//  - MULTI-OUTPUT defs (many noise nodes expose out/outr/outg/...):
//    we pick the FIRST viewable output.
// Returns { kind, outType, outputName, multiOutput } where kind is
// 'surface' | 'bsdf' | 'color' | null. outputName is the specific
// output to tap (null = the def's single/default output). multiOutput
// is true when the node instance must be created as type 'multioutput'.
const COLOR_VIEWABLE = ['color3', 'color4', 'float', 'vector2', 'vector3', 'vector4'];
const resolveNodeKind = (doc, nodeName) => {
    const defs = vecToArray(doc.getMatchingNodeDefs(nodeName));
    // Flatten every def into candidate outputs.
    const candidates = []; // { type, outputName, multiOutput }
    const allTypes = [];
    for (const def of defs) {
        const outs = vecToArray(def.getOutputs ? def.getOutputs() : null);
        const multiOutput = (def.getType && def.getType() === 'multioutput') || outs.length > 1;
        if (outs.length === 0) {
            const t = def.getType();
            allTypes.push(t);
            candidates.push({ type: t, outputName: null, multiOutput: false });
        } else {
            for (const o of outs) {
                const t = o.getType();
                allTypes.push(t);
                // With a single output, downstream doesn't need an
                // explicit output name; with several, it does.
                candidates.push({
                    type: t,
                    outputName: multiOutput ? o.getName() : null,
                    multiOutput,
                });
            }
        }
    }

    // Priority: surface shader > BSDF > first viewable color/vector.
    const surf = candidates.find((c) => c.type === 'surfaceshader');
    if (surf) return { kind: 'surface', ...surf };
    const bsdf = candidates.find((c) => c.type === 'BSDF');
    if (bsdf) return { kind: 'bsdf', ...bsdf };
    for (const t of COLOR_VIEWABLE) {
        const hit = candidates.find((c) => c.type === t);
        if (hit) return { kind: 'color', outType: t, outputName: hit.outputName, multiOutput: hit.multiOutput };
    }
    return { kind: null, types: allTypes };
};

// Synthesize a small equirectangular environment (LDR, safe to filter
// and mip on WebGL2) so image-based lighting has something to sample:
// a sky-to-ground gradient with a soft overhead "sun" for speculars.
// Real previews would load an HDR; this keeps the viewer self-contained.
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
    // Equirect mapping: irrelevant for the IBL sampler uniforms;
    // the visible background uses a flipY=true copy of this texture
    // (makeBackgroundTexture) — three's background convention is
    // mirrored vertically from MaterialX's latlong lookup.
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = blurred ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = !blurred;
    tex.needsUpdate = true;
    return tex;
};

// Path to a user-supplied equirectangular (lat-long) environment map.
// Drop a file next to the page and point this at it. .hdr is loaded via
// RGBELoader (true HDR lighting); .jpg/.png/.exr* load via TextureLoader.
// Leave as-is / remove the file to fall back to the synthesized sky.
const ENV_MAP_URL = './san_giuseppe_bridge.hdr';

// Load the environment ONCE and reuse across previews. Resolves to
// { radiance, irradiance, mips } or null if no file is present, in
// which case the caller uses the synthesized makeEnvTexture sky.
let envPromise = null;
// ---- Environment preparation: OFFICIAL VIEWER PARITY ----
// The official viewer (main.js) does, per texture:
//   prepareEnvTexture: DataTexture(RGBA), RepeatWrapping (S), max
//   anisotropy, LinearMipmapLinearFilter, generateMipmaps = TRUE.
// and loads TWO files: a radiance env and a PREFILTERED IRRADIANCE
// env ('Lights/irradiance/<same>.hdr'). Mips are essential: the FIS
// specular lookup picks its LOD from roughness — without a mip chain
// every roughness samples the razor-sharp base level, which reads as
// "too reflective" and makes the highlight pattern swim ("rotate")
// as roughness changes.
//
// r128 gotcha (cause of an earlier all-black regression): RGBELoader's
// half-float path outputs RGB-format data, and RGB16F is NOT
// color-renderable, so gl.generateMipmap fails → incomplete texture →
// samples black. Official three's loader emits RGBA. Fix: pad RGB →
// RGBA before upload, THEN mipmapping is safe.
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
    return new THREE.DataTexture(out, img.width, img.height, THREE.RGBAFormat, tex.type);
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
// Build the texture used as the VISIBLE scene.background from a
// prepared radiance texture. It must be a SEPARATE texture from the
// IBL sampler, because the two consumers disagree on V orientation:
//   - MaterialX's mx_latlong_map_lookup maps "up" to v = 0, i.e. it
//     wants the .hdr's first scanline at v = 0 → flipY = FALSE
//     (what a fresh DataTexture gives us — reflections are correct).
//   - three's background path (equirectUv in the equirect→cubemap
//     conversion) maps "up" to v = 1 → it needs flipY = TRUE, which
//     is what RGBELoader sets on the textures it loads.
// The official viewer gets this for free: prepareEnvTexture rebuilds
// a flipY=false DataTexture for the IBL uniforms, but the background
// is the ORIGINAL loader texture (flipY=true). Reusing the IBL
// texture as scene.background mirrors the environment vertically.
// Shares the pixel data; only the upload orientation differs.
const makeBackgroundTexture = (src) => {
    const img = src.image;
    const bg = new THREE.DataTexture(img.data, img.width, img.height, src.format, src.type);
    bg.flipY = true; // three's equirect background convention
    bg.mapping = THREE.EquirectangularReflectionMapping;
    bg.wrapS = THREE.RepeatWrapping;
    bg.wrapT = THREE.ClampToEdgeWrapping;
    // Sampled once into a cube render target — no mip chain needed.
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
const halfToFloat = (h) => {
    const sign = (h & 0x8000) ? -1 : 1;
    const exp = (h >> 10) & 0x1F;
    const frac = h & 0x3FF;
    if (exp === 0) return sign * frac * Math.pow(2, -24);
    if (exp === 31) return frac ? NaN : sign * Infinity;
    return sign * (1 + frac / 1024) * Math.pow(2, exp - 15);
};
// Fallback when no prefiltered irradiance file exists: box-average the
// radiance down to 64x32. Not a true cosine convolution, but close
// enough that diffuse stops mirroring the environment.
const downsampleIrradiance = (tex) => {
    try {
        const img = tex.image;
        const W = 64, H = 32;
        const stride = img.data.length / (img.width * img.height); // 3 or 4
        const isHalf = img.data.constructor === Uint16Array;
        const out = new Uint16Array(W * H * 4);
        const bx = Math.max(1, Math.floor(img.width / W));
        const by = Math.max(1, Math.floor(img.height / H));
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                let r = 0, g = 0, b = 0, cnt = 0;
                for (let sy = 0; sy < by; sy++) {
                    for (let sx = 0; sx < bx; sx++) {
                        const px = ((y * by + sy) * img.width + (x * bx + sx)) * stride;
                        r += isHalf ? halfToFloat(img.data[px]) : img.data[px];
                        g += isHalf ? halfToFloat(img.data[px + 1]) : img.data[px + 1];
                        b += isHalf ? halfToFloat(img.data[px + 2]) : img.data[px + 2];
                        cnt++;
                    }
                }
                const o = (y * W + x) * 4;
                out[o] = floatToHalf(r / cnt);
                out[o + 1] = floatToHalf(g / cnt);
                out[o + 2] = floatToHalf(b / cnt);
                out[o + 3] = 0x3C00;
            }
        }
        return new THREE.DataTexture(out, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
    } catch (e) {
        console.warn('irradiance downsample failed:', e);
        return null;
    }
};
const IRRADIANCE_MAP_URL = './san_giuseppe_bridge_irradiance.hdr';
const loadHDR = (url) => new Promise((resolve) => {
    if (!THREE.RGBELoader) return resolve(null);
    try {
        // r128's RGBELoader defaults to UnsignedByteType (RGBE-encoded
        // data only built-in materials can decode); HalfFloatType makes
        // it decode to linear float at load.
        new THREE.RGBELoader()
            .setDataType(THREE.HalfFloatType)
            .load(url, resolve, undefined, () => resolve(null));
    } catch (e) { resolve(null); }
});
const getEnvironment = () => {
    if (!envPromise) {
        envPromise = Promise.all([
            loadHDR(ENV_MAP_URL),
            loadHDR(IRRADIANCE_MAP_URL),
        ]).then(([radRaw, irrRaw]) => {
            if (!radRaw) return null; // no file → synthesized sky
            const radiance = prepareEnv(radRaw);
            // Prefer the prefiltered irradiance file (drop the official
            // viewer's Lights/irradiance/<name>.hdr next to the app as
            // ./irradiance.hdr for exact parity); else downsample.
            const irrSrc = irrRaw || downsampleIrradiance(radRaw);
            const irradiance = irrSrc ? prepareEnv(irrSrc) : radiance;
            const img = radiance.image;
            const mips = Math.trunc(Math.log2(Math.max(img.width, img.height))) + 1;
            // Correctly-oriented copy for scene.background (see
            // makeBackgroundTexture — the IBL texture is mirrored
            // vertically from three's background convention).
            const background = makeBackgroundTexture(radiance);
            return { radiance, irradiance, mips, background, prefilteredIrr: !!irrRaw };
        });
    }
    return envPromise;
};

// Standard MaterialX color spaces accepted on filename inputs.
// Changing one is a CODEGEN decision (the CMS inserts the transform
// into the shader), so the picker goes through the regen override
// path, not a uniform.
const COLORSPACES = ['srgb_texture', 'lin_rec709', 'g22_rec709', 'g18_rec709',
    'acescg', 'lin_ap1', 'srgb_displayp3', 'lin_displayp3', 'adobergb', 'lin_adobergb', 'none'];


// ------------------------------------------------------------------
// createMtlxRenderView — the ENTIRE render pipeline for one
// renderable MaterialX element, encapsulated so both pages share it:
//   generate ESSL (transparency + COMPLETE interface options)
//   -> three.js renderer/camera/orbit -> upload MaterialX uniform
//   defaults (introspection) -> bind env/lights -> geometry ->
//   compile-check -> animation loop.
// Args: { canvas, mx, gen, genContext, renderable, lightData, label,
//         needsLighting, geomName, autoRotate, isMounted, debugKind }
// Returns { uniforms, introspected, vs, fs, controls, renderer,
//           dispose() } or null when isMounted() went false mid-way
// (already cleaned up). Throws Error with a decoded MaterialX/GLSL
// message on failure.
// ------------------------------------------------------------------
const createMtlxRenderView = async ({
    canvas, mx, gen, genContext, renderable, lightData,
    label, needsLighting, geomName,
    autoRotate = true, envBackground = false, isMounted = () => true, debugKind = '',
}) => {
    let reqId = null;
    let renderer = null;
    let resizeObs = null;
    let controls = null;
    let stopped = false;
    // The radiance texture, kept so the caller can toggle it as the
    // visible scene background (setEnvBackground) — the IBL uniforms
    // are bound regardless.
    let envBgTexture = null;
    const disposePartial = () => {
        stopped = true;
        if (reqId) cancelAnimationFrame(reqId);
        if (resizeObs) resizeObs.disconnect();
        if (controls) controls.dispose();
        if (renderer) renderer.dispose();
    };
    try {
                // Generate the shader from the renderable surface node.
                // OFFICIAL PARITY: per-material generation options.
                // Transparency detection switches the generated blending
                // path (glass etc.); COMPLETE interface exposes every
                // input as a uniform for the editor.
                try {
                    if (typeof mx.isTransparentSurface === 'function') {
                        genContext.getOptions().hwTransparency =
                            mx.isTransparentSurface(renderable, gen.getTarget());
                    }
                } catch (e) { /* keep previous value */ }
                try {
                    if (mx.ShaderInterfaceType) {
                        genContext.getOptions().shaderInterfaceType =
                            mx.ShaderInterfaceType.SHADER_INTERFACE_COMPLETE;
                    }
                } catch (e) { /* default interface */ }

                let mxShader;
                try {
                    mxShader = gen.generate('PreviewShader', renderable, genContext);
                } catch (genErr) {
                    // Decode the REAL MaterialX error (Emscripten throws
                    // numeric pointers) instead of a generic string.
                    throw new Error(`Shader generation failed for "${label}": ${mxErr(mx, genErr)}`);
                }

                // Stage identifiers: some JS builds don't expose the
                // mx.Stage enum object (hence "Cannot read ... 'VERTEX'").
                // The underlying constant values are just the strings
                // "vertex" and "pixel", which getSourceCode accepts.
                const VERTEX_STAGE = (mx.Stage && mx.Stage.VERTEX) || 'vertex';
                const PIXEL_STAGE = (mx.Stage && mx.Stage.PIXEL) || 'pixel';
                const vs = stripVersion(mxShader.getSourceCode(VERTEX_STAGE));
                // hwSrgbEncodeOutput makes MaterialX emit its own sRGB
                // encode (visible as srgb-named code in the source). Only
                // inject our fallback when the option didn't take in this
                // wasm build — double-encoding would wash everything out.
                let fs = stripVersion(mxShader.getSourceCode(PIXEL_STAGE));
                if (!/srgb/i.test(fs)) fs = encodeDisplay(fs);
                else if (DEBUG_SHADERS) console.log('generator emitted sRGB encode (hwSrgbEncodeOutput) — no injection');


                // --- three.js scene (WebGL2) ---
                // clientWidth can be 0 before layout; fall back so the
                // viewport isn't 0×0 (which renders nothing → black).
                const cw = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 400;
                const ch = canvas.clientHeight || 256;
                renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
                renderer.setSize(cw, ch, false);
                renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
                renderer.debug.checkShaderErrors = true;
                // NOTE: outputEncoding/toneMapping are NO-OPS for
                // RawShaderMaterial (built-in-material shader chunks).
                // The actual display transform is injected into the
                // generated pixel shader by encodeDisplay() above.
                if ('outputEncoding' in renderer) renderer.outputEncoding = THREE.sRGBEncoding;
                renderer.toneMapping = THREE.ACESFilmicToneMapping;
                renderer.toneMappingExposure = 1.0;

                const scene = new THREE.Scene();
                const camera = new THREE.PerspectiveCamera(45, cw / ch, 0.1, 100);
                // Was z=2.6 — too tight on a radius-1 shape. Slightly
                // elevated three-quarter framing with breathing room.
                camera.position.set(0, 0.5, 3.6);

                // Orbit + zoom + auto-rotate. Rotating the CAMERA (not
                // the mesh) lets manual orbiting, zooming, and the
                // pause button all compose naturally.
                controls = null;
                if (THREE.OrbitControls) {
                    controls = new THREE.OrbitControls(camera, canvas);
                    controls.enableDamping = true;
                    controls.dampingFactor = 0.08;
                    controls.enablePan = false;
                    controls.minDistance = 1.4;
                    controls.maxDistance = 9;
                    controls.autoRotate = !!autoRotate;
                    controls.autoRotateSpeed = 1.5;
                }

                // Keep the drawing buffer + aspect in sync with layout:
                // the params panel appears after init (flex reflow), and
                // mobile rotation/resizes change the canvas CSS size.
                // Without this the sphere stretches on any reflow.
                const syncSize = () => {
                    const w = canvas.clientWidth || cw;
                    const h = canvas.clientHeight || ch;
                    renderer.setSize(w, h, false);
                    camera.aspect = w / h;
                    camera.updateProjectionMatrix();
                };
                if (window.ResizeObserver) {
                    resizeObs = new ResizeObserver(syncSize);
                    resizeObs.observe(canvas);
                }

                // MaterialX-generated shaders expect their own attribute
                // names (i_position, i_normal, i_texcoord_0, i_tangent)
                // and transform uniforms (u_*), so we use RawShaderMaterial
                // (no three.js built-in injection) and feed both manually.
                const uniforms = {
                    u_worldMatrix: { value: new THREE.Matrix4() },
                    u_viewProjectionMatrix: { value: new THREE.Matrix4() },
                    u_worldInverseTransposeMatrix: { value: new THREE.Matrix4() },
                    u_viewPosition: { value: new THREE.Vector3() },
                };

                // --- Upload MaterialX's uniform DEFAULTS (introspection) ---
                // GLSL ES 3.0 forbids `uniform float x = 1.0;` initializers,
                // so the generated ESSL declares bare uniforms and expects
                // the app to upload each default from the shader's uniform
                // blocks. In WebGL an UNSET uniform reads as 0 — so
                // surface_unlit's unconnected `emission` WEIGHT (default
                // 1.0) was 0, multiplying every unlit preview to black,
                // and every PBR weight/color default was 0 too, blacking
                // out lit nodes. Mirrors the official viewer (§7.1).
                let introspected = [];
                for (const stageName of [VERTEX_STAGE, PIXEL_STAGE]) {
                    let st = null;
                    try { st = mxShader.getStage(stageName); } catch (e) { /* stage absent */ }
                    if (st) introspected = introspected.concat(collectMxUniforms(st));
                }
                for (const u of introspected) {
                    if (uniforms[u.name] || u.data == null) continue; // explicit bindings win; no default → leave for WebGL 0
                    const tu = mxValueToThreeUniform(u.type, u.data);
                    if (tu) uniforms[u.name] = tu;
                }
                // Bind the default checker to every `filename` sampler
                // so image/tiledimage nodes render out of the box —
                // an unbound sampler reads black. (Env samplers are
                // bound later by name and are not `filename` ports.)
                for (const u of introspected) {
                    if (u.type === 'filename' && !uniforms[u.name]) {
                        uniforms[u.name] = { value: getDefaultTexture() };
                    }
                }
                if (DEBUG_SHADERS) {
                    console.log('introspected uniforms:',
                        introspected.map((u) => `${u.type} ${u.name}${u.data != null ? ' (default uploaded)' : ''}`));
                    if (!introspected.length) {
                        console.warn('Shader introspection found NO uniform blocks — defaults not uploaded; expect black. (Binding API mismatch — report the mxShader/stage method names.)');
                    }
                }


                // Discover what the generated shader actually declares,
                // so we bind by real names rather than assumptions.
                const declared = parseUniforms(fs).concat(parseUniforms(vs));
                const declaredNames = new Set(declared.map((u) => u.name));
                const has = (n) => declaredNames.has(n);
                // Find a declared sampler whose name matches a pattern.
                const findSampler = (re) =>
                    declared.find((u) => /sampler/i.test(u.type) && re.test(u.name));

                if (DEBUG_SHADERS) {
                    console.group(`MaterialX preview: ${label}`);
                    console.log('kind:', debugKind, 'needsLighting:', needsLighting);
                    console.log('declared uniforms:', declared.map((u) => `${u.type} ${u.name}`));
                    console.log('VERTEX SHADER\n', vs);
                    console.log('PIXEL SHADER\n', fs);
                    console.groupEnd();
                }

                // Image-based lighting for lit surfaces/BSDFs. Bind the
                // env textures to whatever sampler names the shader really
                // uses (u_envRadiance / u_envIrradiance in current builds,
                // but matched loosely so version drift doesn't leave them
                // unbound → black).
                if (needsLighting) {
                    const env = await getEnvironment();
                    if (!isMounted()) { disposePartial(); return null; }
                    let radiance, irradiance, mips, bgTex;
                    if (env) {
                        radiance = env.radiance; irradiance = env.irradiance; mips = env.mips;
                        bgTex = env.background;
                    } else {
                        radiance = makeEnvTexture(256, 128, false);
                        irradiance = makeEnvTexture(64, 32, true);
                        mips = Math.floor(Math.log2(256)) + 1;
                        // Same convention gap as the HDR path: the
                        // synthesized data is top-first too, so the
                        // background needs its own flipY=true copy.
                        bgTex = makeBackgroundTexture(radiance);
                    }
                    const radSampler = findSampler(/radiance|specular|prefilter/i);
                    const irrSampler = findSampler(/irradiance|diffuse/i);
                    if (radSampler) uniforms[radSampler.name] = { value: radiance };
                    if (irrSampler) uniforms[irrSampler.name] = { value: irradiance };
                    // The (optional) visible background is a SEPARATE,
                    // flipY=true copy of the radiance — reusing the IBL
                    // texture directly renders the environment mirrored
                    // vertically (see makeBackgroundTexture). Matches the
                    // official viewer, whose background is the raw loader
                    // texture, not the prepareEnvTexture copy.
                    envBgTexture = bgTex;
                    if (envBackground) scene.background = bgTex;
                    // OFFICIAL PARITY: env matrix is ALWAYS a +90° Y
                    // rotation (getLightRotation in main.js) — identity
                    // orients the environment differently from the
                    // reference render.
                    if (has('u_envMatrix')) uniforms.u_envMatrix = { value: new THREE.Matrix4().makeRotationY(Math.PI / 2) };
                    if (has('u_envRadianceMips')) uniforms.u_envRadianceMips = { value: mips };
                    if (has('u_envRadianceSamples')) uniforms.u_envRadianceSamples = { value: 16 };
                    if (has('u_envLightIntensity') && !uniforms.u_envLightIntensity) uniforms.u_envLightIntensity = { value: 1.0 };
                    if (has('u_refractionEnv')) uniforms.u_refractionEnv = { value: true };
                    // Direct light rig (struct-array uniform; three maps
                    // {type,direction,color,intensity} onto the generated
                    // LightData struct members by name).
                    const nLights = (lightData && lightData.length) || 0;
                    if (has('u_numActiveLightSources')) uniforms.u_numActiveLightSources = { value: nLights };
                    if (nLights && has('u_lightData')) uniforms.u_lightData = { value: lightData };
                    if (DEBUG_SHADERS) {
                        console.log('env bound → radiance:', radSampler && radSampler.name,
                                    '| irradiance:', irrSampler && irrSampler.name,
                                    env ? (env.prefilteredIrr ? '(radiance + prefiltered irradiance files)' : '(radiance file; irradiance downsampled — drop ./irradiance.hdr for official parity)') : '(synthesized)',
                                    '| direct lights:', (lightData && lightData.length) || 0);
                        const envUnbound = declared.filter((u) => /sampler/i.test(u.type) && /env/i.test(u.name) && !uniforms[u.name]);
                        if (envUnbound.length) console.warn('UNBOUND env samplers (likely cause of black):', envUnbound.map((u) => u.name));
                    }
                }

                const material = new THREE.RawShaderMaterial({
                    vertexShader: vs,
                    fragmentShader: fs,
                    glslVersion: THREE.GLSL3,
                    uniforms,
                    side: THREE.DoubleSide,
                });

                // Selected preview geometry (sphere/cube/shaderball),
                // attributes aliased to MaterialX names + tangents.
                const geometry = prepGeometry(await buildPreviewGeometry(geomName));
                if (!isMounted()) { disposePartial(); return null; }

                const mesh = new THREE.Mesh(geometry, material);
                scene.add(mesh);

                const vp = new THREE.Matrix4();
                const setUniforms = () => {
                    mesh.updateMatrixWorld();
                    camera.updateMatrixWorld();
                    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
                    uniforms.u_worldMatrix.value.copy(mesh.matrixWorld);
                    vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
                    uniforms.u_viewProjectionMatrix.value.copy(vp);
                    uniforms.u_worldInverseTransposeMatrix.value
                        .copy(mesh.matrixWorld).invert().transpose();
                    camera.getWorldPosition(uniforms.u_viewPosition.value);
                };

                // Compile now and surface any GLSL error to the UI instead
                // of failing to a silent black canvas.
                setUniforms();
                renderer.compile(scene, camera);
                const badProg = (renderer.info.programs || []).find(
                    (p) => p.diagnostics && p.diagnostics.runnable === false
                );
                if (badProg) {
                    const d = badProg.diagnostics;
                    const log = (d.programLog || '') + '\n' +
                        (d.fragmentShader && d.fragmentShader.log ? 'FRAG: ' + d.fragmentShader.log : '') +
                        (d.vertexShader && d.vertexShader.log ? ' VERT: ' + d.vertexShader.log : '');
                    console.error('MaterialX shader compile error:', log);
                    throw new Error(`Shader compile error for "${label}". See console. ${log.slice(0, 160)}`);
                }

                const animate = () => {
                    if (stopped || !isMounted()) return;
                    reqId = requestAnimationFrame(animate);
                    if (controls) {
                        controls.update(); // damping + autoRotate
                    } else {
                        // OrbitControls script blocked → old behavior.
                        mesh.rotation.y += 0.005;
                    }
                    setUniforms();
                    renderer.render(scene, camera);
                };
                animate();

        return {
            uniforms, introspected, vs, fs, controls, renderer,
            // Live camera auto-rotation toggle (no regen needed).
            setAutoRotate: (on) => { if (controls) controls.autoRotate = !!on; },
            // Show/hide the environment map as the visible background.
            // No-op when there is no env (unlit previews).
            setEnvBackground: (on) => {
                scene.background = (on && envBgTexture) ? envBgTexture : null;
            },
            // PNG snapshot of the CURRENT view. The drawing buffer isn't
            // preserved between frames (preserveDrawingBuffer:false), so
            // render synchronously right before reading it back.
            snapshot: () => {
                setUniforms();
                renderer.render(scene, camera);
                return renderer.domElement.toDataURL('image/png');
            },
            dispose: disposePartial,
        };
    } catch (err) {
        disposePartial();
        throw err;
    }
};

// ---- public API ----
Object.assign(window, {
    getMxEnv, DEBUG_SHADERS,
    parseUniforms, stripVersion, encodeDisplay,
    mxErr, mxWriteValue, vecToArray,
    collectMxUniforms, mxValueToThreeUniform,
    linToSrgb, srgbToLin, rgbToHex, hexToRgb,
    getDefaultTexture, configureLoadedTexture,
    prepGeometry, normalizeGeometry, buildPreviewGeometry,
    COLOR_VIEWABLE, resolveNodeKind,
    makeEnvTexture, getEnvironment, COLORSPACES,
    createMtlxRenderView,
});