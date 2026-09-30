// exampleCatalog.js: pure catalog for "New Material from Example". Built
// from the packaged gallery/manifest.json (all 54 website/desktop gallery
// materials) when present, falling back to a scan of vendor/materialx's
// Examples tree plus the fixed Playground list on a plain checkout with no
// manifest. Each entry's texture list is derived from its own .mtlx text
// (and any xi:include siblings), reusing docScanner.js's extractFilenameRefs.
// No require('vscode').
'use strict';

const fs = require('fs');
const path = require('path');
const { extractFilenameRefs } = require('./docScanner');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const SOURCE_PLAYGROUND = 'MaterialX Playground';
const SOURCE_EXAMPLES = 'MaterialX Examples';
const MATERIALX_LICENSE_SUFFIX = ' (MaterialX project)';

// repoRelPath uses '/' always (matches how the rest of the repo writes
// these paths); joins them with POSIX semantics regardless of platform,
// collapsing '..'/'.' (a fileprefix like "../../../Images/" must resolve
// to a real repo path, not keep the ".." segments literal).
function posixJoin(dir, ref) {
    return path.posix.join(dir || '', ref);
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

// ---------------------------------------------------------------------
// Texture path rewriting for a copied example. Ported (not imported: those
// files are browser JS/JSX with no Node module.exports) from
// js/graph/zip-export-paths.js (collapseRefSegments/assignZipTexturePaths)
// and js/graph/texture-convert.jsx's rewriteFilenameRefs, which the
// website's own zip export uses to relocate refs that climb above the
// export root. Same idea here: a shared "../../../Images/" fileprefix
// (standard_surface_brass_tiled.mtlx and friends) must not leak a texture
// outside the new material's own folder.
// ---------------------------------------------------------------------

// Splits a ref on '/', collapsing '.'/'..' segments. escaped is true when a
// leading '..' has nowhere left to pop, i.e. the ref climbs above wherever
// it is rooted.
function collapseRefSegments(ref) {
    const segments = String(ref || '').replace(/\\/g, '/').split('/');
    const out = [];
    let escaped = false;
    for (const seg of segments) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
            if (out.length > 0) out.pop();
            else escaped = true;
        } else {
            out.push(seg);
        }
    }
    return { path: out.join('/'), escaped };
}

// Assigns each resolved ref a destination path relative to the new .mtlx's
// own folder: refs that already sit inside it keep their collapsed path,
// refs that climb above it (or collide) relocate under `relocateFolder`
// with collision-safe names. Returns { [resolvedRef]: { destPath, relocated } }.
function assignDestPaths(refs, relocateFolder) {
    const byRef = {};
    const used = new Set();
    const uniquePath = (candidate) => {
        if (!used.has(candidate)) return candidate;
        const dot = candidate.lastIndexOf('.');
        const base = dot > 0 ? candidate.slice(0, dot) : candidate;
        const ext = dot > 0 ? candidate.slice(dot) : '';
        let n = 2;
        let next = base + '_' + n + ext;
        while (used.has(next)) { n += 1; next = base + '_' + n + ext; }
        return next;
    };
    for (const ref of refs || []) {
        const key = String(ref || '').replace(/\\/g, '/');
        if (!key || Object.prototype.hasOwnProperty.call(byRef, key)) continue;
        const { path: collapsed, escaped } = collapseRefSegments(key);
        let relocated = escaped || !collapsed;
        let destPath = relocated ? relocateFolder + '/' + (collapsed.split('/').pop() || 'texture') : collapsed;
        destPath = uniquePath(destPath);
        used.add(destPath);
        if (!relocated && destPath !== collapsed) relocated = true; // moved by a collision suffix
        byRef[key] = { destPath, relocated };
    }
    return byRef;
}

