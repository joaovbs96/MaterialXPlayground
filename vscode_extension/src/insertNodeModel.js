// insertNodeModel.js: pure position/list logic behind the Insert Node view
// (insertNodeView.js), no vscode dependency, same "pure module behind a
// thin vscode command" split as filePicker.js/mtlxCompletions.js.
'use strict';

const fs = require('fs');
const path = require('path');
const mtlxSymbols = require('./mtlxSymbols');

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

// One level of MaterialX indentation, matching the "MaterialX Document"
// snippet skeleton (mtlx.snippets.json): a single tab.
const INDENT_UNIT = '\t';

// Quote-aware scan for the end of the start/self-closing tag beginning
// at `ltOffset` (its '<'): a '>' inside an attribute value never ends it.
function scanTagEnd(text, ltOffset) {
    let i = ltOffset + 1;
    while (i < text.length && !/[\s/>]/.test(text[i])) i++;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '"' || ch === "'") {
            const close = text.indexOf(ch, i + 1);
            i = close === -1 ? text.length : close + 1;
            continue;
        }
        if (ch === '/' && text[i + 1] === '>') return { end: i + 2, selfClosing: true, selfCloseAt: i };
        if (ch === '>') return { end: i + 1, selfClosing: false, selfCloseAt: -1 };
        i++;
    }
    return { end: text.length, selfClosing: false, selfCloseAt: -1 };
}

// The document's <materialx> root: mtlxSymbols.scanElements already skips
// the XML declaration, leading comments and CDATA when finding tags, so
// this is tolerant of the cursor sitting anywhere among those. Null when
// the document has no <materialx> element at all.
function findMaterialxRoot(text) {
    const { root, lineStarts } = mtlxSymbols.scanElements(text);
    const materialx = root.children.find((c) => c.tag === 'materialx');
    if (!materialx) return null;
    const toOffset = (pos) => lineStarts[pos.line] + pos.character;
    const rootStart = toOffset(materialx.range.start);
    const rootEnd = toOffset(materialx.range.end);
    const tag = scanTagEnd(text, rootStart);
    return { rootStart, rootEnd, openTagEnd: tag.end, selfClosing: tag.selfClosing, selfCloseAt: tag.selfCloseAt };
}

// The offset of the real "</materialx" closing tag matching `rootEnd`
// (the whole element's end, from mtlxSymbols), or -1 when the root was
// only implicitly closed at end-of-file (an unclosed/mid-edit document).
function materialxCloseTagStart(text, rootEnd) {
    const marker = '</materialx';
    const candidate = text.lastIndexOf('<', rootEnd - 1);
    if (candidate === -1 || text.slice(candidate, candidate + marker.length) !== marker) return -1;
    const between = text.slice(candidate + marker.length, rootEnd - 1);
    if (!/^[ \t\r\n]*$/.test(between) || text[rootEnd - 1] !== '>') return -1;
    return candidate;
}

// A self-closing <materialx ... /> has no valid interior at all, so it's
// expanded to <materialx ...>\n\tBODY\n</materialx> regardless of where
// the cursor was -- `replaceStart`/`replaceEnd` span the old self-close.
function expandSelfClosingPlan(text, rootInfo) {
    const openTag = text.slice(rootInfo.rootStart, rootInfo.selfCloseAt).replace(/\s+$/, '') + '>';
    const indent = lineIndent(text, rootInfo.rootStart) + INDENT_UNIT;
    return {
        mode: 'expand-root',
        replaceStart: rootInfo.rootStart,
        replaceEnd: rootInfo.openTagEnd,
        prefix: openTag + '\n',
        indent,
        suffix: '\n</materialx>',
    };
}

