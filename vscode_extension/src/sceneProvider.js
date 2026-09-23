// sceneProvider.js: read-only custom editor that opens a USD stage
// (.usd/.usda/.usdc/.usdz) in the site's USD Scene Viewer. The stage's file
// set (usdFileSet.js) is sent as webview resource URLs ('mtlx-open-scene');
// media/bootstrap.js fetches them and hands them to js/usd-scene-app.jsx.
'use strict';

const vscode = require('vscode');
const path = require('path');
const docScanner = require('./docScanner');
const usdFileSet = require('./usdFileSet');
const { buildHtml, wireCommonWebviewMessages, trackScenePanel, getSharedOutputChannel, logLine, RELOAD_DEBOUNCE_MS } = require('./editorProvider');
const { errMsg } = require('./util');

const VIEW_TYPE = 'materialxPlayground.sceneViewer';
// The ONE place the set of auto-openable/openable scene extensions lives.
// glTF/GLB/OBJ scene loading isn't wired up on this branch yet; once it is,
// adding them here (and to their own custom-editor registration) is the
// only change needed for extension.js's auto-open to pick them up too.
const SCENE_EXTENSIONS = ['.usd', '.usda', '.usdc', '.usdz'];
const SAVE_REFUSED = 'Graph edits opened from a USD scene cannot be saved into the USD file. Use Export .mtlx in the Graph Editor to save the material as a separate file.';

function isSceneUri(uri) {
    return !!uri && SCENE_EXTENSIONS.includes(path.extname(uri.path).toLowerCase());
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
        try {
            const containmentRoot = docScanner.containmentRoot(uri);
            await buildHtml(this.context, webviewPanel.webview, '#!scene', false, containmentRoot, true);
            trackScenePanel(webviewPanel);
            const commonSub = wireCommonWebviewMessages(webviewPanel.webview, undefined, uri);

            let seq = 0;
            let lastSignature = null;
            let lastLoggedWarnings = null;
            let watcher = null;
            let watchedBase = null;
            let debounceTimer = null;

            // Rescans the file set and posts it; a rescan whose files, sizes
            // and mtimes all match the last one sent is dropped (watch noise).
            const sendScene = async (force) => {
                const mySeq = ++seq;
                try {
                    const set = await usdFileSet.collect(uri);
                    if (mySeq !== seq) return;
                    const joined = set.warnings.join('\n');
                    if (set.warnings.length && joined !== lastLoggedWarnings) {
                        const channel = getSharedOutputChannel();
                        for (const warning of set.warnings) logLine(channel, uri.fsPath + ': ' + warning);
                    }
                    lastLoggedWarnings = joined;
                    const signature = set.root + '\n' + set.files.map((f) => f.rel + '|' + f.size + '|' + f.mtime).sort().join('\n');
                    if (!force && signature === lastSignature) return;
                    lastSignature = signature;
                    const fileUrls = {};
                    const mtimes = {};
                    for (const f of set.files) {
                        fileUrls[f.rel] = webviewPanel.webview.asWebviewUri(f.uri).toString() + '?v=' + f.mtime + '-' + f.size;
                        mtimes[f.rel] = f.mtime;
                    }
                    webviewPanel.webview.postMessage({ type: 'mtlx-open-scene', name, root: set.root, fileUrls, mtimes });
                    watchFolder(set.baseUri);
                } catch (err) {
                    if (mySeq !== seq) return;
                    vscode.window.showErrorMessage('MaterialX Playground: failed to load "' + name + '": ' + errMsg(err));
                }
            };
            const schedule = (changedUri) => {
                if (changedUri && !/\.(usda?|usdc|usdz|mtlx|png|jpe?g|gif|bmp|webp|tga|exr|hdr|tiff?|ktx2)$/i.test(changedUri.path)) return;
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(() => { debounceTimer = null; sendScene(false); }, RELOAD_DEBOUNCE_MS);
            };
            // One recursive watcher on the file set's base folder, rebuilt
            // only when a rescan moves that base.
            const watchFolder = (baseUri) => {
                if (watchedBase && watchedBase.toString() === baseUri.toString()) return;
                if (watcher) watcher.dispose();
                watchedBase = baseUri;
                watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(baseUri, '**/*'));
                watcher.onDidChange(schedule);
                watcher.onDidCreate(schedule);
                watcher.onDidDelete(schedule);
            };

            const messageSub = webviewPanel.webview.onDidReceiveMessage((msg) => {
                if (!msg) return;
                if (msg.type === 'ready') {
                    sendScene(true);
                } else if (msg.type === 'mtlx-save') {
                    // Never written into the USD file: the graph came from a
                    // material inside the stage, not from this document.
                    webviewPanel.webview.postMessage({ type: 'mtlx-save-result', ok: false, error: SAVE_REFUSED });
                    vscode.window.showWarningMessage('MaterialX Playground: ' + SAVE_REFUSED);
                }
                // 'mtlx-sync' (live graph edits) is ignored for the same reason.
            });

            webviewPanel.onDidDispose(() => {
                commonSub.dispose();
                messageSub.dispose();
                if (watcher) watcher.dispose();
                if (debounceTimer) clearTimeout(debounceTimer);
                seq++;
            });
        } catch (err) {
            vscode.window.showErrorMessage('MaterialX Playground: failed to open the USD Scene Viewer: ' + errMsg(err));
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
                vscode.window.showErrorMessage('MaterialX Playground: select a .usd, .usda, .usdc or .usdz file to open in the USD Scene Viewer.');
                return;
            }
            try {
                await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
            } catch (err) {
                vscode.window.showErrorMessage('MaterialX Playground: failed to open the USD Scene Viewer: ' + errMsg(err));
            }
        })
    );
}

module.exports = { register, VIEW_TYPE, SCENE_EXTENSIONS, isSceneUri };
