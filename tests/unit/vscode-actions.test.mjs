// Exercises actionsModel.js's pure row builder, message-type validator and
// About-data assembly -- no vscode module involved (actionsView.js is the
// thin WebviewViewProvider wrapper), same split as vscode-outline.test.mjs
// over outlineModel.js/outlineView.js.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const actionsModel = require('../../vscode_extension/src/actionsModel.js');

test('buildActionRows: seven rows, in the specified order (Material Viewer before Graph Editor)', () => {
    const rows = actionsModel.buildActionRows(false, false);
    assert.deepEqual(rows.map((r) => r.id), [
        'newDocument', 'openDocs', 'openInMaterialViewer', 'openInGraphEditor',
        'filterDocsByFile', 'insertNode', 'newFromExample',
    ]);
    assert.equal(rows.find((r) => r.id === 'openDocs').icon, 'book');
    assert.equal(rows.find((r) => r.id === 'newFromExample').variant, 'primary');
    assert.equal(rows.find((r) => r.id === 'insertNode').variant, 'primary');
    assert.equal(rows.find((r) => r.id === 'filterDocsByFile').variant, 'secondary');
});

test('buildActionRows: newFromExample and insertNode toggle their own panel, no command', () => {
    const rows = actionsModel.buildActionRows(false, true);
    const example = rows.find((r) => r.id === 'newFromExample');
    const insert = rows.find((r) => r.id === 'insertNode');
    assert.equal(example.toggle, 'examples');
    assert.equal(example.command, null);
    assert.equal(insert.toggle, 'insertNode');
    assert.equal(insert.command, null);
});

test('buildActionRows: only the two toggle rows carry a toggle field', () => {
    const rows = actionsModel.buildActionRows(true, true);
    for (const row of rows) {
        if (row.id === 'newFromExample' || row.id === 'insertNode') continue;
        assert.equal(row.toggle, null);
    }
});

test('buildActionRows: no active document disables the three document-scoped rows', () => {
    const rows = actionsModel.buildActionRows(false, true);
    for (const id of ['openInGraphEditor', 'openInMaterialViewer', 'filterDocsByFile']) {
        const row = rows.find((r) => r.id === id);
        assert.equal(row.disabled, true);
        assert.equal(row.command, null);
        assert.equal(row.description, 'Open a MaterialX file first');
    }
});

test('buildActionRows: active document enables the three document-scoped rows', () => {
    const rows = actionsModel.buildActionRows(true, true);
    const graph = rows.find((r) => r.id === 'openInGraphEditor');
    const viewer = rows.find((r) => r.id === 'openInMaterialViewer');
    const filter = rows.find((r) => r.id === 'filterDocsByFile');
    assert.equal(graph.disabled, false);
    assert.equal(graph.command, 'materialxPlayground.openInGraphEditor');
    assert.equal(graph.description, undefined);
    assert.equal(viewer.command, 'materialxPlayground.openInMaterialViewer');
    assert.equal(filter.command, 'materialxPlayground.filterDocsByFile');
});

test('buildActionRows: insertNode is gated on hasMtlxTextEditor, independent of hasActiveDocument', () => {
    const withDocNoTextEditor = actionsModel.buildActionRows(true, false);
    const row1 = withDocNoTextEditor.find((r) => r.id === 'insertNode');
    assert.equal(row1.disabled, true);
    assert.equal(row1.description, 'Open a .mtlx file in the text editor to insert nodes.');

    const withTextEditorNoDoc = actionsModel.buildActionRows(false, true);
    const row2 = withTextEditorNoDoc.find((r) => r.id === 'insertNode');
    assert.equal(row2.disabled, false);
    assert.equal(row2.description, undefined);
});

test('buildActionRows: other rows are always enabled regardless of document/editor', () => {
    for (const hasDoc of [false, true]) {
        for (const hasEditor of [false, true]) {
            const rows = actionsModel.buildActionRows(hasDoc, hasEditor);
            for (const id of ['newFromExample', 'newDocument', 'openDocs']) {
                const row = rows.find((r) => r.id === id);
                assert.equal(row.disabled, false);
            }
        }
    }
});

test('buildActionRows: layout is "half" for every row except the two toggle rows', () => {
    const rows = actionsModel.buildActionRows(true, true);
    for (const row of rows) {
        const isToggle = row.id === 'newFromExample' || row.id === 'insertNode';
        assert.equal(row.layout, isToggle ? null : 'half');
    }
});