// Rewrites <input type="filename" value="..."> tags so every relocated ref
// resolves from the new .mtlx's own folder, mirroring texture-convert.jsx's
// rewriteFilenameRefs (materialx-root + per-nodegraph fileprefix scoping)
// for the common case: a prefix that only ever descends into subfolders.
//
// A materialx-ROOT fileprefix that itself climbs above the document's own
// directory ("../../../Images/", standard_surface_brass_tiled.mtlx and
// friends) can't be compensated the same way: once `value` has walked back
// out past the doc's own folder, there is no portable way to walk back down
// INTO it again (that would mean literally spelling out the new folder's
// own name, which changes with the numbered-suffix collision rule). So
// when the root prefix escapes, this blanks the materialx element's own
// fileprefix attribute instead and fully resolves every ref in the
// document (root-scope and per-nodegraph alike) to a prefix-independent
// value - relocated refs get their destPath, everything else gets its old
// value re-resolved against whatever prefix survives (a nodegraph's own
// fileprefix, if it has one, is untouched and still applies).
function rewriteFilenameRefs(xml, refToDestPath) {
    const rootAttrs = (/<materialx\b([^>]*)>/.exec(xml) || [])[1] || '';
    const rootPrefix = ((/\bfileprefix\s*=\s*"([^"]*)"/.exec(rootAttrs) || [])[1] || '').replace(/\\/g, '/');
    const rootEscapes = collapseRefSegments(rootPrefix).escaped;

    // fullPrefix resolves the ORIGINAL ref (dictionary lookup key);
    // ownPrefix is what the ref resolves against once rootEscapes forces a
    // blank root fileprefix (its own nodegraph prefix, if any, or '').
    const rewriteScope = (text, fullPrefix, ownPrefix) => text.replace(/<input\b[^>]*>/g, (tag) => {
        if (!/\btype\s*=\s*"filename"/.test(tag)) return tag;
        const m = /\bvalue(\s*=\s*)"([^"]*)"/.exec(tag);
        const raw = m && m[2];
        if (!raw) return tag;
        const resolved = (fullPrefix + raw).replace(/\\/g, '/');
        const entry = refToDestPath && refToDestPath[resolved];

        let newValue;
        if (entry && entry.relocated) {
            if (rootEscapes) {
                // fileprefix is blanked below, so the doc resolves refs
                // directly relative to its own folder: no climb needed.
                newValue = entry.destPath;
            } else {
                // fileprefix survives unchanged: climb out of it first, the
                // same number of levels it descends (collapsed, so a
                // prefix that itself contained '..' can't over-climb).
                const collapsedPrefix = collapseRefSegments(fullPrefix).path;
                const depth = collapsedPrefix ? collapsedPrefix.split('/').length : 0;
                newValue = '../'.repeat(depth) + entry.destPath;
            }
        } else if (rootEscapes) {
            newValue = collapseRefSegments(ownPrefix + raw).path;
        } else {
            return tag; // nothing relocated, prefix untouched: byte-identical
        }
        if (newValue === raw) return tag;
        return tag.slice(0, m.index) + 'value' + m[1] + '"' + newValue + '"' + tag.slice(m.index + m[0].length);
    });

    let out = '';
    let cursor = 0;
    const NG = /<nodegraph\b([^>]*)>([\s\S]*?)<\/nodegraph>/g;
    let ngm;
    while ((ngm = NG.exec(xml)) !== null) {
        out += rewriteScope(xml.slice(cursor, ngm.index), rootPrefix, '');
        const ngPrefix = ((/\bfileprefix\s*=\s*"([^"]*)"/.exec(ngm[1]) || [])[1] || '').replace(/\\/g, '/');
        out += '<nodegraph' + ngm[1] + '>' + rewriteScope(ngm[2], rootPrefix + ngPrefix, ngPrefix) + '</nodegraph>';
        cursor = ngm.index + ngm[0].length;
    }
    out += rewriteScope(xml.slice(cursor), rootPrefix, '');

    if (rootEscapes) {
        out = out.replace(/(<materialx\b[^>]*?)\s*fileprefix\s*=\s*"[^"]*"/, '$1');
    }
    return out;
}

