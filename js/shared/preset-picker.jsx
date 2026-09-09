// js/shared/preset-picker.jsx - unified preset picker (MtlxPresetPicker),
// the single dialog used by the Viewer, Compare and Graph Editor to pick a
// starting material. Backed by gallery/manifest.json (the Material
// Gallery's 53-entry set), falling back to MTLX_PRESETS (js/shared/
// mtlx-ui.jsx) when the manifest is unavailable (a fresh clone or a
// VS Code checkout that never ran `npm run gallery:data`). No top-level
// import/export, self-registers via Object.assign(window, {}) at the
// bottom. Needs mtlx-ui.jsx and the graph-preview stack loaded first.

// Family chip order/labels, the Material Gallery's own display order.
// MTLX_PRESETS fallback entries only ever land in StandardSurface/
// OpenPbr/Playground, a subset of this list, so one table covers both.
const PRESET_PICKER_FAMILY_ORDER = [
    { id: 'StandardSurface', label: 'Standard Surface' },
    { id: 'OpenPbr', label: 'OpenPBR' },
    { id: 'GltfPbr', label: 'glTF PBR' },
    { id: 'UsdPreviewSurface', label: 'USD Preview Surface' },
    { id: 'DisneyPrincipled', label: 'Disney Principled' },
    { id: 'SimpleHair', label: 'Simple Hair' },
    { id: 'Playground', label: 'Playground' },
];
const PRESET_PICKER_TAG_FILTERS = [
    { id: 'Textured', label: 'Textured' },
    { id: 'Procedural', label: 'Procedural' },
];

// Small pill idioms, sized well below the Material Gallery's own chips so
// two rows of them fit under the search bar in a narrow left column.
const PRESET_PICKER_CHIP_ACTIVE = 'border-blue-500 bg-blue-500/[0.12] text-blue-300';
const PRESET_PICKER_CHIP_IDLE = 'border-gray-600 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-gray-100';
const PRESET_PICKER_CHIP_BASE = 'h-6 px-2 rounded-full border text-[11px] font-medium transition-colors whitespace-nowrap';
const PRESET_PICKER_TAG_CLASS = 'text-[9px] font-medium uppercase tracking-wide px-[6px] py-px rounded-full border border-gray-600 text-gray-400';

// Doc cache cap, same LRU idiom as gallery-app.jsx's GALLERY_DOC_CACHE_MAX
// (duplicated here rather than shared: this file has no imports).
const PRESET_PICKER_DOC_CACHE_MAX = 8;
function presetPickerCacheGet(cache, key) {
    if (!cache.has(key)) return null;
    const v = cache.get(key);
    cache.delete(key);
    cache.set(key, v);
    return v;
}
function presetPickerCacheSet(cache, key, value) {
    cache.delete(key);
    cache.set(key, value);
    if (cache.size > PRESET_PICKER_DOC_CACHE_MAX) cache.delete(cache.keys().next().value);
}

// Debounces the search input, same idiom as gallery-app.jsx's
// useGalleryDebounced (duplicated locally for the same no-imports reason).
function usePresetPickerDebounced(value, delay) {
    const [debounced, setDebounced] = React.useState(value);
    React.useEffect(() => {
        const t = setTimeout(() => setDebounced(value), delay);
        return () => clearTimeout(t);
    }, [value, delay]);
    return debounced;
}

// Fetches gallery/manifest.json once per page session (module state, so
// every host's picker instance shares it). Resolves to null (never
// rejects): "no manifest" and "fetch failed" both just mean fall back.
let __presetPickerManifestPromise = null;
function loadPresetPickerManifest() {
    if (!__presetPickerManifestPromise) {
        __presetPickerManifestPromise = fetch('gallery/manifest.json', { cache: 'no-cache' })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
            .catch(() => null);
    }
    return __presetPickerManifestPromise;
}

