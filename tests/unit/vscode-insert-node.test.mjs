// Exercises insertNodeModel.js's pure helpers behind the Insert Node view
// -- no vscode module involved, same split as vscode-actions.test.mjs over
// actionsModel.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const model = require('../../vscode_extension/src/insertNodeModel.js');
const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

test('isInsideOpenTag: true right after the tag name, false once the tag is closed', () => {
    assert.equal(model.isInsideOpenTag('<mix', 4), true);
    assert.equal(model.isInsideOpenTag('<mix name="a" ', 14), true);
    assert.equal(model.isInsideOpenTag('<mix name="a">', 14), false);
    assert.equal(model.isInsideOpenTag('<mix name="a"></mix>', 20), false);
});

test('insertPlan: normal inside position is unchanged -- cursor mode outside any open tag', () => {
    const text = '<materialx version="1.39">\n  \n</materialx>';
    const offset = text.indexOf('\n  \n') + 3; // the blank line
    const plan = model.insertPlan(text, offset);
    assert.equal(plan.mode, 'cursor');
    assert.equal(plan.offset, offset);
});

test('insertPlan: next-line mode inside a child\'s open start tag, pushing the following line down', () => {
    const text = '<materialx version="1.39">\n<mix name="a" \n  type="color3">\n</mix>\n</materialx>';
    const offset = text.indexOf('\n  ') + 1 + 2; // inside the attribute whitespace, indented 2
    assert.equal(model.isInsideOpenTag(text, offset), true);
    const plan = model.insertPlan(text, offset);
    assert.equal(plan.mode, 'next-line');
    assert.equal(plan.suffix, '\n');
    assert.equal(plan.prefix, '');
    // offset lands at the start of the CURRENT line (right after the '\n'
    // that starts it), so the new content is pushed above what's there.
    assert.equal(text.slice(0, plan.offset).endsWith('\n'), true);
});

test('insertPlan: next-line mode at the end of an unclosed document (no trailing newline) appends one', () => {
    // Still mid-edit inside <materialx> -- the whole document is only
    // implicitly closed at EOF, so there's no real </materialx> to clamp to.
    const text = '<materialx version="1.39">\n<mix name="a"';
    const plan = model.insertPlan(text, text.length);
    assert.equal(plan.mode, 'next-line');
    assert.equal(plan.prefix, '\n');
    assert.equal(plan.suffix, '');
    assert.equal(plan.offset, text.length);
});

// New behavior: never insert outside <materialx></materialx>.

test('insertPlan: cursor before <materialx> lands as the first child, right after its start tag', () => {
    const text = '<?xml version="1.0"?>\n<materialx version="1.39">\n\t\n</materialx>';
    const plan = model.insertPlan(text, 5); // inside the XML declaration
    assert.equal(plan.mode, 'first-child');
    assert.equal(plan.indent, '\t');
    assert.equal(plan.suffix, '\n');
    // Lands right after <materialx ...>'s own line, before the existing content.
    const openTagEnd = text.indexOf('">') + 2;
    const nextLine = text.indexOf('\n', openTagEnd) + 1;
    assert.equal(plan.offset, nextLine);
});

test('insertPlan: cursor inside a leading comment lands as the first child too', () => {
    const text = '<!-- a leading comment -->\n<materialx version="1.39">\n\t\n</materialx>';
    const offset = text.indexOf('leading');
    const plan = model.insertPlan(text, offset);
    assert.equal(plan.mode, 'first-child');
});

test('insertPlan: cursor after </materialx> lands as the last child, right before it', () => {
    const text = '<materialx version="1.39">\n\t<mix name="a"/>\n</materialx>\n';
    const plan = model.insertPlan(text, text.length); // past the closing tag entirely
    assert.equal(plan.mode, 'last-child');
    assert.equal(plan.indent, '\t');
    assert.equal(plan.suffix, '\n');
    const closeTagStart = text.indexOf('</materialx>');
    assert.equal(plan.offset, closeTagStart);
});

