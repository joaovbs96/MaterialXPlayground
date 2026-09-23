// mtlxAttributeSchema.js: pure (no 'vscode') attribute-name schema for
// .mtlx elements, keyed by "element kind" (tag + surrounding context, not
// just tag alone: a node's own <input> and a <nodedef>'s <input> allow
// different attribute sets). Built from vendor/materialx/documents/
// Specification/*.md (MaterialX 1.39); each non-obvious rule below quotes
// its source section. mtlxCompletions.js is the only caller: it resolves
// which KIND an element in the live document tree is, then narrows this
// module's per-kind list by which attributes are already present and,
// for value-typed conditions (colorspace/unit/ui-range), by the
// element's resolved MaterialX type.
'use strict';

// ---------------------------------------------------------------------
// Attribute catalog: name -> one-line description shown as completion
// detail. Shared across kinds so the text is written once.

const DESC = {
    name: 'unique name of this element within its scope',
    doc: 'documentation string for this element',
    type: 'MaterialX data type',
    value: 'a literal value for this element',
    version: 'MaterialX spec version (materialx), or requested node/nodedef version',
    colorspace: 'color space of this value/file/image',
    namespace: 'namespace applied to elements declared in this scope',
    geomprefix: 'prefix prepended to geomname/geomnamearray values in scope',
    fileprefix: 'prefix prepended to filename-type values in scope',
    nodename: 'name of a node at the same scope to connect to',
    nodegraph: 'name of a nodegraph to connect to (functional/implementation nodedef, or as an input connection)',
    output: 'name of a specific output to connect to, when the source has multiple outputs',
    interfacename: 'name of the enclosing nodegraph/nodedef interface input or token to reference',
    nodedef: 'name of a nodedef this element implements or requests',
    node: 'category name of the custom node being declared',
    inherit: 'name of another element to inherit definitions from',
    nodegroup: 'classification group for this nodedef',
    isdefaultversion: 'use this nodedef when a node instance requests no specific version',
    target: 'restricts this element to one or more rendering targets',
    uiname: 'alternative display name for this element in a UI',
    internalgeomprops: 'geometric properties this node needs internally available',
    uniform: 'restrict this input to uniform (non-varying) values/connections',
    defaultgeomprop: 'intrinsic geometric property providing this input\'s default value',
    enum: 'comma-separated list of allowed value labels',
    enumvalues: 'comma-separated list of underlying values for enum',
    unittype: 'unit type (e.g. "distance") this value is expressed in',
    unit: 'specific unit this value is expressed in',
    uifolder: 'UI folder path (use "/" for nested folders)',
    uimin: 'minimum value the UI allows',
    uimax: 'maximum value the UI allows',
    uisoftmin: 'suggested minimum UI slider value',
    uisoftmax: 'suggested maximum UI slider value',
    uistep: 'UI increment/decrement step size',
    hint: 'hint for code generators about how this input is used',
    uivisible: 'whether this input/token is visible in the UI (default true)',
    uiadvanced: 'whether this input/token is an "advanced" UI parameter (default false)',
    xpos: 'X position of this node/look when drawn in a UI',
    ypos: 'Y position of this node/look when drawn in a UI',
    width: 'relative width when drawn in a UI (or output image width in pixels)',
    height: 'relative height when drawn in a UI (or output image height in pixels)',
    uicolor: 'display-referred color3 for this node/look as drawn in a UI',
    bitdepth: 'expected per-channel bit depth of the output image',
    defaultinput: 'name of a nodedef input passed through unmodified by applications with no implementation',
    default: 'constant value output by applications with no implementation for this node',
    implname: 'implementation-specific name for this node/input on the given target',
    file: 'URI of an external source file for this implementation',
    sourcecode: 'inline source code for this implementation',
    function: 'name of the entry-point function within the source code',
    format: '"shader" (complete, default) or "fragment" (needs code-gen processing)',
    semantic: 'interpretation semantic for this custom type ("color", "shader" or "material")',
    context: 'semantic-specific rendering context for a "shader"-semantic type',
    contains: 'comma-separated list of node names this backdrop contains',
    minimized: 'whether this backdrop/nodegraph is collapsed in a UI',
    looks: 'comma-separated list of look/lookgroup names in this group',
    material: 'name of the material node this assignment references',
    geom: 'comma-separated geometry names/expressions this assignment applies to',
    collection: 'name of a collection this assignment applies to',
    exclusive: 'whether this material assignment is mutually exclusive with others (default true)',
    variantset: 'name of the variantset to apply a variant from',
    variant: 'name of the variant within variantset to apply',
    viewergeom: 'comma-separated viewer geometry names this visibility affects',
    viewercollection: 'name of a collection of viewer geometries this visibility affects',
    vistype: 'type of visibility being defined (camera, illumination, shadow, secondary, ...)',
    visible: 'whether the geom/collection is visible for this visibility type (default true)',
    property: 'name of the property being assigned',
    propertyset: 'name of the propertyset being assigned',
    includegeom: 'comma-separated geometry names/expressions to include',
    includecollection: 'comma-separated collection names to include',
    excludegeom: 'comma-separated geometry names/expressions to exclude',
    geomprop: 'name of the standard geometric property this element maps to',
    space: 'geometric space for this geomprop ("model", "object" or "world")',
    index: 'index for this geomprop (e.g. UV set index)',
    attrname: 'name of the custom attribute being defined',
    elements: 'comma-separated element (or element/input) names this custom attribute applies to',
    exportable: 'whether this custom attribute is emitted as shader metadata',
};

