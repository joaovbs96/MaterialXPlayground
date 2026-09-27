// Exercises actionsModel.js's pure row builder, message-type validator and
// About-data assembly -- no vscode module involved (actionsView.js is the
// thin WebviewViewProvider wrapper), same split as vscode-outline.test.mjs
// over outlineModel.js/outlineView.js.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const actionsModel = require('../../vscode_extension/src/actionsModel.js');

test('buildActionRows: six rows, in the specified order, with icons and variants', () => {
    const rows = actionsModel.buildActionRows(false);
    assert.deepEqual(rows.map((r) => r.id), [
        'newDocument', 'openDocs',
        'openInGraphEditor', 'openInMaterialViewer', 'filterDocsByFile', 'newFromExample',
    ]);
    assert.equal(rows.find((r) => r.id === 'openDocs').icon, 'book');
    assert.equal(rows.find((r) => r.id === 'newFromExample').variant, 'primary');
    assert.equal(rows.find((r) => r.id === 'filterDocsByFile').variant, 'secondary');
});

test('buildActionRows: newFromExample toggles the embedded examples panel, no command', () => {
    const rows = actionsModel.buildActionRows(false);
    const row = rows.find((r) => r.id === 'newFromExample');
    assert.equal(row.toggle, 'examples');
    assert.equal(row.command, null);
});

test('buildActionRows: only newFromExample carries a toggle field', () => {
    const rows = actionsModel.buildActionRows(true);
    for (const row of rows) {
        if (row.id === 'newFromExample') continue;
        assert.equal(row.toggle, null);
    }
});

test('buildActionRows: no active document disables the two "Open in ..." rows', () => {
    const rows = actionsModel.buildActionRows(false);
    const graph = rows.find((r) => r.id === 'openInGraphEditor');
    const viewer = rows.find((r) => r.id === 'openInMaterialViewer');
    assert.equal(graph.disabled, true);
    assert.equal(graph.command, null);
    assert.equal(graph.description, 'Open a MaterialX file first');
    assert.equal(viewer.disabled, true);
    assert.equal(viewer.command, null);
});

test('buildActionRows: active document enables the two "Open in ..." rows', () => {
    const rows = actionsModel.buildActionRows(true);
    const graph = rows.find((r) => r.id === 'openInGraphEditor');
    const viewer = rows.find((r) => r.id === 'openInMaterialViewer');
    assert.equal(graph.disabled, false);
    assert.equal(graph.command, 'materialxPlayground.openInGraphEditor');
    assert.equal(graph.description, undefined);
    assert.equal(viewer.command, 'materialxPlayground.openInMaterialViewer');
});

test('buildActionRows: other rows are always enabled regardless of document', () => {
    for (const hasDoc of [false, true]) {
        const rows = actionsModel.buildActionRows(hasDoc);
        for (const id of ['newFromExample', 'newDocument', 'openDocs', 'filterDocsByFile']) {
            const row = rows.find((r) => r.id === id);
            assert.equal(row.disabled, false);
        }
        assert.ok(rows.find((r) => r.id === 'newDocument').command);
    }
});

test('isValidMessageType: accepts the known set, rejects anything else', () => {
    for (const type of ['ready', 'run', 'toggleExamples', 'about', 'github', 'rendered']) {
        assert.equal(actionsModel.isValidMessageType(type), true);
    }
    for (const type of ['open', 'toggle', 'exec', '', undefined, null, 123, '__proto__']) {
        assert.equal(actionsModel.isValidMessageType(type), false);
    }
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
