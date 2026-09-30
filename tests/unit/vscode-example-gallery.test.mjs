// Unit tests for exampleGalleryModel.js: the flat card list (buildGalleryData,
// one card per catalog entry, thumb-id mapping via an inline gallery/
// manifest.json fixture, gallery/ is gitignored), the family-chip list, the
// search/family/tag filter (ported from js/gallery-app.jsx's `filtered`
// memo - family exact-match, tags AND, query across name/family/shading
// model/license/tags), and the message-validation helper isKnownCardId
// rejecting anything not in the current card list. Same 'vscode' stub trick
// as vscode-example-thumbs.test.mjs, since newFromExample.js (required
// transitively) touches vscode at module scope.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
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


// gallery/manifest.json is gitignored: tests on the real 54-material data skip without it.
const HAS_GALLERY = fs.existsSync(path.join(exampleCatalog.REPO_ROOT, 'gallery', 'manifest.json'));
const SKIP_REAL = HAS_GALLERY ? false : 'gallery/manifest.json is gitignored and absent on this checkout';

// Inline catalog fixture (no filesystem reads), same entry shape as getCatalog().
const MX = 'Apache License 2.0 (MaterialX project)';
function fx(id, label, family, familyLabel, shadingModel, license, tags, mtlxPath) {
    return { id, label, family, familyLabel, shadingModel, license, tags, mtlxPath };
}
const FIXTURE_CATALOG = [
    fx('AnimatedChristmasTreeOrnament', 'Animated Christmas Tree Ornament', 'Playground', 'Playground', 'standard_surface', 'CC0 1.0 Universal', ['Playground', 'Textured'], 'materials/AnimatedChristmasTreeOrnament/ChristmasTreeOrnament016_1K-JPG.mtlx'),
    fx('Motley_Patchwork_Rug', 'Motley Patchwork Rug', 'Playground', 'Playground', 'standard_surface', 'MIT License', ['Playground', 'Textured'], 'materials/Motley_Patchwork_Rug/Motley_Patchwork_Rug.mtlx'),
    fx('open_pbr_glass', 'Glass', 'OpenPbr', 'OpenPBR', 'open_pbr_surface', MX, ['OpenPBR', 'Procedural'], 'vendor/materialx/resources/Materials/Examples/OpenPbr/open_pbr_glass.mtlx'),
    fx('open_pbr_default', 'Default', 'OpenPbr', 'OpenPBR', 'open_pbr_surface', MX, ['OpenPBR', 'Procedural'], 'vendor/materialx/resources/Materials/Examples/OpenPbr/open_pbr_default.mtlx'),
    fx('standard_surface_gold', 'Gold', 'StandardSurface', 'Standard Surface', 'standard_surface', MX, ['Standard Surface', 'Procedural'], 'vendor/materialx/resources/Materials/Examples/StandardSurface/standard_surface_gold.mtlx'),
    fx('standard_surface_chess_set', 'Chess Set', 'StandardSurface', 'Standard Surface', 'standard_surface', MX, ['Standard Surface', 'Textured'], 'vendor/materialx/resources/Materials/Examples/StandardSurface/standard_surface_chess_set.mtlx'),
    fx('usd_preview_wood', 'Wood', 'UsdPreviewSurface', 'USD Preview Surface', 'UsdPreviewSurface', MX, ['USD Preview Surface', 'Textured'], 'vendor/materialx/resources/Materials/Examples/UsdPreviewSurface/usd_preview_wood.mtlx'),
];

test('buildGalleryData: one card per catalog entry, in catalog order, catalog', () => {
    const cards = galleryModel.buildGalleryData(FIXTURE_CATALOG, MATERIALS);
    assert.equal(cards.length, FIXTURE_CATALOG.length);
    assert.deepEqual(cards.map((c) => c.id), FIXTURE_CATALOG.map((e) => e.id));
});

test('buildGalleryData: real catalog yields one card per entry, full 54-material catalog', { skip: SKIP_REAL }, () => {
    const cards = galleryModel.buildGalleryData(exampleCatalog.getCatalog(), MATERIALS);
    assert.equal(cards.length, 54);
    assert.deepEqual(cards.map((c) => c.id), exampleCatalog.getCatalog().map((e) => e.id));
});

test('buildGalleryData: thumbId set only for entries the fixture manifest matches', () => {
    const cards = galleryModel.buildGalleryData(FIXTURE_CATALOG, MATERIALS);
    const ornament = cards.find((c) => c.id === 'AnimatedChristmasTreeOrnament');
    const rug = cards.find((c) => c.id === 'Motley_Patchwork_Rug');
    const glass = cards.find((c) => c.id === 'open_pbr_glass');
    const untouched = cards.find((c) => c.id === 'open_pbr_default');
    assert.equal(ornament.thumbId, 'AnimatedChristmasTreeOrnament');
    assert.equal(rug.thumbId, 'Motley_Patchwork_Rug');
    assert.equal(glass.thumbId, 'open_pbr_glass');
    assert.equal(untouched.thumbId, null);
});

