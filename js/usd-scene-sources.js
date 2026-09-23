// Browser bridge for the glTF/GLB and OBJ(+MTL) stage loaders. Mirrors
// js/usd-scene-runtime.js's lazy-import pattern so the same relative
// specifier keeps working in the shell, the VS Code webview and Electron.
(() => {
    const rootKindByExt = { usd: 'usd', usda: 'usd', usdc: 'usd', usdz: 'usd', glb: 'gltf', gltf: 'gltf', obj: 'obj' };

    const extOf = (value) => {
        const path = String(value || '').replace(/\\/g, '/');
        const dot = path.lastIndexOf('.');
        return dot === -1 ? '' : path.slice(dot + 1).toLowerCase();
    };

    // Accepts either a single path/File-like value, or a list of dropped
    // files (each { path } or a File), and reports the first root kind found
    // among the recognized extensions, preferring usd > gltf > obj.
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
        const rank = { usd: 2, gltf: 1, obj: 0 };
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

    window.MtlxSceneSources = {
        detectRootKind,
        loadGltfStage: (options) => loadGltfModule().then((module) => module.loadGltfStage(options)),
        loadObjStage: (options) => loadObjModule().then((module) => module.loadObjStage(options)),
    };
})();