test('insertPlan: cursor inside the </materialx> end tag itself also lands as the last child', () => {
    const text = '<materialx version="1.39">\n\t<mix name="a"/>\n</materialx>';
    const offset = text.indexOf('</materialx>') + 5; // between '<' and '>'
    const plan = model.insertPlan(text, offset);
    assert.equal(plan.mode, 'last-child');
    const closeTagStart = text.indexOf('</materialx>');
    assert.equal(plan.offset, closeTagStart);
});

test('insertPlan: a self-closing <materialx ... /> root is expanded into open/close tags', () => {
    const text = '<materialx version="1.39" />';
    const plan = model.insertPlan(text, 5);
    assert.equal(plan.mode, 'expand-root');
    assert.equal(plan.replaceStart, 0);
    assert.equal(plan.replaceEnd, text.length);
    assert.equal(plan.prefix, '<materialx version="1.39">\n');
    assert.equal(plan.indent, '\t');
    assert.equal(plan.suffix, '\n</materialx>');
});

test('insertPlan: no <materialx> element at all yields the no-root mode, no insertion point', () => {
    const plan = model.insertPlan('<mix name="a"/>', 5);
    assert.deepEqual(plan, { mode: 'no-root' });
});

test('insertPlan: an empty document also yields no-root', () => {
    assert.deepEqual(model.insertPlan('', 0), { mode: 'no-root' });
});

test('lineIndent: leading whitespace of the offset\'s own line', () => {
    const text = 'a\n    <mix>\n';
    const offset = text.indexOf('<mix>');
    assert.equal(model.lineIndent(text, offset), '    ');
});

test('allNamesInText: collects every name="..." value in the document', () => {
    const text = '<materialx><image name="img1" /><standard_surface name="SR_a" /></materialx>';
    const names = model.allNamesInText(text);
    assert.ok(names.has('img1'));
    assert.ok(names.has('SR_a'));
    assert.equal(names.size, 2);
});

test('outputTypesInIndex: deduped, sorted output types across every category', () => {
    const index = {
        categories: new Map([
            ['mix', { outputTypes: ['color3', 'float'] }],
            ['add', { outputTypes: ['float'] }],
            ['noop', { outputTypes: [] }],
        ]),
    };
    assert.deepEqual(model.outputTypesInIndex(index), ['color3', 'float']);
});

test('allCategoryRows: one row per category, sorted by name', () => {
    const index = {
        categories: new Map([
            ['zzz', { library: 'lib/z', outputTypes: ['float'] }],
            ['aaa', { library: 'lib/a', outputTypes: ['color3'] }],
        ]),
    };
    const rows = model.allCategoryRows(index);
    assert.deepEqual(rows.map((r) => r.name), ['aaa', 'zzz']);
    assert.equal(rows[0].library, 'lib/a');
    assert.deepEqual(rows[0].outputTypes, ['color3']);
});