test('buildGalleryData: every card carries family/familyLabel/tags for the filter chips', () => {
    const cards = galleryModel.buildGalleryData(FIXTURE_CATALOG, MATERIALS);
    for (const c of cards) {
        assert.ok(c.family, c.id + ': missing family');
        assert.ok(c.familyLabel, c.id + ': missing familyLabel');
        assert.ok(Array.isArray(c.tags) && c.tags.length > 0, c.id + ': missing tags');
    }
});

// ---- familyChips: "All" plus present families, fixed order ------------

test('familyChips: "All" first, only families actually present, in GALLERY_FAMILY_ORDER order', () => {
    const cards = [
        { family: 'Playground' }, { family: 'StandardSurface' }, { family: 'OpenPbr' },
    ];
    const chips = galleryModel.familyChips(cards);
    assert.deepEqual(chips.map((c) => c.id), ['all', 'StandardSurface', 'OpenPbr', 'Playground']);
});

test('familyChips: against the real catalog, every gallery family is present', { skip: SKIP_REAL }, () => {
    const chips = galleryModel.familyChips(exampleCatalog.getCatalog());
    const ids = chips.map((c) => c.id);
    assert.deepEqual(ids, ['all', 'StandardSurface', 'OpenPbr', 'GltfPbr', 'UsdPreviewSurface', 'DisneyPrincipled', 'SimpleHair', 'Playground']);
});

// ---- filterCards: family exact, tags AND, query across several fields -

test('filterCards: family filter is an exact match, "all" (or omitted) keeps everything', () => {
    const cards = galleryModel.buildGalleryData(FIXTURE_CATALOG, MATERIALS);
    const openPbr = galleryModel.filterCards(cards, { family: 'OpenPbr' });
    assert.ok(openPbr.length > 0 && openPbr.every((c) => c.family === 'OpenPbr'));
    assert.equal(galleryModel.filterCards(cards, { family: 'all' }).length, cards.length);
    assert.equal(galleryModel.filterCards(cards, {}).length, cards.length);
});

test('filterCards: tags are AND semantics (every requested tag must be present)', () => {
    const cards = galleryModel.buildGalleryData(FIXTURE_CATALOG, MATERIALS);
    const textured = galleryModel.filterCards(cards, { tags: ['Textured'] });
    assert.ok(textured.length > 0 && textured.every((c) => c.tags.includes('Textured')));
    const impossible = galleryModel.filterCards(cards, { tags: ['Textured', 'Procedural'] });
    assert.equal(impossible.length, 0, 'a material is never both Textured and Procedural');
});

test('filterCards: query matches name, family label, shading model, license or a tag, case-insensitively', () => {
    const cards = galleryModel.buildGalleryData(FIXTURE_CATALOG, MATERIALS);

    const byName = galleryModel.filterCards(cards, { query: 'gold' });
    assert.ok(byName.length >= 1 && byName.every((c) => c.label.toLowerCase().includes('gold')));

    const byShadingModel = galleryModel.filterCards(cards, { query: 'OPEN_PBR_SURFACE' });
    assert.ok(byShadingModel.length > 1 && byShadingModel.every((c) => c.shadingModel === 'open_pbr_surface'));

    const byFamilyLabel = galleryModel.filterCards(cards, { query: 'usd preview surface' });
    assert.ok(byFamilyLabel.length > 0 && byFamilyLabel.every((c) => c.familyLabel === 'USD Preview Surface'));

    const byLicense = galleryModel.filterCards(cards, { query: 'apache license 2.0' });
    assert.ok(byLicense.length > 0);

    assert.equal(galleryModel.filterCards(cards, { query: 'nonexistent-search-term-xyz' }).length, 0);
    assert.equal(galleryModel.filterCards(cards, { query: '  ' }).length, cards.length); // whitespace-only == no filter
});

test('filterCards: filters combine (family AND tag AND query)', () => {
    const cards = galleryModel.buildGalleryData(FIXTURE_CATALOG, MATERIALS);
    const combined = galleryModel.filterCards(cards, { family: 'StandardSurface', tags: ['Textured'], query: 'chess' });
    assert.equal(combined.length, 1);
    assert.equal(combined[0].id, 'standard_surface_chess_set');
});

// ---- isKnownCardId -------------------------------------------------

test('isKnownCardId: only ids present in the exact card list are accepted', () => {
    const cards = galleryModel.buildGalleryData(FIXTURE_CATALOG, MATERIALS);
    assert.equal(galleryModel.isKnownCardId(cards, cards[0].id), true);
    assert.equal(galleryModel.isKnownCardId(cards, 'not-a-real-id'), false);
});
