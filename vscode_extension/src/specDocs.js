// specDocs.js — headless (extension-host) extractor for per-node
// DESCRIPTIONS and PORT TABLES out of the three MaterialX specification
// markdown files (MaterialX.PBRSpec.md, MaterialX.NPRSpec.md,
// MaterialX.StandardNodes.md). Vendor-first, remote-fallback — mirrors
// js/mtlx-assets.js's local-vs-remote split (see readLocalSpecFile/
// fetchRemoteSpecFile below): a file present under
// vendor/materialx/documents/Specification/ (the offline build) is read
// locally and never touches the network; otherwise it's fetched once
// from raw.githubusercontent.com at SPEC_TAG and cached in memory for
// the rest of the extension host session. Pure Node: this module must
// NOT require('vscode') anywhere, so it stays independently loadable/
// testable with plain `node` — same rule validator.js/mtlxNode.js/
// docScanner.js already follow, for the same reason (hoverProvider.js is
// the only caller, and it's fine for THAT file to depend on vscode; this
// one stays free of it).
//
// This is a deliberately trimmed Node port of js/spec-parser.js's
// parseMdDocs() state machine (anchors -> `### \`name\`` headings ->
// following paragraph text -> Port-column tables -> cleanText/
// cleanCellValue markdown cleanup), NOT a require() of it —
// js/spec-parser.js is a browser global-scope IIFE that fetches the spec
// files over the network (raw.githubusercontent.com, via js/mtlx-assets.js's
// resolver) and joins them against live WASM nodedefs for the FULL doc
// database (description + notes + port tables + references); this module
// only ever wants the description paragraph(s) that appear directly after
// a node's heading, plus the Port-column table(s) that follow them
// (skipping "notes" prose AFTER those tables and footnote references).
// Where the two logics overlap (heading/anchor recognition, paragraph
// accumulation, table header/row parsing, cleanText/cleanCellValue's
// link/bold/italic/entity/sentinel cleanup) the logic here mirrors
// spec-parser.js line for line; see the deviations called out inline
// below.
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

// ---------------------------------------------------------------------
// Spec revision/link configuration — kept in lockstep with the constants
// of the same name in js/spec-parser.js so a spec_url produced here
// points at exactly the same GitHub blob/anchor the website would show
// for the same node. SPEC_TAG is also the single source of truth for the
// remote raw-content fetch below (RAW_BASE) — one tag constant, two
// consumers.
const REPO = 'AcademySoftwareFoundation/MaterialX';
const SPEC_TAG = 'v1.39.5';
const SPEC_DIR = 'documents/Specification/';
const BLOB_BASE = 'https://github.com/' + REPO + '/blob/' + SPEC_TAG + '/' + SPEC_DIR;

// Vendor-first source locations, mirroring js/mtlx-assets.js's LOCAL_ROOT/
// repoUrl split (see readLocalSpecFile/fetchRemoteSpecFile below for the
// actual local-vs-remote decision): the offline build populates
// vendor/materialx/ with a mirror of the upstream repo's own directory
// layout, so the local path is just repoRoot + LOCAL_ROOT + SPEC_DIR +
// <file> — no separate mapping table to keep in sync.
const LOCAL_ROOT = 'vendor/materialx/';
const RAW_BASE = 'https://raw.githubusercontent.com/' + REPO + '/' + SPEC_TAG + '/' + SPEC_DIR;

// Files to parse, in the order they're merged (see mergeFileText/
// ensureSourcesLoading below) — stdlib first since it's the largest/most
// commonly-hovered library, then the two extension libraries. Order only
// matters as a tie-break for which file's anchor "wins" when the SAME
// category name is documented in more than one spec file (e.g. `mix`/
// `add` each have a generic stdlib entry AND a PBR-specific BSDF-layering
// entry) — the description itself is the concatenation of every entry
// found across every file/duplicate heading (see the merge comment
// below), so no prose is lost either way, only the spec_url's target
// file/anchor.
const SPEC_FILES = ['MaterialX.StandardNodes.md', 'MaterialX.PBRSpec.md', 'MaterialX.NPRSpec.md'];

