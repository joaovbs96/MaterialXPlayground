// Exercises the pure formatStatusBar() helper in extension.js (S).
// extension.js requires('vscode') transitively, so it can't be require()'d
// here; the function is extracted verbatim and run in isolation instead.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

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

const extSrc = fs.readFileSync(EXTENSION_JS, 'utf8');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(
    extractFunction(extSrc, 'formatStatusBar') + '\n' +
    'this.formatStatusBar = formatStatusBar;\n',
    sandbox
);
const { formatStatusBar } = sandbox;

test('formatStatusBar: no issues shows a check icon and no counts', () => {
    const { icon, text, tooltip } = formatStatusBar(0, 0, []);
    assert.equal(icon, '$(check)');
    assert.equal(text, '$(check) MaterialX Playground');
    assert.equal(tooltip, 'No MaterialX validation issues.');
});

test('formatStatusBar: one error, singular wording, error icon wins over warning', () => {
    const { icon, text } = formatStatusBar(1, 2, []);
    assert.equal(icon, '$(error)');
    assert.equal(text, '$(error) MaterialX Playground: 1 error, 2 warnings');
});

test('formatStatusBar: only warnings shows a warning icon, plural wording', () => {
    const { icon, text } = formatStatusBar(0, 1, []);
    assert.equal(icon, '$(warning)');
    assert.equal(text, '$(warning) MaterialX Playground: 1 warning');
});

test('formatStatusBar: plural errors, no warnings', () => {
    const { text } = formatStatusBar(3, 0, []);
    assert.equal(text, '$(error) MaterialX Playground: 3 errors');
});

test('formatStatusBar: tooltip lists up to 3 issues with an ellipsis for the rest', () => {
    const { tooltip } = formatStatusBar(4, 0, ['a', 'b', 'c', 'd']);
    assert.equal(tooltip, 'MaterialX Playground: 4 errors:\n• a\n• b\n• c\n…');
    assert.ok(!tooltip.includes('—'), 'tooltip must not contain an em-dash');
});

test('formatStatusBar: tooltip with 3 or fewer issues has no trailing ellipsis', () => {
    const { tooltip } = formatStatusBar(2, 0, ['a', 'b']);
    assert.equal(tooltip, 'MaterialX Playground: 2 errors:\n• a\n• b');
});
