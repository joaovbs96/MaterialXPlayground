// usdFileSet.js: the files a scene root needs in the webview's in-memory
// filesystem: the root file plus whatever it references, recursively. No
// folder walk: siblings in the root's folder are never included unless
// something actually references them. Root formats: USD text layers
// (.usda, sublayers/references/payloads/asset attributes), .mtlx documents
// (xi:include, textures), glTF (.gltf: buffers[].uri, images[].uri), GLB
// (.glb: same, from its JSON chunk, external refs only), and OBJ (mtllib ->
// .mtl -> map_* texture statements). Binary USD crates (.usdc, binary .usd)
// contribute every path-like token of their TOKENS section, resolved against
// the crate's own folder; anything still missing surfaces later through the
// host's missing-reference round trip (createSession().resolveMissing,
// driven by sceneProvider.js). Everything is confined exactly like
// docScanner.js (refPolicy, realpath).
//
// Snapshot shape: { baseUri, root, files: [{ rel, uri, size, mtime }],
// totalBytes, warnings }. `rel` paths are relative to baseUri, the deepest
// folder holding every file, so `..` references resolve inside the set.
'use strict';

const fs = require('fs');
const path = require('path');
const docScanner = require('./docScanner');
const refPolicy = require('./refPolicy');

const MAX_FILES = 4000;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB across the whole set
const MAX_SCAN_BYTES = 64 * 1024 * 1024; // larger layers are sent but not read for references
const MAX_SCAN_TOTAL_BYTES = 512 * 1024 * 1024; // text read for references, per session
const SKIP_WARNING_LIMIT = 5;
const SCAN_CONCURRENCY = 8; // files read for references at once
const RESOLVE_CONCURRENCY = 16; // realpath + stat calls at once, per scanned file
const MAX_MISSING_PER_REQUEST = 512;
const MAX_MISSING_ROUNDS = 5; // on-demand rounds per session (one open or reload)
const MAX_CRATE_TOKEN_BYTES = 64 * 1024 * 1024; // a crate's TOKENS section, compressed or not
const MAX_CRATE_TOKEN_LENGTH = 1024;

const ASSET_PATH_RE = /@([^@\n]+)@/g;
const XI_INCLUDE_HREF_RE = /<xi:include\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
// MaterialX tile tokens: <UDIM> is a 4-digit code, <UVTILE> is u<U>_v<V>.
const TILE_TOKEN_RE = /<UDIM>|<UVTILE>/i;
const TILE_TOKEN_SPLIT_RE = /(<UDIM>|<UVTILE>)/i;

function extOf(p) {
    return refPolicy.extOf(p);
}

