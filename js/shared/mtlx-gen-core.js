// mtlx-gen-core.js, the MaterialX shader-generation core shared by the page
// and the thumbnail worker: GLSL patches, document helpers, file resolvers and
// the budgeted generator. No window, document, localStorage or THREE here;
// everything environmental goes through MtlxGenCore.setHost.
(() => {
// Host providers, each read lazily at the call site. Defaults are the
// behaviour of a page with no overrides; the engine installs real readers.
const HOST_DEFAULTS = {
    lightLimit: () => true,
    featureGated: () => true,
    constInputs: () => true,
    displacementConstInputs: () => true,
    specularEnvMethod: () => 'prefilter',
    heightToNormalTexel: () => false,
    samplerBudgetOverride: () => undefined,
    perfLog: () => false,
    debugShaders: () => false,
};
const host = Object.assign({}, HOST_DEFAULTS);
const setHost = (providers) => {
    for (const k of Object.keys(providers || {})) {
        if (!(k in HOST_DEFAULTS)) throw new Error('MtlxGenCore.setHost: unknown hook ' + k);
        if (typeof providers[k] !== 'function') throw new Error('MtlxGenCore.setHost: hook ' + k + ' must be a function');
        host[k] = providers[k];
    }
};
// Plain-JSON view of every hook, so a worker can mirror the page.
const hostSnapshot = () => {
    const snap = {};
    for (const k of Object.keys(HOST_DEFAULTS)) {
        const v = host[k]();
        snap[k] = v === undefined ? null : v;
    }
    return snap;
};
const setHostFromSnapshot = (obj) => {
    const providers = {};
    for (const k of Object.keys(obj || {})) {
        if (!(k in HOST_DEFAULTS)) continue;
        const v = obj[k] === null ? undefined : obj[k];
        providers[k] = () => v;
    }
    setHost(providers);
};

// MaterialX light shader ids. The id bound with bindLightShader IS the
// LightData.type the generated sampleLightSource() switches on, so these
// are part of the shader contract and must not be renumbered.
const LIGHT_TYPE_DIRECTIONAL = 1;
const LIGHT_TYPE_POINT = 2;
const LIGHT_TYPE_SPOT = 3;
// Per-light source shape, kept separate from MaterialX's light type because
// an area emitter is represented by several point/spot samples. The shader
// uses this to apply the source-side cosine to only those samples.
const LIGHT_SOURCE_KIND_AREA = 1;
// Slots reserved for lights imported from a USD stage. This lands in the
// generated GLSL as part of MAX_LIGHT_SOURCES, so it is decided once before
// the first shader is generated and can never grow at runtime. Unused slots
// cost nothing: the light loop is bounded by u_numActiveLightSources.
//
// 16 is a ceiling, not a preference. LightData is 8 vec4 slots wide (int +
// 3 vec3 + 4 float), so 16 stage slots plus the env key light is 136 uniform
// vectors, still inside the 224 that GLES 3 guarantees. Raising it buys
// finer area-light subdivision at the risk of failing to link on a GPU at
// that floor, and this define lands in EVERY material in both apps.
const STAGE_LIGHT_SLOTS = 16;
// Rig lights parsed from environment_map.mtlx, recorded here so the
// light-limit tiers can size one generation without the getMxEnv closure.
let mxRigLightCount = 0;
const readLightLimit = () => {
    return host.lightLimit();
};
// Stage-light slot tiers. MAX_LIGHT_SOURCES is baked into the generated
// source, so a tool that can never hold a stage light compiles a body per
// light slot it will never use (17 slots is 8.4s vs 3.7s on a glass shader).
const STAGE_LIGHT_TIERS = [0, 4, 8, STAGE_LIGHT_SLOTS];
// Viewer, Compare, docs previews, Graph previews and embeds bind the rig
// plus the environment key light and nothing else (currentLights is called
// there without stageLights), so their tier can never be exceeded.
const PREVIEW_STAGE_LIGHT_COUNT = 0;
const readFeatureGated = () => {
    return host.featureGated();
};
// Features no preview tool can ever turn on: the Viewer, Compare, docs and
// Graph previews and the embeds bind white shadow moments and a zero-strength
// occlusion volume, so generating either costs compile time for a no-op.
// skipLocalEnv/skipBounce are inert here too (no local reflection probe or
// baked bounce volume in preview), so gating them off frees two samplers.
const PREVIEW_FEATURE_OPTIONS = { skipShadowMap: true, skipOcclusion: true, skipLocalEnv: true, skipBounce: true };
// Smallest tier that still covers `count`; anything unknown or over the
// ceiling falls back to the full reservation.
const chooseStageLightTier = (count) => {
    const n = Number(count);
    if (!Number.isFinite(n) || n < 0) return STAGE_LIGHT_SLOTS;
    const tier = STAGE_LIGHT_TIERS.find((t) => t >= n);
    return tier === undefined ? STAGE_LIGHT_SLOTS : tier;
};

// Wasm calls must be serialized, the heap can GROW mid-call
// (ALLOW_MEMORY_GROWTH), detaching a concurrent call's typed-array
// views ("memory access out of bounds"). One promise chain at a time.
let mxQueueTail = Promise.resolve();
// Lock-discipline diagnostics (see mxWarnIfLocked). mxLockDepth counts
// in-flight mxExclusive calls; mxExclusiveHeldSync is true only while
// fn's own sync body runs, distinguishing in-lock calls from unlocked ones.
let mxLockDepth = 0;
let mxExclusiveHeldSync = false;
function mxExclusive(fn) {
    mxLockDepth++;
    const run = () => Promise.resolve().then(() => {
        mxExclusiveHeldSync = true;
        try {
            return fn();
        } finally {
            mxExclusiveHeldSync = false;
        }
    });
    const p = mxQueueTail.then(run, run);
    // The tail must never carry a rejection forward (it would look like
    // every later caller failed), settle it to undefined either way.
    mxQueueTail = p.then(() => undefined, () => undefined);
    // Lock depth follows the OUTER promise (fn plus anything it awaits),
    // not just the synchronous run() above, settles whether fn resolved
    // or rejected.
    p.then(() => { mxLockDepth--; }, () => { mxLockDepth--; });
    return p;
}

// Tripwire for synchronous wasm helpers called lock-free from the JSX
// layer (can't self-lock without turning async). Never throws/blocks,
// only warns when one runs during a genuinely concurrent mxExclusive op.
const mxWarnIfLocked = (name) => {
    if (mxLockDepth > 0 && !mxExclusiveHeldSync) {
        console.warn('[mtlx] ' + name + ' called while an exclusive wasm operation is in flight, possible heap-detach hazard; route this call through mxExclusive.');
    }
};

// Gated console.warn for expected/recoverable conditions (e.g. a missing
// texture) that would otherwise spam every load; real warnings stay
// ungated. Exported as window.mtlxWarn for consumers loaded after this file.
const mtlxWarn = (...args) => { if (host.debugShaders()) console.warn(...args); };

// Scrapes `uniform <type> u_<name>;` declarations from generated source
// so bindings use the shader's real names. Returns [{ type, name }, ...].
const parseUniforms = (src) => {
    const out = [];
    const re = /uniform\s+(\w+)\s+(u_\w+)\s*(?:\[\s*\w+\s*\])?\s*;/g;
    let m;
    while ((m = re.exec(src)) !== null) out.push({ type: m[1], name: m[2] });
    return out;
};

// Counts sampler declarations that cost a texture image unit, including
// precision-qualified ones that parseUniforms misses; arrays count by
// their length. Enforces the MAX_TEXTURE_IMAGE_UNITS budget.
const countFragmentSamplers = (fs) => {
    const re = /uniform\s+(?:(?:low|medium|high)p\s+)?(sampler2D|sampler3D|samplerCube)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*;/g;
    const names = [];
    let count = 0;
    // Scene/engine samplers are all u_-prefixed; a material's own texture
    // reads are named after their image node (<node>_file).
    let scene = 0;
    let m;
    while ((m = re.exec(fs)) !== null) {
        const size = m[3] ? parseInt(m[3], 10) : 1;
        count += size;
        if (/^u_/.test(m[2])) scene += size;
        names.push(m[3] ? m[2] + '[' + m[3] + ']' : m[2]);
    }
    return { count, names, scene, material: count - scene };
};

// Estimates fragment uniform vector cost against MAX_FRAGMENT_UNIFORM_VECTORS.
// Struct rows: scalars/vectors 1, mat2 2, mat3 3, mat4 4, nested structs
// recursively. Uniform declarations: samplers 0, arrays times size, struct
// types their row sum. Returns { estimate, largest } (top five by rows).
const estimateFragmentUniformVectors = (fs) => {
    const defines = new Map();
    const defineRe = /#define\s+(\w+)\s+(\d+)\b/g;
    let dm;
    while ((dm = defineRe.exec(fs)) !== null) defines.set(dm[1], parseInt(dm[2], 10));
    const resolveSize = (token) => (/^\d+$/.test(token) ? parseInt(token, 10) : (defines.has(token) ? defines.get(token) : 1));
    const structRows = new Map();
    const baseTypeRows = (type) => {
        if (structRows.has(type)) return structRows.get(type);
        if (type === 'mat2' || type === 'mat2x2') return 2;
        if (type === 'mat3' || type === 'mat3x3') return 3;
        if (type === 'mat4' || type === 'mat4x4') return 4;
        return 1;
    };
    const structRe = /struct\s+(\w+)\s*\{([^}]*)\}/g;
    const memberRe = /(?:(?:low|medium|high)p\s+)?(\w+)\s+\w+\s*(?:\[\s*(\w+)\s*\])?\s*;/g;
    let sm;
    while ((sm = structRe.exec(fs)) !== null) {
        let rows = 0;
        let mm;
        memberRe.lastIndex = 0;
        while ((mm = memberRe.exec(sm[2])) !== null) rows += baseTypeRows(mm[1]) * (mm[2] ? resolveSize(mm[2]) : 1);
        structRows.set(sm[1], rows);
    }
    const isSampler = (type) => /^sampler(2D|3D|Cube)$/.test(type);
    const uniformRe = /uniform\s+(?:(?:low|medium|high)p\s+)?(\w+)\s+(\w+)\s*(?:\[\s*(\w+)\s*\])?\s*;/g;
    const entries = [];
    let um;
    while ((um = uniformRe.exec(fs)) !== null) {
        const [, type, name, sizeToken] = um;
        const size = sizeToken ? resolveSize(sizeToken) : 1;
        const rows = isSampler(type) ? 0 : baseTypeRows(type) * size;
        entries.push({ name, type, rows });
    }
    const estimate = entries.reduce((sum, e) => sum + e.rows, 0);
    const largest = entries.slice().sort((a, b) => b.rows - a.rows).slice(0, 5);
    return { estimate, largest };
};

// three.js RawShaderMaterial + glslVersion:GLSL3 prepends its own
// "#version 300 es"; MaterialX ESSL output already has one. Strip the
// generated version line to avoid a duplicate-directive compile error.
const stripVersion = (src) => src.replace(/^\s*#version[^\n]*\n/, '');

// Scrapes `in <type> i_<name>;` vertex attribute declarations from the
// vertex stage. Returns [{ type, name }, ...].
const parseVertexInputs = (vs) => {
    const out = [];
    const re = /^\s*in\s+(\w+)\s+(i_\w+)\s*;/gm;
    let m;
    while ((m = re.exec(vs)) !== null) out.push({ type: m[1], name: m[2] });
    return out;
};

// Integer geomprop varyings need GLSL ES 3.00's "flat" qualifier, and every
// stream this viewer binds is a Float32 attribute, so the vertex ATTRIBUTE
// side is redeclared as the matching float type and rounded back to int
// for the varying and any other in-stage use.
const INT_GEOMPROP_TYPES = {
    int: 'float', ivec2: 'vec2', ivec3: 'vec3', ivec4: 'vec4',
    uint: 'float', uvec2: 'vec2', uvec3: 'vec3', uvec4: 'vec4'
};
const isIntGeompropType = (type) => Object.prototype.hasOwnProperty.call(INT_GEOMPROP_TYPES, type);

// ESSL's geompropvalue node names both the vertex input and the vertex-data
// connector "i_geomprop_<name>" (the GLSL generator hides this behind a
// vd. struct; ESSL emits flat varyings), producing a redefinition of the
// "out" declaration and an invalid self-assignment connector line. Renames
// only the connector side to "vd_geomprop_<name>" in both stages. No match
// is a no-op (fail-soft): shaders without geompropvalue are untouched.
const patchGeompropVaryings = (vs, fs) => {
    const outRe = /^\s*out\s+(\w+)\s+i_geomprop_(\w+)\s*;/gm;
    const hasOut = outRe.test(vs);
    const inRe = /^\s*in\s+\w+\s+i_geomprop_\w+\s*;/m;
    if (!hasOut && inRe.test(vs)) {
        mtlxWarn('mtlx-engine: found a vertex "in i_geomprop_*" without a matching "out", patchGeompropVaryings skipped.');
    }
    // Connector type per geomprop name, gathered before any rewrite.
    const connectorTypes = new Map();
    outRe.lastIndex = 0;
    let om;
    while ((om = outRe.exec(vs)) !== null) connectorTypes.set(om[2], om[1]);

    const vsLines = vs.split('\n').map((line) => {
        const declMatch = line.match(/^(\s*)in\s+(\w+)\s+i_geomprop_(\w+)\s*;/);
        if (declMatch) {
            const [, indent, type, name] = declMatch;
            const floatType = INT_GEOMPROP_TYPES[type];
            return floatType ? `${indent}in ${floatType} i_geomprop_${name};` : line;
        }
        const outMatch = line.match(/^(\s*)out\s+(\w+)\s+i_geomprop_(\w+)\s*;/);
        if (outMatch) {
            const [, indent, type, name] = outMatch;
            return `${indent}${isIntGeompropType(type) ? 'flat ' : ''}out ${type} vd_geomprop_${name};`;
        }
        const connMatch = line.match(/^(\s*)i_geomprop_(\w+)\s*=\s*i_geomprop_\2\s*;/);
        if (connMatch) {
            const [, indent, name] = connMatch;
            const type = connectorTypes.get(name);
            return isIntGeompropType(type)
                ? `${indent}vd_geomprop_${name} = ${type}(round(i_geomprop_${name}));`
                : `${indent}vd_geomprop_${name} = i_geomprop_${name};`;
        }
        // Any other in-stage use of an integer geomprop (e.g. displacement
        // reading it directly) rounds the float attribute back to its int type.
        let out = line;
        for (const [name, type] of connectorTypes) {
            if (!isIntGeompropType(type)) continue;
            out = out.replace(new RegExp('\\bi_geomprop_' + name + '\\b', 'g'), `${type}(round(i_geomprop_${name}))`);
        }
        return out;
    });
    const patchedVs = vsLines.join('\n');

    const patchedFs = fs
        .replace(/\bi_geomprop_(\w+)\b/g, 'vd_geomprop_$1')
        .replace(/^(\s*)in\s+(\w+)\s+vd_geomprop_(\w+)\s*;/gm, (full, indent, type, name) =>
            `${indent}${isIntGeompropType(type) ? 'flat ' : ''}in ${type} vd_geomprop_${name};`);
    return { vs: patchedVs, fs: patchedFs };
};

// Finds CALL sites of fnName in GLSL source text (not its definition:
// generated fragment sources inline the library function body right
// above its call sites, and a naive non-greedy ")...;" regex matches
// INTO that definition's body instead of stopping at its own params).
// Balances parens from the opening "(" to find the real end, then
// requires the next non-space character to be ";" (a call statement;
// a definition's params are followed by "{" instead).
const findGlslCalls = (text, fnName) => {
  const calls = [];
  const idRe = new RegExp('\\b' + fnName + '\\s*\\(', 'g');
  let m;
  while ((m = idRe.exec(text)) !== null) {
    const before = text.slice(Math.max(0, m.index - 8), m.index);
    if (/\bvoid\s*$/.test(before)) continue; // "void fnName(" is the definition
    const openParenIdx = m.index + m[0].length - 1;
    let depth = 1, i = openParenIdx + 1;
    while (i < text.length && depth > 0) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') depth--;
      i++;
    }
    if (depth !== 0) continue; // unbalanced, bail out defensively
    const closeParenIdx = i - 1;
    let j = i;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] !== ';') continue; // followed by "{" => a definition, skip
    calls.push({ argsText: text.slice(openParenIdx + 1, closeParenIdx), start: m.index, end: j + 1 });
  }
  return calls;
};

// Splits a GLSL call's argument list on top-level commas only (args can
// themselves be calls, e.g. "vec2(0.000000, 0.000000)").
const splitGlslArgs = (argsText) => {
    const out = [];
    let depth = 0, start = 0;
    for (let i = 0; i < argsText.length; i++) {
        const c = argsText[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth === 0) { out.push(argsText.slice(start, i).trim()); start = i + 1; }
    }
    out.push(argsText.slice(start).trim());
    return out;
};

// Generic version of findGlslCalls: finds every CALL statement (any
// function name), not just one. Used to trace height sources through
// arbitrary helper calls (separate3, extract, nodegraph wrappers).
const findAllCallStatements = (text) => {
    const calls = [];
    const idRe = /\b(\w+)\s*\(/g;
    let m;
    while ((m = idRe.exec(text)) !== null) {
        const before = text.slice(Math.max(0, m.index - 8), m.index);
        if (/\bvoid\s*$/.test(before)) continue; // definition, not a call
        const openParenIdx = m.index + m[0].length - 1;
        let depth = 1, i = openParenIdx + 1;
        while (i < text.length && depth > 0) {
            if (text[i] === '(') depth++;
            else if (text[i] === ')') depth--;
            i++;
        }
        if (depth !== 0) continue;
        const closeParenIdx = i - 1;
        let j = i;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] !== ';') continue;
        calls.push({ fnName: m[1], argsText: text.slice(openParenIdx + 1, closeParenIdx), start: m.index, end: j + 1 });
    }
    return calls;
};

// Finds every "void NAME(params) { ... }" definition in GLSL source text
// (generated shaders inline nodegraph bodies as plain functions, e.g.
// NG_bump_vector3), including main() itself. Used to scope height-source
// tracing per-function and to resolve a parameter back to its call-site
// argument when a call site passes the height through a wrapper function.
const findFunctionDefs = (text) => {
    const defs = [];
    const re = /\bvoid\s+(\w+)\s*\(/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        const openParenIdx = m.index + m[0].length - 1;
        let depth = 1, i = openParenIdx + 1;
        while (i < text.length && depth > 0) {
            if (text[i] === '(') depth++;
            else if (text[i] === ')') depth--;
            i++;
        }
        if (depth !== 0) continue;
        const paramsText = text.slice(openParenIdx + 1, i - 1);
        let j = i;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] !== '{') continue; // not immediately followed by a body: not a definition we can scope
        let bodyDepth = 1, k = j + 1;
        while (k < text.length && bodyDepth > 0) {
            if (text[k] === '{') bodyDepth++;
            else if (text[k] === '}') bodyDepth--;
            k++;
        }
        if (bodyDepth !== 0) continue;
        const params = splitGlslArgs(paramsText).filter((p) => p.length).map((p) => {
            const parts = p.trim().split(/\s+/);
            return { name: parts[parts.length - 1], type: parts.slice(0, -1).join(' ') };
        });
        defs.push({ name: m[1], params, bodyStart: j + 1, bodyEnd: k - 1 });
    }
    return defs;
};

const findEnclosingFunction = (pos, funcDefs) =>
    funcDefs.find((f) => pos >= f.bodyStart && pos <= f.bodyEnd);

// uv_scale/uv_offset arrive as UNIFORM NAMES in generated GLSL (MaterialX
// never inlines them as literals), so "identity" is checked against the
// uniform's own MaterialX-introspected default value (collectMxUniforms
// entries, { name, type, data }), not the call-site text. A bare vec2(..)
// literal is also accepted, in case a future codegen path does inline it.
const isIdentityVec2Arg = (expr, introspected, x, y) => {
    const lit = expr.match(/^vec2\(\s*([-\d.eE]+)\s*,\s*([-\d.eE]+)\s*\)$/);
    if (lit) return Math.abs(parseFloat(lit[1]) - x) < 1e-4 && Math.abs(parseFloat(lit[2]) - y) < 1e-4;
    const u = introspected && introspected.find((e) => e.name === expr && e.type === 'vector2');
    if (!u || !Array.isArray(u.data) || u.data.length < 2) return false;
    return Math.abs(u.data[0] - x) < 1e-4 && Math.abs(u.data[1] - y) < 1e-4;
};

const HEIGHTTONORMAL_TEXEL_FN = `
void mx_heighttonormal_vector3_texel(sampler2D tex, vec2 uv, float scale, out vec3 result)
{
    // Finite-difference gradient over texels, matching common DCC bump
    // nodes, instead of upstream's per-UV screen-derivative gradient
    // (which blows up on high-resolution height textures).
    vec2 texel = 1.0 / vec2(textureSize(tex, 0));
    float hL = texture(tex, uv - vec2(texel.x, 0.0)).r;
    float hR = texture(tex, uv + vec2(texel.x, 0.0)).r;
    float hD = texture(tex, uv - vec2(0.0, texel.y)).r;
    float hU = texture(tex, uv + vec2(0.0, texel.y)).r;
    float gx = (hR - hL) * 0.5;
    float gy = (hU - hD) * 0.5;
    // Mirrored UVs flip the tangent-frame handedness; match upstream's
    // n.z<0 flip via the UV Jacobian's sign instead (no cross product here).
    vec2 dUdS = vec2(dFdx(uv.x), dFdy(uv.x));
    vec2 dVdS = vec2(dFdx(uv.y), dFdy(uv.y));
    if (dUdS.x * dVdS.y - dUdS.y * dVdS.x < 0.0) { gx = -gx; gy = -gy; }
    result = normalize(vec3(-gx * scale, -gy * scale, 1.0)) * 0.5 + 0.5;
}
`;

// Hex-tiled height sampling blends three rotated tile lookups (no single
// texel grid exists to resample), so this keeps upstream's own
// screen-derivative formula and only divides the gradient by N (the
// sampler's largest texel dimension) for texel-unit semantics.
const HEIGHTTONORMAL_HEXTILE_TEXEL_FN = `
void mx_heighttonormal_vector3_hextile_texel(float height, sampler2D tex, vec2 texcoord, float scale, out vec3 result)
{
    float N = float(max(textureSize(tex, 0).x, textureSize(tex, 0).y));
    vec2 dHdS = vec2(dFdx(height), dFdy(height)) * scale * (1.0 / 16.0) / N;
    vec2 dUdS = vec2(dFdx(texcoord.x), dFdy(texcoord.x));
    vec2 dVdS = vec2(dFdx(texcoord.y), dFdy(texcoord.y));
    vec3 tangent = vec3(dUdS.x, dVdS.x, dHdS.x);
    vec3 bitangent = vec3(dUdS.y, dVdS.y, dHdS.y);
    vec3 n = cross(tangent, bitangent);
    if (dot(n, n) < 1e-16) { n = vec3(0, 0, 1); }
    else if (n.z < 0.0) { n *= -1.0; }
    result = normalize(n) * 0.5 + 0.5;
}
`;

// Functions whose call passes the source vector as its first arg and the
// extracted channel(s) as later "out" args, e.g. NG_separate3_color3(in1,
// outr, outg, outb) or an inlined extract nodegraph's NG_extract_*(in1,
// index, out). Matched by generated-name prefix, case sensitive.
const CHANNEL_EXTRACT_FN_RE = /^(NG_separate[234]_|NG_extract_|mx_extract_)/;

// Traces `varName` (used as the H argument of a heighttonormal call, or
// as an intermediate found along the way) back to a sampler-based source,
// within a single function's body text (GLSL has no nested functions, so
// a function's own body is a closed scope for local variables).
// Handles direct mx_image_*/mx_hextiledimage_* results, simple aliasing
// ("H = tmp;"), component extracts ("H = tmp.x;"/"H = tmp[0];"), and
// separate3/extract-style calls. Crosses into the caller's scope when
// `varName` turns out to be a formal parameter (see resolveAcrossCall
// below), so a height traced through a nodegraph-turned-function (e.g.
// NG_bump_vector3) still resolves. Returns { kind: 'image', sampler,
// texcoord } | { kind: 'hextiled', sampler } | null.
const traceHeightSource = (varName, funcDef, fs, allFuncs, introspected, notices, depth) => {
    if (depth > 6) return null; // defensive cap, real chains are 2-3 deep
    const body = fs.slice(funcDef.bodyStart, funcDef.bodyEnd + 1);

    // 1) Direct sampler-backed result: mx_image_<type>(...) / mx_hextiledimage_<type>(...).
    for (const call of findAllCallStatements(body)) {
        const args = splitGlslArgs(call.argsText);
        const isImage = /^mx_image_(float|color3|color4|vector2|vector3|vector4)$/.test(call.fnName);
        const isHextiled = /^mx_hextiledimage_(color3|color4)$/.test(call.fnName);
        if (!isImage && !isHextiled) continue;
        const resultVar = args[args.length - 1];
        if (resultVar !== varName) continue;
        if (isImage) {
            if (args.length < 13) continue;
            const sampler = args[0], texcoord = args[3], uvScale = args[10], uvOffset = args[11];
            if (!isIdentityVec2Arg(uvScale, introspected, 1, 1) || !isIdentityVec2Arg(uvOffset, introspected, 0, 0)) {
                notices.push(`heighttonormal: skipped a call site (non-identity uv_scale/uv_offset on "${resultVar}")`);
                return null;
            }
            return { kind: 'image', sampler, texcoord };
        }
        return { kind: 'hextiled', sampler: args[0] };
    }

    // 2) Simple alias / component extract: "[type] H = X;" / "H = X.c;" / "H = X[n];".
    const aliasRe = new RegExp('(?:^|[;{}\\s])(?:\\w+\\s+)?' + varName + '\\s*=\\s*([A-Za-z_]\\w*)\\s*(?:\\.\\w+|\\[\\s*\\d+\\s*\\])?\\s*;');
    const aliasMatch = body.match(aliasRe);
    if (aliasMatch && aliasMatch[1] !== varName) {
        return traceHeightSource(aliasMatch[1], funcDef, fs, allFuncs, introspected, notices, depth + 1);
    }

    // 3) separate3/extract-style calls: varName is one of the output args.
    for (const call of findAllCallStatements(body)) {
        if (!CHANNEL_EXTRACT_FN_RE.test(call.fnName)) continue;
        const args = splitGlslArgs(call.argsText);
        if (args.length < 2 || !args.slice(1).includes(varName)) continue;
        return traceHeightSource(args[0], funcDef, fs, allFuncs, introspected, notices, depth + 1);
    }

    // 4) varName is a formal parameter of this function: follow its ONLY
    // call site back into the caller's scope. Skipped (ambiguous) if the
    // function is called from more than one place, or the actual argument
    // isn't a bare variable, since it isn't safe to rewrite a SHARED
    // function body for just one of its callers.
    const paramIdx = funcDef.params.findIndex((p) => p.name === varName);
    if (paramIdx === -1) return null;
    const callSites = findGlslCalls(fs, funcDef.name);
    if (callSites.length !== 1) return null;
    const callerArgs = splitGlslArgs(callSites[0].argsText);
    const actualArg = callerArgs[paramIdx] && callerArgs[paramIdx].trim();
    if (!actualArg || !/^\w+$/.test(actualArg)) return null;
    const callerFunc = findEnclosingFunction(callSites[0].start, allFuncs);
    if (!callerFunc) return null;
    return traceHeightSource(actualArg, callerFunc, fs, allFuncs, introspected, notices, depth + 1);
};

// Experimental opt-in (see HEIGHT_TO_NORMAL_TEXEL above): rewrites
// mx_heighttonormal_vector3(H, S, T, OUT) call sites whose height H
// traces back (through assignments, component extracts, separate/extract
// chains, and nodegraph-turned-function parameters) to a sampler-based
// source, to a texel-space gradient instead. A plain mx_image_* source
// resamples the sampler directly; a hextiledimage source (three rotated
// tile blends, no single texel grid) keeps upstream's own screen-
// derivative formula but scales it by 1/N instead. Anything that doesn't
// trace to a sampler, or whose uv_scale/uv_offset aren't identity, is
// left untouched (upstream behavior).
const applyHeightToNormalTexel = (fs, notices, introspected) => {
    if (!host.heightToNormalTexel()) return fs;
    const allFuncs = findFunctionDefs(fs);
    const h2nCalls = findGlslCalls(fs, 'mx_heighttonormal_vector3');
    if (!h2nCalls.length) return fs;
    let rewrittenImage = 0, rewrittenHextile = 0;
    // Rebuild right-to-left so earlier offsets stay valid as later (later
    // in text order, processed first here) spans are replaced.
    for (let k = h2nCalls.length - 1; k >= 0; k--) {
        const call = h2nCalls[k];
        const args = splitGlslArgs(call.argsText);
        if (args.length !== 4) continue;
        const [heightVar, scale, texcoord, outVar] = args;
        const enclosing = findEnclosingFunction(call.start, allFuncs);
        if (!enclosing) continue;
        const src = traceHeightSource(heightVar, enclosing, fs, allFuncs, introspected, notices, 0);
        if (!src) continue;
        let replacement;
        if (src.kind === 'image') {
            replacement = `mx_heighttonormal_vector3_texel(${src.sampler}, ${src.texcoord}, ${scale}, ${outVar});`;
            rewrittenImage++;
        } else {
            replacement = `mx_heighttonormal_vector3_hextile_texel(${heightVar}, ${src.sampler}, ${texcoord}, ${scale}, ${outVar});`;
            rewrittenHextile++;
        }
        fs = fs.slice(0, call.start) + replacement + fs.slice(call.end);
    }
    const rewritten = rewrittenImage + rewrittenHextile;
    if (rewritten > 0) {
        // Insert after any leading "precision ...;" directives, not at
        // position 0: ESSL requires those before the first float/int/
        // sampler use, and our injected functions have all three.
        let insertAt = 0;
        const precisionRe = /^precision\s+\w+\s+\w+\s*;\s*$/gm;
        let pm;
        while ((pm = precisionRe.exec(fs)) !== null) insertAt = pm.index + pm[0].length;
        let injected = '';
        if (rewrittenImage) injected += HEIGHTTONORMAL_TEXEL_FN;
        if (rewrittenHextile) injected += HEIGHTTONORMAL_HEXTILE_TEXEL_FN;
        fs = fs.slice(0, insertAt) + '\n' + injected + fs.slice(insertAt);
        notices.push(`heighttonormal: ${rewritten} call(s) use texel-space gradients (experimental)`);
    }
    return fs;
};

