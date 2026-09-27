// docScanner.js — Node-side (extension host) port of the site's document
// crawler: given a .mtlx document's text and its on-disk location, walks
// <xi:include href="..."> siblings (breadth-first, capped) and extracts
// <input type="filename" value="..."> texture references (fileprefix-
// aware, per js/graph-app.jsx's extractFilenameRefs), reading everything
// through vscode.workspace.fs so it also works for files outside any
// open workspace folder and for virtual filesystems.
//
// Mirrors (but does not import — the site's code is browser/regex-based
// and has no Node entry point) two pieces of js/graph-app.jsx and
// js/mtlx-engine.js:
//   - js/mtlx-engine.js resolveIncludes() (~line 535): the xi:include
//     href regex, and the map-key composition for included docs
//     (fromDir + '/' + href, where fromDir is the INCLUDING doc's own
//     map-key directory — NOT the href's own path segments; see
//     resolveIncludes's recursive call at ~line 557, which derives the
//     next fromDir from the resolved hit.key, not from the href).
//   - js/graph-app.jsx extractFilenameRefs() + the loadPreset() BFS
//     (~lines 1650-1748): fileprefix-aware filename-ref extraction
//     (<materialx fileprefix> + per-<nodegraph fileprefix> scoping) and
//     the flat "map[ref] = blob" keying loadPreset uses for textures —
//     no directory prefix, since the fileprefix value already encodes
//     whatever traversal the document's author intended.
//
// Containment: every ref is resolved through refPolicy.js and confined to
// a root (the workspace folder holding the document, or its own folder)
// before anything is stat'd (and, for includes, read). See
// resolveContained() below.
//
// Textures are never read here: editorProvider.js hands the webview a
// resource URL for each one instead, so the webview fetches the bytes
// itself. Every containment step still runs (unsafe ref, extension
// allowlist, join, root containment, realpath, stat regular file); only
// the readFile call is skipped.
//
// Returned shape: { files: { [relPath: string]: Uint8Array }, textures:
// { [ref: string]: { uri, size, mtime } }, warnings: string[] }. `files`
// holds xi:include'd documents only. Neither map contains an entry for
// the root document itself: callers already have that text (it's the
// open document).
'use strict';

const fs = require('fs');
const refPolicy = require('./refPolicy');
const { errMsg } = require('./util');

const MAX_DOCS = 12; // guard only, matches loadPreset's MAX_DOCS — xi:include chains in practice nest at most one deep
const MAX_BYTES = 64 * 1024 * 1024; // total payload cap across all included documents (textures are never read here, so they are not counted)
const MAX_INCLUDE_BYTES = 8 * 1024 * 1024; // per-file cap for a single xi:include'd document
const MAX_TEXTURE_BYTES = 2 * 1024 * 1024 * 1024; // per-file cap for a single texture: a Blob/ArrayBuffer ceiling in the renderer, not a network budget
const MAX_TEXTURE_REFS = 256; // distinct texture refs considered per scan
const SKIP_WARNING_LIMIT = 5; // collapse long runs of skip warnings into one summary line

// vscode is required lazily, only when a real scan runs, so this file
// stays requireable and testable outside the extension host, like
// refPolicy.js and util.js.
function defaultDeps() {
    const vscode = require('vscode');
    return {
        fs: vscode.workspace.fs,
        Uri: vscode.Uri,
        FileType: vscode.FileType,
        getWorkspaceFolder: (uri) => vscode.workspace.getWorkspaceFolder(uri),
        realpath: fs.promises.realpath,
        readHead,
    };
}

// First `length` bytes of a local file (usdFileSet.js tells a binary .usd
// crate from a text layer without reading it in full). null for other schemes.
async function readHead(uri, length) {
    if (!uri || uri.scheme !== 'file') return null;
    const handle = await fs.promises.open(uri.fsPath, 'r');
    try {
        const buf = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buf, 0, length, 0);
        return buf.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}

// Mirrors js/mtlx-engine.js's normPath: authored fileprefix/filename values
// can use Windows-style backslashes, which vscode.Uri.joinPath does NOT
// treat as path separators (it treats the whole ref as one literal POSIX
// segment) — normalize before ever building a Uri from a ref/href.
function normSep(p) {
    return p.replace(/\\/g, '/');
}

