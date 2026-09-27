// insertNodeModel.js: pure position/list logic behind the Insert Node view
// (insertNodeView.js), no vscode dependency, same "pure module behind a
// thin vscode command" split as filePicker.js/mtlxCompletions.js.
'use strict';

// True when `offset` sits inside an already-typed opening tag (after its
// '<' and tag name, up to but not including the closing '>'): the last
// '<' before offset comes after the last '>' before offset.
function isInsideOpenTag(text, offset) {
    const lastOpen = text.lastIndexOf('<', offset - 1);
    const lastClose = text.lastIndexOf('>', offset - 1);
    return lastOpen > lastClose;
}

// Leading whitespace run of the line containing `offset`.
function lineIndent(text, offset) {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const m = /^[ \t]*/.exec(text.slice(lineStart));
    return m ? m[0] : '';
}

// Where a freshly inserted node snippet should land: at the cursor, or
// pushed to the start of the NEXT line (same indentation) when the cursor
// is inside an open start tag or between its attributes -- inserting a
// full element there would otherwise land mid-attribute-list.
function insertPlan(text, offset) {
    if (!isInsideOpenTag(text, offset)) return { mode: 'cursor', offset, prefix: '', indent: '', suffix: '' };
    const indent = lineIndent(text, offset);
    const lineEnd = text.indexOf('\n', offset);
    if (lineEnd === -1) return { mode: 'next-line', offset: text.length, prefix: '\n', indent, suffix: '' };
    return { mode: 'next-line', offset: lineEnd + 1, prefix: '', indent, suffix: '\n' };
}

// Every `name="..."` attribute value found anywhere in `text`, for keeping
// a freshly-inserted snippet's default name unique document-wide. A plain
// regex (not the tolerant element scanner mtlxCompletions.js uses
// internally, which isn't exported) is precise enough for this purpose.
function allNamesInText(text) {
    const names = new Set();
    const re = /\bname\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(text)) !== null) names.add(m[1]);
    return names;
}

// The output types present across every category in a library index (the
// Insert Node view's type filter options), sorted, deduped.
function outputTypesInIndex(index) {
    const types = new Set();
    for (const entry of index.categories.values()) {
        for (const t of entry.outputTypes) types.add(t);
    }
    return Array.from(types).sort();
}

// One row per node category: {name, library, outputTypes}, sorted by name.
function allCategoryRows(index) {
    const rows = [];
    for (const [name, entry] of index.categories) {
        rows.push({ name, library: entry.library, outputTypes: entry.outputTypes.slice() });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
}

module.exports = { isInsideOpenTag, lineIndent, insertPlan, allNamesInText, outputTypesInIndex, allCategoryRows };
