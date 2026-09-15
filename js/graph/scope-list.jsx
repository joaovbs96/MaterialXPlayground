// js/graph/scope-list.jsx: left sidebar: a searchable, sortable, read-only
// list of every card in the current scope. Self-exports via
// Object.assign(window, {}); no top-level import/export.

        const SCOPE_LIST_GROUPS_KEY = 'mtlxGraphScopeListGroups';
        // The list body has no side padding (rows add their own), so the
        // group header spans edge to edge without the negative-margin trick.
        const SCOPE_GROUP_HEADER_CLASS = GROUP_HEADER_CLASS
            .replace('w-[calc(100%+1.25rem)]', 'w-full')
            .replace('-mx-2.5 ', '');
        const loadScopeListGroups = () => {
            try {
                const raw = window.localStorage.getItem(SCOPE_LIST_GROUPS_KEY);
                const parsed = raw ? JSON.parse(raw) : null;
                return Object.assign({ inputs: true, nodes: true, outputs: true }, parsed || {});
            } catch (e) { return { inputs: true, nodes: true, outputs: true }; }
        };

        // A glyph shape per row kind: node/graph/def read as a filled dot,
        // an input as a diamond, an output as a small square.
        const SCOPE_ROW_KIND_LABEL = { input: 'in', output: 'out', graph: 'graph', def: 'def', node: '' };

        // Labels for the sort MtlxSelect's title, keyed by sortKey value.
        const SCOPE_LIST_SORT_LABELS = { graph: 'graph order', name: 'name', type: 'type', category: 'category' };

        function ScopeListRow({ r, hi, selected, onSelect, onOpen, onOpenImpl }) {
            const glyphShape = r.kind === 'input' ? 'rotate-45'
                : r.kind === 'output' ? 'rounded-sm' : 'rounded-full';
            return (
                <button
                    type="button"
                    data-row-id={r.id}
                    className={'w-full flex items-center gap-2 px-2 py-1 rounded text-[12px] font-mono text-left transition-colors '
                        + (selected ? 'bg-blue-600/30 text-gray-100' : (hi ? 'bg-gray-700/60 text-gray-200' : 'text-gray-300 hover:bg-gray-700/60'))}
                    title={r.category + (r.type ? ' : ' + r.type : '')}
                    onClick={() => onSelect(r.id)}
                    onDoubleClick={() => {
                        if (r.id.indexOf('g:') === 0) onOpen(r.name);
                        else if (r.implGraph && onOpenImpl) onOpenImpl(r.implGraph, r.id);
                    }}
                >
                    <span className={'flex-none w-2 h-2 ' + glyphShape} style={{ background: r.color }} />
                    <span className="flex-none text-[8px] uppercase tracking-wider text-gray-500 w-6">
                        {SCOPE_ROW_KIND_LABEL[r.kind] || ''}
                    </span>
                    <span className="truncate">{r.name}</span>
                    <span className="ml-auto flex-none text-[9px]" style={{ color: typeColor(r.type) }}>
                        {r.kind === 'node' ? r.category : r.type}
                    </span>
                </button>
            );
        }

        function ScopeList({
            rows, scope, functional, selectedIds, query, setQuery,
            typeFilter, setTypeFilter, sortKey, setSortKey, sortDir, setSortDir,
            onSelect, onOpen, onOpenImpl, onCollapse, className,
        }) {
            const [hi, setHi] = React.useState(-1);
            const inputRef = React.useRef(null);
            const listRef = React.useRef(null);
            const [groupsOpen, setGroupsOpen] = React.useState(loadScopeListGroups);

            React.useEffect(() => { setHi(-1); }, [query]);

            const toggleGroup = (key) => {
                setGroupsOpen((prev) => {
                    const next = Object.assign({}, prev, { [key]: !prev[key] });
                    try { window.localStorage.setItem(SCOPE_LIST_GROUPS_KEY, JSON.stringify(next)); } catch (e) { /* private mode */ }
                    return next;
                });
            };

            const typesPresent = React.useMemo(() => {
                const s = new Set();
                rows.forEach((r) => {
                    if (r.type) s.add(r.type);
                    (r.outTypes || []).forEach((t) => { if (t) s.add(t); });
                });
                return Array.from(s).sort();
            }, [rows]);

            const filtered = React.useMemo(() => {
                let list = searchFilter(rows, query, (r) => [r.name, r.category]);
                if (typeFilter) {
                    list = list.filter((r) => r.type === typeFilter || (r.outTypes || []).indexOf(typeFilter) !== -1);
                }
                return list;
            }, [rows, query, typeFilter]);

            const sorted = React.useMemo(() => {
                const list = filtered.slice();
                if (sortKey === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
                else if (sortKey === 'category') list.sort((a, b) => a.category.localeCompare(b.category));
                else if (sortKey === 'type') list.sort((a, b) => (a.type || '').localeCompare(b.type || '') || a.name.localeCompare(b.name));
                // 'graph' keeps the incoming order.
                if (sortDir === 'desc') list.reverse();
                return list;
            }, [filtered, sortKey, sortDir]);

            const inputRows = React.useMemo(() => sorted.filter((r) => r.kind === 'input'), [sorted]);
            const nodeRows = React.useMemo(() => sorted.filter((r) => r.kind === 'node' || r.kind === 'graph' || r.kind === 'def'), [sorted]);
            const outputRows = React.useMemo(() => sorted.filter((r) => r.kind === 'output'), [sorted]);

            // Flattened, in visual order, respecting collapsed groups: the
            // sequence ArrowUp/ArrowDown walks.
            const flat = React.useMemo(() => {
                if (!scope) return sorted;
                const out = [];
                if (groupsOpen.inputs) out.push(...inputRows);
                if (groupsOpen.nodes) out.push(...nodeRows);
                if (groupsOpen.outputs) out.push(...outputRows);
                return out;
            }, [scope, sorted, groupsOpen, inputRows, nodeRows, outputRows]);

            const flatIndexById = React.useMemo(() => {
                const m = {};
                flat.forEach((r, i) => { m[r.id] = i; });
                return m;
            }, [flat]);

            const scrollRowIntoView = (id) => {
                const el = listRef.current && listRef.current.querySelector('[data-row-id="' + CSS.escape(id) + '"]');
                if (el) el.scrollIntoView({ block: 'nearest' });
            };

            const handleNavKey = (e) => {
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setHi((cur) => {
                        const next = Math.min(flat.length - 1, cur + 1);
                        if (flat[next]) scrollRowIntoView(flat[next].id);
                        return next;
                    });
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setHi((cur) => {
                        const next = Math.max(0, cur - 1);
                        if (flat[next]) scrollRowIntoView(flat[next].id);
                        return next;
                    });
                } else if (e.key === 'Enter') {
                    if (hi >= 0 && flat[hi]) { e.preventDefault(); onSelect(flat[hi].id); }
                } else if (e.key === 'Escape') {
                    setQuery('');
                    if (inputRef.current) inputRef.current.blur();
                }
            };

            const renderRow = (r) => (
                <ScopeListRow
                    key={r.id}
                    r={r}
                    hi={hi === flatIndexById[r.id]}
                    selected={selectedIds.indexOf(r.id) !== -1}
                    onSelect={onSelect}
                    onOpen={onOpen}
                    onOpenImpl={onOpenImpl}
                />
            );

            const groupHeader = (key, title, count) => (
                <button type="button" className={SCOPE_GROUP_HEADER_CLASS} onClick={() => toggleGroup(key)}>
                    <MtlxIcon name={groupsOpen[key] ? 'chevron-down' : 'chevron-right'} className="w-3 h-3" />
                    <span>{title}</span>
                    <span className="ml-auto text-[9px] text-gray-500 normal-case tracking-normal">{count}</span>
                </button>
            );

            const total = rows.length;
            const visibleCount = sorted.length;

            return (
                // flex-1 min-h-0 (not h-full): the sidebar now stacks this
                // above the embedded type legend, so it must shrink to
                // share the column instead of claiming the full height.
                <div className={'flex flex-col flex-1 min-h-0' + (className ? ' ' + className : '')}>
                    <div className="flex flex-col border-b border-gray-700 bg-gray-900/70">
                        <div className="flex items-center gap-2 px-3 py-2 min-h-[45px] border-b border-gray-800">
                            <MtlxIcon name="list-details" className="w-3.5 h-3.5 text-gray-500" />
                            <span className="text-[13px] font-bold text-gray-100 truncate font-mono flex-1 flex items-center gap-1.5">
                                {scope && <span className="w-2 h-2 rounded-full flex-none" style={{ background: typeColor('nodegraph') }} />}
                                {scope || 'Nodes'}
                            </span>
                            <span className="text-[10px] text-gray-500">{visibleCount}/{total}</span>
                            <button
                                type="button"
                                title="Collapse the node list"
                                className="flex-none w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700/80 transition-colors"
                                onClick={onCollapse}
                            >
                                <MtlxIcon name="chevrons-left" className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="flex items-stretch border-b border-gray-700">
                            <div className="relative flex-1 min-w-0">
                                <MtlxIcon name="search" className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none" />
                                <input
                                    ref={inputRef}
                                    className="w-full bg-gray-900 pl-7 pr-2 py-1.5 text-[12px] font-mono text-gray-100 placeholder-gray-500 focus:outline-none"
                                    placeholder="Filter nodes"
                                    value={query}
                                    spellCheck={false}
                                    onChange={(e) => setQuery(e.target.value)}
                                    onKeyDown={handleNavKey}
                                />
                            </div>
                            {query && (
                                <button
                                    type="button"
                                    title="Clear filter"
                                    className="flex-none w-6 self-center mr-1 text-gray-500 hover:text-gray-200"
                                    onClick={() => { setQuery(''); if (inputRef.current) inputRef.current.focus(); }}
                                >
                                    <MtlxIcon name="x" className="w-3.5 h-3.5" />
                                </button>
                            )}
                        </div>
                        <div className="flex items-center gap-1.5 px-2 py-1.5">
                            <TypeSelect
                                value={typeFilter}
                                onChange={setTypeFilter}
                                types={typesPresent}
                                emptyOption="Any type"
                                title="Filter by Type"
                                className="flex-1 min-w-0"
                            />
                            <MtlxSelect
                                value={sortKey}
                                onChange={setSortKey}
                                options={[
                                    { value: 'graph', label: 'graph order' },
                                    { value: 'name', label: 'name' },
                                    { value: 'type', label: 'type' },
                                    { value: 'category', label: 'category' },
                                ]}
                                defValue={null}
                                icon={sortDir === 'asc' ? 'sort-ascending' : 'sort-descending'}
                                title={'Sort by ' + SCOPE_LIST_SORT_LABELS[sortKey]}
                                size="sm"
                                variant="field"
                                font="mono"
                                align="left"
                                className="flex-1 min-w-[8.5rem] max-w-[9rem]"
                            />
                            <button
                                type="button"
                                title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
                                className={ICON_BTN_SM + ' flex-none'}
                                onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
                            >
                                <MtlxIcon name={sortDir === 'asc' ? 'sort-ascending' : 'sort-descending'} className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    </div>
                    <div
                        ref={listRef}
                        className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-0 [scrollbar-gutter:auto] py-1"
                        onKeyDown={handleNavKey}
                    >
                        {sorted.length === 0 && <div className="text-[11px] text-gray-500 py-2 px-2.5">No matches.</div>}
                        {sorted.length > 0 && !scope && <div className="px-2.5">{sorted.map((r) => renderRow(r))}</div>}
                        {sorted.length > 0 && scope && (
                            <React.Fragment>
                                {groupHeader('inputs', 'Inputs', inputRows.length)}
                                {groupsOpen.inputs && <div className="px-2.5">{inputRows.map((r) => renderRow(r))}</div>}
                                {groupHeader('nodes', 'Nodes', nodeRows.length)}
                                {groupsOpen.nodes && <div className="px-2.5">{nodeRows.map((r) => renderRow(r))}</div>}
                                {groupHeader('outputs', 'Outputs', outputRows.length)}
                                {groupsOpen.outputs && <div className="px-2.5">{outputRows.map((r) => renderRow(r))}</div>}
                            </React.Fragment>
                        )}
                    </div>
                </div>
            );
        }

Object.assign(window, { ScopeList });
