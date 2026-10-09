// thumb-worker.js, the node thumbnail worker (module worker). It owns its own
// MaterialX instance, document copy and one short-lived OffscreenCanvas WebGL2
// context, and renders each target with the same code as the sidebar preview.
// Messages are { v: 1, type, ... }; the protocol is described in thumb-client.js.
import '../shared/mtlx-gen-core.js';
import '../shared/mtlx-three-material.js';
import './mtlx-preview-build.js';
import './thumb-signature.js';
import '../shared/mtlx-scene-assembly.js';
import { createThumbScene } from './thumb-scene.js';

const G = globalThis;
const V = 1;
const THUMB_PIPELINE_VERSION = 1;
const IDLE_MS = 10000;
const IDLE_SCENE_MS = 30000;
const SHADER_TYPES = ['surfaceshader', 'BSDF', 'EDF', 'VDF', 'material'];
const SOURCE_CACHE_MAX = 64;
const PROGRAM_CACHE_MAX = 32;
const TEXTURE_BYTES_MAX = 128 * 1024 * 1024;
const TEXTURE_MAX_SIZE = 1024;
const LINK_TIMEOUT_MS = 15000;
const MISS_DRAW_MS = 30; // a draw slower than this after a prewarm means the program was linked again
const MISS_LIMIT = 3;

const post = (msg, transfer) => G.postMessage(Object.assign({ v: V }, msg), transfer || []);

let mx = null;
let env = null;
let dead = false;
let appVersion = '';
let buildId = '';
let loaderStatus = {};

let parsed = null;
let lastXml = null;
let lightTree = null;
let curDocSeq = -1;
let settings = {};
let defaultDisplay = { transform: 'srgb', exposureEV: 0 };
const fileMap = {};
const fileIds = {};

const srcCache = new Map();
let gl = null;

const describe = (e) => {
    try { return MtlxGenCore.mxErr(mx, e); } catch (_) { return String((e && e.message) || e); }
};
const isAbort = (e) => /abort|unreachable|out of memory|memory access out of bounds/i.test(String((e && e.message) || e))
    || (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError);