function escapeRe(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasTileToken(ref) {
    return TILE_TOKEN_RE.test(ref);
}

// Filename regex for a tiled texture name such as `wood.<UDIM>.png`.
function tileNameRegex(name) {
    const parts = name.split(TILE_TOKEN_SPLIT_RE).map((part) => {
        if (/^<UDIM>$/i.test(part)) return '\\d{4}';
        if (/^<UVTILE>$/i.test(part)) return 'u\\d+_v\\d+';
        return escapeRe(part);
    });
    return new RegExp('^' + parts.join('') + '$', 'i');
}

class CancelledError extends Error {
    constructor() {
        super('cancelled');
        this.cancelled = true;
    }
}

// Runs fn over items with at most `limit` calls in flight.
async function mapLimit(items, limit, fn) {
    let next = 0;
    const run = async () => {
        while (next < items.length) {
            const index = next++;
            await fn(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
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
// .mtlx document referenced from the stage. Tile tokens are masked first:
// the `>` in `<UDIM>` would otherwise end docScanner's `<input ...>` match.
function extractMtlxRefs(xml) {
    const masked = String(xml).replace(/<(UDIM|UVTILE)>/gi, '\u0001$1\u0002');
    const unmask = (ref) => ref.replace(/\u0001(UDIM|UVTILE)\u0002/gi, '<$1>');
    const out = new Set(docScanner.extractFilenameRefs(masked).map((r) => unmask(r).replace(/\\/g, '/')));
    XI_INCLUDE_HREF_RE.lastIndex = 0;
    let m;
    while ((m = XI_INCLUDE_HREF_RE.exec(xml)) !== null) out.add(String(m[1] || m[2]).replace(/\\/g, '/'));
    return Array.from(out).filter(Boolean);
}

function isScannable(p) {
    const ext = extOf(p);
    return ext === 'usda' || ext === 'usd' || ext === 'usdc' || ext === 'mtlx'
        || ext === 'gltf' || ext === 'glb' || ext === 'obj' || ext === 'mtl';
}

// glTF/GLB buffers[]/images[].uri: relative-path entries only (data: URIs
// are inline and need no file), URI-decoded like any other web reference.
function extractGltfJsonRefs(text) {
    let json;
    try { json = JSON.parse(text); } catch (e) { return []; }
    const out = [];
    const collect = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const item of arr) {
            const uri = item && item.uri;
            if (typeof uri !== 'string' || !uri || uri.startsWith('data:')) continue;
            try { out.push(decodeURIComponent(uri).replace(/\\/g, '/')); } catch (e) { /* malformed % escape: skip */ }
        }
    };
    collect(json.buffers);
    collect(json.images);
    return out;
}

const GLB_MAGIC = 0x46546c67; // ASCII 'glTF', little-endian
const GLB_CHUNK_JSON = 0x4e4f534a; // ASCII 'JSON', little-endian

// GLB container: 12-byte header, then length-prefixed chunks. Only the JSON
// chunk is parsed; an embedded BIN chunk needs no external ref, an external
// buffer/image uri (uncommon in .glb but legal) is picked up the same way
// as glTF.
function extractGlbRefs(bytes) {
    const buf = Buffer.from(bytes);
    if (buf.length < 20 || buf.readUInt32LE(0) !== GLB_MAGIC) return [];
    let offset = 12;
    while (offset + 8 <= buf.length) {
        const chunkLength = buf.readUInt32LE(offset);
        const chunkType = buf.readUInt32LE(offset + 4);
        const chunkStart = offset + 8;
        if (chunkStart + chunkLength > buf.length) break;
        if (chunkType === GLB_CHUNK_JSON) {
            return extractGltfJsonRefs(buf.toString('utf8', chunkStart, chunkStart + chunkLength));
        }
        offset = chunkStart + chunkLength;
    }
    return [];
}

// OBJ `mtllib` lines: may list several files on one rest-of-line, and
// exporters sometimes emit filenames containing spaces, so this can't just
// split on whitespace. Each candidate is grown lazily up to its own ".mtl"
// so a run of spaces inside one filename stays with it.
const OBJ_MTLLIB_LINE_RE = /^[ \t]*mtllib[ \t]+(.+?)[ \t]*$/gim;
const MTL_FILE_RE = /\S.*?\.mtl/gi;

function extractObjMtllibRefs(text) {
    const out = [];
    let lineMatch;
    OBJ_MTLLIB_LINE_RE.lastIndex = 0;
    while ((lineMatch = OBJ_MTLLIB_LINE_RE.exec(text)) !== null) {
        const rest = lineMatch[1];
        let fileMatch;
        let any = false;
        MTL_FILE_RE.lastIndex = 0;
        while ((fileMatch = MTL_FILE_RE.exec(rest)) !== null) {
            out.push(fileMatch[0].replace(/\\/g, '/'));
            any = true;
        }
        if (!any && rest.trim()) out.push(rest.trim().replace(/\\/g, '/'));
    }
    return out;
}

// .mtl texture statements this project's OBJ loader (and common exporters)
// use. Option flags before the path (-bm, -s, -o, -clamp, ...) are stripped
// by their known MTL arg count; -o/-s/-t take 1-3 NUMERIC args so only the
// numeric run right after them is consumed.
const MTL_TEXTURE_RE = /^[ \t]*(map_Kd|map_Ks|map_Ka|map_Ns|map_d|map_bump|bump|disp|decal|norm|map_Pr|map_Pm|map_Ps|map_Ke)[ \t]+(.+?)[ \t]*$/gim;
const MTL_FLAG_ARG_COUNTS = {
    '-blendu': 1, '-blendv': 1, '-cc': 1, '-clamp': 1, '-imfchan': 1,
    '-type': 1, '-bm': 1, '-boost': 1, '-texres': 1, '-mm': 2,
    '-o': 3, '-s': 3, '-t': 3,
};
const NUMERIC_TOKEN_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function stripMtlTextureFlags(rest) {
    const tokens = rest.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && tokens[i].startsWith('-')) {
        const flag = tokens[i].toLowerCase();
        i++;
        const argCount = MTL_FLAG_ARG_COUNTS[flag];
        if (argCount === undefined) { i++; continue; } // unknown flag: assume one arg
        if (flag === '-o' || flag === '-s' || flag === '-t') {
            let consumed = 0;
            while (consumed < argCount && i < tokens.length && NUMERIC_TOKEN_RE.test(tokens[i])) { i++; consumed++; }
        } else {
            i += argCount;
        }
    }
    return tokens.slice(i).join(' ');
}

function extractMtlTextureRefs(text) {
    const out = [];
    let m;
    MTL_TEXTURE_RE.lastIndex = 0;
    while ((m = MTL_TEXTURE_RE.exec(text)) !== null) {
        const p = stripMtlTextureFlags(m[2]);
        if (p) out.push(p.replace(/\\/g, '/'));
    }
    return out;
}

// USD crate (.usdc) reading: the bootstrap header, the table of contents
// it points at, and the TOKENS section, which holds every string of the
// layer (asset paths included) as NUL-separated text.
const CRATE_MAGIC = 'PXR-USDC';

// One LZ4 block into `out` starting at `start`; returns the end offset.
function lz4DecodeBlock(src, out, start) {
    let s = 0;
    let d = start;
    const fail = () => { throw new Error('malformed LZ4 block'); };
    while (s < src.length) {
        const token = src[s++];
        let literals = token >> 4;
        if (literals === 15) { let b; do { if (s >= src.length) fail(); b = src[s++]; literals += b; } while (b === 255); }
        if (s + literals > src.length || d + literals > out.length) fail();
        src.copy(out, d, s, s + literals);
        s += literals;
        d += literals;
        if (s >= src.length) break;
        if (s + 2 > src.length) fail();
        const offset = src[s] | (src[s + 1] << 8);
        s += 2;
        let match = token & 15;
        if (match === 15) { let b; do { if (s >= src.length) fail(); b = src[s++]; match += b; } while (b === 255); }
        match += 4;
        if (!offset || offset > d - start || d + match > out.length) fail();
        for (let i = 0; i < match; i++, d++) out[d] = out[d - offset];
    }
    return d;
}

// TfFastCompression buffer: a chunk count byte (0 = one LZ4 block), then
// for chunked data an int32 size before each block.
function tfDecompress(src, size) {
    const out = Buffer.alloc(size);
    const chunks = src[0];
    if (!chunks) { lz4DecodeBlock(src.subarray(1), out, 0); return out; }
    let s = 1;
    let d = 0;
    for (let i = 0; i < chunks; i++) {
        if (s + 4 > src.length) throw new Error('malformed compressed tokens');
        const len = src.readInt32LE(s);
        s += 4;
        if (len < 0 || s + len > src.length) throw new Error('malformed compressed tokens');
        d = lz4DecodeBlock(src.subarray(s, s + len), out, d);
        s += len;
    }
    return out;
}

// Path-like tokens: a file extension and no line breaks. Policy and
// containment still apply when each one is resolved.
function crateTokenRefs(tokens) {
    const out = new Set();
    for (const token of tokens) {
        if (!token || token.length > MAX_CRATE_TOKEN_LENGTH || /[\n\r\0]/.test(token)) continue;
        const ref = cleanAssetPath(token);
        if (ref && /[^/.]\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(ref)) out.add(ref);
    }
    return Array.from(out);
}

// Bytes [offset, offset + length) of a file, without reading the rest.
async function readRange(deps, uri, offset, length) {
    if (deps.readRange) return deps.readRange(uri, offset, length);
    if (uri.scheme !== 'file') return !offset && deps.readHead ? deps.readHead(uri, length) : null;
    const handle = await fs.promises.open(uri.fsPath, 'r');
    try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

// { tokens, bytes } of a USD crate, reading only its header, TOC and TOKENS
// section; null when the file is not a crate. Throws on a malformed crate.
async function readCrateTokens(deps, uri, maxBytes) {
    const header = await readRange(deps, uri, 0, 24);
    if (!header || header.length < 24 || Buffer.from(header).toString('latin1', 0, 8) !== CRATE_MAGIC) return null;
    const head = Buffer.from(header);
    const oldTokens = head[8] === 0 && head[9] < 4; // before 0.4.0 tokens are stored uncompressed
    const tocOffset = Number(head.readBigInt64LE(16));
    const countBuf = await readRange(deps, uri, tocOffset, 8);
    if (!countBuf || countBuf.length < 8) throw new Error('truncated crate');
    const sections = Number(Buffer.from(countBuf).readBigUInt64LE(0));
    if (sections > 64) throw new Error('malformed crate');
    const toc = Buffer.from(await readRange(deps, uri, tocOffset + 8, sections * 32));
    for (let i = 0; i + 1 <= sections && (i + 1) * 32 <= toc.length; i++) {
        const o = i * 32;
        if (toc.toString('latin1', o, o + 16).replace(/\0[\s\S]*$/, '') !== 'TOKENS') continue;
        const start = Number(toc.readBigInt64LE(o + 16));
        const size = Number(toc.readBigInt64LE(o + 24));
        if (size > maxBytes) return { tokens: [], bytes: 0 };
        const section = Buffer.from(await readRange(deps, uri, start, size));
        let chars;
        if (oldTokens) {
            chars = section.subarray(16, 16 + Number(section.readBigUInt64LE(8)));
        } else {
            const uncompressed = Number(section.readBigUInt64LE(8));
            const compressed = Number(section.readBigUInt64LE(16));
            if (uncompressed > maxBytes || 24 + compressed > section.length) throw new Error('malformed crate tokens');
            chars = tfDecompress(section.subarray(24, 24 + compressed), uncompressed);
        }
        return { tokens: chars.toString('utf8').split('\0'), bytes: size };
    }
    return { tokens: [], bytes: 0 };
}

// 'text', 'binary' or 'unknown' for a scene file. Decided by extension; a
// .usd needs its first bytes (`head`): '#usda' is text, a crate is binary.
function sceneFileKind(p, head) {
    const ext = extOf(p);
    if (ext === 'usda' || ext === 'gltf' || ext === 'obj') return 'text';
    if (ext === 'usdc' || ext === 'usdz' || ext === 'glb') return 'binary';
    if (ext !== 'usd' || !head) return 'unknown';
    const magic = Buffer.from(head).toString('latin1', 0, 8);
    if (magic.startsWith('#usda')) return 'text';
    return magic === CRATE_MAGIC ? 'binary' : 'unknown';
}

// A set-relative path as the webview reports it (a VFS layer identifier such
// as `/layers/geo.usda`): forward slashes, no leading slash, no escape above
// the set base. Returns '' for anything else.
function normalizeSetPath(value) {
    const raw = String(value || '').replace(/\\/g, '/').trim();
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw.replace(/^\/+/, ''))) return '';
    const out = [];
    for (const part of raw.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') {
            if (!out.length) return '';
            out.pop();
        } else {
            out.push(part);
        }
    }
    return out.join('/');
}

