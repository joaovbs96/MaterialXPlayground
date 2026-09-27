// mtlxCompletions.js: headless (extension-host) completion logic for
// .mtlx files. Pure Node: must NOT require('vscode') anywhere, same rule
// mtlxSymbols.js/mtlxColors.js/specDocs.js/nodeSignature.js follow.
// completionProvider.js is the thin vscode wrapper that converts this
// module's plain-object candidates into vscode.CompletionItem instances.
//
// Built on mtlxSymbols.js's tolerant element-tree scanner (scanElements),
// which already handles a mid-edit/unclosed tag the way a completion
// request always sees the document: the tag being completed usually has
// no closing '>' yet. The node-library data (js/gen/nodelib.json,
// js/gen/nodelib-index.json), the same generated files hoverProvider.js/
// nodeSignature.js read via specDocs.js/the docs site, is loaded once and
// cached per repoRoot (buildLibraryIndex/getLibraryIndex below), never
// re-parsed per keystroke.
'use strict';

const fs = require('fs');
const path = require('path');
const { scanElements, offsetToPos, attributeValueAt, nearestAncestor, materialxRoot } = require('./mtlxSymbols');
const attrSchema = require('./mtlxAttributeSchema');

// ---------------------------------------------------------------------
// Static reference data.

// Mirrors hoverProvider.js's STRUCTURAL_ELEMENTS set (that file requires
// vscode; this one must not, so the list is duplicated rather than
// imported, same "mirrors but does not import" precedent mtlxNode.js/
// specDocs.js already document for js/mtlx-engine.js/js/spec-parser.js).
// A short `detail` string is added here since completion items benefit
// from one, unlike a hover (which already shows the spec description).
const STRUCTURAL_ELEMENTS = [
    { name: 'materialx', detail: 'document root element' },
    { name: 'nodegraph', detail: 'a graph of connected nodes' },
    { name: 'nodedef', detail: 'custom node interface declaration' },
    { name: 'input', detail: 'a node, nodedef or interface input' },
    { name: 'output', detail: 'a node or nodegraph output' },
    { name: 'token', detail: 'a string substitution token' },
    { name: 'implementation', detail: 'source-code implementation of a nodedef' },
    { name: 'typedef', detail: 'custom data type declaration' },
    { name: 'member', detail: 'a typedef struct member' },
    { name: 'unit', detail: 'a unit declaration' },
    { name: 'unittype', detail: 'a unit type declaration' },
    { name: 'look', detail: 'a collection of material/visibility assignments' },
    { name: 'lookgroup', detail: 'a group of looks' },
    { name: 'materialassign', detail: 'assigns a material to a collection' },
    { name: 'visibility', detail: 'visibility override for a collection' },
    { name: 'collection', detail: 'a named set of geometries' },
    { name: 'geominfo', detail: 'per-geometry property values' },
    { name: 'geomprop', detail: 'a named geometric property' },
    { name: 'geompropdef', detail: 'geometric property declaration' },
    { name: 'property', detail: 'a shader property' },
    { name: 'propertyset', detail: 'a set of shader properties' },
    { name: 'propertyassign', detail: 'assigns a propertyset to a collection' },
    { name: 'variant', detail: 'a named variant' },
    { name: 'variantset', detail: 'a set of variants' },
    { name: 'variantassign', detail: 'assigns a variant value' },
    { name: 'backdrop', detail: 'a graph-editor annotation region' },
    { name: 'comment', detail: 'an XML comment element' },
];

// Mirrors js/mtlx-engine.js's COLORSPACES array (a browser global script,
// not requireable from Node, same reason as the STRUCTURAL_ELEMENTS copy
// above).
const COLORSPACES = ['srgb_texture', 'lin_rec709', 'g22_rec709', 'g18_rec709',
    'acescg', 'lin_ap1', 'srgb_displayp3', 'lin_displayp3', 'adobergb', 'lin_adobergb', 'none'];

// Mirrors js/graph/panels.jsx's IFACE_VALUE_TYPES: every scalar/aggregate
// MaterialX data type plus the shader-ish ones a `type="..."` attribute can
// carry (same list the Node Graph Editor's own type picker offers).
const MTLX_TYPES = ['boolean', 'color3', 'color4', 'filename', 'float', 'integer',
    'matrix33', 'matrix44', 'string', 'vector2', 'vector3', 'vector4',
    'surfaceshader', 'displacementshader', 'volumeshader', 'BSDF', 'EDF', 'VDF', 'lightshader', 'material'];

// Attribute names whose VALUE this module can complete (see valueItemsFor
// below); 'name' is handled separately since it only narrows to input
// names when the element itself is <input>.
const VALUE_ATTRS = new Set([
    'type', 'nodename', 'nodegraph', 'output', 'interfacename', 'colorspace', 'nodedef',
    'version', 'unittype', 'unit', 'target', 'defaultgeomprop', 'value',
    'uniform', 'uivisible', 'uiadvanced', 'isdefaultversion', 'minimized', 'visible', 'exclusive', 'exportable',
]);

// Boolean-typed attributes (spec: "boolean, optional"): value completion
// is a plain true/false list regardless of element kind.
const BOOLEAN_ATTRS = new Set([
    'uniform', 'uivisible', 'uiadvanced', 'isdefaultversion', 'minimized', 'visible', 'exclusive', 'exportable',
]);

// "Units" section (spec lines 373-402): the two unittypes and their units
// pre-defined by the MaterialX standard library. Mirrors the <unitdef>
// example in the spec verbatim (js/gen/nodelib.json does not carry unit
// definitions, only node signatures, so this can't be derived from it).
const UNITTYPES = ['distance', 'angle'];
const UNITS_BY_TYPE = {
    distance: ['nanometer', 'micron', 'millimeter', 'centimeter', 'inch', 'foot', 'yard', 'meter', 'kilometer', 'mile'],
    angle: ['degree', 'radian'],
};

// "Geometric Properties" section (spec lines 468-484): the standard
// geomprop names valid for a <geomprop> element's own geomprop= value.
const GEOMPROP_NAMES = ['position', 'normal', 'tangent', 'bitangent', 'texcoord', 'geomcolor'];