test('buildActionRows: every half-layout row carries a shortLabel, full label unchanged', () => {
    const rows = actionsModel.buildActionRows(true, true);
    const expected = {
        newDocument: 'New Document',
        openDocs: 'Node Docs',
        openInGraphEditor: 'Graph Editor',
        openInMaterialViewer: 'Material Viewer',
        filterDocsByFile: 'Filter Docs by File',
    };
    for (const row of rows) {
        if (row.layout !== 'half') continue;
        assert.equal(row.shortLabel, expected[row.id]);
        assert.ok(row.label.length > row.shortLabel.length);
    }
});

test('buildActionRows: the two full-width toggle rows have no shortLabel', () => {
    const rows = actionsModel.buildActionRows(true, true);
    for (const id of ['newFromExample', 'insertNode']) {
        const row = rows.find((r) => r.id === id);
        assert.equal(row.shortLabel, null);
    }
    assert.equal(rows.find((r) => r.id === 'newFromExample').label, 'New Material from Example');
    assert.equal(rows.find((r) => r.id === 'insertNode').label, 'Insert Node');
});

test('isValidMessageType: accepts the known set, rejects anything else', () => {
    for (const type of ['ready', 'run', 'toggleExamples', 'toggleInsertNode', 'insertNode', 'about', 'github', 'rendered', 'openHelpLink']) {
        assert.equal(actionsModel.isValidMessageType(type), true);
    }
    for (const type of ['open', 'toggle', 'exec', '', undefined, null, 123, '__proto__']) {
        assert.equal(actionsModel.isValidMessageType(type), false);
    }
});

test('nextGroupExpansion: expanding one group collapses the other', () => {
    const collapsed = { examples: false, insertNode: false };
    const expandInsert = actionsModel.nextGroupExpansion(collapsed, 'insertNode', true);
    assert.deepEqual(expandInsert, { examples: false, insertNode: true });
    const expandExamples = actionsModel.nextGroupExpansion(expandInsert, 'examples', true);
    assert.deepEqual(expandExamples, { examples: true, insertNode: false });
});

test('nextGroupExpansion: collapsing one group never expands the other', () => {
    const bothExpandedIsImpossible = { examples: true, insertNode: false };
    const next = actionsModel.nextGroupExpansion(bothExpandedIsImpossible, 'examples', false);
    assert.deepEqual(next, { examples: false, insertNode: false });
});

test('decideColumnLayout: flips only after two consecutive disagreeing readings (hysteresis)', () => {
    let step = actionsModel.decideColumnLayout('two', true, 0);
    assert.deepEqual(step, { mode: 'two', streak: 1 });
    step = actionsModel.decideColumnLayout(step.mode, true, step.streak);
    assert.deepEqual(step, { mode: 'single', streak: 0 });
});

test('decideColumnLayout: an agreeing reading resets the streak, no flip', () => {
    let step = actionsModel.decideColumnLayout('two', true, 0);
    assert.deepEqual(step, { mode: 'two', streak: 1 });
    step = actionsModel.decideColumnLayout(step.mode, false, step.streak);
    assert.deepEqual(step, { mode: 'two', streak: 0 });
});

test('isValidHelpLinkId: accepts the three overflow-menu ids, rejects anything else', () => {
    for (const id of ['tutorials', 'reportIssue', 'whatsNew']) {
        assert.equal(actionsModel.isValidHelpLinkId(id), true);
    }
    for (const id of ['github', '', undefined, null, 123, '__proto__']) {
        assert.equal(actionsModel.isValidHelpLinkId(id), false);
    }
});

test('platformLabel: maps the three known Node platforms, passes through/falls back otherwise', () => {
    assert.equal(actionsModel.platformLabel('win32'), 'Windows');
    assert.equal(actionsModel.platformLabel('darwin'), 'macOS');
    assert.equal(actionsModel.platformLabel('linux'), 'Linux');
    assert.equal(actionsModel.platformLabel('freebsd'), 'freebsd');
    assert.equal(actionsModel.platformLabel(undefined), 'unknown');
});

