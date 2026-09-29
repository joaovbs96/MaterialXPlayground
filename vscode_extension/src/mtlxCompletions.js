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

// Every non-node element the MaterialX 1.39 spec and Geometry Extensions
// define (there is no <comment> element: XML comments are <!-- -->), with
// a short completion detail.
const STRUCTURAL_ELEMENTS = [
    { name: 'materialx', detail: 'document root element' },
    { name: 'nodegraph', detail: 'a graph of connected nodes' },
    { name: 'nodedef', detail: 'custom node interface declaration' },
    { name: 'input', detail: 'a node, nodedef or interface input' },
    { name: 'output', detail: 'a nodedef or nodegraph output' },
    { name: 'token', detail: 'a string substitution token' },
    { name: 'uifolder', detail: 'a nodedef UI folder' },
    { name: 'implementation', detail: 'source-code implementation of a nodedef' },
    { name: 'typedef', detail: 'custom data type declaration' },
    { name: 'member', detail: 'a typedef struct member' },
    { name: 'unittypedef', detail: 'a unit type declaration' },
    { name: 'unitdef', detail: 'a set of units for a unit type' },
    { name: 'unit', detail: 'a unit and its scale, inside a unitdef' },
    { name: 'targetdef', detail: 'a rendering target declaration' },
    { name: 'attributedef', detail: 'a custom attribute declaration' },
    { name: 'geompropdef', detail: 'geometric property declaration' },
    { name: 'look', detail: 'a collection of material/visibility assignments' },
    { name: 'lookgroup', detail: 'a group of looks' },
    { name: 'materialassign', detail: 'assigns a material to geometry or a collection' },
    { name: 'variantassign', detail: 'applies a variant from a variantset' },
    { name: 'visibility', detail: 'visibility override for a collection' },
    { name: 'propertyassign', detail: 'assigns a property value to geometry' },
    { name: 'propertysetassign', detail: 'assigns a propertyset to geometry' },
    { name: 'collection', detail: 'a named set of geometries' },
    { name: 'geominfo', detail: 'per-geometry property values' },
    { name: 'geomprop', detail: 'a geometric property value, inside a geominfo' },
    { name: 'tokendefault', detail: 'default value for a geometry token' },
    { name: 'property', detail: 'a shader property' },
    { name: 'propertyset', detail: 'a set of shader properties' },
    { name: 'variant', detail: 'a named variant' },
    { name: 'variantset', detail: 'a set of variants' },
    { name: 'backdrop', detail: 'a graph-editor annotation region' },
    { name: 'xi:include', detail: 'include another .mtlx document' },
];

// Allowed children per parent tag (spec element descriptions): `nodes`
// also allows node instances. Tags absent here and from LEAF_TAGS (unknown
// or custom elements) keep the permissive full list.
const ROOT_CHILDREN = ['nodegraph', 'nodedef', 'implementation', 'typedef', 'unittypedef', 'unitdef',
    'targetdef', 'attributedef', 'geompropdef', 'look', 'lookgroup', 'collection', 'geominfo', 'tokendefault',
    'propertyset', 'variantset', 'backdrop', 'output', 'xi:include'];
const CHILDREN_BY_PARENT = {
    materialx: { nodes: true, tags: ROOT_CHILDREN },
    nodegraph: { nodes: true, tags: ['input', 'token', 'output', 'nodegraph', 'backdrop'] },
    nodedef: { tags: ['input', 'token', 'output', 'uifolder'] },
    implementation: { tags: ['input', 'token'] },
    typedef: { tags: ['member'] },
    unitdef: { tags: ['unit'] },
    look: { tags: ['materialassign', 'variantassign', 'visibility', 'propertyassign', 'propertysetassign'] },
    materialassign: { tags: ['variantassign'] },
    propertyset: { tags: ['property'] },
    geominfo: { tags: ['geomprop', 'token'] },
    variantset: { tags: ['variant'] },
    variant: { tags: ['input', 'token'] },
};
const LEAF_TAGS = new Set(['input', 'output', 'token', 'member', 'unit', 'geomprop', 'property', 'tokendefault',
    'geompropdef', 'targetdef', 'unittypedef', 'attributedef', 'collection', 'lookgroup', 'visibility',
    'propertyassign', 'propertysetassign', 'variantassign', 'backdrop', 'uifolder', 'xi:include']);
const STRUCTURAL_TAGS = new Set(STRUCTURAL_ELEMENTS.map((s) => s.name));

// "Color Spaces and Color Management Systems": the spec's ACES 1.2 list
// plus the reserved "none".
const COLORSPACES = ['srgb_texture', 'lin_rec709', 'g22_rec709', 'g18_rec709', 'acescg', 'lin_ap1',
    'g22_ap1', 'g18_ap1', 'lin_srgb', 'adobergb', 'lin_adobergb', 'srgb_displayp3', 'lin_displayp3', 'none'];

// Mirrors js/graph/panels.jsx's IFACE_VALUE_TYPES: every scalar/aggregate
// MaterialX data type plus the shader-ish ones a `type="..."` attribute can
// carry (same list the Node Graph Editor's own type picker offers).
const MTLX_TYPES = ['boolean', 'color3', 'color4', 'filename', 'float', 'integer',
    'matrix33', 'matrix44', 'string', 'vector2', 'vector3', 'vector4',
    'surfaceshader', 'displacementshader', 'volumeshader', 'BSDF', 'EDF', 'VDF', 'lightshader', 'material'];
// "MaterialX Data Types": the array types, offered after MTLX_TYPES in type="" values.
const ARRAY_TYPES = ['integerarray', 'floatarray', 'color3array', 'color4array',
    'vector2array', 'vector3array', 'vector4array', 'stringarray'];