// The four multi-element document snippets moved out of
// language/mtlx.snippets.json and into completion items (see
// documentSnippetItems below): a static file can't renumber a colliding
// default name, a completion item built per-request can.
const DOC_SNIPPETS = [
    {
        prefix: 'standard_surface', label: 'standard_surface', kind: 'doc-snippet',
        detail: 'standard_surface shader + surfacematerial',
        names: ['SR_surface', 'M_surface'],
        build: (n) => [
            '<standard_surface name="${1:' + n[0] + '}" type="surfaceshader">',
            '\t<input name="base_color" type="color3" value="${2:0.8, 0.8, 0.8}" />',
            '\t<input name="specular_roughness" type="float" value="${3:0.2}" />',
            '\t<input name="metalness" type="float" value="${4:0.0}" />',
            '</standard_surface>',
            '<surfacematerial name="${5:' + n[1] + '}" type="material">',
            '\t<input name="surfaceshader" type="surfaceshader" nodename="${1:' + n[0] + '}" />',
            '</surfacematerial>',
            '$0',
        ].join('\n'),
    },
    {
        prefix: 'open_pbr_surface', label: 'open_pbr_surface', kind: 'doc-snippet',
        detail: 'open_pbr_surface shader + surfacematerial',
        names: ['SR_openpbr', 'M_openpbr'],
        build: (n) => [
            '<open_pbr_surface name="${1:' + n[0] + '}" type="surfaceshader">',
            '\t<input name="base_color" type="color3" value="${2:0.8, 0.8, 0.8}" />',
            '\t<input name="base_weight" type="float" value="${3:1.0}" />',
            '\t<input name="specular_roughness" type="float" value="${4:0.3}" />',
            '</open_pbr_surface>',
            '<surfacematerial name="${5:' + n[1] + '}" type="material">',
            '\t<input name="surfaceshader" type="surfaceshader" nodename="${1:' + n[0] + '}" />',
            '</surfacematerial>',
            '$0',
        ].join('\n'),
    },
    {
        prefix: 'texturechain', label: 'texturechain', kind: 'doc-snippet',
        detail: 'texcoord -> place2d -> image (color3)',
        names: ['texcoord1', 'place2d1', 'image1'],
        build: (n) => [
            '<texcoord name="${1:' + n[0] + '}" type="vector2">',
            '\t<input name="index" type="integer" value="0" />',
            '</texcoord>',
            '<place2d name="${2:' + n[1] + '}" type="vector2">',
            '\t<input name="texcoord" type="vector2" nodename="${1:' + n[0] + '}" />',
            '</place2d>',
            '<image name="${3:' + n[2] + '}" type="color3">',
            '\t<input name="file" type="filename" value="${4:texture.png}" colorspace="srgb_texture" />',
            '\t<input name="texcoord" type="vector2" nodename="${2:' + n[1] + '}" />',
            '</image>',
            '$0',
        ].join('\n'),
    },
    {
        prefix: 'normalmapchain', label: 'normalmapchain', kind: 'doc-snippet',
        detail: 'image (vector3) -> normalmap',
        names: ['normal_image', 'normalmap1'],
        build: (n) => [
            '<image name="${1:' + n[0] + '}" type="vector3">',
            '\t<input name="file" type="filename" value="${2:normal.png}" />',
            '\t<input name="default" type="vector3" value="0.5, 0.5, 1.0" />',
            '</image>',
            '<normalmap name="${3:' + n[1] + '}" type="vector3">',
            '\t<input name="in" type="vector3" nodename="${1:' + n[0] + '}" />',
            '</normalmap>',
            '$0',
        ].join('\n'),
    },
    {
        prefix: 'nodegraph', label: 'nodegraph', kind: 'doc-snippet',
        detail: 'a reusable nodegraph with a typed output',
        names: ['NG_graph', 'out', 'node1'],
        build: (n) => [
            '<nodegraph name="${1:' + n[0] + '}">',
            '\t$2',
            '\t<output name="${3:' + n[1] + '}" type="${4:color3}" nodename="${5:' + n[2] + '}" />',
            '</nodegraph>',
            '$0',
        ].join('\n'),
    },
];

// defaultgeomprop only ever supplies a vector2/vector3 default: geomcolor
// (color3/4) is never a legal defaultgeomprop value, mirrors
// mtlxAttributeSchema.js's isGeompropEligible typeGate.
const DEFAULTGEOMPROP_NAMES = GEOMPROP_NAMES.filter((g) => g !== 'geomcolor');

// ---------------------------------------------------------------------
// Library index: lazy, memoized per repoRoot (only ever one repoRoot per
// extension host process in practice, same assumption mtlxNode.js/
// specDocs.js make for their own single-repoRoot caches).

let cachedRepoRoot = null;
let cachedIndex = null;

function readJson(repoRoot, relPath) {
    return JSON.parse(fs.readFileSync(path.join(repoRoot, ...relPath.split('/')), 'utf8'));
}

// categories: Map(category -> { library: "lib/group"|null, outputTypes:
// string[], sigGroups: nodelib-index.json's own sigGroups array for that
// category }). nodedefNames: every nodedef `name` (e.g. "ND_mix_color3")
// found across every category, deduped + sorted, for `nodedef="..."`
// completion.
function buildLibraryIndex(repoRoot) {
    const nodelib = readJson(repoRoot, 'js/gen/nodelib.json');
    const nodelibIndex = readJson(repoRoot, 'js/gen/nodelib-index.json');

    const libraryOf = new Map();
    for (const lib of Object.keys(nodelib)) {
        for (const group of Object.keys(nodelib[lib])) {
            for (const category of Object.keys(nodelib[lib][group])) {
                if (!libraryOf.has(category)) libraryOf.set(category, lib + '/' + group);
            }
        }
    }

    const categories = new Map();
    const nodedefNameSet = new Set();
    const nodes = nodelibIndex.nodes || {};
    for (const category of Object.keys(nodes)) {
        const sigGroups = nodes[category].sigGroups || [];
        const outputTypes = [];
        const nodedefNames = [];
        const versions = [];
        for (const g of sigGroups) {
            if (g.type && outputTypes.indexOf(g.type) === -1) outputTypes.push(g.type);
            for (const v of g.versions || []) {
                if (v.name) {
                    nodedefNameSet.add(v.name);
                    if (nodedefNames.indexOf(v.name) === -1) nodedefNames.push(v.name);
                }
                if (v.version && versions.indexOf(v.version) === -1) versions.push(v.version);
            }
        }
        categories.set(category, { library: libraryOf.get(category) || null, outputTypes, sigGroups, nodedefNames, versions });
    }

    return {
        categories,
        nodedefNames: Array.from(nodedefNameSet).sort(),
        allTargets: Array.isArray(nodelibIndex.allTargets) ? nodelibIndex.allTargets.slice() : [],
    };
}

