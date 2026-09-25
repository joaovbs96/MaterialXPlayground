// js/mxslc-engine.js — ShadingLanguageX (.mxsl) WASM compiler loader.
//
// Lazily loads the mxslc WebAssembly bindings (vendor/mxslc/JsMxslc.js,
// fetched from a pinned ShadingLanguageX GitHub release by `npm run vendor`,
// see the "mxslc" entry in scripts/vendor-deps.mjs) and exposes two entry
// points to graph-app.jsx and viewer-app.jsx:
//
//   - expandMxsl(), used by ingest() the same way it already uses
//     expandZips() from mtlx-engine.js: given a dropped/opened file map,
//     any .mxsl entries are compiled to MaterialX XML in place and re-keyed
//     with a .mtlx extension, so everything downstream (root-document
//     detection, xi:include resolution, texture binding) treats a compiled
//     .mxsl document exactly like a hand-authored .mtlx one.
//   - slxExportStages(), used by the "Export Shader Code…" dialog's
//     ShadingLanguageX target to turn the CURRENT (possibly hand-edited)
//     MaterialX document back into SLX source, via mxslc's decompiler.
//
// Multi-file projects: the mxslc WASM binding's CompileOptions.addSource
// registers sibling files by relative path for #include / #library
// resolution (see the ShadingLanguageX repo's mxslc++/javascript/README.md).
// expandMxsl() infers which dropped .mxsl file is the compile root by
// scanning every .mxsl file's text for #include/#library directives: a
// file no other file's directives name is a root candidate. Each candidate
// is compiled with every other .mxsl/.mtlx sibling in the drop offered up
// as a virtual file, and every candidate that compiles successfully is
// written back into the map as its own .mtlx entry. When that yields more
// than one .mtlx document, each app's existing "this drop contains several
// .mtlx files" picker (already used for plain multi-document .mtlx drops)
// is what lets the user disambiguate — no separate UI is needed for .mxsl
// projects.

// Lazy: only fetched the first time a .mxsl file is opened or a
// ShadingLanguageX export is requested. MtlxVendor.load caches the
// result and drops a failed attempt from its cache automatically.
const getMxslcModule = () => MtlxVendor.load('mxslc');

// Compile one SLX source string to a MaterialX XML string. `files` is an
// optional plain object mapping a relative path — exactly as it would
// appear inside a #include "..." or #library "..." directive in `source`
// — to that sibling file's text; pass null/undefined for a self-contained
// compile with no siblings. `label` is only used to make a thrown error
// identify which file failed.
const compileMxslcSource = async (source, files, label) => {
    const mxslc = await getMxslcModule();

    const opts = new mxslc.CompileOptions();
    try {
        for (const [path, contents] of Object.entries(files || {})) {
            opts.addSource(path, contents);
        }
        return mxslc.compileSlxToMtlx(source, opts);
    } catch (e) {
        // JsMxslc.cpp rethrows C++ exceptions as real Error objects
        // (CompileError / Error), so e.message is already a readable
        // compiler diagnostic — just attach which file it came from.
        const msg = (e && e.message) || String(e);
        throw new Error('ShadingLanguageX compile error in ' + label + ':\n' + msg);
    } finally {
        opts.delete(); // embind object: not garbage-collected automatically
    }
};

// Decompiling a large graph (thousands of nodes) can run for minutes on
// the mxslc WASM module, so it runs in a dedicated worker (js/mxslc-worker.js)
// instead of the main thread: a worker is also the only way to actually
// stop an in-flight call (terminate()), which an AbortSignal alone cannot
// do for synchronous WASM. One worker is kept warm and reused across
// decompiles; an aborted call terminates it and the next call boots a
// fresh one.
let mxslcWorker = null;
let mxslcNextRequestId = 1;

const discardMxslcWorker = () => {
    if (mxslcWorker) {
        try { mxslcWorker.terminate(); } catch (e) { /* already gone */ }
    }
    mxslcWorker = null;
};

const ensureMxslcWorker = () => {
    if (!mxslcWorker) {
        mxslcWorker = new Worker(new URL('js/mxslc-worker.js', document.baseURI), { type: 'module' });
    }
    return mxslcWorker;
};