function attr(name, opts) {
    return Object.assign({ name, detail: DESC[name] || 'attribute' }, opts || {});
}

// ---------------------------------------------------------------------
// Type gates: predicates over a resolved MaterialX `type` string, used to
// narrow value-conditional attributes (mtlxCompletions resolves the type
// itself: own `type=` attribute, else the parent node's nodedef).

const NUMERIC_UI_TYPES = new Set(['integer', 'float', 'color3', 'color4', 'vector2', 'vector3', 'vector4']);
const UNIT_ELIGIBLE_TYPES = new Set(['float', 'vector2', 'vector3', 'vector4', 'filename']);
const COLORSPACE_TYPES = new Set(['color3', 'color4', 'filename']);
const isNumericUi = (t) => NUMERIC_UI_TYPES.has(t);
const isUnitEligible = (t) => UNIT_ELIGIBLE_TYPES.has(t);
const isColorspaceEligible = (t) => COLORSPACE_TYPES.has(t);

// ---------------------------------------------------------------------
// Attribute lists per element "kind". `required: true` sorts an attribute
// first (mirrors the spec's own "required" markers); `typeGate` restricts
// the attribute to a resolved type, applied by mtlxCompletions once it
// knows the element's effective type (unknown/unresolved type: the
// attribute is still offered, since withholding it on incomplete
// information is worse than offering one that may not apply).

// Standard UI attributes ("Standard UI Attributes", spec lines 682-727):
// `doc` on every element; xpos/ypos/width/height/uicolor on node types
// and <look>; uivisible/uiadvanced only on <input>/<token> of a nodedef
// or node instantiation (not inside <implementation> or a nodegraph
// interface).
const DOC_ONLY = [attr('doc')];
const NODE_UI_POS = [attr('xpos'), attr('ypos'), attr('width'), attr('height'), attr('uicolor')];
const IO_UI_ATTRS = [
    attr('uiname'), attr('uifolder'),
    attr('uimin', { typeGate: isNumericUi }), attr('uimax', { typeGate: isNumericUi }),
    attr('uisoftmin', { typeGate: isNumericUi }), attr('uisoftmax', { typeGate: isNumericUi }),
    attr('uistep', { typeGate: isNumericUi }),
    attr('uivisible'), attr('uiadvanced'),
];

