// impl-matrix.jsx — the implementation-target matrix: which shading-
// language targets the standard library ships an <implementation> for,
// per nodedef signature. Pure presentational component now: the
// per-signature target index (previously built live in-browser via
// getImplIndex()/nodeDefSigKey against the WASM stdlib) is pregenerated
// at build time by scripts/build-nodelib.mjs's buildImplRows port
// (scripts/lib/nodedef-extract.mjs) into js/gen/nodelib-index.json, and
// passed down as the `implRows`/`allTargets` props — this file does no
// WASM work of its own. Loaded as text/babel; Babel executes each file
// in its own function scope, so the public API is exported onto window
// at the bottom.

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

        // props: { nodeName, signature, implRows, allTargets }. implRows is
        // the pregenerated per-signature array (scripts/build-nodelib.mjs's
        // buildImplRows, see js/docs-app.jsx's call site) — [{key, type,
        // targets: [...sorted], inherited: [...sorted], graph}], one entry
        // per TYPE SIGNATURE (same nodeDefSigKey grouping groupDefVersions
        // uses). `signature` picks out just the row for the currently
        // selected overload, falling back to showing every row (collapsed
        // when identical) if `signature` isn't provided or doesn't match
        // anything — same selection rule the old live version used, just
        // operating on plain arrays instead of Sets/state now that the data
        // arrives ready-made instead of being computed in an effect.
        function ImplTargetMatrix({ nodeName, signature, implRows, allTargets }) {
            if (!nodeName || implRows == null || !implRows.length) return null;

            const bySig = {};
            implRows.forEach((r) => { bySig[r.key] = r; });

            const sameImpl = (a, b) => a.graph === b.graph
                && a.targets.length === b.targets.length
                && a.targets.every((t) => b.targets.indexOf(t) !== -1)
                && a.inherited.length === b.inherited.length
                && a.inherited.every((t) => b.inherited.indexOf(t) !== -1);

            let rows;
            if (signature && bySig[signature]) {
                rows = [bySig[signature]];
            } else {
                // Collapse to a single row when every signature shares the
                // exact same implementation set — the common case.
                rows = implRows.length > 1 && implRows.every((r) => sameImpl(r, implRows[0]))
                    ? [implRows[0]] : implRows;
            }

            const targets = allTargets || [];
            const badgeBase = 'px-2 py-0.5 rounded border font-mono text-[11px]';

            return (
                <div className="mt-3 mb-2 text-xs">
                    <div className="flex items-start gap-2 flex-wrap">
                        <span className="text-gray-500 uppercase tracking-wider font-semibold pt-0.5">
                            Implementations:
                        </span>
                        <div className="flex flex-col gap-1.5">
                            {rows.map((row, i) => (
                                <div key={row.key || i} className="flex items-center gap-1.5 flex-wrap">
                                    {row.graph ? (
                                        <span className={badgeBase + ' border-blue-700/60 bg-blue-950/40 text-blue-300'}>
                                            Graph (all targets)
                                        </span>
                                    ) : targets.length ? (
                                        targets.map((t) => {
                                            const explicit = row.targets.indexOf(t) !== -1;
                                            const inherited = !explicit && row.inherited.indexOf(t) !== -1;
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
        // IMPL_TARGET_LABELS and friendlyTargetLabel have no consumers
        // outside this file (checked repo-wide, word-boundary grep) — kept
        // as declarations (used internally by ImplTargetMatrix) but
        // omitted from the export list. TARGET_INHERITANCE/getImplIndex no
        // longer exist in this file at all — see
        // scripts/lib/nodedef-extract.mjs.
        Object.assign(window, {
            ImplTargetMatrix,
        });
