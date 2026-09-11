// Scene Viewer route. This page owns file selection and lifecycle only. USD
// composition and rendering stay behind the two small runtime contracts.
// UI skeleton mirrors js/viewer-app.jsx (docked sidebar, HUD, pinned
// statistics panel like js/compare-app.jsx) so the Scene Viewer looks and
// behaves like the rest of the toolset.
(() => {
    const ROOT_EXTENSIONS = ['.usd', '.usda', '.usdc', '.usdz'];
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

    const asPath = (file) => String(file.webkitRelativePath || file.relativePath || file.name || '').replace(/\\/g, '/');
    const ext = (path) => { const i = path.lastIndexOf('.'); return i < 0 ? '' : path.slice(i).toLowerCase(); };
    const rootCandidates = (files) => {
        // Keep every supplied USD layer selectable. A nested layer may be the
        // intentional root of a folder upload, while the default still picks
        // a conventional top-level root in pickDefaultRootLayer().
        return files.filter((f) => ROOT_EXTENSIONS.indexOf(ext(f.path)) >= 0);
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
    async function pickDefaultRootLayer(files) {
        const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const candidates = rootCandidates(files);
        if (candidates.length === 0) return '';
        if (candidates.length === 1) return candidates[0].path;
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
        if (topLevel.length === 0) return oldDefaultRoot(candidates);
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
        return topLevel[0].path;
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
        const pathMatch = /(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+\.(?:usd|usda|usdc|usdz)\b/i.exec(raw);
        if (pathMatch && /(?:open|read|reference|layer)/i.test(raw)) {
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
    const progressValue = (value) => {
        if (typeof value === 'number') return { phase: 'Loading', fraction: Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : null, done: 0, total: 0, message: '' };
        const p = value && typeof value === 'object' ? value : { message: String(value || '') };
        const done = Number(p.done || p.index || 0);
        const total = Number(p.total || 0);
        const explicitFraction = p.fraction != null ? Number(p.fraction) : null;
        const explicitProgress = p.progress != null ? Number(p.progress) : null;
        const fraction = Number.isFinite(explicitFraction) ? Math.max(0, Math.min(1, explicitFraction)) : Number.isFinite(explicitProgress) ? Math.max(0, Math.min(1, explicitProgress)) : total > 0 ? Math.max(0, Math.min(1, done / total)) : null;
        return { phase: String(p.phase || ''), fraction, done, total, message: String(p.message || p.status || '') };
    };
    const apiFunction = (name) => {
        const candidates = [window[name], window.MtlxUsd && window.MtlxUsd[name], window.UsdSceneRuntime && window.UsdSceneRuntime[name]];
        return candidates.find((value) => typeof value === 'function');
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
        const [error, setError] = React.useState('');
        const [dragOver, setDragOver] = React.useState(false);
        const [selectedPrim, setSelectedPrim] = React.useState('');
        const [selectedCamera, setSelectedCamera] = React.useState('default');
        React.useEffect(() => { setSelectedCamera('default'); }, [stage]);
        const [rootTouched, setRootTouched] = React.useState(false);
        const [envFileName, setEnvFileName] = React.useState('');
        const [envImportError, setEnvImportError] = React.useState(null);
        const [envRotation, setEnvRotation] = React.useState(0);
        const [envExposureLinear, setEnvExposureLinear] = React.useState(1);
        const [backdrop, setBackdrop] = React.useState('studio');
        const [textureSizeTick, setTextureSizeTick] = React.useState(0);
        const [subdivisionLevel, setSubdivisionLevel] = React.useState(
            () => (typeof storedSceneSubdivisionLevel === 'function' ? storedSceneSubdivisionLevel() : 1)
        );
        const subdivisionLevelRef = React.useRef(subdivisionLevel);
        subdivisionLevelRef.current = subdivisionLevel;
        // The Scene keeps its own view transform (the Material Viewer stays on
        // sRGB for MaterialXView parity); exposure is shared with the other tools.
        const [displayTransform, setDisplayTransformState] = React.useState('neutral');
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
        const [presentation, setPresentation] = React.useState({ enabled: true, bloom: true, strength: 0.25, supported: true });
        const [shadowsOn, setShadowsOn] = React.useState(true);
        const [aoOn, setAoOn] = React.useState(true);
        const [aoStrength, setAoStrength] = React.useState(0.85);
        const [skyVisOn, setSkyVisOn] = React.useState(true);
        const [skyVisStrength, setSkyVisStrength] = React.useState(1);
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
        const envSettingsRef = React.useRef({ rotation: 0, exposureLinear: 1, backdrop: 'studio', autoRotate: false });
        const [recordOpen, setRecordOpen] = React.useState(false);
        const envOverrideRef = React.useRef(null);
        const currentEnvironmentRef = React.useRef(null);
        const containerRef = React.useRef(null);
        const viewportRef = containerRef;
        const activeRef = React.useRef(active);
        activeRef.current = active;
        const abortRef = React.useRef(null);
        const mountedRef = React.useRef(true);
        const filesRef = React.useRef(files);
        const handleRef = React.useRef(null);
        const generationRef = React.useRef(0);
        const environmentGenerationRef = React.useRef(0);
        const [rotating, toggleRotating] = useViewToggle(handleRef, 'setAutoRotate', false);
        filesRef.current = files;
        envSettingsRef.current = { rotation: envRotation, exposureLinear: envExposureLinear, backdrop, autoRotate: rotating };
        const updateProgress = (value, generation) => { if (mountedRef.current && (generation == null || generation === generationRef.current)) setProgress(progressValue(value)); };

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
        const applyDisplayExposure = (raw) => {
            const value = Math.max(-8, Math.min(8, Number(raw)));
            if (!Number.isFinite(value)) return;
            setDisplayExposureState(value);
            if (window.setDisplayExposure) window.setDisplayExposure(value);
        };

        const applyChosenFiles = async (next, generation) => {
            if (!mountedRef.current || generation !== generationRef.current) return;
            setFiles(next);
            const preferredRoot = await pickDefaultRootLayer(next);
            if (!mountedRef.current || generation !== generationRef.current) return;
            setRootPath(preferredRoot);
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
            const loader = apiFunction('loadUsdStage');
            if (typeof loader !== 'function') { setError('USD stage loader is unavailable in this build.'); setStatus('error'); return; }
            if (!loadRoot) { setError('Select one USD root layer before loading.'); setStatus('error'); return; }
            const generation = ++generationRef.current;
            if (abortRef.current) abortRef.current.abort();
            const controller = new AbortController();
            abortRef.current = controller;
            if (handleRef.current && typeof handleRef.current.dispose === 'function') handleRef.current.dispose();
            handleRef.current = null; setHandle(null); setStage(null); setError(''); setStatus('loading');
            window.__mtlxUsdSceneHandle = null;
            try {
                const result = await loader({ files: loadFiles, rootPath: loadRoot, signal: controller.signal, subdivisionLevel: subdivisionLevelRef.current, onProgress: (value) => updateProgress(value, generation) });
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
                    const nextHandle = await renderer({ container: containerRef.current, stage, files, version, onProgress: (value) => updateProgress(value, rendererGeneration), isMounted: () => mountedRef.current && generationRef.current === rendererGeneration && !rendererController?.signal?.aborted && (adopted || (live && active)) });
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
                    } else {
                        callHandle('setEnvRotation', settings.rotation * Math.PI / 180);
                        callHandle('setEnvExposure', settings.exposureLinear);
                    }
                    callHandle('setBackdrop', settings.backdrop);
                    callHandle('setAutoRotate', settings.autoRotate);
                    if (currentEnvironmentRef.current && !useDome) callHandle('setEnvironment', currentEnvironmentRef.current);
                    setHandle(nextHandle); setStatus('rendered');
                    if (nextHandle && nextHandle.frameAll) nextHandle.frameAll();
                } catch (e) { if (live && mountedRef.current && generationRef.current === rendererGeneration && !rendererController?.signal?.aborted) { setError(String(e && e.message || e)); setStatus('error'); } }
            })();
            return () => { live = false; };
        }, [stage, active]);
        React.useEffect(() => {
            if (!containerRef.current || !window.ResizeObserver) return undefined;
            const observer = new ResizeObserver(() => { if (handle && handle.resize) handle.resize(); });
            observer.observe(containerRef.current); return () => observer.disconnect();
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
        const warningDetails = warningRecords(materialWarningList(stage).concat(handle && Array.isArray(handle.warnings) ? handle.warnings.map(String) : []));
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
        const applySkyVisStrength = (raw) => {
            const value = Math.max(0, Math.min(1, Number(raw)));
            if (!Number.isFinite(value)) return;
            setSkyVisStrength(value);
            callHandle('setSkyVisibilityStrength', value);
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
                setBackdrop('studio'); callHandle('setBackdrop', 'studio');
                return;
            }
            if (env) { currentEnvironmentRef.current = env; callHandle('setEnvironment', env); }
            setEnvFileName(''); setEnvRotation(0); setEnvExposureLinear(1); callHandle('setEnvRotation', 0); callHandle('setEnvExposure', 1); setBackdrop('studio'); callHandle('setBackdrop', 'studio');
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
        const textureMaxSize = (handle && typeof handle.getTextureMaxSize === 'function')
            ? handle.getTextureMaxSize()
            : (typeof storedSceneTextureMaxSize === 'function' ? storedSceneTextureMaxSize() : 2048);
        const textureBudgetGib = (handle && typeof handle.getTextureBudgetBytes === 'function')
            ? Math.round(handle.getTextureBudgetBytes() / (1024 * 1024 * 1024))
            : Math.round((typeof storedSceneTextureBudgetBytes === 'function' ? storedSceneTextureBudgetBytes() : (1024 * 1024 * 1024)) / (1024 * 1024 * 1024));
        // Referenced so the memo below re-reads getTextureMaxSize() after a
        // mutation that doesn't otherwise touch React state.
        void textureSizeTick;

        const fraction = progress.fraction;
        const phaseLabels = { worker: 'Loading stage', parse: 'Composing stage', geometry: 'Preparing geometry', material: 'Compiling materials', texture: 'Loading textures', renderer: 'Preparing viewport', 'gpu-program': 'Checking GPU programs' };
        const progressLabel = phaseLabels[progress.phase] || (progress.phase ? progress.phase.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : (status === 'rendered' ? 'Ready' : 'Loading'));
        const progressText = progress.total ? (progress.done + '/' + progress.total) : (/texture|material/i.test(progress.phase) ? '' : progress.message);
        const busy = status === 'loading' || status === 'loading-example' || status === 'loaded';
        const canTuneEnvironment = !!handle && typeof handle.setEnvRotation === 'function';
        const envSummary = (envRotation === 0 && envExposureLinear === 1)
            ? 'Default environment'
            : Math.round(envRotation) + '°, ' + formatEv(linearToEv(envExposureLinear));
        const renderedPrimCount = (handle && Array.isArray(handle.prims)) ? handle.prims.length : meshes.length;
        const triangleCount = stageTriangleCount(stage);
        const hasStage = !!stage || files.length > 0;

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
                                accept=".usd,.usda,.usdc,.usdz,.mtlx,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tga,.exr,.hdr,.tif,.tiff,.ktx2"
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
                                    onChange={(v) => { setRootPath(v); setRootTouched(true); }}
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
                        const cameraLabels = { default: 'Default (auto framing)' };
                        const cameraTitles = {};
                        cameras.forEach((c) => { cameraLabels[c.primPath] = c.name || c.primPath; cameraTitles[c.primPath] = c.primPath; });
                        return (
                            <div data-testid="usd-scene-camera-select">
                                <FieldLabel label="Camera" />
                                <MtlxSelect
                                    value={selectedCamera}
                                    options={cameraOptions}
                                    labels={cameraLabels}
                                    titles={cameraTitles}
                                    onChange={selectCamera}
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
                        value={envRotation} min={0} max={360} step={1}
                        onSlider={(v) => { const n = Number(v); setEnvRotation(n); callHandle('setEnvRotation', n * Math.PI / 180); }}
                        onNumber={(v) => { const n = Number(v); setEnvRotation(n); callHandle('setEnvRotation', n * Math.PI / 180); }}
                    />
                    <SliderField
                        disabled={!canTuneEnvironment}
                        label="Exposure" unit="EV"
                        value={linearToEv(envExposureLinear)} min={EV_MIN} max={EV_MAX} step={EV_STEP}
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

                <SectionCard icon="settings-cog" title="Rendering" summary={({ neutral: 'Neutral', aces: 'ACES', srgb: 'sRGB', lin_rec709: 'lin_rec709' })[displayTransform] || displayTransform} dense>
                    <div className="flex items-center justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-400">
                            Display transform
                            <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-amber-600/30 border border-amber-500/50 text-amber-300">Experimental</span>
                        </span>
                        <MtlxSelect
                            value={displayTransform}
                            options={['neutral', 'aces', 'srgb', 'lin_rec709']}
                            labels={{ neutral: 'Neutral', aces: 'ACES', srgb: 'sRGB', lin_rec709: 'lin_rec709' }}
                            onChange={pickDisplayTransform}
                            defValue="neutral"
                            title="How the linear render is encoded for display. Neutral rolls highlights off while keeping hue. sRGB clips at 1.0 and matches the official MaterialX viewer. This is the Scene's own setting; the Material Viewer keeps sRGB."
                            size="sm"
                        />
                    </div>
                    <SliderField
                        label="Camera exposure" unit="EV"
                        value={displayExposure}
                        min={-8}
                        max={8}
                        step={0.25}
                        onSlider={(v) => applyDisplayExposure(v)}
                        onNumber={(v) => applyDisplayExposure(v)}
                    />
                    <div className="text-[11px] text-gray-400">
                        Scales the whole image before the display transform, the way a camera would. The Environment card's exposure gains only the image based lighting, so on a stage that also has its own lights it cannot balance the picture on its own.
                    </div>
                    <label className="flex items-center justify-between gap-2" title="Capture scene-linear HDR before a single display transform. Off uses the previous rendering path.">
                        <span className="text-xs font-medium text-gray-400">HDR presentation</span>
                        <Toggle checked={!!presentation.enabled} disabled={!handle || !presentation.supported}
                            onChange={(enabled) => { if(callHandle('setPresentation', { enabled }))setPresentation(handleRef.current.getPresentation()); }} />
                    </label>
                    <label className="flex items-center justify-between gap-2" title="Optical glow from actual HDR highlights. This does not add lighting to nearby geometry.">
                        <span className="text-xs font-medium text-gray-400">Highlight glow</span>
                        <Toggle checked={!!presentation.bloom} disabled={!handle || !presentation.enabled || !presentation.supported}
                            onChange={(bloom) => { if(callHandle('setPresentation', { bloom }))setPresentation(handleRef.current.getPresentation()); }} />
                    </label>
                    {presentation.enabled && presentation.bloom && presentation.supported ? (
                        <SliderField label="Glow strength" value={presentation.strength} min={0} max={1} step={0.025}
                            onSlider={(strength) => { if(callHandle('setPresentation', { strength }))setPresentation(handleRef.current.getPresentation()); }}
                            onNumber={(strength) => { if(callHandle('setPresentation', { strength }))setPresentation(handleRef.current.getPresentation()); }} />
                    ) : null}
                    <div className="text-[11px] text-gray-400">
                        {presentation.supported ? 'Scene-linear HDR preserves luminous highlights. Glow redistributes their brightness before the display transform; it does not replace emissive lighting or change authored colors.' : presentation.reason || 'HDR is unavailable on this device. The existing renderer remains active.'}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-gray-400">Texture resolution</span>
                        <MtlxSelect
                            value={textureMaxSize}
                            options={[512, 1024, 2048, 4096, Infinity]}
                            labels={{ 512: '512 px', 1024: '1024 px', 2048: '2048 px', 4096: '4096 px', Infinity: 'Original' }}
                            onChange={pickTextureMaxSize}
                            defValue={2048}
                            size="sm"
                            disabled={busy}
                        />
                    </div>
                    <div className="mt-1 text-[11px] text-gray-400">
                        Higher resolutions sharpen normal and roughness maps, at the cost of memory and load time.
                    </div>
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-gray-400">Texture memory</span>
                        <MtlxSelect
                            value={textureBudgetGib}
                            options={[1, 2, 4]}
                            labels={{ 1: '1 GB', 2: '2 GB', 4: '4 GB' }}
                            onChange={pickTextureBudgetGib}
                            defValue={1}
                            size="sm"
                            disabled={busy}
                        />
                    </div>
                    <div className="mt-1 text-[11px] text-gray-400">
                        Higher values can exhaust GPU memory and lose the WebGL context on smaller GPUs
                    </div>
                    <label
                        className="flex items-center justify-between cursor-pointer"
                        title={sceneTransparency ? 'Disable scene material transparency' : 'Enable scene material transparency'}
                    >
                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-400">
                            Transparency
                            <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-amber-600/30 border border-amber-500/50 text-amber-300">Experimental</span>
                        </span>
                        <Toggle
                            checked={sceneTransparency}
                            onChange={(next) => {
                                setSceneTransparencyState(next);
                                window.setUsdSceneTransparency && window.setUsdSceneTransparency(next);
                            }}
                        />
                    </label>
                    <div className="mt-1 text-[11px] text-gray-400">
                        Render opacity/transmission authored by scene materials. When off, transparent materials render opaque. Applies immediately.
                    </div>
                    {stageLightInfo.count > 0 ? (
                        <React.Fragment>
                            <label
                                className="flex items-center justify-between cursor-pointer"
                                title={stageLightsOn ? 'Ignore the lights authored on this stage' : 'Light the stage with its own lights'}
                            >
                                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-400">
                                    Stage lights
                                    <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-amber-600/30 border border-amber-500/50 text-amber-300">Experimental</span>
                                </span>
                                <Toggle
                                    checked={stageLightsOn}
                                    onChange={(next) => { setStageLightsOn(next); callHandle('setStageLightsEnabled', next); }}
                                />
                            </label>
                            <div className="mt-1 text-[11px] text-gray-400">
                                {stageLightInfo.count} light{stageLightInfo.count === 1 ? '' : 's'} imported from the stage. Area lights are split into several point samples across their surface, sharing the emitter's power; Diagnostics lists the split per light.
                            </div>
                            <label
                                className="flex items-center justify-between cursor-pointer"
                                title={skyVisOn ? 'Turn baked sky visibility off' : 'Let room geometry block the environment light'}
                            >
                                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-400">
                                    Sky visibility
                                    <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-amber-600/30 border border-amber-500/50 text-amber-300">Experimental</span>
                                </span>
                                <Toggle
                                    checked={skyVisOn}
                                    onChange={(next) => { setSkyVisOn(next); callHandle('setSkyVisibility', next); }}
                                />
                            </label>
                            <div className="mt-1 text-[11px] text-gray-400">
                                Environment light has no visibility term, so a wall does not block the sky and interiors read flat and overlit. This bakes how much sky each part of the stage can actually see into a coarse volume, once per stage. Room scale, which screen space occlusion cannot reach.
                            </div>
                            {skyVisOn ? (
                                <SliderField
                                    label="Sky visibility strength"
                                    value={skyVisStrength}
                                    min={0}
                                    max={1}
                                    step={0.05}
                                    onSlider={(v) => applySkyVisStrength(v)}
                                    onNumber={(v) => applySkyVisStrength(v)}
                                />
                            ) : null}
                            <label
                                className="flex items-center justify-between cursor-pointer"
                                title={shadowsOn ? 'Turn shadows off' : 'Cast shadows from the brightest light'}
                            >
                                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-400">
                                    Shadows
                                    <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-amber-600/30 border border-amber-500/50 text-amber-300">Experimental</span>
                                </span>
                                <Toggle
                                    checked={shadowsOn}
                                    onChange={(next) => { setShadowsOn(next); callHandle('setShadowsEnabled', next); }}
                                />
                            </label>
                            <div className="mt-1 text-[11px] text-gray-400">
                                Up to eight lights cast, packed into one shadow atlas, chosen by the light they deliver to sampled receivers. The atlas is rebuilt when the camera or lighting changes. More casters increase geometry-pass cost.
                            </div>
                            <label
                                className="flex items-center justify-between cursor-pointer"
                                title={aoOn ? 'Turn ambient occlusion off' : 'Occlude environment light in creases and corners'}
                            >
                                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-400">
                                    Ambient occlusion
                                    <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-amber-600/30 border border-amber-500/50 text-amber-300">Experimental</span>
                                </span>
                                <Toggle
                                    checked={aoOn}
                                    onChange={(next) => { setAoOn(next); callHandle('setAmbientOcclusionEnabled', next); }}
                                />
                            </label>
                            <div className="mt-1 text-[11px] text-gray-400">
                                Environment light reaches every surface equally, including ones facing a wall, which makes interiors read flat. This estimates how much sky each pixel can actually see. Screen space, so it only knows about geometry on screen.
                            </div>
                            {aoOn ? (
                                <SliderField
                                    label="Ambient occlusion strength"
                                    value={aoStrength}
                                    min={0}
                                    max={1}
                                    step={0.05}
                                    onSlider={(v) => applyAoStrength(v)}
                                    onNumber={(v) => applyAoStrength(v)}
                                />
                            ) : null}
                            {stageLightsOn ? (
                                <SliderField
                                    label="Stage light intensity" unit="EV"
                                    value={stageLightsEv}
                                    min={-8}
                                    max={8}
                                    step={0.25}
                                    onSlider={(v) => applyStageLightsEv(v)}
                                    onNumber={(v) => applyStageLightsEv(v)}
                                />
                            ) : null}
                        </React.Fragment>
                    ) : null}
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-gray-400">Subdivision</span>
                        <MtlxSelect
                            value={subdivisionLevel}
                            options={[0, 1, 2]}
                            labels={{ 0: 'Off', 1: '1', 2: '2' }}
                            onChange={pickSubdivisionLevel}
                            defValue={1}
                            size="sm"
                            disabled={busy}
                        />
                    </div>
                    <div className="mt-1 text-[11px] text-gray-400">
                        Loop-subdivides catmullClark meshes for preview; the runtime cannot expose the cage, so this approximates the limit surface.
                    </div>
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
                                                <div key={severity + i} className={'font-mono text-xs break-all ' + style.text}>{record.label}</div>
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

        return <div data-testid="usd-scene-viewer" className="absolute inset-0 overflow-hidden flex bg-gray-900">
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
                            onClick={() => setSidebarOpen(false)}
                            title="Collapse the scene viewer panel"
                            className="flex-none ml-auto text-gray-400 hover:text-gray-200 px-1 leading-none text-sm"
                        ><MtlxIcon name="chevrons-left" className="w-4 h-4" /></button>
                    </div>
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
                        Drag orbits, wheel/pinch zooms. Textures are matched by relative path; unresolved images fall back to the image node's default color.
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
                                    Drop a USD stage (.usd, .usda, .usdc, .usdz) and its referenced files
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
                            showSettings
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
                            clusters={[['rotate', 'cameraReset'], ['screenshot', 'record', 'settings', 'fullscreen']]}
                        />
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
                </div>
            </div>

            {status === 'cancelled' && !busy && (
                <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 max-w-[min(42rem,85%)] bg-gray-800/90 backdrop-blur border border-gray-600 text-gray-300 text-sm rounded-lg px-4 py-2 break-words shadow-lg">Cancelled</div>
            )}
            {error && (
                <div role="alert" data-testid="usd-scene-error" className="absolute top-12 left-1/2 -translate-x-1/2 z-30 max-w-[min(42rem,85%)] bg-red-950/90 border border-red-800/60 text-red-200 text-sm rounded-lg px-4 py-2.5 break-words shadow-lg">{error}</div>
            )}

            {!sidebarOpen && (
                <button
                    onClick={() => setSidebarOpen(true)}
                    title="Expand the scene viewer panel"
                    className={'absolute top-2 left-2 z-30 ' + HUD_PILL}
                >
                    <MtlxIcon name="chevrons-right" className="w-4 h-4" />
                    <span className="max-w-[5rem] md:max-w-[8rem] truncate">Scene</span>
                </button>
            )}
            {recordOpen && (
                <RecordGifDialog open={recordOpen} onClose={() => setRecordOpen(false)}
                    viewRef={handleRef} baseName={rootBasename ? rootBasename.replace(/\.[^.]+$/, '') : 'usd-scene'} transparent={false} />
            )}
        </div>;
    }
    window.SceneViewerApp = SceneViewerApp;
})();