// nodedefLibraries: scans <nodedef> declarations straight off disk, a
// fixture libraries/ tree isolated from the repo's real one.
test('nodedefLibraries: library from the file path, group from nodegroup=', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtlx-ndeflib-'));
    try {
        fs.mkdirSync(path.join(dir, 'pbrlib'));
        fs.writeFileSync(path.join(dir, 'pbrlib', 'pbrlib_defs.mtlx'),
            '<nodedef name="ND_multiply_bsdfC" node="multiply" nodegroup="pbr" />');
        fs.mkdirSync(path.join(dir, 'bxdf', 'lama'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'bxdf', 'lama', 'lama_defs.mtlx'),
            '<nodedef name="ND_lama_add" node="lama_add" />'); // no nodegroup=
        const map = model.nodedefLibraries(dir);
        assert.deepEqual(map.get('ND_multiply_bsdfC'), { library: 'pbrlib', group: 'pbr' });
        assert.deepEqual(map.get('ND_lama_add'), { library: 'bxdf/lama', group: 'uncategorized' });
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('nodedefLibraries: a missing directory yields an empty map, not a throw', () => {
    const map = model.nodedefLibraries(path.join(os.tmpdir(), 'mtlx-ndeflib-does-not-exist'));
    assert.equal(map.size, 0);
});

// splitCategoryByLibrary / allCategorySplitRows: a category's sigGroups
// split by each version's real library, not mtlxCompletions.js's
// first-found-only entry.library.
test('splitCategoryByLibrary: one group per real library, own output types each', () => {
    const entry = {
        library: 'pbrlib/pbr', // first-found only, per mtlxCompletions.js
        sigGroups: [
            { type: 'BSDF', versions: [{ name: 'ND_multiply_bsdfC' }] },
            { type: 'float', versions: [{ name: 'ND_multiply_float' }] },
            { type: 'color3', versions: [{ name: 'ND_multiply_color3' }] },
        ],
    };
    const ndefLibs = new Map([
        ['ND_multiply_bsdfC', { library: 'pbrlib', group: 'pbr' }],
        ['ND_multiply_float', { library: 'stdlib', group: 'math' }],
        ['ND_multiply_color3', { library: 'stdlib', group: 'math' }],
    ]);
    const splits = model.splitCategoryByLibrary(entry, ndefLibs);
    const byKey = Object.fromEntries(splits.map((s) => [s.library + '/' + s.group, s.outputTypes]));
    assert.deepEqual(byKey['pbrlib/pbr'], ['BSDF']);
    assert.deepEqual(byKey['stdlib/math'], ['float', 'color3']);
});

test('splitCategoryByLibrary: a version nodedefLibraries never saw falls back to entry.library', () => {
    const entry = { library: 'stdlib/math', sigGroups: [{ type: 'float', versions: [{ name: 'ND_unknown' }] }] };
    const splits = model.splitCategoryByLibrary(entry, new Map());
    assert.deepEqual(splits, [{ library: 'stdlib', group: 'math', outputTypes: ['float'] }]);
});

test('allCategorySplitRows: multiply appears under both its real libraries', () => {
    const index = {
        categories: new Map([
            ['multiply', {
                library: 'pbrlib/pbr',
                sigGroups: [
                    { type: 'BSDF', versions: [{ name: 'ND_multiply_bsdfC' }] },
                    { type: 'float', versions: [{ name: 'ND_multiply_float' }] },
                ],
            }],
        ]),
    };
    const ndefLibs = new Map([
        ['ND_multiply_bsdfC', { library: 'pbrlib', group: 'pbr' }],
        ['ND_multiply_float', { library: 'stdlib', group: 'math' }],
    ]);
    const rows = model.allCategorySplitRows(index, ndefLibs);
    assert.deepEqual(rows.map((r) => r.library).sort(), ['pbrlib/pbr', 'stdlib/math']);
    assert.ok(rows.every((r) => r.name === 'multiply'));
});

// Against the real repo: multiply genuinely has nodedefs in both pbrlib
// and stdlib (the bug this fix addresses -- picking either used to be
// impossible, only pbrlib/pbr ever showed).
test('allCategorySplitRows + buildInsertTree: multiply under both stdlib/math and pbrlib/pbr, in docs order', () => {
    const mtlxCompletions = require('../../vscode_extension/src/mtlxCompletions.js');
    const REPO_ROOT = path.join(__dirname, '..', '..');
    const index = mtlxCompletions.getLibraryIndex(REPO_ROOT);
    const ndefLibs = model.nodedefLibraries(path.join(REPO_ROOT, 'libraries'));
    const rows = model.allCategorySplitRows(index, ndefLibs)
        .filter((r) => r.name === 'multiply')
        .map((r) => ({ ...r, orderedOutputTypes: mtlxCompletions.orderTypeChoices(r.outputTypes, null) }));
    assert.deepEqual(rows.map((r) => r.library).sort(), ['pbrlib/pbr', 'stdlib/math']);

    const stdlibRow = rows.find((r) => r.library === 'stdlib/math');
    for (const t of ['float', 'color3', 'color4', 'vector2', 'vector3', 'vector4']) {
        assert.ok(stdlibRow.outputTypes.includes(t), t);
    }
    const pbrlibRow = rows.find((r) => r.library === 'pbrlib/pbr');
    assert.deepEqual(pbrlibRow.outputTypes.sort(), ['BSDF', 'EDF', 'VDF']);

    const nodelib = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'js', 'gen', 'nodelib.json'), 'utf8'));
    const docOrder = model.docOrderFromNodelib(nodelib);
    const tree = model.buildInsertTree(rows, docOrder);
    const keys = tree.map((g) => g.key);
    // pbrlib comes before stdlib in js/gen/nodelib.json's own key order.
    assert.ok(keys.indexOf('pbrlib/pbr') < keys.indexOf('stdlib/math'));
});

