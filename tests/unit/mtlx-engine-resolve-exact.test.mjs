// Table-driven parity between the engine's exact:true resolvers and the
// Scene's sceneExactFile / sceneUdimTiles / resolveSceneIncludes, sliced
// read-only from js/usd-scene-renderer.js. Fuzzy-mode behavior is untouched
// (checked by mtlx-engine-texture-sampler.test.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'mtlx-engine.js'), 'utf8');
const CORE_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'shared', 'mtlx-gen-core.js'), 'utf8');
const SCENE_SOURCE = fs.readFileSync(path.join(ROOT, 'js', 'usd-scene-renderer.js'), 'utf8');

// Grabs one top-level `const NAME = ...;` statement verbatim, tracking
// (){}[] depth so it works for both block- and expression-bodied arrows.
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

function makeBlob(text) {
    return { text: async () => text };
}

function loadEngineResolvers() {
    const combined = [
        extractStatement(CORE_SOURCE, 'normPath', 'mtlx-gen-core.js'),
        extractStatement(CORE_SOURCE, 'joinRefPath', 'mtlx-gen-core.js'),
        extractStatement(CORE_SOURCE, 'findFileForRef', 'mtlx-gen-core.js'),
        extractStatement(CORE_SOURCE, 'findFilesForRef', 'mtlx-gen-core.js'),
        extractStatement(CORE_SOURCE, 'preferKtx2Sibling', 'mtlx-gen-core.js'),
        extractStatement(ENGINE_SOURCE, 'resolveIncludes', 'mtlx-engine.js'),
        'this.joinRefPath = joinRefPath;',
        'this.findFileForRef = findFileForRef;',
        'this.findFilesForRef = findFilesForRef;',
        'this.preferKtx2Sibling = preferKtx2Sibling;',
        'this.resolveIncludes = resolveIncludes;',
    ].join('\n\n');
    const context = { console };
    vm.runInNewContext(combined, context, { filename: path.join(ROOT, 'js', 'mtlx-engine.js') });
    return context;
}

function loadSceneResolvers() {
    const combined = [
        // Stub: canonicalizeSceneFilenameInputs is Scene-only XML rewriting the
        // engine's exact resolveIncludes does not perform (design section 4);
        // resolveSceneIncludes calls it, so a passthrough keeps the slice runnable.
        'const canonicalizeSceneFilenameInputs = (xml) => xml;',
        extractStatement(SCENE_SOURCE, 'sceneNormPath', 'usd-scene-renderer.js'),
        extractStatement(SCENE_SOURCE, 'sceneDir', 'usd-scene-renderer.js'),
        extractStatement(SCENE_SOURCE, 'sceneJoinPath', 'usd-scene-renderer.js'),
        extractStatement(SCENE_SOURCE, 'sceneKtx2SiblingPath', 'usd-scene-renderer.js'),
        extractStatement(SCENE_SOURCE, 'sceneExactFile', 'usd-scene-renderer.js'),
        extractStatement(SCENE_SOURCE, 'sceneUdimCode', 'usd-scene-renderer.js'),
        extractStatement(SCENE_SOURCE, 'sceneUdimTile', 'usd-scene-renderer.js'),
        extractStatement(SCENE_SOURCE, 'sceneUdimTiles', 'usd-scene-renderer.js'),
        extractStatement(SCENE_SOURCE, 'resolveSceneIncludes', 'usd-scene-renderer.js'),
        'this.sceneExactFile = sceneExactFile;',
        'this.sceneUdimTiles = sceneUdimTiles;',
        'this.resolveSceneIncludes = resolveSceneIncludes;',
    ].join('\n\n');
    const context = { console };
    vm.runInNewContext(combined, context, { filename: path.join(ROOT, 'js', 'usd-scene-renderer.js') });
    return context;
}

// ---- findFileForRef exact vs sceneExactFile ----
test('exact findFileForRef matches sceneExactFile: hit, case, dot-segments, ktx2 sibling, mtlx guard, miss', () => {
    const engine = loadEngineResolvers();
    const scene = loadSceneResolvers();
    const cases = [
        { map: { 'textures/wood.png': 1 }, ref: 'wood.png', fromDir: 'textures' },
        { map: { 'Textures/Wood.png': 1 }, ref: 'Wood.png', fromDir: 'Textures' }, // case-sensitive
        { map: { 'a/b/tex.png': 1 }, ref: '../b/tex.png', fromDir: 'a/x' }, // .. resolves
        { map: { 'a.png': 1 }, ref: 'missing.png', fromDir: '' }, // miss
        { map: { 'a/tex.png': 1 }, ref: 'tex.png', fromDir: '' }, // no basename fallback in exact mode
    ];
    for (const c of cases) {
        const engineHit = engine.findFileForRef(c.map, c.ref, { exact: true, fromDir: c.fromDir });
        const sceneHit = scene.sceneExactFile(c.map, c.ref, c.fromDir);
        if (!sceneHit) {
            assert.equal(engineHit, null, JSON.stringify(c));
        } else {
            assert.ok(engineHit, 'expected a hit for ' + JSON.stringify(c));
            assert.equal(engineHit.key, sceneHit.originalPath, JSON.stringify(c));
        }
    }

    // preferKtx2Sibling is a separate call (sceneExactFile folds the
    // substitution in): engine callers apply it after findFileForRef.
    const ktx2Map = { 'tex.png': 1, 'tex.ktx2': 1 };
    const engineExact = engine.findFileForRef(ktx2Map, 'tex.png', { exact: true, fromDir: '' });
    const engineSubbed = engine.preferKtx2Sibling(ktx2Map, engineExact);
    const sceneKtx2 = scene.sceneExactFile(ktx2Map, 'tex.png', '');
    assert.equal(engineSubbed.key, sceneKtx2.path);

    // .mtlx guard: a document reference is never substituted for a same-stem .ktx2.
    const mtlxMap = { 'doc.mtlx': 1, 'doc.ktx2': 1 };
    const engineDoc = engine.findFileForRef(mtlxMap, 'doc.mtlx', { exact: true, fromDir: '' });
    const engineDocSubbed = engine.preferKtx2Sibling(mtlxMap, engineDoc);
    const sceneDoc = scene.sceneExactFile(mtlxMap, 'doc.mtlx', '');
    assert.equal(engineDocSubbed.key, 'doc.mtlx');
    assert.equal(sceneDoc.path, 'doc.mtlx');
});