// One scene's file set, kept across on-demand rounds so nothing already
// resolved or scanned is visited twice. Options: scanRefs (false skips every
// static reference parse, test only), isCancelled, onProgress({ found, bytes }).
class SceneFileSession {
    constructor(deps, rootLayerUri, options) {
        const opts = options || {};
        this.deps = deps;
        this.rootLayerUri = rootLayerUri;
        this.scanRefs = opts.scanRefs !== false;
        this.isCancelled = opts.isCancelled || (() => false);
        this.onProgress = opts.onProgress || null;
        this.files = new Map(); // uri.toString() -> { uri, size, mtime }
        this.resolving = new Map(); // joined uri.toString() -> Promise<'added'|'present'|false>
        this.queue = [];
        this.skipped = [];
        this.dropped = { files: 0, bytes: 0 };
        this.totalBytes = 0;
        this.scanBytes = 0;
        this.tried = new Set(); // missing-entry keys already looked up
        this.rounds = 0;
        this.maxRounds = opts.maxRounds || MAX_MISSING_ROUNDS;
        this.ctx = null;
        this.rootUri = null;
    }

    checkCancelled() {
        if (this.isCancelled()) throw new CancelledError();
    }

    progress() {
        if (this.onProgress) this.onProgress({ found: this.files.size, bytes: this.totalBytes });
    }

