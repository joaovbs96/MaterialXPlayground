// Drive-letter and UNC references are absolute filesystem paths, not URL
// schemes: engine exact resolvers, the Scene's canonicalization and file map,
// and the glTF/OBJ/pbrt loaders. The desktop app tags files with
// File.__mtlxAbsPath; browser drops fall back to a unique suffix match.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { isAbsoluteFsRef, absFsKey, absIndexOf, resolveAbsFsRef, resolveScenePath } from '../../js/usd/scene-import-common.js';
import { resolveMtlTexturePath, resolveMtllibPath } from '../../js/usd/obj-stage-loader.js';
import { resolveGltfBuffers } from '../../js/usd/gltf-stage-loader.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CORE = fs.readFileSync(path.join(ROOT, 'js', 'shared', 'mtlx-gen-core.js'), 'utf8');
const RENDERER = fs.readFileSync(path.join(ROOT, 'js', 'usd-scene-renderer.js'), 'utf8');

function extract(source, name) {
    const idx = source.indexOf('const ' + name + ' = ');
    assert.ok(idx >= 0, name);
    let depth = 0;
    for (let i = idx; i < source.length; i++) {
        const c = source[i];
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') depth--;
        else if (c === ';' && depth === 0) return source.slice(idx, i + 1);
    }
    throw new Error('unterminated ' + name);
}

function engine() {
    const context = {};
    vm.runInNewContext(['normPath', 'joinRefPath', 'findFileForRef', 'findFilesForRef', 'preferKtx2Sibling'].map((n) => extract(CORE, n)).join('\n')
        + '\nthis.window = { normPath, joinRefPath, findFileForRef, findFilesForRef, preferKtx2Sibling };', context);
    return context.window;
}

function scene() {
    const start = RENDERER.indexOf('const sceneArray =');
    const end = RENDERER.indexOf('const sceneMatrix =', start);
    const context = { Blob, Math, String, Object, Set, window: engine() };
    vm.runInNewContext(RENDERER.slice(start, end) + '\nthis.api = { sceneFileMap, canonicalizeSceneFilenameInputs, sceneExactFile, sceneResolveDomeTexture };', context);
    return context.api;
}

// A File-like value carrying the desktop app's absolute path tag.
const tagged = (abs) => Object.assign(new Blob(['x']), { __mtlxAbsPath: abs });

test('joinRefPath keeps drive-letter and UNC prefixes and ignores fromDir for them', () => {
    const { joinRefPath } = engine();
    assert.equal(joinRefPath('scene/looks', 'L:/tex/a.png'), 'L:/tex/a.png');
    assert.equal(joinRefPath('scene/looks', 'L:\\tex\\..\\tex2\\a.png'), 'L:/tex2/a.png');
    assert.equal(joinRefPath('scene', '\\\\server\\share\\tex\\a.png'), '//server/share/tex/a.png');
    assert.equal(joinRefPath('scene', '//server/share/./tex/a.png'), '//server/share/tex/a.png');
    // Relative regressions: unchanged.
    assert.equal(joinRefPath('scene/looks', '../tex/a.png'), 'scene/tex/a.png');
    assert.equal(joinRefPath('', './tex/a.png'), 'tex/a.png');
    assert.equal(joinRefPath('scene', '/tex/a.png'), 'scene/tex/a.png');
});

test('exact findFileForRef: absolute index first, then a unique longest suffix, relative unchanged', () => {
    const { findFileForRef } = engine();
    const map = { 'shot/tex/a.png': 1, '__abs/L/lib/b.png': 2, 'tex/a.png': 3 };
    Object.defineProperty(map, '__absIndex', { value: { 'l:/lib/b.png': '__abs/L/lib/b.png', '//server/share/c.png': 'tex/a.png' }, enumerable: false });
    assert.deepEqual({ ...findFileForRef(map, 'L:/lib/b.png', { exact: true, fromDir: 'shot' }) }, { key: '__abs/L/lib/b.png', how: 'absolute' });
    assert.deepEqual({ ...findFileForRef(map, 'l:\\LIB\\b.png', { exact: true }) }, { key: '__abs/L/lib/b.png', how: 'absolute' });
    assert.equal(findFileForRef(map, '\\\\server\\share\\c.png', { exact: true }).key, 'tex/a.png');
    // Not indexed: the longest key that is a suffix of the absolute path.
    assert.deepEqual({ ...findFileForRef(map, 'D:/proj/shot/tex/a.png', { exact: true }) }, { key: 'shot/tex/a.png', how: 'suffix' });
    assert.equal(findFileForRef({ 'a/x.png': 1, 'b/x.png': 1 }, 'D:/x.png', { exact: true }), null, 'no key is a suffix');
    // Relative refs: exact only, a miss stays a miss.
    assert.equal(findFileForRef(map, 'tex/a.png', { exact: true, fromDir: 'shot' }).key, 'shot/tex/a.png');
    assert.equal(findFileForRef(map, 'a.png', { exact: true }), null);
});