// ---------------------------------------------------------------------
// Text cleanup — trimmed port of js/spec-parser.js's cleanText (only the
// pieces description/cell prose actually needs: math-span protection,
// entity decoding, markdown link resolution, bold/italic/backtick
// stripping) plus cleanCellValue (spec sentinel mapping + surrounding-
// quote stripping for table cells, now that port tables are captured).
const MD_LINK_RE = /\[([^\]^][^\]]*)\]\(([^)]*)\)/g;
const BOLD_US_RE = /__([^_]+)__/g;
const BOLD_AST_RE = /\*\*([^*]+)\*\*/g;
const ITALIC_RE = /(?<![\w])_([^_\s][^_]*)_(?![\w])/g;
const MATH_RE = /\$\$[^$]+\$\$|\$[^$\n]+\$/g;

// html.unescape equivalent. spec-parser.js does this via a throwaway
// <textarea> (DOM RCDATA decoding); no DOM exists in the extension host,
// so this ports its own non-DOM fallback branch verbatim.
const ENTITY_FALLBACK = {
    '&lt;': '<', '&gt;': '>', '&amp;': '&',
    '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
};
function decodeEntities(val) {
    if (val.indexOf('&') === -1) return val;
    return val
        .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
        .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (m) => ENTITY_FALLBACK[m]);
}

// Same-file '#anchor' links resolve against the repoFile currently being
// parsed; relative links resolve against the spec directory on GitHub —
// identical rules to js/spec-parser.js's resolveLinkTarget.
function resolveLinkTarget(target, repoFile) {
    target = target.trim();
    if (/^(https?:\/\/|mailto:)/.test(target)) return target;
    if (target.startsWith('#')) return BLOB_BASE + repoFile + target;
    while (target.startsWith('./')) target = target.slice(2);
    while (target.startsWith('../')) target = target.slice(3);
    return BLOB_BASE + target;
}