// ---- Light element tree (for signatures) ----
// Built from the XML text so every attribute is kept verbatim. Comments,
// declarations and text are skipped.
const buildLightTree = (xml) => {
    const { tokens } = MtlxGenCore.xmlTokenize(xml);
    const root = { tag: '#root', attrs: {}, kids: [] };
    const stack = [root];
    for (const t of tokens) {
        const raw = t.raw;
        if (raw[0] !== '<' || raw.startsWith('<!') || raw.startsWith('<?')) continue;
        if (raw.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
        const parts = MtlxGenCore.xmlTagParts(raw);
        if (!parts) continue;
        const attrs = {};
        parts.attrs.forEach((v, k) => { attrs[k] = v.value; });
        const el = { tag: parts.tag, attrs, kids: [] };
        stack[stack.length - 1].kids.push(el);
        if (!parts.selfClosing) stack.push(el);
    }
    return root.kids.find((k) => k.tag === 'materialx') || root.kids[0] || root;
};

// ---- Files ----
const ktx2Alternative = (key) => {
    const dot = key.lastIndexOf('.');
    if (dot < 0) return null;
    const stem = key.slice(0, dot);
    return Object.keys(fileMap).find((k) => k.slice(0, k.lastIndexOf('.')) === stem && !/.(ktx2|mtlx)$/i.test(k)) || null;
};
// Resolves a texture reference like the page does, except a KTX2 hit is
// swapped for a decodable sibling (ktx2Only marks the ones with none).
const resolveFile = (ref) => {
    if (!ref) return null;
    let hit = MtlxGenCore.findFileForRef(fileMap, ref);
    if (!hit && /<UDIM>/i.test(ref)) {
        const tiles = MtlxGenCore.findFilesForRef(fileMap, ref).sort((a, b) => a.ref.localeCompare(b.ref));
        if (tiles.length) hit = { key: tiles[0].key };
    }
    if (!hit) return null;
    if (/\.ktx2$/i.test(hit.key)) {
        const alt = ktx2Alternative(hit.key);
        return alt ? { key: alt } : { key: hit.key, ktx2Only: true };
    }
    return { key: hit.key };
};
const fileIdentity = (value, el, anc) => {
    let ref = String(value == null ? '' : value);
    if (!ref) return 'unbound';
    let prefix = el && el.attrs ? el.attrs.fileprefix : undefined;
    for (let i = anc.length - 1; prefix == null && i >= 0; i--) prefix = anc[i].attrs && anc[i].attrs.fileprefix;
    if (prefix) ref = prefix + ref;
    const hit = resolveFile(ref);
    if (!hit) return 'unbound';
    return fileIds[hit.key] || MtlxGenCore.textureCacheKey(fileMap[hit.key], hit.key);
};

const applyFileDeltas = async (files) => {
    if (!files) return;
    for (const p of files.remove || []) { delete fileMap[p]; delete fileIds[p]; }
    const add = files.add || {};
    for (const p of Object.keys(add)) {
        fileMap[p] = add[p];
        fileIds[p] = await MtlxGenCore.textureCacheKeyAsync(add[p], p);
    }
};

// ---- Signatures ----
const saltOf = () => ['pv' + THUMB_PIPELINE_VERSION, appVersion, buildId, JSON.stringify(settings || {})].join('|');
const computeSigs = (keys) => {
    const targets = (keys || []).map((k) => Object.assign({}, k.target, { key: k.key }));
    const sigs = MtlxThumbSignature.computeSignatures(lightTree, targets, { salt: saltOf(), fileIdentity });
    const missing = targets.filter((t) => sigs[t.key] == null).map((t) => t.key);
    return { sigs, missing };
};

// ---- Source generation ----
const outputTypeOf = (target) => {
    const { docChild, nodeOutInfo, pickPreviewOutput } = MtlxPreviewBuild;
    const { mxSafe, mxElType, vecToArray } = MtlxGenCore;
    const doc = parsed.doc;
    const id = String(target.id || '');
    const name = id.slice(2);
    const scope = target.scope || '';
    const container = () => (scope ? (docChild(doc, scope) || mxSafe(() => doc.getNodeGraph(scope), null)) : doc);
    if (id[0] === 'n') {
        const c = container();
        const el = c ? mxSafe(() => c.getNode(name), null) : null;
        return el ? nodeOutInfo(el).type : null;
    }
    if (id[0] === 'o') {
        const c = container();
        const o = c ? mxSafe(() => c.getOutput(name), null) : null;
        return o ? mxElType(o) : null;
    }
    if (id[0] === 'i') {
        const c = container();
        const inp = c ? mxSafe(() => c.getInput(name), null) : null;
        return inp ? mxElType(inp) : null;
    }
    const def = (parsed.definitions || []).find((d) => d.id === id);
    if (def) return def.outType || null;
    const g = id[0] === 'g' ? mxSafe(() => doc.getNodeGraph(name), null) : null;
    if (g) {
        const outs = vecToArray(mxSafe(() => g.getOutputs(), []));
        return outs.length ? mxElType(pickPreviewOutput(outs)) : null;
    }
    return null;
};

class JobError extends Error {
    constructor(kind, message) { super(message); this.kind = kind; }
}
class JobCancelled extends Error {}

// Cancel arrives outside the serial chain; jobs poll the set at their checkpoints.
const cancelled = new Set();
const noteCancel = (jobId) => {
    cancelled.add(jobId);
    while (cancelled.size > 256) cancelled.delete(cancelled.values().next().value);
};

const buildSources = async (target, kind) => {
    const type = outputTypeOf(target);
    const allowed = kind === 'shader' ? SHADER_TYPES.indexOf(type) !== -1 : MtlxGenCore.COLOR_VIEWABLE.indexOf(type) !== -1;
    if (type != null && !allowed) {
        throw new JobError('unsupported', 'Output type ' + type + ' has no thumbnail.');
    }
    const compoundRoot = !!settings.compoundRoot;
    const needsFresh = MtlxPreviewBuild.previewNeedsFreshContext(parsed, target, compoundRoot);
    let freshCtx = null;
    let built = null;
    try {
        built = await MtlxGenCore.mxExclusive(() => MtlxPreviewBuild.buildPreviewRenderable(parsed, target, { compoundRoot }));
        if (!built.renderable) throw new JobError('unsupported', built.notice || 'Nothing to preview.');
        // Transients now exist in the document: with no nodedef or functional graph, only library compounds can be cached.
        if (needsFresh && typeof env.createGenContext === 'function' && !MtlxPreviewBuild.previewCanShareContext(parsed, compoundRoot)) {
            freshCtx = env.createGenContext();
        }
        const genContext = freshCtx || env.genContext;
        const srcs = await MtlxGenCore.generatePreviewSourcesWithinBudget({
            mx, gen: env.gen, genContext, renderable: built.renderable, label: built.label || 'thumbnail',
            materialName: built.materialName || null, isMounted: () => true,
            stageLightCount: MtlxGenCore.PREVIEW_STAGE_LIGHT_COUNT,
            sceneFeatureOptions: MtlxGenCore.PREVIEW_FEATURE_OPTIONS, allowConstInputs: true,
        });
        if (!srcs) throw new JobError('generate', 'Shader generation returned nothing.');
        return srcs;
    } finally {
        if (built) { try { await MtlxGenCore.mxExclusive(() => built.cleanup()); } catch (_) { /* best-effort */ } }
        if (freshCtx) { try { freshCtx.delete(); } catch (_) { /* best-effort */ } }
    }
};

const generateEntry = async (target, kind) => {
    try { return { srcs: await buildSources(target, kind) }; } catch (e) {
        if (e instanceof JobError) return { error: { kind: e.kind, message: e.message } };
        if (isAbort(e)) throw e;
        return { error: { kind: 'generate', message: describe(e) } };
    }
};

const remember = (sig, entry) => {
    srcCache.delete(sig);
    srcCache.set(sig, entry);
    while (srcCache.size > SOURCE_CACHE_MAX) srcCache.delete(srcCache.keys().next().value);
};

// ---- GL context ----
let idleTimer = 0;
const armIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (outstanding.size) armIdle(); else releaseGl(false); }, thumbScene.hasScene() ? IDLE_SCENE_MS : IDLE_MS);
};

