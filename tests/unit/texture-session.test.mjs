// createTextureSession: ladder/estimate parity with the Scene's sliced
// planTextureSize (R:2384-2446) plus the session's own behavior (reserve,
// decode dedup across sampler modes, sync cached acquire, dispose frees
// wrappers not prototypes, LRU eviction closes bitmaps).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'mtlx-engine.js'), 'utf8');
// The Scene's own copies were deleted in P6 S4; their frozen pre-P6 text is the oracle.
const SCENE_SOURCE = fs.readFileSync(path.join(ROOT, 'tests', 'unit', 'fixtures', 'scene-legacy-p5.js'), 'utf8');

function extractStatement(source, name, filename) {
    const marker = 'const ' + name + ' = ';
    const idx = source.indexOf(marker);
    assert.ok(idx >= 0, 'not found in ' + filename + ': ' + name);
    let depth = 0;
    for (let i = idx; i < source.length; i++) {
        const c = source[i];
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') depth--;
        else if (c === ';' && depth === 0) return source.slice(idx, i + 1);
    }
    throw new Error('unterminated statement: ' + name);
}

// Minimal THREE stand-in: TextureLoader resolves synchronously so decode
// counting is deterministic; textures carry just enough shape for
// configureLoadedTexture / textureSourceBytes / dispose bookkeeping.
function makeThreeStub(onLoad) {
    class FakeTexture {
        constructor(w, h, type) {
            this.image = { width: w, height: h, closed: false, close: () => { this.image.closed = true; } };
            this.type = type;
            this.disposed = false;
        }
        clone() {
            const t = new FakeTexture(this.image.width, this.image.height, this.type);
            return t;
        }
        dispose() { this.disposed = true; }
    }
    return {
        FloatType: 'float',
        UnsignedByteType: 'ubyte',
        LinearFilter: 1, LinearMipmapLinearFilter: 2,
        ClampToEdgeWrapping: 1001, MirroredRepeatWrapping: 1002, RepeatWrapping: 1000,
        Texture: FakeTexture,
        DataTexture: FakeTexture,
        TextureLoader: class {
            load(url, resolve) {
                onLoad();
                resolve(new FakeTexture(64, 64, 'ubyte'));
            }
        },
    };
}

function loadEngineTextureSession(onLoad) {
    const start = ENGINE_SOURCE.indexOf('const normPath =');
    const end = ENGINE_SOURCE.indexOf('\n// Extracts a plain JS array');
    assert.ok(start >= 0 && end > start, 'texture session source range is present');
    // configureLoadedTexture lives just past createTextureSession in the
    // engine file (design: "right after bindDroppedTextures"); pull it in
    // verbatim rather than restating its wrap/anisotropy logic here.
    const configureLoadedTexture = extractStatement(ENGINE_SOURCE, 'configureLoadedTexture', 'mtlx-engine.js');
    const exports = [
        '\nthis.createTextureSession = createTextureSession;',
        '\nthis.TEXTURE_SOURCES = TEXTURE_SOURCES;',
        '\nthis.planTextureSession = planTextureSession;',
    ].join('');
    const context = {
        console,
        window: {},
        document: { createElement: () => ({ getContext: () => ({ putImageData: () => {}, drawImage: () => {} }) }) },
        performance: globalThis.performance,
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
        THREE: makeThreeStub(onLoad || (() => {})),
        mtlxWarn: () => {},
    };
    vm.createContext(context);
    vm.runInContext(ENGINE_SOURCE.slice(start, end) + '\n\n' + configureLoadedTexture + exports, context, {
        filename: path.join(ROOT, 'js', 'mtlx-engine.js'),
    });
    return context;
}