// docOrderFromNodelib / buildInsertTree: the tree must mirror the docs
// view's default order, which is just js/gen/nodelib.json's own key order.

// This fixture's key order deliberately isn't alphabetical (texture2d
// before pbr, math before channel), so an accidental alphabetical sort
// would fail these tests.
const SAMPLE_NODELIB = {
    bxdf: {
        texture2d: { image_bsdf: {} },
        pbr: { standard_surface: {}, open_pbr_surface: {} },
    },
    stdlib: {
        math: { add: {}, multiply: {} },
        channel: { extract: {} },
    },
};

test('docOrderFromNodelib: library rank, then group rank within it, from the JSON\'s own key order', () => {
    const docOrder = model.docOrderFromNodelib(SAMPLE_NODELIB);
    const bxdfPbr = docOrder.groupOrder.get('bxdf/pbr');
    const bxdfTexture2d = docOrder.groupOrder.get('bxdf/texture2d');
    const stdlibMath = docOrder.groupOrder.get('stdlib/math');
    const stdlibChannel = docOrder.groupOrder.get('stdlib/channel');

    assert.equal(bxdfTexture2d.libraryRank, 0);
    assert.equal(bxdfPbr.libraryRank, 0);
    assert.ok(bxdfTexture2d.groupRank < bxdfPbr.groupRank); // texture2d listed before pbr in the fixture
    assert.ok(bxdfPbr.libraryRank < stdlibMath.libraryRank); // bxdf listed before stdlib
    assert.ok(stdlibMath.groupRank < stdlibChannel.groupRank); // math listed before channel
});

test('docOrderFromNodelib: node rank within a group follows the JSON\'s own key order', () => {
    const docOrder = model.docOrderFromNodelib(SAMPLE_NODELIB);
    const ranks = docOrder.nodeOrder.get('bxdf/pbr');
    assert.ok(ranks.get('standard_surface') < ranks.get('open_pbr_surface'));
});

