// Scene Viewer route. This page owns file selection and lifecycle only. USD
// composition and rendering stay behind the two small runtime contracts.
// UI skeleton mirrors js/viewer-app.jsx (docked sidebar, HUD, pinned
// statistics panel like js/compare-app.jsx) so the Scene Viewer looks and
// behaves like the rest of the toolset.
(() => {
    const ROOT_EXTENSIONS = ['.usd', '.usda', '.usdc', '.usdz'];
    // glTF/OBJ roots route through window.MtlxSceneSources (js/usd-scene-sources.js)
    // instead of the USD worker; see detectRootKind() and load() below.
    const MODEL_ROOT_EXTENSIONS = ['.glb', '.gltf', '.obj'];
    const EXAMPLE_ROOT = 'tests/fixtures/usd-scene/root.usda';
    const EXAMPLE_FILES = [
        EXAMPLE_ROOT,
        'tests/fixtures/usd-scene/nested/nested.usda',
        'tests/fixtures/usd-scene/nested/materials/red.mtlx',
        'tests/fixtures/usd-scene/nested/materials/blue.mtlx',
    ];
    // Self-authored (not imported from js/compare-app.jsx per the ground
    // rule against importing across apps): the same grid-mask empty-stage
    // treatment as Compare's own empty slot.
    const EMPTY_STAGE_GRID_IMAGE = 'linear-gradient(to right, rgba(107,114,128,0.16) 1px, transparent 1px), linear-gradient(to bottom, rgba(107,114,128,0.16) 1px, transparent 1px)';
    const EMPTY_STAGE_GRID_MASK = 'radial-gradient(ellipse at center, rgba(0,0,0,1) 0%, rgba(0,0,0,0.9) 30%, rgba(0,0,0,0) 70%)';
    // Same translucent-over-solid card surface as SectionCard/compare's
    // stats panel (js/shared/mtlx-ui.jsx CARD_SURFACE).
    const PANEL_SURFACE = 'color-mix(in srgb, var(--site-gray-800, #1f2937) 35%, var(--site-gray-900, #111827))';

    // Mirrors js/usd-scene-renderer.js sceneDomeYawDegFromRotation (not
    // exported, math not to be changed here): converts an authored dome
    // rotationDeg into the engine's mx_latlong yaw degrees, so a manual
    // nudge of the slider matches the yaw the renderer already applied.
    const domeYawDegFromRotation = (rotationDeg) => (((90 - Number(rotationDeg || 0)) % 360) + 360) % 360;

    const asPath = (file) => String(file.webkitRelativePath || file.relativePath || file.name || '').replace(/\\/g, '/');
    const ext = (path) => { const i = path.lastIndexOf('.'); return i < 0 ? '' : path.slice(i).toLowerCase(); };
    const ALL_ROOT_EXTENSIONS = ROOT_EXTENSIONS.concat(MODEL_ROOT_EXTENSIONS);
    const isUsdRootPath = (path) => ROOT_EXTENSIONS.indexOf(ext(path)) >= 0;
    const isModelRootPath = (path) => MODEL_ROOT_EXTENSIONS.indexOf(ext(path)) >= 0;
    const rootCandidates = (files) => {
        // Keep every supplied USD or model (glTF/OBJ) root selectable; the
        // default still picks a conventional top-level root in
        // pickDefaultRootLayer().
        return files.filter((f) => ALL_ROOT_EXTENSIONS.indexOf(ext(f.path)) >= 0);
    };
    const dirOf = (path) => { const i = String(path).lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); };
    // Collapses '.' and '..' segments without touching the filesystem, the
    // same way a USD composer resolves an asset path relative to the layer
    // that references it.
    const normalizeRelativePath = (path) => {
        const out = [];
        String(path).split('/').forEach((part) => {
            if (part === '' || part === '.') return;
            if (part === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else out.push('..'); return; }
            out.push(part);
        });
        return out.join('/');
    };
    const rootNamePattern = /(^|\/)root\.(usd|usda|usdc|usdz)$/i;
    const oldDefaultRoot = (candidates) => {
        const preferred = candidates.find((f) => rootNamePattern.test(f.path));
        return preferred ? preferred.path : (candidates.length === 1 ? candidates[0].path : '');
    };
    // A candidate's data may be a File/Blob (file picker, window drop) or an
    // ArrayBuffer/typed array (loadExample's fetch results); normalize both
    // to a Blob so slice()/text() work the same way.
    const blobOfCandidate = (file) => {
        const data = file && file.data !== undefined ? file.data : file;
        if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
        if (data instanceof ArrayBuffer) return new Blob([data]);
        if (ArrayBuffer.isView(data)) return new Blob([data.buffer]);
        return null;
    };
    const ASCII_SCAN_SKIP_BYTES = 64 * 1024 * 1024;
    const ASCII_SCAN_MAX_CHARS = 32 * 1024 * 1024;
    const isAsciiUsdBlob = async (blob) => {
        if (!blob || typeof blob.slice !== 'function') return false;
        try { return /^#usda\b/.test(await blob.slice(0, 8).text()); } catch (e) { return false; }
    };
    // Scans every ASCII USD candidate once for `@asset@` tokens (references,
    // payloads, subLayers) to tell top-level layers from layers something
    // else pulls in, then picks the shallowest unreferenced one so a folder
    // like the Teapot's (root usda referencing Geometry/* and Looks/*)
    // defaults to the actual root instead of leaving the picker empty.
    // Keyed by the candidate set's own identity (path|size|lastModified per
    // file, sorted and joined) so re-selecting the same folder skips the
    // whole ASCII scan. Insertion-order eviction keeps this small.
    const ROOT_LAYER_CACHE_MAX = 8;
    const rootLayerCache = new Map();
    const cacheRootLayer = (key, value) => {
        if (rootLayerCache.size >= ROOT_LAYER_CACHE_MAX) rootLayerCache.delete(rootLayerCache.keys().next().value);
        rootLayerCache.set(key, value);
        return value;
    };
    // Shallowest-first, then alphabetical, the same tiebreak
    // pickDefaultUsdRootLayer uses for composition roots below.
    const shallowestFirst = (a, b) => {
        const depthDiff = String(a.path).split('/').length - String(b.path).split('/').length;
        if (depthDiff !== 0) return depthDiff;
        const aPath = String(a.path), bPath = String(b.path);
        return aPath < bPath ? -1 : (aPath > bPath ? 1 : 0);
    };
    // Model-only root selection (no USD candidate present): a single root
    // wins outright; otherwise prefer the shallowest .gltf/.glb over any
    // .obj, since glTF roots carry their own scene graph and .obj does not.
    function pickDefaultModelRoot(modelCandidates) {
        if (modelCandidates.length === 0) return '';
        if (modelCandidates.length === 1) return modelCandidates[0].path;
        const gltfLike = modelCandidates.filter((f) => ext(f.path) === '.gltf' || ext(f.path) === '.glb');
        const pool = (gltfLike.length ? gltfLike : modelCandidates.filter((f) => ext(f.path) === '.obj')) || [];
        const sorted = (pool.length ? pool : modelCandidates).slice().sort(shallowestFirst);
        return sorted[0].path;
    }
    // A USD root always wins the default pick over a co-uploaded model
    // root, which comes back as an ignoredModelRoots entry for the
    // caller's diagnostics; with no USD root, a model root is picked.
    async function pickDefaultRootLayer(files) {
        const candidates = rootCandidates(files);
        if (candidates.length === 0) return { path: '', ignoredModelRoots: [] };
        const usdCandidates = candidates.filter((f) => isUsdRootPath(f.path));
        const modelCandidates = candidates.filter((f) => isModelRootPath(f.path));
        if (usdCandidates.length === 0) return { path: pickDefaultModelRoot(modelCandidates), ignoredModelRoots: [] };
        const path = await pickDefaultUsdRootLayer(usdCandidates);
        return { path, ignoredModelRoots: modelCandidates.map((f) => f.path) };
    }
    async function pickDefaultUsdRootLayer(candidates) {
        const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (candidates.length === 0) return '';
        if (candidates.length === 1) return candidates[0].path;
        const cacheKey = candidates.map((f) => {
            const size = f && f.data && typeof f.data.size === 'number' ? f.data.size : -1;
            const modified = f && f.data && typeof f.data.lastModified === 'number' ? f.data.lastModified : -1;
            return String(f.path) + '|' + size + '|' + modified;
        }).sort().join(',');
        if (rootLayerCache.has(cacheKey)) {
            const elapsedMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startedAt;
            console.debug('pickDefaultRootLayer: scanned', candidates.length, 'candidates in', elapsedMs.toFixed(1) + 'ms (cached)');
            return rootLayerCache.get(cacheKey);
        }
        const candidateKeys = new Set(candidates.map((f) => String(f.path).replace(/\\/g, '/').toLowerCase()));
        const referenced = new Set();
        // Which OTHER candidates a layer references, keyed by the scanning
        // layer's own normalized path. Used to prefer composition roots
        // (layers that pull in other candidates) over standalone leaves.
        const outgoing = new Map();
        for (const file of candidates) {
            const selfKey = String(file.path).replace(/\\/g, '/').toLowerCase();
            const blob = blobOfCandidate(file);
            if (!blob || !(await isAsciiUsdBlob(blob))) continue;
            const size = typeof blob.size === 'number' ? blob.size : 0;
            if (size > ASCII_SCAN_SKIP_BYTES) { console.info('pickDefaultRootLayer: skipping oversized USD layer', file.path, size); continue; }
            let text;
            try { text = await blob.text(); } catch (e) { continue; }
            if (text.length > ASCII_SCAN_MAX_CHARS) text = text.slice(0, ASCII_SCAN_MAX_CHARS);
            const dir = dirOf(file.path);
            const tokenPattern = /@([^@\n]+)@/g;
            let match;
            const outs = new Set();
            while ((match = tokenPattern.exec(text))) {
                let ref = match[1].replace(/:SDF_FORMAT_ARGS:.*$/, '').trim();
                if (!ref || ref.indexOf('anon:') === 0 || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(ref)) continue;
                ref = ref.replace(/\\/g, '/');
                if (ROOT_EXTENSIONS.indexOf(ext(ref.split(/[?#]/)[0])) < 0) continue;
                const resolved = ref.charAt(0) === '/' ? normalizeRelativePath(ref) : normalizeRelativePath(dir ? dir + '/' + ref : ref);
                const resolvedKey = resolved.toLowerCase();
                if (resolvedKey === selfKey) continue; // self references never count as "referenced by something else"
                referenced.add(resolvedKey);
                if (candidateKeys.has(resolvedKey)) outs.add(resolvedKey);
            }
            if (outs.size) outgoing.set(selfKey, outs);
        }
        const topLevel = candidates.filter((f) => !referenced.has(String(f.path).replace(/\\/g, '/').toLowerCase()));
        const elapsedMs = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - startedAt;
        console.debug('pickDefaultRootLayer: scanned', candidates.length, 'candidates in', elapsedMs.toFixed(1) + 'ms');
        if (topLevel.length === 0) return cacheRootLayer(cacheKey, oldDefaultRoot(candidates));
        const isComposition = (f) => outgoing.has(String(f.path).replace(/\\/g, '/').toLowerCase());
        const isNamedRoot = (f) => rootNamePattern.test(f.path);
        topLevel.sort((a, b) => {
            const compDiff = (isComposition(b) ? 1 : 0) - (isComposition(a) ? 1 : 0);
            if (compDiff !== 0) return compDiff;
            const namedDiff = (isNamedRoot(b) ? 1 : 0) - (isNamedRoot(a) ? 1 : 0);
            if (namedDiff !== 0) return namedDiff;
            const depthDiff = String(a.path).split('/').length - String(b.path).split('/').length;
            if (depthDiff !== 0) return depthDiff;
            const lenDiff = String(a.path).length - String(b.path).length;
            if (lenDiff !== 0) return lenDiff;
            const aPath = String(a.path), bPath = String(b.path);
            return aPath < bPath ? -1 : (aPath > bPath ? 1 : 0);
        });
        return cacheRootLayer(cacheKey, topLevel[0].path);
    }
    // The camera the picker should apply with no user interaction: the one
    // the worker flags defaultCamera, else the first authored camera, else
    // null (auto framing). Defensive since the flag may not exist yet.
    function defaultCameraPathFor(cams) {
        const list = Array.isArray(cams) ? cams : [];
        if (list.length === 0) return null;
        const flagged = list.find((c) => c && c.defaultCamera);
        return (flagged || list[0]).primPath || null;
    }
    // Root-layer candidates from a shared upload often share one long
    // prefix (a zip's top folder), so the basename alone tells them apart
    // in most cases. When two candidates share a basename, extend both by
    // one more parent directory at a time until their labels differ.
    const distinctRootLabels = (paths) => {
        const segs = paths.map((p) => String(p).split('/').filter(Boolean));
        const labels = segs.map((s) => s[s.length - 1] || '');
        const groups = new Map();
        labels.forEach((label, i) => {
            if (!groups.has(label)) groups.set(label, []);
            groups.get(label).push(i);
        });
        groups.forEach((idxs) => {
            if (idxs.length < 2) return;
            let depth = 1;
            for (;;) {
                const tries = idxs.map((i) => segs[i].slice(-1 - depth).join('/'));
                const unique = new Set(tries).size === tries.length;
                const exhausted = idxs.every((i) => depth + 1 >= segs[i].length);
                if (unique || exhausted) {
                    idxs.forEach((i, j) => { labels[i] = tries[j]; });
                    break;
                }
                depth += 1;
            }
        });
        return labels;
    };
    const stageMeshes = (stage) => Array.isArray(stage && stage.meshes) ? stage.meshes : [];
    const stageTriangleCount = (stage) => stageMeshes(stage).reduce((sum, mesh) => {
        if (!mesh) return sum;
        const corners = Array.isArray(mesh.indices) || mesh.indices ? mesh.indices.length : (mesh.positions ? mesh.positions.length / 3 : 0);
        return sum + Math.floor(corners / 3);
    }, 0);
    const stageMaterials = (stage) => Array.isArray(stage && stage.materials) ? stage.materials : [];
    const materialWarningList = (stage) => {
        const out = [];
        (Array.isArray(stage && stage.warnings) ? stage.warnings : []).forEach((w) => out.push(String(w && (w.message || w.text || w) || 'Scene warning')));
        stageMeshes(stage).forEach((mesh) => (Array.isArray(mesh && mesh.warnings) ? mesh.warnings : []).forEach((w) => out.push(String(w && (w.message || w.text || w) || 'Material warning'))));
        return out;
    };
    const warningRecord = (value) => {
        const raw = String(value || 'Scene warning');
        // Native USD can repeat the same failed asset once per composed prim.
        // Collapse that noisy form to a useful path while retaining the raw
        // diagnostic below a disclosure for debugging.
        const assetMatch = /Could not open asset @([^@]+)@/i.exec(raw);
        if (assetMatch) {
            const path = assetMatch[1].replace(/\\/g, '/');
            return { key: 'missing-asset:' + path.toLowerCase(), label: 'Missing referenced file: ' + path, raw };
        }
        const pathMatch = /(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.(?:usd|usda|usdc|usdz)\b/i.exec(raw);
        if (pathMatch && /(?:open|read|reference|layer)/i.test(raw) && !/too large/i.test(raw)) {
            const path = pathMatch[0].replace(/\\/g, '/');
            return { key: 'missing-layer:' + path.toLowerCase(), label: 'Missing referenced layer: ' + path, raw };
        }
        return { key: raw, label: raw, raw };
    };
    const warningRecords = (values) => {
        const seen = new Set();
        return values.map(warningRecord).filter((record) => {
            if (seen.has(record.key)) return false;
            seen.add(record.key);
            return true;
        });
    };
    const readFiles = async (fileList) => {
        const all = Array.from(fileList || []);
        const kept = all.filter((file) => !isHiddenSideFile(asPath(file)));
        if (kept.length !== all.length) console.info('readFiles: skipped ' + (all.length - kept.length) + ' side file(s)');
        return kept.map((file) => ({ path: asPath(file), data: file }));
    };
    // Window drop hands over a { relPath: File } map (js/mtlx-engine.js's
    // readDroppedItems, which preserves nested directory paths); flatten it
    // to the same { path, data } shape readFiles() produces.
    const filesFromMap = (map) => Object.keys(map || {}).map((path) => ({ path: String(path).replace(/\\/g, '/'), data: map[path] }));
    // Whole-load phase table: the single source of truth for the load
    // sequence's step numbering, labels and progress-bar segments.
    const USD_SCENE_LOAD_PHASES = [
        { phase: 'worker', label: 'Reading files', segment: [0.00, 0.06] },
        { phase: 'parse', label: 'Composing stage', segment: [0.06, 0.10] },
        { phase: 'extract-geometry', label: 'Extracting meshes', segment: [0.10, 0.14] },
        { phase: 'extract-materials', label: 'Extracting materials', segment: [0.14, 0.16] },
        { phase: 'prepare-geometry', label: 'Subdividing meshes', segment: [0.16, 0.20] },
        { phase: 'material', label: 'Compiling materials', segment: [0.20, 0.52] },
        { phase: 'material-bind', label: 'Binding materials', segment: [0.52, 0.56] },
        { phase: 'texture', label: 'Loading textures', segment: [0.56, 0.72] },
        { phase: 'geometry', label: 'Preparing geometry', segment: [0.72, 0.86] },
        { phase: 'renderer', label: 'Preparing viewport', segment: [0.86, 0.99] },
    ];
    window.USD_SCENE_LOAD_PHASES = USD_SCENE_LOAD_PHASES;
    // Each phase owns a slice of the bar so it fills once across the whole
    // load instead of restarting per phase.
    const USD_SCENE_PROGRESS_SEGMENTS = Object.fromEntries(
        USD_SCENE_LOAD_PHASES.map((entry) => [entry.phase, entry.segment])
    );
    // Pure: maps one progress event plus the previous whole-load fraction to
    // the next whole-load fraction. Never moves backwards inside one load.
    const usdSceneProgressFraction = (event, previous) => {
        const prev = Number.isFinite(previous) ? previous : 0;
        const clamp01 = (v) => Math.max(0, Math.min(1, v));
        const p = event && typeof event === 'object' ? event : {};
        const phase = String(p.phase || '');
        if (phase === 'renderer' && String(p.status || '') === 'ready') return 1;
        const segment = USD_SCENE_PROGRESS_SEGMENTS[phase];
        if (!segment) return prev;
        const [start, end] = segment;
        const explicitFraction = p.fraction != null ? Number(p.fraction) : (p.progress != null ? Number(p.progress) : null);
        const total = Number(p.total || 0);
        const done = Number(p.done != null ? p.done : (p.index != null ? p.index : 0));
        const local = Number.isFinite(explicitFraction) ? clamp01(explicitFraction) : (total > 0 ? clamp01(done / total) : 0);
        return Math.max(prev, start + local * (end - start));
    };
    window.usdSceneProgressFraction = usdSceneProgressFraction;
    const progressValue = (value, wholeFraction) => {
        if (typeof value === 'number') {
            const numberFraction = Number.isFinite(wholeFraction) ? wholeFraction : (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null);
            return { phase: 'Loading', fraction: numberFraction, done: 0, total: 0, message: '', label: '', step: '' };
        }
        const p = value && typeof value === 'object' ? value : { message: String(value || '') };
        const done = Number(p.done || p.index || 0);
        const total = Number(p.total || 0);
        const fraction = Number.isFinite(wholeFraction) ? wholeFraction : null;
        return {
            phase: String(p.phase || ''), fraction, done, total,
            message: String(p.message || p.status || ''),
            label: String(p.label || ''), step: String(p.step || ''),
        };
    };
    const apiFunction = (name) => {
        const candidates = [window[name], window.MtlxUsd && window.MtlxUsd[name], window.UsdSceneRuntime && window.UsdSceneRuntime[name]];
        return candidates.find((value) => typeof value === 'function');
    };

    // Pure: keeps a panel rect fully inside bounds, shrinking it first when
    // it is larger than the container. No side effects, safe for a Node test.
    const clampPanelRect = (rect, bounds) => {
        // Empty bounds mean the view is hidden (display none); clamping
        // against them would collapse the rect to nothing, so keep it.
        if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        const width = Math.max(0, Math.min(rect.width, bounds.width));
        const height = Math.max(0, Math.min(rect.height, bounds.height));
        const x = Math.max(0, Math.min(rect.x, bounds.width - width));
        const y = Math.max(0, Math.min(rect.y, bounds.height - height));
        return { x, y, width, height };
    };
    window.usdSceneClampPanelRect = clampPanelRect;

    const MATERIAL_PREVIEW_RECT_KEY = 'mtlx_scene_material_preview_rect';
    const MATERIAL_PREVIEW_DEFAULT_SIZE = { width: 640, height: 420 };
    const MATERIAL_PREVIEW_MIN_SIZE = { width: 320, height: 220 };
    const readStoredMaterialPreviewRect = () => {
        try {
            const raw = localStorage.getItem(MATERIAL_PREVIEW_RECT_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            // A collapsed rect (persisted from a hidden view) is discarded so
            // the next open falls back to the default size at the click.
            if (parsed && [parsed.x, parsed.y, parsed.width, parsed.height].every(Number.isFinite)
                && parsed.width >= MATERIAL_PREVIEW_MIN_SIZE.width && parsed.height >= MATERIAL_PREVIEW_MIN_SIZE.height) return parsed;
        } catch (e) { /* storage unavailable or corrupt */ }
        return null;
    };

    // Floating graph + shaderball preview for the material under a
    // double-click in the viewport. Stays mounted (CSS-hidden) after first
    // open so the graph-preview/materialx-viewer instances survive reopens.
    function MaterialPreviewPanel({ open, payload, anchor, onClose, containerRef, panelRef, sceneFiles }) {
        const shownRef = React.useRef(null);
        if (payload) shownRef.current = payload;
        const shown = shownRef.current;
        const [rect, setRect] = React.useState(() => readStoredMaterialPreviewRect());
        const rectRef = React.useRef(rect);
        rectRef.current = rect;
        const bodyRef = React.useRef(null);
        const dragRef = React.useRef(null);
        const resizeRef = React.useRef(null);
        const [bodyHeight, setBodyHeight] = React.useState(0);
        const [depsReady, setDepsReady] = React.useState(!!window.MtlxGraphPreview);

        useEscapeToClose(onClose, open);

        // Clamp a restored rect against the current container once mounted.
        React.useEffect(() => {
            if (!containerRef.current) return;
            const bounds = containerRef.current.getBoundingClientRect();
            setRect((prev) => (prev ? clampPanelRect(prev, bounds) : prev));
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        // First-ever open with no persisted rect: default 640x420 anchored
        // at the click. A later open keeps whatever rect the user left.
        React.useEffect(() => {
            if (!open || !containerRef.current) return;
            const bounds = containerRef.current.getBoundingClientRect();
            // A remembered rect is re-clamped on every open so one saved from
            // a larger window still lands inside the current viewport.
            if (rectRef.current) { setRect(clampPanelRect(rectRef.current, bounds)); return; }
            if (!anchor) return;
            const base = {
                x: anchor.x - MATERIAL_PREVIEW_DEFAULT_SIZE.width / 2,
                y: anchor.y - MATERIAL_PREVIEW_DEFAULT_SIZE.height / 2,
                width: MATERIAL_PREVIEW_DEFAULT_SIZE.width,
                height: MATERIAL_PREVIEW_DEFAULT_SIZE.height,
            };
            setRect(clampPanelRect(base, bounds));
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [open, anchor]);

        React.useEffect(() => {
            if (!rect) return;
            try { localStorage.setItem(MATERIAL_PREVIEW_RECT_KEY, JSON.stringify(rect)); } catch (e) { /* storage unavailable */ }
        }, [rect]);

        React.useEffect(() => {
            if (!window.MtlxGraphPreview && open) {
                let cancelled = false;
                window.mtlxLoadViewDeps('galleryDetail').then(() => { if (!cancelled) setDepsReady(true); });
                return () => { cancelled = true; };
            }
            return undefined;
        }, [open]);

        // Deps on !!shown, not []: the body div does not exist in the DOM
        // until the panel opens for the first time (shown is still null on
        // the very first mount, so a one-shot effect would see no element
        // and never attach), so this must re-run once shown flips truthy.
        React.useEffect(() => {
            if (!bodyRef.current || !window.ResizeObserver) return undefined;
            const observer = new ResizeObserver((entries) => {
                const entry = entries[0];
                if (entry) setBodyHeight(Math.round(entry.contentRect.height));
            });
            observer.observe(bodyRef.current);
            return () => observer.disconnect();
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [!!shown]);

        const beginDrag = (dragTargetRef) => (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            // A pointerdown that started on a button (Close, Open in Graph
            // Editor) must not capture the pointer: capture redirects the
            // matching mouseup, which silently swallows the button's click.
            if (e.target && e.target.closest && e.target.closest('button')) return;
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* unsupported */ }
            dragTargetRef.current = { startX: e.clientX, startY: e.clientY, rect: rectRef.current };
        };
        const endDrag = (dragTargetRef) => (e) => {
            dragTargetRef.current = null;
            try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (err) { /* unsupported */ }
        };
        const onHeaderMove = (e) => {
            const drag = dragRef.current;
            if (!drag || !containerRef.current) return;
            const bounds = containerRef.current.getBoundingClientRect();
            const next = clampPanelRect({
                x: drag.rect.x + (e.clientX - drag.startX),
                y: drag.rect.y + (e.clientY - drag.startY),
                width: drag.rect.width, height: drag.rect.height,
            }, bounds);
            setRect(next);
        };
        const onResizeMove = (e) => {
            const drag = resizeRef.current;
            if (!drag || !containerRef.current) return;
            const bounds = containerRef.current.getBoundingClientRect();
            const next = clampPanelRect({
                x: drag.rect.x, y: drag.rect.y,
                width: Math.max(MATERIAL_PREVIEW_MIN_SIZE.width, drag.rect.width + (e.clientX - drag.startX)),
                height: Math.max(MATERIAL_PREVIEW_MIN_SIZE.height, drag.rect.height + (e.clientY - drag.startY)),
            }, bounds);
            setRect(next);
        };

        if (!shown) return null; // never opened yet this session

        // The full scene's loose files (every dropped/loaded non-.mtlx
        // entry), not just getMaterialDocument's own filename-ref-scoped
        // map: the exporter's own matcher can resolve a texture under a
        // relative form the renderer's narrower scan did not try.
        const handoffFiles = (sceneFiles && Object.keys(sceneFiles).length) ? sceneFiles : shown.files;
        const openInEditor = () => {
            window.openInGraphEditor({ xml: shown.xml, name: shown.name, files: handoffFiles, select: shown.materialName });
        };
        const rectStyle = rect
            ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height }
            : { left: 0, top: 0, width: MATERIAL_PREVIEW_DEFAULT_SIZE.width, height: MATERIAL_PREVIEW_DEFAULT_SIZE.height };

        return (
            <div
                ref={panelRef}
                data-testid="usd-scene-material-preview"
                className={'absolute z-40 flex flex-col bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl overflow-hidden' + (open ? '' : ' hidden')}
                style={rectStyle}
                aria-hidden={!open}
            >
                <div
                    className="flex-none flex items-center justify-between gap-2 px-3 py-2 border-b border-gray-700 bg-gray-900/70 cursor-move touch-none"
                    onPointerDown={beginDrag(dragRef)}
                    onPointerMove={onHeaderMove}
                    onPointerUp={endDrag(dragRef)}
                >
                    <div className="min-w-0 flex flex-col">
                        <span className="text-[11px] text-gray-400 truncate max-w-[16rem]">{shown.primPath || ''}</span>
                        <span className="text-sm font-semibold text-gray-100 truncate max-w-[16rem]">{shown.materialName || shown.name}</span>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                        <button type="button" onClick={openInEditor} className={HUD_PILL}>
                            <MtlxIcon name="external-link" className="w-3.5 h-3.5" /> Open in Graph Editor
                        </button>
                        <button type="button" onClick={onClose} className={HUD_PILL} aria-label="Close">
                            <MtlxIcon name="x" className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>
                <div ref={bodyRef} className="relative flex-1 min-h-0">
                    {!depsReady ? (
                        <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-sm animate-pulse">Loading preview</div>
                    ) : (
                        <window.MtlxGraphPreview
                            xml={shown.xml}
                            preview="right"
                            previewTextures={handoffFiles}
                            previewName={shown.name}
                            previewExpanded
                            previewResizable
                            previewSplitStorageKey="mtlx_scene_material_preview_split"
                            lazy={false}
                            controls={['zoom']}
                            autoFocus="fit"
                            chrome="card"
                            height={bodyHeight || (MATERIAL_PREVIEW_DEFAULT_SIZE.height - 60)}
                        />
                    )}
                </div>
                <div
                    data-testid="usd-scene-material-preview-resize"
                    className="absolute bottom-0 right-0 w-4 h-4 z-20 cursor-nwse-resize touch-none"
                    onPointerDown={beginDrag(resizeRef)}
                    onPointerMove={onResizeMove}
                    onPointerUp={endDrag(resizeRef)}
                />
            </div>
        );
    }

    // Kept as one array so the list is easy to edit without touching the
    // popover markup below.
    const SCENE_KNOWN_ISSUES = [
        'A malformed prim can crash the USD runtime.',
        'UsdPreviewSurface is only flattened to basic constants and textures, not converted to MaterialX.',
        'Reloading stages many times in one session has hung twice.',
    ];
    const KNOWN_ISSUES_POPOVER_W = 260;

    // Named "quality" throughout, never "preset" alone: MTLX_PRESETS and
    // MtlxPresetPicker already mean material presets app-wide.
    // These reference the same top-level consts js/usd-scene-renderer.js
    // declares (shared global scope, not window properties); the fallback
    // only matters if that script somehow loads after this one.
    const QUALITY_TEXTURE_MAX_SIZE_DEFAULT = (typeof SCENE_TEXTURE_MAX_SIZE_DEFAULT !== 'undefined')
        ? SCENE_TEXTURE_MAX_SIZE_DEFAULT
        : (typeof storedSceneTextureMaxSize === 'function' ? storedSceneTextureMaxSize() : 2048);
    const QUALITY_TEXTURE_BUDGET_DEFAULT_GIB = (typeof SCENE_TEXTURE_BUDGET_DEFAULT_GIB !== 'undefined')
        ? SCENE_TEXTURE_BUDGET_DEFAULT_GIB
        : (typeof storedSceneTextureBudgetBytes === 'function' ? Math.round(storedSceneTextureBudgetBytes() / (1024 * 1024 * 1024)) : 1);
    const QUALITY_SUBDIVISION_DEFAULT = (typeof SCENE_SUBDIVISION_DEFAULT !== 'undefined')
        ? SCENE_SUBDIVISION_DEFAULT
        : (typeof storedSceneSubdivisionLevel === 'function' ? storedSceneSubdivisionLevel() : 1);

    // Excluded on purpose: backdrop and env rotation (look, not cost);
    // heightToNormalTexel (engine-global, shared with other tools, no Scene
    // UI); MSAA sample count and FXAA (renderer-only test hooks, no row).
    // Same fallback idiom as the texture/subdivision consts above: read the
    // renderer's own default consts when available so "Default" can never
    // drift from what a fresh profile actually ships.
    const QUALITY_DISPLACEMENT_SUBDIVISION_DEFAULT = (typeof SCENE_DISPLACEMENT_SUBDIVISION_DEFAULT !== 'undefined')
        ? SCENE_DISPLACEMENT_SUBDIVISION_DEFAULT
        : (typeof storedSceneDisplacementSubdivision === 'function' ? storedSceneDisplacementSubdivision() : 'follow');
    const QUALITY_TRIANGLE_LIMITS_DEFAULT = (typeof SCENE_TRIANGLE_LIMITS_DEFAULT !== 'undefined')
        ? SCENE_TRIANGLE_LIMITS_DEFAULT
        : (typeof storedSceneTriangleLimits === 'function' ? storedSceneTriangleLimits() : true);
    // Live-key defaults (apply instantly, no draft): same fallback idiom,
    // reading the renderer's own *_DEFAULT consts added alongside them.
    const QUALITY_DISPLAY_TRANSFORM_DEFAULT = (typeof SCENE_DISPLAY_TRANSFORM_DEFAULT !== 'undefined') ? SCENE_DISPLAY_TRANSFORM_DEFAULT : 'neutral';
    const QUALITY_MATERIAL_WORKSPACE_DEFAULT = (typeof SCENE_MATERIAL_WORKSPACE_DEFAULT !== 'undefined') ? SCENE_MATERIAL_WORKSPACE_DEFAULT : 'rec709';
    // No exported const for this one (js/mtlx-engine.js:5249, initDisplayExposure's own fallback); shared engine-wide, not Scene-only.
    const QUALITY_DISPLAY_EXPOSURE_DEFAULT = 0;
    const QUALITY_STAGE_LIGHTS_DEFAULT = (typeof SCENE_STAGE_LIGHTS_DEFAULT !== 'undefined') ? SCENE_STAGE_LIGHTS_DEFAULT : true;
    const QUALITY_STAGE_LIGHTS_EV_DEFAULT = (typeof SCENE_STAGE_LIGHTS_EV_DEFAULT !== 'undefined') ? SCENE_STAGE_LIGHTS_EV_DEFAULT : 0;
    const QUALITY_AO_STRENGTH_DEFAULT = (typeof SCENE_AO_STRENGTH_DEFAULT !== 'undefined') ? SCENE_AO_STRENGTH_DEFAULT : 0.85;
    const QUALITY_BOUNCE_STRENGTH_DEFAULT = (typeof SCENE_BOUNCE_STRENGTH_DEFAULT !== 'undefined') ? SCENE_BOUNCE_STRENGTH_DEFAULT : 1;
    const QUALITY_SKYVIS_STRENGTH_DEFAULT = (typeof SCENE_SKYVIS_STRENGTH_DEFAULT !== 'undefined') ? SCENE_SKYVIS_STRENGTH_DEFAULT : 1;
    const QUALITY_LOCAL_ENV_STRENGTH_DEFAULT = (typeof SCENE_LOCAL_ENV_STRENGTH_DEFAULT !== 'undefined') ? SCENE_LOCAL_ENV_STRENGTH_DEFAULT : 1;
    const QUALITY_SSR_DEFAULT = (typeof SCENE_SSR_DEFAULT !== 'undefined') ? SCENE_SSR_DEFAULT : false;
    const QUALITY_SSR_STRENGTH_DEFAULT = (typeof SCENE_SSR_STRENGTH_DEFAULT !== 'undefined') ? SCENE_SSR_STRENGTH_DEFAULT : 1;
    const QUALITY_SSR_MAX_ROUGHNESS_DEFAULT = (typeof SCENE_SSR_MAX_ROUGHNESS_DEFAULT !== 'undefined') ? SCENE_SSR_MAX_ROUGHNESS_DEFAULT : 0.5;
    // No exported const (js/mtlx-engine.js:606, DIFFUSE_ENV_METHOD's own fallback is 'convolve'); shared engine-wide.
    const QUALITY_DIFFUSE_ENV_CONVOLVE_DEFAULT = true;
    // Matches the shipped React.useState default below verbatim (single
    // source): HDR presentation is app-owned state, not a persisted const.
    const SCENE_PRESENTATION_DEFAULT = { enabled: true, bloom: false, strength: 0.25, threshold: 1, knee: 0.5, radius: 0.65, antialias: true, samples: 4, debugView: 'final', supported: true };
    const SCENE_QUALITY_STORAGE_KEY = 'mtlx_scene_quality';
    // Live keys carry the SAME value on every level (today's shipped
    // default): they stay instant, never staged, so a level never fights an
    // in-progress drag; only Reset and the toolbar menu force them.
    const LIVE_QUALITY_VALUES = {
        displayTransform: QUALITY_DISPLAY_TRANSFORM_DEFAULT, materialWorkspace: QUALITY_MATERIAL_WORKSPACE_DEFAULT,
        displayExposure: QUALITY_DISPLAY_EXPOSURE_DEFAULT, presentation: SCENE_PRESENTATION_DEFAULT,
        stageLightsOn: QUALITY_STAGE_LIGHTS_DEFAULT, stageLightsEv: QUALITY_STAGE_LIGHTS_EV_DEFAULT,
        aoStrength: QUALITY_AO_STRENGTH_DEFAULT, bounceStrength: QUALITY_BOUNCE_STRENGTH_DEFAULT,
        skyVisStrength: QUALITY_SKYVIS_STRENGTH_DEFAULT, localEnvStrength: QUALITY_LOCAL_ENV_STRENGTH_DEFAULT,
        ssrOn: QUALITY_SSR_DEFAULT, ssrStrength: QUALITY_SSR_STRENGTH_DEFAULT, ssrMaxRoughness: QUALITY_SSR_MAX_ROUGHNESS_DEFAULT,
        diffuseEnvConvolve: QUALITY_DIFFUSE_ENV_CONVOLVE_DEFAULT,
    };
    const LIVE_QUALITY_KEYS = Object.keys(LIVE_QUALITY_VALUES);
    const SCENE_QUALITY_LEVELS = [
        {
            id: 'performance', label: 'Performance', icon: 'bolt',
            title: 'Lowest settings, fastest loading and drawing',
            values: {
                textureMaxSize: 512, textureBudgetGib: 1, subdivision: 0,
                shadows: false, ao: false, skyVis: false, transparency: false,
                displacement: false, displacementSubdivision: QUALITY_DISPLACEMENT_SUBDIVISION_DEFAULT,
                triangleLimits: true, bounce: false, localReflections: false, specularAA: false,
                ...LIVE_QUALITY_VALUES,
            },
        },
        {
            id: 'default', label: 'Default', icon: 'restore',
            title: 'Balanced quality and speed',
            values: {
                textureMaxSize: QUALITY_TEXTURE_MAX_SIZE_DEFAULT, textureBudgetGib: QUALITY_TEXTURE_BUDGET_DEFAULT_GIB, subdivision: QUALITY_SUBDIVISION_DEFAULT,
                // Sky visibility, AO and shadows off by default (2026-09-22):
                // matches storedSceneShadows/Ao/SkyVis in usd-scene-renderer.js.
                shadows: false, ao: false, skyVis: false, transparency: true,
                displacement: true, displacementSubdivision: QUALITY_DISPLACEMENT_SUBDIVISION_DEFAULT,
                triangleLimits: QUALITY_TRIANGLE_LIMITS_DEFAULT, bounce: true, localReflections: false, specularAA: true,
                ...LIVE_QUALITY_VALUES,
            },
        },
        {
            id: 'quality', label: 'Quality', icon: 'sparkles',
            title: 'Highest settings, slowest loading and drawing',
            values: {
                textureMaxSize: 4096, textureBudgetGib: 4, subdivision: 2,
                shadows: true, ao: true, skyVis: true, transparency: true,
                displacement: true, displacementSubdivision: 3,
                triangleLimits: false, bounce: true, localReflections: true, specularAA: true,
                ...LIVE_QUALITY_VALUES,
            },
        },
    ];

    // Render-settings popover row shells, hoisted to module scope (not
    // declared inside SceneViewerApp) so their component TYPE stays the
    // same across every render. A component declared inside a render body
    // is a brand-new function every time, so React unmounts and remounts
    // every instance on each re-render — which dropped a slider's pointer
    // capture mid-drag and remounted the MtlxSelect rows (flicker) on every
    // keystroke. See js/usd-scene-app.jsx's SceneRowCtx.Provider (wraps
    // SceneViewerApp's return) for the per-render values these still need.
    const SceneRowCtx = React.createContext({ rowDirtyFor: () => false, draftDiff: {}, hasStage: true });
    const EXP_BADGE = <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-amber-600/30 border border-amber-500/50 text-amber-300">Experimental</span>;
    const DirtyDot = ({ show }) => (show ? <span title="Differs from the selected quality level" className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" /> : null);
    const settingsCostKind = (key) => {
        if ((typeof SCENE_SETTINGS_RELOAD_KEYS !== 'undefined' ? SCENE_SETTINGS_RELOAD_KEYS : []).includes(key)) return 'reload';
        if ((typeof SCENE_SETTINGS_REBUILD_KEYS !== 'undefined' ? SCENE_SETTINGS_REBUILD_KEYS : []).includes(key)) return 'rebuild';
        if ((typeof SCENE_SETTINGS_GEOMETRY_KEYS !== 'undefined' ? SCENE_SETTINGS_GEOMETRY_KEYS : []).includes(key)) return 'geometry';
        return null;
    };
    const COST_KIND_ICON = { reload: 'refresh', rebuild: 'code', geometry: 'cube' };
    const COST_KIND_TITLE = {
        reload: 'Changing this reloads the stage', rebuild: 'Changing this recompiles materials', geometry: 'Changing this rebuilds geometry',
    };
    // settingKey drives DirtyDot (amber, differs from the level) and
    // CostBadge (reload/rebuild/geometry, tinted if pending) via context.
    const CostBadge = ({ settingKey }) => {
        const { draftDiff, hasStage } = React.useContext(SceneRowCtx);
        const kind = settingKey ? settingsCostKind(settingKey) : null;
        if (!kind) return null;
        // Muted with no scene loaded: Apply will only persist the value,
        // never actually pay this cost, see applyQualityDraft.
        const pending = hasStage && settingKey in draftDiff;
        return (
            <span title={COST_KIND_TITLE[kind]} className={'inline-flex ' + (pending ? 'text-amber-400' : 'text-gray-500')}>
                <MtlxIcon name={COST_KIND_ICON[kind]} className="w-3 h-3" />
            </span>
        );
    };
    const ToggleRow = ({ label, experimental, checked, onChange, disabled, title, description, dirty, settingKey }) => {
        const { rowDirtyFor } = React.useContext(SceneRowCtx);
        return (
            <div className="py-2 border-b border-gray-700/60 last:border-b-0">
                <label className="flex items-center justify-between gap-2 cursor-pointer" title={title}>
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-300">
                        <DirtyDot show={rowDirtyFor(settingKey, dirty)} /><span>{label}</span>{experimental ? EXP_BADGE : null}<CostBadge settingKey={settingKey} />
                    </span>
                    <Toggle checked={checked} onChange={onChange} disabled={disabled} />
                </label>
                {description ? <div className="mt-1 text-[11px] text-gray-400">{description}</div> : null}
            </div>
        );
    };
    const SelectRow = ({ label, experimental, control, description, title, dirty, settingKey }) => {
        const { rowDirtyFor } = React.useContext(SceneRowCtx);
        return (
            <div className="py-2 border-b border-gray-700/60 last:border-b-0" title={title}>
                <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-300">
                        <DirtyDot show={rowDirtyFor(settingKey, dirty)} /><span>{label}</span>{experimental ? EXP_BADGE : null}<CostBadge settingKey={settingKey} />
                    </span>
                    {control}
                </div>
                {description ? <div className="mt-1 text-[11px] text-gray-400">{description}</div> : null}
            </div>
        );
    };
    const SliderRow = ({ children, description, dirty, settingKey }) => {
        const { rowDirtyFor } = React.useContext(SceneRowCtx);
        return (
            <div className="py-2 border-b border-gray-700/60 last:border-b-0">
                {rowDirtyFor(settingKey, dirty) ? <div className="flex items-center gap-1.5 mb-1"><DirtyDot show /><span className="text-[10px] text-amber-300/80">Differs from the selected quality level</span></div> : null}
                {children}
                {description ? <div className="mt-1 text-[11px] text-gray-400">{description}</div> : null}
            </div>
        );
    };
    const ButtonRow = ({ label, onClick, disabled, title, description }) => (
        <div className="py-2 border-b border-gray-700/60 last:border-b-0">
            <button type="button" onClick={onClick} disabled={disabled} title={title} className={BTN_SECONDARY + ' w-full'}>{label}</button>
            {description ? <div className="mt-1 text-[11px] text-gray-400">{description}</div> : null}
        </div>
    );
    // Three-way quality control used by the Render settings popover.
    // Kept local rather than moved into js/shared/mtlx-ui.jsx, which
    // feeds the embed bundle where Tailwind utilities silently no-op.
    const QUALITY_SEGMENT_TONES = {
        hud: {
            wrap: 'inline-flex rounded-lg border border-gray-600/50 overflow-hidden',
            idle: 'bg-gray-900/70 backdrop-blur text-gray-300 hover:bg-gray-700 hover:text-gray-100',
            active: 'bg-blue-600/80 text-white border-blue-500',
        },
        panel: {
            wrap: 'flex flex-1 rounded-lg border border-gray-600/50 overflow-hidden',
            idle: 'bg-gray-800/80 text-gray-300 hover:bg-gray-700/80',
            active: 'bg-blue-500/[0.12] text-blue-300',
        },
    };
    const QualitySegments = ({ value, onChange, disabled, tone }) => {
        const cls = QUALITY_SEGMENT_TONES[tone] || QUALITY_SEGMENT_TONES.hud;
        return (
            <div
                role="group"
                aria-label="Render quality"
                data-testid={tone === 'panel' ? 'usd-scene-quality-popover' : 'usd-scene-quality-toolbar'}
                className={cls.wrap}
            >
                {SCENE_QUALITY_LEVELS.map((level, i) => {
                    const active = value === level.id;
                    return (
                        <button
                            key={level.id}
                            type="button"
                            data-testid={'usd-scene-quality-' + level.id}
                            data-active={active ? 'true' : undefined}
                            aria-pressed={active}
                            title={level.title}
                            disabled={disabled}
                            onClick={() => onChange(level.id)}
                            className={'h-7 px-2.5 flex items-center gap-1 text-[11px] font-medium whitespace-nowrap transition-colors '
                                + 'first:rounded-l-[7px] last:rounded-r-[7px] disabled:opacity-60 disabled:cursor-not-allowed '
                                + (tone === 'panel' ? 'flex-1 justify-center ' : '')
                                + (i > 0 ? 'border-l border-gray-600/50 ' : '')
                                + (active ? cls.active : cls.idle)}
                        >
                            {level.icon && <MtlxIcon name={level.icon} className="w-3.5 h-3.5 flex-none" />}
                            {level.label}
                        </button>
                    );
                })}
            </div>
        );
    };
    function SceneViewerApp({ active = true }) {
        const narrow = useNarrowPane();
        const [sidebarOpen, setSidebarOpen] = React.useState(!narrow);
        const sidebarOpenRef = React.useRef(sidebarOpen);
        sidebarOpenRef.current = sidebarOpen;
        const [files, setFiles] = React.useState([]);
        const [rootPath, setRootPath] = React.useState('');
        const [status, setStatus] = React.useState('idle');
        const [progress, setProgress] = React.useState({ phase: '', done: 0, total: 0, message: '' });
        const [stage, setStage] = React.useState(null);
        const [handle, setHandle] = React.useState(null);
        // Full loose (non-.mtlx) file map of the loaded scene, for the
        // material preview panel's editor hand-off: the renderer's own
        // getMaterialDocument().files is scoped to what its own filename-ref
        // scan matched, which can miss a texture the export scanner later
        // wants under a different relative form. Also merges stage.assets so
        // synthetic entries (glTF-embedded textures/materials, USDZ-internal
        // textures) the loader already decoded into memory are included,
        // not just the user's originally-dropped files.
        const sceneLooseFiles = React.useMemo(() => {
            const map = {};
            const add = ({ path, data }) => {
                if (!path || /\.mtlx$/i.test(path)) return;
                if (window.isHiddenSideFile && window.isHiddenSideFile(path)) return;
                map[path] = (data instanceof ArrayBuffer) ? new Blob([data]) : data;
            };
            files.forEach(add);
            (stage && Array.isArray(stage.assets) ? stage.assets : []).forEach(add);
            return map;
        }, [files, stage]);
        const [error, setError] = React.useState('');
        const [previewOpen, setPreviewOpen] = React.useState(false);
        // Short viewport note explaining why a double-click opened nothing.
        const [doubleClickNote, setDoubleClickNote] = React.useState('');
        const doubleClickNoteTimer = React.useRef(0);
        const showDoubleClickNote = (text) => {
            setDoubleClickNote(text);
            clearTimeout(doubleClickNoteTimer.current);
            doubleClickNoteTimer.current = setTimeout(() => setDoubleClickNote(''), 3000);
        };
        const DOUBLE_CLICK_NOTES = {
            moved: 'Double-click ignored: the pointer moved between the clicks',
            'no-api': 'Double-click preview is unavailable for this stage',
            'no-hit': 'Double-click: no surface under the pointer',
            'no-material': 'Double-click: the surface has no material bound',
            'no-document': 'Double-click: no MaterialX document for this material',
        };
        const [previewPayload, setPreviewPayload] = React.useState(null);
        const [previewAnchor, setPreviewAnchor] = React.useState(null);
        const previewPanelRef = React.useRef(null);
        const [dragOver, setDragOver] = React.useState(false);
        const [selectedPrim, setSelectedPrim] = React.useState('');
        const [selectedCamera, setSelectedCamera] = React.useState('default');
        React.useEffect(() => {
            const stageCameras = Array.isArray(stage && stage.cameras) ? stage.cameras : [];
            setSelectedCamera(defaultCameraPathFor(stageCameras) || 'default');
        }, [stage]);
        const [rootTouched, setRootTouched] = React.useState(false);
        // Model (glTF/OBJ) root candidates set aside when a USD root layer
        // was also supplied; surfaced as an info-level diagnostic below.
        const [ignoredModelRoots, setIgnoredModelRoots] = React.useState([]);
        const [envFileName, setEnvFileName] = React.useState('');
        const [envImportError, setEnvImportError] = React.useState(null);
        const [envRotation, setEnvRotation] = React.useState(0);
        const [envExposureLinear, setEnvExposureLinear] = React.useState(1);
        const [backdrop, setBackdrop] = React.useState('studio');
        const [textureSizeTick, setTextureSizeTick] = React.useState(0);
        const [subdivisionLevel, setSubdivisionLevel] = React.useState(
            () => (typeof storedSceneSubdivisionLevel === 'function' ? storedSceneSubdivisionLevel() : 0)
        );
        const subdivisionLevelRef = React.useRef(subdivisionLevel);
        subdivisionLevelRef.current = subdivisionLevel;
        const [triangleLimits, setTriangleLimitsState] = React.useState(
            () => (typeof storedSceneTriangleLimits === 'function' ? storedSceneTriangleLimits() : true)
        );
        const triangleLimitsRef = React.useRef(triangleLimits);
        triangleLimitsRef.current = triangleLimits;
        const [displacementEnabled, setDisplacementEnabledState] = React.useState(
            () => !!(window.getDisplacementEnabled && window.getDisplacementEnabled())
        );
        const [displacementSubdivisionOverride, setDisplacementSubdivisionOverrideState] = React.useState(
            () => (typeof storedSceneDisplacementSubdivision === 'function' ? storedSceneDisplacementSubdivision() : 'follow')
        );
        const displacementSubdivisionRef = React.useRef(displacementSubdivisionOverride);
        displacementSubdivisionRef.current = displacementSubdivisionOverride;
        React.useEffect(() => {
            const onSettingsChanged = (e) => {
                if (e.detail && e.detail.key === 'displacement') setDisplacementEnabledState(!!e.detail.value);
            };
            window.addEventListener('mtlx-settings-changed', onSettingsChanged);
            return () => window.removeEventListener('mtlx-settings-changed', onSettingsChanged);
        }, []);
        // The Scene keeps its own view transform (the Material Viewer stays on
        // sRGB for MaterialXView parity); exposure is shared with the other tools.
        const [displayTransform, setDisplayTransformState] = React.useState('neutral');
        // Karma reads untagged colour constants and displayColor as ACEScg;
        // this viewer treats the same numbers as linear Rec.709. Scene-only,
        // recompiles every material when toggled (see setSceneMaterialWorkspace).
        const [materialWorkspace, setMaterialWorkspaceState] = React.useState('rec709');
        // Widens the anisotropic specular alpha by screen-space normal/roughness
        // variance to stop procedural-roughness fireflies (see patchSpecularAA in
        // mtlx-engine.js). Scene-only, recompiles every material when toggled
        // (see setSceneSpecularAA); default on.
        const [specularAAOn, setSpecularAAOn] = React.useState(true);
        const [displayExposure, setDisplayExposureState] = React.useState(
            () => (window.getDisplayExposure ? window.getDisplayExposure() : 0)
        );
        // Analytic lights imported from the stage. Count comes from the
        // handle once a stage is loaded; the two controls are live.
        // Diagnostic groups: errors and warnings open, info and the source
        // list collapsed, since those are the long ones.
        const [diagOpen, setDiagOpen] = React.useState({ error: true, warning: true, info: false, materials: false });
        const [stageLightInfo, setStageLightInfo] = React.useState({ count: 0, enabled: true, ev: 0 });
        const [stageLightsOn, setStageLightsOn] = React.useState(true);
        const [stageLightsEv, setStageLightsEv] = React.useState(0);
        const [presentation, setPresentation] = React.useState(SCENE_PRESENTATION_DEFAULT);
        // Off by default (2026-09-22): matches storedSceneShadows and the
        // "default" quality level's shadows value below.
        const [shadowsOn, setShadowsOn] = React.useState(false);
        // Off by default (2026-09-22): matches storedSceneAo and the
        // "default" quality level's ao value below.
        const [aoOn, setAoOn] = React.useState(false);
        const [aoStrength, setAoStrength] = React.useState(0.85);
        // Default on (v3, 2026-09-20): see storedSceneBounce in
        // js/usd-scene-renderer.js. Strength default must track
        // QUALITY_BOUNCE_STRENGTH_DEFAULT or a fresh profile opens with a
        // stray dot and Reset already enabled.
        const [bounceOn, setBounceOn] = React.useState(true);
        const [bounceStrength, setBounceStrength] = React.useState(QUALITY_BOUNCE_STRENGTH_DEFAULT);
        // Screen-space reflections are parked: rows hidden, state and handlers kept.
        const SSR_ROWS_HIDDEN = true;
        const [ssrOn, setSsrOn] = React.useState(false);
        const [ssrStrength, setSsrStrength] = React.useState(1);
        const [ssrMaxRoughness, setSsrMaxRoughness] = React.useState(0.5);
        // Off by default (2026-09-22): matches storedSceneSkyVis and the
        // "default" quality level's skyVis value below.
        const [skyVisOn, setSkyVisOn] = React.useState(false);
        const [skyVisStrength, setSkyVisStrength] = React.useState(1);
        // Local reflections: off by default (storedSceneLocalReflections in
        // js/usd-scene-renderer.js), never on in an embed.
        const [localEnvOn, setLocalEnvOn] = React.useState(false);
        const [localEnvStrength, setLocalEnvStrength] = React.useState(1);
        // Render settings popover: replaces the old sidebar Rendering card.
        // Tab is persisted so a reopen lands where the user left it.
        const RENDER_TAB_KEY = 'mtlx_scene_render_settings_tab';
        const RENDER_TABS = ['display', 'lighting', 'effects', 'geometry'];
        const [renderSettingsOpen, setRenderSettingsOpen] = React.useState(false);
        const [renderSettingsMounted, setRenderSettingsMounted] = React.useState(false);
        // Quality draft (staged governed values, null until first touched),
        // the live-control snapshot taken when the popover opens (for
        // Cancel), and the label shown while an Apply is in flight.
        const [qualityDraft, setQualityDraft] = React.useState(null);
        const [liveSnapshot, setLiveSnapshot] = React.useState(null);
        const [presetApplying, setPresetApplying] = React.useState(null);
        const [renderTab, setRenderTab] = React.useState(() => {
            try { const v = localStorage.getItem(RENDER_TAB_KEY); return RENDER_TABS.indexOf(v) >= 0 ? v : 'display'; }
            catch (e) { return 'display'; }
        });
        const renderSettingsBtnRef = React.useRef(null);
        const renderSettingsPopRef = React.useRef(null);
        React.useEffect(() => { if (renderSettingsOpen) setRenderSettingsMounted(true); }, [renderSettingsOpen]);
        React.useEffect(() => { try { localStorage.setItem(RENDER_TAB_KEY, renderTab); } catch (e) {} }, [renderTab]);
        useEscapeToClose(() => setRenderSettingsOpen(false), renderSettingsOpen);
        React.useEffect(() => {
            if (!renderSettingsOpen) return undefined;
            const onDown = (e) => {
                if (renderSettingsPopRef.current && renderSettingsPopRef.current.contains(e.target)) return;
                if (renderSettingsBtnRef.current && renderSettingsBtnRef.current.contains(e.target)) return;
                setRenderSettingsOpen(false);
            };
            window.addEventListener('pointerdown', onDown);
            return () => window.removeEventListener('pointerdown', onDown);
        }, [renderSettingsOpen]);
        // Sidebar "Experimental" pill: a small known-issues popover, portaled
        // out of the sidebar's overflow-hidden and clamped to the viewport
        // the same way SettingsDialog in mtlx-ui.jsx anchors below its cog.
        const [knownIssuesOpen, setKnownIssuesOpen] = React.useState(false);
        const knownIssuesBtnRef = React.useRef(null);
        const knownIssuesPopRef = React.useRef(null);
        const [knownIssuesPos, setKnownIssuesPos] = React.useState(null);
        useEscapeToClose(() => setKnownIssuesOpen(false), knownIssuesOpen);
        React.useLayoutEffect(() => {
            if (!knownIssuesOpen) return undefined;
            const rect = knownIssuesBtnRef.current ? knownIssuesBtnRef.current.getBoundingClientRect() : null;
            if (rect) {
                const left = Math.max(8, Math.min(rect.left, window.innerWidth - KNOWN_ISSUES_POPOVER_W - 8));
                setKnownIssuesPos({ left, top: Math.min(rect.bottom + 4, window.innerHeight - 8) });
            }
            return undefined;
        }, [knownIssuesOpen]);
        React.useEffect(() => {
            if (!knownIssuesOpen) return undefined;
            const onDown = (e) => {
                if (knownIssuesPopRef.current && knownIssuesPopRef.current.contains(e.target)) return;
                if (knownIssuesBtnRef.current && knownIssuesBtnRef.current.contains(e.target)) return;
                setKnownIssuesOpen(false);
            };
            window.addEventListener('pointerdown', onDown);
            return () => window.removeEventListener('pointerdown', onDown);
        }, [knownIssuesOpen]);
        // Mirrors the boolean keys js/usd-scene-renderer.js reads at creation
        // (storedSceneAo etc.) so a toggle flipped before load is honored by
        // the next renderer instance without editing that file.
        const writeStoredSceneBool = (key, enabled) => { try { localStorage.setItem(key, enabled ? '1' : '0'); } catch (e) {} };
        const [transparentPrims, setTransparentPrims] = React.useState([]);
        // Scene owns its transparency preference. It intentionally does not
        // mirror the shared Viewer Force Transparency setting: Scene defaults
        // to authored transmission/opacity and has its own explicit opt-out.
        const [sceneTransparency, setSceneTransparencyState] = React.useState(
            () => (typeof window.getUsdSceneTransparency === 'function' ? !!window.getUsdSceneTransparency() : true)
        );
        React.useEffect(() => {
            const onSceneTransparencyChanged = (e) => {
                const detail = e && e.detail;
                const value = detail && detail.value != null ? detail.value : detail && detail.enabled;
                if (value == null) return;
                const enabled = !!value;
                setSceneTransparencyState(enabled);
                // The transparent-prims list only exists while Scene
                // transparency is enabled, so refresh it from the live handle.
                const fn = handleRef.current && handleRef.current.getTransparentPrims;
                if (!enabled) setTransparentPrims([]);
                else if (typeof fn === 'function') { try { setTransparentPrims(fn()); } catch (err) { /* not rendered yet */ } }
            };
            window.addEventListener('mtlx-usd-scene-transparency', onSceneTransparencyChanged);
            return () => window.removeEventListener('mtlx-usd-scene-transparency', onSceneTransparencyChanged);
        }, []);
        // GPU-convolved diffuse irradiance vs. the SH l<=2 fit (js/mtlx-engine.js
        // DIFFUSE_ENV_METHOD). Not generation-affecting: flipping it only
        // rebinds a sampler through applyMaterialEnvironment, no recompile.
        const [diffuseEnvConvolve, setDiffuseEnvConvolveState] = React.useState(
            () => (typeof window.getDiffuseEnvMethod === 'function' ? window.getDiffuseEnvMethod() !== 'sh' : true)
        );
        React.useEffect(() => {
            const onSettingsChanged = (e) => {
                const detail = e && e.detail;
                if (!detail || detail.key !== 'diffuseEnvMethod') return;
                setDiffuseEnvConvolveState(detail.value !== 'sh');
            };
            window.addEventListener('mtlx-settings-changed', onSettingsChanged);
            return () => window.removeEventListener('mtlx-settings-changed', onSettingsChanged);
        }, []);
        const envSettingsRef = React.useRef({ rotation: 0, exposureLinear: 1, backdrop: 'studio', autoRotate: false });
        const [recordOpen, setRecordOpen] = React.useState(false);
        const envOverrideRef = React.useRef(null);
        // True while envRotation holds an authored dome rotationDeg rather
        // than a plain engine-degree value; gates the yaw conversion below.
        const domeRotationActiveRef = React.useRef(false);
        const currentEnvironmentRef = React.useRef(null);
        const containerRef = React.useRef(null);
        const viewportRef = containerRef;
        const activeRef = React.useRef(active);
        activeRef.current = active;
        // Sleeping the view also drops the preview panel (its own live
        // viewer) by remounting it empty; the next double-click rebuilds it.
        const [previewEpoch, setPreviewEpoch] = React.useState(0);
        React.useEffect(() => {
            if (active) return;
            setPreviewOpen(false);
            setPreviewPayload(null);
            setPreviewEpoch((epoch) => epoch + 1);
        }, [active]);
        const abortRef = React.useRef(null);
        const mountedRef = React.useRef(true);
        const filesRef = React.useRef(files);
        const handleRef = React.useRef(null);
        const generationRef = React.useRef(0);
        const environmentGenerationRef = React.useRef(0);
        // Tracks the whole-load fraction across both the worker and renderer
        // phases of one load (they share a generation id); a new generation
        // resets it to 0 so the bar never carries over from a prior load.
        const progressFractionGenRef = React.useRef(null);
        const progressFractionRef = React.useRef(0);
        const [rotating, toggleRotating] = useViewToggle(handleRef, 'setAutoRotate', false);
        filesRef.current = files;
        envSettingsRef.current = { rotation: envRotation, exposureLinear: envExposureLinear, backdrop, autoRotate: rotating };
        const updateProgress = (value, generation) => {
            // Perf-only: records every progress event (loader worker phases
            // AND renderer phases) with a timestamp, for the load-timeline
            // harness. Zero cost when MTLX_PERF_LOG is off.
            if (window.MTLX_PERF_LOG && value && typeof value === 'object') {
                window.__mtlxScenePhases = window.__mtlxScenePhases || [];
                window.__mtlxScenePhases.push({ phase: value.phase, status: value.status, t: performance.now() });
            }
            if (!mountedRef.current || (generation != null && generation !== generationRef.current)) return;
            if (progressFractionGenRef.current !== generation) { progressFractionGenRef.current = generation; progressFractionRef.current = 0; }
            const wholeFraction = usdSceneProgressFraction(value, progressFractionRef.current);
            progressFractionRef.current = wholeFraction;
            setProgress(progressValue(value, wholeFraction));
        };

        React.useEffect(() => () => {
            mountedRef.current = false;
            if (abortRef.current) abortRef.current.abort();
            if (handleRef.current && typeof handleRef.current.dispose === 'function') handleRef.current.dispose();
            handleRef.current = null;
            window.__mtlxUsdSceneHandle = null;
        }, []);

        // Compact-mode auto-collapse, same idiom as js/viewer-app.jsx.
        const prevNarrowRef = React.useRef(narrow);
        const preNarrowOpenRef = React.useRef(true);
        React.useEffect(() => {
            const was = prevNarrowRef.current;
            prevNarrowRef.current = narrow;
            if (narrow === was) return;
            if (narrow) {
                preNarrowOpenRef.current = sidebarOpenRef.current;
                setSidebarOpen(false);
            } else {
                setSidebarOpen(preNarrowOpenRef.current);
            }
        }, [narrow]);

        React.useEffect(() => {
            const onDisplayExposure = () => {
                if (window.getDisplayExposure) setDisplayExposureState(window.getDisplayExposure());
            };
            window.addEventListener('mtlx-display-exposure', onDisplayExposure);
            return () => window.removeEventListener('mtlx-display-exposure', onDisplayExposure);
        }, []);
        const pickDisplayTransform = (mode) => {
            setDisplayTransformState(mode);
            callHandle('setSceneDisplayTransform', mode);
        };
        const pickMaterialWorkspace = (space) => {
            setMaterialWorkspaceState(space);
            callHandle('setSceneMaterialWorkspace', space);
        };
        const applyDisplayExposure = (raw) => {
            const value = Math.max(-8, Math.min(8, Number(raw)));
            if (!Number.isFinite(value)) return;
            setDisplayExposureState(value);
            if (window.setDisplayExposure) window.setDisplayExposure(value);
        };

        const applyChosenFiles = async (next, generation) => {
            if (!mountedRef.current || generation !== generationRef.current) return;
            setFiles(next);
            const { path: preferredRoot, ignoredModelRoots } = await pickDefaultRootLayer(next);
            if (!mountedRef.current || generation !== generationRef.current) return;
            setRootPath(preferredRoot);
            setIgnoredModelRoots(ignoredModelRoots);
            setRootTouched(false);
            setStage(null);
            setStatus(next.length ? 'ready-to-load' : 'idle');
            setError('');
            // A root only auto-loads when one could actually be determined;
            // an empty result (no candidates, or an unresolved fallback)
            // leaves today's behavior of waiting on an explicit pick.
            if (preferredRoot) await load(next, preferredRoot);
        };
        const chooseFiles = async (list) => {
            const generation = ++generationRef.current;
            if (abortRef.current) abortRef.current.abort();
            if (handleRef.current && handleRef.current.dispose) handleRef.current.dispose();
            handleRef.current = null; setHandle(null); setStage(null);
            window.__mtlxUsdSceneHandle = null;
            const next = await readFiles(list);
            applyChosenFiles(next, generation);
        };
        const chooseFilesFromMap = async (map) => {
            const generation = ++generationRef.current;
            if (abortRef.current) abortRef.current.abort();
            if (handleRef.current && handleRef.current.dispose) handleRef.current.dispose();
            handleRef.current = null; setHandle(null); setStage(null);
            window.__mtlxUsdSceneHandle = null;
            applyChosenFiles(filesFromMap(map), generation);
        };
        const load = async (loadFiles = filesRef.current, loadRoot = rootPath) => {
            if (!loadRoot) { setError('Select one root layer before loading.'); setStatus('error'); return; }
            // js/usd-scene-sources.js tells a glTF/OBJ root apart from a
            // USD one; its loaders resolve to the same neutral stage
            // payload, so everything downstream stays identical either way.
            const sources = window.MtlxSceneSources;
            const kind = (sources && typeof sources.detectRootKind === 'function') ? sources.detectRootKind(loadRoot) : 'usd';
            const loader = kind === 'gltf' ? (sources && sources.loadGltfStage)
                : kind === 'obj' ? (sources && sources.loadObjStage)
                : apiFunction('loadUsdStage');
            if (typeof loader !== 'function') { setError('Scene loader is unavailable in this build.'); setStatus('error'); return; }
            const generation = ++generationRef.current;
            if (abortRef.current) abortRef.current.abort();
            const controller = new AbortController();
            abortRef.current = controller;
            if (handleRef.current && typeof handleRef.current.dispose === 'function') handleRef.current.dispose();
            handleRef.current = null; setHandle(null); setStage(null); setError(''); setStatus('loading');
            window.__mtlxUsdSceneHandle = null;
            try {
                // subdivisionLevel/triangleLimits are USD-only knobs; a
                // glTF/OBJ stage arrives already tessellated, so the model
                // loaders simply ignore the two fields.
                const result = await loader({ files: loadFiles, rootPath: loadRoot, signal: controller.signal, subdivisionLevel: subdivisionLevelRef.current, triangleLimits: triangleLimitsRef.current, onProgress: (value) => updateProgress(value, generation) });
                if (!mountedRef.current || controller.signal.aborted || generation !== generationRef.current) return;
                setStage(result); setStatus('loaded');
            } catch (e) {
                if (!mountedRef.current || controller.signal.aborted || generation !== generationRef.current || e && e.name === 'AbortError') return;
                setError(String(e && e.message || e)); setStatus('error');
            }
        };
        const loadExample = async () => {
            const generation = ++generationRef.current;
            if (abortRef.current) abortRef.current.abort();
            if (handleRef.current && handleRef.current.dispose) handleRef.current.dispose();
            handleRef.current = null; setHandle(null); setStage(null);
            window.__mtlxUsdSceneHandle = null;
            setStatus('loading-example'); setError('');
            try {
                const loaded = await Promise.all(EXAMPLE_FILES.map(async (path) => {
                    const response = await fetch(path, { cache: 'no-store' });
                    if (!response.ok) throw new Error('Example asset failed to load: ' + path + ' (' + response.status + ')');
                    return { path, data: await response.arrayBuffer() };
                }));
                if (!mountedRef.current || generation !== generationRef.current) return;
                setFiles(loaded); setRootPath(EXAMPLE_ROOT); setRootTouched(true); await load(loaded, EXAMPLE_ROOT);
            } catch (e) { if (mountedRef.current && generation === generationRef.current) { setError(String(e && e.message || e)); setStatus('error'); } }
        };
        React.useEffect(() => {
            if (!stage || !containerRef.current) return undefined;
            if (handleRef.current && handleRef.current.__sceneStage !== stage) {
                handleRef.current.dispose && handleRef.current.dispose();
                handleRef.current = null; setHandle(null);
                window.__mtlxUsdSceneHandle = null;
            }
            if (!active) {
                if (handleRef.current && handleRef.current.setActive) handleRef.current.setActive(false);
                return undefined;
            }
            if (handleRef.current && handleRef.current.setActive) {
                handleRef.current.setActive(true);
                return undefined;
            }
            let live = true;
            let adopted = false;
            let created = null;
            const rendererGeneration = generationRef.current;
            const rendererController = abortRef.current;
            const renderer = apiFunction('createMtlxSceneView');
            if (typeof renderer !== 'function') { setError('USD scene renderer is unavailable in this build.'); setStatus('error'); return undefined; }
            (async () => {
                try {
                    const version = window.MtlxAssets && window.MtlxAssets.MTLX_DEFAULT_VERSION || window.MTLX_DEFAULT_VERSION;
                    // A retained scene handle survives route visibility pauses
                    // after adoption. During initial construction, the local
                    // effect guard still cancels work when the route leaves.
                    const nextHandle = await renderer({ container: containerRef.current, stage, files, version, displacementSubdivision: displacementSubdivisionRef.current, triangleLimits: triangleLimitsRef.current, onProgress: (value) => updateProgress(value, rendererGeneration), isMounted: () => mountedRef.current && generationRef.current === rendererGeneration && !rendererController?.signal?.aborted && (adopted || (live && active)) });
                    created = nextHandle;
                    if (!live || !mountedRef.current || !active || generationRef.current !== rendererGeneration || rendererController?.signal?.aborted) { if (nextHandle && nextHandle.dispose) nextHandle.dispose(); return; }
                    nextHandle.__sceneStage = stage;
                    adopted = true;
                    handleRef.current = nextHandle;
                    window.__mtlxUsdSceneHandle = nextHandle; // test and console access to the live scene handle.
                    const settings = envSettingsRef.current;
                    // A stage that ships a dome light has already seeded the
                    // renderer with its own environment, rotation and exposure.
                    // Mirror those into the card instead of replaying the
                    // card's defaults over them; a user import still wins.
                    if (nextHandle.getShadows) setShadowsOn(nextHandle.getShadows().enabled);
                    if (nextHandle.getPresentation) setPresentation(nextHandle.getPresentation());
                    if (nextHandle.getSceneDisplayTransform) setDisplayTransformState(nextHandle.getSceneDisplayTransform());
                    if (nextHandle.getSceneMaterialWorkspace) setMaterialWorkspaceState(nextHandle.getSceneMaterialWorkspace());
                    if (nextHandle.getSceneSpecularAA) setSpecularAAOn(nextHandle.getSceneSpecularAA());
                    if (nextHandle.getSkyVisibility) {
                        const sky = nextHandle.getSkyVisibility();
                        setSkyVisOn(sky.enabled);
                        setSkyVisStrength(sky.strength);
                    }
                    if (nextHandle.getAmbientOcclusion) {
                        const ao = nextHandle.getAmbientOcclusion();
                        setAoOn(ao.enabled);
                        setAoStrength(ao.strength);
                    }
                    if (nextHandle.getSceneBounce) {
                        const bounce = nextHandle.getSceneBounce();
                        setBounceOn(bounce.enabled);
                        setBounceStrength(bounce.strength);
                    }
                    if (nextHandle.getScreenSpaceReflections) {
                        const ssr = nextHandle.getScreenSpaceReflections();
                        setSsrOn(ssr.enabled);
                        setSsrStrength(ssr.strength);
                        setSsrMaxRoughness(ssr.maxRoughness);
                    }
                    if (nextHandle.getLocalReflections) {
                        const localEnv = nextHandle.getLocalReflections();
                        setLocalEnvOn(localEnv.enabled);
                        setLocalEnvStrength(localEnv.strength);
                    }
                    const transparencyEnabled = typeof window.getUsdSceneTransparency === 'function'
                        ? !!window.getUsdSceneTransparency() : sceneTransparency;
                    if (nextHandle.getTransparentPrims && transparencyEnabled) {
                        try { setTransparentPrims(nextHandle.getTransparentPrims()); } catch (e) { /* pre-render */ }
                    }
                    if (nextHandle.getStageLights) {
                        const info = nextHandle.getStageLights();
                        setStageLightInfo(info);
                        setStageLightsOn(info.enabled);
                        setStageLightsEv(info.ev);
                    }
                    const dome = nextHandle.getDomeLight ? nextHandle.getDomeLight() : null;
                    const useDome = !!dome && !envOverrideRef.current;
                    if (useDome) {
                        setEnvFileName(dome.fileName || 'Stage dome light');
                        setEnvRotation(Math.round(dome.rotationDeg));
                        setEnvExposureLinear(dome.exposure);
                        domeRotationActiveRef.current = true;
                    } else {
                        domeRotationActiveRef.current = false;
                        callHandle('setEnvRotation', settings.rotation * Math.PI / 180);
                        callHandle('setEnvExposure', settings.exposureLinear);
                    }
                    callHandle('setBackdrop', settings.backdrop);
                    callHandle('setAutoRotate', settings.autoRotate);
                    if (currentEnvironmentRef.current && !useDome) callHandle('setEnvironment', currentEnvironmentRef.current);
                    setHandle(nextHandle); setStatus('rendered');
                    // Apply the chosen camera up front instead of framing
                    // first, so the view never visibly jumps; applyCamera
                    // already falls back to frameAll when the path is missing.
                    const initialCameraPath = defaultCameraPathFor(stage && stage.cameras);
                    if (initialCameraPath && nextHandle.applyCamera) nextHandle.applyCamera(initialCameraPath);
                    else if (nextHandle && nextHandle.frameAll) nextHandle.frameAll();
                } catch (e) { if (live && mountedRef.current && generationRef.current === rendererGeneration && !rendererController?.signal?.aborted) { setError(String(e && e.message || e)); setStatus('error'); } }
            })();
            return () => { live = false; };
        }, [stage, active]);
        React.useEffect(() => {
            if (!containerRef.current || !window.ResizeObserver) return undefined;
            const observer = new ResizeObserver(() => { if (handle && handle.resize) handle.resize(); });
            observer.observe(containerRef.current); return () => observer.disconnect();
        }, [handle]);

        // Double-click a mesh to open its material's graph + shaderball
        // preview. A dblclick within 4px of its own pointerdown counts as a
        // click on the viewport; one starting inside the open panel does not.
        React.useEffect(() => {
            const container = containerRef.current;
            if (!container || !handle) return undefined;
            const down = { x: 0, y: 0, t: 0 };
            // Diagnostics: every attempt lands in window.__mtlxUsdSceneDoubleClicks
            // (last 40) and a failure shows its reason in the viewport.
            const log = (entry) => {
                const list = (window.__mtlxUsdSceneDoubleClicks = window.__mtlxUsdSceneDoubleClicks || []);
                list.push(Object.assign({ t: Math.round(performance.now()) }, entry));
                if (list.length > 40) list.splice(0, list.length - 40);
                if (entry.event === 'dblclick') console.debug('[usd-scene] double-click ' + entry.reason, entry);
            };
            const onPointerDown = (e) => {
                down.x = e.clientX; down.y = e.clientY; down.t = performance.now();
                log({ event: 'pointerdown', x: e.clientX, y: e.clientY, button: e.button, pointerType: e.pointerType, target: e.target && e.target.tagName });
            };
            const onDblClick = (e) => {
                const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
                const base = { event: 'dblclick', x: e.clientX, y: e.clientY, moved: Math.round(moved), sinceDown: Math.round(performance.now() - down.t), target: e.target && e.target.tagName };
                const fail = (reason, extra) => { log(Object.assign({ reason }, base, extra || {})); showDoubleClickNote(DOUBLE_CLICK_NOTES[reason] || reason); };
                if (moved > 4) return fail('moved');
                if (previewPanelRef.current && previewPanelRef.current.contains(e.target)) return log(Object.assign({ reason: 'in-panel' }, base));
                if (typeof handle.pickAt !== 'function' || typeof handle.getMaterialDocument !== 'function') return fail('no-api');
                const hit = handle.pickAt(e.clientX, e.clientY);
                if (!hit) return fail('no-hit');
                if (!hit.materialPath) return fail('no-material', { hit });
                const doc = handle.getMaterialDocument(hit.materialPath);
                if (!doc) return fail('no-document', { hit });
                log(Object.assign({ reason: 'ok' }, base, { hit: { primPath: hit.primPath, materialPath: hit.materialPath } }));
                const bounds = container.getBoundingClientRect();
                setPreviewPayload(Object.assign({ primPath: hit.primPath, materialName: hit.materialName }, doc));
                setPreviewAnchor({ x: e.clientX - bounds.left, y: e.clientY - bounds.top });
                setPreviewOpen(true);
            };
            container.addEventListener('pointerdown', onPointerDown);
            container.addEventListener('dblclick', onDblClick);
            return () => {
                container.removeEventListener('pointerdown', onPointerDown);
                container.removeEventListener('dblclick', onDblClick);
            };
        }, [handle]);

        // Page-wide drag & drop: files can drop anywhere, not just a sidebar
        // drop zone. The engine's readDroppedItems (js/mtlx-engine.js:880,
        // used inside useWindowFileDrop) preserves nested directory-relative
        // paths, which the USD loader needs, so no local walker is kept here.
        useWindowFileDrop({
            activeRef,
            onFiles: (map) => { chooseFilesFromMap(map); },
            onDragState: setDragOver,
        });

        const candidates = rootCandidates(files);
        const meshes = stageMeshes(stage);
        const cameras = Array.isArray(stage && stage.cameras) ? stage.cameras : [];
        const materials = stageMaterials(stage);
        // A USD root layer always wins over a co-uploaded glTF/OBJ root; the
        // ignored model roots surface here as [info], the same tag prefix
        // severityOf() below already recognizes.
        const ignoredRootWarnings = ignoredModelRoots.map((path) => '[info] Ignored model root (a USD root layer was found): ' + path);
        const warningDetails = warningRecords(materialWarningList(stage).concat(ignoredRootWarnings).concat(handle && Array.isArray(handle.warnings) ? handle.warnings.map(String) : []));
        const warnings = warningDetails.map((record) => record.label);
        // Diagnostics carry no severity of their own, so classify by wording:
        // anything that stopped working is an error, anything that merely
        // reports what we did is info, and the rest stays a warning.
        const severityOf = (text) => {
            const value = String(text || '');
            // An explicit tag from the producer always wins; the wording rules
            // below are only a fallback for messages that carry no tag.
            if (/^\[info\]/.test(value)) return 'info';
            if (/^\[error\]/.test(value)) return 'error';
            if (/(failed|error|could not|cannot|unsupported|invalid|aborted)/i.test(value)) return 'error';
            if (/(applied as the environment|approximated as a point|loaded from|imported from|skipped)/i.test(value)) return 'info';
            return 'warning';
        };
        // One reusable disclosure row: chevron, icon, label, count badge and a
        // copy button that puts the whole group on the clipboard.
        const DiagGroup = ({ id, icon, tone, label, lines, children }) => {
            const open = !!diagOpen[id];
            const [copied, setCopied] = React.useState(false);
            const copy = (event) => {
                event.stopPropagation();
                const text = lines.join('\n');
                const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1200); };
                if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => {});
                else {
                    // Clipboard API needs a secure context; fall back so this
                    // still works when the site is served over plain http.
                    const area = document.createElement('textarea');
                    area.value = text; document.body.appendChild(area); area.select();
                    try { document.execCommand('copy'); done(); } catch (e) { /* blocked */ }
                    document.body.removeChild(area);
                }
            };
            return (
                <div className="border-t border-gray-700/70 first:border-t-0">
                    <div className="w-full flex items-center gap-1.5 py-1.5 px-1 -mx-1 rounded hover:bg-gray-800/60">
                        <button
                            type="button"
                            onClick={() => setDiagOpen((prev) => ({ ...prev, [id]: !prev[id] }))}
                            aria-expanded={open}
                            className="flex-1 min-w-0 flex items-center gap-1.5 text-left"
                        >
                            <MtlxIcon name={open ? 'chevron-down' : 'chevron-right'} className="w-3.5 h-3.5 shrink-0 text-gray-500" />
                            <MtlxIcon name={icon} className={'w-3.5 h-3.5 shrink-0 ' + tone} />
                            <span className={'text-[10px] font-semibold uppercase tracking-[0.08em] ' + tone}>{label}</span>
                            <span className="ml-auto text-[10px] font-mono tabular-nums text-gray-400 bg-gray-800 border border-gray-700 rounded-full px-1.5 py-0.5">{lines.length}</span>
                        </button>
                        <button
                            type="button"
                            onClick={copy}
                            title={'Copy all ' + lines.length + ' line(s)'}
                            aria-label={'Copy ' + label}
                            className="shrink-0 p-1 rounded text-gray-500 hover:text-gray-200 hover:bg-gray-700"
                        >
                            <MtlxIcon name={copied ? 'copy-check' : 'copy'} className="w-3.5 h-3.5" />
                        </button>
                    </div>
                    {open ? <div className="pb-2 pl-5 space-y-1">{children}</div> : null}
                </div>
            );
        };
        // Warnings that name a render setting link straight to its tab in the popover;
        // the text must match the path the renderer writes into the warning.
        const SETTING_LINKS = [{ text: 'Render settings > Geometry and Textures > Texture memory', tab: 'geometry' }];
        const renderWarningText = (label) => {
            const link = SETTING_LINKS.find((entry) => label.indexOf(entry.text) !== -1);
            if (!link) return label;
            const at = label.indexOf(link.text);
            return (
                <React.Fragment>
                    {label.slice(0, at)}
                    <button type="button" data-testid="usd-scene-warning-setting-link"
                        onClick={() => { setRenderTab(link.tab); setRenderSettingsOpen(true); }}
                        title="Open this setting"
                        className="underline decoration-dotted underline-offset-2 hover:text-amber-100 text-left break-all">
                        {link.text}
                    </button>
                    {label.slice(at + link.text.length)}
                </React.Fragment>
            );
        };
        const stripTag = (text) => String(text || '').replace(/^\[(?:info|error|warning)\]\s*/, '');
        const grouped = { error: [], warning: [], info: [] };
        warningDetails.forEach((record) => {
            grouped[severityOf(record.raw || record.label)].push(
                Object.assign({}, record, { label: stripTag(record.label), raw: stripTag(record.raw) }));
        });
        const SEVERITY_STYLE = {
            error: { icon: 'alert-triangle', text: 'text-red-300/90', label: 'Errors' },
            warning: { icon: 'alert-triangle', text: 'text-amber-300/90', label: 'Warnings' },
            info: { icon: 'info-circle', text: 'text-gray-400', label: 'Info' },
        };
        // SliderField reports the raw input string through onSlider/onNumber
        // (it has no onChange), so every slider coerces and clamps here.
        const applyAoStrength = (raw) => {
            const value = Math.max(0, Math.min(1, Number(raw)));
            if (!Number.isFinite(value)) return;
            setAoStrength(value);
            callHandle('setAmbientOcclusionStrength', value);
        };
        const applyBounceStrength = (raw) => {
            const value = Math.max(0, Math.min(1, Number(raw)));
            if (!Number.isFinite(value)) return;
            setBounceStrength(value);
            callHandle('setSceneBounceStrength', value);
        };
        const applySsrStrength = (raw) => {
            const value = Math.max(0, Math.min(1, Number(raw)));
            if (!Number.isFinite(value)) return;
            setSsrStrength(value);
            callHandle('setScreenSpaceReflectionStrength', value);
        };
        const applySsrMaxRoughness = (raw) => {
            const value = Math.max(0.05, Math.min(1, Number(raw)));
            if (!Number.isFinite(value)) return;
            setSsrMaxRoughness(value);
            callHandle('setScreenSpaceReflectionMaxRoughness', value);
        };
        const applySkyVisStrength = (raw) => {
            const value = Math.max(0, Math.min(1, Number(raw)));
            if (!Number.isFinite(value)) return;
            setSkyVisStrength(value);
            callHandle('setSkyVisibilityStrength', value);
        };
        const applyLocalEnvStrength = (raw) => {
            const value = Math.max(0, Math.min(1, Number(raw)));
            if (!Number.isFinite(value)) return;
            setLocalEnvStrength(value);
            callHandle('setLocalReflectionStrength', value);
        };
        const applyStageLightsEv = (raw) => {
            const value = Math.max(-8, Math.min(8, Number(raw)));
            if (!Number.isFinite(value)) return;
            setStageLightsEv(value);
            callHandle('setStageLightsEv', value);
        };
        const callHandle = (name, ...args) => {
            const fn = handleRef.current && handleRef.current[name];
            if (typeof fn !== 'function') return false;
            try { fn(...args); return true; } catch (e) { setError(String(e && e.message || e)); return false; }
        };
        const refreshPresentation = () => {
            const getter = handleRef.current && handleRef.current.getPresentation;
            if (typeof getter !== 'function') return;
            try { setPresentation(getter()); } catch (e) {}
        };
        const updatePresentation = (patch) => {
            if (callHandle('setPresentation', patch)) refreshPresentation();
        };
        const resetPresentation = () => updatePresentation({ reset: true });
        const disposeUnusedEnvironment = (env) => {
            const seen = new Set();
            ['radiance', 'irradiance', 'background'].forEach((name) => {
                const texture = env && env[name];
                if (!texture || seen.has(texture) || typeof texture.dispose !== 'function') return;
                seen.add(texture);
                try { texture.dispose(); } catch (e) {}
            });
        };
        const importEnvironment = async (list) => {
            const generation = ++environmentGenerationRef.current;
            const file = list && list[0];
            if (!file) return;
            const loader = apiFunction('loadEnvironmentFromFile');
            if (typeof loader !== 'function') { setEnvImportError('Environment import is unavailable in this build.'); return; }
            setEnvImportError(null);
            try {
                const env = await loader(file.data || file);
                if (!mountedRef.current || generation !== environmentGenerationRef.current) { disposeUnusedEnvironment(env); return; }
                // setEnvOverride now broadcasts to every LIVE_VIEWS member
                // (the Scene handle joined that registry at creation), so
                // the manual callHandle('setEnvironment', env) this used to
                // need right after is redundant.
                if (apiFunction('setEnvOverride')) apiFunction('setEnvOverride')(env);
                envOverrideRef.current = env;
                currentEnvironmentRef.current = env;
                domeRotationActiveRef.current = false;
                setEnvFileName(file.name || file.path || 'Imported environment');
            } catch (e) { if (mountedRef.current && generation === environmentGenerationRef.current) setEnvImportError(String(e && e.message || e)); }
        };
        const clearImportedEnvironment = async () => {
            const generation = ++environmentGenerationRef.current;
            envOverrideRef.current = null;
            currentEnvironmentRef.current = null;
            setEnvImportError(null);
            const reset = apiFunction('setEnvOverride');
            if (reset) reset(null);
            const getter = apiFunction('getEnvironment');
            if (getter) { try { const env = await getter(); if (mountedRef.current && generation === environmentGenerationRef.current) { currentEnvironmentRef.current = env; callHandle('setEnvironment', env); } } catch (e) {} }
            if (mountedRef.current && generation === environmentGenerationRef.current) setEnvFileName('');
        };
        const resetEnvironment = async () => {
            const generation = ++environmentGenerationRef.current;
            envOverrideRef.current = null;
            currentEnvironmentRef.current = null;
            setEnvImportError(null);
            const reset = apiFunction('setEnvOverride');
            if (reset) reset(null);
            const getter = apiFunction('getEnvironment');
            let env = null;
            if (getter) { try { env = await getter(); } catch (e) {} }
            if (!mountedRef.current || generation !== environmentGenerationRef.current) return;
            // Reset means "back to how this stage was authored", so a stage
            // that supplied a dome light returns to the dome, not to the site
            // default environment.
            const dome = handleRef.current && handleRef.current.getDomeLight && handleRef.current.getDomeLight();
            if (dome && callHandle('applyDomeLight')) {
                currentEnvironmentRef.current = null;
                setEnvFileName(dome.fileName || 'Stage dome light');
                setEnvRotation(Math.round(dome.rotationDeg));
                setEnvExposureLinear(dome.exposure);
                domeRotationActiveRef.current = true;
                setBackdrop('studio'); callHandle('setBackdrop', 'studio');
                return;
            }
            domeRotationActiveRef.current = false;
            if (env) { currentEnvironmentRef.current = env; callHandle('setEnvironment', env); }
            setEnvFileName(''); setEnvRotation(0); setEnvExposureLinear(1); callHandle('setEnvRotation', 0); callHandle('setEnvExposure', 1); setBackdrop('studio'); callHandle('setBackdrop', 'studio');
        };
        // The slider always displays and edits the authored degrees (matching
        // the dome light's own rotationDeg label when one is active); only
        // the value sent to the engine goes through the yaw conversion, so
        // the running rotation stays consistent with what seeded it.
        const applyEnvRotation = (v) => {
            const n = Number(v);
            setEnvRotation(n);
            const engineDeg = domeRotationActiveRef.current ? domeYawDegFromRotation(n) : n;
            callHandle('setEnvRotation', engineDeg * Math.PI / 180);
        };
        const setEnvExposureVal = (linear) => { setEnvExposureLinear(linear); callHandle('setEnvExposure', linear); };
        const cancel = () => { generationRef.current += 1; if (abortRef.current) abortRef.current.abort(); setStatus('cancelled'); setProgress((p) => ({ ...p, message: 'Cancelled' })); };
        const frameAll = () => { if (handle && handle.frameAll) { handle.frameAll(); if (handle.renderNow) handle.renderNow(); } };
        const select = (mesh) => { const path = String(mesh && (mesh.primPath || mesh.path || mesh.name) || ''); setSelectedPrim(path); if (handle && handle.selectPrim) handle.selectPrim(path); if (handle && handle.renderNow) handle.renderNow(); };
        const selectCamera = (value) => {
            setSelectedCamera(value);
            callHandle('applyCamera', value === 'default' ? null : value);
            if (handle && handle.renderNow) handle.renderNow();
        };
        const [isFullscreen, toggleFullscreen] = useFullscreen(viewportRef);
        const rootBasename = rootPath ? rootPath.split('/').pop() : '';
        const takeScreenshot = () => { if (handleRef.current && handleRef.current.snapshot) downloadSnapshot(handleRef.current, rootBasename || 'usd-scene'); };
        const pickTextureMaxSize = (px) => {
            const value = px === Infinity || String(px).toLowerCase() === 'infinity' ? Infinity : Number(px);
            if (!callHandle('setTextureMaxSize', value) && typeof setStoredSceneTextureMaxSize === 'function') {
                setStoredSceneTextureMaxSize(value);
            }
            setTextureSizeTick((t) => t + 1);
        };
        const pickTextureBudgetGib = (gib) => {
            const bytes = Number(gib) * 1024 * 1024 * 1024;
            if (!callHandle('setTextureBudgetBytes', bytes) && typeof setStoredSceneTextureBudgetBytes === 'function') {
                setStoredSceneTextureBudgetBytes(bytes);
            }
            setTextureSizeTick((t) => t + 1);
        };
        const pickSubdivisionLevel = (level) => {
            const next = Number(level);
            setSubdivisionLevel(next);
            subdivisionLevelRef.current = next;
            if (typeof setStoredSceneSubdivisionLevel === 'function') setStoredSceneSubdivisionLevel(next);
            if (files.length && rootPath) load();
        };
        const pickDisplacementSubdivisionOverride = (value) => {
            const next = value === 'follow' ? 'follow' : Number(value);
            setDisplacementSubdivisionOverrideState(next);
            displacementSubdivisionRef.current = next;
            if (typeof setStoredSceneDisplacementSubdivision === 'function') setStoredSceneDisplacementSubdivision(next);
            callHandle('setDisplacementSubdivisionOverride', next);
        };
        const pickTriangleLimits = (enabled) => {
            const next = enabled !== false;
            setTriangleLimitsState(next);
            triangleLimitsRef.current = next;
            if (typeof setStoredSceneTriangleLimits === 'function') setStoredSceneTriangleLimits(next);
            callHandle('setTriangleLimits', next);
            if (files.length && rootPath) load();
        };
        const textureMaxSize = (handle && typeof handle.getTextureMaxSize === 'function')
            ? handle.getTextureMaxSize()
            : (typeof storedSceneTextureMaxSize === 'function' ? storedSceneTextureMaxSize() : 2048);
        const textureBudgetGib = (handle && typeof handle.getTextureBudgetBytes === 'function')
            ? Math.round(handle.getTextureBudgetBytes() / (1024 * 1024 * 1024))
            : Math.round((typeof storedSceneTextureBudgetBytes === 'function' ? storedSceneTextureBudgetBytes() : (1024 * 1024 * 1024)) / (1024 * 1024 * 1024));
        // Referenced so the memo below re-reads getTextureMaxSize() after a
        // mutation that doesn't otherwise touch React state.
        void textureSizeTick;

        // Every governed value, read the same way the popover controls read
        // them today (live handle first, stored fallback otherwise).
        const currentQualityValues = {
            textureMaxSize: Number(textureMaxSize), textureBudgetGib: Number(textureBudgetGib), subdivision: Number(subdivisionLevel),
            shadows: shadowsOn, ao: aoOn, skyVis: skyVisOn, transparency: sceneTransparency,
            displacement: displacementEnabled, displacementSubdivision: displacementSubdivisionOverride,
            triangleLimits, bounce: bounceOn, localReflections: localEnvOn, specularAA: specularAAOn,
        };
        const QUALITY_GOVERNED_KEYS = Object.keys(currentQualityValues);
        // Live keys: every other popover row. Same shape as captureLiveSnapshot
        // below (which just copies this), read straight off React state.
        const currentLiveValues = {
            displayTransform, materialWorkspace, displayExposure, presentation,
            stageLightsOn, stageLightsEv, aoStrength, bounceStrength, skyVisStrength,
            localEnvStrength, ssrOn, ssrStrength, ssrMaxRoughness, diffuseEnvConvolve,
        };
        const ALL_QUALITY_KEYS = QUALITY_GOVERNED_KEYS.concat(LIVE_QUALITY_KEYS);
        // Exact match first (handles Infinity, matching strings/booleans).
        // Numbers compare with an epsilon (slider drift/float rounding).
        // The one object value (presentation) compares field by field over
        // b's keys, never JSON.stringify: key order or an extra field on a
        // (e.g. a hardware-derived flag) must not fake a difference.
        const valuesEqual = (a, b) => {
            if (a === b) return true;
            if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
            if (a && b && typeof a === 'object') return Object.keys(b).every((k) => valuesEqual(a[k], b[k]));
            return false;
        };
        // "Custom" is derived, never stored: the active level is the stored
        // id (inferred by exact match the first time, else 'default'), and
        // overrides are every governed key (staged or live) that no longer
        // matches it.
        const selectedQualityId = (() => {
            let stored = null;
            try { stored = localStorage.getItem(SCENE_QUALITY_STORAGE_KEY); } catch (e) { /* privacy mode */ }
            if (SCENE_QUALITY_LEVELS.some((entry) => entry.id === stored)) return stored;
            const inferred = SCENE_QUALITY_LEVELS.find((level) =>
                QUALITY_GOVERNED_KEYS.every((key) => currentQualityValues[key] === level.values[key])
                && LIVE_QUALITY_KEYS.every((key) => valuesEqual(currentLiveValues[key], level.values[key])));
            return inferred ? inferred.id : 'default';
        })();
        const selectedQualityLevel = SCENE_QUALITY_LEVELS.find((entry) => entry.id === selectedQualityId);
        // One forced-apply dispatcher for Reset and the preset segments
        // (the places that move live keys): reuses each row's own handler.
        const forceLiveValue = (key, value) => {
            if (key === 'displayTransform') return pickDisplayTransform(value);
            if (key === 'materialWorkspace') return pickMaterialWorkspace(value);
            if (key === 'displayExposure') return applyDisplayExposure(value);
            if (key === 'presentation') return updatePresentation(value);
            if (key === 'stageLightsOn') return setStageLightsOnValue(value);
            if (key === 'stageLightsEv') return applyStageLightsEv(value);
            if (key === 'aoStrength') return applyAoStrength(value);
            if (key === 'bounceStrength') return applyBounceStrength(value);
            if (key === 'skyVisStrength') return applySkyVisStrength(value);
            if (key === 'localEnvStrength') return applyLocalEnvStrength(value);
            if (key === 'ssrOn') return setSsrOnValue(value);
            if (key === 'ssrStrength') return applySsrStrength(value);
            if (key === 'ssrMaxRoughness') return applySsrMaxRoughness(value);
            if (key === 'diffuseEnvConvolve') return setDiffuseEnvConvolveValue(value);
        };
        // Shared with restoreLiveSnapshot and forceLiveValue: the three live
        // toggles whose onChange body is more than one call, factored once
        // instead of copied at each of their three call sites.
        const setStageLightsOnValue = (next) => { setStageLightsOn(next); callHandle('setStageLightsEnabled', next); writeStoredSceneBool('mtlx_scene_stage_lights', next); };
        const setSsrOnValue = (next) => { setSsrOn(next); callHandle('setScreenSpaceReflections', next); writeStoredSceneBool('mtlx_scene_ssr', next); };
        const setDiffuseEnvConvolveValue = (next) => {
            setDiffuseEnvConvolveState(next);
            window.setDiffuseEnvMethod && window.setDiffuseEnvMethod(next ? 'convolve' : 'sh');
            if (currentEnvironmentRef.current) callHandle('setEnvironment', currentEnvironmentRef.current);
        };
        // No stage handle yet: matches the persist-only fallback every single
        // governed handler falls back to with no handle (writeStoredSceneBool/
        // setStored*); displacement and transparency are globals, still live.
        const persistSceneSettingsForNextLoad = (diff) => {
            if ('textureMaxSize' in diff && typeof setStoredSceneTextureMaxSize === 'function') setStoredSceneTextureMaxSize(diff.textureMaxSize);
            if ('textureBudgetGib' in diff && typeof setStoredSceneTextureBudgetBytes === 'function') setStoredSceneTextureBudgetBytes(diff.textureBudgetGib * 1024 * 1024 * 1024);
            if ('shadows' in diff) writeStoredSceneBool('mtlx_scene_shadows', diff.shadows);
            if ('ao' in diff) writeStoredSceneBool('mtlx_scene_ao', diff.ao);
            if ('skyVis' in diff) writeStoredSceneBool('mtlx_scene_skyvis', diff.skyVis);
            if ('specularAA' in diff) writeStoredSceneBool('mtlx_scene_specular_aa', diff.specularAA);
            if ('bounce' in diff) writeStoredSceneBool('mtlx_scene_bounce', diff.bounce);
            if ('localReflections' in diff) writeStoredSceneBool('mtlx_scene_local_reflections', diff.localReflections);
            if ('triangleLimits' in diff && typeof setStoredSceneTriangleLimits === 'function') setStoredSceneTriangleLimits(diff.triangleLimits);
            if ('displacementSubdivision' in diff && typeof setStoredSceneDisplacementSubdivision === 'function') setStoredSceneDisplacementSubdivision(diff.displacementSubdivision);
            if ('subdivision' in diff && typeof setStoredSceneSubdivisionLevel === 'function') setStoredSceneSubdivisionLevel(diff.subdivision);
            if ('displacement' in diff && window.setDisplacementEnabled) window.setDisplacementEnabled(diff.displacement);
            if ('transparency' in diff && window.setUsdSceneTransparency) window.setUsdSceneTransparency(diff.transparency);
            return { reload: false, rebuild: false, geometry: false };
        };
        // Shared apply path for the toolbar's immediate preset and the
        // popover's Apply: one applySceneSettings call, state sync, reload
        // only if asked.
        const commitQualitySettings = (diff, id) => {
            if (id) { try { localStorage.setItem(SCENE_QUALITY_STORAGE_KEY, id); } catch (e) { /* privacy mode */ } }
            if (!Object.keys(diff).length) return { reload: false, rebuild: false, geometry: false, reloadPromise: null };
            const result = (handle && typeof handle.applySceneSettings === 'function')
                ? handle.applySceneSettings(diff)
                : persistSceneSettingsForNextLoad(diff);
            if ('textureMaxSize' in diff || 'textureBudgetGib' in diff) setTextureSizeTick((t) => t + 1);
            if ('shadows' in diff) setShadowsOn(diff.shadows);
            if ('ao' in diff) setAoOn(diff.ao);
            if ('skyVis' in diff) setSkyVisOn(diff.skyVis);
            if ('transparency' in diff) setSceneTransparencyState(diff.transparency);
            if ('displacement' in diff) setDisplacementEnabledState(diff.displacement);
            if ('displacementSubdivision' in diff) {
                setDisplacementSubdivisionOverrideState(diff.displacementSubdivision);
                displacementSubdivisionRef.current = diff.displacementSubdivision;
            }
            if ('triangleLimits' in diff) { setTriangleLimitsState(diff.triangleLimits); triangleLimitsRef.current = diff.triangleLimits; }
            if ('bounce' in diff) setBounceOn(diff.bounce);
            if ('localReflections' in diff) setLocalEnvOn(diff.localReflections);
            if ('specularAA' in diff) setSpecularAAOn(diff.specularAA);
            if ('subdivision' in diff) { setSubdivisionLevel(diff.subdivision); subdivisionLevelRef.current = diff.subdivision; }
            const reloadPromise = (result && result.reload && files.length && rootPath) ? load() : null;
            return Object.assign({ reload: false, rebuild: false, geometry: false }, result, { reloadPromise });
        };
        // Draft model for the popover: governed rows edit `qualityDraft`
        // (null until first touched) instead of calling their handlers;
        // nothing reaches the renderer until Apply.
        const draftLevel = qualityDraft ? SCENE_QUALITY_LEVELS.find((entry) => entry.id === qualityDraft.qualityId) : selectedQualityLevel;
        const draftValues = qualityDraft ? qualityDraft.values : currentQualityValues;
        // Value a row actually shows: the draft for a staged key, the live
        // current value for a live key (live keys are never staged).
        const rowValue = (key) => (LIVE_QUALITY_KEYS.includes(key) ? currentLiveValues[key] : draftValues[key]);
        const draftAllOverrides = draftLevel ? ALL_QUALITY_KEYS.filter((key) => !valuesEqual(rowValue(key), draftLevel.values[key])) : [];
        // Staged-only overrides: drives the popover's own segmented control,
        // which only ever stages (never reflects live-key drift).
        const draftStagedOverrides = draftLevel ? QUALITY_GOVERNED_KEYS.filter((key) => draftValues[key] !== draftLevel.values[key]) : [];
        const draftDiff = {};
        QUALITY_GOVERNED_KEYS.forEach((key) => { if (draftValues[key] !== currentQualityValues[key]) draftDiff[key] = draftValues[key]; });
        const draftDirty = Object.keys(draftDiff).length > 0;
        // Enabled whenever ANY key (staged or live) differs from the level.
        const draftResetDirty = draftAllOverrides.length > 0;
        // Dev aid: with mtlxDebugShaders on, print exactly which key(s) made
        // Reset dirty and both of their values, so a report of "Reset is
        // enabled with no dots" can be checked against real data instead of
        // re-deriving this comparison by hand.
        const draftOverridesKey = draftAllOverrides.join(',');
        React.useEffect(() => {
            let debugOn = false;
            try { debugOn = localStorage.getItem('mtlxDebugShaders') === '1'; } catch (e) { /* privacy mode */ }
            if (!debugOn || !draftOverridesKey || !draftLevel) return;
            console.log('[usd-scene] Reset dirty vs "' + draftLevel.id + '":', draftOverridesKey.split(',').map((key) => ({
                key, current: rowValue(key), level: draftLevel.values[key],
            })));
        }, [draftOverridesKey, draftLevel]);
        const draftCost = (typeof describeSceneSettingsCost === 'function')
            ? describeSceneSettingsCost(currentQualityValues, draftDiff)
            : { reload: false, rebuild: false, geometry: false };
        const stageQualityValue = (key, value) => {
            setQualityDraft((d) => {
                const base = d || { qualityId: selectedQualityId, values: { ...currentQualityValues } };
                return { qualityId: base.qualityId, values: { ...base.values, [key]: value } };
            });
        };
        const stageQualityLevel = (id) => {
            const level = SCENE_QUALITY_LEVELS.find((entry) => entry.id === id);
            if (!level) return;
            setQualityDraft({ qualityId: id, values: { ...level.values } });
            // Live keys are never staged (a row's value comes straight off
            // live state, see rowValue above), so a preset pick must force
            // them immediately too — otherwise a row like Sky visibility
            // strength or Stage light intensity keeps its old value while
            // the segmented control already shows the new preset picked.
            // Exactly what Reset already does for live keys.
            LIVE_QUALITY_KEYS.forEach((key) => {
                if (!valuesEqual(currentLiveValues[key], level.values[key])) forceLiveValue(key, level.values[key]);
            });
        };
        const captureLiveSnapshot = () => ({ ...currentLiveValues });
        // Restores every live control through its existing handler (same
        // dispatcher Reset and the toolbar menu use); nothing duplicated here.
        const restoreLiveSnapshot = (snap) => {
            if (!snap) return;
            LIVE_QUALITY_KEYS.forEach((key) => forceLiveValue(key, snap[key]));
        };
        // One editing session per popover visit: taken only when none is in
        // progress, cleared by Apply/Cancel, so close-and-reopen restores
        // from when the session began, not from the last reopen.
        React.useEffect(() => {
            if (renderSettingsOpen && !liveSnapshot) setLiveSnapshot(captureLiveSnapshot());
        }, [renderSettingsOpen, liveSnapshot]);
        const lastCurrentQualityRef = React.useRef(currentQualityValues);
        // currentQualityValues is a fresh object every render, so this still
        // runs each time one of its fields actually changes; the dep array
        // just documents that (and drops the effect on unrelated renders,
        // e.g. a plain slider drag that never touches a governed key).
        React.useEffect(() => {
            const prev = lastCurrentQualityRef.current;
            if (qualityDraft) {
                let next = null;
                QUALITY_GOVERNED_KEYS.forEach((key) => {
                    if (currentQualityValues[key] !== prev[key] && qualityDraft.values[key] === prev[key]) {
                        next = next || { ...qualityDraft.values };
                        next[key] = currentQualityValues[key];
                    }
                });
                if (next) setQualityDraft((d) => (d ? { qualityId: d.qualityId, values: next } : d));
            }
            lastCurrentQualityRef.current = currentQualityValues;
        }, [currentQualityValues, qualityDraft]);
        const applyQualityDraft = () => {
            if (!draftDirty) return;
            // No scene loaded: nothing to reload, recompile or rebuild, so
            // commitQualitySettings already falls through to the persist-only
            // path below; just skip the "Applying ..." label for it too.
            if (hasStage) setPresetApplying(draftStagedOverrides.length ? 'Custom' : (draftLevel ? draftLevel.label : 'Custom'));
            const id = qualityDraft ? qualityDraft.qualityId : selectedQualityId;
            const { reloadPromise } = commitQualitySettings(draftDiff, id);
            const applied = { ...draftValues };
            setQualityDraft({ qualityId: id, values: applied });
            setLiveSnapshot(null); // ends the editing session, live keys were left alone
            if (reloadPromise) reloadPromise.finally(() => setPresetApplying(null));
            else setPresetApplying(null);
        };
        const cancelQualityDraft = () => {
            restoreLiveSnapshot(liveSnapshot);
            setLiveSnapshot(null);
            setQualityDraft(null);
            setRenderSettingsOpen(false);
        };
        // Forces every key (staged and live) to the selected level's values:
        // staged goes into the draft, live goes through forceLiveValue so
        // sliders visibly move right away.
        const resetQualityDraft = () => {
            if (!draftLevel) return;
            const id = qualityDraft ? qualityDraft.qualityId : selectedQualityId;
            setQualityDraft({ qualityId: id, values: { ...draftLevel.values } });
            LIVE_QUALITY_KEYS.forEach((key) => { if (!valuesEqual(currentLiveValues[key], draftLevel.values[key])) forceLiveValue(key, draftLevel.values[key]); });
        };
        // Plain sentence for the footer: nothing when no staged change is
        // pending, else the pending count plus what Apply will actually do.
        const footerHintText = () => {
            const n = Object.keys(draftDiff).length;
            if (!n) return '';
            const count = n + ' change' + (n === 1 ? '' : 's') + '.';
            if (!hasStage) return count + ' Applies when a scene is loaded';
            const action = draftCost.reload ? 'Applying will reload the stage'
                : draftCost.rebuild ? 'Applying will recompile materials'
                : draftCost.geometry ? 'Applying will rebuild geometry'
                : 'Applying will apply instantly';
            return count + ' ' + action;
        };
        const qualitySummaryText = () => {
            const v = draftValues;
            const parts = [
                (v.textureMaxSize === Infinity ? 'Original' : v.textureMaxSize + 'px') + ' textures',
                v.textureBudgetGib + ' GB',
                v.subdivision ? ('subdivision ' + v.subdivision) : 'no subdivision',
                v.displacement ? 'displacement on' : 'displacement off',
                (v.shadows && v.ao) ? 'shadows and ambient occlusion on' : (v.shadows ? 'shadows on' : (v.ao ? 'ambient occlusion on' : 'shadows and ambient occlusion off')),
            ];
            return parts.join(', ');
        };

        const fraction = progress.fraction;
        const phaseLabels = { ...Object.fromEntries(USD_SCENE_LOAD_PHASES.map((entry) => [entry.phase, entry.label])), 'gpu-program': 'Checking GPU programs' };
        const phaseIndex = USD_SCENE_LOAD_PHASES.findIndex((entry) => entry.phase === progress.phase);
        const phaseCount = USD_SCENE_LOAD_PHASES.length;
        const stepPrefix = phaseIndex >= 0 ? ('Step ' + (phaseIndex + 1) + '/' + phaseCount + ': ') : '';
        const progressLabel = stepPrefix + (phaseLabels[progress.phase] || (progress.phase ? progress.phase.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : (status === 'rendered' ? 'Ready' : 'Loading')));
        const progressText = progress.total ? (progress.done + '/' + progress.total) : (/texture|material/i.test(progress.phase) ? '' : progress.message);
        // Second, dimmer overlay line: the current item within the phase.
        const RENDERER_STEP_LABELS = { 'shadow-atlas': 'Building shadow atlas', 'sky-visibility': 'Baking sky visibility', 'occlusion-volume': 'Baking occlusion volume', 'shader-join': 'Finishing shader compiles', 'gpu-program': 'Checking GPU programs', 'first-frame': 'Rendering first frame' };
        const progressDetail = progress.phase === 'renderer' ? (RENDERER_STEP_LABELS[progress.step] || '') : (progress.label || '');
        const busy = status === 'loading' || status === 'loading-example' || status === 'loaded';
        const canTuneEnvironment = !!handle && typeof handle.setEnvRotation === 'function';
        const envSummary = (envRotation === 0 && envExposureLinear === 1)
            ? 'Default environment'
            : Math.round(envRotation) + '°, ' + formatEv(linearToEv(envExposureLinear));
        const renderedPrimCount = (handle && Array.isArray(handle.prims)) ? handle.prims.length : meshes.length;
        const triangleCount = stageTriangleCount(stage);
        const hasStage = !!stage || files.length > 0;

        const RENDER_TAB_LABELS = { display: 'Display', lighting: 'Lighting', effects: 'Effects', geometry: 'Geometry and Textures' };
        // rowDirtyFor closes over this render's draft/live state; it is a
        // plain function (not a component), so recreating it every render
        // only changes a context VALUE, never a component TYPE — passing it
        // through SceneRowCtx keeps ToggleRow/SelectRow/SliderRow/CostBadge
        // (module-scope, hoisted below SCENE_QUALITY_LEVELS) mounted once
        // instead of remounting on every keystroke/drag tick.
        const rowDirtyFor = (settingKey, dirty) => (settingKey
            ? (!!draftLevel && !valuesEqual(rowValue(settingKey), draftLevel.values[settingKey]))
            : !!dirty);
        const renderDisplayTab = () => (
            <React.Fragment>
                <SelectRow
                    label="Display transform" experimental settingKey="displayTransform"
                    title="This is the Scene's own setting; the Material Viewer keeps sRGB."
                    control={
                        <MtlxSelect
                            value={displayTransform}
                            options={['neutral', 'aces', 'srgb', 'lin_rec709']}
                            labels={{ neutral: 'Neutral', aces: 'ACES', srgb: 'sRGB', lin_rec709: 'lin_rec709' }}
                            onChange={pickDisplayTransform}
                            defValue="neutral"
                            size="sm"
                        />
                    }
                    description="How the linear render is encoded for display. Neutral rolls highlights off while keeping hue; sRGB clips at 1.0 and matches the official MaterialX viewer."
                />
                <SelectRow
                    label="Material working space" experimental settingKey="materialWorkspace"
                    title="This is the Scene's own setting; the Material Viewer, Compare, Builder and Graph previews always assume Rec.709."
                    control={
                        <MtlxSelect
                            value={materialWorkspace}
                            options={['rec709', 'acescg']}
                            labels={{ rec709: 'Rec.709', acescg: 'ACEScg' }}
                            onChange={pickMaterialWorkspace}
                            defValue="rec709"
                            size="sm"
                        />
                    }
                    description="How untagged colour numbers in the material (constants, interface values, USD overrides, displayColor) are read. Rec.709 takes them literally; ACEScg treats them as Houdini/Karma's scene-linear space and converts them, which matches Karma's albedo more closely. Tagged textures and colorspace-tagged inputs are unaffected."
                />
                <ToggleRow label="Specular anti-aliasing" experimental checked={draftValues.specularAA}
                    settingKey="specularAA"
                    title={draftValues.specularAA ? 'Turn off geometric specular anti-aliasing' : 'Widen specular roughness where it is changing fast on screen'}
                    onChange={(next) => stageQualityValue('specularAA', next)}
                    description="Widens anisotropic specular roughness by the screen-space variance of the shading normal and of the roughness input, so a fine procedural roughness noise network does not sparkle under a single-sample rasterizer the way a multi-sample path tracer would not. Smooth, constant-roughness materials are essentially unaffected. Staged: takes effect on Apply." />
                <SliderRow settingKey="displayExposure" description="Scales the whole image before the display transform, the way a camera would. The Environment card's exposure only gains the image based lighting.">
                    <SliderField label="Camera exposure" unit="EV" value={displayExposure} min={-8} max={8} step={0.25} decimals={2}
                        defaultValue={draftLevel && draftLevel.values.displayExposure}
                        onSlider={applyDisplayExposure} onNumber={applyDisplayExposure} />
                </SliderRow>
                <ToggleRow label="HDR presentation" checked={!!presentation.enabled} disabled={!handle || !presentation.supported}
                    settingKey="presentation"
                    onChange={(enabled) => updatePresentation({ enabled })}
                    description="Capture scene-linear HDR before a single display transform. Off uses the previous rendering path." />
                <ToggleRow label="Highlight glow" checked={!!presentation.bloom} disabled={!handle || !presentation.enabled || !presentation.supported}
                    dirty={presentation.bloom !== SCENE_PRESENTATION_DEFAULT.bloom}
                    onChange={(bloom) => updatePresentation({ bloom })}
                    description="Optical glow from actual HDR highlights. This does not add lighting to nearby geometry." />
                {presentation.enabled && presentation.bloom && presentation.supported ? (
                    <SliderRow description="Controls how much of the glow highlight bleeds into the image."
                        dirty={!valuesEqual(presentation.strength, SCENE_PRESENTATION_DEFAULT.strength)}>
                        <SliderField label="Glow strength" value={presentation.strength} min={0} max={1} step={0.025} decimals={3}
                            defaultValue={SCENE_PRESENTATION_DEFAULT.strength}
                            onSlider={(strength) => updatePresentation({ strength })} onNumber={(strength) => updatePresentation({ strength })} />
                    </SliderRow>
                ) : null}
                {presentation.supported ? (
                    <SelectRow
                        label="HDR view"
                        title={handle ? undefined : 'Load a stage first'}
                        dirty={(presentation.debugView || 'final') !== SCENE_PRESENTATION_DEFAULT.debugView}
                        control={
                            <MtlxSelect
                                value={presentation.debugView || 'final'}
                                options={['final', 'linear', 'no-bloom', 'highlights', 'bloom', 'composite']}
                                labels={{ final: 'Final', linear: 'Scene linear', 'no-bloom': 'No glow', highlights: 'Highlights', bloom: 'Glow', composite: 'Composite' }}
                                onChange={(debugView) => updatePresentation({ debugView })}
                                defValue="final"
                                size="sm"
                                disabled={!handle}
                            />
                        }
                        description="Temporary inspection view for the HDR presentation pipeline."
                    />
                ) : null}
                {presentation.supported && presentation.enabled && presentation.bloom ? (
                    <React.Fragment>
                        <SliderRow description="Luminance level above which highlights start to glow."
                            dirty={!valuesEqual(presentation.threshold, SCENE_PRESENTATION_DEFAULT.threshold)}>
                            <SliderField label="Glow threshold" value={presentation.threshold} min={0.01} max={1000} step={0.01} decimals={2}
                                defaultValue={SCENE_PRESENTATION_DEFAULT.threshold}
                                onSlider={(threshold) => updatePresentation({ threshold })} onNumber={(threshold) => updatePresentation({ threshold })} />
                        </SliderRow>
                        <SliderRow description="How softly the glow threshold transitions."
                            dirty={!valuesEqual(presentation.knee, SCENE_PRESENTATION_DEFAULT.knee)}>
                            <SliderField label="Glow knee" value={presentation.knee} min={0} max={1} step={0.01} decimals={2}
                                defaultValue={SCENE_PRESENTATION_DEFAULT.knee}
                                onSlider={(knee) => updatePresentation({ knee })} onNumber={(knee) => updatePresentation({ knee })} />
                        </SliderRow>
                        <SliderRow description="How far the glow spreads from each highlight."
                            dirty={!valuesEqual(presentation.radius, SCENE_PRESENTATION_DEFAULT.radius)}>
                            <SliderField label="Glow radius" value={presentation.radius} min={0} max={1} step={0.01} decimals={2}
                                defaultValue={SCENE_PRESENTATION_DEFAULT.radius}
                                onSlider={(radius) => updatePresentation({ radius })} onNumber={(radius) => updatePresentation({ radius })} />
                        </SliderRow>
                    </React.Fragment>
                ) : null}
                {presentation.supported ? (
                    <ButtonRow label="Reset HDR presentation" onClick={resetPresentation} disabled={!handle}
                        title={handle ? undefined : 'Load a stage first'}
                        description={presentation.supported ? 'Scene-linear HDR preserves luminous highlights; this restores its defaults.' : (presentation.reason || 'HDR is unavailable on this device.')} />
                ) : null}
            </React.Fragment>
        );
        const renderLightingTab = () => (
            <React.Fragment>
                <ToggleRow label="Stage lights" experimental checked={stageLightsOn}
                    settingKey="stageLightsOn"
                    title={stageLightsOn ? 'Ignore the lights authored on this stage' : 'Light the stage with its own lights'}
                    onChange={setStageLightsOnValue}
                    description={(stageLightInfo.count || 0) + ' light(s) imported from the stage. Area lights are split into several point samples across their surface, sharing the emitter\'s power.'} />
                {stageLightsOn ? (
                    <SliderRow settingKey="stageLightsEv" description="Scales the imported stage lights' overall brightness.">
                        <SliderField label="Stage light intensity" unit="EV" value={stageLightsEv} min={-8} max={8} step={0.25} decimals={2}
                            defaultValue={draftLevel && draftLevel.values.stageLightsEv}
                            onSlider={applyStageLightsEv} onNumber={applyStageLightsEv} />
                    </SliderRow>
                ) : null}
                <ToggleRow label="Shadows" experimental checked={draftValues.shadows}
                    settingKey="shadows"
                    title={draftValues.shadows ? 'Turn shadows off' : 'Cast shadows from the brightest light'}
                    onChange={(next) => stageQualityValue('shadows', next)}
                    description="Up to 32 shadow faces, packed into one shadow atlas, chosen by the light they deliver to sampled receivers. The atlas is rebuilt when the camera or lighting changes. Staged: takes effect on Apply." />
                <ToggleRow label="Sky visibility" experimental checked={draftValues.skyVis}
                    settingKey="skyVis"
                    title={draftValues.skyVis ? 'Turn baked sky visibility off' : 'Let room geometry block the environment light'}
                    onChange={(next) => stageQualityValue('skyVis', next)}
                    description="Environment light has no visibility term, so a wall does not block the sky and interiors read flat and overlit. This bakes how much sky each part of the stage can see into a coarse volume. Staged: takes effect on Apply." />
                {skyVisOn ? (
                    <SliderRow settingKey="skyVisStrength" description="How strongly the baked sky visibility darkens occluded areas.">
                        <SliderField label="Sky visibility strength" value={skyVisStrength} min={0} max={1} step={0.05} decimals={2}
                            defaultValue={draftLevel && draftLevel.values.skyVisStrength}
                            onSlider={applySkyVisStrength} onNumber={applySkyVisStrength} />
                    </SliderRow>
                ) : null}
            </React.Fragment>
        );
        const renderEffectsTab = () => (
            <React.Fragment>
                <ToggleRow label="Ambient occlusion" experimental checked={draftValues.ao}
                    settingKey="ao"
                    title={draftValues.ao ? 'Turn ambient occlusion off' : 'Occlude environment light in creases and corners'}
                    onChange={(next) => stageQualityValue('ao', next)}
                    description="Environment light reaches every surface equally, including ones facing a wall, which makes interiors read flat. This estimates how much sky each pixel can actually see. Staged: takes effect on Apply." />
                {aoOn ? (
                    <SliderRow settingKey="aoStrength" description="How strongly the estimated occlusion darkens creases and corners.">
                        <SliderField label="Ambient occlusion strength" value={aoStrength} min={0} max={1} step={0.05} decimals={2}
                            defaultValue={draftLevel && draftLevel.values.aoStrength}
                            onSlider={applyAoStrength} onNumber={applyAoStrength} />
                    </SliderRow>
                ) : null}
                <ToggleRow label="Diffuse bounce" experimental checked={draftValues.bounce}
                    settingKey="bounce"
                    title={draftValues.bounce ? 'Turn the baked diffuse bounce off' : 'Bounce blocked sky light back off nearby surfaces'}
                    onChange={(next) => stageQualityValue('bounce', next)}
                    description="Environment light is not reflected back off the room, so shadowed sides and corners lose the light the walls and floor bounce onto them. This bakes a coarse estimate of that bounce and adds it back where the sky is blocked. Staged: takes effect on Apply." />
                {bounceOn ? (
                    <SliderRow settingKey="bounceStrength" description="How strongly the baked bounce term fills back in.">
                        <SliderField label="Diffuse bounce strength" value={bounceStrength} min={0} max={1} step={0.05} decimals={2}
                            defaultValue={draftLevel && draftLevel.values.bounceStrength}
                            onSlider={applyBounceStrength} onNumber={applyBounceStrength} />
                    </SliderRow>
                ) : null}
                <ToggleRow label="Local reflections" experimental checked={draftValues.localReflections}
                    settingKey="localReflections"
                    title={draftValues.localReflections ? 'Turn the local reflection capture off' : 'Reflect the captured studio set instead of only the environment'}
                    onChange={(next) => stageQualityValue('localReflections', next)}
                    description="Reflections only show the environment, so the floor and the wall of a studio set never appear in a metal or a glossy surface. This captures the scene once from the subject and reflects that instead wherever it covers the sky. Staged: takes effect on Apply." />
                {localEnvOn ? (
                    <SliderRow settingKey="localEnvStrength" description="How strongly the captured local reflection blends in.">
                        <SliderField label="Local reflection strength" value={localEnvStrength} min={0} max={1} step={0.05} decimals={2}
                            defaultValue={draftLevel && draftLevel.values.localEnvStrength}
                            onSlider={applyLocalEnvStrength} onNumber={applyLocalEnvStrength} />
                    </SliderRow>
                ) : null}
                {SSR_ROWS_HIDDEN ? null : (<React.Fragment>
                <ToggleRow label="Screen-space reflections" experimental checked={ssrOn}
                    settingKey="ssrOn"
                    title={ssrOn ? 'Turn screen-space reflections off' : 'Reflect the scene colour in specular through a screen-space trace'}
                    onChange={setSsrOnValue}
                    description="Traces a screen-space ray through last frame's colour buffer for a reflection, falling back to the environment when it misses." />
                {ssrOn ? (
                    <React.Fragment>
                        <SliderRow settingKey="ssrStrength" description="How much of the traced reflection blends into specular.">
                            <SliderField label="Reflection strength" value={ssrStrength} min={0} max={1} step={0.05} decimals={2}
                                defaultValue={draftLevel && draftLevel.values.ssrStrength}
                                onSlider={applySsrStrength} onNumber={applySsrStrength} />
                        </SliderRow>
                        <SliderRow settingKey="ssrMaxRoughness" description="Roughest surface that still receives a screen-space reflection.">
                            <SliderField label="Reflection max roughness" value={ssrMaxRoughness} min={0.05} max={1} step={0.05} decimals={2}
                                defaultValue={draftLevel && draftLevel.values.ssrMaxRoughness}
                                onSlider={applySsrMaxRoughness} onNumber={applySsrMaxRoughness} />
                        </SliderRow>
                    </React.Fragment>
                ) : null}
                </React.Fragment>)}
                <ToggleRow label="Transparency" experimental checked={draftValues.transparency}
                    settingKey="transparency"
                    title={draftValues.transparency ? 'Disable scene material transparency' : 'Enable scene material transparency'}
                    onChange={(next) => stageQualityValue('transparency', next)}
                    description="Render opacity/transmission authored by scene materials. When off, transparent materials render opaque. Staged: takes effect on Apply." />
                <ToggleRow label="Convolved diffuse environment" checked={diffuseEnvConvolve}
                    settingKey="diffuseEnvConvolve"
                    title={diffuseEnvConvolve ? 'Use the second-order spherical harmonic fit instead' : 'Cosine-convolve the environment on the GPU instead'}
                    onChange={setDiffuseEnvConvolveValue}
                    description="Cosine-convolves the environment instead of a 9 term spherical harmonic fit. More accurate diffuse under small bright lights." />
            </React.Fragment>
        );
        const renderGeometryTab = () => (
            <React.Fragment>
                <SelectRow label="Texture resolution"
                    settingKey="textureMaxSize"
                    control={
                        <MtlxSelect value={draftValues.textureMaxSize} options={[512, 1024, 2048, 4096, Infinity]}
                            labels={{ 512: '512 px', 1024: '1024 px', 2048: '2048 px', 4096: '4096 px', Infinity: 'Original' }}
                            onChange={(next) => stageQualityValue('textureMaxSize', next)} defValue={2048} size="sm" disabled={busy} />
                    }
                    description="The maximum size each texture loads at. Higher values show finer detail in color, normal and roughness maps, but loading takes longer and uses more memory. If all textures together would go over Texture memory, they load smaller than this. Staged: takes effect on Apply." />
                <SelectRow label="Texture memory"
                    settingKey="textureBudgetGib"
                    control={
                        <MtlxSelect value={draftValues.textureBudgetGib} options={[1, 2, 4]} labels={{ 1: '1 GB', 2: '2 GB', 4: '4 GB' }}
                            onChange={(next) => stageQualityValue('textureBudgetGib', next)} defValue={1} size="sm" disabled={busy} />
                    }
                    description="How much memory all scene textures may use. Over the limit, all textures load at a lower resolution (1024, then 512 px) until they fit; if they still do not fit, the rest are left out (default values, grey UDIM tiles). Too high a value can exceed GPU memory and blank the view. Staged: takes effect on Apply." />
                <SelectRow label="Subdivision"
                    settingKey="subdivision"
                    control={
                        <MtlxSelect value={draftValues.subdivision} options={[0, 1, 2]} labels={{ 0: 'Off', 1: '1', 2: '2' }}
                            onChange={(next) => stageQualityValue('subdivision', Number(next))} defValue={0} size="sm" disabled={busy} />
                    }
                    description="Loop-subdivides catmullClark meshes for preview; the runtime cannot expose the cage, so this approximates the limit surface. Staged: reloads the stage on Apply." />
                <ToggleRow label="Displacement" checked={draftValues.displacement}
                    settingKey="displacement"
                    title={draftValues.displacement ? 'Disable displacement' : 'Enable displacement'}
                    onChange={(next) => stageQualityValue('displacement', next)}
                    description="Moves geometry bound to a displaced MaterialX material. Staged: takes effect on Apply." />
                <SelectRow label="Displacement subdivision"
                    settingKey="displacementSubdivision"
                    control={
                        <MtlxSelect value={draftValues.displacementSubdivision} options={['follow', 0, 1, 2, 3]}
                            labels={{ follow: 'Follow stage', 0: 'Off', 1: '1', 2: '2', 3: '3' }}
                            onChange={(next) => stageQualityValue('displacementSubdivision', next === 'follow' ? 'follow' : Number(next))} defValue="follow" size="sm" disabled={busy} />
                    }
                    description="Subdivision applied to meshes bound to displaced MaterialX materials. Staged: takes effect on Apply." />
                <ToggleRow label="Triangle limits" checked={draftValues.triangleLimits}
                    settingKey="triangleLimits"
                    onChange={(next) => stageQualityValue('triangleLimits', next !== false)} disabled={busy}
                    description="Skips or lowers subdivision and displacement detail that would exceed 700,000 triangles per mesh or 6,000,000 per scene. Turning this off can run out of memory or freeze the tab on heavy scenes. Staged: reloads the stage on Apply." />
            </React.Fragment>
        );
        const sidebarBody = (
            <div className="flex-1 overflow-y-auto custom-scrollbar p-3.5 space-y-4">
                <SectionCard icon="file" title="Stage" summary={rootBasename || 'No stage'} defaultOpen>
                    <div className="flex items-center gap-1">
                        <div className="flex-1 min-w-0">
                            <FilePickerField
                                value={files.length ? files.length + ' file' + (files.length === 1 ? '' : 's') : ''}
                                placeholder="No stage loaded"
                                multiple
                                icon="files"
                                accept=".usd,.usda,.usdc,.usdz,.glb,.gltf,.obj,.mtl,.bin,.mtlx,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tga,.exr,.hdr,.tif,.tiff,.ktx2"
                                onFiles={chooseFiles}
                                inputTestId="usd-scene-file-picker"
                            />
                        </div>
                        <label
                            title="Choose a folder"
                            className="h-[26px] w-[26px] shrink-0 inline-flex items-center justify-center border border-gray-700 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-300 cursor-pointer"
                        >
                            <MtlxIcon name="folder" className="w-3.5 h-3.5" />
                            <input type="file" webkitdirectory="" directory="" multiple className="hidden" onChange={(e) => chooseFiles(e.target.files)} />
                        </label>
                    </div>
                    <div className="text-xs text-gray-500">or drag-and-drop anywhere on the page</div>

                    {candidates.length > 1 && (() => {
                        const candidatePaths = candidates.map((f) => f.path);
                        const shortLabels = distinctRootLabels(candidatePaths);
                        const rootLabels = {};
                        const rootTitles = {};
                        candidatePaths.forEach((p, i) => { rootLabels[p] = shortLabels[i]; rootTitles[p] = p; });
                        return (
                            <div data-testid="usd-scene-root-select">
                                <FieldLabel label="Root layer" />
                                <MtlxSelect
                                    value={rootPath}
                                    options={candidatePaths}
                                    labels={rootLabels}
                                    titles={rootTitles}
                                    title={rootPath || undefined}
                                    popWidth={320}
                                    onChange={(v) => {
                                        setRootPath(v); setRootTouched(true);
                                        // One-click scene switching: reload the newly picked root
                                        // right away instead of waiting on the explicit Load button.
                                        if (filesRef.current && filesRef.current.length > 0) load(filesRef.current, v);
                                    }}
                                    defValue={null}
                                    size="lg"
                                    variant="field"
                                    block
                                />
                            </div>
                        );
                    })()}

                    {cameras.length > 0 && (() => {
                        const cameraOptions = ['default', ...cameras.map((c) => c.primPath)];
                        const cameraLabels = { default: 'Auto framing' };
                        const cameraTitles = {};
                        cameras.forEach((c) => { cameraLabels[c.primPath] = c.name || c.primPath; cameraTitles[c.primPath] = c.primPath; });
                        const defaultCameraPath = defaultCameraPathFor(cameras);
                        return (
                            <div data-testid="usd-scene-camera-select">
                                <FieldLabel label="Camera" />
                                <MtlxSelect
                                    value={selectedCamera}
                                    options={cameraOptions}
                                    labels={cameraLabels}
                                    titles={cameraTitles}
                                    onChange={selectCamera}
                                    defValue={defaultCameraPath || 'default'}
                                    size="lg"
                                    variant="field"
                                    block
                                />
                            </div>
                        );
                    })()}

                    {files.length > 0 && (
                        <div className="text-xs text-gray-500">{files.length} input file{files.length === 1 ? '' : 's'}</div>
                    )}

                    {files.length > 0 && rootPath && (
                        <button type="button" onClick={() => load()} className={BTN_PRIMARY + ' w-full'}>Load {rootBasename}</button>
                    )}
                    {busy && (
                        <button type="button" data-testid="usd-scene-cancel" onClick={cancel} className={BTN_SECONDARY + ' w-full'}>Cancel</button>
                    )}
                    <button type="button" data-testid="usd-scene-load-example" onClick={loadExample} className={BTN_SECONDARY + ' w-full'}>Load example</button>

                    {meshes.length > 0 && (
                        <details>
                            <summary className="cursor-pointer text-xs text-gray-400">Prim selection</summary>
                            <div className="mt-2 max-h-48 overflow-y-auto custom-scrollbar space-y-0.5">
                                {meshes.map((mesh, i) => {
                                    const path = String(mesh.primPath || mesh.path || mesh.name || ('mesh ' + (i + 1)));
                                    const isSelected = selectedPrim === path;
                                    return (
                                        <button
                                            type="button"
                                            key={path + i}
                                            onClick={() => select(mesh)}
                                            className={'block w-full truncate rounded px-2 py-1 text-left text-[11px] font-mono '
                                                + (isSelected ? 'bg-blue-500/[0.12] text-blue-300 ring-1 ring-blue-500/60' : 'text-gray-300 hover:bg-gray-800')}
                                        >
                                            {path}
                                        </button>
                                    );
                                })}
                            </div>
                        </details>
                    )}
                </SectionCard>

                <SectionCard icon="sun" title="Environment" summary={envSummary} defaultOpen dense>
                    <FilePickerField
                        value={envFileName}
                        placeholder="Default environment"
                        accept=".hdr,.exr"
                        icon="file"
                        onFiles={importEnvironment}
                        onClear={clearImportedEnvironment}
                    />
                    {envImportError && <div className="text-xs text-red-400">{envImportError}</div>}
                    <SliderField
                        disabled={!canTuneEnvironment}
                        label="Environment rotation" unit="deg"
                        value={envRotation} min={0} max={360} step={1} decimals={0}
                        defaultValue={0}
                        onSlider={applyEnvRotation}
                        onNumber={applyEnvRotation}
                    />
                    <SliderField
                        disabled={!canTuneEnvironment}
                        label="Exposure" unit="EV"
                        value={linearToEv(envExposureLinear)} min={EV_MIN} max={EV_MAX} step={EV_STEP} decimals={1}
                        defaultValue={0}
                        onSlider={(v) => setEnvExposureVal(evToLinear(v))}
                        onNumber={(v) => setEnvExposureVal(evToLinear(v))}
                    />
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-gray-400">Backdrop</span>
                        <MtlxSelect
                            value={backdrop}
                            options={['studio', 'studio-dark', 'environment', 'none']}
                            labels={{ studio: 'Studio', 'studio-dark': 'Studio (Dark)', environment: 'Environment', none: 'None' }}
                            onChange={(value) => { setBackdrop(value); callHandle('setBackdrop', value); }}
                            defValue="studio"
                            size="sm"
                            disabled={!handle || typeof handle.setBackdrop !== 'function'}
                        />
                    </div>
                    <button type="button" onClick={resetEnvironment} className={BTN_SECONDARY + ' w-full'}>Reset</button>
                </SectionCard>

                <div data-testid={materials.length ? 'usd-material-provenance' : undefined}>
                    <SectionCard key={warnings.length > 0} icon="alert-triangle" title="Diagnostics" summary={warnings.length ? warnings.length + ' warning' + (warnings.length === 1 ? '' : 's') : 'None'} defaultOpen={warnings.length > 0} dense>
                        {warnings.length || transparentPrims.length ? (
                            <div data-testid="usd-material-warnings">
                                {['error', 'warning', 'info'].map((severity) => {
                                    const records = grouped[severity];
                                    if (!records.length) return null;
                                    const style = SEVERITY_STYLE[severity];
                                    return (
                                        <DiagGroup
                                            key={severity}
                                            id={severity}
                                            icon={style.icon}
                                            tone={style.text}
                                            label={style.label}
                                            lines={records.map((record) => record.label)}
                                        >
                                            {records.map((record, i) => (
                                                <div key={severity + i} className={'font-mono text-xs break-all ' + style.text}>{renderWarningText(record.label)}</div>
                                            ))}
                                        </DiagGroup>
                                    );
                                })}
                                {transparentPrims.length ? (
                                    <DiagGroup
                                        id="transparent"
                                        icon="color-filter"
                                        tone="text-sky-300/90"
                                        label="Transparency"
                                        lines={transparentPrims.map((entry) => entry.primPath + ' [' + entry.materialPath + ']')}
                                    >
                                        {transparentPrims.map((entry, i) => (
                                            <div key={'t' + i} className="font-mono text-xs break-all text-sky-300/90">
                                                {entry.primPath}
                                                <span className="text-gray-500"> [{entry.materialPath}]</span>
                                            </div>
                                        ))}
                                    </DiagGroup>
                                ) : null}
                                {materials.length ? (
                                    <DiagGroup
                                        id="materials"
                                        icon="file-text"
                                        tone="text-gray-500"
                                        label="Material sources"
                                        lines={materials.map((material) => String(material.materialX && material.materialX.path || material.sourceAsset || material.path || 'Material source unavailable'))}
                                    >
                                        {materials.map((material, i) => (
                                            <div key={'m' + i} className="text-gray-400 font-mono text-xs break-all">
                                                {String(material.materialX && material.materialX.path || material.sourceAsset || material.path || 'Material source unavailable')}
                                            </div>
                                        ))}
                                    </DiagGroup>
                                ) : null}
                            </div>
                        ) : (
                            <div className="text-xs text-gray-500">No warnings.</div>
                        )}
                    </SectionCard>
                </div>
            </div>
        );

        // Context value, not a component type: rowDirtyFor/draftDiff are new
        // every render, but that only re-renders the hoisted row consumers,
        // it never remounts them (see the rowDirtyFor comment above).
        return <SceneRowCtx.Provider value={{ rowDirtyFor, draftDiff, hasStage }}>
        <div data-testid="usd-scene-viewer" className="absolute inset-0 overflow-hidden flex bg-gray-900">
            <span className="sr-only" data-testid="usd-scene-status">{status}</span>
            {dragOver && (
                <div className="fixed left-0 right-0 bottom-0 top-14 z-40 pointer-events-none p-2 sm:p-4">
                    <div className="w-full h-full rounded-xl border-4 border-dashed border-blue-500/70 bg-blue-950/40 flex items-center justify-center">
                        <div className="flex items-center gap-2 text-blue-200 text-lg font-semibold bg-gray-900/80 rounded-lg px-5 py-3">
                            <MtlxIcon name="file-upload" className="w-6 h-6" /> Drop to load
                        </div>
                    </div>
                </div>
            )}

            {sidebarOpen && (
                <div data-testid="usd-scene-sidebar" className="flex-none w-80 max-w-[90%] flex flex-col bg-gray-900 border-r border-gray-700 overflow-hidden">
                    <div className="flex-none flex items-center px-3 py-2 border-b border-gray-700">
                        <span className="text-[13px] font-semibold text-gray-200">Scene Viewer</span>
                        <button
                            ref={knownIssuesBtnRef}
                            type="button"
                            data-testid="usd-scene-experimental-pill"
                            aria-expanded={knownIssuesOpen}
                            title="Known issues"
                            onClick={() => setKnownIssuesOpen((o) => !o)}
                            className="ml-2 text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-amber-600/30 border border-amber-500/50 text-amber-300 hover:bg-amber-600/40 hover:border-amber-500/70"
                        >Experimental</button>
                        <button
                            onClick={() => setSidebarOpen(false)}
                            title="Collapse the scene viewer panel"
                            className="flex-none ml-auto text-gray-400 hover:text-gray-200 px-1 leading-none text-sm"
                        ><MtlxIcon name="chevrons-left" className="w-4 h-4" /></button>
                    </div>
                    {knownIssuesOpen && knownIssuesPos && ReactDOM.createPortal(
                        <div
                            ref={knownIssuesPopRef}
                            data-testid="usd-scene-known-issues"
                            onPointerDown={(e) => e.stopPropagation()}
                            style={{ position: 'fixed', zIndex: 9999, width: KNOWN_ISSUES_POPOVER_W, left: knownIssuesPos.left, top: knownIssuesPos.top }}
                            className="bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl overflow-hidden"
                        >
                            <div className="px-3 py-2.5 space-y-1.5">
                                <div className="text-[12px] font-semibold text-gray-200">Known issues</div>
                                <ul className="list-disc pl-4 space-y-1 text-[11px] text-gray-400">
                                    {SCENE_KNOWN_ISSUES.map((issue, i) => <li key={i}>{issue}</li>)}
                                </ul>
                            </div>
                        </div>,
                        fullscreenPortalRoot()
                    )}
                    {sidebarBody}
                    <div className="shrink-0 border-t border-gray-700 px-3.5 py-3.5 space-y-1" style={{ background: PANEL_SURFACE }} data-testid="usd-stage-counts">
                        <div className="flex items-center gap-2 mb-1.5">
                            <MtlxIcon name="cube" className="w-4 h-4 text-gray-400 shrink-0" />
                            <span className="text-[13px] font-semibold text-gray-200 shrink-0">Statistics</span>
                        </div>
                        <div className="space-y-1 text-[11px] text-gray-300">
                            <div className="flex justify-between">
                                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-gray-500">Meshes</span>
                                <span className="font-mono tabular-nums">{meshes.length}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-gray-500">Triangles</span>
                                <span className="font-mono tabular-nums" data-testid="usd-stage-triangles">{triangleCount.toLocaleString()}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-gray-500">Materials</span>
                                <span className="font-mono tabular-nums">{materials.length}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-gray-500">Rendered prims</span>
                                <span className="font-mono tabular-nums">{renderedPrimCount}</span>
                            </div>
                            <div className="flex justify-between">
                                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-gray-500">Warnings</span>
                                <span className="font-mono tabular-nums">{warnings.length}</span>
                            </div>
                            <div className="flex justify-between gap-2">
                                <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-gray-500 shrink-0">Root</span>
                                <span className="font-mono tabular-nums break-all text-right" data-testid="usd-stage-root">{rootPath || 'None'}</span>
                            </div>
                        </div>
                    </div>
                    <div className="flex-none border-t border-gray-700 px-3 py-2 text-[11px] text-gray-500">
                        Drag orbits, wheel/pinch zooms. Textures are matched by relative path; unresolved images fall back to the image node's default color. Double-click a surface to preview its material graph and shaderball.
                    </div>
                </div>
            )}

            <div className="relative flex-1 min-w-0">
                <div ref={containerRef} data-testid="usd-scene-canvas" className="absolute inset-0 bg-gray-900" aria-label="Rendered USD scene">
                    <LoadingOverlay
                        show={busy}
                        label={progressLabel + (progressText ? ' ' + progressText : '')}
                        fraction={fraction}
                        testId="usd-scene-progress"
                        className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-gray-900/70"
                        labelClassName="text-sm text-gray-300 animate-pulse"
                        barWidthClass="w-56"
                    >
                        {progressDetail && (
                            <span
                                data-testid="usd-scene-progress-detail"
                                className="text-xs text-gray-500 truncate w-56 text-center"
                            >{progressDetail}</span>
                        )}
                        <button type="button" onClick={cancel} className={HUD_PILL + ' pointer-events-auto'}>Cancel</button>
                    </LoadingOverlay>

                    {!hasStage && !busy && (
                        <React.Fragment>
                            <div
                                aria-hidden="true"
                                className="absolute inset-0 pointer-events-none"
                                style={{
                                    backgroundImage: EMPTY_STAGE_GRID_IMAGE,
                                    backgroundSize: '40px 40px',
                                    maskImage: EMPTY_STAGE_GRID_MASK,
                                    WebkitMaskImage: EMPTY_STAGE_GRID_MASK,
                                }}
                            />
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6">
                                <div className="text-gray-500 text-sm max-w-sm">
                                    Drop a USD stage (.usd, .usda, .usdc, .usdz), a glTF (.gltf, .glb) or an OBJ (.obj) and its referenced files
                                </div>
                                <button type="button" onClick={loadExample} className={PILL_ACTION}>
                                    <MtlxIcon name="file-upload" className="w-3.5 h-3.5" /> Load example
                                </button>
                            </div>
                        </React.Fragment>
                    )}

                    {handle && (
                        <ViewportControls
                            containerClassName="absolute top-2 right-2 z-10 flex items-center gap-2.5 flex-wrap justify-end max-w-[calc(100%-5rem)]"
                            clusterClassName="flex items-center gap-1"
                            selectSize="md"
                            buttonClassName={(isActive) => isActive ? HUD_PILL_ACTIVE : HUD_PILL}
                            showGeomSelect={false}
                            envAvail={false}
                            showBackdropPicker={false}
                            showSettings={false}
                            showRotate
                            rotating={rotating}
                            onToggleRotating={toggleRotating}
                            onCameraReset={() => { if (handle && handle.resetCamera) { handle.resetCamera(); if (handle.renderNow) handle.renderNow(); } else frameAll(); }}
                            showScreenshot
                            onScreenshot={takeScreenshot}
                            onRecord={() => setRecordOpen(true)}
                            showRecord={!!handle && typeof handle.beginCapture === 'function'}
                            isFullscreen={isFullscreen}
                            onToggleFullscreen={toggleFullscreen}
                            showLabels
                            clusters={[['rotate', 'cameraReset'], ['screenshot', 'record', 'fullscreen']]}
                        />
                    )}

                    <div className="absolute top-2 left-2 z-30 flex items-center gap-2.5 flex-wrap max-w-[calc(100%-5rem)]">
                        {!sidebarOpen && (
                            <button
                                type="button"
                                onClick={() => setSidebarOpen(true)}
                                title="Expand the scene viewer panel"
                                className={HUD_PILL}
                            >
                                <MtlxIcon name="chevrons-right" className="w-4 h-4" />
                                <span className="max-w-[5rem] md:max-w-[8rem] truncate">Scene</span>
                            </button>
                        )}
                        <button
                            type="button"
                            ref={renderSettingsBtnRef}
                            data-testid="usd-scene-render-settings"
                            title={draftDirty ? 'Render settings (unapplied changes)' : 'Render settings'}
                            onClick={() => setRenderSettingsOpen((o) => !o)}
                            className={(renderSettingsOpen ? HUD_PILL_ACTIVE : HUD_PILL) + ' relative'}
                        >
                            <MtlxIcon name="settings-cog" className="w-4 h-4" />
                            <span>Render settings</span>
                            {draftDirty ? (
                                <span title="Unapplied changes" className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-400 border border-gray-900" />
                            ) : null}
                        </button>
                    </div>

                    {renderSettingsMounted && (
                        <div
                            ref={renderSettingsPopRef}
                            data-testid="usd-scene-render-settings-popover"
                            className={(renderSettingsOpen ? '' : 'hidden ') + 'absolute z-30 top-11 left-2 flex flex-col bg-gray-800/95 backdrop-blur border border-gray-600 rounded-lg shadow-2xl overflow-hidden'}
                            style={{ width: 'min(560px, calc(100% - 16px))', maxHeight: 'calc(100% - 56px)' }}
                        >
                            <div className="flex-none px-3 py-2 border-b border-gray-700">
                                <div className="flex items-center gap-2">
                                    <span className="text-xs font-medium text-gray-300">Preset</span>
                                    <QualitySegments tone="panel" value={draftStagedOverrides.length ? 'custom' : (draftLevel ? draftLevel.id : 'default')}
                                        onChange={stageQualityLevel} disabled={busy || !!presetApplying} />
                                </div>
                                <div className="mt-1 text-[11px] text-gray-400">{qualitySummaryText()}</div>
                            </div>
                            <div className="flex-none flex items-center gap-1 px-2 pt-2 border-b border-gray-700 overflow-x-auto">
                                {RENDER_TABS.map((tab) => (
                                    <button
                                        key={tab}
                                        type="button"
                                        onClick={() => setRenderTab(tab)}
                                        className={'shrink-0 px-2.5 py-1.5 text-[11px] font-medium rounded-t-md border-b-2 whitespace-nowrap '
                                            + (renderTab === tab ? 'border-blue-500 text-blue-300' : 'border-transparent text-gray-400 hover:text-gray-200')}
                                    >
                                        {RENDER_TAB_LABELS[tab]}
                                    </button>
                                ))}
                            </div>
                            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-3 space-y-1">
                                {renderTab === 'display' && renderDisplayTab()}
                                {renderTab === 'lighting' && renderLightingTab()}
                                {renderTab === 'effects' && renderEffectsTab()}
                                {renderTab === 'geometry' && renderGeometryTab()}
                            </div>
                            <div className="flex-none flex items-center justify-between gap-2 px-3 py-2 border-t border-gray-700">
                                <span className="text-[11px] text-gray-400 truncate">
                                    {presetApplying ? ('Applying ' + presetApplying) : footerHintText()}
                                </span>
                                <div className="flex items-center gap-1.5 shrink-0">
                                    <button type="button" data-testid="usd-scene-quality-reset" disabled={busy || !!presetApplying || !draftResetDirty}
                                        onClick={resetQualityDraft} className={BTN_SECONDARY + ' gap-1'}>
                                        <MtlxIcon name="restore" className="w-3.5 h-3.5 flex-none" />Reset</button>
                                    <button type="button" data-testid="usd-scene-quality-cancel" disabled={busy || !!presetApplying}
                                        onClick={cancelQualityDraft} className={BTN_SECONDARY + ' gap-1'}>
                                        <MtlxIcon name="x" className="w-3.5 h-3.5 flex-none" />Cancel</button>
                                    <button type="button" data-testid="usd-scene-quality-apply" disabled={busy || !!presetApplying || !draftDirty}
                                        onClick={applyQualityDraft} className={BTN_SECONDARY + ' gap-1'}>
                                        <MtlxIcon name="check" className="w-3.5 h-3.5 flex-none" />Apply</button>
                                </div>
                            </div>
                        </div>
                    )}

                    {doubleClickNote && (
                        <div data-testid="usd-scene-dblclick-note" className="absolute bottom-10 left-2 z-10 pointer-events-none px-2 py-1 rounded-full bg-amber-500/20 border border-amber-500/40 text-[11px] text-amber-200">
                            {doubleClickNote}
                        </div>
                    )}
                    {handle && (() => {
                        const segments = [rootBasename, meshes.length + ' meshes'];
                        const mtlxVersion = (window.MtlxAssets && window.MtlxAssets.MTLX_DEFAULT_VERSION) || window.__mtlxVersion;
                        if (mtlxVersion) segments.push('v' + mtlxVersion);
                        return (
                            <div className="absolute bottom-2 left-2 z-10 pointer-events-none flex items-center gap-2 px-2 py-1 rounded-full bg-black/60 text-[11px] text-white/90">
                                <span className="w-1.5 h-1.5 rounded-full bg-green-400 shrink-0" />
                                {segments.filter(Boolean).map((seg, i) => (
                                    <React.Fragment key={i}>
                                        {i > 0 && <span className="text-white/40">/</span>}
                                        <span className={seg.charAt(0) === 'v' && i === segments.length - 1 ? 'font-mono' : undefined}>{seg}</span>
                                    </React.Fragment>
                                ))}
                            </div>
                        );
                    })()}

                    <MaterialPreviewPanel
                        key={previewEpoch}
                        open={previewOpen}
                        payload={previewPayload}
                        anchor={previewAnchor}
                        onClose={() => setPreviewOpen(false)}
                        containerRef={containerRef}
                        panelRef={previewPanelRef}
                        sceneFiles={sceneLooseFiles}
                    />
                </div>
            </div>

            {status === 'cancelled' && !busy && (
                <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 max-w-[min(42rem,85%)] bg-gray-800/90 backdrop-blur border border-gray-600 text-gray-300 text-sm rounded-lg px-4 py-2 break-words shadow-lg">Cancelled</div>
            )}
            {error && (
                <div role="alert" data-testid="usd-scene-error" className="absolute top-12 left-1/2 -translate-x-1/2 z-30 max-w-[min(42rem,85%)] bg-red-950/90 border border-red-800/60 text-red-200 text-sm rounded-lg px-4 py-2.5 break-words shadow-lg">{error}</div>
            )}

            {recordOpen && (
                <RecordGifDialog open={recordOpen} onClose={() => setRecordOpen(false)}
                    viewRef={handleRef} baseName={rootBasename ? rootBasename.replace(/\.[^.]+$/, '') : 'usd-scene'} transparent={false} />
            )}
        </div>
        </SceneRowCtx.Provider>;
    }
    window.SceneViewerApp = SceneViewerApp;
})();
