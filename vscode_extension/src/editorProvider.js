// editorProvider.js — CustomTextEditorProvider that hosts the site
// (index.html, unmodified) inside a webview, feeding it the open .mtlx
// document (+ resolved sibling textures/includes, via docScanner.js)
// through the same window.__mtlxPendingImport / __mtlxPendingViewerImport
// contract the site itself uses for its own "send to viewer"/"send to
// editor" buttons (js/shared/mtlx-ui.jsx openInGraphEditor/openInViewer).
// media/bootstrap.js is the webview-side counterpart that turns the
// postMessage payload built here into that contract.
'use strict';

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const docScanner = require('./docScanner');
const { errMsg } = require('./util');
const { getSetting } = require('./settingsHost');

// How long to wait after the last keystroke before rescanning + resending
// the document to the webview. Keeps a fast typist from triggering a
// filesystem crawl (docScanner.scan) on every character.
const RELOAD_DEBOUNCE_MS = 400;

// Inert unless the stress-test harness sets this in the extension host's
// own environment, never true for a real user session. Gates the
// bootstrap.js `?transportTest=1` query param and the mtlx-test-*
// message handling below; see testApi in this file's exports and
// extension.js's activate().
const TEST_TRANSPORT = process.env.MTLX_TEST_TRANSPORT === '1';

// Test-only instrumentation for the direct-texture-read transport: lets a
// stress-test harness observe, per webview, the per-file SHA-256/size/
// timing report bootstrap.js posts (mtlx-test-files) and every forwarded
// error (mtlx-error / mtlx-test-error). null in normal operation: a real
// user session never creates this.
let testHooks = null;
if (TEST_TRANSPORT) {
    const filesListeners = [];
    const errorListeners = [];
    const saveResultListeners = [];
    const sceneReportListeners = [];
    const graphSaveListeners = [];
    const materialPreviewListeners = [];
    const errors = [];
    testHooks = {
        // 'mtlx-test-material-preview': the scene's material panel state.
        emitMaterialPreviewReport(report) {
            for (const listener of materialPreviewListeners) listener(report);
        },
        // 'mtlx-test-scene' (one per settled USD stage load) and
        // 'mtlx-test-graph-save' (the host's answer to a probe graph save).
        emitSceneReport(report) {
            for (const listener of sceneReportListeners) listener(report);
        },
        emitGraphSaveResult(rec) {
            for (const listener of graphSaveListeners) listener(rec);
        },
        emitFilesReport(report) {
            for (const listener of filesListeners) listener(report);
        },
        emitError(text) {
            errors.push(text);
            for (const listener of errorListeners) listener(text);
        },
        // Fired once per settled 'mtlx-save-file' handling (see
        // handleSaveFile below) -- lets the stress-test harness observe
        // the save outcome without polling the filesystem.
        emitSaveResult(rec) {
            for (const listener of saveResultListeners) listener(rec);
        },
        api: {
            onFilesReport(listener) { filesListeners.push(listener); },
            onError(listener) { errorListeners.push(listener); },
            getErrors() { return errors.slice(); },
            onSaveResult(listener) { saveResultListeners.push(listener); },
            // Makes handleSaveFile skip vscode.window.showSaveDialog and
            // write straight into `dir` (a plain fs path) instead -- lets
            // the harness assert on exact saved bytes with no native
            // dialog for a human to click through. Pass a falsy value to
            // go back to the real dialog.
            setSaveTarget(dir) { testSaveTargetDir = dir || null; },
            // Asks the active panel's webview to run the SITE's real
            // downloadBlob (js/shared/mtlx-ui.jsx) with a small text
            // Blob -- see bootstrap.js's handleTestTriggerDownload.
            triggerDownload(name, text) { postToActivePanel({ type: 'mtlx-test-trigger-download', name, text }); },
            // Same, for downloadSnapshot() against the mounted Viewer's
            // live render-view handle -- see bootstrap.js's
            // handleTestTriggerSnapshot.
            triggerSnapshot(baseName) { postToActivePanel({ type: 'mtlx-test-trigger-snapshot', baseName }); },
            onSceneReport(listener) { sceneReportListeners.push(listener); },
            onGraphSaveResult(listener) { graphSaveListeners.push(listener); },
            // Asks the most recent USD scene panel to post a probe 'mtlx-save'
            // (bootstrap.js's handleTestTriggerGraphSave).
            triggerSceneGraphSave(xml) {
                if (activeScenePanel) activeScenePanel.webview.postMessage({ type: 'mtlx-test-trigger-graph-save', xml: String(xml || '') });
            },
            // Double-clicks the scene viewport centre and reports the material
            // preview panel (bootstrap.js's handleTestTriggerMaterialPreview).
            onMaterialPreviewReport(listener) { materialPreviewListeners.push(listener); },
            triggerSceneMaterialPreview(timeoutMs) {
                if (activeScenePanel) activeScenePanel.webview.postMessage({ type: 'mtlx-test-trigger-material-preview', timeoutMs: timeoutMs || 30000 });
            },
            // Test-only seam for the settingsFallback smoke scenario: the
            // exact effective value getSetting() (settingsHost.js) would
            // hand to real code, without the harness needing its own copy
            // of the materialxPlayground.* / materialx.* fallback logic.
            getSetting(key) { return getSetting(key); },
        },
    };
}

