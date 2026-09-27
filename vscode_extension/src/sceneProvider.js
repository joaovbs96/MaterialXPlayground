// sceneProvider.js: read-only custom editor that opens a USD stage
// (.usd/.usda/.usdc/.usdz) or a glTF/GLB/OBJ scene in the site's Scene
// Viewer. The scene's file set (usdFileSet.js) is sent as webview resource
// URLs ('mtlx-open-scene'); media/bootstrap.js fetches them and hands them
// to js/usd-scene-app.jsx.
//
// Protocol (seq numbers one open or reload; round numbers the sets sent
// for it, 0 being the static collection):
//   host -> webview  'mtlx-scene-progress' { seq, found, bytes } while collecting
//                    'mtlx-open-scene' { seq, round, name, root, fileUrls, mtimes, sizes, totalBytes }
//                    'mtlx-scene-missing-result' { seq, requestId, added, stillMissing }
//   webview -> host  'mtlx-scene-missing' { seq, requestId, missing: [{ asset, introducedBy }] }
//                    'mtlx-scene-cancel' { seq }, 'mtlx-scene-reload'
'use strict';

const vscode = require('vscode');
const path = require('path');
const docScanner = require('./docScanner');
const textureStamp = require('./textureStamp');
const usdFileSet = require('./usdFileSet');
const { buildHtml, panelLifecycle, wireCommonWebviewMessages, trackScenePanel, getSharedOutputChannel, logLine, showHostError, RELOAD_DEBOUNCE_MS, sceneTestHooks, panelIconPath } = require('./editorProvider');
const { errMsg } = require('./util');

const VIEW_TYPE = 'materialxPlayground.sceneViewer';
// The ONE place the set of auto-openable/openable scene extensions lives.
// extension.js's auto-open (maybeAutoOpenSceneText/Tab) reads this list
// indirectly through isSceneUri, so adding an extension here is the only
// change needed for it to be picked up there too.
const SCENE_EXTENSIONS = ['.usd', '.usda', '.usdc', '.usdz', '.gltf', '.glb', '.obj'];
const SAVE_REFUSED = 'Graph edits to a scene material cannot be saved into the scene file. Use Export .mtlx in the Graph Editor to save the material as a separate file.';
// On-demand rounds (missing files the loaded scene asked for) are capped per
// open or reload by the usdFileSet session (MAX_MISSING_ROUNDS there).
const PROGRESS_INTERVAL_MS = 120;
const LOG_LIST_LIMIT = 20;

function isSceneUri(uri) {
    return !!uri && SCENE_EXTENSIONS.includes(path.extname(uri.path).toLowerCase());
}

// "a, b, c and 4 more" for Output channel lines.
function listForLog(items) {
    const shown = items.slice(0, LOG_LIST_LIMIT);
    return shown.join(', ') + (items.length > shown.length ? ' and ' + (items.length - shown.length) + ' more' : '');
}

function formatMegabytes(bytes) {
    return (bytes / 1048576).toFixed(1) + ' MB';
}

class UsdSceneProvider {
    constructor(context) {
        this.context = context;
    }

    openCustomDocument(uri) {
        return { uri, dispose() {} };
    }