// ---------------------------------------------------------------------
// xi:include-aware document collection (standard_surface_look_brass_tiled
// and _look_wood_tiled each xi:include a sibling .mtlx that carries the
// escaping fileprefix). Pure fs, BFS, same shape as docScanner.js's own
// (vscode-dependent) walk.
// ---------------------------------------------------------------------

const XI_INCLUDE_RE = /<xi:include\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*?\/?>(?:\s*<\/xi:include>)?/g;
const MAX_DOCS = 12; // guard only; this catalog's includes nest at most one deep

function extractIncludeHrefs(xml) {
    const hrefs = [];
    XI_INCLUDE_RE.lastIndex = 0;
    let m;
    while ((m = XI_INCLUDE_RE.exec(xml)) !== null) {
        const href = m[1] || m[2];
        if (href) hrefs.push(href);
    }
    return hrefs;
}

// [{ repoRelPath, dir, basename, text }], root document first.
function collectDocs(mtlxRepoRelPath) {
    const abs = path.join(REPO_ROOT, ...mtlxRepoRelPath.split('/'));
    const rootText = fs.readFileSync(abs, 'utf8');
    const root = { repoRelPath: mtlxRepoRelPath, dir: posixDirname(mtlxRepoRelPath), basename: posixBasename(mtlxRepoRelPath), text: rootText };
    const docs = [root];
    const visited = new Set([mtlxRepoRelPath]);
    const queue = [root];
    while (queue.length && docs.length < MAX_DOCS) {
        const item = queue.shift();
        for (const href of extractIncludeHrefs(item.text)) {
            if (docs.length >= MAX_DOCS) break;
            const incRel = normalizeRelPath(posixJoin(item.dir, href.replace(/\\/g, '/')));
            if (visited.has(incRel)) continue;
            visited.add(incRel);
            const incAbs = path.join(REPO_ROOT, ...incRel.split('/'));
            if (!fs.existsSync(incAbs)) continue;
            const doc = { repoRelPath: incRel, dir: posixDirname(incRel), basename: posixBasename(incRel), text: fs.readFileSync(incAbs, 'utf8') };
            docs.push(doc);
            queue.push(doc);
        }
    }
    return docs;
}

// Builds the { rel, from | content } file list for one entry: the root
// .mtlx plus any xi:include siblings (each rewritten so its filename refs
// resolve from the new material's own folder) and every texture they
// reference (relocated into "textures/" when its ref would otherwise climb
// outside that folder). `from` is repo-relative (read the source, byte-for-
// byte); `content` is already-rewritten text (write verbatim, UTF-8).
function buildFiles(mtlxRepoRelPath) {
    const docs = collectDocs(mtlxRepoRelPath);

    const allRefs = [];
    for (const doc of docs) {
        for (const raw of extractFilenameRefs(doc.text)) allRefs.push(normalizeRelPath(raw.replace(/\\/g, '/')));
    }
    const refToDestPath = assignDestPaths(allRefs, 'textures');

    // `from` on a content-rewritten doc is its own original source path -
    // not read again to build the copy (that uses `content`), but kept so
    // callers that need the real source set (e.g. the .vsix keep-list
    // check) can still recover every document this entry touches.
    const files = docs.map((doc) => ({ rel: doc.basename, from: doc.repoRelPath, content: rewriteFilenameRefs(doc.text, refToDestPath) }));

    const seenRefs = new Set();
    for (const doc of docs) {
        for (const raw of extractFilenameRefs(doc.text)) {
            const ref = normalizeRelPath(raw.replace(/\\/g, '/'));
            if (seenRefs.has(ref)) continue;
            seenRefs.add(ref);
            const entry = refToDestPath[ref];
            const rel = entry.relocated ? entry.destPath : ref;
            files.push({ from: posixJoin(doc.dir, ref), rel });
        }
    }
    return { files, hasTextures: files.some((f) => f.content === undefined) };
}

