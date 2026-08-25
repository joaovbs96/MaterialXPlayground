// js/gallery-app.jsx - the Material Gallery view (hash route "#!gallery"),
// reached from the home Learn group. Browse, search and preview every
// example material shipped in the MaterialX repo plus a few playground
// showcase materials, generated into gallery/manifest.json (gitignored,
// see scripts/build-gallery.mjs and docs/local/GALLERY.md). Classic JSX
// like the other view apps, no imports - the shell Babel-transforms it
// on first activation and keeps it mounted (keep-alive shell).

// Chip order and display labels for the family filter; only families
// actually present in the manifest are shown, in this fixed order.
const GALLERY_FAMILY_ORDER = [
    { id: 'StandardSurface', label: 'Standard Surface' },
    { id: 'OpenPbr', label: 'OpenPBR' },
    { id: 'GltfPbr', label: 'glTF PBR' },
    { id: 'UsdPreviewSurface', label: 'USD Preview Surface' },
    { id: 'DisneyPrincipled', label: 'Disney Principled' },
    { id: 'SimpleHair', label: 'Simple Hair' },
    { id: 'Playground', label: 'Playground' },
];
// Repo-relative prefix every `origin: 'materialx'` docPath starts with;
// stripped so the remainder can be handed to fetchPresetFiles the same
// way MTLX_PRESETS paths are (relative to resources/Materials/Examples/).
const GALLERY_EXAMPLES_PREFIX = 'resources/Materials/Examples/';
// Gray "micro pill" tag idiom, copied from vscode-app.jsx's TAG_PILL_CLASS.
const GALLERY_TAG_CLASS = 'text-[10px] font-medium uppercase tracking-wide px-[7px] py-px rounded-full border border-gray-600 text-gray-400';
const GALLERY_CODE_CLASS = 'font-mono text-[0.9em] text-gray-200 bg-gray-700/50 border border-gray-700 rounded px-1 py-px';

// Debounces a fast-changing value (e.g. a search input) by `delay` ms.
function useGalleryDebounced(value, delay) {
    const [debounced, setDebounced] = React.useState(value);
    React.useEffect(() => {
        const t = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(t);
    }, [value, delay]);
    return debounced;
}

// Reads q/family/m off "#!gallery?..." (builder's hash-param pattern);
// {} when the current hash isn't a gallery route or carries no query.
function parseGalleryHash() {
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    if (qIdx < 0) return {};
    const params = new URLSearchParams(hash.slice(qIdx + 1));
    const patch = {};
    if (params.has('q')) patch.q = params.get('q');
    if (params.has('family')) patch.family = params.get('family');
    if (params.has('m')) patch.m = params.get('m');
    return patch;
}

// docPath resolution differs by origin: a materialx example is repo-relative,
// crawled the same way MTLX_PRESETS entries are; a playground entry is
// site-relative, crawled as same-origin (its textures can live outside examples/).
function fetchGalleryDoc(m) {
    if (m.origin === 'materialx') {
        const relPath = m.docPath.indexOf(GALLERY_EXAMPLES_PREFIX) === 0
            ? m.docPath.slice(GALLERY_EXAMPLES_PREFIX.length)
            : m.docPath;
        return window.fetchPresetFiles({ path: relPath });
    }
    return window.fetchRemoteDocumentFiles(m.docPath);
}

// Human-readable byte size, one decimal place below 10 of a unit.
function galleryHumanBytes(n) {
    if (!(n > 0)) return '0 B';
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB'];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + ' ' + units[i];
}

// Friendly card shown when gallery/manifest.json 404s: a fresh clone or a
// VS Code checkout that never ran the generator, not an error to alarm over.
function GalleryEmptyState() {
    return (
        <div className="flex flex-col items-center justify-center gap-3 text-center py-20 px-4 bg-gray-800 border border-gray-800 rounded-xl">
            <MtlxIcon name="alert-triangle" className="w-8 h-8 text-amber-300" />
            <h2 className="text-lg font-semibold text-gray-100">Gallery data not generated</h2>
            <p className="text-sm text-gray-400 max-w-md">
                The manifest and thumbnails behind this gallery are produced at deploy time, and locally
                by running <code className={GALLERY_CODE_CLASS}>npm run gallery:data</code>. Run that,
                then reload this page.
            </p>
        </div>
    );
}