// Decompile a MaterialX XML string to ShadingLanguageX source, via the
// SAME mxslc module compileMxslcSource uses (a completely separate WASM
// module from the main MaterialX engine, see js/mtlx-engine.js, run off
// the main thread in js/mxslc-worker.js). Used by the "Export Shader
// Code..." dialog's ShadingLanguageX target. Resolves { code, ms }, ms
// being the worker's own decompile time so the dialog can show it.
// `signal`, if given and already aborted or aborted while the call is in
// flight, terminates the worker and rejects with an AbortError.
const decompileMtlxToSlx = (xml, { signal } = {}) => {
    if (signal && signal.aborted) {
        return Promise.reject(new DOMException('ShadingLanguageX decompile aborted', 'AbortError'));
    }

    let worker;
    try {
        worker = ensureMxslcWorker();
    } catch (e) {
        discardMxslcWorker();
        const msg = (e && e.message) || String(e);
        return Promise.reject(new Error('ShadingLanguageX decompile worker could not be created:\n' + msg));
    }

    const id = mxslcNextRequestId++;
    const entryUrl = MtlxVendor.url('mxslc', 'JsMxslc.js');

    return new Promise((resolve, reject) => {
        let settled = false;
        const onAbort = () => {
            if (settled) return;
            settled = true;
            discardMxslcWorker(); // only way to stop a running WASM call
            reject(new DOMException('ShadingLanguageX decompile aborted', 'AbortError'));
        };
        const cleanup = () => {
            if (signal) signal.removeEventListener('abort', onAbort);
            worker.removeEventListener('message', onMessage);
            worker.removeEventListener('error', onError);
        };
        const onMessage = (event) => {
            const msg = event.data;
            if (!msg || msg.id !== id || settled) return;
            settled = true;
            cleanup();
            if (msg.ok) {
                resolve({ code: msg.code, ms: msg.ms });
            } else {
                reject(new Error('ShadingLanguageX decompile error:\n' + msg.error));
            }
        };
        const onError = (event) => {
            if (settled) return;
            settled = true;
            cleanup();
            discardMxslcWorker(); // worker is in an unknown state
            reject(new Error('ShadingLanguageX decompile worker failed: ' + ((event && event.message) || 'unknown error')));
        };
        worker.addEventListener('message', onMessage);
        worker.addEventListener('error', onError);
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        try {
            worker.postMessage({ id, op: 'decompile', xml, entryUrl });
        } catch (e) {
            settled = true;
            cleanup();
            discardMxslcWorker();
            reject(new Error('ShadingLanguageX decompile request could not cross Worker boundary:\n' + ((e && e.message) || String(e))));
        }
    });
};

// ShaderExportDialog stages for the ShadingLanguageX target, shared by the
// graph editor and the viewer. Returns immediately: "Original" (the
// as-authored .mxsl source, only when the document was compiled from one)
// carries its code inline, but "Decompiled" is lazy: a `load(signal)`
// the dialog calls when that stage is actually shown, so the instantly
// available Original stage is never blocked behind the slow decompile,
// and the caller controls when (and whether) it runs.
const slxExportStages = async (xml, originalSource) => {
    const stages = [];
    if (originalSource != null) stages.push({ id: 'original', label: 'Original', code: originalSource });
    stages.push({ id: 'decompiled', label: 'Decompiled', load: (signal) => decompileMtlxToSlx(xml, { signal }) });
    return { stages };
};

// A #include "..." or #library "..." directive's target, e.g. "colors.mxsl"
// or "utils.mtlx" — LanguageSpecification.md's File Inclusion section.
const DIRECTIVE_RE = /#\s*(?:include|library)\s*"([^"]+)"/g;

// Dropping a whole folder (folder drag-and-drop / the directory file
// picker) reports every entry's path prefixed with the folder's own name
// (File#webkitRelativePath), but a directive inside those files names
// siblings relative to the folder's *contents*, never that outer name. If
// every candidate key shares one leading path segment, strip it so keys
// compare the same way the compiler itself would resolve them; otherwise
// (flat files, or a mixed selection) leave keys exactly as given.
const stripCommonFolderPrefix = (keys) => {
    const parts = keys.map((k) => k.split('/'));
    if (parts.length && parts.every((p) => p.length > 1 && p[0] === parts[0][0])) {
        const prefixLen = parts[0][0].length + 1;
        return (key) => key.slice(prefixLen);
    }
    return (key) => key;
};