test('buildInsertTree: groups sorted to match docOrderFromNodelib, nodes sorted within each group', () => {
    const docOrder = model.docOrderFromNodelib(SAMPLE_NODELIB);
    const rows = [
        { name: 'multiply', library: 'stdlib/math', outputTypes: ['float'] },
        { name: 'add', library: 'stdlib/math', outputTypes: ['float'] },
        { name: 'extract', library: 'stdlib/channel', outputTypes: ['float'] },
        { name: 'open_pbr_surface', library: 'bxdf/pbr', outputTypes: ['surfaceshader'] },
        { name: 'standard_surface', library: 'bxdf/pbr', outputTypes: ['surfaceshader'] },
        { name: 'image_bsdf', library: 'bxdf/texture2d', outputTypes: ['BSDF'] },
    ];
    const tree = model.buildInsertTree(rows, docOrder);

    // Group order: bxdf/texture2d, bxdf/pbr, stdlib/math, stdlib/channel --
    // exactly docOrderFromNodelib's own ranking, not alphabetical.
    assert.deepEqual(tree.map((g) => g.key), ['bxdf/texture2d', 'bxdf/pbr', 'stdlib/math', 'stdlib/channel']);
    assert.deepEqual(tree.map((g) => g.library), ['bxdf', 'bxdf', 'stdlib', 'stdlib']);
    assert.deepEqual(tree.map((g) => g.group), ['texture2d', 'pbr', 'math', 'channel']);

    // Node order within a group: the JSON's own order (standard_surface
    // before open_pbr_surface, add before multiply), not the row array's
    // own (reversed) order and not alphabetical.
    const pbrGroup = tree.find((g) => g.key === 'bxdf/pbr');
    assert.deepEqual(pbrGroup.nodes.map((n) => n.name), ['standard_surface', 'open_pbr_surface']);
    const mathGroup = tree.find((g) => g.key === 'stdlib/math');
    assert.deepEqual(mathGroup.nodes.map((n) => n.name), ['add', 'multiply']);
});

test('buildInsertTree: a category the docs order never saw sorts after every known group', () => {
    const docOrder = model.docOrderFromNodelib(SAMPLE_NODELIB);
    const rows = [
        { name: 'multiply', library: 'stdlib/math', outputTypes: ['float'] },
        { name: 'mystery', library: 'newlib/newgroup', outputTypes: ['float'] },
    ];
    const tree = model.buildInsertTree(rows, docOrder);
    assert.deepEqual(tree.map((g) => g.key), ['stdlib/math', 'newlib/newgroup']);
});

// filterInsertTree: search filtering + auto-expand model (media/
// actions-view.js's filterTree mirrors this by hand).
const SAMPLE_TREE = [
    { key: 'bxdf/pbr', library: 'bxdf', group: 'pbr', nodes: [
        { name: 'standard_surface', library: 'bxdf/pbr' },
        { name: 'open_pbr_surface', library: 'bxdf/pbr' },
    ] },
    { key: 'stdlib/math', library: 'stdlib', group: 'math', nodes: [
        { name: 'add', library: 'stdlib/math' },
        { name: 'multiply', library: 'stdlib/math' },
    ] },
];

test('filterInsertTree: empty term keeps every group/node, matched false', () => {
    const out = model.filterInsertTree(SAMPLE_TREE, '');
    assert.equal(out.length, 2);
    assert.equal(out[0].nodes.length, 2);
    assert.equal(out.every((g) => g.matched === false), true);
});

test('filterInsertTree: a term narrows to matching nodes, drops groups with none, marks matched', () => {
    const out = model.filterInsertTree(SAMPLE_TREE, 'add');
    assert.deepEqual(out.map((g) => g.key), ['stdlib/math']);
    assert.deepEqual(out[0].nodes.map((n) => n.name), ['add']);
    assert.equal(out[0].matched, true);
});

test('filterInsertTree: matches a node\'s library too, case-insensitively', () => {
    const out = model.filterInsertTree(SAMPLE_TREE, 'PBR');
    assert.deepEqual(out.map((g) => g.key), ['bxdf/pbr']);
    assert.equal(out[0].nodes.length, 2); // both nodes carry library "bxdf/pbr"
});

test('filterInsertTree: no match anywhere returns an empty array', () => {
    assert.deepEqual(model.filterInsertTree(SAMPLE_TREE, 'zzz_no_such_node'), []);
});

// rememberLastType / preferredOutputType: per-category last-used type
// memory (extension globalState).
test('rememberLastType: sets the category, never mutates the input map', () => {
    const map = { mix: 'color3' };
    const next = model.rememberLastType(map, 'multiply', 'float');
    assert.deepEqual(map, { mix: 'color3' }); // unchanged
    assert.equal(next.multiply, 'float');
    assert.equal(next.mix, 'color3');
});