// Maps one MTLX_PRESETS entry (mtlx-ui.jsx, { label, desc, path|src }) into
// the manifest entry shape. `_preset` carries the original object through
// to fetchPresetPickerDoc, straight to window.fetchPresetFiles.
function presetToEntry(preset) {
    const isSrc = !!preset.src;
    const folder = !isSrc && preset.path ? preset.path.split('/')[0] : null;
    const family = isSrc ? 'Playground' : (folder || 'MaterialX');
    const known = PRESET_PICKER_FAMILY_ORDER.find((f) => f.id === family);
    const key = window.presetKey ? window.presetKey(preset) : (preset.src || preset.path);
    return {
        id: 'preset:' + key,
        name: preset.label,
        family,
        familyLabel: known ? known.label : family,
        origin: isSrc ? 'playground' : 'materialx',
        textured: null, // not derivable without fetching the document
        tags: [],
        thumb: null,
        _preset: preset,
    };
}

// Mirrors gallery-app.jsx's fetchGalleryDoc (duplicated, that file stays
// untouched): a materialx-origin entry is repo-relative, crawled like an
// MTLX_PRESETS pick; a playground entry is site-relative, same-origin.
const PRESET_PICKER_EXAMPLES_PREFIX = 'resources/Materials/Examples/';
function fetchPresetPickerDoc(entry) {
    if (entry._preset) return window.fetchPresetFiles(entry._preset);
    if (entry.origin === 'materialx') {
        const relPath = entry.docPath.indexOf(PRESET_PICKER_EXAMPLES_PREFIX) === 0
            ? entry.docPath.slice(PRESET_PICKER_EXAMPLES_PREFIX.length)
            : entry.docPath;
        return window.fetchPresetFiles({ path: relPath });
    }
    return window.fetchRemoteDocumentFiles(entry.docPath);
}

// One row: 48px square thumb (lazy, gradient-initial fallback on a missing
// or broken image), name, tiny tag pills. Highlight is driven entirely by
// the parent (click/arrow keys); this component owns no state of its own.
function PresetPickerRow({ entry, highlighted, onClick, onDoubleClick, setRowEl }) {
    const [imgFailed, setImgFailed] = React.useState(false);
    const showPlaceholder = imgFailed || !entry.thumb;
    return (
        <button
            type="button"
            ref={setRowEl}
            role="option"
            aria-selected={highlighted}
            onClick={onClick}
            onDoubleClick={onDoubleClick}
            title={entry.name}
            className={'w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left transition-colors border '
                + (highlighted ? 'bg-blue-600/20 border-blue-500/60' : 'border-transparent hover:bg-gray-700/50')}
        >
            {showPlaceholder ? (
                <div
                    className="w-12 h-12 shrink-0 rounded flex items-center justify-center text-sm font-semibold text-blue-300/70"
                    style={{ backgroundImage: 'linear-gradient(135deg, rgba(59,130,246,0.18), rgba(59,130,246,0.04))' }}
                >
                    {(entry.name || '?').charAt(0).toUpperCase()}
                </div>
            ) : (
                <img
                    src={'gallery/' + entry.thumb}
                    alt=""
                    loading="lazy"
                    width={48}
                    height={48}
                    onError={() => setImgFailed(true)}
                    className="w-12 h-12 shrink-0 rounded object-cover border border-gray-700"
                />
            )}
            <div className="min-w-0 flex-1">
                <span className="block text-[12px] font-medium text-gray-100 truncate">{entry.name}</span>
                <div className="flex flex-wrap gap-1 mt-1">
                    <span className={PRESET_PICKER_TAG_CLASS}>{entry.familyLabel}</span>
                    {entry.textured !== null && (
                        <span className={PRESET_PICKER_TAG_CLASS}>{entry.textured ? 'Textured' : 'Procedural'}</span>
                    )}
                </div>
            </div>
        </button>
    );
}