function getLibraryIndex(repoRoot) {
    if (cachedIndex && cachedRepoRoot === repoRoot) return cachedIndex;
    cachedIndex = buildLibraryIndex(repoRoot);
    cachedRepoRoot = repoRoot;
    return cachedIndex;
}

// Test-only: forces the next getLibraryIndex call to rebuild.
function resetLibraryIndexCacheForTests() {
    cachedRepoRoot = null;
    cachedIndex = null;
}

// Every input name for `category`'s nodedef(s), as [{name, type,
// default}], narrowed to sigGroups whose output type is `wantType` when
// that narrows to at least one group, else every sigGroup's inputs
// unioned (the still-ambiguous case: broader is more useful than empty).
// First occurrence of a name wins when sigGroups disagree on its type.
function inputsForCategory(index, category, wantType) {
    const entry = index.categories.get(category);
    if (!entry) return [];
    let groups = entry.sigGroups;
    if (wantType) {
        const narrowed = groups.filter((g) => g.type === wantType);
        if (narrowed.length) groups = narrowed;
    }
    const byName = new Map();
    for (const g of groups) {
        for (const v of g.versions || []) {
            const inputTypes = v.inputTypes || {};
            const defaults = v.defaults || {};
            for (const name of Object.keys(inputTypes)) {
                if (!byName.has(name)) {
                    byName.set(name, { name, type: inputTypes[name], default: defaults[name] });
                }
            }
        }
    }
    return Array.from(byName.values());
}

// Every `name=` value found anywhere in the document tree, used to keep a
// freshly-inserted snippet's default names unique document-wide (cheap:
// completion already re-scans the whole document on every keystroke).
function allNamesInDocument(root) {
    const names = new Set();
    const walk = (n) => {
        if (n.attrs && n.attrs.name) names.add(n.attrs.name.value);
        for (const c of n.children) walk(c);
    };
    walk(root);
    return names;
}

// Bare base (no trailing digits, e.g. "SR_surface" or a node category):
// `base` as-is when free, else `stem` + smallest integer >= 2 not taken.
// Base already ending in digits (e.g. doc-snippet defaults like
// "texcoord1"): strip that suffix to get `stem`, then reuse the same
// stem for every later collision instead of stacking another counter
// on top ("texcoord1" -> "texcoord2", never "texcoord12").
function uniqueName(base, existing) {
    const m = /^(.*?)(\d+)$/.exec(base);
    if (!m) {
        if (!existing.has(base)) return base;
        let n = 2;
        while (existing.has(base + n)) n++;
        return base + n;
    }
    const stem = m[1];
    let n = 1;
    while (existing.has(stem + n)) n++;
    return stem + n;
}

// Names already used by `parentEl`'s own <input> children, excluding
// `excludeEl` itself (an <input> being completed is already IN the tree
// but has no name yet, so excludeEl is usually irrelevant; passed for
// symmetry/safety).
function presentChildInputNames(parentEl, excludeEl) {
    const names = new Set();
    for (const c of parentEl.children) {
        if (c.tag === 'input' && c !== excludeEl && c.attrs.name) names.add(c.attrs.name.value);
    }
    return names;
}

function documentSnippetItems(root) {
    const existing = allNamesInDocument(root);
    return DOC_SNIPPETS.map((s) => {
        const names = s.names.map((n) => uniqueName(n, existing));
        return {
            kind: s.kind,
            label: s.label,
            prefix: s.prefix,
            detail: s.detail,
            insertText: s.build(names),
            isSnippet: true,
        };
    });
}

// ---------------------------------------------------------------------
// Offset-based text scanning: completion works from a raw char offset
// (document.offsetAt(position) on the vscode side), unlike mtlxSymbols.js's
// own {line, character} helpers, so this module converts once via
// offsetToPos rather than threading two coordinate systems through.

const TAG_NAME_CHAR_RE = /[\w:.\-]/;
function isTagNameChar(ch) {
    return ch !== undefined && TAG_NAME_CHAR_RE.test(ch);
}

// Is `offset` positioned right after '<' plus zero or more tag-name
// characters (i.e. the user is typing/has typed a tag name)? Returns the
// already-typed prefix, or null (including for a closing tag, '</...').
function tagPrefixAt(text, offset) {
    let start = offset;
    while (start > 0 && isTagNameChar(text[start - 1])) start--;
    if (start === 0 || text[start - 1] !== '<') return null;
    if (text[start - 2] === '/') return null;
    return { start, end: offset, prefix: text.slice(start, offset) };
}

// True when the tag being completed already has more of its own content
// typed past the cursor on the same line (another attribute, a bare '>',
// or more tag-name characters): a full name+type+closing-tag snippet
// would then double up with what's already there, so the caller falls
// back to inserting just the element name (E4).
function tagAlreadyHasBody(text, offset) {
    let i = offset;
    while (i < text.length && text[i] !== '\n' && text[i] !== '<') {
        if (!/\s/.test(text[i])) return true;
        i++;
    }
    return false;
}

