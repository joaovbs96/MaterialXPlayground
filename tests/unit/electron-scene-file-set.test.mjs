// electron/main/scene-file-set.js: the desktop app's scene file set (DCC
// policy: relative, absolute and out-of-folder refs, read-only, scene and
// image types only) and its app:// lookup. Fixtures are built in a temp dir.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sceneFileSet = require('../../electron/main/scene-file-set.js');
const IS_WIN = process.platform === 'win32';
const TEMP_DIRS = [];
const tempDir = (prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TEMP_DIRS.push(dir); return dir; };
test.after(() => { for (const dir of TEMP_DIRS) fs.rmSync(dir, { recursive: true, force: true }); });

function write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

// <tmp>/project/scenes/shot/main.usda (the root), a sibling folder outside
// the root's folder, and a texture in a second, unrelated temp folder that
// is referenced by its absolute path.
function makeFixture() {
    const tmp = tempDir('mtlx-scene-set-');
    const far = tempDir('mtlx-scene-far-');
    const shot = path.join(tmp, 'project', 'scenes', 'shot');
    const farTex = path.join(far, 'library', 'far.png');
    write(farTex, 'far-bytes');
    write(path.join(shot, 'main.usda'), [
        '#usda 1.0',
        '(',
        '    subLayers = [@./geo/part.usda@]',
        ')',
        'def Shader "t" { asset inputs:file = @../../shared/tex/wood.png@ }',
        'def Shader "u" { asset inputs:file = @' + farTex.replace(/\\/g, '/') + '@ }',
        'def Shader "v" { asset inputs:file = @missing.png@ }',
        'def Shader "w" { asset inputs:file = @notes.txt@ }',
        'def Material "m" ( references = @mat/mat.mtlx@ ) {}',
        '',
    ].join('\n'));
    write(path.join(shot, 'geo', 'part.usda'), '#usda 1.0\ndef Shader "p" { asset inputs:file = @../tex/part.png@ }\n');
    write(path.join(shot, 'tex', 'part.png'), 'part');
    write(path.join(shot, 'notes.txt'), 'never read');
    write(path.join(shot, 'unreferenced.png'), 'sibling nobody references');
    write(path.join(tmp, 'project', 'shared', 'tex', 'wood.png'), 'wood');
    write(path.join(shot, 'mat', 'mat.mtlx'), '<?xml version="1.0"?>\n<materialx version="1.39">\n'
        + '  <image name="img" type="color3"><input name="file" type="filename" value="tiles/a.<UDIM>.png" /></image>\n</materialx>\n');
    write(path.join(shot, 'mat', 'tiles', 'a.1001.png'), 't1');
    write(path.join(shot, 'mat', 'tiles', 'a.1002.png'), 't2');
    write(path.join(shot, 'mat', 'tiles', 'b.1001.png'), 'other tile set');
    write(path.join(shot, 'late', 'found-later.png'), 'late');
    return { tmp, far, shot, farTex };
}

