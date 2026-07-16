// nodeSignature.js — headless (extension-host) helpers for matching a
// hovered/edited MaterialX element to the right port TABLE and rendering
// that table as hover markdown, plus building/round-tripping a compact
// "signature token" so a hover's "Open Interactive Documentation" link
// can deep-link the docs site straight to the matching signature. Pure
// Node: this module must NOT require('vscode') anywhere, so it stays
// independently loadable/testable with plain `node` — same rule
// specDocs.js/validator.js/mtlxNode.js/docScanner.js already follow, for
// the same reason (hoverProvider.js is the only caller, and it's fine
// for THAT file to depend on vscode; this one stays free of it).
//
// Two families of exports:
//   - SAME_AS_RE/resolveType/isOutputPort/uniqTypeTokens/signatureLabel/
//     SIG_FAMILY_EXPANSIONS/expandSigToken/pickTableForType — a trimmed,
//     otherwise VERBATIM Node port of js/docs/port-tables.jsx's
//     signature-label helper cluster (not a require() of it — that file
//     is Babel/JSX, executed in a browser <script type="text/babel">
//     context with no module.exports, and exports its OWN copies of
//     these onto `window` only for its internal use — see that file's
//     own "no consumers outside this file" export-list comment). Kept
//     byte-for-byte identical logic so a table match (or signature label)
//     made here and one made by the docs site itself (js/docs-app.jsx's
//     `pickTableForType(portTables, selectedGroup.type)`, js/docs/
//     port-tables.jsx's own signatureLabel) never disagree for the same
//     table data.
//   - extractElementContext/buildSigToken/renderPortsMarkdown — new
//     helpers with no site-side counterpart, specific to turning a raw
//     .mtlx document's text + a tag-name offset into a signature and a
//     compact hover-sized markdown rendering of a table's ports.
'use strict';

// ---------------------------------------------------------------------
// Verbatim port of js/docs/port-tables.jsx's signature-label helper
// cluster (~lines 247-356 there), trimmed of JSX/React context. See the
// file banner above for why this is a port, not a require().

// "Same as <port>" (optionally "... or <extra>") type-reference syntax
// used throughout the spec's port tables (e.g. multiply's `in2`: "Same
// as `in1` or float").
const SAME_AS_RE = /^same as\s+(\S+?)(?:\s+or\s+(.+))?$/i;

// Resolves a port's TYPE cell, following a "Same as X" chain to the
// concrete type string(s) it ultimately refers to. `seen` guards against
// a cyclical/self-referencing chain (defensive; the spec never actually
// has one).
const resolveType = (ports, portName, seen) => {
    seen = seen || new Set();
    const row = ports[portName];
    if (!row || seen.has(portName)) return '';
    seen.add(portName);
    const t = (row.type || '').trim();
    const m = t.match(SAME_AS_RE);
    if (!m) return t;
    const resolved = resolveType(ports, m[1], seen);
    if (!resolved) return t; // unresolvable reference: keep raw text
    return m[2] ? `${resolved}, ${m[2]}` : resolved;
};

// A port counts as an OUTPUT when its key is literally 'out', or its
// description starts with "Output" (the spec's own convention for
// naming a non-'out' output port, e.g. multi-output nodes).
const isOutputPort = (name, row) =>
    name === 'out' || /^output\b/i.test(row.description || '');

// Split resolved type strings ("colorN, vectorN") into individual tokens
// and dedupe at token level, so "Same as in1 or float" on a matrixNN
// input yields "matrixNN, float" rather than "matrixNN, matrixNN, float".
const uniqTypeTokens = (typeStrings) => {
    const seen = new Set();
    const out = [];
    typeStrings.filter(Boolean).forEach(s =>
        s.split(',').map(t => t.trim()).filter(Boolean).forEach(t => {
            if (!seen.has(t)) { seen.add(t); out.push(t); }
        })
    );
    return out;
};

// Verbatim port of js/docs/port-tables.jsx's signatureLabel (~lines
// 280-294 there): an "inputs → output" type summary for a table, e.g.
// "surfaceshader" or "boolean → float, integer" — used for hover
// markdown's "**Signature:**" line (see renderPortsMarkdown below).
// Reuses resolveType/isOutputPort/uniqTypeTokens above, the same helpers
// the docs site's own signatureLabel closes over, so a label produced
// here never disagrees with the one the docs site shows for the same
// table data. Returns null when the table has no in/out types at all
// worth summarizing.
const signatureLabel = (table) => {
    const ports = table.ports || {};
    const names = Object.keys(ports);
    const inTypes = uniqTypeTokens(names
        .filter(n => !isOutputPort(n, ports[n]))
        .map(n => resolveType(ports, n)));
    const outTypes = uniqTypeTokens(names
        .filter(n => isOutputPort(n, ports[n]))
        .map(n => resolveType(ports, n)));
    if (!inTypes.length && !outTypes.length) return null;
    const inStr = inTypes.join(', ');
    const outStr = outTypes.join(', ');
    if (!outStr || inStr === outStr) return inStr || outStr;
    if (!inStr) return `→ ${outStr}`;
    return `${inStr} → ${outStr}`;
};