// Mirrors js/spec-parser.js's cleanText exactly (math spans stashed
// before any stripping so LaTeX source survives, restored verbatim at
// the end; links kept as markdown with an absolute, resolved target so
// the resulting description remains valid markdown for a VS Code
// MarkdownString hover; bold/italic markers stripped to plain text;
// backticks stripped).
function cleanText(val, repoFile) {
    if (!val) return '';

    const mathSpans = [];
    val = val.replace(MATH_RE, (m) => {
        mathSpans.push(m);
        return '' + (mathSpans.length - 1) + '';
    });

    val = decodeEntities(val);
    val = val.replace(MD_LINK_RE, (m, text, target) => '[' + text + '](' + resolveLinkTarget(target, repoFile) + ')');
    val = val.replace(BOLD_US_RE, '$1');
    val = val.replace(BOLD_AST_RE, '$1');
    val = val.replace(ITALIC_RE, '$1');
    val = val.replace(/`/g, '');

    mathSpans.forEach((span, i) => {
        val = val.replace('' + i + '', () => span);
    });

    return val.trim();
}

// Sentinel placeholders used by the spec markdown's table cells, mapped
// to display-friendly values. Matched against the *raw* cell content
// before any markdown stripping, so the bold/italic regexes can't mangle
// them. Verbatim from js/spec-parser.js's SENTINEL_MAP.
const SENTINEL_MAP = {
    '__empty__': '',
    '__zero__': '0',
    '__one__': '1',
    '__half__': '0.5',
    '__matrix33__': 'identity (matrix33)',
    '__matrix44__': 'identity (matrix44)',
    '_UV0_': 'UV0',
    '_NA_': 'N/A',
};

// Cleanup for one table cell — verbatim port of js/spec-parser.js's
// cleanCellValue, with repoFile threaded through to cleanText (this
// module's cleanText takes repoFile as an explicit arg rather than
// reading a module-level currentRepoFile, per its own comment above).
function cleanCellValue(val, repoFile) {
    if (!val) return '';
    val = val.trim();

    // Map spec sentinels first, on the raw value.
    if (Object.prototype.hasOwnProperty.call(SENTINEL_MAP, val)) {
        return SENTINEL_MAP[val];
    }

    val = cleanText(val, repoFile);

    // Strip only *surrounding* symmetric quotes; never touch apostrophes
    // or quotes inside the text ("renderer's", "minframe-maxframe").
    if (val.length >= 2 && val[0] === val[val.length - 1] && (val[0] === '"' || val[0] === "'")) {
        val = val.slice(1, -1).trim();
    }
    return val;
}

// ---------------------------------------------------------------------
// Per-file markdown parse — trimmed port of js/spec-parser.js's
// parseMdDocs. Recognizes the same anchor/heading/table structure but
// drops everything the description/port-table pair doesn't need:
// footnotes and "notes" (prose AFTER the first port table). Returns
// { name: [{ description, anchor, port_tables }] } — an ARRAY per name
// because a node name can appear more than once in one spec file (e.g.
// the color `mix` and the shader `mix` both live in
// MaterialX.StandardNodes.md).
const NODE_HEADING_RE = /^###\s+`([^`]+)`\s*$/;
const ANY_HEADING_RE = /^#{1,6}\s+.*$/;
const TABLE_SEP_RE = /^[-:\s]+$/;
const ANCHOR_RE = /^<a\s+id="([^"]+)"/;
const HTML_FILLER_RE = /^(<p>\s*<\/p>|<p\s*\/>|<\/?p>|<br\s*\/?>)$/i;

function parseSpecFile(text, repoFile) {
    const docs = {};
    if (!text) return docs;
    const lines = text.split(/\r\n|\n|\r/);

    let lastAnchor = null;    // most recent <a id="..."> line, consumed by the next node heading
    let node = null;          // { name, descParas: [], anchor, port_tables: [] }
    let paraBuffer = [];
    let currentTable = null;  // { headers, ports } for the table currently open, or null between tables
    let inFence = false;      // inside a ``` fenced block

    // Prose before the node's first Port-column table is the
    // description; DELIBERATE DEVIATION from parseMdDocs: prose after
    // that point (parseMdDocs' "notes") is parsed (to keep table-start
    // detection correct) but never kept, since this module extracts
    // descriptions and port tables ONLY, not notes/references. A node
    // has "seen its first port table" once node.port_tables is
    // non-empty — mirrors parseMdDocs' targetParagraphs() switching from
    // _desc_paras to _note_paras the same way.
    const flushParagraph = () => {
        if (node && paraBuffer.length && !node.port_tables.length) {
            const paragraph = cleanText(paraBuffer.join(' '), repoFile);
            if (paragraph) node.descParas.push(paragraph);
        }
        paraBuffer = [];
    };

    const closeNode = () => {
        flushParagraph();
        if (node) {
            const description = node.descParas.join('\n\n');
            // Keep this node's entry when it carries a description OR at
            // least one real (non-ignored) port table — a heading that
            // somehow produced neither has nothing worth surfacing.
            if (description || node.port_tables.length) {
                (docs[node.name] = docs[node.name] || []).push({
                    description,
                    anchor: node.anchor,
                    port_tables: node.port_tables,
                });
            }
        }
        node = null;
        currentTable = null;
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();

        // Fenced blocks (```math ... ``` etc.): DELIBERATE DEVIATION from
        // parseMdDocs, which keeps fenced content (folding ```math``` into
        // a $$...$$ display-math paragraph). Fences essentially never
        // appear in the short pre-table prose this module cares about
        // (they're a "notes"/worked-example thing), so they're just
        // skipped here rather than ported in full — one less place a
        // hover tooltip's markdown could end up malformed.
        if (line.startsWith('```')) {
            inFence = !inFence;
            continue;
        }
        if (inFence) continue;

        if (!line) {
            // Blank line: paragraph and table boundaries, same as parseMdDocs.
            flushParagraph();
            currentTable = null;
            continue;
        }

        if (ANY_HEADING_RE.test(line)) {
            const nodeMatch = NODE_HEADING_RE.exec(line);
            if (nodeMatch) {
                closeNode();
                node = { name: nodeMatch[1].trim(), descParas: [], anchor: lastAnchor, port_tables: [] };
                lastAnchor = null;
            } else {
                // Any other heading — including a level>=4 sub-heading
                // INSIDE a node's own prose (parseMdDocs keeps those as
                // content) — ends the current node here. DELIBERATE
                // DEVIATION: description-only mode has no "keep as
                // content" bucket to route a sub-heading into, and by the
                // time a real spec entry reaches a sub-heading it has
                // already passed its port table in every file inspected
                // for this module, so the description itself is unaffected
                // in practice.
                closeNode();
            }
            continue;
        }

        const anchorMatch = ANCHOR_RE.exec(line);
        if (anchorMatch) {
            lastAnchor = anchorMatch[1];
            continue;
        }

        if (node === null) continue; // prose between sections
        if (HTML_FILLER_RE.test(line)) continue;

        if (line.startsWith('|')) {
            flushParagraph();
            const parts = line.split('|').map((p) => p.trim()).slice(1, -1);
            const nonEmpty = parts.filter((p) => p);
            if (parts.length && nonEmpty.length && nonEmpty.every((p) => TABLE_SEP_RE.test(p))) {
                continue; // separator row (|---|---|...)
            }
            if (currentTable === null) {
                // First pipe row of a new table -> header row. Mirrors
                // js/spec-parser.js's header normalization exactly
                // (lowercase, spaces -> underscores: "Accepted Values"
                // -> "accepted_values") so this module's port_tables
                // shape matches the site's. Only a table with a "port"
                // column is a REAL port table (pushed to
                // node.port_tables, which also ends description
                // accumulation for good, see flushParagraph above) — a
                // Port-less table is consumed but ignored, mirroring
                // parseMdDocs treating it the same way (its rows never
                // land in port_tables, so text after it still targets
                // the description).
                const headers = parts.map((h) => h.toLowerCase().split(' ').join('_'));
                currentTable = { headers, ports: {} };
                if (headers.indexOf('port') !== -1) {
                    node.port_tables.push(currentTable);
                } else {
                    currentTable.ignore = true;
                }
            } else if (!currentTable.ignore) {
                // Data row of the currently open (real) port table.
                const headers = currentTable.headers;
                const rowData = {};
                headers.forEach((h, i) => {
                    rowData[h] = cleanCellValue(i < parts.length ? parts[i] : '', repoFile);
                });
                const portName = (rowData.port || '').trim();
                delete rowData.port;
                // Guard against a stray header row being read as data
                // (e.g. two tables not separated by a blank line).
                if (portName && portName.toLowerCase() !== 'port') {
                    currentTable.ports[portName] = rowData;
                }
            }
            continue;
        }

        paraBuffer.push(line);
    }
    closeNode();
    return docs;
}

// ---------------------------------------------------------------------
// Source loading — vendor-first (synchronous), remote-fallback (async).
//
// readLocalSpecFile: the offline-build path, mirroring js/mtlx-assets.js's
// LOCAL mode — a file present under vendor/materialx/documents/
// Specification/ is read synchronously and NEVER touches the network for
// that file, same "hard mode isolation" guarantee mtlx-assets.js documents
// for the browser build. Missing/unreadable -> null (fail soft, same as
// the single try/catch this replaces), not an exception: the offline
// build not having vendored these three files yet is an expected,
// non-fatal state.
function readLocalSpecFile(repoRoot, file) {
    try {
        return fs.readFileSync(path.join(repoRoot, LOCAL_ROOT, SPEC_DIR, file), 'utf8');
    } catch (e) {
        return null;
    }
}

// fetchRemoteSpecFile: the online-build fallback for a file NOT found
// locally. Plain `https`, no fetch()/dependency — this module stays as
// dependency-light as validator.js/mtlxNode.js/docScanner.js, and `https`
// needs no Node-version feature-detection (unlike global fetch, whose
// availability tracks the Node version bundled with whatever VS Code
// version this extension's package.json `engines.vscode` ends up running
// under). Resolves to the response body on a 200, or null on ANY failure
// (network error, non-200 status, timeout) — NEVER rejects, so callers
// don't need a `.catch()` of their own, and a null return threads through
// mergeFileText below exactly like a local miss does.
const FETCH_TIMEOUT_MS = 10000;
function fetchRemoteSpecFile(file) {
    return new Promise((resolve) => {
        const req = https.get(RAW_BASE + file, (res) => {
            if (res.statusCode !== 200) {
                res.resume(); // drain so the socket can be released
                resolve(null);
                return;
            }
            res.setEncoding('utf8');
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve(body));
            res.on('error', () => resolve(null));
        });
        req.on('error', () => resolve(null));
        req.setTimeout(FETCH_TIMEOUT_MS, () => {
            req.destroy();
            resolve(null);
        });
    });
}

// ---------------------------------------------------------------------
// Combine all three files into one category -> { description, port_tables,
// specUrl? } map, plus a squashed-lowercase index for the fallback lookup.
// Split into an incremental merge step (mergeFileText) and a derive step
// (deriveByNameMaps) so a file's contribution can land whenever its text
// becomes available — synchronously for a vendored file, or asynchronously
// whenever its remote fetch settles (see ensureSourcesLoading below) —
// instead of requiring every file to be in hand up front the way a single
// synchronous buildCombinedMap(repoRoot) used to.
//
// A category found in more than one file/heading (see SPEC_FILES' order
// comment above) has its descriptions CONCATENATED and its port_tables
// CONCATENATED (in file order, then heading order within a file — the
// same order parseSpecFile discovered them in), mirroring
// js/spec-parser.js's resolveDoc() "no confident nodegroup match: merge
// everything so nothing is lost" fallback (including its
// `entries.reduce((acc, e) => acc.concat(e.port_tables || []), [])` for
// port_tables specifically) — this module has no nodedef/nodegroup
// context to disambiguate with (getNodeDoc takes only a category
// string), so that fallback is the only behavior available, applied
// unconditionally rather than as one branch of resolveDoc.
const squash = (s) => String(s).replace(/[-_]/g, '').toLowerCase();

const merged = new Map(); // name -> { descParas: [], portTables: [], anchor: null, file: null }
let dirty = false;        // true once `merged` changed since the last deriveByNameMaps() call
let derivedMap = null;    // { byName, bySquashed } derived from `merged`, recomputed lazily below

// Folds ONE file's parsed entries into the shared `merged` map (mutates
// in place, marks `dirty`). `text` may be null (missing locally AND
// remote fetch failed/still pending) — a no-op fail-soft skip, same as
// the old per-file try/catch's `continue`.
function mergeFileText(file, text) {
    if (!text) return;
    const perFile = parseSpecFile(text, file);
    for (const name of Object.keys(perFile)) {
        let combined = merged.get(name);
        if (!combined) {
            combined = { descParas: [], portTables: [], anchor: null, file: null };
            merged.set(name, combined);
        }
        for (const entry of perFile[name]) {
            if (entry.description) combined.descParas.push(entry.description);
            if (entry.port_tables && entry.port_tables.length) {
                combined.portTables = combined.portTables.concat(entry.port_tables);
            }
            // First anchor found (in SPEC_FILES order, then file
            // order) wins the spec_url's target file — every node
            // heading in these files is immediately preceded by its
            // own <a id="node-..."> line, so this is the anchor for
            // the exact entry the description text came from, not a
            // guess.
            if (!combined.anchor && entry.anchor) {
                combined.anchor = entry.anchor;
                combined.file = file;
            }
        }
    }
    dirty = true;
}

// Derives the byName/bySquashed lookup getNodeDoc actually queries from
// whatever `merged` currently holds. Recomputed lazily (guarded by
// `dirty` in getNodeDoc below) rather than incrementally — cheap relative
// to a network round trip, and correctness (picking up a file that just
// finished a remote fetch) matters more than micro-perf here.
function deriveByNameMaps() {
    const byName = new Map();
    const bySquashed = new Map(); // squashed key -> canonical category name, first match wins
    for (const [name, combined] of merged) {
        const description = combined.descParas.join('\n\n');
        const entry = { description, port_tables: combined.portTables };
        // Only set spec_url when a REAL anchor was parsed — no synthetic
        // 'node-' + name.split('_').join('-') guess here (unlike
        // js/spec-parser.js, which can afford to guess because it always
        // knows the node's library/file from the live nodedef; this
        // module, given just a category string, would risk pointing at a
        // file that doesn't even contain the node). "when derivable, else
        // omitted" per the spec.
        if (combined.anchor) {
            entry.specUrl = BLOB_BASE + combined.file + '#' + combined.anchor;
        }
        byName.set(name, entry);
        const key = squash(name);
        if (!bySquashed.has(key)) bySquashed.set(key, name);
    }
    return { byName, bySquashed };
}

// Kicked off once per extension host session (see `initStarted` below).
// For each of the three files, IN SPEC_FILES ORDER: read it locally if
// vendored (synchronous, merged immediately); otherwise fetch it from
// GitHub (async) and merge it in once that settles, THEN move on to the
// next file — deliberately sequential (`await`ed inside the loop, not
// fired off in parallel) rather than a bare fire-and-forget per file, so
// that when two+ files fall back to remote (e.g. a plain dev checkout
// with no vendor/materialx/ at all — `npm run vendor` alone doesn't
// populate it, only `vendor:offline` does) they still land in
// mergeFileText in the SAME order raw network completion order would
// otherwise scramble; mergeFileText's/deriveByNameMaps' "first anchor in
// SPEC_FILES order wins" and "descriptions concatenated in SPEC_FILES
// order" guarantees (see their own comments above) depend on that order,
// not on which request happens to come back first. The IIFE itself is
// NOT awaited by ensureSourcesLoading's caller (getNodeDoc stays fully
// synchronous) — it just runs to completion in the background. A
// getNodeDoc call made before a later file's fetch resolves simply sees
// that file's categories as undocumented yet — the same graceful "no
// doc" path a genuinely-undocumented category already takes (see
// getNodeDoc's own doc comment) — and self-heals on a later hover once
// the fetch lands, since `merged`/`dirty` are module-level and mutated
// in place rather than rebuilt from scratch.
let initStarted = false;
function ensureSourcesLoading(repoRoot) {
    if (initStarted) return;
    initStarted = true;
    (async () => {
        for (const file of SPEC_FILES) {
            const localText = readLocalSpecFile(repoRoot, file);
            if (localText !== null) {
                mergeFileText(file, localText);
                continue;
            }
            const remoteText = await fetchRemoteSpecFile(file);
            mergeFileText(file, remoteText);
        }
    })();
}

// ---------------------------------------------------------------------
// Public API.

/**
 * getNodeDoc(repoRoot, category) -> { description, port_tables, specUrl? } | null
 *
 * (a) exact category-name match against the parsed spec files;
 * (b) else a squashed-lowercase fallback (strip [_-], lowercase — same
 *     idea as hashToSel's name-only branch in js/docs/doc-links.jsx);
 * (c) port_tables is the {headers, ports} array parsed for this category
 *     (see parseSpecFile above), possibly empty — same shape
 *     js/docs/port-tables.jsx's getPortTables()/pickTableForType() and
 *     this extension's nodeSignature.js consume;
 * (d) specUrl included only when an anchor was actually found for that
 *     category in one of the three files, omitted otherwise.
 * Returns null when the category isn't documented in any of the three
 * spec files under either lookup — including, transiently, one whose
 * file is still an in-flight remote fetch (see ensureSourcesLoading
 * above). This stays a plain, synchronous lookup — no promise/callback
 * surfaced to the caller (hoverProvider.js's buildHoverMarkdown), which
 * already treats a null doc as "no description/table available".
 *
 * repoRoot is fixed for the whole session (there is exactly one
 * extension host process and exactly one repo root, same assumption
 * mtlxNode.js documents for its own singleton) — a later call with a
 * different repoRoot does NOT restart source loading; this mirrors
 * mtlxNode.js's "first caller's repoRoot wins forever" precedent for the
 * same reason.
 */
function getNodeDoc(repoRoot, category) {
    if (!category) return null;
    ensureSourcesLoading(repoRoot);
    if (dirty) {
        derivedMap = deriveByNameMaps();
        dirty = false;
    }
    if (!derivedMap) return null; // nothing merged yet — every source still in flight

    let entry = derivedMap.byName.get(category);
    if (!entry) {
        const canonical = derivedMap.bySquashed.get(squash(category));
        if (canonical) entry = derivedMap.byName.get(canonical);
    }
    if (!entry) return null;

    const out = { description: entry.description, port_tables: entry.port_tables || [] };
    if (entry.specUrl) out.specUrl = entry.specUrl;
    return out;
}

module.exports = { getNodeDoc };