const textureCache = new Map();
let textureBytes = 0;
const programKeepers = new Map();

const disposeTexture = (tex) => {
    try { tex.dispose(); } catch (_) { /* already gone */ }
    if (tex.image && typeof tex.image.close === 'function') { try { tex.image.close(); } catch (_) { /* already closed */ } }
};
const textureSize = (tex) => {
    const img = tex.image || {};
    const px = (img.width || 1) * (img.height || 1);
    const float = img.data && img.data.BYTES_PER_ELEMENT === 4;
    return Math.ceil(px * (float ? 16 : 4) * 4 / 3);
};
const evictTextures = (inUse) => {
    for (const [k, e] of textureCache) {
        if (textureBytes <= TEXTURE_BYTES_MAX) break;
        if (inUse.has(e.tex)) continue;
        textureCache.delete(k);
        textureBytes -= e.bytes;
        disposeTexture(e.tex);
    }
};

function releaseGl(lost) {
    clearTimeout(idleTimer);
    if (!gl) return;
    const state = gl;
    gl = null;
    state.releasing = true;
    thumbScene.onGlReleased();
    if (state.scene3d) {
        for (const m of state.scene3d.owned) { try { m.dispose(); } catch (_) { /* best-effort */ } }
        try { state.scene3d.pmremRT.dispose(); } catch (_) { /* best-effort */ }
        try { state.scene3d.controls.dispose(); } catch (_) { /* best-effort */ }
        state.scene3d = null;
    }
    for (const m of programKeepers.values()) { try { m.dispose(); } catch (_) { /* best-effort */ } }
    programKeepers.clear();
    for (const e of textureCache.values()) disposeTexture(e.tex);
    textureCache.clear();
    textureBytes = 0;
    try { state.renderer.dispose(); } catch (_) { /* best-effort */ }
    if (!lost) {
        try {
            const ext = state.ctx.getExtension('WEBGL_lose_context');
            if (ext) ext.loseContext();
        } catch (_) { /* best-effort */ }
    }
}

const ensureGl = (size) => {
    if (gl && (gl.lost || gl.ctx.isContextLost())) releaseGl(true);
    if (!gl) {
        const canvas = new OffscreenCanvas(size, size);
        // Same context options as the sidebar renderer (render-session.js acquireRenderer).
        const ctx = canvas.getContext('webgl2', {
            antialias: true, alpha: true, depth: true, stencil: true,
            premultipliedAlpha: true, preserveDrawingBuffer: false,
            powerPreference: 'default', failIfMajorPerformanceCaveat: false,
        });
        if (!ctx) throw new JobError('context', 'WebGL2 is not available in the thumbnail worker.');
        const state = { canvas, ctx, lost: false, releasing: false };
        canvas.addEventListener('webglcontextlost', (e) => {
            if (!state.releasing) { state.lost = true; if (e.preventDefault) e.preventDefault(); }
        });
        state.renderer = new THREE.WebGLRenderer({ canvas, context: ctx, antialias: true, alpha: true });
        state.renderer.debug.checkShaderErrors = true;
        state.renderer.setPixelRatio(1);
        state.scene = new THREE.Scene();
        state.camera = MtlxThreeMaterial.createFlat2dCamera();
        gl = state;
    }
    if (gl.canvas.width !== size || gl.canvas.height !== size) {
        gl.canvas.width = size;
        gl.canvas.height = size;
    }
    gl.renderer.setSize(size, size, false);
    return gl;
};