// Most recently created or focused USD scene panel (sceneProvider.js), only
// read by the test API above. Cleared when that panel is disposed.
let activeScenePanel = null;
function trackScenePanel(panel) {
    activeScenePanel = panel;
    const viewSub = panel.onDidChangeViewState(() => { if (panel.active) activeScenePanel = panel; });
    panel.onDidDispose(() => {
        viewSub.dispose();
        if (activeScenePanel === panel) activeScenePanel = null;
    });
}

// Test-only override for handleSaveFile's save location -- see
// testHooks.api.setSaveTarget above. null in normal operation (and
// always null outside TEST_TRANSPORT, since nothing can ever set it).
let testSaveTargetDir = null;

// Reads vscode_extension/media/webview.html and substitutes its
// ${placeholder} tokens. Shared by resolveCustomTextEditor (the real
// custom editor, backed by a document) and renderStaticHtml (the
// document-less "MaterialX: Open Node Documentation" command in
// extension.js) — both need byte-identical chrome, just a different
// initial hash and, for the static case, no document-payload wiring.
//
// `docsOnly` is threaded straight through to a ${docsOnly} substitution
// (mechanism mirrors ${initialHash} above it) so media/bootstrap.js can
// set window.__MTLX_DOCS_ONLY__ before any site script runs — js/
// site-header.js's nav-item filter reads that flag to hide the file-bound
// Viewer/Graph tabs in the standalone docs panel, which has no .mtlx
// document behind it at all. resolveCustomTextEditor passes false (the
// file-backed editor keeps every tab); renderStaticHtml passes true (it
// is only ever the docs panel).
//
// `extraResourceRoot`, when given (a vscode.Uri), is added to
// localResourceRoots alongside the extension root: the containment root
// docScanner.containmentRoot() computed for the open document, so the
// webview can asWebviewUri() its textures. Omitted for the docs panel
// (renderStaticHtml), which has no document and therefore no textures.
//
// `sceneOnly` (sceneProvider.js) becomes ${sceneOnly}, read by bootstrap.js
// as window.__MTLX_SCENE_ONLY__ so the header keeps only Scene and Graph.
async function buildHtml(context, webview, initialHash, docsOnly, extraResourceRoot, sceneOnly) {
    // package.json now lives at the repo root, so packaging (vsce
    // package) bundles both the site's files (index.html, js/,
    // libraries/, ...) and vscode_extension/ into the same install
    // directory — context.extensionUri already IS that root, both when
    // run out of a repo checkout (see README.md "Development" — F5 "Run
    // Extension") and when installed from a .vsix.
    const repoRootUri = context.extensionUri;

    webview.options = {
        enableScripts: true,
        localResourceRoots: extraResourceRoot ? [repoRootUri, extraResourceRoot] : [repoRootUri],
    };

    const templateUri = vscode.Uri.joinPath(context.extensionUri, 'vscode_extension', 'media', 'webview.html');
    let bootstrapUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'vscode_extension', 'media', 'bootstrap.js')).toString();
    // Test seam: inert unless MTLX_TEST_TRANSPORT=1 in the extension
    // host's own environment (see TEST_TRANSPORT above). bootstrap.js
    // reads this off its own <script src> at load time via
    // document.currentScript.
    if (TEST_TRANSPORT) bootstrapUri += '?transportTest=1';
    const baseUri = webview.asWebviewUri(repoRootUri).toString() + '/';

    const bytes = await vscode.workspace.fs.readFile(templateUri);
    let html = Buffer.from(bytes).toString('utf8');
    html = html.split('${cspSource}').join(webview.cspSource);
    html = html.split('${baseUri}').join(baseUri);
    html = html.split('${bootstrapUri}').join(bootstrapUri);
    html = html.split('${initialHash}').join(initialHash);
    html = html.split('${docsOnly}').join(docsOnly ? '1' : '');
    html = html.split('${sceneOnly}').join(sceneOnly ? '1' : '');
    // Fed to media/bootstrap.js (window.__MTLX_VSCODE_VERSIONS__), consumed
    // by js/shell.jsx's AboutDialog for its VS Code version block.
    html = html.split('${extensionVersion}').join(String(context.extension.packageJSON.version || ''));
    html = html.split('${vscodeVersion}').join(String(vscode.version || ''));

    webview.html = html;
}