// First root-scope node whose type="surfaceshader" (skipping <nodegraph>/
// <nodedef> bodies and the <input>/<output> declarations that can carry
// that same type attribute) - a fallback shading-model label when a def
// doesn't already carry one. Small regex port of build-gallery.mjs's
// extractShaderCategory.
function extractShaderCategory(xml) {
    const scope = xml.replace(/<nodegraph\b[^>]*>[\s\S]*?<\/nodegraph>/g, '').replace(/<nodedef\b[^>]*>[\s\S]*?<\/nodedef>/g, '');
    const TAG_RE = /<(\w[\w.-]*)\b([^>]*)>/g;
    let m;
    while ((m = TAG_RE.exec(scope)) !== null) {
        if (m[1] === 'input' || m[1] === 'output') continue;
        if (/\btype\s*=\s*"surfaceshader"/.test(m[2])) return m[1];
    }
    return '';
}

function entry(def) {
    const { files, hasTextures } = buildFiles(def.mtlxPath);
    const shadingModel = def.shadingModel || extractShaderCategory(files[0].content) || '';
    const tags = def.tags && def.tags.length ? def.tags : [def.familyLabel, hasTextures ? 'Textured' : 'Procedural', shadingModel].filter(Boolean);
    return {
        id: def.id,
        label: def.label,
        shadingModel,
        source: def.source,
        license: def.license,
        destName: def.destName,
        mtlxPath: def.mtlxPath,
        family: def.family || '',
        familyLabel: def.familyLabel || '',
        tags,
        files,
        hasTextures,
    };
}

// ---------------------------------------------------------------------
// Manifest-driven defs: one per gallery/manifest.json material (the same
// 54 items the website/desktop Material Gallery ships).
// ---------------------------------------------------------------------

function defFromManifestEntry(m) {
    const isPlayground = m.origin !== 'materialx';
    const licenseLabel = (m.license && m.license.label) || 'Unknown license';
    return {
        id: m.id,
        label: m.name,
        shadingModel: m.shader || '',
        source: isPlayground ? SOURCE_PLAYGROUND : SOURCE_EXAMPLES,
        license: isPlayground ? licenseLabel : licenseLabel + MATERIALX_LICENSE_SUFFIX,
        destName: m.id,
        mtlxPath: isPlayground ? m.docPath : 'vendor/materialx/' + m.docPath,
        family: m.family,
        familyLabel: m.familyLabel,
        tags: m.tags || [],
    };
}

// ---------------------------------------------------------------------
// Fallback defs (no gallery/manifest.json: a plain checkout that never ran
// `npm run gallery:data`). Scans vendor/materialx's Examples tree directly
// - present only after `npm run vendor:offline` - plus the fixed
// Playground list, so the catalog never depends on hand-maintained ids.
// ---------------------------------------------------------------------

const FAMILY_LABELS = {
    StandardSurface: 'Standard Surface',
    OpenPbr: 'OpenPBR',
    GltfPbr: 'glTF PBR',
    UsdPreviewSurface: 'USD Preview Surface',
    DisneyPrincipled: 'Disney Principled',
    SimpleHair: 'Simple Hair',
};