// ---- Textures ----
const loadTexture = async (hit, samplerModes, shader, anisotropy) => {
    const TM = MtlxThreeMaterial;
    const blob = fileMap[hit.key];
    const ext = (hit.key.split('.').pop() || '').toLowerCase();
    let tex = null;
    if (ext === 'exr') tex = await TM.loadExrTexture(blob);
    else if (ext === 'hdr') tex = await TM.loadHdrTexture(blob);
    else if (ext === 'tif' || ext === 'tiff') tex = await TM.loadTifTexture(blob, hit.key);
    else if (ext === 'tga') tex = await TM.loadTgaTexture(blob, hit.key);
    else tex = await TM.loadBoundedBitmapTexture(blob, shader ? Infinity : TEXTURE_MAX_SIZE, samplerModes);
    if (tex) TM.configureLoadedTexture(tex, samplerModes, shader ? anisotropy : undefined);
    return tex;
};

// Binds every filename sampler it can; returns { approx } when one fell back
// to the default texture because it could not be decoded here.
const bindTextures = async (srcs, uniforms, inUse, notices, topts) => {
    const shader = !!(topts && topts.shader);
    const anisotropy = topts ? topts.anisotropy : undefined;
    const reasons = [];
    let approx = false;
    for (const u of srcs.introspected || []) {
        if (u.type !== 'filename') continue;
        const ref = typeof u.data === 'string' ? u.data : (u.data != null ? String(u.data) : '');
        if (!ref) continue;
        const hit = resolveFile(ref);
        if (!hit) continue;
        if (hit.ktx2Only) {
            approx = true;
            if (reasons.indexOf('ktx2') === -1) reasons.push('ktx2');
            notices.push('KTX2 texture ' + hit.key + ' is shown as its default value in thumbnails.');
            continue;
        }
        const samplerModes = u.samplerModes || null;
        const rawKey = fileIds[hit.key] || MtlxGenCore.textureCacheKey(fileMap[hit.key], hit.key);
        const cacheKey = MtlxGenCore.samplerCacheKey(rawKey, samplerModes) + (shader ? '|scene' : '');
        let entry = textureCache.get(cacheKey);
        if (!entry) {
            let tex = null;
            try { tex = await loadTexture(hit, samplerModes, shader, anisotropy); } catch (e) {
                notices.push('Texture ' + hit.key + ' could not be decoded: ' + describe(e));
            }
            if (!tex) { approx = true; if (reasons.indexOf('texture') === -1) reasons.push('texture'); continue; }
            entry = { tex, bytes: textureSize(tex) };
            textureCache.set(cacheKey, entry);
            textureBytes += entry.bytes;
        } else {
            textureCache.delete(cacheKey);
            textureCache.set(cacheKey, entry);
        }
        inUse.add(entry.tex);
        if (uniforms[u.name]) uniforms[u.name].value = entry.tex;
    }
    evictTextures(inUse);
    return { approx, reasons };
};

// ---- Render ----
const progKeyOf = (srcs) => MtlxGenCore.fnv1aHex(srcs.vs) + MtlxGenCore.fnv1aHex(srcs.fs) + srcs.fs.length;
const retainProgram = (srcs, material) => {
    // The first material of a program stays alive so later jobs reuse it.
    const progKey = progKeyOf(srcs);
    if (programKeepers.has(progKey)) material.dispose();
    else {
        material.uniforms = {};
        programKeepers.set(progKey, material);
        while (programKeepers.size > PROGRAM_CACHE_MAX) {
            const oldest = programKeepers.keys().next().value;
            programKeepers.get(oldest).dispose();
            programKeepers.delete(oldest);
        }
    }
};

const thumbScene = createThumbScene({
    JobError, getGl: (size) => ensureGl(size), releaseGl, bindTextures, retainProgram,
});

