// js/shared/mtlx-handoff.js: cross-reload handoff for the node graph
// editor's unsaved session (document XML plus dropped textures), kept
// alive across a self-triggered reload (new build).
//
// Views call MtlxHandoff.register(view, hooks); capture()/exportForUser()
// run before the reload, consume() restores after. Metadata lives in
// sessionStorage, texture Blobs in IndexedDB (structured-clone, no
// base64). Plain ES5 script, loaded eagerly before Babel/React.

(function () {
    'use strict';

    var SS_KEY = 'mtlx_handoff';
    var DB_NAME = 'mtlx-handoff';
    var DB_STORE = 'blobs';
    var BYTES_BUDGET = 100 * 1024 * 1024; // 100MB

    // view name -> { hasWork, canSave, save, exportForUser }
    var registry = {};

    function register(view, hooks) {
        registry[view] = hooks || {};
    }

    // First registered view that currently reports work, or null. There
    // is only ever one slot of stored state (a single sessionStorage
    // record), so "first with work" is the whole selection policy.
    function findActiveHooks() {
        var views = Object.keys(registry);
        for (var i = 0; i < views.length; i++) {
            var hooks = registry[views[i]];
            var has = false;
            try { has = !!(hooks && hooks.hasWork && hooks.hasWork()); } catch (e) { has = false; }
            if (has) return { view: views[i], hooks: hooks };
        }
        return null;
    }

    // ---- Minimal promise-based IndexedDB blob store. Every failure
    // path resolves (never rejects) so a caller never needs a catch. ----
    function openDb() {
        return new Promise(function (resolve) {
            if (!window.indexedDB) { resolve(null); return; }
            var req;
            try {
                req = window.indexedDB.open(DB_NAME, 1);
            } catch (e) { resolve(null); return; }
            req.onupgradeneeded = function () {
                try { req.result.createObjectStore(DB_STORE); } catch (e) { /* already exists */ }
            };
            req.onsuccess = function () { resolve(req.result || null); };
            req.onerror = function () { resolve(null); };
            req.onblocked = function () { resolve(null); };
        });
    }

    function idbPut(key, blob) {
        return openDb().then(function (db) {
            if (!db) return false;
            return new Promise(function (resolve) {
                try {
                    var tx = db.transaction(DB_STORE, 'readwrite');
                    tx.objectStore(DB_STORE).put(blob, key);
                    tx.oncomplete = function () { db.close(); resolve(true); };
                    tx.onerror = function () { db.close(); resolve(false); };
                    tx.onabort = function () { db.close(); resolve(false); };
                } catch (e) {
                    try { db.close(); } catch (e2) { /* ignore */ }
                    resolve(false);
                }
            });
        });
    }

    function idbGet(key) {
        return openDb().then(function (db) {
            if (!db) return null;
            return new Promise(function (resolve) {
                var result = null;
                try {
                    var tx = db.transaction(DB_STORE, 'readonly');
                    var req = tx.objectStore(DB_STORE).get(key);
                    req.onsuccess = function () { result = req.result || null; };
                    req.onerror = function () { result = null; };
                    tx.oncomplete = function () { db.close(); resolve(result); };
                    tx.onerror = function () { db.close(); resolve(null); };
                    tx.onabort = function () { db.close(); resolve(null); };
                } catch (e) {
                    try { db.close(); } catch (e2) { /* ignore */ }
                    resolve(null);
                }
            });
        });
    }

    function idbClear() {
        return openDb().then(function (db) {
            if (!db) return false;
            return new Promise(function (resolve) {
                try {
                    var tx = db.transaction(DB_STORE, 'readwrite');
                    tx.objectStore(DB_STORE).clear();
                    tx.oncomplete = function () { db.close(); resolve(true); };
                    tx.onerror = function () { db.close(); resolve(false); };
                    tx.onabort = function () { db.close(); resolve(false); };
                } catch (e) {
                    try { db.close(); } catch (e2) { /* ignore */ }
                    resolve(false);
                }
            });
        });
    }

    // Synchronous storage probe: private-browsing IndexedDB (Safari,
    // older Firefox) can throw immediately from open() rather than
    // failing async, so a view's (synchronous) canSave() hook can use
    // this without waiting on a round trip.
    function probeStorageSync() {
        if (!window.indexedDB) {
            return { ok: false, reason: 'browser storage (IndexedDB) is unavailable here, possibly private browsing' };
        }
        try {
            var req = window.indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = function () {
                try { req.result.createObjectStore(DB_STORE); } catch (e) { /* already exists */ }
            };
            req.onerror = function () { /* async failure, the sync probe already reported ok */ };
            req.onsuccess = function () {
                try { req.result.close(); } catch (e) { /* ignore */ }
            };
        } catch (e) {
            return { ok: false, reason: 'a test write to browser storage failed' };
        }
        return { ok: true, reason: null };
    }

    function hasWork() {
        return !!findActiveHooks();
    }

    function canSave() {
        var active = findActiveHooks();
        if (!active) return { ok: true, reason: null, bytes: 0 };
        try {
            var res = active.hooks.canSave ? active.hooks.canSave() : null;
            if (res && typeof res === 'object') {
                return {
                    ok: res.ok !== false,
                    reason: typeof res.reason === 'string' ? res.reason : null,
                    bytes: typeof res.bytes === 'number' ? res.bytes : 0,
                };
            }
        } catch (e) {
            return { ok: false, reason: 'could not check handoff readiness', bytes: 0 };
        }
        return { ok: true, reason: null, bytes: 0 };
    }

    function exportForUser() {
        var active = findActiveHooks();
        if (!active || !active.hooks.exportForUser) return;
        try { active.hooks.exportForUser(); } catch (e) { /* best-effort */ }
    }

    // Captures the active view's document (plus textures) into
    // sessionStorage/IndexedDB. Never rejects; resolves false on any
    // failure so a caller never needs a catch of its own.
    function capture() {
        var active = findActiveHooks();
        if (!active || !active.hooks.save) return Promise.resolve(false);
        var gate;
        try {
            gate = active.hooks.canSave ? active.hooks.canSave() : { ok: true };
        } catch (e) {
            gate = { ok: false };
        }
        if (!gate || gate.ok === false) return Promise.resolve(false);

        var view = active.view;
        return Promise.resolve()
            .then(function () { return active.hooks.save(); })
            .then(function (data) {
                if (!data || data.xml == null) return false;
                var textures = Array.isArray(data.textures) ? data.textures : [];
                var textureRefs = [];
                var chain = Promise.resolve();
                textures.forEach(function (t) {
                    if (!t || !t.ref || !t.blob) return;
                    chain = chain.then(function () {
                        return idbPut(t.ref, t.blob).then(function (ok) {
                            if (ok) textureRefs.push(t.ref);
                        });
                    });
                });
                return chain.then(function () {
                    // window.__MTLX_BUILD (index.html's stamp, see
                    // scripts/lib/build-id.mjs) identifies the build this
                    // was captured under; not compared against anything
                    // on restore, just required to be present.
                    var buildId = (typeof window.__MTLX_BUILD === 'string' && window.__MTLX_BUILD) || String(Date.now());
                    var record = {
                        buildId: buildId,
                        view: view,
                        xml: data.xml,
                        name: data.name || 'document',
                        scope: data.scope || '',
                        textureRefs: textureRefs,
                    };
                    try {
                        sessionStorage.setItem(SS_KEY, JSON.stringify(record));
                    } catch (e) {
                        return false;
                    }
                    // Suppress the next beforeunload prompt (the reload
                    // that's about to happen is intentional); re-armed
                    // after 3s so an aborted reload does not silently
                    // disarm a later genuine close.
                    window.__mtlxSuppressUnloadPrompt = true;
                    setTimeout(function () {
                        window.__mtlxSuppressUnloadPrompt = false;
                    }, 3000);
                    return true;
                });
            })
            .catch(function () { return false; });
    }

    // Reads back and clears the stored record for `view`. Never rejects;
    // resolves null on any failure or when nothing applies to this view.
    function consume(view) {
        var raw = null;
        try { raw = sessionStorage.getItem(SS_KEY); } catch (e) { raw = null; }
        if (!raw) return Promise.resolve(null);
        // Crash-safe: remove the record BEFORE parsing/applying it, so a
        // restore that throws mid-flight can't cause a reload loop.
        try { sessionStorage.removeItem(SS_KEY); } catch (e) { /* best-effort */ }

        var record = null;
        try { record = JSON.parse(raw); } catch (e) { record = null; }

        if (!record || record.buildId == null || typeof record.xml !== 'string' || record.view !== view) {
            idbClear();
            return Promise.resolve(null);
        }

        var refs = Array.isArray(record.textureRefs) ? record.textureRefs : [];
        return Promise.all(refs.map(function (ref) {
            return idbGet(ref).then(function (blob) { return { ref: ref, blob: blob }; });
        })).then(function (pairs) {
            var files = {};
            pairs.forEach(function (p) { if (p.blob) files[p.ref] = p.blob; });
            idbClear();
            return { xml: record.xml, name: record.name || 'document', scope: record.scope || '', files: files };
        }).catch(function () {
            idbClear();
            return null;
        });
    }

    window.MtlxHandoff = {
        register: register,
        hasWork: hasWork,
        canSave: canSave,
        capture: capture,
        exportForUser: exportForUser,
        consume: consume,
        // Extra surface (not part of the documented contract) that lets
        // a view's own canSave() hook share this module's budget/probe
        // logic instead of duplicating IndexedDB handling.
        BYTES_BUDGET: BYTES_BUDGET,
        probeStorageSync: probeStorageSync,
    };
})();