// The unified preset picker. onSelect receives { xml, name, files, entry }
// (files = the loose non-.mtlx companion map; entry = the picked manifest/
// fallback entry itself, additive so a caller like the builder can derive a
// shareable URL for it without touching document content). The host applies
// it and closes. `overlayClassName` forwards to DialogFrame's own
// `fixed`-overlay escape hatch.
function MtlxPresetPicker({ open, onClose, onSelect, title, overlayClassName }) {
    // ---- Data: manifest.materials, or the MTLX_PRESETS fallback -----
    const [mode, setMode] = React.useState('loading'); // 'loading' | 'manifest' | 'fallback'
    const [entries, setEntries] = React.useState([]);
    const fetchedRef = React.useRef(false);
    React.useEffect(() => {
        if (!open || fetchedRef.current) return;
        fetchedRef.current = true;
        loadPresetPickerManifest().then((data) => {
            if (data && Array.isArray(data.materials) && data.materials.length) {
                setEntries(data.materials);
                setMode('manifest');
            } else {
                setEntries((window.MTLX_PRESETS || []).map(presetToEntry));
                setMode('fallback');
            }
        });
    }, [open]);

    // ---- Search + chip filters --------------------------------------
    const [query, setQuery] = React.useState('');
    const debouncedQuery = usePresetPickerDebounced(query, 150);
    const [family, setFamily] = React.useState('all');
    const [tags, setTags] = React.useState([]);
    // Fresh filter state each time the dialog (re)opens, so a closed-then-
    // reopened picker doesn't carry a stale search from a previous host.
    const wasOpenRef = React.useRef(false);
    React.useEffect(() => {
        if (open && !wasOpenRef.current) { setQuery(''); setFamily('all'); setTags([]); }
        wasOpenRef.current = open;
    }, [open]);

    const families = React.useMemo(() => {
        const present = new Set(entries.map((e) => e.family));
        return PRESET_PICKER_FAMILY_ORDER.filter((f) => present.has(f.id));
    }, [entries]);

    const filtered = React.useMemo(() => {
        const q = debouncedQuery.trim().toLowerCase();
        return entries.filter((e) => {
            if (family !== 'all' && e.family !== family) return false;
            if (tags.length && !tags.every((t) => (e.tags || []).indexOf(t) !== -1)) return false;
            if (!q) return true;
            if (e.name.toLowerCase().indexOf(q) !== -1) return true;
            if ((e.familyLabel || '').toLowerCase().indexOf(q) !== -1) return true;
            return (e.tags || []).some((t) => t.toLowerCase().indexOf(q) !== -1);
        });
    }, [entries, family, tags, debouncedQuery]);

    const toggleTag = (id) => setTags((prev) => prev.indexOf(id) !== -1 ? prev.filter((t) => t !== id) : [...prev, id]);

    // ---- Highlight (keyboard + click), scrolled into view -----------
    const [highlightId, setHighlightId] = React.useState(null);
    React.useEffect(() => {
        if (!filtered.length) { setHighlightId(null); return; }
        if (!filtered.some((e) => e.id === highlightId)) setHighlightId(filtered[0].id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filtered]);
    const highlightedEntry = filtered.find((e) => e.id === highlightId) || null;

    const rowElsRef = React.useRef({});
    React.useEffect(() => {
        const el = highlightId && rowElsRef.current[highlightId];
        if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    }, [highlightId]);

    // ---- Doc for the highlighted entry: LRU cache + stale-token guard,
    // same recipe as GalleryDetailOverlay. `doc` is sticky (never null
    // again) so MtlxGraphPreview keeps showing the last-good doc while a new one loads.
    const docCacheRef = React.useRef(new Map());
    const [doc, setDoc] = React.useState(null);
    const [docStatus, setDocStatus] = React.useState('idle');
    React.useEffect(() => {
        if (!open || !highlightedEntry) return undefined;
        const cached = presetPickerCacheGet(docCacheRef.current, highlightedEntry.id);
        let cancelled = false;
        setDocStatus('loading');
        (async () => {
            try {
                const result = cached || await (async () => {
                    const { map, rootKey } = await fetchPresetPickerDoc(highlightedEntry);
                    const xml = await map[rootKey].text();
                    const textures = window.looseFilesFrom(map);
                    const name = rootKey.replace(/\.mtlx$/i, '');
                    const built = { id: highlightedEntry.id, xml, textures, name };
                    presetPickerCacheSet(docCacheRef.current, highlightedEntry.id, built);
                    return built;
                })();
                if (cancelled) return;
                setDoc(result);
                setDocStatus('ready');
            } catch (e) {
                if (!cancelled) setDocStatus('error');
            }
        })();
        return () => { cancelled = true; };
    }, [open, highlightedEntry && highlightedEntry.id]);

    const ready = docStatus === 'ready' && !!doc && !!highlightedEntry && doc.id === highlightedEntry.id;

    const confirmHighlighted = () => {
        if (!ready) return;
        onSelect({ xml: doc.xml, name: doc.name, files: doc.textures, entry: highlightedEntry });
    };
    // Double-click highlights AND confirms. If already ready, confirm now
    // (an effect keyed on `ready` would never re-fire for an unchanged
    // value); otherwise stash the id and let the effect below confirm it.
    const pendingConfirmIdRef = React.useRef(null);
    const handleRowDoubleClick = (entry) => {
        setHighlightId(entry.id);
        if (docStatus === 'ready' && doc && doc.id === entry.id) {
            onSelect({ xml: doc.xml, name: doc.name, files: doc.textures, entry });
        } else {
            pendingConfirmIdRef.current = entry.id;
        }
    };
    React.useEffect(() => {
        if (ready && pendingConfirmIdRef.current === doc.id) {
            pendingConfirmIdRef.current = null;
            onSelect({ xml: doc.xml, name: doc.name, files: doc.textures, entry: highlightedEntry });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ready]);

    // ---- Preview column height: MtlxGraphPreview needs a literal px
    // number, so measure the column's real height instead of guessing.
    // Deps=[open]: the picker stays mounted, so the ref is null pre-open.
    const previewColRef = React.useRef(null);
    const [previewHeight, setPreviewHeight] = React.useState(420);
    React.useEffect(() => {
        const el = previewColRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver((entries) => {
            const h = (entries[0] && entries[0].contentRect) ? entries[0].contentRect.height : el.clientHeight;
            if (h > 0) setPreviewHeight(Math.round(h));
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, [open]);

    // ---- Keyboard: ArrowUp/Down move the highlight, Enter confirms,
    // Esc cancels (bubbles to useEscapeToClose below). Same idiom as
    // js/graph-app.jsx's PortPickerPopover.
    const onKeyDown = (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            const idx = filtered.findIndex((x) => x.id === highlightId);
            const next = filtered[Math.min(idx + 1, filtered.length - 1)];
            if (next) setHighlightId(next.id);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            const idx = filtered.findIndex((x) => x.id === highlightId);
            const next = filtered[Math.max(idx - 1, 0)];
            if (next) setHighlightId(next.id);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            confirmHighlighted();
        }
    };

    useEscapeToClose(onClose, open);
    if (!open) return null;

    // VS Code webview: bound to one opened file today, so no current call
    // site ever opens this there - but if one someday does, skip the 3D
    // pane rather than trust an untested iframe inside the webview.
    const inVsCode = !!window.__MTLX_VSCODE__;

    return (
        <DialogFrame
            open={open}
            title={title || 'Presets'}
            onClose={onClose}
            overlayClassName={overlayClassName}
            // Also subtracts --mtlx-header-h, matching the fixed-overlay
            // callers' own header carve-out, so this panel never grows as
            // tall as the header band when a caller passes that overlay.
            panelClassName="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl w-full max-w-[70rem] max-h-[calc(100vh-var(--mtlx-header-h,0px)-4rem)] overflow-hidden flex flex-col"
        >
            <div className="flex h-[440px]">
                <div
                    className="w-72 sm:w-[22rem] shrink-0 border-r border-gray-700 flex flex-col h-full"
                    onKeyDown={onKeyDown}
                >
                    <div className="p-2.5 space-y-2 shrink-0 border-b border-gray-700/60">
                        <input
                            type="text"
                            autoFocus
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search materials..."
                            aria-label="Search materials"
                            className={TEXT_INPUT_CLS}
                        />
                        <div className="flex flex-wrap gap-1">
                            {families.map((f) => (
                                <button
                                    key={f.id}
                                    type="button"
                                    aria-pressed={family === f.id}
                                    onClick={() => setFamily(family === f.id ? 'all' : f.id)}
                                    className={PRESET_PICKER_CHIP_BASE + ' ' + (family === f.id ? PRESET_PICKER_CHIP_ACTIVE : PRESET_PICKER_CHIP_IDLE)}
                                >
                                    {f.label}
                                </button>
                            ))}
                            {mode === 'manifest' && families.length > 0 && (
                                <span className="w-px h-4 bg-gray-700 self-center" aria-hidden="true" />
                            )}
                            {mode === 'manifest' && PRESET_PICKER_TAG_FILTERS.map((t) => (
                                <button
                                    key={t.id}
                                    type="button"
                                    aria-pressed={tags.indexOf(t.id) !== -1}
                                    onClick={() => toggleTag(t.id)}
                                    className={PRESET_PICKER_CHIP_BASE + ' ' + (tags.indexOf(t.id) !== -1 ? PRESET_PICKER_CHIP_ACTIVE : PRESET_PICKER_CHIP_IDLE)}
                                >
                                    {t.label}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div role="listbox" aria-label="Materials" className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-1.5 space-y-0.5">
                        {mode === 'loading' && (
                            <div className="flex items-center justify-center h-full text-gray-500 text-[12px] animate-pulse">Loading...</div>
                        )}
                        {mode !== 'loading' && filtered.length === 0 && (
                            <div className="flex items-center justify-center h-full text-gray-500 text-[12px] text-center px-3">No materials match these filters.</div>
                        )}
                        {filtered.map((entry) => (
                            <PresetPickerRow
                                key={entry.id}
                                entry={entry}
                                highlighted={entry.id === highlightId}
                                onClick={() => setHighlightId(entry.id)}
                                onDoubleClick={() => handleRowDoubleClick(entry)}
                                setRowEl={(el) => { if (el) rowElsRef.current[entry.id] = el; else delete rowElsRef.current[entry.id]; }}
                            />
                        ))}
                    </div>
                </div>
                <div ref={previewColRef} className="flex-1 min-w-0 relative h-full">
                    {!doc ? (
                        <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">
                            {filtered.length ? 'Loading material...' : 'No material to preview.'}
                        </div>
                    ) : (
                        <div className="relative h-full">
                            <MtlxGraphPreview
                                xml={doc.xml}
                                preview={inVsCode ? false : 'right'}
                                previewTextures={doc.textures}
                                previewName={doc.name}
                                lazy={false}
                                interactive={true}
                                controls={['zoom']}
                                autoFocus="fit"
                                chrome="none"
                                transparent={false}
                                height={previewHeight}
                            />
                            {!ready && docStatus === 'loading' && (
                                <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-900/70 text-gray-300 text-sm">
                                    Loading material...
                                </div>
                            )}
                            {docStatus === 'error' && (
                                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-gray-900/85 text-center px-4">
                                    <MtlxIcon name="alert-triangle" className="w-6 h-6 text-amber-300" />
                                    <span className="text-sm text-gray-300">Could not load this material.</span>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
            <div className="shrink-0 flex justify-end gap-2 px-4 py-2.5 border-t border-gray-700 bg-gray-900/70">
                <button type="button" onClick={onClose} className={BTN_SECONDARY}>Cancel</button>
                <button
                    type="button"
                    onClick={confirmHighlighted}
                    disabled={!ready}
                    className={BTN_PRIMARY + ' gap-1.5 disabled:opacity-40'}
                >
                    <MtlxIcon name="check" className="w-3.5 h-3.5" />
                    Select preset
                </button>
            </div>
        </DialogFrame>
    );
}

Object.assign(window, { MtlxPresetPicker });