// Fixed enumerations from the spec, keyed by attribute name.
const ENUM_VALUES = {
    semantic: ['default', 'color', 'shader', 'material'], // "Custom Data Types"
    context: ['surface', 'volume', 'displacement', 'light'], // "Shader Nodes" standard typedefs
    format: ['shader', 'fragment'], // implementation "format"
    vistype: ['camera', 'illumination', 'shadow', 'secondary'], // GeomExts "Visibility Elements"
    space: ['model', 'object', 'world'], // "Geometric Spaces"
    bitdepth: ['8', '16', '32', '64'], // "Output Elements"
};
// `hint` differs by element: "Custom Data Types" vs "NodeDef Input Elements".
const TYPEDEF_HINTS = ['halfprecision', 'doubleprecision'];
const INPUT_HINTS = ['transparency', 'opacity', 'anisotropy'];

// Attribute names whose VALUE this module can complete (see valueItemsFor).
const VALUE_ATTRS = new Set([
    'type', 'nodename', 'nodegraph', 'output', 'interfacename', 'colorspace', 'nodedef',
    'version', 'unittype', 'unit', 'target', 'defaultgeomprop', 'value', 'defaultinput', 'geomprop',
    'uniform', 'uivisible', 'uiadvanced', 'isdefaultversion', 'minimized', 'visible', 'exclusive', 'exportable',
    'semantic', 'context', 'format', 'vistype', 'space', 'bitdepth', 'hint', 'nodegroup', 'inherit',
    'internalgeomprops', 'material', 'collection', 'includecollection', 'viewercollection', 'looks',
    'default', 'variantset', 'variant', 'propertyset',
]);

// Boolean-typed attributes (spec: "boolean, optional"): value completion
// is a plain true/false list regardless of element kind.
const BOOLEAN_ATTRS = new Set([
    'uniform', 'uivisible', 'uiadvanced', 'isdefaultversion', 'minimized', 'visible', 'exclusive', 'exportable',
]);

// "Units": the spec's predefined unittypes and units, used only when
// libraries/**.mtlx cannot be read (the library <unitdef>s win otherwise).
const UNITTYPES = ['distance', 'angle'];
const UNITS_BY_TYPE = {
    distance: ['nanometer', 'micron', 'millimeter', 'centimeter', 'inch', 'foot', 'yard', 'meter', 'kilometer', 'mile'],
    angle: ['degree', 'radian'],
};

// "Geometric Properties": the standard geomprop names, valid for a
// <geompropdef>'s geomprop= value.
const GEOMPROP_NAMES = attrSchema.STANDARD_GEOMPROPS;

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

// Closure-producing types: placed after every non-closure type in a
// default type-choice order, unless a category produces ONLY closures.
const CLOSURE_TYPES = ['BSDF', 'EDF', 'VDF'];

// Non-closure types ranked ahead of the rest of the list: color3 first
// (the most commonly authored shading value), then float.
const COMMON_NONCLOSURE_TYPES = ['color3', 'float'];

// Reorders `types` (a category's own output types, unordered/alphabetical
// as nodelib-index.json happens to store them) into a sensible default for
// a type-choice completion: `preferredType` first when it's actually one
// of `types` (the type the surrounding context already wants, e.g. the
// input a fresh node will feed), else COMMON_NONCLOSURE_TYPES first, then
// any other non-closure type (original relative order kept), then
// CLOSURE_TYPES last (a no-op when `types` has nothing but closures).
// Exported as the shared primitive behind both buildNodeElementSnippet and
// defaultOutputTypeOrder below.
function orderTypeChoices(types, preferredType) {
    const isClosure = (t) => CLOSURE_TYPES.indexOf(t) !== -1;
    const nonClosure = types.filter((t) => !isClosure(t));
    const closure = types.filter(isClosure);
    const rank = (t) => {
        const i = COMMON_NONCLOSURE_TYPES.indexOf(t);
        return i === -1 ? COMMON_NONCLOSURE_TYPES.length : i;
    };
    const orderedNonClosure = nonClosure
        .map((t, i) => ({ t, i }))
        .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
        .map((x) => x.t);
    const orderedClosure = closure
        .map((t, i) => ({ t, i }))
        .sort((a, b) => CLOSURE_TYPES.indexOf(a.t) - CLOSURE_TYPES.indexOf(b.t) || a.i - b.i)
        .map((x) => x.t);
    let ordered = orderedNonClosure.concat(orderedClosure);
    if (preferredType && ordered.indexOf(preferredType) !== -1) {
        ordered = [preferredType].concat(ordered.filter((t) => t !== preferredType));
    }
    return ordered;
}

// Sidebar-reusable entry point (Insert Node view): the same default
// type-choice ordering buildNodeElementSnippet applies below, keyed by
// category name instead of an already-resolved library entry.
// `context.index` is a getLibraryIndex() result the caller already holds;
// `context.preferredType` is the type the insertion context wants (e.g.
// the input the new node will feed), or omitted/null when unknown.
function defaultOutputTypeOrder(category, context) {
    const ctx = context || {};
    const entry = ctx.index && ctx.index.categories.get(category);
    const types = entry && entry.outputTypes.length ? entry.outputTypes.slice() : MTLX_TYPES.slice();
    return orderTypeChoices(types, ctx.preferredType || null);
}

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

    const lib = scanLibraries(repoRoot);
    const allTargets = Array.isArray(nodelibIndex.allTargets) ? nodelibIndex.allTargets.slice() : [];
    for (const t of lib.targets) if (allTargets.indexOf(t) === -1) allTargets.push(t);
    return {
        categories,
        geompropdefs: lib.geompropdefs,
        unittypes: lib.unittypes.length ? lib.unittypes : UNITTYPES.slice(),
        unitsByType: Object.keys(lib.unitsByType).length ? lib.unitsByType : UNITS_BY_TYPE,
        nodegroups: lib.nodegroups.sort(),
        typedefs: lib.typedefs,
        libNodedefs: lib.nodedefs,
        nodedefNames: Array.from(nodedefNameSet).sort(),
        allTargets: allTargets.sort(),
    };
}

function emptyIndex() {
    return {
        categories: new Map(), geompropdefs: [], unittypes: UNITTYPES.slice(), unitsByType: UNITS_BY_TYPE,
        nodegroups: [], typedefs: [], libNodedefs: new Map(), nodedefNames: [], allTargets: [],
    };
}