    // Resolves the root layer and everything it statically references.
    async init() {
        const deps = this.deps;
        const root = docScanner._containmentRootWith(deps, this.rootLayerUri);
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
        this.ctx = { root, rootRealpath, isFileScheme, totalBytes: 0 };
        this.caseInsensitive = isFileScheme && process.platform === 'win32';
        this.layerDir = deps.Uri.joinPath(this.rootLayerUri, '..');
        this.checkCancelled();
        const rootName = path.posix.basename(this.rootLayerUri.path);
        const rootResolved = await docScanner.resolveContained(deps, this.ctx, this.layerDir, rootName, 'scene');
        if (rootResolved.skip) throw new Error(docScanner.describeSkip(rootName, rootResolved.skip, rootResolved.detail));
        this.rootUri = rootResolved.uri;
        this.add(rootResolved);
        await this.drain();
    }

    // 'added', 'present' (already in the set) or false (a limit was hit).
    add(resolved) {
        const key = resolved.uri.toString();
        if (this.files.has(key)) return 'present';
        if (this.files.size >= MAX_FILES) { this.dropped.files++; return false; }
        if (this.totalBytes + resolved.size > MAX_TOTAL_BYTES) { this.dropped.bytes++; return false; }
        this.files.set(key, resolved);
        this.totalBytes += resolved.size;
        if (this.scanRefs && isScannable(resolved.uri.path)) this.queue.push(resolved);
        this.progress();
        return 'added';
    }

