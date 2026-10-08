// Browser bridge for the glTF/GLB, OBJ(+MTL), pbrt-v4 and Mitsuba stage loaders. Mirrors
// js/usd-scene-runtime.js's lazy-import pattern so the same relative
// specifier keeps working in the shell, the VS Code webview and Electron.
(() => {
    const rootKindByExt = { usd: 'usd', usda: 'usd', usdc: 'usd', usdz: 'usd', glb: 'gltf', gltf: 'gltf', obj: 'obj', pbrt: 'pbrt', xml: 'mitsuba' };

    const extOf = (value) => {
        const path = String(value || '').replace(/\\/g, '/');
        const dot = path.lastIndexOf('.');
        return dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
    };

    // Accepts either a single path/File-like value, or a list of dropped
    // files (each { path } or a File), and reports the first root kind found
    // among the recognized extensions, preferring usd > gltf > pbrt > mitsuba > obj
    // (by extension only; detectRootKindForFiles checks a Mitsuba root's content).
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
        const rank = { usd: 4, gltf: 3, pbrt: 2, mitsuba: 1, obj: 0 };
        for (const candidate of candidates) {
            const kind = rootKindByExt[extOf(candidate)];
            if (!kind) continue;
            if (rank[kind] > bestRank) { best = kind; bestRank = rank[kind]; }
        }
        return best;
    };

    // Mitsuba detection is by content, not by .xml: see classifyMitsubaXmlFiles
    // in js/usd/scene-import-common.js.
    let pendingCommon;
    const loadCommonModule = () => {
        if (!pendingCommon) pendingCommon = import('./usd/scene-import-common.js');
        return pendingCommon;
    };
    const classifyMitsubaXmlFiles = (files) => loadCommonModule().then((module) => module.classifyMitsubaXmlFiles(files));
    // JSZip loads lazily (registry entry "jszip"), only when a .zip is chosen.
    const expandSceneZips = (entries) => loadCommonModule().then((module) => module.expandSceneZips(entries, async (data) => {
        const JSZipLib = await window.MtlxVendor.load('jszip');
        return JSZipLib.loadAsync(data);
    }));
    // detectRootKind plus the content check: an .xml root that is not a Mitsuba
    // scene gives '' (no supported scene).
    const detectRootKindForFiles = async (files, rootPath) => {
        const kind = detectRootKind(rootPath);
        if (kind !== 'mitsuba') return kind;
        const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
        const key = norm(rootPath);
        const entry = (Array.isArray(files) ? files : []).find((f) => f && norm(f.path) === key);
        if (!entry) return kind;
        const module = await loadCommonModule();
        const text = await module.readEntryText(entry.data);
        return module.mitsubaSceneInfo(text) ? kind : '';
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

    let pendingMitsuba;
    const loadMitsubaModule = () => {
        if (!pendingMitsuba) pendingMitsuba = import('./usd/mitsuba-stage-loader.js');
        return pendingMitsuba;
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
        detectRootKindForFiles,
        classifyMitsubaXmlFiles,
        expandSceneZips,
        loadGltfStage: (options) => loadGltfModule().then((module) => module.loadGltfStage(options)),
        loadObjStage: (options) => loadObjModule().then((module) => module.loadObjStage(options)),
        // A lone .mtl library as one MaterialX document: { xml, name, files } (desktop app).
        convertMtlLibrary: (files, rootPath) => loadObjModule().then((module) => module.convertMtlLibrary({ files, rootPath })),
        loadPbrtStage: (options) => loadPbrtModule().then((module) => module.loadPbrtStage(options)),
        loadMitsubaStage: (options) => loadMitsubaModule().then((module) => module.loadMitsubaStage(options)),
    };
})();