// Hair helper pbrlib nodes pull in the full BSDF/lighting include chain,
// which the generator only emits for LIT shaders, leaving an unlit
// preview referencing undefined symbols; this patches in no-op stubs.
const patchUnlitLightingRefs = (src) => {
    const referencedNotDefined = (name) =>
        new RegExp('\\b' + name + '\\s*\\(').test(src) &&
        !new RegExp('vec3\\s+' + name + '\\s*\\(').test(src);

    const needsIrr = referencedNotDefined('mx_environment_irradiance');
    const needsRad = referencedNotDefined('mx_environment_radiance');
    const needsTrans = referencedNotDefined('mx_surface_transmission');

    if (needsIrr || needsRad || needsTrans) {
        let simple = ''; // no dependencies, can go at the very top
        let fresnel = ''; // needs the FresnelData struct
        if (needsIrr) simple += 'vec3 mx_environment_irradiance(vec3 N) { return vec3(0.0); }\n';
        if (needsRad) fresnel += 'vec3 mx_environment_radiance(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd) { return vec3(0.0); }\n';
        if (needsTrans) fresnel += 'vec3 mx_surface_transmission(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd, vec3 tint) { return vec3(0.0); }\n';
        const header = '\n// [mtlx-engine] no-op lighting stubs for an unlit shader (see patchUnlitLightingRefs)\n';
        if (simple) src = header + simple + src;
        if (fresnel) {
            const structIdx = src.indexOf('struct FresnelData');
            const insertAt = structIdx !== -1 ? src.indexOf('};', structIdx) + 2 : -1;
            if (insertAt > 1) {
                src = src.slice(0, insertAt) + header + fresnel + src.slice(insertAt);
            } else {
                // A silent skip here would leave mx_environment_radiance/
                // mx_surface_transmission called but never stubbed, failing
                // later with a cryptic GLSL error, throw instead, loudly.
                throw new Error('patchUnlitLightingRefs: could not locate the "struct FresnelData" anchor (or its closing "};") in generated fragment shader, MaterialX output format may have changed');
            }
        }
    }

    // Last prepend so the define stays the very first line of the source.
    if (/\bDIRECTIONAL_ALBEDO_METHOD\b/.test(src) &&
        !/#define\s+DIRECTIONAL_ALBEDO_METHOD\b/.test(src)) {
        src = '#define DIRECTIONAL_ALBEDO_METHOD 0\n' + src;
    }
    return src;
};

// The shared MaterialX light library keeps a +1 scene-unit offset in point
// and spot attenuation for the ordinary Material Viewer. Scene imports first
// convert authored coordinates to metres, so that offset becomes an
// arbitrary one-metre term and breaks inverse-square scale covariance. Scene
// compilation opts into the physical form while the ordinary preview path
// remains byte-for-byte compatible with the library output.
const patchScenePhysicalLightFalloff = (src, sceneRgbt = false) => {
    if (!sceneRgbt) return src;
    return src.replace(/pow\s*\(\s*distance\s*\+\s*1\.0\s*,\s*light\.decay_rate\s*\+\s*M_FLOAT_EPS\s*\)/g,
        'pow(max(distance, M_FLOAT_EPS), light.decay_rate)');
};

// Shared display-transform GLSL body (`inVar`/`outVar`: vec3 in/out).
// `mode` (see getDisplayTransform()) picks the curve: 'aces' (three r128's Hill
// fit), 'neutral' (Khronos PBR Neutral), 'srgb' (OETF alone, MaterialXView
// parity) or 'lin_rec709' (nothing at all). `exposureVar`, when given, names a
// float uniform applied as a camera exposure ahead of the curve.
// Sole source: encodeDisplay() and finalMat both call it, so the two never drift apart.
// The tone curve alone, operating in place on a vec3 named `_c`. Split out of
// ACES_SRGB_GLSL so applyThreeToneMappingChunk can reuse the exact same source
// for three's built-in materials: the backdrop and the objects then cannot
// drift, which is the failure this split exists to prevent.
// srgb emits nothing, matching MaterialXView: glEnable(GL_FRAMEBUFFER_SRGB) wraps
// its env/opaque/transparent passes (RenderPipelineGL.cpp:357, disabled :458) for a
// hardware sRGB OETF only, no tone map (hwSrgbEncodeOutput false, GenOptions.h:92).
const TONE_CURVE_GLSL = (mode, pad) => {
    const p = pad || '        ';
    if (mode === 'aces') {
        // three r128's Hill fit of the ACES RRT+ODT, kept byte-identical to the
        // tonemapping_pars_fragment chunk so the two paths agree exactly.
        return p + 'const mat3 _acesIn = mat3(\n' +
            p + '    vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383),\n' +
            p + '    vec3(0.04823, 0.01566, 0.83777)\n' +
            p + ');\n' +
            p + 'const mat3 _acesOut = mat3(\n' +
            p + '    vec3( 1.60475, -0.10208, -0.00327), vec3(-0.53108,  1.10813, -0.07276),\n' +
            p + '    vec3(-0.07367, -0.00605,  1.07602)\n' +
            p + ');\n' +
            p + '_c = _acesIn * _c;\n' +
            p + 'vec3 _aces_a = _c * (_c + vec3(0.0245786)) - vec3(0.000090537);\n' +
            p + 'vec3 _aces_b = _c * (0.983729 * _c + vec3(0.4329510)) + vec3(0.238081);\n' +
            p + '_c = _acesOut * (_aces_a / _aces_b);\n';
    }
    if (mode === 'neutral') {
        // Khronos PBR Neutral. Preserves the hue and saturation of in-gamut
        // colour and rolls only the highlights toward white, where the ACES fit
        // skews saturated hues badly (see studioInverseAcesSrgbGlsl's own note).
        // Written as a block rather than the reference function's early returns
        // so it can be spliced inline.
        return p + '{\n' +
            p + '    const float _nsc = 0.76; // startCompression, 0.8 - 0.04\n' +
            p + '    const float _nds = 0.15; // desaturation\n' +
            p + '    float _nx = min(_c.r, min(_c.g, _c.b));\n' +
            p + '    float _noff = _nx < 0.08 ? _nx - 6.25 * _nx * _nx : 0.04;\n' +
            p + '    _c -= _noff;\n' +
            p + '    float _npk = max(_c.r, max(_c.g, _c.b));\n' +
            p + '    if (_npk >= _nsc) {\n' +
            p + '        const float _nd = 1.0 - _nsc;\n' +
            p + '        float _nnp = 1.0 - _nd * _nd / (_npk + _nd - _nsc);\n' +
            p + '        _c *= _nnp / _npk;\n' +
            p + '        float _ng = 1.0 - 1.0 / (_nds * (_npk - _nnp) + 1.0);\n' +
            p + '        _c = mix(_c, vec3(_nnp), _ng);\n' +
            p + '    }\n' +
            p + '}\n';
    }
    return '';
};

// Numeric form of the mode, for the shader-side branch below. Kept beside
// DISPLAY_TRANSFORM_VALUES so the two cannot disagree.
const DISPLAY_TRANSFORM_IDS = { srgb: 0, aces: 1, lin_rec709: 2, neutral: 3 };
const displayTransformId = (mode) => DISPLAY_TRANSFORM_IDS[mode] || 0;

// Emits the whole transform as a runtime branch on `modeVar` instead of baking
// one curve in. That is what lets a view pick its own transform (the Scene
// wants a filmic default, the Material Viewer must stay on plain sRGB for
// MaterialXView parity) and what makes switching cost a uniform write rather
// than regenerating every material in the stage.
const DISPLAY_TRANSFORM_SWITCH_GLSL = (inVar, outVar, modeVar, exposureVar) => {
    const p = '        ';
    return p + 'vec3 _c = max(' + inVar + ', vec3(0.0));\n' +
        (exposureVar ? p + '_c *= ' + exposureVar + ';\n' : '') +
        p + 'if (' + modeVar + ' == 1) {\n' +
        TONE_CURVE_GLSL('aces', p + '    ') +
        p + '} else if (' + modeVar + ' == 3) {\n' +
        TONE_CURVE_GLSL('neutral', p + '    ') +
        p + '}\n' +
        // lin_rec709 (2) is the inspection mode: no tone map, no OETF and no
        // clamp, so over-range values survive a float readback.
        p + 'vec3 ' + outVar + ' = _c;\n' +
        p + 'if (' + modeVar + ' != 2) {\n' +
        p + '    _c = clamp(_c, vec3(0.0), vec3(1.0)); // saturate()\n' +
        p + '    vec3 _lo = _c * 12.92;\n' +
        p + '    vec3 _hi = 1.055 * pow(_c, vec3(1.0 / 2.4)) - 0.055;\n' +
        p + '    ' + outVar + ' = mix(_hi, _lo, step(_c, vec3(0.0031308)));\n' +
        p + '}\n';
};

const ACES_SRGB_GLSL = (inVar, outVar, mode, exposureVar) => {
    // Camera exposure, ahead of the tone curve. It belongs here and nowhere
    // else because it is the one scale that must apply to direct light, the
    // environment and emission alike; u_envLightIntensity gains only the IBL.
    // It stays a uniform on purpose: `mode` is baked into source, so anything
    // baked would cost a full regeneration of every material per tweak.
    const exposeBody = exposureVar ? '        _c *= ' + exposureVar + ';\n' : '';
    const head = '        vec3 _c = max(' + inVar + ', vec3(0.0));\n' + exposeBody;
    // lin_rec709 is the inspection mode: no tone map, no OETF and no clamp, so
    // over-range values survive a float readback. The saturate below belongs to
    // the display-referred modes only, which is what it always meant.
    if (mode === 'lin_rec709') return head + '        vec3 ' + outVar + ' = _c;\n';
    const guarded = head +
        TONE_CURVE_GLSL(mode) +
        '        _c = clamp(_c, vec3(0.0), vec3(1.0)); // saturate()\n';
    return guarded +
        '        vec3 _lo = _c * 12.92;\n' +
        '        vec3 _hi = 1.055 * pow(_c, vec3(1.0 / 2.4)) - 0.055;\n' +
        '        vec3 ' + outVar + ' = mix(_hi, _lo, step(_c, vec3(0.0031308)));\n';
};

// Injects the current display transform (getDisplayTransform(), see
// ACES_SRGB_GLSL) before main()'s closing brace: RawShaderMaterial bypasses
// renderer.toneMapping, so this is what keeps it matching the rest of the
// scene. Linear peel and opaque passes defer to finalMat's single
// composite-time pass instead, so the transform is never applied twice.
const encodeDisplay = (src) => {
    // Both anchors are load-bearing: a silent skip here used to ship
    // raw-linear output straight to the display with no error anywhere.
    // Fail loud instead, so a format change surfaces immediately.
    const m = src.match(/\bout\s+vec4\s+(\w+)\s*;/);
    if (!m) throw new Error('encodeDisplay: could not locate the fragment shader\'s "out vec4 <name>;" declaration, MaterialX output format may have changed');
    const v = m[1];
    // Both the curve and the exposure ride along as uniforms, so neither one
    // regenerates a shader when it changes and each view can hold its own.
    let out = src;
    const decl = 'uniform float u_displayExposure;\nuniform int u_displayTransform;';
    if (out.indexOf('uniform int u_displayTransform;') === -1) {
        const mainIdx = out.indexOf('void main');
        if (mainIdx === -1) throw new Error('encodeDisplay: could not locate "void main" to declare the display uniforms, MaterialX output format may have changed');
        out = out.slice(0, mainIdx) + decl + '\n' + out.slice(mainIdx);
    }
    const idx = out.lastIndexOf('}');
    if (idx === -1) throw new Error('encodeDisplay: could not locate a closing "}" (expected main()\'s closing brace) in generated fragment shader, MaterialX output format may have changed');
    const inject =
        '\n    // Injected by previewer: display transform (see encodeDisplay()\'s header comment), then sRGB.\n' +
        '    if (u_peelLinear == 0) {\n' +
        DISPLAY_TRANSFORM_SWITCH_GLSL(v + '.rgb', '_enc', 'u_displayTransform', 'u_displayExposure') +
        '        ' + v + ' = vec4(_enc, ' + v + '.a);\n' +
        '    }\n';
    return out.slice(0, idx) + inject + out.slice(idx);
};

// Deliberate energy-compromise constant for the peel-mode env-refraction
// return below: a FLAT scale (not re-weighted by transmission/color, the
// closure result is already weight-scaled downstream) applied to keep
// transmission hue alive in depth-peel mode, at the cost of some
// double-counting against the real scene now showing through via the
// alpha-composited background. Tune here.
const PEEL_REFRACTION_SCALE = 0.5;

// Bounds-guards MaterialX's mx_shadow_occlusion. The library samples the
// moments map with no check at all, so a fragment outside the shadow
// frustum reads a clamped edge texel and a fragment behind a perspective
// light projects through w < 0 onto arbitrary coordinates: both read as
// shadowed and streak across the stage. Outside the map means unlit by
// that caster, which is fully lit here. No-op when the shader has no
// shadow map (the pattern is absent), so unshadowed materials are
// untouched.
const patchShadowBounds = (fs) => {
    const call = 'mx_variance_shadow_occlusion(shadowMoments, shadowCoord.z)';
    const anchor = 'return  ' + call;
    if (fs.indexOf(anchor) === -1) return fs;
    const guard = [
        'if (shadowCoord4.w <= 0.0) return 1.0;',
        'if (any(lessThan(shadowCoord, vec3(0.0))) || any(greaterThan(shadowCoord, vec3(1.0)))) return 1.0;',
        // A light inside the scene cannot be covered by one 2D map, so the
        // frustum always ends somewhere. Stopping dead at its edge draws a
        // hard straight line across the floor where shadowed meets
        // unshadowed, so fade over the last few percent of the map instead.
        //
        // Only the XY edges. There is deliberately no far-plane term: under a
        // perspective projection shadowCoord.z is not a distance, and with a
        // near of 0.25 against a far of 399 the ENTIRE stage lands past 0.99,
        // so any threshold on it fades every shadow in the scene to nothing.
        'vec2 mx_shadowEdge = min(shadowCoord.xy, vec2(1.0) - shadowCoord.xy);',
        'float mx_shadowFade = smoothstep(0.0, 0.12, min(mx_shadowEdge.x, mx_shadowEdge.y));',
        // Variance shadow maps leak: Chebyshev's bound is only an upper bound,
        // so a partly occluded texel reports far more light than it receives.
        // The library has no bleed reduction at all, and with MIN_VARIANCE at
        // 1e-5 across a whole stage's depth range an occluder needs roughly a
        // world unit of separation before it even half darkens. Rescaling the
        // tail of the bound is the standard fix and is what gives small props
        // a readable shadow instead of a grey wash.
        'float mx_shadowRaw = ' + call + ';',
        'float mx_shadowLit = smoothstep(0.35, 1.0, mx_shadowRaw);',
        'return mix(1.0, mx_shadowLit, mx_shadowFade);',
    ].join('\n    ');
    return fs.replace(anchor, guard);
};

// Points MaterialX's single shadow term at the light the map was actually
// rendered from.
//
// The generator emits the shadow ONCE, before the light loop, and resets it at
// the end of every iteration:
//
//     // Shadow occlusion
//     occlusion = mx_shadow_occlusion(u_shadowMap, u_shadowMatrix, positionWorld);
//     ... for (int activeLightIndex = ...) {
//             // Clear shadow factor for next light
//             occlusion = 1.0;
//         }
//
// so only light slot 0 is ever shadowed. Our slot layout is [rig..., key,
// stage...] and the site's environment_map.mtlx declares no rig lights, so slot
// 0 is the environment key light while the caster is chosen from the STAGE
// lights. The map was therefore drawn from one light and applied to a different
// one pointing somewhere else, which is why no USD light cast a shadow and the
// darkening that did appear sat at the wrong contact points.
//
// The fix keeps MaterialX's one map and selects per light instead: the caster's
// slots (an area emitter is split across several) carry the shadow, everything
// else stays lit. u_shadowLightBegin == u_shadowLightEnd means "no caster",
// which is the safe default and what the Material Viewer runs with.
// Compile-time GLSL array size: shadow faces packed into the atlas (a
// directional caster uses one, an omni/area cube group reserves six) plus
// the light slots the per-light lookup can address. Must match the renderer.
const SHADOW_FACE_SLOTS = 32;
const SHADOW_LIGHT_SLOTS_MAX = 32;
// One bias policy for every caster kind: a normal offset off the surface
// and a depth bias on the comparison, both measured in atlas texels so
// they scale with the per-face texel footprint. Injected as #define below.
const SHADOW_NORMAL_OFFSET_TEXELS = 1.0;
const SHADOW_DEPTH_BIAS_TEXELS = 1.0;

// faceSlots: compile-time face array size, a generation parameter (the Scene uses the full atlas).
const patchShadowLightScope = (fs, { skipTransmittance = false, faceSlots = SHADOW_FACE_SLOTS } = {}) => {
    const call = 'occlusion = mx_shadow_occlusion(u_shadowMap, u_shadowMatrix, positionWorld);';
    const site = 'L = lightShader.direction;';
    if (fs.indexOf(call) === -1 || fs.indexOf(site) === -1) return fs;
    // The geometric normal, when the surface exposes one. Used to push the
    // receiver test point off the shaded surface before the shadow lookup
    // (see mx_shadow_atlas), which is what removes self-shadow acne without
    // a large constant bias. Absent it, the lookup falls back to testing at
    // the surface itself, matching the previous behaviour exactly.
    const hasNormal = /\bin\s+vec3\s+normalWorld\s*;/.test(fs);
    const shadowNormalExpr = hasNormal ? 'normalize(normalWorld)' : 'vec3(0.0)';
    // MaterialX's own single-map call is dropped: it computes the shadow once,
    // before the loop, which is what limited it to light slot 0.
    let out = fs.replace(call, 'occlusion = 1.0;');
    // Caches shadow visibility per resolved face for this fragment
    // invocation (reset each main()), so light slots that share an omni
    // face reuse one lookup instead of repeating the atlas search.
    const lightLoop = '        // Light loop\n';
    const transmitCacheInit = skipTransmittance ? '' : '        vec3 mx_shadowTransmit[' + faceSlots + '];\n'
        + '        for (int mx_transmitIndex = 0; mx_transmitIndex < ' + faceSlots + '; ++mx_transmitIndex) {\n'
        + '            mx_shadowTransmit[mx_transmitIndex] = vec3(-1.0);\n'
        + '        }\n';
    const cacheDecl = '        float mx_shadowVisibility[' + faceSlots + '];\n'
        + '        for (int mx_shadowIndex = 0; mx_shadowIndex < ' + faceSlots + '; ++mx_shadowIndex) {\n'
        + '            mx_shadowVisibility[mx_shadowIndex] = -1.0;\n'
        + '        }\n'
        + transmitCacheInit
        + '        vec3 mx_shadowNormal = ' + shadowNormalExpr + ';\n\n';
    if (out.indexOf(lightLoop) !== -1 && out.indexOf('mx_shadowVisibility[') === -1) {
        out = out.replace(lightLoop, cacheDecl + lightLoop);
    }
    const shadowPerCaster = out.indexOf('mx_shadowVisibility[') !== -1
        ? '\n                if (mx_face < 0) {'
        + '\n                    occlusion = 1.0;'
        + '\n                } else if (mx_shadowVisibility[mx_face] < -0.5) {'
        + '\n                    mx_shadowVisibility[mx_face] = mx_shadow_atlas(mx_face, positionWorld, mx_shadowNormal);'
        + '\n                    occlusion = mx_shadowVisibility[mx_face];'
        + '\n                } else {'
        + '\n                    occlusion = mx_shadowVisibility[mx_face];'
        + '\n                }'
        : '\n                occlusion = mx_shadow_atlas(mx_face, positionWorld, ' + shadowNormalExpr + ');';
    // Resolves a light slot to an atlas face: faceCount 1 maps straight
    // through, faceCount >= 2 (an omni/area cube group) expresses the
    // shaded point in the group's basis and picks the face by major axis.
    out = out.replace(site, site
        + '\n            {'
        + '\n                int mx_slotFace = u_shadowSlotFace[activeLightIndex];'
        + '\n                int mx_slotCount = u_shadowSlotFaceCount[activeLightIndex];'
        + '\n                int mx_face = -1;'
        + '\n                if (mx_slotFace >= 0) {'
        + '\n                    if (mx_slotCount >= 2) {'
        + '\n                        vec3 mx_faceVec = positionWorld - u_shadowFaceOrigin[mx_slotFace];'
        + '\n                        vec3 mx_faceLocal = vec3('
        + '\n                            dot(mx_faceVec, u_shadowFaceBasisX[mx_slotFace]),'
        + '\n                            dot(mx_faceVec, u_shadowFaceBasisY[mx_slotFace]),'
        + '\n                            dot(mx_faceVec, u_shadowFaceBasisZ[mx_slotFace]));'
        + '\n                        vec3 mx_faceAbs = abs(mx_faceLocal);'
        + '\n                        int mx_axis;'
        + '\n                        if (mx_faceAbs.x >= mx_faceAbs.y && mx_faceAbs.x >= mx_faceAbs.z) mx_axis = mx_faceLocal.x >= 0.0 ? 0 : 1;'
        + '\n                        else if (mx_faceAbs.y >= mx_faceAbs.x && mx_faceAbs.y >= mx_faceAbs.z) mx_axis = mx_faceLocal.y >= 0.0 ? 2 : 3;'
        + '\n                        else mx_axis = mx_faceLocal.z >= 0.0 ? 4 : 5;'
        + '\n                        mx_face = mx_slotFace + mx_axis;'
        + '\n                        if (u_shadowFaceValid[mx_face] < 0.5) mx_face = -1;'
        + '\n                    } else {'
        + '\n                        mx_face = mx_slotFace;'
        + '\n                    }'
        + '\n                }'
        + shadowPerCaster
        // Keep scalar shadow visibility in ClosureData.occlusion. MaterialX
        // closures intentionally consume it differently: ordinary reflection
        // uses the full factor, subsurface softens it toward grazing angles,
        // and the bundled translucent transmission closure ignores it. Do not
        // replace those per-closure rules with a global intensity mask. Colored
        // transmittance still scales source radiance because ClosureData can
        // carry only a scalar visibility term.
        + (skipTransmittance ? '' : '\n                vec3 mx_transmit = vec3(1.0);'
            + '\n                if (mx_face < 0) {'
            + '\n                    mx_transmit = vec3(1.0);'
            + '\n                } else if (mx_shadowTransmit[mx_face].x < -0.5) {'
            + '\n                    mx_shadowTransmit[mx_face] = mx_shadow_transmittance(mx_face, positionWorld, mx_shadowNormal);'
            + '\n                    mx_transmit = mx_shadowTransmit[mx_face];'
            + '\n                } else {'
            + '\n                    mx_transmit = mx_shadowTransmit[mx_face];'
            + '\n                }')
        + '\n                lightShader.intensity *= ' + (skipTransmittance ? '' : 'mx_transmit * ') + 'u_shadowDiagnosticVisibilityScale;'
        + '\n            }');
    if (out.indexOf('uniform sampler2D u_shadowAtlas;') !== -1) return out;
    const decl = [
        'uniform sampler2D u_shadowAtlas;',
        'uniform mat4 u_shadowMatrices[' + faceSlots + '];',
        // xy = tile origin in atlas UV, zw = tile size.
        'uniform vec4 u_shadowTiles[' + faceSlots + '];',
        // Normalized positive light-view Z plane for linear moments.
        'uniform vec4 u_shadowDepthPlanes[' + faceSlots + '];',
        // x = near, y = far - near, in the same world units used by the
        // authored emitter radius. Kept separate because the normalized
        // plane alone cannot recover its near offset.
        'uniform vec2 u_shadowDepthRanges[' + faceSlots + '];',
        // x/y = authored source radius in world units; z/w = explicit
        // perspective projection scale. Directional casters use all zeroes.
        'uniform vec4 u_shadowSourceRadii[' + faceSlots + '];',
        // World-space size of one atlas texel at the caster's near plane
        // (perspective) or across the whole frustum (orthographic). Feeds
        // both the normal-offset and the depth bias below; zero disables
        // both for that slot.
        'uniform float u_shadowTexelWorldSize[' + faceSlots + '];',
        // Light position for an omni caster's face, used to pick which of
        // its six faces a shaded point falls into. Unused (zero) otherwise.
        'uniform vec3 u_shadowFaceOrigin[' + faceSlots + '];',
        // 1.0 where a face actually holds rendered data, 0.0 where the
        // renderer reserved the slot but never allocated a cell for it.
        'uniform float u_shadowFaceValid[' + faceSlots + '];',
        // A cube group's own world +X/+Y/+Z, read only at the group's base
        // face index: world axes for omni, the emitter's own frame for area.
        'uniform vec3 u_shadowFaceBasisX[' + faceSlots + '];',
        'uniform vec3 u_shadowFaceBasisY[' + faceSlots + '];',
        'uniform vec3 u_shadowFaceBasisZ[' + faceSlots + '];',
        // Per light slot: base face index (or -1 for none) and how many
        // consecutive faces it spans (1 for directional, 6 for a cube group).
        'uniform int u_shadowSlotFace[' + SHADOW_LIGHT_SLOTS_MAX + '];',
        'uniform int u_shadowSlotFaceCount[' + SHADOW_LIGHT_SLOTS_MAX + '];',
        // Test-only multiplier for direct incoming visibility. Normal
        // rendering always binds one; keeping it in the compiled shader lets
        // a diagnostic prove D(V)=V*D(1) without modifying scene lights.
        'uniform float u_shadowDiagnosticVisibilityScale;',
    ].concat(skipTransmittance ? [] : [
        // Packed into one texture: R1 (nearest transmitter) cell origin/size,
        // R2 (product of all) is the same rect offset by half the height.
        // Zero size means no record for that face (dropped, or feature off).
        'uniform sampler2D u_shadowTransmittance;',
        'uniform vec4 u_shadowRecordCells[' + faceSlots + '];',
    ]).concat([
        '#define SHADOW_NORMAL_OFFSET_TEXELS ' + SHADOW_NORMAL_OFFSET_TEXELS.toFixed(4),
        '#define SHADOW_DEPTH_BIAS_TEXELS ' + SHADOW_DEPTH_BIAS_TEXELS.toFixed(4),
        'float mx_shadow_vsm(vec2 moments, float receiverDepth) {',
        '    float p = (receiverDepth <= moments.x) ? 1.0 : 0.0;',
        '    float variance = max(moments.y - moments.x * moments.x, 2e-7);',
        '    float d = receiverDepth - moments.x;',
        '    float lit = max(p, variance / (variance + d * d));',
        '    return smoothstep(0.3, 1.0, lit);',
        '}',
        'float mx_shadow_atlas(int caster, vec3 P, vec3 Ng) {',
        '    if (caster < 0) return 1.0;',
        '    vec4 depthPlane = u_shadowDepthPlanes[caster];',
        '    vec2 depthRange = u_shadowDepthRanges[caster];',
        '    float nearDepth = depthRange.x;',
        '    float depthSpan = max(depthRange.y, 1e-9);',
        '    vec2 projectionScale = u_shadowSourceRadii[caster].zw;',
        '    bool perspective = projectionScale.x > 0.0 || projectionScale.y > 0.0;',
        '    vec2 sourceRadius = u_shadowSourceRadii[caster].xy;',
        // Normal offset AND depth bias share one texel-world estimate,
        // scaled by distance for a perspective caster (using the raw,
        // unbiased point). Small enough now to apply to every caster kind.
        '    float texelBase = u_shadowTexelWorldSize[caster];',
        '    float rawDepth = dot(vec4(P, 1.0), depthPlane);',
        '    float rawZ = max(nearDepth + depthSpan * rawDepth, 0.0);',
        '    float texelWorld = texelBase * (perspective ? rawZ : 1.0);',
        '    vec3 offsetP = P + Ng * (texelWorld * SHADOW_NORMAL_OFFSET_TEXELS);',
        '    vec4 c4 = u_shadowMatrices[caster] * vec4(offsetP, 1.0);',
        '    if (c4.w <= 0.0) return 1.0;',
        '    vec3 sc = c4.xyz / c4.w;',
        '    sc = sc * 0.5 + 0.5;',
        '    if (any(lessThan(sc, vec3(0.0))) || any(greaterThan(sc, vec3(1.0)))) return 1.0;',
        '    vec4 tile = u_shadowTiles[caster];',
        '    vec2 atlasTexel = 1.0 / vec2(textureSize(u_shadowAtlas, 0));',
        '    vec2 tileTexel = atlasTexel / max(tile.zw, vec2(1e-6));',
        // Clamp the local tile coordinate by half a texel before mapping into
        // the atlas, so a bilinear tap at the tile edge cannot cross into a
        // neighbouring cell. tileRect no longer carries its own inset.
        '    vec2 localUv = clamp(sc.xy, tileTexel * 0.5, vec2(1.0) - tileTexel * 0.5);',
        '    vec2 centerUv = tile.xy + localUv * tile.zw;',
        '    vec2 moments = texture(u_shadowAtlas, centerUv).xy;',
        // Projected XY comes from the real light camera; moments use a
        // linear light-view depth plane. One shared depth-bias margin here
        // feeds the centre tap and both PCSS passes below identically.
        '    float receiverDepth = dot(vec4(offsetP, 1.0), depthPlane);',
        '    receiverDepth -= SHADOW_DEPTH_BIAS_TEXELS * texelWorld / depthSpan;',
        '    float receiverZ = nearDepth + depthSpan * receiverDepth;',
        // A source with zero extent is a point/directional caster: retain the
        // centre lookup and avoid nine redundant filtered samples. For area
        // sources, search from the physical emitter footprint at the receiver
        // plane, independent of the centre texel's current blocker estimate.
        '    float lit = mx_shadow_vsm(moments, receiverDepth);',
        '    if (sourceRadius.x <= 0.0 && sourceRadius.y <= 0.0) {',
        '        vec2 e0 = min(sc.xy, vec2(1.0) - sc.xy);',
        '        return mix(1.0, lit, smoothstep(0.0, 0.04, min(e0.x, e0.y)));',
        '    }',
        '    vec2 searchRadius = sourceRadius * projectionScale * 0.5 / max(nearDepth, 1e-9)',
        '        * max(receiverZ - nearDepth, 0.0) / max(receiverZ, 1e-6);',
        // The PCSS bound is a constant in tile space (two texels of a 1024
        // tile) so a 512 cell filters the same world footprint as a full tile
        // rather than twice as wide.
        '    vec2 pcssMaxRadius = vec2(2.0 / 1024.0);',
        '    searchRadius = min(searchRadius, pcssMaxRadius);',
        // Estimate a blocker over a source-size footprint. The search and
        // filter stay inside this caster tile, so atlas slots cannot bleed.
        '    float blockerSum = 0.0;',
        '    float blockerCount = 0.0;',
        '    for (int oy = -1; oy <= 1; oy++) {',
        '        for (int ox = -1; ox <= 1; ox++) {',
        '            vec2 local = clamp(sc.xy + vec2(float(ox), float(oy)) * searchRadius, tileTexel * 0.5, vec2(1.0) - tileTexel * 0.5);',
        '            vec2 sm = texture(u_shadowAtlas, tile.xy + local * tile.zw).xy;',
        '            if (sm.x < receiverDepth) { blockerSum += sm.x; blockerCount += 1.0; }',
        '        }',
        '    }',
        '    float blockerDepth = blockerCount > 0.0 ? blockerSum / blockerCount : moments.x;',
        '    float blockerZ = nearDepth + depthSpan * blockerDepth;',
        '    vec2 filterRadius = sourceRadius * projectionScale * 0.5',
        '        * max(receiverZ - blockerZ, 0.0) / max(blockerZ, 1e-6)',
        '        / max(receiverZ, 1e-6);',
        '    filterRadius = min(filterRadius, pcssMaxRadius);',
        '    float filtered = 0.0;',
        '    for (int oy = -1; oy <= 1; oy++) {',
        '        for (int ox = -1; ox <= 1; ox++) {',
        '            vec2 local = clamp(sc.xy + vec2(float(ox), float(oy)) * filterRadius, tileTexel * 0.5, vec2(1.0) - tileTexel * 0.5);',
        '            vec2 sm = texture(u_shadowAtlas, tile.xy + local * tile.zw).xy;',
        // Apply VSM bleed reduction per tap before averaging; reducing only
        // after the average turns a partially visible area source nearly black.
        '            filtered += mx_shadow_vsm(sm, receiverDepth);',
        '        }',
        '    }',
        '    lit = filtered / 9.0;',
        // One 2D map cannot cover a light inside the room, so the frustum ends
        // somewhere; fade the last few percent instead of drawing a hard line.
        '    vec2 e = min(sc.xy, vec2(1.0) - sc.xy);',
        '    return mix(1.0, lit, smoothstep(0.0, 0.04, min(e.x, e.y)));',
        '}',
    ]).concat(skipTransmittance ? [] : [
        // Orders the receiver's biased depth against the two stacked records:
        // nearer than both is lit, past R1 only applies its tint, past both
        // applies the full product. An empty cell's clear color reads as lit.
        // Bounded by design: with three or more stacked transmitters the middle
        // one is folded into the product for every receiver past the last one,
        // and a receiver inside a solid sees that solid's full product.
        'vec3 mx_shadow_transmittance(int caster, vec3 P, vec3 Ng) {',
        '    if (caster < 0) return vec3(1.0);',
        '    vec4 cell = u_shadowRecordCells[caster];',
        '    if (cell.z <= 0.0 || cell.w <= 0.0) return vec3(1.0);',
        '    vec4 depthPlane = u_shadowDepthPlanes[caster];',
        '    vec2 depthRange = u_shadowDepthRanges[caster];',
        '    float nearDepth = depthRange.x;',
        '    float depthSpan = max(depthRange.y, 1e-9);',
        '    vec2 projectionScale = u_shadowSourceRadii[caster].zw;',
        '    bool perspective = projectionScale.x > 0.0 || projectionScale.y > 0.0;',
        '    float texelBase = u_shadowTexelWorldSize[caster];',
        '    float rawDepth = dot(vec4(P, 1.0), depthPlane);',
        '    float rawZ = max(nearDepth + depthSpan * rawDepth, 0.0);',
        '    float texelWorld = texelBase * (perspective ? rawZ : 1.0);',
        '    vec3 offsetP = P + Ng * (texelWorld * SHADOW_NORMAL_OFFSET_TEXELS);',
        '    vec4 c4 = u_shadowMatrices[caster] * vec4(offsetP, 1.0);',
        '    if (c4.w <= 0.0) return vec3(1.0);',
        '    vec3 sc = c4.xyz / c4.w * 0.5 + 0.5;',
        '    if (any(lessThan(sc, vec3(0.0))) || any(greaterThan(sc, vec3(1.0)))) return vec3(1.0);',
        '    float z = dot(vec4(offsetP, 1.0), depthPlane) - SHADOW_DEPTH_BIAS_TEXELS * texelWorld / depthSpan;',
        '    vec2 r1uv = cell.xy + sc.xy * cell.zw;',
        '    vec2 r2uv = r1uv + vec2(0.0, 0.5);',
        '    vec4 rec1 = texture(u_shadowTransmittance, r1uv);',
        '    vec4 rec2 = texture(u_shadowTransmittance, r2uv);',
        // Alpha stores 1 - depth: an untouched cell (alpha 1) reads as depth
        // 0, and the product plane keeps its farthest depth through MIN.
        '    if (z > 1.0 - rec2.a) return rec2.rgb;',
        '    if (z > 1.0 - rec1.a) return rec1.rgb;',
        '    return vec3(1.0);',
        '}',
    ]).concat([
        '',
    ]).join('\n');
    // Must land before the FIRST global function, not before main(): the light
    // loop lives in a surface evaluation function that precedes main, so
    // declaring any later leaves these used before declared and nothing
    // compiles. Same trap patchAmbientOcclusion documents.
    const firstFn = out.search(/^(?:void|vec[234]|float|int|bool|mat[234])\s+\w+\s*\(/m);
    const at = firstFn !== -1 ? firstFn : out.indexOf('void main');
    if (at === -1) return fs;
    return out.slice(0, at) + decl + out.slice(at);
};

// Adds the source shape to MaterialX's generated LightData struct. Area lights
// are represented by point/spot quadrature samples, so the native light type
// cannot identify their planar source geometry. Keeping the marker in the
// struct means every existing light-data refresh carries it with the sample.
const patchLightSourceKindStruct = (fs) => {
    const match = fs.match(/struct\s+LightData\s*\{[\s\S]*?\n\};/);
    if (!match || /\bsourceKind\b/.test(match[0])) return fs;
    const struct = match[0].replace(/\n\};$/, '\n    int sourceKind;\n};');
    return fs.slice(0, match.index) + struct + fs.slice(match.index + match[0].length);
};