    // Authored refs warn on every skip but a disallowed type (doc strings can
    // hold stray `@` pairs); on-demand lookups pass record=false instead.
    resolveRef(baseDirUri, ref, record) {
        let joined = null;
        try { joined = this.deps.Uri.joinPath(baseDirUri, ref).toString(); } catch (e) { joined = null; }
        if (joined && this.files.has(joined)) return Promise.resolve('present');
        if (joined && this.resolving.has(joined)) return this.resolving.get(joined);
        const pending = (async () => {
            this.checkCancelled();
            const resolved = await docScanner.resolveContained(this.deps, this.ctx, baseDirUri, ref, 'scene');
            if (resolved.skip) {
                if (record && resolved.skip !== 'extension') this.skipped.push(docScanner.describeSkip(ref, resolved.skip, resolved.detail));
                return false;
            }
            return this.add(resolved);
        })();
        if (joined) this.resolving.set(joined, pending);
        return pending;
    }

    // Adds every file in the ref's folder matching its <UDIM>/<UVTILE> name;
    // returns how many tiles are in the set afterwards.
    async addTiles(baseDirUri, ref, record) {
        const slash = ref.lastIndexOf('/');
        const dirRef = slash >= 0 ? ref.slice(0, slash) : '.';
        if (refPolicy.isUnsafeRef(dirRef)) { if (record) this.skipped.push(docScanner.describeSkip(ref, 'unsafe')); return 0; }
        const dirUri = this.deps.Uri.joinPath(baseDirUri, dirRef);
        if (!refPolicy.isPathInside(dirUri.path, this.ctx.root.path, this.caseInsensitive)) {
            if (record) this.skipped.push(docScanner.describeSkip(ref, 'outside'));
            return 0;
        }
        const tile = tileNameRegex(ref.slice(slash + 1));
        let entries;
        try { entries = await this.deps.fs.readDirectory(dirUri); } catch (e) {
            if (record) this.skipped.push(docScanner.describeSkip(ref, 'not-found'));
            return 0;
        }
        const names = entries.map(([name]) => name).filter((name) => tile.test(name));
        let count = 0;
        await mapLimit(names, RESOLVE_CONCURRENCY, async (name) => {
            if (await this.resolveRef(baseDirUri, (slash >= 0 ? dirRef + '/' : '') + name, record)) count++;
        });
        return count;
    }