// One-line metadata field (label + value), the gray micro-label idiom
// from what-is-materialx.jsx's "By the numbers" strip.
function GalleryMetaField({ label, value }) {
    return (
        <div className="min-w-0 flex flex-col gap-0.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-gray-500">{label}</span>
            <span className="text-sm text-gray-200 break-words">{value}</span>
        </div>
    );
}

// One grid card: square lazy thumb (falling back to a gradient initial
// tile on a missing/broken image), name, and two tag chips. No live 3D
// viewer here, ever - the grid can hold ~53 cards, well past the embed LRU.
function GalleryCard({ m, onOpen }) {
    const [imgFailed, setImgFailed] = React.useState(false);
    const showPlaceholder = imgFailed || !m.thumb;
    return (
        <button
            type="button"
            onClick={() => onOpen(m.id)}
            title={m.name}
            className="group flex flex-col text-left bg-gray-800 border border-gray-800 rounded-xl overflow-hidden transition-colors hover:border-blue-500/50 hover:bg-gray-800/80"
        >
            {showPlaceholder ? (
                <div
                    className="w-full aspect-square border-b border-gray-700 flex items-center justify-center text-2xl font-semibold text-blue-300/70"
                    style={{ backgroundImage: 'linear-gradient(135deg, rgba(59,130,246,0.18), rgba(59,130,246,0.04))' }}
                >
                    {(m.name || '?').charAt(0).toUpperCase()}
                </div>
            ) : (
                <img
                    src={'gallery/' + m.thumb}
                    alt=""
                    loading="lazy"
                    width={512}
                    height={512}
                    onError={() => setImgFailed(true)}
                    className="w-full aspect-square object-cover border-b border-gray-700"
                />
            )}
            <div className="flex flex-col gap-1.5 p-3">
                <span className="text-sm font-medium text-gray-100 truncate">{m.name}</span>
                <div className="flex flex-wrap gap-1.5">
                    <span className={GALLERY_TAG_CLASS}>{m.familyLabel}</span>
                    <span className={GALLERY_TAG_CLASS}>{m.textured ? 'Textured' : 'Procedural'}</span>
                </div>
            </div>
        </button>
    );
}