const renderTarget = async (srcs, display, size) => {
    const TM = MtlxThreeMaterial;
    const state = ensureGl(size);
    const { renderer, scene, camera } = state;
    const notices = (srcs.notices || []).slice();
    const geometry = TM.prepGeometry(new THREE.PlaneGeometry(2, 2));
    let material = null;
    try {
        if (srcs.geomprops && srcs.geomprops.length) {
            TM.bindGeompropAttributes(geometry, srcs.geomprops, (text) => { if (!notices.includes(text)) notices.push(text); });
        }
        const uniforms = TM.createMtlxSceneUniforms({ compiled: srcs, env: null, lightData: [], envRotationRad: 0, envExposure: 1 });
        const exposureEV = Number.isFinite(Number(display.exposureEV)) ? Number(display.exposureEV) : 0;
        if (uniforms.u_displayExposure) uniforms.u_displayExposure.value = Math.pow(2, exposureEV);
        if (uniforms.u_displayTransform) uniforms.u_displayTransform.value = MtlxGenCore.displayTransformId(display.transform || 'srgb');
        if (uniforms.u_time) uniforms.u_time.value = 0;
        if (uniforms.u_frame) uniforms.u_frame.value = 0;
        const inUse = new Set();
        const { approx, reasons } = await bindTextures(srcs, uniforms, inUse, notices);
        if (state.lost || state.ctx.isContextLost()) throw new JobError('context', 'The WebGL context was lost.');
        material = TM.createPreviewMaterial(srcs, uniforms);
        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);
        TM.updateTransformUniforms(uniforms, mesh, camera);
        renderer.setClearColor(0, 0);
        renderer.clear();
        const tDraw = performance.now();
        renderer.render(scene, camera);
        const drawMs = performance.now() - tDraw;
        scene.remove(mesh);
        if (state.lost || state.ctx.isContextLost()) throw new JobError('context', 'The WebGL context was lost.');
        const bad = (renderer.info.programs || []).find((p) => p.diagnostics && p.diagnostics.runnable === false);
        if (bad) {
            const d = bad.diagnostics;
            const log = (d.programLog || '') + (d.fragmentShader && d.fragmentShader.log ? ' FRAG: ' + d.fragmentShader.log : '')
                + (d.vertexShader && d.vertexShader.log ? ' VERT: ' + d.vertexShader.log : '');
            throw new JobError('compile', 'Shader compile error. ' + log.slice(0, 300));
        }
        // Copy into a 2D canvas: a bitmap straight from the WebGL canvas goes blank once the context is released.
        const glBitmap = state.canvas.transferToImageBitmap();
        const copy = new OffscreenCanvas(glBitmap.width, glBitmap.height);
        copy.getContext('2d').drawImage(glBitmap, 0, 0);
        glBitmap.close();
        const bitmap = copy.transferToImageBitmap();
        retainProgram(srcs, material);
        material = null;
        return { bitmap, notices, approx, reasons, drawMs };
    } finally {
        if (material) { try { material.dispose(); } catch (_) { /* best-effort */ } }
        geometry.dispose();
    }
};

// ---- Parallel pattern links ----
// A pattern job submits its program through KHR_parallel_shader_compile right after generation and
// renders when the link is done, so up to a window of links overlap. Renders stay serial (one canvas).
const outstanding = new Set();
const linkJobs = new Map();
let renderTail = Promise.resolve();
let parallelOk = false;
let misses = 0;

const serialRender = (fn) => {
    const run = renderTail.then(fn);
    renderTail = run.catch(() => {});
    return run;
};
const glFor = (size) => ((gl && !gl.lost && !gl.ctx.isContextLost()) ? gl : ensureGl(size));

// Returns a shared link record, or null when three.js will find the program already (kept or unsupported).
const acquireLink = (srcs, size) => {
    const key = progKeyOf(srcs);
    if (programKeepers.has(key)) return null;
    let L = linkJobs.get(key);
    if (L && L.st !== gl) { linkJobs.delete(key); L = null; }
    if (!L) {
        const st = glFor(size);
        const g = st.ctx;
        const ext = g.getExtension('KHR_parallel_shader_compile');
        if (!ext) return null;
        const vs = g.createShader(g.VERTEX_SHADER);
        g.shaderSource(vs, '#version 300 es\n' + srcs.vs);
        g.compileShader(vs);
        const fsh = g.createShader(g.FRAGMENT_SHADER);
        g.shaderSource(fsh, '#version 300 es\n' + srcs.fs);
        g.compileShader(fsh);
        const prog = g.createProgram();
        g.attachShader(prog, vs);
        g.attachShader(prog, fsh);
        g.linkProgram(prog);
        L = { key, st, g, ext, vs, fsh, prog, refs: 0 };
        linkJobs.set(key, L);
    }
    L.refs++;
    return L;
};
const releaseLink = (L) => {
    if (--L.refs > 0) return;
    if (linkJobs.get(L.key) === L) linkJobs.delete(L.key);
    try { L.g.deleteProgram(L.prog); L.g.deleteShader(L.vs); L.g.deleteShader(L.fsh); } catch (_) { /* context gone */ }
};
const linkDone = (L) => {
    try {
        if (L.g.isContextLost() || !L.g.isProgram(L.prog)) return true;
        const v = L.g.getProgramParameter(L.prog, L.ext.COMPLETION_STATUS_KHR);
        return v === null ? true : !!v;
    } catch (_) { return true; }
};
const waitLink = async (L) => {
    const t0 = performance.now();
    while (!linkDone(L) && performance.now() - t0 < LINK_TIMEOUT_MS) await new Promise((r) => setTimeout(r, 2));
};

