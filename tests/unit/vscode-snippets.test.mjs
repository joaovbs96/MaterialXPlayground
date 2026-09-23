// Validates every body in vscode_extension/language/mtlx.snippets.json by
// expanding its tab stops with their placeholder defaults, wrapping bare
// fragments in a <materialx> root, and parsing the result with the real
// MaterialX WASM through mtlxNode.js (plain Node, no vscode), the same
// module extension.js's live diagnostics run through. A snippet that no
// longer parses as valid MaterialX is a real regression, not a style nit.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mtlxNode = require('../../vscode_extension/src/mtlxNode.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SNIPPETS_PATH = path.join(REPO_ROOT, 'vscode_extension', 'language', 'mtlx.snippets.json');

const snippets = JSON.parse(fs.readFileSync(SNIPPETS_PATH, 'utf8'));

// Expands VS Code snippet tab-stop syntax to its default (placeholder)
// text: "${N:default}" -> "default", "${N}"/bare "$N" -> "" (no default).
// Good enough for our own snippets (no nested placeholders, no
// transforms/choices), not a general snippet-syntax parser.
function expandBody(body) {
    let s = Array.isArray(body) ? body.join('\n') : body;
    s = s.replace(/\$\{\d+:([^{}]*)\}/g, '$1');
    s = s.replace(/\$\{\d+\}/g, '');
    s = s.replace(/\$\d+/g, '');
    return s;
}

// Most snippets are FRAGMENTS meant to be pasted inside an existing
// document, not full documents themselves: wrap those in a minimal
// <materialx> root so the WASM has a real document to parse. A snippet
// whose expansion already starts a document (the "MaterialX Document"
// skeleton) is left as-is.
function wrapIfFragment(expanded) {
    if (/<materialx[\s>]/.test(expanded)) return expanded;
    return '<?xml version="1.0"?>\n<materialx version="1.39">\n' + expanded + '\n</materialx>\n';
}

// "Nodegraph with Output" is the one snippet whose default expansion is
// EXPECTED to fail semantic validation: its $2 tab stop (where real nodes
// go) is empty by default, so the output's nodename="node1" placeholder
// dangles on purpose: that's a placeholder for the user to fill in, not a
// bug. Every other snippet should validate completely clean.
const EXPECTED_DANGLING_REF = new Set(['Nodegraph with Output']);

for (const [name, snip] of Object.entries(snippets)) {
    test(`snippet "${name}" parses as valid MaterialX`, async () => {
        assert.ok(snip.prefix, `${name}: missing "prefix"`);
        assert.ok(snip.body, `${name}: missing "body"`);

        const expanded = expandBody(snip.body);
        const doc = wrapIfFragment(expanded);
        const result = await mtlxNode.validateSemantic(REPO_ROOT, doc);

        assert.equal(result.available, true, `${name}: MaterialX WASM unavailable, cannot validate`);
        const parseFailures = result.messages.filter((m) => m.text.startsWith('MaterialX could not parse the document'));
        assert.deepEqual(parseFailures, [], `${name}: failed to parse: ${JSON.stringify(parseFailures)}`);

        if (!EXPECTED_DANGLING_REF.has(name)) {
            assert.deepEqual(result.messages, [], `${name}: unexpected validation messages: ${JSON.stringify(result.messages)}`);
        }
    });
}

test('mtlx.snippets.json: every prefix is unique', () => {
    const prefixes = Object.values(snippets).map((s) => s.prefix);
    assert.equal(new Set(prefixes).size, prefixes.length, 'duplicate snippet prefix');
});