// Detail overlay: matches DialogFrame's own chrome but is built by hand so
// Close can be a labeled PILL_ACTION, not DialogFrame's bare "x" button.
// Esc and a scrim click both close it (see useEscapeToClose).
function GalleryDetailOverlay({ material, tag, doc, docStatus, docError, actionBusy, onOpenIn, onDownload, onClose }) {
    useEscapeToClose(onClose, !!material);
    if (!material) return null;
    const ready = docStatus === 'ready' && !!doc;
    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-gray-950/70 p-4"
            onMouseDown={onClose}
        >
            <div
                onMouseDown={(e) => e.stopPropagation()}
                className="w-full max-w-[64rem] max-h-[calc(100vh-2rem)] bg-gray-800 border border-gray-700 rounded-xl shadow-2xl overflow-hidden flex flex-col"
            >
                <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-700 bg-gray-900/70">
                    <div className="min-w-0">
                        <span className="block text-sm font-semibold text-gray-100 truncate">{material.name}</span>
                        <span className="block text-[11px] text-gray-500">{material.familyLabel}</span>
                    </div>
                    <button type="button" onClick={onClose} className={PILL_ACTION}>
                        <MtlxIcon name="x" className="w-3.5 h-3.5" />
                        Close
                    </button>
                </div>
                <div className="overflow-y-auto custom-scrollbar p-4 flex flex-col gap-4">
                    {docStatus === 'loading' && (
                        <div className="h-[400px] flex items-center justify-center text-gray-400 text-sm animate-pulse">
                            Loading material…
                        </div>
                    )}
                    {docStatus === 'error' && (
                        <div className="h-[200px] flex flex-col items-center justify-center gap-2 text-center px-4">
                            <MtlxIcon name="alert-triangle" className="w-6 h-6 text-amber-300" />
                            <span className="text-sm text-gray-300">Could not load this material.</span>
                            <span className="text-xs text-gray-500">{docError}</span>
                        </div>
                    )}
                    {ready && (
                        <MtlxGraphPreview
                            xml={doc.xml}
                            preview="right"
                            previewTextures={doc.textures}
                            previewName={doc.name}
                            lazy={false}
                            drill={true}
                            interactive={true}
                            controls={['zoom']}
                            autoFocus="fit"
                            chrome="card"
                            transparent={false}
                            height={400}
                        />
                    )}

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3 border-t border-gray-800 pt-3">
                        <GalleryMetaField label="Family" value={material.familyLabel} />
                        <GalleryMetaField label="Shader" value={material.shader} />
                        <GalleryMetaField
                            label="Source"
                            value={material.origin === 'materialx' ? 'MaterialX ' + tag : 'Playground'}
                        />
                        <GalleryMetaField label="Document size" value={galleryHumanBytes(material.bytes)} />
                        {material.textured && (
                            <GalleryMetaField
                                label="Textures"
                                value={material.textureCount + ' (' + galleryHumanBytes(material.textureBytes) + ')'}
                            />
                        )}
                        <GalleryMetaField label="Renderables" value={material.renderables.join(', ')} />
                    </div>

                    {material.note && (
                        <p className="text-xs text-gray-500 border-t border-gray-800 pt-3">{material.note}</p>
                    )}

                    <div className="flex flex-wrap gap-2 border-t border-gray-800 pt-3">
                        <button
                            type="button"
                            disabled={!ready || !!actionBusy}
                            onClick={() => onOpenIn('viewer')}
                            className={PILL_ACTION}
                        >
                            <MtlxIcon name="camera" className="w-3.5 h-3.5" />
                            {actionBusy === 'viewer' ? 'Loading' : 'Open in Viewer'}
                        </button>
                        <button
                            type="button"
                            disabled={!ready || !!actionBusy}
                            onClick={() => onOpenIn('graph')}
                            className={PILL_ACTION}
                        >
                            <MtlxIcon name="share" className="w-3.5 h-3.5" />
                            {actionBusy === 'graph' ? 'Loading' : 'Open in Graph Editor'}
                        </button>
                        <button
                            type="button"
                            disabled={!ready}
                            onClick={onDownload}
                            className={PILL_ACTION}
                        >
                            <MtlxIcon name="download" className="w-3.5 h-3.5" />
                            Download .mtlx
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

function MtlxGalleryApp({ active } = {}) {
    // Manifest: null while loading, 'error' on a 404/failure, else the
    // parsed { version, source, generatedAt, materials } object. Fetched
    // once, guarded by a ref, the first time this view actually activates.
    const fetchedRef = React.useRef(false);
    const [manifest, setManifest] = React.useState(null);
    React.useEffect(() => {
        if (!active || fetchedRef.current) return;
        fetchedRef.current = true;
        fetch('gallery/manifest.json', { cache: 'no-cache' })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
            .then((data) => setManifest(data))
            .catch(() => setManifest('error'));
    }, [active]);

    // Deep-link state (q/family/m), parsed once at mount (this component
    // only ever mounts once, exactly on first activation, per the shell's
    // keep-alive contract) and kept in sync by the hashchange listener below.
    const initialHashState = React.useState(parseGalleryHash)[0];
    const [query, setQuery] = React.useState(initialHashState.q || '');
    const [family, setFamily] = React.useState(initialHashState.family || 'all');
    const [openId, setOpenId] = React.useState(initialHashState.m || null);
    const debouncedQuery = useGalleryDebounced(query, 150);

    // The one document-level listener this view keeps subscribed even while
    // hidden: reparses q/family/m whenever the hash lands on a gallery route
    // (guarded so navigating away, e.g. to #!viewer, never clobbers this).
    React.useEffect(() => {
        const onHashChange = () => {
            const hash = window.location.hash || '';
            if (hash !== '#!gallery' && hash.indexOf('#!gallery?') !== 0) return;
            const patch = parseGalleryHash();
            setQuery(patch.q || '');
            setFamily(patch.family || 'all');
            setOpenId(patch.m || null);
        };
        window.addEventListener('hashchange', onHashChange);
        return () => window.removeEventListener('hashchange', onHashChange);
    }, []);

    // Mirrors state back into the hash via replaceState (builder's pattern,
    // js/builder-app.jsx:1207-1212) so the router never re-triggers.
    React.useEffect(() => {
        const params = new URLSearchParams();
        if (debouncedQuery.trim()) params.set('q', debouncedQuery.trim());
        if (family !== 'all') params.set('family', family);
        if (openId) params.set('m', openId);
        const qs = params.toString();
        const hash = '#!gallery' + (qs ? '?' + qs : '');
        if (window.location.hash !== hash) {
            try { history.replaceState(null, '', hash); } catch (e) { /* best-effort */ }
        }
    }, [debouncedQuery, family, openId]);

    const materials = manifest && manifest.materials ? manifest.materials : null;
    const tag = (manifest && manifest.source && manifest.source.tag)
        || (window.MtlxAssets ? window.MtlxAssets.MTLX_TAG : 'v1.39.5');

    const chips = React.useMemo(() => {
        if (!materials) return [{ id: 'all', label: 'All' }];
        const present = new Set(materials.map((m) => m.family));
        return [{ id: 'all', label: 'All' }, ...GALLERY_FAMILY_ORDER.filter((f) => present.has(f.id))];
    }, [materials]);

    const filtered = React.useMemo(() => {
        if (!materials) return [];
        const q = debouncedQuery.trim().toLowerCase();
        return materials.filter((m) => {
            if (family !== 'all' && m.family !== family) return false;
            if (!q) return true;
            if (m.name.toLowerCase().indexOf(q) !== -1) return true;
            if (m.familyLabel.toLowerCase().indexOf(q) !== -1) return true;
            return (m.tags || []).some((t) => t.toLowerCase().indexOf(q) !== -1);
        });
    }, [materials, family, debouncedQuery]);

    const isFiltered = family !== 'all' || debouncedQuery.trim() !== '';
    const countLabel = !materials ? '' : !isFiltered
        ? materials.length + ' material' + (materials.length === 1 ? '' : 's')
        : filtered.length + ' match' + (filtered.length === 1 ? '' : 'es')
            + (debouncedQuery.trim() ? ' for "' + debouncedQuery.trim() + '"' : '');

    const openMaterial = materials ? materials.find((m) => m.id === openId) || null : null;

    // Fetched document cache, keyed by material id, so reopening the same
    // card's overlay is instant. `doc` is { xml, textures, name } for
    // whichever material is currently open.
    const docCacheRef = React.useRef(new Map());
    const [doc, setDoc] = React.useState(null);
    const [docStatus, setDocStatus] = React.useState('idle');
    const [docError, setDocError] = React.useState(null);
    React.useEffect(() => {
        if (!openMaterial) { setDoc(null); setDocStatus('idle'); setDocError(null); return undefined; }
        const cached = docCacheRef.current.get(openMaterial.id);
        if (cached) { setDoc(cached); setDocStatus('ready'); setDocError(null); return undefined; }
        let cancelled = false;
        setDocStatus('loading'); setDoc(null); setDocError(null);
        (async () => {
            try {
                const { map, rootKey } = await fetchGalleryDoc(openMaterial);
                const xml = await map[rootKey].text();
                const textures = window.looseFilesFrom(map);
                const name = rootKey.replace(/\.mtlx$/i, '');
                const result = { xml, textures, name };
                docCacheRef.current.set(openMaterial.id, result);
                if (!cancelled) { setDoc(result); setDocStatus('ready'); }
            } catch (e) {
                if (!cancelled) { setDocStatus('error'); setDocError(window.errMsg(e)); }
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openMaterial && openMaterial.id]);

    const [actionBusy, setActionBusy] = React.useState(null);
    const openIn = async (target) => {
        if (actionBusy || !doc) return;
        setActionBusy(target);
        try {
            await window.mtlxLoadViewDeps(target);
            (target === 'viewer' ? window.openInViewer : window.openInGraphEditor)(
                { xml: doc.xml, name: doc.name, files: doc.textures }
            );
        } catch (e) {
            console.error('[gallery] hand-off failed', e);
        } finally {
            setActionBusy(null);
        }
    };
    const downloadDoc = () => {
        if (!doc || !openMaterial) return;
        window.downloadXml(doc.xml, openMaterial.id + '.mtlx');
    };

    // Grid extent resolved against the shell's view wrapper (HeroGrid's own
    // contract). No naturally tall block to fade across here, so this is an
    // invisible extent sized to fade across roughly card row 1 instead.
    const rootRef = React.useRef(null);
    const fadeRef = React.useRef(null);

    return (
        <div ref={rootRef} className="relative">
            <HeroGrid rootRef={rootRef} fadeRef={fadeRef} fadeFrom="middle" />
            <div ref={fadeRef} aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[640px]" />
            <div className="relative space-y-6">
                <div className="space-y-2">
                    <div className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-blue-300">
                        Learn <span className="text-gray-600">/</span> <span className="text-gray-400">Material Gallery</span>
                    </div>
                    <h1 className="text-[28px] sm:text-[34px] leading-[1.15] font-bold tracking-[-0.01em] text-gray-100 text-balance">
                        Material Gallery
                    </h1>
                    <p className="text-gray-400 text-sm sm:text-base max-w-[60em]">
                        Every example material shipped in the MaterialX project repo ({tag}), plus a few playground
                        materials of our own, ready to search, preview and reopen in the Viewer or Graph Editor.
                    </p>
                </div>

                {manifest === 'error' && <GalleryEmptyState />}
                {manifest === null && (
                    <div className="flex items-center justify-center h-40 text-gray-400 text-sm animate-pulse">Loading gallery…</div>
                )}

                {materials && (
                    <>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <input
                                type="text"
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Search materials…"
                                aria-label="Search materials"
                                className="w-full sm:max-w-xs h-9 px-3 rounded-lg border border-gray-600 bg-gray-800 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                            />
                            <div className="flex flex-wrap gap-2">
                                {chips.map((c) => {
                                    const isActive = family === c.id;
                                    return (
                                        <button
                                            key={c.id}
                                            type="button"
                                            aria-pressed={isActive}
                                            onClick={() => setFamily(c.id)}
                                            className={'h-8 px-3.5 rounded-full border text-[13px] font-medium transition-colors '
                                                + (isActive
                                                    ? 'border-blue-500 bg-blue-500/[0.12] text-blue-300'
                                                    : 'border-gray-600 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-gray-100')}
                                        >
                                            {c.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        <p className="text-xs text-gray-500">{countLabel}</p>

                        {filtered.length === 0 ? (
                            <div className="flex items-center justify-center py-16 text-sm text-gray-500 text-center">
                                No materials match this search.
                            </div>
                        ) : (
                            <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-4">
                                {filtered.map((m) => <GalleryCard key={m.id} m={m} onOpen={setOpenId} />)}
                            </div>
                        )}
                    </>
                )}

                <GalleryDetailOverlay
                    material={openMaterial}
                    tag={tag}
                    doc={doc}
                    docStatus={docStatus}
                    docError={docError}
                    actionBusy={actionBusy}
                    onOpenIn={openIn}
                    onDownload={downloadDoc}
                    onClose={() => setOpenId(null)}
                />
            </div>
        </div>
    );
}

window.MtlxGalleryApp = MtlxGalleryApp;
