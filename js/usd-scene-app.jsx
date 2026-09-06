// Scene Viewer route. This page owns file selection and lifecycle only. USD
// composition and rendering stay behind the two small runtime contracts.
(() => {
    const ROOT_EXTENSIONS = ['.usd', '.usda', '.usdc', '.usdz'];
    const EXAMPLE_ROOT = 'tests/fixtures/usd-scene/root.usda';
    const EXAMPLE_FILES = [
        EXAMPLE_ROOT,
        'tests/fixtures/usd-scene/nested/nested.usda',
        'tests/fixtures/usd-scene/nested/materials/red.mtlx',
        'tests/fixtures/usd-scene/nested/materials/blue.mtlx',
    ];

    const asPath = (file) => String(file.webkitRelativePath || file.relativePath || file.name || '').replace(/\\/g, '/');
    const ext = (path) => { const i = path.lastIndexOf('.'); return i < 0 ? '' : path.slice(i).toLowerCase(); };
    const rootCandidates = (files) => {
        // Keep every supplied USD layer selectable. A nested layer may be the
        // intentional root of a folder upload, while the default still picks
        // a conventional top-level root in chooseFiles().
        return files.filter((f) => ROOT_EXTENSIONS.indexOf(ext(f.path)) >= 0);
    };
    const stageMeshes = (stage) => Array.isArray(stage && stage.meshes) ? stage.meshes : [];
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
    const readFiles = async (fileList) => Array.from(fileList || []).map((file) => ({ path: asPath(file), data: file }));
    const readDroppedItems = async (items) => {
        const output = [];
        const visit = (entry, prefix = '') => new Promise((resolve, reject) => {
            if (!entry) return resolve();
            if (entry.isFile) return entry.file((file) => { file.relativePath = prefix + file.name; output.push(file); resolve(); }, reject);
            if (!entry.isDirectory) return resolve();
            const reader = entry.createReader();
            const readBatch = () => reader.readEntries(async (entries) => {
                if (!entries.length) return resolve();
                for (const child of entries) await visit(child, prefix + entry.name + '/');
                readBatch();
            }, reject);
            readBatch();
        });
        const entries = Array.from(items || []).map((item) => item.webkitGetAsEntry && item.webkitGetAsEntry()).filter(Boolean);
        for (const entry of entries) await visit(entry, '');
        return output;
    };
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
        const [files, setFiles] = React.useState([]);
        const [rootPath, setRootPath] = React.useState('');
        const [status, setStatus] = React.useState('idle');
        const [progress, setProgress] = React.useState({ phase: '', done: 0, total: 0, message: '' });
        const [stage, setStage] = React.useState(null);
        const [handle, setHandle] = React.useState(null);
        const [error, setError] = React.useState('');
        const [dragging, setDragging] = React.useState(false);
        const [selectedPrim, setSelectedPrim] = React.useState('');
        const [rootTouched, setRootTouched] = React.useState(false);
        const [envFileName, setEnvFileName] = React.useState('');
        const [envRotation, setEnvRotation] = React.useState(0);
        const [envExposure, setEnvExposure] = React.useState(0);
        const [backdrop, setBackdrop] = React.useState('studio');
        const [autoRotate, setAutoRotate] = React.useState(false);
        const [diagnosticsOpen, setDiagnosticsOpen] = React.useState(false);
        const [recordOpen, setRecordOpen] = React.useState(false);
        const envSettingsRef = React.useRef({ rotation: 0, exposure: 0, backdrop: 'studio', autoRotate: false });
        const envOverrideRef = React.useRef(null);
        const currentEnvironmentRef = React.useRef(null);
        const containerRef = React.useRef(null);
        const inputRef = React.useRef(null);
        const folderRef = React.useRef(null);
        const abortRef = React.useRef(null);
        const mountedRef = React.useRef(true);
        const filesRef = React.useRef(files);
        const handleRef = React.useRef(null);
        const generationRef = React.useRef(0);
        const environmentGenerationRef = React.useRef(0);
        filesRef.current = files;
        envSettingsRef.current = { rotation: envRotation, exposure: envExposure, backdrop, autoRotate };
        const updateProgress = (value, generation) => { if (mountedRef.current && (generation == null || generation === generationRef.current)) setProgress(progressValue(value)); };

        React.useEffect(() => () => {
            mountedRef.current = false;
            if (abortRef.current) abortRef.current.abort();
            if (handleRef.current && typeof handleRef.current.dispose === 'function') handleRef.current.dispose();
            handleRef.current = null;
        }, []);

        const chooseFiles = async (list) => {
            const generation = ++generationRef.current;
            if (abortRef.current) abortRef.current.abort();
            if (handleRef.current && handleRef.current.dispose) handleRef.current.dispose();
            handleRef.current = null; setHandle(null); setStage(null);
            const next = await readFiles(list);
            if (!mountedRef.current || generation !== generationRef.current) return;
            setFiles(next);
            const candidates = rootCandidates(next);
            const preferred = candidates.find((f) => /(^|\/)root\.(usd|usda|usdc|usdz)$/i.test(f.path));
            setRootPath(preferred ? preferred.path : (candidates.length === 1 ? candidates[0].path : ''));
            setRootTouched(false);
            setStage(null);
            setStatus(next.length ? 'ready-to-load' : 'idle');
            setError('');
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
            try {
                const result = await loader({ files: loadFiles, rootPath: loadRoot, signal: controller.signal, onProgress: (value) => updateProgress(value, generation) });
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
                    const settings = envSettingsRef.current;
                    callHandle('setEnvRotation', settings.rotation * Math.PI / 180);
                    callHandle('setEnvExposure', Math.pow(2, settings.exposure));
                    callHandle('setBackdrop', settings.backdrop);
                    callHandle('setAutoRotate', settings.autoRotate);
                    if (currentEnvironmentRef.current) callHandle('setEnvironment', currentEnvironmentRef.current);
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
        const candidates = rootCandidates(files);
        const meshes = stageMeshes(stage);
        const materials = stageMaterials(stage);
        const warningDetails = warningRecords(materialWarningList(stage).concat(handle && Array.isArray(handle.warnings) ? handle.warnings.map(String) : []));
        const warnings = warningDetails.map((record) => record.label);
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
            if (typeof loader !== 'function') { setError('Environment import is unavailable in this build.'); return; }
            try {
                const env = await loader(file.data || file);
                if (!mountedRef.current || generation !== environmentGenerationRef.current) { disposeUnusedEnvironment(env); return; }
                if (apiFunction('setEnvOverride')) apiFunction('setEnvOverride')(env);
                envOverrideRef.current = env;
                currentEnvironmentRef.current = env;
                callHandle('setEnvironment', env);
                setEnvFileName(file.name || file.path || 'Imported environment');
            } catch (e) { if (mountedRef.current && generation === environmentGenerationRef.current) setError(String(e && e.message || e)); }
        };
        const clearImportedEnvironment = async () => {
            const generation = ++environmentGenerationRef.current;
            envOverrideRef.current = null;
            currentEnvironmentRef.current = null;
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
            const reset = apiFunction('setEnvOverride');
            if (reset) reset(null);
            const getter = apiFunction('getEnvironment');
            let env = null;
            if (getter) { try { env = await getter(); } catch (e) {} }
            if (!mountedRef.current || generation !== environmentGenerationRef.current) return;
            if (env) { currentEnvironmentRef.current = env; callHandle('setEnvironment', env); }
            setEnvFileName(''); setEnvRotation(0); setEnvExposure(0); callHandle('setEnvRotation', 0); callHandle('setEnvExposure', 1); setBackdrop('studio'); callHandle('setBackdrop', 'studio');
        };
        const downloadSnapshot = () => {
            const value = handleRef.current && handleRef.current.snapshot && handleRef.current.snapshot();
            if (!value) { setError('Snapshot is unavailable until a scene is rendered.'); return; }
            const link = document.createElement('a'); link.href = value; link.download = 'usd-scene.png'; link.click();
        };
        const cancel = () => { generationRef.current += 1; if (abortRef.current) abortRef.current.abort(); setStatus('cancelled'); setProgress((p) => ({ ...p, message: 'Cancelled' })); };
        const frame = () => { if (handle && handle.frameAll) { handle.frameAll(); if (handle.renderNow) handle.renderNow(); } };
        const select = (mesh) => { const path = String(mesh && (mesh.primPath || mesh.path || mesh.name) || ''); setSelectedPrim(path); if (handle && handle.selectPrim) handle.selectPrim(path); if (handle && handle.renderNow) handle.renderNow(); };
        const fraction = progress.fraction;
        const phaseLabels = { worker: 'Loading stage', parse: 'Composing stage', geometry: 'Preparing geometry', material: 'Compiling materials', texture: 'Loading textures', renderer: 'Preparing viewport', 'gpu-program': 'Checking GPU programs' };
        const progressLabel = phaseLabels[progress.phase] || (progress.phase ? progress.phase.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : (status === 'rendered' ? 'Ready' : 'Loading'));
        const progressText = progress.total ? (progress.done + '/' + progress.total) : (/texture|material/i.test(progress.phase) ? '' : progress.message);
        const warningSummary = warnings.length ? warnings.length + ' warning' + (warnings.length === 1 ? '' : 's') + ' · ' + warningDetails[0].label : 'None';
        const canTuneEnvironment = !!handle && typeof handle.setEnvRotation === 'function';
        return <div data-testid="usd-scene-viewer" className="h-full min-h-0 w-full flex flex-col bg-gray-950 text-gray-100">
            <div className="flex flex-wrap items-center gap-2 border-b border-gray-800 bg-gray-900 px-3 py-2">
                <strong className="mr-2 text-sm">USD Scene Viewer</strong>
                <button type="button" data-testid="usd-scene-load-example" onClick={loadExample} className="h-7 rounded bg-blue-600 px-3 text-xs hover:bg-blue-500">Load example</button>
                <button type="button" onClick={() => inputRef.current && inputRef.current.click()} className="h-7 rounded border border-gray-700 px-3 text-xs hover:bg-gray-800">Choose files</button>
                <button type="button" onClick={() => folderRef.current && folderRef.current.click()} className="h-7 rounded border border-gray-700 px-3 text-xs hover:bg-gray-800">Choose folder</button>
                <button type="button" data-testid="usd-scene-frame" onClick={frame} disabled={!handle} className="h-7 rounded border border-gray-700 px-3 text-xs disabled:opacity-40">Frame all</button>
                <button type="button" onClick={() => setAutoRotate((value) => { const next = !value; callHandle('setAutoRotate', next); return next; })} disabled={!handle} className={'h-7 rounded border px-3 text-xs disabled:opacity-40 ' + (autoRotate ? 'border-blue-500 bg-blue-600/70' : 'border-gray-700 hover:bg-gray-800')}>Auto rotate</button>
                <button type="button" onClick={downloadSnapshot} disabled={!handle} className="h-7 rounded border border-gray-700 px-3 text-xs disabled:opacity-40">Snapshot</button>
                <button type="button" onClick={() => setRecordOpen(true)} disabled={!handle} className="h-7 rounded border border-gray-700 px-3 text-xs disabled:opacity-40"><MtlxIcon name="player-record" className="w-3.5 h-3.5 inline mr-1" />Record GIF</button>
                {(status === 'loading' || status === 'loading-example' || status === 'loaded') ? <button type="button" data-testid="usd-scene-cancel" onClick={cancel} className="h-7 rounded border border-red-700 px-3 text-xs text-red-300">Cancel</button> : null}
                <input ref={inputRef} data-testid="usd-scene-file-picker" className="hidden" type="file" multiple onChange={(e) => chooseFiles(e.target.files)} />
                <input ref={folderRef} className="hidden" type="file" multiple webkitdirectory="true" directory="true" onChange={(e) => chooseFiles(e.target.files)} />
            </div>
            <div className="flex flex-1 min-h-0 flex-col md:flex-row">
                <aside className="w-full md:w-80 shrink-0 min-w-0 overflow-x-hidden overflow-y-auto custom-scrollbar border-b md:border-b-0 md:border-r border-gray-800 bg-gray-900/70 p-3.5 space-y-3.5">
                    <SectionCard icon="file" title="Stage" summary={rootPath ? rootPath.split('/').pop() : 'No stage'} defaultOpen>
                        <div data-testid="usd-scene-dropzone" onDragEnter={(e) => { e.preventDefault(); setDragging(true); }} onDragOver={(e) => e.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={async (e) => { e.preventDefault(); setDragging(false); const dropped = await readDroppedItems(e.dataTransfer.items); chooseFiles(dropped.length ? dropped : e.dataTransfer.files); }} className={'rounded-lg border border-dashed p-3 text-xs ' + (dragging ? 'border-blue-400 bg-blue-950/30' : 'border-gray-700')}>
                            Drop a USD stage and its referenced assets here.
                        </div>
                        {candidates.length > 1 ? <label className="mt-3 block text-xs text-gray-300" data-testid="usd-scene-root-select">USD root layer<select className="mt-1 h-8 w-full rounded border border-gray-700 bg-gray-900 px-2 text-xs" value={rootPath} onChange={(e) => { setRootPath(e.target.value); setRootTouched(true); }}><option value="">Select a root layer</option>{candidates.map((f) => <option key={f.path} value={f.path}>{f.path}</option>)}</select></label> : null}
                        {files.length && rootPath ? <button type="button" onClick={() => load()} className="mt-3 w-full rounded bg-emerald-700 px-3 py-2 text-xs hover:bg-emerald-600">Load {rootPath.split('/').pop()}</button> : null}
                        {files.length ? <details className="mt-3 text-xs"><summary className="cursor-pointer text-gray-400">{files.length} input files</summary><div className="mt-2 max-h-40 overflow-auto space-y-1 text-gray-500">{files.map((f) => <div key={f.path} className="truncate" title={f.path}>{f.path}</div>)}</div></details> : null}
                    </SectionCard>
                    <SectionCard icon="sun" title="Environment" summary={envFileName || 'Default environment'} defaultOpen dense>
                        <FilePickerField value={envFileName} placeholder="Default environment" accept=".hdr,.exr" icon="file" onFiles={importEnvironment} onClear={clearImportedEnvironment} />
                        <SliderField disabled={!canTuneEnvironment} label="Environment rotation" unit="deg" value={envRotation} min={0} max={360} step={1} onSlider={(v) => { const n = Number(v); setEnvRotation(n); callHandle('setEnvRotation', n * Math.PI / 180); }} onNumber={(v) => { const n = Number(v); setEnvRotation(n); callHandle('setEnvRotation', n * Math.PI / 180); }} />
                        <SliderField disabled={!canTuneEnvironment || typeof handle.setEnvExposure !== 'function'} label="Exposure" unit="EV" value={envExposure} min={-4} max={4} step={0.1} onSlider={(v) => { const n = Number(v); setEnvExposure(n); callHandle('setEnvExposure', Math.pow(2, n)); }} onNumber={(v) => { const n = Number(v); setEnvExposure(n); callHandle('setEnvExposure', Math.pow(2, n)); }} />
                        <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium text-gray-400">Backdrop</span><MtlxSelect value={backdrop} options={['studio', 'studio-dark', 'environment', 'none']} labels={{ studio: 'Studio', 'studio-dark': 'Studio (Dark)', environment: 'Environment', none: 'None' }} onChange={(value) => { setBackdrop(value); callHandle('setBackdrop', value); }} defValue="studio" size="sm" disabled={!handle || typeof handle.setBackdrop !== 'function'} /></div>
                        <button type="button" onClick={resetEnvironment} className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700">Reset environment</button>
                    </SectionCard>
                    <SectionCard icon="cube" title="Scene summary" summary={meshes.length + ' meshes, ' + materials.length + ' materials'} defaultOpen dense>
                        <div className="grid grid-cols-2 gap-2 text-xs text-gray-300" data-testid="usd-stage-counts"><div>Meshes: <strong>{meshes.length}</strong></div><div>Materials: <strong>{materials.length}</strong></div><div>Warnings: <strong>{warningSummary}</strong></div><div>Root: <strong className="break-all" data-testid="usd-stage-root">{rootPath ? rootPath : 'None'}</strong></div><div data-testid="usd-scene-status">Status: <strong>{status}</strong></div></div>
                        {meshes.length ? <details className="mt-2"><summary className="cursor-pointer text-gray-400">Prim selection</summary><div className="mt-2 space-y-1">{meshes.map((mesh, i) => <button type="button" key={String(mesh.primPath || mesh.path || i)} onClick={() => select(mesh)} className={'block w-full truncate rounded px-2 py-1 text-left ' + (selectedPrim === String(mesh.primPath || mesh.path || mesh.name || '') ? 'bg-blue-900 text-blue-100' : 'text-gray-300 hover:bg-gray-800')}>{String(mesh.primPath || mesh.path || mesh.name || ('mesh ' + (i + 1)))}</button>)}</div></details> : null}
                    </SectionCard>
                    {(materials.length || warnings.length) ? <details data-testid={materials.length ? 'usd-material-provenance' : undefined} open={diagnosticsOpen} onToggle={(e) => setDiagnosticsOpen(e.currentTarget.open)} className="rounded-lg border border-gray-800 bg-gray-900/60 px-3.5 py-3 text-xs"><summary className="cursor-pointer text-gray-400">Diagnostics and material sources</summary><div className="mt-2 space-y-2 break-words text-gray-500">{warnings.length ? <div data-testid="usd-material-warnings">{warningDetails.map((record, i) => <div key={'w' + i} className="text-amber-300/90 break-all"><div>{record.label}</div>{record.raw !== record.label ? <details className="mt-1 text-gray-600"><summary className="cursor-pointer">Raw diagnostic</summary><div className="mt-1 break-all">{record.raw}</div></details> : null}</div>)}</div> : <div>No warnings.</div>}{materials.map((material, i) => <div key={'m' + i} className="break-all">{String(material.materialX && material.materialX.path || material.sourceAsset || material.path || 'Material source unavailable')}</div>)}</div></details> : null}
                </aside>
                <main ref={containerRef} data-testid="usd-scene-canvas" className="relative min-h-[24rem] flex-1 bg-gray-900" aria-label="Rendered USD scene">
                    {(status === 'loading' || status === 'loading-example' || status === 'loaded') ? <div data-testid="usd-scene-progress" className="pointer-events-none absolute left-4 right-4 top-4 z-10 rounded-lg border border-gray-700 bg-gray-900/85 p-3 shadow-lg"><div className="flex items-center justify-between gap-3 text-xs text-gray-300"><span>{progressLabel}</span><span className="truncate text-gray-500">{progressText}</span></div><div role="progressbar" aria-label={progressLabel} aria-valuemin="0" aria-valuemax="100" {...(fraction == null ? {} : { 'aria-valuenow': Math.round(fraction * 100) })} className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-700">{fraction == null ? <div className="mtlx-loading-bar w-full" /> : <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: (fraction * 100) + '%' }} />}</div></div> : null}
                    {status === 'cancelled' ? <div data-testid="usd-scene-progress" className="absolute left-4 right-4 top-4 z-10 rounded-lg border border-gray-700 bg-gray-900/85 p-3 text-xs text-gray-300">Cancelled</div> : null}
                </main>
            </div>
            {error ? <div role="alert" data-testid="usd-scene-error" className="border-t border-red-800 bg-red-950/60 px-3 py-2 text-xs text-red-200 break-words">{error}</div> : null}
            {recordOpen ? <RecordGifDialog open={recordOpen} onClose={() => setRecordOpen(false)} viewRef={handleRef}
                baseName={rootPath ? rootPath.split('/').pop().replace(/\.[^.]+$/, '') : 'usd-scene'} transparent={false} /> : null}
        </div>;
    }
    window.SceneViewerApp = SceneViewerApp;
})();
