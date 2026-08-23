// docs-app.jsx — the App component for the MaterialX node documentation
// browser (index.html), extracted from its inline text/babel script.
// Uses index.html's literal \uXXXX escape-text convention (e.g. {'↗'})
// in some string literals — same as node-graph.html; preserve exactly.
// Loaded as text/babel after js/mtlx-engine.js and js/docs/*.jsx, which
// it depends on via window globals; reads window.__MTLX_EMBED (set by
// index.html's early <head> script) for embed-mode behavior. Node data
// comes from prebuilt js/gen/nodelib*.json — docs browsing is WASM-free;
// the MaterialX engine loads only for 3D previews.

        // Given nodeVersionGroups and a sig hint ({out, ins}, from a VS Code
        // hover link's `?sig=` — see doc-links.jsx's parseSigHint), returns
        // the group index to pre-select (-1 if none), disambiguating via hint.ins.
        // Stable empty fallbacks: inline `[]`/`{}` literals get a new
        // identity every render, defeating React.memo on consumers like
        // PortTable — kept module-level so identity never changes.
        const EMPTY_TABLES = [];
        const EMPTY_COLUMNS = [];

        const matchSigHintToGroups = (groups, hint) => {
            if (!groups || !groups.length || !hint || !hint.out) return -1;

            let candidates = [];
            for (let i = 0; i < groups.length; i++) {
                if (groups[i].type === hint.out) candidates.push(i);
            }
            if (!candidates.length) {
                const wantLower = hint.out.toLowerCase();
                for (let i = 0; i < groups.length; i++) {
                    if ((groups[i].type || '').toLowerCase() === wantLower) candidates.push(i);
                }
            }
            if (!candidates.length) return -1;
            if (candidates.length === 1 || !hint.ins || !hint.ins.length) return candidates[0];

            for (const idx of candidates) {
                const group = groups[idx];
                const defaultVersion = group.versions && group.versions[0];
                if (!defaultVersion) continue;
                const inputTypes = defaultVersion.inputTypes || {};
                const satisfiesAll = hint.ins.every((inp) =>
                    Object.prototype.hasOwnProperty.call(inputTypes, inp.name) && inputTypes[inp.name] === inp.type);
                if (satisfiesAll) return idx;
            }
            return candidates[0];
        };

        // Which table(s) to render: narrows multi-table documented nodes to
        // the ONE table matching the selected signature. Keep `sigCount > 1`
        // here in sync with the same gate on typesOverride/defaultsOverride below.
        const resolveDisplayTables = (portTables, sigCount, selectedGroup, autoDoc, sig, effectiveTables) =>
            portTables.length > 0
                ? (portTables.length > 1 && sigCount > 1 && selectedGroup
                    ? [pickTableForType(portTables, selectedGroup.type) || portTables[0]]
                    : portTables)
                : (sigCount > 1 ? [autoDoc && autoDoc.tables && autoDoc.tables[sig]].filter(Boolean)
                    : effectiveTables);

        // Decides previewability from the selected signature's exact types
        // and passes it to Node3DPreview (which must not re-derive it from
        // nodedefs). Returns a notice string when unpreviewable, else null.
        const resolvePreviewDisabled = (selectedGroup, selectedVersion, selectedNode) => {
            if (!selectedGroup || !selectedVersion) return null; // groups not loaded — previewer decides
            const CLOSURE = ['BSDF', 'EDF', 'VDF'];
            const VIEWABLE = ['color3', 'color4', 'float', 'vector2', 'vector3', 'vector4'];
            const out = selectedGroup.type;
            // '+'-joined multi-output signature, or the literal
            // 'multioutput' string nodedef.getType() returns: no single
            // output type to gate on — deferred to the previewer instead.
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
        };

        function App({ active = true, inline = false, initialHash } = {}) {
            // Embed mode: focused single-node view, iframed by the graph
            // editor (index.html?embed=1#/<lib>/<group>/<name>) — flag is
            // set synchronously in <head> before first paint.
            const EMBED = !!window.__MTLX_EMBED;
            // inline: mounted in the graph editor's docs dialog, wanting
            // embed mode's stripped-down layout. chromeless covers both,
            // since EMBED (a parse-time const) can't express this case.
            const chromeless = inline || EMBED;
            // True when hosted inside the VS Code extension's webview (set
            // by its bootstrap). Distinct from chromeless: this gates
            // webview-only affordances (e.g. copying a permalink), not layout.
            const IN_VSCODE = !!window.__MTLX_VSCODE__;
            // Kept current every render so the mtlx-open-node listener below
            // (registered once per jsonData load) can gate on the LATEST
            // active value without re-subscribing.
            const activeRef = React.useRef(active);
            activeRef.current = active;
            // The hash the page LANDED on — read once, before the async spec-DB
            // load can race with the user switching shell views (which rewrites
            // location.hash to a '#!' route and would lose a docs deep link).
            const initialHashRef = React.useRef(window.location.hash);
            // A pending sig hint (`{name, hint}`, from hashToSel's sel.sigHint),
            // applied to the Signature dropdown once nodeVersionGroups loads.
            // A ref, not state: it must not itself trigger a render.
            const pendingSigRef = React.useRef(null);
            // Companion to pendingSigRef for `?ver=`: the nodedef version to
            // land on once the signature's version list is known. Only ever
            // SET from a hash, never cleared there — selecting a node
            // rewrites the URL without the query, so a second pass over the
            // hash would wipe a hint it can no longer see. Consumption
            // clears it, and matching is guarded by node name.
            const pendingVerRef = React.useRef(null);
            const [jsonData, setJsonData] = React.useState(null);
            const [selectedNode, setSelectedNode] = React.useState(null);
            // Which signature (port table) of the selected node is shown —
            // and previewed. Reset on every selection change.
            const [sigIndex, setSigIndex] = React.useState(0);
            React.useEffect(() => {
                setSigIndex(0);
                // A pending sig hint targets ONE specific node by name;
                // if this selection is for a different node (e.g. a
                // sidebar click raced the hint before consumption), drop it.
                if (pendingSigRef.current && selectedNode && pendingSigRef.current.name !== selectedNode.name) {
                    pendingSigRef.current = null;
                }
            }, [selectedNode]);
            const [copied, setCopied] = React.useState(false);
            // Resolves doc links pointing at a spec #node-... anchor to a
            // loaded node (separators stripped from both sides so
            // hyphenated/squashed spellings match); unknown → official page.
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
                    // Only the ACTIVE instance reacts: a kept-alive docs
                    // view and an inline dialog instance can both be
                    // mounted at once; only one should respond per click.
                    if (!activeRef.current) return;
                    const hit = index[e.detail.key];
                    if (hit) {
                        setSelectedNode(hit);
                        // Inline: the dialog owns its own scroll container,
                        // not the page — and there's no ref to the detail
                        // pane to scroll instead, so just skip scrolling.
                        if (!inline) window.scrollTo({ top: 0, behavior: 'smooth' });
                    } else if (e.detail.url) {
                        window.open(e.detail.url, '_blank', 'noopener');
                    } else {
                        mtlxWarn('mtlx-open-node: no node matches key', e.detail.key);
                    }
                };
                window.addEventListener('mtlx-open-node', onOpen);
                return () => {
                    window.removeEventListener('mtlx-open-node', onOpen);
                    if (window.__mtlxNodeIndex === index) delete window.__mtlxNodeIndex;
                };
            }, [jsonData]);

            // KaTeX defer-load is now handled by MathText itself via
            // rich-text.jsx's useKatexReady(); App no longer needs its
            // own poll/state for this.

            // State to keep track of which tree folders are open
            const [expandedLibs, setExpandedLibs] = React.useState({});
            const [expandedGroups, setExpandedGroups] = React.useState({});

            // Shared initialization for both auto-loaded and uploaded data.
            const applyData = (parsedData, source) => {
                setJsonData(parsedData);
                setSelectedNode(null);
                setDataSource(source);

                // A permalink (#/lib/group/name) wins over the default first
                // node. A '#!...' hash means a view switch raced the spec-DB
                // load — fall back to the landed hash; inline uses initialHash.
                let hashForSel;
                if (inline) {
                    hashForSel = initialHash || '';
                } else {
                    const rawHash = window.location.hash;
                    hashForSel = /^#!/.test(rawHash) ? initialHashRef.current : rawHash;
                }
                const fromHash = hashToSel(parsedData, hashForSel);
                if (fromHash) {
                    setExpandedLibs({ [fromHash.lib]: true });
                    setExpandedGroups({ [`${fromHash.lib}-${fromHash.group}`]: true });
                    // A `?sig=` hint (VS Code hover deep link only — see
                    // doc-links.jsx's parseSigHint) is set right before
                    // setSelectedNode, so the sigIndex-reset effect above sees it.
                    pendingSigRef.current = fromHash.sigHint ? { name: fromHash.name, hint: fromHash.sigHint } : null;
                    if (fromHash.verHint) pendingVerRef.current = { name: fromHash.name, version: fromHash.verHint };
                    setSelectedNode(fromHash);
                    return;
                }

                // Default landing node: OpenPBR's surface shader when
                // present — a far better first impression (and a
                // parameter-rich preview) than whatever sorts first.
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

            // Keeps the address bar in sync via replaceState (no history
            // entry, no hashchange feedback loop) — one Back exits docs
            // entirely. Only writes while VISIBLE (skips stomping other views).
            React.useEffect(() => {
                // An inline instance (mounted inside the graph editor's docs
                // dialog) must NEVER touch the parent page's URL/history —
                // that hash belongs to the graph view's own routing.
                if (inline) return;
                if (!selectedNode || !active) return;
                const h = selToHash(selectedNode);
                if (window.location.hash !== h) {
                    // replaceState resolves h against <base>; under the VS
                    // Code webview that base is a different origin, so it
                    // throws — fall back to a plain fragment assignment,
                    // which never leaves the document (at the cost of a
                    // hashchange the onNav listener below re-resolves,
                    // idempotently, to the already-selected node).
                    try { history.replaceState(null, '', h); } catch (e) { window.location.hash = h; }
                }
            }, [selectedNode, active]);
            React.useEffect(() => {
                // The parent page's hash belongs to the graph view when
                // inline — an inline instance must not react to it.
                if (inline || !jsonData) return undefined;
                const onNav = () => {
                    const sel = hashToSel(jsonData, window.location.hash);
                    if (sel) {
                        setExpandedLibs((p) => Object.assign({}, p, { [sel.lib]: true }));
                        setExpandedGroups((p) => Object.assign({}, p, { [`${sel.lib}-${sel.group}`]: true }));
                        // Same pending-hint queuing as applyData's
                        // fromHash branch above — see its comment.
                        pendingSigRef.current = sel.sigHint ? { name: sel.name, hint: sel.sigHint } : null;
                        if (sel.verHint) pendingVerRef.current = { name: sel.name, version: sel.verHint };
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

            // Loads the pregenerated node docs JSON: nodelib.json (Layer 1)
            // + nodelib-index.json (Layer 2, feeds genData below). Both are
            // committed — a failure here means a hosting/path bug.
            const [autoLoad, setAutoLoad] = React.useState('loading'); // loading | done | failed
            const [dataSource, setDataSource] = React.useState(null);
            const [genData, setGenData] = React.useState(null);
            React.useEffect(() => {
                Promise.all([fetch('js/gen/nodelib.json'), fetch('js/gen/nodelib-index.json')])
                    .then((rs) => Promise.all(rs.map((r) => {
                        if (!r.ok) throw new Error('HTTP ' + r.status);
                        return r.json();
                    })))
                    .then(([db, index]) => {
                        setGenData(index);
                        applyData(db, `MaterialX ${index.meta.tag} specification (pregenerated)`);
                        setAutoLoad('done');
                    })
                    .catch((err) => {
                        console.warn('Pregenerated node library load failed', err);
                        setAutoLoad('failed');
                    });
            }, []);

            // Auto-generated port tables (nodes with no spec docs): read
            // straight off genData, the pregenerated Layer-2 index — no
            // live WASM read.
            const autoDoc = React.useMemo(() => {
                if (!selectedNode || !genData) return null;
                const name = selectedNode.name;
                const entry = genData.nodes[name];
                const tables = (entry && entry.autoTables) || [];
                return { name, status: tables.length ? 'ready' : 'unavailable', tables };
            }, [selectedNode, genData]);

            // VERSION metadata for EVERY selection, read off
            // genData.nodes[name].sigGroups — intentionally UNFILTERED
            // (e.g. 'multiply' lists every signature); previewer hides the rest.
            const nodeVersionGroups = React.useMemo(() => {
                if (!genData || !selectedNode) return null;
                const entry = genData.nodes[selectedNode.name];
                return (entry && entry.sigGroups) || null;
            }, [selectedNode, genData]);
            // Consumes a pending sig hint once nodeVersionGroups has loaded
            // for the selected node (matching needs live version data).
            // Cleared even on a no-match, so it applies at most once.
            React.useEffect(() => {
                const pending = pendingSigRef.current;
                if (!pending || !selectedNode || pending.name !== selectedNode.name) return;
                if (!nodeVersionGroups) return; // groups not loaded yet — wait for the next run
                pendingSigRef.current = null;
                const idx = matchSigHintToGroups(nodeVersionGroups, pending.hint);
                if (idx > 0) setSigIndex(idx);
            }, [nodeVersionGroups, selectedNode]);
            // Which VERSION is selected within the resolved signature
            // group — reset on selection/signature change, since a
            // different signature may resolve to a different default.
            const [versionIndex, setVersionIndex] = React.useState(0);
            // Two effects, ordered: the reset stands aside while a hint is
            // pending for THIS node, and the applier consumes it. Folding
            // them into one meant every later run re-reset to 0 once the
            // hint had been consumed.
            React.useEffect(() => {
                const p = pendingVerRef.current;
                if (p && selectedNode && p.name === selectedNode.name) return; // the hint owns this selection
                setVersionIndex(0);
            }, [selectedNode, sigIndex]);
            React.useEffect(() => {
                const pending = pendingVerRef.current;
                if (!pending || !selectedNode || pending.name !== selectedNode.name) return;
                const groups = nodeVersionGroups;
                if (!groups || !groups.length) return; // version list not loaded yet
                const group = groups[Math.min(sigIndex, groups.length - 1)];
                if (!group || !group.versions) return;
                const idx = group.versions.findIndex((v) => v.version === pending.version);
                pendingVerRef.current = null; // applies at most once
                setVersionIndex(idx > 0 ? idx : 0);
            }, [selectedNode, sigIndex, nodeVersionGroups]);

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
            // Help popup (the Help button in the sidebar's control row).
            const [showHelp, setShowHelp] = React.useState(false);
            useEscapeToClose(() => setShowHelp(false), showHelp);
            // md+-only Node Library panel collapse; ephemeral, no localStorage
            // (site panel-collapse policy).
            const [sidebarCollapsed, setSidebarCollapsed] = React.useState(false);
            const [searchQuery, setSearchQuery] = React.useState('');
            // Global 3D-preview switch, persisted across sessions so slow
            // machines stay preview-free. localStorage is best-effort
            // (private mode etc. throws) — default is ON.
            const [showPreviews, setShowPreviews] = React.useState(() => {
                if (chromeless) return true;
                try { return localStorage.getItem('mtlx_show_previews') !== '0'; } catch (e) { return true; }
            });
            const togglePreviews = () => setShowPreviews((v) => {
                const nv = !v;
                try { localStorage.setItem('mtlx_show_previews', nv ? '1' : '0'); } catch (e) { /* best-effort */ }
                return nv;
            });
            // Warms the MaterialX module so the header's version badge
            // resolves and the first preview skips the WASM download.
            // Docs browsing itself is WASM-free — only warm once previews are enabled.
            React.useEffect(() => {
                if (!showPreviews) return;
                getMxEnv().catch(() => {});
            }, [showPreviews]);

            const stats = React.useMemo(() => {
                if (!jsonData) return null;
                let total = 0, undoc = 0;
                const undocKeys = new Set();
                Object.entries(jsonData).forEach(([lib, groups]) =>
                    Object.entries(groups).forEach(([group, nodes]) =>
                        Object.entries(nodes).forEach(([name, info]) => {
                            total++;
                            if (isUndocumented(info)) {
                                undoc++;
                                undocKeys.add(`${lib}-${group}-${name}`);
                            }
                        })
                    )
                );
                return { total, undoc, undocKeys };
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

            // Memoized so portTables/columns/typesOverride/refs keep a
            // stable identity for React.memo'd PortTable/MathText/RichBlocks
            // — an inline recompute would defeat the memo on unrelated re-renders.
            const portTables = React.useMemo(
                () => selectedNode ? getPortTables(selectedNode.info) : EMPTY_TABLES,
                [selectedNode]
            );
            // For undocumented nodes, fall back to the nodedef-generated tables.
            const autoReady = autoDoc && selectedNode && autoDoc.name === selectedNode.name
                && autoDoc.status === 'ready';
            const isAutoTable = portTables.length === 0 && autoReady && autoDoc.tables.length > 0;
            const effectiveTables = portTables.length > 0 ? portTables
                : (isAutoTable ? autoDoc.tables : EMPTY_TABLES);
            // Signature selection is driven by live nodedef VERSION GROUPS,
            // not by counting markdown tables — fractal3d has ELEVEN
            // nodedefs collapsed into ONE table, invisible to effectiveTables.length.
            const sigGroups = nodeVersionGroups || [];
            const sigCount = sigGroups.length;
            const sig = Math.min(sigIndex, Math.max(sigCount - 1, 0));
            const selectedGroup = sigGroups[sig] || null;
            // Which table(s) to render — see resolveDisplayTables above
            // for the full selection rules.
            const displayTables = React.useMemo(
                () => resolveDisplayTables(portTables, sigCount, selectedGroup, autoDoc, sig, effectiveTables),
                [portTables, sigCount, selectedGroup, autoDoc, sig, effectiveTables]
            );
            // Concrete type this signature previews as (null → auto-pick).
            // Falls back to the markdown-table heuristic while
            // nodeVersionGroups is still loading, so preview isn't blocked.
            const previewType = selectedGroup ? selectedGroup.type
                : (effectiveTables.length > 0 ? signaturePreviewType(effectiveTables[0]) : null);
            // The VERSION picker (same/multiple defaults within a signature)
            // now reads directly off the selected group instead of
            // re-matching by output type.
            const showVersionPicker = !!selectedGroup && selectedGroup.versions.length > 1;
            const versionIdx = selectedGroup
                ? Math.min(versionIndex, Math.max(selectedGroup.versions.length - 1, 0)) : 0;
            const selectedVersion = selectedGroup ? selectedGroup.versions[versionIdx] : null;
            // Markdown tables carry only ONE signature's port rows, so once
            // several exist, the selected version's live type/default data
            // must be projected onto them, or a picked signature shows stale data.
            const typesOverride = React.useMemo(
                () => (sigCount > 1 && selectedVersion && portTables.length > 0)
                    ? { ...selectedVersion.inputTypes, ...selectedVersion.outputTypes } : null,
                [sigCount, selectedVersion, portTables]
            );
            // Already a stable reference (selectedVersion.defaults, straight
            // off the pregenerated data — no new object built here); no
            // memo needed.
            const defaultsOverride = selectedVersion && (sigCount > 1 || !selectedVersion.isDefaultVersion)
                ? selectedVersion.defaults : null;
            // Previewability decided HERE, where the selected signature's exact
            // types are known, and passed down — see resolvePreviewDisabled
            // above for the type-gating rules.
            const previewDisabled = resolvePreviewDisabled(selectedGroup, selectedVersion, selectedNode);
            // Column set for the displayed table(s).
            const columns = React.useMemo(
                () => displayTables.length > 0 ? unionColumns(displayTables) : EMPTY_COLUMNS,
                [displayTables]
            );
            // Footnote references: map key -> {n, url, text}, numbered by
            // order of first appearance (the parser preserves that order).
            const references = (selectedNode && selectedNode.info.references) || [];
            // Keyed on selectedNode, not references: a missing
            // info.references falls back to a fresh `[]` every render,
            // which would defeat the memo even though data hasn't changed.
            const docsRootRef = React.useRef(null);
            const refs = React.useMemo(() => {
                const map = {};
                references.forEach((r, i) => { map[r.key] = { n: i + 1, url: r.url, text: r.text }; });
                return map;
            }, [selectedNode]);

            return (
                // The grid needs a `relative` host whose first child it can be,
                // but the content column carries space-y-*, which would push
                // that column's own first child down. Hence the extra shell.
                <div ref={docsRootRef} className="relative md:h-full md:flex md:flex-col md:min-h-0">
                    {/* Page decoration only. Inside the graph editor's docs
                        dialog (inline) and in embed mode there is no page to
                        decorate, and HeroGrid would measure against the HOST
                        view's wrapper, overflowing the dialog sideways. */}
                    {!chromeless && <HeroGrid rootRef={docsRootRef} fadeRef={docsRootRef} fadeFrom="top" />}
                {/* relative, like every other HeroGrid host: the grid is an
                    absolute sibling, and CSS paints positioned elements above
                    the backgrounds of static ones, so without this the grid
                    would sit ON TOP of the panels instead of behind them. */}
                <div className="relative space-y-4 sm:space-y-6 md:flex-1 md:min-h-0 md:flex md:flex-col">
                    {/* Data source status: visible only while loading or on failure */}
                    {autoLoad === 'loading' && (
                        <div className="bg-gray-800 p-4 rounded-xl border border-gray-800 text-sm text-gray-400">
                            Loading the node library…
                        </div>
                    )}
                    {autoLoad === 'failed' && (
                        <div className="bg-gray-800 p-4 rounded-xl border border-amber-700/60 text-sm text-gray-300">
                            Could not load the pregenerated node library data
                            (js/gen/nodelib.json, js/gen/nodelib-index.json). Reload the
                            page, or if you're building from source, run
                            `npm run build:nodelib` to (re)generate them.
                        </div>
                    )}

                    {/* Help popup — js/docs/sidebar.jsx's DocsHelpDialog. App
                        keeps the showHelp state and useEscapeToClose above;
                        DocsHelpDialog just gets open/onClose. */}
                    {!chromeless && <DocsHelpDialog open={showHelp} onClose={() => setShowHelp(false)} />}

                    {jsonData && (
                        /* md+: the grid absorbs all height between the page
                           top and disclaimers; panels scroll internally. The
                           20rem floor avoids squishing them on short windows. */
                        <div className={chromeless
                            ? 'grid grid-cols-1 gap-3 sm:gap-6 md:flex-1 md:min-h-[20rem]'
                            : (sidebarCollapsed
                                /* md:-m-6 cancels the shell's page padding
                                   for edge-to-edge (md-scoped: collapse only
                                   exists at md+); md:gap-0 keeps the strip flush. */
                                ? 'grid grid-cols-1 md:grid-cols-[auto_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] gap-3 sm:gap-6 md:gap-0 md:flex-1 md:min-h-[20rem] md:-m-6'
                                // Expanded: sizes the sidebar column to its min-content —
                                // just wide enough for the filter tri-state + "3D Preview"
                                // row. The doc pane's columns stay minmax(0,1fr).
                                : 'grid grid-cols-1 md:grid-cols-[min-content_repeat(3,minmax(0,1fr))] md:grid-rows-[minmax(0,1fr)] gap-3 sm:gap-6 md:flex-1 md:min-h-[20rem]')}>

                            {/* Vertical twin of the footer's collapsed "Disclaimer" strip: a slim
                                full-height in-flow bar in the grid's auto column; click re-opens
                                the panel. */}
                            {!chromeless && sidebarCollapsed && (
                                <div className="hidden md:block">
                                    <button
                                        onClick={() => setSidebarCollapsed(false)}
                                        title="Expand the node library panel"
                                        aria-label="Expand the node library panel"
                                        aria-expanded="false"
                                        className="h-full w-7 flex flex-col items-center gap-1.5 py-2 bg-gray-900 border-r border-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
                                    >
                                        <MtlxIcon name="chevrons-right" className="w-4 h-4 shrink-0" />
                                        <span className="text-xs [writing-mode:vertical-rl] whitespace-nowrap">Search Nodes</span>
                                    </button>
                                </div>
                            )}

                            {/* Left Sidebar: js/docs/sidebar.jsx's DocsSidebar. App owns
                                the state/derived data below. Always mounted (not just
                                when expanded) so its state survives collapse/expand. */}
                            {!chromeless && (
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
                                    stats={stats}
                                    applyDocFilter={applyDocFilter}
                                    showPreviews={showPreviews}
                                    togglePreviews={togglePreviews}
                                    onShowHelp={() => setShowHelp(true)}
                                    collapsed={sidebarCollapsed}
                                    onCollapse={() => setSidebarCollapsed(true)}
                                />
                            )}

                            {/* Right Content Area: Node Details */}
                            <div className={(chromeless || sidebarCollapsed ? '' : 'md:col-span-3 ')
                                + 'bg-gray-800 p-4 sm:p-6'
                                /* Inline (the graph editor's docs dialog): the DialogFrame
                                   panel is the edge and its scroller already reserves a
                                   gutter, so card chrome would box a box and a second
                                   overflow-y-auto would reserve a second gutter. ?embed=1
                                   keeps the shell's page padding, so it keeps the card. */
                                + (inline ? ''
                                    : ' rounded-xl border border-gray-800 md:min-h-0 md:overflow-y-auto custom-scrollbar'
                                    /* Collapsed (md+) docs pane loses its card chrome, rounded
                                       corners and border, so it reads as edge-to-edge content
                                       against the now-flush (md:-m-6) shell background. */
                                    + (!chromeless && sidebarCollapsed ? ' md:rounded-none md:border-0' : ''))}>
                                {selectedNode ? (
                                    <div>
                                        <div className="mb-4">
                                            <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-blue-300 mb-1">
                                                {selectedNode.lib}<span className="text-gray-600">/</span><span className="text-gray-400">{selectedNode.group}</span>
                                            </div>
                                            <h2 className="text-xl sm:text-3xl font-bold text-white font-mono tracking-[-0.01em] break-words min-w-0">{selectedNode.name}</h2>
                                            <div className="flex items-center gap-2 flex-wrap mt-2">
                                                {selectedNode.info.section && (
                                                    <span className="inline-flex items-center h-6 px-2 rounded-md border border-gray-700 bg-gray-800/60 text-[11px] font-medium text-gray-400">
                                                        spec: {selectedNode.info.section}
                                                    </span>
                                                )}
                                                {isUndocumented(selectedNode.info) ? (
                                                    // No spec entry exists, so a link would
                                                    // land nowhere useful; show it disabled
                                                    // instead.
                                                    <span
                                                        title="This node has no entry in the official specification documents"
                                                        className="inline-flex items-center gap-1 h-6 px-2 rounded-md border border-gray-700 bg-gray-800/50 text-[11px] font-medium text-gray-600 cursor-not-allowed select-none"
                                                    >
                                                        Official spec <MtlxIcon name="external-link" className="w-3.5 h-3.5" />
                                                    </span>
                                                ) : (
                                                    <a
                                                        href={specUrlForNode(selectedNode)}
                                                        target="_blank" rel="noopener noreferrer"
                                                        title="Open this node in the official MaterialX specification on GitHub"
                                                        className="inline-flex items-center gap-1 h-6 px-2 rounded-md border border-gray-600/50 bg-gray-900/70 text-[11px] font-medium text-blue-300 hover:text-blue-200 hover:border-blue-500/60 transition-colors"
                                                    >
                                                        Official spec <MtlxIcon name="external-link" className="w-3.5 h-3.5" />
                                                    </a>
                                                )}
                                                {/* Under VS Code the webview's origin makes a copied
                                                    URL meaningless, so hide the button. Gated on
                                                    IN_VSCODE, not chromeless/inline — this is host-specific. */}
                                                {!IN_VSCODE && (
                                                <button
                                                    onClick={copyPermalink}
                                                    title="Copy a direct link to this node"
                                                    className={'inline-flex items-center gap-1 h-6 px-2 rounded-md border text-[11px] font-medium transition-colors ' + (
                                                        copied
                                                            ? 'bg-green-700/30 border-green-600/60 text-green-300'
                                                            : 'border-gray-600/50 bg-gray-900/70 text-gray-400 hover:bg-gray-700 hover:border-gray-600 hover:text-gray-100'
                                                    )}
                                                >
                                                    {copied ? (
                                                        <React.Fragment>
                                                            <MtlxIcon name="copy-check" className="w-3.5 h-3.5" />
                                                            Copied
                                                        </React.Fragment>
                                                    ) : (
                                                        <React.Fragment>
                                                            <MtlxIcon name="copy" className="w-3.5 h-3.5" />
                                                            Copy link
                                                        </React.Fragment>
                                                    )}
                                                </button>
                                                )}
                                                {/* Signature + Version pickers live up here in
                                                    the badge row — they drive the preview AND
                                                    the port table below, so they shouldn't be
                                                    buried next to the tables. Right-aligned via
                                                    ml-auto; the sub-container is itself a
                                                    wrappable flex row, so on narrow widths it
                                                    drops to its own line(s) instead of
                                                    squeezing the badges. Gated on sigCount
                                                    alone (not the tables): multi-signature
                                                    nodes deserve the picker even when only the
                                                    auto-generated ports table renders. */}
                                                {(sigCount > 1 || showVersionPicker) && (
                                                    <div className="ml-auto flex items-center gap-2 flex-wrap justify-end">
                                                        {sigCount > 1 && (
                                                            <React.Fragment>
                                                                <label className="text-[10px] font-semibold uppercase tracking-[0.08em] text-gray-500">
                                                                    Signature
                                                                </label>
                                                                <MtlxSelect
                                                                    value={sig}
                                                                    options={sigGroups.map((g, i) => {
                                                                        const l = g.type + (g.ambiguous && g.inSummary ? ' (' + g.inSummary + ')' : '');
                                                                        return { value: i, label: (i + 1) + ' / ' + sigCount + (l ? ' - ' + l : '') };
                                                                    })}
                                                                    onChange={setSigIndex}
                                                                    title="This node has several signatures - pick which one to document and preview"
                                                                    ariaLabel="Signature"
                                                                    font="mono"
                                                                    size="sm"
                                                                    variant="field"
                                                                    className="max-w-full"
                                                                />
                                                            </React.Fragment>
                                                        )}
                                                        {showVersionPicker && (
                                                            <React.Fragment>
                                                                <label className="text-[10px] font-semibold uppercase tracking-[0.08em] text-gray-500">
                                                                    Version
                                                                </label>
                                                                <MtlxSelect
                                                                    value={versionIdx}
                                                                    options={selectedGroup.versions.map((v, i) => ({
                                                                        value: i,
                                                                        label: (v.version || '?') + (v.isDefaultVersion ? ' (default)' : ''),
                                                                    }))}
                                                                    onChange={setVersionIndex}
                                                                    title="This node has several nodedef versions - same ports, different defaults"
                                                                    ariaLabel="Version"
                                                                    font="mono"
                                                                    size="sm"
                                                                    variant="field"
                                                                    className="max-w-full"
                                                                />
                                                            </React.Fragment>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        {/* Wrapped in PreviewErrorBoundary since previews touch
                                            wasm/GL and a render throw here would otherwise blank
                                            the whole page — no other error boundary exists. */}
                                        <PreviewErrorBoundary>
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
                                            embed={chromeless}
                                        />
                                        </PreviewErrorBoundary>

                                        {/* Implementation-target matrix: which shading
                                            languages the standard library ships an
                                            implementation for, per signature. */}
                                        <ImplTargetMatrix
                                            nodeName={selectedNode.name}
                                            signature={selectedGroup ? selectedGroup.key : null}
                                            implRows={genData && selectedNode
                                                ? ((genData.nodes[selectedNode.name] && genData.nodes[selectedNode.name].impl) || [])
                                                : null}
                                            allTargets={genData ? genData.allTargets : []}
                                        />

                                        {/* Description: paragraphs before the first table, or a
                                            styled placeholder when the spec has no entry at all. */}
                                        {isUndocumented(selectedNode.info) ? (
                                            <div className="flex items-start gap-3 mt-4 mb-4">
                                                <div className="w-9 h-9 rounded-[9px] bg-blue-500/10 border border-blue-500/25 flex items-center justify-center text-blue-400 shrink-0">
                                                    <MtlxIcon name="info-circle" className="w-[18px] h-[18px]" />
                                                </div>
                                                <div className="min-w-0 text-sm leading-5 text-gray-400 pt-0.5">
                                                    <div className="text-gray-200 font-medium">No specification entry for this node.</div>
                                                    <div className="mt-0.5">Ports, types and defaults below are read from its MaterialX nodedef; descriptions are unavailable.</div>
                                                </div>
                                            </div>
                                        ) : (
                                            <RichBlocks
                                                text={selectedNode.info.description}
                                                refs={refs}
                                                className="text-gray-300 leading-relaxed mb-8 text-base sm:text-lg"
                                            />
                                        )}

                                        {/* Port tables: from the spec, or, for undocumented
                                            nodes, synthesized from the MaterialX nodedef with
                                            a disclaimer (suppressed above when already shown). */}
                                        {effectiveTables.length > 0 ? (
                                            <div className="space-y-6">
                                                {isAutoTable && !isUndocumented(selectedNode.info) && <AutoDocNotice />}
                                                {displayTables.map((table, i) => (
                                                    <PortTable key={sigCount > 1 ? (sig + ':' + i) : i} table={table} columns={columns} refs={refs}
                                                        defaultsOverride={defaultsOverride} typesOverride={typesOverride} />
                                                ))}
                                            </div>
                                        ) : (
                                            <NodeDefPortsTable
                                                rows={(genData && selectedNode && genData.nodes[selectedNode.name] && genData.nodes[selectedNode.name].defPorts) || []}
                                                showNotice={!isUndocumented(selectedNode.info)}
                                            />
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
                                                <h4 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-gray-500 mb-3">References</h4>
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
                                    <div className="flex flex-col items-center justify-center gap-3 h-full">
                                        <div className="w-9 h-9 rounded-[9px] bg-blue-500/10 border border-blue-500/25 flex items-center justify-center text-blue-400">
                                            <MtlxIcon name="file-code" className="w-[18px] h-[18px]" />
                                        </div>
                                        <div className="text-sm text-gray-500">Select a node from the tree to view its details.</div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}
                </div>
                </div>
            );
        }

        window.App = App;
