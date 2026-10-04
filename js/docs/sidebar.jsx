// sidebar.jsx — docs page's left-hand node tree (DocsSidebar) and "?" Help
// modal (DocsHelpDialog), extracted from js/docs-app.jsx's App. Loaded as
// text/babel, so the API is exported onto window.

        // Chevron icons for the tree view, matching the original inline SVGs
        // (MTLX_ICON_PATHS 'chevron-right'/'chevron-down', js/mtlx-engine.js).
        // className passed explicitly since it differs from MtlxIcon's default.
        const ChevronRight = () => (
            <MtlxIcon name="chevron-right" className="w-4 h-4 inline-block mr-1 text-fg-subtle" />
        );
        const ChevronDown = () => (
            <MtlxIcon name="chevron-down" className="w-4 h-4 inline-block mr-1 text-fg-muted" />
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
            fileFilter, onPickFiles, onClearFileFilter, showFilePicker,
        }) {
            // Hidden <input type=file>, clicked via the "Filter by file"
            // button below; App does the reading/scanning (pickFileFilter).
            const fileInputRef = React.useRef(null);
            // Type dot colors: shared site palette (js/shared/ui-commons.js),
            // keyed by port type name so both MtlxSelect triggers and rows
            // match the graph legend / port-table dots.
            const typeDots = React.useMemo(() => {
                const dots = {};
                (outputTypeOptions || []).concat(takesTypeOptions || []).forEach((t) => {
                    dots[t] = typeColor(t);
                });
                return dots;
            }, [outputTypeOptions, takesTypeOptions]);
            // Single expand/collapse toggle: "open" only when every visible lib
            // and group is already expanded (search forces everything open).
            const allOpen = forceOpen || (treeData && Object.keys(treeData).length > 0 &&
                Object.entries(treeData).every(([lib, groups]) =>
                    expandedLibs[lib] && Object.keys(groups).every((g) => expandedGroups[`${lib}-${g}`])));
            return (
                // [scrollbar-gutter:stable]: this element is both the scroll
                // container and (at md+) the fixed 340px grid column
                // (js/docs-app.jsx); reserve the gutter so width stays
                // constant as the scrollbar toggles.
                // min-w-0: a grid item's default min-width:auto lets wide
                // content (long node names) push past a fixed track instead
                // of wrapping, which would make the panel visually resize.
                <div className={(collapsed ? 'md:hidden ' : 'md:col-span-1 md:min-w-0 ') + 'bg-surface-raised rounded-xl border border-line-subtle max-h-[45vh] md:max-h-none md:min-h-0 overflow-y-auto custom-scrollbar [scrollbar-gutter:stable]'}>
                    {/* Sticky header stays visible while the tree scrolls beneath it. The
                        scroll container is unpadded; the sticky block and tree wrapper
                        carry their own padding so the header sits flush at top with no overlap. */}
                    <div className="sticky top-0 z-10 bg-surface-raised px-4 pt-4 pb-1">
                        <div className="flex items-center justify-between mb-3 border-b border-line pb-2">
                            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-subtle">
                                Node Library
                            </h3>
                            <div className="flex items-center gap-1">
                                <button
                                    onClick={onShowHelp}
                                    title="How to use this page"
                                    aria-label="Help"
                                    className="p-1 rounded-md text-fg-subtle hover:text-fg-soft hover:bg-hover"
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
                                            ? 'text-accent-fg hover:text-accent-fg-strong hover:bg-accent-wash/10'
                                            : 'text-warning-marker hover:text-warning hover:bg-warning-hue/10'
                                    }`}
                                >
                                    <MtlxIcon name={showPreviews ? 'cube' : 'cube-off'} className="w-4 h-4" />
                                </button>
                                <button
                                    onClick={onCollapse}
                                    title="Collapse the node library panel"
                                    aria-label="Collapse the node library panel"
                                    className="hidden md:block p-1 rounded-md text-fg-subtle hover:text-fg-soft hover:bg-hover"
                                >
                                    <MtlxIcon name="chevrons-left" className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                        {/* Three-option segmented control: replaces the old stat cards
                            and the separate documented/undocumented filter icons. Each
                            segment's own count swaps for the live match count while a
                            search or type filter narrows the tree. */}
                        <div className="flex items-stretch rounded-md border border-line overflow-hidden mb-2 h-8" role="group" aria-label="Documentation filter">
                            {[
                                { mode: 'all', label: 'All', title: 'All', count: stats ? stats.total : 0 },
                                { mode: 'documented', label: 'Docs', title: 'Documented nodes', count: stats ? stats.total - stats.undoc : 0 },
                                { mode: 'undocumented', label: 'No docs', title: 'No docs', count: stats ? stats.undoc : 0 },
                            ].map(({ mode, label, title, count }, i) => {
                                const active = docFilter === mode;
                                const shownCount = active && matchCount !== null ? matchCount : count;
                                const countCls = mode === 'undocumented'
                                    ? 'text-warning-marker'
                                    : (active ? 'text-accent-fg-strong' : 'text-fg-subtle');
                                return (
                                    <button
                                        key={mode}
                                        onClick={() => applyDocFilter(mode)}
                                        title={title}
                                        aria-label={title}
                                        aria-pressed={active}
                                        style={{ flex: '1 1 auto', whiteSpace: 'nowrap', paddingLeft: '6px', paddingRight: '6px' }}
                                        className={`min-w-0 flex items-center justify-center gap-1 text-xs transition-colors ${i > 0 ? 'border-l border-line' : ''} ${
                                            active
                                                ? 'bg-selection/20 text-accent-fg-strong'
                                                : 'bg-control text-fg-muted hover:bg-hover hover:text-fg-soft'
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
                                className="w-full bg-surface-sunken border border-line-control rounded-md h-8 pl-3 pr-16 text-sm text-fg-soft placeholder-fg-subtle focus:outline-none focus:border-focus"
                            />
                            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
                                {searchQuery && (
                                    <button
                                        onClick={() => setSearchQuery('')}
                                        title="Clear search"
                                        aria-label="Clear search"
                                        className="p-1 rounded text-fg-subtle hover:text-fg-soft"
                                    >
                                        <MtlxIcon name="x" className="w-3.5 h-3.5" />
                                    </button>
                                )}
                                <button
                                    onClick={allOpen ? collapseAll : expandAll}
                                    title={allOpen ? 'Collapse all' : 'Expand all'}
                                    aria-label={allOpen ? 'Collapse all' : 'Expand all'}
                                    className="p-1 rounded text-fg-subtle hover:text-fg-soft"
                                >
                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        {allOpen
                                            ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 10l5-5 5 5M7 19l5-5 5 5" />
                                            : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 5l5 5 5-5M7 14l5 5 5-5" />}
                                    </svg>
                                </button>
                            </div>
                        </div>
                        {/* Integrated type-filter line: two MtlxSelect dropdowns
                            (the site-wide custom control), each half the row.
                            The trigger's own prefixed label ("Outputs: any",
                            "Inputs: color3") replaces the old label+chip
                            pairing, so choosing "any" alone clears a filter. */}
                        <div
                            className="flex items-center gap-1.5 mb-2"
                            role="group"
                            aria-label="Filter by port type"
                        >
                            <MtlxSelect
                                value={searchInType || ''}
                                options={takesTypeOptions || []}
                                dots={typeDots}
                                defValue={null}
                                emptyOption="any"
                                valuePrefix="Inputs: "
                                onChange={(v) => setSearchInType(v || null)}
                                title="Only show nodes with a signature taking this type as input (in: in the search box)"
                                ariaLabel="Filter by input type"
                                font="mono"
                                size="sm"
                                variant="sidebar"
                                block
                                className="flex-1 min-w-0"
                            />
                            <MtlxSelect
                                value={searchOutType || ''}
                                options={outputTypeOptions || []}
                                dots={typeDots}
                                defValue={null}
                                emptyOption="any"
                                valuePrefix="Outputs: "
                                onChange={(v) => setSearchOutType(v || null)}
                                title="Only show nodes with a signature outputting this type (out: in the search box)"
                                ariaLabel="Filter by output type"
                                font="mono"
                                size="sm"
                                variant="sidebar"
                                block
                                className="flex-1 min-w-0"
                            />
                        </div>
                        {/* File-based filter: narrows the tree to categories
                            present in one or more locally picked .mtlx
                            files (AND'd with the search/type filters above).
                            Under VS Code the host drives this itself via the
                            `mtlx-docs-filter` window event, so the picker
                            button is hidden but the chip still shows. */}
                        {(showFilePicker || fileFilter) && (
                            <div className="flex items-center gap-1.5 mb-2 flex-wrap" role="group" aria-label="Filter by file">
                                {showFilePicker && (
                                    <React.Fragment>
                                        <input
                                            ref={fileInputRef}
                                            type="file"
                                            accept=".mtlx"
                                            multiple
                                            className="hidden"
                                            onChange={(e) => {
                                                onPickFiles(e.target.files);
                                                e.target.value = '';
                                            }}
                                        />
                                        <button
                                            onClick={() => fileInputRef.current && fileInputRef.current.click()}
                                            title="Filter the node tree to categories used in one or more .mtlx files"
                                            className="text-xs px-2 py-1 rounded border border-line-control text-fg-secondary hover:text-fg hover:bg-hover"
                                        >
                                            Filter by file
                                        </button>
                                    </React.Fragment>
                                )}
                                {fileFilter && (
                                    <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-selection/20 text-accent-fg-strong max-w-full">
                                        <span className="truncate">In {fileFilter.file}</span>
                                        <button
                                            onClick={onClearFileFilter}
                                            title="Clear the file filter"
                                            aria-label="Clear the file filter"
                                            className="flex-none text-accent-fg-strong/80 hover:text-accent-fg-bright"
                                        >
                                            <MtlxIcon name="x" className="w-3 h-3" />
                                        </button>
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                    <div className="px-4 pb-4 pt-1">
                    {docFilter !== 'all' && !forceOpen && Object.keys(treeData).length === 0 && (
                        <div className="text-xs text-fg-subtle italic">No matching nodes.</div>
                    )}
                    <div className="space-y-1 text-sm">
                        {Object.entries(treeData).map(([lib, groups]) => (
                            <div key={lib} className="select-none">
                                {/* Library Level */}
                                <div
                                    className="flex items-center cursor-pointer hover:text-accent-fg text-fg-soft font-medium py-1"
                                    onClick={() => toggleLib(lib)}
                                >
                                    {(expandedLibs[lib] || forceOpen) ? <ChevronDown /> : <ChevronRight />}
                                    {lib.toUpperCase()}
                                </div>

                                {/* Group Level */}
                                {(expandedLibs[lib] || forceOpen) && (
                                    <div className="ml-4 border-l border-line pl-2 space-y-1 mt-1">
                                        {Object.entries(groups).map(([group, nodes]) => {
                                            const groupKey = `${lib}-${group}`;
                                            return (
                                                <div key={groupKey}>
                                                    <div
                                                        className="flex items-center cursor-pointer hover:text-accent-fg-strong text-fg-muted py-1"
                                                        onClick={() => toggleGroup(lib, group)}
                                                    >
                                                        {(expandedGroups[groupKey] || forceOpen) ? <ChevronDown /> : <ChevronRight />}
                                                        {group}
                                                    </div>

                                                    {/* Node Level */}
                                                    {(expandedGroups[groupKey] || forceOpen) && (
                                                        <div className="ml-4 border-l border-line pl-2 space-y-1 mt-1">
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
                                                                    ? 'bg-accent-fill text-on-accent'
                                                                    : (undoc ? 'text-fg-muted hover:bg-warning-bg/20 hover:text-warning' : 'text-fg-muted hover:bg-hover-accent/20 hover:text-accent-fg-strong');
                                                                return (
                                                                    <div
                                                                        key={nodeName}
                                                                        onClick={() => setSelectedNode({ lib, group, name: nodeName, info: nodeInfo })}
                                                                        className={`cursor-pointer py-1 px-2 rounded font-mono text-xs break-all ${rowCls}`}
                                                                    >
                                                                        {nodeName}
                                                                        {undoc && <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning-marker ml-1.5 align-middle" />}
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
                    className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-scrim-alt/60"
                    onClick={onClose}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Help"
                >
                    <div
                        className="bg-surface-raised border border-line rounded-lg shadow-xl max-w-xl w-full max-h-[85vh] overflow-y-auto custom-scrollbar p-5 sm:p-6"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-start justify-between gap-4 mb-3">
                            <h2 className="text-lg font-semibold text-fg">How to use the Node Library</h2>
                            <button
                                onClick={onClose}
                                title="Close (Esc)"
                                className="text-fg-muted hover:text-fg-soft text-xl leading-none px-1"
                                aria-label="Close help"
                            >
                                &times;
                            </button>
                        </div>
                        <div className="space-y-3 text-sm text-fg-secondary">
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
                                <span className="font-semibold text-fg">Browsing.</span>{' '}
                                The left panel lists every node, grouped by library and node group. The
                                segmented control above the search box shows all nodes, only documented, or
                                only undocumented ones, each with its count. Use the search box to filter by
                                name, and the icon next to it to expand or collapse everything. The
                                "Inputs"/"Outputs" row below filters by port type: "Outputs" keeps nodes
                                with a signature that outputs the chosen type, "Inputs" keeps nodes with a
                                signature that takes it as an input; choosing "any" clears a filter. Typing{' '}
                                <code>out:&lt;type&gt;</code> or <code>in:&lt;type&gt;</code> directly into
                                the search box (e.g. <code>out:color3</code>) does the same thing and can be
                                combined with a name and with each other.
                            </p>
                            <p>
                                <span className="font-semibold text-fg">Documentation.</span>{' '}
                                Selecting a node shows its description, port tables, and references from the
                                specification. Links to other nodes open directly in the app; everything else
                                opens the official spec on GitHub.
                            </p>
                            <p>
                                <span className="font-semibold text-fg">3D preview.</span>{' '}
                                Most nodes render live in WebGL: drag to orbit, scroll to zoom. The controls
                                on the viewport switch the preview geometry, start/stop the turntable
                                rotation, show the environment as background, save a PNG preview, and go
                                full screen. Editing values in the parameter panel regenerates the shader,
                                and the node can be downloaded as a .mtlx document with the current values.
                                The cube button in the panel header toggles all WebGL previews globally, to
                                save resources on slow machines.
                            </p>
                            <p className="text-fg-muted">
                                Something broken or missing? Report it on the{' '}
                                <a
                                    href={window.SITE_LINKS.issues}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-accent-fg hover:text-accent-fg-strong underline decoration-accent-wash/40"
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
