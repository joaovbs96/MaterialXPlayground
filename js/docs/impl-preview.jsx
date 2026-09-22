// impl-preview.jsx — inline implementation-nodegraph preview panel for a
// docs node page. Sits between the 3D preview and the Implementations row
// (docs-app.jsx). Modeled on js/usd-scene-app.jsx's MaterialPreviewPanel:
// small header (breadcrumb + title, an editor-handoff button, a close
// button) hosting window.MtlxGraphPreview (js/graph/graph-preview.jsx).
//
// Deps: window.MtlxGraphPreview and its own deps (React Flow, dagre,
// js/graph/model.jsx etc.) are NOT in the docs view's eager VIEW_DEPS —
// they're loaded on demand via window.mtlxLoadViewDeps('galleryDetail'),
// the same dependency-only bundle js/usd-scene-app.jsx's panel uses (see
// js/shell.jsx's VIEW_DEPS.galleryDetail). Resolving the nodegraph itself
// needs window.getMxEnv (js/mtlx-engine.js) plus window.computeImplGraphByNodedef
// and window.docChild (js/graph/model.jsx, so only callable once that
// bundle has loaded). Everything else used here (mxSafe, mxExclusive,
// mtlxWarn, fullscreenElement, toggleFullscreen, PreviewErrorBoundary,
// useEscapeToClose, MtlxIcon) is already eager via docs' own VIEW_DEPS
// (js/mtlx-engine.js, js/shared/mtlx-ui.jsx). The "View in Graph Editor"
// button builds its window.__mtlxPendingImport handoff directly (not via
// js/shared/mtlx-ui.jsx's openInGraphEditor) so it can carry `returnHash`,
// a field that helper doesn't know about — see openInEditor below.
// No top-level import/export; self-exports at the bottom.

        // Builds a standalone one-nodegraph XML document for nodedef
        // `ndName`'s library implementation: a fresh document holding a
        // COPY of the stdlib nodegraph (addNodeGraph + copyContentFrom),
        // so the caller gets a small self-contained XML string rather than
        // the whole standard library. Runs under mxExclusive since wasm
        // calls must be serialized against any other in-flight doc work
        // (e.g. the 3D preview above regenerating at the same time).
        const resolveImplGraphXml = async (ndName) => {
            const { mx, stdlib } = await getMxEnv();
            return window.mxExclusive(() => {
                const map = window.computeImplGraphByNodedef ? window.computeImplGraphByNodedef(stdlib) : null;
                const ngName = map ? map.get(ndName) : null;
                if (!ngName) return { xml: null, graphName: null };
                const src = (window.docChild && window.docChild(stdlib, ngName))
                    || mxSafe(() => stdlib.getNodeGraph(ngName), null);
                if (!src) return { xml: null, graphName: null };
                const doc = mx.createDocument();
                let created = null;
                try {
                    created = mxSafe(() => doc.addNodeGraph(ngName), null);
                    if (!created) return { xml: null, graphName: null };
                    const copied = mxSafe(() => { created.copyContentFrom(src); return true; }, false);
                    if (!copied) return { xml: null, graphName: null };
                    const xml = mxSafe(() => mx.writeToXmlString(doc), null);
                    return { xml, graphName: ngName };
                } finally {
                    try { if (created) created.delete(); } catch (e) { /* already freed */ }
                    try { doc.delete(); } catch (e) { /* already freed */ }
                }
            });
        };

        // `nodeCategory`/`ndName`/`outType` mirror docs-app.jsx's own
        // viewImplementation() handoff payload — the panel builds the same
        // one-node XML for its "View in Graph Editor" button. `open` gates
        // rendering/loading; the panel unmounts entirely on close, so
        // reopening always re-resolves (cheap: a handful of wasm calls).
        function DocsImplPreviewPanel({ open, lib, group, nodeName, ndName, outType, returnHash, onClose, inVSCode }) {
            const [depsReady, setDepsReady] = React.useState(!!window.MtlxGraphPreview);
            const [state, setState] = React.useState({ status: 'loading', xml: null, graphName: null });

            useEscapeToClose(onClose, open);

            React.useEffect(() => {
                if (!open || window.MtlxGraphPreview) return undefined;
                let cancelled = false;
                window.mtlxLoadViewDeps('galleryDetail').then(() => { if (!cancelled) setDepsReady(true); });
                return () => { cancelled = true; };
            }, [open]);

            React.useEffect(() => {
                if (!open || !depsReady) return undefined;
                let cancelled = false;
                setState({ status: 'loading', xml: null, graphName: null });
                resolveImplGraphXml(ndName).then((res) => {
                    if (cancelled) return;
                    if (!res.xml) setState({ status: 'error', xml: null, graphName: null });
                    else setState({ status: 'ready', xml: res.xml, graphName: res.graphName });
                }).catch((e) => {
                    if (cancelled) return;
                    mtlxWarn('DocsImplPreviewPanel: failed to resolve implementation graph', e);
                    setState({ status: 'error', xml: null, graphName: null });
                });
                return () => { cancelled = true; };
                // eslint-disable-next-line react-hooks/exhaustive-deps
            }, [open, depsReady, ndName]);

            if (!open) return null;

            // Same handoff contract js/shared/mtlx-ui.jsx's openInGraphEditor
            // uses (window.__mtlxPendingImport + 'mtlx-load-document'), built
            // here directly rather than through that helper so `returnHash`
            // (not part of openInGraphEditor's signature) rides along —
            // js/graph-app.jsx's handleImport/pendingImplRef read it to send
            // Backspace/breadcrumb-up back to this Node Specs page instead
            // of the document root (js/graph-app.jsx goUpScope).
            const openInEditor = () => {
                if (fullscreenElement()) toggleFullscreen();
                const xml = '<?xml version="1.0"?>\n<materialx version="1.39">\n'
                    + '  <' + nodeName + ' name="' + nodeName + '1" type="' + outType + '" nodedef="' + ndName + '" />\n'
                    + '</materialx>';
                const payload = {
                    xml, name: nodeName, files: null, select: nodeName + '1',
                    implOf: ndName, returnHash: returnHash || null,
                };
                window.__mtlxPendingImport = payload;
                window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: payload }));
                window.location.hash = '#!graph';
            };

            return (
                <div className="docs-impl-preview bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
                    <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-gray-700 bg-gray-900/70">
                        <div className="min-w-0 flex flex-col">
                            <span className="text-[11px] text-gray-400 truncate">{lib}<span className="text-gray-600"> / </span>{group}</span>
                            <span className="text-sm font-semibold text-gray-100 truncate">{nodeName} implementation</span>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                            {!inVSCode && (
                                <button
                                    type="button"
                                    onClick={openInEditor}
                                    disabled={state.status !== 'ready'}
                                    title="Open this implementation graph in the Node Graph Editor"
                                    className="inline-flex items-center gap-1 h-6 px-2 rounded-md border border-gray-600/50 bg-gray-900/70 text-[11px] font-medium text-gray-400 hover:bg-gray-700 hover:border-gray-600 hover:text-gray-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                    <MtlxIcon name="external-link" className="w-3.5 h-3.5" />
                                    View in Graph Editor
                                </button>
                            )}
                            <button
                                type="button"
                                onClick={onClose}
                                aria-label="Close implementation preview"
                                title="Close"
                                className="inline-flex items-center justify-center w-6 h-6 rounded-md border border-gray-600/50 bg-gray-900/70 text-gray-400 hover:bg-gray-700 hover:border-gray-600 hover:text-gray-100 transition-colors"
                            >
                                <MtlxIcon name="x" className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    </div>
                    <div className="docs-impl-preview-body relative">
                        {(state.status === 'loading' || !depsReady) && (
                            <div className="h-[22rem] flex items-center justify-center text-gray-400 text-sm animate-pulse">
                                Loading preview
                            </div>
                        )}
                        {state.status === 'error' && depsReady && (
                            <div className="flex items-start gap-2 px-3 py-3 text-sm text-amber-300">
                                <MtlxIcon name="alert-triangle" className="w-4 h-4 shrink-0 mt-px" />
                                Could not resolve this node's implementation graph.
                            </div>
                        )}
                        {state.status === 'ready' && depsReady && (
                            <PreviewErrorBoundary>
                                <window.MtlxGraphPreview
                                    xml={state.xml}
                                    scope={state.graphName}
                                    controls={['zoom']}
                                    autoFocus="fit"
                                    chrome="none"
                                    height={352}
                                />
                            </PreviewErrorBoundary>
                        )}
                    </div>
                </div>
            );
        }

        Object.assign(window, { DocsImplPreviewPanel });