// Family placeholder -> concrete member types, as authored by the spec
// (e.g. a table whose output is documented as "colorN" covers color2,
// color3, AND color4 concretely).
const SIG_FAMILY_EXPANSIONS = {
    colorn: ['color2', 'color3', 'color4'],
    vectorn: ['vector2', 'vector3', 'vector4'],
    matrixnn: ['matrix33', 'matrix44'],
};
const expandSigToken = (tok) => {
    const key = (tok || '').trim().toLowerCase();
    return SIG_FAMILY_EXPANSIONS[key] || [key];
};

// Which markdown table documents the signature with this output type?
// Spec write-ups that cover several signatures under one heading (e.g.
// `multiply`: scalar/vector table + matrixNN table) author family tokens
// ('float, colorN or vectorN', 'matrixNN') rather than splitting per
// concrete type. Expand those tokens and pick the first table whose
// OUTPUT port types (resolving "Same as X" chains via resolveType, and
// falling back to ALL ports when a table has no output row) cover the
// wanted concrete type.
const pickTableForType = (tables, type) => {
    if (!type || !tables || !tables.length) return null;
    const want = type.trim().toLowerCase();
    for (const table of tables) {
        const ports = table.ports || {};
        const names = Object.keys(ports);
        let outNames = names.filter(n => isOutputPort(n, ports[n]));
        if (!outNames.length) outNames = names;
        const tokens = uniqTypeTokens(outNames.map(n => resolveType(ports, n)));
        const expanded = tokens.reduce((acc, t) => acc.concat(expandSigToken(t)), []);
        if (expanded.some(t => t === want)) return table;
    }
    return null;
};

// ---------------------------------------------------------------------
// extractElementContext — bounded, best-effort scan of a raw .mtlx
// document's TEXT (no XML parser: this must stay fast enough to run on
// every hover, and tolerate a document that's mid-edit/invalid XML at
// the moment of the hover) to recover the hovered element's own
// `type="..."` attribute and its <input> children's name/type pairs.
//
// `text`: the FULL document text. `nameStartOffset`: the char offset of
// the FIRST character of the tag name itself (i.e. right after the '<'
// — hoverProvider.js passes `document.offsetAt(tagRange.start)`, where
// tagRange is the tag-name word range). `tagName`: the tag name string
// (e.g. "multiply").
//
// Returns { type: string|null, inputs: [{name, type}] }. Every scan
// below is BOUNDED (a cap on chars scanned or matches inspected) so a
// pathological/huge document can't make a single hover slow, and ANY
// failure (bad args, an exception, a tag that never closes within its
// cap) degrades to { type: null, inputs: [] } rather than throwing —
// hoverProvider.js still shows the description/first table on a context
// miss, so degrading silently is strictly better than a broken hover.
const ELEMENT_TYPE_SHAPE_RE = /^[\w:]+$/;
const INPUT_FIELD_SHAPE_RE = /^[\w:.\-]+$/;
const OPEN_TAG_SCAN_CAP = 4000;
const CHILDREN_SCAN_CAP = 20000;
const INPUT_MATCH_CAP = 64;
const MAX_CONTEXT_INPUTS = 8;

function extractAttrValue(tagText, attrName) {
    const re = new RegExp('\\b' + attrName + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')');
    const m = re.exec(tagText);
    if (!m) return null;
    return m[2] !== undefined ? m[2] : m[3];
}