// Double-quote-only `name="value"` attribute extraction, shared by the
// three fileprefix/value lookups in extractFilenameRefs below. MUST stay
// double-quote-only — a deliberate mirror of js/graph-app.jsx's own
// extractFilenameRefs (see this file's banner), which never bothers with
// single-quoted attributes for these particular fields. Returns the
// captured value, or null if `tag` has no such (double-quoted) attribute.
function attrDq(tag, name) {
    const m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"').exec(tag);
    return m ? m[1] : null;
}

// href may not be the first attribute and may be single- or double-quoted,
// the same tolerant regex as js/mtlx-engine.js resolveIncludes/loadPreset.
// 'd' adds per-group match indices (m.indices), used by the Files view to
// locate the exact href span for a "Replace..." edit.
const XI_INCLUDE_RE = /<xi:include\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*?\/?>(?:\s*<\/xi:include>)?/gd;

// Same double-quoted attribute lookup as attrDq, but also returns the
// captured value's absolute offset span (start/end, exclusive of quotes)
// within `tag` plus `tagOffset` -- used to build the Files view's precise
// "Replace..." edit range. Returns null when the attribute isn't present.
function attrDqRange(tag, name, tagOffset) {
    const re = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"', 'd');
    const m = re.exec(tag);
    if (!m) return null;
    const [start, end] = m.indices[1];
    return { value: m[1], start: tagOffset + start, end: tagOffset + end };
}

// Port of js/graph-app.jsx's extractFilenameRefs (~line 1650): splits the
// doc into "scopes" (each <nodegraph>'s body, plus everything outside any
// nodegraph), each carrying its own accumulated fileprefix (root
// <materialx fileprefix> + that nodegraph's own fileprefix, per
// MaterialX's inheritable-attribute semantics), then two-pass scans each
// scope's <input type="filename" value="..."> tags. Returns
// [{ref, start, end}], `ref` already fileprefix-resolved, `start`/`end`
// the absolute offset span of the raw (unprefixed) value text in `xml`.
function extractFilenameRefsCore(xml) {
    const rootAttrs = (/<materialx\b([^>]*)>/.exec(xml) || [])[1] || '';
    const rootPrefix = attrDq(rootAttrs, 'fileprefix') || '';
    const scopes = [];
    let cursor = 0;
    const NG = /<nodegraph\b([^>]*)>([\s\S]*?)<\/nodegraph>/g;
    let ngm;
    while ((ngm = NG.exec(xml)) !== null) {
        scopes.push({ text: xml.slice(cursor, ngm.index), prefix: rootPrefix, start: cursor });
        const ngPrefix = attrDq(ngm[1], 'fileprefix') || '';
        const bodyStart = ngm.index + ngm[0].length - ngm[2].length - '</nodegraph>'.length;
        scopes.push({ text: ngm[2], prefix: rootPrefix + ngPrefix, start: bodyStart });
        cursor = ngm.index + ngm[0].length;
    }
    scopes.push({ text: xml.slice(cursor), prefix: rootPrefix, start: cursor });
    const refs = [];
    for (const scope of scopes) {
        const re = /<input\b[^>]*>/g;
        let m;
        while ((m = re.exec(scope.text)) !== null) {
            const tag = m[0];
            if (!/\btype\s*=\s*"filename"/.test(tag)) continue;
            const range = attrDqRange(tag, 'value', scope.start + m.index);
            if (!range || !range.value) continue;
            refs.push({ ref: scope.prefix + range.value, start: range.start, end: range.end });
        }
    }
    return refs;
}

function extractFilenameRefs(xml) {
    return extractFilenameRefsCore(xml).map((r) => r.ref);
}

// 0-based line number of `offset` within `text` (a plain scan: Files-view
// ref lists are small, this never runs on a per-keystroke hot path).
function lineOfOffset(text, offset) {
    let line = 0;
    for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
    return line;
}

// Short human text for a resolveContained skip reason, used by the Files
// view's ref rows (describeSkip's own sentences already name the ref and
// end with a period; this is just the tail, reused for a `reason` field).
function refSkipText(reason) {
    switch (reason) {
        case 'not-found': return 'The referenced file was not found.';
        case 'outside': return 'It resolves outside the workspace folder.';
        case 'extension': return 'Its file type is not allowed here.';
        case 'unsafe': return 'It is not a safe relative reference.';
        case 'symlink': return 'It is a symbolic link that cannot be verified here.';
        case 'not-regular-file': return 'It is not a regular file.';
        case 'too-large': return 'It exceeds the per-file size limit.';
        case 'budget': return 'The total payload cap for included documents was reached.';
        default: return 'Could not resolve the reference.';
    }
}