    async resolveCustomEditor(document, webviewPanel) {
        const uri = document.uri;
        const name = path.basename(uri.path);
        // Before any await: see panelLifecycle in editorProvider.js.
        const life = panelLifecycle(webviewPanel);
        const webview = life.webview;
        webviewPanel.iconPath = panelIconPath(this.context.extensionUri);
        try {
            const containmentRoot = docScanner.containmentRoot(uri);
            if (!await buildHtml(this.context, webview, '#!scene', false, containmentRoot, true, life.isLive)) return;
            trackScenePanel(webviewPanel);
            life.track(wireCommonWebviewMessages(webview, undefined, uri, life));

            let seq = 0;
            let lastSignature = null;
            let lastLoggedWarnings = null;
            let watcher = null;
            let watchedBase = null;
            let debounceTimer = null;
            let currentUris = new Set(); // uri.toString() of the last file set sent
            let session = null; // usdFileSet session behind the last set sent
            let sentBaseUri = null; // that set's base, which missing paths are relative to
            let round = 0;
            let roundLimitLoggedSeq = 0;
            let sentSeq = 0; // seq of the last set posted: the one the webview loads
            let cancelledUpTo = 0; // Cancel stops every scan and round up to this seq
            let suspended = false; // after Cancel, file changes wait for Reload
            const isDisposed = () => life.disposed;
            let missingChain = Promise.resolve();
            // Files found on demand, re-checked on every rescan of this panel.
            const knownExtras = new Map();

            const deps = docScanner.defaultDeps();
            const staticScan = () => !sceneTestHooks || sceneTestHooks.sceneStaticScan !== false;
            // severity defaults to 'info' (E21: forwarded as 'mtlx-log' to
            // every live webview, tagged to this scene's file name).
            const log = (text, severity) => logLine(getSharedOutputChannel(), text, severity, name);
            // A scan lives until a newer scan starts; a sent set (and its
            // on-demand rounds) until a newer set is sent. A dropped rescan
            // (nothing changed) therefore never cancels the rounds.
            const scanLive = (mySeq) => () => !isDisposed() && mySeq === seq && mySeq > cancelledUpTo;
            const setLive = (mySeq) => () => !isDisposed() && mySeq === sentSeq && mySeq > cancelledUpTo;

            // Collection progress, at most one message per PROGRESS_INTERVAL_MS.
            const progressPoster = (mySeq) => {
                let pending = null;
                let timer = null;
                let last = 0;
                const flush = () => {
                    timer = null;
                    if (pending && mySeq === seq && !isDisposed()) life.post(Object.assign({ type: 'mtlx-scene-progress', seq: mySeq }, pending));
                    pending = null;
                    last = Date.now();
                };
                return {
                    update(value) {
                        pending = value;
                        if (!timer) timer = setTimeout(flush, Math.max(0, PROGRESS_INTERVAL_MS - (Date.now() - last)));
                    },
                    now(value) { pending = value; if (timer) clearTimeout(timer); flush(); },
                    stop() { if (timer) clearTimeout(timer); timer = null; pending = null; },
                };
            };

            // '?v=' cache-buster via textureStamp.js (E20), same mechanism
            // editorProvider.js uses for the .mtlx editor's own textures: a
            // same-size, same-mtime replacement (e.g. an Explorer copy that
            // preserves the timestamp) still bumps ctime, so the webview's
            // resource cache doesn't keep serving the old bytes.
            const postSet = async (mySeq, snap) => {
                currentUris = new Set(snap.files.map((f) => f.uri.toString()));
                const fileUrls = {};
                const mtimes = {};
                const sizes = {};
                await Promise.all(snap.files.map(async (f) => {
                    const ctimeNs = await textureStamp.changeTimeNs(f.uri);
                    fileUrls[f.rel] = textureStamp.versionedUrl(webview.asWebviewUri(f.uri).toString(), { mtime: f.mtime, size: f.size, ctimeNs });
                    mtimes[f.rel] = f.mtime;
                    sizes[f.rel] = f.size;
                }));
                // throttleMs: test-only, see testApi.setSceneFetchThrottle in
                // editorProvider.js; 0/undefined outside TEST_TRANSPORT.
                const throttleMs = sceneTestHooks ? sceneTestHooks.sceneFetchThrottleMs : 0;
                life.post({ type: 'mtlx-open-scene', seq: mySeq, round, name, root: snap.root, fileUrls, mtimes, sizes, totalBytes: snap.totalBytes, throttleMs });
                watchFolder(snap.baseUri);
            };

            // Rescans the file set and posts it; a rescan whose files, sizes
            // and mtimes all match the last one sent is dropped (watch noise).
            // Forced loads (open, Reload) also report collection progress.
            const sendScene = async (force) => {
                const mySeq = ++seq;
                const live = scanLive(mySeq);
                const progress = force ? progressPoster(mySeq) : null;
                if (progress) progress.now({ found: 0, bytes: 0 });
                const startedAt = Date.now();
                try {
                    const next = usdFileSet.createSession(deps, uri, {
                        scanRefs: staticScan(),
                        isCancelled: () => !live(),
                        onProgress: progress ? (p) => progress.update(p) : null,
                    });
                    await next.init();
                    if (knownExtras.size) await next.addKnown(Array.from(knownExtras.values()));
                    const snap = next.snapshot();
                    if (progress) progress.stop();
                    if (!live()) return;
                    const joined = snap.warnings.join('\n');
                    if (snap.warnings.length && joined !== lastLoggedWarnings) {
                        for (const warning of snap.warnings) log(uri.fsPath + ': ' + warning, 'warning');
                    }
                    lastLoggedWarnings = joined;
                    const signature = snap.root + '\n' + snap.files.map((f) => f.rel + '|' + f.size + '|' + f.mtime).join('\n');
                    if (!force && signature === lastSignature) return;
                    lastSignature = signature;
                    session = next;
                    sentSeq = mySeq;
                    const sent = setLive(mySeq);
                    next.isCancelled = () => !sent();
                    sentBaseUri = snap.baseUri;
                    round = 0;
                    const ms = Date.now() - startedAt;
                    if (sceneTestHooks) sceneTestHooks.emitSceneRound({ seq: mySeq, round, ms, files: snap.files.length, bytes: snap.totalBytes, added: snap.files.map((f) => f.rel), stillMissing: [] });
                    postSet(mySeq, snap);
                } catch (err) {
                    if (progress) progress.stop();
                    if ((err && err.cancelled) || !live()) return;
                    showHostError('MaterialX Playground: failed to load "' + name + '": ' + errMsg(err));
                }
            };

            // One on-demand round: resolve what the loaded scene reported
            // missing and resend the set when that found anything new.
            const resolveMissing = async (msg) => {
                const reply = (added, stillMissing) => life.post({
                    type: 'mtlx-scene-missing-result', seq: msg.seq, requestId: msg.requestId, added, stillMissing,
                });
                const mySeq = sentSeq;
                const live = setLive(mySeq);
                if (msg.seq !== mySeq || !session || !live()) { reply(0, 0); return; }
                const startedAt = Date.now();
                let result;
                try {
                    result = await session.resolveMissing(msg.missing, sentBaseUri);
                } catch (err) {
                    if (!(err && err.cancelled) && live()) {
                        log(uri.fsPath + ': looking up missing files failed: ' + errMsg(err), 'error');
                        reply(0, 0);
                    }
                    return;
                }
                if (!live()) return;
                if (result.limited) {
                    if (roundLimitLoggedSeq !== mySeq) log(uri.fsPath + ': stopped looking for missing files after ' + session.maxRounds + ' rounds.', 'warning');
                    roundLimitLoggedSeq = mySeq;
                    reply(0, 0);
                    return;
                }
                if (!result.tried) { reply(0, 0); return; } // only entries looked up before: not a round
                round = result.round;
                const snap = session.snapshot();
                const addedRels = result.added.map((f) => snap.relOf(f.uri)).sort();
                if (addedRels.length) log(uri.fsPath + ': round ' + round + ' added ' + addedRels.length + ' referenced file(s) (' + formatMegabytes(result.added.reduce((sum, f) => sum + f.size, 0)) + '): ' + listForLog(addedRels), 'info');
                if (result.stillMissing.length) log(uri.fsPath + ': round ' + round + ' could not find ' + result.stillMissing.length + ' referenced file(s): ' + listForLog(result.stillMissing), 'warning');
                if (sceneTestHooks) sceneTestHooks.emitSceneRound({ seq: mySeq, round, ms: Date.now() - startedAt, files: snap.files.length, bytes: snap.totalBytes, added: addedRels, stillMissing: result.stillMissing });
                reply(result.added.length, result.stillMissing.length);
                if (!result.added.length) return;
                for (const f of result.added) knownExtras.set(f.uri.toString(), f.uri);
                sentBaseUri = snap.baseUri;
                lastSignature = snap.root + '\n' + snap.files.map((f) => f.rel + '|' + f.size + '|' + f.mtime).join('\n');
                postSet(mySeq, snap);
            };

            // Reload on a change to a file already in the sent file set, or
            // (for creates/renames of files not sent yet, e.g. a missing
            // reference the user just added) any scene-allowed extension.
            // Unrelated sibling files in the same watched folder never match.
            const schedule = (changedUri) => {
                if (suspended) return;
                if (changedUri) {
                    const inSet = currentUris.has(changedUri.toString());
                    const scenelike = /\.(usda?|usdc|usdz|gltf|glb|obj|bin|mtl|mtlx|png|jpe?g|gif|bmp|webp|tga|exr|hdr|tiff?|ktx2)$/i.test(changedUri.path);
                    if (!inSet && !scenelike) return;
                }
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => { debounceTimer = null; sendScene(false); }, RELOAD_DEBOUNCE_MS);
            };
            // One recursive watcher on the file set's base folder, rebuilt
            // only when a rescan moves that base.
            const watchFolder = (baseUri) => {
                if (isDisposed()) return;
                if (watchedBase && watchedBase.toString() === baseUri.toString()) return;
                if (watcher) watcher.dispose();
                watchedBase = baseUri;
                watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(baseUri, '**/*'));
                watcher.onDidChange(schedule);
                watcher.onDidCreate(schedule);
                watcher.onDidDelete(schedule);
            };

