// impl-matrix.jsx — implementation-target matrix: which shading-language
// targets the stdlib ships an <implementation> for, per nodedef signature.
// Purely presentational — implRows/allTargets are pregenerated at build
// time by scripts/build-nodelib.mjs (scripts/lib/nodedef-extract.mjs)
// into js/gen/nodelib-index.json; this file does no WASM work itself.
// Loaded as text/babel; Babel gives each file its own function scope,
// so the public API is exported onto window at the bottom.

        // Documentation aid, not a certification tool — renders nothing
        // (rather than throwing) when the expected data isn't present.
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

        // props: { nodeName, signature, implRows, allTargets }. implRows:
        // pregenerated per-signature array (scripts/build-nodelib.mjs);
        // `signature` picks one row, else all rows (collapsed if identical).
        function ImplTargetMatrix({ nodeName, signature, implRows, allTargets }) {
            if (!nodeName || implRows == null || !implRows.length) return null;

            const bySig = {};
            implRows.forEach((r) => { bySig[r.key] = r; });

            // Deliberately ignores files/graphFile: two rows with the
            // same target sets but different source files still collapse
            // to one row — only the ✓/✓*/– pattern needs to match.
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
                                        // Feature 1: link to the nodegraph's GitHub
                                        // source when resolved; else fall back to a
                                        // plain span.
                                        implFileUrl(row.graphFile) ? (
                                            <a
                                                href={implFileUrl(row.graphFile)}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                title={'Nodegraph implementation — view source: ' + row.graphFile}
                                                aria-label="View nodegraph implementation source"
                                                className={badgeBase + ' border-blue-700/60 bg-blue-950/40 text-blue-300'}
                                            >
                                                Graph (all targets)
                                            </a>
                                        ) : (
                                            <span className={badgeBase + ' border-blue-700/60 bg-blue-950/40 text-blue-300'}>
                                                Graph (all targets)
                                            </span>
                                        )
                                    ) : targets.length ? (
                                        targets.map((t) => {
                                            const explicit = row.targets.indexOf(t) !== -1;
                                            const inherited = !explicit && row.inherited.indexOf(t) !== -1;
                                            // Explicit/inherited badges link to source;
                                            // inherited bakes to the GLSL parent's path
                                            // at build time. '–' never links.
                                            const path = (explicit || inherited) && row.files ? row.files[t] : null;
                                            const href = implFileUrl(path);
                                            const badgeClassName = badgeBase + (
                                                explicit
                                                    ? ' border-green-700/60 bg-green-950/30 text-green-400'
                                                    : inherited
                                                        ? ' border-green-800/40 border-dashed bg-green-950/10 text-green-600'
                                                        : ' border-gray-700 bg-gray-900 text-gray-600'
                                            );
                                            const badgeChildren = (
                                                <React.Fragment>{explicit ? '✓' : inherited ? '✓*' : '–'} {friendlyTargetLabel(t)}</React.Fragment>
                                            );
                                            if (href) {
                                                const title = inherited
                                                    ? 'Inherited from GLSL — no explicit implementation, but MaterialX falls back to the GLSL source at generation time. Source: ' + path
                                                    : t + ' — view source: ' + path;
                                                return (
                                                    <a
                                                        key={t}
                                                        href={href}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        title={title}
                                                        aria-label={'View ' + friendlyTargetLabel(t) + ' implementation source'}
                                                        className={badgeClassName}
                                                    >
                                                        {badgeChildren}
                                                    </a>
                                                );
                                            }
                                            return (
                                                <span
                                                    key={t}
                                                    title={
                                                        inherited
                                                            ? 'Inherited from GLSL — no explicit implementation, but MaterialX falls back to the GLSL source at generation time.'
                                                            : t
                                                    }
                                                    className={badgeClassName}
                                                >
                                                    {badgeChildren}
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

        // ---- public API ---- (IMPL_TARGET_LABELS/friendlyTargetLabel
        // are internal-only; TARGET_INHERITANCE/getImplIndex no longer
        // live here — see scripts/lib/nodedef-extract.mjs.)
        Object.assign(window, {
            ImplTargetMatrix,
        });