// Expand any .mxsl files in the map into their compiled .mtlx equivalent
// (in place), mirroring expandZips(map) in mtlx-engine.js. Called AFTER
// expandZips in ingest(), so a .mxsl shipped inside a .zip is also caught.
//
// `origins`, if given, is a plain object this function populates with
// {compiledMtlxKey: {source, filename, files}} for every root it
// successfully compiles — graph-app.jsx and viewer-app.jsx use this to
// know, once a specific .mtlx path is actually loaded as the active
// document, whether it has .mxsl provenance, what its as-authored source
// looked like (the "Original" button in the ShadingLanguageX export target,
// and the graph editor's code view) and what it was originally named
// (rootKey, before it was re-keyed to compiledMtlxKey). `files` is the
// sibling map it was compiled with, so the code view can recompile it.
// Omit it to just expand.
//
// `failures`, if given, is a plain array this function pushes
// {rootKey, message} onto for every root candidate that fails to
// compile, so callers can warn about the ones silently dropped.
const expandMxsl = async (map, origins, failures) => {
    const mxslKeys = Object.keys(map).filter((k) => /\.mxsl$/i.test(k));
    if (!mxslKeys.length) return map;

    // Everything a directive could plausibly target: other .mxsl sources
    // (#include) and any .mtlx files dropped alongside them (#library).
    const siblingKeys = Object.keys(map).filter((k) => /\.(mxsl|mtlx)$/i.test(k));
    const effectiveKey = stripCommonFolderPrefix(siblingKeys);

    // Read every candidate's text once, keyed by its effective (prefix-
    // stripped) path — the form a directive would actually reference.
    const textByEffectiveKey = {};
    for (const key of siblingKeys) {
        textByEffectiveKey[effectiveKey(key)] = await map[key].text();
    }

    // A .mxsl file that some other file's #include/#library directive
    // names is not a root — it's pulled in by whichever file does name
    // it. Compare both the full effective path and the bare filename, so
    // a directive written as "colors.mxsl" still matches a file reported
    // as "sub/colors.mxsl".
    const included = new Set();
    for (const key of mxslKeys) {
        let m;
        DIRECTIVE_RE.lastIndex = 0;
        while ((m = DIRECTIVE_RE.exec(textByEffectiveKey[effectiveKey(key)])) !== null) {
            included.add(m[1]);
            included.add(m[1].split('/').pop());
        }
    }
    const isIncluded = (ek) => included.has(ek) || included.has(ek.split('/').pop());

    let rootKeys = mxslKeys.filter((k) => !isIncluded(effectiveKey(k)));
    if (!rootKeys.length) {
        // Nothing looked like a leaf (e.g. a cyclic or otherwise
        // unusual set of directives) — fall back to trying every .mxsl
        // file as its own root rather than refusing the whole drop.
        rootKeys = mxslKeys.slice();
    }

    let lastError = null;
    const compiled = [];
    for (const rootKey of rootKeys) {
        const rootEk = effectiveKey(rootKey);
        const rootSource = textByEffectiveKey[rootEk];
        const files = {};
        for (const ek of Object.keys(textByEffectiveKey)) {
            if (ek !== rootEk) files[ek] = textByEffectiveKey[ek];
        }
        try {
            const xml = await compileMxslcSource(rootSource, files, rootKey);
            compiled.push({ rootKey, xml, source: rootSource, files });
        } catch (e) {
            // Not every root candidate necessarily compiles on its own
            // (e.g. the heuristic above can admit a genuine include as a
            // "root" when it's also never #include'd by anything else in
            // the drop) — skip it and keep the ones that do.
            lastError = e;
            // Recorded for the caller, message trimmed to its first line.
            if (failures) failures.push({ rootKey, message: ((e && e.message) || String(e)).split('\n')[0] });
        }
    }

    for (const key of mxslKeys) delete map[key];

    if (!compiled.length) {
        throw lastError || new Error('No .mxsl file in this drop compiled successfully.');
    }

    for (const { rootKey, xml, source, files } of compiled) {
        const mtlxKey = rootKey.replace(/\.mxsl$/i, '.mtlx');
        if (Object.prototype.hasOwnProperty.call(map, mtlxKey)) {
            console.warn('expandMxsl: ' + mtlxKey + ' was already present in this drop — overwriting it with the document compiled from ' + rootKey);
        }
        map[mtlxKey] = new Blob([xml], { type: 'application/xml' });
        if (origins) origins[mtlxKey] = { source, filename: rootKey, files };
    }
    return map;
};

// Exported for parity with mtlx-engine.js's own Object.assign(window, {...})
// at its tail (real ES modules — e.g. a future VS Code webview path — can't
// see this classic script's top-level bindings otherwise). graph-app.jsx
// and viewer-app.jsx are sibling classic <script type="text/babel">s, so
// they reach slxExportStages as a bare identifier, exactly like expandZips.
// viewer-app.jsx reaches expandMxsl via window instead, because the embed
// bundle (embed/viewer.html) doesn't load this file.
Object.assign(window, { getMxslcModule, compileMxslcSource, decompileMtlxToSlx, slxExportStages, expandMxsl });