test('exact findFilesForRef matches absolute UDIM refs through the absolute index', () => {
    const { findFilesForRef } = engine();
    const map = { 'm/t.1001.png': 1, 'm/t.1002.png': 1 };
    Object.defineProperty(map, '__absIndex', { value: { 'l:/m/t.1001.png': 'm/t.1001.png', 'l:/m/t.1002.png': 'm/t.1002.png' }, enumerable: false });
    const hits = findFilesForRef(map, 'L:/m/t.<UDIM>.png', { exact: true });
    assert.deepEqual(JSON.parse(JSON.stringify(hits.map((h) => [h.key, h.code]))), [['m/t.1001.png', 1001], ['m/t.1002.png', 1002]]);
    assert.equal(findFilesForRef(map, 'm/t.<UDIM>.png', { exact: true }).length, 2, 'relative unchanged');
});

test('Scene canonicalization keeps absolute refs as paths and the file map indexes tagged files', () => {
    const { sceneFileMap, canonicalizeSceneFilenameInputs, sceneExactFile, sceneResolveDomeTexture } = scene();
    const map = sceneFileMap([
        { path: 'shot/main.usda', data: new Blob(['#usda']) },
        { path: '__abs/L/tex/a.png', data: tagged('L:/tex/a.png') },
        { path: '__unc/srv/share/b.png', data: tagged('//srv/share/b.png') },
    ], {});
    assert.ok(!Object.keys(map).includes('__absIndex'), 'index is not enumerable');
    const xml = '<materialx fileprefix="textures/"><input name="file" type="filename" value="L:\\tex\\a.png" />'
        + '<input name="f2" type="filename" value="\\\\srv\\share\\b.png" /><input name="f3" type="filename" value="https://x/y.png" /></materialx>';
    const out = canonicalizeSceneFilenameInputs(xml, 'shot/looks/doc.mtlx', map, true);
    assert.ok(out.includes('value="L:/tex/a.png"'), out);
    assert.ok(out.includes('value="//srv/share/b.png"'), out);
    assert.ok(out.includes('value="https://x/y.png"'), 'URLs untouched');
    assert.equal(sceneExactFile(map, 'L:/tex/a.png', '').originalPath, '__abs/L/tex/a.png');
    assert.equal(sceneExactFile(map, '//srv/share/b.png', '').originalPath, '__unc/srv/share/b.png');
    assert.equal(sceneResolveDomeTexture(map, { rootPath: 'shot/main.usda' }, '@L:/tex/a.png@').path, '__abs/L/tex/a.png');
});

