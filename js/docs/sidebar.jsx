// sidebar.jsx — docs page's left-hand node tree (DocsSidebar) and "?" Help
// modal (DocsHelpDialog), extracted from js/docs-app.jsx's App. Loaded as
// text/babel, so the API is exported onto window.

        // Chevron icons for the tree view, matching the original inline SVGs
        // (MTLX_ICON_PATHS 'chevron-right'/'chevron-down', js/mtlx-engine.js).
        // className passed explicitly since it differs from MtlxIcon's default.
        const ChevronRight = () => (
            <MtlxIcon name="chevron-right" className="w-4 h-4 inline-block mr-1 text-gray-500" />
        );
        const ChevronDown = () => (
            <MtlxIcon name="chevron-down" className="w-4 h-4 inline-block mr-1 text-gray-400" />
        );

        // DocsSidebar — the "Node Library" panel (header + lib/group/node
        // tree). Purely presentational: App owns all state and derived
        // data and passes it down as props.
        function DocsSidebar({
            treeData, docFilter, forceOpen, searchQuery, setSearchQuery, matchCount,
            searchOutType, searchInType, setSearchOutType, setSearchInType,
            outputTypeOptions, takesTypeOptions,
            expandAll, collapseAll, expandedLibs, toggleLib, expandedGroups, toggleGroup,
            selectedNode, setSelectedNode,
            stats, applyDocFilter, showPreviews, togglePreviews, onShowHelp, collapsed, onCollapse,
        }) {
            // Type-filter row (Outputs/Takes) is closed by default; it opens on
            // funnel click or whenever a type token already lives in the query.
            const [typeRowOpen, setTypeRowOpen] = React.useState(false);
            const hasTypeToken = !!(searchOutType || searchInType);
            const showTypeRow = typeRowOpen || hasTypeToken;
            // Single expand/collapse toggle: "open" only when every visible lib
            // and group is already expanded (search forces everything open).
            const allOpen = forceOpen || (treeData && Object.keys(treeData).length > 0 &&
                Object.entries(treeData).every(([lib, groups]) =>
                    expandedLibs[lib] && Object.keys(groups).every((g) => expandedGroups[`${lib}-${g}`])));
            return (
                // [scrollbar-gutter:stable]: this element is both the scroll
                // container and (at md+) the min-content grid column; reserve
                // the gutter so width stays constant as the scrollbar toggles.
                <div className={(collapsed ? 'md:hidden ' : 'md:col-span-1 ') + 'bg-gray-800 rounded-xl border border-gray-800 max-h-[45vh] md:max-h-none md:min-h-0 overflow-y-auto custom-scrollbar [scrollbar-gutter:stable]'}>
                    {/* Sticky header stays visible while the tree scrolls beneath it. The
                        scroll container is unpadded; the sticky block and tree wrapper
                        carry their own padding so the header sits flush at top with no overlap. */}
                    <div className="sticky top-0 z-10 bg-gray-800 px-4 pt-4 pb-1">
                        <div className="flex items-center justify-between mb-3 border-b border-gray-700 pb-2">
                            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-500">
                                Node Library
                            </h3>
                            <div className="flex items-center gap-1">
                                <button
                                    onClick={onShowHelp}
                                    title="How to use this page"
                                    aria-label="Help"
                                    className="p-1 rounded-md text-gray-500 hover:text-gray-200 hover:bg-gray-700"
                                >
                                    <MtlxIcon name="help" className="w-4 h-4" />
                                </button>
                                <button
                                    onClick={togglePreviews}
                                    aria-pressed={showPreviews}
                                    aria-label="Toggle 3D previews"
                                    title={showPreviews
                                        ? '3D previews are on — click to disable the WebGL node previews (saves resources on slow machines)'
                                        : '3D previews are off — click to enable the WebGL node previews'}
                                    className={`p-1 rounded-md transition-colors ${
                                        showPreviews
                                            ? 'text-blue-400 hover:text-blue-300 hover:bg-blue-500/10'
                                            : 'text-amber-400 hover:text-amber-300 hover:bg-amber-500/10'
                                    }`}
                                >
                                    <MtlxIcon name={showPreviews ? 'cube' : 'cube-off'} className="w-4 h-4" />
                                </button>
                                <button
                                    onClick={onCollapse}
                                    title="Collapse the node library panel"
                                    aria-label="Collapse the node library panel"
                                    className="hidden md:block p-1 rounded-md text-gray-500 hover:text-gray-200 hover:bg-gray-700"
                                >
                                    <MtlxIcon name="chevrons-left" className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                        {/* Three-option segmented control: replaces the old stat cards
                            and the separate documented/undocumented filter icons. Each
                            segment's own count swaps for the live match count while a
                            search or type filter narrows the tree. */}
                        <div className="flex items-stretch rounded-md border border-gray-700 overflow-hidden mb-2 h-8" role="group" aria-label="Documentation filter">
                            {[
                                { mode: 'all', label: 'All', count: stats ? stats.total : 0 },
                                { mode: 'documented', label: 'Documented', count: stats ? stats.total - stats.undoc : 0 },
                                { mode: 'undocumented', label: 'No docs', count: stats ? stats.undoc : 0 },
                            ].map(({ mode, label, count }, i) => {
                                const active = docFilter === mode;
                                const shownCount = active && matchCount !== null ? matchCount : count;
                                const countCls = mode === 'undocumented'
                                    ? 'text-amber-400'
                                    : (active ? 'text-blue-300' : 'text-gray-500');
                                return (
                                    <button
                                        key={mode}
                                        onClick={() => applyDocFilter(mode)}
                                        title={label}
                                        aria-label={label}
                                        aria-pressed={active}
                                        className={`flex-1 min-w-0 flex items-center justify-center gap-1 text-xs transition-colors ${i > 0 ? 'border-l border-gray-700' : ''} ${
                                            active
                                                ? 'bg-blue-500/[0.12] text-blue-300'
                                                : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                                        }`}
                                    >
                                        <span className="truncate">{label}</span>
                                        <span className={`font-semibold ${countCls}`}>
                                            {active && matchCount !== null ? `· ${shownCount}` : shownCount}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                        <div className="relative mb-1">
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder="Search nodes..."
                                className="w-full bg-gray-900 border border-gray-700 rounded-md h-8 pl-3 pr-16 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                            />
                            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                                {searchQuery && (
                                    <button
                                        onClick={() => setSearchQuery('')}
                                        title="Clear search"
                                        aria-label="Clear search"
                                        className="p-1 rounded text-gray-500 hover:text-gray-200"
                                    >
                                        <MtlxIcon name="x" className="w-3.5 h-3.5" />
                                    </button>
                                )}
                                <button
                                    onClick={() => setTypeRowOpen((v) => !v)}
                                    title="Filter by port type"
                                    aria-label="Toggle type filters"
                                    aria-pressed={showTypeRow}
                                    className={`p-1 rounded transition-colors ${
                                        showTypeRow ? 'text-blue-400 hover:text-blue-300' : 'text-gray-500 hover:text-gray-200'
                                    }`}
                                >
                                    <MtlxIcon name="adjustments" className="w-3.5 h-3.5" />
                                </button>
                                <button
                                    onClick={allOpen ? collapseAll : expandAll}
                                    title={allOpen ? 'Collapse all' : 'Expand all'}
                                    aria-label={allOpen ? 'Collapse all' : 'Expand all'}
                                    className="p-1 rounded text-gray-500 hover:text-gray-200"
                                >
                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        {allOpen
                                            ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 10l5-5 5 5M7 19l5-5 5 5" />
                                            : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 5l5 5 5-5M7 14l5 5 5-5" />}
                                    </svg>
                                </button>
                            </div>
                        </div>
                        {(searchOutType || searchInType) && (
                            <div className="flex flex-wrap items-center gap-1 pb-1">
                                {searchOutType && (
                                    <span className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full border border-gray-700 bg-gray-900 text-[11px] font-mono text-gray-300">
                                        out: {searchOutType}
                                        <button
                                            onClick={() => setSearchOutType(null)}
                                            title="Remove output type filter"
                                            aria-label={`Remove output type filter (${searchOutType})`}
                                            className="text-gray-500 hover:text-gray-200"
                                        >
                                            <MtlxIcon name="x" className="w-3 h-3" />
                                        </button>
                                    </span>
                                )}
                                {searchInType && (
                                    <span className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full border border-gray-700 bg-gray-900 text-[11px] font-mono text-gray-300">
                                        in: {searchInType}
                                        <button
                                            onClick={() => setSearchInType(null)}
                                            title="Remove input type filter"
                                            aria-label={`Remove input type filter (${searchInType})`}
                                            className="text-gray-500 hover:text-gray-200"
                                        >
                                            <MtlxIcon name="x" className="w-3 h-3" />
                                        </button>
                                    </span>
                                )}
                            </div>
                        )}
                        {showTypeRow && (
                            <div className="flex items-center gap-1.5 pb-2">
                                <MtlxSelect
                                    value={searchOutType || ''}
                                    options={outputTypeOptions || []}
                                    onChange={(v) => setSearchOutType(v || null)}
                                    emptyOption="any"
                                    placeholder="Outputs: any"
                                    defValue={null}
                                    title="Only show nodes with a signature outputting this type (out: in the search box)"
                                    ariaLabel="Filter by output type"
                                    font="mono"
                                    size="sm"
                                    variant="field"
                                    className="flex-1 min-w-0"
                                />
                                <MtlxSelect
                                    value={searchInType || ''}
                                    options={takesTypeOptions || []}
                                    onChange={(v) => setSearchInType(v || null)}
                                    emptyOption="any"
                                    placeholder="Takes: any"
                                    defValue={null}
                                    title="Only show nodes with a signature taking this type as input (in: in the search box)"
                                    ariaLabel="Filter by input type"
                                    font="mono"
                                    size="sm"
                                    variant="field"
                                    className="flex-1 min-w-0"
                                />
                            </div>
                        )}
                    </div>
                    <div className="px-4 pb-4 pt-1">
                    {docFilter !== 'all' && !forceOpen && Object.keys(treeData).length === 0 && (
                        <div className="text-xs text-gray-500 italic">No matching nodes.</div>
                    )}
                    <div className="space-y-1 text-sm">
                        {Object.entries(treeData).map(([lib, groups]) => (
                            <div key={lib} className="select-none">
                                {/* Library Level */}
                                <div
                                    className="flex items-center cursor-pointer hover:text-blue-400 text-gray-200 font-medium py-1"
                                    onClick={() => toggleLib(lib)}
                                >
                                    {(expandedLibs[lib] || forceOpen) ? <ChevronDown /> : <ChevronRight />}
                                    {lib.toUpperCase()}
                                </div>

                                {/* Group Level */}
                                {(expandedLibs[lib] || forceOpen) && (
                                    <div className="ml-4 border-l border-gray-700 pl-2 space-y-1 mt-1">
                                        {Object.entries(groups).map(([group, nodes]) => {
                                            const groupKey = `${lib}-${group}`;
                                            return (
                                                <div key={groupKey}>
                                                    <div
                                                        className="flex items-center cursor-pointer hover:text-blue-300 text-gray-400 py-1"
                                                        onClick={() => toggleGroup(lib, group)}
                                                    >
                                                        {(expandedGroups[groupKey] || forceOpen) ? <ChevronDown /> : <ChevronRight />}
                                                        {group}
                                                    </div>

                                                    {/* Node Level */}
                                                    {(expandedGroups[groupKey] || forceOpen) && (
                                                        <div className="ml-4 border-l border-gray-700 pl-2 space-y-1 mt-1">
                                                            {Object.entries(nodes).map(([nodeName, nodeInfo]) => {
                                                                // A node name can exist in several groups (e.g. the
                                                                // color `mix` and the shader `mix`), so selection is
                                                                // keyed on lib + group + name.
                                                                const isSelected = selectedNode
                                                                    && selectedNode.name === nodeName
                                                                    && selectedNode.lib === lib
                                                                    && selectedNode.group === group;
                                                                // Documented rows hover blue, undocumented hover amber.
                                                                // Keys come from App's stats memo — avoids recomputing
                                                                // isUndocumented (and rebuilding port tables) per keystroke.
                                                                const undoc = stats && stats.undocKeys.has(`${lib}-${group}-${nodeName}`);
                                                                const rowCls = isSelected
                                                                    ? 'bg-blue-600 text-white'
                                                                    : (undoc ? 'text-gray-400 hover:bg-amber-900/20 hover:text-amber-300' : 'text-gray-400 hover:bg-blue-900/20 hover:text-blue-300');
                                                                return (
                                                                    <div
                                                                        key={nodeName}
                                                                        onClick={() => setSelectedNode({ lib, group, name: nodeName, info: nodeInfo })}
                                                                        className={`cursor-pointer py-1 px-2 rounded font-mono text-xs break-all ${rowCls}`}
                                                                    >
                                                                        {nodeName}
                                                                        {undoc && <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400/80 ml-1.5 align-middle" />}
                                                                    </div>
                                                                )
                                                            })}
                                                        </div>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                    </div>
                </div>
            );
        }

        // DocsHelpDialog — the "?" Help modal. App keeps ownership of showHelp
        // state and its useEscapeToClose(...) call (least change from the
        // original single-file App); this component just receives open/onClose.
        function DocsHelpDialog({ open, onClose }) {
            if (!open) return null;
            // Help popup: click-outside or Esc closes. Rendered via a portal
            // directly under <body>, so a transformed/filtered ancestor can't
            // hijack position:fixed's containing block and break the overlay.
            return ReactDOM.createPortal(
                <div
                    className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60"
                    onClick={onClose}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Help"
                >
                    <div
                        className="bg-gray-800 border border-gray-700 rounded-lg shadow-xl max-w-xl w-full max-h-[85vh] overflow-y-auto custom-scrollbar p-5 sm:p-6"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-start justify-between gap-4 mb-3">
                            <h2 className="text-lg font-semibold text-white">How to use the Node Library</h2>
                            <button
                                onClick={onClose}
                                title="Close (Esc)"
                                className="text-gray-400 hover:text-gray-200 text-xl leading-none px-1"
                                aria-label="Close help"
                            >
                                &times;
                            </button>
                        </div>
                        <div className="space-y-3 text-sm text-gray-300">
                            <p>
                                Documentation browser and live previews for the MaterialX node libraries.
                            </p>
                            <p>
                                This page is a browsable reference for the MaterialX node libraries. The
                                documentation is parsed live from the official specification (pinned to the
                                version shown in the header) and joined with the node definitions reported
                                by the MaterialX runtime itself.
                            </p>
                            <p>
                                <span className="font-semibold text-gray-100">Browsing.</span>{' '}
                                The left panel lists every node, grouped by library and node group. The
                                segmented control above the search box shows all nodes, only documented, or
                                only undocumented ones, each with its count. Use the search box to filter by
                                name, and the icon next to it to expand or collapse everything. The funnel
                                icon inside the search box opens two dropdowns that filter by port type:
                                "Outputs" keeps nodes with a signature that outputs the chosen type, "Takes"
                                keeps nodes with a signature that takes it as an input; active type filters
                                show as removable chips under the search box. Typing{' '}
                                <code>out:&lt;type&gt;</code> or <code>in:&lt;type&gt;</code> directly into
                                the search box (e.g. <code>out:color3</code>) does the same thing and can be
                                combined with a name and with each other.
                            </p>
                            <p>
                                <span className="font-semibold text-gray-100">Documentation.</span>{' '}
                                Selecting a node shows its description, port tables, and references from the
                                specification. Links to other nodes open directly in the app; everything else
                                opens the official spec on GitHub.
                            </p>
                            <p>
                                <span className="font-semibold text-gray-100">3D preview.</span>{' '}
                                Most nodes render live in WebGL: drag to orbit, scroll to zoom. The controls
                                on the viewport switch the preview geometry, start/stop the turntable
                                rotation, show the environment as background, save a PNG preview, and go
                                full screen. Editing values in the parameter panel regenerates the shader,
                                and the node can be downloaded as a .mtlx document with the current values.
                                The cube button in the panel header toggles all WebGL previews globally, to
                                save resources on slow machines.
                            </p>
                            <p className="text-gray-400">
                                Something broken or missing? Report it on the{' '}
                                <a
                                    href={window.SITE_LINKS.issues}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-400 hover:text-blue-300 underline decoration-blue-500/40"
                                >Feedback &amp; Issues</a>{' '}
                                page.
                            </p>
                        </div>
                    </div>
                </div>,
                document.body
            );
        }

        // ---- public API ----
        Object.assign(window, {
            DocsSidebar, DocsHelpDialog,
        });
