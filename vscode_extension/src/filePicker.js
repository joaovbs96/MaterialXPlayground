// filePicker.js: pure (no vscode) path math behind materialxPlayground.
// pickFile (E10b), registered in extension.js. Computing the value a
// completion's "Browse for file..." item writes into a filename= attribute
// is plain path arithmetic, so it lives here, independently testable,
// same "pure module behind a thin vscode command" split as
// mtlxCompletions.js/completionProvider.js.
'use strict';

const path = require('path');

function toPosix(p) {
    return String(p).replace(/\\/g, '/');
}

// computeFilePathValue(documentUri, pickedFsPath) -> the string to write
// into a filename= value: for an untitled document (no folder of its own),
// the picked file's absolute path in POSIX form; otherwise the picked
// file's path relative to the document's own folder, POSIX form, no
// leading "./" (but "../" kept when the picked file is outside that
// folder). `documentUri` only needs `.scheme` and `.fsPath` (a real
// vscode.Uri satisfies this; a plain object is enough for tests).
function computeFilePathValue(documentUri, pickedFsPath) {
    if (!documentUri || documentUri.scheme === 'untitled') {
        return toPosix(pickedFsPath);
    }
    const dir = path.dirname(documentUri.fsPath);
    const rel = path.relative(dir, pickedFsPath);
    return toPosix(rel);
}

module.exports = { computeFilePathValue };
