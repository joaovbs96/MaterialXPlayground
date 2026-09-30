// mtlxAttributeSchema.js: pure (no 'vscode') attribute-name schema for
// .mtlx elements, keyed by element kind (tag plus context), built from the
// MaterialX 1.39 spec; each rule cites its spec section.
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
    defaultgeomprop: 'name of a geompropdef supplying the default value (vector2/vector3 nodedef inputs)',
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
    scale: 'multiplicative conversion factor of this unit relative to the other units of its unittype',
    impltype: 'target-specific type of the enumvalues given in this implementation',
    geomfile: 'file in which the geometry referenced within this scope is defined',
    href: 'path of the .mtlx document to include',
};

function attr(name, opts) {
    return Object.assign({ name, detail: DESC[name] || 'attribute' }, opts || {});
}

// ---------------------------------------------------------------------
// Type gates: predicates over a resolved MaterialX `type` string, applied
// by mtlxCompletions once it knows the element's type (unknown: offered).

const NUMERIC_UI_TYPES = new Set(['integer', 'float', 'color3', 'color4', 'vector2', 'vector3', 'vector4']);
// "Units": float, vectorN (and their arrays) plus filename inputs.
const UNIT_ELIGIBLE_TYPES = new Set(['float', 'vector2', 'vector3', 'vector4', 'floatarray',
    'vector2array', 'vector3array', 'vector4array', 'filename']);
// GeomExts "GeomProp Elements": only float and vectorN geomprops take a unittype/unit.
const GEOM_UNIT_TYPES = new Set(['float', 'vector2', 'vector3', 'vector4']);
const COLORSPACE_TYPES = new Set(['color3', 'color4', 'filename']);
// "NodeDef Input Elements": colorspace is "for color3- or color4-type inputs".
const COLOR_TYPES = new Set(['color3', 'color4']);
// "NodeDef Input Elements": defaultgeomprop is only "for vector2 or vector3 inputs".
const GEOMPROP_ELIGIBLE_TYPES = new Set(['vector2', 'vector3']);
const isNumericUi = (t) => NUMERIC_UI_TYPES.has(t);
const isUnitEligible = (t) => UNIT_ELIGIBLE_TYPES.has(t);
const isGeomUnitEligible = (t) => GEOM_UNIT_TYPES.has(t);
const isColorspaceEligible = (t) => COLORSPACE_TYPES.has(t);
const isColorType = (t) => COLOR_TYPES.has(t);
const isGeompropEligible = (t) => GEOMPROP_ELIGIBLE_TYPES.has(t);
const isFilename = (t) => t === 'filename';
// enumvalues is "for non-string types" (NodeDef Input/Token Elements).
const isNonString = (t) => t !== 'string' && t !== 'stringarray';

// ---------------------------------------------------------------------
// Per-kind attribute lists. Options: `required` (sorts first), `typeGate`,
// `conflicts` (dropped once any listed attribute is present; "a=v" matches
// that value only), `requiresAny` (dropped until one is present), `when`.

const without = (list, name) => list.filter((n) => n !== name);

// "Inputs": value, nodename, nodegraph and (inside a nodegraph)
// interfacename are alternatives; `output` only qualifies a nodename or
// nodegraph connection. colorspace/unit/fileprefix describe a value or file.
const IN_SOURCES = ['value', 'nodename', 'nodegraph', 'interfacename'];
const connSource = (n) => attr(n, {
    conflicts: without(IN_SOURCES, n).concat(n === 'value' || n === 'interfacename' ? ['output'] : []),
});
const CONNECTED = ['nodename', 'nodegraph', 'interfacename'];
const OUTPUT_QUALIFIER = attr('output', { requiresAny: ['nodename', 'nodegraph'] });

// GeomExts: "Either a geom or a collection may be specified, but not both."
const GEOM_OR_COLLECTION = [attr('geom', { conflicts: ['collection'] }), attr('collection', { conflicts: ['geom'] })];