// ---------------------------------------------------------------------
// Shared webview message wiring — used by BOTH webview creation sites
// (resolveCustomTextEditor's custom-editor panel and extension.js's
// document-less docs panel), so error forwarding behaves identically
// everywhere the site runs.

// One OutputChannel for the whole extension, created lazily on the first
// forwarded webview error — most sessions never need it, and channels
// stick around in the Output panel's dropdown once created.
let sharedOutputChannel = null;
function getSharedOutputChannel() {
    if (!sharedOutputChannel) {
        sharedOutputChannel = vscode.window.createOutputChannel('MaterialX Playground');
    }
    return sharedOutputChannel;
}

// Disposes the lazily-created channel above, if one was ever created.
// Registered as a Disposable in extension.js's activate() so it's torn
// down on deactivate instead of leaking for the life of the host window.
function disposeSharedOutputChannel() {
    if (sharedOutputChannel) {
        sharedOutputChannel.dispose();
        sharedOutputChannel = null;
    }
}

// Shared by every timestamped OutputChannel line this extension writes
// (the 'mtlx-error' forward below, sendUpdate's per-warning log further
// down, and extension.js's tier-2-unavailable log, which imports this) —
// prepends a '[ISO timestamp] ' prefix so entries can be correlated
// against other logs.
function logLine(channel, text) {
    channel.appendLine('[' + new Date().toISOString() + '] ' + text);
}

// Where a Save dialog should default to for a given (possibly null)
// document: the open .mtlx file's own folder, else the first workspace
// folder, else the user's home directory. Used by handleSaveFile below;
// the docs panel (no document) always falls through past the first check.
function defaultSaveDirFor(documentUri) {
    if (documentUri && documentUri.scheme === 'file') {
        try {
            return vscode.Uri.file(path.dirname(documentUri.fsPath));
        } catch (e) {
            // fall through to the workspace/home fallback below
        }
    }
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length) return folders[0].uri;
    return vscode.Uri.file(os.homedir());
}

// Payload ceiling for 'mtlx-save-file' -- an accidental multi-GB export
// would otherwise round-trip as base64 text through postMessage and blow
// up the extension host's memory decoding it.
const MAX_SAVE_FILE_BYTES = 1 * 1024 * 1024 * 1024; // 1 GiB

// Handles 'mtlx-save-file' { id, name, mime, bytesB64 } -- bootstrap.js's
// window.__mtlxHostSave, the VS Code replacement for the site's
// `<a download>` click (js/shared/mtlx-ui.jsx downloadBlob/
// downloadSnapshot), which produces no file inside a webview. Sanitizes
// `name` to a basename, prompts a native Save dialog (skipped in test
// mode -- see testSaveTargetDir), writes the bytes, and always replies
// with { type: 'mtlx-save-file-result', id, ok, path|error }. A user
// cancel replies ok:false with no `error` and shows nothing; that is not
// a failure.
async function handleSaveFile(webview, msg, documentUri) {
    const id = msg.id;
    const reply = (payload) => webview.postMessage(Object.assign({ type: 'mtlx-save-file-result', id }, payload));
    const rawName = typeof msg.name === 'string' ? msg.name : 'download';
    const baseName = path.basename(rawName) || 'download';
    try {
        const bytesB64 = typeof msg.bytesB64 === 'string' ? msg.bytesB64 : '';
        // Cheap pre-check on the base64 TEXT length (base64 is ~4/3 the
        // raw size) before paying for the Buffer.from() decode below.
        if (bytesB64.length > (MAX_SAVE_FILE_BYTES * 4) / 3) {
            reply({ ok: false, error: 'file is larger than the 1 GiB export limit' });
            return;
        }
        const bytes = Buffer.from(bytesB64, 'base64');
        if (bytes.length > MAX_SAVE_FILE_BYTES) {
            reply({ ok: false, error: 'file is larger than the 1 GiB export limit' });
            return;
        }

        let targetUri;
        if (testSaveTargetDir) {
            targetUri = vscode.Uri.file(path.join(testSaveTargetDir, baseName));
        } else {
            const dir = defaultSaveDirFor(documentUri);
            const ext = path.extname(baseName).slice(1);
            const filters = ext ? { [ext.toUpperCase() + ' files']: [ext] } : undefined;
            const picked = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(dir, baseName), filters });
            if (!picked) {
                reply({ ok: false }); // user cancel -- not an error
                if (testHooks) testHooks.emitSaveResult({ name: baseName, ok: false, canceled: true });
                return;
            }
            targetUri = picked;
        }

        await vscode.workspace.fs.writeFile(targetUri, bytes);
        reply({ ok: true, path: targetUri.fsPath });
        if (testHooks) testHooks.emitSaveResult({ name: baseName, ok: true, path: targetUri.fsPath });

        if (!testSaveTargetDir) {
            vscode.window.showInformationMessage('MaterialX Playground: saved "' + baseName + '"', 'Reveal in Explorer')
                .then((choice) => {
                    if (choice === 'Reveal in Explorer') vscode.commands.executeCommand('revealFileInOS', targetUri);
                });
        }
    } catch (err) {
        const message = errMsg(err);
        reply({ ok: false, error: message });
        if (testHooks) testHooks.emitSaveResult({ name: baseName, ok: false, error: message });
        vscode.window.showErrorMessage('MaterialX Playground: failed to save "' + baseName + '": ' + message);
    }
}