test('static scan follows relative, out-of-folder and absolute refs, no folder walk', async () => {
    const fx = makeFixture();
    const session = sceneFileSet.createSession(path.join(fx.shot, 'main.usda'));
    try {
        await session.init();
        const snap = session.snapshot();
        const rels = snap.files.map((f) => f.rel);
        const abs = snap.files.map((f) => f.abs.toLowerCase());
        assert.ok(abs.includes(path.join(fx.shot, 'geo', 'part.usda').replace(/\\/g, '/').toLowerCase()));
        assert.ok(abs.includes(path.join(fx.shot, 'tex', 'part.png').replace(/\\/g, '/').toLowerCase()), 'ref of a sublayer');
        assert.ok(abs.includes(path.join(fx.tmp, 'project', 'shared', 'tex', 'wood.png').replace(/\\/g, '/').toLowerCase()), 'sibling folder outside the root folder');
        assert.ok(abs.includes(fx.farTex.replace(/\\/g, '/').toLowerCase()), 'absolute ref');
        assert.ok(abs.some((a) => a.endsWith('/tiles/a.1001.png')) && abs.some((a) => a.endsWith('/tiles/a.1002.png')), 'UDIM tiles');
        assert.ok(!abs.some((a) => a.endsWith('/tiles/b.1001.png')), 'other tile set not included');
        assert.ok(!abs.some((a) => a.endsWith('unreferenced.png')), 'unreferenced sibling not included');
        assert.ok(!abs.some((a) => a.endsWith('notes.txt')), 'non-scene file type never read');
        assert.ok(snap.warnings.some((w) => /missing\.png/.test(w)), 'missing ref reported');
        // Relative layout is kept: the root's rel resolves its ../../shared ref inside the set.
        const rootDir = path.posix.dirname(snap.root);
        assert.ok(rels.includes(path.posix.normalize(rootDir + '/../../shared/tex/wood.png')));
        assert.ok(rels.includes(path.posix.normalize(rootDir + '/geo/part.usda')));
        for (const f of snap.files) assert.ok(!f.rel.startsWith('..') && !path.isAbsolute(f.rel), 'rel inside the set: ' + f.rel);
    } finally {
        sceneFileSet.disposeSession(session);
    }
});

test('missing-reference round trip resolves against the introducing layer, the base and the root folder', async () => {
    const fx = makeFixture();
    const session = sceneFileSet.createSession(path.join(fx.shot, 'main.usda'));
    try {
        await session.init();
        const snap = session.snapshot();
        const rootDir = path.posix.dirname(snap.root);
        const result = await session.resolveMissing([
            { asset: 'late/found-later.png', introducedBy: '/' + snap.root },
            { asset: 'nowhere.png', introducedBy: snap.root },
        ]);
        assert.equal(result.added.length, 1);
        assert.deepEqual(result.stillMissing, ['nowhere.png']);
        const again = session.snapshot();
        assert.ok(again.files.some((f) => f.rel === rootDir + '/late/found-later.png'));
        const repeat = await session.resolveMissing([{ asset: 'nowhere.png', introducedBy: snap.root }]);
        assert.equal(repeat.tried, 0, 'an entry is looked up once per session');
    } finally {
        sceneFileSet.disposeSession(session);
    }
});

test('app:// lookup is by exact token and id; disposed sessions and bad paths 404', async () => {
    const fx = makeFixture();
    const session = sceneFileSet.createSession(path.join(fx.shot, 'main.usda'));
    await session.init();
    const snap = session.snapshot();
    const wood = snap.files.find((f) => f.rel.endsWith('shared/tex/wood.png'));
    const url = sceneFileSet.filePathFor(session, wood);
    const ok = await sceneFileSet.handleSceneRequest(url, false);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'wood');
    assert.equal(await sceneFileSet.handleSceneRequest('/index.html', false), null);
    const bad = [
        '/__scene/' + session.token + '/../../main.usda',
        '/__scene/' + session.token + '/f999/x.png',
        '/__scene/' + '0'.repeat(32) + '/' + wood.id + '/wood.png',
        '/__scene/' + session.token + '/' + encodeURIComponent(wood.abs),
    ];
    for (const p of bad) assert.equal((await sceneFileSet.handleSceneRequest(p, false)).status, 404, p);
    sceneFileSet.disposeSession(session);
    assert.equal((await sceneFileSet.handleSceneRequest(url, false)).status, 404, 'disposed');
});