            life.track(webview.onDidReceiveMessage((msg) => {
                if (!msg) return;
                if (msg.type === 'ready') {
                    sendScene(true);
                } else if (msg.type === 'mtlx-scene-missing') {
                    missingChain = missingChain.then(() => resolveMissing(msg)).catch(() => {});
                } else if (msg.type === 'mtlx-scene-cancel') {
                    if (typeof msg.seq === 'number' && msg.seq < sentSeq) return; // about an older set
                    cancelledUpTo = seq;
                    suspended = true;
                    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
                    log(uri.fsPath + ': scene loading cancelled.', 'info');
                } else if (msg.type === 'mtlx-scene-reload') {
                    suspended = false;
                    sendScene(true);
                } else if (msg.type === 'mtlx-save') {
                    // Never written into the USD file: the graph came from a
                    // material inside the stage, not from this document.
                    life.post({ type: 'mtlx-save-result', ok: false, error: SAVE_REFUSED });
                    vscode.window.showWarningMessage('MaterialX Playground: ' + SAVE_REFUSED);
                }
                // 'mtlx-sync' (live graph edits) is ignored for the same reason.
            }));

            life.onDispose(() => {
                if (watcher) watcher.dispose();
                if (debounceTimer) clearTimeout(debounceTimer);
                seq++;
            });
        } catch (err) {
            if (life.disposed) return; // closed while resolving
            showHostError('MaterialX Playground: failed to open the Scene Viewer: ' + errMsg(err));
        }
    }
}