test('rememberLastType: updating an existing category overwrites its type', () => {
    const map = { multiply: 'color3' };
    const next = model.rememberLastType(map, 'multiply', 'float');
    assert.equal(next.multiply, 'float');
});

test('rememberLastType: caps the map, evicting the oldest entry first', () => {
    let map = {};
    map = model.rememberLastType(map, 'a', 'float', 2);
    map = model.rememberLastType(map, 'b', 'float', 2);
    map = model.rememberLastType(map, 'c', 'float', 2);
    assert.deepEqual(Object.keys(map), ['b', 'c']); // 'a' was the oldest, evicted
});

test('preferredOutputType: the remembered type when it is still offered', () => {
    const t = model.preferredOutputType({ multiply: 'float' }, 'multiply', ['color3', 'float', 'vector3']);
    assert.equal(t, 'float');
});

test('preferredOutputType: falls back to the ordering\'s own first entry with no memory, or a stale one', () => {
    assert.equal(model.preferredOutputType({}, 'multiply', ['color3', 'float']), 'color3');
    assert.equal(model.preferredOutputType({ multiply: 'BSDF' }, 'multiply', ['color3', 'float']), 'color3');
});

test('preferredOutputType: null with no types at all', () => {
    assert.equal(model.preferredOutputType({}, 'multiply', []), null);
});

// pinOutputType: rewrites buildNodeElementSnippet()'s type-choice tabstop
// to a literal, already-chosen type, and renumbers the name tabstop to 1
// so accepting the snippet lands on the name instead.
test('pinOutputType: a valid choice becomes literal, name tabstop renumbered to 1', () => {
    const body = 'multiply name="${2:multiply1}" type="${1|float,color3,vector3|}">$0</multiply>';
    const out = model.pinOutputType(body, 'color3');
    assert.equal(out, 'multiply name="${1:multiply1}" type="color3">$0</multiply>');
});

test('pinOutputType: an outputType not among the choices leaves the body unchanged', () => {
    const body = 'multiply name="${2:multiply1}" type="${1|float,color3|}">$0</multiply>';
    assert.equal(model.pinOutputType(body, 'BSDF'), body);
});

test('pinOutputType: null/non-string outputType leaves the body unchanged', () => {
    const body = 'multiply name="${2:multiply1}" type="${1|float,color3|}">$0</multiply>';
    assert.equal(model.pinOutputType(body, null), body);
    assert.equal(model.pinOutputType(body, undefined), body);
});

test('pinOutputType: a body with no type-choice tabstop (already fixed) is returned unchanged', () => {
    const body = 'multiply name="${1:multiply1}" type="float">$0</multiply>';
    assert.equal(model.pinOutputType(body, 'float'), body);
});

// Against the real committed js/gen/nodelib.json: flattened by hand here
// (not through docOrderFromNodelib), an independent check rather than
// the function testing itself.
test('docOrderFromNodelib: matches the Node Specs docs order for the real js/gen/nodelib.json', () => {
    const nodelib = JSON.parse(fs.readFileSync(new URL('../../js/gen/nodelib.json', import.meta.url), 'utf8'));
    const docsFlatOrder = [];
    for (const lib of Object.keys(nodelib)) {
        for (const group of Object.keys(nodelib[lib])) docsFlatOrder.push(lib + '/' + group);
    }

    const docOrder = model.docOrderFromNodelib(nodelib);
    const derivedOrder = Array.from(docOrder.groupOrder.entries())
        .sort((a, b) => a[1].libraryRank - b[1].libraryRank || a[1].groupRank - b[1].groupRank)
        .map(([key]) => key);

    assert.deepEqual(derivedOrder, docsFlatOrder);
    assert.ok(docsFlatOrder.length > 5); // sanity: nodelib.json actually has several lib/group pairs
});