const ATTRS_BY_KIND = {
    // "Attributes for a <materialx> element" (spec lines 328-332), plus
    // fileprefix/geomprefix (File Prefixes/Geometry Prefixes sections).
    materialx: [
        attr('version', { required: true }), attr('colorspace'), attr('namespace'),
        attr('fileprefix'), attr('geomprefix'), attr('doc'),
    ],

    // "Individual node elements" (spec lines 581-593) + custom-attribute
    // note that `target`/`inherit` are used on shader-node instances
    // ("Instantiated shader nodes can also inherit...", line 1303-1309).
    'node-instance': [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('version'), attr('nodedef'), attr('uiname'), attr('inherit'),
        attr('colorspace', { typeGate: isColorspaceEligible }),
        attr('target'), attr('doc'),
        ...NODE_UI_POS,
    ],

    // "Node elements contain zero or more <input> elements" (spec lines
    // 599-609): value XOR nodename/nodegraph (mtlxCompletions enforces
    // the exclusion, this list stays flat), plus unit/unittype (line
    // 603) and interfacename for functional/compound nodegraph content
    // (lines 1174-1196, gated to inside a <nodegraph> by mtlxCompletions).
    'node-instance-input': [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('value'), attr('nodename'), attr('nodegraph'), attr('output'),
        attr('interfacename'),
        attr('colorspace', { typeGate: isColorspaceEligible }),
        attr('unittype', { typeGate: isUnitEligible }), attr('unit', { typeGate: isUnitEligible }),
        attr('target'), attr('doc'),
    ],

    // Token elements on a node instance mirror geominfo tokens (name,
    // type, value) plus interfacename for nodegraph-content use.
    'node-instance-token': [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('value'), attr('interfacename'), attr('doc'),
    ],

    // "Attributes for <nodedef> elements" (spec lines 942-952).
    nodedef: [
        attr('name', { required: true }), attr('node', { required: true }),
        attr('inherit'), attr('nodegroup'), attr('version'), attr('isdefaultversion'),
        attr('target'), attr('uiname'), attr('internalgeomprops'),
        attr('namespace'), attr('doc'),
    ],

    // "Attributes for NodeDef Input elements" (spec lines 983-1005) plus
    // the shared Standard UI Attributes for nodedef inputs/tokens (uiname
    // duplicated there intentionally: both sections declare it).
    'nodedef-input': [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('value'), attr('uniform'),
        attr('defaultgeomprop'), attr('enum'), attr('enumvalues'),
        attr('colorspace', { typeGate: isColorspaceEligible }),
        attr('unittype', { typeGate: isUnitEligible }), attr('unit', { typeGate: isUnitEligible }),
        attr('hint'), attr('target'), attr('doc'),
        ...IO_UI_ATTRS,
    ],

    // "Attributes for NodeDef Token elements" (spec lines 1018-1027).
    'nodedef-token': [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('value'), attr('enum'), attr('enumvalues'), attr('doc'),
        attr('uiname'), attr('uifolder'), attr('uivisible'), attr('uiadvanced'),
    ],

    // "Attributes for NodeDef Output elements" (spec lines 1039-1046):
    // no nodename/nodegraph connection allowed, only defaultinput/default.
    'nodedef-output': [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('defaultinput'), attr('default'), attr('doc'),
    ],

    // Output element inside a <nodegraph> ("Attributes for Output
    // elements", spec lines 640-653): nodename required there, plus the
    // 2D-caching-specific colorspace/width/height/bitdepth.
    'nodegraph-output': [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('nodename', { required: true }), attr('output'), attr('uniform'),
        attr('colorspace', { typeGate: isColorspaceEligible }),
        attr('width'), attr('height'), attr('bitdepth'), attr('doc'),
    ],

    // Functional nodegraph: "must either itself specify a nodedef
    // attribute..." (spec line 1149); "may not itself specify any direct
    // child input elements" (line 1154), so no compound-only attrs here.
    'nodegraph-functional': [
        attr('name', { required: true }), attr('nodedef', { required: true }),
        attr('target'), attr('namespace'), attr('fileprefix'), attr('doc'),
        ...NODE_UI_POS,
    ],

    // Compound nodegraph: "may specify the same float width and height
    // and boolean minimized attributes as <backdrop> nodes" (spec line
    // 1196).
    'nodegraph-compound': [
        attr('name', { required: true }),
        attr('target'), attr('namespace'), attr('fileprefix'),
        attr('width'), attr('height'), attr('minimized'), attr('doc'),
        ...NODE_UI_POS,
    ],

    // Interface <input>/<token> that is a direct child of a compound
    // nodegraph (spec lines 1186-1196): same shape as a node input's
    // value/nodename, no interfacename (there is no OUTER interface to
    // reference from here).
    'nodegraph-interface-input': [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('value'), attr('nodename'), attr('output'),
        attr('colorspace', { typeGate: isColorspaceEligible }),
        attr('unittype', { typeGate: isUnitEligible }), attr('unit', { typeGate: isUnitEligible }),
        attr('doc'),
    ],
    'nodegraph-interface-token': [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('value'), attr('doc'),
    ],

    // "Implementation elements support the following attributes" (spec
    // lines 1054-1064).
    implementation: [
        attr('name', { required: true }), attr('nodedef', { required: true }),
        attr('nodegraph'), attr('implname'), attr('file'), attr('sourcecode'),
        attr('function'), attr('target'), attr('format'), attr('doc'),
    ],
    // <input> remap child of an <implementation> (spec lines 1068-1075):
    // only name/type/implname, never value/nodename.
    'implementation-input': [
        attr('name', { required: true }), attr('type'), attr('implname'), attr('doc'),
    ],

    // "Attributes for <typedef> elements" (spec lines 261-269).
    typedef: [
        attr('name', { required: true }), attr('semantic'), attr('context'),
        attr('inherit'), attr('hint'), attr('doc'),
    ],
    // "Attributes for <member> elements" (spec lines 271-275).
    member: [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('value', { required: true }), attr('doc'),
    ],

    unittypedef: [attr('name', { required: true }), attr('doc')],
    unitdef: [attr('name', { required: true }), attr('unittype', { required: true }), attr('doc')],
    unit: [attr('name', { required: true }), attr('value'), attr('doc')],

    targetdef: [attr('name', { required: true }), attr('inherit'), attr('doc')],
    attributedef: [
        attr('name', { required: true }), attr('attrname', { required: true }),
        attr('type', { required: true }), attr('value'),
        attr('target'), attr('elements'), attr('exportable'),
        attr('enum'), attr('enumvalues'), attr('doc'),
    ],

    // "Look and Property Elements" (GeomExts.md).
    look: [attr('name', { required: true }), attr('inherit'), attr('doc'), ...NODE_UI_POS],
    lookgroup: [
        attr('name', { required: true }), attr('looks'),
        attr('default', { detail: 'name of the default look in this lookgroup' }),
        attr('doc'),
    ],
    materialassign: [
        attr('name', { required: true }), attr('material', { required: true }),
        attr('geom'), attr('collection'), attr('exclusive'), attr('doc'),
    ],
    variantassign: [
        attr('name', { required: true }), attr('variantset', { required: true }),
        attr('variant', { required: true }), attr('doc'),
    ],
    visibility: [
        attr('name', { required: true }), attr('viewergeom'), attr('viewercollection'),
        attr('geom'), attr('collection'), attr('vistype'), attr('visible'), attr('doc'),
    ],
    propertyassign: [
        attr('name', { required: true }), attr('property', { required: true }),
        attr('type', { required: true }), attr('value', { required: true }),
        attr('target'), attr('geom'), attr('collection'), attr('doc'),
    ],
    propertysetassign: [
        attr('name', { required: true }), attr('propertyset', { required: true }),
        attr('geom'), attr('collection'), attr('doc'),
    ],
    propertyset: [attr('name', { required: true }), attr('doc')],
    property: [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('value', { required: true }), attr('target'), attr('doc'),
    ],
    collection: [
        attr('name', { required: true }), attr('includegeom'), attr('includecollection'),
        attr('excludegeom'), attr('doc'),
    ],
    geominfo: [attr('name', { required: true }), attr('geom'), attr('collection'), attr('doc')],
    geomprop: [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('value', { required: true }),
        attr('unittype', { typeGate: isUnitEligible }), attr('unit', { typeGate: isUnitEligible }),
        attr('doc'),
    ],
    'geominfo-token': [attr('name', { required: true }), attr('type', { required: true }), attr('value'), attr('doc')],
    tokendefault: [attr('name', { required: true }), attr('type', { required: true }), attr('value'), attr('doc')],
    geompropdef: [
        attr('name', { required: true }), attr('type', { required: true }), attr('uniform'),
        attr('geomprop'), attr('space'), attr('index'),
        attr('unittype', { typeGate: isUnitEligible }), attr('unit', { typeGate: isUnitEligible }),
        attr('doc'),
    ],
    variantset: [attr('name', { required: true }), attr('node'), attr('nodedef'), attr('doc')],
    variant: [attr('name', { required: true }), attr('doc')],
    backdrop: [
        attr('name', { required: true }), attr('contains'), attr('minimized'),
        attr('width'), attr('height'), ...NODE_UI_POS.filter((a) => a.name === 'xpos' || a.name === 'ypos'),
        attr('doc'),
    ],
    uifolder: [attr('name', { required: true }), attr('uifolder', { required: true }), attr('doc')],
};