function loadScenePlanner() {
    const combined = [
        extractStatement(SCENE_SOURCE, 'sceneNormPath', 'usd-scene-renderer.js'),
        extractStatement(SCENE_SOURCE, 'sceneDir', 'usd-scene-renderer.js'),
        extractStatement(SCENE_SOURCE, 'sceneJoinPath', 'usd-scene-renderer.js'),
        extractStatement(SCENE_SOURCE, 'sceneKtx2SiblingPath', 'usd-scene-renderer.js'),
        extractStatement(SCENE_SOURCE, 'sceneExactFile', 'usd-scene-renderer.js'),
        extractStatement(SCENE_SOURCE, 'sceneUdimCode', 'usd-scene-renderer.js'),
        extractStatement(SCENE_SOURCE, 'sceneUdimTile', 'usd-scene-renderer.js'),
        extractStatement(SCENE_SOURCE, 'sceneUdimTiles', 'usd-scene-renderer.js'),
        'this.sceneExactFile = sceneExactFile;',
        'this.sceneUdimTiles = sceneUdimTiles;',
    ].join('\n\n');
    const context = {
        console,
        window: { readImageDimensions: async (blob) => blob.dims || null },
    };
    vm.createContext(context);
    vm.runInContext(combined, context, { filename: path.join(ROOT, 'js', 'usd-scene-renderer.js') });
    return context;
}

// Scene's planTextureSize inlined here (not extracted as a standalone
// `const`, it lives inside a closure), reproduced from R:2384-2446 against
// the sliced helpers above so the ladder/estimate math is checked, not a
// reimplementation of it.
async function scenePlanTextureSize(scene, fileMap, refs, sceneOptions) {
    const entries = new Map();
    for (const ref of refs) {
        if (/<UDIM>/i.test(ref)) {
            const tiles = scene.sceneUdimTiles(ref, fileMap);
            tiles.forEach((hit) => { if (hit && !entries.has(hit.path)) entries.set(hit.path, hit.blob); });
            continue;
        }
        const hit = scene.sceneExactFile(fileMap, ref, '');
        if (hit && !entries.has(hit.path)) entries.set(hit.path, hit.blob);
    }
    const dims = await Promise.all(Array.from(entries.entries()).map(async ([p, blob]) => {
        const ext = String(p).split('.').pop().toLowerCase();
        const dimensions = await scene.window.readImageDimensions(blob);
        const w = (dimensions && dimensions.width) || 4096;
        const h = (dimensions && dimensions.height) || 4096;
        const isFloat = ext === 'exr' || ext === 'hdr';
        const mipmapped = !isFloat;
        const bytesPerPixel = ext === 'ktx2' ? 1 : (isFloat ? 16 : 4);
        return { w, h, bytesPerPixel, mipmapped };
    }));
    const requested = Number.isFinite(sceneOptions.textureMaxSize) ? sceneOptions.textureMaxSize : Infinity;
    const ladder = Array.from(new Set([requested, 4096, 2048, 1024, 512].filter((v) => v <= requested))).sort((a, b) => b - a);
    if (!ladder.length) ladder.push(512);
    const estimateAt = (tier) => dims.reduce((total, d) => {
        const w = Math.min(d.w, tier), h = Math.min(d.h, tier);
        return total + w * h * d.bytesPerPixel * (d.mipmapped ? 4 / 3 : 1);
    }, 0);
    let chosen = 512, plannedBytes = 0;
    for (const tier of ladder) {
        const estimate = estimateAt(tier);
        if (estimate <= sceneOptions.textureMaxBytes) { chosen = tier; plannedBytes = estimate; break; }
        plannedBytes = estimate;
    }
    if (!ladder.includes(chosen)) { chosen = 512; plannedBytes = estimateAt(512); }
    return { tier: chosen, plannedBytes };
}

test('session.plan ladder/estimate matches the Scene planTextureSize: mixed png/exr/ktx2, unreadable dims default to 4096', async () => {
    const engine = loadEngineTextureSession();
    const scene = loadScenePlanner();

    const fileMap = {
        'wall.png': { dims: { width: 8192, height: 8192 } },
        'roof.exr': { dims: { width: 4096, height: 4096 } }, // 16 B/px, no mips
        'trim.ktx2': { dims: { width: 2048, height: 2048 } }, // 1 B/px
        'unknown.png': {}, // unreadable -> defaults to 4096 square
    };
    const refs = ['wall.png', 'roof.exr', 'trim.ktx2', 'unknown.png'];
    const sceneOptions = { textureMaxSize: 4096, textureMaxBytes: 64 * 1024 * 1024 };

    const session = engine.createTextureSession({ maxSize: 4096, budgetBytes: sceneOptions.textureMaxBytes, exact: true, tiers: [4096, 2048, 1024, 512] });
    const enginePlan = await session.plan(refs, fileMap);
    const scenePlan = await scenePlanTextureSize(scene, fileMap, refs, sceneOptions);

    assert.equal(enginePlan.tier, scenePlan.tier);
    assert.equal(enginePlan.plannedBytes, scenePlan.plannedBytes);
});