// Handles the message types every MaterialX webview can send, regardless
// of which command created it:
//   - 'mtlx-error'  { text }: an uncaught error / unhandled rejection
//     inside the webview, forwarded to the shared OutputChannel for
//     diagnostics.
//   - 'mtlx-test-files' { seq, files, failures, totalMs } and
//     'mtlx-test-error' { text }: inert unless TEST_TRANSPORT is set (see
//     above): the stress-test harness's view into bootstrap.js's texture
//     fetch/hash report and mirrored error text, relayed to testHooks.
//   - 'mtlx-save-file' { id, name, mime, bytesB64 }: bootstrap.js's
//     window.__mtlxHostSave, the VS Code replacement for the site's
//     `<a download>` export buttons: see handleSaveFile above.
// `outputChannel` is optional — omitted, the lazily-created shared
// channel is used. `documentUri` (also optional) is the open .mtlx
// file's uri, used only to default the 'mtlx-save-file' Save dialog's
// folder, null for the document-less docs panel. Returns the
// Disposable for the listener; callers dispose it with their panel.
function wireCommonWebviewMessages(webview, outputChannel, documentUri) {
    return webview.onDidReceiveMessage(async (msg) => {
        if (!msg) return;
        if (msg.type === 'mtlx-error') {
            const channel = outputChannel || getSharedOutputChannel();
            logLine(channel, String(msg.text || ''));
            if (testHooks) testHooks.emitError(String(msg.text || ''));
        } else if (msg.type === 'mtlx-test-files') {
            if (testHooks) testHooks.emitFilesReport({ seq: msg.seq, files: msg.files, failures: msg.failures, totalMs: msg.totalMs });
        } else if (msg.type === 'mtlx-test-error') {
            if (testHooks) testHooks.emitError(String(msg.text || ''));
        } else if (msg.type === 'mtlx-test-scene') {
            if (testHooks) testHooks.emitSceneReport(msg.report || null);
        } else if (msg.type === 'mtlx-test-graph-save') {
            if (testHooks) testHooks.emitGraphSaveResult({ ok: !!msg.ok, error: msg.error ? String(msg.error) : '' });
        } else if (msg.type === 'mtlx-test-material-preview') {
            if (testHooks) testHooks.emitMaterialPreviewReport(msg.report || null);
        } else if (msg.type === 'mtlx-save-file') {
            await handleSaveFile(webview, msg, documentUri);
        }
    });
}

// Turn a Node Buffer/Uint8Array-keyed files map (docScanner's return
// shape) into a plain object of base64 strings for the 'mtlx-open'
// message's `filesB64` field. VS Code's extension<->webview postMessage
// channel does NOT reliably deliver typed arrays as typed arrays:
// despite an earlier assumption here that VS Code >=1.57 sends
// Uint8Array natively, observed behavior is that a Node Buffer posted
// as-is JSON-serializes into a plain object on the webview side. That
// defect was masked for this path only because nothing here parses the
// bytes as anything more demanding than an opaque Blob, but it was
// silently producing corrupt texture/include payloads all the same.
// media/bootstrap.js decodes each entry back to a Uint8Array before
// wrapping it in a Blob.
function toMessageFilesB64(files) {
    const out = {};
    for (const key of Object.keys(files)) out[key] = Buffer.from(files[key]).toString('base64');
    return out;
}

// Turns docScanner's `textures` map ({ [key]: { uri, size, mtime } }) into
// the 'mtlx-open' message's `fileUrls` field: a webview resource URL per
// texture, so media/bootstrap.js fetches the bytes itself instead of them
// being base64-encoded through postMessage. The '?v=mtime-size' query is
// a cache-buster only: VS Code's webview resource cache otherwise keeps
// serving a texture's old bytes after it's rewritten on disk and the live
// reload picks up the change.
function toFileUrls(webview, textures) {
    const out = {};
    for (const key of Object.keys(textures)) {
        const t = textures[key];
        out[key] = webview.asWebviewUri(t.uri).toString() + '?v=' + t.mtime + '-' + t.size;
    }
    return out;
}