    async scanOne(item) {
        this.checkCancelled();
        const deps = this.deps;
        const ext = extOf(item.uri.path);
        const dirUri = deps.Uri.joinPath(item.uri, '..');
        // A crate (.usdc, or a .usd with the crate header) is read in ranges:
        // header, table of contents and TOKENS section, never in full.
        if (ext === 'usdc' || ext === 'usd') {
            let crate;
            try {
                crate = await readCrateTokens(deps, item.uri, Math.min(MAX_CRATE_TOKEN_BYTES, MAX_SCAN_TOTAL_BYTES - this.scanBytes));
            } catch (e) {
                crate = { tokens: [], bytes: 0 };
            }
            this.checkCancelled();
            if (crate) {
                this.scanBytes += crate.bytes;
                // Tokens also hold doc strings and custom data: misses stay silent.
                await mapLimit(crateTokenRefs(crate.tokens), RESOLVE_CONCURRENCY, (ref) => (hasTileToken(ref)
                    ? this.addTiles(dirUri, ref, false)
                    : this.resolveRef(dirUri, ref, false)));
                return;
            }
            if (ext === 'usdc') return;
        }
        if (item.size > MAX_SCAN_BYTES || this.scanBytes + item.size > MAX_SCAN_TOTAL_BYTES) return;
        // A .usd that is not a crate is read in full only when it is text.
        if (ext === 'usd' && deps.readHead) {
            let head = null;
            try { head = await deps.readHead(item.uri, 5); } catch (e) { head = null; }
            if (head && Buffer.from(head).toString('latin1') !== '#usda') return;
        }
        this.scanBytes += item.size;
        let bytes;
        try { bytes = await deps.fs.readFile(item.uri); } catch (e) { return; }
        this.checkCancelled();
        let refs;
        if (ext === 'glb') {
            refs = extractGlbRefs(bytes);
        } else {
            const text = Buffer.from(bytes).toString('utf8');
            if (ext === 'mtlx') refs = extractMtlxRefs(text);
            else if (ext === 'gltf') refs = extractGltfJsonRefs(text);
            else if (ext === 'obj') refs = extractObjMtllibRefs(text);
            else if (ext === 'mtl') refs = extractMtlTextureRefs(text);
            else if (text.startsWith('#usda')) refs = extractAssetRefs(text);
            else return; // not a text layer
        }
        await mapLimit(refs, RESOLVE_CONCURRENCY, (ref) => (hasTileToken(ref)
            ? this.addTiles(dirUri, ref, true)
            : this.resolveRef(dirUri, ref, true)));
    }

    // Scans queued text files (and what they add) with bounded concurrency.
    async drain() {
        const active = new Set();
        let failure = null;
        while (!failure && (this.queue.length || active.size)) {
            this.checkCancelled();
            while (this.queue.length && active.size < SCAN_CONCURRENCY) {
                const item = this.queue.shift();
                const task = this.scanOne(item)
                    .catch((e) => { failure = failure || e; })
                    .then(() => { active.delete(task); });
                active.add(task);
            }
            if (active.size) await Promise.race(active);
        }
        if (failure) throw failure;
        this.checkCancelled();
    }

    // Re-validates files found on demand earlier in this panel (a rescan
    // after a file change keeps them without another round trip).
    async addKnown(uris) {
        await mapLimit(uris || [], RESOLVE_CONCURRENCY, (uri) => this.resolveRef(
            this.deps.Uri.joinPath(uri, '..'), path.posix.basename(uri.path), false));
        await this.drain();
    }