const noteDraw = (warmed, drawMs) => {
    if (!warmed || drawMs <= MISS_DRAW_MS || !parallelOk) return;
    if (++misses >= MISS_LIMIT) {
        parallelOk = false;
        post({ type: 'windowOff', reason: 'program cache miss' });
    }
};

const finishParallel = async (m, entry, link, genMs, t0, size, display) => {
    const jobId = m.jobId;
    const fail = (kind, message) => post({ type: 'error', jobId, key: m.key, sig: m.sig, kind, message });
    try {
        const tLink = performance.now();
        if (link) await waitLink(link);
        const linkMs = performance.now() - tLink;
        if (cancelled.has(jobId)) throw new JobCancelled();
        const tRender = performance.now();
        const out = await serialRender(() => {
            if (cancelled.has(jobId)) throw new JobCancelled();
            return renderTarget(entry.srcs, display, size);
        });
        noteDraw(!!link, out.drawMs);
        post({
            type: 'result', jobId, key: m.key, sig: m.sig, bitmap: out.bitmap, ms: performance.now() - t0, notices: out.notices, approx: out.approx,
            approxReasons: out.reasons, timings: { genMs, linkMs, renderMs: performance.now() - tRender, drawMs: out.drawMs },
        }, [out.bitmap]);
    } catch (e) {
        if (e instanceof JobCancelled) post({ type: 'stale', jobId, reason: 'cancelled' });
        else if (e instanceof JobError) fail(e.kind, e.message);
        else if (isAbort(e)) { dead = true; post({ type: 'fatal', message: describe(e) }); } else fail('generate', describe(e));
    } finally {
        if (link) releaseLink(link);
        cancelled.delete(jobId);
    }
};

const handleRender = async (m) => {
    const jobId = m.jobId;
    const shader = m.kind === 'shader';
    if (m.docSeq !== curDocSeq || !parsed) { post({ type: 'stale', jobId, reason: 'docSeq' }); return; }
    clearTimeout(idleTimer);
    const t0 = performance.now();
    const fail = (kind, message) => post({ type: 'error', jobId, key: m.key, sig: m.sig, kind, message });
    const check = () => { if (cancelled.has(jobId)) throw new JobCancelled(); };
    const stage = (name) => { if (shader) post({ type: 'stage', jobId, stage: name }); };
    let deferred = false;
    try {
        if (shader && (!thumbScene.hasScene() || m.sceneKey !== thumbScene.key())) {
            fail('scene', 'The thumbnail scene is not ready for this render.');
            return;
        }
        check();
        // A target without a signature is never cached.
        const cacheable = typeof m.sig === 'string' && m.sig.length > 0;
        let entry = cacheable ? srcCache.get(m.sig) : null;
        let genMs = 0;
        if (!entry) {
            stage('generate');
            const tGen = performance.now();
            entry = await generateEntry(m.target || {}, shader ? 'shader' : 'pattern');
            genMs = performance.now() - tGen;
            if (cacheable) remember(m.sig, entry);
        }
        if (entry.error) { fail(entry.error.kind, entry.error.message); return; }
        // A macrotask gap lets a queued cancel land before the link starts.
        if (shader) await new Promise((r) => setTimeout(r, 0));
        check();
        const size = Math.max(16, Math.min(512, Math.round(Number(m.size) || 238)));
        const display = m.display || defaultDisplay;
        if (!shader && m.parallel && parallelOk) {
            // The link and the render finish off the message chain so the next job can generate meanwhile.
            let link = null;
            try { link = acquireLink(entry.srcs, size); } catch (_) { link = null; }
            const run = finishParallel(m, entry, link, genMs, t0, size, display).finally(() => {
                outstanding.delete(run);
                if (!outstanding.size) armIdle();
            });
            outstanding.add(run);
            deferred = true;
            return;
        }
        if (shader) {
            const notices = (entry.srcs.notices || []).slice();
            const out = await thumbScene.renderShader(entry.srcs, display, size, { check, isCancelled: () => cancelled.has(jobId), stage }, notices);
            post({
                type: 'result', jobId, key: m.key, sig: m.sig, bitmap: out.bitmap, ms: performance.now() - t0, notices,
                approx: out.approx, approxReasons: out.reasons, timings: { genMs, linkMs: out.linkMs, renderMs: out.renderMs },
            }, [out.bitmap]);
            return;
        }
        const tRender = performance.now();
        const out = await renderTarget(entry.srcs, display, size);
        post({
            type: 'result', jobId, key: m.key, sig: m.sig, bitmap: out.bitmap, ms: performance.now() - t0, notices: out.notices, approx: out.approx,
            approxReasons: out.reasons, timings: { genMs, linkMs: 0, renderMs: performance.now() - tRender },
        }, [out.bitmap]);
    } catch (e) {
        if (e instanceof JobCancelled) post({ type: 'stale', jobId, reason: 'cancelled' });
        else if (e instanceof JobError) fail(e.kind, e.message);
        else if (isAbort(e)) throw e;
        else fail('generate', describe(e));
    } finally {
        if (!deferred) {
            cancelled.delete(jobId);
            if (!outstanding.size) armIdle();
        }
    }
};