test('glTF buffers/images, OBJ mtllib and MTL textures, pbrt strings', async () => {
    const tmp = tempDir('mtlx-scene-model-');
    write(path.join(tmp, 'm.gltf'), JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'm.bin', byteLength: 4 }], images: [{ uri: 'tex/c%20d.png' }] }));
    write(path.join(tmp, 'm.bin'), 'abcd');
    write(path.join(tmp, 'tex', 'c d.png'), 'img');
    write(path.join(tmp, 'o.obj'), 'mtllib o.mtl\nv 0 0 0\n');
    write(path.join(tmp, 'o.mtl'), 'newmtl a\nmap_Kd -s 1 1 1 tex/kd.png\n');
    write(path.join(tmp, 'tex', 'kd.png'), 'kd');
    write(path.join(tmp, 's.pbrt'), 'Shape "plymesh" "string filename" [ "geo/mesh.ply" ]\nTexture "t" "spectrum" "imagemap" "string filename" "tex/kd.png"\n');
    write(path.join(tmp, 'geo', 'mesh.ply'), 'ply');
    const names = async (root) => {
        const s = sceneFileSet.createSession(path.join(tmp, root));
        try { await s.init(); return s.snapshot().files.map((f) => f.rel).sort(); } finally { sceneFileSet.disposeSession(s); }
    };
    assert.deepEqual(await names('m.gltf'), ['m.bin', 'm.gltf', 'tex/c d.png']);
    assert.deepEqual(await names('o.obj'), ['o.mtl', 'o.obj', 'tex/kd.png']);
    assert.deepEqual(await names('s.pbrt'), ['geo/mesh.ply', 's.pbrt', 'tex/kd.png']);
    assert.deepEqual(await names('o.mtl'), ['o.mtl', 'tex/kd.png']);
});

test('drive-letter and UNC refs are filesystem paths, URL schemes are not', () => {
    const base = IS_WIN ? 'C:\\proj\\scene' : '/proj/scene';
    assert.equal(sceneFileSet.refToPath(base, 'https://x/y.png'), null);
    assert.equal(sceneFileSet.refToPath(base, 'data:image/png;base64,AA'), null);
    assert.equal(sceneFileSet.refToPath(base, 'tex/a.png'), path.resolve(base, 'tex/a.png'));
    assert.ok(sceneFileSet.isAbsoluteFsRef('L:/tex/a.png'));
    assert.ok(sceneFileSet.isAbsoluteFsRef('L:\\tex\\a.png'));
    assert.ok(sceneFileSet.isAbsoluteFsRef('\\\\server\\share\\a.png'));
    assert.ok(sceneFileSet.isAbsoluteFsRef('//server/share/a.png'));
    assert.ok(!sceneFileSet.isAbsoluteFsRef('tex/a.png'));
    assert.ok(!sceneFileSet.isAbsoluteFsRef('///a.png'));
    if (IS_WIN) {
        assert.equal(sceneFileSet.refToPath(base, 'L:/tex/a.png'), 'L:\\tex\\a.png');
        assert.equal(sceneFileSet.refToPath(base, '\\\\server\\share\\tex\\a.png'), '\\\\server\\share\\tex\\a.png');
        assert.equal(sceneFileSet.refToPath(base, '//server/share/tex/a.png'), '\\\\server\\share\\tex\\a.png');
        assert.equal(sceneFileSet.syntheticRel('L:\\tex\\a.png'), '__abs/L/tex/a.png');
        assert.equal(sceneFileSet.syntheticRel('\\\\server\\share\\tex\\a.png'), '__unc/server/share/tex/a.png');
        assert.equal(sceneFileSet.syntheticToAbs('__unc/server/share/tex/a.png'), '\\\\server\\share\\tex\\a.png');
        assert.equal(sceneFileSet.syntheticToAbs('__abs/L/tex/a.png'), 'L:\\tex\\a.png');
    }
    assert.equal(sceneFileSet.syntheticToAbs('tex/a.png'), undefined);
});

test('scene root extensions exclude .xml and .mtlx', () => {
    for (const ext of ['usd', 'usda', 'usdc', 'usdz', 'gltf', 'glb', 'obj', 'mtl', 'pbrt']) assert.ok(sceneFileSet.isSceneRootPath('a/b.' + ext.toUpperCase()), ext);
    assert.ok(!sceneFileSet.isSceneRootPath('scene.xml'));
    assert.ok(!sceneFileSet.isSceneRootPath('doc.mtlx'));
});