// Standard UI Attributes: `doc` on every element; xpos/ypos/width/height/
// uicolor on node types and <look>; uivisible/uiadvanced only on <input>/
// <token> of a nodedef or node instance.
const DOC_ONLY = [attr('doc')];
const NODE_UI_POS = [attr('xpos'), attr('ypos'), attr('width'), attr('height'), attr('uicolor')];
const IO_UI_ATTRS = [
    attr('uiname'), attr('uifolder'),
    attr('uimin', { typeGate: isNumericUi }), attr('uimax', { typeGate: isNumericUi }),
    attr('uisoftmin', { typeGate: isNumericUi }), attr('uisoftmax', { typeGate: isNumericUi }),
    attr('uistep', { typeGate: isNumericUi }),
    attr('uivisible'), attr('uiadvanced'),
];

// geompropdef space/index follow the standard geomprop's own inputs
// (StandardNodes "Geometric Nodes"); a non-standard geomprop stays permissive.
const SPACE_GEOMPROPS = ['position', 'normal', 'tangent', 'bitangent'];
const INDEX_GEOMPROPS = ['tangent', 'bitangent', 'texcoord', 'geomcolor'];
const STANDARD_GEOMPROPS = ['position', 'normal', 'tangent', 'bitangent', 'texcoord', 'geomcolor'];
const geompropAllows = (list) => (attrs) => !STANDARD_GEOMPROPS.includes(attrs.geomprop) || list.includes(attrs.geomprop);