// found / missing (not-found) / skipped (everything else: outside the
// workspace, disallowed extension, symlink, etc.) -- the three states the
// Files view shows.
function refStatusFor(reason) {
    if (reason === 'not-found') return 'missing';
    return 'skipped';
}

// Resolves ref against baseDirUri and confines it to ctx.root (unsafe ref,
// extension, join, containment, realpath, stat, then byte caps, in order).
// Returns { uri, size, mtime } or { skip: reason }; see describeSkip() for
// text. The total-bytes budget only applies to 'include' refs: textures
// are never read, so nothing accumulates a running total for them.
async function resolveContained(deps, ctx, baseDirUri, ref, kind) {
    if (refPolicy.isUnsafeRef(ref)) return { skip: 'unsafe' };
    if (!refPolicy.isAllowedRef(ref, kind)) return { skip: 'extension' };

    let uri;
    try {
        uri = deps.Uri.joinPath(baseDirUri, ref);
    } catch (e) {
        return { skip: 'join', detail: errMsg(e) };
    }

    if (uri.scheme !== ctx.root.scheme || uri.authority !== ctx.root.authority) {
        return { skip: 'outside' };
    }
    const caseInsensitive = ctx.isFileScheme && process.platform === 'win32';
    if (!refPolicy.isPathInside(uri.path, ctx.root.path, caseInsensitive)) {
        return { skip: 'outside' };
    }

    // file: scheme only: realpath survives symlinks; ENOENT means not found.
    if (ctx.isFileScheme) {
        let real;
        try {
            real = await deps.realpath(uri.fsPath);
        } catch (e) {
            if (e && e.code === 'ENOENT') return { skip: 'not-found' };
            return { skip: 'join', detail: errMsg(e) };
        }
        if (ctx.rootRealpath) {
            const realNorm = real.replace(/\\/g, '/');
            if (!refPolicy.isPathInside(realNorm, ctx.rootRealpath, caseInsensitive)) {
                return { skip: 'outside' };
            }
        }
    }

    let stat;
    try {
        stat = await deps.fs.stat(uri);
    } catch (e) {
        return { skip: 'not-found' };
    }

    // Non-file schemes cannot be realpath-verified, so reject symlinks outright.
    if (!ctx.isFileScheme && (stat.type & deps.FileType.SymbolicLink)) {
        return { skip: 'symlink' };
    }
    if (!(stat.type & deps.FileType.File)) {
        return { skip: 'not-regular-file' };
    }

    const perFileCap = kind === 'include' ? MAX_INCLUDE_BYTES : MAX_TEXTURE_BYTES;
    if (stat.size > perFileCap) return { skip: 'too-large' };
    if (kind === 'include' && ctx.totalBytes + stat.size > MAX_BYTES) return { skip: 'budget' };

    return { uri, size: stat.size, mtime: stat.mtime };
}

// One line per skip reason, shaped `Skipped "<ref>": <why>.` The 'outside'
// wording is required verbatim: it is the one users hit most often, an
// in-workspace-looking ref that actually resolves elsewhere.
function describeSkip(ref, reason, detail) {
    switch (reason) {
        case 'unsafe':
            return 'Skipped "' + ref + '": it is not a safe relative reference.';
        case 'extension':
            return 'Skipped "' + ref + '": its file type is not allowed here.';
        case 'outside':
            return 'Skipped "' + ref + '": it resolves outside the workspace folder (open the folder that contains it to allow it).';
        case 'not-found':
            return 'Skipped "' + ref + '": the referenced file was not found.';
        case 'not-regular-file':
            return 'Skipped "' + ref + '": it is not a regular file.';
        case 'symlink':
            return 'Skipped "' + ref + '": it is a symbolic link that cannot be safely verified here.';
        case 'too-large':
            return 'Skipped "' + ref + '": it exceeds the per-file size limit.';
        case 'budget':
            return 'Skipped "' + ref + '": the total payload cap for included documents (64MB) was reached.';
        default:
            return 'Skipped "' + ref + '": could not resolve it' + (detail ? ' (' + detail + ')' : '') + '.';
    }
}

// Collapses a long run of skip warnings into the first few plus one
// "N more references skipped" summary line, so a document with many bad
// refs doesn't flood the warnings array/Output channel one line each.
function flushSkipWarnings(warnings, skipped) {
    if (!skipped.length) return;
    const shown = skipped.slice(0, SKIP_WARNING_LIMIT);
    for (const msg of shown) warnings.push(msg);
    const extra = skipped.length - shown.length;
    if (extra > 0) warnings.push(extra + ' more reference(s) skipped.');
}

