// Exercises mtlxDocSkeleton.js's readSkeletonBody() -- pure aside from a
// synchronous fs.readFileSync of the real, committed mtlx.snippets.json --
// no vscode module involved (newDocument.js is the thin vscode command
// wrapper that isn't exercised here, same split as mtlxCompletions.js/
// completionProvider.js). The point of this module is that it NEVER
// hand-types a MaterialX version: it reuses mtlx.snippets.json's own
// "MaterialX Document" body, which scripts/lib/version.mjs's STAMP_TABLE
// keeps in sync, so this test asserts the skeleton is read from THAT file
// rather than re-typed here.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mtlxDocSkeleton = require('../../vscode_extension/src/mtlxDocSkeleton.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('readSkeletonBody: matches the mtlxdoc snippet body from mtlx.snippets.json verbatim', () => {
    const snippets = JSON.parse(
        fs.readFileSync(path.join(REPO_ROOT, 'vscode_extension/language/mtlx.snippets.json'), 'utf8')
    );
    const expected = snippets['MaterialX Document'].body.join('\n');
    assert.equal(mtlxDocSkeleton.readSkeletonBody(REPO_ROOT), expected);
});

test('readSkeletonBody: skeleton has the XML declaration, a versioned root and a $0 tab stop', () => {
    const body = mtlxDocSkeleton.readSkeletonBody(REPO_ROOT);
    assert.match(body, /^<\?xml version="1\.0"\?>/);
    assert.match(body, /<materialx version="\d+\.\d+" colorspace="lin_rec709">/);
    assert.match(body, /\$0/);
    assert.match(body, /<\/materialx>/);
});

test('readSkeletonBody: throws when the snippets file cannot be found', () => {
    assert.throws(() => mtlxDocSkeleton.readSkeletonBody(path.join(REPO_ROOT, 'vscode_extension')));
});