test('loader helpers resolve absolute refs; relative resolution unchanged', async () => {
    assert.ok(isAbsoluteFsRef('L:/a.png') && isAbsoluteFsRef('\\\\srv\\s\\a.png') && isAbsoluteFsRef('//srv/s/a.png'));
    assert.ok(!isAbsoluteFsRef('a.png') && !isAbsoluteFsRef('/a.png') && !isAbsoluteFsRef('https://x'));
    assert.equal(absFsKey('L:\\Tex\\..\\b.png'), 'l:/b.png');
    const entries = [
        { path: 'shot/o.obj', data: new Blob(['o']) },
        { path: '__abs/L/lib/kd.png', data: tagged('L:\\lib\\kd.png') },
        { path: 'shot/tex/kd.png', data: new Blob(['x']) },
    ];
    const fileByPath = new Map(entries.map((e) => [e.path, e]));
    const basenameIndex = new Map([['kd.png', ['__abs/L/lib/kd.png', 'shot/tex/kd.png']]]);
    assert.equal(resolveAbsFsRef('l:/lib/kd.png', absIndexOf(entries), fileByPath.keys()), '__abs/L/lib/kd.png');
    assert.equal(resolveMtlTexturePath({ path: 'L:\\lib\\kd.png' }, 'shot', 'shot', fileByPath, basenameIndex), '__abs/L/lib/kd.png');
    assert.equal(resolveMtlTexturePath({ path: 'tex/kd.png' }, 'shot', 'shot', fileByPath, basenameIndex), 'shot/tex/kd.png');
    assert.equal(resolveMtlTexturePath({ path: 'Z:/proj/shot/tex/kd.png' }, 'shot', 'shot', fileByPath, basenameIndex), 'shot/tex/kd.png', 'suffix match');
    assert.equal(resolveMtllibPath('L:/lib/kd.png', 'shot', fileByPath, basenameIndex), '__abs/L/lib/kd.png');
    assert.equal(resolveScenePath('L:/lib/kd.png', 'shot', 'shot', fileByPath), '__abs/L/lib/kd.png');
    const bin = { path: '__unc/srv/share/m.bin', data: Object.assign(new Blob([new Uint8Array([1, 2, 3, 4])]), { __mtlxAbsPath: '//srv/share/m.bin' }) };
    const binMap = new Map([[bin.path, bin]]);
    const buffers = await resolveGltfBuffers([{ uri: '\\\\srv\\share\\m.bin', byteLength: 4 }], { rootDir: 'shot', fileByPath: binMap, fileByBasename: new Map() });
    assert.deepEqual(Array.from(buffers[0]), [1, 2, 3, 4]);
});

// VS Code keeps its earlier behaviour: no absolute-ref matching anywhere.
test('VS Code host: L:/proj/tex/a.png does not resolve to tex/a.png and absolute refs are not rewritten', () => {
    const context = { host: { absoluteFsRefs: () => false } };
    vm.runInNewContext(['normPath', 'joinRefPath', 'findFileForRef', 'findFilesForRef'].map((n) => extract(CORE, n)).join('\n')
        + '\nthis.api = { joinRefPath, findFileForRef, findFilesForRef };', context);
    const { joinRefPath, findFileForRef } = context.api;
    assert.equal(findFileForRef({ 'tex/a.png': 1 }, 'L:/proj/tex/a.png', { exact: true }), null);
    assert.equal(findFileForRef({ 'tex/a.png': 1 }, 'L:/proj/tex/a.png', { exact: true, absoluteFsRefs: true }).key, 'tex/a.png', 'option overrides the host');
    assert.equal(joinRefPath('scene', '//srv/share/a.png'), 'scene/srv/share/a.png', 'earlier joinRefPath result');
    assert.equal(joinRefPath('scene', 'L:/a.png'), 'scene/L:/a.png');

    const start = RENDERER.indexOf('const sceneArray =');
    const end = RENDERER.indexOf('const sceneMatrix =', start);
    const win = Object.assign(engine(), { __MTLX_VSCODE__: true });
    const rc = { Blob, Math, String, Object, Set, window: win };
    vm.runInNewContext(RENDERER.slice(start, end) + '\nthis.api = { sceneFileMap, canonicalizeSceneFilenameInputs };', rc);
    const out = rc.api.canonicalizeSceneFilenameInputs('<materialx><input name="file" type="filename" value="L:\tex\a.png" /></materialx>', 'shot/doc.mtlx', {}, true);
    assert.ok(out.includes('value="L:\tex\a.png"'), out);

    globalThis.__MTLX_VSCODE__ = true;
    try {
        assert.ok(!isAbsoluteFsRef('L:/a.png'));
        const entries = [{ path: 'a/tex/kd.png', data: new Blob(['x']) }, { path: 'b/tex/kd.png', data: new Blob(['x']) }];
        const fileByPath = new Map(entries.map((e) => [e.path, e]));
        const basenameIndex = new Map([['kd.png', ['a/tex/kd.png', 'b/tex/kd.png']]]);
        assert.equal(resolveMtlTexturePath({ path: 'Z:/proj/a/tex/kd.png' }, 'shot', 'shot', fileByPath, basenameIndex), null);
    } finally {
        delete globalThis.__MTLX_VSCODE__;
    }
});
