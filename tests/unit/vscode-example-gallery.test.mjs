// Unit tests for exampleGalleryModel.js: grouping (same source-based
// grouping the old QuickPick used), the search filter, thumb-id mapping
// via an inline gallery/manifest.json fixture (gallery/ is gitignored),
// and the message-validation helper isKnownCardId rejecting anything not
// in the current group list. Same 'vscode' stub trick as
// vscode-example-thumbs.test.mjs, since newFromExample.js (required
// transitively) touches vscode at module scope.
import assert from 'node:assert/strict';
import test from 'node:test';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const vscodeStub = { QuickPickItemKind: { Separator: 1 }, Uri: {}, window: {}, commands: {}, workspace: {} };
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.call(this, request, ...rest);
};
const galleryModel = require('../../vscode_extension/src/exampleGalleryModel.js');
const exampleCatalog = require('../../vscode_extension/src/exampleCatalog.js');
Module._load = originalLoad;

// Trimmed gallery/manifest.json fixture, same shapes as
// vscode-example-thumbs.test.mjs's FIXTURE_MATERIALS.
const MATERIALS = [
    {
        id: 'AnimatedChristmasTreeOrnament',
        origin: 'playground',
        docPath: 'materials/AnimatedChristmasTreeOrnament/ChristmasTreeOrnament016_1K-JPG.mtlx',
    },
    {
        id: 'Motley_Patchwork_Rug',
        origin: 'playground',
        docPath: 'materials/Motley_Patchwork_Rug/Motley_Patchwork_Rug.mtlx',
    },
    {
        id: 'open_pbr_glass',
        origin: 'materialx',
        docPath: 'resources/Materials/Examples/OpenPbr/open_pbr_glass.mtlx',
    },
];

test('buildGalleryData: groups by source in catalog order, 14 cards total', () => {
    const groups = galleryModel.buildGalleryData(exampleCatalog.getCatalog(), MATERIALS);
    assert.deepEqual(groups.map((g) => g.source), ['MaterialX Playground', 'MaterialX Examples']);
    const total = groups.reduce((n, g) => n + g.cards.length, 0);
    assert.equal(total, 14);
});

test('buildGalleryData: thumbId set only for entries the fixture manifest matches', () => {
    const groups = galleryModel.buildGalleryData(exampleCatalog.getCatalog(), MATERIALS);
    const allCards = groups.flatMap((g) => g.cards);
    const ornament = allCards.find((c) => c.id === 'playground-christmas-tree-ornament');
    const rug = allCards.find((c) => c.id === 'playground-motley-patchwork-rug');
    const glass = allCards.find((c) => c.id === 'example-open-pbr-glass');
    const untouched = allCards.find((c) => c.id === 'playground-open-pbr-default');
    assert.equal(ornament.thumbId, 'AnimatedChristmasTreeOrnament');
    assert.equal(rug.thumbId, 'Motley_Patchwork_Rug');
    assert.equal(glass.thumbId, 'open_pbr_glass');
    assert.equal(untouched.thumbId, null);
});

test('filterGroups: matches label, shading model or license, case-insensitively', () => {
    const groups = galleryModel.buildGalleryData(exampleCatalog.getCatalog(), MATERIALS);

    const byName = galleryModel.filterGroups(groups, 'gold');
    assert.equal(byName.flatMap((g) => g.cards).length, 1);
    assert.equal(byName[0].cards[0].id, 'example-standard-surface-gold');

    const byShadingModel = galleryModel.filterGroups(groups, 'OPEN_PBR_SURFACE');
    assert.ok(byShadingModel.flatMap((g) => g.cards).length > 1);

    const byLicense = galleryModel.filterGroups(groups, 'apache-2.0');
    assert.ok(byLicense.every((g) => g.source === 'MaterialX Examples'));
});

test('filterGroups: drops groups left with no matching cards, keeps all for an empty query', () => {
    const groups = galleryModel.buildGalleryData(exampleCatalog.getCatalog(), MATERIALS);
    const none = galleryModel.filterGroups(groups, 'nonexistent-search-term-xyz');
    assert.deepEqual(none, []);
    assert.deepEqual(galleryModel.filterGroups(groups, ''), groups);
    assert.deepEqual(galleryModel.filterGroups(groups, '   '), groups);
});

test('isKnownCardId: true only for an id present in these exact groups', () => {
    const groups = galleryModel.buildGalleryData(exampleCatalog.getCatalog(), MATERIALS);
    assert.equal(galleryModel.isKnownCardId(groups, 'example-standard-surface-gold'), true);
    assert.equal(galleryModel.isKnownCardId(groups, 'not-a-real-id'), false);
    assert.equal(galleryModel.isKnownCardId(groups, '__proto__'), false);
    assert.equal(galleryModel.isKnownCardId(groups, ''), false);

    const filtered = galleryModel.filterGroups(groups, 'gold');
    assert.equal(galleryModel.isKnownCardId(filtered, 'example-standard-surface-gold'), true);
    assert.equal(galleryModel.isKnownCardId(filtered, 'example-standard-surface-glass'), false);
});