// Containment root for documentUri: the workspace folder holding it, else
// its own directory (loose file, no workspace folder). A non-file-scheme
// document with no workspace folder has nothing safe to resolve refs
// against, so this returns null in that case: the one situation _scanWith
// bails out of scanning entirely. Shared with editorProvider.js (see
// containmentRoot() below), which needs the same root to size a webview's
// localResourceRoots.
function _containmentRootWith(deps, documentUri) {
    const folder = deps.getWorkspaceFolder(documentUri);
    if (folder) return folder.uri;
    if (documentUri.scheme !== 'file') return null;
    return deps.Uri.joinPath(documentUri, '..');
}

// Scan a .mtlx document (already-read text) plus everything it pulls in
// via xi:include, for xi:include siblings and filename (texture) refs.
// documentUri: the vscode.Uri of the currently-open .mtlx file (used only
// to resolve relative refs against its real directory — its own
// text/bytes are NOT added to the returned `files` map; the caller
// already has that text as the message's top-level `xml`).
async function _scanWith(deps, documentUri, xmlText) {
    const warnings = [];
    const skipped = [];
    const files = {};
    const textures = {};

    const rootDir = deps.Uri.joinPath(documentUri, '..');
    const root = _containmentRootWith(deps, documentUri);
    if (!root) {
        return {
            files: {},
            textures: {},
            refs: [],
            warnings: ['Reference scanning skipped: this document is not backed by a file in an open workspace folder.']
        };
    }

    const isFileScheme = root.scheme === 'file';
    let rootRealpath = null;
    if (isFileScheme) {
        try {
            rootRealpath = (await deps.realpath(root.fsPath)).replace(/\\/g, '/');
        } catch (e) {
            // Root itself unreadable: fall back to the path-based
            // containment check above, already done via isPathInside.
            rootRealpath = null;
        }
    }

    const ctx = { root, rootRealpath, isFileScheme, totalBytes: Buffer.byteLength(xmlText, 'utf8') };

    const visitedDocs = new Set([documentUri.toString()]);
    const seenTextureRefs = new Set();
    let textureRefLimitHit = false;

    // BFS queue over xi:include'd docs. Each entry, once its text is
    // fetched, contributes further include/texture refs of its own.
    // mapKey is this doc's OWN key in `files` (null for the root, which
    // isn't stored there); mapDir is the directory PORTION of mapKey (or
    // '' for the root) — composed the same way
    // js/mtlx-engine.js:resolveIncludes composes fromDir for its
    // recursive call: dirname of the INCLUDING doc's map key, not the
    // href's own path segments.
    const queue = [{ uri: documentUri, dirUri: rootDir, mapDir: '', mapKey: null, xml: xmlText }];
    const textureFetches = [];
    // Files view rows: only the ROOT document's own refs (its own
    // xi:includes and filename inputs), not ones belonging to a doc it
    // pulls in via xi:include -- those have no meaningful line/range in
    // the ACTIVE document's own text editor.
    const rootRefs = [];

    while (queue.length) {
        const item = queue.shift();
        const isRoot = item.mapKey === null;
        let xml = item.xml;

        if (xml === undefined) {
            const bytes = await readContained(deps, item.uri, item.mapKey, skipped, ctx);
            if (bytes === null) continue;
            files[item.mapKey] = bytes;
            xml = Buffer.from(bytes).toString('utf8');
        }

        // (a) xi:include siblings, resolved against THIS doc's real
        // directory; keyed by mapDir + '/' + href (fromDir + '/' + href,
        // mirroring resolveIncludes).
        XI_INCLUDE_RE.lastIndex = 0;
        let m;
        while ((m = XI_INCLUDE_RE.exec(xml)) !== null) {
            const grp = m[1] !== undefined ? 1 : 2;
            const href = normSep(m[grp]);
            const resolved = await resolveContained(deps, ctx, item.dirUri, href, 'include');
            if (isRoot) {
                const [hStart, hEnd] = m.indices[grp];
                rootRefs.push({
                    value: href,
                    start: hStart,
                    end: hEnd,
                    status: resolved.skip ? refStatusFor(resolved.skip) : 'found',
                    reason: resolved.skip ? refSkipText(resolved.skip) : null,
                    uri: resolved.skip ? undefined : resolved.uri,
                });
            }
            if (resolved.skip) {
                skipped.push(describeSkip(href, resolved.skip, resolved.detail));
                continue;
            }
            const visitKey = resolved.uri.toString();
            if (visitedDocs.has(visitKey)) continue;
            if (visitedDocs.size >= MAX_DOCS) {
                skipped.push('Skipped "' + href + '": the include limit (' + MAX_DOCS + ' documents) was reached.');
                continue;
            }
            visitedDocs.add(visitKey);
            const mapKey = item.mapDir ? item.mapDir + '/' + href : href;
            const mapDir = mapKey.lastIndexOf('/') >= 0 ? mapKey.slice(0, mapKey.lastIndexOf('/')) : '';
            queue.push({
                uri: resolved.uri,
                dirUri: deps.Uri.joinPath(resolved.uri, '..'),
                mapDir,
                mapKey,
                xml: undefined,
            });
        }

        // (b) filename refs, fileprefix-resolved within THIS doc, fetched
        // relative to THIS doc's real directory — best-effort, doesn't
        // block the include BFS. Keyed flat by the ref string itself
        // (fileprefix + authored value), exactly like loadPreset's
        // `map[ref] = blob` — no directory prefix, since the fileprefix
        // already encodes whatever traversal the author intended.
        for (const { ref: rawRef, start, end } of extractFilenameRefsCore(xml)) {
            const ref = normSep(rawRef);
            if (seenTextureRefs.has(ref)) {
                continue;
            }
            if (seenTextureRefs.size >= MAX_TEXTURE_REFS) {
                textureRefLimitHit = true;
                continue;
            }
            seenTextureRefs.add(ref);
            textureFetches.push({ dirUri: item.dirUri, ref, isRoot, start, end });
        }
    }
    if (textureRefLimitHit) {
        skipped.push('The texture reference limit (' + MAX_TEXTURE_REFS + ') was reached; further references were skipped.');
    }

    for (const { dirUri, ref, isRoot, start, end } of textureFetches) {
        const resolved = await resolveContained(deps, ctx, dirUri, ref, 'texture');
        if (isRoot) {
            rootRefs.push({
                value: ref,
                start,
                end,
                status: resolved.skip ? refStatusFor(resolved.skip) : 'found',
                reason: resolved.skip ? refSkipText(resolved.skip) : null,
                uri: resolved.skip ? undefined : resolved.uri,
            });
        }
        if (resolved.skip) {
            skipped.push(describeSkip(ref, resolved.skip, resolved.detail));
            continue;
        }
        // Never read here: editorProvider.js turns this into a webview
        // resource URL and the webview fetches the bytes itself.
        textures[ref] = { uri: resolved.uri, size: resolved.size, mtime: resolved.mtime };
    }

    flushSkipWarnings(warnings, skipped);
    const refs = rootRefs
        .sort((a, b) => a.start - b.start)
        .map((r) => ({
            value: r.value, status: r.status, reason: r.reason, uri: r.uri,
            line: lineOfOffset(xmlText, r.start), offset: r.start, endOffset: r.end,
        }));
    return { files, textures, warnings, refs };
}