// ---- findFilesForRef exact vs sceneUdimTiles ----
test('exact findFilesForRef matches sceneUdimTiles: 2x2 grid, low code rejected, duplicates, case-sensitive', () => {
    const engine = loadEngineResolvers();
    const scene = loadSceneResolvers();
    const cases = [
        { map: { 'tex.1001.png': 1, 'tex.1002.png': 1, 'tex.1011.png': 1, 'tex.1012.png': 1 }, ref: 'tex.<UDIM>.png' },
        { map: { 'tex.0999.png': 1, 'tex.1001.png': 1 }, ref: 'tex.<UDIM>.png' }, // code < 1001 rejected
        { map: { 'tex.1001.png': 1, 'tex.abcd.png': 1 }, ref: 'tex.<UDIM>.png' }, // non-digit rejected
        { map: { 'tex.1001.PNG': 1 }, ref: 'tex.<UDIM>.png' }, // case-sensitive suffix, no match
    ];
    for (const c of cases) {
        const engineHits = engine.findFilesForRef(c.map, c.ref, { exact: true });
        const sceneTiles = scene.sceneUdimTiles(c.ref, c.map);
        assert.equal(engineHits.length, sceneTiles.size, JSON.stringify(c));
        for (const hit of engineHits) {
            const sceneTile = sceneTiles.get(hit.code);
            assert.ok(sceneTile, 'engine found code ' + hit.code + ' scene did not: ' + JSON.stringify(c));
            assert.equal(hit.key, sceneTile.path);
            assert.equal(hit.u, sceneTile.u);
            assert.equal(hit.v, sceneTile.v);
        }
        // sorted by code
        for (let i = 1; i < engineHits.length; i++) assert.ok(engineHits[i].code >= engineHits[i - 1].code);
    }
});

// ---- resolveIncludes exact vs resolveSceneIncludes ----
test('exact resolveIncludes matches resolveSceneIncludes: resolved child, unresolved warning, visited silent skip', async () => {
    const engine = loadEngineResolvers();
    const scene = loadSceneResolvers();

    const map = {
        'root.mtlx': makeBlob('<materialx><xi:include href="lib/child.mtlx"/><xi:include href="missing.mtlx"/></materialx>'),
        'lib/child.mtlx': makeBlob('<?xml version="1.0"?><materialx><nodedef name="ND_x"/></materialx>'),
    };
    const sceneMap = { 'root.mtlx': map['root.mtlx'], 'lib/child.mtlx': map['lib/child.mtlx'] };

    const engineWarnings = [];
    const engineOut = await engine.resolveIncludes(
        await map['root.mtlx'].text(), map, '', new Set(), { exact: true, warnings: engineWarnings },
    );
    const sceneWarnings = [];
    const sceneOut = await scene.resolveSceneIncludes(
        await sceneMap['root.mtlx'].text(), '', sceneMap, new Set(), sceneWarnings,
    );

    assert.equal(engineOut, sceneOut);
    assert.equal(engineWarnings.length, 1);
    assert.equal(sceneWarnings.length, 1);
    assert.ok(engineOut.includes('nodedef'));
    assert.ok(engineOut.includes('unresolved include: missing.mtlx'));

    // Already-visited include: skipped silently by both, no comment inserted.
    const cyclicMap = {
        'a.mtlx': makeBlob('<materialx><xi:include href="b.mtlx"/></materialx>'),
        'b.mtlx': makeBlob('<materialx><xi:include href="a.mtlx"/><nodedef name="ND_b"/></materialx>'),
    };
    const engineVisited = new Set(['a.mtlx']);
    const sceneVisited = new Set(['a.mtlx']);
    const engineCyclic = await engine.resolveIncludes(await cyclicMap['b.mtlx'].text(), cyclicMap, '', engineVisited, { exact: true, warnings: [] });
    const sceneCyclic = await scene.resolveSceneIncludes(await cyclicMap['b.mtlx'].text(), '', cyclicMap, sceneVisited, []);
    assert.equal(engineCyclic, sceneCyclic);
    assert.ok(!engineCyclic.includes('unresolved'));
});

// ---- fuzzy mode stays byte-identical (opts omitted / exact:false) ----
test('fuzzy findFileForRef and findFilesForRef ignore an absent opts argument exactly as before', () => {
    const engine = loadEngineResolvers();
    const map = { 'a/wood.png': 1 };
    const hit = engine.findFileForRef(map, 'wood.png');
    assert.equal(hit.key, 'a/wood.png');
    assert.equal(hit.how, 'suffix');
    const tileMap = { 'tex.1001.png': 1, 'tex.1002.png': 1 };
    const hits = engine.findFilesForRef(tileMap, 'tex.<UDIM>.png');
    assert.equal(hits.length, 2);
    assert.ok('code' in hits[0] && 'u' in hits[0] && 'v' in hits[0]);
});
