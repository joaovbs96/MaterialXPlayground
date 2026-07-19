// spec-parser.js — in-browser port of spec_parser.py.
//
// Builds the node-documentation database ON THE FLY: fetches the MaterialX
// specification markdown files (pinned tag below) through the shared
// local-first resolver (window.MtlxAssets, js/mtlx-assets.js — GitHub
// today, a vendored local mirror once a future offline build populates
// vendor/materialx/), parses them with the same state machine as the
// Python script, and joins them against the nodedefs reported by the
// MaterialX WASM runtime (getMxEnv from mtlx-engine.js). The result is
// byte-for-byte the same JSON shape spec_parser.py wrote to nodes.json:
//
//   { library: { nodegroup: { nodename: {
//       description, notes, section, references: [{key,text,url}],
//       port_tables: [{headers:[...], ports:{name:{...}}}], spec_url
//   } } } }
//
// Self-contained plain script (no Babel/JSX/react): everything is inside
// one IIFE and the public API is exported onto window.MtlxSpecParser.
// The only external dependencies are window.getMxEnv (mtlx-engine.js) —
// and only at buildNodeDatabase() call time — and window.MtlxAssets
// (js/mtlx-assets.js, loaded before this script), used by RAW_BASE below;
// parseMdDocs/cleanText/... are usable standalone. In remote mode this
// requires network access to raw.githubusercontent.com (which sends
// Access-Control-Allow-Origin: *); BLOB_BASE (human-facing links) always
// points at github.com regardless of mode.
//
// Usage:
//   <script src="js/spec-parser.js"></script>
//   ...
//   MtlxSpecParser.buildNodeDatabase().then((db) => { ...same as nodes.json... });

