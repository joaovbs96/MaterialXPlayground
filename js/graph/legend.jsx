// js/graph/legend.jsx: the MaterialX type-color legend, shared by the
// graph editor and the read-only graph preview so the two cannot drift.
// Exports legendTypesFor/legendDisplayTypesFor (pure derivations) and
// MtlxTypeLegend (open card, collapsed pill, tri-state control). Loaded
// after js/graph/style.jsx (needs typeColor/TYPE_COLORS/getNodeColor) and
// before js/graph-app.jsx, per js/shell.jsx's VIEW_DEPS.graph manifest.
//
// BTN_TOOLBAR, used by the collapsed pill, is a global from
// js/shared/mtlx-ui.jsx: any consumer must load that file first.
// MtlxIcon is a global from js/shared/ui-commons.js.
//
// .custom-scrollbar (the open card's type grid) is defined only in
// index.html's <style> block, not in any .css file. A standalone page
// embedding this legend must carry those rules itself; do not
// duplicate them into a stylesheet.

        // Every type used anywhere in the given nodes: each node's own
        // type attribute (data.type, e.g. 'multioutput' on stdlib
        // translation nodes), every port type (data.inputs/data.outputs),
        // plus 'nodegraph'/'node' when a node's header dot (getNodeColor)
        // falls back to that kind color, deduped and alphabetized.
        function legendTypesFor(nodes) {
            const s = new Set();
            for (const n of nodes) {
                const d = n.data || {};

                // The node's own type attribute drives its header dot
                // color (getNodeColor case 2); census it directly so
                // e.g. multioutput nodes show up even with no synthetic
                // 'multioutput' port left on data.outputs.
                if (d.type) s.add(d.type);

                // Scan every input/output port's type
                for (const p of (d.inputs || [])) if (p.type) s.add(p.type);
                for (const p of (d.outputs || [])) if (p.type) s.add(p.type);

                // Node KINDS (not MaterialX data types) get their own dot
                // color in getNodeColor; report them so nodegraph/generic
                // nodes actually show up in the in-graph legend too.
                const nc = getNodeColor(d);
                if (nc === typeColor('nodegraph')) s.add('nodegraph');
                else if (nc === typeColor('node')) s.add('node');
            }
            return Array.from(s).sort((a, b) =>
                a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
        }

        // What the legend actually renders: just the given in-scope types, or
        // (showAll) every TYPE_COLORS type merged with any extra (hash-colored)
        // types the caller's types list contains.
        function legendDisplayTypesFor(legendTypes, showAll) {
            if (!showAll) return legendTypes;
            const s = new Set([...Object.keys(TYPE_COLORS), ...legendTypes]);
            return Array.from(s).sort((a, b) =>
                a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
        }

        // Types (legend) tristate control: minimize / default / show-all, each
        // button jumping straight to its own target state. Rendered identically
        // in the card header and the minimized pill.
        function LegendTriState({ legendOpen, legendShowAll, setLegendOpen, setLegendShowAll }) {
            const state = !legendOpen ? 'min' : (legendShowAll ? 'all' : 'default');
            const SEGMENTS = [
                { key: 'min', icon: 'minus', title: 'Minimize the legend', apply: () => setLegendOpen(false) },
                { key: 'default', icon: 'color-filter', title: 'Show types used in the current graph', apply: () => { setLegendOpen(true); setLegendShowAll(false); } },
                { key: 'all', icon: 'plus', title: 'Show all known type colors', apply: () => { setLegendOpen(true); setLegendShowAll(true); } },
            ];
            return (
                <div className="flex items-center -mr-1">
                    {SEGMENTS.map((seg) => {
                        const active = state === seg.key;
                        return (
                            <button
                                key={seg.key}
                                onClick={(e) => { e.stopPropagation(); seg.apply(); }}
                                title={seg.title}
                                aria-pressed={active}
                                className={'rounded px-1 leading-none transition-colors ' + (active
                                    ? 'bg-blue-600/70 text-white'
                                    : 'text-gray-400 hover:text-gray-200')}
                            ><MtlxIcon name={seg.icon} className="w-3.5 h-3.5" /></button>
                        );
                    })}
                </div>
            );
        }

        // The shared legend UI: the open card, the collapsed pill, and the
        // tri-state control embedded in both. The caller owns open/showAll
        // state and the ref that measures whichever branch is rendered.
        function MtlxTypeLegend({ types, displayTypes, open, showAll, setOpen, setShowAll, nodeCount, connectionCount, showCounts }) {
            return open ? (
                // w-80 (not w-60): the longest type name (displacementshader,
                // ~133px at this legend's text-[11px] font-mono) doesn't fit
                // in a grid-cols-2 column at the old width.
                <div className="bg-gray-800/90 backdrop-blur border border-gray-700 rounded-lg p-3 w-80">
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Types</span>
                        <LegendTriState
                            legendOpen={open}
                            legendShowAll={showAll}
                            setLegendOpen={setOpen}
                            setLegendShowAll={setShowAll}
                        />
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 max-h-48 overflow-y-auto custom-scrollbar">
                        {displayTypes.map((t) => {
                            const inGraph = types.indexOf(t) !== -1;
                            return (
                                <div key={t}
                                    className={'flex items-center gap-1.5 text-[11px] font-mono min-w-0 '
                                        + (inGraph ? 'text-gray-400' : 'text-gray-600')}
                                    title={inGraph ? t : t + ' (not in current graph)'}
                                >
                                    <span className={'w-2 h-2 rounded-full flex-none' + (inGraph ? '' : ' opacity-50')}
                                        style={{ background: typeColor(t) }} />
                                    <span className="truncate">{t}</span>
                                </div>
                            );
                        })}
                        {!displayTypes.length && (
                            <div className="col-span-2 text-[11px] text-gray-500">No typed ports in view.</div>
                        )}
                    </div>
                    {showCounts && (
                        <div className="text-[10px] text-gray-500 mt-2 pt-1.5 border-t border-gray-700">
                            {nodeCount} node{nodeCount === 1 ? '' : 's'} {'\u00B7'}{' '}
                            {connectionCount} connection{connectionCount === 1 ? '' : 's'}
                        </div>
                    )}
                </div>
            ) : (
                // Label first, dots after, same treatment as
                // the open card's header. A <div role="button">,
                // not a real <button>: it hosts the tristate's own nested buttons.
                <div
                    role="button"
                    tabIndex={0}
                    onClick={() => { setOpen(true); setShowAll(false); }}
                    onKeyDown={(e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return;
                        e.preventDefault();
                        setOpen(true);
                        setShowAll(false);
                    }}
                    title="Show the type color legend"
                    className={BTN_TOOLBAR + ' cursor-pointer'}
                >
                    <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Types</span>
                    {types.slice(0, 3).map((t) => (
                        <span key={t} className="w-2 h-2 rounded-full" style={{ background: typeColor(t) }} />
                    ))}
                    <LegendTriState
                        legendOpen={open}
                        legendShowAll={showAll}
                        setLegendOpen={setOpen}
                        setLegendShowAll={setShowAll}
                    />
                </div>
            );
        }

Object.assign(window, {
    legendTypesFor, legendDisplayTypesFor, MtlxTypeLegend,
});