// ---------------------------------------------------------------------
// Ctrl+S reliability (VX5): a webview's in-iframe keydown listener is
// NOT reliably the first/only responder for a chord VS Code's workbench
// keybinding service also wants to interpret (it may route Ctrl+S to its
// own "save this webview" handling before — or instead of — the page's
// own listener ever seeing it). The robust fix is a package.json-
// contributed keybinding (materialxPlayground.saveGraph, gated on
// `when: activeCustomEditorId == 'materialxPlayground.editor'`) that VS
// Code itself dispatches through the command system, no webview focus
// race involved. That command needs to know which panel/document to
// save — VS Code doesn't hand a CustomTextEditorProvider a "currently
// active" accessor, so this module tracks it by hand: the last panel
// resolveCustomTextEditor created, updated whenever a panel reports
// itself active via onDidChangeViewState (the user can have several
// .mtlx tabs open, each its own panel/document pair), and cleared when
// that panel is disposed — but ONLY if it's still the one referenced
// here, so a stale dispose (of a panel that already lost "active" status
// to a newer one) can't clobber the real current entry.
let activePanelInfo = null; // { panel, document } | null

// Shared by saveActiveGraph/undoActiveGraph/redoActiveGraph: posts the
// given message to the active panel's webview (see the comment on
// activePanelInfo above for what "active" tracks and why), or shows an
// info message if no MaterialX Playground editor is currently active.
function postToActivePanel(message) {
    if (!activePanelInfo) {
        vscode.window.showInformationMessage('No active MaterialX Playground editor.');
        return;
    }
    activePanelInfo.panel.webview.postMessage(message);
}

// Command handler for materialxPlayground.saveGraph (registered in
// extension.js, bound to the Ctrl+S/Cmd+S keybinding above). Asks the
// active panel's webview to run its own save path (media/bootstrap.js's
// requestGraphSave(), which still gates on the Node Graph view actually
// being mounted) rather than duplicating that logic here — the reply
// comes back as the existing 'mtlx-save' message, handled exactly as it
// always was in resolveCustomTextEditor below.
function saveActiveGraph() {
    postToActivePanel({ type: 'mtlx-request-save' });
}

// Command handlers for materialxPlayground.undoGraph/redoGraph
// (registered in extension.js, bound to the Ctrl+Z/Cmd+Z and
// Ctrl+Shift+Z/Cmd+Shift+Z/Ctrl+Y keybindings). These commands must
// exist at all so, while the custom editor is active, these contributed
// keybindings can OUTRANK the workbench's default routing of the chord
// and hand it to this extension first — the webview's own
// 'mtlx-request-undo'/'mtlx-request-redo' handling (media/bootstrap.js)
// then guards on graph-view-visible / not-focused-in-a-text-field and, if
// those pass, asks US (via 'mtlx-native-undo'/'mtlx-native-redo', see the
// messageSub handling below) to run VS Code's own native document
// undo/redo — safe because the .mtlx document buffer is kept continuously
// in sync with the live graph session via 'mtlx-sync' (window.
// __mtlxNotifyEdit in js/graph-app.jsx), so the native undo/redo stack
// already reflects every graph edit, not just explicit saves.
function undoActiveGraph() {
    postToActivePanel({ type: 'mtlx-request-undo' });
}

function redoActiveGraph() {
    postToActivePanel({ type: 'mtlx-request-redo' });
}

// ---------------------------------------------------------------------
// Docs panel singleton: backs the materialxPlayground.openDocs command
// (extension.js) — the graph editor's "?" button no longer routes here,
// it renders the docs view inline inside the editor webview itself (see
// js/graph/dialogs.jsx's DocsDialog). Repeated invocations of the command
// want "a docs panel showing this hash" rather than "a brand-new docs
// panel every time", so one docs panel is reused, revealed and
// re-navigated (via the existing mode: 'docs' 'mtlx-open' message, see
// bootstrap.js) on every subsequent call.
let docsPanelInfo = null; // { panel } | null

async function openDocsPanel(context, hash, viewColumn) {
    if (docsPanelInfo) {
        const { panel } = docsPanelInfo;
        panel.reveal(undefined, true); // preserveFocus, keep its current column
        panel.webview.postMessage({ type: 'mtlx-open', mode: 'docs', hash: hash });
        return;
    }
    const panel = vscode.window.createWebviewPanel(
        'materialxPlayground.docs',
        'MaterialX: Node Documentation',
        viewColumn,
        { retainContextWhenHidden: true }
    );
    await MaterialXEditorProvider.renderStaticHtml(context, panel, hash);
    docsPanelInfo = { panel };
    panel.onDidDispose(() => {
        // Only clear if THIS panel is still the recorded one — mirrors
        // the activePanelInfo dispose guard above.
        if (docsPanelInfo && docsPanelInfo.panel === panel) {
            docsPanelInfo = null;
        }
    });
}

class MaterialXEditorProvider {
    constructor(context) {
        this.context = context;
    }