function titleCaseFromSnake(name) {
    return name.split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const MATERIALX_LICENSE = 'Apache License 2.0' + MATERIALX_LICENSE_SUFFIX;

function scanExamplesDefs() {
    const examplesRoot = path.join(REPO_ROOT, 'vendor', 'materialx', 'resources', 'Materials', 'Examples');
    if (!fs.existsSync(examplesRoot)) return [];
    const defs = [];
    for (const family of fs.readdirSync(examplesRoot)) {
        const familyLabel = FAMILY_LABELS[family];
        if (!familyLabel) continue;
        const dir = path.join(examplesRoot, family);
        if (!fs.statSync(dir).isDirectory()) continue;
        for (const fileName of fs.readdirSync(dir)) {
            if (!fileName.toLowerCase().endsWith('.mtlx')) continue;
            const id = fileName.slice(0, -'.mtlx'.length);
            defs.push({
                id,
                label: titleCaseFromSnake(id),
                shadingModel: '',
                source: SOURCE_EXAMPLES,
                license: MATERIALX_LICENSE,
                destName: id,
                mtlxPath: 'vendor/materialx/resources/Materials/Examples/' + family + '/' + fileName,
                family,
                familyLabel,
                tags: [],
            });
        }
    }
    return defs;
}

const PLAYGROUND_DEFS = [
    {
        id: 'AnimatedChristmasTreeOrnament',
        label: 'Animated Christmas Tree Ornament',
        source: SOURCE_PLAYGROUND,
        license: 'CC0 1.0 Universal',
        destName: 'AnimatedChristmasTreeOrnament',
        mtlxPath: 'materials/AnimatedChristmasTreeOrnament/ChristmasTreeOrnament016_1K-JPG.mtlx',
        family: 'Playground',
        familyLabel: 'Playground',
    },
    {
        id: 'Motley_Patchwork_Rug',
        label: 'Motley Patchwork Rug',
        source: SOURCE_PLAYGROUND,
        license: 'MIT License',
        destName: 'Motley_Patchwork_Rug',
        mtlxPath: 'materials/Motley_Patchwork_Rug/Motley_Patchwork_Rug.mtlx',
        family: 'Playground',
        familyLabel: 'Playground',
    },
    {
        id: 'standard_surface_carpaint_to_openpbr',
        label: 'Carpaint to OpenPBR',
        source: SOURCE_PLAYGROUND,
        license: 'Apache License 2.0',
        destName: 'standard_surface_carpaint_to_openpbr',
        mtlxPath: 'materials/standard_surface_carpaint_to_openpbr.mtlx',
        family: 'Playground',
        familyLabel: 'Playground',
    },
    {
        id: 'animated_noise',
        label: 'Animated Noise',
        source: SOURCE_PLAYGROUND,
        license: 'Apache License 2.0',
        destName: 'animated_noise',
        mtlxPath: 'examples/animated_noise.mtlx',
        family: 'Playground',
        familyLabel: 'Playground',
    },
];

function loadGalleryManifestMaterials() {
    try {
        const raw = fs.readFileSync(path.join(REPO_ROOT, 'gallery', 'manifest.json'), 'utf8');
        const materials = JSON.parse(raw).materials;
        return Array.isArray(materials) && materials.length ? materials : null;
    } catch (e) {
        return null;
    }
}

// buildCatalog: pure builder, unit-testable without touching the real
// filesystem. `materials` is a gallery/manifest.json materials array (or
// null/empty to force the fallback scan); `fallbackDefs` defaults to a real
// scan of vendor/materialx plus the fixed Playground list.
function buildCatalog(materials, fallbackDefs) {
    const defs = materials && materials.length
        ? materials.map(defFromManifestEntry)
        : (fallbackDefs || [...PLAYGROUND_DEFS, ...scanExamplesDefs()]);
    const out = [];
    for (const def of defs) {
        try {
            out.push(entry(def));
        } catch (e) {
            // Missing/unreadable source file for this one entry: skip it
            // rather than failing catalog construction for every other one.
        }
    }
    return out;
}

let cachedCatalog = null;
function getCatalog() {
    if (!cachedCatalog) cachedCatalog = buildCatalog(loadGalleryManifestMaterials());
    return cachedCatalog;
}

function getExample(id) {
    return getCatalog().find((e) => e.id === id) || null;
}

module.exports = {
    REPO_ROOT,
    SOURCE_PLAYGROUND,
    SOURCE_EXAMPLES,
    getCatalog,
    getExample,
    buildCatalog,
    defFromManifestEntry,
    scanExamplesDefs,
    collapseRefSegments,
    assignDestPaths,
    rewriteFilenameRefs,
    buildFiles,
};
