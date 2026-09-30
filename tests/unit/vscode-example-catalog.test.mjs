// Exercises exampleCatalog.js: the real manifest-driven catalog (every
// gallery/manifest.json material, all 54), the pure buildCatalog(materials,
// fallbackDefs) builder with inline fixtures (manifest-driven vs. fallback
// scan), and the texture-path rewriting a textured/fileprefix'd example
// needs to stay self-contained once copied (collapseRefSegments/
// assignDestPaths/rewriteFilenameRefs, and buildFiles end to end).
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const catalog = require('../../vscode_extension/src/exampleCatalog.js');
const { extractFilenameRefs } = require('../../vscode_extension/src/docScanner.js');

const REPO_ROOT = catalog.REPO_ROOT;
const hasVendorMaterialx = fs.existsSync(path.join(REPO_ROOT, 'vendor', 'materialx', 'resources', 'Materials', 'Examples'));

const hasGallery = fs.existsSync(path.join(REPO_ROOT, 'gallery', 'manifest.json'));
const SKIP_REAL = hasGallery && hasVendorMaterialx ? false : 'gitignored gallery/manifest.json or vendor/materialx is absent on this checkout';

// ---- getCatalog(): the real, manifest-driven catalog -----------------

test('getCatalog: every entry has a unique id, matching the full 54-material gallery', { skip: SKIP_REAL }, () => {
    const entries = catalog.getCatalog();
    assert.equal(entries.length, 54, 'expected the full website/desktop gallery (54 materials)');
    const ids = new Set();
    for (const e of entries) {
        assert.ok(!ids.has(e.id), 'duplicate id: ' + e.id);
        ids.add(e.id);
    }
});

test('getCatalog: every file in every entry exists on disk under the repo', () => {
    for (const e of catalog.getCatalog()) {
        assert.ok(e.files.length > 0, e.id + ': no files listed');
        for (const f of e.files) {
            const abs = path.join(REPO_ROOT, ...f.from.split('/'));
            assert.ok(fs.existsSync(abs), e.id + ': missing source file ' + f.from);
        }
    }
});

test('getCatalog: hasTextures agrees with there being at least one non-doc file', () => {
    for (const e of catalog.getCatalog()) {
        const textureFiles = e.files.filter((f) => f.content === undefined);
        assert.equal(e.hasTextures, textureFiles.length > 0, e.id + ': hasTextures disagrees with its own file list');
    }
});

test('getCatalog: every entry has a label, shading model, source, license, family', () => {
    for (const e of catalog.getCatalog()) {
        assert.ok(e.label, e.id + ': missing label');
        assert.ok(e.shadingModel, e.id + ': missing shadingModel');
        assert.ok(e.source, e.id + ': missing source');
        assert.ok(e.license, e.id + ': missing license');
        assert.ok(e.family, e.id + ': missing family');
        assert.ok(e.familyLabel, e.id + ': missing familyLabel');
        assert.ok(Array.isArray(e.tags) && e.tags.length > 0, e.id + ': missing tags');
    }
});

test('getExample resolves a known id and returns null for an unknown one', () => {
    const entries = catalog.getCatalog();
    const first = entries[0];
    assert.equal(catalog.getExample(first.id).id, first.id);
    assert.equal(catalog.getExample('not-a-real-id'), null);
});

// ---- buildCatalog(materials, fallbackDefs): the pure builder ---------

const MANIFEST_FIXTURE = [
    {
        id: 'open_pbr_glass', name: 'Glass', family: 'OpenPbr', familyLabel: 'OpenPBR', origin: 'materialx',
        docPath: 'resources/Materials/Examples/OpenPbr/open_pbr_glass.mtlx', shader: 'open_pbr_surface',
        tags: ['OpenPBR', 'Procedural', 'open_pbr_surface'], license: { label: 'Apache License 2.0', origin: 'materialx' },
    },
    {
        id: 'Motley_Patchwork_Rug', name: 'Motley Patchwork Rug', family: 'Playground', familyLabel: 'Playground', origin: 'playground',
        docPath: 'materials/Motley_Patchwork_Rug/Motley_Patchwork_Rug.mtlx', shader: 'standard_surface',
        tags: ['Playground', 'Textured', 'standard_surface'], license: { label: 'MIT License', origin: 'site' },
    },
];

// Two tracked Playground sources, so the builder can read them on a clean checkout.
const PLAYGROUND_FIXTURE = [
    MANIFEST_FIXTURE[1],
    { id: 'animated_noise', name: 'Animated Noise', family: 'Playground', familyLabel: 'Playground', origin: 'playground', docPath: 'examples/animated_noise.mtlx', shader: 'standard_surface', tags: ['Playground', 'Procedural'], license: { label: 'Apache License 2.0', origin: 'site' } },
];

