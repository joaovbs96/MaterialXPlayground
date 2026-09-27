// outlineModel.js: pure (no vscode) tree-building logic behind the
// Outline view (outlineView.js is the thin TreeDataProvider wrapper over
// this, same split as mtlxSymbols.js/symbolProviders.js). Builds a flat
// id-addressable tree from mtlxSymbols.buildDocumentSymbols so the
// TreeDataProvider's getParent/reveal-by-id and the "follow cursor"
// deepest-symbol lookup are both plain data operations, independently
// testable with fixture strings.
'use strict';

const mtlxSymbols = require('./mtlxSymbols');

// Maps a document-symbol kind (mtlxSymbols.js's toSymbol) to a
// ThemeIcon name (outlineView.js turns this into vscode.ThemeIcon).
const KIND_ICONS = {
    nodegraph: 'symbol-class',
    nodedef: 'symbol-class',
    node: 'symbol-method',
    input: 'symbol-field',
    output: 'symbol-interface',
    look: 'symbol-namespace',
};

function iconForKind(kind) {
    return KIND_ICONS[kind] || 'symbol-misc';
}

// Stable ids are an element-name path ("NG_main/tinted/in1"), unique per
// sibling group via a ":N" suffix on a name collision (rare: MaterialX
// requires unique names within one scope, but the tolerant scanner may
// still see a duplicate mid-edit).
function uniqueId(base, usedAtLevel) {
    if (!usedAtLevel.has(base)) {
        usedAtLevel.add(base);
        return base;
    }
    let n = 2;
    while (usedAtLevel.has(base + ':' + n)) n++;
    const id = base + ':' + n;
    usedAtLevel.add(id);
    return id;
}

function toNode(sym, parentId, usedAtLevel, byId) {
    const id = uniqueId((parentId ? parentId + '/' : '') + sym.name, usedAtLevel);
    const node = {
        id,
        parentId: parentId || null,
        name: sym.name,
        detail: sym.detail,
        kind: sym.kind,
        range: sym.range,
        selectionRange: sym.selectionRange,
        children: [],
    };
    byId.set(id, node);
    const childUsed = new Set();
    node.children = sym.children.map((c) => toNode(c, id, childUsed, byId));
    return node;
}

// buildOutlineTree(text) -> { roots: OutlineNode[], byId: Map<string, OutlineNode> }
function buildOutlineTree(text) {
    const { root } = mtlxSymbols.scanElements(text);
    const symbols = mtlxSymbols.buildDocumentSymbols(root);
    const byId = new Map();
    const usedTop = new Set();
    const roots = symbols.map((s) => toNode(s, null, usedTop, byId));
    return { roots, byId };
}

function posLte(a, b) {
    return a.line === b.line ? a.character <= b.character : a.line < b.line;
}
function inRange(range, pos) {
    return posLte(range.start, pos) && posLte(pos, range.end);
}

// Deepest node (recursive) whose range contains `pos`, or null. Sibling
// ranges never overlap in a well-formed tree, so the first containing
// root/child found is the only possible branch to descend into.
function findDeepestAt(nodes, pos) {
    for (const node of nodes) {
        if (inRange(node.range, pos)) {
            return findDeepestAt(node.children, pos) || node;
        }
    }
    return null;
}

// pathAt(text, pos) -> id string of the deepest symbol containing `pos`,
// or null. `pos` is a plain {line, character}, same shape mtlxSymbols.js
// uses everywhere else.
function pathAt(text, pos) {
    const { roots } = buildOutlineTree(text);
    const hit = findDeepestAt(roots, pos);
    return hit ? hit.id : null;
}

module.exports = {
    buildOutlineTree,
    findDeepestAt,
    pathAt,
    iconForKind,
};
