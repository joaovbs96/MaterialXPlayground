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
            expandAll, collapseAll, expandedLibs, toggleLib, expandedGroups, toggleGroup,
            selectedNode, setSelectedNode,
            stats, applyDocFilter, showPreviews, togglePreviews, onShowHelp, collapsed, onCollapse,
        }) {
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
                                    onClick={onCollapse}
                                    title="Collapse the node library panel"
                                    aria-label="Collapse the node library panel"
                                    className="hidden md:block p-1 rounded-md text-gray-500 hover:text-gray-200 hover:bg-gray-700"
                                >
                                    <MtlxIcon name="chevrons-left" className="w-4 h-4" />
                                </button>
                            </div>
                        </div>
                        <p className="text-xs text-gray-500 pb-2">
                            Documentation browser and live previews for the MaterialX node libraries.
                        </p>
                        {stats && (
                            <div className="grid grid-cols-2 gap-1.5 mb-2 text-center">
                                <div className="rounded-lg border border-blue-500 bg-blue-500/[0.12] px-2 py-1.5 flex flex-col gap-0.5">
                                    <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-blue-300">Nodes</span>
                                    <span className="text-sm font-semibold text-blue-300">{stats.total}</span>
                                </div>
                                <div className="rounded-lg border border-amber-700/60 bg-amber-900/20 px-2 py-1.5 flex flex-col gap-0.5">
                                    <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-400">
                                        Without docs
                                    </span>
                                    <span className="text-sm font-semibold text-amber-300">{stats.undoc}</span>
                                </div>
                            </div>
                        )}
                        {/* Both controls are intrinsically sized (invisible-sizer technique,
                            not flex-1); this row drives the sidebar's min-content grid column
                            (js/docs-app.jsx), so it always fits on one line without flex-wrap. */}
                        <div className="flex items-center gap-1.5 pb-2">
                            <div className="inline-flex shrink-0 rounded-lg border border-gray-700 overflow-hidden" role="group" aria-label="Documentation filter">
                                {[
                                    { mode: 'all', icon: 'file-infinity', label: 'All Nodes' },
                                    { mode: 'documented', icon: 'file-check', label: 'Documented' },
                                    { mode: 'undocumented', icon: 'file-x', label: 'Undocumented' },
                                ].map(({ mode, icon, label }, i) => {
                                    const active = docFilter === mode;
                                    const activeCls = mode === 'undocumented'
                                        ? 'bg-amber-900/20 text-amber-400 ring-1 ring-inset ring-amber-700/60'
                                        : 'bg-blue-500/[0.12] text-blue-300 ring-1 ring-inset ring-blue-500/60';
                                    return (
                                        <button
                                            key={mode}
                                            onClick={() => applyDocFilter(mode)}
                                            title={label}
                                            aria-label={label}
                                            aria-pressed={active}
                                            className={`p-1.5 flex items-center gap-1 transition-colors first:rounded-l-[7px] last:rounded-r-[7px] ${i > 0 ? `border-l ${active && mode === 'undocumented' ? 'border-amber-700/60' : 'border-gray-700'}` : ''} ${
                                                active
                                                    ? activeCls
                                                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                                            }`}
                                        >
                                            <MtlxIcon name={icon} className="w-4 h-4 shrink-0" />
                                            {docFilter === mode && (
                                                /* Invisible sizer: the longest label ("Undocumented") reserves the
                                                   column width, the real label overlays it — the group's total width
                                                   is therefore identical whichever segment is active. */
                                                <span className="text-xs grid text-left whitespace-nowrap">
                                                    <span className="invisible col-start-1 row-start-1" aria-hidden="true">Undocumented</span>
                                                    <span className="col-start-1 row-start-1">{label}</span>
                                                </span>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                            <button
                                onClick={togglePreviews}
                                aria-pressed={showPreviews}
                                aria-label="Toggle 3D previews"
                                title={showPreviews
                                    ? '3D previews are on — click to disable the WebGL node previews (saves resources on slow machines)'
                                    : '3D previews are off — click to enable the WebGL node previews'}
                                className={`shrink-0 p-1.5 rounded-lg border flex items-center gap-1 transition-colors ${
                                    showPreviews
                                        ? 'bg-blue-500/[0.12] border-blue-500 text-blue-300 hover:bg-blue-500/20'
                                        : 'bg-gray-800 border-amber-700/60 text-amber-400 hover:bg-gray-700'
                                }`}
                            >
                                <MtlxIcon name={showPreviews ? 'cube' : 'cube-off'} className="w-4 h-4 shrink-0" />
                                <span className="text-xs whitespace-nowrap">3D Preview</span>
                            </button>
                        </div>
                        <div className="flex items-center gap-1 pb-2">
                            <div className="relative flex-1 min-w-0">
                                <input
                                    type="text"
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    placeholder="Search nodes..."
                                    className="w-full bg-gray-900 border border-gray-700 rounded-md px-3 py-1.5 pr-8 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                                />
                                {searchQuery && (
                                    <button
                                        onClick={() => setSearchQuery('')}
                                        title="Clear search"
                                        className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-200"
                                    >
                                        <MtlxIcon name="x" className="w-3.5 h-3.5" />
                                    </button>
                                )}
                            </div>
                            <button
                                onClick={expandAll}
                                title="Expand all"
                                className="shrink-0 p-1 rounded-md text-gray-500 hover:text-gray-200 hover:bg-gray-700"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 5l5 5 5-5M7 14l5 5 5-5" />
                                </svg>
                            </button>
                            <button
                                onClick={collapseAll}
                                title="Collapse all"
                                className="shrink-0 p-1 rounded-md text-gray-500 hover:text-gray-200 hover:bg-gray-700"
                            >
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 10l5-5 5 5M7 19l5-5 5 5" />
                                </svg>
                            </button>
                        </div>
                        {matchCount !== null && (
                            <div className="text-xs text-gray-500 pb-1">
                                {matchCount} {matchCount === 1 ? 'match' : 'matches'}
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
                                This page is a browsable reference for the MaterialX node libraries. The
                                documentation is parsed live from the official specification (pinned to the
                                version shown in the header) and joined with the node definitions reported
                                by the MaterialX runtime itself.
                            </p>
                            <p>
                                <span className="font-semibold text-gray-100">Browsing.</span>{' '}
                                The left panel lists every node, grouped by library and node group. Use the
                                search box to filter by name, the arrows next to the search box to expand
                                or collapse everything, and the three filter icons above the search box to
                                show all nodes, only documented, or only undocumented ones. The counters at
                                the top of the panel show how many nodes have documentation.
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
                                The cube button in the left panel toggles all WebGL previews globally, to
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
