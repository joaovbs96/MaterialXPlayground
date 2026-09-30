// Exercises the pure docsPanelColumn() helper in extension.js (task 4).
// extension.js requires('vscode') transitively, so the helper is
// extracted verbatim and run against a minimal fake vscode instead.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXTENSION_JS = path.join(REPO_ROOT, 'vscode_extension', 'src', 'extension.js');

// Slices a `const <name> = (...) => { ... };` declaration by brace-matching
// from its arrow body's first '{'.
function extractConstArrow(src, name) {
    const re = new RegExp('(?:^|\\n)(\\s*)const\\s+' + name + '\\s*=\\s*\\(');
    const m = re.exec(src);
    assert.ok(m, 'expected to find const ' + name + ' in extension.js');
    const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
    const braceIdx = src.indexOf('{', m.index);
    let depth = 0;
    let end = braceIdx;
    for (; end < src.length; end++) {
        if (src[end] === '{') depth++;
        else if (src[end] === '}') {
            depth--;
            if (depth === 0) { end++; break; }
        }
    }
    if (src[end] === ';') end++;
    return src.slice(start, end);
}

const extSrc = fs.readFileSync(EXTENSION_JS, 'utf8');

function buildSandbox(activeTextEditor) {
    const fakeVscode = {
        ViewColumn: { Active: -1, Beside: -2 },
        window: { activeTextEditor },
    };
    const sandbox = { vscode: fakeVscode };
    vm.createContext(sandbox);
    vm.runInContext(
        extractConstArrow(extSrc, 'docsPanelColumn') + '\n' +
        'this.docsPanelColumn = docsPanelColumn;\n',
        sandbox
    );
    return sandbox.docsPanelColumn;
}

test('docsPanelColumn: no editor, not from a hover link -> Active', () => {
    const docsPanelColumn = buildSandbox(undefined);
    assert.equal(docsPanelColumn(false), -1);
});

test('docsPanelColumn: no editor, from a hover link -> Beside', () => {
    const docsPanelColumn = buildSandbox(undefined);
    assert.equal(docsPanelColumn(true), -2);
});

test('docsPanelColumn: a focused .mtlx text editor -> Beside, even with no hover link', () => {
    const docsPanelColumn = buildSandbox({ document: { languageId: 'mtlx' } });
    assert.equal(docsPanelColumn(false), -2);
});

test('docsPanelColumn: a focused non-mtlx text editor, no hover link -> Active', () => {
    const docsPanelColumn = buildSandbox({ document: { languageId: 'plaintext' } });
    assert.equal(docsPanelColumn(false), -1);
});