// Fills the source cache for pattern jobs the page cannot render yet (CPU only, no GL). It yields to
// any queued message between jobs, and a batch for an older document does nothing.
const handlePrepare = async (m) => {
    let n = 0;
    for (const j of Array.isArray(m.jobs) ? m.jobs : []) {
        if (m.docSeq !== curDocSeq || !parsed || dead || queued > 1) break;
        if (!j || typeof j.sig !== 'string' || !j.sig || srcCache.has(j.sig)) continue;
        remember(j.sig, await generateEntry(j.target || {}, 'pattern'));
        n++;
        await new Promise((r) => setTimeout(r, 0));
    }
    post({ type: 'prepared', docSeq: m.docSeq, n });
};

const handleSetScene = async (m) => {
    clearTimeout(idleTimer);
    try {
        const out = await thumbScene.setScene(m, defaultDisplay);
        if (out.anisotropyChanged) {
            for (const [k, e] of textureCache) {
                if (!k.endsWith('|scene')) continue;
                textureCache.delete(k);
                textureBytes -= e.bytes;
                disposeTexture(e.tex);
            }
        }
        post({ type: 'sceneReady', sceneKey: out.sceneKey, ms: out.ms, gpuBytesEstimate: out.gpuBytesEstimate });
    } catch (e) {
        if (isAbort(e)) throw e;
        post({ type: 'error', jobId: null, sceneKey: m.sceneKey, kind: 'scene', message: e instanceof JobError ? e.message : describe(e) });
    } finally {
        armIdle();
    }
};

// ---- Messages ----
const importOptional = async (name, url) => {
    if (!url) { loaderStatus[name] = 'absent'; return; }
    try { await import(url); loaderStatus[name] = 'ok'; } catch (e) { loaderStatus[name] = 'failed: ' + ((e && e.message) || e); }
};

// The MaterialX JS wrapper picks its XML path handling from typeof window and uses
// document.createElement('a') to absolutize search paths. Installed after three and the
// loaders evaluate, so they never see it. baseUrl is the page's: in VS Code the worker
// runs from a blob: URL, which cannot resolve relative paths.
const installMaterialXShim = (baseUrl) => {
    const base = baseUrl || G.location.href;
    if (typeof G.window === 'undefined') G.window = G;
    if (typeof G.document === 'undefined') {
        G.document = {
            createElement: () => {
                let u = null;
                return {
                    set href(v) { u = new URL(String(v), base); },
                    get href() { return u ? u.href : ''; },
                    get origin() { return u ? u.origin : ''; },
                    get pathname() { return u ? u.pathname : ''; },
                    get search() { return u ? u.search : ''; },
                    get hash() { return u ? u.hash : ''; },
                };
            },
        };
    }
};

const probeParallelCompile = () => {
    try {
        const g = new OffscreenCanvas(1, 1).getContext('webgl2');
        const ok = !!(g && g.getExtension('KHR_parallel_shader_compile'));
        const lose = g && g.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
        return ok;
    } catch (_) { return false; }
};