const ATTRS_BY_KIND = {
    // "MTLX File Format Definition", "File Prefixes", GeomExts "Geometry
    // Prefixes" and "Geometry Representation" (geomfile).
    materialx: [
        attr('version', { required: true }), attr('colorspace'), attr('namespace'),
        attr('fileprefix'), attr('geomprefix'), attr('geomfile'), attr('doc'),
    ],

    // "Nodes": name/type required, version/nodedef, uiname; colorspace and
    // fileprefix apply to the node's scope. `inherit` (shader instances
    // only) and `target` (not a node-instance attribute) are not offered.
    'node-instance': [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('nodedef'), attr('version'),
        attr('colorspace', { typeGate: isColorspaceEligible }), attr('fileprefix'),
        attr('uiname'), attr('uicolor'), attr('xpos'), attr('ypos'), attr('width'), attr('height'),
        attr('doc'),
    ],

    // "Inputs", "Custom Inputs" (documentational target), "File Prefixes",
    // Standard UI Attributes (uivisible on node-instance inputs).
    'node-instance-input': [
        attr('name', { required: true }), attr('type', { required: true }),
        connSource('value'), connSource('nodename'), connSource('nodegraph'), OUTPUT_QUALIFIER,
        connSource('interfacename'),
        attr('colorspace', { typeGate: isColorspaceEligible, conflicts: CONNECTED }),
        attr('unittype', { typeGate: isUnitEligible, conflicts: CONNECTED }),
        attr('unit', { typeGate: isUnitEligible, conflicts: CONNECTED }),
        attr('fileprefix', { typeGate: isFilename, conflicts: CONNECTED }),
        attr('target'), attr('uivisible'), attr('doc'),
    ],

    // Token on a node instance: value, or interfacename inside a nodegraph.
    'node-instance-token': [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('value', { conflicts: ['interfacename'] }), attr('interfacename', { conflicts: ['value'] }),
        attr('uivisible'), attr('doc'),
    ],

    // "Custom Node Declaration NodeDef Elements".
    nodedef: [
        attr('name', { required: true }), attr('node', { required: true }),
        attr('inherit'), attr('nodegroup'), attr('version'), attr('isdefaultversion'),
        attr('target'), attr('uiname'), attr('internalgeomprops'),
        attr('namespace'), attr('doc'),
    ],

    // "NodeDef Input Elements": value XOR defaultgeomprop, and
    // defaultgeomprop "May not be specified on uniform inputs".
    'nodedef-input': [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('value', { conflicts: ['defaultgeomprop'] }), attr('uniform', { conflicts: ['defaultgeomprop'] }),
        attr('defaultgeomprop', { typeGate: isGeompropEligible, conflicts: ['value', 'uniform=true'] }),
        attr('enum'), attr('enumvalues', { typeGate: isNonString }),
        attr('colorspace', { typeGate: isColorType }),
        attr('unittype', { typeGate: isUnitEligible }), attr('unit', { typeGate: isUnitEligible }),
        attr('hint'), attr('target'), attr('doc'),
        ...IO_UI_ATTRS,
    ],

    // "NodeDef Token Elements".
    'nodedef-token': [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('value'), attr('enum'), attr('enumvalues', { typeGate: isNonString }), attr('doc'),
        attr('uiname'), attr('uifolder'), attr('uivisible'), attr('uiadvanced'),
    ],

    // "NodeDef Output Elements": defaultinput/default, never a connection or
    // file attributes. `uniform` is from "Output Elements", which the nodedef
    // section does not exclude (how a node output is "declared uniform").
    'nodedef-output': [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('defaultinput'), attr('default'), attr('uniform'), attr('doc'),
    ],

    // "Output Elements" (nodegraph or document level): nodename required,
    // output only with it, plus the 2D-caching colorspace/width/height/bitdepth.
    'nodegraph-output': [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('nodename', { required: true }), attr('output', { requiresAny: ['nodename'] }), attr('uniform'),
        attr('colorspace', { typeGate: isColorspaceEligible }),
        attr('width'), attr('height'), attr('bitdepth'), attr('doc'),
    ],

    // "Functional Nodegraphs": nodedef (or an <implementation>), optional target.
    'nodegraph-functional': [
        attr('name', { required: true }), attr('nodedef', { required: true }),
        attr('target'), attr('namespace'), attr('colorspace'), attr('fileprefix'), attr('doc'),
        ...NODE_UI_POS,
    ],

    // "Compound Nodegraphs": width/height/minimized like a <backdrop>.
    'nodegraph-compound': [
        attr('name', { required: true }),
        attr('namespace'), attr('colorspace'), attr('fileprefix'), attr('minimized'),
        ...NODE_UI_POS, attr('doc'),
    ],

    // A bare <nodegraph> without nodedef: target is functional-only, so not offered.
    nodegraph: [
        attr('name', { required: true }), attr('nodedef', { conflicts: ['minimized'] }),
        attr('namespace'), attr('colorspace'), attr('fileprefix'),
        attr('minimized', { conflicts: ['nodedef'] }),
        ...NODE_UI_POS, attr('doc'),
    ],

    // Compound nodegraph interface <input>: value, or a nodename/nodegraph
    // connection at the nodegraph's own scope ("Compound Nodegraphs").
    'nodegraph-interface-input': [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('value', { conflicts: ['nodename', 'nodegraph', 'output'] }),
        attr('nodename', { conflicts: ['value', 'nodegraph'] }), attr('nodegraph', { conflicts: ['value', 'nodename'] }),
        OUTPUT_QUALIFIER,
        attr('colorspace', { typeGate: isColorspaceEligible, conflicts: CONNECTED }),
        attr('unittype', { typeGate: isUnitEligible, conflicts: CONNECTED }),
        attr('unit', { typeGate: isUnitEligible, conflicts: CONNECTED }),
        attr('doc'),
    ],
    'nodegraph-interface-token': [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('value'), attr('doc'),
    ],

    // "Custom Node Definition Using Implementation Elements": "may define a
    // file or sourcecode attribute, or neither, but not both".
    implementation: [
        attr('name', { required: true }), attr('nodedef', { required: true }),
        attr('nodegraph'), attr('implname'),
        attr('file', { conflicts: ['sourcecode'] }), attr('sourcecode', { conflicts: ['file'] }),
        attr('function'), attr('target'), attr('format'), attr('doc'),
    ],
    // Remap <input>/<token> children: implname, plus target-specific
    // enumvalues/impltype for enum inputs and tokens.
    'implementation-input': [
        attr('name', { required: true }), attr('type'), attr('implname'),
        attr('impltype'), attr('enumvalues'), attr('doc'),
    ],
    'implementation-token': [
        attr('name', { required: true }), attr('type'), attr('impltype'), attr('enumvalues'), attr('doc'),
    ],

    // "Custom Data Types".
    typedef: [
        attr('name', { required: true }), attr('semantic'), attr('context'),
        attr('inherit'), attr('hint'), attr('doc'),
    ],
    member: [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('value', { required: true }), attr('doc'),
    ],

    // "Units": <unit name scale>.
    unittypedef: [attr('name', { required: true }), attr('doc')],
    unitdef: [attr('name', { required: true }), attr('unittype', { required: true }), attr('doc')],
    unit: [attr('name', { required: true }), attr('scale', { required: true }), attr('doc')],

    // "Target Definition", "Custom Attributes".
    targetdef: [attr('name', { required: true }), attr('inherit'), attr('doc')],
    attributedef: [
        attr('name', { required: true }), attr('attrname', { required: true }),
        attr('type', { required: true }), attr('value'),
        attr('target'), attr('elements'), attr('exportable'),
        attr('enum'), attr('enumvalues'), attr('doc'),
    ],

    // GeomExts "Look and Property Elements".
    look: [attr('name', { required: true }), attr('inherit'), attr('doc'), ...NODE_UI_POS],
    lookgroup: [
        attr('name', { required: true }), attr('looks', { required: true }),
        attr('default', { detail: 'name of the default look in this lookgroup' }),
        attr('xpos'), attr('ypos'), attr('uicolor'), attr('doc'),
    ],
    materialassign: [
        attr('name', { required: true }), attr('material', { required: true }),
        ...GEOM_OR_COLLECTION, attr('exclusive'), attr('doc'),
    ],
    variantassign: [
        attr('name', { required: true }), attr('variantset', { required: true }),
        attr('variant', { required: true }), attr('doc'),
    ],
    // "Either geom or collection must be defined but not both; similarly,
    // one cannot define both a viewergeom and a viewercollection."
    visibility: [
        attr('name', { required: true }),
        attr('viewergeom', { conflicts: ['viewercollection'] }), attr('viewercollection', { conflicts: ['viewergeom'] }),
        ...GEOM_OR_COLLECTION, attr('vistype'), attr('visible'), attr('doc'),
    ],
    propertyassign: [
        attr('name', { required: true }), attr('property', { required: true }),
        attr('type', { required: true }), attr('value', { required: true }),
        attr('target'), ...GEOM_OR_COLLECTION, attr('doc'),
    ],
    propertysetassign: [
        attr('name', { required: true }), attr('propertyset', { required: true }),
        ...GEOM_OR_COLLECTION, attr('doc'),
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
    geominfo: [attr('name', { required: true }), ...GEOM_OR_COLLECTION, attr('doc')],
    geomprop: [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('value', { required: true }),
        attr('unittype', { typeGate: isGeomUnitEligible }), attr('unit', { typeGate: isGeomUnitEligible }),
        attr('doc'),
    ],
    'geominfo-token': [attr('name', { required: true }), attr('type', { required: true }), attr('value'), attr('doc')],
    tokendefault: [attr('name', { required: true }), attr('type', { required: true }), attr('value'), attr('doc')],
    // "Geometric Properties": space/index only with geomprop, and none of
    // geomprop/space/index on uniform="true" geomprops.
    geompropdef: [
        attr('name', { required: true }), attr('type', { required: true }),
        attr('uniform', { conflicts: ['geomprop', 'space', 'index'] }),
        attr('geomprop', { conflicts: ['uniform=true'] }),
        attr('space', { requiresAny: ['geomprop'], conflicts: ['uniform=true'], when: geompropAllows(SPACE_GEOMPROPS) }),
        attr('index', { requiresAny: ['geomprop'], conflicts: ['uniform=true'], when: geompropAllows(INDEX_GEOMPROPS) }),
        attr('unittype', { typeGate: isGeomUnitEligible }), attr('unit', { typeGate: isGeomUnitEligible }),
        attr('doc'),
    ],
    // "Material Variants": variant inputs "may only define a value, not a connection".
    variantset: [attr('name', { required: true }), attr('node'), attr('nodedef'), attr('doc')],
    variant: [attr('name', { required: true }), attr('doc')],
    'variant-input': [
        attr('name', { required: true }), attr('type', { required: true }), attr('value'),
        attr('colorspace', { typeGate: isColorspaceEligible }),
        attr('unittype', { typeGate: isUnitEligible }), attr('unit', { typeGate: isUnitEligible }),
        attr('doc'),
    ],
    'variant-token': [attr('name', { required: true }), attr('type', { required: true }), attr('value'), attr('doc')],
    // "Backdrop Elements".
    backdrop: [
        attr('name', { required: true }), attr('contains'), attr('minimized'),
        attr('width'), attr('height'), attr('xpos'), attr('ypos'),
        attr('doc'),
    ],
    uifolder: [attr('name', { required: true }), attr('uifolder', { required: true }), attr('doc')],
    // "MTLX File Format Definition": standard XML XIncludes.
    'xi:include': [attr('href', { required: true })],
};

// Structural tags that map straight to a kind of the same name.
const DIRECT_KINDS = new Set(['materialx', 'nodedef', 'implementation', 'typedef', 'member', 'unittypedef',
    'unitdef', 'unit', 'targetdef', 'attributedef', 'look', 'lookgroup', 'materialassign', 'variantassign',
    'visibility', 'propertyassign', 'propertysetassign', 'propertyset', 'property', 'collection', 'geominfo',
    'geompropdef', 'variantset', 'variant', 'backdrop', 'uifolder', 'tokendefault', 'geomprop', 'xi:include']);

// classifyElement(el): maps a document-tree element ({tag, parent, attrs,
// children}) to an ATTRS_BY_KIND key. Any unrecognized tag is a node
// instance (the permissive default for custom nodes).
function classifyElement(el) {
    if (!el || !el.tag) return null;
    const tag = el.tag;
    const parentTag = el.parent && el.parent.tag;
    if (DIRECT_KINDS.has(tag)) return tag;

    if (tag === 'nodegraph') {
        if (el.attrs && el.attrs.nodedef) return 'nodegraph-functional';
        const hasInterfaceChild = (el.children || []).some((c) => c.tag === 'input' || c.tag === 'token');
        if (hasInterfaceChild || (el.attrs && el.attrs.minimized)) return 'nodegraph-compound';
        return 'nodegraph';
    }
    if (tag === 'output') return parentTag === 'nodedef' ? 'nodedef-output' : 'nodegraph-output';
    if (tag === 'input') {
        if (parentTag === 'nodedef') return 'nodedef-input';
        if (parentTag === 'implementation') return 'implementation-input';
        if (parentTag === 'nodegraph') return 'nodegraph-interface-input';
        if (parentTag === 'variant') return 'variant-input';
        return 'node-instance-input';
    }
    if (tag === 'token') {
        if (parentTag === 'nodedef') return 'nodedef-token';
        if (parentTag === 'geominfo') return 'geominfo-token';
        if (parentTag === 'nodegraph') return 'nodegraph-interface-token';
        if (parentTag === 'implementation') return 'implementation-token';
        if (parentTag === 'variant') return 'variant-token';
        return 'node-instance-token';
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
    isGeomUnitEligible,
    isColorspaceEligible,
    isColorType,
    isGeompropEligible,
    STANDARD_GEOMPROPS,
};