// Definitions read from libraries/**.mtlx at load time (never hard-coded):
// geompropdefs, unittypedefs/unitdefs, targetdefs, typedefs, nodegroups
// and each nodedef's port attributes (enum, unittype, uniform, outputs).
const LIB_TAG_RE = /<(\/?)([\w:]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
const LIB_ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
function scanLibraries(repoRoot) {
    const out = { geompropdefs: [], unittypes: [], unitsByType: {}, targets: [], typedefs: [], nodegroups: [], nodedefs: new Map() };
    const scanText = (text) => {
        let unittype = null;
        let nd = null;
        let m;
        LIB_TAG_RE.lastIndex = 0;
        while ((m = LIB_TAG_RE.exec(text))) {
            const [, closing, tag, attrText, selfClose] = m;
            if (closing) {
                if (tag === 'unitdef') unittype = null;
                if (tag === 'nodedef') nd = null;
                continue;
            }
            const a = {};
            let am;
            LIB_ATTR_RE.lastIndex = 0;
            while ((am = LIB_ATTR_RE.exec(attrText))) a[am[1]] = am[2];
            if (tag === 'geompropdef' && a.name && a.type && !out.geompropdefs.some((g) => g.name === a.name)) {
                out.geompropdefs.push({ name: a.name, type: a.type });
            } else if (tag === 'unittypedef' && a.name && out.unittypes.indexOf(a.name) === -1) {
                out.unittypes.push(a.name);
            } else if (tag === 'unitdef') {
                unittype = selfClose ? null : a.unittype || null;
            } else if (tag === 'unit' && unittype && a.name) {
                const list = out.unitsByType[unittype] || (out.unitsByType[unittype] = []);
                if (list.indexOf(a.name) === -1) list.push(a.name);
            } else if (tag === 'targetdef' && a.name && out.targets.indexOf(a.name) === -1) {
                out.targets.push(a.name);
            } else if (tag === 'typedef' && a.name && out.typedefs.indexOf(a.name) === -1) {
                out.typedefs.push(a.name);
            } else if (tag === 'nodedef' && a.name) {
                if (a.nodegroup && out.nodegroups.indexOf(a.nodegroup) === -1) out.nodegroups.push(a.nodegroup);
                const def = { name: a.name, node: a.node || '', inputs: new Map(), tokens: new Map(), outputs: [] };
                if (!out.nodedefs.has(a.name)) out.nodedefs.set(a.name, def);
                nd = selfClose ? null : def;
            } else if (nd && tag === 'input' && a.name) {
                nd.inputs.set(a.name, a);
            } else if (nd && tag === 'token' && a.name) {
                nd.tokens.set(a.name, a);
            } else if (nd && tag === 'output' && a.name) {
                nd.outputs.push({ name: a.name, type: a.type || '' });
            }
        }
    };
    const walk = (dir) => {
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (e.name.endsWith('.mtlx')) {
                let text = '';
                try { text = fs.readFileSync(full, 'utf8'); } catch (err) { continue; }
                scanText(text.replace(/<!--[\s\S]*?-->/g, ''));
            }
        }
    };
    walk(path.join(repoRoot, 'libraries'));
    return out;
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
        index = emptyIndex();
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
        if (el) return attributeNameItems(index, el, root).map((it, i) => withRange(withOrder(it, i), offset, offset));
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
        if (el) return attributeNameItems(index, el, root).map((it, i) => withRange(withOrder(it, i), attrNameHit.start, attrNameHit.end));
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
// category's own output types (its nodedef signatures), ordered by
// orderTypeChoices (preferred type first when the caller has one and it's
// actually produced by this category, else a sensible non-closure-first
// default). The type placeholder is tab stop 1 (not 2): accepting the
// completion lands the user straight on the type choice instead of a
// preselected first type they'd otherwise have to Tab past. Exported for
// direct unit testing of the naming/choice rules without going through a
// full getCompletions() call.
function buildNodeElementSnippet(category, entry, existingNames, preferredType) {
    const defaultName = uniqueName(category, existingNames);
    const types = entry.outputTypes.length ? entry.outputTypes.slice() : MTLX_TYPES.slice();
    const choices = orderTypeChoices(types, preferredType);
    return category + ' name="${2:' + escapeSnippet(defaultName) + '}" type="${1|'
        + choices.join(',') + '|}">$0</' + category + '>';
}

// ---------------------------------------------------------------------
// Document-local definitions and node/port resolution.

function findNamedChildren(scope, tag) {
    if (!scope) return [];
    return scope.children.filter((c) => c.tag === tag && c.attrs.name);
}

function attrVal(el, name) {
    return el && el.attrs && el.attrs[name] ? el.attrs[name].value : null;
}

function docChildren(root, tag) {
    return root ? findNamedChildren(materialxRoot(root), tag) : [];
}

function namesOf(els) {
    return els.map((c) => c.attrs.name.value);
}

// Document <nodedef>s declaring node category `category` (their node=).
function docNodedefsFor(root, category) {
    return docChildren(root, 'nodedef').filter((n) => attrVal(n, 'node') === category);
}

// A document <nodedef> element in the {name, node, inputs, tokens, outputs}
// shape scanLibraries builds for library nodedefs.
function nodedefShape(nd) {
    const plain = (c) => {
        const a = {};
        for (const k of Object.keys(c.attrs)) a[k] = c.attrs[k].value;
        return a;
    };
    const shape = { name: attrVal(nd, 'name'), node: attrVal(nd, 'node') || '', inputs: new Map(), tokens: new Map(), outputs: [] };
    for (const c of nd.children) {
        if (!c.attrs || !c.attrs.name) continue;
        if (c.tag === 'input') shape.inputs.set(c.attrs.name.value, plain(c));
        else if (c.tag === 'token') shape.tokens.set(c.attrs.name.value, plain(c));
        else if (c.tag === 'output') shape.outputs.push({ name: c.attrs.name.value, type: attrVal(c, 'type') || '' });
    }
    return shape;
}

const nodedefOutType = (d) => (d.outputs.length > 1 ? 'multioutput' : (d.outputs[0] ? d.outputs[0].type : ''));

// Nodedef shapes (library, then document) for a node category, narrowed to
// the ones producing `wantType` ("multioutput" for several outputs) if any do.
function nodedefsForCategory(index, root, category, wantType) {
    const defs = [];
    const entry = index.categories.get(category);
    if (entry) for (const n of entry.nodedefNames) if (index.libNodedefs.has(n)) defs.push(index.libNodedefs.get(n));
    for (const nd of docNodedefsFor(root, category)) defs.push(nodedefShape(nd));
    if (!wantType) return defs;
    const narrowed = defs.filter((d) => nodedefOutType(d) === wantType);
    return narrowed.length ? narrowed : defs;
}

// Declared attributes of port `name` (a token when isToken, else an input)
// on node instance `nodeEl`'s nodedef, or null when none declares it.
function portDecl(index, root, nodeEl, name, isToken) {
    for (const d of nodedefsForCategory(index, root, nodeEl.tag, attrVal(nodeEl, 'type'))) {
        const p = (isToken ? d.tokens : d.inputs).get(name);
        if (p) return p;
    }
    return null;
}

// A library node category, or a custom one declared by a document nodedef.
function isNodeCategory(index, root, tag) {
    if (!tag) return false;
    if (index.categories.has(tag)) return true;
    return !STRUCTURAL_TAGS.has(tag) && docNodedefsFor(root, tag).length > 0;
}

// Inputs [{name, type, default}] of node instance `nodeEl`: library
// signatures, else the document's own nodedefs for that category.
function inputsForNode(index, root, nodeEl) {
    const wantType = attrVal(nodeEl, 'type');
    if (index.categories.has(nodeEl.tag)) return inputsForCategory(index, nodeEl.tag, wantType);
    const byName = new Map();
    for (const d of nodedefsForCategory(index, root, nodeEl.tag, wantType)) {
        for (const [n, a] of d.inputs) if (!byName.has(n)) byName.set(n, { name: n, type: a.type, default: a.value });
    }
    return Array.from(byName.values());
}

// Output ports [{name, type}] of node instance `nodeEl`, or null if unknown.
function nodeOutputs(index, root, nodeEl) {
    const t = attrVal(nodeEl, 'type');
    const byName = new Map();
    const entry = index.categories.get(nodeEl.tag);
    if (entry) {
        const narrowed = t ? entry.sigGroups.filter((g) => g.type === t) : [];
        for (const g of narrowed.length ? narrowed : entry.sigGroups) {
            for (const v of g.versions || []) {
                const outs = v.outputTypes || {};
                for (const n of Object.keys(outs)) if (!byName.has(n)) byName.set(n, outs[n]);
            }
        }
    } else {
        for (const d of nodedefsForCategory(index, root, nodeEl.tag, t)) {
            for (const o of d.outputs) if (!byName.has(o.name)) byName.set(o.name, o.type);
        }
    }
    return byName.size ? Array.from(byName, ([name, type]) => ({ name, type })) : null;
}

// Every output type a node instance can connect with (a multioutput node:
// each of its outputs), or [] when unknown.
function nodeConnectableTypes(index, root, nodeEl) {
    const t = attrVal(nodeEl, 'type');
    if (t && t !== 'multioutput') return [t];
    const outs = nodeOutputs(index, root, nodeEl);
    return outs ? outs.map((o) => o.type) : [];
}

// Scope whose children a nodename/nodegraph on `el` references: a node
// input sees its node's siblings, a compound nodegraph's interface input
// the nodegraph's siblings, a nodegraph <output> the nodegraph's children.
function connectionScope(root, el) {
    const p = el.parent;
    const top = materialxRoot(root);
    if (el.tag === 'output') return p && p.tag ? p : top;
    if (p && p.tag === 'nodegraph') return p.parent && p.parent.tag ? p.parent : top;
    if (p && p.parent && p.parent.tag) return p.parent;
    return nearestAncestor(el, 'nodegraph') || top;
}

function findNodeIn(scope, name) {
    return scope.children.find((c) => c.tag && !STRUCTURAL_TAGS.has(c.tag) && attrVal(c, 'name') === name) || null;
}

function referencedNodegraph(root, el) {
    const name = attrVal(el, 'nodegraph');
    const byName = (c) => c.attrs.name.value === name;
    return findNamedChildren(connectionScope(root, el), 'nodegraph').find(byName)
        || docChildren(root, 'nodegraph').find(byName) || null;
}

// "Inputs": output is required for a multi-output source and ignored for a
// single-output one. Unresolvable sources count as multi-output.
function connectsToMultiOutput(index, root, el) {
    if (attrVal(el, 'nodegraph') !== null) {
        const ng = referencedNodegraph(root, el);
        return !ng || ng.children.filter((c) => c.tag === 'output').length > 1;
    }
    const nn = attrVal(el, 'nodename');
    if (nn === null) return true;
    const node = findNodeIn(connectionScope(root, el), nn);
    if (!node) return true;
    const t = attrVal(node, 'type');
    if (t) return t === 'multioutput';
    const outs = nodeOutputs(index, root, node);
    return !outs || outs.length > 1;
}

// "Inputs": same type only, except a string output may feed a filename input.
function typeCompatible(sourceType, wantType) {
    return !wantType || !sourceType || sourceType === wantType || (wantType === 'filename' && sourceType === 'string');
}

// Outputs of the node or nodegraph `el` connects to, for output="...".
function outputCandidates(index, root, el) {
    if (attrVal(el, 'nodegraph') !== null) {
        const ng = referencedNodegraph(root, el);
        return ng ? findNamedChildren(ng, 'output').map((c) => ({ name: c.attrs.name.value, type: attrVal(c, 'type') || '' })) : [];
    }
    const nn = attrVal(el, 'nodename');
    if (nn === null) return [];
    const node = findNodeIn(connectionScope(root, el), nn);
    return node ? nodeOutputs(index, root, node) || [] : [];
}

// Interface ports an interfacename may reference ("Functional Nodegraphs",
// "Compound Nodegraphs"): the nodedef's inputs (or tokens) for a functional
// nodegraph, the nodegraph's own ones for a compound one.
function interfaceCandidates(index, root, el) {
    const ng = nearestAncestor(el, 'nodegraph');
    if (!ng) return [];
    const isToken = el.tag === 'token';
    let ndName = attrVal(ng, 'nodedef');
    if (ndName === null) {
        const impl = docChildren(root, 'implementation').find((c) => attrVal(c, 'nodegraph') === attrVal(ng, 'name'));
        ndName = impl ? attrVal(impl, 'nodedef') : null;
    }
    if (ndName !== null) {
        const docNd = docChildren(root, 'nodedef').find((c) => c.attrs.name.value === ndName);
        const shape = docNd ? nodedefShape(docNd) : index.libNodedefs.get(ndName);
        if (shape) return Array.from((isToken ? shape.tokens : shape.inputs).values()).map((a) => ({ name: a.name, type: a.type || '' }));
    }
    return findNamedChildren(ng, isToken ? 'token' : 'input').map((c) => ({ name: c.attrs.name.value, type: attrVal(c, 'type') || '' }));
}

// ---------------------------------------------------------------------
// Tag-name completions.

function structuralItem(s, existingNames, alreadyHasBody) {
    let insertText = s.name;
    let isSnippet = false;
    if (!alreadyHasBody && s.name === 'nodegraph') {
        insertText = 'nodegraph name="${1:' + uniqueName('NG_graph', existingNames) + '}">$0</nodegraph>';
        isSnippet = true;
    } else if (!alreadyHasBody && s.name === 'output') {
        const choices = orderTypeChoices(MTLX_TYPES.slice(), null);
        insertText = 'output name="${2:' + uniqueName('out', existingNames) + '}" type="${1|' + choices.join(',') + '|}" />$0';
        isSnippet = true;
    } else if (!alreadyHasBody && s.name === 'xi:include') {
        insertText = 'xi:include href="$1" />$0';
        isSnippet = true;
    }
    return { kind: 'structural', label: s.name, detail: s.detail, insertText, isSnippet };
}

function nodeItem(name, entry, detail, existingNames, alreadyHasBody) {
    if (!alreadyHasBody && entry.outputTypes.length) {
        return { kind: 'node', label: name, detail, insertText: buildNodeElementSnippet(name, entry, existingNames, null), isSnippet: true };
    }
    return { kind: 'node', label: name, detail, insertText: name, isSnippet: false };
}

// Children allowed inside `parentEl` (CHILDREN_BY_PARENT): node categories
// only where nodes may appear, <input>/<token> snippets inside a node
// instance, nothing inside leaf elements, everything inside unknown ones.
function nodeAndStructuralItems(index, parentEl, root, alreadyHasBody) {
    const items = [];
    const parentTag = parentEl && parentEl.tag;
    const existingNames = root ? allNamesInDocument(root) : new Set();

    if (parentTag && isNodeCategory(index, root, parentTag)) {
        // Inside a node instance body only <input> and <token> are legal.
        items.push({ kind: 'structural', label: 'token', detail: 'a string substitution token', insertText: 'token', isSnippet: false });
        const present = presentChildInputNames(parentEl, null);
        for (const inp of inputsForNode(index, root, parentEl)) {
            if (present.has(inp.name)) continue;
            const hasDefault = inp.default != null && inp.default !== '';
            items.push({
                kind: 'input',
                label: 'input name="' + inp.name + '"',
                detail: inp.type + (hasDefault ? ' = ' + inp.default : ''),
                insertText: 'input name="' + inp.name + '" type="' + inp.type + '" value="${1:' + (hasDefault ? escapeSnippet(inp.default) : '') + '}" />$0',
                isSnippet: true,
            });
        }
        return items;
    }

    let allowNodes = true;
    let allowed = null; // null: every structural element (unknown parent)
    if (!parentTag) {
        allowNodes = false;
        allowed = ['materialx'];
    } else if (CHILDREN_BY_PARENT[parentTag]) {
        const rule = CHILDREN_BY_PARENT[parentTag];
        allowNodes = !!rule.nodes;
        allowed = rule.tags;
        // "a functional nodegraph may not itself specify any direct child input elements"
        if (parentTag === 'nodegraph' && attrVal(parentEl, 'nodedef') !== null) {
            allowed = allowed.filter((t) => t !== 'input' && t !== 'token');
        }
    } else if (LEAF_TAGS.has(parentTag)) {
        return [];
    }

    if (allowNodes) {
        for (const [name, entry] of index.categories) {
            const bits = [];
            if (entry.library) bits.push(entry.library);
            if (entry.outputTypes.length) bits.push('→ ' + entry.outputTypes.join(', '));
            items.push(nodeItem(name, entry, bits.join('  '), existingNames, alreadyHasBody));
        }
        // Custom node categories declared by this document's own nodedefs.
        const seen = new Set();
        for (const nd of docChildren(root, 'nodedef')) {
            const cat = attrVal(nd, 'node');
            if (!cat || seen.has(cat) || index.categories.has(cat) || STRUCTURAL_TAGS.has(cat)) continue;
            seen.add(cat);
            const outputTypes = [];
            for (const d of docNodedefsFor(root, cat)) {
                const t = nodedefOutType(nodedefShape(d));
                if (t && outputTypes.indexOf(t) === -1) outputTypes.push(t);
            }
            items.push(nodeItem(cat, { outputTypes }, 'custom node (this document)', existingNames, alreadyHasBody));
        }
    }
    for (const s of STRUCTURAL_ELEMENTS) {
        if (allowed && allowed.indexOf(s.name) === -1) continue;
        if (index.categories.has(s.name)) continue;
        items.push(structuralItem(s, existingNames, alreadyHasBody));
    }
    return items;
}

// Snippet placeholder text must not itself contain snippet syntax: a
// default like "0.8, 0.8, 0.8" is safe already, but this guards $/}/\ just
// in case a future nodelib entry's default string isn't.
function escapeSnippet(s) {
    return String(s).replace(/[\\$}]/g, '\\$&');
}

