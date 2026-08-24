// js/shared/mtlx-autosave.js: the graph editor's autosave store.
//
// Persists the unsaved document (name, XML) to localStorage, sync
// readable/writable so a pagehide-time write always lands. Texture
// Blobs go to IndexedDB, written at dirty-flush time (never awaited
// at pagehide). Each tab keeps its own session id, rotated at every
// mount, so an orphaned draft from another tab can be offered for
// recovery. Plain ES5 script, loaded eagerly before Babel/React.

(function () {
    'use strict';

    var LS_PREFIX = 'mtlx_autosave_';
    var SS_TAB = 'mtlx_autosave_tab';
    var SS_CONTINUE = 'mtlx_autosave_continue';
    var DB_NAME = 'mtlx-autosave';
    var DB_STORE = 'blobs';
    var DB_VERSION = 1;
    var BYTES_BUDGET = 100 * 1024 * 1024; // 100MB
    var XML_MAX = 2 * 1024 * 1024; // 2MB
    var BEAT_MS = 20000;
    var STALE_MS = 180000;
    var AGE_MAX_MS = 7 * 24 * 3600 * 1000;

    // This tab's current session id (set by adoptSession) and the last
    // record written under it, kept in memory so beat()/writeRecord()
    // never need to re-read localStorage.
    var currentId = null;
    var lastRecord = null;
    var availableCache = null;

    function makeId() {
        var i, h, hex;
        if (window.crypto && window.crypto.getRandomValues) {
            var bytes = new Uint8Array(6);
            window.crypto.getRandomValues(bytes);
            hex = '';
            for (i = 0; i < bytes.length; i++) {
                h = bytes[i].toString(16);
                hex += h.length === 1 ? '0' + h : h;
            }
            return hex;
        }
        hex = '';
        for (i = 0; i < 12; i++) {
            hex += Math.floor(Math.random() * 16).toString(16);
        }
        return hex;
    }

    // ---- Minimal promise-based IndexedDB blob store, mirroring
    // mtlx-handoff.js's shape. Every failure path resolves (never
    // rejects) so a caller never needs a catch. ----
    function openDb() {
        return new Promise(function (resolve) {
            if (!window.indexedDB) { resolve(null); return; }
            var req;
            try {
                req = window.indexedDB.open(DB_NAME, DB_VERSION);
            } catch (e) { resolve(null); return; }
            req.onupgradeneeded = function () {
                try { req.result.createObjectStore(DB_STORE); } catch (e) { /* already exists */ }
            };
            req.onsuccess = function () { resolve(req.result || null); };
            req.onerror = function () { resolve(null); };
            req.onblocked = function () { resolve(null); };
        });
    }

    function available() {
        if (availableCache !== null) return availableCache;
        var canary = LS_PREFIX + 'canary';
        try {
            window.localStorage.setItem(canary, '1');
            window.localStorage.removeItem(canary);
            availableCache = true;
        } catch (e) {
            availableCache = false;
        }
        return availableCache;
    }

    function adoptSession() {
        var prevId = null;
        try { prevId = sessionStorage.getItem(SS_TAB); } catch (e) { prevId = null; }
        var id = makeId();
        try { sessionStorage.setItem(SS_TAB, id); } catch (e) { /* best-effort */ }
        var continueId = null;
        try {
            continueId = sessionStorage.getItem(SS_CONTINUE);
            sessionStorage.removeItem(SS_CONTINUE);
        } catch (e) { continueId = null; }
        currentId = id;
        lastRecord = null;
        return { id: id, prevId: prevId, continueId: continueId };
    }

    function writeRecord(fields) {
        if (!currentId) return false;
        fields = fields || {};
        if (typeof fields.xml === 'string' && fields.xml.length > XML_MAX) return false;

        var merged = {};
        var src = lastRecord || {};
        var k;
        for (k in src) { if (src.hasOwnProperty(k)) merged[k] = src[k]; }
        for (k in fields) { if (fields.hasOwnProperty(k)) merged[k] = fields[k]; }

        var now = Date.now();
        merged.v = 1;
        merged.savedAt = now;
        merged.beat = now;
        merged.buildId = (typeof window.__MTLX_BUILD === 'string' && window.__MTLX_BUILD) || String(Date.now());

        try {
            window.localStorage.setItem(LS_PREFIX + currentId, JSON.stringify(merged));
        } catch (e) {
            return false;
        }
        lastRecord = merged;
        return true;
    }

    function beat() {
        if (!currentId || !lastRecord) return;
        lastRecord.beat = Date.now();
        try {
            window.localStorage.setItem(LS_PREFIX + currentId, JSON.stringify(lastRecord));
        } catch (e) { /* best-effort */ }
    }

    function clearCurrent() {
        if (!currentId) return;
        try { window.localStorage.removeItem(LS_PREFIX + currentId); } catch (e) { /* best-effort */ }
        lastRecord = null;
    }

    function readRecord(id) {
        var raw = null;
        try { raw = window.localStorage.getItem(LS_PREFIX + id); } catch (e) { raw = null; }
        if (!raw) return null;
        var record = null;
        try { record = JSON.parse(raw); } catch (e) { record = null; }
        if (!record || typeof record !== 'object') return null;
        record.id = id;
        return record;
    }

    function listSessions() {
        var out = [];
        var keys = [];
        try { keys = Object.keys(window.localStorage); } catch (e) { keys = []; }
        for (var i = 0; i < keys.length; i++) {
            if (keys[i].indexOf(LS_PREFIX) !== 0) continue;
            var record = readRecord(keys[i].slice(LS_PREFIX.length));
            if (record) out.push(record);
        }
        return out;
    }

    function removeSession(id) {
        try { window.localStorage.removeItem(LS_PREFIX + id); } catch (e) { /* best-effort */ }
        deleteSessionBlobs(id);
    }

    // Offerable: crash-ish siblings only, not currentId or live tabs.
    // closedAt set or a stale heartbeat means crash-ish; prevId (this
    // tab's earlier rotation) sorts first, then savedAt descending.
    function offerable(currentId, prevId) {
        var all = listSessions();
        var now = Date.now();
        var out = [];
        for (var i = 0; i < all.length; i++) {
            var record = all[i];
            if (record.id === currentId) continue;
            var savedAt = typeof record.savedAt === 'number' ? record.savedAt : 0;
            if (now - savedAt > AGE_MAX_MS) {
                removeSession(record.id);
                continue;
            }
            var beatAt = typeof record.beat === 'number' ? record.beat : savedAt;
            var stale = (now - beatAt) > STALE_MS;
            if (record.closedAt != null || stale) out.push(record);
        }
        out.sort(function (a, b) {
            if (a.id === prevId) return -1;
            if (b.id === prevId) return 1;
            return (b.savedAt || 0) - (a.savedAt || 0);
        });
        return out;
    }

    // One open/transaction for the whole batch, not per blob like the
    // old handoff capture() chain. Stops once the running byte total
    // would exceed BYTES_BUDGET; resolves the keys actually stored.
    function putBlobs(id, entries) {
        entries = entries || [];
        return openDb().then(function (db) {
            if (!db) return [];
            return new Promise(function (resolve) {
                var toPut = [];
                var total = 0;
                for (var i = 0; i < entries.length; i++) {
                    var entry = entries[i];
                    if (!entry || !entry.key || !entry.blob) continue;
                    total += entry.blob.size || 0;
                    if (total > BYTES_BUDGET) break;
                    toPut.push(entry);
                }
                if (!toPut.length) {
                    try { db.close(); } catch (e) { /* ignore */ }
                    resolve([]);
                    return;
                }
                try {
                    var stored = [];
                    var tx = db.transaction(DB_STORE, 'readwrite');
                    var store = tx.objectStore(DB_STORE);
                    for (var j = 0; j < toPut.length; j++) {
                        store.put(toPut[j].blob, id + '/' + toPut[j].key);
                        stored.push(toPut[j].key);
                    }
                    tx.oncomplete = function () { db.close(); resolve(stored); };
                    tx.onerror = function () { db.close(); resolve([]); };
                    tx.onabort = function () { db.close(); resolve([]); };
                } catch (e) {
                    try { db.close(); } catch (e2) { /* ignore */ }
                    resolve([]);
                }
            });
        });
    }

    function getBlobs(id) {
        return openDb().then(function (db) {
            if (!db) return {};
            return new Promise(function (resolve) {
                var out = {};
                try {
                    var range = IDBKeyRange.bound(id + '/', id + '/' + String.fromCharCode(0xffff));
                    var tx = db.transaction(DB_STORE, 'readonly');
                    var store = tx.objectStore(DB_STORE);
                    if (store.getAll && store.getAllKeys) {
                        var keysReq = store.getAllKeys(range);
                        var valuesReq = store.getAll(range);
                        tx.oncomplete = function () {
                            db.close();
                            var keys = keysReq.result || [];
                            var values = valuesReq.result || [];
                            for (var i = 0; i < keys.length; i++) {
                                out[String(keys[i]).slice(id.length + 1)] = values[i];
                            }
                            resolve(out);
                        };
                    } else {
                        var cursorReq = store.openCursor(range);
                        cursorReq.onsuccess = function (event) {
                            var cursor = event.target.result;
                            if (cursor) {
                                out[String(cursor.key).slice(id.length + 1)] = cursor.value;
                                cursor.continue();
                            }
                        };
                        tx.oncomplete = function () { db.close(); resolve(out); };
                    }
                    tx.onerror = function () { db.close(); resolve({}); };
                    tx.onabort = function () { db.close(); resolve({}); };
                } catch (e) {
                    try { db.close(); } catch (e2) { /* ignore */ }
                    resolve({});
                }
            });
        });
    }

    function deleteSessionBlobs(id) {
        return openDb().then(function (db) {
            if (!db) return false;
            return new Promise(function (resolve) {
                try {
                    var range = IDBKeyRange.bound(id + '/', id + '/' + String.fromCharCode(0xffff));
                    var tx = db.transaction(DB_STORE, 'readwrite');
                    tx.objectStore(DB_STORE).delete(range);
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

    function listSessionIds() {
        return openDb().then(function (db) {
            if (!db) return [];
            return new Promise(function (resolve) {
                try {
                    var tx = db.transaction(DB_STORE, 'readonly');
                    var req = tx.objectStore(DB_STORE).getAllKeys();
                    tx.oncomplete = function () {
                        db.close();
                        var keys = req.result || [];
                        var seen = {};
                        var ids = [];
                        for (var i = 0; i < keys.length; i++) {
                            var slash = String(keys[i]).indexOf('/');
                            if (slash < 0) continue;
                            var sid = String(keys[i]).slice(0, slash);
                            if (!seen[sid]) { seen[sid] = true; ids.push(sid); }
                        }
                        resolve(ids);
                    };
                    tx.onerror = function () { db.close(); resolve([]); };
                    tx.onabort = function () { db.close(); resolve([]); };
                } catch (e) {
                    try { db.close(); } catch (e2) { /* ignore */ }
                    resolve([]);
                }
            });
        });
    }

    // Sync pass drops age-expired records. Async pass drops blob
    // namespaces with no matching record (crash before any write) and
    // sweeps legacy mtlx-handoff leftovers, best-effort.
    function gcSweep(currentId) {
        var now = Date.now();
        var all = listSessions();
        for (var i = 0; i < all.length; i++) {
            var savedAt = typeof all[i].savedAt === 'number' ? all[i].savedAt : 0;
            if (now - savedAt > AGE_MAX_MS) removeSession(all[i].id);
        }

        listSessionIds().then(function (ids) {
            for (var j = 0; j < ids.length; j++) {
                if (ids[j] === currentId) continue;
                var raw = null;
                try { raw = window.localStorage.getItem(LS_PREFIX + ids[j]); } catch (e) { raw = null; }
                if (!raw) deleteSessionBlobs(ids[j]);
            }
        });

        try { sessionStorage.removeItem('mtlx_handoff'); } catch (e) { /* best-effort */ }
        try { window.indexedDB && window.indexedDB.deleteDatabase('mtlx-handoff'); } catch (e) { /* best-effort */ }
    }

    function setContinueMarker() {
        if (!currentId) return;
        try { sessionStorage.setItem(SS_CONTINUE, currentId); } catch (e) { /* best-effort */ }
    }

    // Sync probe: private-browsing IndexedDB (Safari, older Firefox)
    // can throw immediately from open() instead of failing async, so a
    // synchronous canSave() hook can use this without a round trip.
    function probeStorageSync() {
        if (!window.indexedDB) {
            return { ok: false, reason: 'browser storage (IndexedDB) is unavailable here, possibly private browsing' };
        }
        try {
            var req = window.indexedDB.open(DB_NAME, DB_VERSION);
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

    window.MtlxAutosave = {
        available: available,
        adoptSession: adoptSession,
        writeRecord: writeRecord,
        beat: beat,
        clearCurrent: clearCurrent,
        readRecord: readRecord,
        listSessions: listSessions,
        offerable: offerable,
        removeSession: removeSession,
        putBlobs: putBlobs,
        getBlobs: getBlobs,
        deleteSessionBlobs: deleteSessionBlobs,
        listSessionIds: listSessionIds,
        gcSweep: gcSweep,
        setContinueMarker: setContinueMarker,
        probeStorageSync: probeStorageSync,
        // Extra surface (not part of the documented method list) so a
        // view's heartbeat timer and budget checks share these values
        // instead of hardcoding them.
        BYTES_BUDGET: BYTES_BUDGET,
        BEAT_MS: BEAT_MS,
        STALE_MS: STALE_MS,
    };
})();