function escapeRegExpLiteral(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractElementContext(text, nameStartOffset, tagName) {
    const FAIL = { type: null, inputs: [] };
    try {
        if (typeof text !== 'string' || typeof nameStartOffset !== 'number'
            || nameStartOffset < 0 || nameStartOffset > text.length
            || typeof tagName !== 'string' || !tagName) {
            return FAIL;
        }

        // ---- Step 1: locate the end of the OPEN tag — the unquoted '>'
        // that closes `<tagName ...>` or `<tagName .../>` — skipping over
        // quoted attribute-value spans so a '>' inside a value (legal in
        // an unescaped-but-still-parseable-by-real-XML-parsers attribute,
        // though rare) doesn't terminate the tag early. Bounded: a tag
        // that doesn't close within OPEN_TAG_SCAN_CAP chars is treated as
        // a failure rather than scanned without limit.
        const openLimit = Math.min(text.length, nameStartOffset + OPEN_TAG_SCAN_CAP);
        let i = nameStartOffset;
        let inQuote = null;
        let gt = -1;
        while (i < openLimit) {
            const ch = text[i];
            if (inQuote) {
                if (ch === inQuote) inQuote = null;
            } else if (ch === '"' || ch === "'") {
                inQuote = ch;
            } else if (ch === '>') {
                gt = i;
                break;
            }
            i++;
        }
        if (gt === -1) return FAIL;

        const openTag = text.slice(nameStartOffset, gt + 1); // "tagName ...>" (or ".../>")
        const selfClosing = /\/\s*>$/.test(openTag);

        // ---- The element's own `type="..."` attribute, if any and if
        // it looks like a plausible MaterialX type (word chars/colon
        // only — no dots/hyphens, unlike input name/type below: an
        // element's `type` is always a bare type name, never a
        // versioned/namespaced identifier).
        let type = null;
        const rawType = extractAttrValue(openTag, 'type');
        if (rawType !== null && ELEMENT_TYPE_SHAPE_RE.test(rawType)) type = rawType;

        if (selfClosing) return { type, inputs: [] };

        // ---- Step 2: children region — from just after the open tag's
        // '>' to whichever comes first: the matching </tagName close
        // tag, or a NESTED <tagName (the same tag name reopening — a
        // guard against scanning past a malformed/never-closed element
        // into an unrelated later element of the same category).
        // Bounded to CHILDREN_SCAN_CAP chars; if neither boundary is
        // found within the cap, the capped region itself is scanned
        // (best-effort, not a failure — <input> children near the start
        // of a huge element are still found).
        const childStart = gt + 1;
        const region = text.slice(childStart, Math.min(text.length, childStart + CHILDREN_SCAN_CAP));
        const escapedTag = escapeRegExpLiteral(tagName);
        const closeMatch = new RegExp('</' + escapedTag + '\\b').exec(region);
        const nestedMatch = new RegExp('<' + escapedTag + '[\\s/>]').exec(region);
        let regionEnd = region.length;
        if (closeMatch && nestedMatch) regionEnd = Math.min(closeMatch.index, nestedMatch.index);
        else if (closeMatch) regionEnd = closeMatch.index;
        else if (nestedMatch) regionEnd = nestedMatch.index;
        const childrenText = region.slice(0, regionEnd);

        // ---- Step 3: <input ...> children — up to INPUT_MATCH_CAP raw
        // matches inspected, up to MAX_CONTEXT_INPUTS kept (only those
        // whose name AND type are both present and shape-valid).
        const inputs = [];
        const inputRe = /<input\b[^>]*?\/?>/g;
        let seen = 0;
        let m;
        while (inputs.length < MAX_CONTEXT_INPUTS && seen < INPUT_MATCH_CAP && (m = inputRe.exec(childrenText)) !== null) {
            seen++;
            const tag = m[0];
            const nm = extractAttrValue(tag, 'name');
            const ty = extractAttrValue(tag, 'type');
            if (nm === null || ty === null) continue;
            if (!INPUT_FIELD_SHAPE_RE.test(nm) || !INPUT_FIELD_SHAPE_RE.test(ty)) continue;
            inputs.push({ name: nm, type: ty });
        }

        return { type, inputs };
    } catch (e) {
        return FAIL;
    }
}

// ---------------------------------------------------------------------
// buildSigToken — a compact, URL-safe-once-encoded string encoding ctx's
// output type and typed inputs, e.g. `color3(in1:color3,in2:float)`, or
// just the bare output type (`surfaceshader`) when there are no typed
// inputs to disambiguate with. Returns null when ctx has no usable
// output type at all — nothing worth deep-linking a signature for.
//
// Every char buildSigToken can emit is validated upstream (ELEMENT_TYPE_
// SHAPE_RE / INPUT_FIELD_SHAPE_RE above), so every token this function
// produces is guaranteed to match extension.js's SIG_TOKEN_RE and
// js/docs/doc-links.jsx's SIG_HINT_RE — both intentionally shaped to
// accept exactly this grammar.
function buildSigToken(ctx) {
    if (!ctx || !ctx.type) return null;
    const inputs = Array.isArray(ctx.inputs) ? ctx.inputs : [];
    if (!inputs.length) return ctx.type;
    return ctx.type + '(' + inputs.map((inp) => inp.name + ':' + inp.type).join(',') + ')';
}

// ---------------------------------------------------------------------
// renderPortsMarkdown — a per-port DEFINITION LIST rendering of one port
// TABLE ({headers, ports: {name: {type, default, description, ...}}}),
// sized for a hover tooltip rather than the full docs page. This
// replaces an earlier GFM pipe-table rendering: VS Code's hover CSS
// renders pipe tables WITHOUT visible cell borders and stretches columns
// unreadably (verified — `supportHtml` doesn't help either, since the
// markdown sanitizer strips style attributes and the same CSS still
// applies to the resulting plain <table>). A definition list with
// code-span "chips" for name/type/default reads far better in that same
// hover CSS: one block per port (name/type/default chips on one line,
// description on the next), preceded by a "**Signature:**" line (see
// signatureLabel above). `accepted_values` is dropped entirely (the
// interactive docs page is the source of truth for enum lists), footnote
// references are stripped (a hover has no References section to resolve
// them against), long descriptions are truncated on a word boundary, and
// the port count is capped so one giant node (e.g. a closure with 20+
// inputs) can't produce an unreadable wall of hover text.
const FOOTNOTE_REF_RE = /\[\^[^\]\s]+\]/g;
const DESCRIPTION_MAX_LEN = 120;
const MAX_TABLE_ROWS = 14;

