// usdFileSet.js: the files a USD root layer needs in the webview's in-memory
// filesystem: its folder tree plus whatever text layers and .mtlx documents
// reference, each confined exactly like docScanner.js (refPolicy, realpath).
//
// Returned shape: { baseUri, root, files: [{ rel, uri, size, mtime }],
// totalBytes, warnings }. `rel` paths are relative to baseUri, the deepest
// folder holding every file, so `..` references resolve inside the set.
'use strict';

const path = require('path');
const docScanner = require('./docScanner');
const refPolicy = require('./refPolicy');

const MAX_FILES = 4000;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB across the whole set
const MAX_SCAN_BYTES = 64 * 1024 * 1024; // larger layers are sent but not read for references
const MAX_SCAN_TOTAL_BYTES = 512 * 1024 * 1024; // text read for references, per collection
const MAX_DIR_ENTRIES = 50000; // folder walk budget
const SKIP_WARNING_LIMIT = 5;
const SKIPPED_DIR_NAMES = new Set(['node_modules']); // plus every dot-folder

const ASSET_PATH_RE = /@([^@\n]+)@/g;
const XI_INCLUDE_HREF_RE = /<xi:include\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function extOf(p) {
    return refPolicy.extOf(p);
}

function escapeRe(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// An authored asset path as a plain relative ref: drops file format args and
// package-internal paths (`a.usdz[b.png]`), normalizes separators.
function cleanAssetPath(raw) {
    let ref = String(raw).replace(/:SDF_FORMAT_ARGS:.*$/, '').trim();
    const bracket = ref.indexOf('[');
    if (bracket > 0) ref = ref.slice(0, bracket);
    if (!ref || ref.startsWith('anon:')) return null;
    return ref.replace(/\\/g, '/');
}

// `@asset@` paths of a text (.usda) layer: sublayers, references, payloads,
// asset-valued attributes (textures, .mtlx sources).
function extractAssetRefs(text) {
    const out = new Set();
    ASSET_PATH_RE.lastIndex = 0;
    let m;
    while ((m = ASSET_PATH_RE.exec(text)) !== null) {
        const ref = cleanAssetPath(m[1]);
        if (ref) out.add(ref);
    }
    return Array.from(out);
}

// Texture refs (fileprefix-aware, via docScanner) and xi:include hrefs of a
// .mtlx document referenced from the stage.
function extractMtlxRefs(xml) {
    const out = new Set(docScanner.extractFilenameRefs(xml).map((r) => r.replace(/\\/g, '/')));
    XI_INCLUDE_HREF_RE.lastIndex = 0;
    let m;
    while ((m = XI_INCLUDE_HREF_RE.exec(xml)) !== null) out.add(String(m[1] || m[2]).replace(/\\/g, '/'));
    return Array.from(out).filter(Boolean);
}

function isScannable(p) {
    const ext = extOf(p);
    return ext === 'usda' || ext === 'usd' || ext === 'mtlx';
}

async function _collectWith(deps, rootLayerUri) {
    const root = docScanner._containmentRootWith(deps, rootLayerUri);
    if (!root) throw new Error('it is not a file in an open workspace folder');
    const isFileScheme = root.scheme === 'file';
    let rootRealpath = null;
    if (isFileScheme) {
        try {
            rootRealpath = (await deps.realpath(root.fsPath)).replace(/\\/g, '/');
        } catch (e) {
            rootRealpath = null; // path-based containment still applies
        }
    }
    const ctx = { root, rootRealpath, isFileScheme, totalBytes: 0 };
    const caseInsensitive = isFileScheme && process.platform === 'win32';
    const layerDir = deps.Uri.joinPath(rootLayerUri, '..');

    const files = new Map(); // uri.toString() -> { uri, size, mtime }
    const queue = [];
    const skipped = [];
    const dropped = { files: 0, bytes: 0 };
    let totalBytes = 0;
    let scanBytes = 0;

    const add = (resolved) => {
        const key = resolved.uri.toString();
        if (files.has(key)) return;
        if (files.size >= MAX_FILES) { dropped.files++; return; }
        if (totalBytes + resolved.size > MAX_TOTAL_BYTES) { dropped.bytes++; return; }
        files.set(key, resolved);
        totalBytes += resolved.size;
        if (isScannable(resolved.uri.path)) queue.push(resolved);
    };
    // Authored refs warn on every skip but a disallowed type (doc strings can
    // hold stray `@` pairs); folder-walk entries only when they escape the root.
    const resolveAndAdd = async (baseDirUri, ref, authored) => {
        const resolved = await docScanner.resolveContained(deps, ctx, baseDirUri, ref, 'scene');
        if (resolved.skip) {
            if (authored ? resolved.skip !== 'extension' : resolved.skip === 'outside') {
                skipped.push(docScanner.describeSkip(ref, resolved.skip, resolved.detail));
            }
            return;
        }
        add(resolved);
    };
    const addUdimTiles = async (baseDirUri, ref) => {
        const slash = ref.lastIndexOf('/');
        const dirRef = slash >= 0 ? ref.slice(0, slash) : '.';
        if (refPolicy.isUnsafeRef(dirRef)) { skipped.push(docScanner.describeSkip(ref, 'unsafe')); return; }
        const dirUri = deps.Uri.joinPath(baseDirUri, dirRef);
        if (!refPolicy.isPathInside(dirUri.path, ctx.root.path, caseInsensitive)) { skipped.push(docScanner.describeSkip(ref, 'outside')); return; }
        const tile = new RegExp('^' + ref.slice(slash + 1).split('<UDIM>').map(escapeRe).join('\\d{4}') + '$', 'i');
        let entries;
        try { entries = await deps.fs.readDirectory(dirUri); } catch (e) { skipped.push(docScanner.describeSkip(ref, 'not-found')); return; }
        for (const [name] of entries) {
            if (tile.test(name)) await resolveAndAdd(baseDirUri, (slash >= 0 ? dirRef + '/' : '') + name, true);
        }
    };
    const drain = async () => {
        while (queue.length) {
            const item = queue.shift();
            if (item.size > MAX_SCAN_BYTES || scanBytes + item.size > MAX_SCAN_TOTAL_BYTES) continue;
            let bytes;
            try { bytes = await deps.fs.readFile(item.uri); } catch (e) { continue; }
            scanBytes += bytes.byteLength;
            const text = Buffer.from(bytes).toString('utf8');
            const isMtlx = extOf(item.uri.path) === 'mtlx';
            if (!isMtlx && !text.startsWith('#usda')) continue; // binary crate: not scanned
            const dirUri = deps.Uri.joinPath(item.uri, '..');
            for (const ref of (isMtlx ? extractMtlxRefs(text) : extractAssetRefs(text))) {
                if (ref.includes('<UDIM>')) await addUdimTiles(dirUri, ref);
                else await resolveAndAdd(dirUri, ref, true);
            }
        }
    };
    // Breadth-first so shallow files win when a limit is reached; never
    // follows linked folders, skips dot-folders and node_modules.
    const walkTree = async () => {
        const dirs = [{ uri: layerDir, rel: '' }];
        let seen = 0;
        while (dirs.length) {
            const dir = dirs.shift();
            let entries;
            try { entries = await deps.fs.readDirectory(dir.uri); } catch (e) { continue; }
            entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
            for (const [name, type] of entries) {
                if (++seen > MAX_DIR_ENTRIES) {
                    skipped.push('Stopped listing the stage folder after ' + MAX_DIR_ENTRIES + ' entries.');
                    return;
                }
                if (name.startsWith('.')) continue;
                const rel = dir.rel ? dir.rel + '/' + name : name;
                if (type & deps.FileType.Directory) {
                    if (!(type & deps.FileType.SymbolicLink) && !SKIPPED_DIR_NAMES.has(name)) dirs.push({ uri: deps.Uri.joinPath(dir.uri, name), rel });
                } else if ((type & deps.FileType.File) && refPolicy.isAllowedRef(name, 'scene')) {
                    await resolveAndAdd(layerDir, rel, false);
                }
            }
        }
    };

    const rootName = path.posix.basename(rootLayerUri.path);
    const rootResolved = await docScanner.resolveContained(deps, ctx, layerDir, rootName, 'scene');
    if (rootResolved.skip) throw new Error(docScanner.describeSkip(rootName, rootResolved.skip, rootResolved.detail));
    add(rootResolved);
    await drain(); // everything the root layer reaches comes first
    await walkTree();
    await drain(); // then whatever the rest of its folder references

    const all = Array.from(files.values());
    let baseSegs = null;
    for (const f of all) {
        const segs = f.uri.path.split('/').slice(0, -1);
        if (!baseSegs) { baseSegs = segs; continue; }
        let i = 0;
        while (i < baseSegs.length && i < segs.length
            && (caseInsensitive ? baseSegs[i].toLowerCase() === segs[i].toLowerCase() : baseSegs[i] === segs[i])) i++;
        baseSegs = baseSegs.slice(0, i);
    }
    const basePath = baseSegs.join('/');
    const up = path.posix.relative(basePath || '/', layerDir.path);
    const baseUri = up ? deps.Uri.joinPath(layerDir, up.split('/').map(() => '..').join('/')) : layerDir;
    const relOf = (uri) => uri.path.slice(basePath.length + 1);

    const warnings = [];
    for (const msg of skipped.slice(0, SKIP_WARNING_LIMIT)) warnings.push(msg);
    if (skipped.length > SKIP_WARNING_LIMIT) warnings.push((skipped.length - SKIP_WARNING_LIMIT) + ' more reference(s) skipped.');
    if (dropped.files) warnings.push('The scene file limit (' + MAX_FILES + ' files) was reached; ' + dropped.files + ' more file(s) were not sent.');
    if (dropped.bytes) warnings.push('The scene size limit (4 GiB) was reached; ' + dropped.bytes + ' more file(s) were not sent.');

    return {
        baseUri,
        root: relOf(rootResolved.uri),
        files: all.map((f) => ({ rel: relOf(f.uri), uri: f.uri, size: f.size, mtime: f.mtime })),
        totalBytes,
        warnings,
    };
}

async function collect(rootLayerUri) {
    return _collectWith(docScanner.defaultDeps(), rootLayerUri);
}

module.exports = { collect, _collectWith, extractAssetRefs, cleanAssetPath, MAX_FILES, MAX_TOTAL_BYTES };
