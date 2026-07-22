// port-tables.jsx — port-table data helpers and renderers: normalizing
// spec port data into tables, deriving signature labels/preview types,
// and the PortTable / NodeDefPortsTable components. The nodedef-walking
// machinery that used to live here (defInputs/defOutputs/safeType,
// nodeDefSigKey, groupDefVersions, dedupeDefsBySignature,
// buildAutoTablesFromDefs) has moved to build-land
// (scripts/lib/nodedef-extract.mjs, run by scripts/build-nodelib.mjs) —
// this file now only renders data that arrives pre-computed in
// js/gen/nodelib-index.json (see js/docs-app.jsx). PortTable uses
// MathText (js/docs/rich-text.jsx, loaded before this file). Loaded as
// text/babel; Babel executes each file in its own function scope, so the
// public API is exported onto window at the bottom.

        // Turn a normalized header key back into a display label,
        // e.g. "accepted_values" -> "Accepted Values".
        const headerLabel = (key) =>
            key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

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
            port: 'w-52',
            type: 'w-48',
            default: 'w-40',
            accepted_values: 'w-44',
            // description gets whatever space is left
        };
        // Same widths in rem, used to compute each table's minimum width on
        // small screens (fixed columns + a readable minimum for description).
        const COL_REM = { port: 13, type: 12, default: 10, accepted_values: 11 };
        const DESCRIPTION_MIN_REM = 8;
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

        // Concrete MaterialX type to PREVIEW for a signature table: resolve
        // the output-type tokens (falling back to input tokens when the
        // table has no output row), expand the spec's family placeholders
        // (colorN → color3, ...), and prefer a renderable type. Returns
        // null when nothing can be derived — the preview then auto-picks.
        const SIG_CONCRETE_TOKEN = {
            colorn: 'color3', vectorn: 'vector3', matrixnn: 'matrix33',
        };
        const SIG_PREVIEW_PREFERENCE = [
            'surfaceshader', 'BSDF', 'color3', 'float', 'vector3', 'color4',
            'vector2', 'vector4', 'integer', 'boolean',
        ];
        const signaturePreviewType = (table) => {
            const ports = (table && table.ports) || {};
            const names = Object.keys(ports);
            let tokens = uniqTypeTokens(names
                .filter(n => isOutputPort(n, ports[n]))
                .map(n => resolveType(ports, n)));
            if (!tokens.length) {
                tokens = uniqTypeTokens(names.map(n => resolveType(ports, n)));
            }
            const concrete = tokens.map(t => SIG_CONCRETE_TOKEN[t.toLowerCase()] || t);
            for (const pref of SIG_PREVIEW_PREFERENCE) {
                const hit = concrete.find(c => c.toLowerCase() === pref.toLowerCase());
                if (hit) return pref;
            }
            return concrete[0] || null;
        };

        // Which markdown table documents the signature with this output
        // type? Spec write-ups that cover several signatures under one
        // heading (e.g. `multiply`: scalar/vector table + matrixNN table)
        // author family tokens ('float, colorN or vectorN', 'matrixNN')
        // rather than splitting per concrete type. Expand those tokens the
        // same way signaturePreviewType does and pick the first table whose
        // OUTPUT port types (resolving "Same as X" chains via resolveType,
        // and falling back to ALL ports when a table has no output row)
        // cover the wanted concrete type.
        const SIG_FAMILY_EXPANSIONS = {
            colorn: ['color2', 'color3', 'color4'],
            vectorn: ['vector2', 'vector3', 'vector4'],
            matrixnn: ['matrix33', 'matrix44'],
        };
        const expandSigToken = (tok) => {
            const key = (tok || '').trim().toLowerCase();
            return SIG_FAMILY_EXPANSIONS[key] || [key];
        };
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

        // `defaultsOverride`: an optional {portName: valueString} map — used
        // when the docs page's Version picker (index.html) selects a
        // non-default nodedef version. The spec's own "default" column
        // reflects whichever version the write-up was authored against
        // (usually the current default); switching versions overrides just
        // that cell with the SELECTED version's live nodedef default,
        // leaving descriptions/types untouched.
        function PortTable({ table, columns, refs, defaultsOverride, typesOverride }) {
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
                                    {columns.map(col => {
                                        const overridden = col === 'default' && defaultsOverride
                                            && Object.prototype.hasOwnProperty.call(defaultsOverride, portName);
                                        const typeOverridden = col === 'type' && typesOverride
                                            && Object.prototype.hasOwnProperty.call(typesOverride, portName);
                                        const cellText = overridden ? defaultsOverride[portName]
                                            : typeOverridden ? typesOverride[portName]
                                            : (portData[col] || '');
                                        return (
                                            <td key={col} className={`px-4 py-3 align-top ${CELL_STYLES[col] || ''}`}>
                                                {col === 'port'
                                                    ? portName
                                                    : <MathText text={cellText} refs={refs} />}
                                            </td>
                                        );
                                    })}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            );
        }

        // Rows: [{name, kind, types[], value, enums}], pregenerated by
        // scripts/build-nodelib.mjs's buildDefPorts port
        // (scripts/lib/nodedef-extract.mjs) from the union of every
        // matching nodedef's inputs/outputs — no live WASM read.
        const NodeDefPortsTable = ({ rows }) => {
            rows = rows || [];
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
        // headerLabel, the column-layout consts (CANONICAL_ORDER etc.),
        // and the signature-label helper cluster (SAME_AS_RE, resolveType,
        // isOutputPort, uniqTypeTokens, signatureLabel, SIG_CONCRETE_TOKEN,
        // SIG_PREVIEW_PREFERENCE, SIG_FAMILY_EXPANSIONS, expandSigToken)
        // have no consumers outside this file (checked repo-wide,
        // word-boundary grep) — kept as declarations (used internally by
        // PortTable/unionColumns/signaturePreviewType/pickTableForType) but
        // omitted from the export list. The nodedef-walking helpers
        // (defInputs, defOutputs, safeType, nodeDefSigKey, groupDefVersions,
        // dedupeDefsBySignature, buildAutoTablesFromDefs) no longer live in
        // this file at all — see scripts/lib/nodedef-extract.mjs.
        Object.assign(window, {
            getPortTables, isUndocumented,
            unionColumns, signaturePreviewType, pickTableForType, PortTable,
            NodeDefPortsTable,
        });