(function () {
    'use strict';

    // ------------------------------------------------------------------
    // Configuration: which spec revision to parse. Single source of truth
    // for BOTH the raw-file fetches and every resolved link / spec_url,
    // so docs, deep links, and anchors always agree with each other.
    // ------------------------------------------------------------------
    // Defaults from js/mtlx-assets.js's MTLX_TAG (the single source of
    // truth) when available; the literal fallback covers standalone /
    // extension-webview contexts where mtlx-assets.js hasn't run yet — see
    // scripts/vendor.mjs's --check for the drift guard between the two.
    const SPEC_TAG = (window.MtlxAssets && window.MtlxAssets.MTLX_TAG) || 'v1.39.5';
    const REPO = 'AcademySoftwareFoundation/MaterialX';
    const SPEC_DIR = 'documents/Specification/';
    // Raw file content. Resolved through window.MtlxAssets (js/mtlx-assets.js,
    // loaded before this script) instead of hardcoding
    // raw.githubusercontent.com directly, so a future offline/packaged
    // build (vendor/materialx/ populated) transparently serves these spec
    // .md files from the local vendor mirror instead — see mtlx-assets.js's
    // header comment for the local/remote contract. MtlxSpecParser.SPEC_TAG
    // is passed through but ignored in local mode (single fixed snapshot).
    const RAW_BASE = () => window.MtlxAssets.repoUrl(SPEC_DIR, MtlxSpecParser.SPEC_TAG);
    // Human-facing pages (spec_url, resolved relative links).
    const BLOB_BASE = () => `https://github.com/${REPO}/blob/${MtlxSpecParser.SPEC_TAG}/${SPEC_DIR}`;

    // Library -> spec markdown file. Sub-libraries ('bxdf/lama') fall back
    // to their base library's file (see docsForLibrary).
    const MD_MAPPING = {
        bxdf: 'MaterialX.PBRSpec.md',
        pbrlib: 'MaterialX.PBRSpec.md',
        nprlib: 'MaterialX.NPRSpec.md',
        stdlib: 'MaterialX.StandardNodes.md',
    };
    const SPEC_FILES = Array.from(new Set(Object.values(MD_MAPPING)));

    // ------------------------------------------------------------------
    // Text cleanup (port of clean_text / clean_cell_value)
    // ------------------------------------------------------------------

    // Sentinel placeholders used by the spec markdown, mapped to
    // display-friendly values. Matched against the *raw* cell content
    // before any markdown stripping, so the bold/italic regexes can't
    // mangle them.
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

    // [link text](target) -> kept as markdown with an ABSOLUTE target.
    // Footnote refs [^Key] are NOT matched: they lack the trailing
    // parenthesis group, and the first character class excludes '^'.
    const MD_LINK_RE = /\[([^\]^][^\]]*)\]\(([^)]*)\)/g;
    // __bold__ / **bold** -> bold
    const BOLD_US_RE = /__([^_]+)__/g;
    const BOLD_AST_RE = /\*\*([^*]+)\*\*/g;
    // _italic_ -> italic, only on word boundaries so snake_case survives.
    const ITALIC_RE = /(?<![\w])_([^_\s][^_]*)_(?![\w])/g;
    // LaTeX math spans: $$display$$ or $inline$ (inline must not span lines)
    const MATH_RE = /\$\$[^$]+\$\$|\$[^$\n]+\$/g;
    // Footnote machinery: [^Key] references and "[^Key]: citation" defs
    const FOOTNOTE_REF_RE = /\[\^([^\]\s]+)\]/g;
    const FOOTNOTE_DEF_RE = /^\[\^([^\]\s]+)\]:\s*(.*)$/;
    const ANGLE_URL_RE = /<(https?:\/\/[^>\s]+)>/g;

    // Same-file '#anchor' links resolve against the repo file currently
    // being parsed (set by parseMdDocs, like the Python global).
    let currentRepoFile = 'MaterialX.Specification.md';

    // html.unescape equivalent. A textarea's content model is RCDATA, so
    // assigning innerHTML decodes character references but keeps tags like
    // <image> as literal text — exactly what the spec cells need.
    const decodeEntities = (() => {
        let ta = null;
        const FALLBACK = {
            '&lt;': '<', '&gt;': '>', '&amp;': '&',
            '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
        };
        return (val) => {
            if (val.indexOf('&') === -1) return val;
            if (typeof document !== 'undefined') {
                if (!ta) ta = document.createElement('textarea');
                ta.innerHTML = val;
                const out = ta.value;
                ta.innerHTML = '';
                return out;
            }
            // Non-DOM context (worker): minimal named/numeric decode.
            return val
                .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
                .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
                .replace(/&(lt|gt|amp|quot|#39|nbsp);/g, (m) => FALLBACK[m]);
        };
    })();

    const resolveLinkTarget = (target) => {
        target = target.trim();
        if (/^(https?:\/\/|mailto:)/.test(target)) return target;
        if (target.startsWith('#')) return BLOB_BASE() + currentRepoFile + target;
        while (target.startsWith('./')) target = target.slice(2);
        while (target.startsWith('../')) target = target.slice(3);
        return BLOB_BASE() + target;
    };

    /**
     * Cleanup shared by table cells and description prose.
     *
     * Math spans ($...$ / $$...$$) are stashed away first so that none of
     * the markdown stripping (underscores, asterisks, backticks, links,
     * entity unescaping) can corrupt LaTeX source; they are restored
     * verbatim at the end and rendered by the viewer. Footnote references
     * like [^Oren1994] pass through untouched.
     */
    const cleanText = (val) => {
        if (!val) return '';

        const mathSpans = [];
        val = val.replace(MATH_RE, (m) => {
            mathSpans.push(m);
            return '\uE000' + (mathSpans.length - 1) + '\uE001';
        });

        val = decodeEntities(val);                       // &lt;image> -> <image>
        val = val.replace(MD_LINK_RE,                    // keep links, absolute
            (m, text, target) => '[' + text + '](' + resolveLinkTarget(target) + ')');
        val = val.replace(BOLD_US_RE, '$1');
        val = val.replace(BOLD_AST_RE, '$1');
        val = val.replace(ITALIC_RE, '$1');
        val = val.replace(/`/g, '');

        mathSpans.forEach((span, i) => {
            val = val.replace('\uE000' + i + '\uE001', () => span);
        });

        return val.trim();
    };

    const cleanCellValue = (val) => {
        if (!val) return '';
        val = val.trim();

        // Map spec sentinels first, on the raw value.
        if (Object.prototype.hasOwnProperty.call(SENTINEL_MAP, val)) {
            return SENTINEL_MAP[val];
        }

        val = cleanText(val);

        // Strip only *surrounding* symmetric quotes; never touch apostrophes
        // or quotes inside the text ("renderer's", "minframe-maxframe").
        if (val.length >= 2 && val[0] === val[val.length - 1] && (val[0] === '"' || val[0] === "'")) {
            val = val.slice(1, -1).trim();
        }
        return val;
    };

    // ------------------------------------------------------------------
    // Footnotes (port of parse_footnotes)
    // ------------------------------------------------------------------

    /**
     * First pass: collect footnote definitions ("[^Key]: citation text")
     * into a map keyed by footnote key. Handles definitions wrapped over
     * multiple lines (continuation ends at a blank line or heading).
     * Returns { key: { text, url|null } }.
     */
    const parseFootnotes = (lines) => {
        const raw = {};
        let currentKey = null;
        for (const rawLine of lines) {
            const line = rawLine.trim();
            const m = FOOTNOTE_DEF_RE.exec(line);
            if (m) {
                currentKey = m[1];
                raw[currentKey] = m[2].trim();
            } else if (currentKey && line && !line.startsWith('#')) {
                raw[currentKey] += ' ' + line;   // wrapped definition line
            } else {
                currentKey = null;
            }
        }

        const footnotes = {};
        for (const [key, rawText] of Object.entries(raw)) {
            ANGLE_URL_RE.lastIndex = 0;
            const urlMatch = ANGLE_URL_RE.exec(rawText);
            const url = urlMatch ? urlMatch[1] : null;
            let text = rawText.replace(ANGLE_URL_RE, '');
            text = cleanText(text);
            // Tidy punctuation left behind by URL removal (", , 1994" etc.)
            text = text.replace(/\s*,\s*,/g, ',');
            text = text.replace(/\s+,/g, ',');
            text = text.replace(/^[ ,]+|[ ,]+$/g, '');
            footnotes[key] = { text, url };
        }
        return footnotes;
    };

    // ------------------------------------------------------------------
    // Markdown spec parser (port of parse_md_docs)
    // ------------------------------------------------------------------

    const NODE_HEADING_RE = /^###\s+`([^`]+)`\s*$/;
    const ANY_HEADING_RE = /^(#{1,6})\s+(.*)$/;
    const TABLE_SEP_RE = /^[-:\s]+$/;
    const HTML_FILLER_RE = /^(<p>\s*<\/p>|<p\s*\/>|<\/?p>|<br\s*\/?>)$/i;

    /**
     * Parses a MaterialX specification markdown TEXT (already fetched).
     * `repoFile` is the filename in the repo (e.g. 'MaterialX.PBRSpec.md');
     * same-file '#anchor' links resolve against it.
     *
     * Returns a map: node name -> LIST of entries (a node name can appear
     * more than once in a spec file, e.g. the color `mix` and the shader
     * `mix`). Entry shape matches the Python parser exactly:
     *   { description, notes, section, anchor, references, port_tables }
     */
    const parseMdDocs = (text, repoFile) => {
        currentRepoFile = (repoFile && repoFile.startsWith('MaterialX.'))
            ? repoFile : 'MaterialX.Specification.md';

        const docs = {};
        if (!text) return docs;
        const lines = text.split('\n');

        // First pass: footnote definitions for the whole file.
        const footnotes = parseFootnotes(lines);

        let currentSection = '';
        let lastAnchor = null;   // most recent <a id="..."> (spec deep-link)
        let node = null;         // entry currently being filled
        let currentTable = null; // table currently being filled
        let paraBuffer = [];     // lines of the paragraph being accumulated
        let inFence = false;     // inside a ``` fenced block
        let fenceInfo = '';
        let fenceLines = [];

        // Prose before the first table -> description; after -> notes.
        const targetParagraphs = () =>
            node.port_tables.length ? node._note_paras : node._desc_paras;

        const flushParagraph = () => {
            if (node !== null && paraBuffer.length) {
                const paragraph = cleanText(paraBuffer.join(' '));
                if (paragraph) targetParagraphs().push(paragraph);
            }
            paraBuffer = [];
        };

        // Ordered, de-duplicated footnote refs from all node text.
        const collectReferences = (entry) => {
            const texts = [entry.description, entry.notes];
            for (const table of entry.port_tables) {
                for (const row of Object.values(table.ports)) {
                    texts.push(...Object.values(row));
                }
            }
            const seen = new Set();
            const refs = [];
            for (const t of texts) {
                if (!t) continue;
                FOOTNOTE_REF_RE.lastIndex = 0;
                let m;
                while ((m = FOOTNOTE_REF_RE.exec(t)) !== null) {
                    const key = m[1];
                    if (!seen.has(key)) {
                        seen.add(key);
                        const info = footnotes[key] || {};
                        refs.push({ key, text: info.text || '', url: info.url != null ? info.url : null });
                    }
                }
            }
            return refs;
        };

        const closeNode = () => {
            flushParagraph();
            if (node !== null) {
                node.description = node._desc_paras.join('\n\n');
                node.notes = node._note_paras.join('\n\n');
                delete node._desc_paras;
                delete node._note_paras;
                node.references = collectReferences(node);
                const name = node._name;
                delete node._name;
                (docs[name] = docs[name] || []).push(node);
            }
            node = null;
            currentTable = null;
        };

        for (const rawLine of lines) {
            const line = rawLine.trim();

            // --- fenced blocks (```math ... ```) take priority over all else ---
            if (line.startsWith('```')) {
                if (!inFence) {
                    inFence = true;
                    fenceInfo = line.slice(3).trim().toLowerCase();
                    fenceLines = [];
                } else {
                    inFence = false;
                    if (node !== null) {
                        flushParagraph();
                        const content = fenceLines.map((l) => l.trim()).filter(Boolean).join(' ');
                        if (content) {
                            if (fenceInfo === 'math') {
                                // Display math: viewer renders $$...$$ blocks.
                                targetParagraphs().push('$$ ' + content + ' $$');
                            } else {
                                targetParagraphs().push(content);
                            }
                        }
                    }
                }
                continue;
            }
            if (inFence) { fenceLines.push(rawLine); continue; }

            if (!line) {
                // Blank line: paragraph and table boundaries.
                flushParagraph();
                currentTable = null;
                continue;
            }

            const heading = ANY_HEADING_RE.exec(line);
            if (heading) {
                const level = heading[1].length;
                const title = heading[2];
                const nodeMatch = NODE_HEADING_RE.exec(line);
                if (nodeMatch) {
                    // New node definition begins.
                    closeNode();
                    node = {
                        _name: nodeMatch[1].trim(),
                        _desc_paras: [],
                        _note_paras: [],
                        section: currentSection,
                        anchor: lastAnchor,  // GitHub deep-link id, may be null
                        port_tables: [],
                    };
                    lastAnchor = null;
                } else if (level >= 4 && node !== null) {
                    // "#### Reflectance Equations" etc.: a sub-heading INSIDE
                    // the current node's documentation. Keep it as content;
                    // the viewer styles paragraphs starting with '#'.
                    flushParagraph();
                    targetParagraphs().push('#'.repeat(level) + ' ' + cleanText(title));
                } else {
                    // #/##/### section headings end the current node.
                    closeNode();
                    if (level <= 2) currentSection = title.trim();
                }
                continue;
            }

            // HTML anchors carry the GitHub deep-link id for the heading
            // that follows (e.g. <a id="node-mix"> </a>). This MUST run
            // before the `node === null` early-continue below: a node's
            // anchor line always arrives BETWEEN nodes.
            if (line.startsWith('<a id=')) {
                const anchorMatch = /<a\s+id="([^"]+)"/.exec(line);
                if (anchorMatch) lastAnchor = anchorMatch[1];
                continue;
            }

            if (node === null) continue; // prose between sections

            if (HTML_FILLER_RE.test(line)) continue;

            if (line.startsWith('|')) {
                flushParagraph();
                const parts = line.split('|').map((p) => p.trim()).slice(1, -1);

                // Markdown table separator row (|---|---|...)
                const nonEmpty = parts.filter((p) => p);
                if (parts.length && nonEmpty.length &&
                    nonEmpty.every((p) => TABLE_SEP_RE.test(p))) {
                    continue;
                }

                if (currentTable === null) {
                    // First pipe row of a new table -> header row.
                    const headers = parts.map((h) => h.toLowerCase().split(' ').join('_'));
                    currentTable = { headers, ports: {} };
                    if (headers.indexOf('port') !== -1) {
                        node.port_tables.push(currentTable);
                    } else {
                        // Table without a Port column: consume but ignore.
                        currentTable.ignore = true;
                    }
                } else {
                    if (currentTable.ignore) continue;
                    const headers = currentTable.headers;
                    const rowData = {};
                    headers.forEach((h, i) => {
                        rowData[h] = cleanCellValue(i < parts.length ? parts[i] : '');
                    });
                    const portName = (rowData.port || '').trim();
                    delete rowData.port;
                    // Guard against a stray header row being read as data
                    // (e.g. two tables not separated by a blank line).
                    if (portName && portName.toLowerCase() !== 'port') {
                        currentTable.ports[portName] = rowData;
                    }
                }
            } else {
                // Plain prose: node description (before the first table) or
                // notes (after/between tables).
                paraBuffer.push(line);
            }
        }

        closeNode();

        // Drop internal 'ignore' flags on any kept tables (defensive;
        // ignored tables were never appended, but keep in case that changes).
        for (const entries of Object.values(docs)) {
            for (const entry of entries) {
                for (const table of entry.port_tables) delete table.ignore;
            }
        }

        return docs;
    };

    // ------------------------------------------------------------------
    // Doc resolution (port of resolve_doc)
    // ------------------------------------------------------------------

    /**
     * Pick the right doc entry for a nodedef when a node name appears more
     * than once in a spec file (e.g. color `mix` vs. shader `mix`).
     * Strategy: match the nodedef's nodegroup against the enclosing spec
     * section title; if no match, merge all entries so nothing is lost.
     */
    const resolveDoc = (entries, nodeGroup) => {
        if (!entries || !entries.length) return null;
        if (entries.length === 1) return Object.assign({}, entries[0]);

        const ng = (nodeGroup || '').toLowerCase();
        if (ng) {
            for (const entry of entries) {
                if ((entry.section || '').toLowerCase().indexOf(ng) !== -1) {
                    return Object.assign({}, entry);
                }
            }
        }

        // No confident match: merge everything so nothing is lost.
        const mergedRefs = [];
        const seenKeys = new Set();
        for (const entry of entries) {
            for (const ref of entry.references || []) {
                if (!seenKeys.has(ref.key)) {
                    seenKeys.add(ref.key);
                    mergedRefs.push(ref);
                }
            }
        }
        const firstAnchor = entries.find((e) => e.anchor);
        return {
            description: entries.filter((e) => e.description).map((e) => e.description).join('\n\n'),
            notes: entries.filter((e) => e.notes).map((e) => e.notes).join('\n\n'),
            section: entries.filter((e) => e.section).map((e) => e.section).join(' / '),
            references: mergedRefs,
            port_tables: entries.reduce((acc, e) => acc.concat(e.port_tables || []), []),
            anchor: firstAnchor ? firstAnchor.anchor : null,
        };
    };

    // ------------------------------------------------------------------
    // Spec file fetching (replaces reading local .md files)
    // ------------------------------------------------------------------

    // Parse each distinct file exactly once, keyed BY FILE so same-named
    // nodes in different specs never collide. Cached per tag.
    let specDocsPromise = null;
    let specDocsTag = null;

    const fetchSpecDocs = () => {
        const tag = MtlxSpecParser.SPEC_TAG;
        if (!specDocsPromise || specDocsTag !== tag) {
            specDocsTag = tag;
            specDocsPromise = Promise.all(SPEC_FILES.map((file) =>
                fetch(RAW_BASE() + file)
                    .then((r) => {
                        if (!r.ok) throw new Error('HTTP ' + r.status);
                        return r.text();
                    })
                    .then((text) => [file, parseMdDocs(text, file)])
                    .catch((err) => {
                        // Mirror the Python behavior for a missing file:
                        // warn and carry on with no docs from that spec.
                        console.warn(`spec-parser: could not fetch ${file}@${tag}:`, err);
                        return [file, {}];
                    })
            )).then((pairs) => {
                const byFile = {};
                for (const [file, docs] of pairs) byFile[file] = docs;
                // All fetches failed -> building the DB would silently mark
                // every node undocumented; better to fail loudly so callers
                // can fall back (e.g. to a pre-baked nodes.json).
                if (pairs.every(([, docs]) => !Object.keys(docs).length)) {
                    specDocsPromise = null; // allow retry
                    throw new Error('spec-parser: no spec files could be fetched/parsed');
                }
                return byFile;
            });
        }
        return specDocsPromise;
    };

    // ------------------------------------------------------------------
    // Node database (port of main): join spec docs with WASM nodedefs
    // ------------------------------------------------------------------

    const specFileForLibrary = (libraryName) => {
        const base = (libraryName || '').split('/')[0];
        if (base === 'pbrlib' || base === 'bxdf') return 'MaterialX.PBRSpec.md';
        if (base === 'nprlib') return 'MaterialX.NPRSpec.md';
        if (base === 'stdlib') return 'MaterialX.StandardNodes.md';
        return 'MaterialX.Specification.md';
    };

    // 'bxdf/lama' -> PBRSpec via base 'bxdf'; unmapped -> no docs.
    const docsForLibrary = (parsedByFile, libraryName) => {
        let file = MD_MAPPING[libraryName];
        if (file === undefined) file = MD_MAPPING[(libraryName || '').split('/')[0]];
        return (file && parsedByFile[file]) || {};
    };

    // Library name from a nodedef's source URI, exactly like the Python:
    // '<...>/libraries/<lib>[/<sub>]/file.mtlx' -> 'lib' or 'lib/sub';
    // no 'libraries' segment -> the parent directory's basename.
    const libraryFromSourceUri = (sourceUri) => {
        if (!sourceUri) return 'unknown';
        const parts = sourceUri.replace(/\\/g, '/').split('/');
        const libIndex = parts.indexOf('libraries');
        if (libIndex !== -1) {
            if (libIndex + 1 < parts.length) {
                let lib = parts[libIndex + 1].toLowerCase();
                if (libIndex + 2 < parts.length && !parts[libIndex + 2].endsWith('.mtlx')) {
                    lib = lib + '/' + parts[libIndex + 2].toLowerCase();
                }
                return lib;
            }
            return 'unknown';
        }
        // basename(dirname(uri))
        const dir = parts.slice(0, -1);
        const base = dir.length ? dir[dir.length - 1] : '';
        return base ? base.toLowerCase() : 'unknown';
    };

    // Local emscripten-vector helper so this file stays self-contained
    // (window.vecToArray from mtlx-engine.js is used when available).
    const toArray = (v) => {
        if (!v) return [];
        if (Array.isArray(v)) return v;
        if (typeof window !== 'undefined' && typeof window.vecToArray === 'function') {
            return window.vecToArray(v);
        }
        if (typeof v.size === 'function' && typeof v.get === 'function') {
            const out = [];
            for (let i = 0; i < v.size(); i++) out.push(v.get(i));
            return out;
        }
        return [];
    };

    let databasePromise = null;
    let databaseTag = null;

    /**
     * Build the full node database. Equivalent of spec_parser.py main(),
     * minus writing a file: resolves to the nodes.json object.
     *
     * opts.mxEnv: optional { mx, stdlib } (e.g. an already-awaited
     * getMxEnv() result); defaults to window.getMxEnv().
     * Cached: repeated calls return the same promise (per SPEC_TAG).
     */
    const buildNodeDatabase = (opts) => {
        opts = opts || {};
        const tag = MtlxSpecParser.SPEC_TAG;
        if (databasePromise && databaseTag === tag && !opts.mxEnv) return databasePromise;

        const envPromise = opts.mxEnv
            ? Promise.resolve(opts.mxEnv)
            : (typeof window !== 'undefined' && typeof window.getMxEnv === 'function'
                ? window.getMxEnv()
                : Promise.reject(new Error('spec-parser: getMxEnv is not available (load js/mtlx-engine.js first) and no mxEnv was passed')));

        const promise = Promise.all([fetchSpecDocs(), envPromise])
            .then(([parsedByFile, env]) => {
                const stdlib = env.stdlib;
                if (!stdlib || typeof stdlib.getNodeDefs !== 'function') {
                    throw new Error('spec-parser: stdlib.getNodeDefs is not bound in this MaterialX build');
                }

                // The nodedef walk below both ALLOCATES (vector marshaling —
                // stdlib.getNodeDefs() and friends — can grow the wasm heap)
                // and READS the shared stdlib, so it must be serialized
                // against concurrent shader generation/other wasm work (see
                // mxExclusive in js/mtlx-engine.js) — otherwise this
                // docs-page load races the first node preview's
                // generatePreviewSources call, one of the sources of the
                // irregular "memory access out of bounds" wasm errors. The
                // spec markdown fetch/parse above (parsedByFile) never
                // touches wasm, so it stays OUTSIDE the lock — only the walk
                // itself (fully synchronous: no awaits in the callback
                // below) goes through mxExclusive.
                return window.mxExclusive(() => {
                    const nodeDatabase = {};
                    let unknownLibs = 0, total = 0;

                    for (const nodeDef of toArray(stdlib.getNodeDefs())) {
                        const category = nodeDef.getNodeString();
                        if (!category) continue;
                        total++;

                        const nodeGroup = nodeDef.getNodeGroup() || 'uncategorized';
                        const sourceUri = (typeof nodeDef.getSourceUri === 'function')
                            ? nodeDef.getSourceUri() : '';
                        const libraryName = libraryFromSourceUri(sourceUri);
                        if (libraryName === 'unknown') unknownLibs++;

                        if (!nodeDatabase[libraryName]) nodeDatabase[libraryName] = {};
                        if (!nodeDatabase[libraryName][nodeGroup]) nodeDatabase[libraryName][nodeGroup] = {};

                        // Look up documentation in THIS library's spec file only.
                        const libDocs = docsForLibrary(parsedByFile, libraryName);
                        let nodeInfo = resolveDoc(libDocs[category], nodeGroup);
                        if (nodeInfo === null) {
                            nodeInfo = {
                                description: 'No documentation available.',
                                notes: '',
                                section: '',
                                references: [],
                                port_tables: [],
                            };
                        }

                        // Direct link into the official spec on GitHub. Prefer the
                        // anchor parsed from the MD (exact); fall back to the
                        // observed hyphenated convention (oren_nayar_diffuse_bsdf
                        // -> #node-oren-nayar-diffuse-bsdf).
                        const anchor = nodeInfo.anchor || ('node-' + category.split('_').join('-'));
                        delete nodeInfo.anchor;
                        nodeInfo.spec_url = BLOB_BASE() + specFileForLibrary(libraryName) + '#' + anchor;

                        nodeDatabase[libraryName][nodeGroup][category] = nodeInfo;
                    }

                    // The JS build should report source URIs from its virtual
                    // filesystem; if it didn't, every node collapsed into
                    // 'unknown' and no docs matched — worth a loud warning.
                    if (total && unknownLibs === total) {
                        console.warn('spec-parser: no nodedef reported a source URI — library classification (and therefore all documentation matching) failed.');
                    }

                    return nodeDatabase;
                });
            });

        if (!opts.mxEnv) {
            databasePromise = promise.catch((err) => {
                databasePromise = null; // allow retry after transient failures
                throw err;
            });
            databaseTag = tag;
            return databasePromise;
        }
        return promise;
    };

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------
    const MtlxSpecParser = {
        // Reassignable: MtlxSpecParser.SPEC_TAG = 'v1.40.0' before the
        // first buildNodeDatabase() call retargets everything (fetches,
        // resolved links, spec_url) to another tag/branch.
        SPEC_TAG,
        SPEC_FILES,
        cleanText,
        cleanCellValue,
        parseFootnotes,
        parseMdDocs,
        resolveDoc,
        specFileForLibrary,
        libraryFromSourceUri,
        fetchSpecDocs,
        buildNodeDatabase,
    };

    if (typeof window !== 'undefined') window.MtlxSpecParser = MtlxSpecParser;
    if (typeof module !== 'undefined' && module.exports) module.exports = MtlxSpecParser; // node (tests)
})();