    async resolveCustomTextEditor(document, webviewPanel /*, _token */) {
        try {
            const uriKey = document.uri.toString();
            // The materialxPlayground.defaultView setting picks which view is
            // shown first (the initial hash) — the document itself is
            // always loaded into both views (see sendUpdate's mode:
            // 'both' below), so this only decides what the user sees on
            // first paint. The header nav switches to the other view,
            // already loaded.
            const defaultView = getSetting('defaultView');
            const initialHash = defaultView === 'graph' ? '#!graph' : '#!viewer';

            // Same root docScanner.scan() confines refs to, sized into
            // localResourceRoots below so the webview can asWebviewUri()
            // this document's textures. null for an untitled/non-file
            // document with no open workspace folder (buildHtml then
            // falls back to just the extension root).
            const containmentRoot = docScanner.containmentRoot(document.uri);

            // false: this IS the file-backed custom editor, so it keeps
            // every tab (Docs + Viewer + Graph) — see buildHtml's comment
            // on the docsOnly parameter above.
            await buildHtml(this.context, webviewPanel.webview, initialHash, false, containmentRoot);

            // Error forwarding, shared with the docs panel (see
            // wireCommonWebviewMessages above).
            const commonSub = wireCommonWebviewMessages(webviewPanel.webview, undefined, document.uri);

            // Register as the active panel immediately (a freshly created
            // panel is always the one the user is looking at), then keep
            // it current as focus moves between tabs — see the comment on
            // activePanelInfo above for why this tracking exists.
            activePanelInfo = { panel: webviewPanel, document };
            const viewStateSub = webviewPanel.onDidChangeViewState(() => {
                if (webviewPanel.active) {
                    activePanelInfo = { panel: webviewPanel, document };
                }
            });

            // Per-panel scan sequence: sendUpdate can overlap itself (a
            // fast edit debounces into a new scan before an older
            // docScanner.scan() call resolves), so a superseded scan's
            // result or error is dropped instead of posting stale data.
            let scanSeq = 0;
            // Last warning list (joined) actually logged for THIS panel,
            // so the same unresolved include/texture is only re-logged
            // when the warning set actually changes.
            let lastLoggedWarnings = null;

            // The document is sent to BOTH views (mode: 'both' below) —
            // initialHash (fixed above, for the lifetime of this panel)
            // only controls which one is visible first. Switching
            // materialxPlayground.defaultView after the fact doesn't yank an
            // already-open tab from one view to the other on the next
            // live-reload tick; it only affects panels opened afterward.
            const sendUpdate = async () => {
                const mySeq = ++scanSeq;
                try {
                    const xml = document.getText();
                    const name = path.basename(document.uri.fsPath, path.extname(document.uri.fsPath));
                    const { files, textures, warnings } = await docScanner.scan(document.uri, xml);
                    if (mySeq !== scanSeq) return; // superseded by a newer scan while this one was in flight

                    const joined = warnings.join('\n');
                    if (warnings.length && joined !== lastLoggedWarnings) {
                        // Non-fatal (missing texture, unresolved include,
                        // etc.) — logged, not surfaced as an error dialog
                        // per file, or every dangling texture ref in a
                        // large scene would pop a toast.
                        console.warn('[MaterialX Playground] ' + document.fileName + ':\n  ' + warnings.join('\n  '));
                        // Also surface to the visible Output channel —
                        // console.warn only reaches the dev host's
                        // devtools console, which most users never open.
                        const channel = getSharedOutputChannel();
                        for (const warning of warnings) {
                            logLine(channel, document.fileName + ': ' + warning);
                        }
                    }
                    lastLoggedWarnings = joined;

                    webviewPanel.webview.postMessage({
                        type: 'mtlx-open',
                        mode: 'both',
                        name,
                        xml,
                        filesB64: toMessageFilesB64(files),
                        fileUrls: toFileUrls(webviewPanel.webview, textures),
                    });
                } catch (err) {
                    if (mySeq !== scanSeq) return; // superseded, don't surface a stale scan's error
                    vscode.window.showErrorMessage(
                        'MaterialX Playground: failed to load "' + path.basename(document.fileName) + '" — '
                        + errMsg(err)
                    );
                }
            };

            // Echo-suppression counter for the 'mtlx-save' and 'mtlx-sync'
            // handlers below: while > 0, EVERY change event on this
            // document is our own doing — the mtlx-save handler's
            // applyEdit plus whatever edits VS Code's save participants
            // (files.insertFinalNewline, files.trimTrailingWhitespace,
            // format-on-save, third-party formatters) apply inside
            // document.save(), or the mtlx-sync handler's own applyEdit —
            // so changeSub must not schedule a resend for any of them. The
            // previous mechanism here (an exact-text marker) was
            // single-shot and only matched the applyEdit event, letting
            // save-participant edits leak through and trigger the
            // destructive resend: the re-ingest wiped the graph's undo
            // history right after every save.
            //
            // This is a COUNTER, not a boolean, because 'mtlx-sync' fires
            // much more often than 'mtlx-save' ever did (once per settled
            // graph edit, ~350ms coalesced, vs. once per explicit Ctrl+S)
            // and the two can in principle overlap — a sync landing while
            // a save's document.save() (which can trigger save-participant
            // edits) hasn't resolved yet. A plain boolean risks one
            // operation's `finally` clearing suppression while the other
            // is still in-flight; a counter (suppressed while > 0) stays
            // correct under overlap. 0 whenever no webview-originated
            // edit/save is in-flight, so it can never suppress a real
            // external edit.
            let hostEditDepth = 0;

            // The webview sends {type:'ready'} once its own boot (site
            // shell + WASM env warmup kickoff) has reached the point
            // where js/graph-app.jsx / js/viewer-app.jsx's
            // 'mtlx-load-document'/'mtlx-view-document' listeners are
            // registered (see media/bootstrap.js) — sending earlier would
            // race the listener registration and the payload would be
            // dropped on the floor.
            //
            // 'mtlx-save' (Ctrl+S inside the Node Graph view — reaches
            // here via either path: the contributed keybinding's
            // materialxPlayground.saveGraph command, which posts
            // 'mtlx-request-save' and lets the webview reply with this,
            // or media/bootstrap.js's belt-and-suspenders in-webview
            // keydown listener posting it directly): write the webview's
            // current graph XML back to THIS document's full range and
            // save it to disk, then reply so the webview can settle its
            // pending save promise (and mark its own session saved).
            const messageSub = webviewPanel.webview.onDidReceiveMessage(async (msg) => {
                if (!msg) return;
                if (msg.type === 'ready') {
                    sendUpdate();
                    return;
                }
                if (msg.type === 'mtlx-save') {
                    const xml = typeof msg.xml === 'string' ? msg.xml : '';
                    try {
                        const fullRange = document.validateRange(new vscode.Range(0, 0, document.lineCount, 0));
                        const edit = new vscode.WorkspaceEdit();
                        edit.replace(document.uri, fullRange, xml);
                        // Incremented BEFORE applyEdit: applyEdit
                        // synchronously fires onDidChangeTextDocument
                        // (changeSub below), so the counter has to already
                        // be incremented by the time that listener runs, or
                        // the echo-suppression check there would miss it.
                        hostEditDepth++;
                        const applied = await vscode.workspace.applyEdit(edit);
                        if (!applied) {
                            throw new Error('edit was not applied (document may have changed concurrently)');
                        }
                        await document.save();
                        webviewPanel.webview.postMessage({ type: 'mtlx-save-result', ok: true });
                    } catch (err) {
                        const message = errMsg(err);
                        vscode.window.showErrorMessage(
                            'MaterialX Playground: failed to save "' + path.basename(document.fileName) + '" — ' + message
                        );
                        webviewPanel.webview.postMessage({ type: 'mtlx-save-result', ok: false, error: message });
                    } finally {
                        // Always decremented once the save settles, success
                        // or failure. Safe to decrement here: save
                        // participants' change events all fire before
                        // document.save() resolves, so by the time this
                        // finally runs, every change event this save could
                        // produce has already been (correctly) suppressed
                        // by changeSub below.
                        hostEditDepth--;
                    }
                    return;
                }
                if (msg.type === 'mtlx-sync') {
                    // Fire-and-forget buffer sync: js/graph-app.jsx's
                    // flushUndoSnapshot calls window.__mtlxNotifyEdit
                    // (bootstrap.js posts this) whenever a coalesced graph
                    // edit settles, so the real .mtlx document buffer stays
                    // continuously in sync — this is what makes the VS Code
                    // tab's "unsaved changes" dot track live graph edits,
                    // and keeps any other open view of the same file (e.g.
                    // a plain text editor split) live. Unlike 'mtlx-save':
                    // no document.save() (does not write to disk) and no
                    // reply is posted back.
                    const xml = typeof msg.xml === 'string' ? msg.xml : null;
                    if (xml === null) return;
                    try {
                        if (xml === document.getText()) return; // no-op, avoid a redundant WorkspaceEdit
                        const fullRange = document.validateRange(new vscode.Range(0, 0, document.lineCount, 0));
                        const edit = new vscode.WorkspaceEdit();
                        edit.replace(document.uri, fullRange, xml);
                        hostEditDepth++;
                        try {
                            await vscode.workspace.applyEdit(edit);
                        } finally {
                            hostEditDepth--;
                        }
                    } catch (err) {
                        vscode.window.showErrorMessage(
                            'MaterialX Playground: failed to sync "' + path.basename(document.fileName) + '" — '
                            + errMsg(err)
                        );
                    }
                    return;
                }
                if (msg.type === 'mtlx-native-undo' || msg.type === 'mtlx-native-redo') {
                    // Requested by media/bootstrap.js's
                    // 'mtlx-request-undo'/'mtlx-request-redo' handling (in
                    // turn triggered by the materialxPlayground.undoGraph/
                    // redoGraph commands below). Deliberately does NOT
                    // touch hostEditDepth — the whole point is for the
                    // resulting document change to flow through the normal
                    // live-reload path (changeSub below) so the graph
                    // re-renders the undone/redone state.
                    try {
                        await vscode.commands.executeCommand(msg.type === 'mtlx-native-undo' ? 'undo' : 'redo');
                        // Skip the generic RELOAD_DEBOUNCE_MS wait so
                        // undo/redo feels immediate: cancel any pending
                        // debounced resend and send the fresh state right
                        // away.
                        if (debounceTimer) {
                            clearTimeout(debounceTimer);
                            debounceTimer = null;
                        }
                        sendUpdate();
                    } catch (err) {
                        vscode.window.showErrorMessage(
                            'MaterialX Playground: ' + (msg.type === 'mtlx-native-undo' ? 'undo' : 'redo') + ' failed — '
                            + errMsg(err)
                        );
                    }
                }
            });

            // Live reload: re-scan + resend whenever THIS document's text
            // changes, debounced so a fast typist doesn't trigger a
            // filesystem crawl per keystroke.
            let debounceTimer = null;
            const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() !== uriKey) return;
                // Echo suppression: this fires for the 'mtlx-save' and
                // 'mtlx-sync' handlers' own applyEdit calls above too — and
                // for every edit VS Code's save participants apply inside
                // document.save() — since those are changes to THIS
                // document like any other. Resending in those cases would
                // re-ingest the graph's own just-written serialization back
                // into the webview on the next debounce tick, destroying
                // its undo history/selection over data it JUST wrote — so
                // while a webview-originated edit/save is in flight, skip
                // scheduling a resend entirely (see the comment on
                // hostEditDepth above for why a counter, not a boolean, is
                // what's needed here).
                if (hostEditDepth > 0) return;
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(sendUpdate, RELOAD_DEBOUNCE_MS);
            });

            webviewPanel.onDidDispose(() => {
                commonSub.dispose();
                messageSub.dispose();
                changeSub.dispose();
                viewStateSub.dispose();
                if (debounceTimer) clearTimeout(debounceTimer);
                // Only clear if THIS panel is still the recorded active
                // one — a panel that already lost "active" status to a
                // newer tab (and was superseded in activePanelInfo above)
                // being disposed later must not wipe out that newer entry.
                if (activePanelInfo && activePanelInfo.panel === webviewPanel) {
                    activePanelInfo = null;
                }
            });
        } catch (err) {
            vscode.window.showErrorMessage(
                'MaterialX Playground: failed to open the editor — ' + errMsg(err)
            );
        }
    }

    // Document-less variant for extension.js's materialxPlayground.openDocs
    // command: same HTML/chrome, no document payload ever sent (the docs
    // view browses the node library entirely on its own, same as visiting
    // index.html#!docs directly). Takes the whole panel (not just its
    // webview) so it can wire the shared error-forwarding handler and
    // dispose it with the panel.
    static async renderStaticHtml(context, panel, initialHash) {
        try {
            // true: this is only ever the standalone docs panel (no .mtlx
            // document backs it) — see buildHtml's comment on the
            // docsOnly parameter above.
            await buildHtml(context, panel.webview, initialHash, true);
            const commonSub = wireCommonWebviewMessages(panel.webview, undefined, null);
            panel.onDidDispose(() => commonSub.dispose());
        } catch (err) {
            vscode.window.showErrorMessage(
                'MaterialX Playground: failed to open node documentation — ' + errMsg(err)
            );
        }
    }
}

// buildHtml, wireCommonWebviewMessages, toFileUrls and trackScenePanel are
// exported for sceneProvider.js only, so the USD scene editor shares the
// exact same chrome, error forwarding and save bridge as the .mtlx editor.
module.exports = {
    MaterialXEditorProvider,
    buildHtml,
    wireCommonWebviewMessages,
    toFileUrls,
    trackScenePanel,
    RELOAD_DEBOUNCE_MS,
    saveActiveGraph,
    undoActiveGraph,
    redoActiveGraph,
    openDocsPanel,
    getSharedOutputChannel,
    logLine,
    disposeSharedOutputChannel,
    // null unless MTLX_TEST_TRANSPORT=1 (see TEST_TRANSPORT above):
    // extension.js's activate() surfaces this as its return value's
    // `_test` field, for the stress-test harness only.
    testApi: testHooks ? testHooks.api : null,
};