test('defFromManifestEntry: a materialx-origin entry maps to the vendor path, examples source and suffixed license', () => {
    const glass = catalog.defFromManifestEntry(MANIFEST_FIXTURE[0]);
    assert.equal(glass.destName, 'open_pbr_glass');
    assert.equal(glass.mtlxPath, 'vendor/materialx/resources/Materials/Examples/OpenPbr/open_pbr_glass.mtlx');
    assert.equal(glass.source, catalog.SOURCE_EXAMPLES);
    assert.equal(glass.license, 'Apache License 2.0 (MaterialX project)');
});

test('buildCatalog: manifest-driven, one entry per material, destName === manifest id', () => {
    const entries = catalog.buildCatalog(PLAYGROUND_FIXTURE);
    assert.equal(entries.length, 2);
    assert.equal(entries.find((e) => e.id === 'animated_noise').destName, 'animated_noise');
    const rug = entries.find((e) => e.id === 'Motley_Patchwork_Rug');
    assert.equal(rug.source, catalog.SOURCE_PLAYGROUND);
    assert.equal(rug.license, 'MIT License');
    assert.equal(rug.hasTextures, true);
});

test('buildCatalog: a broken manifest entry (unreadable source) is skipped, not fatal', () => {
    const broken = [{ id: 'nope', name: 'Nope', family: 'OpenPbr', familyLabel: 'OpenPBR', origin: 'materialx', docPath: 'resources/Materials/Examples/OpenPbr/does_not_exist.mtlx' }];
    const entries = catalog.buildCatalog([...broken, ...PLAYGROUND_FIXTURE]);
    assert.equal(entries.length, 2); // the broken one is dropped, the other two still build
});

test('buildCatalog: an injected fallbackDefs list is used verbatim when materials is empty', () => {
    const fixtureDefs = [{
        id: 'animated_noise', label: 'Animated Noise', shadingModel: 'standard_surface', source: catalog.SOURCE_PLAYGROUND,
        license: 'Apache License 2.0', destName: 'animated_noise', family: 'Playground', familyLabel: 'Playground',
        mtlxPath: 'examples/animated_noise.mtlx',
    }];
    const entries = catalog.buildCatalog(null, fixtureDefs);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, 'animated_noise');
});

test('buildCatalog: with no manifest and no injected fallback, scans vendor/materialx + the fixed Playground list', { skip: !hasVendorMaterialx }, () => {
    const entries = catalog.buildCatalog(null);
    const playground = entries.filter((e) => e.family === 'Playground');
    assert.equal(playground.length, 4, 'expected the 4 fixed Playground entries');
    const openPbr = entries.filter((e) => e.family === 'OpenPbr');
    assert.ok(openPbr.length >= 8, 'expected the scanned OpenPbr examples, got ' + openPbr.length);
    // scanExamplesDefs derives ids from real filenames on disk - never
    // hand-maintained, so it can only drift by the vendor snapshot changing.
    const glass = entries.find((e) => e.id === 'open_pbr_glass');
    assert.ok(glass, 'expected a scanned open_pbr_glass entry');
});

// ---- texture path rewriting -------------------------------------------

test('collapseRefSegments: a ref inside the root keeps its path; one that climbs above it escapes', () => {
    assert.deepEqual(catalog.collapseRefSegments('textures/foo.png'), { path: 'textures/foo.png', escaped: false });
    assert.deepEqual(catalog.collapseRefSegments('./foo.png'), { path: 'foo.png', escaped: false });
    assert.deepEqual(catalog.collapseRefSegments('../../../Images/foo.jpg'), { path: 'Images/foo.jpg', escaped: true });
});

test('assignDestPaths: escaping refs relocate under the given folder, collision-safe', () => {
    const map = catalog.assignDestPaths(['../../../Images/a.jpg', '../../../Images/b.jpg', 'textures/c.png'], 'textures');
    assert.equal(map['../../../Images/a.jpg'].destPath, 'textures/a.jpg');
    assert.equal(map['../../../Images/a.jpg'].relocated, true);
    assert.equal(map['textures/c.png'].destPath, 'textures/c.png');
    assert.equal(map['textures/c.png'].relocated, false);

    // Collision: an already-relative "textures/a.jpg" plus an escaping ref
    // that would ALSO land on "textures/a.jpg" gets a numbered suffix.
    const collide = catalog.assignDestPaths(['textures/a.jpg', '../../a.jpg'], 'textures');
    assert.equal(collide['textures/a.jpg'].destPath, 'textures/a.jpg');
    assert.equal(collide['../../a.jpg'].destPath, 'textures/a_2.jpg');
});