// The USD file a command should open: an explicit uri (Explorer or editor
// title menus), else the active tab's resource, else the active text editor's.
function resolveSceneUri(uriArg) {
    if (uriArg instanceof vscode.Uri) return uriArg;
    const tab = vscode.window.tabGroups.activeTabGroup && vscode.window.tabGroups.activeTabGroup.activeTab;
    if (tab && tab.input && tab.input.uri instanceof vscode.Uri) return tab.input.uri;
    const editor = vscode.window.activeTextEditor;
    return editor && editor.document ? editor.document.uri : null;
}

function register(context) {
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(VIEW_TYPE, new UsdSceneProvider(context), {
            webviewOptions: { retainContextWhenHidden: true },
            supportsMultipleEditorsPerDocument: false,
        }),
        vscode.commands.registerCommand('materialxPlayground.openScene', async (uriArg) => {
            const uri = resolveSceneUri(uriArg);
            if (!isSceneUri(uri)) {
                showHostError('MaterialX Playground: select a .usd, .usda, .usdc, .usdz, .gltf, .glb or .obj file to open in the Scene Viewer.');
                return;
            }
            try {
                await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
            } catch (err) {
                showHostError('MaterialX Playground: failed to open the Scene Viewer: ' + errMsg(err));
            }
        })
    );
}

module.exports = { register, VIEW_TYPE, SCENE_EXTENSIONS, isSceneUri };
