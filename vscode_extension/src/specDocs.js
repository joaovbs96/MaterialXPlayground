// specDocs.js — headless (extension-host) extractor for per-node
// DESCRIPTIONS ONLY out of the three MaterialX specification markdown
// files committed at the repo root (MaterialX.PBRSpec.md,
// MaterialX.NPRSpec.md, MaterialX.StandardNodes.md). Pure Node: this
// module must NOT require('vscode') anywhere, so it stays independently
// loadable/testable with plain `node` — same rule validator.js/
// mtlxNode.js/docScanner.js already follow, for the same reason
// (hoverProvider.js is the only caller, and it's fine for THAT file to
// depend on vscode; this one stays free of it).
//
// This is a deliberately trimmed Node port of js/spec-parser.js's
// parseMdDocs() state machine (anchors -> `### \`name\`` headings ->
// following paragraph text -> cleanText markdown cleanup), NOT a
// require() of it — js/spec-parser.js is a browser global-scope IIFE
// that fetches the spec files over the network (raw.githubusercontent.com)
// and joins them against live WASM nodedefs for the FULL doc database
// (description + notes + port tables + references); this module only
// ever wants the description paragraph(s) that appear directly after a
// node's heading and before its first port table, read from the LOCAL
// committed copies. Where the two logics overlap (heading/anchor
// recognition, paragraph accumulation, table-start detection, cleanText's
// link/bold/italic/entity cleanup) the logic here mirrors spec-parser.js
// line for line; see the deviations called out inline below.
'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------
// Spec revision/link configuration — kept in lockstep with the constants
// of the same name in js/spec-parser.js so a spec_url produced here
// points at exactly the same GitHub blob/anchor the website would show
// for the same node.
const REPO = 'AcademySoftwareFoundation/MaterialX';
const SPEC_TAG = 'v1.39.5';
const SPEC_DIR = 'documents/Specification/';
const BLOB_BASE = 'https://github.com/' + REPO + '/blob/' + SPEC_TAG + '/' + SPEC_DIR;

// Files to parse, in the order they're merged (see buildCombinedMap
// below) — stdlib first since it's the largest/most commonly-hovered
// library, then the two extension libraries. Order only matters as a
// tie-break for which file's anchor "wins" when the SAME category name
// is documented in more than one spec file (e.g. `mix`/`add` each have a
// generic stdlib entry AND a PBR-specific BSDF-layering entry) — the
// description itself is the concatenation of every entry found across
// every file/duplicate heading (see the merge comment below), so no
// prose is lost either way, only the spec_url's target file/anchor.
const SPEC_FILES = ['MaterialX.StandardNodes.md', 'MaterialX.PBRSpec.md', 'MaterialX.NPRSpec.md'];

// ---------------------------------------------------------------------
// Text cleanup — trimmed port of js/spec-parser.js's cleanText (only the
// pieces description prose actually needs: math-span protection, entity
// decoding, markdown link resolution, bold/italic/backtick stripping).
// cleanCellValue (table-cell sentinels/quote-stripping) has no
// counterpart here — this module never reads table cells.
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

// ---------------------------------------------------------------------
// Per-file markdown parse — trimmed port of js/spec-parser.js's
// parseMdDocs. Recognizes the same anchor/heading/table structure but
// drops everything the description doesn't need: footnotes, port table
// cell contents, "notes" (prose AFTER the first port table). Returns
// { name: [{ description, anchor }] } — an ARRAY per name because a
// node name can appear more than once in one spec file (e.g. the color
// `mix` and the shader `mix` both live in MaterialX.StandardNodes.md).
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
    let node = null;          // { name, descParas: [], anchor, sawPortTable }
    let paraBuffer = [];
    let tableHeaders = null;  // headers of the table currently open, or null between tables
    let inFence = false;      // inside a ``` fenced block

    // Prose before the node's first Port-column table is the
    // description; DELIBERATE DEVIATION from parseMdDocs: prose after
    // that point (parseMdDocs' "notes") is parsed (to keep table-start
    // detection correct) but never kept, since this module extracts
    // descriptions ONLY.
    const flushParagraph = () => {
        if (node && paraBuffer.length && !node.sawPortTable) {
            const paragraph = cleanText(paraBuffer.join(' '), repoFile);
            if (paragraph) node.descParas.push(paragraph);
        }
        paraBuffer = [];
    };

    const closeNode = () => {
        flushParagraph();
        if (node) {
            const description = node.descParas.join('\n\n');
            if (description) {
                (docs[node.name] = docs[node.name] || []).push({ description, anchor: node.anchor });
            }
        }
        node = null;
        tableHeaders = null;
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
            tableHeaders = null;
            continue;
        }

        if (ANY_HEADING_RE.test(line)) {
            const nodeMatch = NODE_HEADING_RE.exec(line);
            if (nodeMatch) {
                closeNode();
                node = { name: nodeMatch[1].trim(), descParas: [], anchor: lastAnchor, sawPortTable: false };
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
            if (tableHeaders === null) {
                // First pipe row of a new table -> header row. Only a
                // table with a "Port" column flips sawPortTable (and thus
                // ends description accumulation for good) — mirrors
                // parseMdDocs treating a Port-less table as "ignore" (its
                // rows never land in port_tables, so text after it still
                // targets the description).
                tableHeaders = parts.map((h) => h.toLowerCase());
                if (tableHeaders.indexOf('port') !== -1) node.sawPortTable = true;
            }
            // Data rows: nothing to extract for a description-only parse.
            continue;
        }

        paraBuffer.push(line);
    }
    closeNode();
    return docs;
}