test('session.reserve accepts until the budget is exhausted, then rejects', () => {
    const engine = loadEngineTextureSession();
    const session = engine.createTextureSession({ maxSize: 512, budgetBytes: 1000 });
    assert.equal(session.reserve('a', { bytes: 400 }), true);
    assert.equal(session.reserve('b', { bytes: 400 }), true);
    assert.equal(session.reserve('a', { bytes: 400 }), true); // already reserved, idempotent
    assert.equal(session.reserve('c', { bytes: 400 }), false); // 1200 > 1000
    assert.equal(session.stats().reservedBytes, 800);
});

test('two sampler modes on the same source share one decode, two wrappers', async () => {
    let decodeCalls = 0;
    const engine = loadEngineTextureSession(() => { decodeCalls += 1; });
    const session = engine.createTextureSession({ cache: new Map() });
    const fileMap = { 'wood.png': { name: 'wood.png', size: 10, lastModified: 1 } };
    const hit = session.resolve(fileMap, 'wood.png');

    const a = await session.acquire(hit, { samplerModes: { u: 'clamp', v: 'periodic' } });
    const b = await session.acquire(hit, { samplerModes: { u: 'mirror', v: 'clamp' } });

    assert.equal(decodeCalls, 1, 'the underlying source decodes exactly once');
    assert.notEqual(a.texture, b.texture, 'each sampler-mode combination gets its own wrapper');
    assert.equal(a.texture.wrapS, 1001);
    assert.equal(b.texture.wrapS, 1002);
    assert.equal(session.stats().wrapperCount, 2);
    assert.equal(session.stats().sourceCount, 1);
});

test('two concurrent acquire() calls for the same source (not yet awaited) still decode once', async () => {
    let decodeCalls = 0;
    const engine = loadEngineTextureSession(() => { decodeCalls += 1; });
    const session = engine.createTextureSession({ cache: new Map() });
    const fileMap = { 'wood.png': { name: 'wood.png', size: 10, lastModified: 1 } };
    const hit = session.resolve(fileMap, 'wood.png');

    // Two filename uniforms sharing one file, bound in the same pass:
    // both acquire() calls fire before either Promise resolves.
    const p1 = session.acquire(hit, { samplerModes: null });
    const p2 = session.acquire(hit, { samplerModes: null });
    const [a, b] = await Promise.all([p1, p2]);

    assert.equal(decodeCalls, 1, 'only one decode for two in-flight acquires of the same source');
    assert.equal(a.texture, b.texture, 'both callers land on the same wrapper');
});

test('a cached source resolves acquire synchronously (no Promise)', async () => {
    const engine = loadEngineTextureSession();
    const cache = new Map();
    const session = engine.createTextureSession({ cache });
    const fileMap = { 'wood.png': { name: 'wood.png', size: 10, lastModified: 1 } };
    const hit = session.resolve(fileMap, 'wood.png');

    const first = await session.acquire(hit, { samplerModes: null });
    assert.ok(first && first.texture);

    const second = session.acquire(hit, { samplerModes: { u: 'clamp', v: 'clamp' } });
    assert.equal(typeof second.then, 'undefined', 'a cached source returns synchronously, not a Promise');
    assert.ok(second.texture);
});

test('dispose frees this session\'s wrappers but not the shared decoded prototype', async () => {
    const engine = loadEngineTextureSession();
    const cache = new Map();
    const session = engine.createTextureSession({ cache });
    const fileMap = { 'wood.png': { name: 'wood.png', size: 10, lastModified: 1 } };
    const hit = session.resolve(fileMap, 'wood.png');
    const result = await session.acquire(hit, { samplerModes: null });

    session.dispose();

    assert.equal(result.texture.disposed, true, 'the wrapper clone is disposed');
    const entry = Array.from(cache.values())[0];
    assert.equal(entry.proto.disposed, false, 'the shared prototype is not disposed on session dispose');
    assert.equal(entry.refs, 0, 'the prototype drops to zero refs (idle, not deleted, under the LRU budget)');
});

