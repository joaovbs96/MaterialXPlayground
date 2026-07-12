// docs-app.jsx — the App component for the MaterialX node documentation
// browser (index.html). Extracted verbatim from the page's inline
// text/babel script (originally index.html lines 76-1103) — pure move,
// no behavior change. Note: this file uses index.html's literal \uXXXX
// escape-text convention (e.g. {'↗'}) in a few string literals —
// same convention as node-graph.html; preserve exactly, do not normalize.
// Loaded as text/babel; Babel executes each file in its own function
// scope. Depends on window globals published by js/spec-parser.js,
// js/mtlx-engine.js, js/docs/doc-links.jsx, js/docs/rich-text.jsx,
// js/docs/port-tables.jsx, js/docs/impl-matrix.jsx, js/docs/sidebar.jsx,
// and js/node-preview.jsx, so this script tag must load AFTER all of
// those. Reads window.__MTLX_EMBED (set synchronously by index.html's
// early <head> script) for embed-mode behavior. The sidebar tree
// (DocsSidebar) and Help modal (DocsHelpDialog) live in
// js/docs/sidebar.jsx — App owns all their state/derived data and passes
// it down as props (see the {jsonData && (...)} block below).

        function App({ active = true } = {}) {
            // Embed mode: focused single-node view, iframed by the graph
            // editor (index.html?embed=1#/<lib>/<group>/<name>) — flag is
            // set synchronously in <head> before first paint.
            const EMBED = !!window.__MTLX_EMBED;
            // The hash the page LANDED on — read once, before the async spec-DB
            // load can race with the user switching shell views (which rewrites
            // location.hash to a '#!' route and would lose a docs deep link).
            const initialHashRef = React.useRef(window.location.hash);
            const [jsonData, setJsonData] = React.useState(null);
            const [selectedNode, setSelectedNode] = React.useState(null);
            // Which signature (port table) of the selected node is shown —
            // and previewed. Reset on every selection change.
            const [sigIndex, setSigIndex] = React.useState(0);
            React.useEffect(() => { setSigIndex(0); }, [selectedNode]);
            const [copied, setCopied] = React.useState(false);
            // Auto-generated port tables (from the nodedef) for undocumented
            // nodes: { name, status: 'loading'|'ready'|'unavailable', tables }.
            const [autoDoc, setAutoDoc] = React.useState(null);
            // Warm the MaterialX module so the version badge in the shared
            // header resolves (the engine dispatches 'mtlx-version'; the
            // header listens) and the first preview doesn't pay the WASM
            // download. One-time load only — the resource cost the "3D
            // previews" toggle guards is the per-node render loop, not this.
            React.useEffect(() => {
                getMxEnv().catch(() => {});
            }, []);

            // Resolve doc links that point at a spec #node-... anchor to a
            // node in the loaded database (anchors and node names both get
            // separators stripped so hyphenated and squashed conventions both
            // match). Known → select in-app; unknown → official page.
            React.useEffect(() => {
                if (!jsonData) return undefined;
                const index = {};
                for (const lib of Object.keys(jsonData)) {
                    for (const group of Object.keys(jsonData[lib])) {
                        for (const name of Object.keys(jsonData[lib][group])) {
                            const key = name.replace(/[-_]/g, '').toLowerCase();
                            if (!index[key]) index[key] = { lib, group, name, info: jsonData[lib][group][name] };
                        }
                    }
                }
                // Published so the doc renderer can mark <nodename> chips as
                // clickable only when they resolve to a known node.
                window.__mtlxNodeIndex = index;
                const onOpen = (e) => {
                    const hit = index[e.detail.key];
                    if (hit) {
                        setSelectedNode(hit);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    } else if (e.detail.url) {
                        window.open(e.detail.url, '_blank', 'noopener');
                    } else {
                        console.warn('mtlx-open-node: no node matches key', e.detail.key);
                    }
                };
                window.addEventListener('mtlx-open-node', onOpen);
                return () => {
                    window.removeEventListener('mtlx-open-node', onOpen);
                    if (window.__mtlxNodeIndex === index) delete window.__mtlxNodeIndex;
                };
            }, [jsonData]);

            // KaTeX loads with `defer`; if React renders before it's ready,
            // poll briefly and re-render once it arrives so math spans
            // upgrade from raw text to rendered output.
            const [, setKatexReady] = React.useState(!!window.katex);
            React.useEffect(() => {
                if (window.katex) return;
                const timer = setInterval(() => {
                    if (window.katex) {
                        setKatexReady(true);
                        clearInterval(timer);
                    }
                }, 200);
                return () => clearInterval(timer);
            }, []);

            // State to keep track of which tree folders are open
            const [expandedLibs, setExpandedLibs] = React.useState({});
            const [expandedGroups, setExpandedGroups] = React.useState({});

            // Shared initialization for both auto-loaded and uploaded data.
            const applyData = (parsedData, source) => {
                setJsonData(parsedData);
                setSelectedNode(null);
                setDataSource(source);

                // A permalink (#/lib/group/name) wins over the default first node.
                // If the CURRENT hash is a shell route ('#!...'), the user switched
                // views while the spec DB was loading — fall back to the hash the
                // page landed on so the deep-linked node is still selected.
                const rawHash = window.location.hash;
                const hashForSel = /^#!/.test(rawHash) ? initialHashRef.current : rawHash;
                const fromHash = hashToSel(parsedData, hashForSel);
                if (fromHash) {
                    setExpandedLibs({ [fromHash.lib]: true });
                    setExpandedGroups({ [`${fromHash.lib}-${fromHash.group}`]: true });
                    setSelectedNode(fromHash);
                    return;
                }

                // Default landing node: OpenPBR's surface shader when the
                // data has it — the flagship uber-shader is a far better
                // first impression (and a parameter-rich preview) than
                // whatever node happens to sort first. Falls back to the
                // first node of the first library/group otherwise.
                let def = null;
                for (const lib of Object.keys(parsedData)) {
                    for (const group of Object.keys(parsedData[lib])) {
                        for (const name of Object.keys(parsedData[lib][group])) {
                            if (name.toLowerCase() === 'open_pbr_surface') {
                                def = { lib, group, name, info: parsedData[lib][group][name] };
                                break;
                            }
                        }
                        if (def) break;
                    }
                    if (def) break;
                }
                if (!def) {
                    const firstLib = Object.keys(parsedData)[0];
                    const firstGroup = firstLib && Object.keys(parsedData[firstLib])[0];
                    const firstNode = firstGroup && Object.keys(parsedData[firstLib][firstGroup])[0];
                    if (firstNode) {
                        def = { lib: firstLib, group: firstGroup, name: firstNode,
                                info: parsedData[firstLib][firstGroup][firstNode] };
                    }
                }
                if (def) {
                    setExpandedLibs({ [def.lib]: true });
                    setExpandedGroups({ [`${def.lib}-${def.group}`]: true });
                    setSelectedNode(def);
                }
            };

            // Keep the address bar in sync with the selection (permalink), and
            // react to back/forward + manual hash edits. pushState updates the
            // bar WITHOUT firing hashchange, so no feedback loop; popstate
            // handles history navigation. Only write the URL while the docs
            // view is VISIBLE — a late spec-DB load while another shell view
            // is active must not stomp the shell's '#!' route (pushState
            // doesn't fire hashchange, so the shell can't recover); when the
            // view becomes active again, this re-runs and restores the node
            // permalink.
            React.useEffect(() => {
                if (!selectedNode || !active) return;
                const h = selToHash(selectedNode);
                if (window.location.hash !== h) {
                    if (EMBED) {
                        try { history.replaceState(null, '', h); } catch (e) { window.location.replace(h); }
                    } else {
                        try { history.pushState(null, '', h); } catch (e) { window.location.hash = h; }
                    }
                }
            }, [selectedNode, active]);
            React.useEffect(() => {
                if (!jsonData) return undefined;
                const onNav = () => {
                    const sel = hashToSel(jsonData, window.location.hash);
                    if (sel) {
                        setExpandedLibs((p) => Object.assign({}, p, { [sel.lib]: true }));
                        setExpandedGroups((p) => Object.assign({}, p, { [`${sel.lib}-${sel.group}`]: true }));
                        setSelectedNode(sel);
                    }
                };
                window.addEventListener('hashchange', onNav);
                window.addEventListener('popstate', onNav);
                return () => {
                    window.removeEventListener('hashchange', onNav);
                    window.removeEventListener('popstate', onNav);
                };
            }, [jsonData]);

            const copyPermalink = () => {
                const loc = window.location;
                // Never carry over the query string (e.g. ?embed=1): the
                // copied link should always open the full page, never the
                // focused embed view.
                const url = loc.origin + loc.pathname + selToHash(selectedNode);
                const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(url).then(done, () => {
                        window.prompt('Copy this link:', url);
                    });
                } else {
                    window.prompt('Copy this link:', url);
                }
            };

            // For nodes with NO documentation, read the ports/types straight
            // from the MaterialX nodedef (via the WASM API) and synthesize a
            // table on the fly. Guarded so a stale fetch can't overwrite a
            // newer selection.
            React.useEffect(() => {
                if (!selectedNode || !isUndocumented(selectedNode.info)) {
                    setAutoDoc(null);
                    return undefined;
                }
                const name = selectedNode.name;
                let alive = true;
                setAutoDoc({ name, status: 'loading', tables: [] });
                getMxEnv()
                    .then(({ mx, stdlib }) => {
                        if (!alive) return;
                        const doc = mx.createDocument();
                        // setDataLibrary REFERENCES the standard library
                        // (nodedef matching, validation, and shadergen all
                        // consult it) without making it part of the document —
                        // so a plain writeToXmlString(doc) contains only OUR
                        // nodes. importLibrary would bake megabytes of stdlib
                        // into the doc, and the JS binding of XmlWriteOptions
                        // exposes only writeXIncludeEnable (elementPredicate is
                        // NOT bound), so there is no way to filter at write
                        // time. Verified: all preview kinds generate and export
                        // cleanly through the data library.
                        if (typeof doc.setDataLibrary === 'function') {
                            doc.setDataLibrary(stdlib);
                        } else {
                            // Ancient binding without setDataLibrary — exports
                            // would include the library. Loud, not silent:
                            console.error('setDataLibrary is not bound in this MaterialX build — .mtlx exports will include the standard library.');
                            doc.importLibrary(stdlib);
                        }
                        const defs = dedupeDefsBySignature(vecToArray(doc.getMatchingNodeDefs(name)));
                        const tables = buildAutoTablesFromDefs(defs);
                        if (!alive) return;
                        setAutoDoc({ name, status: tables.length ? 'ready' : 'unavailable', tables });
                    })
                    .catch(() => { if (alive) setAutoDoc({ name, status: 'unavailable', tables: [] }); });
                return () => { alive = false; };
            }, [selectedNode]);

            // VERSION metadata (standard_surface 1.0.1 default / 1.0.0, …),
            // read from the live nodedefs for EVERY selection — documented
            // or not. This is deliberately separate from the autoDoc effect
            // above: that one only runs for undocumented nodes (its tables
            // come from the spec instead), so a documented node's version
            // data would otherwise never be read at all. Grouped the same
            // way node-graph.html's groupSignatures does (see
            // groupDefVersions), one entry per type signature.
            const [nodeVersionGroups, setNodeVersionGroups] = React.useState(null);
            React.useEffect(() => {
                if (!selectedNode) { setNodeVersionGroups(null); return undefined; }
                const name = selectedNode.name;
                let alive = true;
                getMxEnv()
                    .then(({ mx, stdlib }) => {
                        if (!alive) return;
                        const doc = mx.createDocument();
                        if (typeof doc.setDataLibrary === 'function') doc.setDataLibrary(stdlib);
                        else doc.importLibrary(stdlib);
                        // Intentionally UNFILTERED across libraries: ambiguous categories
                        // ('multiply' is stdlib math AND pbrlib BSDF/EDF/VDF) should list every
                        // signature in the dropdown; the previewer itself notices the
                        // un-compilable closure ones instead of hiding them here.
                        const groups = groupDefVersions(vecToArray(doc.getMatchingNodeDefs(name)));
                        if (alive) setNodeVersionGroups(groups);
                    })
                    .catch(() => { if (alive) setNodeVersionGroups(null); });
                return () => { alive = false; };
            }, [selectedNode]);
            // Which VERSION is selected within the currently resolved
            // signature group — reset whenever the selection or signature
            // changes (a different signature may resolve to a different
            // group with its own default).
            const [versionIndex, setVersionIndex] = React.useState(0);
            React.useEffect(() => { setVersionIndex(0); }, [selectedNode, sigIndex]);

            // Build the node database LIVE: fetch the spec markdown for the
            // pinned tag straight from GitHub and parse it in-browser
            // (spec-parser.js), joining against the nodedefs from the WASM.
            // There is no local fallback: if GitHub is unreachable
            // (offline/file://), the page shows the failed state.
            const [autoLoad, setAutoLoad] = React.useState('loading'); // loading | done | failed
            const [dataSource, setDataSource] = React.useState(null);
            React.useEffect(() => {
                const live = (window.MtlxSpecParser
                    ? window.MtlxSpecParser.buildNodeDatabase()
                    : Promise.reject(new Error('spec-parser.js not loaded')));
                live
                    .then(db => {
                        applyData(db, `MaterialX ${window.MtlxSpecParser.SPEC_TAG} specification (parsed live)`);
                        setAutoLoad('done');
                    })
                    .catch((err) => {
                        console.warn('Live spec parse failed', err);
                        setAutoLoad('failed');
                    });
            }, []);

            // (Manual upload removed: the page auto-loads the live spec only.)

            const toggleLib = (lib) => {
                setExpandedLibs(prev => ({ ...prev, [lib]: !prev[lib] }));
            };

            const toggleGroup = (lib, group) => {
                const key = `${lib}-${group}`;
                setExpandedGroups(prev => ({ ...prev, [key]: !prev[key] }));
            };

            // ----------------------------------------------------------------
            // Documentation stats + tristate doc filter + name search
            // ----------------------------------------------------------------
            // 'all' | 'documented' | 'undocumented'
            const [docFilter, setDocFilter] = React.useState('all');
            // Help popup (the "?" button in the stats row).
            const [showHelp, setShowHelp] = React.useState(false);
            useEscapeToClose(() => setShowHelp(false), showHelp);
            const [searchQuery, setSearchQuery] = React.useState('');
            // Global 3D-preview switch, persisted across sessions so slow
            // machines stay preview-free. localStorage is best-effort
            // (private mode etc. throws) — default is ON.
            const [showPreviews, setShowPreviews] = React.useState(() => {
                if (EMBED) return true;
                try { return localStorage.getItem('mtlx_show_previews') !== '0'; } catch (e) { return true; }
            });
            const togglePreviews = () => setShowPreviews((v) => {
                const nv = !v;
                try { localStorage.setItem('mtlx_show_previews', nv ? '1' : '0'); } catch (e) { /* best-effort */ }
                return nv;
            });
            // Embed mode: the graph editor posts visibility when its docs dialog
            // hides/shows this iframe — pause the 3D preview loop while hidden
            // (display:none does not stop the iframe's rAF). Deliberately NOT
            // togglePreviews: that would persist to localStorage and pollute the
            // full page's preference.
            React.useEffect(() => {
                if (!EMBED) return undefined;
                const onMsg = (e) => {
                    const d = e.data;
                    if (d && d.type === 'mtlx-embed-visible') setShowPreviews(!!d.visible);
                };
                window.addEventListener('message', onMsg);
                return () => window.removeEventListener('message', onMsg);
            }, []);

            const stats = React.useMemo(() => {
                if (!jsonData) return null;
                let total = 0, undoc = 0;
                Object.values(jsonData).forEach(groups =>
                    Object.values(groups).forEach(nodes =>
                        Object.values(nodes).forEach(info => {
                            total++;
                            if (isUndocumented(info)) undoc++;
                        })
                    )
                );
                return { total, undoc };
            }, [jsonData]);

            // The tree renders from treeData: the full data, narrowed by the
            // "no docs" filter and/or the search query, with empty
            // groups/libs pruned.
            const treeData = React.useMemo(() => {
                if (!jsonData) return jsonData;
                const query = searchQuery.trim().toLowerCase();
                if (docFilter === 'all' && !query) return jsonData;
                const filtered = {};
                Object.entries(jsonData).forEach(([lib, groups]) => {
                    Object.entries(groups).forEach(([group, nodes]) => {
                        const kept = {};
                        Object.entries(nodes).forEach(([name, info]) => {
                            if (docFilter === 'undocumented' && !isUndocumented(info)) return;
                            if (docFilter === 'documented' && isUndocumented(info)) return;
                            if (query && !name.toLowerCase().includes(query)) return;
                            kept[name] = info;
                        });
                        if (Object.keys(kept).length > 0) {
                            if (!filtered[lib]) filtered[lib] = {};
                            filtered[lib][group] = kept;
                        }
                    });
                });
                return filtered;
            }, [jsonData, docFilter, searchQuery]);

            // While searching, show all matches regardless of stored
            // expansion state; clearing the query restores the prior state.
            const forceOpen = searchQuery.trim() !== '';
            const matchCount = React.useMemo(() => {
                if (!treeData || !forceOpen) return null;
                let n = 0;
                Object.values(treeData).forEach(gs =>
                    Object.values(gs).forEach(ns => { n += Object.keys(ns).length; }));
                return n;
            }, [treeData, forceOpen]);

            // Expand/collapse the whole (visible) tree at once.
            const expandAll = () => {
                const libs = {}, groups = {};
                Object.entries(treeData || {}).forEach(([lib, gs]) => {
                    libs[lib] = true;
                    Object.keys(gs).forEach(g => { groups[`${lib}-${g}`] = true; });
                });
                setExpandedLibs(libs);
                setExpandedGroups(groups);
            };
            const collapseAll = () => {
                setExpandedLibs({});
                setExpandedGroups({});
            };

            const applyDocFilter = (mode) => {
                setDocFilter(mode);
                if (mode === 'undocumented' && jsonData) {
                    // The undocumented set is usually small: expand everything
                    // containing such nodes so the view is a complete overview.
                    const libs = {}, groups = {};
                    Object.entries(jsonData).forEach(([lib, gs]) => {
                        Object.entries(gs).forEach(([group, nodes]) => {
                            if (Object.values(nodes).some(isUndocumented)) {
                                libs[lib] = true;
                                groups[`${lib}-${group}`] = true;
                            }
                        });
                    });
                    setExpandedLibs(libs);
                    setExpandedGroups(groups);
                }
            };

            // Chevron icons for the tree view now live in js/docs/sidebar.jsx
            // (moved with DocsSidebar, their only consumer).

            const portTables = selectedNode ? getPortTables(selectedNode.info) : [];
            // For undocumented nodes, fall back to the nodedef-generated tables.
            const autoReady = autoDoc && selectedNode && autoDoc.name === selectedNode.name
                && autoDoc.status === 'ready';
            const isAutoTable = portTables.length === 0 && autoReady && autoDoc.tables.length > 0;
            const autoLoading = autoDoc && selectedNode && autoDoc.name === selectedNode.name
                && autoDoc.status === 'loading';
            const effectiveTables = portTables.length > 0 ? portTables
                : (isAutoTable ? autoDoc.tables : []);
            // Signature selection: the dropdown is now driven by the live
            // nodedef VERSION GROUPS (nodeVersionGroups), not by counting
            // markdown tables — a node like fractal3d has ELEVEN nodedefs
            // (several sharing an output type but differing by the
            // `amplitude` input type) collapsed into ONE markdown table, so
            // effectiveTables.length alone could never surface them.
            const sigGroups = nodeVersionGroups || [];
            const sigCount = sigGroups.length;
            const sig = Math.min(sigIndex, Math.max(sigCount - 1, 0));
            const selectedGroup = sigGroups[sig] || null;
            // Documented nodes: when the spec write-up authors SEVERAL port
            // tables under one heading (e.g. `multiply`: scalar/vector table
            // + matrixNN table) and there's more than one live signature to
            // choose from, show only the ONE table matching the selected
            // signature's output type — otherwise every table renders
            // stacked, which reads as duplicated content. Single-table
            // documented nodes are unaffected. Undocumented nodes show the
            // ONE auto-generated table matching the selected group.
            // groupDefVersions and dedupeDefsBySignature walk the SAME
            // getMatchingNodeDefs(name) list in the same order with the same
            // signature key (nodeDefSigKey), so index `sig` lines up across
            // sigGroups and autoDoc.tables — see buildAutoTablesFromDefs.
            const displayTables = portTables.length > 0
                ? (portTables.length > 1 && sigCount > 1 && selectedGroup
                    ? [pickTableForType(portTables, selectedGroup.type) || portTables[0]]
                    : portTables)
                : (sigCount > 1 ? [autoDoc && autoDoc.tables && autoDoc.tables[sig]].filter(Boolean)
                    : effectiveTables);
            // Concrete type this signature previews as (null → auto-pick).
            // While nodeVersionGroups is still loading (async), fall back to
            // the markdown-table-derived heuristic so the preview isn't
            // blocked on it.
            const previewType = selectedGroup ? selectedGroup.type
                : (effectiveTables.length > 0 ? signaturePreviewType(effectiveTables[0]) : null);
            // The VERSION picker (same/multiple defaults within a signature)
            // now reads directly off the selected group instead of
            // re-matching by output type.
            const showVersionPicker = !!selectedGroup && selectedGroup.versions.length > 1;
            const versionIdx = selectedGroup
                ? Math.min(versionIndex, Math.max(selectedGroup.versions.length - 1, 0)) : 0;
            const selectedVersion = selectedGroup ? selectedGroup.versions[versionIdx] : null;
            // Markdown tables carry only ONE signature's worth of port rows,
            // so once several signatures exist, the selected version's live
            // type/default data must be projected onto them — otherwise a
            // dropdown pick that doesn't match the spec's authored signature
            // would show stale types/defaults.
            const typesOverride = (sigCount > 1 && selectedVersion && portTables.length > 0)
                ? { ...selectedVersion.inputTypes, ...selectedVersion.outputTypes } : null;
            const defaultsOverride = selectedVersion && (sigCount > 1 || !selectedVersion.isDefaultVersion)
                ? selectedVersion.defaults : null;
            // Previewability decided HERE, where the selected signature's exact
            // types are known, and passed down — the previewer must not re-derive
            // signature info from nodedefs.
            const previewDisabled = (() => {
                if (!selectedGroup || !selectedVersion) return null; // groups not loaded — previewer decides
                const CLOSURE = ['BSDF', 'EDF', 'VDF'];
                const VIEWABLE = ['color3', 'color4', 'float', 'vector2', 'vector3', 'vector4'];
                const out = selectedGroup.type;
                // '+'-joined multi-output signature, or the literal 'multioutput'
                // type string a real multi-output nodedef's getType() returns —
                // no single primary output type to gate on; multioutput
                // signatures (including translation graphs) are deferred to the
                // previewer, which has a working translation branch.
                if (!out || out.indexOf('+') !== -1 || out === 'multioutput') return null;
                const inTypes = Object.values(selectedVersion.inputTypes || {});
                const hasClosureInput = inTypes.some((t) => CLOSURE.indexOf(t) !== -1);
                // A surfaceshader with unbound closure (BSDF/EDF) inputs passes
                // the VIEWABLE-ish gate below but renders as a meaningless black
                // ball — catch it before the generic previewable check.
                if (out === 'surfaceshader' && hasClosureInput) {
                    return `No preview for "${selectedNode.name}" — its closure inputs (BSDF/EDF) are unbound in an isolated preview; open it in the node graph editor and wire it up to see a result.`;
                }
                const previewable = VIEWABLE.indexOf(out) !== -1
                    || out === 'surfaceshader'
                    || out === 'material'
                    || (out === 'BSDF' && !hasClosureInput)
                    || (out === 'EDF' && !hasClosureInput);
                if (previewable) return null;
                if (CLOSURE.indexOf(out) !== -1 && hasClosureInput) {
                    return `No preview for "${selectedNode.name}" — closure operators (BSDF/EDF/VDF in and out) aren't previewed in isolation. Open it in the node graph editor to see it in context.`;
                }
                return `No preview for "${selectedNode.name}" — it outputs ${out}, which isn't a viewable color surface. Try it in the node graph editor.`;
            })();
            // Column set for the displayed table(s).
            const columns = displayTables.length > 0 ? unionColumns(displayTables) : [];
            // Footnote references: map key -> {n, url, text}, numbered by
            // order of first appearance (the parser preserves that order).
            const references = (selectedNode && selectedNode.info.references) || [];
            const refs = {};
            references.forEach((r, i) => { refs[r.key] = { n: i + 1, url: r.url, text: r.text }; });

            return (
                <div className="space-y-4 sm:space-y-6 md:h-full md:flex md:flex-col md:min-h-0">
                    {!EMBED && (
                    /* Page intro: the site title/nav/links live in the shared
                       header (js/site-header.js); only page-specific bits stay. */
                    <div className="flex items-center justify-between gap-4 flex-wrap">
                        <p className="text-gray-400 text-sm sm:text-base">
                            Documentation browser and live previews for the MaterialX node libraries.
                        </p>
                        <button
                            onClick={togglePreviews}
                            title="Globally enable/disable the WebGL node previews (saves resources on slow machines)"
                            className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                                showPreviews
                                    ? 'bg-gray-800 border-gray-600 text-gray-200 hover:bg-gray-700'
                                    : 'bg-gray-800 border-amber-700/60 text-amber-400 hover:bg-gray-700'
                            }`}
                        >
                            3D previews: {showPreviews ? 'On' : 'Off'}
                        </button>
                    </div>
                    )}

                    {/* Data source status: visible only while loading or on failure */}
                    {autoLoad === 'loading' && (
                        <div className="bg-gray-800 p-4 rounded-lg shadow border border-gray-700 text-sm text-gray-400">
                            Parsing the MaterialX specification…
                        </div>
                    )}
                    {autoLoad === 'failed' && (
                        <div className="bg-gray-800 p-4 rounded-lg shadow border border-amber-700/60 text-sm text-gray-300">
                            Could not fetch and parse the MaterialX specification from GitHub.
                            Check your network connection and reload the page.
                        </div>
                    )}

                    {!EMBED && jsonData && stats && (
                        <div className="flex items-center gap-3 flex-wrap text-sm">
                            <span className="bg-gray-800 border border-gray-700 text-gray-200 px-3 py-1.5 rounded-lg">
                                <span className="font-semibold text-white">{stats.total}</span> nodes total
                            </span>
                            <span className={`px-3 py-1.5 rounded-lg border ${
                                stats.undoc > 0
                                    ? 'bg-gray-800 border-amber-700/60 text-amber-400'
                                    : 'bg-gray-800 border-gray-700 text-gray-500'
                            }`}>
                                <span className="font-semibold">{stats.undoc}</span> without docs
                            </span>
                            <div className="inline-flex rounded-lg border border-gray-700 overflow-hidden" role="group" aria-label="Documentation filter">
                                {[
                                    { mode: 'all', label: 'Show all' },
                                    { mode: 'documented', label: 'Only documented' },
                                    { mode: 'undocumented', label: 'Only undocumented' },
                                ].map(({ mode, label }, i) => (
                                    <button
                                        key={mode}
                                        onClick={() => applyDocFilter(mode)}
                                        className={`px-2 sm:px-3 py-1.5 text-xs sm:text-sm transition-colors ${i > 0 ? 'border-l border-gray-700' : ''} ${
                                            docFilter === mode
                                                ? 'bg-blue-600 text-white'
                                                : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200'
                                        }`}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                            <button
                                onClick={() => setShowHelp(true)}
                                title="How to use this page"
                                className="ml-auto text-xs px-3 py-1.5 rounded-lg border bg-gray-800 border-gray-600 text-gray-200 hover:bg-gray-700 transition-colors inline-flex items-center gap-1.5"
                            >
                                <span className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-current text-[10px] font-bold" aria-hidden="true">?</span>
                                Help
                            </button>
                        </div>
                    )}

                    {/* Help popup — js/docs/sidebar.jsx's DocsHelpDialog (a
                        portal directly under <body>, see its own comment).
                        App keeps the showHelp state and useEscapeToClose
                        call above; DocsHelpDialog just gets open/onClose. */}
                    {!EMBED && <DocsHelpDialog open={showHelp} onClose={() => setShowHelp(false)} />}

                    {jsonData && (
                        /* md+: the grid absorbs all height left between the
                           stats row and the disclaimers; both panels scroll
                           internally. The 20rem floor keeps the panels usable
                           on very short desktop windows by letting the page
                           scroll again instead of squishing them further. */
                        <div className={EMBED
                            ? 'grid grid-cols-1 gap-3 sm:gap-6 md:flex-1 md:min-h-[20rem]'
                            : 'grid grid-cols-1 md:grid-cols-4 md:grid-rows-[minmax(0,1fr)] gap-3 sm:gap-6 md:flex-1 md:min-h-[20rem]'}>

                            {/* Left Sidebar: Hierarchical Tree Menu — js/docs/sidebar.jsx's
                                DocsSidebar. App owns all the state/derived data below
                                and passes it down as props. */}
                            {!EMBED && (
                                <DocsSidebar
                                    treeData={treeData}
                                    docFilter={docFilter}
                                    forceOpen={forceOpen}
                                    searchQuery={searchQuery}
                                    setSearchQuery={setSearchQuery}
                                    matchCount={matchCount}
                                    expandAll={expandAll}
                                    collapseAll={collapseAll}
                                    expandedLibs={expandedLibs}
                                    toggleLib={toggleLib}
                                    expandedGroups={expandedGroups}
                                    toggleGroup={toggleGroup}
                                    selectedNode={selectedNode}
                                    setSelectedNode={setSelectedNode}
                                />
                            )}

                            {/* Right Content Area: Node Details */}
                            <div className={EMBED
                                ? 'bg-gray-800 p-4 sm:p-6 rounded-lg shadow border border-gray-700 md:min-h-0 md:overflow-y-auto custom-scrollbar'
                                : 'md:col-span-3 bg-gray-800 p-4 sm:p-6 rounded-lg shadow border border-gray-700 md:min-h-0 md:overflow-y-auto custom-scrollbar'}>
                                {selectedNode ? (
                                    <div>
                                        <div className="mb-4">
                                            <h2 className="text-xl sm:text-3xl font-bold text-white font-mono break-words min-w-0">{selectedNode.name}</h2>
                                            <div className="flex items-center gap-2 flex-wrap mt-2">
                                                <span className="bg-gray-700 text-gray-300 text-xs px-2 py-1 rounded border border-gray-600">
                                                    {selectedNode.lib} / {selectedNode.group}
                                                </span>
                                                {selectedNode.info.section && (
                                                    <span className="bg-gray-700 text-gray-400 text-xs px-2 py-1 rounded border border-gray-600">
                                                        spec: {selectedNode.info.section}
                                                    </span>
                                                )}
                                                {isUndocumented(selectedNode.info) ? (
                                                    // No spec entry exists — a link would
                                                    // land nowhere useful, so show it
                                                    // disabled instead.
                                                    <span
                                                        title="This node has no entry in the official specification documents"
                                                        className="bg-gray-800 text-gray-600 text-xs px-2 py-1 rounded border border-gray-700 cursor-not-allowed select-none"
                                                    >
                                                        Official spec {'\u2197'}
                                                    </span>
                                                ) : (
                                                    <a
                                                        href={specUrlForNode(selectedNode)}
                                                        target="_blank" rel="noopener noreferrer"
                                                        title="Open this node in the official MaterialX specification on GitHub"
                                                        className="bg-gray-700 text-blue-300 hover:text-blue-200 text-xs px-2 py-1 rounded border border-gray-600 hover:border-blue-500/60 transition-colors"
                                                    >
                                                        Official spec {'\u2197'}
                                                    </a>
                                                )}
                                                <button
                                                    onClick={copyPermalink}
                                                    title="Copy a direct link to this node"
                                                    className={`text-xs px-2 py-1 rounded border transition-colors flex items-center gap-1 ${
                                                        copied
                                                            ? 'bg-green-700/30 border-green-600/60 text-green-300'
                                                            : 'bg-gray-700 border-gray-600 text-gray-300 hover:text-white hover:border-blue-500/60'
                                                    }`}
                                                >
                                                    {copied ? (
                                                        <React.Fragment>
                                                            <svg viewBox="0 0 20 20" className="w-3.5 h-3.5" fill="currentColor" aria-hidden="true"><path fillRule="evenodd" d="M16.7 5.3a1 1 0 010 1.4l-7.5 7.5a1 1 0 01-1.4 0L3.3 9.7a1 1 0 011.4-1.4l3.3 3.29 6.8-6.79a1 1 0 011.4 0z" clipRule="evenodd"/></svg>
                                                            Copied
                                                        </React.Fragment>
                                                    ) : (
                                                        <React.Fragment>
                                                            <svg viewBox="0 0 20 20" className="w-3.5 h-3.5" fill="currentColor" aria-hidden="true"><path d="M8.5 3A3.5 3.5 0 005 6.5v1a1 1 0 002 0v-1A1.5 1.5 0 018.5 5h5A1.5 1.5 0 0115 6.5v5A1.5 1.5 0 0113.5 13h-1a1 1 0 000 2h1a3.5 3.5 0 003.5-3.5v-5A3.5 3.5 0 0013.5 3h-5z"/><path d="M6.5 7A3.5 3.5 0 003 10.5v5A3.5 3.5 0 006.5 19h5a3.5 3.5 0 003.5-3.5v-1a1 1 0 00-2 0v1a1.5 1.5 0 01-1.5 1.5h-5A1.5 1.5 0 015 15.5v-5A1.5 1.5 0 016.5 9h1a1 1 0 000-2h-1z"/></svg>
                                                            Copy link
                                                        </React.Fragment>
                                                    )}
                                                </button>
                                            </div>
                                        </div>

                                        {/* INJECTED 3D PREVIEW */}
                                        <Node3DPreview
                                            nodeName={selectedNode.name}
                                            library={selectedNode.lib}
                                            nodegroup={selectedNode.group}
                                            preferredType={previewType}
                                            preferredDef={selectedVersion ? selectedVersion.name : null}
                                            disabledNotice={previewDisabled}
                                            enabled={showPreviews}
                                            onEnable={togglePreviews}
                                            active={active}
                                        />

                                        {/* Implementation-target matrix: which shading
                                            languages the standard library ships an
                                            implementation for, per signature. */}
                                        <ImplTargetMatrix
                                            nodeName={selectedNode.name}
                                            signature={selectedGroup ? selectedGroup.key : null}
                                        />

                                        {/* Description: paragraphs before the first table */}
                                        <RichBlocks
                                            text={selectedNode.info.description}
                                            refs={refs}
                                            className="text-gray-300 leading-relaxed mb-8 text-base sm:text-lg"
                                        />

                                        {/* Port tables: from the spec, or — for
                                            undocumented nodes — synthesized from
                                            the MaterialX nodedef with a disclaimer. */}
                                        {effectiveTables.length > 0 ? (
                                            <div className="space-y-6">
                                                {isAutoTable && (
                                                    <div className="bg-blue-950/40 border border-blue-800/60 text-blue-200/90 text-sm rounded-lg px-4 py-3 flex items-start gap-2">
                                                        <span aria-hidden="true">{'\u2139\uFE0F'}</span>
                                                        <span>
                                                            <span className="font-semibold text-blue-200">Auto-generated from the nodedef.</span>{' '}
                                                            This node has no specification documentation, so its ports,
                                                            types, and defaults were read directly from the MaterialX
                                                            node definition. Descriptions are unavailable and the
                                                            details may differ from an official write-up.
                                                        </span>
                                                    </div>
                                                )}
                                                {sigCount > 1 && (
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider" htmlFor="sig-select">
                                                            Signature
                                                        </label>
                                                        <select
                                                            id="sig-select"
                                                            value={sig}
                                                            onChange={(e) => setSigIndex(Number(e.target.value))}
                                                            title="This node has several signatures — pick which one to document and preview"
                                                            className="bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs sm:text-sm font-mono text-gray-200 max-w-full"
                                                        >
                                                            {sigGroups.map((g, i) => {
                                                                const l = g.type + (g.ambiguous && g.inSummary ? ' (' + g.inSummary + ')' : '');
                                                                return (
                                                                    <option key={g.key || i} value={i}>
                                                                        {(i + 1) + ' / ' + sigCount + (l ? ' — ' + l : '')}
                                                                    </option>
                                                                );
                                                            })}
                                                        </select>
                                                    </div>
                                                )}
                                                {showVersionPicker && (
                                                    <div className="flex items-center gap-2 flex-wrap">
                                                        <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider" htmlFor="version-select">
                                                            Version
                                                        </label>
                                                        <select
                                                            id="version-select"
                                                            value={versionIdx}
                                                            onChange={(e) => setVersionIndex(Number(e.target.value))}
                                                            title="This node has several nodedef versions — same ports, different defaults"
                                                            className="bg-gray-900 border border-gray-600 rounded px-2 py-1.5 text-xs sm:text-sm font-mono text-gray-200 max-w-full"
                                                        >
                                                            {selectedGroup.versions.map((v, i) => (
                                                                <option key={v.name || i} value={i}>
                                                                    {(v.version || '?') + (v.isDefaultVersion ? ' (default)' : '')}
                                                                </option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                )}
                                                {displayTables.map((table, i) => (
                                                    <PortTable key={sigCount > 1 ? (sig + ':' + i) : i} table={table} columns={columns} refs={refs}
                                                        defaultsOverride={defaultsOverride} typesOverride={typesOverride} />
                                                ))}
                                            </div>
                                        ) : autoLoading ? (
                                            <div className="bg-gray-900 border border-gray-700 rounded p-4 text-sm text-gray-500 italic">
                                                Generating a port table from the node definition…
                                            </div>
                                        ) : (
                                            <NodeDefPortsTable nodeName={selectedNode.name} />
                                        )}

                                        {/* Notes: prose after/between tables (sub-headings, equations, ...) */}
                                        {selectedNode.info.notes && (
                                            <RichBlocks
                                                text={selectedNode.info.notes}
                                                refs={refs}
                                                className="text-gray-300 leading-relaxed mt-8 pt-6 border-t border-gray-700"
                                            />
                                        )}

                                        {/* References: footnotes cited by this node */}
                                        {references.length > 0 && (
                                            <div className="mt-8 pt-6 border-t border-gray-700">
                                                <h4 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">References</h4>
                                                <ol className="space-y-2 text-sm text-gray-400">
                                                    {references.map((r, i) => (
                                                        <li key={r.key} className="flex gap-2">
                                                            <span className="text-gray-500 shrink-0">[{i + 1}]</span>
                                                            <span>
                                                                {r.text || r.key}
                                                                {r.url && (
                                                                    <a href={r.url} target="_blank" rel="noreferrer"
                                                                       className="ml-2 text-blue-400 hover:underline break-all">
                                                                        {r.url}
                                                                    </a>
                                                                )}
                                                            </span>
                                                        </li>
                                                    ))}
                                                </ol>
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div className="text-gray-500 flex items-center justify-center h-full">
                                        Select a node from the tree to view its details.
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {!EMBED && (
                    /* Disclaimer: previews are experimental; the spec MD files
                       in the MaterialX repository are the source of truth. */
                    <div className="bg-amber-950/40 border border-amber-700/60 text-amber-300/90 text-sm rounded-lg px-4 py-3">
                        <span className="font-semibold text-amber-300">{'\u26A0'} Experimental Preview:</span>{' '}
                        The 3D node previews and parameter values shown here are under development and may not
                        match reference renders. For any bugs, please report them in the {' '}
                        <a
                            href={ISSUES_URL}
                            target="_blank" rel="noopener noreferrer"
                            className="underline text-amber-200 hover:text-amber-100"
                        >
                            project repository.
                        </a>{' '}
                    </div>
                    )}
                </div>
            );
        }

        window.App = App;
