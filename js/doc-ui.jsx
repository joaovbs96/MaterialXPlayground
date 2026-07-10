// doc-ui.jsx — presentational components + helpers for the MaterialX
// node documentation browser. Loaded as text/babel; Babel executes each
// file in its own function scope, so the public API is exported onto
// window at the bottom. Load AFTER mtlx-engine.js (NodeDefPortsTable
// uses getMxEnv/vecToArray).

        // Project links. The shared header (js/site-header.js) is the single
        // source of truth when it's loaded; the literals below are fallbacks
        // so doc-ui also works standalone.
        const REPO_URL = (window.SITE_LINKS && window.SITE_LINKS.repo) || 'https://github.com/joaovbs96/MaterialXNodeDocs';
        const ISSUES_URL = (window.SITE_LINKS && window.SITE_LINKS.issues) || (REPO_URL + '/issues');
        const SPEC_DOCS_URL = (window.SITE_LINKS && window.SITE_LINKS.spec) || 'https://github.com/AcademySoftwareFoundation/MaterialX/tree/main/documents/Specification';

        // Permalinks: a node is addressed by lib/group/name in the URL hash,
        // e.g. #/stdlib/math/add — hash routing needs no server config, so it
        // works as-is on GitHub Pages. These convert between a selection and
        // the hash both ways.
        const selToHash = (sel) =>
            sel ? '#/' + [sel.lib, sel.group, sel.name].map(encodeURIComponent).join('/') : '';
        const hashToSel = (data, hash) => {
            if (!data || !hash) return null;
            const body = hash.replace(/^#\/?/, '');
            if (!body) return null;
            const parts = body.split('/').map((s) => { try { return decodeURIComponent(s); } catch (e) { return s; } });
            if (parts.length < 3) return null;
            const name = parts.slice(2).join('/'); // names shouldn't contain '/', but be safe
            const [lib, group] = parts;
            if (data[lib] && data[lib][group] && data[lib][group][name]) {
                return { lib, group, name, info: data[lib][group][name] };
            }
            return null;
        };

        // Turn a normalized header key back into a display label,
        // e.g. "accepted_values" -> "Accepted Values".
        const headerLabel = (key) =>
            key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

        // ------------------------------------------------------------------
        // Rich text: node prose may contain $inline$ / $$display$$ math
        // spans (preserved verbatim by the parser) and footnote references
        // like [^Oren1994]. Math renders via KaTeX; footnote refs render as
        // superscript numbered links into the node's reference list. If
        // KaTeX failed to load or a span doesn't parse, the raw text shows
        // instead so nothing is ever lost.
        // ------------------------------------------------------------------
        const RICH_SPLIT_RE = /(\$\$[^$]+\$\$|\$[^$\n]+\$|\[\^[^\]\s]+\])/g;
        const FOOTNOTE_RE = /^\[\^([^\]\s]+)\]$/;

        // Inline styling for plain prose: numeric vectors like
        // [0.001, 0.001, 0.01] and MaterialX node names in angle brackets like
        // <image> render in the monospace table font (a vector needs >=2
        // comma-separated numbers; an angle token must start with a letter, so
        // "a < b" isn't matched).
        const INLINE_STYLE_RE = /(\[\s*[+-]?\d[\d.eE+-]*(?:\s*,\s*[+-]?\d[\d.eE+-]*)+\s*\]|<[A-Za-z_][\w.:-]*>)/g;
        const MONO = 'font-mono text-[0.9em] bg-gray-900/70 border border-gray-700 rounded px-1 py-0.5';
        const styleInlinePlain = (text, kp) => {
            const parts = String(text).split(INLINE_STYLE_RE);
            return parts.map((part, i) => {
                if (!part) return null;
                if (part[0] === '[' && part[part.length - 1] === ']') {
                    return <code key={kp + 'v' + i} className={MONO + ' text-amber-300'}>{part}</code>;
                }
                if (part[0] === '<' && part[part.length - 1] === '>') {
                    // Cross-reference: a <nodename> token that matches a node in
                    // the loaded database navigates to it in-app. Unknown tokens
                    // (ports, placeholders like <geomname>) stay plain chips.
                    const inner = part.slice(1, -1);
                    const idx = window.__mtlxNodeIndex;
                    const key = /^[A-Za-z0-9_-]+$/.test(inner) ? inner.replace(/[-_]/g, '').toLowerCase() : null;
                    if (key && idx && idx[key]) {
                        return (
                            <code
                                key={kp + 'n' + i}
                                onClick={() => window.dispatchEvent(new CustomEvent('mtlx-open-node', { detail: { key } }))}
                                title={'Open node: ' + idx[key].name}
                                className={MONO + ' text-blue-300 underline decoration-blue-500/40 cursor-pointer hover:text-blue-200'}
                            >{part}</code>
                        );
                    }
                    return <code key={kp + 'n' + i} className={MONO + ' text-blue-300'}>{part}</code>;
                }
                return <React.Fragment key={kp + 't' + i}>{part}</React.Fragment>;
            });
        };
        // Markdown links preserved by the parser: [text](https://...).
        // Links into a spec's #node-... anchor open the node IN-APP when we
        // know it (via the mtlx-open-node event the App listens for); anything
        // else opens the official page in a new tab.
        const DOC_LINK_RE = /\[([^\]^][^\]]*)\]\((https?:[^)\s]+)\)/g;
        const SPEC_NODE_ANCHOR_RE = /documents\/Specification\/[^#)\s]*#(node-[A-Za-z0-9_-]+)/;
        const openDocLink = (url) => {
            const m = url.match(SPEC_NODE_ANCHOR_RE);
            if (m) {
                // Anchor conventions vary (hyphenated vs squashed); normalize
                // both sides by dropping separators and let the App resolve it.
                const key = m[1].slice(5).replace(/[-_]/g, '').toLowerCase();
                window.dispatchEvent(new CustomEvent('mtlx-open-node', { detail: { key, url } }));
                return;
            }
            window.open(url, '_blank', 'noopener');
        };
        const styleInline = (text, kp) => {
            const src = String(text);
            const out = [];
            let last = 0, m, i = 0;
            DOC_LINK_RE.lastIndex = 0;
            while ((m = DOC_LINK_RE.exec(src)) !== null) {
                if (m.index > last) out.push(...styleInlinePlain(src.slice(last, m.index), kp + 'p' + i + '-'));
                const url = m[2];
                out.push(
                    <a
                        key={kp + 'l' + i}
                        href={url}
                        onClick={(e) => { e.preventDefault(); openDocLink(url); }}
                        className="text-blue-400 hover:text-blue-300 underline decoration-blue-500/40 cursor-pointer"
                        title={url}
                    >{m[1]}</a>
                );
                last = m.index + m[0].length;
                i++;
            }
            if (last < src.length) out.push(...styleInlinePlain(src.slice(last), kp + 'e-'));
            return out;
        };

        function MathText({ text, refs }) {
            if (text == null || text === '') return null;
            const parts = String(text).split(RICH_SPLIT_RE);
            return (
                <React.Fragment>
                    {parts.map((part, i) => {
                        if (!part) return null;

                        // Footnote reference -> superscript link [n]
                        const fn = part.match(FOOTNOTE_RE);
                        if (fn) {
                            const ref = refs && refs[fn[1]];
                            if (ref) {
                                const marker = `[${ref.n}]`;
                                return (
                                    <sup key={i} className="text-blue-400">
                                        {ref.url ? (
                                            <a href={ref.url} target="_blank" rel="noreferrer"
                                               title={ref.text || fn[1]}
                                               className="hover:underline">{marker}</a>
                                        ) : (
                                            <span title={ref.text || fn[1]}>{marker}</span>
                                        )}
                                    </sup>
                                );
                            }
                            return <span key={i}>{part}</span>; // unknown key: keep raw
                        }

                        // Math span -> KaTeX
                        const isDisplay = part.length > 4 && part.startsWith('$$') && part.endsWith('$$');
                        const isInline = !isDisplay && part.length > 2 && part.startsWith('$') && part.endsWith('$');
                        if ((isDisplay || isInline) && window.katex) {
                            const src = isDisplay ? part.slice(2, -2) : part.slice(1, -1);
                            try {
                                const html = window.katex.renderToString(src, {
                                    displayMode: isDisplay,
                                    throwOnError: true,
                                });
                                return <span key={i} dangerouslySetInnerHTML={{ __html: html }} />;
                            } catch (err) {
                                return <span key={i}>{part}</span>;
                            }
                        }
                        return <span key={i}>{styleInline(part, i + '-')}</span>;
                    })}
                </React.Fragment>
            );
        }

        // Renders multi-paragraph prose (description / notes): paragraphs
        // are separated by \n\n; a paragraph starting with '#'s is a
        // sub-heading (e.g. "#### Reflectance Equations"); a standalone
        // "$$...$$" paragraph becomes a centered display equation.
        const SUBHEADING_RE = /^#{1,6}\s+(.*)$/;

        function RichBlocks({ text, refs, className }) {
            if (!text) return null;
            return (
                <div className={className}>
                    {text.split('\n\n').map((block, i) => {
                        const h = block.match(SUBHEADING_RE);
                        if (h) {
                            return (
                                <h4 key={i} className="text-sm font-semibold text-gray-200 uppercase tracking-wider mt-5 mb-2">
                                    {h[1]}
                                </h4>
                            );
                        }
                        return (
                            <p key={i} className="mb-3">
                                <MathText text={block} refs={refs} />
                            </p>
                        );
                    })}
                </div>
            );
        }

        // Normalize a node entry so the viewer supports both the new
        // schema ({ port_tables: [{headers, ports}, ...] }) and the old
        // one ({ ports: {...} }).
        const getPortTables = (nodeInfo) => {
            if (Array.isArray(nodeInfo.port_tables)) return nodeInfo.port_tables;
            if (nodeInfo.ports && Object.keys(nodeInfo.ports).length > 0) {
                const firstRow = Object.values(nodeInfo.ports)[0] || {};
                return [{ headers: ['port', ...Object.keys(firstRow)], ports: nodeInfo.ports }];
            }
            return [];
        };

        // Build port tables (same shape the viewer renders) directly from a
        // node's MaterialX nodedefs, for nodes with NO spec documentation. One
        // table per nodedef (overload/signature); inputs first, then outputs.
        // `vecToArray` normalizes the MaterialX vector<->array binding.
        const buildAutoTablesFromDefs = (defs) => {
            const tables = [];
            for (const def of defs) {
                const ports = {};
                let anyEnum = false;
                const inputs = vecToArray(def.getActiveInputs ? def.getActiveInputs()
                    : (def.getInputs ? def.getInputs() : null));
                for (const inp of inputs) {
                    let dv = '', enumv = '';
                    try { dv = (inp.getValueString && inp.getValueString()) || ''; } catch (e) { /* none */ }
                    try { enumv = (inp.getAttribute && inp.getAttribute('enum')) || ''; } catch (e) { /* none */ }
                    const row = { description: '', type: inp.getType(), default: dv };
                    if (enumv) { row.accepted_values = enumv; anyEnum = true; }
                    ports[inp.getName()] = row;
                }
                const outs = vecToArray(def.getActiveOutputs ? def.getActiveOutputs()
                    : (def.getOutputs ? def.getOutputs() : null));
                if (outs.length === 0) {
                    let t = 'output';
                    try { t = def.getType(); } catch (e) { /* keep */ }
                    ports['out'] = { description: 'Output', type: t, default: '' };
                } else {
                    for (const out of outs) {
                        ports[out.getName()] = { description: 'Output', type: out.getType(), default: '' };
                    }
                }
                if (Object.keys(ports).length) {
                    const headers = anyEnum
                        ? ['port', 'description', 'type', 'default', 'accepted_values']
                        : ['port', 'description', 'type', 'default'];
                    tables.push({ headers, ports });
                }
            }
            return tables;
        };

        // A node counts as undocumented when it has no port tables, no
        // notes, and no real description (the parser emits the fallback
        // string "No documentation available." for spec-less nodedefs).
        const isUndocumented = (info) => {
            if (getPortTables(info).length > 0) return false;
            if (info.notes) return false;
            const desc = (info.description || '').trim();
            return desc === '' || desc === 'No documentation available.';
        };

        // ------------------------------------------------------------------
        // Shared column layout: every table of a node renders the SAME
        // columns in the SAME order with FIXED widths, so stacked tables
        // line up instead of each computing its own widths.
        // ------------------------------------------------------------------
        const CANONICAL_ORDER = ['port', 'description', 'type', 'default', 'accepted_values'];
        const COL_WIDTHS = {
            port: 'w-40',
            type: 'w-48',
            default: 'w-36',
            accepted_values: 'w-44',
            // description gets whatever space is left
        };
        // Same widths in rem, used to compute each table's minimum width on
        // small screens (fixed columns + a readable minimum for description).
        const COL_REM = { port: 10, type: 12, default: 9, accepted_values: 11 };
        const DESCRIPTION_MIN_REM = 14;
        const EXTRA_COL_REM = 8;
        const CELL_STYLES = {
            port: 'font-medium text-blue-400 font-mono break-words',
            type: 'font-mono text-xs text-purple-400 break-words',
            default: 'font-mono text-xs text-yellow-300 break-words',
            accepted_values: 'font-mono text-xs text-green-400 break-words',
        };

        const unionColumns = (tables) => {
            const seen = new Set();
            tables.forEach(t => (t.headers || []).forEach(h => seen.add(h)));
            tables.forEach(t => Object.values(t.ports || {}).forEach(row =>
                Object.keys(row).forEach(k => seen.add(k))
            ));
            seen.add('port');
            const ordered = CANONICAL_ORDER.filter(c => seen.has(c));
            [...seen].sort().forEach(c => { if (!CANONICAL_ORDER.includes(c)) ordered.push(c); });
            return ordered;
        };

        // ------------------------------------------------------------------
        // Signature labels: derive "inputs → output" type summaries from
        // each table, resolving "Same as <port>" references, so headings
        // read e.g. "surfaceshader" or "boolean → float, integer"
        // ------------------------------------------------------------------
        const SAME_AS_RE = /^same as\s+(\S+?)(?:\s+or\s+(.+))?$/i;

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

        const isOutputPort = (name, row) =>
            name === 'out' || /^output\b/i.test(row.description || '');

        // Split resolved type strings ("colorN, vectorN") into individual
        // tokens and dedupe at token level, so "Same as in1 or float" on a
        // matrixNN input yields "matrixNN, float" rather than
        // "matrixNN, matrixNN, float".
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

        function PortTable({ table, columns, refs }) {
            // Minimum table width (small screens only, via the .port-table
            // media rule): sum of the fixed column widths plus a readable
            // minimum for the flexible description column. Below this the
            // wrapper scrolls horizontally instead of crushing columns.
            const minRem = columns.reduce(
                (sum, c) => sum + (c === 'description' ? DESCRIPTION_MIN_REM : (COL_REM[c] || EXTRA_COL_REM)),
                0
            );
            return (
                <div className="overflow-x-auto rounded-lg border border-gray-700">
                    <table
                        style={{ '--tbl-min': `${minRem}rem` }}
                        className="port-table w-full table-fixed text-sm text-left text-gray-300"
                    >
                        <colgroup>
                            {columns.map(col => (
                                <col key={col} className={COL_WIDTHS[col] || ''} />
                            ))}
                        </colgroup>
                        <thead className="text-xs text-gray-400 uppercase bg-gray-900 border-b border-gray-700">
                            <tr>
                                {columns.map(col => (
                                    <th key={col} scope="col" className="px-4 py-3">{headerLabel(col)}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {Object.entries(table.ports).map(([portName, portData]) => (
                                <tr className="border-b border-gray-700 last:border-b-0 hover:bg-gray-750" key={portName}>
                                    {columns.map(col => (
                                        <td key={col} className={`px-4 py-3 align-top ${CELL_STYLES[col] || ''}`}>
                                            {col === 'port'
                                                ? portName
                                                : <MathText text={portData[col] || ''} refs={refs} />}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            );
        }

        // ------------------------------------------------------------------
        // MaterialX 3D Preview Component
        // ------------------------------------------------------------------
        // IMPORTANT: load ONLY JsMaterialXGenShader.js. It is a SUPERSET of
        // JsMaterialXCore.js (core document model + shader generation). If you
        // also load and initialize JsMaterialXCore, embind tries to register
        // the shared C++ types (VectorBase, Vector2, ...) a second time and
        // throws "Cannot register public name 'VectorBase' twice". One module.
        //
        // The whole MaterialX runtime is initialized ONCE and cached at module
        // scope: re-initializing per node select would re-download the wasm and
        // reload the standard libraries every time.
        // ---- Official spec deep-links ----
        // Prefer a parser-provided `spec_url` (new JSON schema regenerated
        // from spec_parser.py). For older JSON, derive it: the spec file
        // follows the node's library, and the heading anchors in the spec MD
        // follow the hyphenated "node-<name>" convention observed in the MD
        // (e.g. oren_nayar_diffuse_bsdf → #node-oren-nayar-diffuse-bsdf).
        // GitHub resolves those fragments to user-content-prefixed ids.
        const SPEC_BASE = 'https://github.com/AcademySoftwareFoundation/MaterialX/blob/main/documents/Specification/';
        const specFileForLib = (lib) => {
            const base = (lib || '').split('/')[0];
            if (base === 'pbrlib' || base === 'bxdf') return 'MaterialX.PBRSpec.md';
            if (base === 'nprlib') return 'MaterialX.NPRSpec.md';
            if (base === 'stdlib') return 'MaterialX.StandardNodes.md';
            return 'MaterialX.Specification.md';
        };
        const specUrlForNode = (node) => {
            if (node.info && node.info.spec_url) return node.info.spec_url;
            return SPEC_BASE + specFileForLib(node.lib) + '#node-' + node.name.replace(/_/g, '-');
        };

        // Parse `uniform <type> <name>;` declarations out of generated GLSL so
        // we can bind by the shader's ACTUAL names (which vary by MaterialX
        const NodeDefPortsTable = ({ nodeName }) => {
            const [rows, setRows] = React.useState(null); // null = loading
            React.useEffect(() => {
                let alive = true;
                setRows(null);
                getMxEnv().then(({ stdlib }) => {
                    if (!alive) return;
                    const byName = {};
                    const order = [];
                    const record = (el, kindLabel) => {
                        const nm = el.getName();
                        const key = kindLabel + ':' + nm;
                        let ty = '';
                        try { const t = el.getType && el.getType(); ty = (t && t.getName) ? t.getName() : String(t || ''); } catch (e) { ty = ''; }
                        let val = '';
                        try { val = (el.getValueString && el.getValueString()) || ''; } catch (e) { val = ''; }
                        let en = '';
                        try { en = (el.getAttribute && el.getAttribute('enum')) || ''; } catch (e) { en = ''; }
                        if (!byName[key]) {
                            byName[key] = { name: nm, kind: kindLabel, types: [], value: val, enums: en };
                            order.push(key);
                        }
                        if (ty && byName[key].types.indexOf(ty) === -1) byName[key].types.push(ty);
                    };
                    try {
                        for (const def of vecToArray(stdlib.getMatchingNodeDefs(nodeName))) {
                            for (const inp of vecToArray(def.getInputs ? def.getInputs() : null)) record(inp, 'input');
                            for (const out of vecToArray(def.getOutputs ? def.getOutputs() : null)) record(out, 'output');
                        }
                    } catch (e) { /* nodedef read is best-effort */ }
                    if (alive) setRows(order.map((k) => byName[k]));
                }).catch(() => { if (alive) setRows([]); });
                return () => { alive = false; };
            }, [nodeName]);
            if (rows === null) {
                return <div className="text-sm text-gray-500 italic">Reading ports from the nodedef…</div>;
            }
            if (!rows.length) {
                return (
                    <div className="bg-gray-900 border border-gray-700 rounded p-4 text-sm text-gray-500 italic">
                        No specific ports defined or extracted for this node.
                    </div>
                );
            }
            return (
                <div>
                    <div className="text-xs text-amber-400/80 bg-amber-950/30 border border-amber-800/40 rounded px-3 py-2 mb-3">
                        {'\u26A0'} This table was generated automatically from the node's nodedef in the standard library — it is not part of the official specification documents.
                    </div>
                    <div className="overflow-x-auto bg-gray-900 border border-gray-700 rounded-lg">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-xs uppercase tracking-wider text-gray-400 border-b border-gray-700">
                                    <th className="px-3 py-2">Port</th>
                                    <th className="px-3 py-2">Kind</th>
                                    <th className="px-3 py-2">Type(s)</th>
                                    <th className="px-3 py-2">Default</th>
                                    <th className="px-3 py-2">Accepted values</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((r) => (
                                    <tr key={r.kind + ':' + r.name} className="border-b border-gray-800 last:border-0 align-top">
                                        <td className="px-3 py-2 font-mono text-blue-300">{r.name}</td>
                                        <td className="px-3 py-2 text-gray-400">{r.kind}</td>
                                        <td className="px-3 py-2 font-mono text-purple-300">{r.types.join(', ')}</td>
                                        <td className="px-3 py-2 font-mono text-amber-300 break-all">{r.value}</td>
                                        <td className="px-3 py-2 font-mono text-green-300 break-words">{r.enums}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            );
        };


        // ---- public API ----
        Object.assign(window, {
            REPO_URL, ISSUES_URL, SPEC_DOCS_URL,
            selToHash, hashToSel, headerLabel,
            styleInlinePlain, styleInline, openDocLink,
            MathText, RichBlocks,
            getPortTables, buildAutoTablesFromDefs, isUndocumented,
            CANONICAL_ORDER, COL_WIDTHS, COL_REM, DESCRIPTION_MIN_REM, EXTRA_COL_REM, CELL_STYLES,
            unionColumns, signatureLabel, PortTable,
            specFileForLib, specUrlForNode, NodeDefPortsTable,
        });