// New line right after <materialx ...>'s own start tag, as the first
// child, indented one level in from the root tag itself.
function firstChildPlan(text, rootInfo) {
    const indent = lineIndent(text, rootInfo.rootStart) + INDENT_UNIT;
    const afterOpen = rootInfo.openTagEnd;
    const nextNewline = text.indexOf('\n', afterOpen);
    const restOfLine = nextNewline === -1 ? text.slice(afterOpen) : text.slice(afterOpen, nextNewline);
    if (nextNewline !== -1 && /^[ \t]*$/.test(restOfLine)) {
        return { mode: 'first-child', offset: nextNewline + 1, prefix: '', indent, suffix: '\n' };
    }
    return { mode: 'first-child', offset: afterOpen, prefix: '\n', indent, suffix: '\n' };
}

// New line right before </materialx>, as the last child, same indent
// rule as firstChildPlan.
function lastChildPlan(text, rootInfo, closeTagStart) {
    const indent = lineIndent(text, rootInfo.rootStart) + INDENT_UNIT;
    const lineStart = text.lastIndexOf('\n', closeTagStart - 1) + 1;
    const beforeCloseTag = text.slice(lineStart, closeTagStart);
    if (/^[ \t]*$/.test(beforeCloseTag)) {
        return { mode: 'last-child', offset: lineStart, prefix: '', indent, suffix: '\n' };
    }
    return { mode: 'last-child', offset: closeTagStart, prefix: '\n', indent, suffix: '\n' };
}

// Where a freshly inserted node snippet should land. Never outside the
// <materialx> element: before its start tag (or inside the XML
// declaration/leading comments/its own attributes) lands as the FIRST
// child; at or after </materialx> (or inside it) lands as the LAST
// child; a self-closing root is expanded first. Inside the root's own
// content, the cursor lands at the cursor, or -- when it's inside an
// open start tag or between attributes -- pushed to the start of the
// NEXT line (same indentation), clamped to stay before </materialx>.
// No <materialx> element at all: nothing valid to insert into.
function insertPlan(text, offset) {
    const rootInfo = findMaterialxRoot(text);
    if (!rootInfo) return { mode: 'no-root' };
    if (rootInfo.selfClosing) return expandSelfClosingPlan(text, rootInfo);

    if (offset <= rootInfo.openTagEnd) return firstChildPlan(text, rootInfo);

    const closeTagStart = materialxCloseTagStart(text, rootInfo.rootEnd);
    if (closeTagStart !== -1 && offset >= closeTagStart) return lastChildPlan(text, rootInfo, closeTagStart);

    if (!isInsideOpenTag(text, offset)) return { mode: 'cursor', offset, prefix: '', indent: '', suffix: '' };
    const indent = lineIndent(text, offset);
    const lineEnd = text.indexOf('\n', offset);
    if (lineEnd === -1) return { mode: 'next-line', offset: text.length, prefix: '\n', indent, suffix: '' };
    if (closeTagStart !== -1 && lineEnd >= closeTagStart) return lastChildPlan(text, rootInfo, closeTagStart);
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

// ---------------------------------------------------------------------

// A category (e.g. "multiply") can have nodedefs in SEVERAL libraries;
// mtlxCompletions.js's index keeps only the first-found one. These recover
// every nodedef's real library/group from libraries/**/*.mtlx directly.

function walkMtlxFiles(dir) {
    let out = [];
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out = out.concat(walkMtlxFiles(full));
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mtlx')) out.push(full);
    }
    return out;
}

// "libraries/<lib>/file.mtlx" -> "lib"; "libraries/<lib>/<sub>/file.mtlx"
// -> "lib/sub" (only one level deep) -- exactly libraryFromSourceUri's rule.
function libraryForPath(librariesRoot, filePath) {
    const parts = path.relative(librariesRoot, filePath).replace(/\\/g, '/').split('/');
    let lib = (parts[0] || '').toLowerCase();
    if (parts.length > 2) lib += '/' + parts[1].toLowerCase();
    return lib;
}

const NODEDEF_TAG_RE = /<nodedef\b([^>]*)>/g;
function attrValue(attrsText, name) {
    const m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"').exec(attrsText);
    return m ? m[1] : null;
}

