// mtlxDocSkeleton.js: pure (no vscode) helper behind newDocument.js.
// Reads vscode_extension/language/mtlx.snippets.json's own "MaterialX
// Document" body (the mtlxdoc prefix snippet) instead of retyping the
// skeleton: that body's <materialx version="..."> literal is stamped by
// scripts/lib/version.mjs's STAMP_TABLE, so reusing it verbatim means
// nothing here ever hand-types a MaterialX version.
'use strict';

const fs = require('fs');
const path = require('path');

const SNIPPETS_REL_PATH = 'vscode_extension/language/mtlx.snippets.json';
const SNIPPET_NAME = 'MaterialX Document';

// readSkeletonBody(repoRoot) -> the snippet body joined into the plain
// multi-line snippet-syntax string editor.insertSnippet expects (its "$0"
// tab stop lands the cursor inside the root element).
function readSkeletonBody(repoRoot) {
    const filePath = path.join(repoRoot, ...SNIPPETS_REL_PATH.split('/'));
    const snippets = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const entry = snippets[SNIPPET_NAME];
    if (!entry || !Array.isArray(entry.body)) {
        throw new Error('"' + SNIPPET_NAME + '" snippet not found in ' + SNIPPETS_REL_PATH);
    }
    return entry.body.join('\n');
}

module.exports = { readSkeletonBody, SNIPPETS_REL_PATH, SNIPPET_NAME };
