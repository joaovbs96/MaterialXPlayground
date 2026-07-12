// impl-matrix.jsx — the implementation-target matrix: which shading-
// language targets the standard library ships an <implementation> for,
// per nodedef signature. Split out of doc-ui.jsx (Phase 3) — pure move,
// no behavior change. Uses nodeDefSigKey (js/docs/port-tables.jsx,
// loaded before this file) and the engine's mxSafe/getMxEnv/vecToArray
// (js/mtlx-engine.js). Loaded as text/babel; Babel executes each file in
// its own function scope, so the public API is exported onto window at
// the bottom.

        // ------------------------------------------------------------------
        // Implementation-target matrix: which render targets (genglsl,
        // genessl, genosl, genmdl, genmsl, ...) the standard library ships an
        // <implementation> for, per nodedef — a documentation aid, not a
        // certification tool (best-effort: falls back to an empty matrix on
        // any WASM binding mismatch rather than throwing).
        // ------------------------------------------------------------------
        // Every MaterialX API call goes through mxSafe (js/mtlx-engine.js),
        // same convention as graph-app.jsx's local `safe` helper.
        const IMPL_TARGET_LABELS = {
            genglsl: 'GLSL', genessl: 'ESSL', genosl: 'OSL', genmdl: 'MDL', genmsl: 'MSL',
        };
        const friendlyTargetLabel = (target) => {
            if (IMPL_TARGET_LABELS[target]) return IMPL_TARGET_LABELS[target];
            const stripped = String(target || '').replace(/^gen/i, '');
            return (stripped || target || '').toUpperCase();
        };

        // Confirmed by reading libraries/targets/{genmsl,genslangl,essl}.mtlx in the
        // vendored MaterialX standard library: these three targets are declared
        // inherit="genglsl", so a nodedef with no explicit implementation for one of
        // them still renders fine via the inherited GLSL source at generation time.
        // Revisit this map if the vendored library version changes.
        const TARGET_INHERITANCE = { essl: 'genglsl', genmsl: 'genglsl', genslang: 'genglsl' };

        // Cached once per page load: nodedefName -> { targets: Set<string>,
        // inherited: Set<string>, graph: boolean }. `graph: true` means the
        // nodedef's implementation is a <nodegraph> (works for every target)
        // rather than a per-target source-code implementation. `inherited`
        // holds targets that have no explicit implementation but resolve via
        // TARGET_INHERITANCE from a target that does (e.g. genmsl -> genglsl).
        let implIndexPromise = null;
        function getImplIndex() {
            if (!implIndexPromise) {
                implIndexPromise = (async () => {
                    const { stdlib } = await getMxEnv();
                    const impls = vecToArray(mxSafe(() => stdlib.getImplementations(), []));
                    const index = {};
                    impls.forEach((impl) => {
                        const nodedefName = mxSafe(() => impl.getAttribute('nodedef'), null);
                        if (!nodedefName) return;
                        if (!index[nodedefName]) index[nodedefName] = { targets: new Set(), inherited: new Set(), graph: false };
                        const ngAttr = mxSafe(() => impl.getAttribute('nodegraph'), '');
                        if (ngAttr) {
                            index[nodedefName].graph = true;
                            return;
                        }
                        const target = mxSafe(() => impl.getAttribute('target'), null);
                        if (target) index[nodedefName].targets.add(target);
                    });
                    // MaterialX also lets a <nodegraph> serve directly as a
                    // function implementation when it carries a `nodedef`
                    // attribute itself, with no separate <implementation>
                    // element pointing at it — this is the dominant pattern
                    // in the standard library (274+ occurrences vs. only 2
                    // uses of the indirect <implementation nodegraph="...">
                    // link handled above). Mirrors graph-app.jsx's
                    // getNodeGraphs()/implGraphNames two-shape handling.
                    const nodegraphs = vecToArray(mxSafe(() => stdlib.getNodeGraphs(), []));
                    nodegraphs.forEach((g) => {
                        const nodedefName = mxSafe(() => g.getAttribute('nodedef'), null);
                        if (!nodedefName) return;
                        if (!index[nodedefName]) index[nodedefName] = { targets: new Set(), inherited: new Set(), graph: false };
                        index[nodedefName].graph = true;
                    });
                    // Resolve target inheritance: a nodedef with no explicit
                    // implementation for an inheriting target (e.g. genmsl)
                    // still renders via the parent target's (genglsl's)
                    // implementation if that one exists. Record such targets
                    // separately in `inherited` so the UI can distinguish
                    // "explicit override" from "works via inheritance".
                    Object.values(index).forEach((entry) => {
                        Object.entries(TARGET_INHERITANCE).forEach(([child, parent]) => {
                            if (entry.targets.has(parent) && !entry.targets.has(child)) {
                                entry.inherited.add(child);
                            }
                        });
                    });
                    return index;
                })();
            }
            return implIndexPromise;
        }

        // props: { nodeName, signature } — the component derives its own
        // per-signature grouping (bySig, keyed by nodeDefSigKey) from the live
        // nodedefs, then uses `signature` to pick out just the row for the
        // currently selected overload, falling back to showing every row
        // (collapsed when identical) if `signature` isn't provided or doesn't
        // match anything.
        function ImplTargetMatrix({ nodeName, signature }) {
            const [state, setState] = React.useState({ status: 'idle', rows: [], allTargets: [] });

            React.useEffect(() => {
                if (!nodeName) { setState({ status: 'idle', rows: [], allTargets: [] }); return undefined; }
                let alive = true;
                setState({ status: 'loading', rows: [], allTargets: [] });
                (async () => {
                    try {
                        const { stdlib } = await getMxEnv();
                        const index = await getImplIndex();
                        const defs = vecToArray(mxSafe(() => stdlib.getMatchingNodeDefs(nodeName), []));
                        if (!defs.length) { if (alive) setState({ status: 'empty', rows: [], allTargets: [] }); return; }

                        // One entry per TYPE SIGNATURE (nodeDefSigKey, same key
                        // groupDefVersions uses) — version-duplicate nodedefs
                        // (e.g. standard_surface 1.0.1/1.0.0) collapse together
                        // and their implementations are unioned.
                        const bySig = {};
                        const order = [];
                        defs.forEach((def) => {
                            let key = null;
                            try { key = nodeDefSigKey(def); } catch (e) { /* ignore */ }
                            const defName = mxSafe(() => def.getName(), null);
                            if (!key) key = defName || String(order.length);
                            let outType = '';
                            try { outType = def.getType(); } catch (e) { /* none */ }
                            if (!bySig[key]) {
                                bySig[key] = { key, type: outType, targets: new Set(), inherited: new Set(), graph: false };
                                order.push(key);
                            }
                            const info = defName && index[defName];
                            if (info) {
                                if (info.graph) bySig[key].graph = true;
                                info.targets.forEach((t) => bySig[key].targets.add(t));
                                info.inherited.forEach((t) => bySig[key].inherited.add(t));
                            }
                        });

                        const sigRows = order.map((key) => bySig[key]);
                        const sameImpl = (a, b) => a.graph === b.graph
                            && a.targets.size === b.targets.size
                            && [...a.targets].every((t) => b.targets.has(t))
                            && a.inherited.size === b.inherited.size
                            && [...a.inherited].every((t) => b.inherited.has(t));
                        // When the caller tells us which signature/overload is
                        // currently selected (and it matches one we built),
                        // show only that row — don't let the other overloads'
                        // rows leak into the currently-selected node's matrix.
                        // Only fall back to the "collapse if identical" /
                        // "show every row" behavior when we have no usable
                        // signature match (e.g. no signature prop, or a
                        // mismatch against bySig — defensive, so we still show
                        // something rather than nothing).
                        let rows;
                        if (signature && bySig[signature]) {
                            rows = [bySig[signature]];
                        } else {
                            // Collapse to a single row when every signature
                            // shares the exact same implementation set — the
                            // common case.
                            rows = sigRows.length > 1 && sigRows.every((r) => sameImpl(r, sigRows[0]))
                                ? [sigRows[0]] : sigRows;
                        }

                        const allTargets = new Set();
                        Object.values(index).forEach((info) => {
                            info.targets.forEach((t) => allTargets.add(t));
                            info.inherited.forEach((t) => allTargets.add(t));
                        });
                        sigRows.forEach((r) => {
                            r.targets.forEach((t) => allTargets.add(t));
                            r.inherited.forEach((t) => allTargets.add(t));
                        });

                        if (alive) {
                            setState({ status: 'ready', rows, allTargets: [...allTargets].sort() });
                        }
                    } catch (e) {
                        if (alive) setState({ status: 'error', rows: [], allTargets: [] });
                    }
                })();
                return () => { alive = false; };
            }, [nodeName, signature]);

            if (state.status === 'idle' || state.status === 'empty' || state.status === 'error') return null;
            if (state.status === 'loading') {
                return (
                    <div className="text-xs text-gray-500 italic mt-3">
                        Checking shading-language implementations…
                    </div>
                );
            }
            if (!state.rows.length) return null;

            const targets = state.allTargets;
            const badgeBase = 'px-2 py-0.5 rounded border font-mono text-[11px]';

            return (
                <div className="mt-3 mb-2 text-xs">
                    <div className="flex items-start gap-2 flex-wrap">
                        <span className="text-gray-500 uppercase tracking-wider font-semibold pt-0.5">
                            Implementations:
                        </span>
                        <div className="flex flex-col gap-1.5">
                            {state.rows.map((row, i) => (
                                <div key={row.key || i} className="flex items-center gap-1.5 flex-wrap">
                                    {row.graph ? (
                                        <span className={badgeBase + ' border-blue-700/60 bg-blue-950/40 text-blue-300'}>
                                            Graph (all targets)
                                        </span>
                                    ) : targets.length ? (
                                        targets.map((t) => {
                                            const explicit = row.targets.has(t);
                                            const inherited = !explicit && row.inherited.has(t);
                                            return (
                                                <span
                                                    key={t}
                                                    title={
                                                        inherited
                                                            ? 'Inherited from GLSL — no explicit implementation, but MaterialX falls back to the GLSL source at generation time.'
                                                            : t
                                                    }
                                                    className={badgeBase + (
                                                        explicit
                                                            ? ' border-green-700/60 bg-green-950/30 text-green-400'
                                                            : inherited
                                                                ? ' border-green-800/40 border-dashed bg-green-950/10 text-green-600'
                                                                : ' border-gray-700 bg-gray-900 text-gray-600'
                                                    )}
                                                >
                                                    {explicit ? '✓' : inherited ? '✓*' : '–'} {friendlyTargetLabel(t)}
                                                </span>
                                            );
                                        })
                                    ) : (
                                        <span className="text-gray-600 italic">No implementations found.</span>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            );
        }

        // ---- public API ----
        // IMPL_TARGET_LABELS, friendlyTargetLabel, TARGET_INHERITANCE,
        // implIndexPromise, and getImplIndex have no consumers outside this
        // file (checked repo-wide, word-boundary grep) — kept as
        // declarations (used internally by ImplTargetMatrix) but omitted
        // from the export list.
        Object.assign(window, {
            ImplTargetMatrix,
        });
