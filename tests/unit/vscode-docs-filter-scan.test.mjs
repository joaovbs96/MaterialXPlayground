// Exercises extension.js's categoriesFromMtlxText (W1: the docs panel's
// file-based filter) against the REAL committed implementation, extracted
// verbatim from source (extension.js can't be require()'d directly -- see
// vscode-trust-autoopen.test.mjs's comment for why -- same brace-matching
// technique, plus the DOCS_FILTER_STRUCTURAL_TAGS const it depends on).
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXTENSION_JS = path.join(REPO_ROOT, 'vscode_extension', 'src', 'extension.js');

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

function extractConst(src, name) {
    const re = new RegExp('const\\s+' + name + '\\s*=\\s*new Set\\(\\[[\\s\\S]*?\\]\\);');
    const m = re.exec(src);
    assert.ok(m, 'expected to find const ' + name + ' in extension.js');
    return m[0];
}

const extSrc = fs.readFileSync(EXTENSION_JS, 'utf8');
// Run in THIS realm (not a separate vm context) so the returned arrays are
// ordinary same-realm Arrays -- a vm.createContext sandbox's Array is a
// different realm's constructor and trips assert.deepEqual's identity checks.
const mtlxSymbols = require('../../vscode_extension/src/mtlxSymbols.js');
const categoriesFromMtlxText = vm.runInThisContext(
    '(function (mtlxSymbols) {\n' +
    extractConst(extSrc, 'DOCS_FILTER_STRUCTURAL_TAGS') + '\n' +
    extractFunction(extSrc, 'categoriesFromMtlxText') + '\n' +
    'return categoriesFromMtlxText;\n' +
    '})'
)(mtlxSymbols);

test('categoriesFromMtlxText returns node category tags, excluding structural elements', () => {
    const xml = `<?xml version="1.0"?>
<materialx version="1.39">
  <nodegraph name="NG_main">
    <standard_surface name="surf" type="surfaceshader">
      <input name="base_color" type="color3" nodename="tex" />
    </standard_surface>
    <image name="tex" type="color3">
      <input name="file" type="filename" value="a.png" />
    </image>
    <output name="out" type="surfaceshader" nodename="surf" />
  </nodegraph>
</materialx>`;
    const cats = categoriesFromMtlxText(xml).sort();
    assert.deepEqual(cats, ['image', 'standard_surface']);
});

test('categoriesFromMtlxText excludes structural/plumbing tags entirely', () => {
    const xml = '<materialx><nodedef name="x"/><typedef name="y"/><look name="z"/></materialx>';
    assert.deepEqual(categoriesFromMtlxText(xml), []);
});

test('categoriesFromMtlxText tolerates malformed/in-progress text', () => {
    assert.doesNotThrow(() => categoriesFromMtlxText('<materialx><standard_su'));
    assert.deepEqual(categoriesFromMtlxText(''), []);
    assert.deepEqual(categoriesFromMtlxText(null), []);
});

test('categoriesFromMtlxText dedupes repeated categories', () => {
    const xml = '<materialx><image name="a"/><image name="b"/></materialx>';
    assert.deepEqual(categoriesFromMtlxText(xml), ['image']);
});
