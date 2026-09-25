// js/mxslc-worker.js: dedicated module Worker running mxslc's decompiler.
//
// Plain ESM, not Babel-transformed (loaded directly as { type: 'module' },
// mirroring js/usd/usd-stage-worker.js). Kept off the main thread because
// decompileMtlxToSlx() on a large MaterialX document can run for minutes,
// and a Worker is the only way to make that call abortable (terminate()).

let mxslcPromise = null;

function loadMxslc(entryUrl) {
    if (!mxslcPromise) {
        mxslcPromise = import(entryUrl).then((ns) => {
            const factory = ns.default;
            if (typeof factory !== 'function') {
                throw new Error('mxslc worker: JsMxslc.js default export is not a function');
            }
            return factory({ locateFile: (p) => new URL(p, entryUrl).href });
        });
    }
    return mxslcPromise;
}

self.onmessage = async (event) => {
    const { id, op, xml, entryUrl } = event.data || {};
    if (op !== 'decompile') return;
    try {
        const mxslc = await loadMxslc(entryUrl);
        const t0 = performance.now();
        const code = mxslc.decompileMtlxToSlx(xml);
        const ms = performance.now() - t0;
        self.postMessage({ id, ok: true, code, ms });
    } catch (e) {
        const msg = (e && e.message) || String(e);
        self.postMessage({ id, ok: false, error: msg });
    }
};
