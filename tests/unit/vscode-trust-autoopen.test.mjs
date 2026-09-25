// Exercises the pure isMtlxAutoOpenTarget/isSceneAutoOpenTarget guards in
// extension.js (used by maybeAutoOpen/maybeAutoOpenSceneText AND by
// rescanAutoOpenAfterTrust's onDidGrantWorkspaceTrust rescan) against
// plain document descriptors, with no real vscode host involved.
// extension.js itself requires('vscode') at module scope (transitively,
// through editorProvider.js and friends), so it can't be require()'d
// directly here, instead the two function declarations are extracted
// verbatim from the committed source and evaluated in isolation, the
// same technique the sig-link test uses for the browser-side docs files.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXTENSION_JS = path.join(REPO_ROOT, 'vscode_extension', 'src', 'extension.js');

// Slices out a single top-level `function <name>(...) {...}` declaration
// by brace-matching from its first '{', so the test always exercises the
// REAL committed implementation rather than a hand-copied duplicate that
// could silently drift from it.
function extractFunction(src, name) {
    const re = new RegExp('(?:^|\\n)function\\s+' + name + '\\s*\\(');
    const m = re.exec(src);
    assert.ok(m, 'expected to find function ' + name + ' in extension.js');
    const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
    let i = start;
    while (src[i] !== '{') i++;
    let depth = 0;
    let end = i;
    for (; end < src.length; end++) {
        if (src[end] === '{') depth++;
        else if (src[end] === '}') {
            depth--;
            if (depth === 0) { end++; break; }
        }
    }
    return src.slice(start, end);
}

const extSrc = fs.readFileSync(EXTENSION_JS, 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
    extractFunction(extSrc, 'isMtlxAutoOpenTarget') + '\n' +
    extractFunction(extSrc, 'isSceneAutoOpenTarget') + '\n' +
    'this.isMtlxAutoOpenTarget = isMtlxAutoOpenTarget;\n' +
    'this.isSceneAutoOpenTarget = isSceneAutoOpenTarget;\n',
    sandbox
);
const { isMtlxAutoOpenTarget, isSceneAutoOpenTarget } = sandbox;

function doc(uriStr, languageId) {
    return { uri: { scheme: uriStr.split(':')[0], toString: () => uriStr }, languageId };
}

test('isMtlxAutoOpenTarget: accepts a file-scheme mtlx document not yet opened', () => {
    const opened = new Set();
    assert.equal(isMtlxAutoOpenTarget(doc('file:///a/b.mtlx', 'mtlx'), opened), true);
});

test('isMtlxAutoOpenTarget: rejects non-mtlx languageId, non-file scheme, and already-opened uris', () => {
    const opened = new Set(['file:///seen.mtlx']);
    assert.equal(isMtlxAutoOpenTarget(doc('file:///a.txt', 'plaintext'), opened), false);
    assert.equal(isMtlxAutoOpenTarget(doc('untitled:Untitled-1', 'mtlx'), opened), false);
    assert.equal(isMtlxAutoOpenTarget(doc('file:///seen.mtlx', 'mtlx'), opened), false);
    assert.equal(isMtlxAutoOpenTarget(null, opened), false);
    assert.equal(isMtlxAutoOpenTarget({ uri: null, languageId: 'mtlx' }, opened), false);
});

test('isSceneAutoOpenTarget: accepts a file-scheme scene document not yet opened', () => {
    const opened = new Set();
    const isSceneUri = (uri) => /\.usda$/.test(uri.path || '');
    assert.equal(isSceneAutoOpenTarget({ uri: { scheme: 'file', path: '/a/scene.usda', toString: () => 'file:///a/scene.usda' } }, opened, isSceneUri), true);
});

test('isSceneAutoOpenTarget: rejects non-scene documents and re-scan duplicates', () => {
    const opened = new Set(['file:///seen.usda']);
    const isSceneUri = (uri) => /\.usda$/.test(uri.path || '');
    const notScene = { uri: { scheme: 'file', path: '/a/b.mtlx', toString: () => 'file:///a/b.mtlx' } };
    assert.equal(isSceneAutoOpenTarget(notScene, opened, isSceneUri), false);
    const alreadySeen = { uri: { scheme: 'file', path: '/seen.usda', toString: () => 'file:///seen.usda' } };
    assert.equal(isSceneAutoOpenTarget(alreadySeen, opened, isSceneUri), false);
});

// Simulates rescanAutoOpenAfterTrust's own loop: given several open
// documents (mirroring vscode.workspace.textDocuments, i.e. ALL open
// text docs, not just the visible/active one), only the qualifying,
// not-yet-opened ones are picked, and picking twice never re-picks the
// same uri once it's marked opened, the "do not open duplicates" rule
// the trust rescan depends on.
test('rescan-shaped loop: picks every unopened candidate once, across mtlx and scene docs, skips the rest', () => {
    const openedMtlx = new Set();
    const openedScene = new Set();
    const isSceneUri = (uri) => /\.usda$/.test(uri.path || '');
    const docs = [
        doc('file:///active-trust-editor', undefined), // the Workspace Trust editor itself
        doc('file:///background.mtlx', 'mtlx'),        // background tab, never focused
        { uri: { scheme: 'file', path: '/scene.usda', toString: () => 'file:///scene.usda' } },
        doc('untitled:Untitled-1', 'mtlx'),             // unsaved, not a real file
    ];

    const picked = [];
    for (const d of docs) {
        if (isMtlxAutoOpenTarget(d, openedMtlx)) { openedMtlx.add(d.uri.toString()); picked.push(d.uri.toString()); }
        if (isSceneAutoOpenTarget(d, openedScene, isSceneUri)) { openedScene.add(d.uri.toString()); picked.push(d.uri.toString()); }
    }
    assert.deepEqual(picked.sort(), ['file:///background.mtlx', 'file:///scene.usda']);

    // A second rescan pass (e.g. a redundant event) must not re-pick.
    const pickedAgain = [];
    for (const d of docs) {
        if (isMtlxAutoOpenTarget(d, openedMtlx)) pickedAgain.push(d.uri.toString());
        if (isSceneAutoOpenTarget(d, openedScene, isSceneUri)) pickedAgain.push(d.uri.toString());
    }
    assert.deepEqual(pickedAgain, []);
});
