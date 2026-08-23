// js/graph/style.jsx — dagre layout, MaterialX type -> color mapping,
// and descriptor/edge -> React Flow node/edge conversion. Loaded after
// js/graph/model.jsx per js/shell.jsx's VIEW_DEPS.graph manifest. Like
// other lazy-loaded files here, it has no top-level import/export — it
// self-exports via Object.assign(window, {}) at the bottom.

        const { MarkerType } = window.ReactFlow;

        // ---- Layout ----------------------------------------------------------

        const NODE_W = 240;
        // Must track MtlxGraphNode's real metrics (header ~34px, row 22px)
        // or dagre's ranks drift apart from what actually renders. Guarded:
        // a malformed descriptor (non-array inputs/outputs) used to throw
        // here mid-layout; fall back to 0 rows for the missing side and
        // warn instead, so one bad node degrades the layout, not the page.
        const nodeHeight = (d) => {
            const inputsOk = Array.isArray(d && d.inputs);
            const outputsOk = Array.isArray(d && d.outputs);
            if (!inputsOk || !outputsOk) {
                console.warn('[mtlx] nodeHeight: node "' + (d && d.id) + '" has non-array inputs/outputs — treating the missing side as empty.', d);
            }
            const inputCount = inputsOk ? d.inputs.length : 0;
            const outputCount = outputsOk ? d.outputs.length : 0;
            return 38 + (inputCount + outputCount) * 22 + 6;
        };

        const layoutScope = (descs, edges) => {
            // Two return points (stored-position fast path vs. dagre) each
            // log their own line when MTLX_PERF_LOG is on, so back-to-back
            // layoutScope logs signal a double-layout bug.
            const __perfStart = MTLX_PERF_LOG ? performance.now() : 0;
            const stored = descs.length > 1 && descs.every((d) => d.pos);
            if (stored) {
                // Editor coordinates are unit-ish; scale to pixels. Distinct
                // positions required — some exporters write all-zeros.
                const uniq = new Set(descs.map((d) => d.pos.x + '/' + d.pos.y));
                if (uniq.size > 1) {
                    const posOf = {};
                    for (const d of descs) posOf[d.id] = { x: d.pos.x * 240, y: d.pos.y * 240 };
                    if (MTLX_PERF_LOG) {
                        console.log('[mtlx-perf] layoutScope (stored positions): '
                            + descs.length + ' nodes, ' + (performance.now() - __perfStart).toFixed(1) + 'ms');
                    }
                    return posOf;
                }
            }
            const g = new dagre.graphlib.Graph();
            g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 70, marginx: 24, marginy: 24 });
            g.setDefaultEdgeLabel(() => ({}));
            for (const d of descs) g.setNode(d.id, { width: NODE_W, height: nodeHeight(d) });
            for (const e of edges) g.setEdge(e.source, e.target);
            dagre.layout(g);
            const posOf = {};
            for (const d of descs) {
                const n = g.node(d.id); // dagre positions are CENTERS
                if (!n) {
                    // dagre never assigned this id a position (e.g. it was
                    // never g.setNode()'d, or the graph is otherwise out of
                    // sync with descs). Skip it here — leaving posOf[d.id]
                    // unset — and let toFlow()'s own guard supply a sane
                    // default so the node still renders instead of React
                    // Flow dereferencing an undefined position.
                    console.warn('[mtlx] layoutScope: dagre produced no position for node "' + d.id + '" — leaving it for toFlow\'s default-position fallback.', d);
                    continue;
                }
                posOf[d.id] = { x: n.x - NODE_W / 2, y: n.y - nodeHeight(d) / 2 };
            }
            if (MTLX_PERF_LOG) {
                console.log('[mtlx-perf] layoutScope (dagre): '
                    + descs.length + ' nodes, ' + (performance.now() - __perfStart).toFixed(1) + 'ms');
            }
            return posOf;
        };

        // ---- React Flow node rendering ---------------------------------------

        // TYPE_COLORS, typeHue, typeColor now live in js/shared/ui-commons.js
        // (loaded eagerly before this file); resolved here via window.

        // Node-kind accents (header dot + minimap) derive from TYPE_COLORS so
        // they always track the palette; nodegraph/generic have no MaterialX
        // type, so they keep their own hues.
        const getNodeColor = (data) => {
            if (!data) return typeColor('node');
            
            // 1. Structural nodes explicitly pull their assigned TYPE_COLORS
            if (data.kind === 'nodegraph') return typeColor('nodegraph');
            if (data.kind === 'input' || data.kind === 'output') return typeColor(data.type);
            
            // 2. Data nodes pull directly from their output type
            // (color3, float, etc)
            if (data.type) return typeColor(data.type);
            
            // 3. Fallbacks just in case a shader/material lacks a type string
            if (data.kind === 'material') return typeColor('material');
            if (data.kind === 'shader') return typeColor('surfaceshader');
            
            return typeColor('node');
        };

        const handleStyle = (color) => ({
            width: 9, height: 9, border: '1.5px solid #111827', background: color,
        });
        // Port mode 'authored' shows only doc-set inputs; 'all' shows
        // all nodedef inputs. keepRow pins a disconnected port visible
        // for one extra render so it doesn't vanish mid-interaction.
        const visiblePortsFor = (all, mode) => all.filter((inp) =>
            inp.connected || inp.keepRow || mode === 'all' || inp.authored !== false);

        const toFlow = (descs, edges, opts) => {
            const o = opts || {};
            const mode = o.portMode || 'authored';
            // Per-node overrides, id -> 'authored'|'all'. A rebuild caused by
            // a LOCAL action passes the modes the cards already had, so one
            // node's rename/paste/group doesn't reset every other card to the
            // global. Absent ids (new nodes) fall back to the global mode.
            const modes = o.portModes || null;
            const connectedIn = new Set(edges.map((e) => e.target + '|' + e.targetHandle));
            // Filter BEFORE layout: nodeHeight() counts the rows that will
            // actually render. data.inputs = the visible rows; data.allInputs
            // = everything (the parameter panel edits from the full list).
            const shaped = descs.map((d) => {
                const withConn = d.inputs.map((inp) => Object.assign({}, inp, {
                    connected: connectedIn.has(d.id + '|in:' + inp.name),
                }));
                const nodeMode = (modes && modes[d.id]) || mode;
                return Object.assign({}, d, {
                    allInputs: withConn,
                    inputs: visiblePortsFor(withConn, nodeMode),
                    portMode: nodeMode,
                    onOpen: (d.kind === 'nodegraph' && o.onOpenScope)
                        ? () => o.onOpenScope(d.name) : undefined,
                    onTogglePorts: o.onTogglePorts ? () => o.onTogglePorts(d.id) : undefined,
                    onPortAdd: o.onPortAdd,
                    // Inline rename on the card. The `renaming` flag itself is
                    // patched onto one node in place (no rebuild); these are
                    // the bound callbacks the editor commits through.
                    onRenameStart: o.onRenameStart ? () => o.onRenameStart(d.id) : undefined,
                    onRenameCommit: o.onRenameCommit ? (name) => o.onRenameCommit(d.id, name) : undefined,
                    onRenameCancel: o.onRenameCancel ? () => o.onRenameCancel(d.id) : undefined,
                    renameIssueFor: o.renameIssueFor ? (name) => o.renameIssueFor(d.id, name) : undefined,
                });
            });
            const posOf = layoutScope(shaped, edges);
            // A missing posOf[d.id] (layoutScope skipped it, or a
            // stored-position document is missing an entry) would hand
            // React Flow `position: undefined` — it derefs node.position.x
            // during its own render, unmounting the root. Fall back to a
            // small index-based grid (not all-zeros, so fallback nodes
            // don't stack exactly on top of each other) and warn once.
            const nodes = shaped.map((d, i) => {
                let pos = posOf[d.id];
                if (!pos) {
                    console.warn('[mtlx] toFlow: no layout position for node "' + d.id + '" — using a default grid position so it still renders.', d);
                    pos = { x: (i % 6) * (NODE_W + 40), y: Math.floor(i / 6) * 200 };
                }
                return {
                    id: d.id,
                    type: 'mtlx',
                    position: pos,
                    data: d,
                };
            });
            const rfEdges = edges.map(toRfEdge);
            return { nodes, edges: rfEdges };
        };

        // One flow edge, styled by its MaterialX type — used by toFlow AND by
        // onConnect (live drag-connections), so the two always look identical.
        const toRfEdge = (e) => ({
            id: e.id, source: e.source, sourceHandle: e.sourceHandle,
            target: e.target, targetHandle: e.targetHandle,
            data: { type: e.type || '' },
            style: { stroke: typeColor(e.type), strokeWidth: 1.5 },
            markerEnd: { type: MarkerType.ArrowClosed, color: typeColor(e.type), width: 14, height: 14 },
        });

        // The attributes that make an <input> (or <output>) element a
        // CONNECTION in MaterialX. Clearing all of them = disconnecting.
        const CONN_ATTRS = ['interfacename', 'nodegraph', 'nodename', 'output'];

Object.assign(window, {
    getNodeColor, handleStyle, NODE_W, nodeHeight, layoutScope,
    visiblePortsFor, toFlow, toRfEdge, CONN_ATTRS,
});
