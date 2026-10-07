// glue.js: main-world glue between the Electron preload's mtlxDesktop
// bridge and the UNMODIFIED site, installed via webFrame.executeJavaScript.
// Ported from vscode_extension/media/bootstrap.js's handleOpen('both') contract.
(function () {
    'use strict';
    if (window.__mtlxGlueInstalled) return;
    window.__mtlxGlueInstalled = true;
    if (!window.mtlxDesktop) return;

    // Reports the applied theme's base and frame colors so main can paint nativeTheme, window background and titlebar.
    window.addEventListener('mtlx-theme-change', function (e) {
        var d = e && e.detail;
        if (!d || typeof d.preference !== 'string' || !window.__mtlxThemeReport) return;
        var T = window.MtlxTheme;
        var native = T && T.get ? {
            windowBg: T.get('native-window-bg'),
            titlebar: T.get('native-titlebar'),
            titlebarSymbol: T.get('native-titlebar-symbol'),
        } : null;
        window.__mtlxThemeReport(d.preference, d.base, native);
    });

    // Mirrors bootstrap.js's handleOpen('both') exactly, but skips base64:
    // contextBridge/IPC carry Uint8Array/TypedArrays by copy natively, unlike
    // the webview postMessage channel bootstrap.js has to work around.
    window.mtlxDesktop.onOpenFile(function (payload) {
        if (!payload) return;
        var rawFiles = payload.files || null;
        var blobMap = null;
        if (rawFiles) {
            blobMap = {};
            Object.keys(rawFiles).forEach(function (key) {
                blobMap[key] = new Blob([rawFiles[key]]);
            });
        }
        var loaded = { xml: payload.xml, name: payload.name, files: blobMap, reload: payload.reload };
        window.__mtlxPendingImport = loaded;
        window.__mtlxPendingViewerImport = loaded;
        window.dispatchEvent(new CustomEvent('mtlx-load-document', { detail: loaded }));
        window.dispatchEvent(new CustomEvent('mtlx-view-document', { detail: loaded }));
    });

    // js/graph-app.jsx calls this with the serialized XML STRING on every
    // settled edit (not a boolean): any call simply means "now dirty".
    // The desktop bridge itself clears dirty again on a successful save.
    window.__mtlxNotifyEdit = function () {
        window.mtlxDesktop.notifyEdit(true);
    };

    // Wired to the native Save/Save As menu items (main.js's saveFromMenu),
    // which drive onRequestSave and onSaveCommitted via the IPC round trip.
    window.mtlxDesktop.onRequestSave(function () {
        if (typeof window.__mtlxGetGraphXml !== 'function') {
            return Promise.reject(new Error('graph view is not open'));
        }
        return window.__mtlxGetGraphXml();
    });
    window.mtlxDesktop.onSaveCommitted(function () {
        if (typeof window.__mtlxMarkGraphSaved === 'function') window.__mtlxMarkGraphSaved();
    });

    // New/Export/Undo/Redo forward here from the native menu (main.js's
    // sendMenuCommand); an editable-focused field gets the OS text-edit
    // command instead, mirroring graph-app.jsx's own Ctrl+C/V/Z guard.
    window.mtlxDesktop.onMenuCommand(function (cmd) {
        if (cmd === 'undo' || cmd === 'redo') {
            var active = document.activeElement;
            var isEditable = active && (active.isContentEditable
                || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName || ''));
            if (isEditable) {
                document.execCommand(cmd);
                return;
            }
        }
        window.dispatchEvent(new CustomEvent('mtlx-desktop-command', { detail: { cmd: cmd } }));
    });

    // Shell-level styled close-confirm dialog (js/shell.jsx). Token is
    // kept here, not exposed to shell.jsx, and echoed back so a stale
    // response after the native fallback wins is a no-op in main.
    var pendingCloseConfirmToken = null;
    window.mtlxDesktop.onCloseConfirmRequest(function (payload) {
        pendingCloseConfirmToken = payload && payload.token;
        window.dispatchEvent(new CustomEvent('mtlx-desktop-close-confirm', { detail: payload }));
    });
    window.__mtlxRespondCloseConfirm = function (choice) {
        window.mtlxDesktop.respondCloseConfirm({ token: pendingCloseConfirmToken, choice: choice });
    };

    // Shell-level settings dialog (js/shell.jsx's DesktopSettingsDialog),
    // opened from the header cog (js/site-header.js).
    window.__mtlxGetDesktopSettings = function () {
        return window.mtlxDesktop.getSettings();
    };
    window.__mtlxSetOpenInNewWindow = function (value) {
        window.mtlxDesktop.setOpenInNewWindow(value);
    };
    window.__mtlxSetShowRecentInSystem = function (value) {
        window.mtlxDesktop.setShowRecentInSystem(value);
    };
    window.__mtlxSetDocumentOpenView = function (value) {
        window.mtlxDesktop.setDocumentOpenView(value);
    };
    window.__mtlxSetSafeMode = function (value) {
        window.mtlxDesktop.setSafeMode(value);
    };
    window.__mtlxRelaunch = function () {
        window.mtlxDesktop.relaunch();
    };

    // Shell-level notice bar (js/shell.jsx's DesktopNoticeBar): safe-mode
    // startup and crash-recovery notices pushed from main (GPU restarts,
    // etc), one CustomEvent per notice.
    window.mtlxDesktop.onNotice(function (notice) {
        window.dispatchEvent(new CustomEvent('mtlx-desktop-notice', { detail: notice }));
    });

    // Shell-level About dialog (js/shell.jsx's AboutDialog),
    // opened from the header help button (js/site-header.js).
    window.__mtlxGetAbout = function () {
        return window.mtlxDesktop.getAbout();
    };

    // Graph editor's in-app Open Recent dialog (js/graph-app.jsx), since
    // the native Open Recent submenu is unreachable behind titleBarStyle
    // 'hidden'. getRecents is read fresh every time the dialog opens.
    window.__mtlxGetRecents = function () {
        return window.mtlxDesktop.getRecents();
    };
    window.__mtlxOpenRecent = function (filePath) {
        return window.mtlxDesktop.openRecent(filePath);
    };

    // Drop-to-open (its two call sites: js/shared/mtlx-ui.jsx's
    // useWindowFileDrop and js/shell.jsx's window listener). Lives here,
    // not in mtlx-ui.jsx, so Home (which never loads mtlx-ui.jsx) can
    // still resolve a dropped .mtlx to a real document.
    window.__mtlxGetPathForFile = function (file) {
        return window.mtlxDesktop.getPathForFile(file);
    };
    window.__mtlxOpenPath = function (filePath) {
        return window.mtlxDesktop.openPath(filePath);
    };

    // Electron drop-to-open: resolves a drop to ONE real on-disk path via
    // webUtils, which main opens (mtlx-open-path): a single .mtlx, a single
    // scene file, or the one scene root of a multi-file drop. Returns null
    // for anything else (folders, several roots, web/embeds): in-memory path.
    var SCENE_ROOT_DROP_RE = /\.(usd|usda|usdc|usdz|gltf|glb|obj|pbrt)$/i;
    window.__mtlxDesktopPathDrop = function (dt) {
        if (!dt || !dt.files || !dt.files.length) return null;
        var files = Array.prototype.slice.call(dt.files);
        for (var i = 0; i < files.length; i++) {
            var item = dt.items && dt.items[i];
            var entry = item && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
            // entry is unavailable in some drag sources; only reject when it
            // exists and is actually a directory, not merely absent.
            if (entry && !entry.isFile) return null;
        }
        // The Material Viewer takes .obj/.glb/.gltf drops as preview geometry itself.
        var sceneDropsHere = !/^#!viewer/.test(window.location.hash || '');
        var pick = null;
        if (files.length === 1) {
            var name = files[0].name || '';
            if (/\.mtlx$/i.test(name) || (sceneDropsHere && (SCENE_ROOT_DROP_RE.test(name) || /\.mtl$/i.test(name)))) pick = files[0];
        } else if (sceneDropsHere) {
            var roots = files.filter(function (f) { return SCENE_ROOT_DROP_RE.test(f.name || ''); });
            if (roots.length === 1) pick = roots[0];
        }
        if (!pick) return null;
        var path = '';
        try {
            path = window.__mtlxGetPathForFile(pick);
        } catch (e) {
            path = '';
        }
        return path ? path : null;
    };

    // File > Reveal/Copy Path (js/graph-app.jsx's in-app File menu; the
    // native menu items call shell.showItemInFolder/clipboard.writeText
    // directly in main and do not go through these).
    window.__mtlxRevealDocument = function () {
        return window.mtlxDesktop.revealDocument();
    };
    window.__mtlxCopyDocumentPath = function () {
        return window.mtlxDesktop.copyDocumentPath();
    };

    // ------------------------------------------------------------------
    // Scene Viewer file sets (main.js "Scene Viewer disk access"), ported
    // from vscode_extension/media/bootstrap.js. One open or reload is a seq;
    // missing-file rounds resend the set with the same seq and a higher
    // round. Progress reaches js/usd-scene-app.jsx as
    // 'mtlx-scene-host-progress' events, files as 'mtlx-load-scene'.
    (function () {
        if (typeof window.mtlxDesktop.onOpenScene !== 'function') return;
        var scene = { seq: 0, round: 0, cancelled: false, token: 0, controller: null };
        // url -> { promise, blob, loaded }: a file is fetched once per session and reused across rounds.
        var sceneBlobs = {};
        var SCENE_FETCH_CONCURRENCY = 6;
        var SCENE_STREAM_MAX_BYTES = 256 * 1024 * 1024; // larger files skip byte-level progress

        function emitSceneProgress(detail) {
            window.__mtlxSceneHostProgress = detail; // read by a view that mounts late
            window.dispatchEvent(new CustomEvent('mtlx-scene-host-progress', { detail: detail }));
        }

        // False for a message from an older seq, or for the seq the user cancelled.
        function adoptSceneSeq(seq) {
            if (typeof seq !== 'number') return !scene.cancelled;
            if (seq < scene.seq) return false;
            if (seq > scene.seq) {
                scene.seq = seq;
                scene.round = 0;
                scene.cancelled = false;
            }
            return !scene.cancelled;
        }

        function handleSceneProgress(msg) {
            if (!msg || !adoptSceneSeq(msg.seq)) return;
            emitSceneProgress({ seq: msg.seq, round: 0, phase: 'collect', found: Number(msg.found) || 0, bytes: Number(msg.bytes) || 0 });
        }

        function fetchSceneBlob(url, signal) {
            var hit = sceneBlobs[url];
            if (hit) return hit.promise;
            var entry = { promise: null, blob: null, loaded: 0 };
            entry.promise = fetch(url, { signal: signal }).then(function (res) {
                if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'));
                var length = Number(res.headers.get('content-length')) || 0;
                if (!res.body || typeof res.body.getReader !== 'function' || length > SCENE_STREAM_MAX_BYTES) return res.blob();
                var reader = res.body.getReader();
                var chunks = [];
                function pump() {
                    return reader.read().then(function (step) {
                        if (step.done) return new Blob(chunks);
                        chunks.push(step.value);
                        entry.loaded += step.value.byteLength;
                        return pump();
                    });
                }
                return pump();
            }).then(function (blob) {
                entry.blob = blob;
                entry.loaded = blob.size;
                return blob;
            }, function (e) {
                if (sceneBlobs[url] === entry) delete sceneBlobs[url];
                throw e;
            });
            sceneBlobs[url] = entry;
            return entry.promise;
        }

        // Fetches the set (cached files are not fetched again) with progress,
        // then hands the Scene Viewer File objects whose lastModified is the
        // file's mtime; __mtlxAbsPath carries each file's absolute path.
        function handleOpenScene(msg) {
            if (!msg || !adoptSceneSeq(msg.seq)) return;
            scene.round = Number(msg.round) || 0;
            var token = ++scene.token;
            if (!scene.controller) scene.controller = new AbortController();
            var signal = scene.controller.signal;
            var urls = msg.fileUrls || {};
            var mtimes = msg.mtimes || {};
            var sizes = msg.sizes || {};
            var absPaths = msg.abs || {};
            var keys = Object.keys(urls);
            var bytesTotal = keys.reduce(function (sum, key) { return sum + (Number(sizes[key]) || 0); }, 0);
            var done = 0;
            var blobs = {};
            var current = function () { return token === scene.token && !scene.cancelled; };
            function report() {
                if (!current()) return;
                var bytes = 0;
                keys.forEach(function (key) {
                    var entry = sceneBlobs[urls[key]];
                    if (entry) bytes += entry.blob ? entry.blob.size : entry.loaded;
                });
                emitSceneProgress({
                    seq: msg.seq, round: scene.round, phase: 'fetch', done: done, total: keys.length,
                    bytesDone: Math.min(bytes, bytesTotal), bytesTotal: bytesTotal,
                });
            }
            report();
            var timer = setInterval(report, 150);
            var next = 0;
            function runOne() {
                if (!current() || next >= keys.length) return Promise.resolve();
                var key = keys[next++];
                return fetchSceneBlob(urls[key], signal).then(function (blob) {
                    blobs[key] = blob;
                }, function (e) {
                    if (!(e && e.name === 'AbortError') && current()) console.error('[desktop] scene file "' + key + '" could not be loaded: ' + String((e && e.message) || e));
                }).then(function () {
                    done++;
                    return runOne();
                });
            }
            var starters = [];
            for (var i = 0; i < Math.min(SCENE_FETCH_CONCURRENCY, keys.length); i++) starters.push(runOne());
            Promise.all(starters).then(function () {
                clearInterval(timer);
                if (!current()) return;
                report();
                var keep = {};
                keys.forEach(function (key) { keep[urls[key]] = true; });
                Object.keys(sceneBlobs).forEach(function (url) {
                    if (!keep[url] && sceneBlobs[url].blob) delete sceneBlobs[url];
                });
                var files = {};
                Object.keys(blobs).forEach(function (key) {
                    var modified = typeof mtimes[key] === 'number' ? mtimes[key] : Date.now();
                    var file = new File([blobs[key]], key.slice(key.lastIndexOf('/') + 1), { lastModified: modified });
                    if (typeof absPaths[key] === 'string') file.__mtlxAbsPath = absPaths[key];
                    files[key] = file;
                });
                var payload = { files: files, root: msg.root, name: msg.name, seq: msg.seq, round: scene.round };
                window.__mtlxPendingSceneImport = payload;
                window.dispatchEvent(new CustomEvent('mtlx-load-scene', { detail: payload }));
            });
        }

        // js/usd-scene-app.jsx's Cancel: stops every fetch in flight and the
        // main-process session; nothing more loads until the next open.
        window.__mtlxSceneCancel = function () {
            scene.cancelled = true;
            scene.token++;
            if (scene.controller) {
                scene.controller.abort();
                scene.controller = null;
            }
            sceneBlobs = {};
            window.mtlxDesktop.sceneCancel(scene.seq);
        };
        window.__mtlxSceneReload = function () {
            window.mtlxDesktop.sceneReload();
        };
        // Files the loaded scene reported missing ({ asset, introducedBy });
        // resolves { added, stillMissing }, a bigger set follows when added > 0.
        window.__mtlxSceneReportMissing = function (missing) {
            if (!Array.isArray(missing) || !missing.length || scene.cancelled || !scene.seq) return Promise.resolve({ added: 0 });
            return window.mtlxDesktop.sceneResolveMissing({ seq: scene.seq, missing: missing.slice(0, 512) }).then(function (r) {
                return { added: Number(r && r.added) || 0, stillMissing: Number(r && r.stillMissing) || 0 };
            }, function () {
                return { added: 0 };
            });
        };

        window.mtlxDesktop.onSceneProgress(handleSceneProgress);
        window.mtlxDesktop.onOpenScene(handleOpenScene);
    })();
})();
