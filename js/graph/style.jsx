// js/graph/style.jsx — layout (dagre) and MaterialX type -> color mapping,
// plus the descriptor/edge -> React Flow nodes/edges conversion. Split out
// of js/graph-app.jsx (pure move, no behavior change) as part of the graph
// view's file split. Loaded after js/graph/model.jsx in the graph view's
// babelScripts manifest (see js/shell.jsx's VIEW_DEPS.graph). Like every
// other lazy-loaded file in this app, this file has NO top-level import/
// export — it self-exports via a single Object.assign(window, {}) at the
// bottom.

        const { MarkerType } = window.ReactFlow;

        // ---- Layout ----------------------------------------------------------

        const NODE_W = 240;
        // Must track MtlxGraphNode's real metrics (header ~34px, row 22px)
        // or dagre's ranks drift apart from what actually renders.
        const nodeHeight = (d) => 38 + (d.inputs.length + d.outputs.length) * 22 + 6;

        const layoutScope = (descs, edges) => {
            // Two return points below (stored-position fast path vs. a real
            // dagre pass) — each logs its own line when the flag is on, so
            // a scope change that logs BOTH buildScope and two layoutScope
            // lines back to back would flag a double-layout.
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
                posOf[d.id] = { x: n.x - NODE_W / 2, y: n.y - nodeHeight(d) / 2 };
            }
            if (MTLX_PERF_LOG) {
                console.log('[mtlx-perf] layoutScope (dagre): '
                    + descs.length + ' nodes, ' + (performance.now() - __perfStart).toFixed(1) + 'ms');
            }
            return posOf;
        };

        // ---- React Flow node rendering ---------------------------------------

        // MaterialX type → port/edge color. Every standard type has a curated,
        // hand-spread hue (so co-occurring types are never confusable — the old
        // table gave matrix33 and matrix44 the SAME color, and made integer a
        // near-twin of float). The shader family intentionally clusters in the
        // green band but separated by lightness. Anything not in the table
        // (custom/struct/array types) falls back to a deterministic hash of the
        // type name, so a given type keeps the exact same color in every scope,
        // every document, every session.
        const TYPE_COLORS = {
            boolean: '#d2372b',            // crimson red
            BSDF: '#2e7d32',               // forest green
            color3: '#fdd835',             // sunflower yellow
            color4: '#f4511e',             // coral orange
            displacementshader: '#8d6e63', // warm taupe
            EDF: '#cddc39',                // yellow-green
            filename: '#90a4ae',           // cool blue-gray
            float: '#3949ab',              // deep indigo blue
            integer: '#8e24aa',            // royal violet
            lightshader: '#ff934f',        // warm apricot orange
            material: '#ff404f',           // vivid red
            matrix33: '#cfd8dc',           // pale blue-gray
            matrix44: '#546e7a',           // slate blue-gray
            string: '#d7c4a3',             // warm sand
            surfaceshader: '#00897b',      // deep teal
            vector2: '#5c6bc0',            // muted indigo
            vector3: '#b388ff',            // soft lavender
            vector4: '#ec407a',            // rose pink
            VDF: '#9ccc65',                // fresh green
            volumeshader: '#00bcd4',       // bright cyan
            node: '#a1887f',               // muted warm stone
            nodegraph: '#854d0e'           // bronze brown
        };
        // Stable string hash → hue; fixed saturation/lightness keeps hashed
        // colors legible on the dark stage.
        const typeHue = (s) => {
            let h = 0;
            for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
            return ((h % 360) + 360) % 360;
        };
        const typeColor = (t) => {
            if (!t) return '#94a3b8'; // untyped: default slate
            if (TYPE_COLORS[t]) return TYPE_COLORS[t];
            return 'hsl(' + typeHue(String(t)) + ', 65%, 62%)';
        };

        // Node-kind accents (header dot + minimap) derive from TYPE_COLORS so
        // they always track the palette; nodegraph/generic have no MaterialX
        // type, so they keep their own hues.
        const getNodeColor = (data) => {
            if (!data) return typeColor('node');
            
            // 1. Structural nodes explicitly pull their assigned TYPE_COLORS
            if (data.kind === 'nodegraph') return typeColor('nodegraph');
            if (data.kind === 'input' || data.kind === 'output') return typeColor(data.type);
            
            // 2. Data nodes pull directly from their output type (color3, float, etc)
            if (data.type) return typeColor(data.type);
            
            // 3. Fallbacks just in case a shader/material lacks a type string
            if (data.kind === 'material') return typeColor('material');
            if (data.kind === 'shader') return typeColor('surfaceshader');
            
            return typeColor('node');
        };

        const handleStyle = (color) => ({
            width: 9, height: 9, border: '1.5px solid #111827', background: color,
        });
        // Descriptors + layout → React Flow nodes/edges.
        // Input display, per node: 'authored' (only inputs written in the
        // document — "set") or 'all' (plus every nodedef input at its
        // default value). Connected inputs are ALWAYS visible so no edge
        // ever dangles. keepRow (patchInputConn, js/graph-app.jsx) is a
        // flow-state-only flag that pins a just-disconnected port visible
        // for one more render in 'authored' mode, so it doesn't vanish out
        // from under the user the instant they disconnect it.
        const visiblePortsFor = (all, mode) => all.filter((inp) =>
            inp.connected || inp.keepRow || mode === 'all' || inp.authored !== false);

        const toFlow = (descs, edges, opts) => {
            const o = opts || {};
            const mode = o.portMode || 'authored';
            const connectedIn = new Set(edges.map((e) => e.target + '|' + e.targetHandle));
            // Filter BEFORE layout: nodeHeight() counts the rows that will
            // actually render. data.inputs = the visible rows; data.allInputs
            // = everything (the parameter panel edits from the full list).
            const shaped = descs.map((d) => {
                const withConn = d.inputs.map((inp) => Object.assign({}, inp, {
                    connected: connectedIn.has(d.id + '|in:' + inp.name),
                }));
                return Object.assign({}, d, {
                    allInputs: withConn,
                    inputs: visiblePortsFor(withConn, mode),
                    portMode: mode,
                    onOpen: (d.kind === 'nodegraph' && o.onOpenScope)
                        ? () => o.onOpenScope(d.name) : undefined,
                    onTogglePorts: o.onTogglePorts ? () => o.onTogglePorts(d.id) : undefined,
                    onPortAdd: o.onPortAdd,
                });
            });
            const posOf = layoutScope(shaped, edges);
            const nodes = shaped.map((d) => ({
                id: d.id,
                type: 'mtlx',
                position: posOf[d.id],
                data: d,
            }));
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
    TYPE_COLORS, typeColor, getNodeColor, handleStyle, NODE_W, nodeHeight, layoutScope,
    visiblePortsFor, toFlow, toRfEdge, CONN_ATTRS,
});
