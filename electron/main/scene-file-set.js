// scene-file-set.js: Node port of vscode_extension/src/usdFileSet.js for
// Electron's main process. The scene root plus every file it references,
// recursively (USD text layers, crate tokens, .mtlx, glTF/GLB, OBJ/MTL,
// pbrt), with no folder walk: a sibling is only included when something
// references it (UDIM tiles list the referenced folder only).
//
// Policy (desktop app, like a DCC): references may be relative, drive-letter
// absolute or UNC, and may leave the root's folder. Reads are read-only and
// limited to scene and image file types (SCENE_EXTENSIONS). The renderer
// never names a path: it fetches files by an opaque per-session id through
// the app: protocol (/__scene/<token>/<id>/<name>), and asks for missing
// references, which are resolved here against the scene's own folders.
//
// Snapshot shape: { base, root, files: [{ rel, abs, size, mtime, id }],
// totalBytes, warnings }. `rel` is relative to `base`, the deepest folder
// holding every file on the root's volume; files on another drive or share
// get a synthetic rel (`__abs/<drive>/...`, `__unc/<server>/<share>/...`).
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath } = require('node:url');
const { Readable } = require('node:stream');
const docScanner = require('./doc-scanner');

const IS_WIN = process.platform === 'win32';
const MAX_FILES = 4000;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB across the whole set
const MAX_SCAN_BYTES = 64 * 1024 * 1024; // larger files are sent but not read for references
const MAX_SCAN_TOTAL_BYTES = 512 * 1024 * 1024; // text read for references, per session
const SKIP_WARNING_LIMIT = 5;
const SCAN_CONCURRENCY = 8;
const RESOLVE_CONCURRENCY = 16;
const MAX_MISSING_PER_REQUEST = 512;
const MAX_MISSING_ROUNDS = 5;
const MAX_CRATE_TOKEN_BYTES = 64 * 1024 * 1024;
const MAX_CRATE_TOKEN_LENGTH = 1024;

// Fallback when the caller passes no texture list (main.js passes the site's
// js/shared/texture-formats.js list, the single source of truth).
const DEFAULT_TEXTURE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'exr', 'hdr', 'tif', 'tiff', 'tga', 'ktx2'];
const SCENE_FILE_EXTS = ['usd', 'usda', 'usdc', 'usdz', 'gltf', 'glb', 'obj', 'bin', 'mtl', 'mtlx', 'pbrt', 'ply', 'pfm'];
// Files the desktop app opens as a Scene Viewer root (file associations,
// drop, argv). .xml (Mitsuba) is too generic to claim.
const SCENE_ROOT_EXTS = ['usd', 'usda', 'usdc', 'usdz', 'gltf', 'glb', 'obj', 'mtl', 'pbrt'];

const ASSET_PATH_RE = /@([^@\n]+)@/g;
const XI_INCLUDE_HREF_RE = /<xi:include\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const TILE_TOKEN_RE = /<UDIM>|<UVTILE>/i;
const TILE_TOKEN_SPLIT_RE = /(<UDIM>|<UVTILE>)/i;
// Two or more characters, so a drive letter ("L:") is never a URL scheme.
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]+:/i;

