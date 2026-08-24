// doc-scanner.js: Node port of vscode_extension/src/docScanner.js for
// Electron's main process. Only the filesystem layer changes (node:fs
// instead of vscode.workspace.fs); ref-extraction logic is unchanged.
'use strict';

const path = require('node:path');
const fs = require('node:fs/promises');

function errMsg(e) {
    return e && e.message ? e.message : String(e);
}

const MAX_DOCS = 12; // guard only, matches loadPreset's MAX_DOCS (xi:include chains in practice nest at most one deep)
const MAX_BYTES = 64 * 1024 * 1024; // total payload cap across all included docs + textures

// href may not be the first attribute and may be single- or double-quoted,
// same tolerant regex as js/mtlx-engine.js resolveIncludes/loadPreset.
const XI_INCLUDE_RE = /<xi:include\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*?\/?>(?:\s*<\/xi:include>)?/g;

// Mirrors js/mtlx-engine.js's normPath: authored fileprefix/filename values
// can use Windows-style backslashes, which path.resolve would otherwise
// treat as a literal segment on POSIX, so normalize before resolving.
function normSep(p) {
    return p.replace(/\\/g, '/');
}

// Skip refs that would escape the document tree via a URI scheme or an
// OS-absolute path (POSIX/UNC or Windows drive-absolute). Port of
// loadPreset's isSchemeOrRootedRef, generalized to plain filesystem refs.
function isUnsafeRef(ref) {
    if (!ref) return true;
    if (/^[a-z][a-z0-9+.\-]*:\/\//i.test(ref)) return true; // scheme://
    if (ref.startsWith('/') || ref.startsWith('\\')) return true; // POSIX/UNC-rooted
    if (/^[A-Za-z]:[\\/]/.test(ref)) return true; // Windows drive-absolute
    return false;
}

// Double-quote-only `name="value"` attribute extraction, shared by the
// fileprefix/value lookups below. Returns the captured value, or null
// if `tag` has no such (double-quoted) attribute.
function attrDq(tag, name) {
    const m = new RegExp('\\b' + name + '\\s*=\\s*"([^"]*)"').exec(tag);
    return m ? m[1] : null;
}

// Port of js/graph-app.jsx's extractFilenameRefs: splits the doc into
// per-nodegraph "scopes" (each with its own accumulated fileprefix), then
// scans each scope's <input type="filename" value="..."> tags.
function extractFilenameRefs(xml) {
    const rootAttrs = (/<materialx\b([^>]*)>/.exec(xml) || [])[1] || '';
    const rootPrefix = attrDq(rootAttrs, 'fileprefix') || '';
    const scopes = [];
    let cursor = 0;
    const NG = /<nodegraph\b([^>]*)>([\s\S]*?)<\/nodegraph>/g;
    let ngm;
    while ((ngm = NG.exec(xml)) !== null) {
        scopes.push({ text: xml.slice(cursor, ngm.index), prefix: rootPrefix });
        const ngPrefix = attrDq(ngm[1], 'fileprefix') || '';
        scopes.push({ text: ngm[2], prefix: rootPrefix + ngPrefix });
        cursor = ngm.index + ngm[0].length;
    }
    scopes.push({ text: xml.slice(cursor), prefix: rootPrefix });
    const refs = [];
    for (const scope of scopes) {
        const tags = scope.text.match(/<input\b[^>]*>/g) || [];
        for (const tag of tags) {
            if (!/\btype\s*=\s*"filename"/.test(tag)) continue;
            const raw = attrDq(tag, 'value');
            if (!raw) continue;
            refs.push(scope.prefix + raw);
        }
    }
    return refs;
}

// Scan a .mtlx document (already-read text) plus everything it pulls in
// via xi:include, for xi:include siblings and filename (texture) refs.
// documentPath resolves relative refs; its own bytes are not added to `files`.
async function scan(documentPath, xmlText) {
    const warnings = [];
    const files = {};
    let totalBytes = Buffer.byteLength(xmlText, 'utf8');
    let capped = false;

    const rootDir = path.dirname(documentPath);
    const visitedDocs = new Set([documentPath]);
    const seenTextureRefs = new Set();

    // BFS queue over xi:include'd docs. mapKey is this doc's own key in
    // `files` (null for the root); mapDir is composed the same way
    // js/mtlx-engine.js:resolveIncludes composes fromDir for its recursive call.
    const queue = [{ filePath: documentPath, dirPath: rootDir, mapDir: '', mapKey: null, xml: xmlText }];
    const textureFetches = [];

    while (queue.length) {
        const item = queue.shift();
        let xml = item.xml;

        if (xml === undefined) {
            if (totalBytes > MAX_BYTES) { capped = true; break; }
            try {
                const bytes = await fs.readFile(item.filePath);
                totalBytes += bytes.byteLength;
                if (totalBytes > MAX_BYTES) {
                    warnings.push('Payload cap (64MB) reached, stopped before reading included document "' + item.mapKey + '".');
                    capped = true;
                    break;
                }
                files[item.mapKey] = bytes;
                xml = Buffer.from(bytes).toString('utf8');
            } catch (e) {
                warnings.push('Could not read included document "' + item.mapKey + '": ' + errMsg(e));
                continue;
            }
        }

        // (a) xi:include siblings, resolved against THIS doc's real
        // directory; keyed by mapDir + '/' + href (fromDir + '/' + href,
        // mirroring resolveIncludes).
        XI_INCLUDE_RE.lastIndex = 0;
        let m;
        while ((m = XI_INCLUDE_RE.exec(xml)) !== null) {
            const href = normSep(m[1] || m[2]);
            if (isUnsafeRef(href)) {
                warnings.push('Skipped unsafe xi:include href: ' + href);
                continue;
            }
            if (visitedDocs.size >= MAX_DOCS) {
                warnings.push('Include limit reached (' + MAX_DOCS + ' docs), skipped xi:include href: ' + href);
                continue;
            }
            let incPath;
            try {
                incPath = path.resolve(item.dirPath, href);
            } catch (e) {
                warnings.push('Could not resolve xi:include href "' + href + '": ' + errMsg(e));
                continue;
            }
            const visitKey = incPath;
            if (visitedDocs.has(visitKey)) continue;
            visitedDocs.add(visitKey);
            const mapKey = item.mapDir ? item.mapDir + '/' + href : href;
            const mapDir = mapKey.lastIndexOf('/') >= 0 ? mapKey.slice(0, mapKey.lastIndexOf('/')) : '';
            queue.push({
                filePath: incPath,
                dirPath: path.dirname(incPath),
                mapDir,
                mapKey,
                xml: undefined,
            });
        }

        // (b) filename refs, fileprefix-resolved within THIS doc, best-effort
        // (doesn't block the include BFS). Keyed flat by the ref string
        // itself, exactly like loadPreset's `map[ref] = blob`.
        for (const rawRef of extractFilenameRefs(xml)) {
            const ref = normSep(rawRef);
            if (isUnsafeRef(ref) || seenTextureRefs.has(ref)) continue;
            seenTextureRefs.add(ref);
            textureFetches.push({ dirPath: item.dirPath, ref });
        }
    }

    if (!capped) {
        for (const { dirPath, ref } of textureFetches) {
            if (totalBytes > MAX_BYTES) {
                warnings.push('Payload cap (64MB) reached, stopped before reading texture "' + ref + '".');
                break;
            }
            let refPath;
            try {
                refPath = path.resolve(dirPath, ref);
            } catch (e) {
                warnings.push('Could not resolve texture ref "' + ref + '": ' + errMsg(e));
                continue;
            }
            try {
                const bytes = await fs.readFile(refPath);
                totalBytes += bytes.byteLength;
                if (totalBytes > MAX_BYTES) {
                    warnings.push('Payload cap (64MB) reached, dropped texture "' + ref + '" after reading it.');
                    break;
                }
                files[ref] = bytes;
            } catch (e) {
                warnings.push('Could not read texture "' + ref + '" (falls back to the checker in the viewer): ' + errMsg(e));
            }
        }
    }

    return { files, warnings };
}

module.exports = { scan, extractFilenameRefs, isUnsafeRef };
