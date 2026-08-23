// port-tables.jsx — port-table data helpers and renderers: normalizes
// spec port data into tables and derives signature labels/preview
// types for PortTable / NodeDefPortsTable. Nodedef-walking now lives
// in scripts/lib/nodedef-extract.mjs (build-land); this file only
// renders data pre-computed into js/gen/nodelib-index.json. Requires
// MathText (js/docs/rich-text.jsx) loaded first. Loaded as text/babel
// in its own function scope, so the public API is exported onto
// window at the bottom.

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

        // Shared column layout: every port table renders the same
        // columns in the same order with fixed widths, so stacked
        // tables for a node line up instead of each sizing itself.
        const CANONICAL_ORDER = ['port', 'description', 'type', 'default', 'accepted_values'];
        const COL_WIDTHS = {
            port: 'w-60',
            type: 'w-48',
            default: 'w-40',
            accepted_values: 'w-44',
            // description gets whatever space is left
        };
        // Same widths in rem, used to compute each table's minimum
        // width on small screens. port gets extra headroom for long
        // identifiers since that column is whitespace-nowrap.
        const COL_REM = { port: 15, type: 12, default: 10, accepted_values: 11 };
        const DESCRIPTION_MIN_REM = 8;
        const EXTRA_COL_REM = 8;
        const CELL_STYLES = {
            port: 'font-medium text-gray-100 font-mono whitespace-nowrap',
            type: 'font-mono text-xs text-gray-200 break-words',
            default: 'font-mono text-xs text-gray-300 break-words',
            accepted_values: 'font-mono text-xs text-gray-400 break-words',
        };

        // Type column dot: an exact TYPE_COLORS key gets the legend's own
        // dot + neutral label; family tokens (colorN) or prose ("Same as
        // ...") fall back to an italic neutral label with no dot.
        const TypeCell = ({ text }) => {
            if (!text) return null;
            const tokens = String(text).split(',').map(t => t.trim()).filter(Boolean);
            return tokens.map((tok, i) => (
                <React.Fragment key={tok + i}>
                    {i > 0 ? ', ' : ''}
                    {Object.prototype.hasOwnProperty.call(TYPE_COLORS, tok)
                        ? (
                            <span className="whitespace-nowrap">
                                <span
                                    className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                                    style={{ background: typeColor(tok) }}
                                />
                                {tok}
                            </span>
                        )
                        : <span className="italic text-gray-400">{tok}</span>}
                </React.Fragment>
            ));
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

        // Signature labels: derive "inputs → output" type summaries
        // from each table, resolving "Same as <port>" references, so
        // headings read e.g. "boolean → float, integer".
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

        // Splits resolved type strings into tokens and dedupes at the
        // token level, so e.g. "Same as in1 or float" on a matrixNN
        // input yields "matrixNN, float", not a duplicated token.
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

        // Concrete type to preview for a signature table: resolve
        // output tokens (falling back to input), expand family
        // placeholders, and prefer a renderable type; null means auto-pick.
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

        // Picks the table whose output types cover `type`, expanding
        // family tokens (e.g. 'matrixNN') the way signaturePreviewType
        // does, since spec write-ups group several signatures per table.
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

        // `defaultsOverride`: optional {portName: value} map from the
        // Version picker; overrides just the "default" cell with the
        // selected version's live value, leaving spec prose untouched.
        //
        // React.memo: js/docs-app.jsx stabilizes these props, so this
        // skips re-rendering (and re-running per-cell MathText) on
        // unrelated renders, e.g. sidebar-search keystrokes.
        const PortTable = React.memo(function PortTable({ table, columns, refs, defaultsOverride, typesOverride }) {
            // Sum of fixed column widths plus a readable minimum for
            // description; the .port-table media rule uses this so small
            // screens scroll horizontally instead of crushing columns.
            const minRem = columns.reduce(
                (sum, c) => sum + (c === 'description' ? DESCRIPTION_MIN_REM : (COL_REM[c] || EXTRA_COL_REM)),
                0
            );
            return (
                <div className="overflow-x-auto rounded-xl border border-gray-700">
                    <table
                        style={{ '--tbl-min': `${minRem}rem` }}
                        className="port-table w-full table-auto text-sm text-left text-gray-300"
                    >
                        <colgroup>
                            {columns.map(col => (
                                <col key={col} className={COL_WIDTHS[col] || ''} />
                            ))}
                        </colgroup>
                        <thead className="text-[10px] font-semibold uppercase tracking-[0.08em] text-gray-500 bg-gray-900 border-b border-gray-700">
                            <tr>
                                {columns.map(col => (
                                    <th key={col} scope="col" className={`px-4 py-3 border-r border-gray-700/50 last:border-r-0 ${col === 'port' ? 'whitespace-nowrap' : ''}`}>{headerLabel(col)}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {Object.entries(table.ports).map(([portName, portData]) => (
                                <tr className="border-b border-gray-700/50 last:border-b-0 hover:bg-gray-700/40" key={portName}>
                                    {columns.map(col => {
                                        const overridden = col === 'default' && defaultsOverride
                                            && Object.prototype.hasOwnProperty.call(defaultsOverride, portName);
                                        const typeOverridden = col === 'type' && typesOverride
                                            && Object.prototype.hasOwnProperty.call(typesOverride, portName);
                                        const cellText = overridden ? defaultsOverride[portName]
                                            : typeOverridden ? typesOverride[portName]
                                            : (portData[col] || '');
                                        return (
                                            <td key={col} className={`px-4 py-3 align-top border-r border-gray-700/50 last:border-r-0 ${CELL_STYLES[col] || ''}`}>
                                                {col === 'port'
                                                    ? portName
                                                    : col === 'type'
                                                    ? <TypeCell text={cellText} />
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
        });

        // Shared banner for auto-generated port data (spec-less nodes):
        // used both here and by js/docs-app.jsx's isAutoTable case, so
        // the two read as one consistent notice, not two similar ones.
        function AutoDocNotice() {
            return (
                <div className="bg-blue-950/40 border border-blue-800/60 text-blue-200/90 text-sm rounded-xl px-4 py-3 flex items-start gap-2 mb-3">
                    <MtlxIcon name="info-circle" className="w-4 h-4 shrink-0 mt-0.5" />
                    <span><span className="font-semibold text-blue-200">Generated from the nodedef.</span> This node's ports, types and defaults were read directly from the MaterialX node definition, not from the specification documents.</span>
                </div>
            );
        }

        // Rows: [{name, kind, types[], value, enums}], pregenerated
        // by scripts/lib/nodedef-extract.mjs from the union of every
        // matching nodedef's ports, no live WASM read here.
        const NodeDefPortsTable = ({ rows, showNotice = true }) => {
            rows = rows || [];
            if (!rows.length) {
                return (
                    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-sm text-gray-500 italic">
                        No specific ports defined or extracted for this node.
                    </div>
                );
            }
            return (
                <div>
                    {showNotice && <AutoDocNotice />}
                    <div className="overflow-x-auto bg-gray-900 border border-gray-700 rounded-xl">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-[10px] font-semibold uppercase tracking-[0.08em] text-gray-500 bg-gray-900 border-b border-gray-700">
                                    <th className="px-3 py-2 border-r border-gray-700/50 last:border-r-0">Port</th>
                                    <th className="px-3 py-2 border-r border-gray-700/50 last:border-r-0">Kind</th>
                                    <th className="px-3 py-2 border-r border-gray-700/50 last:border-r-0">Type(s)</th>
                                    <th className="px-3 py-2 border-r border-gray-700/50 last:border-r-0">Default</th>
                                    <th className="px-3 py-2 border-r border-gray-700/50 last:border-r-0">Accepted values</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((r) => (
                                    <tr key={r.kind + ':' + r.name} className="border-b border-gray-700/50 last:border-0 align-top">
                                        <td className="px-3 py-2 font-mono text-gray-100 border-r border-gray-700/50 last:border-r-0">{r.name}</td>
                                        <td className="px-3 py-2 text-gray-400 border-r border-gray-700/50 last:border-r-0">{r.kind}</td>
                                        <td className="px-3 py-2 font-mono text-xs border-r border-gray-700/50 last:border-r-0"><TypeCell text={r.types.join(', ')} /></td>
                                        <td className="px-3 py-2 font-mono text-gray-300 break-all border-r border-gray-700/50 last:border-r-0">{r.value}</td>
                                        <td className="px-3 py-2 font-mono text-gray-400 break-words border-r border-gray-700/50 last:border-r-0">{r.enums}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            );
        };

        // ---- public API ----
        // Only helpers with consumers outside this file are exported;
        // internal-only helpers (signature/column-layout math) stay local.
        Object.assign(window, {
            getPortTables, isUndocumented,
            unionColumns, signaturePreviewType, pickTableForType, PortTable,
            NodeDefPortsTable, AutoDocNotice,
        });