    // Looks up the files a loaded scene reported missing: { asset,
    // introducedBy } with introducedBy a set-relative layer path (relative
    // to baseUri, the base of the snapshot the webview loaded). Tries the
    // introducing layer's folder first, then the set base. Entries already
    // looked up in this session are skipped; a request with new entries is
    // one round, at most maxRounds. Returns { round, limited, tried, added:
    // [{ uri, size, mtime }], stillMissing: [asset] }.
    async resolveMissing(entries, baseUri) {
        const none = { round: this.rounds, limited: false, tried: 0, added: [], stillMissing: [] };
        if (this.rounds >= this.maxRounds) return Object.assign(none, { limited: true });
        const before = new Set(this.files.keys());
        const fresh = [];
        for (const entry of (Array.isArray(entries) ? entries : []).slice(0, MAX_MISSING_PER_REQUEST)) {
            const asset = cleanAssetPath(entry && entry.asset);
            if (!asset) continue;
            const by = normalizeSetPath(entry && entry.introducedBy);
            const key = asset + '|' + by;
            if (this.tried.has(key)) continue;
            this.tried.add(key);
            fresh.push({ asset, by });
        }
        if (!fresh.length) return none;
        this.rounds++;
        const stillMissing = [];
        await mapLimit(fresh, RESOLVE_CONCURRENCY, async ({ asset, by }) => {
            this.checkCancelled();
            // A leading slash is a path in the webview's filesystem, whose
            // root is the set base.
            const absolute = asset.startsWith('/');
            const ref = absolute ? asset.replace(/^\/+/, '') : asset;
            const dirs = [];
            if (!absolute && by.includes('/')) dirs.push(this.deps.Uri.joinPath(baseUri, by.slice(0, by.lastIndexOf('/'))));
            dirs.push(baseUri);
            for (const dir of dirs) {
                const found = hasTileToken(ref) ? (await this.addTiles(dir, ref, false)) > 0 : !!(await this.resolveRef(dir, ref, false));
                if (found) return;
            }
            stillMissing.push(asset);
        });
        await this.drain();
        const added = [];
        for (const [key, file] of this.files) if (!before.has(key)) added.push(file);
        return { round: this.rounds, limited: false, tried: fresh.length, added, stillMissing: stillMissing.sort() };
    }

    snapshot() {
        const all = Array.from(this.files.values());
        const caseInsensitive = this.caseInsensitive;
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
        const up = path.posix.relative(basePath || '/', this.layerDir.path);
        const baseUri = up ? this.deps.Uri.joinPath(this.layerDir, up.split('/').map(() => '..').join('/')) : this.layerDir;
        const relOf = (uri) => uri.path.slice(basePath.length + 1);

        const warnings = [];
        for (const msg of this.skipped.slice(0, SKIP_WARNING_LIMIT)) warnings.push(msg);
        if (this.skipped.length > SKIP_WARNING_LIMIT) warnings.push((this.skipped.length - SKIP_WARNING_LIMIT) + ' more reference(s) skipped.');
        if (this.dropped.files) warnings.push('The scene file limit (' + MAX_FILES + ' files) was reached; ' + this.dropped.files + ' more file(s) were not sent.');
        if (this.dropped.bytes) warnings.push('The scene size limit (4 GiB) was reached; ' + this.dropped.bytes + ' more file(s) were not sent.');

        const files = all.map((f) => ({ rel: relOf(f.uri), uri: f.uri, size: f.size, mtime: f.mtime }))
            .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
        return { baseUri, root: relOf(this.rootUri), files, totalBytes: this.totalBytes, warnings, relOf };
    }
}

function createSession(deps, rootLayerUri, options) {
    return new SceneFileSession(deps, rootLayerUri, options);
}

async function _collectWith(deps, rootLayerUri, options) {
    const session = createSession(deps, rootLayerUri, options);
    await session.init();
    return session.snapshot();
}

async function collect(rootLayerUri, options) {
    return _collectWith(docScanner.defaultDeps(), rootLayerUri, options);
}

module.exports = {
    collect, _collectWith, createSession, extractAssetRefs, extractMtlxRefs, cleanAssetPath,
    extractGltfJsonRefs, extractGlbRefs, extractObjMtllibRefs, extractMtlTextureRefs,
    normalizeSetPath, tileNameRegex, readCrateTokens, crateTokenRefs, sceneFileKind,
    MAX_FILES, MAX_TOTAL_BYTES, MAX_MISSING_PER_REQUEST, MAX_MISSING_ROUNDS,
};
