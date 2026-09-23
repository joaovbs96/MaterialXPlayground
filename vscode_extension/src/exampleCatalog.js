// exampleCatalog.js: pure catalog for "New Material from Example".
// Each entry's texture list is derived by reusing docScanner.js's
// extractFilenameRefs on the source .mtlx. No require('vscode').
'use strict';

const fs = require('fs');
const path = require('path');
const { extractFilenameRefs } = require('./docScanner');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SOURCE_PLAYGROUND = 'MaterialX Playground';
const SOURCE_EXAMPLES = 'MaterialX Examples';

// repoRelPath uses '/' always (matches how the rest of the repo writes
// these paths); joins them with POSIX semantics regardless of platform.
function posixJoin(dir, ref) {
    if (!dir) return ref;
    return (dir + '/' + ref).replace(/\/\.\//g, '/');
}

function posixDirname(repoRelPath) {
    const idx = repoRelPath.lastIndexOf('/');
    return idx === -1 ? '' : repoRelPath.slice(0, idx);
}

function posixBasename(repoRelPath) {
    const idx = repoRelPath.lastIndexOf('/');
    return idx === -1 ? repoRelPath : repoRelPath.slice(idx + 1);
}

// Collapses "/./" segments and a leading "./". A fileprefix of "./"
// (see ChristmasTreeOrnament016_1K-JPG.mtlx) would otherwise leave a
// texture ref looking like "./name.jpg" instead of plain "name.jpg".
function normalizeRelPath(p) {
    return p.replace(/\/\.\//g, '/').replace(/^\.\//, '');
}

// Builds the { from, rel } file list for one entry. `from` is repo-
// relative (read the source); `rel` is relative to the .mtlx's own
// directory (write the destination, so relative refs keep resolving).
function buildFiles(mtlxRepoRelPath) {
    const abs = path.join(REPO_ROOT, ...mtlxRepoRelPath.split('/'));
    const text = fs.readFileSync(abs, 'utf8');
    const dir = posixDirname(mtlxRepoRelPath);
    const mtlxRel = posixBasename(mtlxRepoRelPath);

    const files = [{ from: mtlxRepoRelPath, rel: mtlxRel }];
    const seen = new Set([mtlxRel]);
    for (const raw of extractFilenameRefs(text)) {
        const ref = normalizeRelPath(raw.replace(/\\/g, '/'));
        if (seen.has(ref)) continue;
        seen.add(ref);
        files.push({ from: posixJoin(dir, ref), rel: ref });
    }
    return files;
}

function entry(def) {
    const files = buildFiles(def.mtlxPath);
    return {
        id: def.id,
        label: def.label,
        shadingModel: def.shadingModel,
        source: def.source,
        license: def.license,
        destName: def.destName,
        mtlxPath: def.mtlxPath,
        files,
        hasTextures: files.length > 1,
    };
}

// --- MaterialX Playground examples (materials/) ---
const PLAYGROUND_DEFS = [
    {
        id: 'playground-open-pbr-default',
        label: 'OpenPBR Default',
        shadingModel: 'open_pbr_surface',
        source: SOURCE_PLAYGROUND,
        license: 'MaterialX Playground (repository license)',
        destName: 'open_pbr_default',
        mtlxPath: 'materials/open_pbr_default.mtlx',
    },
    {
        id: 'playground-standard-surface-carpaint-to-openpbr',
        label: 'Standard Surface Car Paint (converted to OpenPBR)',
        shadingModel: 'open_pbr_surface',
        source: SOURCE_PLAYGROUND,
        license: 'MaterialX Playground (repository license)',
        destName: 'standard_surface_carpaint_to_openpbr',
        mtlxPath: 'materials/standard_surface_carpaint_to_openpbr.mtlx',
    },
    {
        id: 'playground-motley-patchwork-rug',
        label: 'Motley Patchwork Rug',
        shadingModel: 'standard_surface',
        source: SOURCE_PLAYGROUND,
        license: 'MIT (AMD GPUOpen material library)',
        destName: 'Motley_Patchwork_Rug',
        mtlxPath: 'materials/Motley_Patchwork_Rug/Motley_Patchwork_Rug.mtlx',
    },
    {
        id: 'playground-christmas-tree-ornament',
        label: 'Animated Christmas Tree Ornament',
        shadingModel: 'open_pbr_surface',
        source: SOURCE_PLAYGROUND,
        license: 'CC0 1.0 (ambientCG)',
        destName: 'AnimatedChristmasTreeOrnament',
        mtlxPath: 'materials/AnimatedChristmasTreeOrnament/ChristmasTreeOrnament016_1K-JPG.mtlx',
    },
];

// --- Curated upstream examples (vendor/materialx/resources/Materials/
// Examples/): no texture files, no xi:include. Keep equal to
// scripts/check-vsix-files.mjs's MATERIALX_KEEP_LIST and .vscodeignore.
const EXAMPLES_LICENSE = 'Apache-2.0 (MaterialX project)';
const EXAMPLES_DEFS = [
    {
        id: 'example-standard-surface-default',
        label: 'Standard Surface Default',
        shadingModel: 'standard_surface',
        destName: 'standard_surface_default',
        mtlxPath: 'vendor/materialx/resources/Materials/Examples/StandardSurface/standard_surface_default.mtlx',
    },
    {
        id: 'example-standard-surface-gold',
        label: 'Standard Surface Gold',
        shadingModel: 'standard_surface',
        destName: 'standard_surface_gold',
        mtlxPath: 'vendor/materialx/resources/Materials/Examples/StandardSurface/standard_surface_gold.mtlx',
    },
    {
        id: 'example-standard-surface-glass',
        label: 'Standard Surface Glass',
        shadingModel: 'standard_surface',
        destName: 'standard_surface_glass',
        mtlxPath: 'vendor/materialx/resources/Materials/Examples/StandardSurface/standard_surface_glass.mtlx',
    },
    {
        id: 'example-standard-surface-plastic',
        label: 'Standard Surface Plastic',
        shadingModel: 'standard_surface',
        destName: 'standard_surface_plastic',
        mtlxPath: 'vendor/materialx/resources/Materials/Examples/StandardSurface/standard_surface_plastic.mtlx',
    },
    {
        id: 'example-standard-surface-marble',
        label: 'Standard Surface Marble',
        shadingModel: 'standard_surface',
        destName: 'standard_surface_marble_solid',
        mtlxPath: 'vendor/materialx/resources/Materials/Examples/StandardSurface/standard_surface_marble_solid.mtlx',
    },
    {
        id: 'example-open-pbr-aluminum-brushed',
        label: 'OpenPBR Aluminum (Brushed)',
        shadingModel: 'open_pbr_surface',
        destName: 'open_pbr_aluminum_brushed',
        mtlxPath: 'vendor/materialx/resources/Materials/Examples/OpenPbr/open_pbr_aluminum_brushed.mtlx',
    },
    {
        id: 'example-open-pbr-glass',
        label: 'OpenPBR Glass',
        shadingModel: 'open_pbr_surface',
        destName: 'open_pbr_glass',
        mtlxPath: 'vendor/materialx/resources/Materials/Examples/OpenPbr/open_pbr_glass.mtlx',
    },
    {
        id: 'example-open-pbr-carpaint',
        label: 'OpenPBR Car Paint',
        shadingModel: 'open_pbr_surface',
        destName: 'open_pbr_carpaint',
        mtlxPath: 'vendor/materialx/resources/Materials/Examples/OpenPbr/open_pbr_carpaint.mtlx',
    },
    {
        id: 'example-open-pbr-velvet',
        label: 'OpenPBR Velvet',
        shadingModel: 'open_pbr_surface',
        destName: 'open_pbr_velvet',
        mtlxPath: 'vendor/materialx/resources/Materials/Examples/OpenPbr/open_pbr_velvet.mtlx',
    },
    {
        id: 'example-open-pbr-pearl',
        label: 'OpenPBR Pearl',
        shadingModel: 'open_pbr_surface',
        destName: 'open_pbr_pearl',
        mtlxPath: 'vendor/materialx/resources/Materials/Examples/OpenPbr/open_pbr_pearl.mtlx',
    },
].map((def) => Object.assign({ source: SOURCE_EXAMPLES, license: EXAMPLES_LICENSE }, def));

const CATALOG = [...PLAYGROUND_DEFS, ...EXAMPLES_DEFS].map(entry);

function getCatalog() {
    return CATALOG;
}

function getExample(id) {
    return CATALOG.find((e) => e.id === id) || null;
}

module.exports = {
    REPO_ROOT,
    SOURCE_PLAYGROUND,
    SOURCE_EXAMPLES,
    getCatalog,
    getExample,
};