test('LRU eviction closes the idle prototype bitmap once the 256 MiB idle budget is exceeded', async () => {
    const engine = loadEngineTextureSession();
    const cache = engine.TEXTURE_SOURCES; // the shared default cache the LRU acts on
    const sessionA = engine.createTextureSession({ cache });
    // A synthetic huge "image" (20000x20000x4B/px*4/3 mips ~ 2 GiB) forces
    // this one release past the 256 MiB idle budget without allocating
    // real memory: textureSourceBytes only reads width/height/type.
    const bigBlob = { name: 'huge.png', size: 1, lastModified: 1 };
    const fileMap = { 'huge.png': bigBlob };
    const hit = sessionA.resolve(fileMap, 'huge.png');
    const result = await sessionA.acquire(hit, { samplerModes: null });
    result.texture.image.width = 20000;
    result.texture.image.height = 20000;
    // The cached prototype entry shares the same image object as the clone
    // only by value here (FakeTexture.clone copies width/height), so grow
    // the stored prototype's image directly too.
    const key = Array.from(cache.keys())[0];
    const entry = cache.get(key);
    entry.proto.image.width = 20000;
    entry.proto.image.height = 20000;
    entry.bytes = 20000 * 20000 * 4 * (4 / 3);

    assert.equal(cache.has(key), true);
    sessionA.dispose(); // refs -> 0, entry goes idle, way over budget, evicted immediately

    assert.equal(cache.has(key), false, 'the idle prototype is evicted once far over the 256 MiB budget');
});

test('release drops one wrapper and its source reference (P6 S4)', async () => {
    const engine = loadEngineTextureSession();
    const cache = new Map();
    const session = engine.createTextureSession({ cache });
    const fileMap = { 'wood.png': { name: 'wood.png', size: 10, lastModified: 1 } };
    const hit = session.resolve(fileMap, 'wood.png');
    const result = await session.acquire(hit, { samplerModes: null });

    assert.equal(session.release(result.texture), true);
    assert.equal(result.texture.disposed, true);
    assert.equal(session.stats().wrapperCount, 0);
    assert.equal(Array.from(cache.values())[0].refs, 0);
    assert.equal(session.release(result.texture), false, 'a second release is a no-op');
});

test('fastPathSamplerQuirk keeps default address modes for a bounded fast-path prototype only (P6 S4)', async () => {
    const engine = loadEngineTextureSession();
    const cache = new Map();
    const session = engine.createTextureSession({ cache });
    const fileMap = { 'wood.png': { name: 'wood.png', size: 10, lastModified: 1 } };
    const hit = session.resolve(fileMap, 'wood.png');
    const modes = { u: 'clamp', v: 'mirror' };
    await session.acquire(hit, { samplerModes: null });
    const proto = Array.from(cache.values())[0].proto;
    proto.userData = { mtlxBoundedFastPath: true };

    const quirk = session.acquire(hit, { samplerModes: modes, fastPathSamplerQuirk: true });
    const plain = session.acquire(hit, { samplerModes: modes });
    assert.equal(quirk.texture.wrapS, 1000, 'fast-path proto under the quirk keeps periodic');
    assert.equal(plain.texture.wrapS, 1001, 'without the quirk the authored modes apply');
    assert.notEqual(quirk.texture, plain.texture, 'the quirk is part of the wrapper key');
});

test('a session-wide fastPathSamplerQuirk applies to every acquire (Scene displacement, P6 S5)', async () => {
    const engine = loadEngineTextureSession();
    const cache = new Map();
    const session = engine.createTextureSession({ cache, fastPathSamplerQuirk: true });
    const fileMap = { 'height.png': { name: 'height.png', size: 10, lastModified: 1 } };
    const hit = session.resolve(fileMap, 'height.png');
    await session.acquire(hit, { samplerModes: null });
    Array.from(cache.values())[0].proto.userData = { mtlxBoundedFastPath: true };
    const result = session.acquire(hit, { samplerModes: { u: 'clamp', v: 'clamp' } });
    assert.equal(result.texture.wrapS, 1000, 'the bounded fast-path proto keeps periodic, as the legacy binds did');
});
