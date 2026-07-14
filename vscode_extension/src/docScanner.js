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
// Returned shape: { files: { [relPath: string]: Uint8Array }, warnings:
// string[] }. `files` never contains an entry for the root document
// itself — callers already have that text (it's the open document).
'use strict';

const vscode = require('vscode');

const MAX_DOCS = 12; // guard only, matches loadPreset's MAX_DOCS — xi:include chains in practice nest at most one deep
const MAX_BYTES = 64 * 1024 * 1024; // total payload cap across all included docs + textures

// href may not be the first attribute and may be single- or double-quoted
// — same tolerant regex as js/mtlx-engine.js resolveIncludes/loadPreset.
const XI_INCLUDE_RE = /<xi:include\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*?\/?>(?:\s*<\/xi:include>)?/g;

// Skip refs that would escape the document tree via a URI scheme or an
// OS-absolute path (POSIX/UNC or Windows drive-absolute) — a port of
// loadPreset's isSchemeOrRootedRef, generalized from "outside the
// preset's resources/ root" (a web concept scoped to a fixed base URL)
// to "not a relative reference" (the filesystem equivalent here: never
// resolve a ref that could walk outside the document's own tree via an
// absolute path).
function isUnsafeRef(ref) {
    if (!ref) return true;
    if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(ref)) return true; // scheme://
    if (ref.startsWith('/') || ref.startsWith('\\')) return true; // POSIX/UNC-rooted
    if (/^[A-Za-z]:[\\/]/.test(ref)) return true; // Windows drive-absolute
    return false;
}

// Port of js/graph-app.jsx's extractFilenameRefs (~line 1650): splits the
// doc into "scopes" (each <nodegraph>'s body, plus everything outside any
// nodegraph), each carrying its own accumulated fileprefix (root
// <materialx fileprefix> + that nodegraph's own fileprefix, per
// MaterialX's inheritable-attribute semantics), then two-pass scans each
// scope's <input type="filename" value="..."> tags.
function extractFilenameRefs(xml) {
    const rootAttrs = (/<materialx\b([^>]*)>/.exec(xml) || [])[1] || '';
    const rootPrefix = (/\bfileprefix\s*=\s*"([^"]*)"/.exec(rootAttrs) || [])[1] || '';
    const scopes = [];
    let cursor = 0;
    const NG = /<nodegraph\b([^>]*)>([\s\S]*?)<\/nodegraph>/g;
    let ngm;
    while ((ngm = NG.exec(xml)) !== null) {
        scopes.push({ text: xml.slice(cursor, ngm.index), prefix: rootPrefix });
        const ngPrefix = (/\bfileprefix\s*=\s*"([^"]*)"/.exec(ngm[1]) || [])[1] || '';
        scopes.push({ text: ngm[2], prefix: rootPrefix + ngPrefix });
        cursor = ngm.index + ngm[0].length;
    }
    scopes.push({ text: xml.slice(cursor), prefix: rootPrefix });
    const refs = [];
    for (const scope of scopes) {
        const tags = scope.text.match(/<input\b[^>]*>/g) || [];
        for (const tag of tags) {
            if (!/\btype\s*=\s*"filename"/.test(tag)) continue;
            const m = /\bvalue\s*=\s*"([^"]*)"/.exec(tag);
            const raw = m && m[1];
            if (!raw) continue;
            refs.push(scope.prefix + raw);
        }
    }
    return refs;
}

// Scan a .mtlx document (already-read text) plus everything it pulls in
// via xi:include, for xi:include siblings and filename (texture) refs.
// documentUri: the vscode.Uri of the currently-open .mtlx file (used only
// to resolve relative refs against its real directory — its own
// text/bytes are NOT added to the returned `files` map; the caller
// already has that text as the message's top-level `xml`).
async function scan(documentUri, xmlText) {
    const warnings = [];
    const files = {};
    let totalBytes = Buffer.byteLength(xmlText, 'utf8');
    let capped = false;

    const rootDir = vscode.Uri.joinPath(documentUri, '..');
    const visitedDocs = new Set([documentUri.toString()]);
    const seenTextureRefs = new Set();

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

    while (queue.length) {
        const item = queue.shift();
        let xml = item.xml;

        if (xml === undefined) {
            if (totalBytes > MAX_BYTES) { capped = true; break; }
            try {
                const bytes = await vscode.workspace.fs.readFile(item.uri);
                totalBytes += bytes.byteLength;
                if (totalBytes > MAX_BYTES) {
                    warnings.push('Payload cap (64MB) reached — stopped before reading included document "' + item.mapKey + '".');
                    capped = true;
                    break;
                }
                files[item.mapKey] = bytes;
                xml = Buffer.from(bytes).toString('utf8');
            } catch (e) {
                warnings.push('Could not read included document "' + item.mapKey + '": ' + (e && e.message ? e.message : String(e)));
                continue;
            }
        }

        // (a) xi:include siblings, resolved against THIS doc's real
        // directory; keyed by mapDir + '/' + href (fromDir + '/' + href,
        // mirroring resolveIncludes).
        XI_INCLUDE_RE.lastIndex = 0;
        let m;
        while ((m = XI_INCLUDE_RE.exec(xml)) !== null) {
            const href = m[1] || m[2];
            if (isUnsafeRef(href)) {
                warnings.push('Skipped unsafe xi:include href: ' + href);
                continue;
            }
            if (visitedDocs.size >= MAX_DOCS) {
                warnings.push('Include limit reached (' + MAX_DOCS + ' docs) — skipped xi:include href: ' + href);
                continue;
            }
            let incUri;
            try {
                incUri = vscode.Uri.joinPath(item.dirUri, href);
            } catch (e) {
                warnings.push('Could not resolve xi:include href "' + href + '": ' + (e && e.message ? e.message : String(e)));
                continue;
            }
            const visitKey = incUri.toString();
            if (visitedDocs.has(visitKey)) continue;
            visitedDocs.add(visitKey);
            const mapKey = item.mapDir ? item.mapDir + '/' + href : href;
            const mapDir = mapKey.lastIndexOf('/') >= 0 ? mapKey.slice(0, mapKey.lastIndexOf('/')) : '';
            queue.push({
                uri: incUri,
                dirUri: vscode.Uri.joinPath(incUri, '..'),
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
        for (const ref of extractFilenameRefs(xml)) {
            if (isUnsafeRef(ref) || seenTextureRefs.has(ref)) continue;
            seenTextureRefs.add(ref);
            textureFetches.push({ dirUri: item.dirUri, ref });
        }
    }

    if (!capped) {
        for (const { dirUri, ref } of textureFetches) {
            if (totalBytes > MAX_BYTES) {
                warnings.push('Payload cap (64MB) reached — stopped before reading texture "' + ref + '".');
                break;
            }
            let refUri;
            try {
                refUri = vscode.Uri.joinPath(dirUri, ref);
            } catch (e) {
                warnings.push('Could not resolve texture ref "' + ref + '": ' + (e && e.message ? e.message : String(e)));
                continue;
            }
            try {
                const bytes = await vscode.workspace.fs.readFile(refUri);
                totalBytes += bytes.byteLength;
                if (totalBytes > MAX_BYTES) {
                    warnings.push('Payload cap (64MB) reached — dropped texture "' + ref + '" after reading it.');
                    break;
                }
                files[ref] = bytes;
            } catch (e) {
                warnings.push('Could not read texture "' + ref + '" (falls back to the checker in the viewer): ' + (e && e.message ? e.message : String(e)));
            }
        }
    }

    return { files, warnings };
}

module.exports = { scan, extractFilenameRefs, isUnsafeRef };