// Reads an already contained/stat'd uri, then re-checks the real byte
// count against the running total (a file can grow between stat and
// read). Over budget here skips this one file and continues the scan.
// Used for xi:include'd documents only: textures are never read.
async function readContained(deps, uri, label, skipped, ctx) {
    try {
        const bytes = await deps.fs.readFile(uri);
        if (ctx.totalBytes + bytes.byteLength > MAX_BYTES) {
            skipped.push('Skipped "' + label + '": the total payload cap for included documents (64MB) was reached after reading it.');
            return null;
        }
        ctx.totalBytes += bytes.byteLength;
        return bytes;
    } catch (e) {
        skipped.push('Skipped "' + label + '": could not read it (' + errMsg(e) + ').');
        return null;
    }
}

async function scan(documentUri, xmlText) {
    return _scanWith(defaultDeps(), documentUri, xmlText);
}

// Public containment-root helper for editorProvider.js: the same root
// _scanWith resolves refs against, for a real vscode document. Returns
// null exactly when _scanWith would skip scanning entirely (untitled /
// non-file document with no open workspace folder).
function containmentRoot(documentUri) {
    return _containmentRootWith(defaultDeps(), documentUri);
}

module.exports = {
    scan,
    _scanWith,
    extractFilenameRefs,
    extractFilenameRefsCore,
    isUnsafeRef: refPolicy.isUnsafeRef,
    containmentRoot,
    _containmentRootWith,
    // Shared with usdFileSet.js so USD scene files are confined identically.
    resolveContained,
    describeSkip,
    defaultDeps,
};