// Is `offset` right after '</' plus zero or more tag-name characters
// (a closing tag being typed)? Returns the offset of the '<' itself plus
// the typed-name range, or null. Companion to tagPrefixAt, which
// deliberately returns null for this same case.
function closingTagPrefixAt(text, offset) {
    let start = offset;
    while (start > 0 && isTagNameChar(text[start - 1])) start--;
    if (start < 2 || text[start - 1] !== '/' || text[start - 2] !== '<') return null;
    return { ltStart: start - 2, start, end: offset, prefix: text.slice(start, offset) };
}

// The tag name of the innermost element still open right before `ltStart`
// (the '<' of a '</' being typed). Reparses only the text BEFORE that '<'
// so the half-typed closing tag (and anything after it) can't perturb the
// scan; whatever is still open at that point is exactly what a closing
// tag typed there would close.
function innermostUnclosedTagName(text, ltStart) {
    let root, lineStarts;
    try {
        ({ root, lineStarts } = scanElements(text.slice(0, ltStart)));
    } catch (e) {
        return null;
    }
    const pos = offsetToPos(lineStarts, ltStart);
    annotateWithin(root, pos);
    const el = elementContaining(root);
    return el ? el.tag : null;
}

// A plain identifier/word ending right at `offset`, used for the bare
// document-snippet prefixes (e.g. "standard_surface") typed as ordinary
// text rather than after '<': mirrors tagPrefixAt's backward scan but
// without requiring a preceding '<'.
const WORD_CHAR_RE = /\w/;
function wordPrefixAt(text, offset) {
    let start = offset;
    while (start > 0 && WORD_CHAR_RE.test(text[start - 1])) start--;
    if (start === offset) return null;
    return { start, end: offset, prefix: text.slice(start, offset) };
}