// ---------------------------------------------------------------------
// Combine all three files into one category -> { description, specUrl? }
// map, plus a squashed-lowercase index for the fallback lookup.
//
// A category found in more than one file/heading (see SPEC_FILES' order
// comment above) has its descriptions CONCATENATED, mirroring
// js/spec-parser.js's resolveDoc() "no confident nodegroup match: merge
// everything so nothing is lost" fallback — this module has no nodedef/
// nodegroup context to disambiguate with (getNodeDoc takes only a
// category string), so that fallback is the only behavior available,
// applied unconditionally rather than as one branch of resolveDoc.
const squash = (s) => String(s).replace(/[-_]/g, '').toLowerCase();

function buildCombinedMap(repoRoot) {
    const merged = new Map(); // name -> { descParas: [], anchor: null, file: null }

    for (const file of SPEC_FILES) {
        let text;
        try {
            text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
        } catch (e) {
            continue; // fail soft: missing/unreadable file -> skip it, per-file
        }
        const perFile = parseSpecFile(text, file);
        for (const name of Object.keys(perFile)) {
            let combined = merged.get(name);
            if (!combined) {
                combined = { descParas: [], anchor: null, file: null };
                merged.set(name, combined);
            }
            for (const entry of perFile[name]) {
                if (entry.description) combined.descParas.push(entry.description);
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
    }

    const byName = new Map();
    const bySquashed = new Map(); // squashed key -> canonical category name, first match wins
    for (const [name, combined] of merged) {
        const description = combined.descParas.join('\n\n');
        const entry = { description };
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

// ---------------------------------------------------------------------
// Public API.

// Lazy + cached: parsed once, on the first getNodeDoc() call, then
// reused for the lifetime of the extension host process — repo root is
// fixed for the whole session (there is exactly one extension host
// process and exactly one repo root, same assumption mtlxNode.js
// documents for its own singleton). A later call with a different
// repoRoot does NOT reparse; this mirrors mtlxNode.js's "first caller's
// repoRoot wins forever" precedent for the same reason.
let cachedMap = null;

/**
 * getNodeDoc(repoRoot, category) -> { description, specUrl? } | null
 *
 * (a) exact category-name match against the parsed spec files;
 * (b) else a squashed-lowercase fallback (strip [_-], lowercase — same
 *     idea as hashToSel's name-only branch in js/docs/doc-links.jsx);
 * (c) specUrl included only when an anchor was actually found for that
 *     category in one of the three files, omitted otherwise.
 * Returns null when the category isn't documented in any of the three
 * spec files under either lookup.
 */
function getNodeDoc(repoRoot, category) {
    if (!category) return null;
    if (!cachedMap) cachedMap = buildCombinedMap(repoRoot);

    let entry = cachedMap.byName.get(category);
    if (!entry) {
        const canonical = cachedMap.bySquashed.get(squash(category));
        if (canonical) entry = cachedMap.byName.get(canonical);
    }
    if (!entry) return null;

    const out = { description: entry.description };
    if (entry.specUrl) out.specUrl = entry.specUrl;
    return out;
}

module.exports = { getNodeDoc };
