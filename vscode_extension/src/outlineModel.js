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
        tag: sym.tag,
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

// Selection sync (E18). Paths are Outline ids ("NG_main/tinted/in1"); '' is
// the document root. syncPathAt is pathAt plus '' when the cursor sits on
// the <materialx> start line, so blank lines between elements stay inert.
function syncPathAt(text, pos) {
    const hit = pathAt(text, pos);
    if (hit) return hit;
    const top = mtlxSymbols.materialxRoot(mtlxSymbols.scanElements(text).root);
    return top && top.tag === 'materialx' && top.range.start.line === pos.line ? '' : null;
}

function isMaterialNode(node) {
    return node.kind === 'node' && (/material$/.test(node.tag || '') || / : material$/.test(node.detail || ''));
}

function ancestry(tree, node) {
    const chain = [];
    for (let cur = node; cur; cur = cur.parentId ? tree.byId.get(cur.parentId) : null) chain.unshift(cur);
    return chain;
}

// Outline path -> Graph Editor target { scope, id } (scope '' = document
// root, else a top-level nodegraph); inputs resolve to their owning node,
// the root to the first material. null when the graph shows no such card.
function graphTargetForPath(tree, nodePath) {
    if (nodePath === '' || nodePath == null) {
        const mat = tree.roots.find(isMaterialNode);
        return mat ? { scope: '', id: 'n:' + mat.name } : null;
    }
    const node = tree.byId.get(nodePath);
    if (!node) return null;
    const chain = ancestry(tree, node);
    const top = chain[0];
    if (top.kind === 'nodegraph') {
        if (chain.length === 1) return { scope: '', id: 'g:' + top.name };
        const child = chain[1];
        const prefix = child.kind === 'output' ? 'o:' : child.kind === 'input' ? 'i:' : 'n:';
        return { scope: top.name, id: prefix + child.name };
    }
    if (top.kind === 'nodedef') return { scope: '', id: 'd:' + top.name };
    if (top.kind === 'output') return chain.length === 1 ? { scope: '', id: 'o:' + top.name } : null;
    if (top.kind === 'node') return { scope: '', id: 'n:' + top.name };
    return null;
}

// Graph Editor selection { scope, id } -> Outline path ("NG_main/tinted").
function pathForGraphSelection(scope, id) {
    const m = /^[nogid]:(.+)$/.exec(String(id || ''));
    if (!m) return null;
    return scope ? scope + '/' + m[1] : m[1];
}

// Range to select in the text for a path reported by the graph, or null.
function rangeForPath(tree, nodePath) {
    const node = nodePath ? tree.byId.get(nodePath) : null;
    return node ? (node.selectionRange || node.range) : null;
}

module.exports = {
    buildOutlineTree,
    findDeepestAt,
    pathAt,
    syncPathAt,
    graphTargetForPath,
    pathForGraphSelection,
    rangeForPath,
    iconForKind,
};
