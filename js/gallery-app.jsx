// js/gallery-app.jsx - the Material Gallery view (hash route "#!gallery"),
// reached from Home's Learn group; browses/searches gallery/manifest.json
// (gitignored, see scripts/build-gallery.mjs). Shell-injected, no imports.

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
// Same idiom, but clickable: the overlay's family/Textured/Procedural
// pills, which apply a filter and need an obvious hover affordance.
const GALLERY_TAG_CLASS_LINK = GALLERY_TAG_CLASS + ' cursor-pointer transition-colors hover:border-blue-500/60 hover:text-gray-100';
const GALLERY_CODE_CLASS = 'font-mono text-[0.9em] text-gray-200 bg-gray-700/50 border border-gray-700 rounded px-1 py-px';
// Filter-chip idiom, shared by the family chips, the tag chips and the
// numbered page pills.
const GALLERY_CHIP_ACTIVE = 'border-blue-500 bg-blue-500/[0.12] text-blue-300';
const GALLERY_CHIP_IDLE = 'border-gray-600 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-gray-100';
// Multi-select AND tag chips shown next to the single-select family chips;
// the manifest's other tags (familyLabel, shader) aren't chip-worthy.
const GALLERY_TAG_FILTERS = [
    { id: 'Textured', label: 'Textured' },
    { id: 'Procedural', label: 'Procedural' },
];

// Page-size options for the grid, persisted across reloads.
const GALLERY_PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
const GALLERY_PAGE_SIZE_KEY = 'mtlx_gallery_page_size';
const GALLERY_PAGE_SIZE_DEFAULT = 20;
// Reads the stored page size, falling back to the default when unset or
// when it no longer matches one of the selectable options.
function readGalleryPageSize() {
    let stored = null;
    try { stored = parseInt(localStorage.getItem(GALLERY_PAGE_SIZE_KEY), 10); } catch (e) { /* best-effort */ }
    return GALLERY_PAGE_SIZE_OPTIONS.indexOf(stored) !== -1 ? stored : GALLERY_PAGE_SIZE_DEFAULT;
}

// Doc cache cap: texture blob maps can be large (the chess set alone is
// ~15MB), so bound the cache instead of letting it grow with every card
// ever opened. Map insertion order doubles as recency once a hit re-inserts.
const GALLERY_DOC_CACHE_MAX = 8;
function galleryCacheGet(cache, key) {
    if (!cache.has(key)) return null;
    const v = cache.get(key);
    cache.delete(key);
    cache.set(key, v); // move to the "most recently used" end
    return v;
}
function galleryCacheSet(cache, key, value) {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > GALLERY_DOC_CACHE_MAX) cache.delete(cache.keys().next().value);
}

// Debounces a fast-changing value (e.g. a search input) by `delay` ms.
function useGalleryDebounced(value, delay) {
    const [debounced, setDebounced] = React.useState(value);
    React.useEffect(() => {
        const t = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(t);
    }, [value, delay]);
    return debounced;
}