// The realistic `"` trigger moment is right after typing the OPENING
// quote (e.g. `type="`), with no closing quote yet: mtlxSymbols.js's
// attributeValueAt only ever sees an attribute once BOTH quotes exist
// (scanElements skips an unterminated value entirely, same as a real XML
// parser would mid-edit). Rather than duplicate that tokenizer, splice in
// a synthetic closing quote (the same quote char) at `offset` and let the
// existing tokenizer see a normal, complete (if truncated) value: cheap,
// and every attribute range this produces lines up with the ORIGINAL
// offsets up to `offset` since nothing before it changed. Line-scoped
// (MaterialX attribute values are never authored across a newline in this
// codebase's own examples) and returns null when `offset` isn't right
// after an open quote at all.
const OPEN_QUOTE_RE = /=\s*(["'])[^"'<>]*$/;
function withSyntheticQuoteClose(text, offset) {
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const linePrefix = text.slice(lineStart, offset);
    const m = OPEN_QUOTE_RE.exec(linePrefix);
    if (!m) return null;
    return text.slice(0, offset) + m[1] + text.slice(offset);
}

// The nearest ELEMENT (not the pseudo-root) whose own tag's opening '<'
// starts before `offset` and whose range contains it, i.e. "what element
// is the cursor inside of", used to find the enclosing node for context B
// and the attribute-name (space-trigger) context. Walks the already-built
// tree rather than re-scanning, cheapest done as a simple recursive search
// since a .mtlx document's tree is shallow (a handful of levels deep).
function elementContaining(node) {
    let best = node.tag ? node : null;
    for (const child of node.children) {
        if (child.__withinOffset && child.__withinOffset()) {
            const deeper = elementContaining(child);
            if (deeper) best = deeper;
        }
    }
    return best;
}

function posLte(a, b) { return a.line === b.line ? a.character <= b.character : a.line < b.line; }
function posEq(a, b) { return a.line === b.line && a.character === b.character; }

// Inverse of mtlxSymbols.offsetToPos, local to this module (mtlxSymbols.js
// only ever needed the offset->pos direction for its own callers).
function posToOffset(lineStarts, p) {
    return lineStarts[p.line] + p.character;
}

// ---------------------------------------------------------------------
// Public entry point.
//
// getCompletions({ text, offset, triggerChar, repoRoot }) -> candidate[]
// candidate: { kind, label, detail, insertText, isSnippet, replaceStart,
//   replaceEnd }: replaceStart/replaceEnd are char OFFSETS into `text`
// (the span the item's insertText should replace); omitted (both equal
// `offset`) means a plain insert at the cursor.
function getCompletions({ text, offset, repoRoot }) {
    if (typeof text !== 'string' || typeof offset !== 'number') return [];
    let root, lineStarts;
    try {
        ({ root, lineStarts } = scanElements(text));
    } catch (e) {
        return [];
    }

    // Attach a cheap {line,character} <= offset <= end membership test to
    // every element up front: offsetToPos is O(log n), so this stays fast
    // even for a large document (completion runs on keystrokes, not the
    // whole tree, per call otherwise).
    const pos = offsetToPos(lineStarts, offset);
    annotateWithin(root, pos);

    let index;
    try {
        index = getLibraryIndex(repoRoot);
    } catch (e) {
        index = { categories: new Map(), nodedefNames: [], allTargets: [] };
    }

    // Context: inside a quoted attribute VALUE. Nearest hit wins,
    // whether or not it's one this module knows how to complete (an
    // unknown attrName just yields no items, same as no hit at all). Tries
    // the document as-is first (a value already fully quoted, cursor
    // somewhere inside it), then the synthetic-quote-close reparse for the
    // "just typed the opening quote" moment (see withSyntheticQuoteClose).
    let valueHit = attributeValueAt(root, pos);
    let valueRoot = root;
    let valueLineStarts = lineStarts;
    if (!valueHit) {
        const synthetic = withSyntheticQuoteClose(text, offset);
        if (synthetic !== null) {
            try {
                const reparsed = scanElements(synthetic);
                const hit2 = attributeValueAt(reparsed.root, offsetToPos(reparsed.lineStarts, offset));
                if (hit2) {
                    valueHit = hit2;
                    valueRoot = reparsed.root;
                    valueLineStarts = reparsed.lineStarts;
                }
            } catch (e) { /* fall through: no value context */ }
        }
    }
    if (valueHit) {
        const valueStart = posToOffset(valueLineStarts, valueHit.range.start);
        return valueItemsFor(valueRoot, index, valueHit)
            .map((it, i) => withRange(withOrder(it, i), valueStart, offset));
    }

    // Context: typing/typed a tag name directly after '<'. When some
    // prefix has already been typed (e.g. "<inp"), that partial tag is
    // itself IN the tree (scanElements is tolerant of the missing '>') and
    // is the deepest element containing the cursor: step up to ITS
    // parent to find the true enclosing scope, confirmed by checking its
    // own start position is exactly this '<' (see tagPrefixAt above).
    // With no prefix yet (bare "<"), scanElements never created a node for
    // it, so the deepest match is already the real enclosing scope.
    const tagHit = tagPrefixAt(text, offset);
    if (tagHit) {
        const deepest = elementContaining(root);
        const ltPos = offsetToPos(lineStarts, tagHit.start - 1);
        const parent = (tagHit.prefix && deepest && deepest.tag && deepest.parent && posEq(deepest.range.start, ltPos))
            ? deepest.parent
            : deepest;
        const alreadyHasBody = tagAlreadyHasBody(text, offset);
        const items = nodeAndStructuralItems(index, parent, root, alreadyHasBody);
        return items.map((it) => withRange(it, tagHit.start, offset));
    }

    // Context: typing a CLOSING tag, '</' optionally followed by a
    // partial name. tagPrefixAt above deliberately returns null here; the
    // one sensible completion is the innermost still-open element's own
    // tag name, replacing any partial name already typed.
    const closeHit = closingTagPrefixAt(text, offset);
    if (closeHit) {
        const tag = innermostUnclosedTagName(text, closeHit.ltStart);
        if (!tag) return [];
        return [withRange({
            kind: 'closing-tag', label: tag, detail: 'close <' + tag + '>',
            insertText: tag + '>', isSnippet: false, preselect: true,
        }, closeHit.start, closeHit.end)];
    }

    // Context: inside an element's own attribute whitespace (not inside a
    // tag name, not inside a value): offer attribute-NAME snippets for
    // whichever element the cursor is inside. Only fires when the
    // immediately preceding non-space run looks like "insideOpenTag"; kept
    // deliberately conservative (skip rather than guess); see
    // inAttributeWhitespace below.
    if (inAttributeWhitespace(text, offset)) {
        const el = elementContaining(root);
        if (el) return attributeNameItems(index, el).map((it, i) => withRange(withOrder(it, i), offset, offset));
    }

    // Context: a PARTIAL attribute name already typed (e.g. "<multiply n",
    // cursor right after 'n'): inAttributeWhitespace above only fires with
    // whitespace directly before the cursor, so a half-typed name (no
    // trailing space yet) falls through it. attributeNamePrefixAt finds
    // the same "inside an open tag's attribute region" context one word
    // back, so Ctrl+Space mid-word still offers attributes, replacing the
    // partial word instead of inserting beside it.
    const attrNameHit = attributeNamePrefixAt(text, offset);
    if (attrNameHit) {
        const el = elementContaining(root);
        if (el) return attributeNameItems(index, el).map((it, i) => withRange(withOrder(it, i), attrNameHit.start, attrNameHit.end));
    }

    // Context (E6): a bare word typed as ordinary text (not right after
    // '<', not an attribute name/value) matching one of the multi-element
    // document snippets moved out of language/mtlx.snippets.json. Filtered
    // by prefix here (rather than relying solely on the editor's own label
    // filtering) so an unrelated word yields no items, same as today.
    const wordHit = wordPrefixAt(text, offset);
    if (wordHit) {
        const items = documentSnippetItems(root).filter((it) => it.prefix.indexOf(wordHit.prefix) === 0);
        if (items.length) return items.map((it) => withRange(it, wordHit.start, offset));
    }

    return [];
}

// Adds a private __withinOffset(offset) predicate to every element,
// backed by its own {line,character} range. offsetToPos is only computed
// once per call site (see getCompletions above), so this compares plain
// {line,character} pairs, no further offset math.
function annotateWithin(node, cursorPos) {
    node.__withinOffset = () => posLte(node.range.start, cursorPos) && posLte(cursorPos, node.range.end);
    for (const child of node.children) annotateWithin(child, cursorPos);
}

function withRange(item, start, end) {
    return Object.assign({}, item, { replaceStart: start, replaceEnd: end });
}

// Stamps the item's position in its own already-ordered candidate array
// as `sortIndex`, so the vscode-side wrapper can build a sortText that
// preserves this module's intended order (required first, then a
// curated/spec-derived priority) instead of vscode's own default
// alphabetical-by-label fallback.
function withOrder(item, i) {
    return Object.assign({}, item, { sortIndex: i });
}

// True when `offset` sits in an open tag's attribute region: after the
// tag name and at least one whitespace character, before any '>', e.g.
// "<input |" or "<input name=\"x\" |". Deliberately simple/bounded (mirrors
// nodeSignature.js's extractElementContext caps): scans back at most 4000
// chars for the nearest unescaped '<'/'>' and requires whitespace directly
// before `offset`.
const ATTR_WS_SCAN_CAP = 4000;
function inAttributeWhitespace(text, offset) {
    if (offset === 0) return false;
    const before = text[offset - 1];
    if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r') return false;
    const from = Math.max(0, offset - ATTR_WS_SCAN_CAP);
    const segment = text.slice(from, offset);
    const lastLt = segment.lastIndexOf('<');
    const lastGt = segment.lastIndexOf('>');
    if (lastLt === -1 || lastLt <= lastGt) return false; // no open tag, or already closed
    // Not a closing tag, and there's at least a tag-name char right after '<'.
    return segment[lastLt + 1] !== '/' && isTagNameChar(segment[lastLt + 1]);
}

// Same char class validator.js/mtlxSymbols.js use for an attribute name
// token (word chars plus ':.-').
const ATTR_NAME_CHAR_RE = /[\w:.\-]/;
function isAttrNameChar(ch) {
    return ch !== undefined && ATTR_NAME_CHAR_RE.test(ch);
}

// Is `offset` right after a PARTIAL attribute name, itself preceded by
// whitespace inside an open tag's attribute region (e.g. "<multiply n|",
// or "<input name=\"x\" ty|")? Backs up over the already-typed name chars,
// then reuses inAttributeWhitespace at that earlier position (it already
// requires whitespace immediately before it and an enclosing open tag).
// Returns the replace range for the partial word, or null.
function attributeNamePrefixAt(text, offset) {
    let start = offset;
    while (start > 0 && isAttrNameChar(text[start - 1])) start--;
    if (start === offset) return null; // nothing typed right before the cursor
    if (!inAttributeWhitespace(text, start)) return null;
    return { start, end: offset };
}

// ---------------------------------------------------------------------
// Context builders.

// Builds the "<category name=... type=...>...</category>" snippet for a
// freshly-typed node category (E4): a unique default name (category name
// plus the smallest free numeric suffix), and a type CHOICE of the
// category's own output types (its nodedef signatures), preferred type
// first when the caller has one and it's actually produced by this
// category. Exported for direct unit testing of the naming/choice rules
// without going through a full getCompletions() call.
function buildNodeElementSnippet(category, entry, existingNames, preferredType) {
    const defaultName = uniqueName(category, existingNames);
    let choices = entry.outputTypes.length ? entry.outputTypes.slice() : MTLX_TYPES.slice();
    if (preferredType && choices.indexOf(preferredType) !== -1) {
        choices = [preferredType].concat(choices.filter((t) => t !== preferredType));
    }
    return category + ' name="${1:' + escapeSnippet(defaultName) + '}" type="${2|'
        + choices.join(',') + '|}">$0</' + category + '>';
}

function nodeAndStructuralItems(index, parentEl, root, alreadyHasBody) {
    const items = [];
    const parentTag = parentEl && parentEl.tag;
    // Nodes cannot nest inside a node instance's own body (E1): don't
    // flood that context with the full category list, only the
    // structural children the spec actually allows there.
    const parentIsNodeInstance = !!(parentTag && index.categories.has(parentTag));
    const existingNames = root ? allNamesInDocument(root) : new Set();

    if (!parentIsNodeInstance) {
        for (const [name, entry] of index.categories) {
            const bits = [];
            if (entry.library) bits.push(entry.library);
            if (entry.outputTypes.length) bits.push('→ ' + entry.outputTypes.join(', '));
            const detail = bits.join('  ');
            if (!alreadyHasBody && entry.outputTypes.length) {
                items.push({
                    kind: 'node', label: name, detail,
                    insertText: buildNodeElementSnippet(name, entry, existingNames, null),
                    isSnippet: true,
                });
            } else {
                items.push({ kind: 'node', label: name, detail, insertText: name, isSnippet: false });
            }
        }
        for (const s of STRUCTURAL_ELEMENTS) {
            if (index.categories.has(s.name)) continue; // e.g. surfacematerial is both: the node entry wins
            let insertText = s.name;
            let isSnippet = false;
            if (!alreadyHasBody && s.name === 'nodegraph') {
                const dn = uniqueName('NG_graph', existingNames);
                insertText = 'nodegraph name="${1:' + dn + '}">$0</nodegraph>';
                isSnippet = true;
            } else if (!alreadyHasBody && s.name === 'output') {
                const dn = uniqueName('out', existingNames);
                insertText = 'output name="${1:' + dn + '}" type="${2|' + MTLX_TYPES.join(',') + '|}" />$0';
                isSnippet = true;
            }
            items.push({ kind: 'structural', label: s.name, detail: s.detail, insertText, isSnippet });
        }
    } else {
        // Inside a node instance body only <input> (enrichment below) and
        // <token> are spec-legal children; <output>/other node categories
        // are not (a node instance never has a nodegraph-style output, and
        // nodes never nest inside nodes).
        items.push({ kind: 'structural', label: 'token', detail: 'a string substitution token', insertText: 'token', isSnippet: false });
    }

    // Enrichment: the enclosing element is itself a node, offer complete
    // "<input name=... type=... value=... />" snippets for that node's own
    // inputs NOT already present as a child <input>, narrowed by its own
    // type= attribute when it has one (E1).
    if (parentIsNodeInstance) {
        const wantType = parentEl.attrs.type ? parentEl.attrs.type.value : null;
        const present = presentChildInputNames(parentEl, null);
        for (const inp of inputsForCategory(index, parentTag, wantType)) {
            if (present.has(inp.name)) continue;
            const valuePlaceholder = inp.default != null && inp.default !== '' ? escapeSnippet(inp.default) : '';
            items.push({
                kind: 'input',
                label: 'input name="' + inp.name + '"',
                detail: inp.type + (inp.default != null && inp.default !== '' ? ' = ' + inp.default : ''),
                insertText: 'input name="' + inp.name + '" type="' + inp.type + '" value="${1:' + valuePlaceholder + '}" />$0',
                isSnippet: true,
            });
        }
    }
    return items;
}

// Snippet placeholder text must not itself contain snippet syntax: a
// default like "0.8, 0.8, 0.8" is safe already, but this guards $/}/\ just
// in case a future nodelib entry's default string isn't.
function escapeSnippet(s) {
    return String(s).replace(/[\\$}]/g, '\\$&');
}

function findNamedChildren(scope, tag) {
    if (!scope) return [];
    return scope.children.filter((c) => c.tag === tag && c.attrs.name);
}

// Best-effort effective MaterialX type for `el`: its own `type=`
// attribute wins; otherwise, for an <input> whose parent is a node
// instance (a category the library knows about), the type comes from
// that category's nodedef(s), narrowed by the parent node's own `type=`
// when it has one (mirrors inputsForCategory's own narrowing, and the
// "name" value-completion case a few lines below it).
// `ignoreAttr`: when the caller is itself completing `el`'s own `type=`
// value, that attribute already exists in the tree as a half-typed (often
// empty-string) value  -  skip it rather than "resolving" the type to the
// very thing being typed, and fall through to the nodedef-derived type.
function resolveElementType(index, el, ignoreAttr) {
    if (el.attrs && el.attrs.type && ignoreAttr !== 'type') return el.attrs.type.value;
    if (el.tag === 'input' && el.parent && el.parent.tag && index.categories.has(el.parent.tag)) {
        const parent = el.parent;
        const wantType = parent.attrs.type ? parent.attrs.type.value : null;
        const name = el.attrs.name ? el.attrs.name.value : null;
        if (name) {
            const match = inputsForCategory(index, parent.tag, wantType).find((i) => i.name === name);
            if (match) return match.type;
        }
    }
    return null;
}

function valueItemsFor(root, index, hit) {
    const { element, attrName } = hit;

    if (attrName === 'type') {
        // A node instance's own `type=`: category output types first
        // (the actually-producible types for this node), then every
        // other MaterialX type. An <input>'s `type=` with a name already
        // typed: its library-declared type first.
        const ordered = [];
        if (element.tag && index.categories.has(element.tag)) {
            ordered.push(...index.categories.get(element.tag).outputTypes);
        } else if (element.tag === 'input' && element.parent && element.parent.tag && index.categories.has(element.parent.tag)) {
            const t = resolveElementType(index, element, 'type');
            if (t) ordered.push(t);
        }
        for (const t of MTLX_TYPES) if (ordered.indexOf(t) === -1) ordered.push(t);
        return ordered.map((t) => ({ kind: 'type', label: t, detail: '', insertText: t, isSnippet: false }));
    }
    if (attrName === 'colorspace') {
        return COLORSPACES.map((c) => ({ kind: 'colorspace', label: c, detail: '', insertText: c, isSnippet: false }));
    }
    if (attrName === 'version' && element.tag && index.categories.has(element.tag)) {
        return index.categories.get(element.tag).versions
            .map((v) => ({ kind: 'version', label: v, detail: element.tag + ' version', insertText: v, isSnippet: false }));
    }
    if (BOOLEAN_ATTRS.has(attrName)) {
        return ['true', 'false'].map((b) => ({ kind: 'boolean', label: b, detail: '', insertText: b, isSnippet: false }));
    }
    if (attrName === 'unittype') {
        return UNITTYPES.map((u) => ({ kind: 'unittype', label: u, detail: '', insertText: u, isSnippet: false }));
    }
    if (attrName === 'unit') {
        const wantType = element.attrs.unittype ? element.attrs.unittype.value : null;
        const units = wantType && UNITS_BY_TYPE[wantType]
            ? UNITS_BY_TYPE[wantType]
            : UNITTYPES.reduce((acc, t) => acc.concat(UNITS_BY_TYPE[t]), []);
        return units.map((u) => ({ kind: 'unit', label: u, detail: wantType || '', insertText: u, isSnippet: false }));
    }
    if (attrName === 'defaultgeomprop') {
        return DEFAULTGEOMPROP_NAMES.map((g) => ({ kind: 'geomprop', label: g, detail: '', insertText: g, isSnippet: false }));
    }
    if (attrName === 'geomprop') {
        return GEOMPROP_NAMES.map((g) => ({ kind: 'geomprop', label: g, detail: '', insertText: g, isSnippet: false }));
    }
    if (attrName === 'target') {
        return index.allTargets.map((t) => ({ kind: 'target', label: t, detail: '', insertText: t, isSnippet: false }));
    }
    if (attrName === 'nodedef') {
        // Node instance: its own category's library nodedefs first, then
        // every document-defined <nodedef name="...">, then the full
        // library nodedef name list (a node's `nodedef=` may legitimately
        // name a nodedef for a DIFFERENT node, e.g. inherit scenarios).
        const ordered = [];
        if (element.tag && index.categories.has(element.tag)) {
            ordered.push(...index.categories.get(element.tag).nodedefNames);
        }
        for (const c of findNamedChildren(materialxRoot(root), 'nodedef')) {
            if (ordered.indexOf(c.attrs.name.value) === -1) ordered.push(c.attrs.name.value);
        }
        for (const n of index.nodedefNames) if (ordered.indexOf(n) === -1) ordered.push(n);
        return ordered.map((n) => ({ kind: 'nodedef', label: n, detail: '', insertText: n, isSnippet: false }));
    }
    if (attrName === 'nodegraph') {
        return findNamedChildren(materialxRoot(root), 'nodegraph')
            .map((c) => ({ kind: 'nodegraph', label: c.attrs.name.value, detail: 'nodegraph', insertText: c.attrs.name.value, isSnippet: false }));
    }
    if (attrName === 'nodename') {
        // Mirrors mtlxSymbols.js's NON_NODE_TAGS: everything except
        // input/output/token/nodedef children can be a nodename target.
        // E5: excludes the enclosing node itself (a node can't connect to
        // its own input), and ranks candidates whose OWN output type
        // matches this input's resolved type first (still lists the rest,
        // just after), surfacing the node's type in the item detail.
        const scope = nearestAncestor(element, 'nodegraph') || materialxRoot(root);
        const wantType = resolveElementType(index, element);
        const candidates = scope.children
            .filter((c) => c.tag && !['input', 'output', 'token', 'nodedef'].includes(c.tag) && c.attrs.name)
            .filter((c) => c !== element.parent)
            .map((c) => {
                const t = c.attrs.type ? c.attrs.type.value
                    : (index.categories.has(c.tag) ? (index.categories.get(c.tag).outputTypes[0] || '') : '');
                return { c, t };
            });
        candidates.sort((a, b) => {
            const am = wantType && a.t === wantType ? 0 : 1;
            const bm = wantType && b.t === wantType ? 0 : 1;
            return am - bm;
        });
        return candidates.map(({ c, t }) => ({ kind: 'nodename', label: c.attrs.name.value, detail: t, insertText: c.attrs.name.value, isSnippet: false }));
    }
    if (attrName === 'output') {
        let scope = null;
        if (element.attrs.nodegraph) {
            scope = findNamedChildren(materialxRoot(root), 'nodegraph').find((c) => c.attrs.name.value === element.attrs.nodegraph.value) || null;
        } else {
            scope = nearestAncestor(element, 'nodegraph');
        }
        return scope
            ? findNamedChildren(scope, 'output').map((c) => ({ kind: 'output', label: c.attrs.name.value, detail: c.attrs.type ? c.attrs.type.value : '', insertText: c.attrs.name.value, isSnippet: false }))
            : [];
    }
    if (attrName === 'interfacename') {
        const scope = nearestAncestor(element, 'nodegraph');
        return scope
            ? findNamedChildren(scope, 'input').map((c) => ({ kind: 'interfacename', label: c.attrs.name.value, detail: c.attrs.type ? c.attrs.type.value : '', insertText: c.attrs.name.value, isSnippet: false }))
            : [];
    }
    if (attrName === 'value' && element.tag === 'input') {
        // E10a: a filename-typed input's value gets a "Browse for file..."
        // item that inserts nothing and instead runs a command (wired up
        // by completionProvider.js, which has the vscode Uri/positions
        // this pure module doesn't); sortIndex 0 (via withOrder, since
        // it's the only item) puts it first.
        const t = resolveElementType(index, element);
        if (t === 'filename') {
            return [{ kind: 'file-browse', label: 'Browse for file...', detail: '', insertText: '', isSnippet: false }];
        }
        return [];
    }
    if (attrName === 'name' && element.tag === 'input' && element.parent && element.parent.tag) {
        const parent = element.parent;
        if (index.categories.has(parent.tag)) {
            const wantType = parent.attrs.type ? parent.attrs.type.value : null;
            const hasType = !!(element.attrs && element.attrs.type);
            const present = presentChildInputNames(parent, element);
            return inputsForCategory(index, parent.tag, wantType)
                .filter((inp) => !present.has(inp.name))
                .map((inp) => ({
                    kind: 'input-name',
                    label: inp.name,
                    detail: inp.type,
                    // The replace range only covers the partial NAME text
                    // (inside the already-open quote); appending
                    // `" type="<type>` here closes that quote and reopens
                    // one for type=, reusing the closing quote the user
                    // already has right after the cursor  -  same trick the
                    // tag-context "<input name=... type=... />" snippet a
                    // few lines up uses, just without a snippet.
                    insertText: hasType ? inp.name : inp.name + '" type="' + inp.type,
                    isSnippet: false,
                }));
        }
    }
    return [];
}

// Attribute-NAME completions for the "space" trigger: offered for
// whichever element the cursor is inside, narrowed to exactly the
// attributes mtlxAttributeSchema.js says are valid for that element's
// KIND (materialx root / node instance / nodedef input / ..., see that
// module for the full per-kind breakdown), excluding attributes already
// present and, for a handful of value-conditional attributes (colorspace,
// the ui* range attributes, unit/unittype), narrowed further by the
// element's resolved MaterialX type. `interfacename` is additionally
// dropped unless `el` has an enclosing <nodegraph> to reference (spec:
// interfacename resolves nodedef/nodegraph interface inputs, mirrors the
// same scope check the "interfacename" VALUE completion below already
// applies via nearestAncestor). Required-first, then alphabetical,
// mirrors the spec's own "(required)" markers.
// Attribute names whose presence means a value= would conflict with a
// connection instead (E2): spec's "value XOR nodename/nodegraph/
// interfacename/output" rule for a node/nodedef/nodegraph-interface input.
const CONNECTION_ATTRS = ['nodename', 'nodegraph', 'interfacename', 'output'];

function attributeNameItems(index, el) {
    const kind = attrSchema.classifyElement(el, index.categories);
    if (!kind) return [];
    const present = new Set(Object.keys(el.attrs || {}));
    const effType = resolveElementType(index, el);
    const inNodegraph = !!nearestAncestor(el, 'nodegraph');
    const hasConnection = CONNECTION_ATTRS.some((a) => present.has(a));

    // E2: when this <input> has no name= yet, `colorspace` can't be
    // resolved from ITS OWN type (there's nothing to look up by name), so
    // gate it instead on whether any of the parent node's still-missing
    // inputs could plausibly want one (color3/color4/filename). An
    // unknown/unresolvable parent falls through to the normal typeGate
    // behavior below (permissive: offer it rather than guess wrong).
    let missingInputTypes = null;
    if (el.tag === 'input' && !present.has('name') && el.parent && el.parent.tag && index.categories.has(el.parent.tag)) {
        const parent = el.parent;
        const wantType = parent.attrs.type ? parent.attrs.type.value : null;
        const presentNames = presentChildInputNames(parent, el);
        missingInputTypes = inputsForCategory(index, parent.tag, wantType)
            .filter((i) => !presentNames.has(i.name))
            .map((i) => i.type);
    }

    const candidates = attrSchema.attributesFor(kind)
        .filter((a) => !present.has(a.name))
        .filter((a) => a.name !== 'value' || !hasConnection)
        .filter((a) => {
            if (a.name === 'colorspace' && missingInputTypes) {
                return missingInputTypes.some((t) => attrSchema.isColorspaceEligible(t));
            }
            return !a.typeGate || !effType || a.typeGate(effType);
        })
        .filter((a) => a.name !== 'interfacename' || inNodegraph);

    const items = candidates.map((a) => ({
        kind: 'attr-name',
        label: a.name,
        detail: a.detail,
        insertText: a.name + '="$1"$0',
        isSnippet: true,
        __required: !!a.required,
    }));
    // Required first; Array#sort is a stable sort (guaranteed since
    // ES2019), so ties keep attrSchema's own array order  -  that array
    // IS the curated priority (spec-required first, then commonly-used,
    // then UI/layout, then doc last), not alphabetical.
    items.sort((x, y) => (x.__required === y.__required ? 0 : x.__required ? -1 : 1));
    if (items.length && items[0].__required) items[0].preselect = true;
    return items.map((it) => { delete it.__required; return it; });
}

module.exports = {
    getCompletions,
    getLibraryIndex,
    buildLibraryIndex,
    inputsForCategory,
    resetLibraryIndexCacheForTests,
    STRUCTURAL_ELEMENTS,
    COLORSPACES,
    MTLX_TYPES,
    VALUE_ATTRS,
    uniqueName,
    buildNodeElementSnippet,
    documentSnippetItems,
    DOC_SNIPPETS,
};