// Best-effort effective MaterialX type for `el`: its own `type=` wins,
// else an <input> of a node instance takes its nodedef's declared type.
// `ignoreAttr` 'type' skips a half-typed type= being completed right now.
function resolveElementType(index, el, ignoreAttr, root) {
    if (el.attrs && el.attrs.type && ignoreAttr !== 'type') return el.attrs.type.value;
    const p = el.parent;
    const name = attrVal(el, 'name');
    if (el.tag === 'input' && p && p.tag && name && isNodeCategory(index, root, p.tag)) {
        const match = inputsForNode(index, root, p).find((i) => i.name === name);
        if (match) return match.type;
    }
    return null;
}

// True when `el` already carries value= or a connection attribute: a
// filename input in that state must not get an auto-inserted value="".
function hasValueOrConnection(el) {
    if (!el || !el.attrs) return false;
    if (el.attrs.value) return true;
    return CONNECTION_ATTRS.some((a) => !!el.attrs[a]);
}

// ---------------------------------------------------------------------
// Attribute-value completions.

function plainItems(kind, list, detail) {
    const seen = new Set();
    const out = [];
    for (const v of list) {
        if (seen.has(v)) continue;
        seen.add(v);
        out.push({ kind, label: v, detail: detail || '', insertText: v, isSnippet: false });
    }
    return out;
}