// ---------------------------------------------------------------------
// classifyElement(el): maps a live document-tree element (mtlxSymbols.js
// node shape: {tag, parent, attrs}) to one of the ATTRS_BY_KIND keys
// above, or null when this module has no schema entry for it (falls
// back to just `name`/`doc` via COMMON_FALLBACK). `categories` is
// mtlxCompletions' library index's `categories` Map (category name ->
// node-library entry), used to tell a node instance apart from a
// same-named structural element (e.g. a node category also named
// "surfacematerial").
function classifyElement(el, categories) {
    if (!el || !el.tag) return null;
    const tag = el.tag;
    const parentTag = el.parent && el.parent.tag;
    const grandparentTag = el.parent && el.parent.parent && el.parent.parent.tag;

    if (tag === 'materialx') return 'materialx';

    if (tag === 'nodedef') return 'nodedef';
    if (tag === 'implementation') return 'implementation';
    if (tag === 'typedef') return 'typedef';
    if (tag === 'member') return 'member';
    if (tag === 'unittypedef') return 'unittypedef';
    if (tag === 'unitdef') return 'unitdef';
    if (tag === 'unit') return 'unit';
    if (tag === 'targetdef') return 'targetdef';
    if (tag === 'attributedef') return 'attributedef';
    if (tag === 'look') return 'look';
    if (tag === 'lookgroup') return 'lookgroup';
    if (tag === 'materialassign') return 'materialassign';
    if (tag === 'variantassign') return 'variantassign';
    if (tag === 'visibility') return 'visibility';
    if (tag === 'propertyassign') return 'propertyassign';
    if (tag === 'propertysetassign') return 'propertysetassign';
    if (tag === 'propertyset') return 'propertyset';
    if (tag === 'property') return 'property';
    if (tag === 'collection') return 'collection';
    if (tag === 'geominfo') return 'geominfo';
    if (tag === 'geompropdef') return 'geompropdef';
    if (tag === 'variantset') return 'variantset';
    if (tag === 'variant') return 'variant';
    if (tag === 'backdrop') return 'backdrop';
    if (tag === 'uifolder') return 'uifolder';
    if (tag === 'tokendefault') return 'tokendefault';

    if (tag === 'geomprop') return 'geomprop';

    if (tag === 'nodegraph') {
        // Compound: has any direct <input>/<token> children (spec line
        // 1186). Functional: has a `nodedef` attribute, or none of the
        // above yet (still ambiguous while being typed) -> treat as
        // functional, the more common authoring case for a bare
        // "<nodegraph " tag.
        const hasInterfaceChild = el.children.some((c) => c.tag === 'input' || c.tag === 'token');
        return hasInterfaceChild ? 'nodegraph-compound' : 'nodegraph-functional';
    }

    if (tag === 'implementation') return 'implementation';

    if (tag === 'output') {
        if (parentTag === 'nodedef') return 'nodedef-output';
        return 'nodegraph-output';
    }

    if (tag === 'input') {
        if (parentTag === 'nodedef') return 'nodedef-input';
        if (parentTag === 'implementation') return 'implementation-input';
        if (parentTag === 'nodegraph') return 'nodegraph-interface-input';
        if (parentTag === 'variant') return 'node-instance-input'; // value-only; caller excludes nodename/nodegraph
        // Otherwise: an <input> child of a node instance (any category).
        return 'node-instance-input';
    }

    if (tag === 'token') {
        if (parentTag === 'nodedef') return 'nodedef-token';
        if (parentTag === 'geominfo') return 'geominfo-token';
        if (parentTag === 'nodegraph') return 'nodegraph-interface-token';
        return 'node-instance-token';
    }

    // A node instance: any tag that isn't one of the structural tags
    // above, found at the document root, inside a <nodegraph>, or inside
    // a <variantset>/<look> (materialassign's shaderref-less children).
    // categories (when available) confirms it; without it (library
    // unavailable) any remaining tag defaults to a node instance, since
    // that's what an unrecognized element name almost always is in a
    // .mtlx file.
    if (!categories || categories.has(tag) || parentTag === 'nodegraph' || parentTag === 'materialx' || !parentTag) {
        return 'node-instance';
    }
    return 'node-instance';
}

function attributesFor(kind) {
    return ATTRS_BY_KIND[kind] || DOC_ONLY;
}

module.exports = {
    ATTRS_BY_KIND,
    classifyElement,
    attributesFor,
    isNumericUi,
    isUnitEligible,
    isColorspaceEligible,
};