// nodedefLibraries(librariesRoot): Map(nodedefName -> {library, group}),
// scanned from every <nodedef name="..." node="..." nodegroup="..."> in
// librariesRoot (the extension's own vendored libraries/ folder).
function nodedefLibraries(librariesRoot) {
    const map = new Map();
    for (const file of walkMtlxFiles(librariesRoot)) {
        const library = libraryForPath(librariesRoot, file);
        let text;
        try { text = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
        let m;
        NODEDEF_TAG_RE.lastIndex = 0;
        while ((m = NODEDEF_TAG_RE.exec(text)) !== null) {
            const name = attrValue(m[1], 'name');
            if (!name || !attrValue(m[1], 'node')) continue;
            const group = attrValue(m[1], 'nodegroup') || 'uncategorized';
            map.set(name, { library, group });
        }
    }
    return map;
}

// splitCategoryByLibrary(entry, ndefLibs): entry.sigGroups split by each
// version's real library/group -- [{library, group, outputTypes}]. A
// version ndefLibs missed falls back to entry.library (one row).
function splitCategoryByLibrary(entry, ndefLibs) {
    const parts = (entry.library || '').split('/');
    const fallback = { library: parts[0] || 'unknown', group: parts.slice(1).join('/') || 'uncategorized' };
    const groups = new Map();
    for (const sg of entry.sigGroups || []) {
        for (const v of sg.versions || []) {
            const loc = (v.name && ndefLibs.get(v.name)) || fallback;
            const key = loc.library + '/' + loc.group;
            let g = groups.get(key);
            if (!g) { g = { library: loc.library, group: loc.group, outputTypes: [] }; groups.set(key, g); }
            if (sg.type && g.outputTypes.indexOf(sg.type) === -1) g.outputTypes.push(sg.type);
        }
    }
    return Array.from(groups.values());
}

// allCategorySplitRows(index, ndefLibs): one row per (category,
// library/group) pair, each with only that library's own output types.
function allCategorySplitRows(index, ndefLibs) {
    const rows = [];
    for (const [name, entry] of index.categories) {
        for (const split of splitCategoryByLibrary(entry, ndefLibs)) {
            rows.push({ name, library: split.library + '/' + split.group, outputTypes: split.outputTypes });
        }
    }
    rows.sort((a, b) => a.name.localeCompare(b.name) || a.library.localeCompare(b.library));
    return rows;
}

// ---------------------------------------------------------------------

// Insert Node tree: mirrors the Node Specs docs view's order (js/docs/
// sidebar.jsx walks js/gen/nodelib.json's own key order, no sort of its
// own; browser-only, so derived here from that same generated file).

// docOrderFromNodelib(nodelib): the parsed js/gen/nodelib.json object.
// Returns { groupOrder, nodeOrder }: groupOrder maps "library/group" to
// its rank; nodeOrder maps "library/group" to a Map(category -> rank).
function docOrderFromNodelib(nodelib) {
    const groupOrder = new Map();
    const nodeOrder = new Map();
    let libraryRank = 0;
    for (const library of Object.keys(nodelib || {})) {
        let groupRank = 0;
        for (const group of Object.keys(nodelib[library])) {
            const key = library + '/' + group;
            groupOrder.set(key, { library, group, libraryRank, groupRank });
            const cats = new Map();
            let rank = 0;
            for (const category of Object.keys(nodelib[library][group])) cats.set(category, rank++);
            nodeOrder.set(key, cats);
            groupRank++;
        }
        libraryRank++;
    }
    return { groupOrder, nodeOrder };
}

// buildInsertTree(rows, docOrder): groups allCategoryRows()'s output by
// "library/group", sorted per docOrder (a docOrderFromNodelib() result).
// Nodes within a group sort by docs rank, then name.
function buildInsertTree(rows, docOrder) {
    const groupOrder = (docOrder && docOrder.groupOrder) || new Map();
    const nodeOrder = (docOrder && docOrder.nodeOrder) || new Map();
    const groups = new Map();
    for (const row of rows) {
        const key = row.library || '';
        let g = groups.get(key);
        if (!g) {
            const info = groupOrder.get(key);
            const parts = key.split('/');
            g = {
                key,
                library: info ? info.library : (parts[0] || 'other'),
                group: info ? info.group : (parts.slice(1).join('/') || 'other'),
                libraryRank: info ? info.libraryRank : Infinity,
                groupRank: info ? info.groupRank : Infinity,
                nodes: [],
            };
            groups.set(key, g);
        }
        const ranks = nodeOrder.get(key);
        const rank = ranks && ranks.has(row.name) ? ranks.get(row.name) : Infinity;
        g.nodes.push({ row, rank });
    }
    const list = Array.from(groups.values());
    list.sort((a, b) => a.libraryRank - b.libraryRank
        || a.groupRank - b.groupRank
        || a.library.localeCompare(b.library)
        || a.group.localeCompare(b.group));
    for (const g of list) {
        g.nodes.sort((a, b) => a.rank - b.rank || a.row.name.localeCompare(b.row.name));
        g.nodes = g.nodes.map((n) => n.row);
    }
    return list;
}

// filterInsertTree(tree, term): narrowed to groups with a node whose name
// or library matches `term` (case-insensitive). Empty term keeps
// everything, `matched: false`.
function nodeMatchesQuery(node, q) {
    const hay = (node.name + ' ' + (node.library || '')).toLowerCase();
    return hay.indexOf(q) !== -1;
}

function filterInsertTree(tree, term) {
    const q = String(term || '').trim().toLowerCase();
    if (!q) return tree.map((g) => Object.assign({}, g, { nodes: g.nodes.slice(), matched: false }));
    const out = [];
    for (const g of tree) {
        const nodes = g.nodes.filter((n) => nodeMatchesQuery(n, q));
        if (nodes.length) out.push(Object.assign({}, g, { nodes, matched: true }));
    }
    return out;
}

// ---------------------------------------------------------------------

// Per-category "last type used" memory (extension globalState, key
// materialxPlayground.insertNode.lastTypes): a capped {category: type}
// object. Kept pure (the host reads/writes globalState) for testing.

const DEFAULT_LAST_TYPES_CAP = 200;

// rememberLastType(map, category, type, maxEntries): a NEW map with
// `category` set to `type`, moved to the most-recent end; over
// `maxEntries` the oldest entry drops. `map` is never mutated.
function rememberLastType(map, category, type, maxEntries) {
    const cap = maxEntries || DEFAULT_LAST_TYPES_CAP;
    const next = Object.assign({}, map);
    delete next[category];
    next[category] = type;
    const keys = Object.keys(next);
    while (keys.length > cap) delete next[keys.shift()];
    return next;
}

// preferredOutputType(map, category, orderedOutputTypes): the remembered
// last type when it's still offered, else that list's own first entry
// (mtlxCompletions.defaultOutputTypeOrder's default), else null.
function preferredOutputType(map, category, orderedOutputTypes) {
    const types = orderedOutputTypes || [];
    const last = map && Object.prototype.hasOwnProperty.call(map, category) ? map[category] : null;
    if (last && types.indexOf(last) !== -1) return last;
    return types.length ? types[0] : null;
}

// pinOutputType(body, outputType): rewrites buildNodeElementSnippet()'s
// choice snippet (tabstop 1 = type, tabstop 2 = name) into a literal type
// with tabstop 1 on the name. Unchanged if `outputType` isn't a choice.
function pinOutputType(body, outputType) {
    if (typeof outputType !== 'string') return body;
    const re = /type="\$\{1\|([^}]*)\|\}"/;
    const m = re.exec(body);
    if (!m) return body;
    const choices = m[1].split(',');
    if (choices.indexOf(outputType) === -1) return body;
    const rewritten = body.slice(0, m.index) + 'type="' + outputType + '"' + body.slice(m.index + m[0].length);
    return rewritten.replace('${2:', '${1:');
}

module.exports = {
    isInsideOpenTag, lineIndent, insertPlan, findMaterialxRoot, allNamesInText, outputTypesInIndex, allCategoryRows,
    nodedefLibraries, splitCategoryByLibrary, allCategorySplitRows,
    docOrderFromNodelib, buildInsertTree, filterInsertTree,
    rememberLastType, preferredOutputType, pinOutputType,
};