function portItems(kind, ports) {
    return ports.map((p) => ({ kind, label: p.name, detail: p.type || '', insertText: p.name, isSnippet: false }));
}

function docUnitsByType(root) {
    const out = {};
    for (const ud of docChildren(root, 'unitdef')) {
        const ut = attrVal(ud, 'unittype');
        if (!ut) continue;
        out[ut] = (out[ut] || []).concat(namesOf(findNamedChildren(ud, 'unit')));
    }
    return out;
}

// value="..." on an <input>: the file picker for filenames, true/false for
// booleans, and the nodedef's enum (or enumvalues) for enum inputs.
function inputValueItems(root, index, element) {
    const t = resolveElementType(index, element, null, root);
    if (t === 'filename') {
        return [{ kind: 'file-browse', label: 'Browse for file...', detail: '', insertText: '', isSnippet: false }];
    }
    if (t === 'boolean') return plainItems('boolean', ['true', 'false']);
    let decl = null;
    const p = element.parent;
    const name = attrVal(element, 'name');
    if (p && p.tag === 'nodedef') decl = { enum: attrVal(element, 'enum'), enumvalues: attrVal(element, 'enumvalues'), type: t };
    else if (p && name && isNodeCategory(index, root, p.tag)) decl = portDecl(index, root, p, name, false);
    if (!decl || !decl.enum) return [];
    const labels = decl.enum.split(',').map((s) => s.trim()).filter(Boolean);
    const values = decl.enumvalues ? decl.enumvalues.split(',').map((s) => s.trim()) : null;
    const isString = !t || t === 'string' || t === 'stringarray';
    if (isString || !values || values.length !== labels.length) return plainItems('enum', labels);
    return values.map((v, i) => ({ kind: 'enum', label: v, detail: labels[i], insertText: v, isSnippet: false }));
}