test('buildIssueUrl: a GitHub new-issue URL with an encoded, version-stamped title and body', () => {
    const url = actionsModel.buildIssueUrl({
        repoUrl: 'https://github.com/joaovbs96/MaterialXPlayground',
        extensionVersionText: 'v2026.8.11',
        vscodeVersion: '1.95.0',
        mtlxVersion: 'v1.39.5',
        platform: 'Windows',
    });
    assert.ok(url.startsWith('https://github.com/joaovbs96/MaterialXPlayground/issues/new?title='));
    const params = new URLSearchParams(url.split('?')[1]);
    assert.ok(params.get('title').includes('v2026.8.11'));
    const body = params.get('body');
    assert.ok(body.includes('Extension: v2026.8.11'));
    assert.ok(body.includes('VS Code: 1.95.0'));
    assert.ok(body.includes('MaterialX: v1.39.5'));
    assert.ok(body.includes('OS: Windows'));
});

test('buildIssueUrl: falls back to "n/a" for missing version facts', () => {
    const url = actionsModel.buildIssueUrl({ repoUrl: 'https://example.com/repo' });
    const body = new URLSearchParams(url.split('?')[1]).get('body');
    assert.ok(body.includes('Extension: n/a'));
    assert.ok(body.includes('VS Code: n/a'));
    assert.ok(body.includes('MaterialX: n/a'));
    assert.ok(body.includes('OS: n/a'));
});

test('buildAboutData: skips vscode:false vendor entries, keeps the rest', () => {
    const data = actionsModel.buildAboutData({
        extensionVersion: '2026.8.11',
        vscodeVersion: '1.95.0',
        mtlxTag: 'v1.39.5',
        vendorDeps: {
            three: { name: 'three.js', licenseUrl: 'https://example.com/three' },
            basisEncoder: { name: 'Basis Universal', licenseUrl: 'https://example.com/basis', vscode: false },
        },
        repoUrl: 'https://github.com/joaovbs96/MaterialXPlayground',
        issuesUrl: 'https://github.com/joaovbs96/MaterialXPlayground/issues',
        license: 'MIT License text',
        licenseError: false,
    });

    const names = data.vendorEntries.map((l) => l.name);
    assert.ok(names.includes('three.js'));
    assert.ok(!names.includes('Basis Universal'));
    // Hand-vendored static entries (MaterialX itself, Tabler Icons, ...)
    // are always present, mirroring js/shell.jsx's STATIC_LIBRARIES.
    assert.ok(names.includes('MaterialX'));
    assert.equal(data.extensionVersionText, 'v2026.8.11');
    assert.equal(data.vscodeVersion, '1.95.0');
    assert.equal(data.mtlxVersion, 'v1.39.5');
    assert.equal(data.mtlxReleaseUrl, 'https://github.com/AcademySoftwareFoundation/MaterialX/releases/tag/v1.39.5');
    assert.equal(data.license, 'MIT License text');
    assert.equal(data.licenseError, false);
});

test('buildAboutData: falls back gracefully with no version/license info', () => {
    const data = actionsModel.buildAboutData({});
    assert.equal(data.extensionVersionText, 'n/a');
    assert.equal(data.vscodeVersion, 'n/a');
    assert.equal(data.mtlxVersion, null);
    assert.equal(data.mtlxReleaseUrl, null);
    assert.equal(data.license, null);
    assert.equal(data.licenseError, false);
    assert.ok(data.vendorEntries.length > 0); // static libraries alone
});

test('buildAboutData: vendor entries are deduped by name and sorted', () => {
    const data = actionsModel.buildAboutData({
        vendorDeps: {
            a: { name: 'MaterialX', licenseUrl: 'https://example.com/dup' }, // dupes a static entry
        },
    });
    const names = data.vendorEntries.map((l) => l.name);
    assert.equal(names.filter((n) => n === 'MaterialX').length, 1);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(names, sorted);
});

// reflowLicenseText: shaped like the real Apache-2.0 LICENSE file the
// extension ships -- a 3-line centered title block with no blank lines
// between them, then blank-line-separated sections including a numbered
// heading, a wrapped body paragraph and (a)/(b) list items.
const APACHE_SAMPLE = [
    '                                 Apache License',
    '                           Version 2.0, January 2004',
    '                        http://www.apache.org/licenses/',
    '',
    '   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION',
    '',
    '   1. Definitions.',
    '',
    '      "License" shall mean the terms and conditions for use, reproduction,',
    '      and distribution as defined by Sections 1 through 9 of this document.',
    '',
    '   4. Redistribution. You may reproduce and distribute copies of the Work',
    '      provided that You meet the following conditions:',
    '',
    '      (a) You must give any other recipients of the Work or',
    '          Derivative Works a copy of this License; and',
    '',
    '      (b) You must cause any modified files to carry prominent notices',
    '          stating that You changed the files; and',
].join('\n');

