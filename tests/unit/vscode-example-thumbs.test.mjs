// Unit tests for newFromExample.js's galleryIdFor(): matches a catalog
// entry to its gallery manifest entry by full resolved source-document
// path, not by id === basename (that missed AnimatedChristmasTreeOrnament,
// whose manifest id differs from its .mtlx file's own basename). Uses an
// inline manifest fixture since gallery/ is gitignored and absent on a
// clean checkout; one extra test skips itself when the real file is missing.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Minimal 'vscode' stand-in: newFromExample.js only touches vscode inside
// functions this test never calls, so nothing here needs real behavior.
const vscodeStub = { QuickPickItemKind: { Separator: 1 }, Uri: {}, window: {}, commands: {}, workspace: {} };
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.call(this, request, ...rest);
};
const newFromExample = require('../../vscode_extension/src/newFromExample.js');
const exampleCatalog = require('../../vscode_extension/src/exampleCatalog.js');
Module._load = originalLoad;

// Shapes copied from a real gallery/manifest.json, trimmed to the fields
// galleryIdFor() reads: id, origin, docPath.
const FIXTURE_MATERIALS = [
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
        id: 'standard_surface_carpaint_to_openpbr',
        origin: 'playground',
        docPath: 'materials/standard_surface_carpaint_to_openpbr.mtlx',
    },
    {
        id: 'open_pbr_default',
        origin: 'materialx',
        docPath: 'resources/Materials/Examples/OpenPbr/open_pbr_default.mtlx',
    },
    {
        id: 'open_pbr_glass',
        origin: 'materialx',
        docPath: 'resources/Materials/Examples/OpenPbr/open_pbr_glass.mtlx',
    },
];

test('galleryIdFor: matches by full resolved path, not id === basename', () => {
    const example = exampleCatalog.getExample('playground-christmas-tree-ornament');
    assert.equal(newFromExample.galleryIdFor(FIXTURE_MATERIALS, example), 'AnimatedChristmasTreeOrnament');
});

test('galleryIdFor: matches playground and vendor entries whose id equals the basename', () => {
    const rug = exampleCatalog.getExample('playground-motley-patchwork-rug');
    assert.equal(newFromExample.galleryIdFor(FIXTURE_MATERIALS, rug), 'Motley_Patchwork_Rug');

    const carpaint = exampleCatalog.getExample('playground-standard-surface-carpaint-to-openpbr');
    assert.equal(newFromExample.galleryIdFor(FIXTURE_MATERIALS, carpaint), 'standard_surface_carpaint_to_openpbr');

    const glass = exampleCatalog.getExample('example-open-pbr-glass');
    assert.equal(newFromExample.galleryIdFor(FIXTURE_MATERIALS, glass), 'open_pbr_glass');
});

test('galleryIdFor: OpenPBR Default resolves to its vendor gallery entry', () => {
    const example = exampleCatalog.getExample('example-open-pbr-default');
    assert.equal(newFromExample.galleryIdFor(FIXTURE_MATERIALS, example), 'open_pbr_default');
});

test('galleryIdFor: against the real gallery/manifest.json, every catalog entry maps as expected', (t) => {
    const manifestPath = path.join(ROOT, 'gallery', 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        t.skip('gallery/manifest.json is gitignored and not present on this checkout');
        return;
    }
    const materials = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).materials || [];
    const mapping = {};
    for (const example of exampleCatalog.getCatalog()) {
        mapping[example.id] = newFromExample.galleryIdFor(materials, example);
    }
    assert.equal(mapping['playground-christmas-tree-ornament'], 'AnimatedChristmasTreeOrnament');
    assert.equal(mapping['example-open-pbr-default'], 'open_pbr_default');
    const withIcon = Object.values(mapping).filter((id) => id !== null).length;
    assert.equal(withIcon, 14);
    assert.equal(Object.keys(mapping).length, 14);
});