function stripFootnoteRefs(s) {
    return s.replace(FOOTNOTE_REF_RE, '');
}

// Text placed INSIDE a `code span` (port name/type/default) must not
// carry a backtick (would terminate the span early) or a pipe (harmless
// in a definition list, but stripped anyway per the same "keep chip text
// clean" rule) — never applied to the free-text description paragraph,
// which isn't wrapped in a code span.
function sanitizeChip(s) {
    return s.replace(/[`|]/g, '');
}

// Truncates on a word boundary (never mid-word) and appends an ellipsis;
// falls back to a hard cut only when no earlier space exists to break
// on (a single very long "word", e.g. a URL).
function truncateDescription(s) {
    if (!s || s.length <= DESCRIPTION_MAX_LEN) return s;
    const cut = s.slice(0, DESCRIPTION_MAX_LEN);
    const lastSpace = cut.lastIndexOf(' ');
    const trimmed = (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
    return trimmed + '…';
}

function cellText(raw, isDescription) {
    let s = raw == null ? '' : String(raw).trim();
    if (!s) return '';
    s = stripFootnoteRefs(s);
    if (isDescription) s = truncateDescription(s);
    return s;
}

function renderPortsMarkdown(table) {
    try {
        if (!table || !table.ports) return '';
        const portNames = Object.keys(table.ports);
        if (!portNames.length) return '';

        const blocks = [];

        // Signature line first, e.g. "**Signature:** `boolean, integer,
        // float, colorN, vectorN → surfaceshader`" — omitted entirely
        // (rather than printed empty) when signatureLabel can't derive
        // anything useful for this table.
        const sigLabel = signatureLabel(table);
        if (sigLabel) {
            blocks.push('**Signature:** `' + sanitizeChip(sigLabel) + '`');
        }

        const shown = portNames.slice(0, MAX_TABLE_ROWS);
        for (const pn of shown) {
            const row = table.ports[pn] || {};
            const name = sanitizeChip(stripFootnoteRefs(String(pn || '').trim()));
            if (!name) continue;
            const type = sanitizeChip(cellText(row.type, false));
            const def = sanitizeChip(cellText(row.default, false));

            // "**`name`** `type` — default `value`", trailing two spaces
            // for a markdown hard line break so the description (when
            // present) starts on its own line within the SAME block —
            // omit the "— default ..." segment entirely when there's no
            // default value to show.
            let head = '**`' + name + '`**';
            if (type) head += ' `' + type + '`';
            if (def) head += ' — default `' + def + '`';
            head += '  ';

            const desc = cellText(row.description, true);
            blocks.push(desc ? head + '\n' + desc : head);
        }

        let md = blocks.join('\n\n');
        const remaining = portNames.length - shown.length;
        if (remaining > 0) {
            md += '\n\n_…and ' + remaining + ' more ports — open the full documentation below._';
        }
        return md;
    } catch (e) {
        return '';
    }
}

module.exports = {
    SAME_AS_RE,
    resolveType,
    isOutputPort,
    uniqTypeTokens,
    signatureLabel,
    SIG_FAMILY_EXPANSIONS,
    expandSigToken,
    pickTableForType,
    extractElementContext,
    buildSigToken,
    renderPortsMarkdown,
};