test('reflowLicenseText: centered title lines each stay their own paragraph', () => {
    const paragraphs = actionsModel.reflowLicenseText(APACHE_SAMPLE);
    assert.equal(paragraphs[0], 'Apache License');
    assert.equal(paragraphs[1], 'Version 2.0, January 2004');
    assert.equal(paragraphs[2], 'http://www.apache.org/licenses/');
});

test('reflowLicenseText: section heading and numbered section stay isolated', () => {
    const paragraphs = actionsModel.reflowLicenseText(APACHE_SAMPLE);
    assert.ok(paragraphs.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'));
    assert.ok(paragraphs.includes('1. Definitions.'));
});

test('reflowLicenseText: a wrapped paragraph body is joined onto one line', () => {
    const paragraphs = actionsModel.reflowLicenseText(APACHE_SAMPLE);
    assert.ok(paragraphs.includes(
        '"License" shall mean the terms and conditions for use, reproduction, '
        + 'and distribution as defined by Sections 1 through 9 of this document.'
    ));
});

test('reflowLicenseText: (a)/(b) list items each stay their own paragraph, joined internally', () => {
    const paragraphs = actionsModel.reflowLicenseText(APACHE_SAMPLE);
    assert.ok(paragraphs.includes('(a) You must give any other recipients of the Work or Derivative Works a copy of this License; and'));
    assert.ok(paragraphs.includes('(b) You must cause any modified files to carry prominent notices stating that You changed the files; and'));
});

test('reflowLicenseText: no line break characters survive in any paragraph', () => {
    const paragraphs = actionsModel.reflowLicenseText(APACHE_SAMPLE);
    for (const p of paragraphs) assert.ok(!/\n/.test(p));
});

test('reflowLicenseText: empty/missing input yields an empty array', () => {
    assert.deepEqual(actionsModel.reflowLicenseText(''), []);
    assert.deepEqual(actionsModel.reflowLicenseText(null), []);
    assert.deepEqual(actionsModel.reflowLicenseText(undefined), []);
});

test('buildAboutData: licenseParagraphs is the reflowed license, empty array with no license', () => {
    const withLicense = actionsModel.buildAboutData({ license: APACHE_SAMPLE });
    assert.ok(Array.isArray(withLicense.licenseParagraphs));
    assert.ok(withLicense.licenseParagraphs.length > 3);
    assert.equal(withLicense.licenseParagraphs[0], 'Apache License');

    const withoutLicense = actionsModel.buildAboutData({});
    assert.deepEqual(withoutLicense.licenseParagraphs, []);
});

test('decideColumnLayout: fast narrow then wide settles on two columns after the confirming reading', () => {
    let step = { mode: 'two', streak: 0 };
    for (const truncated of [true, true]) step = actionsModel.decideColumnLayout(step.mode, truncated, step.streak);
    assert.equal(step.mode, 'single');
    // One resize callback after the widen, then the scheduled re-read.
    step = actionsModel.decideColumnLayout(step.mode, false, step.streak);
    assert.deepEqual(step, { mode: 'single', streak: 1 });
    step = actionsModel.decideColumnLayout(step.mode, false, step.streak);
    assert.deepEqual(step, { mode: 'two', streak: 0 });
});

test('actions-view.js re-reads while a layout flip is pending', () => {
    const src = fs.readFileSync(new URL('../../vscode_extension/media/actions-view.js', import.meta.url), 'utf8');
    assert.match(src, /if \(columnStreak > 0\) columnTimer = setTimeout\(updateColumnLayout/);
});

test('insert node: remembered type is posted right after the memory update, and drives the next default', () => {
    const src = fs.readFileSync(new URL('../../vscode_extension/src/actionsView.js', import.meta.url), 'utf8');
    assert.match(src, /globalState\.update\(LAST_TYPES_KEY, next\);\s*(\/\/[^\n]*\n\s*)*this\._postState\(\);/);
    const ins = require('../../vscode_extension/src/insertNodeModel.js');
    const ordered = ['color3', 'float', 'color4'];
    assert.equal(ins.preferredOutputType({}, 'multiply', ordered), 'color3');
    const mem = ins.rememberLastType({}, 'multiply', 'float');
    assert.equal(ins.preferredOutputType(mem, 'multiply', ordered), 'float');
});
