// js/graph/catalog.jsx — Tab quick-add node catalog: per-nodedef info,
// grouping a category's nodedefs into type signatures (versions collapsed
// under their signature), and the memoized catalog builder.
// Loaded after js/graph/model.jsx (see js/shell.jsx's VIEW_DEPS.graph);
// no top-level import/export, self-exports via Object.assign(window, {})
// at the bottom. `nodeCatalogPromise` is the only module-mutable state in
// the graph view's split files; buildNodeCatalog is its sole mutator.

        // ---- Tab quick-add: the standard-library node catalog -------------

        // One entry per stdlib node category (name, group, signature
        // groups), built once from the loaded library.
        // Raw per-nodedef info: name, resolved output type, inputs, version.
        // Inputs come from getActiveInputs, so a versioned nodedef that only
        // overrides some defaults still reports its FULL port list.
        const nodeDefInfo = (def) => {
            const seen = new Set();
            const inputs = [];
            const defIns = vecToArray(mxSafe(() => def.getActiveInputs(), []))
                .concat(vecToArray(mxSafe(() => def.getInputs(), [])));
            for (const dIn of defIns) {
                const nm = mxElName(dIn);
                if (!nm || seen.has(nm)) continue;
                seen.add(nm);
                inputs.push({
                    name: nm, type: mxElType(dIn),
                    value: mxSafe(() => (dIn.getValueString ? dIn.getValueString() : ''), '') || mxElAttr(dIn, 'value'),
                });
            }
            // Modern nodedefs declare their type on <output> children only.
            const outTypes = vecToArray(mxSafe(() => def.getActiveOutputs(), [])).map(mxElType).filter(Boolean);
            const type = mxElType(def)
                || (outTypes.length === 1 ? outTypes[0] : (outTypes.length ? 'multioutput' : ''));
            const outLabel = type === 'multioutput' ? outTypes.join(' + ') : type;
            return {
                name: mxElName(def), type, outLabel, inputs,
                version: mxSafe(() => def.getVersionString(), '') || '',
                isDefaultVersion: !!mxSafe(() => def.getDefaultVersion(), false),
                sig: (inputs.map((i) => i.type).join(', ') || '\u2014') + ' \u2192 ' + (outLabel || '?'),
            };
        };

        // Deduped, order-preserving token list \u2014 "color3, color3, float"
        // becomes "color3, float" \u2014 used for the compact signature label
        // (task 7) exactly like the docs page's uniqTypeTokens.
        const uniqTokens = (arr) => {
            const seen = new Set();
            const out = [];
            arr.forEach((t) => { if (t && !seen.has(t)) { seen.add(t); out.push(t); } });
            return out;
        };

        // TYPE-SIGNATURE key: ordered input types plus output type,
        // version-independent. Same key = same signature across versions;
        // differing keys = genuinely different (e.g. mix: float vs color3).
        const sigKeyOf = (d) => d.type + '|' + d.inputs.map((i) => i.type).join(',');

        // Groups a category's nodedefs by TYPE SIGNATURE, each entry
        // carrying every VERSION. inputs/outLabel reflect the DEFAULT (or
        // first) version; ambiguous means output type alone can't disambiguate.
        const groupSignatures = (defs) => {
            const byKey = {};
            const order = [];
            for (const d of defs) {
                const key = sigKeyOf(d);
                if (!byKey[key]) { byKey[key] = []; order.push(key); }
                byKey[key].push(d);
            }
            const groups = order.map((key) => {
                const versions = byKey[key].slice().sort((a, b) => {
                    if (a.isDefaultVersion !== b.isDefaultVersion) return a.isDefaultVersion ? -1 : 1;
                    return b.version.localeCompare(a.version, undefined, { numeric: true });
                });
                const rep = versions[0];
                return {
                    key, type: rep.type, outLabel: rep.outLabel, inputs: rep.inputs,
                    inSummary: uniqTokens(rep.inputs.map((i) => i.type)).join(', '),
                    full: rep.sig, versions,
                };
            });
            const byType = {};
            groups.forEach((g) => { byType[g.type] = (byType[g.type] || 0) + 1; });
            groups.forEach((g) => { g.ambiguous = byType[g.type] > 1; });
            // Sorted by output type then input summary, matching the docs
            // Signature dropdown (js/docs-app.jsx's sigOptions) so both
            // tools present the same order.
            groups.sort((a, b) => {
                const byOut = String(a.outLabel || a.type).localeCompare(String(b.outLabel || b.type));
                return byOut !== 0 ? byOut : String(a.inSummary).localeCompare(String(b.inSummary));
            });
            return groups;
        };

        let nodeCatalogPromise = null;
        const buildNodeCatalog = () => {
            if (!nodeCatalogPromise) {
                nodeCatalogPromise = getMxEnv().then(({ stdlib }) => {
                    const byCat = {};
                    for (const def of vecToArray(mxSafe(() => stdlib.getNodeDefs(), []))) {
                        const cat = mxSafe(() => def.getNodeString(), '');
                        if (!cat) continue;
                        const group = mxSafe(() => def.getNodeGroup(), '') || '';
                        const e = byCat[cat] || (byCat[cat] = { category: cat, group, defs: [] });
                        if (!e.group && group) e.group = group;
                        e.defs.push(nodeDefInfo(def)); // library order = the canonical one
                    }
                    return Object.keys(byCat).sort().map((k) => {
                        const e = byCat[k];
                        e.signatures = groupSignatures(e.defs);
                        return e;
                    });
                });
                nodeCatalogPromise.catch(() => { nodeCatalogPromise = null; }); // allow retry
            }
            return nodeCatalogPromise;
        };

Object.assign(window, { buildNodeCatalog, nodeDefInfo, groupSignatures });
