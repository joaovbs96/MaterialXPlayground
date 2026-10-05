// js/graph/style.jsx — dagre layout, MaterialX type -> color mapping,
// and descriptor/edge -> React Flow node/edge conversion. Loaded after
// js/graph/model.jsx per js/shell.jsx's VIEW_DEPS.graph manifest. Like
// other lazy-loaded files here, it has no top-level import/export — it
// self-exports via Object.assign(window, {}) at the bottom.

        const { MarkerType } = window.ReactFlow;

        // ---- Layout ----------------------------------------------------------

        const NODE_W = 240;
        // A ShadingLanguageX node's card is wider, to fit its code
        // (SlxNodeCode, node-component.jsx): the code view's editor,
        // SLX_MIN_ROWS to SLX_MAX_ROWS lines tall at that editor's line
        // height and padding (CODE_LINE_HEIGHT, CODE_PAD_Y in
        // js/graph/code-view.jsx), plus room for its horizontal
        // scrollbar; then the status line and padding around it all
        // (SLX_EDITOR_CHROME_H).
        const SLX_NODE_W = 420;
        const SLX_LINE_H = 18;
        const SLX_PAD_Y = 8;
        const SLX_MIN_ROWS = 6;
        const SLX_MAX_ROWS = 22;
        const SLX_EDITOR_CHROME_H = 37;
        const slxEditorHeight = (code) => Math.min(SLX_MAX_ROWS,
            Math.max(SLX_MIN_ROWS, String(code == null ? '' : code).split('\n').length)) * SLX_LINE_H + 2 * SLX_PAD_Y + 10;
        const nodeWidth = (d) => ((d && d.slx) ? SLX_NODE_W : NODE_W);
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
            const editor = (d && d.slx) ? slxEditorHeight(d.slx.source) + SLX_EDITOR_CHROME_H : 0;
            // The "= value" line under the ports (node-component.jsx) is a 22px row too.
            const valueRow = d && d.value !== undefined && d.value !== '' ? 1 : 0;
            return HEADER_H + 6 + (inputCount + outputCount + valueRow) * 22 + editor + (d && d.thumb ? (d.thumbSize === 'small' ? THUMB_SMALL_DELTA : thumbRowH(d)) : 0);
        };

        // Square preview on top of the card: the inner card width (NODE_W less the 1px border each
        // side) plus the 1px separator under it.
        const THUMB_SIDE = NODE_W - 2;
        // Header of a card without a preview: 8 padding, an 18 name row, a 13 type row, 1 separator.
        const HEADER_H = 40;
        const THUMB_ROW_H = THUMB_SIDE + 1;
        // The large preview spans the card's own width, so a wider code-node card gets a taller square.
        const thumbRowH = (d) => nodeWidth(d) - 2 + 1;
        // Small preview: the header becomes 64px of content plus its 1px separator (65).
        const THUMB_SMALL = 64;
        const THUMB_SMALL_DELTA = THUMB_SMALL + 1 - HEADER_H;
        // Types drawn on the shaderball. Volume, displacement and light shaders are excluded.
        const SHADER_THUMB_TYPES = ['surfaceshader', 'BSDF', 'EDF', 'VDF', 'material'];
        // Thumbnail class of a card: 'pattern' (flat preview), 'shader' (shaderball) or null.
        // The output is picked like pickPreviewOutput: first viewable, else the first.
        const thumbKind = (d) => {
            if (!d || typeof d.id !== 'string') return null;
            const viewable = (t) => window.MtlxGenCore.COLOR_VIEWABLE.indexOf(t) !== -1;
            const byType = (t) => (viewable(t) ? 'pattern' : SHADER_THUMB_TYPES.indexOf(t) !== -1 ? 'shader' : null);
            const k = d.id.slice(0, 2);
            if (k === 'o:' || k === 'i:') return byType(d.type);
            if (k !== 'n:' && k !== 'g:' && k !== 'd:') return null;
            const outs = Array.isArray(d.outputs) ? d.outputs : [];
            if (k === 'n:' && d.kind === 'node') return outs.some((o) => viewable(o.type)) ? 'pattern' : null;
            if (k === 'n:' && d.kind !== 'shader' && d.kind !== 'material') return null;
            const pick = outs.find((o) => viewable(o.type)) || outs[0];
            const kind = byType(pick ? pick.type : d.type);
            if (kind === 'shader' && d.kind === 'material') {
                // Needs a connected surfaceshader input, like the click preview.
                const ok = Array.isArray(d.inputs) && d.inputs.some((i) => i.type === 'surfaceshader' && (i.nodename || i.nodegraph || i.connected));
                return ok ? 'shader' : null;
            }
            return kind;
        };
        const thumbEligible = (d) => !!thumbKind(d);

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
            for (const d of descs) g.setNode(d.id, { width: nodeWidth(d), height: nodeHeight(d) });
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
                posOf[d.id] = { x: n.x - nodeWidth(d) / 2, y: n.y - nodeHeight(d) / 2 };
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

            // Definition cards (nodedef-only, or a functional nodegraph)
            // read as nodegraphs regardless of their resolved output type.
            if (data.kind === 'nodedef' || data.functional) return typeColor('nodegraph');

            // 2. Data nodes pull directly from their output type
            // (color3, float, etc)
            if (data.type) return typeColor(data.type);
            
            // 3. Fallbacks just in case a shader/material lacks a type string
            if (data.kind === 'material') return typeColor('material');
            if (data.kind === 'shader') return typeColor('surfaceshader');
            
            return typeColor('node');
        };

        // Resolved rgba string (RF sets it as an SVG paint), same format as the old literal.
        const minimapMaskColor = () => {
            const h = MtlxTheme.get('graph-minimap-mask');
            const a = MtlxTheme.param('graph', 'minimapMaskAlpha', 0.75);
            return 'rgba(' + [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ') + ', ' + a + ')';
        };

        const handleStyle = (color) => ({
            width: 9, height: 9, border: '1.5px solid ' + MtlxTheme.var('graph-canvas'), background: color,
        });
        // Port mode 'authored' shows only doc-set inputs; 'all' shows
        // all nodedef inputs. keepRow pins a disconnected port visible
        // for one extra render so it doesn't vanish mid-interaction.
        const visiblePortsFor = (all, mode) => all.filter((inp) =>
            inp.connected || inp.keepRow || mode === 'all' || inp.authored !== false);

        const toFlow = (descs, edges, opts) => {
            const o = opts || {};
            // Thumbnail enable state is decided before layout so card heights are right.
            if (o.thumbPrep) o.thumbPrep(descs);
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
                const th = o.thumbFor ? o.thumbFor(d) : null;
                return Object.assign({}, d, th ? {
                    thumb: th.on, thumbSize: th.size, thumbElig: th.eligible, thumbKind: th.kind, thumbKey: th.key, thumbStore: th.store,
                } : null, {
                    allInputs: withConn,
                    inputs: visiblePortsFor(withConn, nodeMode),
                    portMode: nodeMode,
                    onOpen: (d.kind === 'nodegraph' && o.onOpenScope)
                        ? () => o.onOpenScope(d.name) : undefined,
                    // A data node whose nodedef is backed by a library
                    // nodegraph (e.g. standard_surface -> NG_standard_
                    // surface_surfaceshader) can jump straight to it, view only.
                    onOpenImpl: (d.implGraph && o.onOpenImpl)
                        ? () => o.onOpenImpl(d.implGraph, d.id) : undefined,
                    implGraph: d.implGraph,
                    onTogglePorts: o.onTogglePorts ? () => o.onTogglePorts(d.id) : undefined,
                    onPortAdd: o.onPortAdd,
                    // Inline rename on the card. The `renaming` flag itself is
                    // patched onto one node in place (no rebuild); these are
                    // the bound callbacks the editor commits through.
                    onRenameStart: o.onRenameStart ? () => o.onRenameStart(d.id) : undefined,
                    onRenameCommit: o.onRenameCommit ? (name) => o.onRenameCommit(d.id, name) : undefined,
                    onRenameCancel: o.onRenameCancel ? () => o.onRenameCancel(d.id) : undefined,
                    renameIssueFor: o.renameIssueFor ? (name) => o.renameIssueFor(d.id, name) : undefined,
                    // ShadingLanguageX code node: its source, an unsaved
                    // draft kept across remounts (slxDraftFor), and the
                    // compile/draft callbacks. Without onSlxCompile (read-
                    // only scope, graph previews) the code shows read-only.
                    slx: d.slx ? Object.assign({}, d.slx, {
                        draft: o.slxDraftFor ? o.slxDraftFor(d.name, d.slx.source) : null,
                        unavailable: !!o.slxUnavailable,
                    }) : undefined,
                    onSlxCompile: (d.slx && o.onSlxCompile) ? (src) => o.onSlxCompile(d.name, src) : undefined,
                    onSlxDraft: (d.slx && o.onSlxDraft) ? (st) => o.onSlxDraft(d.name, st) : undefined,
                    onOpenNodeDocs: d.slx ? o.onOpenNodeDocs : undefined,
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
    getNodeColor, handleStyle, minimapMaskColor, NODE_W, nodeWidth, THUMB_SIDE, THUMB_ROW_H, thumbRowH, THUMB_SMALL, THUMB_SMALL_DELTA, thumbEligible, thumbKind, SHADER_THUMB_TYPES, nodeHeight, layoutScope,
    SLX_NODE_W, slxEditorHeight,
    visiblePortsFor, toFlow, toRfEdge, CONN_ATTRS,
});