function valueItemsFor(root, index, hit) {
    const { element, attrName } = hit;
    const tag = element.tag;
    const kind = attrSchema.classifyElement(element);

    if (attrName === 'type') {
        // A node instance: its nodedefs' output types first; an <input>
        // with a name: its declared type first; then every MaterialX type.
        const ordered = [];
        const isNode = kind === 'node-instance';
        if (isNode && index.categories.has(tag)) {
            ordered.push(...index.categories.get(tag).outputTypes);
        } else if (isNode) {
            for (const d of docNodedefsFor(root, tag)) ordered.push(nodedefOutType(nodedefShape(d)));
        } else if (tag === 'input' && element.parent && isNodeCategory(index, root, element.parent.tag)) {
            const t = resolveElementType(index, element, 'type', root);
            if (t) ordered.push(t);
        }
        const all = ordered.filter(Boolean).concat(MTLX_TYPES, ARRAY_TYPES, namesOf(docChildren(root, 'typedef')));
        if (isNode && !isNodeCategory(index, root, tag)) all.push('multioutput');
        const isInput = tag === 'input';
        return plainItems('type', all).map((item) => {
            if (isInput && item.label === 'filename' && !hasValueOrConnection(element)) item.filenameValueEligible = true;
            return item;
        });
    }
    if (attrName === 'colorspace') return plainItems('colorspace', COLORSPACES);
    if (attrName === 'version') {
        if (tag === 'materialx') return plainItems('version', ['1.39'], 'MaterialX specification version');
        if (index.categories.has(tag)) return plainItems('version', index.categories.get(tag).versions, tag + ' version');
        return [];
    }
    if (BOOLEAN_ATTRS.has(attrName)) return plainItems('boolean', ['true', 'false']);
    if (ENUM_VALUES[attrName] && !(attrName === 'space' && tag !== 'geompropdef')) {
        return plainItems('enum', ENUM_VALUES[attrName]);
    }
    if (attrName === 'hint') {
        if (tag === 'typedef') return plainItems('enum', TYPEDEF_HINTS);
        if (tag === 'input') return plainItems('enum', INPUT_HINTS);
        return [];
    }
    if (attrName === 'unittype') {
        return plainItems('unittype', (index.unittypes || []).concat(namesOf(docChildren(root, 'unittypedef'))));
    }
    if (attrName === 'unit') {
        let wantType = attrVal(element, 'unittype');
        if (!wantType && tag === 'input' && element.parent && attrVal(element, 'name') !== null && isNodeCategory(index, root, element.parent.tag)) {
            const decl = portDecl(index, root, element.parent, attrVal(element, 'name'), false);
            wantType = decl && decl.unittype ? decl.unittype : null;
        }
        const byType = Object.assign({}, index.unitsByType);
        const docUnits = docUnitsByType(root);
        for (const k of Object.keys(docUnits)) byType[k] = (byType[k] || []).concat(docUnits[k]);
        const units = wantType ? byType[wantType] || [] : Object.keys(byType).reduce((acc, k) => acc.concat(byType[k]), []);
        return plainItems('unit', units, wantType || '');
    }
    if (attrName === 'defaultgeomprop') {
        // Names of <geompropdef>s (library and this document) of the input's type.
        const wantT = resolveElementType(index, element, null, root);
        const defs = (index.geompropdefs || []).concat(docChildren(root, 'geompropdef')
            .map((g) => ({ name: g.attrs.name.value, type: attrVal(g, 'type') || '' })));
        const seen = new Set();
        return defs
            .filter((g) => (wantT ? g.type === wantT : attrSchema.isGeompropEligible(g.type)))
            .filter((g) => !seen.has(g.name) && seen.add(g.name))
            .map((g) => ({ kind: 'geomprop', label: g.name, detail: g.type, insertText: g.name, isSnippet: false }));
    }
    if (attrName === 'geomprop') return tag === 'geompropdef' ? plainItems('geomprop', GEOMPROP_NAMES) : [];
    if (attrName === 'internalgeomprops') {
        return plainItems('geomprop', GEOMPROP_NAMES.concat((index.geompropdefs || []).map((g) => g.name),
            namesOf(docChildren(root, 'geompropdef'))));
    }
    if (attrName === 'target') {
        return plainItems('target', (index.allTargets || []).concat(namesOf(docChildren(root, 'targetdef'))));
    }
    if (attrName === 'nodegroup') {
        const docGroups = docChildren(root, 'nodedef').map((n) => attrVal(n, 'nodegroup')).filter(Boolean);
        return plainItems('enum', (index.nodegroups || []).concat(docGroups));
    }
    if (attrName === 'nodedef') {
        // Node instance: its own category's nodedefs first, then the
        // document's <nodedef>s, then every library nodedef name.
        const ordered = [];
        if (index.categories.has(tag)) ordered.push(...index.categories.get(tag).nodedefNames);
        ordered.push(...namesOf(docChildren(root, 'nodedef')), ...index.nodedefNames);
        return plainItems('nodedef', ordered);
    }
    if (attrName === 'inherit') {
        const self = attrVal(element, 'name');
        const notSelf = (n) => n !== self;
        if (tag === 'nodedef') return plainItems('nodedef', namesOf(docChildren(root, 'nodedef')).concat(index.nodedefNames).filter(notSelf));
        if (tag === 'look') return plainItems('reference', namesOf(docChildren(root, 'look')).filter(notSelf));
        if (tag === 'typedef') return plainItems('type', MTLX_TYPES.concat(ARRAY_TYPES, namesOf(docChildren(root, 'typedef'))).filter(notSelf));
        if (tag === 'targetdef') return plainItems('target', (index.allTargets || []).concat(namesOf(docChildren(root, 'targetdef'))).filter(notSelf));
        return [];
    }
    if (attrName === 'nodegraph') {
        // Compound nodegraphs at the same scope ("Compound Nodegraphs"),
        // never the one enclosing this element; any root nodegraph for an
        // <implementation>.
        if (tag === 'implementation') return plainItems('nodegraph', namesOf(docChildren(root, 'nodegraph')), 'nodegraph');
        const scope = connectionScope(root, element);
        return findNamedChildren(scope, 'nodegraph')
            .filter((c) => attrVal(c, 'nodedef') === null && !isAncestor(c, element))
            .map((c) => ({ kind: 'nodegraph', label: c.attrs.name.value, detail: 'nodegraph', insertText: c.attrs.name.value, isSnippet: false }));
    }
    if (attrName === 'nodename') {
        // Nodes at the connection scope, never the enclosing node itself,
        // filtered to outputs of this port's type (multioutput: any output).
        const scope = connectionScope(root, element);
        const wantType = resolveElementType(index, element, null, root);
        return scope.children
            .filter((c) => c.tag && !STRUCTURAL_TAGS.has(c.tag) && c.attrs.name && c !== element.parent)
            .map((c) => ({ c, types: nodeConnectableTypes(index, root, c) }))
            .filter(({ types }) => !types.length || types.some((t) => typeCompatible(t, wantType)))
            .map(({ c, types }) => ({ kind: 'nodename', label: c.attrs.name.value, detail: attrVal(c, 'type') || types[0] || '', insertText: c.attrs.name.value, isSnippet: false }));
    }
    if (attrName === 'output') {
        const wantType = tag === 'output' || tag === 'input' ? resolveElementType(index, element, null, root) : null;
        return portItems('output', outputCandidates(index, root, element).filter((o) => typeCompatible(o.type, wantType)));
    }
    if (attrName === 'interfacename') {
        const wantType = resolveElementType(index, element, null, root);
        return portItems('interfacename', interfaceCandidates(index, root, element).filter((o) => typeCompatible(o.type, wantType)));
    }
    if (attrName === 'defaultinput') {
        // "the name of an <input> element within the <nodedef>, which must be the same type as type"
        const p = element.parent;
        if (!p || p.tag !== 'nodedef') return [];
        const wantType = attrVal(element, 'type');
        return portItems('input-name', findNamedChildren(p, 'input')
            .map((c) => ({ name: c.attrs.name.value, type: attrVal(c, 'type') || '' }))
            .filter((c) => !wantType || c.type === wantType));
    }
    if (attrName === 'value' && tag === 'input') return inputValueItems(root, index, element);
    if (attrName === 'material') {
        return plainItems('reference', materialxRoot(root).children
            .filter((c) => c.tag && c.attrs.name && attrVal(c, 'type') === 'material').map((c) => c.attrs.name.value), 'material');
    }
    if (attrName === 'collection' || attrName === 'includecollection' || attrName === 'viewercollection') {
        const self = tag === 'collection' ? attrVal(element, 'name') : null;
        return plainItems('reference', namesOf(docChildren(root, 'collection')).filter((n) => n !== self), 'collection');
    }
    if (attrName === 'looks') {
        const self = attrVal(element, 'name');
        return plainItems('reference', namesOf(docChildren(root, 'look')).concat(namesOf(docChildren(root, 'lookgroup'))).filter((n) => n !== self), 'look');
    }
    if (attrName === 'default' && tag === 'lookgroup') {
        const listed = (attrVal(element, 'looks') || '').split(',').map((s) => s.trim()).filter(Boolean);
        return plainItems('reference', listed.length ? listed : namesOf(docChildren(root, 'look')), 'look');
    }
    if (attrName === 'variantset' && tag === 'variantassign') {
        return plainItems('reference', namesOf(docChildren(root, 'variantset')), 'variantset');
    }
    if (attrName === 'variant' && tag === 'variantassign') {
        const setName = attrVal(element, 'variantset');
        const sets = docChildren(root, 'variantset').filter((s) => setName === null || s.attrs.name.value === setName);
        return plainItems('reference', sets.reduce((acc, s) => acc.concat(namesOf(findNamedChildren(s, 'variant'))), []), 'variant');
    }
    if (attrName === 'propertyset' && tag === 'propertysetassign') {
        return plainItems('reference', namesOf(docChildren(root, 'propertyset')), 'propertyset');
    }
    if (attrName === 'name' && tag === 'input' && element.parent && element.parent.tag) {
        const parent = element.parent;
        if (isNodeCategory(index, root, parent.tag)) {
            const hasType = !!(element.attrs && element.attrs.type);
            const present = presentChildInputNames(parent, element);
            return inputsForNode(index, root, parent)
                .filter((inp) => !present.has(inp.name))
                .map((inp) => {
                    // Appending `" type="<type>` reuses the closing quote already after the cursor.
                    const item = {
                        kind: 'input-name',
                        label: inp.name,
                        detail: inp.type,
                        insertText: hasType ? inp.name : inp.name + '" type="' + inp.type,
                        isSnippet: false,
                    };
                    // completionProvider.js appends `" value="` and opens the picker (pickFileOnFilenameInput).
                    if (inp.type === 'filename' && !hasValueOrConnection(element)) item.filenameValueEligible = true;
                    return item;
                });
        }
    }
    return [];
}