test('rewriteFilenameRefs: a non-escaping prefix compensates via value only, unrelated refs stay byte-identical', () => {
    const xml = '<materialx version="1.39"><nodegraph name="NG" fileprefix="sub/">'
        + '<input name="file" type="filename" value="a.jpg" /><input name="file2" type="filename" value="untouched.jpg" />'
        + '</nodegraph></materialx>';
    const refToDestPath = { 'sub/a.jpg': { destPath: 'textures/a.jpg', relocated: true } };
    const out = catalog.rewriteFilenameRefs(xml, refToDestPath);
    assert.ok(out.includes('value="../textures/a.jpg"'), 'relocated ref not rewritten correctly: ' + out);
    assert.ok(out.includes('value="untouched.jpg"'), 'unrelated ref must stay byte-identical: ' + out);
    assert.ok(out.includes('fileprefix="sub/"'), 'non-escaping prefix must be left in place: ' + out);
});

test('rewriteFilenameRefs: an escaping root prefix is blanked and every ref fully re-resolved', () => {
    const xml = '<materialx version="1.39" fileprefix="../../../Images/">'
        + '<standard_surface name="s"><input name="base_color" type="filename" value="a.jpg" /></standard_surface>'
        + '<nodegraph name="NG"><input name="file" type="filename" value="b.jpg" /></nodegraph>'
        + '</materialx>';
    const refToDestPath = {
        '../../../Images/a.jpg': { destPath: 'textures/a.jpg', relocated: true },
        '../../../Images/b.jpg': { destPath: 'textures/b.jpg', relocated: true },
    };
    const out = catalog.rewriteFilenameRefs(xml, refToDestPath);
    assert.ok(!/fileprefix\s*=/.test((/<materialx\b[^>]*>/.exec(out) || [''])[0]), 'root fileprefix must be blanked: ' + out);
    assert.ok(out.includes('value="textures/a.jpg"'), 'root-scope ref not rewritten correctly: ' + out);
    assert.ok(out.includes('value="textures/b.jpg"'), 'nodegraph-scope ref not rewritten correctly: ' + out);
});

test('buildFiles: standard_surface_brass_tiled (escaping fileprefix) relocates both textures and rewrites the copy', { skip: !hasVendorMaterialx }, () => {
    const { files, hasTextures } = catalog.buildFiles('vendor/materialx/resources/Materials/Examples/StandardSurface/standard_surface_brass_tiled.mtlx');
    assert.equal(hasTextures, true);
    const root = files[0];
    assert.equal(root.rel, 'standard_surface_brass_tiled.mtlx');
    assert.ok(!root.content.includes('../../../Images/'), 'root copy still escapes: ' + root.content);
    assert.ok(!/<materialx\b[^>]*fileprefix/.test(root.content), 'escaping root fileprefix must be blanked: ' + root.content);
    assert.ok(root.content.includes('value="textures/brass_color.jpg"'));
    const textureRels = files.slice(1).map((f) => f.rel).sort();
    assert.deepEqual(textureRels, ['textures/brass_color.jpg', 'textures/brass_roughness.jpg']);
    for (const f of files.slice(1)) {
        assert.ok(fs.existsSync(path.join(REPO_ROOT, ...f.from.split('/'))), f.rel + ': source missing at ' + f.from);
    }
});

test('buildFiles: standard_surface_look_brass_tiled (xi:include) pulls in the included doc and its textures', { skip: !hasVendorMaterialx }, () => {
    const { files, hasTextures } = catalog.buildFiles('vendor/materialx/resources/Materials/Examples/StandardSurface/standard_surface_look_brass_tiled.mtlx');
    assert.equal(hasTextures, true);
    const rels = files.map((f) => f.rel);
    assert.ok(rels.includes('standard_surface_look_brass_tiled.mtlx'));
    assert.ok(rels.includes('standard_surface_brass_tiled.mtlx'));
    assert.ok(rels.includes('standard_surface_greysphere_calibration.mtlx'));
    assert.ok(rels.some((r) => r.startsWith('textures/')), 'expected at least one relocated texture');
});

test('every texture referenced by a real example is present in its own copy list (fileprefix + xi:include aware)', { skip: !hasVendorMaterialx }, () => {
    for (const e of catalog.getCatalog()) {
        const docs = [e.mtlxPath, ...e.files.filter((f) => f.content !== undefined).map((f) => f.from)];
        const rels = new Set(e.files.map((f) => f.rel));
        for (const docPath of docs) {
            const text = fs.readFileSync(path.join(REPO_ROOT, ...docPath.split('/')), 'utf8');
            for (const raw of extractFilenameRefs(text)) {
                const ref = raw.replace(/\\/g, '/').replace(/\/\.\//g, '/').replace(/^\.\//, '');
                const entry = catalog.assignDestPaths([ref], 'textures')[ref];
                const expectedRel = entry.relocated ? entry.destPath : ref;
                assert.ok(rels.has(expectedRel) || rels.has(ref),
                    e.id + ': texture ref "' + ref + '" not in copy list ' + JSON.stringify([...rels]));
            }
        }
    }
});
