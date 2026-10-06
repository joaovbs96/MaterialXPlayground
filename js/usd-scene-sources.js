// Browser bridge for the glTF/GLB, OBJ(+MTL) and pbrt-v4 stage loaders. Mirrors
// js/usd-scene-runtime.js's lazy-import pattern so the same relative
// specifier keeps working in the shell, the VS Code webview and Electron.
(() => {
    const rootKindByExt = { usd: 'usd', usda: 'usd', usdc: 'usd', usdz: 'usd', glb: 'gltf', gltf: 'gltf', obj: 'obj', pbrt: 'pbrt' };

    const extOf = (value) => {
        const path = String(value || '').replace(/\\/g, '/');
        const dot = path.lastIndexOf('.');
        return dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
    };

    // Accepts either a single path/File-like value, or a list of dropped
    // files (each { path } or a File), and reports the first root kind found
    // among the recognized extensions, preferring usd > gltf > pbrt > obj.
    const detectRootKind = (pathOrFiles) => {
        const candidates = [];
        if (Array.isArray(pathOrFiles)) {
            for (const item of pathOrFiles) {
                if (!item) continue;
                candidates.push(typeof item === 'string' ? item : (item.path || item.name || ''));
            }
        } else if (pathOrFiles && typeof pathOrFiles === 'object') {
            candidates.push(pathOrFiles.path || pathOrFiles.name || '');
        } else {
            candidates.push(pathOrFiles || '');
        }
        let best = '';
        let bestRank = -1;
        const rank = { usd: 3, gltf: 2, pbrt: 1, obj: 0 };
        for (const candidate of candidates) {
            const kind = rootKindByExt[extOf(candidate)];
            if (!kind) continue;
            if (rank[kind] > bestRank) { best = kind; bestRank = rank[kind]; }
        }
        return best;
    };

    let pendingGltf;
    const loadGltfModule = () => {
        if (!pendingGltf) pendingGltf = import('./usd/gltf-stage-loader.js');
        return pendingGltf;
    };

    let pendingObj;
    const loadObjModule = () => {
        if (!pendingObj) pendingObj = import('./usd/obj-stage-loader.js');
        return pendingObj;
    };

    let pendingPbrt;
    const loadPbrtModule = () => {
        if (!pendingPbrt) pendingPbrt = import('./usd/pbrt-stage-loader.js');
        return pendingPbrt;
    };

    let pendingExport;
    const loadExportModules = () => {
        if (!pendingExport) pendingExport = Promise.all([import('./usd/usd-stage-export.js'), import('./usd/usd-stage-loader.js')]);
        return pendingExport;
    };

    // Payload -> { blob, filename, warnings } through the OpenUSD worker's ExportStage,
    // which also packages the download. options.onProgress(phase) gets prepare, runtime,
    // write, stage, readback, package; the per-phase timings go to console.debug.
    const exportUsdStage = async (payload, options = {}) => {
        const report = (phase) => { if (typeof options.onProgress === 'function') options.onProgress(phase); };
        const t0 = performance.now();
        report('prepare');
        const [exporter, loader] = await loadExportModules();
        const job = await exporter.buildExportJob(payload, options);
        if (options.signal && options.signal.aborted) throw new DOMException('USD export aborted', 'AbortError');
        const t1 = performance.now();
        const result = await loader.exportUsdStage(
            { spec: job.spec, files: job.files, package: { stem: job.stem, materialMode: job.materialMode, format: job.format } },
            { signal: options.signal, onProgress: (v) => report(v && v.phase) });
        if (!result || !result.ok) throw new Error((result && result.error) || 'USD export failed');
        if (!result.package) throw new Error('The USD runtime returned no package.');
        console.debug('[usd-export] timings ms', JSON.stringify(Object.assign({ build: Math.round(t1 - t0), total: Math.round(performance.now() - t0) }, result.timings || {})));
        const blob = new Blob([result.package.bytes], { type: 'application/octet-stream' });
        return { blob, filename: result.package.filename, warnings: job.warnings.concat(result.warnings || []) };
    };

    window.MtlxSceneSources = {
        exportUsdStage,
        detectRootKind,
        loadGltfStage: (options) => loadGltfModule().then((module) => module.loadGltfStage(options)),
        loadObjStage: (options) => loadObjModule().then((module) => module.loadObjStage(options)),
        loadPbrtStage: (options) => loadPbrtModule().then((module) => module.loadPbrtStage(options)),
    };
})();