// Applies finite planar emitter geometry to the point/spot quadrature used
// for USD rect and disk lights. MaterialX's point and spot implementations
// describe an isotropic source, while a rect or disk emits only from its
// front hemisphere. The source normal is already present in LightData's
// `direction` member; L is the normalized surface-to-source direction after
// sampleLightSource(), so dot(direction, -L) is the source-side cosine at the
// current shaded point. The injected sourceKind member avoids overloading the
// MaterialX light type, which still selects point versus spot attenuation.
const patchAreaLightSourceCosine = (fs) => {
    const site = 'L = lightShader.direction;';
    if (fs.indexOf(site) === -1 || fs.indexOf('u_lightData') === -1 || fs.indexOf('sourceKind') === -1) return fs;
    let out = fs.replace(site, site
        + '\n            if (u_lightData[activeLightIndex].sourceKind == ' + LIGHT_SOURCE_KIND_AREA + ') {'
        + '\n                lightShader.intensity *= max(dot(u_lightData[activeLightIndex].direction, -L), 0.0);'
        + '\n            }');
    return out;
};

// Geometric specular anti-aliasing. standard_surface's generated GLSL
// evaluates the anisotropic GGX lobe at whatever roughness the shading
// point's alpha pair carries, one sample per fragment. When that alpha
// comes from a fine procedural noise network (a fractal3d chain feeding
// specular_roughness at high object-space frequency, as in
// egg_brushed_steel), it can vary faster than the pixel footprint, and a
// single-sample rasterizer turns that into isolated bright specular
// fireflies a multi-sample path tracer (Karma at 32 spp) integrates away.
// See scratchpad/displacement-verified/brushed-steel/report.md section 3-4.
//
// Widens the alpha pair by the screen-space variance of the shading
// normal AND of the roughness input that feeds mx_roughness_anisotropy,
// both taken from dFdx/dFdy (core in GLSL ES 3.00 fragment shaders, no
// extension needed). A flat normal and a constant roughness leave both
// variance terms at (near) zero, so smooth, non-noisy materials are left
// essentially unchanged (verified on the gray sphere, see
// specular-aa/implementation.md).
//
// Insertion anchor: immediately after mx_roughness_anisotropy's MAIN call
// (not the coat or transmission ones), whose argument/output names are
// fixed by the standard_surface impl graph across every material using it
// (not user-authored, same kind of structural name patchDiffuseBounceAdd
// relies on for base_color_nonnegative_out). Patching after this call
// widens exactly the alpha pair the generated closures read for both
// direct and indirect specular, without touching stdlib GLSL.
//
// Idempotent: checks for its own marker function name. Safe-fail: no
// anchor match (a shader shape without this exact standard_surface
// anisotropy call) leaves the shader untouched.
const patchSpecularAA = (fs, { specularAA = false } = {}) => {
    if (!specularAA) return fs;
    if (fs.indexOf('mx_specular_aa_widen') !== -1) return fs;
    const anchor = /mx_roughness_anisotropy\(coat_affected_roughness_out,\s*specular_anisotropy,\s*main_roughness_out\);/;
    if (!anchor.test(fs)) return fs;
    let out = fs.replace(anchor, (m) => m
        + '\n    main_roughness_out = mx_specular_aa_widen(main_roughness_out, normal, coat_affected_roughness_out);');
    const decl = [
        // sigma2 in variance space: normal-slope variance plus roughness-
        // input variance, both from screen-space derivatives, summed and
        // clamped before being added to alpha^2 (variance-space widening,
        // not a linear roughness add, so a near-zero base alpha does not
        // get disproportionately blown out).
        //
        // Both constants are far below the textbook geometric-specular-AA
        // values (Filament's "specularAntiAliasingVariance"/"...Threshold"
        // defaults, 0.15/0.18): measured on the real engine
        // (specular-aa/implementation.md), the textbook scale saturated the
        // threshold almost everywhere on egg_brushed_steel's egg, not just
        // at the aliasing pixels, because the material's fractal3d
        // roughness noise is fine-grained across essentially the WHOLE
        // surface (it is at the aliasing frequency by design, not merely at
        // isolated outliers), and the analytic-displacement shading normal
        // is likewise a fine per-vertex signal rather than ordinary
        // curvature. Two prior attempts (1.0/1.0 and 0.15/0.18) both made
        // the measured speckle metric WORSE than specularAA off, not
        // better; the smaller scale here is the one that stays a true
        // localized correction instead of a blanket roughening.
        'const float MX_SPECULAR_AA_NORMAL_SCALE = 0.002;',
        'const float MX_SPECULAR_AA_ROUGHNESS_SCALE = 0.005;',
        'const float MX_SPECULAR_AA_THRESHOLD = 0.01;',
        'vec2 mx_specular_aa_widen(vec2 alpha, vec3 aaNormal, float aaRoughness) {',
        '    vec3 dNx = dFdx(aaNormal);',
        '    vec3 dNy = dFdy(aaNormal);',
        '    float dRx = dFdx(aaRoughness);',
        '    float dRy = dFdy(aaRoughness);',
        '    float normalVariance = dot(dNx, dNx) + dot(dNy, dNy);',
        '    float roughnessVariance = dRx * dRx + dRy * dRy;',
        '    float kernelRoughness = min(MX_SPECULAR_AA_NORMAL_SCALE * normalVariance + MX_SPECULAR_AA_ROUGHNESS_SCALE * roughnessVariance, MX_SPECULAR_AA_THRESHOLD);',
        '    vec2 alpha2 = clamp(alpha * alpha + vec2(kernelRoughness), 0.0, 1.0);',
        '    return sqrt(alpha2);',
        '}',
        '',
    ].join('\n');
    // Same "before the first function definition" anchor as the other
    // fragment patches: the call site lives inside a function that
    // precedes main(), so the helper must be declared earlier still.
    const firstFn = out.search(/^(?:void|vec[234]|float|int|bool|mat[234])\s+\w+\s*\(/m);
    const at = firstFn !== -1 ? firstFn : out.indexOf('void main(');
    if (at === -1) return fs;
    return out.slice(0, at) + decl + out.slice(at);
};

// Feeds a screen-space ambient occlusion factor into the slot MaterialX
// already reserves for it. The generator emits, verbatim:
//
//     // Ambient occlusion
//     occlusion = 1.0;
//
// immediately before the environment contribution, so replacing that one
// assignment darkens ONLY the environment term. That is what AO means, and
// it is why this is not folded into u_shadowMap: the shadow occlusion
// scalar also multiplies every analytic light.
//
// The room in a closed interior is the whole point. MaterialX's IBL has no
// visibility term at all, so a stage lit by a dome sees full sky radiance on
// every surface including the ones facing a wall, which is what makes an
// interior read flat and overlit next to an offline render that traces it.
//
// Fail-soft: no anchor means no AO, and the default 1x1 white map with
// strength 0 makes the injected code an exact no-op until a pass binds one.
// A file-scope float mirroring the `occlusion` scalar, defaulting to 1.0 so
// a shader that never runs this patch still compiles and reads as an exact
// no-op. patchLocalEnvironmentRadiance no longer reads this (see its own
// comment: `occlusion` only reaches ClosureData.occlusion, which the
// generated closures read in their direct-light branches, never in
// CLOSURE_TYPE_INDIRECT, so it was never applied to the local reflection
// term in the first place). Idempotent: checks for the DECLARATION, not the
// bare identifier, so an already-inserted assignment (which also contains
// the identifier text) never fools this into skipping the declaration.
const ensureEnvOcclusionGlobal = (src) => {
    if (/\bfloat\s+mx_envOcclusionValue\b/.test(src)) return src;
    const decl = 'float mx_envOcclusionValue = 1.0;\nfloat mx_env_occlusion_value() { return mx_envOcclusionValue; }\n';
    // Same anchor as patchAmbientOcclusion's own uniform decls below: must
    // land before the FIRST function definition (not just before main()),
    // since the generator can emit the AO/environment-radiance slots inside
    // a surface evaluation function that precedes main.
    const firstFn = src.search(/^(?:void|vec[234]|float|int|bool|mat[234])\s+\w+\s*\(/m);
    const at = firstFn !== -1 ? firstFn : src.indexOf('void main(');
    if (at === -1) return src;
    return src.slice(0, at) + decl + src.slice(at);
};

const patchAmbientOcclusion = (fs, { skipSkyVis = false, skipAoVolume = false } = {}) => {
    const anchor = /(\/\/ Ambient occlusion\s*\n\s*)occlusion = 1\.0;/;
    if (!anchor.test(fs)) return fs;
    // Sky visibility needs the world position; without that varying only the
    // screen space term is available and the volume lookup is skipped.
    // skipSkyVis is the sampler-budget drop: forces the ssao-only path so
    // u_skyVisMap (a sampler3D) is never declared.
    const hasWorldPos = !skipSkyVis && /\bin\s+vec3\s+positionWorld\s*;/.test(fs)
        && /\bin\s+vec3\s+normalWorld\s*;/.test(fs);
    // The baked occlusion VOLUME (js/usd-scene-skyvis.js's AO bake) is a
    // separate sampler-budget drop from sky visibility; skipAoVolume falls
    // back to the sky-times-ssao combination without it.
    const useVolume = hasWorldPos && !skipAoVolume;
    // Mirrors the computed occlusion into a file-scope float (currently
    // unread; kept for diagnostics and any future direct-light consumer).
    // patchLocalEnvironmentRadiance does NOT read this: `occlusion` only
    // reaches ClosureData.occlusion, which the generated conductor/
    // dielectric/generalized_schlick/diffuse closures apply in their
    // CLOSURE_TYPE_REFLECTION (direct light) branches only, never in
    // CLOSURE_TYPE_INDIRECT, so it never darkened the environment radiance
    // Li in the first place. An earlier revision divided the local
    // reflection term by this value to "undo" that non-existent darkening,
    // which amplified it by up to 20x instead (see
    // scratchpad/displacement-verified/reflections/overshoot.md).
    const assignment = !hasWorldPos
        ? 'occlusion = mx_ssao_occlusion(); mx_envOcclusionValue = occlusion;'
        : (useVolume
            ? 'occlusion = mx_sky_visibility() * min(mx_volume_occlusion(), mx_ssao_occlusion()); mx_envOcclusionValue = occlusion;'
            : 'occlusion = mx_ssao_occlusion() * mx_sky_visibility(); mx_envOcclusionValue = occlusion;');
    let out = fs.replace(anchor, '$1' + assignment);
    out = ensureEnvOcclusionGlobal(out);
    const skyDecls = !hasWorldPos ? [] : [
        // Baked coarse visibility of the environment (js/usd-scene-skyvis.js).
        // MaterialX's IBL has no visibility term at all, so an interior lit by
        // a dome sees full sky on every surface including ones facing a wall.
        // Screen space AO cannot reach that scale; this can, and the two
        // multiply: the volume carries the room, the screen space pass the
        // contacts. An unbound volume is white at strength 0, an exact no-op.
        'uniform highp sampler3D u_skyVisMap;',
        'uniform vec3 u_skyVisMin;',
        'uniform vec3 u_skyVisSize;',
        // Sampled one cell along the normal, into the free space the surface
        // faces, rather than at the surface itself where the cell is half solid.
        'uniform float u_skyVisCell;',
        'uniform float u_skyVisStrength;',
        'float mx_sky_visibility() {',
        '    if (u_skyVisStrength <= 0.0) return 1.0;',
        // MaterialX's generated closures face-forward their shading normal,
        // but normalWorld is the geometric varying and remains unchanged on
        // a DoubleSide back face. Keep the voxel offset and directional
        // moment evaluation on that same front-facing geometric hemisphere.
        '    vec3 skyNormal = normalize(normalWorld);',
        '    if (!gl_FrontFacing) skyNormal = -skyNormal;',
        // A surface on the stage boundary can sit on the near face of its
        // occupied voxel. One cell lands on the far boundary and trilinear
        // sampling clamps back into that same occupied slice. Move to the
        // first air-cell centre (one full cell plus half-cell margin) so a
        // planar receiver never self-occludes its own sky sample.
        '    vec3 uvw = (positionWorld + skyNormal * (1.5 * u_skyVisCell) - u_skyVisMin) / max(u_skyVisSize, vec3(1e-6));',
        '    if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) return 1.0;',
        // The bake stores the sky visibility function's first order moments:
        // R = <V>, GBA = signed UNORM encoding of d = 2<V omega>.
        // Decode the centered GBA channels before evaluating the diffuse
        // directional response for this surface normal.
        '    vec4 moments = texture(u_skyVisMap, uvw);',
        '    float visibilityMean = moments.r;',
        '    vec3 visibilityDirection = (moments.gba * 255.0 - vec3(128.0)) / 127.0;',
        '    float vis = clamp(visibilityMean + dot(visibilityDirection, skyNormal), 0.0, 1.0);',
        '    return mix(1.0, vis, clamp(u_skyVisStrength, 0.0, 1.0));',
        '}',
    ];
    // A copy of mx_sky_visibility over its own baked volume (see
    // buildAoVolume in js/usd-scene-renderer.js): local occlusion the sky
    // bake is too coarse to resolve, sampled the same biased way.
    const volumeDecls = !useVolume ? [] : [
        'uniform highp sampler3D u_aoVolumeMap;',
        'uniform vec3 u_aoVolumeMin;',
        'uniform vec3 u_aoVolumeSize;',
        'uniform float u_aoVolumeCell;',
        'uniform float u_aoVolumeStrength;',
        'float mx_volume_occlusion() {',
        '    if (u_aoVolumeStrength <= 0.0) return 1.0;',
        '    vec3 skyNormal = normalize(normalWorld);',
        '    if (!gl_FrontFacing) skyNormal = -skyNormal;',
        '    vec3 uvw = (positionWorld + skyNormal * (1.5 * u_aoVolumeCell) - u_aoVolumeMin) / max(u_aoVolumeSize, vec3(1e-6));',
        '    if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) return 1.0;',
        '    vec4 moments = texture(u_aoVolumeMap, uvw);',
        '    float visibilityMean = moments.r;',
        '    vec3 visibilityDirection = (moments.gba * 255.0 - vec3(128.0)) / 127.0;',
        '    float vis = clamp(visibilityMean + dot(visibilityDirection, skyNormal), 0.0, 1.0);',
        '    return mix(1.0, vis, clamp(u_aoVolumeStrength, 0.0, 1.0));',
        '}',
    ];
    const decls = [
        'uniform sampler2D u_ssaoMap;',
        'uniform vec2 u_ssaoTexel;',
        'uniform float u_ssaoStrength;',
        // .r is the raw AO factor, .g the guard's per-pixel confidence (screen
        // edges and rays that miss the frame or the scene); low confidence
        // fades the term back to unoccluded rather than trusting a bad sample.
        'float mx_ssao_occlusion() {',
        '    vec2 aoSample = texture(u_ssaoMap, gl_FragCoord.xy * u_ssaoTexel).rg;',
        '    return mix(1.0, clamp(aoSample.r, 0.0, 1.0), clamp(u_ssaoStrength, 0.0, 1.0) * clamp(aoSample.g, 0.0, 1.0));',
        '}',
    ].concat(skyDecls).concat(volumeDecls).concat(['']).join('\n');
    // Must land before the FIRST function definition, not before main():
    // the generator emits the ambient-occlusion slot inside a surface
    // evaluation function that precedes main, so declaring the helper any
    // later leaves it used before it is declared and nothing compiles.
    // Only builtins are referenced here, so the top of the function section
    // is always a legal home for it.
    const firstFn = out.search(/^(?:void|vec[234]|float|int|bool|mat[234])\s+\w+\s*\(/m);
    const at = firstFn !== -1 ? firstFn : out.indexOf('void main(');
    if (at === -1) return fs; // nothing recognisable: leave the shader untouched
    return out.slice(0, at) + decls + out.slice(at);
};

// Diffuse bounce v3: a REAL one-bounce irradiance estimate, baked per cell
// from the blockers' own outgoing radiance (js/usd-scene-skyvis.js's
// bakeBounceGeometry/shadeBounce), not a whole-scene mean. See
// scratchpad/displacement-verified/color-parity/bounce/v3-design.md for the
// derivation this replaces (v2's computeBounceERef/marchBounce, which used
// a global mean and double-counted 1/pi).
//
// This is an ADDITIVE term on the shaded colour, not a multiplier on
// `occlusion`: canonical.md (2026-09-20) found that at a typical Scene
// shading point the analytic key light (a directional light extracted from
// the dome's brightest cluster, see extractKeyLight) supplies most of the
// diffuse irradiance and is evaluated in the ordinary light loop, entirely
// outside the `occlusion` scalar's reach.
//
// Units: the engine's stored irradiance (env.irradianceConvolvedData, see
// ensureConvolvedIrradiance) is ALREADY divided by pi, matching
// mx_environment_irradiance's plain map lookup. The bake (shadeBounce) works
// entirely in that same stored-unit convention, so this shader term applies
// NO further 1/pi anywhere -- unlike v2's MX_BOUNCE_PI_INV, which divided a
// term that was already in stored units a second time.
//
// The baked volume stores a scalar SH1 (R = L0 mean, GBA = signed L1
// moment), reconstructed the same way mx_sky_visibility reconstructs its
// moments, plus two globals: u_bounceScale (the bake's own maximum, so the
// UNORM8 encoding spans the real range) and u_bounceTint (the blockers'
// albedo-weighted mean chroma, normalized to luminance 1).
//
// Reusing `base_color_nonnegative_out`, standard_surface's own generated
// albedo variable, keeps this literally the same material albedo
// standard_surface itself diffuses with, so re-lighting, layering and the
// ACES display path downstream all see one more ordinary linear-colour
// contribution, nothing bespoke. Requires `base_color_nonnegative_out` to
// exist textually (every MaterialEggs asset is standard_surface-based);
// safe-fails (no injection, shader unchanged) on any other node graph shape.
//
// The near-field term is additionally gated by min(mx_volume_occlusion(),
// mx_ssao_occlusion()) when those helpers are compiled in (patchAmbientOcclusion
// runs first): a concave corner with almost no local AO should not ALSO gain
// a full one-bounce lift on top of its shadow deficit (see v3-design.md
// section 9's "shadow corner" acceptance-criterion note). When the AO volume
// itself has been dropped from the sampler budget, mx_volume_occlusion is
// never declared, so this falls back to mx_ssao_occlusion alone rather than
// referencing an undeclared function.
const patchDiffuseBounceAdd = (fs, { skipSkyVis = false, skipBounce = false } = {}) => {
    // No trailing `;` in the capture: the addition must land INSIDE this
    // statement, before the semicolon, not appended after it (appending
    // after would split one statement into two, the second being a bare
    // `+ mx_diffuse_bounce_add(...);` expression-statement -- syntactically
    // dubious enough that it hung the ANGLE/D3D11 shader compiler solid on
    // this asset's standard_surface network instead of failing loudly).
    const anchor = /shader_constructor_out\.color \+= occlusion \* (\w+)\.response;/;
    const match = fs.match(anchor);
    if (!match) return fs;
    const hasWorldPos = !skipSkyVis && !skipBounce
        && /\bin\s+vec3\s+positionWorld\s*;/.test(fs) && /\bin\s+vec3\s+normalWorld\s*;/.test(fs);
    if (!hasWorldPos) return fs;
    // Needs the surface's own diffuse albedo in scope at the injection
    // point; standard_surface's generated indirect block always computes
    // this before combining layers. Anything else (a bespoke node graph, a
    // future codegen contract change) safe-fails to no injection.
    if (!/\bvec3\s+base_color_nonnegative_out\b/.test(fs)) return fs;
    // base_color_nonnegative_out is a LOCAL variable inside the function
    // that contains this statement, not reachable from a separately
    // declared global function; pass it as an argument at the call site
    // instead, where it is still in scope.
    const out = fs.replace(anchor, 'shader_constructor_out.color += occlusion * $1.response + mx_diffuse_bounce_add(base_color_nonnegative_out);');
    // patchAmbientOcclusion runs before this function (see the call site),
    // but its own anchor can fail to match (a shader shape with no "//
    // Ambient occlusion" slot at all), in which case NEITHER
    // mx_volume_occlusion NOR mx_ssao_occlusion is declared even though
    // this function's own anchor still matches. Referencing either
    // unconditionally is a real compile-time regression (caught only by a
    // headed render, not by a source-text check): fall back one more step,
    // to no near-field gating at all, when even mx_ssao_occlusion is
    // missing.
    const hasVolumeOcclusion = /float\s+mx_volume_occlusion\s*\(\s*\)\s*\{/.test(out);
    const hasSsaoOcclusion = /float\s+mx_ssao_occlusion\s*\(\s*\)\s*\{/.test(out);
    const decls = [
        // Baked one-bounce irradiance volume (js/usd-scene-skyvis.js's
        // bakeBounceGeometry/shadeBounce), scalar SH1 encoded exactly like
        // mx_sky_visibility's moments.
        'uniform highp sampler3D u_skyBounceMap;',
        'uniform vec3 u_skyBounceMin;',
        'uniform vec3 u_skyBounceSize;',
        'uniform float u_skyBounceCell;',
        'uniform float u_skyBounceStrength;',
        // The bake's own maximum reconstructed value (denormalizes the
        // UNORM8 encoding) and the blockers' mean chroma (the encoding
        // itself is a single scalar; colour is reintroduced here). Both
        // default to a value that makes the term an exact no-op: scale 0.
        'uniform float u_bounceScale;',
        'uniform vec3 u_bounceTint;',
        'vec3 mx_diffuse_bounce_add(vec3 albedo) {',
        '    if (u_skyBounceStrength <= 0.0 || u_bounceScale <= 0.0) return vec3(0.0);',
        '    vec3 n = normalize(normalWorld);',
        '    if (!gl_FrontFacing) n = -n;',
        '    vec3 uvw = (positionWorld + n * (1.5 * u_skyBounceCell) - u_skyBounceMin) / max(u_skyBounceSize, vec3(1e-6));',
        '    if (any(lessThan(uvw, vec3(0.0))) || any(greaterThan(uvw, vec3(1.0)))) return vec3(0.0);',
        '    vec4 m = texture(u_skyBounceMap, uvw);',
        '    vec3 d = (m.gba * 255.0 - vec3(128.0)) / 127.0;',
        '    float e = u_bounceScale * clamp(m.r + dot(d, n), 0.0, 1.0);',
        '    float near = ' + (hasVolumeOcclusion && hasSsaoOcclusion ? 'min(mx_volume_occlusion(), mx_ssao_occlusion())'
            : (hasSsaoOcclusion ? 'mx_ssao_occlusion()' : '1.0')) + ';',
        '    return clamp(u_skyBounceStrength, 0.0, 1.0) * near * e * u_bounceTint * albedo;',
        '}',
        '',
    ].join('\n');
    // Same "before the first function definition" anchor patchAmbientOcclusion
    // uses: the assignment this patches lives inside a function that precedes
    // main(), so the helper has to be declared before that function starts.
    //
    // EXCLUDES mx_ssao_occlusion/mx_sky_visibility/mx_volume_occlusion by
    // name: patchAmbientOcclusion (which always runs first, see the call
    // site) may have already inserted ITS OWN function definitions earlier
    // in the string, and a plain "first function" search would then land
    // INSIDE that block, before those functions are declared -- exactly the
    // GLSL "no matching overloaded function found" a headed embed run
    // caught, because mx_diffuse_bounce_add's own body calls
    // mx_ssao_occlusion()/mx_volume_occlusion() and needs them declared
    // first. Skipping past them here finds the true ORIGINAL first
    // function instead, landing this block right after AO's.
    const firstFn = out.search(/^(?:void|vec[234]|float|int|bool|mat[234])\s+(?!mx_ssao_occlusion\b|mx_sky_visibility\b|mx_volume_occlusion\b)\w+\s*\(/m);
    const at = firstFn !== -1 ? firstFn : out.indexOf('void main(');
    if (at === -1) return fs;
    return out.slice(0, at) + decls + out.slice(at);
};

// Scene-only correction for the generated OpenPBR thin-wall contract.
// A sheet has no macroscopic interior: its transmission_color is a surface
// tint regardless of the authored transmission_depth. MaterialX 1.39.5's
// generated graph only uses geometry_thin_walled for subsurface scattering;
// its transmission tint and volume branches otherwise still use depth.
// Change the LOCAL function argument, not a global uniform or source asset.
// Thus connected inputs, several OpenPBR closures and runtime booleans all
// keep working. The Material Viewer does not opt in to this scene patch.
// This does not replace the dielectric BSDF with a full two-interface sheet
// solver; roughness, Fresnel layering and reflection remain MaterialX's.
const patchSceneThinWalledTransmission = (fs, enabled, notices) => {
    if (!enabled || fs.indexOf('/* MX_SCENE_THIN_WALL */') !== -1) return fs;
    let count = 0;
    const out = fs.replace(/void\s+NG_open_pbr_surface_surfaceshader\w*\s*\(([^)]*)\)\s*\{/g, (head, args) => {
        if (!/\bbool\s+geometry_thin_walled\b/.test(args)
            || !/\bfloat\s+transmission_depth\b/.test(args)
            || !/\bvec3\s+transmission_color\b/.test(args)) return head;
        count++;
        return head + '\n    /* MX_SCENE_THIN_WALL */\n'
            + '    if (geometry_thin_walled) transmission_depth = 0.0;\n';
    });
    if (!count && /void\s+NG_open_pbr_surface_surfaceshader/.test(fs) && notices) {
        notices.push('Scene thin-wall correction unavailable: the generated OpenPBR function contract changed; keeping MaterialX output');
    }
    return out;
};

// Transport-only "transfer" record. Captures B/D/opacity/thin at the
// generated OpenPBR terminal, then folds coverage and sampled solid
// thickness into one vec4 so a single render target carries the transfer.
const patchLightTransportPayload = (fs, notices, requestedMode) => {
    if (fs.indexOf('/* MX_LIGHT_TRANSPORT */') !== -1) return fs;
    const isTransfer = requestedMode === 4 || requestedMode === 'transfer' || requestedMode === true;
    if (!isTransfer) {
        if (notices) notices.push('Light transport unavailable: only the transfer record is supported.');
        return fs;
    }
    if (!/\bin\s+vec3\s+positionWorld\s*;/.test(fs)) {
        if (notices) notices.push('Light transport unavailable: generated shader has no world position varying.');
        return fs;
    }
    let seen = 0;
    let terminal = '';
    let out = fs.replace(/void\s+NG_open_pbr_surface_surfaceshader\w*\s*\(([^)]*)\)\s*\{/g, (head, args) => {
        const terminalOut = args.match(/\bout\s+(\w+)\s+(\w+)\s*$/);
        if (!/\bfloat\s+transmission_weight\b/.test(args) || !/\bvec3\s+transmission_color\b/.test(args) || !/\bfloat\s+transmission_depth\b/.test(args) || !/\bfloat\s+geometry_opacity\b/.test(args) || !/\bbool\s+geometry_thin_walled\b/.test(args) || !terminalOut) return head;
        seen++;
        terminal = (head.match(/void\s+(\w+)\s*\(/) || [])[1] || '';
        return head + '\n    /* MX_LIGHT_TRANSPORT */\n'
            // Thin transfer owns the authored tint. Solid tint belongs only
            // to sigmaA, otherwise the receiver would apply it twice.
            + '    mx_transportB = geometry_thin_walled ? clamp(transmission_weight * transmission_color, vec3(0.0), vec3(1.0)) : vec3(clamp(transmission_weight, 0.0, 1.0));\n'
            + '    mx_transportD = geometry_thin_walled ? vec3(0.0) : -log(max(transmission_color, vec3(1e-6))) / max(transmission_depth, 1e-6);\n'
            + '    mx_transportOpacity = clamp(geometry_opacity, 0.0, 1.0);\n'
            + '    mx_transportThin = geometry_thin_walled ? 1.0 : 0.0;\n'
            // The transport main body is pruned below, so no caller reads the
            // terminal out value. Return here after evaluating the inputs to
            // avoid the terminal's generated closure/light work as well.
            // The out parameter is still assigned first: an ANGLE/D3D target
            // can otherwise treat an unwritten "out" as leaving the whole
            // call's other side effects undefined.
            + '    ' + terminalOut[2] + ' = ' + terminalOut[1] + '(' + Array(terminalOut[1] === 'surfaceshader' ? 2 : 1).fill('vec3(0.0)').join(', ') + ');\n'
            + '    /* MX_LIGHT_TRANSPORT_TERMINAL_RETURN */\n'
            + '    return;\n';
    });
    if (seen !== 1) { if (notices) notices.push('Light transport unavailable: ambiguous generated OpenPBR terminal'); return fs; }
    const first = out.search(/^(?:void|vec[234]|float|int|bool|mat[234])\s+\w+\s*\(/m);
    const om = out.match(/\bout\s+vec4\s+(\w+)\s*;/);
    if (first < 0 || !om) { if (notices) notices.push('Light transport unavailable: generated output contract changed'); return fs; }
    const decl = 'vec3 mx_transportB=vec3(1.0), mx_transportD=vec3(0.0); float mx_transportOpacity=0.0, mx_transportThin=0.0;\n'
        // Record-only uniforms. u_recordDepthPlane matches the shadow atlas
        // convention (dot(vec4(P,1), plane) -> normalized linear depth);
        // u_recordUnitScale mirrors u_thicknessScale's scene-unit conversion.
        + 'uniform vec4 u_recordDepthPlane;\n'
        + 'uniform sampler2D u_recordEntryDepth;\n'
        + 'uniform sampler2D u_recordExitDepth;\n'
        + 'uniform vec2 u_recordCellOrigin;\n'
        + 'uniform int u_recordPass;\n'
        + 'uniform vec2 u_recordTexel;\n'
        + 'uniform float u_recordDepthSpan;\n'
        + 'uniform float u_recordUnitScale;\n';
    out = out.slice(0, first) + decl + out.slice(first);
    const main = out.search(/\bvoid\s+main\s*\(\s*\)\s*\{/);
    const call = main < 0 || !terminal ? null : out.slice(main).match(new RegExp('\\b' + terminal + '\\s*\\([\\s\\S]*?\\);'));
    if (!call) { if (notices) notices.push('Light transport unavailable: generated terminal call contract changed'); return fs; }
    const at = main + call.index + call[0].length;
    const mainOpen = out.indexOf('{', main);
    let depth = 0, mainEnd = -1;
    for (let i = mainOpen; i >= 0 && i < out.length; i++) {
        if (out[i] === '{') depth++;
        else if (out[i] === '}' && --depth === 0) { mainEnd = i; break; }
    }
    if (mainEnd < 0) { if (notices) notices.push('Light transport unavailable: generated main contract changed'); return fs; }
    // Entry/exit depths come from the consumer's nearest/farthest prepasses
    // (winding independent); their gap is the solid thickness. Alpha carries
    // 1 minus this fragment's own depth so a receiver can order records.
    const transfer = '\n    float mx_recordZOwn = dot(vec4(positionWorld, 1.0), u_recordDepthPlane);\n'
        + '    float mx_recordZEntry = texture(u_recordEntryDepth, (gl_FragCoord.xy - u_recordCellOrigin) * u_recordTexel).r;\n'
        + '    float mx_recordZExit = texture(u_recordExitDepth, (gl_FragCoord.xy - u_recordCellOrigin) * u_recordTexel).r;\n'
        // The product pass takes one surface per solid: the entry surface,
        // matched by depth, so winding never decides how often it multiplies.
        + '    if (u_recordPass == 2 && mx_transportThin < 0.5 && abs(mx_recordZOwn - mx_recordZEntry) > 2e-3) discard;\n'
        + '    float mx_recordThickness = max(mx_recordZExit - mx_recordZEntry, 0.0) * u_recordDepthSpan * u_recordUnitScale;\n'
        + '    vec3 mx_recordT = mx_transportThin > 0.5 ? mx_transportB : mx_transportB * exp(-mx_transportD * mx_recordThickness);\n'
        + '    vec3 mx_recordTrecord = clamp((1.0 - mx_transportOpacity) + mx_transportOpacity * mx_recordT, 0.0, 1.0);\n'
        + '    ' + om[1] + '=vec4(mx_recordTrecord, 1.0 - mx_recordZOwn); return;\n';
    // Physically remove the post-terminal main body rather than relying on
    // a runtime branch for dead-code elimination. This lets linkers drop
    // lighting/environment sampler paths that the terminal does not need.
    return out.slice(0, at) + '\n    /* MX_LIGHT_TRANSPORT_EARLY_RETURN MX_LIGHT_TRANSPORT_TAIL_PRUNED */' + transfer + out.slice(mainEnd);
};

// Gives MaterialX's volume absorption the path length it is missing.
//
// mx_anisotropic_vdf.glsl computes `vdf.throughput = exp(-absorption)` with
// NO distance term, so Beer-Lambert is evaluated as though every ray
// travelled exactly one unit. The absorption coefficient is
// -ln(transmission_color) / transmission_depth, which for a shallow depth is
// enormous: a stage may author a color of (0.50, 1, 0.05) at a depth of
// 0.001, giving a coefficient near 700 and a throughput of exactly zero. The
// transmission lobe is extinguished instead of tinted green.
//
// The path length comes from a back-face distance map: how far the ray still
// has to travel inside the object. Nothing bound means zero thickness, which
// reads as clear rather than black, so an unbound material is safe.
const patchTransmissionThickness = (fs, { dropThicknessMap = false } = {}) => {
    const anchor = 'vdf.throughput = exp(-absorption);';
    if (fs.indexOf(anchor) === -1) return fs;
    // Needs the standard HW varyings to locate the fragment along the ray.
    const hasVars = dropThicknessMap || (/\bin\s+vec3\s+positionWorld\s*;/.test(fs)
        && /uniform\s+vec3\s+u_viewPosition\s*;/.test(fs));
    if (!hasVars) return fs;
    let out = fs.replace(anchor, 'vdf.throughput = exp(-absorption * mx_transmission_path_length());');
    // Sampler-budget drop: no u_thicknessMap declared at all, always the
    // authored reference distance (createMtlxSceneUniforms seeds it from
    // transmission_depth). Same fallback the target-budget overflow path uses.
    const decls = dropThicknessMap ? [
        'uniform float u_thicknessReferencePath;',
        'float mx_transmission_path_length() {',
        '    return max(u_thicknessReferencePath, 0.0);',
        '}',
        '',
    ].join('\n') : [
        'uniform sampler2D u_thicknessMap;',
        'uniform vec2 u_thicknessTexel;',
        // The renderer's sceneRoot has converted positions to metres. The
        // compiler has no UnitSystem, so raw transmission_depth remains in
        // source scene units and the renderer converts this measured path
        // back before applying Beer-Lambert.
        'uniform float u_thicknessScale;',
        // A bounded per-volume target allocation can overflow. In that case
        // use the authored reference transmission distance rather than a
        // borrowed back face or a silently clear absorbing solid.
        'uniform float u_thicknessTargetValid;',
        'uniform float u_thicknessReferencePath;',
        'float mx_transmission_path_length() {',
        '    if (u_thicknessTargetValid < 0.5) return max(u_thicknessReferencePath, 0.0);',
        '    float back = texture(u_thicknessMap, gl_FragCoord.xy * u_thicknessTexel).r;',
        '    if (back <= 0.0) return 0.0; // nothing behind: treat as clear, never as opaque',
        '    float front = distance(positionWorld, u_viewPosition);',
        '    return max(back - front, 0.0) * u_thicknessScale;',
        '}',
        '',
    ].join('\n');
    const fnIdx = out.indexOf('void mx_anisotropic_vdf');
    if (fnIdx === -1) return fs;
    return out.slice(0, fnIdx) + decls + out.slice(fnIdx);
};

// Folds transmission into peel-pass alpha (ESSL only writes it to RGB),
// then mixes toward a Schlick NdotV rim so grazing angles read as
// reflective glass instead of a flat, view-independent haze. Fail-soft.
// skipRefraction (sampler-budget drop) keeps the plain environment-term
// return; refraction also needs the same HW varyings as the Fresnel rim
// above plus the volumetric absorption anchor patchTransmissionThickness
// keys off, so it shares both gates.
const patchTransmissionAlpha = (fs, { skipRefraction = false } = {}) => {
    // Already patched: the peel mode uniform only exists after this pass.
    if (fs.indexOf('uniform int u_peelMode;') !== -1) return fs;
    let weightName = null;
    if (/uniform\s+float\s+transmission_weight\s*;/.test(fs)) weightName = 'transmission_weight';
    else if (/uniform\s+float\s+transmission\s*;/.test(fs)) weightName = 'transmission';
    if (!weightName) return fs;
    const colorExpr = /uniform\s+vec3\s+transmission_color\s*;/.test(fs) ? 'transmission_color' : 'vec3(1.0)';

    const transFnIdx = fs.indexOf('vec3 mx_surface_transmission');
    if (transFnIdx === -1) return fs;
    const returnAnchor = 'return mx_environment_radiance(N, V, X, alpha, distribution, fd) * tint;';
    const returnIdx = fs.indexOf(returnAnchor, transFnIdx);
    if (returnIdx === -1) return fs;

    const outAlphaMatch = fs.match(/float outAlpha = clamp\([^;]*\.transparency,\s*vec3\(0\.3333\)\),\s*0\.0,\s*1\.0\);/);
    if (!outAlphaMatch || outAlphaMatch.index <= returnIdx) return fs;
    const alphaInsertAt = outAlphaMatch.index + outAlphaMatch[0].length;

    // Measured: raw outAlpha barely varies by view angle on its own, so a
    // rim term needs the standard HW normal/position/eye varyings below.
    // Fall back to the flat fold (still floored) when any is missing.
    const hasFresnelVars = /\bin\s+vec3\s+normalWorld\s*;/.test(fs)
        && /\bin\s+vec3\s+positionWorld\s*;/.test(fs)
        && /uniform\s+vec3\s+u_viewPosition\s*;/.test(fs);

    // Base fold: alpha' = a*(1-tT) (T = (1-a)+a*tT), floored at 0.05 for
    // clear-glass sheen above u_alphaThreshold. A Schlick NdotV rim then
    // mixes the base toward 1.0 near grazing angles for a reflective edge.
    const alphaFold = hasFresnelVars
        ? '\n    if (u_peelMode != 0) {\n' +
          '        float _tT = ' + weightName + ' * dot(' + colorExpr + ', vec3(0.3333));\n' +
          '        float _base = outAlpha * (1.0 - _tT);\n' +
          '        vec3 _fN = normalize(normalWorld);\n' +
          '        vec3 _fV = normalize(u_viewPosition - positionWorld);\n' +
          // abs(): DoubleSide peeling also hits inward-facing back walls,
          // whose dot(N,V) is negative; a plain clamp would floor those to
          // 0 and misread every back layer as maximally grazing.
          '        float _fRim = pow(1.0 - abs(clamp(dot(_fN, _fV), -1.0, 1.0)), 5.0);\n' +
          '        outAlpha = max(clamp(mix(_base, 1.0, _fRim), 0.0, 1.0), 0.05);\n' +
          '    }'
        : '\n    if (u_peelMode != 0) {\n' +
          '        float _tT = ' + weightName + ' * dot(' + colorExpr + ', vec3(0.3333));\n' +
          '        outAlpha = max(clamp(outAlpha * (1.0 - _tT), 0.0, 1.0), 0.05);\n' +
          '    }';
    let out = fs.slice(0, alphaInsertAt) + alphaFold + fs.slice(alphaInsertAt);

    // Camera-visible refraction through a solid transmitter, gated on the
    // same varyings as the Fresnel rim plus the volumetric absorption
    // anchor patchTransmissionThickness needs for mx_transmission_path_length().
    const canRefract = !skipRefraction && hasFresnelVars
        && fs.indexOf('vdf.throughput = exp(-absorption);') !== -1;

    let refractionDecls = '';
    let gatedReturn;
    if (canRefract) {
        const declIfAbsent = (line) => (out.indexOf(line) === -1 ? line + '\n' : '');
        refractionDecls =
            declIfAbsent('uniform int u_peelRefractsScene;') +
            declIfAbsent('uniform highp sampler2D u_opaqueDepth;') +
            // No precision qualifier: parseUniforms' regex cannot see one
            // (same blind spot as u_peelPrevDepth/u_skyVisMap), and unlike
            // u_opaqueDepth this uniform IS seeded through has() below.
            declIfAbsent('uniform sampler2D u_opaqueColor;') +
            declIfAbsent('uniform float u_opaqueColorLevels;') +
            declIfAbsent('uniform float u_sceneRadius;') +
            declIfAbsent('uniform mat4 u_viewProjectionMatrix;') +
            declIfAbsent('uniform mat4 u_viewProjectionInverseMatrix;') +
            declIfAbsent('bool mx_sceneRefractionMiss = false;') +
            'float mx_transmission_path_length();\n' +
            'vec3 mx_scene_refraction(vec3 N, vec3 V, vec2 alpha, FresnelData fd, vec3 tint, vec3 envTerm)\n' +
            '{\n' +
            '    if (u_peelRefractsScene == 0) { mx_sceneRefractionMiss = true; return envTerm; }\n' +
            '    float eta = 1.0 / max(fd.ior.x, 1.0);\n' +
            '    vec3 dirIn = refract(-V, N, eta);\n' +
            '    if (dot(dirIn, dirIn) == 0.0) { mx_sceneRefractionMiss = true; return envTerm; }\n' +
            '    float t = mx_transmission_path_length();\n' +
            '    if (t <= 0.0) { mx_sceneRefractionMiss = true; return envTerm; }\n' +
            '    vec3 Pexit = positionWorld + dirIn * t;\n' +
            '    vec4 exitClip = u_viewProjectionMatrix * vec4(Pexit, 1.0);\n' +
            '    if (exitClip.w <= 0.0) { mx_sceneRefractionMiss = true; return envTerm; }\n' +
            '    vec2 exitUv = (exitClip.xy / exitClip.w) * 0.5 + 0.5;\n' +
            // Reach: distance from the exit point to the opaque background,
            // via unprojecting that background sample and comparing camera
            // distances. A thin slab has no reach; a thick one shifts more.
            '    float exitOpaqueRaw = texture(u_opaqueDepth, exitUv).r;\n' +
            '    vec4 exitOpaqueClip = vec4(exitUv * 2.0 - 1.0, exitOpaqueRaw * 2.0 - 1.0, 1.0);\n' +
            '    vec4 exitOpaqueWorldH = u_viewProjectionInverseMatrix * exitOpaqueClip;\n' +
            '    if (abs(exitOpaqueWorldH.w) < 1e-8) { mx_sceneRefractionMiss = true; return envTerm; }\n' +
            '    vec3 exitOpaqueWorld = exitOpaqueWorldH.xyz / exitOpaqueWorldH.w;\n' +
            '    float reach = max(distance(exitOpaqueWorld, u_viewPosition) - distance(Pexit, u_viewPosition), 0.0);\n' +
            '    reach = clamp(reach, 0.0, 4.0 * t + 0.1 * u_sceneRadius);\n' +
            // refract() needs dot(normal, incident) <= 0; dirIn already
            // satisfies that against N (not -N) at this second interface,
            // so reusing N is what keeps the eta=1 case an exact identity.
            '    vec3 dirOut = refract(dirIn, N, 1.0 / eta);\n' +
            '    if (dot(dirOut, dirOut) == 0.0) dirOut = dirIn;\n' + // TIR on exit: bounded, no internal bounce
            '    vec3 Ps = Pexit + dirOut * reach;\n' +
            '    vec4 sampleClip = u_viewProjectionMatrix * vec4(Ps, 1.0);\n' +
            '    if (sampleClip.w <= 0.0) { mx_sceneRefractionMiss = true; return envTerm; }\n' +
            '    vec2 uvS = (sampleClip.xy / sampleClip.w) * 0.5 + 0.5;\n' +
            '    if (uvS.x < 0.0 || uvS.x > 1.0 || uvS.y < 0.0 || uvS.y > 1.0) { mx_sceneRefractionMiss = true; return envTerm; }\n' +
            // Disocclusion: a nearer opaque sample than this fragment's own
            // depth is a foreground object, not the true background.
            '    float zS = texture(u_opaqueDepth, uvS).r;\n' +
            '    if (zS < gl_FragCoord.z) { mx_sceneRefractionMiss = true; return envTerm; }\n' +
            '    float lod = clamp(alpha.x * u_opaqueColorLevels, 0.0, u_opaqueColorLevels);\n' +
            '    return textureLod(u_opaqueColor, uvS, lod).rgb * tint;\n' +
            '}\n';
        gatedReturn =
            'if (u_peelMode != 0) {\n' +
            '        vec3 envTerm = mx_environment_radiance(N, V, X, alpha, distribution, fd) * tint * ' + PEEL_REFRACTION_SCALE + ';\n' +
            '        if (u_peelRefractsScene == 0) return envTerm;\n' +
            '        return mx_scene_refraction(N, V, alpha, fd, tint, envTerm);\n' +
            '    }\n    ' + returnAnchor;
    } else {
        gatedReturn =
            'if (u_peelMode != 0) {\n' +
            '        return mx_environment_radiance(N, V, X, alpha, distribution, fd) * tint * ' + PEEL_REFRACTION_SCALE + ';\n' +
            '    }\n    ' + returnAnchor;
    }
    out = out.slice(0, returnIdx) + gatedReturn + out.slice(returnIdx + returnAnchor.length);
    out = out.slice(0, transFnIdx) + refractionDecls + 'uniform int u_peelMode;\n' + out.slice(transFnIdx);

    return out;
};

// Local environment reflections: substitutes a static per-stage cubemap
// capture (js/usd-scene-localenv.js) into the generated prefilter's `Li`
// lookup, so a reflective surface sees the studio set it sits in (floor,
// cyc wall) rather than only the dome. See
// scratchpad/displacement-verified/reflections/design.md section 5.5.
//
// Sits at `Li` INSIDE the function patchScreenSpaceReflection renames to
// mx_environment_radiance_ibl, so FG, fd.refraction and u_envLightIntensity
// are all inherited unchanged: the local term is weighted by exactly the
// same directional albedo the dome term is. This function therefore MUST
// run before patchScreenSpaceReflection in the call chain (see the call
// site in generatePreviewSourcesUnlocked); the two patches then compose
// without either knowing about the other.
const patchLocalEnvironmentRadiance = (fs, { skipLocalEnv = false, notices = null } = {}) => {
    if (fs.indexOf('mx_local_env_mix') !== -1) return fs;
    // The generator's own prefilter body (mx_environment_prefilter.glsl),
    // matched verbatim; FIS (no single `Li` assignment) and any shader
    // shape the generator changes underneath us both safe-fail here.
    const anchor = 'vec3 Li = mx_latlong_map_lookup(L, u_envMatrix, mx_latlong_alpha_to_lod(avgAlpha), u_envRadiance);';
    const anchorIdx = fs.indexOf(anchor);
    const usable = anchorIdx !== -1
        && /\bin\s+vec3\s+positionWorld\s*;/.test(fs)
        && /\bvec2\s+mx_latlong_projection\s*\(/.test(fs);
    if (skipLocalEnv || !usable) {
        if (anchorIdx !== -1 && !skipLocalEnv && notices) {
            notices.push('local reflections: shader anchor unusable (missing positionWorld or mx_latlong_projection); reflections stay image based');
        }
        return fs;
    }
    let out = fs.slice(0, anchorIdx) + anchor
        + '\n    Li = mx_local_env_mix(Li, positionWorld, L, mx_latlong_alpha_to_lod(avgAlpha));'
        + fs.slice(anchorIdx + anchor.length);

    const declIfAbsent = (line) => (out.indexOf(line) === -1 ? line + '\n' : '');
    const decls =
        declIfAbsent('uniform sampler2D u_localEnvRadiance;') +
        declIfAbsent('uniform float u_localEnvMips;') +
        declIfAbsent('uniform float u_localEnvStrength;') +
        declIfAbsent('uniform vec3 u_localEnvProbe;') +
        declIfAbsent('uniform vec3 u_localEnvBoxMin;') +
        declIfAbsent('uniform vec3 u_localEnvBoxMax;') +
        declIfAbsent('uniform int u_localEnvParallax;');

    const helpers =
        // P is positionWorld, R is the same L the generated body already
        // computed, so no second reflect.
        'vec3 mx_local_env_direction(vec3 P, vec3 R)\n' +
        '{\n' +
        '    if (u_localEnvParallax == 0) return R;\n' +
        '    vec3 invR = 1.0 / max(abs(R), vec3(1e-6)) * sign(R + vec3(1e-9));\n' +
        '    vec3 tMax = (u_localEnvBoxMax - P) * invR;\n' +
        '    vec3 tMin = (u_localEnvBoxMin - P) * invR;\n' +
        '    vec3 tFar = max(tMax, tMin);\n' +
        '    float t = min(min(tFar.x, tFar.y), tFar.z);\n' +
        '    if (!(t > 0.0)) return R;\n' +
        '    return normalize((P + R * t) - u_localEnvProbe);\n' +
        '}\n' +
        // RGB is premultiplied by A (coverage) in the capture; un-multiply
        // here. No occlusion compensation: patchAmbientOcclusion's
        // `occlusion` scalar is wired into ClosureData.occlusion, which the
        // generated closures (mx_conductor_bsdf.glsl etc.) only read in
        // their CLOSURE_TYPE_REFLECTION (direct light) branches, never in
        // CLOSURE_TYPE_INDIRECT, so it never darkens mx_environment_radiance
        // or this substituted Li in the first place. An earlier revision
        // divided by it here to "undo" a darkening that does not happen,
        // amplifying the local term by up to 20x (see
        // scratchpad/displacement-verified/reflections/overshoot.md).
        'vec3 mx_local_env_mix(vec3 domeLi, vec3 P, vec3 R, float lod)\n' +
        '{\n' +
        '    if (u_localEnvStrength <= 0.0) return domeLi;\n' +
        '    vec3 D = mx_local_env_direction(P, R);\n' +
        '    vec2 uv = mx_latlong_projection(D);\n' +
        '    vec4 s = textureLod(u_localEnvRadiance, uv, clamp(lod, 0.0, u_localEnvMips - 1.0));\n' +
        '    float cov = clamp(s.a, 0.0, 1.0);\n' +
        '    if (cov <= 0.0) return domeLi;\n' +
        '    vec3 local = s.rgb / max(s.a, 1e-4);\n' +
        '    return mix(domeLi, local, cov * clamp(u_localEnvStrength, 0.0, 1.0));\n' +
        '}\n';

    // Land just above whichever function signature's BODY actually contains
    // the Li anchor: ordinarily that is mx_environment_radiance itself, but
    // if patchScreenSpaceReflection already ran first (not reachable today,
    // skipSsr is hardcoded true, but kept correct for when it is unparked),
    // that function was renamed to mx_environment_radiance_ibl and a NEW
    // mx_environment_radiance wrapper now exists further down, near main;
    // matching by name alone would find that wrapper instead. Take the last
    // signature match that still precedes the anchor.
    const fnAnchorRe = /vec3 mx_environment_radiance(?:_ibl)?\(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd\)[ \t]*\r?\n[ \t]*\{/g;
    let insertAt = -1;
    let fnMatch;
    while ((fnMatch = fnAnchorRe.exec(out))) {
        if (fnMatch.index >= anchorIdx) break;
        insertAt = fnMatch.index;
    }
    if (insertAt === -1) insertAt = out.indexOf('void main(');
    if (insertAt === -1) return fs; // nothing recognisable: leave the shader untouched
    out = out.slice(0, insertAt) + decls + helpers + out.slice(insertAt);
    // mx_local_env_mix no longer reads mx_env_occlusion_value() (see its own
    // comment), but patchAmbientOcclusion's own writer still needs the
    // mx_envOcclusionValue declaration to exist before its assignment runs.
    // Keep calling it here so whichever patch runs first still gets the
    // declaration in, regardless of order.
    out = ensureEnvOcclusionGlobal(out);
    return out;
};

// Screen-space reflections: reprojects a scene-linear colour buffer along the
// reflection ray for opaque surfaces (history frame) and peel layers (current
// frame, see mtlx-engine.js's RGB-T per-pass binding). Wraps the generated
// mx_environment_radiance so every existing IBL call site gains SSR for free.
const patchScreenSpaceReflection = (fs, { skipSsr = false, notices = null } = {}) => {
    if (fs.indexOf('mx_environment_radiance_ibl') !== -1) return fs;
    if (skipSsr || !/\bin\s+vec3\s+positionWorld\s*;/.test(fs)) return fs;
    const sig = 'vec3 mx_environment_radiance(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd)';
    const anchorRe = /vec3 mx_environment_radiance\(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd\)[ \t]*\r?\n[ \t]*\{/;
    const anchorMatch = anchorRe.exec(fs);
    if (!anchorMatch) {
        const called = /mx_environment_radiance\(N,\s*V,\s*X,\s*\w+,\s*(?:distribution|\d+),\s*fd\)/.test(fs);
        const stubPresent = fs.indexOf(sig + ' { return vec3(0.0); }') !== -1;
        if (called && !stubPresent && notices) {
            notices.push('screen-space reflection: environment radiance anchor not found; reflections stay image based');
        }
        return fs;
    }
    const bodyStart = anchorMatch.index + anchorMatch[0].length;
    // Rename the definition to mx_environment_radiance_ibl (name only; the
    // parameter list/body text is untouched).
    let out = fs.slice(0, anchorMatch.index) + 'vec3 mx_environment_radiance_ibl'
        + anchorMatch[0].slice('vec3 mx_environment_radiance'.length) + fs.slice(bodyStart);

    const declIfAbsent = (line) => (out.indexOf(line) === -1 ? line + '\n' : '');
    const decls =
        'uniform int u_ssrEnabled;\n' +
        'uniform float u_ssrStrength;\n' +
        'uniform float u_ssrMaxRoughness;\n' +
        'uniform mat4 u_historyViewProjectionMatrix;\n' +
        'uniform mat4 u_historyViewProjectionInverseMatrix;\n' +
        'uniform vec3 u_historyViewPosition;\n' +
        declIfAbsent('uniform sampler2D u_opaqueColor;') +
        declIfAbsent('uniform float u_opaqueColorLevels;') +
        declIfAbsent('uniform float u_sceneRadius;') +
        declIfAbsent('uniform highp sampler2D u_opaqueDepth;') +
        // File-scope trace result: written by ONE call to mx_ssr_trace per
        // fragment (see the injected call site below), read by every
        // mx_environment_radiance call site the closures generate.
        'bool mx_ssrTraced = false;\n' +
        'bool mx_ssrHit = false;\n' +
        'vec2 mx_ssrUv = vec2(0.0);\n' +
        'vec3 mx_environment_radiance(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd);\n';

    // The march (origin, 16 steps, 4-step bisection) lives here ONCE and
    // runs at most once per fragment; the wrapper below only blends its
    // result, so a material with several closures never re-runs it.
    const trace =
        'void mx_ssr_trace(vec3 N, vec3 V)\n' +
        '{\n' +
        '    mx_ssrTraced = true;\n' +
        '    vec3 Nf = mx_forward_facing_normal(N, V);\n' +
        '    vec3 R = normalize(reflect(-V, Nf));\n' +
        '    vec3 origin = positionWorld + Nf * 0.002 * u_sceneRadius;\n' +
        '    bool hit = false;\n' +
        '    vec2 uv = vec2(0.0);\n' +
        '    float tPrev = 0.0;\n' +
        '    float tLo = 0.0;\n' +
        '    float tHi = 0.0;\n' +
        '    for (int i = 0; i < 16; i++) {\n' +
        '        float f = float(i) / 16.0;\n' +
        '        float t = 0.5 * u_sceneRadius * f * f;\n' +
        '        vec3 P = origin + R * t;\n' +
        '        vec4 clip = u_historyViewProjectionMatrix * vec4(P, 1.0);\n' +
        '        if (clip.w <= 0.0) break;\n' +
        '        vec2 sUv = (clip.xy / clip.w) * 0.5 + 0.5;\n' +
        '        if (sUv.x < 0.0 || sUv.x > 1.0 || sUv.y < 0.0 || sUv.y > 1.0) break;\n' +
        '        float z = textureLod(u_opaqueDepth, sUv, 0.0).r;\n' +
        '        if (z >= 1.0) { tPrev = t; continue; }\n' +
        '        vec4 unprojH = u_historyViewProjectionInverseMatrix * vec4(sUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);\n' +
        '        vec3 unprojected = unprojH.xyz / unprojH.w;\n' +
        '        float dScene = distance(unprojected, u_historyViewPosition);\n' +
        '        float dSample = distance(P, u_historyViewPosition);\n' +
        '        float behind = dSample - dScene;\n' +
        '        if (behind > 0.0 && behind < 0.02 * u_sceneRadius + 0.02 * dSample) {\n' +
        '            hit = true;\n' +
        '            uv = sUv;\n' +
        '            tLo = tPrev;\n' +
        '            tHi = t;\n' +
        '            break;\n' +
        '        }\n' +
        '        tPrev = t;\n' +
        '    }\n' +
        '    // Bisection after the march so the compiler unrolls 16 + 4 bodies, not 16 x 4.\n' +
        '    for (int b = 0; b < 4; b++) {\n' +
        '        if (!hit) break;\n' +
        '        float tm = 0.5 * (tLo + tHi);\n' +
        '        vec3 Pm = origin + R * tm;\n' +
        '        vec4 clipM = u_historyViewProjectionMatrix * vec4(Pm, 1.0);\n' +
        '        if (clipM.w <= 0.0) { tLo = tm; continue; }\n' +
        '        vec2 mUv = (clipM.xy / clipM.w) * 0.5 + 0.5;\n' +
        '        if (mUv.x < 0.0 || mUv.x > 1.0 || mUv.y < 0.0 || mUv.y > 1.0) { tLo = tm; continue; }\n' +
        '        float mZ = textureLod(u_opaqueDepth, mUv, 0.0).r;\n' +
        '        if (mZ >= 1.0) { tLo = tm; continue; }\n' +
        '        vec4 mUnprojH = u_historyViewProjectionInverseMatrix * vec4(mUv * 2.0 - 1.0, mZ * 2.0 - 1.0, 1.0);\n' +
        '        vec3 mUnprojected = mUnprojH.xyz / mUnprojH.w;\n' +
        '        float mDScene = distance(mUnprojected, u_historyViewPosition);\n' +
        '        float mDSample = distance(Pm, u_historyViewPosition);\n' +
        '        float mBehind = mDSample - mDScene;\n' +
        '        if (mBehind > 0.0 && mBehind < 0.02 * u_sceneRadius + 0.02 * mDSample) {\n' +
        '            tHi = tm;\n' +
        '            uv = mUv;\n' +
        '        } else {\n' +
        '            tLo = tm;\n' +
        '        }\n' +
        '    }\n' +
        '    mx_ssrHit = hit;\n' +
        '    mx_ssrUv = uv;\n' +
        '}\n';
    out = out.slice(0, anchorMatch.index) + decls + trace + out.slice(anchorMatch.index);

    // No loop here: the march already ran (or did not) in mx_ssr_trace;
    // this only blends its result per closure, using that closure's own
    // roughness for FG and the confidence fade.
    const wrapper =
        'vec3 mx_environment_radiance(vec3 N, vec3 V, vec3 X, vec2 alpha, int distribution, FresnelData fd)\n' +
        '{\n' +
        '    vec3 ibl = mx_environment_radiance_ibl(N, V, X, alpha, distribution, fd);\n' +
        '    if (u_ssrEnabled == 0 || fd.refraction || !mx_ssrTraced) return ibl;\n' +
        '    float avgAlpha = mx_average_alpha(alpha);\n' +
        '    if (avgAlpha >= u_ssrMaxRoughness) return ibl;\n' +
        '    float NdotV = clamp(dot(mx_forward_facing_normal(N, V), V), M_FLOAT_EPS, 1.0);\n' +
        '    vec3 FG = mx_ggx_dir_albedo(NdotV, avgAlpha, fd);\n' +
        '    float edge = min(min(mx_ssrUv.x, 1.0 - mx_ssrUv.x), min(mx_ssrUv.y, 1.0 - mx_ssrUv.y));\n' +
        '    float confidence = mx_ssrHit ? smoothstep(0.0, 0.1, edge) * (1.0 - smoothstep(0.0, u_ssrMaxRoughness, avgAlpha)) : 0.0;\n' +
        '    float lod = clamp(avgAlpha * u_opaqueColorLevels, 0.0, u_opaqueColorLevels);\n' +
        '    return mix(ibl, textureLod(u_opaqueColor, mx_ssrUv, lod).rgb * FG, clamp(confidence * u_ssrStrength, 0.0, 1.0));\n' +
        '}\n';
    const mainIdx = out.indexOf('void main');
    if (mainIdx === -1) return out;
    out = out.slice(0, mainIdx) + wrapper + out.slice(mainIdx);

    // Single call site: right after the primary shading N/V, so the trace
    // runs at most once per fragment regardless of how many closures call
    // mx_environment_radiance. Bump-mapped closures still reflect along
    // this geometric-ish N; only FG and the confidence fade use their own.
    const nvAnchorRe = /vec3 N = normalize\(normalWorld\);[ \t]*\r?\n[ \t]*vec3 V = normalize\(u_viewPosition - positionWorld\);/;
    const nvMatch = nvAnchorRe.exec(out);
    if (nvMatch) {
        const at = nvMatch.index + nvMatch[0].length;
        out = out.slice(0, at) + '\n        if (u_ssrEnabled != 0) mx_ssr_trace(N, V);' + out.slice(at);
    } else if (notices) {
        notices.push('screen-space reflection: shading normal/view anchor not found; reflections stay image based');
    }
    return out;
};

// Enables the Scene RGB-T payload on generated MaterialX shaders. The
// terminal viewing response is the closure's layered result; moving it to
// surfaceshader.transparency lets the existing opacity block apply coverage
// exactly once while keeping reflected/emissive C additive. The old scalar
// transmission patch is intentionally bypassed for this mode.
const patchRgbtPayload = (fs) => {
    // Already patched: the RGB-T uniform only exists after this pass.
    if (fs.indexOf('uniform int u_peelRgbt;') !== -1) return fs;
    const original = fs;
    let supported = true;
    let out = fs;
    const transFnIdx = out.indexOf('vec3 mx_surface_transmission');
    if (transFnIdx !== -1) {
        const bodyIdx = out.indexOf('{', transFnIdx);
        if (bodyIdx === -1) supported = false;
        else if (out.indexOf('u_peelRgbt', transFnIdx) === -1) {
            // RGB-T mode returns tint directly; a refracting material
            // instead samples the opaque colour buffer along its bent ray
            // here, ahead of that short circuit.
            const hasRefraction = out.lastIndexOf('vec3 mx_scene_refraction', transFnIdx) !== -1;
            const rgbtReturn = hasRefraction
                ? 'if (u_peelRgbt != 0) { if (u_peelRefractsScene != 0) return mx_scene_refraction(N, V, alpha, fd, tint, tint); return tint; }'
                : 'if (u_peelRgbt != 0) return tint;';
            out = out.slice(0, bodyIdx + 1) +
                '\n    ' + rgbtReturn + '\n' + out.slice(bodyIdx + 1);
        }
    }
    // Restrict the replacement to the generated viewing-transmission section
    // so an unrelated color accumulation elsewhere cannot be redirected.
    let cursor = 0;
    let sectionCount = 0;
    let routedCount = 0;
    const sectionAnchor = '// Calculate the BSDF transmission for viewing direction';
    const opacityAnchor = '// Compute and apply surface opacity';
    while (true) {
        const begin = out.indexOf(sectionAnchor, cursor);
        if (begin === -1) break;
        sectionCount++;
        const end = out.indexOf(opacityAnchor, begin);
        if (end === -1) { supported = false; break; }
        const section = out.slice(begin, end);
        // A generated viewing-transmission section has one terminal closure
        // accumulation.  Picking the last match used to make a mixed graph
        // look supported while silently routing an earlier closure (or a
        // helper's unrelated accumulation) to T.  Require the contract to be
        // unambiguous and fail the whole payload atomically when it is not.
        const matches = [...section.matchAll(/(\w+)\.color\s*\+=\s*(\w+)\.response\s*;/g)];
        if (matches.length !== 1) { supported = false; break; }
        const match = matches[0];
        const terminal = match[0];
        const lhs = match[1];
        const rhs = match[2];
        // A refracting hit's response is a real colour sample, not a tint;
        // it belongs in C like an ordinary BSDF term. A miss (flag set
        // inside mx_scene_refraction) still routes to T as usual.
        const routed = 'if (u_peelRgbt != 0 && (u_peelRefractsScene == 0 || mx_sceneRefractionMiss)) ' + lhs + '.transparency = clamp(' + rhs + '.response, vec3(0.0), vec3(1.0));\n' +
            '    else ' + terminal;
        const at = begin + match.index;
        out = out.slice(0, at) + routed + out.slice(at + terminal.length);
        cursor = at + routed.length;
        routedCount++;
    }
    if (!sectionCount || routedCount !== sectionCount) {
        mtlxWarn('mtlx-engine: RGB-T payload section anchors changed; using Scene legacy peel.');
        supported = false;
    }
    // The generated output is coverage-premultiplied C and transparency T.
    // Pass 1 replaces RGB with T for the explicit transmission target; pass
    // 0/2 retain C and the unmodified scalar coverage alpha for tail blending.
    const output = out.match(/\bout\s+vec4\s+(\w+)\s*;/);
    if (output) {
        const v = output[1];
        // encodeDisplay() has already appended a second assignment to the
        // output variable.  Select the one that carries the generated surface
        // color and require exactly one such assignment, so an unfamiliar or
        // mixed graph cannot accidentally receive a partial payload patch.
        const assignments = [...out.matchAll(new RegExp('(' + v + '\\s*=\\s*vec4\\([^;]+\\);)', 'g'))]
            .filter((m) => /vec4\(\s*\w+\.color\s*,/.test(m[0]));
        const om = assignments.length === 1 ? assignments[0] : null;
        if (!om) supported = false;
        if (om && out.indexOf('u_peelRgbtPass', om.index) === -1) {
            const surfaceMatch = om[0].match(/vec4\(\s*(\w+)\.color\s*,/);
            if (!surfaceMatch) supported = false;
            const surfaceVar = surfaceMatch ? surfaceMatch[1] : '';
            const injectAt = om.index + om[0].length;
            // A refracting hit's colour already landed in C above; writing
            // it into T too would double it via the compositor's t*opaque
            // term, so T is zeroed there. A miss still writes T normally.
            out = out.slice(0, injectAt) +
                '\n    if (u_peelRgbt != 0 && u_peelRgbtPass == 1) ' + v +
                ' = (u_peelRefractsScene != 0 && !mx_sceneRefractionMiss) ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(' + surfaceVar + '.transparency, 1.0);' +
                out.slice(injectAt);
        }
        // Clear transmissive emission has outAlpha=0 but still contributes C;
        // only legacy mode uses the generator's alpha threshold discard.
        // MaterialX emits this threshold in both compact and braced forms;
        // clear transmission has outAlpha=0 and must remain a valid RGB-T C
        // payload in either form.  Keep the threshold discard on legacy peel
        // only, preserving the generated block's semantics exactly.
        out = out.replace(/if\s*\(\s*outAlpha\s*<\s*u_alphaThreshold\s*\)\s*(?:\{\s*discard\s*;\s*\}|discard\s*;)/,
            'if (u_peelRgbt == 0 && outAlpha < u_alphaThreshold) { discard; }');
    }
    else supported = false;
    if (!supported) return original;
    // Declarations must precede every generated function: transmission
    // helpers are commonly emitted before main().
    const firstFn = out.search(/^(?:void|vec[234]|float|int|bool|mat[234])\s+\w+\s*\(/m);
    const decl = 'uniform int u_peelRgbt;\nuniform int u_peelRgbtPass;\nuniform int u_peelRgbtLayer;\n/* MX_RGBT_PAYLOAD_SUPPORTED */\n';
    if (firstFn === -1) return original;
    if (out.indexOf('uniform int u_peelRgbt;') === -1) {
        out = out.slice(0, firstFn) + decl + out.slice(firstFn);
    }
    // The T-zero gate above always needs these; patchTransmissionAlpha may
    // already have declared them (refraction path) or may not have run at
    // all for this shading model, so guard separately here too.
    if (out.indexOf('uniform int u_peelRefractsScene;') === -1) {
        out = out.slice(0, firstFn) + 'uniform int u_peelRefractsScene;\n' + out.slice(firstFn);
    }
    if (out.indexOf('bool mx_sceneRefractionMiss') === -1) {
        out = out.slice(0, firstFn) + 'bool mx_sceneRefractionMiss = false;\n' + out.slice(firstFn);
    }
    // patchTransmissionAlpha runs first to preserve the complete legacy
    // source; its scalar floor is disabled only while RGB-T is active.
    out = out.replace(/if\s*\(\s*u_peelMode\s*!=\s*0\s*\)\s*\{/g,
        'if (u_peelMode != 0 && u_peelRgbt == 0) {');
    return out;
};

// injectPeelDiscard(src), bakes the depth-peel OIT machinery into
// EVERY generated fragment shader unconditionally, gated behind a
// runtime uniform (u_peelMode, default 0 = no-op) so toggling Force
// Transparency never needs a regen/recompile. Inserts four uniform
// decls immediately above void main() (top-level, after any
// #version/#extension directives) and splices a guarded discard block
// right after main()'s opening brace: u_opaqueDepth rejects anything
// behind the opaque scene, u_peelPrevDepth (+eps slop) rejects
// anything at/in-front-of the previous peeled layer, mode 1 (regular
// peel) and mode 2 (tail pass) share this same guard. Mode 2 also gets
// a premultiply epilogue (see below) so its output can under-blend
// into accumRT. Fail-loud (throws) if main() can't be found, same
// contract as encodeDisplay() above.
const injectPeelDiscard = (src, sceneRgbt = false) => {
    // Skip decls patchTransmissionAlpha may have already inserted.
    const declIfAbsent = (line) => (src.indexOf(line) === -1 ? line + '\n' : '');
    const decls =
        declIfAbsent('uniform int u_peelMode;') +
        declIfAbsent('uniform int u_peelHasPrev;') +
        declIfAbsent('uniform highp sampler2D u_peelPrevDepth;') +
        declIfAbsent('uniform highp sampler2D u_opaqueDepth;') +
        declIfAbsent('uniform int u_peelLinear;');
    const block =
        '\n    if (u_peelMode != 0) {\n' +
        '        ivec2 _pc = ivec2(gl_FragCoord.xy);\n' +
        '        float _opaqueZ = texelFetch(u_opaqueDepth, _pc, 0).r;\n' +
        '        if (gl_FragCoord.z >= _opaqueZ) discard;\n' +
        '        if (u_peelHasPrev != 0) {\n' +
        '            float _prevZ = texelFetch(u_peelPrevDepth, _pc, 0).r;\n' +
        '            // PEEL_EPS: ~17 quanta of 24-bit depth precision; constant across cameras/near-far (revisit if coplanar shells misrender).\n' +
        '            if (gl_FragCoord.z <= _prevZ + 1e-6) discard;\n' +
        '        }\n' +
        '    }\n';
    const mainIdx = src.indexOf('void main');
    if (mainIdx === -1) throw new Error('injectPeelDiscard: no main() found (MaterialX output format may have changed)');
    const braceIdx = src.indexOf('{', mainIdx);
    if (braceIdx === -1) throw new Error('injectPeelDiscard: no main() body found (MaterialX output format may have changed)');
    let out = src.slice(0, mainIdx) + decls + src.slice(mainIdx, braceIdx + 1) + block + src.slice(braceIdx + 1);

    // Tail pass (u_peelMode==2) writes premultiplied color so it can
    // under-blend into accumRT; injected right before main()'s closing
    // brace (same anchor encodeDisplay() uses for its own epilogue, which
    // by now has already spliced, gated open or not, and is the last
    // thing before that brace).
    // A light-transport variant always returns before this point (see
    // patchLightTransportPayload's early return), so the tail is
    // unreachable there and skipped for that variant.
    const outMatch = out.match(/\bout\s+vec4\s+(\w+)\s*;/);
    if (out.indexOf('MX_LIGHT_TRANSPORT_EARLY_RETURN') !== -1) {
        // no-op: the tail is unreachable for this variant.
    } else if (outMatch) {
        const v = outMatch[1];
        const closeIdx = out.lastIndexOf('}');
        const premult = '\n    if (u_peelMode == 2 && ' + (sceneRgbt ? 'u_peelRgbt == 0' : 'true') + ') { ' + v + '.rgb *= ' + v + '.a; }\n';
        out = out.slice(0, closeIdx) + premult + out.slice(closeIdx);
    } else {
        mtlxWarn('mtlx-engine: injectPeelDiscard could not locate the fragment output variable, tail-pass premultiply skipped.');
    }
    return out;
};

// Emscripten throws C++ exceptions as raw NUMBER pointers, not Error
// objects, a bare catch stringifies one as "5247184"/"undefined" instead
// of the real message. Decode via mx.getExceptionMessage when available.
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

// CRITICAL: the wasm binding of setValueString is the TYPED
// setValue(value, type="string"), so writing a value RETYPES the input
// to "string". Writing the raw `value` attribute never touches type.
const mxWriteValue = (inp, str, type) => {
    mxWarnIfLocked('mxWriteValue'); // exported doc-mutating helper, see mxWarnIfLocked's header comment
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
    if (Array.isArray(v)) return v;   // this vendored build marshals vectors as real JS arrays
    if (typeof v.size === 'function') {
        const out = [];
        for (let i = 0; i < v.size(); i++) out.push(v.get(i));
        // embind-owned heap vector; materialized elements are independent
        // shared_ptr handles, so free the wrapper. Audited: no caller
        // retains the raw vector (js/ and scripts/ checked).
        if (typeof v.delete === 'function') { try { v.delete(); } catch (e) { /* already freed */ } }
        return out;
    }
    return [];
};

const mxSafe = (fn, fb) => { try { const v = fn(); return v == null ? fb : v; } catch (e) { return fb; } };
const mxElCat = (el) => mxSafe(() => el.getCategory(), '');
const mxElType = (el) => mxSafe(() => String(el.getType()), '');
const mxElName = (el) => mxSafe(() => el.getName(), '');
const mxElAttr = (el, name) => mxSafe(() => el.getAttribute(name), '');

// GLSL leaves pow(x, y) undefined for x < 0, even when y is an exact integer.
// MaterialX power nodes commonly raise signed procedural noise for bump maps,
// where that undefined result becomes a NaN normal and erases the whole BSDF
// layer. Keep library pow calls untouched and route only authored power-node
// assignments through a real-domain, sign-preserving extension: negative bases
// with non-integer exponents return -pow(-base, exponent), matching the Karma
// reference band spacing measured on egg_normals while staying finite.
const materialPowerNodeNames = (doc) => {
    if (!doc) return [];
    const nodes = [];
    try { nodes.push(...vecToArray(doc.getNodes ? doc.getNodes() : null)); } catch (e) { /* empty */ }
    try {
        for (const graph of vecToArray(doc.getNodeGraphs ? doc.getNodeGraphs() : null)) {
            nodes.push(...vecToArray(graph.getNodes ? graph.getNodes() : null));
        }
    } catch (e) { /* empty */ }
    return Array.from(new Set(nodes
        .filter((node) => mxElCat(node) === 'power')
        .map((node) => mxElName(node))
        .filter(Boolean)));
};

const materialGeompropDefaults = (doc) => {
    const defaults = new Map();
    if (!doc) return defaults;
    const nodes = [];
    nodes.push(...vecToArray(mxSafe(() => doc.getNodes ? doc.getNodes() : null, [])));
    for (const graph of vecToArray(mxSafe(() => doc.getNodeGraphs ? doc.getNodeGraphs() : null, []))) {
        nodes.push(...vecToArray(mxSafe(() => graph.getNodes ? graph.getNodes() : null, [])));
    }
    for (const node of nodes) {
        if (mxElCat(node) !== 'geompropvalue') continue;
        let propName = '';
        let value = '';
        for (const input of vecToArray(mxSafe(() => node.getInputs(), []))) {
            const inputName = mxSafe(() => String(input.getName()), '');
            const inputValue = mxElAttr(input, 'value');
            if (inputName === 'geomprop') propName = String(inputValue || '');
            else if (inputName === 'default') value = String(inputValue || '');
        }
        if (!propName || !value) continue;
        const parts = value.split(',').map((part) => Number(part.trim())).filter(Number.isFinite);
        if (parts.length) defaults.set(propName, parts);
    }
    return defaults;
};

const POWER_NODE_REAL_GLSL = `
float mx_preview_power_real(float base, float exponent)
{
    if (base >= 0.0) return pow(base, exponent);
    float nearest = floor(exponent);
    if (exponent != nearest) return -pow(-base, exponent);
    float magnitude = pow(-base, exponent);
    return mod(abs(nearest), 2.0) < 0.5 ? magnitude : -magnitude;
}
vec2 mx_preview_power_real(vec2 base, vec2 exponent)
{
    return vec2(mx_preview_power_real(base.x, exponent.x), mx_preview_power_real(base.y, exponent.y));
}
vec3 mx_preview_power_real(vec3 base, vec3 exponent)
{
    return vec3(mx_preview_power_real(base.x, exponent.x), mx_preview_power_real(base.y, exponent.y), mx_preview_power_real(base.z, exponent.z));
}
vec4 mx_preview_power_real(vec4 base, vec4 exponent)
{
    return vec4(mx_preview_power_real(base.x, exponent.x), mx_preview_power_real(base.y, exponent.y), mx_preview_power_real(base.z, exponent.z), mx_preview_power_real(base.w, exponent.w));
}
`;

const patchMaterialPowerNodes = (fs, nodeNames) => {
    if (!fs || !nodeNames || !nodeNames.length) return fs;
    let patched = fs;
    let replacements = 0;
    for (const name of nodeNames) {
        const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const assignment = new RegExp('(\\b' + escaped + '_out\\s*=\\s*)pow\\s*\\(', 'g');
        patched = patched.replace(assignment, (match, prefix) => {
            replacements++;
            return prefix + 'mx_preview_power_real(';
        });
    }
    if (!replacements || patched.includes('float mx_preview_power_real(')) return patched;
    const firstFunction = patched.search(/\bvoid\s+\w+\s*\(/);
    return firstFunction >= 0
        ? patched.slice(0, firstFunction) + POWER_NODE_REAL_GLSL + '\n' + patched.slice(firstFunction)
        : POWER_NODE_REAL_GLSL + '\n' + patched;
};
const mxElHasAttr = (el, name) => mxSafe(() => el.hasAttribute(name), false);
// Exception-safe single-attribute writes, the wasm binding can throw on
// a detached/invalid element, which mxSafe swallows into a `false` return.
const mxSetAttr = (el, name, value) => mxSafe(() => { el.setAttribute(name, value); return true; }, false);
const mxRemoveAttr = (el, name) => mxSafe(() => { el.removeAttribute(name); return true; }, false);
// Tag an element's colorspace, preferring the typed setColorSpace()
// binding when present and falling back to the raw attribute otherwise,
// not every element's wasm binding exposes the typed setter.
const mxSetColorspace = (el, cs) => {
    mxWarnIfLocked('mxSetColorspace'); // exported doc-mutating helper, see mxWarnIfLocked's header comment
    return mxSafe(() => {
        if (typeof el.setColorSpace === 'function') el.setColorSpace(cs);
        else el.setAttribute('colorspace', cs);
        return true;
    }, false);
};

// Shortest `convert` hop chain fromType->toType (only conversions the
// library defines), a mismatched convert otherwise fails silently
// until GLSL compile. []=no convert needed, null=unreachable.
const findConvertChain = (doc, fromType, toType) => {
    mxWarnIfLocked('findConvertChain'); // exported doc-reading helper, see mxWarnIfLocked's header comment
    if (fromType === toType) return [];
    const typeStr = (t) => (t && t.getName) ? t.getName() : String(t || '');
    // convert nodedefs -> directed edges inType -> outType
    const convEdges = {};
    for (const def of vecToArray(mxSafe(() => doc.getMatchingNodeDefs('convert'), []))) {
        const ins = vecToArray(mxSafe(() => def.getInputs(), []));
        if (ins.length !== 1) continue;
        const inT = typeStr(mxSafe(() => ins[0].getType(), ''));
        const outT = typeStr(mxSafe(() => def.getType(), ''));
        if (!inT || !outT || outT === 'multioutput') continue;
        (convEdges[inT] = convEdges[inT] || new Set()).add(outT);
    }
    // BFS, shortest chain wins (converts are cheap but each hop is
    // another generated function).
    const prev = { [fromType]: null };
    let frontier = [fromType];
    while (frontier.length) {
        const next = [];
        for (const t of frontier) {
            for (const n of convEdges[t] || []) {
                if (n in prev) continue;
                prev[n] = t;
                if (n === toType) {
                    const chain = [];
                    for (let c = toType; c !== fromType; c = prev[c]) chain.unshift(c);
                    return chain;
                }
                next.push(n);
            }
        }
        frontier = next;
    }
    return null;
};

// Create-or-fetch an input on `node`, guaranteeing its TYPE, the only
// safe way here: addInput(name, type) can drop the type arg, and
// setValueString retypes to 'string', either breaking nodedef resolution.
const ensureTypedInput = (doc, node, inputName, wantedType) => {
    mxWarnIfLocked('ensureTypedInput'); // exported doc-mutating helper, see mxWarnIfLocked's header comment
    let inp = mxSafe(() => node.getInput(inputName), null);
    let how = 'existing';
    if (!inp) {
        let defInput = null;
        const cat = mxElCat(node);
        for (const d of vecToArray(mxSafe(() => doc.getMatchingNodeDefs(cat), []))) {
            const cand = mxSafe(() => d.getInput(inputName), null)
                || mxSafe(() => d.getActiveInput(inputName), null);
            if (!cand) continue;
            if (!defInput) defInput = cand; // fallback: first found
            if (wantedType && mxElType(cand) === wantedType) { defInput = cand; break; }
        }
        inp = mxSafe(() => node.addInput(inputName), null);
        how = 'added-bare';
        if (inp && defInput) {
            const copied = mxSafe(() => { inp.copyContentFrom(defInput); return true; }, false);
            if (copied) {
                how = 'copied-from-nodedef';
                // The copy brings nodedef UI/doc metadata along, noisy in
                // exports. defaultgeomprop is worse: MaterialX's validator
                // rejects it outright on a node-instance input.
                for (const attr of ['uimin', 'uimax', 'uisoftmin', 'uisoftmax', 'uistep',
                    'uiname', 'uifolder', 'uiadvanced', 'doc', 'enum', 'enumvalues', 'defaultgeomprop']) {
                    mxRemoveAttr(inp, attr);
                }
            }
        }
    }
    // Enforce the caller's type UNCONDITIONALLY, a wrong-typed copy (see
    // above) must not survive; the caller knows the graph typing, the
    // copy only supplies defaults/metadata.
    if (inp && wantedType && mxElType(inp) !== wantedType) {
        mxSafe(() => {
            if (typeof inp.setType === 'function') inp.setType(wantedType);
            else inp.setAttribute('type', wantedType);
            return true;
        }, false);
        if (mxElType(inp) !== wantedType) {
            mxSetAttr(inp, 'type', wantedType);
        }
        // A copied default VALUE is malformed for the corrected type,
        // drop it; callers connect or re-value anyway.
        mxRemoveAttr(inp, 'value');
    }
    if (inp && wantedType && mxElType(inp) !== wantedType) {
        mtlxWarn('ensureTypedInput: "' + inputName + '" is "' + mxElType(inp) + '" (wanted "' + wantedType + '"), path=' + how);
    }
    return inp;
};
const readConstInputs = () => {
    return host.constInputs();
};
// MaterialX input names whose value multiplies compile time: a uniform
// thin-film thickness keeps the mx_fresnel_airy branch alive and a uniform
// selector keeps every arm of its if-chain alive, in every closure context.
// Array subscripts (the extract family's `index`) are handled by usage
// instead, see selectDynamicIndexUniforms below.
const CONST_INPUT_NAMES = ['thin_film_thickness', 'thin_film_ior', 'thin_film_IOR', 'thinfilm_thickness', 'thinfilm_ior',
    'distribution', 'scatter_mode', 'retroreflective', 'energy_compensation', 'mode'];
// Names the Scene's thin-wall / light-transport patches and uniform builders
// match on by declaration or function signature; never rewrite these.
const CONST_INPUT_DENY = new Set(['thin_walled', 'geometry_thin_walled', 'transmission_weight',
    'transmission_color', 'transmission_depth', 'geometry_opacity']);
const CONST_INPUT_GLSL_TYPES = { float: 'float', integer: 'int', boolean: 'bool' };
// The standalone displacement program takes these on top: unifiednoise3d
// evaluates perlin, cellnoise, worley AND fractal and then switches on
// `type`, and `style` picks the worley distance metric. Displacement-only,
// since nothing edits a displacement input live (a change regenerates).
// `octaves` is deliberately absent: folding the fractal loop bound unrolls
// it and measured 5 to 12 percent SLOWER to compile.
const DISPLACEMENT_CONST_INPUT_NAMES = CONST_INPUT_NAMES.concat(['type', 'style', 'clampoutput']);
const readDisplacementConstInputs = () => {
    return host.displacementConstInputs();
};

// Deterministic GLSL literal for one introspected default; floats always
// carry a decimal point (or an exponent). Returns null when unusable.
const constInputLiteral = (type, data) => {
    if (type === 'boolean') return data ? 'true' : 'false';
    const n = Number(data);
    if (!Number.isFinite(n)) return null;
    if (type === 'integer') return String(n | 0);
    const s = String(n);
    return /[.eE]/.test(s) ? s : s + '.0';
};

// Which targeted input an introspected uniform is, or null. Prefers the
// MaterialX path's last segment; the flattened uniform name is the fallback.
const constInputKey = (u, names = CONST_INPUT_NAMES) => {
    const name = String((u && u.name) || '');
    if (!name || name.indexOf('u_') === 0) return null; // engine/private uniform
    const seg = u.path ? String(u.path).split('/').pop() : '';
    if (seg && names.indexOf(seg) >= 0) return seg;
    for (const n of names) {
        if (name === n || name.endsWith('_' + n)) return n;
    }
    return null;
};

// Everything a usage scan must not see: line and block comments, the
// preprocessor preamble, and every uniform declaration (a declaration is
// not a use, and `uniform int foo[4];` is an array, not a subscript).
const stripGlslForUsage = (src) => String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/^[ \t]*#[^\n]*/gm, ' ')
    .replace(/^[ \t]*uniform\b[^;]*;/gm, ' ');

const USAGE_IDENT_RE = /[A-Za-z_]\w*/g;
const addIdents = (text, out) => {
    let m;
    USAGE_IDENT_RE.lastIndex = 0;
    while ((m = USAGE_IDENT_RE.exec(text))) out.add(m[0]);
};
// Both operand sides of every comparison in a condition region.
const addComparisonIdents = (text, out) => {
    let m;
    const left = /([A-Za-z_]\w*)[ \t]*(?:==|!=|<=|>=|<|>)/g;
    while ((m = left.exec(text))) out.add(m[1]);
    const right = /(?:==|!=|<=|>=|<|>)[ \t]*([A-Za-z_]\w*)/g;
    while ((m = right.exec(text))) out.add(m[1]);
};
// Balanced span starting at the opening bracket at `open`; returns the
// inner text, or null when the source is unbalanced.
const balancedSpan = (src, open, openCh, closeCh) => {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === openCh) depth++;
        else if (c === closeCh) { depth--; if (depth === 0) return src.slice(open + 1, i); }
    }
    return null;
};
// Walks left from a ternary `?` to the start of its condition, stopping at
// the first unbalanced opener or statement separator at depth zero.
const ternaryCondition = (src, qm) => {
    let depth = 0;
    let i = qm - 1;
    for (; i >= 0; i--) {
        const c = src[i];
        if (c === ')' || c === ']') depth++;
        else if (c === '(' || c === '[') { if (depth === 0) break; depth--; }
        else if (depth === 0 && (c === ';' || c === '{' || c === '}' || c === ',' || c === ':' || c === '?')) break;
        else if (depth === 0 && c === '=' && src[i - 1] !== '=' && src[i - 1] !== '!'
            && src[i - 1] !== '<' && src[i - 1] !== '>' && src[i + 1] !== '=') break;
    }
    return src.slice(i + 1, qm);
};

// Usage rule for integer uniforms: an int whose identifier reaches an array
// subscript, a switch operand or a comparison in an if/ternary condition is
// what makes ANGLE emit a dyn_index_* helper or keep both arms alive, so it
// is folded to its default. Plain arithmetic keeps it a uniform.
const selectDynamicIndexUniforms = (vs, fs, introspected) => {
    const picked = new Set();
    const candidates = new Set();
    for (const u of (introspected || [])) {
        const name = String((u && u.name) || '');
        if (!name || name.indexOf('u_') === 0) continue; // engine/private uniform
        if (u.type !== 'integer' || CONST_INPUT_DENY.has(name)) continue;
        candidates.add(name);
    }
    if (!candidates.size) return picked;
    const used = new Set();
    for (const raw of [vs, fs]) {
        const src = stripGlslForUsage(raw);
        for (let i = 0; i < src.length; i++) {
            if (src[i] === '[') {
                const inner = balancedSpan(src, i, '[', ']');
                if (inner != null) addIdents(inner, used);
            } else if (src[i] === '?') {
                addComparisonIdents(ternaryCondition(src, i), used);
            }
        }
        let m;
        const switchRe = /\bswitch[ \t\n]*\(/g;
        while ((m = switchRe.exec(src))) {
            const inner = balancedSpan(src, switchRe.lastIndex - 1, '(', ')');
            if (inner != null) addIdents(inner, used);
        }
        const ifRe = /\bif[ \t\n]*\(/g;
        while ((m = ifRe.exec(src))) {
            const inner = balancedSpan(src, ifRe.lastIndex - 1, '(', ')');
            if (inner != null) addComparisonIdents(inner, used);
        }
    }
    for (const name of candidates) if (used.has(name)) picked.add(name);
    return picked;
};

// Rewrites `uniform T name;` into `const T name = <literal>;` for the
// targeted inputs, so the driver can fold their branches away. Only a
// scalar float/int/bool with exactly one declaration is touched; everything
// else is left alone. Returns the rewritten sources plus the pruned
// introspection list, so nothing tries to bind a uniform that is now gone.
const SELECTOR_CONST_INPUTS = new Set(['mode', 'type', 'style']);
const constifyInputUniforms = (vs, fs, introspected, names = CONST_INPUT_NAMES) => {
    const constInputs = [];
    const kept = [];
    const byUsage = selectDynamicIndexUniforms(vs, fs, introspected);
    let outVs = vs;
    let outFs = fs;
    for (const u of introspected) {
        const glslType = CONST_INPUT_GLSL_TYPES[u.type];
        const key = glslType ? constInputKey(u, names) : null;
        const usageHit = glslType ? byUsage.has(String(u.name)) : false;
        // `mode`, `type` and `style` are generic names: only take them when
        // the generator typed them as an enum selector (integer), never a
        // float or boolean input.
        if ((!key && !usageHit) || CONST_INPUT_DENY.has(String(u.name))
            || (key && !usageHit && SELECTOR_CONST_INPUTS.has(key) && u.type !== 'integer')) { kept.push(u); continue; }
        const literal = u.data == null ? null : constInputLiteral(u.type, u.data);
        if (literal == null) { kept.push(u); continue; }
        const escaped = String(u.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const declRe = new RegExp('(^|\\n)([ \\t]*)uniform[ \\t]+(?:(?:low|medium|high)p[ \\t]+)?'
            + glslType + '[ \\t]+' + escaped + '[ \\t]*;', 'g');
        const hits = (outVs.match(declRe) || []).length + (outFs.match(declRe) || []).length;
        if (hits !== 1) { kept.push(u); continue; }
        const replacement = '$1$2const ' + glslType + ' ' + u.name + ' = ' + literal + ';';
        outVs = outVs.replace(declRe, replacement);
        outFs = outFs.replace(declRe, replacement);
        constInputs.push({ name: u.name, path: u.path || null, value: u.data });
    }
    return { vs: outVs, fs: outFs, introspected: kept, constInputs };
};

// Sweep run before every writeToXmlString call, fixing two attributes
// MaterialX's validator rejects: a leftover `value` on a connected
// input, and `defaultgeomprop` on a node-instance input. Depth-capped walk.
const stripValuesFromConnectedInputs = (doc, maxDepth) => {
    mxWarnIfLocked('stripValuesFromConnectedInputs'); // exported doc-mutating helper, see mxWarnIfLocked's header comment
    const cap = (typeof maxDepth === 'number') ? maxDepth : 10;
    let stripped = 0;
    const walk = (el, depth) => {
        if (!el || depth > cap) return;
        const children = vecToArray(mxSafe(() => el.getChildren(), []));
        for (const child of children) {
            if (mxElCat(child) === 'input') {
                const connected = mxElAttr(child, 'nodename')
                    || mxElAttr(child, 'nodegraph')
                    || mxElAttr(child, 'interfacename');
                // Presence, not truthiness: an empty value="" on a
                // connected input is just as invalid as a non-empty one;
                // mxElAttr's '' fallback can't tell absent from present-but-empty.
                if (connected && mxElHasAttr(child, 'value')) {
                    const removed = mxRemoveAttr(child, 'value');
                    if (removed) stripped++;
                }
                // `el` (the loop's parent, already in scope) is this
                // input's parent element, reused here instead of a
                // second getParent() round trip.
                const parentCat = mxElCat(el);
                if (parentCat !== 'nodegraph' && parentCat !== 'nodedef'
                    && mxElHasAttr(child, 'defaultgeomprop')) {
                    const removed = mxRemoveAttr(child, 'defaultgeomprop');
                    if (removed) stripped++;
                }
            }
            walk(child, depth + 1);
        }
    };
    walk(doc, 0);
    return stripped;
};

// MaterialX 1.39 colorspace names an author may still write from older
// docs or other DCCs; not-a-color aliases map to null and are removed
// (the element then inherits the document colorspace, i.e. no conversion).
const COLORSPACE_ALIASES = {
    srgb_tx: 'srgb_texture',
    sRGB: 'srgb_texture',
    srgb: 'srgb_texture',
    Raw: null,
    raw: null,
    none: null,
};

// Depth-capped walk (stripValuesFromConnectedInputs idiom) rewriting any
// non-1.39 `colorspace` attribute in place, document root included.
// Returns { restore, rewrites }; caller MUST call restore() in a finally
// so the authored document never actually changes.
const applyColorspaceAliases = (doc, maxDepth) => {
    mxWarnIfLocked('applyColorspaceAliases'); // exported doc-mutating helper, see mxWarnIfLocked's header comment
    const cap = (typeof maxDepth === 'number') ? maxDepth : 10;
    const rewrites = new Map();
    const restores = [];
    const visit = (el, depth) => {
        if (!el || depth > cap) return;
        if (mxElHasAttr(el, 'colorspace')) {
            const cs = mxElAttr(el, 'colorspace');
            if (Object.prototype.hasOwnProperty.call(COLORSPACE_ALIASES, cs)) {
                const to = COLORSPACE_ALIASES[cs];
                const ok = to ? mxSetAttr(el, 'colorspace', to) : mxRemoveAttr(el, 'colorspace');
                if (ok) {
                    restores.push(() => mxSetAttr(el, 'colorspace', cs));
                    const key = cs + ' -> ' + (to || '(removed)');
                    rewrites.set(key, (rewrites.get(key) || 0) + 1);
                }
            }
        }
        const children = vecToArray(mxSafe(() => el.getChildren(), []));
        for (const child of children) visit(child, depth + 1);
    };
    visit(doc, 0);
    const restore = () => { for (let i = restores.length - 1; i >= 0; i--) restores[i](); };
    return { restore, rewrites };
};

// cmlib nodes that convert an encoded texture to the lin_rec709 working
// space. Only spaces cmlib can actually transform appear here; anything
// else is reported rather than silently ignored.
const COLORSPACE_TO_WORKING_NODE = {
    srgb_texture: 'srgb_texture_to_lin_rec709',
    g22_rec709: 'g22_rec709_to_lin_rec709',
    g18_rec709: 'g18_rec709_to_lin_rec709',
    acescg: 'acescg_to_lin_rec709',
    lin_ap1: 'lin_ap1_to_lin_rec709',
    g22_ap1: 'g22_ap1_to_lin_rec709',
    adobergb: 'adobergb_to_lin_rec709',
    lin_adobergb: 'lin_adobergb_to_lin_rec709',
    srgb_displayp3: 'srgb_displayp3_to_lin_rec709',
    lin_displayp3: 'lin_displayp3_to_lin_rec709',
    rec709_display: 'rec709_display_to_lin_rec709',
};

// Inserts the colorspace transform MaterialX's own color management system
// would have inserted, because this WASM build does not expose one: neither
// mx.DefaultColorManagementSystem nor generator.setColorManagementSystem is
// bound to JS, so a `colorspace` attribute on a filename input generates
// NOTHING and every sRGB texture is sampled as if it were already linear
// (measurably too bright and washed out). Verified by generating ESSL for a
// tagged image and finding zero conversion nodes in the output.
//
// The rewrite is the CMS's own: put a cmlib conversion node between the
// image and its consumers, and drop the attribute so a future build that
// does bind a CMS cannot apply it twice. Runs on the LIVE document, so the
// caller MUST call restore() in a finally.
const applyColorspaceTransforms = (doc, maxDepth) => {
    mxWarnIfLocked('applyColorspaceTransforms'); // exported doc-mutating helper, see mxWarnIfLocked's header comment
    const cap = (typeof maxDepth === 'number') ? maxDepth : 10;
    const restores = [];
    const converted = new Map();
    const unsupported = new Set();
    // cmlib converts INTO lin_rec709 only. A document working in another
    // space would need the inverse leg too, so leave it alone and say so.
    const docSpace = mxElAttr(doc, 'colorspace');
    if (docSpace && docSpace !== 'lin_rec709') {
        return { restore: () => {}, converted, unsupported: new Set(['(document works in "' + docSpace + '", not lin_rec709)']) };
    }
    let serial = 0;
    const visit = (parent, depth) => {
        if (!parent || depth > cap) return;
        const children = vecToArray(mxSafe(() => parent.getChildren(), []));
        // Snapshot the child list first: the loop adds nodes to this parent.
        const nodes = children.filter((c) => mxSafe(() => typeof c.getInput === 'function' && typeof c.getCategory === 'function', false));
        for (const node of nodes) {
            const fileInput = mxSafe(() => node.getInput('file'), null);
            if (!fileInput || !mxElHasAttr(fileInput, 'colorspace')) { visit(node, depth + 1); continue; }
            const cs = mxElAttr(fileInput, 'colorspace');
            const type = String(mxSafe(() => node.getType(), ''));
            if (type !== 'color3' && type !== 'color4') continue; // float/vector images carry data, never color
            const category = COLORSPACE_TO_WORKING_NODE[cs];
            if (!category) { unsupported.add(cs); continue; }
            const nodeName = mxSafe(() => node.getName(), null);
            if (!nodeName) continue;
            const cmName = '__mtlx_cm_' + (serial++) + '_' + nodeName;
            const cm = mxSafe(() => parent.addNode(category, cmName, type), null);
            if (!cm) { unsupported.add(cs); continue; }
            const cmIn = mxSafe(() => cm.addInput('in', type), null);
            if (!cmIn || !mxSetAttr(cmIn, 'nodename', nodeName)) {
                mxSafe(() => parent.removeChild(cmName), null);
                unsupported.add(cs);
                continue;
            }
            // Every consumer in this scope now reads the converted value.
            // Done by attribute so multi-output and nodegraph references
            // keep whatever `output` they already named. A nodegraph's own
            // <output> element carries nodename directly rather than through
            // an input, so redirect the element itself as well.
            const redirect = (el) => {
                if (mxElAttr(el, 'nodename') !== nodeName) return;
                if (mxSetAttr(el, 'nodename', cmName)) {
                    restores.push(() => mxSetAttr(el, 'nodename', nodeName));
                }
            };
            for (const sibling of children) {
                if (sibling === node || sibling === cm) continue;
                redirect(sibling);
                for (const input of vecToArray(mxSafe(() => sibling.getInputs(), []))) redirect(input);
            }
            mxRemoveAttr(fileInput, 'colorspace');
            restores.push(() => mxSetAttr(fileInput, 'colorspace', cs));
            restores.push(() => mxSafe(() => parent.removeChild(cmName), null));
            converted.set(cs, (converted.get(cs) || 0) + 1);
            visit(node, depth + 1);
        }
    };
    visit(doc, 0);
    const restore = () => { for (let i = restores.length - 1; i >= 0; i--) restores[i](); };
    return { restore, converted, unsupported };
};

// Scene "Material working space" setting: when the authored network works in
// ACEScg (Houdini/Karma's default scene-linear space) rather than our own
// linear Rec.709, every untagged colour NUMBER in the network reads too
// saturated once compared byte-for-byte with Karma. This inserts the same
// cmlib conversion applyColorspaceTransforms inserts for tagged textures,
// but for two things that mechanism never touches: literal color3/color4
// input VALUES (constants, interface defaults, USD overrides already baked
// into a value attribute) and colour geomprops (displayColor and friends),
// whose primvar stream carries no colorspace metadata at all.
//
// Only ever called for the Scene, and only when the setting is "acescg";
// the Viewer/Compare/Builder/Graph previews and every embed never pass the
// option that enables this. Runs on the LIVE document, so the caller MUST
// call restore() in a finally.
const applyMaterialWorkspaceTransforms = (doc, maxDepth) => {
    mxWarnIfLocked('applyMaterialWorkspaceTransforms'); // exported doc-mutating helper, see mxWarnIfLocked's header comment
    const cap = (typeof maxDepth === 'number') ? maxDepth : 10;
    const restores = [];
    let converted = 0;
    // Same working-space guard as applyColorspaceTransforms: cmlib's
    // acescg_to_lin_rec709 node converts INTO lin_rec709 only.
    const docSpace = mxElAttr(doc, 'colorspace');
    if (docSpace && docSpace !== 'lin_rec709') {
        return { restore: () => {}, converted: 0, unsupported: new Set(['(document works in "' + docSpace + '", not lin_rec709)']) };
    }
    let serial = 0;
    // Wraps `nodeName`'s output (already a color3/color4 node in `parent`)
    // in an acescg_to_lin_rec709 node and redirects every other reference
    // to it, the same redirect-by-attribute technique applyColorspaceTransforms
    // uses for a converted image. Returns true on success.
    const wrapNodeOutput = (parent, children, node, nodeName, type) => {
        const cmName = '__mtlx_ws_' + (serial++) + '_' + nodeName;
        const cm = mxSafe(() => parent.addNode('acescg_to_lin_rec709', cmName, type), null);
        if (!cm) return false;
        const cmIn = mxSafe(() => cm.addInput('in', type), null);
        if (!cmIn || !mxSetAttr(cmIn, 'nodename', nodeName)) {
            mxSafe(() => parent.removeChild(cmName), null);
            return false;
        }
        const redirect = (el) => {
            if (mxElAttr(el, 'nodename') !== nodeName) return;
            if (mxSetAttr(el, 'nodename', cmName)) restores.push(() => mxSetAttr(el, 'nodename', nodeName));
        };
        for (const sibling of children) {
            if (sibling === node || sibling === cm) continue;
            redirect(sibling);
            for (const input of vecToArray(mxSafe(() => sibling.getInputs(), []))) redirect(input);
        }
        restores.push(() => mxSafe(() => parent.removeChild(cmName), null));
        return true;
    };
    const visit = (parent, depth) => {
        if (!parent || depth > cap) return;
        const children = vecToArray(mxSafe(() => parent.getChildren(), []));
        const nodes = children.filter((c) => mxSafe(() => typeof c.getInputs === 'function' && typeof c.getCategory === 'function', false));
        for (const node of nodes) {
            const category = mxSafe(() => node.getCategory(), '');
            const nodeType = mxSafe(() => String(node.getType()), '');
            // geompropvalue's OUTPUT carries the primvar's colour (displayColor
            // and friends): no attribute on it is ever a "value", so it's
            // converted the same way a tagged image's output is, not as a
            // literal input below.
            if (category === 'geompropvalue' && (nodeType === 'color3' || nodeType === 'color4') && !mxElHasAttr(node, 'colorspace')) {
                const nodeName = mxSafe(() => node.getName(), null);
                if (nodeName && wrapNodeOutput(parent, children, node, nodeName, nodeType)) converted += 1;
            }
            const inputs = vecToArray(mxSafe(() => node.getInputs(), []));
            for (const inp of inputs) {
                const type = mxSafe(() => String(inp.getType()), '');
                if (type !== 'color3' && type !== 'color4') continue; // vector3 and float values carry data, never colour
                if (mxElHasAttr(inp, 'colorspace')) continue; // explicit tag: caller already knows its space
                if (mxElHasAttr(inp, 'nodename') || mxElHasAttr(inp, 'nodegraph') || mxElHasAttr(inp, 'interfacename') || mxElHasAttr(inp, 'output')) continue; // a connection, not a literal value
                const value = mxSafe(() => inp.getValueString(), null);
                if (value == null || value === '') continue;
                const inputName = mxSafe(() => inp.getName(), null);
                const nodeName = mxSafe(() => node.getName(), null);
                if (!inputName || !nodeName) continue;
                const cmName = '__mtlx_ws_' + (serial++) + '_' + nodeName + '_' + inputName;
                const cm = mxSafe(() => parent.addNode('acescg_to_lin_rec709', cmName, type), null);
                if (!cm) continue;
                const cmIn = mxSafe(() => cm.addInput('in', type), null);
                if (!cmIn || !mxSetAttr(cmIn, 'value', value)) { mxSafe(() => parent.removeChild(cmName), null); continue; }
                if (!mxSetAttr(inp, 'nodename', cmName)) { mxSafe(() => parent.removeChild(cmName), null); continue; }
                mxRemoveAttr(inp, 'value');
                restores.push(() => { mxRemoveAttr(inp, 'nodename'); mxSetAttr(inp, 'value', value); });
                restores.push(() => mxSafe(() => parent.removeChild(cmName), null));
                converted += 1;
            }
            visit(node, depth + 1); // nested nodegraphs/compound instances
        }
    };
    visit(doc, 0);
    const restore = () => { for (let i = restores.length - 1; i >= 0; i--) restores[i](); };
    return { restore, converted };
};

// ------------------------------------------------------------------
// Drag & drop ingestion, shared by the graph editor and material viewer views.
// ------------------------------------------------------------------

// Normalize a path for matching: forward slashes, lowercase, no
// leading ./ or /.
const normPath = (p) => String(p || '')
    .replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();

// Join a base directory and a reference into one path, resolving '.' and
// '..' segments. Backslashes normalize and a leading './' or '/' strips,
// but case is preserved (unlike normPath, which lowercases for fuzzy
// matching). Moved from the Scene's sceneJoinPath for the exact resolvers.
const joinRefPath = (fromDir, ref) => {
    const casedNorm = (v) => String(v || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
    return casedNorm((fromDir ? fromDir + '/' : '') + String(ref || ''))
        .split('/').reduce((out, part) => {
            if (!part || part === '.') return out;
            if (part === '..') { out.pop(); return out; }
            out.push(part); return out;
        }, []).join('/');
};

// Find a dropped file for a path referenced inside the document. Fuzzy
// (default): exact normalized match -> unique suffix match -> unique
// basename match. Exact ({exact:true, fromDir}): hasOwnProperty lookup on
// joinRefPath(fromDir, ref) only, no suffix or basename fallback (a
// composed scene can have duplicate basenames, so a miss must stay a miss).
const findFileForRef = (fileMap, ref, opts) => {
    if (opts && opts.exact) {
        const want = joinRefPath(opts.fromDir, ref);
        if (!want || !Object.prototype.hasOwnProperty.call(fileMap, want)) return null;
        return { key: want, how: 'exact' };
    }
    const want = normPath(ref);
    if (!want) return null;
    const keys = Object.keys(fileMap);
    const norm = {};
    for (const k of keys) norm[normPath(k)] = k;
    if (norm[want]) return { key: norm[want], how: 'exact' };
    const suffix = keys.filter((k) => normPath(k).endsWith('/' + want) || normPath(k) === want);
    if (suffix.length === 1) return { key: suffix[0], how: 'suffix' };
    const base = want.split('/').pop();
    const byBase = keys.filter((k) => normPath(k).split('/').pop() === base);
    if (byBase.length === 1) return { key: byBase[0], how: 'basename' };
    return null;
};

// A <UDIM> reference names a tile set: every key whose path matches the
// reference with the token replaced by four digits, each hit carrying the
// concrete tile ref. Plain references yield the single findFileForRef hit.
// Exact ({exact:true}): literal prefix/suffix split around <UDIM>, 4 case-
// sensitive digits, code >= 1001, no suffix/basename retry. Both modes
// return { key, how, ref, code, u, v } sorted by code.
const findFilesForRef = (fileMap, ref, opts) => {
    if (opts && opts.exact) {
        const raw = String(ref || '');
        const splitParts = raw.split(/<UDIM>/i);
        if (splitParts.length !== 2) return [];
        const prefix = splitParts[0], suffix = splitParts[1];
        const hits = [];
        for (const key of Object.keys(fileMap)) {
            if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue;
            const end = suffix.length ? key.length - suffix.length : key.length;
            const codeText = key.slice(prefix.length, end);
            if (!/^\d{4}$/.test(codeText)) continue;
            const code = Number(codeText);
            if (code < 1001) continue;
            const offset = code - 1001;
            hits.push({ key, how: 'exact', ref: raw.replace(/<UDIM>/i, codeText), code, u: offset % 10, v: Math.floor(offset / 10) });
        }
        return hits.sort((a, b) => a.code - b.code);
    }
    const raw = String(ref || '');
    if (!/<UDIM>/i.test(raw)) {
        const hit = findFileForRef(fileMap, raw);
        return hit ? [{ key: hit.key, how: hit.how, ref: raw }] : [];
    }
    const want = normPath(raw);
    const escaped = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/<udim>/g, '(\\d{4})');
    const tries = [
        { how: 'exact', re: new RegExp('^' + escaped + '$') },
        { how: 'suffix', re: new RegExp('(^|/)' + escaped + '$') },
        { how: 'basename', re: new RegExp('(^|/)' + escaped.split('/').pop() + '$') },
    ];
    for (const { how, re } of tries) {
        const hits = [];
        for (const key of Object.keys(fileMap)) {
            const m = re.exec(normPath(key));
            if (!m) continue;
            const codeText = m[m.length - 1];
            const code = Number(codeText);
            const offset = code - 1001;
            hits.push({ key, how, ref: raw.replace(/<UDIM>/gi, codeText), code, u: offset % 10, v: Math.floor(offset / 10) });
        }
        if (hits.length) return hits.sort((a, b) => a.code - b.code);
    }
    return [];
};

// Given a resolved file-map hit, prefer a sibling "<stem>.ktx2" in the same
// directory when one exists (per-UDIM tile too, since the tile code lives in
// the stem: "wall.1001.png" -> "wall.1001.ktx2"), and never touch the
// original file or a .mtlx document. Returns the (possibly substituted) hit.
const preferKtx2Sibling = (fileMap, hit) => {
    if (!hit || /\.ktx2$/i.test(hit.key) || /\.mtlx$/i.test(hit.key)) return hit;
    const dot = hit.key.lastIndexOf('.');
    if (dot < 0) return hit;
    const ktx2Key = hit.key.slice(0, dot) + '.ktx2';
    if (Object.prototype.hasOwnProperty.call(fileMap, ktx2Key)) {
        return { key: ktx2Key, how: hit.how, substituted: true };
    }
    return hit;
};

// Parses MaterialX XML keeping comments as elements in document order, so a
// write puts them back where they were; builds without XmlReadOptions fall back.
const readMtlxXml = async (mx, doc, xml) => {
    let opts = null;
    try {
        if (typeof mx.XmlReadOptions === 'function') { opts = new mx.XmlReadOptions(); opts.readComments = true; }
    } catch (e) { opts = null; }
    return opts ? mx.readFromXmlString(doc, xml, '', opts) : mx.readFromXmlString(doc, xml);
};

// Comments outside <materialx> never become elements, so they are carried as
// strings. The site's own attribution is dropped here and re-added on export.
const isExportAttribution = (comment) => /^<!--\s*Exported by MaterialX Playground/.test(String(comment || ''));
const splitXmlEnvelope = (text) => {
    const src = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    const comments = (s) => (s.match(/<!--[\s\S]*?-->/g) || []).filter((c) => !isExportAttribution(c));
    const open = src.search(/<materialx\b/);
    const close = src.lastIndexOf('</materialx>');
    return {
        prolog: open > 0 ? comments(src.slice(0, open).replace(/<\?xml[^>]*\?>/, '')) : [],
        trailer: close >= 0 ? comments(src.slice(close + '</materialx>'.length)) : [],
    };
};
const withXmlEnvelope = (xml, envelope) => {
    let text = xml == null ? '' : String(xml);
    const prolog = (envelope && envelope.prolog) || [];
    const trailer = (envelope && envelope.trailer) || [];
    if (prolog.length) {
        const m = /^\s*<\?xml[^>]*\?>\n?/.exec(text);
        const at = m ? m[0].length : 0;
        text = text.slice(0, at) + (m && !m[0].endsWith('\n') ? '\n' : '') + prolog.join('\n') + '\n' + text.slice(at);
    }
    const close = text.lastIndexOf('</materialx>');
    if (trailer.length && close >= 0) {
        const end = close + '</materialx>'.length;
        text = text.slice(0, end) + '\n' + trailer.join('\n') + text.slice(end);
    }
    return text;
};

// MaterialX's XML writer escapes only &, " and line breaks inside attribute
// values: a literal <, > or tab goes out as-is. < and > are not well-formed
// XML (and > ends a tag early in xmlTokenize below), and a tab reads back
// as a space, so attributes carrying them (a ShadingLanguageX node's
// slxsource code, say) are re-escaped here. Comments are left untouched.
const escapeXmlAttrSpecials = (xml) => {
    const text = xml == null ? '' : String(xml);
    if (!/="[^"]*[<>\t]/.test(text)) return text;
    return text.replace(/<!--[\s\S]*?-->|="[^"]*"/g, (m) => (m[0] === '<' || !/[<>\t]/.test(m)) ? m
        : '="' + m.slice(2, -1).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\t/g, '&#9;') + '"');
};

// Source formatting survives a save: tags and comments are matched between the
// loaded text and the writer's output, unchanged ones keep their original text
// (wrapping, blank lines, quoting); only edited or new elements use the writer's.
const XML_ENTITIES = { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' };
const xmlDecode = (s) => s.replace(/&(quot|apos|lt|gt|amp|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
    if (e[0] !== '#') return XML_ENTITIES[e.toLowerCase()];
    return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});
// Element name, attributes with their value offsets, and where new attributes go.
const xmlTagParts = (raw) => {
    const m = /^<([^\s/>!?]+)/.exec(raw);
    if (!m) return null;
    const attrs = new Map();
    const attrRe = /(\s*)([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    attrRe.lastIndex = m[0].length;
    let a, lastEnd = m[0].length;
    while ((a = attrRe.exec(raw))) {
        const quoted = a[3] != null ? a[3] : a[4];
        const valueEnd = a.index + a[0].length - 1;
        attrs.set(a[2], {
            value: xmlDecode(quoted), quote: a[3] != null ? '"' : "'",
            start: a.index, end: a.index + a[0].length, valueStart: valueEnd - quoted.length, valueEnd,
        });
        lastEnd = a.index + a[0].length;
    }
    return { tag: m[1], attrs, insertAt: lastEnd, selfClosing: /\/\s*>$/.test(raw) };
};
const xmlTokenKey = (raw) => {
    if (raw.startsWith('<!--')) return '<!--' + raw.slice(4, -3).replace(/\s+/g, ' ').trim() + '-->';
    // Any XML declaration matches any other: quoting and encoding are layout.
    if (raw.startsWith('<?xml')) return '<?xml?>';
    if (raw.startsWith('<?') || raw.startsWith('</')) return raw.replace(/\s+/g, '');
    const parts = xmlTagParts(raw);
    if (!parts) return raw.replace(/\s+/g, ' ');
    let key = '<' + parts.tag;
    parts.attrs.forEach((v, n) => { key += ' ' + n + '="' + v.value + '"'; });
    return key + (parts.selfClosing ? '/>' : '>');
};
const xmlTokenize = (text) => {
    const tokens = [];
    const re = /<!--[\s\S]*?-->|<[^>]*>|[^<]+/g;
    let m, gapStart = 0;
    while ((m = re.exec(text))) {
        if (m[0][0] !== '<' && !m[0].trim()) continue;
        tokens.push({ key: m[0][0] === '<' ? xmlTokenKey(m[0]) : m[0].trim(), raw: m[0], gap: text.slice(gapStart, m.index) });
        gapStart = m.index + m[0].length;
    }
    return { tokens, tail: text.slice(gapStart) };
};
// Rewrites a source tag to the output tag's attributes without touching its
// layout; null when they are different elements (tag, name or closing form).
const xmlPatchTag = (srcRaw, outRaw) => {
    const s = xmlTagParts(srcRaw), o = xmlTagParts(outRaw);
    if (!s || !o || s.tag !== o.tag || s.selfClosing !== o.selfClosing) return null;
    const sName = s.attrs.get('name'), oName = o.attrs.get('name');
    if ((sName && sName.value) !== (oName && oName.value)) return null;
    // Values arrive decoded (xmlTagParts), so line breaks and tabs must be
    // re-encoded too: a literal one reads back as a space, which would flatten
    // multi-line values such as a ShadingLanguageX node's slxsource code.
    const esc = (v, q) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;')
        .replace(q === '"' ? /"/g : /'/g, q === '"' ? '&quot;' : '&apos;');
    const edits = [];
    s.attrs.forEach((sa, n) => {
        const oa = o.attrs.get(n);
        if (!oa) edits.push({ start: sa.start, end: sa.end, text: '' });
        else if (oa.value !== sa.value) edits.push({ start: sa.valueStart, end: sa.valueEnd, text: esc(oa.value, sa.quote) });
    });
    let added = '';
    o.attrs.forEach((oa, n) => { if (!s.attrs.has(n)) added += ' ' + n + '="' + esc(oa.value, '"') + '"'; });
    if (added) edits.push({ start: s.insertAt, end: s.insertAt, text: added });
    edits.sort((x, y) => y.start - x.start);
    let text = srcRaw;
    for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);
    return text;
};
// Myers diff over token keys; returns source index per output index (-1 when
// inserted), or null when the edit distance exceeds maxD.
const xmlTokenMatches = (a, b, maxD) => {
    const n = a.length, m = b.length;
    const match = new Int32Array(m).fill(-1);
    let lo = 0;
    while (lo < n && lo < m && a[lo] === b[lo]) { match[lo] = lo; lo++; }
    let hiA = n, hiB = m;
    while (hiA > lo && hiB > lo && a[hiA - 1] === b[hiB - 1]) { hiA--; hiB--; match[hiB] = hiA; }
    const A = a.slice(lo, hiA), B = b.slice(lo, hiB), N = A.length, M = B.length;
    if (!N || !M) return match;
    const off = N + M + 1;
    const v = new Int32Array(2 * off + 2);
    const trace = [];
    let found = false;
    for (let d = 0; d <= Math.min(N + M, maxD) && !found; d++) {
        trace.push(v.slice(off - d, off + d + 1));
        for (let k = -d; k <= d; k += 2) {
            let x = (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) ? v[off + k + 1] : v[off + k - 1] + 1;
            let y = x - k;
            while (x < N && y < M && A[x] === B[y]) { x++; y++; }
            v[off + k] = x;
            if (x >= N && y >= M) { found = true; break; }
        }
    }
    if (!found) return null;
    let x = N, y = M;
    for (let d = trace.length - 1; d >= 0; d--) {
        const vd = trace[d];
        const k = x - y;
        if (d === 0) {
            while (x > 0 && y > 0) { match[lo + y - 1] = lo + x - 1; x--; y--; }
            break;
        }
        const at = (kk) => vd[kk + d];
        const prevK = (k === -d || (k !== d && at(k - 1) < at(k + 1))) ? k + 1 : k - 1;
        const prevX = at(prevK), prevY = prevX - prevK;
        while (x > prevX && y > prevY) { match[lo + y - 1] = lo + x - 1; x--; y--; }
        x = prevX; y = prevY;
    }
    return match;
};
const preserveSourceFormatting = (sourceText, writtenXml, { maxD = 3000, maxLength = 16 * 1024 * 1024 } = {}) => {
    const written = writtenXml == null ? '' : String(writtenXml);
    const source = sourceText == null ? '' : String(sourceText);
    if (!source || source.length > maxLength || written.length > maxLength) return written;
    const src = xmlTokenize(source);
    const out = xmlTokenize(written);
    const match = xmlTokenMatches(src.tokens.map((t) => t.key), out.tokens.map((t) => t.key), maxD);
    if (!match) return written;
    const crlf = /\r\n/.test(source);
    const nl = (s) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s);
    // Source tokens dropped by the diff, reusable as in-place edits of a
    // changed output tag between the same matched neighbours.
    const used = new Uint8Array(src.tokens.length);
    match.forEach((i) => { if (i >= 0) used[i] = 1; });
    let text = '';
    let prevSrc = -1;
    for (let j = 0; j < out.tokens.length; j++) {
        let i = match[j];
        if (i >= 0) {
            text += src.tokens[i].gap + src.tokens[i].raw;
            prevSrc = i;
            continue;
        }
        let nextSrc = src.tokens.length;
        for (let jj = j + 1; jj < out.tokens.length; jj++) if (match[jj] >= 0) { nextSrc = match[jj]; break; }
        let patched = null;
        for (let c = prevSrc + 1; c < nextSrc && patched == null; c++) {
            if (used[c] || src.tokens[c].raw[0] !== '<') continue;
            const p = xmlPatchTag(src.tokens[c].raw, out.tokens[j].raw);
            if (p != null) { patched = p; i = c; }
        }
        if (patched != null) {
            used[i] = 1;
            text += src.tokens[i].gap + patched;
            prevSrc = i;
        } else {
            text += nl(out.tokens[j].gap) + nl(out.tokens[j].raw);
        }
    }
    const last = out.tokens.length - 1;
    const lastMatchedToEnd = last >= 0 && match[last] === src.tokens.length - 1;
    return text + (lastMatchedToEnd ? src.tail : nl(out.tail));
};
// True for a real File (or a Blob with the same identity fields glued on),
// where name+size+lastModified already uniquely identify the bytes.
const hasBlobIdentity = (blob) => !!(blob && blob.name != null && blob.size != null && blob.lastModified != null);
const textureCacheKey = (blob, fallback) => {
    if (hasBlobIdentity(blob)) {
        return blob.name + '|' + blob.size + '|' + blob.lastModified;
    }
    return fallback; // e.g. the fileMap key, when identity fields are missing
};
// Cheap FNV-1a over a Uint8Array, used only to fingerprint sampled texture
// bytes below; not cryptographic, just enough to tell "changed" from "same".
// (A same-named string variant exists further down for displacement keys;
// kept separate since bytes vs. char codes are different inputs.)
const fnv1aBytesHex = (bytes) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
};
// Nameless Blobs (e.g. the VS Code webview's fetched texture Blobs carry no
// File identity) hash to the same key across a file replaced on disk unless
// their bytes are sampled. Hashes a handful of small chunks (start/middle/
// end) instead of the whole buffer, so even multi-hundred-MB textures are
// cheap to fingerprint, and memoizes per Blob object since the same Blob is
// often looked up for several sampler uniforms in one bindDroppedTextures call.
const BLOB_FINGERPRINT = new WeakMap();
const fingerprintBlob = (blob) => {
    const size = blob.size || 0;
    const chunk = 4096;
    const offsets = size <= chunk * 3 ? [0] : [0, Math.floor(size / 2), Math.max(0, size - chunk)];
    return Promise.all(offsets.map((off) => blob.slice(off, off + chunk).arrayBuffer()))
        .then((buffers) => buffers.map((b) => fnv1aBytesHex(new Uint8Array(b))).join('-'))
        .catch(() => 'unhashed');
};
// Async counterpart of textureCacheKey: resolves immediately (still a real
// string, wrapped in a Promise) for identity-bearing blobs, and to a
// size+content-fingerprint key otherwise, so a texture replaced on disk with
// the same path gets a different key once its bytes actually differ.
const textureCacheKeyAsync = (blob, fallback) => {
    if (hasBlobIdentity(blob)) return Promise.resolve(textureCacheKey(blob, fallback));
    if (!blob || typeof blob.slice !== 'function' || typeof blob.arrayBuffer !== 'function') {
        return Promise.resolve(fallback);
    }
    let fp = BLOB_FINGERPRINT.get(blob);
    if (!fp) {
        fp = fingerprintBlob(blob).then((hash) => fallback + '|' + blob.size + '|' + hash);
        BLOB_FINGERPRINT.set(blob, fp);
    }
    return fp;
};
// MaterialX image nodes carry sampler address modes independently of the
// image file. Keep the authored spelling on uniform metadata so one source
// image can be bound with different wrapping by different nodes.
const normalizeSamplerAddressMode = (value) => {
    const mode = String(value == null ? '' : value).trim().toLowerCase();
    return mode === 'clamp' || mode === 'mirror' || mode === 'periodic' ? mode : 'periodic';
};
const readMxInputValue = (input) => {
    if (!input) return '';
    const attr = mxElAttr(input, 'value');
    if (attr != null && String(attr) !== '') return String(attr);
    return mxSafe(() => input.getValueString && input.getValueString(), '');
};
const collectImageSamplerModes = (doc) => {
    // Qualified paths prevent same-named image nodes in separate nodegraphs
    // from sharing sampler state. A leaf fallback is retained only when its
    // name is unique in the document.
    const modes = new Map();
    const leafModes = new Map();
    const leafCounts = new Map();
    if (!doc) return modes;
    const visit = (el, depth, parentPath) => {
        if (!el || depth > 32) return;
        const name = mxElName(el);
        const currentPath = name ? parentPath.concat(String(name)) : parentPath;
        if (mxElCat(el) === 'image') {
            if (name) {
                const u = mxSafe(() => el.getInput('uaddressmode'), null);
                const v = mxSafe(() => el.getInput('vaddressmode'), null);
                const samplerModes = {
                    u: normalizeSamplerAddressMode(readMxInputValue(u)),
                    v: normalizeSamplerAddressMode(readMxInputValue(v)),
                };
                modes.set(currentPath.join('/'), samplerModes);
                leafModes.set(String(name), samplerModes);
                leafCounts.set(String(name), (leafCounts.get(String(name)) || 0) + 1);
            }
        }
        let children = vecToArray(mxSafe(() => el.getChildren(), []));
        if (el === doc && !children.length) {
            children = children.concat(vecToArray(mxSafe(() => doc.getNodes && doc.getNodes(), [])));
            children = children.concat(vecToArray(mxSafe(() => doc.getNodeGraphs && doc.getNodeGraphs(), [])));
        }
        for (const child of children) visit(child, depth + 1, currentPath);
    };
    visit(doc, 0, []);
    const uniqueLeaves = new Map();
    for (const [name, samplerModes] of leafModes) {
        if (leafCounts.get(name) === 1) uniqueLeaves.set(name, samplerModes);
    }
    modes.uniqueLeaves = uniqueLeaves;
    return modes;
};const samplerCacheKey = (baseKey, samplerModes) => {
    const modes = samplerModes || { u: 'periodic', v: 'periodic' };
    return String(baseKey) + '|uaddressmode=' + normalizeSamplerAddressMode(modes.u)
        + '|vaddressmode=' + normalizeSamplerAddressMode(modes.v);
};

// Extracts a plain JS array from a real array or an embind vector-like
// value ({size(),get(i)} or {data()}). plainizeMxUniformData relies on
// this to detach heap-backed views before the mxExclusive lock releases.
const mxDataToPlainArray = (d) => {
    if (Array.isArray(d)) return d;
    if (d && typeof d.data === 'function') { try { return Array.from(d.data()); } catch (e) { /* not iterable */ } }
    if (d && typeof d.size === 'function') { const o = []; for (let i = 0; i < d.size(); i++) o.push(d.get(i)); return o; }
    return null;
};

// Enumerate a ShaderStage's uniforms via MaterialX introspection. `data`
// may be a LIVE heap-backed view for vector/matrix/color types, run it
// through plainizeMxUniformData before the mxExclusive lock releases.
const collectMxUniforms = (stage) => {
    mxWarnIfLocked('collectMxUniforms'); // exported doc-reading helper (per shader-gen, not per-frame), see mxWarnIfLocked's header comment
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
                // ties the uniform back to a node input, used by the
                // dynamic parameter UI.
                let path = null;
                try { path = (v.getPath && v.getPath()) || null; } catch (e) { /* absent */ }
                out.push({ name, type, data, path, block: entry.key });
            } catch (e) { /* skip unreadable entry */ }
        }
    }
    return out;
};

// Types whose collectMxUniforms `data` may be a live embind heap-backed
// view, needing mxDataToPlainArray to detach it. Scalars and
// filename/string values already arrive as plain JS, untouched.
const VECTOR_MX_TYPES = new Set(['vector2', 'vector3', 'vector4', 'color3', 'color4', 'matrix33', 'matrix44']);

// Converts ONE collectMxUniforms() entry's `data` to plain JS, must run
// before the mxExclusive lock (see the caution on collectMxUniforms
// above) releases. Returns a new entry object; never mutates the input.
const plainizeMxUniformData = (u) => {
    if (u.data == null || !VECTOR_MX_TYPES.has(u.type)) return u;
    return Object.assign({}, u, { data: mxDataToPlainArray(u.data) });
};
const annotateFilenameSamplerModes = (introspected, doc) => {
    const modes = collectImageSamplerModes(doc);
    if (!modes.size) return introspected;
    const uniqueLeaves = modes.uniqueLeaves || new Map();
    return introspected.map((u) => {
        if (!u || u.type !== 'filename') return u;
        const pathParts = u.path
            ? String(u.path).split(/[/\.:]/).filter(Boolean)
            : [];
        // Prefer the longest qualified suffix from the introspected path.
        // The leading document/material prefix can differ between bindings.
        for (let start = 0; start < pathParts.length; start += 1) {
            for (let end = pathParts.length; end > start; end -= 1) {
                const candidate = pathParts.slice(start, end).join('/');
                const samplerModes = modes.get(candidate);
                if (samplerModes) return Object.assign({}, u, { samplerModes });
            }
        }
        const leaf = u.name ? String(u.name).replace(/_file(?:_.*)?$/, '') : '';
        const samplerModes = uniqueLeaves.get(leaf);
        return samplerModes ? Object.assign({}, u, { samplerModes }) : u;
    });
};

// Resolves how to preview a node from its nodedefs: handles overloaded
// defs and MULTI-OUTPUT defs (picks the first viewable output). Returns
// { kind, outType, outputName, multiOutput }.
const COLOR_VIEWABLE = ['color3', 'color4', 'float', 'vector2', 'vector3', 'vector4'];


// MaterialX has no implicit type coercion; a mismatched connection compiles
// as far as GLSL and fails deep inside an opaque nodegraph call with a line
// number, not a name. Resolve one connected input's source type, following
// nodename, nodegraph and (one hop of) interfacename bindings.
const mxOutputTypeAndNode = (node, outputName) => {
    let outs = [];
    try { outs = vecToArray(node.getOutputs ? node.getOutputs() : null); } catch (e) { outs = []; }
    if (outs.length > 1 || mxElType(node) === 'multioutput') {
        const out = outputName
            ? (mxSafe(() => node.getOutput(outputName), null) || outs.find((o) => mxElName(o) === outputName))
            : outs[0];
        if (!out) return null;
        return { type: mxElType(out), producer: mxSafe(() => out.getConnectedNode(), null) };
    }
    return { type: mxElType(node), producer: node };
};

const mxResolveConnection = (input, doc) => {
    const graphName = mxElAttr(input, 'nodegraph');
    if (graphName) {
        const ng = mxSafe(() => doc.getNodeGraph(graphName), null);
        if (!ng) return null;
        const resolved = mxOutputTypeAndNode(ng, mxElAttr(input, 'output'));
        return resolved ? { type: resolved.type, sourceName: graphName, node: resolved.producer } : null;
    }
    const nodeName = mxElAttr(input, 'nodename');
    if (nodeName) {
        const node = mxSafe(() => input.getConnectedNode(), null);
        if (!node) return null;
        const resolved = mxOutputTypeAndNode(node, mxElAttr(input, 'output'));
        return resolved ? { type: resolved.type, sourceName: nodeName, node: resolved.producer } : null;
    }
    const interfaceName = mxElAttr(input, 'interfacename');
    if (interfaceName) {
        // The promoted graph-level input: one hop only, its own value is
        // the binding, not a further per-instance override to chase.
        const iface = mxSafe(() => input.getInterfaceInput(), null);
        if (iface && iface !== input) return mxResolveConnection(iface, doc);
    }
    return null;
};

// Depth-capped upstream walk from the renderable surface node, through every
// nodename/nodegraph/interfacename-connected input, comparing each input's
// declared type against its source's. Skips (never false-positives) when
// either side, or the connection itself, cannot be resolved: a missing node,
// an unreadable type, or a plain unconnected input with just a value.
const MTLX_TYPE_WALK_MAX_DEPTH = 32;
const findTypeMismatches = (renderable, mx) => {
    let doc = null;
    try { doc = renderable.getDocument(); } catch (e) { return null; }
    if (!doc) return null;
    const visited = new Set();
    let found = null;
    const walk = (node, depth) => {
        if (found || !node || depth > MTLX_TYPE_WALK_MAX_DEPTH) return;
        const nodeName = mxElName(node);
        const visitKey = nodeName + '|' + mxElCat(node);
        if (visited.has(visitKey)) return;
        visited.add(visitKey);
        const inputs = vecToArray(mxSafe(() => (node.getInputs ? node.getInputs() : null), []));
        for (const input of inputs) {
            if (found) return;
            const connected = mxElAttr(input, 'nodename')
                || mxElAttr(input, 'nodegraph')
                || mxElAttr(input, 'interfacename');
            if (!connected) continue;
            const inputType = mxElType(input);
            const resolved = mxResolveConnection(input, doc);
            if (!resolved || !resolved.type || !inputType) continue;
            if (resolved.type !== inputType) {
                found = {
                    nodeName, inputName: mxElName(input), inputType,
                    sourceName: resolved.sourceName, sourceType: resolved.type,
                };
                return;
            }
            if (resolved.node) walk(resolved.node, depth + 1);
        }
    };
    walk(renderable, 0);
    return found;
};

// MaterialX reports an unresolved node by its INSTANCE name only ("could
// not find a nodedef for node 'x'"), which is a name the author invented.
// This adds the category, and whether that category exists here at all.
const describeUnresolvedNodes = (renderable) => {
    let doc = null;
    try { doc = renderable.getDocument(); } catch (e) { return []; }
    if (!doc) return [];

    // Library-owned graphs carry a source URI; user-authored ones don't.
    // Without that filter this would walk the whole standard library.
    const nodes = [];
    try { nodes.push(...(doc.getNodes() || [])); } catch (e) { /* keep going */ }
    try {
        for (const g of doc.getNodeGraphs() || []) {
            if (g.getSourceUri && g.getSourceUri()) continue;
            nodes.push(...(g.getNodes() || []));
        }
    } catch (e) { /* keep going */ }

    const out = [];
    for (const node of nodes) {
        try {
            if (node.getNodeDef()) continue;
        } catch (e) { /* unresolved counts as a finding */ }
        let category = '';
        let known = false;
        try { category = node.getCategory() || ''; } catch (e) { /* unnamed */ }
        try { known = ((doc.getMatchingNodeDefs(category) || []).length > 0); } catch (e) { /* assume not */ }
        let name = '';
        try { name = node.getName() || ''; } catch (e) { /* unnamed */ }
        out.push({ name, category, known });
    }
    return out;
};

// One sentence per unresolved node. `known` separates "this build has no
// such node type" from "it has the type, but not with these inputs",
// which is the difference between a typo and a version/signature problem.
const unresolvedNodesText = (found) => found.map((u) => (u.known
    ? `Node "${u.name}" (type "${u.category}") exists in this MaterialX build, but no definition matches its inputs.`
    : `Node "${u.name}" (type "${u.category}") has no definition in this MaterialX build.`
)).join(' ');

// Image-family nodes that cost one sampler2D each in the generated ESSL.
const MERGEABLE_IMAGE_CATEGORIES = new Set([
    'image', 'tiledimage', 'gltf_image', 'gltf_colorimage', 'gltf_normalmap',
    'gltf_anisotropy_image', 'gltf_iridescence_thickness',
]);
// Editor-only attributes, never part of what a node reads.
const MERGE_IGNORED_ATTRIBUTES = new Set(['name', 'xpos', 'ypos', 'doc']);

// Identity of one node: category, type, its own attributes and every input's
// attributes, so two nodes match only when they read the same file the same
// way (file, colorspace, address/filter modes, texcoord, frame range, ...).
const mxNodeSignature = (node) => {
    const parts = [mxElCat(node), mxElType(node)];
    for (const attr of vecToArray(mxSafe(() => node.getAttributeNames(), [])).slice().sort()) {
        if (MERGE_IGNORED_ATTRIBUTES.has(attr)) continue;
        parts.push('@' + attr + '=' + mxElAttr(node, attr));
    }
    const inputs = vecToArray(mxSafe(() => node.getInputs(), [])).map((input) => {
        const attrs = vecToArray(mxSafe(() => input.getAttributeNames(), [])).slice().sort();
        return mxElName(input) + '{' + attrs.map((a) => a + '=' + mxElAttr(input, a)).join(',') + '}';
    }).sort();
    return parts.join('|') + '|' + inputs.join('|');
};

// Two image nodes that read the same file the same way cost two texture
// units for one texture, which is how a four-texture glTF material ran out
// of sampler slots. Rewires every downstream reference in the same scope
// onto the first of each group; the duplicates stay in the document but
// become unreachable, so codegen never emits them. Runs on the LIVE
// document, so the caller MUST call restore() in a finally.
const mergeDuplicateImageNodes = (doc) => {
    const restores = [];
    const groups = [];
    let merged = 0;
    if (!doc) return { restore: () => {}, merged, groups };
    mxWarnIfLocked('mergeDuplicateImageNodes'); // exported doc-mutating helper, see mxWarnIfLocked's header comment
    const scopes = [doc].concat(vecToArray(mxSafe(() => doc.getNodeGraphs ? doc.getNodeGraphs() : null, [])));
    for (const scope of scopes) {
        const children = vecToArray(mxSafe(() => scope.getChildren(), []));
        const bySignature = new Map();
        const renames = new Map(); // duplicate name -> canonical name
        for (const node of children) {
            if (!MERGEABLE_IMAGE_CATEGORIES.has(mxElCat(node))) continue;
            // An interface-bound input can be rebound per instance; leave those alone.
            const bound = vecToArray(mxSafe(() => node.getInputs(), []))
                .some((input) => mxElHasAttr(input, 'interfacename'));
            if (bound) continue;
            const signature = mxNodeSignature(node);
            const first = bySignature.get(signature);
            if (!first) { bySignature.set(signature, node); continue; }
            renames.set(mxElName(node), mxElName(first));
        }
        if (!renames.size) continue;
        for (const child of children) {
            const ports = [child].concat(vecToArray(mxSafe(() => child.getChildren(), [])));
            for (const port of ports) {
                if (!mxElHasAttr(port, 'nodename')) continue;
                const from = mxElAttr(port, 'nodename');
                const to = renames.get(from);
                if (!to || to === from) continue;
                if (mxSetAttr(port, 'nodename', to)) restores.push(() => mxSetAttr(port, 'nodename', from));
            }
        }
        for (const [from, to] of renames) groups.push({ kept: to, merged: from });
        merged += renames.size;
    }
    const restore = () => { for (let i = restores.length - 1; i >= 0; i--) restores[i](); };
    return { restore, merged, groups };
};

// ------------------------------------------------------------------
// generatePreviewSources: shader-generation slice of createMtlxRenderView,
// letting tryRefreshRenderView diff sources without a full rebuild.
// Frees mxShader before returning, so nothing holds a live wasm handle.
// ------------------------------------------------------------------
const generatePreviewSourcesUnlocked = ({ mx, gen, genContext, renderable, label, materialName = null, isMounted = () => true, document: documentArg = null, sceneRgbt = false, transmission = 'scalar', lightTransport = false, sceneFeatureOptions = null, stageLightCount = null, allowConstInputs = true }) => {
    // The Scene's RGB-T transmission model (payload + thin-wall correction);
    // previews opt in with transmission 'rgbt' (preview Quality).
    const rgbtPayload = sceneRgbt || transmission === 'rgbt';
    // Sampler-budget drops, requested only by compileMtlxSceneMaterial's
    // recompile loop; every other caller keeps the full feature set.
    const skipSkyVis = !!(sceneFeatureOptions && sceneFeatureOptions.skipSkyVis);
    const skipAoVolume = !!(sceneFeatureOptions && sceneFeatureOptions.skipAoVolume);
    const skipBounce = !!(sceneFeatureOptions && sceneFeatureOptions.skipBounce);
    const dropThicknessMap = !!(sceneFeatureOptions && sceneFeatureOptions.dropThicknessMap);
    const skipTransmittance = !!(sceneFeatureOptions && sceneFeatureOptions.skipTransmittance);
    const skipRefraction = !!(sceneFeatureOptions && sceneFeatureOptions.skipRefraction);
    // Feature gating: a feature that is off, or impossible in this tool, is
    // never generated. The kill switch forces both back to "generate".
    const featureGated = readFeatureGated();
    const skipShadowMap = featureGated && !!(sceneFeatureOptions && sceneFeatureOptions.skipShadowMap);
    // skipSsao: the preview's budget drop of its only occlusion term (sky/volume are skipped there).
    const skipOcclusion = (featureGated && !!(sceneFeatureOptions && sceneFeatureOptions.skipOcclusion))
        || !!(sceneFeatureOptions && sceneFeatureOptions.skipSsao);
    // Screen-space reflections are parked (see SCENE_SSR_PARKED in the renderer): skip the patch.
    const skipSsr = true || !!(sceneFeatureOptions && sceneFeatureOptions.skipSsr);
    const skipLocalEnv = !!(sceneFeatureOptions && sceneFeatureOptions.skipLocalEnv);
    // Off by default (Viewer/Compare/Builder/Graph previews and every
    // embed leave sceneFeatureOptions.specularAA unset); the Scene's own
    // compile path (compileMtlxSceneMaterial) is the only caller that
    // sets it explicitly, defaulting to true there.
    const specularAA = !!(sceneFeatureOptions && sceneFeatureOptions.specularAA);
    // OFFICIAL PARITY: per-material generation options on SHARED
    // module-scope genContext. hwTransparency is reset FIRST,
    // unconditionally, else a failed detection leaks A's stale value onto B.
    let transparent = false;
    try { genContext.getOptions().hwTransparency = false; } catch (e) { /* option absent */ }
    try {
        if (typeof mx.isTransparentSurface === 'function') {
            const t = !!mx.isTransparentSurface(renderable, gen.getTarget());
            genContext.getOptions().hwTransparency = t;
            transparent = t; // set only after the option write succeeded
        }
    } catch (e) { transparent = false; /* reset above already put the option at the deterministic false default */ }
    try {
        if (mx.ShaderInterfaceType) {
            genContext.getOptions().shaderInterfaceType =
                mx.ShaderInterfaceType.SHADER_INTERFACE_COMPLETE;
        }
    } catch (e) { /* default interface */ }
    // MaterialX's premultiplied BSDF-add mode combines a diffuse closure's
    // initial throughput 0 with a zero-weight dielectric dummy's throughput 1
    // as max(0 + 1 - 1, 0), erasing the substrate of layered materials (for
    // example the supplied ceramic/Lion graphs). Preview and scene renders
    // need ordinary throughput propagation semantics.
    try { genContext.getOptions().premultipliedBsdfAdd = false; } catch (e) { /* option absent in older bindings */ }
    // Specular environment method. The setter takes the EMBIND ENUM VALUE,
    // not an integer: assigning 0/1/2 is silently ignored, which is what
    // made this look unsettable before. Verified by generating both ways
    // and checking for mx_latlong_alpha_to_lod in the output.
    try {
        const methods = mx.HwSpecularEnvironmentMethod;
        const wanted = host.specularEnvMethod() === 'fis'
            ? methods.SPECULAR_ENVIRONMENT_FIS : methods.SPECULAR_ENVIRONMENT_PREFILTER;
        if (wanted) genContext.getOptions().hwSpecularEnvironmentMethod = wanted;
    } catch (e) { /* enum absent in older bindings, keep the generator default */ }
    // Shadow-map sampling is a generator option, so a tool or a scene with
    // shadows off never compiles it. Written on EVERY generation, both ways,
    // so no material leaks the previous one's setting.
    try { genContext.getOptions().hwShadowMap = !skipShadowMap; } catch (e) { /* option absent */ }
    // Light limit: MAX_LIGHT_SOURCES is baked into the source, so a tool
    // that can never hold a stage light gets a smaller tier. Written on
    // EVERY generation while the switch is on, so no tier leaks to the next.
    let maxLights = mxRigLightCount + 1 + STAGE_LIGHT_SLOTS;
    if (readLightLimit()) {
        maxLights = mxRigLightCount + 1 + chooseStageLightTier(stageLightCount);
        try { genContext.getOptions().hwMaxActiveLightSources = maxLights; } catch (e) { /* option absent */ }
    }

    // Bail before the ~expensive shader-generation call if this
    // build was superseded (mounted flipped while awaiting above),
    // nothing GL-side exists yet, so there's nothing to dispose.
    if (!isMounted()) return null;
    // Colorspace aliases are normalized on the LIVE document for the
    // duration of gen.generate only; restore in finally so the authored
    // document (and any export of it) never actually changes.
    const colorspaceDoc = mxSafe(() => renderable.getDocument(), null) || documentArg;
    let colorspaceAliasResult = null;
    let colorspaceTransformResult = null;
    let materialWorkspaceResult = null;
    let imageMergeResult = null;
    if (colorspaceDoc) {
        colorspaceAliasResult = applyColorspaceAliases(colorspaceDoc);
        // After the aliases (so two spellings of one colorspace still match)
        // and before the transforms, which would otherwise insert one
        // conversion chain per duplicate image.
        imageMergeResult = mergeDuplicateImageNodes(colorspaceDoc);
        if (host.debugShaders() && imageMergeResult.merged) {
            console.log('[mtlx] merged ' + imageMergeResult.merged + ' duplicate image node(s) for "' + label + '":', imageMergeResult.groups);
        }
        // Must follow the aliases: an authored "srgb_tx" only becomes a
        // name cmlib knows once applyColorspaceAliases has normalized it.
        colorspaceTransformResult = applyColorspaceTransforms(colorspaceDoc);
        // Scene-only "Material working space" setting: never set outside the
        // Scene's own compile path (see compileMtlxSceneMaterial), so the
        // Viewer/Compare/Builder/Graph previews and every embed are unaffected.
        if (sceneFeatureOptions && sceneFeatureOptions.materialWorkspace === 'acescg') {
            try {
                materialWorkspaceResult = applyMaterialWorkspaceTransforms(colorspaceDoc);
            } catch (e) {
                // Safe-fail: leave the material in Rec.709 rather than throw.
                mtlxWarn('Material working space (ACEScg) conversion failed, staying in Rec.709: ' + ((e && e.message) || e));
                materialWorkspaceResult = null;
            }
        }
    }
    // Catches a MaterialX type mismatch (no implicit coercion) BEFORE
    // generation, which otherwise fails deep inside an opaque nodegraph
    // call with a GLSL line number instead of naming the real culprit.
    const powerNodeNames = materialPowerNodeNames(colorspaceDoc);
    const mismatch = findTypeMismatches(renderable, mx);
    if (mismatch) {
        throw new Error(`Material "${label}": input "${mismatch.inputName}" on "${mismatch.nodeName}" `
            + `(${mismatch.inputType}) is connected to "${mismatch.sourceName}" (${mismatch.sourceType}); `
            + 'MaterialX requires matching types');
    }

    let mxShader;
    const __genPerfStart = host.perfLog() ? performance.now() : 0;
    try {
        try {
            mxShader = gen.generate('PreviewShader', renderable, genContext);
        } catch (genErr) {
            // Decode the REAL MaterialX error (Emscripten throws
            // numeric pointers) instead of a generic string, then name the
            // node types behind it, which MaterialX's own message omits.
            const detail = unresolvedNodesText(describeUnresolvedNodes(renderable));
            throw new Error(`Shader generation failed for "${label}": ${mxErr(mx, genErr)}`
                + (detail ? `. ${detail}` : ''));
        }
    } finally {
        // Reverse order: the transforms were layered on top of the aliases.
        if (materialWorkspaceResult) materialWorkspaceResult.restore();
        if (colorspaceTransformResult) colorspaceTransformResult.restore();
        if (imageMergeResult) imageMergeResult.restore();
        if (colorspaceAliasResult) colorspaceAliasResult.restore();
    }
    if (host.perfLog()) {
        console.log('[mtlx-perf] gen.generate: '
            + (performance.now() - __genPerfStart).toFixed(1) + 'ms (target: ' + label + ')');
    }

    // Stage identifiers: some JS builds don't expose the mx.Stage enum
    // object ("Cannot read ... 'VERTEX'"). The underlying constants are
    // just the strings "vertex"/"pixel", which getSourceCode accepts.
    const VERTEX_STAGE = (mx.Stage && mx.Stage.VERTEX) || 'vertex';
    const PIXEL_STAGE = (mx.Stage && mx.Stage.PIXEL) || 'pixel';
    let vs = stripVersion(mxShader.getSourceCode(VERTEX_STAGE));
    // hwSrgbEncodeOutput=false means raw linear output, so encodeDisplay()'s
    // (runtime-gated) epilogue is injected below unless the FRAGMENT
    // OUTPUT's own assignment already encodes srgb, checking the whole
    // shader string false-positives.
    let fs = stripVersion(mxShader.getSourceCode(PIXEL_STAGE));
    fs = patchMaterialPowerNodes(fs, powerNodeNames);
    ({ vs, fs } = patchGeompropVaryings(vs, fs));
    const vertexInputs = parseVertexInputs(vs);
    // geompropvalue nodes carry a `default` for when the stream is absent;
    // collect it so binding can use it instead of zeros.
    const geompropDefaults = materialGeompropDefaults(colorspaceDoc);
    const geomprops = vertexInputs
        .filter((v) => v.name.startsWith('i_geomprop_'))
        .map((v) => {
            const name = v.name.slice('i_geomprop_'.length);
            const defaultValue = geompropDefaults.get(name) || null;
            return defaultValue ? { name, type: v.type, defaultValue } : { name, type: v.type };
        });
    const notices = [];
    if (colorspaceAliasResult) {
        for (const [key, count] of colorspaceAliasResult.rewrites) {
            const [from, to] = key.split(' -> ');
            notices.push(`Colorspace "${from}" is not a MaterialX 1.39 name; ${count} inputs treated as `
                + (to === '(removed)' ? 'no conversion' : to));
        }
    }
    if (colorspaceTransformResult) {
        for (const [cs, count] of colorspaceTransformResult.converted) {
            notices.push(`Colorspace "${cs}": ${count} texture(s) converted to lin_rec709 in the shader`);
        }
        for (const cs of colorspaceTransformResult.unsupported) {
            notices.push(`Colorspace "${cs}" has no conversion available; those textures are sampled unconverted`);
        }
    }
    fs = patchUnlitLightingRefs(fs);
    fs = patchScenePhysicalLightFalloff(fs, sceneRgbt);
    fs = patchSceneThinWalledTransmission(fs, rgbtPayload, notices);
    const outDeclMatch = fs.match(/\bout\s+vec4\s+(\w+)\s*;/);
    const outVar = outDeclMatch ? outDeclMatch[1] : null;
    const outAssignments = outVar
        ? fs.match(new RegExp('\\b' + outVar + '\\s*=[^;]*;', 'g'))
        : null;
    if (!outVar || !outAssignments || !outAssignments.length) {
        mtlxWarn(`mtlx-engine: could not locate the fragment output assignment for "${label}", skipping encodeDisplay() as a fail-safe (cannot verify it's safe to inject ACES+sRGB without double-encoding).`);
    } else if (/srgb/i.test(outAssignments.join('\n'))) {
        // Self-encoding materials skip the epilogue entirely (no
        // u_peelLinear gate to attach to), so the linear peel/tail passes
        // treat their output as already display-encoded, a pre-existing
        // approximation, sharper now that peeling can otherwise be linear.
        mtlxWarn(`mtlx-engine: the fragment output assignment for "${label}" already calls an sRGB encode (despite hwSrgbEncodeOutput=false): skipping encodeDisplay() to avoid double-encoding (ACES tone mapping will NOT be applied to this material).`);
    } else {
        fs = encodeDisplay(fs);
    }
    // Local reflections substitute the dome lookup's `Li` BEFORE screen-space
    // reflections wrap the whole function, so SSR (when unparked) blends on
    // top of a local-env-aware fallback rather than the bare dome.
    fs = patchLocalEnvironmentRadiance(fs, { skipLocalEnv, notices });
    // Screen-space reflections wrap the generated IBL call before the
    // refraction/peel patches touch the shader.
    fs = patchScreenSpaceReflection(fs, { skipSsr, notices });
    // Folds transmission into peel-pass alpha; must precede injectPeelDiscard (see its u_peelMode guard).
    fs = patchTransmissionAlpha(fs, { skipRefraction });
    let payloadSupported = false;
    if (rgbtPayload) {
        fs = patchRgbtPayload(fs);
        payloadSupported = fs.indexOf('/* MX_RGBT_PAYLOAD_SUPPORTED */') !== -1;
    }
    let lightTransportSupported = false;
    if (lightTransport) {
        fs = patchLightTransportPayload(fs, notices, lightTransport);
        lightTransportSupported = fs.indexOf('MX_LIGHT_TRANSPORT_TERMINAL_RETURN') !== -1;
    }
    fs = patchShadowBounds(fs);
    const shadowFaceSlots = (sceneFeatureOptions && sceneFeatureOptions.shadowFaceSlots) || SHADOW_FACE_SLOTS;
    fs = patchShadowLightScope(fs, { skipTransmittance, faceSlots: shadowFaceSlots });
    fs = patchLightSourceKindStruct(fs);
    fs = patchAreaLightSourceCosine(fs);
    // skipOcclusion drops the whole block (screen-space AO included), which
    // only ever ran at strength 0 in a tool that cannot bind an AO pass.
    if (!skipOcclusion) fs = patchAmbientOcclusion(fs, { skipSkyVis, skipAoVolume });
    fs = patchDiffuseBounceAdd(fs, { skipSkyVis, skipBounce });
    fs = patchSpecularAA(fs, { specularAA });
    fs = patchTransmissionThickness(fs, { dropThicknessMap });
    // Depth-peel machinery: baked into every fragment shader
    // UNCONDITIONALLY (not just when Force Transparency is on), see
    // injectPeelDiscard's header comment above for why this keeps
    // toggling the setting a pure uniform flip (no regen/recompile) and
    // is a byte-for-byte no-op whenever u_peelMode is left at its default
    // 0 (the normal, non-peeling path).
    fs = injectPeelDiscard(fs, payloadSupported);

    // Uniform introspection, still fully inside the mxExclusive lock:
    // plainizeMxUniformData converts every vector/matrix/color `data`
    // field to a plain, detached JS array before the lock can release.
    let introspected = [];
    for (const stageName of [VERTEX_STAGE, PIXEL_STAGE]) {
        let st = null;
        try { st = mxShader.getStage(stageName); } catch (e) { /* stage absent */ }
        if (st) introspected = introspected.concat(collectMxUniforms(st));
    }
    introspected = introspected.map(plainizeMxUniformData);
    introspected = annotateFilenameSamplerModes(introspected, colorspaceDoc || documentArg);
    // uv_scale/uv_offset are ALWAYS emitted as uniforms (never inline
    // vec2 literals), so applyHeightToNormalTexel's identity check reads
    // their MaterialX-introspected default value here, once introspected
    // exists, instead of pattern-matching the (nonexistent) literal text.
    fs = applyHeightToNormalTexel(fs, notices, introspected);

    // Const inputs: the last source pass, so every regex above still sees
    // the declarations it matches on. Pruned entries leave `introspected`
    // so nothing tries to bind a uniform that no longer exists.
    let constInputs = [];
    if (allowConstInputs !== false && readConstInputs()) {
        const constified = constifyInputUniforms(vs, fs, introspected);
        vs = constified.vs;
        fs = constified.fs;
        introspected = constified.introspected;
        constInputs = constified.constInputs;
    }

    // Last reference to mxShader, free it here, still inside the lock.
    // Guarded: a BindingError here must never fail an otherwise-successful
    // generation. Loop-local `st` handles are left for FinalizationRegistry.
    try { mxShader.delete(); } catch (e) { /* already deleted */ }

    // Displacement is generated as its own tiny standalone program, never
    // let a failure here break the surface material; any problem becomes
    // a notice on the returned sources instead of a throw.
    let displacement = null;
    try {
        const __dispGenStart = host.perfLog() ? performance.now() : 0;
        displacement = generateDisplacementSourcesUnlocked({ mx, gen, genContext, renderable, materialName, allowConstInputs });
        if (displacement && host.perfLog()) displacement.genMs = performance.now() - __dispGenStart;
        if (displacement && displacement.notices && displacement.notices.length) {
            notices.push(...displacement.notices);
        }
    } catch (e) {
        notices.push('Displacement skipped: ' + (e && e.message ? e.message : String(e)));
        displacement = null;
    }

    // What this source does NOT contain, so uniform seeding can skip the
    // same features instead of binding samplers no program declares.
    const featureSkips = {
        shadowMap: skipShadowMap,
        occlusion: skipOcclusion,
        skyVis: skipOcclusion || skipSkyVis,
        aoVolume: skipOcclusion || skipSkyVis || skipAoVolume,
        // Diagnostics only: bindEnvironmentSamplers/createMtlxSceneUniforms
        // still gate on declared uniforms, not these two.
        localEnv: skipLocalEnv,
        bounce: skipBounce,
    };
    return { vs, fs, introspected, transparent, vertexInputs, geomprops, notices, payloadSupported, lightTransportSupported, displacement, maxLights, constInputs, featureSkips, shadowFaceSlots };
};

// Follows one displacementshader-typed input to the element to generate
// from: the connected node, or the connected nodegraph's Output element
// when the input names a nodegraph and output.
const mxFollowDisplacementInput = (input, doc) => {
    if (!input) return null;
    const nodeName = mxElAttr(input, 'nodename');
    if (nodeName) return mxSafe(() => input.getConnectedNode(), null);
    const graphName = mxElAttr(input, 'nodegraph');
    if (graphName) {
        const ng = mxSafe(() => doc.getNodeGraph(graphName), null);
        const outName = mxElAttr(input, 'output');
        return ng && outName ? mxSafe(() => ng.getOutput(outName), null) : null;
    }
    return null;
};

// resolveDisplacementSource: finds the element to generate the standalone
// displacement program from. Must run inside the existing mxExclusive lock.
// `notices`, when given, gets a note when more than one distinct connection is found.
const resolveDisplacementSource = ({ mx, renderable, materialName, notices = null }) => {
    if (!renderable) return null;
    if (mxElType(renderable) === 'displacementshader') return renderable;
    const doc = mxSafe(() => renderable.getDocument(), null);
    if (!doc) return null;
    if (materialName) {
        const matNode = mxSafe(() => doc.getNode(materialName), null);
        if (matNode && mxElType(matNode) === 'material') {
            const el = mxFollowDisplacementInput(mxSafe(() => matNode.getInput('displacementshader'), null), doc);
            if (el) return el;
        }
    }
    const renderableName = mxElName(renderable);
    let allNodes = [];
    try { allNodes = vecToArray(doc.getNodes ? doc.getNodes() : null); } catch (e) { allNodes = []; }
    let found = null;
    const distinct = new Set();
    for (const n of allNodes) {
        if (mxElType(n) !== 'material') continue;
        const surfInput = mxSafe(() => n.getInput('surfaceshader'), null);
        if (!surfInput || mxElAttr(surfInput, 'nodename') !== renderableName) continue;
        const el = mxFollowDisplacementInput(mxSafe(() => n.getInput('displacementshader'), null), doc);
        if (!el) continue;
        distinct.add(mxElName(el) + '|' + mxElCat(el));
        if (!found) found = el;
    }
    if (found && distinct.size > 1 && notices) {
        notices.push('Multiple materials connect a different displacement to "' + renderableName + '"; using the first one found');
    }
    return found;
};

// detectDisplacementMode: a `displacement` node's own input type; a `mix`
// of displacementshader recurses into fg/bg; a nodegraph output recurses
// into its connected node; anything else is `auto`.
const detectDisplacementMode = (element) => {
    if (!element) return 'auto';
    const category = mxElCat(element);
    if (category === 'displacement') {
        const t = mxElType(mxSafe(() => element.getInput('displacement'), null));
        return t === 'float' || t === 'vector3' ? t : 'auto';
    }
    if (category === 'mix' && mxElType(element) === 'displacementshader') {
        const fgMode = detectDisplacementMode(mxSafe(() => { const i = element.getInput('fg'); return i ? i.getConnectedNode() : null; }, null));
        const bgMode = detectDisplacementMode(mxSafe(() => { const i = element.getInput('bg'); return i ? i.getConnectedNode() : null; }, null));
        if (fgMode === 'float' && bgMode === 'float') return 'float';
        if (fgMode === 'vector3' || bgMode === 'vector3') return 'vector3'; // mixed float+vector3 treated as tangent-space vector
        return 'auto';
    }
    const connected = mxSafe(() => (element.getConnectedNode ? element.getConnectedNode() : null), null);
    return connected && connected !== element ? detectDisplacementMode(connected) : 'auto';
};

// FNV-1a over a UTF-16 JS string, good enough for a change-detection key
// (not cryptographic). Returns an 8-char hex string.
const fnv1aHex = (str) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
};

// generateDisplacementSourcesUnlocked: generates the standalone displacement
// program (see evaluateDisplacement for how it's used). Must run inside the
// existing lock; every failure is caught and turned into a notice, never a throw.
const generateDisplacementSourcesUnlocked = ({ mx, gen, genContext, renderable, materialName, allowConstInputs }) => {
    const notices = [];
    const source = resolveDisplacementSource({ mx, renderable, materialName, notices });
    if (!source) return null;
    const mode = detectDisplacementMode(source);
    const document = mxSafe(() => source.getDocument(), null);
    let colorspaceAliasResult = null;
    let colorspaceTransformResult = null;
    if (document) {
        colorspaceAliasResult = applyColorspaceAliases(document);
        colorspaceTransformResult = applyColorspaceTransforms(document);
    }
    const powerNodeNames = materialPowerNodeNames(document);
    let prevHwTransparency;
    let hadHwTransparency = true;
    try { prevHwTransparency = genContext.getOptions().hwTransparency; } catch (e) { hadHwTransparency = false; }
    let shader = null;
    try {
        try { genContext.getOptions().hwTransparency = false; } catch (e) { /* option absent */ }
        try {
            shader = gen.generate('mtlx_displacement', source, genContext);
        } catch (genErr) {
            const msg = mxErr(mx, genErr);
            if (/mix/i.test(msg) && /implementation/i.test(msg)) {
                throw new Error('Displacement mixing is not supported by the MaterialX shader generator.');
            }
            throw new Error('shader generation failed (' + msg.slice(0, 160) + ')');
        }
        const VERTEX_STAGE = (mx.Stage && mx.Stage.VERTEX) || 'vertex';
        const PIXEL_STAGE = (mx.Stage && mx.Stage.PIXEL) || 'pixel';
        let vs = stripVersion(shader.getSourceCode(VERTEX_STAGE));
        let fs = stripVersion(shader.getSourceCode(PIXEL_STAGE));
        fs = patchMaterialPowerNodes(fs, powerNodeNames);
        ({ vs, fs } = patchGeompropVaryings(vs, fs));
        const vertexInputs = parseVertexInputs(vs);
        const geompropDefaults = materialGeompropDefaults(document);
        const geomprops = vertexInputs
            .filter((input) => input.name.startsWith('i_geomprop_'))
            .map((input) => {
                const name = input.name.slice('i_geomprop_'.length);
                const defaultValue = geompropDefaults.get(name) || null;
                return defaultValue ? { name, type: input.type, defaultValue } : { name, type: input.type };
            });
        let introspected = [];
        for (const stageName of [VERTEX_STAGE, PIXEL_STAGE]) {
            let st = null;
            try { st = shader.getStage(stageName); } catch (e) { /* stage absent */ }
            if (st) introspected = introspected.concat(collectMxUniforms(st));
        }
        introspected = introspected.map(plainizeMxUniformData);
        introspected = annotateFilenameSamplerModes(introspected, document);

        // Const inputs, before the splices so the rewritten declarations are
        // still the plain generator output the regexes below expect.
        let constInputs = [];
        if (allowConstInputs !== false && readDisplacementConstInputs()) {
            const constified = constifyInputUniforms(vs, fs, introspected, DISPLACEMENT_CONST_INPUT_NAMES);
            vs = constified.vs;
            fs = constified.fs;
            introspected = constified.introspected;
            constInputs = constified.constInputs;
        }

        // Pixel splice: retarget the discarded final assignment into a
        // little-endian floatBitsToUint pack of one offset*scale component.
        const outMatch = fs.match(/\bout\s+vec4\s+(\w+)\s*;/);
        const structMatches = [...fs.matchAll(/displacementshader\s+(\w+)\s*=/g)];
        const outVar = outMatch ? outMatch[1] : null;
        const structVar = structMatches.length ? structMatches[structMatches.length - 1][1] : null;
        let psSpliced = false;
        if (outVar && structVar) {
            const finalRe = new RegExp('\\b' + outVar + '\\s*=\\s*vec4\\(\\s*0\\.0\\s*,\\s*0\\.0\\s*,\\s*0\\.0\\s*,\\s*1\\.0\\s*\\)\\s*;(?=\\s*\\})');
            if (finalRe.test(fs)) {
                const pack = '{\n'
                    + '        uint dispBits = floatBitsToUint((' + structVar + '.offset * ' + structVar + '.scale)[u_dispComponent]);\n'
                    + '        ' + outVar + ' = vec4(float(dispBits & 0xFFu), float((dispBits >> 8u) & 0xFFu), '
                    + 'float((dispBits >> 16u) & 0xFFu), float((dispBits >> 24u) & 0xFFu)) / 255.0;\n'
                    + '    }';
                fs = fs.replace(finalRe, pack);
                fs = fs.replace(/\bvoid\s+main\s*\(/, 'uniform int u_dispComponent;\nvoid main(');
                psSpliced = true;
            }
        }
        // Vertex splice: rasterize into a readback grid instead of the view.
        const vsAnchorRe = /gl_Position\s*=\s*u_viewProjectionMatrix\s*\*\s*hPositionWorld\s*;/;
        let vsSpliced = false;
        if (vsAnchorRe.test(vs)) {
            vs = vs.replace(vsAnchorRe, 'gl_Position = vec4(i_dispTexel, 0.0, 1.0);\n    gl_PointSize = 1.0;');
            vs = vs.replace(/\bvoid\s+main\s*\(/, 'in vec2 i_dispTexel;\nvoid main(');
            vsSpliced = true;
        }
        if (!psSpliced || !vsSpliced) {
            mtlxWarn('mtlx-engine: displacement splice anchor missing, ' + (!vsSpliced ? 'vertex: ' + vs.slice(0, 200) : 'pixel: ' + fs.slice(0, 200)));
            throw new Error('generated shader anchors not found (vertex or pixel); MaterialX codegen changed');
        }
        const key = fnv1aHex(vs + String.fromCharCode(0) + fs + String.fromCharCode(0)
            + JSON.stringify(introspected.map((u) => ({ name: u.name, type: u.type, data: u.data, samplerModes: u.samplerModes || null }))));
        return { vs, fs, introspected, geomprops, mode, key, notices, constInputs };
    } finally {
        if (colorspaceTransformResult) colorspaceTransformResult.restore();
        if (colorspaceAliasResult) colorspaceAliasResult.restore();
        if (hadHwTransparency) { try { genContext.getOptions().hwTransparency = prevHwTransparency; } catch (e) { /* option absent */ } }
        try { shader && shader.delete && shader.delete(); } catch (e) { /* already deleted */ }
    }
};

// Public entry point: serializes generatePreviewSourcesUnlocked against
// the shared wasm heap. Callers must go through THIS wrapper, never call
// generatePreviewSourcesUnlocked directly, to avoid overlapping wasm ops.
const generatePreviewSources = (...args) => mxExclusive(() => generatePreviewSourcesUnlocked(...args));

// ANGLE D3D11 reports 16 texture image units; a Scene material bakes twelve
// fixed samplers plus one per texture. SSR reuses u_opaqueColor/u_opaqueDepth,
// so it raises the count only on a material that does not already refract.
const DEFAULT_SAMPLER_BUDGET = 16;

// Drop order when a program exceeds the sampler budget; each { key, label }
// is a sceneFeatureOptions flag of generatePreviewSourcesUnlocked. Append
// future samplers here.
// "a", "a and b", "a, b and c" for user-facing lists.
const joinWithAnd = (items) => (items.length <= 1 ? items.join('')
    : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]);
const SAMPLER_BUDGET_DROP_ORDER = [
    // Preview Quality SSAO goes first; the Scene's loop skips previewOnly entries.
    { key: 'skipSsao', label: 'screen-space AO (u_ssaoMap)', userLabel: 'ambient occlusion', previewOnly: true },
    // Parked with screen-space reflections (always skipped for now).
    // { key: 'skipSsr', label: 'screen-space reflection (u_opaqueColor)' },
    { key: 'skipLocalEnv', label: 'local reflection capture (u_localEnvRadiance)', userLabel: 'local reflections' },
    { key: 'skipBounce', label: 'bounce volume (u_skyBounceMap)', userLabel: 'diffuse bounce' },
    { key: 'skipAoVolume', label: 'occlusion volume (u_aoVolumeMap)', userLabel: 'ambient occlusion' },
    { key: 'skipSkyVis', label: 'sky visibility (u_skyVisMap)', userLabel: 'sky visibility' },
    { key: 'dropThicknessMap', label: 'thickness map (u_thicknessMap)', userLabel: 'transmission thickness' },
    { key: 'skipTransmittance', label: 'shadow transmittance (u_shadowTransmittance)', userLabel: 'colored shadows through transparent materials' },
    { key: 'skipRefraction', label: 'refraction colour (u_opaqueColor)', userLabel: 'refraction' },
];

const SCENE_SAMPLER_DROPS = SAMPLER_BUDGET_DROP_ORDER.filter((d) => !d.previewOnly);

// One accurate sentence for a material that ran out of texture units:
// what it needed, where those samplers came from, and what was turned off.
const samplerBudgetNotice = ({ needed, limit, effects, plural }) => 'needs ' + needed.count
    + ' texture samplers (' + needed.material + ' from the material, ' + needed.scene
    + ' from the scene) but this GPU allows ' + limit + ', so ' + effects
    + (plural ? ' are' : ' is') + ' turned off for it';

// Viewer-path generation with the same sampler budget as the Scene: drops
// optional samplers in SAMPLER_BUDGET_DROP_ORDER until the fragment fits
// the texture unit limit, and notes every drop on srcs.notices.
const generatePreviewSourcesWithinBudget = async (args) => {
    const overrideBudget = host.samplerBudgetOverride();
    const budget = Number.isFinite(overrideBudget) ? overrideBudget : DEFAULT_SAMPLER_BUDGET;
    const baseFeatureOptions = args.sceneFeatureOptions || null;
    // A key the caller already gated off (e.g. PREVIEW_FEATURE_OPTIONS'
    // skipLocalEnv/skipBounce) is a no-op drop here: trying it again wastes
    // a regeneration and would name a feature the preview never had.
    const candidates = SAMPLER_BUDGET_DROP_ORDER.filter((d) => !(baseFeatureOptions && baseFeatureOptions[d.key])
        // skipSsao only means something while the occlusion block is generated.
        && !(d.key === 'skipSsao' && (!baseFeatureOptions || baseFeatureOptions.skipOcclusion)));
    const appliedOptions = Object.assign({}, baseFeatureOptions);
    let srcs = await generatePreviewSources(Object.assign({}, args, { sceneFeatureOptions: appliedOptions }));
    if (!srcs) return null;
    let info = countFragmentSamplers(srcs.fs);
    const neededInfo = info; // the full-feature count, what the notice reports
    const dropped = [];
    for (let i = 0; info.count > budget && i < candidates.length; i++) {
        const trialOptions = Object.assign({}, appliedOptions, { [candidates[i].key]: true });
        const trialSrcs = await generatePreviewSources(Object.assign({}, args, { sceneFeatureOptions: trialOptions }));
        if (!trialSrcs) return null;
        const trialInfo = countFragmentSamplers(trialSrcs.fs);
        // Keep and record this drop only when it actually shrank the
        // sampler count; an inert key never enters the notice.
        if (trialInfo.count < info.count) {
            dropped.push(candidates[i]);
            appliedOptions[candidates[i].key] = true;
            srcs = trialSrcs;
            info = trialInfo;
        }
    }
    if (dropped.length) {
        const effects = joinWithAnd(dropped.map((d) => d.userLabel));
        const needed = samplerBudgetNotice({ needed: neededInfo, limit: budget, effects, plural: dropped.length > 1 });
        srcs.notices = (srcs.notices || []).concat(['Texture slots: this material ' + needed]);
        srcs.samplerBudget = { limit: budget, count: info.count, material: info.material, scene: info.scene,
            needed: neededInfo.count, notice: needed,
            dropped: dropped.map((d) => d.label), droppedLabels: dropped.map((d) => d.userLabel) };
    }
    return srcs;
};

// One generator + GenContext + standard libraries for a MaterialX instance,
// with the light shaders bound. configure:false lets the page parse its rig
// first and call env.configureGenContext(env.genContext) itself.
const createGenEnv = (mx, { rigLightCount = 0, onPerf = null, configure = true } = {}) => {
    // WebGL 2 targets ESSL (GLSL ES 3.00), not the desktop GLSL
    // generator (#version 400 won't compile in-browser).
    // loadStandardLibraries also registers the source-code search path.
    const __stdlibPerfStart = onPerf ? performance.now() : 0;
    const gen = mx.EsslShaderGenerator.create();
    const genContext = new mx.GenContext(gen);
    const stdlib = mx.loadStandardLibraries(genContext);
    if (onPerf) onPerf('stdlib+GenContext', performance.now() - __stdlibPerfStart);
    const env = { mx, gen, genContext, stdlib, ldef: null, rigLightCount };
    try {
        env.ldef = stdlib.getNodeDef ? stdlib.getNodeDef('ND_directional_light') : null;
    } catch (e) { console.warn('direct-light registration unavailable:', e); }
    // Every GenContext option + light binding this build needs,
    // centralized so a FRESH context (createGenContext below)
    // gets the exact same setup as this shared one.
    const configureGenContext = (ctx) => {
        // TONE MAPPING: deliberately diverges from the official
        // viewer (raw linear output here; ACES + sRGB applied by
        // encodeDisplay() below, gated at runtime so linear
        // depth-peel passes can defer it, see its header).
        try { ctx.getOptions().hwSrgbEncodeOutput = false; } catch (e) { /* option absent */ }
        // Textures are uploaded flipY=false (V0 = image top row),
        // so generated shaders must sample file textures at
        // (u, 1-v) for MaterialX's lower-left UV origin, without
        // this, every image renders upside down.
        try { ctx.getOptions().fileTextureVerticalFlip = true; } catch (e) { /* option absent */ }
        // Keep the tangent-frame handedness emitted by Three rather
        // than reconstructing the bitangent with an unsigned cross
        // product, which inverts mirrored tangent-space normal maps.
        try { ctx.getOptions().hwImplicitBitangents = false; } catch (e) { /* option absent */ }
        // Shadow occlusion from a variance map; safe everywhere since
        // the default u_shadowMap is white and reads as fully lit.
        // generatePreviewSourcesUnlocked rewrites this per generation.
        try { ctx.getOptions().hwShadowMap = true; } catch (e) { /* option absent */ }
        // Direct light, like the official viewer's registerLights():
        // binds directional_light (id 1) from any <directional_light>
        // in environment_map.mtlx via DOMParser; no rig means pure IBL.
        try {
            const HwGen = mx.HwShaderGenerator;
            if (HwGen && HwGen.bindLightShader && env.ldef) {
                try { HwGen.unbindLightShaders(ctx); } catch (e) { /* fresh ctx */ }
                HwGen.bindLightShader(env.ldef, 1, ctx);
                // Point and spot as well, so USD stage lights have a
                // target: the id IS LightData.type in the generated
                // sampleLightSource() switch. Each bind is guarded alone.
                for (const [name, id] of [['ND_point_light', LIGHT_TYPE_POINT], ['ND_spot_light', LIGHT_TYPE_SPOT]]) {
                    try {
                        const def = stdlib.getNodeDef ? stdlib.getNodeDef(name) : null;
                        if (def) HwGen.bindLightShader(def, id, ctx);
                    } catch (e) { console.warn('light shader ' + name + ' unavailable:', e); }
                }
                // Capacity covers the rig, the reserved env key-light
                // slot and STAGE_LIGHT_SLOTS for imported USD lights;
                // a bound array's length can never change afterwards.
                const opts = ctx.getOptions();
                mxRigLightCount = env.rigLightCount;
                opts.hwMaxActiveLightSources = Math.max(opts.hwMaxActiveLightSources || 0, env.rigLightCount + 1 + STAGE_LIGHT_SLOTS);
            }
        } catch (e) { console.warn('direct-light registration unavailable:', e); }
    };
    env.configureGenContext = configureGenContext;
    // Compound implementations are cached by NAME per context, so a
    // document with its own nodedefs needs a FRESH one to avoid stale gen.
    env.createGenContext = () => {
        const c = new mx.GenContext(gen);
        // loadStandardLibraries is the only bound way to register the
        // source-code search path on a context (about 70 ms); the
        // document it returns is discarded, callers carry the stdlib.
        mx.loadStandardLibraries(c);
        configureGenContext(c);
        return c;
    };
    if (configure) configureGenContext(genContext);
    return env;
};

// Per-nodegroup default preview geometry (lowercase getNodeGroup() strings):
// closure and geometry-dependent groups get the scene, flat groups a 2D buffer.
const SHADERBALL_GROUPS = ['pbr', 'translation', 'material', 'shader', 'light', 'npr', 'geometric', 'texture3d'];
const defaultGeomFor = (nodegroup) => (
    SHADERBALL_GROUPS.indexOf(String(nodegroup || '').toLowerCase()) !== -1 ? 'shaderball-scene' : 'buffer2d'
);
const MtlxGenCoreApi = {
    setHost, hostSnapshot, setHostFromSnapshot, createGenEnv,
    LIGHT_TYPE_DIRECTIONAL,
    LIGHT_TYPE_POINT,
    LIGHT_TYPE_SPOT,
    LIGHT_SOURCE_KIND_AREA,
    STAGE_LIGHT_SLOTS,
    readLightLimit,
    STAGE_LIGHT_TIERS,
    PREVIEW_STAGE_LIGHT_COUNT,
    readFeatureGated,
    PREVIEW_FEATURE_OPTIONS,
    chooseStageLightTier,
    mxExclusive,
    mxWarnIfLocked,
    mtlxWarn,
    parseUniforms,
    countFragmentSamplers,
    estimateFragmentUniformVectors,
    stripVersion,
    parseVertexInputs,
    INT_GEOMPROP_TYPES,
    isIntGeompropType,
    patchGeompropVaryings,
    findGlslCalls,
    splitGlslArgs,
    findAllCallStatements,
    findFunctionDefs,
    findEnclosingFunction,
    isIdentityVec2Arg,
    HEIGHTTONORMAL_TEXEL_FN,
    HEIGHTTONORMAL_HEXTILE_TEXEL_FN,
    CHANNEL_EXTRACT_FN_RE,
    traceHeightSource,
    applyHeightToNormalTexel,
    patchUnlitLightingRefs,
    patchScenePhysicalLightFalloff,
    TONE_CURVE_GLSL,
    DISPLAY_TRANSFORM_IDS,
    displayTransformId,
    DISPLAY_TRANSFORM_SWITCH_GLSL,
    ACES_SRGB_GLSL,
    encodeDisplay,
    PEEL_REFRACTION_SCALE,
    patchShadowBounds,
    SHADOW_FACE_SLOTS,
    SHADOW_LIGHT_SLOTS_MAX,
    SHADOW_NORMAL_OFFSET_TEXELS,
    SHADOW_DEPTH_BIAS_TEXELS,
    patchShadowLightScope,
    patchLightSourceKindStruct,
    patchAreaLightSourceCosine,
    patchSpecularAA,
    ensureEnvOcclusionGlobal,
    patchAmbientOcclusion,
    patchDiffuseBounceAdd,
    patchSceneThinWalledTransmission,
    patchLightTransportPayload,
    patchTransmissionThickness,
    patchTransmissionAlpha,
    patchLocalEnvironmentRadiance,
    patchScreenSpaceReflection,
    patchRgbtPayload,
    injectPeelDiscard,
    mxErr,
    mxWriteValue,
    vecToArray,
    mxSafe,
    mxElCat,
    mxElType,
    mxElName,
    mxElAttr,
    materialPowerNodeNames,
    materialGeompropDefaults,
    POWER_NODE_REAL_GLSL,
    patchMaterialPowerNodes,
    mxElHasAttr,
    mxSetAttr,
    mxRemoveAttr,
    mxSetColorspace,
    findConvertChain,
    ensureTypedInput,
    readConstInputs,
    CONST_INPUT_NAMES,
    CONST_INPUT_DENY,
    CONST_INPUT_GLSL_TYPES,
    DISPLACEMENT_CONST_INPUT_NAMES,
    readDisplacementConstInputs,
    constInputLiteral,
    constInputKey,
    stripGlslForUsage,
    USAGE_IDENT_RE,
    addIdents,
    addComparisonIdents,
    balancedSpan,
    ternaryCondition,
    selectDynamicIndexUniforms,
    SELECTOR_CONST_INPUTS,
    constifyInputUniforms,
    stripValuesFromConnectedInputs,
    COLORSPACE_ALIASES,
    applyColorspaceAliases,
    COLORSPACE_TO_WORKING_NODE,
    applyColorspaceTransforms,
    applyMaterialWorkspaceTransforms,
    normPath,
    joinRefPath,
    findFileForRef,
    findFilesForRef,
    preferKtx2Sibling,
    readMtlxXml,
    isExportAttribution,
    splitXmlEnvelope,
    withXmlEnvelope,
    escapeXmlAttrSpecials,
    XML_ENTITIES,
    xmlDecode,
    xmlTagParts,
    xmlTokenKey,
    xmlTokenize,
    xmlPatchTag,
    xmlTokenMatches,
    preserveSourceFormatting,
    hasBlobIdentity,
    textureCacheKey,
    fnv1aBytesHex,
    BLOB_FINGERPRINT,
    fingerprintBlob,
    textureCacheKeyAsync,
    normalizeSamplerAddressMode,
    readMxInputValue,
    collectImageSamplerModes,
    samplerCacheKey,
    mxDataToPlainArray,
    collectMxUniforms,
    VECTOR_MX_TYPES,
    plainizeMxUniformData,
    annotateFilenameSamplerModes,
    COLOR_VIEWABLE,
    mxOutputTypeAndNode,
    mxResolveConnection,
    MTLX_TYPE_WALK_MAX_DEPTH,
    findTypeMismatches,
    describeUnresolvedNodes,
    unresolvedNodesText,
    MERGEABLE_IMAGE_CATEGORIES,
    MERGE_IGNORED_ATTRIBUTES,
    mxNodeSignature,
    mergeDuplicateImageNodes,
    generatePreviewSourcesUnlocked,
    mxFollowDisplacementInput,
    resolveDisplacementSource,
    detectDisplacementMode,
    fnv1aHex,
    generateDisplacementSourcesUnlocked,
    generatePreviewSources,
    DEFAULT_SAMPLER_BUDGET,
    joinWithAnd,
    SAMPLER_BUDGET_DROP_ORDER,
    SCENE_SAMPLER_DROPS,
    samplerBudgetNotice,
    generatePreviewSourcesWithinBudget,
    SHADERBALL_GROUPS,
    defaultGeomFor,
};
// mxRigLightCount is a live binding, so it is exposed through accessors.
Object.defineProperty(MtlxGenCoreApi, 'mxRigLightCount', {
    get: () => mxRigLightCount,
    set: (v) => { mxRigLightCount = v; },
    enumerable: true,
});
globalThis.MtlxGenCore = MtlxGenCoreApi;
})();