const handleInit = async (m) => {
    await import(m.three.url);
    if (!G.THREE) throw new Error('three.js did not register THREE in the worker.');
    const L = m.loaders || {};
    await importOptional('fflate', L.fflate);
    await importOptional('exr', L.exr);
    await importOptional('hdr', L.hdr);
    await importOptional('pako', L.pako);
    await importOptional('utif', L.utif);
    if (m.host) {
        if (m.host.gen) MtlxGenCore.setHostFromSnapshot(m.host.gen);
        if (m.host.three) MtlxThreeMaterial.setHostFromSnapshot(m.host.three);
        if (m.host.assembly) MtlxSceneAssembly.setHostFromSnapshot(m.host.assembly);
    }
    installMaterialXShim(m.baseUrl);
    const factory = (await import(m.mtlx.factoryUrl)).default;
    if (typeof factory !== 'function') throw new Error('This MaterialX build has no ES module factory.');
    mx = await factory({
        wasmBinary: m.mtlx.wasm,
        getPreloadedPackage: () => m.mtlx.data,
        locateFile: (p) => p,
    });
    const rig = m.rigLights;
    env = MtlxGenCore.createGenEnv(mx, { rigLightCount: Array.isArray(rig) ? rig.length : (Number(rig) || 0) });
    thumbScene.init(m.scene, rig);
    appVersion = String((m.mtlx && m.mtlx.version) || (mx.getVersionString && mx.getVersionString()) || '');
    buildId = String(m.buildId || '');
    parallelOk = probeParallelCompile();
    post({
        type: 'ready',
        capabilities: { viewableTypes: MtlxGenCore.COLOR_VIEWABLE.slice(), loaders: loaderStatus, parallelCompile: parallelOk },
    });
};

const handleSetDocument = async (m) => {
    await applyFileDeltas(m.files);
    settings = m.settings || {};
    if (m.display) defaultDisplay = m.display;
    curDocSeq = m.docSeq;
    if (m.xml !== lastXml || !parsed) {
        const prev = parsed;
        parsed = null;
        lastXml = null;
        if (prev) { try { prev.doc.delete(); } catch (_) { /* already freed */ } }
        try {
            parsed = await MtlxPreviewBuild.parseMtlxDocumentWith(mx, env.stdlib, m.xml);
            lightTree = buildLightTree(m.xml);
            lastXml = m.xml;
        } catch (e) {
            if (isAbort(e)) throw e;
            post({ type: 'signatures', docSeq: m.docSeq, sigs: {}, missing: (m.keys || []).map((k) => k.key), error: describe(e) });
            return;
        }
    }
    const r = computeSigs(m.keys);
    post({ type: 'signatures', docSeq: m.docSeq, sigs: r.sigs, missing: r.missing });
};

const handle = async (m) => {
    if (!m || m.v !== V || dead) return;
    // Everything but a parallel pattern render waits until the jobs still linking have posted.
    if (outstanding.size && !(m.type === 'render' && m.parallel && m.kind !== 'shader')) await Promise.all(Array.from(outstanding));
    switch (m.type) {
        case 'init': await handleInit(m); break;
        case 'setDocument': await handleSetDocument(m); break;
        case 'requestSignatures': {
            if (!parsed) { post({ type: 'signatures', docSeq: m.docSeq, sigs: {}, missing: (m.keys || []).map((k) => k.key) }); break; }
            const r = computeSigs(m.keys);
            post({ type: 'signatures', docSeq: curDocSeq, sigs: r.sigs, missing: r.missing });
            break;
        }
        case 'render': await handleRender(m); break;
        case 'prepare': await handlePrepare(m); break;
        case 'setHost':
            if (m.gen) MtlxGenCore.setHostFromSnapshot(m.gen);
            if (m.three) MtlxThreeMaterial.setHostFromSnapshot(m.three);
            if (m.assembly) MtlxSceneAssembly.setHostFromSnapshot(m.assembly);
            srcCache.clear();
            break;
        case 'setScene': await handleSetScene(m); break;
        case 'trim': releaseGl(false); break;
        case 'releaseScene': thumbScene.release(); releaseGl(false); break;
        case 'setDisplay': if (m.display) defaultDisplay = m.display; break;
        default: break;
    }
};

// Messages run one at a time so a new document never frees the one a job is using.
let chain = Promise.resolve();
let queued = 0; // messages received and not yet handled; a running prepare stops when another waits
G.onmessage = (ev) => {
    const msg = ev.data;
    if (msg && msg.v === V && msg.type === 'cancel') { noteCancel(msg.jobId); return; }
    queued++;
    chain = chain.then(() => handle(ev.data)).catch((e) => {
        dead = true;
        post({ type: 'fatal', message: describe(e) });
    }).then(() => { queued--; });
};
