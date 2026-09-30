// Validates the remaining static snippets in
// vscode_extension/language/mtlx.snippets.json (just "mtlxdoc" now, see
// mtlxCompletions.js's DOC_SNIPPETS for the rest, E6) plus the completion-
// item-based document snippets themselves: expands tab stops with their
// placeholder defaults, wraps bare fragments in a <materialx> root, and
// parses the result with the real MaterialX WASM through mtlxNode.js
// (plain Node, no vscode), the same module extension.js's live
// diagnostics run through. A snippet that no longer parses as valid
// MaterialX is a real regression, not a style nit.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mtlxNode = require('../../vscode_extension/src/mtlxNode.js');
const mtlxCompletions = require('../../vscode_extension/src/mtlxCompletions.js');
const { scanElements } = require('../../vscode_extension/src/mtlxSymbols.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SNIPPETS_PATH = path.join(REPO_ROOT, 'vscode_extension', 'language', 'mtlx.snippets.json');

const snippets = JSON.parse(fs.readFileSync(SNIPPETS_PATH, 'utf8'));

// Expands VS Code snippet tab-stop syntax to its default (placeholder)
// text: "${N:default}" -> "default", "${N}"/bare "$N" -> "" (no default).
// Good enough for our own snippets (no nested placeholders, no
// transforms), not a general snippet-syntax parser.
function expandBody(body) {
    let s = Array.isArray(body) ? body.join('\n') : body;
    s = s.replace(/\$\{\d+:([^{}]*)\}/g, '$1');
    s = s.replace(/\$\{\d+\|([^{}|]*)\|\}/g, (m, choices) => choices.split(',')[0]);
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

for (const [name, snip] of Object.entries(snippets)) {
    test(`static snippet "${name}" parses as valid MaterialX`, async () => {
        assert.ok(snip.prefix, `${name}: missing "prefix"`);
        assert.ok(snip.body, `${name}: missing "body"`);

        const expanded = expandBody(snip.body);
        const doc = wrapIfFragment(expanded);
        const result = await mtlxNode.validateSemantic(REPO_ROOT, doc);

        assert.equal(result.available, true, `${name}: MaterialX WASM unavailable, cannot validate`);
        const parseFailures = result.messages.filter((m) => m.text.startsWith('MaterialX could not parse the document'));
        assert.deepEqual(parseFailures, [], `${name}: failed to parse: ${JSON.stringify(parseFailures)}`);
        assert.deepEqual(result.messages, [], `${name}: unexpected validation messages: ${JSON.stringify(result.messages)}`);
    });
}

test('mtlx.snippets.json: only mtlxdoc remains (the rest moved to completion items, E6)', () => {
    assert.deepEqual(Object.keys(snippets), ['MaterialX Document']);
    assert.deepEqual(Object.values(snippets).map((s) => s.prefix), ['mtlxdoc']);
});

test('mtlx.snippets.json: no "input" snippet (removed by E6)', () => {
    const prefixes = Object.values(snippets).map((s) => s.prefix);
    assert.ok(!prefixes.includes('input'));
});

test('DOC_SNIPPETS: prefixes are unique and none collide with the static file', () => {
    const docPrefixes = mtlxCompletions.DOC_SNIPPETS.map((s) => s.prefix);
    assert.equal(new Set(docPrefixes).size, docPrefixes.length, 'duplicate doc-snippet prefix');
    const staticPrefixes = new Set(Object.values(snippets).map((s) => s.prefix));
    for (const p of docPrefixes) assert.ok(!staticPrefixes.has(p), `"${p}" collides with a static snippet prefix`);
});

test('documentSnippetItems: default names on an empty document match the original static defaults', () => {
    const { root } = scanElements('<materialx version="1.39">\n</materialx>\n');
    const items = mtlxCompletions.documentSnippetItems(root);
    const surface = items.find((i) => i.prefix === 'standard_surface');
    assert.match(surface.insertText, /name="\$\{1:SR_surface\}"/);
    assert.match(surface.insertText, /name="\$\{5:M_surface\}"/);
    // The nodename= reference to the shader must use the SAME unique name
    // as the shader node itself (both are tab stop 1).
    assert.match(surface.insertText, /nodename="\$\{1:SR_surface\}"/);
});

test('documentSnippetItems: renumbers when the default name already exists in the document', () => {
    const { root } = scanElements(
        '<materialx version="1.39">\n  <standard_surface name="SR_surface" type="surfaceshader" />\n</materialx>\n'
    );
    const items = mtlxCompletions.documentSnippetItems(root);
    const surface = items.find((i) => i.prefix === 'standard_surface');
    assert.match(surface.insertText, /name="\$\{1:SR_surface2\}"/);
    assert.match(surface.insertText, /nodename="\$\{1:SR_surface2\}"/);
    // The unrelated M_surface default is untouched (no collision for it).
    assert.match(surface.insertText, /name="\$\{5:M_surface\}"/);
});

test('documentSnippetItems: every generated snippet parses as valid MaterialX (fresh document, no collisions)', async () => {
    const { root } = scanElements('<materialx version="1.39">\n</materialx>\n');
    for (const item of mtlxCompletions.documentSnippetItems(root)) {
        const expanded = expandBody(item.insertText);
        const doc = wrapIfFragment(expanded);
        const result = await mtlxNode.validateSemantic(REPO_ROOT, doc);
        assert.equal(result.available, true, `${item.prefix}: MaterialX WASM unavailable, cannot validate`);
        const parseFailures = result.messages.filter((m) => m.text.startsWith('MaterialX could not parse the document'));
        assert.deepEqual(parseFailures, [], `${item.prefix}: failed to parse: ${JSON.stringify(parseFailures)}`);
        if (item.prefix !== 'nodegraph') {
            // "nodegraph"'s own $2 tab stop (where real nodes go) is empty
            // by default, so its output's nodename="node1" placeholder
            // dangles on purpose, same as the old static snippet did.
            assert.deepEqual(result.messages, [], `${item.prefix}: unexpected validation messages: ${JSON.stringify(result.messages)}`);
        }
    }
});

test('uniqueName: base name, else smallest free numeric suffix starting at 2', () => {
    assert.equal(mtlxCompletions.uniqueName('foo', new Set()), 'foo');
    assert.equal(mtlxCompletions.uniqueName('foo', new Set(['foo'])), 'foo2');
    assert.equal(mtlxCompletions.uniqueName('foo', new Set(['foo', 'foo2'])), 'foo3');
    assert.equal(mtlxCompletions.uniqueName('foo', new Set(['foo', 'foo3'])), 'foo2');
});