// Reads q/family/tag/m/page off "#!gallery?..." (builder's hash-param
// pattern); {} when the current hash isn't a gallery route or carries no
// query. Repeated tag= params become patch.tags (unknown ids dropped).
function parseGalleryHash() {
    const hash = window.location.hash || '';
    const qIdx = hash.indexOf('?');
    if (qIdx < 0) return {};
    const params = new URLSearchParams(hash.slice(qIdx + 1));
    const patch = {};
    if (params.has('q')) patch.q = params.get('q');
    if (params.has('family')) patch.family = params.get('family');
    if (params.has('m')) patch.m = params.get('m');
    if (params.has('page')) patch.page = params.get('page');
    const tagList = params.getAll('tag').filter((t) => GALLERY_TAG_FILTERS.some((f) => f.id === t));
    if (tagList.length) patch.tags = tagList;
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

// GitHub blob URL for a manifest entry's source: MaterialX-tagged for
// 'materialx' origin entries (docPath is repo-relative there); our own
// 'playground' entries link into this repo's main branch instead.
function gallerySourceHref(m, tag) {
    if (m.origin === 'materialx') {
        return 'https://github.com/AcademySoftwareFoundation/MaterialX/blob/' + tag + '/' + m.docPath;
    }
    const repo = (window.SITE_LINKS && window.SITE_LINKS.repo) || 'https://github.com/joaovbs96/MaterialXPlayground';
    return repo + '/blob/main/' + m.docPath;
}

// Which page numbers the pagination control shows: page 1, the last page,
// and current-1/current/current+1, with a single missing page shown as a
// number instead of an ellipsis (only a genuine multi-page gap gets one).
function galleryPageList(current, total) {
    const keep = new Set([1, total, current - 1, current, current + 1]);
    const pages = Array.from(keep).filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
    const out = [];
    pages.forEach((p, i) => {
        if (i > 0) {
            const gap = p - pages[i - 1];
            if (gap === 2) out.push(p - 1);
            else if (gap > 2) out.push('ellipsis-' + p);
        }
        out.push(p);
    });
    return out;
}

// Zip-safe path for a companion key: drops '.'/'..' segments (a zip entry
// must not carry parent traversal); findFileForRef's basename fallback
// still matches it on reimport (js/mtlx-engine.js, ~903).
function galleryZipEntryPath(key) {
    const segs = key.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..');
    return segs.length ? segs.join('/') : 'file';
}

// Builds <id>.zip: the root doc (as <id>.mtlx - every rootKey we crawl
// already matches that name) plus every companion file, textures and
// xi:include sibling .mtlx docs alike. Level 0: nothing here compresses well.
async function galleryBuildZip(map, rootKey, xml, id) {
    const files = { [id + '.mtlx']: window.fflate.strToU8(xml) };
    const used = new Set(Object.keys(files));
    const companionKeys = Object.keys(map).filter((k) => k !== rootKey);
    const bytesByKey = {};
    await Promise.all(companionKeys.map(async (key) => {
        bytesByKey[key] = new Uint8Array(await map[key].arrayBuffer());
    }));
    companionKeys.forEach((key) => {
        let entryPath = galleryZipEntryPath(key);
        if (used.has(entryPath)) {
            // Collision (two companions collapsed to the same path): keep
            // the zip valid by numbering it, even though that basename no
            // longer matches its ref (an already-rare, defensive fallback).
            const dot = entryPath.lastIndexOf('.');
            const stem = dot > 0 ? entryPath.slice(0, dot) : entryPath;
            const ext = dot > 0 ? entryPath.slice(dot) : '';
            let n = 2;
            while (used.has(stem + '_' + n + ext)) n++;
            entryPath = stem + '_' + n + ext;
        }
        used.add(entryPath);
        files[entryPath] = bytesByKey[key];
    });
    return new Blob([window.fflate.zipSync(files, { level: 0 })], { type: 'application/zip' });
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

// Numbered pagination below the grid: first/last, current +-1, and a
// single missing page shown as a number instead of an ellipsis. Hidden
// entirely when there's only one page.
function GalleryPagination({ page, pageCount, onChange }) {
    if (pageCount <= 1) return null;
    const items = galleryPageList(page, pageCount);
    const navBtn = 'h-8 min-w-[2rem] px-2.5 rounded-full border text-[13px] font-medium transition-colors flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed';
    return (
        <nav aria-label="Gallery pages" className="flex flex-wrap items-center justify-center gap-1.5 pt-2">
            <button
                type="button"
                disabled={page <= 1}
                onClick={() => onChange(page - 1)}
                aria-label="Previous page"
                className={navBtn + ' ' + GALLERY_CHIP_IDLE}
            >
                <MtlxIcon name="arrow-left" className="w-3.5 h-3.5" />
            </button>
            {items.map((p) => typeof p === 'number' ? (
                <button
                    key={p}
                    type="button"
                    aria-current={p === page ? 'page' : undefined}
                    onClick={() => onChange(p)}
                    className={navBtn + ' ' + (p === page ? GALLERY_CHIP_ACTIVE : GALLERY_CHIP_IDLE)}
                >
                    {p}
                </button>
            ) : (
                <span key={p} className="px-1 text-gray-600 select-none">…</span>
            ))}
            <button
                type="button"
                disabled={page >= pageCount}
                onClick={() => onChange(page + 1)}
                aria-label="Next page"
                className={navBtn + ' ' + GALLERY_CHIP_IDLE}
            >
                <MtlxIcon name="arrow-right" className="w-3.5 h-3.5" />
            </button>
        </nav>
    );
}

// Detail overlay: matches DialogFrame's chrome but built by hand for a
// labeled Close pill. Stays MOUNTED after its first open (hidden via a
// CSS class instead) so MtlxGraphPreview's <materialx-viewer> never rebuilds.
function GalleryDetailOverlay({
    material, tag, doc, docStatus, docError, actionBusy, linkCopied,
    onOpenIn, onDownload, onCopyLink, onClose, onFilterFamily, onFilterTag,
}) {
    const isOpen = !!material;
    // Remembers the last-opened material so this keeps rendering while
    // hidden instead of unmounting; `doc` itself never resets to null
    // either, so MtlxGraphPreview keeps the same instance across reopens.
    const shownRef = React.useRef(null);
    if (material) shownRef.current = material;
    const shown = shownRef.current;
    useEscapeToClose(onClose, isOpen);
    if (!shown) return null; // never opened yet this session
    // "Ready" means doc reflects THIS material, not a stale previous one
    // still on display while a new fetch is in flight.
    const ready = docStatus === 'ready' && !!doc && doc.id === shown.id;
    const hasCompanions = ready && Object.keys(doc.map).some((k) => k !== doc.rootKey);
    return (
        // Scrim now stops at the header's bottom edge (--mtlx-header-h)
        // instead of covering it; .mtlx-header's raised z-index (60) keeps
        // it and its dropdowns usable/visible while this popup is open.
        <div
            className={'fixed left-0 right-0 bottom-0 z-50 flex items-center justify-center bg-gray-950/70 p-4' + (isOpen ? '' : ' hidden')}
            style={{ top: 'var(--mtlx-header-h, 0px)' }}
            onMouseDown={isOpen ? onClose : undefined}
            aria-hidden={!isOpen}
        >
            <div
                onMouseDown={(e) => e.stopPropagation()}
                className="w-full max-w-[64rem] max-h-[calc(100vh-var(--mtlx-header-h,0px)-2rem)] bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl overflow-hidden flex flex-col"
            >
                <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2.5 border-b border-gray-700 bg-gray-900/70">
                    <div className="min-w-0">
                        <span className="block text-sm font-semibold text-gray-100 truncate">{shown.name}</span>
                        <div className="flex flex-wrap gap-1.5 mt-1">
                            <button
                                type="button"
                                onClick={() => onFilterFamily(shown.family)}
                                title={'Filter by ' + shown.familyLabel}
                                className={GALLERY_TAG_CLASS_LINK}
                            >
                                {shown.familyLabel}
                            </button>
                            <button
                                type="button"
                                onClick={() => onFilterTag(shown.textured ? 'Textured' : 'Procedural')}
                                title={'Filter by ' + (shown.textured ? 'Textured' : 'Procedural')}
                                className={GALLERY_TAG_CLASS_LINK}
                            >
                                {shown.textured ? 'Textured' : 'Procedural'}
                            </button>
                        </div>
                    </div>
                    <button type="button" onClick={onClose} className={PILL_ACTION}>
                        <MtlxIcon name="x" className="w-3.5 h-3.5" />
                        Close
                    </button>
                </div>
                <div className="overflow-y-auto custom-scrollbar p-4 flex flex-col gap-4">
                    {!doc && docStatus === 'loading' && (
                        <div className="h-[400px] flex items-center justify-center text-gray-400 text-sm animate-pulse">
                            Loading material…
                        </div>
                    )}
                    {!doc && docStatus === 'error' && (
                        <div className="h-[200px] flex flex-col items-center justify-center gap-2 text-center px-4">
                            <MtlxIcon name="alert-triangle" className="w-6 h-6 text-amber-300" />
                            <span className="text-sm text-gray-300">Could not load this material.</span>
                            <span className="text-xs text-gray-500">{docError}</span>
                        </div>
                    )}
                    {doc && (
                        <div className="relative">
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
                            {/* Overlaid on top of the (possibly still-stale)
                                preview above instead of replacing it, so the
                                mounted preview/viewer never unmounts. */}
                            {!ready && docStatus === 'loading' && (
                                <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-900/70 text-gray-300 text-sm rounded-lg">
                                    Loading material…
                                </div>
                            )}
                            {docStatus === 'error' && (
                                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-gray-900/85 text-center px-4 rounded-lg">
                                    <MtlxIcon name="alert-triangle" className="w-6 h-6 text-amber-300" />
                                    <span className="text-sm text-gray-300">Could not load this material.</span>
                                    <span className="text-xs text-gray-500">{docError}</span>
                                </div>
                            )}
                        </div>
                    )}

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3 border-t border-gray-800 pt-3">
                        <GalleryMetaField label="Family" value={shown.familyLabel} />
                        <GalleryMetaField label="Shader" value={shown.shader} />
                        <GalleryMetaField
                            label="Source"
                            value={shown.origin === 'materialx' ? 'MaterialX ' + tag : 'Playground'}
                        />
                        <GalleryMetaField label="Document size" value={galleryHumanBytes(shown.bytes)} />
                        {shown.textured && (
                            <GalleryMetaField
                                label="Textures"
                                value={shown.textureCount + ' (' + galleryHumanBytes(shown.textureBytes) + ')'}
                            />
                        )}
                        <GalleryMetaField label="Renderables" value={shown.renderables.join(', ')} />
                    </div>

                    {shown.note && (
                        <p className="text-xs text-gray-500 border-t border-gray-800 pt-3">{shown.note}</p>
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
                            disabled={!ready || !!actionBusy}
                            onClick={onDownload}
                            className={PILL_ACTION}
                        >
                            <MtlxIcon name="download" className="w-3.5 h-3.5" />
                            {actionBusy === 'download' ? 'Downloading' : (hasCompanions ? 'Download .zip' : 'Download .mtlx')}
                        </button>
                        <button type="button" onClick={onCopyLink} className={PILL_ACTION}>
                            <MtlxIcon name={linkCopied ? 'copy-check' : 'copy'} className="w-3.5 h-3.5" />
                            {linkCopied ? 'Copied' : 'Copy Link'}
                        </button>
                        <a
                            href={gallerySourceHref(shown, tag)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={PILL_ACTION}
                        >
                            <MtlxIcon name="external-link" className="w-3.5 h-3.5" />
                            View Source
                        </a>
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

    // Deep-link state (q/family/tag/m/page), parsed once at mount (this
    // component only mounts once, per the shell's keep-alive contract)
    // and kept in sync by the hashchange listener below.
    const initialHashState = React.useState(parseGalleryHash)[0];
    const [query, setQuery] = React.useState(initialHashState.q || '');
    const [family, setFamily] = React.useState(initialHashState.family || 'all');
    const [tags, setTags] = React.useState(initialHashState.tags || []);
    const [openId, setOpenId] = React.useState(initialHashState.m || null);
    const [pageSize, setPageSize] = React.useState(readGalleryPageSize);
    const [page, setPage] = React.useState(() => {
        const n = parseInt(initialHashState.page, 10);
        return Number.isFinite(n) && n >= 1 ? n : 1;
    });
    const debouncedQuery = useGalleryDebounced(query, 150);

    // Reparses q/family/tag/m/page whenever the hash lands on a gallery route
    // (guarded so navigating away never clobbers this). Sets `page` from
    // the hash directly, so back/forward restores the exact page it left on.
    React.useEffect(() => {
        const onHashChange = () => {
            const hash = window.location.hash || '';
            if (hash !== '#!gallery' && hash.indexOf('#!gallery?') !== 0) return;
            const patch = parseGalleryHash();
            setQuery(patch.q || '');
            setFamily(patch.family || 'all');
            setTags(patch.tags || []);
            setOpenId(patch.m || null);
            const n = parseInt(patch.page, 10);
            setPage(Number.isFinite(n) && n >= 1 ? n : 1);
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
        GALLERY_TAG_FILTERS.forEach((t) => { if (tags.indexOf(t.id) !== -1) params.append('tag', t.id); });
        if (openId) params.set('m', openId);
        if (page > 1) params.set('page', String(page));
        const qs = params.toString();
        const hash = '#!gallery' + (qs ? '?' + qs : '');
        if (window.location.hash !== hash) {
            try { history.replaceState(null, '', hash); } catch (e) { /* best-effort */ }
        }
    }, [debouncedQuery, family, tags, openId, page]);

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
            // AND semantics: every active tag must be present on the material.
            if (tags.length && !tags.every((t) => (m.tags || []).indexOf(t) !== -1)) return false;
            if (!q) return true;
            if (m.name.toLowerCase().indexOf(q) !== -1) return true;
            if (m.familyLabel.toLowerCase().indexOf(q) !== -1) return true;
            return (m.tags || []).some((t) => t.toLowerCase().indexOf(q) !== -1);
        });
    }, [materials, family, tags, debouncedQuery]);

    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    const pagedMaterials = React.useMemo(
        () => filtered.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize),
        [filtered, page, pageSize]
    );

    // Clamps a deep-linked page number once the manifest loads and the
    // real page count is known, so an out-of-range request just lands on
    // the last page instead of showing an empty grid forever.
    React.useEffect(() => {
        if (!materials) return;
        setPage((p) => Math.min(Math.max(p, 1), pageCount));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [materials]);

    const changeFamily = (id) => { setFamily(id); setPage(1); };
    const changeQuery = (v) => { setQuery(v); setPage(1); };
    const toggleTag = (id) => {
        setTags((prev) => prev.indexOf(id) !== -1 ? prev.filter((t) => t !== id) : [...prev, id]);
        setPage(1);
    };
    const clearFilters = () => { setQuery(''); setFamily('all'); setTags([]); setPage(1); };
    // Overlay pill handoff: close the overlay, then layer that label on top
    // of the current filters instead of replacing them.
    const applyFamilyFilter = (id) => { setOpenId(null); setFamily(id); setPage(1); };
    const applyTagFilter = (id) => {
        setOpenId(null);
        setTags((prev) => prev.indexOf(id) !== -1 ? prev : [...prev, id]);
        setPage(1);
    };
    const changePageSize = (v) => {
        setPageSize(v);
        try { localStorage.setItem(GALLERY_PAGE_SIZE_KEY, String(v)); } catch (e) { /* best-effort */ }
        const nextCount = Math.max(1, Math.ceil(filtered.length / v));
        setPage((p) => Math.min(p, nextCount));
    };

    // Scrolls the grid back into view on every page change, skipping the
    // very first (mount/deep-link) value so landing on page 3 never jumps
    // the page before the user has scrolled anywhere.
    const gridRef = React.useRef(null);
    const skipPageScrollRef = React.useRef(true);
    React.useEffect(() => {
        if (skipPageScrollRef.current) { skipPageScrollRef.current = false; return; }
        if (gridRef.current) gridRef.current.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, [page]);

    const isFiltered = family !== 'all' || tags.length > 0 || debouncedQuery.trim() !== '';
    const pageSuffix = pageCount > 1 ? ', page ' + page + ' of ' + pageCount : '';
    const countLabel = !materials ? '' : !isFiltered
        ? materials.length + ' material' + (materials.length === 1 ? '' : 's') + pageSuffix
        : filtered.length + ' match' + (filtered.length === 1 ? '' : 'es')
            + (debouncedQuery.trim() ? ' for "' + debouncedQuery.trim() + '"' : '') + pageSuffix;

    const openMaterial = materials ? materials.find((m) => m.id === openId) || null : null;

    // Fetched document cache (LRU-capped, see galleryCacheGet/Set above);
    // `doc` never resets to null once set, so a stale-but-real document
    // keeps MtlxGraphPreview mounted while a new one loads or the overlay closes.
    const docCacheRef = React.useRef(new Map());
    const [doc, setDoc] = React.useState(null);
    const [docStatus, setDocStatus] = React.useState('idle');
    const [docError, setDocError] = React.useState(null);
    React.useEffect(() => {
        if (!openMaterial) { setDocStatus('idle'); setDocError(null); return undefined; }
        const cached = galleryCacheGet(docCacheRef.current, openMaterial.id);
        let cancelled = false;
        setDocStatus('loading'); setDocError(null);
        (async () => {
            try {
                // The overlay's graph/3D-viewer bundle loads concurrently
                // with the doc fetch (a no-op once loaded - js/shell.jsx
                // memoizes it), gated behind the same 'loading' status.
                const [result] = await Promise.all([
                    cached || (async () => {
                        const { map, rootKey } = await fetchGalleryDoc(openMaterial);
                        const xml = await map[rootKey].text();
                        const textures = window.looseFilesFrom(map);
                        const name = rootKey.replace(/\.mtlx$/i, '');
                        const built = { id: openMaterial.id, xml, textures, name, map, rootKey };
                        galleryCacheSet(docCacheRef.current, openMaterial.id, built);
                        return built;
                    })(),
                    window.mtlxLoadViewDeps('galleryDetail'),
                ]);
                if (cancelled) return;
                setDoc(result);
                setDocStatus('ready');
            } catch (e) {
                if (!cancelled) { setDocStatus('error'); setDocError(window.errMsg(e)); }
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openMaterial && openMaterial.id]);

    const [actionBusy, setActionBusy] = React.useState(null);
    const openIn = async (target) => {
        if (actionBusy || !doc || !openMaterial || doc.id !== openMaterial.id) return;
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
    const downloadDoc = async () => {
        if (actionBusy || !doc || !openMaterial || doc.id !== openMaterial.id) return;
        const hasCompanions = Object.keys(doc.map).some((k) => k !== doc.rootKey);
        if (!hasCompanions) {
            window.downloadXml(doc.xml, openMaterial.id + '.mtlx');
            return;
        }
        setActionBusy('download');
        try {
            const blob = await galleryBuildZip(doc.map, doc.rootKey, doc.xml, openMaterial.id);
            window.downloadBlob(blob, openMaterial.id + '.zip');
        } catch (e) {
            console.error('[gallery] zip download failed', e);
        } finally {
            setActionBusy(null);
        }
    };

    // Permalink copy: navigator.clipboard first, falling back to
    // execCommand (window.copyTextToClipboard, js/shared/mtlx-ui.jsx);
    // label swaps to "Copied" for ~1.5s (builder-app.jsx's copySnippet idiom).
    const [linkCopied, setLinkCopied] = React.useState(false);
    const linkCopiedTimerRef = React.useRef(null);
    React.useEffect(() => () => clearTimeout(linkCopiedTimerRef.current), []);
    React.useEffect(() => { setLinkCopied(false); }, [openId]);
    const copyLink = async () => {
        if (!openMaterial) return;
        const url = window.location.origin + window.location.pathname + '#!gallery?m=' + encodeURIComponent(openMaterial.id);
        const copy = window.copyTextToClipboard;
        const ok = copy ? await copy(url) : false;
        if (!ok) return;
        setLinkCopied(true);
        clearTimeout(linkCopiedTimerRef.current);
        linkCopiedTimerRef.current = setTimeout(() => setLinkCopied(false), 1500);
    };

    // Grid extent resolved against the shell's view wrapper (HeroGrid's own
    // contract). No naturally tall block to fade across here, so this is an
    // invisible extent sized to fade across roughly card row 1 instead.
    const rootRef = React.useRef(null);
    const fadeRef = React.useRef(null);

    return (
        <div ref={rootRef} className="relative">
            <HeroGrid rootRef={rootRef} fadeRef={fadeRef} fadeFrom="middle" />
            <div ref={fadeRef} aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-[528px]" />
            <div className="relative max-w-7xl mx-auto px-2 sm:px-0 py-8 sm:py-14 space-y-6">
                {/* Breadcrumb */}
                <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-gray-500">
                    <a href="#!home" className="hover:text-gray-300 transition-colors">Home</a>
                    <MtlxIcon name="chevron-right" className="w-3 h-3" />
                    <span>Learn</span>
                    <MtlxIcon name="chevron-right" className="w-3 h-3" />
                    <span className="text-gray-400">Material Gallery</span>
                </nav>

                <div className="space-y-2">
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
                                onChange={(e) => changeQuery(e.target.value)}
                                placeholder="Search materials…"
                                aria-label="Search materials"
                                className="w-full sm:max-w-xs h-9 px-3 rounded-lg border border-gray-700 bg-gray-900 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
                            />
                            <div className="flex flex-wrap items-center gap-2">
                                {chips.map((c) => {
                                    const isActive = family === c.id;
                                    return (
                                        <button
                                            key={c.id}
                                            type="button"
                                            aria-pressed={isActive}
                                            onClick={() => changeFamily(c.id)}
                                            className={'h-8 px-3.5 rounded-full border text-[13px] font-medium transition-colors '
                                                + (isActive ? GALLERY_CHIP_ACTIVE : GALLERY_CHIP_IDLE)}
                                        >
                                            {c.label}
                                        </button>
                                    );
                                })}
                                {/* Subtle divider: reads as a related but distinct
                                    filter group from the single-select family chips. */}
                                <span className="w-px h-5 bg-gray-700" aria-hidden="true" />
                                {GALLERY_TAG_FILTERS.map((t) => {
                                    const isActive = tags.indexOf(t.id) !== -1;
                                    return (
                                        <button
                                            key={t.id}
                                            type="button"
                                            aria-pressed={isActive}
                                            onClick={() => toggleTag(t.id)}
                                            className={'h-8 px-3.5 rounded-full border text-[13px] font-medium transition-colors '
                                                + (isActive ? GALLERY_CHIP_ACTIVE : GALLERY_CHIP_IDLE)}
                                        >
                                            {t.label}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>

                        <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2 text-xs text-gray-500">
                                <span>{countLabel}</span>
                                {isFiltered && (
                                    <button
                                        type="button"
                                        onClick={clearFilters}
                                        className="text-blue-400 hover:text-blue-300 transition-colors"
                                    >
                                        Clear filters
                                    </button>
                                )}
                            </div>
                            <div className="flex items-center gap-1.5 text-xs text-gray-500 shrink-0">
                                <span>Per page</span>
                                <MtlxSelect
                                    value={pageSize}
                                    options={GALLERY_PAGE_SIZE_OPTIONS}
                                    defValue={GALLERY_PAGE_SIZE_DEFAULT}
                                    onChange={changePageSize}
                                    ariaLabel="Materials per page"
                                    size="sm"
                                    variant="field"
                                />
                            </div>
                        </div>

                        {filtered.length === 0 ? (
                            <div className="flex items-center justify-center py-16 text-sm text-gray-500 text-center">
                                No materials match these filters.
                            </div>
                        ) : (
                            <>
                                <div ref={gridRef} className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-4">
                                    {pagedMaterials.map((m) => <GalleryCard key={m.id} m={m} onOpen={setOpenId} />)}
                                </div>
                                <GalleryPagination page={page} pageCount={pageCount} onChange={setPage} />
                            </>
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
                    linkCopied={linkCopied}
                    onOpenIn={openIn}
                    onDownload={downloadDoc}
                    onCopyLink={copyLink}
                    onClose={() => setOpenId(null)}
                    onFilterFamily={applyFamilyFilter}
                    onFilterTag={applyTagFilter}
                />
            </div>
        </div>
    );
}

window.MtlxGalleryApp = MtlxGalleryApp;