function extOf(p) {
    const clean = String(p).split(/[?#]/)[0];
    const base = clean.slice(Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')) + 1);
    const dot = base.lastIndexOf('.');
    return dot < 0 ? '' : base.slice(dot + 1).toLowerCase();
}

function isSceneRootPath(p) {
    return SCENE_ROOT_EXTS.includes(extOf(p));
}

function escapeRe(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasTileToken(ref) {
    return TILE_TOKEN_RE.test(ref);
}

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

// Authored asset path as a plain ref: drops file format args and
// package-internal paths (`a.usdz[b.png]`), normalizes separators.
function cleanAssetPath(raw) {
    let ref = String(raw == null ? '' : raw).replace(/:SDF_FORMAT_ARGS:.*$/, '').trim();
    const bracket = ref.indexOf('[');
    if (bracket > 0) ref = ref.slice(0, bracket);
    if (!ref || ref.startsWith('anon:')) return null;
    return ref.replace(/\\/g, '/');
}

// True for drive-letter (`L:/`, `L:\`) and UNC (`//server`, `\\server`) refs.
function isAbsoluteFsRef(ref) {
    return /^(?:[a-zA-Z]:[\\/]|[\\/]{2}(?![\\/]))/.test(String(ref || ''));
}

// Absolute filesystem path for a ref read from a file in baseDir, or null
// (URL scheme, control characters, a Windows-only path on another OS).
function refToPath(baseDir, raw) {
    const ref = String(raw == null ? '' : raw).trim();
    if (!ref || /[\x00-\x1f]/.test(ref)) return null;
    if (/^file:/i.test(ref)) {
        try { return path.normalize(fileURLToPath(ref)); } catch (e) { return null; }
    }
    if (URL_SCHEME_RE.test(ref)) return null;
    const fwd = ref.replace(/\\/g, '/');
    if (isAbsoluteFsRef(fwd)) return IS_WIN ? path.win32.normalize(fwd) : null;
    if (/^[a-zA-Z]:/.test(fwd)) return null; // drive-relative ("C:foo")
    return path.resolve(baseDir, fwd);
}

function keyOf(abs) {
    return IS_WIN ? abs.toLowerCase() : abs;
}

function volumeOf(abs) {
    return keyOf(path.parse(abs).root);
}

// Forward-slash absolute path, the form the renderer matches refs against.
function forwardAbs(abs) {
    return abs.replace(/\\/g, '/');
}

// `__abs/<drive>/...` or `__unc/<server>/<share>/...` for a file off the root's volume.
function syntheticRel(abs) {
    const fwd = forwardAbs(abs);
    const drive = /^([a-zA-Z]):\/(.*)$/.exec(fwd);
    if (drive) return '__abs/' + drive[1].toUpperCase() + '/' + drive[2];
    const unc = /^\/\/([^/]+)\/(.*)$/.exec(fwd);
    if (unc) return '__unc/' + unc[1] + '/' + unc[2];
    return '__abs/' + fwd.replace(/^\/+/, '');
}

function syntheticToAbs(rel) {
    const drive = /^__abs\/([a-zA-Z])\/(.*)$/.exec(rel);
    if (drive) return IS_WIN ? path.win32.normalize(drive[1] + ':/' + drive[2]) : null;
    const unc = /^__unc\/([^/]+)\/(.*)$/.exec(rel);
    if (unc) return IS_WIN ? path.win32.normalize('//' + unc[1] + '/' + unc[2]) : null;
    return undefined; // not synthetic
}

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

// Tile tokens are masked first: the `>` in `<UDIM>` would end the `<input ...>` match.
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
        || ext === 'gltf' || ext === 'glb' || ext === 'obj' || ext === 'mtl' || ext === 'pbrt';
}

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

const GLB_MAGIC = 0x46546c67;
const GLB_CHUNK_JSON = 0x4e4f534a;

function extractGlbRefs(bytes) {
    const buf = Buffer.from(bytes);
    if (buf.length < 20 || buf.readUInt32LE(0) !== GLB_MAGIC) return [];
    let offset = 12;
    while (offset + 8 <= buf.length) {
        const chunkLength = buf.readUInt32LE(offset);
        const chunkType = buf.readUInt32LE(offset + 4);
        const chunkStart = offset + 8;
        if (chunkStart + chunkLength > buf.length) break;
        if (chunkType === GLB_CHUNK_JSON) return extractGltfJsonRefs(buf.toString('utf8', chunkStart, chunkStart + chunkLength));
        offset = chunkStart + chunkLength;
    }
    return [];
}

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
        if (argCount === undefined) { i++; continue; }
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

// pbrt-v4: every quoted string that looks like a file name (Include/Import,
// "string filename", texture and spectrum files). Misses stay silent.
const PBRT_STRING_RE = /"([^"\n]{1,1024})"/g;
function extractPbrtRefs(text) {
    const out = new Set();
    PBRT_STRING_RE.lastIndex = 0;
    let m;
    while ((m = PBRT_STRING_RE.exec(text)) !== null) {
        const ref = m[1].trim().replace(/\\/g, '/');
        if (/[^/.]\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(ref)) out.add(ref);
    }
    return Array.from(out);
}

const CRATE_MAGIC = 'PXR-USDC';

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

function crateTokenRefs(tokens) {
    const out = new Set();
    for (const token of tokens) {
        if (!token || token.length > MAX_CRATE_TOKEN_LENGTH || /[\n\r\0]/.test(token)) continue;
        const ref = cleanAssetPath(token);
        if (ref && /[^/.]\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(ref)) out.add(ref);
    }
    return Array.from(out);
}

async function readRange(file, offset, length) {
    const handle = await fs.promises.open(file, 'r');
    try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, offset);
        return buf.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

// { tokens, bytes } of a USD crate (header, TOC and TOKENS section only);
// null when the file is not a crate. Throws on a malformed crate.
async function readCrateTokens(file, maxBytes) {
    const head = await readRange(file, 0, 24);
    if (head.length < 24 || head.toString('latin1', 0, 8) !== CRATE_MAGIC) return null;
    const oldTokens = head[8] === 0 && head[9] < 4;
    const tocOffset = Number(head.readBigInt64LE(16));
    const countBuf = await readRange(file, tocOffset, 8);
    if (countBuf.length < 8) throw new Error('truncated crate');
    const sections = Number(countBuf.readBigUInt64LE(0));
    if (sections > 64) throw new Error('malformed crate');
    const toc = await readRange(file, tocOffset + 8, sections * 32);
    for (let i = 0; (i + 1) * 32 <= toc.length && i < sections; i++) {
        const o = i * 32;
        if (toc.toString('latin1', o, o + 16).replace(/\0[\s\S]*$/, '') !== 'TOKENS') continue;
        const start = Number(toc.readBigInt64LE(o + 16));
        const size = Number(toc.readBigInt64LE(o + 24));
        if (size > maxBytes) return { tokens: [], bytes: 0 };
        const section = await readRange(file, start, size);
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

// A set-relative path as the renderer reports it: forward slashes, no
// leading slash, no escape above the set base; '' for anything else.
function normalizeSetPath(value) {
    const raw = String(value || '').replace(/\\/g, '/').trim();
    if (!raw || URL_SCHEME_RE.test(raw.replace(/^\/+/, ''))) return '';
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

function describeSkip(ref, reason) {
    switch (reason) {
        case 'extension': return 'Skipped "' + ref + '": its file type is not allowed here.';
        case 'not-found': return 'Skipped "' + ref + '": the referenced file was not found.';
        case 'not-regular-file': return 'Skipped "' + ref + '": it is not a regular file.';
        case 'unsupported': return 'Skipped "' + ref + '": it is not a file path this computer can open.';
        default: return 'Skipped "' + ref + '": could not resolve it.';
    }
}

class SceneFileSession {
    // options: textureExts, scanRefs (false skips reference parsing, test
    // only), isCancelled, onProgress({ found, bytes }), maxRounds.
    constructor(rootPath, options) {
        const opts = options || {};
        this.rootPath = path.resolve(rootPath);
        this.token = crypto.randomBytes(16).toString('hex');
        this.allowed = new Set(SCENE_FILE_EXTS.concat(opts.textureExts || DEFAULT_TEXTURE_EXTS));
        this.scanRefs = opts.scanRefs !== false;
        this.isCancelled = opts.isCancelled || (() => false);
        this.onProgress = opts.onProgress || null;
        this.maxRounds = opts.maxRounds || MAX_MISSING_ROUNDS;
        this.files = new Map(); // keyOf(abs) -> { abs, size, mtime, id }
        this.byId = new Map(); // id -> same entry, the protocol lookup
        this.resolving = new Map();
        this.queue = [];
        this.skipped = [];
        this.dropped = { files: 0, bytes: 0 };
        this.totalBytes = 0;
        this.scanBytes = 0;
        this.tried = new Set();
        this.rounds = 0;
        this.nextId = 1;
        this.root = null;
        this.base = path.dirname(this.rootPath);
        this.disposed = false;
    }

    checkCancelled() {
        if (this.disposed || this.isCancelled()) throw new CancelledError();
    }

    progress() {
        if (this.onProgress) this.onProgress({ found: this.files.size, bytes: this.totalBytes });
    }

    async init() {
        this.checkCancelled();
        let stat;
        try { stat = await fs.promises.stat(this.rootPath); } catch (e) { throw new Error('the file was not found'); }
        if (!stat.isFile()) throw new Error('it is not a regular file');
        this.root = this.add(this.rootPath, stat, true);
        if (!this.root) throw new Error('it exceeds the scene size limit');
        await this.drain();
    }

    // The new entry, the existing one, or null when a limit was hit.
    add(abs, stat, force) {
        const key = keyOf(abs);
        const existing = this.files.get(key);
        if (existing) return existing;
        if (!force && !this.allowed.has(extOf(abs))) return null;
        if (this.files.size >= MAX_FILES) { this.dropped.files++; return null; }
        if (this.totalBytes + stat.size > MAX_TOTAL_BYTES) { this.dropped.bytes++; return null; }
        const entry = { abs, size: stat.size, mtime: Math.round(stat.mtimeMs), id: 'f' + (this.nextId++) };
        this.files.set(key, entry);
        this.byId.set(entry.id, entry);
        this.totalBytes += stat.size;
        if (this.scanRefs && isScannable(abs)) this.queue.push(entry);
        this.progress();
        return entry;
    }

    // 'added', 'present' or false. Authored refs record skips; on-demand
    // lookups (and crate tokens, which hold doc strings too) stay silent.
    resolveRef(baseDir, ref, record) {
        const abs = refToPath(baseDir, ref);
        if (!abs) {
            if (record && !URL_SCHEME_RE.test(ref)) this.skipped.push(describeSkip(ref, 'unsupported'));
            return Promise.resolve(false);
        }
        const key = keyOf(abs);
        if (this.files.has(key)) return Promise.resolve('present');
        if (this.resolving.has(key)) return this.resolving.get(key);
        const pending = (async () => {
            this.checkCancelled();
            if (!this.allowed.has(extOf(abs))) {
                return false;
            }
            let stat;
            try { stat = await fs.promises.stat(abs); } catch (e) {
                if (record) this.skipped.push(describeSkip(ref, 'not-found'));
                return false;
            }
            this.checkCancelled();
            if (!stat.isFile()) {
                if (record) this.skipped.push(describeSkip(ref, 'not-regular-file'));
                return false;
            }
            return this.add(abs, stat) ? 'added' : false;
        })();
        this.resolving.set(key, pending);
        return pending;
    }

    // Lists only the referenced folder, adding files that match the ref's
    // <UDIM>/<UVTILE> name; returns how many tiles are in the set afterwards.
    async addTiles(baseDir, ref, record) {
        const slash = ref.lastIndexOf('/');
        const dirRef = slash >= 0 ? ref.slice(0, slash) : '.';
        const dir = refToPath(baseDir, dirRef || '/');
        if (!dir) return 0;
        const tile = tileNameRegex(ref.slice(slash + 1));
        let names;
        try { names = await fs.promises.readdir(dir); } catch (e) {
            if (record) this.skipped.push(describeSkip(ref, 'not-found'));
            return 0;
        }
        let count = 0;
        await mapLimit(names.filter((name) => tile.test(name)), RESOLVE_CONCURRENCY, async (name) => {
            if (await this.resolveRef(dir, name, record)) count++;
        });
        return count;
    }

    async scanOne(item) {
        this.checkCancelled();
        const ext = extOf(item.abs);
        const dir = path.dirname(item.abs);
        const follow = (refs, record) => mapLimit(refs, RESOLVE_CONCURRENCY, (ref) => (hasTileToken(ref)
            ? this.addTiles(dir, ref, record)
            : this.resolveRef(dir, ref, record)));
        if (ext === 'usdc' || ext === 'usd') {
            let crate;
            try {
                crate = await readCrateTokens(item.abs, Math.min(MAX_CRATE_TOKEN_BYTES, MAX_SCAN_TOTAL_BYTES - this.scanBytes));
            } catch (e) {
                crate = { tokens: [], bytes: 0 };
            }
            this.checkCancelled();
            if (crate) {
                this.scanBytes += crate.bytes;
                await follow(crateTokenRefs(crate.tokens), false);
                return;
            }
            if (ext === 'usdc') return;
        }
        if (item.size > MAX_SCAN_BYTES || this.scanBytes + item.size > MAX_SCAN_TOTAL_BYTES) return;
        if (ext === 'usd') {
            let head = null;
            try { head = await readRange(item.abs, 0, 5); } catch (e) { head = null; }
            if (!head || head.toString('latin1') !== '#usda') return;
        }
        this.scanBytes += item.size;
        let bytes;
        try { bytes = await fs.promises.readFile(item.abs); } catch (e) { return; }
        this.checkCancelled();
        if (ext === 'glb') { await follow(extractGlbRefs(bytes), true); return; }
        const text = bytes.toString('utf8');
        if (ext === 'mtlx') await follow(extractMtlxRefs(text), true);
        else if (ext === 'gltf') await follow(extractGltfJsonRefs(text), true);
        else if (ext === 'obj') await follow(extractObjMtllibRefs(text), true);
        else if (ext === 'mtl') await follow(extractMtlTextureRefs(text), true);
        else if (ext === 'pbrt') await follow(extractPbrtRefs(text), false);
        else if (text.startsWith('#usda')) await follow(extractAssetRefs(text), true);
    }

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

    // Absolute path for a set-relative path of the last snapshot, or null.
    relToAbs(rel) {
        const synthetic = syntheticToAbs(rel);
        if (synthetic !== undefined) return synthetic;
        return path.resolve(this.base, rel);
    }

    // Looks up files a loaded scene reported missing ({ asset, introducedBy },
    // introducedBy a set-relative path). Absolute refs resolve as they are;
    // relative ones against the introducing file's folder, the set base, then
    // the root's folder. At most maxRounds rounds; returns { round, limited,
    // tried, added: [entry], stillMissing: [asset] }.
    async resolveMissing(entries) {
        const none = { round: this.rounds, limited: false, tried: 0, added: [], stillMissing: [] };
        if (this.rounds >= this.maxRounds) return Object.assign(none, { limited: true });
        const before = new Set(this.files.keys());
        const fresh = [];
        for (const entry of (Array.isArray(entries) ? entries : []).slice(0, MAX_MISSING_PER_REQUEST)) {
            const asset = cleanAssetPath(entry && entry.asset);
            if (!asset || asset.length > 4096) continue;
            const by = normalizeSetPath(entry && entry.introducedBy);
            const key = asset + '|' + by;
            if (this.tried.has(key)) continue;
            this.tried.add(key);
            fresh.push({ asset, by });
        }
        if (!fresh.length) return none;
        this.rounds++;
        const stillMissing = [];
        const rootDir = path.dirname(this.rootPath);
        await mapLimit(fresh, RESOLVE_CONCURRENCY, async ({ asset, by }) => {
            this.checkCancelled();
            // An absolute path anchored under a layer folder by the USD
            // runtime ("scene/L:/tex/a.png") is still that absolute path.
            const embedded = /(?:^|\/)([a-zA-Z]:\/.*)$/.exec(asset);
            let ref = embedded ? embedded[1] : asset;
            const dirs = [];
            if (isAbsoluteFsRef(ref) || /^file:/i.test(ref)) {
                dirs.push(rootDir);
            } else {
                const synthetic = syntheticToAbs(normalizeSetPath(ref));
                if (synthetic) { ref = synthetic; dirs.push(rootDir); } else {
                    // A leading slash is the root of the renderer's file set.
                    const rooted = ref.startsWith('/');
                    ref = ref.replace(/^\/+/, '');
                    if (!rooted && by) {
                        const byAbs = this.relToAbs(by);
                        if (byAbs) dirs.push(path.dirname(byAbs));
                    }
                    dirs.push(this.base);
                    if (!rooted) dirs.push(rootDir);
                }
            }
            for (const dir of Array.from(new Set(dirs))) {
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
        const rootVolume = volumeOf(this.rootPath);
        const local = all.filter((f) => volumeOf(f.abs) === rootVolume);
        const inside = (abs, dir) => {
            const rel = path.relative(dir, abs);
            return !rel.startsWith('..') && !path.isAbsolute(rel);
        };
        let base = path.dirname(this.rootPath);
        for (const f of local) {
            while (!inside(f.abs, base) && path.dirname(base) !== base) base = path.dirname(base);
        }
        this.base = base;
        const relOf = (f) => (volumeOf(f.abs) === rootVolume
            ? path.relative(this.base, f.abs).split(path.sep).join('/')
            : syntheticRel(f.abs));
        const warnings = [];
        for (const msg of this.skipped.slice(0, SKIP_WARNING_LIMIT)) warnings.push(msg);
        if (this.skipped.length > SKIP_WARNING_LIMIT) warnings.push((this.skipped.length - SKIP_WARNING_LIMIT) + ' more reference(s) skipped.');
        if (this.dropped.files) warnings.push('The scene file limit (' + MAX_FILES + ' files) was reached; ' + this.dropped.files + ' more file(s) were not loaded.');
        if (this.dropped.bytes) warnings.push('The scene size limit (4 GiB) was reached; ' + this.dropped.bytes + ' more file(s) were not loaded.');
        const files = all.map((f) => ({ rel: relOf(f), abs: forwardAbs(f.abs), size: f.size, mtime: f.mtime, id: f.id }))
            .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
        return { base: this.base, root: relOf(this.root), files, totalBytes: this.totalBytes, warnings };
    }
}

// ---------------------------------------------------------------------
// Sessions served through the app: protocol. Lookup is by exact token and
// id only; request paths are never joined onto the filesystem.
const sessions = new Map();

function createSession(rootPath, options) {
    const session = new SceneFileSession(rootPath, options);
    sessions.set(session.token, session);
    return session;
}

function disposeSession(session) {
    if (!session) return;
    session.disposed = true;
    sessions.delete(session.token);
}

// URL path of one file: /__scene/<token>/<id>/<name>. The name is cosmetic.
function filePathFor(session, file) {
    return '/__scene/' + session.token + '/' + file.id + '/' + encodeURIComponent(path.basename(file.abs));
}

// Response for an app:// request under /__scene/, or null for other paths.
async function handleSceneRequest(pathname, isHead) {
    if (!pathname.startsWith('/__scene/')) return null;
    const m = /^\/__scene\/([0-9a-f]{32})\/(f[0-9]{1,9})(?:\/[^/]*)?$/.exec(pathname);
    const notFound = () => new Response(isHead ? null : 'Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    if (!m) return notFound();
    const session = sessions.get(m[1]);
    const entry = session && !session.disposed ? session.byId.get(m[2]) : null;
    if (!entry) return notFound();
    let handle;
    try {
        handle = await fs.promises.open(entry.abs, 'r');
        const stat = await handle.stat();
        const headers = { 'content-type': 'application/octet-stream', 'content-length': String(stat.size), 'cache-control': 'no-store' };
        if (isHead) { await handle.close(); return new Response(null, { status: 200, headers }); }
        const stream = handle.createReadStream({ autoClose: true });
        return new Response(Readable.toWeb(stream), { status: 200, headers });
    } catch (e) {
        if (handle) handle.close().catch(() => {});
        return notFound();
    }
}

module.exports = {
    createSession, disposeSession, filePathFor, handleSceneRequest, isSceneRootPath,
    extractAssetRefs, extractMtlxRefs, extractGltfJsonRefs, extractGlbRefs, extractObjMtllibRefs,
    extractMtlTextureRefs, extractPbrtRefs, crateTokenRefs, readCrateTokens, cleanAssetPath,
    normalizeSetPath, refToPath, isAbsoluteFsRef, syntheticRel, syntheticToAbs, tileNameRegex,
    SCENE_ROOT_EXTS, SCENE_FILE_EXTS, MAX_FILES, MAX_TOTAL_BYTES, MAX_MISSING_PER_REQUEST, MAX_MISSING_ROUNDS,
    _sessionCount: () => sessions.size,
};