function isAncestor(candidate, el) {
    let cur = el.parent;
    while (cur) {
        if (cur === candidate) return true;
        cur = cur.parent;
    }
    return false;
}

// ---------------------------------------------------------------------
// Attribute-name completions: the schema list for the element's kind,
// minus attributes already present, conflicting, or not applicable to the
// resolved type; required first, then the schema's curated order.

// Connection attributes (hasValueOrConnection above).
const CONNECTION_ATTRS = ['nodename', 'nodegraph', 'interfacename', 'output'];
// Input kinds whose colorspace on a filename depends on the node's output type.
const VALUE_INPUT_KINDS = new Set(['node-instance-input', 'nodegraph-interface-input', 'variant-input']);

function attributeNameItems(index, el, root) {
    const kind = attrSchema.classifyElement(el);
    if (!kind) return [];
    const present = new Set(Object.keys(el.attrs || {}));
    const values = {};
    for (const k of present) values[k] = el.attrs[k].value;
    const effType = resolveElementType(index, el, null, root);
    const inNodegraph = !!nearestAncestor(el, 'nodegraph');
    const isNodeInput = kind === 'node-instance-input';
    const nodeParent = isNodeInput && el.parent && isNodeCategory(index, root, el.parent.tag) ? el.parent : null;
    const decl = nodeParent && values.name ? portDecl(index, root, nodeParent, values.name, false) : null;
    // A filename input takes colorspace only when the parent node outputs color3/color4.
    const parentT = el.tag === 'input' && el.parent && el.parent.attrs && el.parent.attrs.type ? el.parent.attrs.type.value : null;
    const colorspaceOk = (t) => (t === 'filename' ? !parentT || parentT === 'color3' || parentT === 'color4' : attrSchema.isColorspaceEligible(t));

    // A nameless node input: colorspace only if some still-missing input of
    // the parent node could take one (its own type is not resolvable yet).
    let missingInputTypes = null;
    if (nodeParent && !present.has('name')) {
        const presentNames = presentChildInputNames(nodeParent, el);
        missingInputTypes = inputsForNode(index, root, nodeParent).filter((i) => !presentNames.has(i.name)).map((i) => i.type);
    }

    const conflictHit = (c) => {
        const eq = c.indexOf('=');
        return eq === -1 ? present.has(c) : values[c.slice(0, eq)] === c.slice(eq + 1);
    };
    const candidates = attrSchema.attributesFor(kind)
        .filter((a) => !present.has(a.name))
        .filter((a) => !(a.conflicts || []).some(conflictHit))
        .filter((a) => !a.requiresAny || a.requiresAny.some((r) => present.has(r)))
        .filter((a) => !a.when || a.when(values))
        .filter((a) => a.name !== 'interfacename' || inNodegraph)
        .filter((a) => a.name !== 'output' || connectsToMultiOutput(index, root, el))
        .filter((a) => {
            // "Inputs": a node input's unit needs a unittype on the input or
            // its nodedef; it may declare unittype only if the nodedef does not.
            if (!decl) return true;
            if (a.name === 'unit') return present.has('unittype') || !!decl.unittype;
            if (a.name === 'unittype') return !decl.unittype;
            return true;
        })
        .filter((a) => {
            if (a.name === 'colorspace' && VALUE_INPUT_KINDS.has(kind)) {
                if (missingInputTypes && !effType) return missingInputTypes.some((t) => colorspaceOk(t));
                if (effType === 'filename') return colorspaceOk('filename');
            }
            return !a.typeGate || !effType || a.typeGate(effType);
        });

    const items = candidates.map((a) => ({
        kind: 'attr-name',
        label: a.name,
        detail: a.detail,
        insertText: a.name + '="$1"$0',
        isSnippet: true,
        __required: !!a.required,
    }));
    // Stable sort: required first, ties keep the schema's curated order.
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
    orderTypeChoices,
    defaultOutputTypeOrder,
};
