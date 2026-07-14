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
const docScanner = require('./docScanner');

// How long to wait after the last keystroke before rescanning + resending
// the document to the webview. Keeps a fast typist from triggering a
// filesystem crawl (docScanner.scan) on every character.
const RELOAD_DEBOUNCE_MS = 400;

// Reads vscode_extension/media/webview.html and substitutes its
// ${placeholder} tokens. Shared by resolveCustomTextEditor (the real
// custom editor, backed by a document) and renderStaticHtml (the
// document-less "MaterialX: Open Node Documentation" command in
// extension.js) — both need byte-identical chrome, just a different
// initial hash and, for the static case, no document-payload wiring.
// Returns the repo-root Uri so callers can hand it to
// wireCommonWebviewMessages() without re-deriving it.
async function buildHtml(context, webview, initialHash) {
    // v1 runs the extension straight out of a checkout of this repo (see
    // README.md "Development" — F5 "Run Extension"), so the site lives
    // one directory up from the extension (../index.html, ../js, ...).
    // Packaging this as a .vsix later will need the site's files copied
    // INTO the extension (e.g. vscode_extension/site/) and this uri
    // updated to point there instead — an extension package cannot
    // reach outside its own install directory at runtime.
    const repoRootUri = vscode.Uri.joinPath(context.extensionUri, '..');

    webview.options = {
        enableScripts: true,
        localResourceRoots: [repoRootUri],
    };

    const templateUri = vscode.Uri.joinPath(context.extensionUri, 'media', 'webview.html');
    const bootstrapUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'bootstrap.js'));
    const baseUri = webview.asWebviewUri(repoRootUri).toString() + '/';

    const bytes = await vscode.workspace.fs.readFile(templateUri);
    let html = Buffer.from(bytes).toString('utf8');
    html = html.split('${cspSource}').join(webview.cspSource);
    html = html.split('${baseUri}').join(baseUri);
    html = html.split('${bootstrapUri}').join(bootstrapUri.toString());
    html = html.split('${initialHash}').join(initialHash);

    webview.html = html;
    return repoRootUri;
}

// ---------------------------------------------------------------------
// Shared webview message wiring — used by BOTH webview creation sites
// (resolveCustomTextEditor's custom-editor panel and extension.js's
// document-less docs panel), so the fetch bridge and error forwarding
// behave identically everywhere the site runs.

// Whitelist for 'mtlx-fetch' paths: exactly the MaterialX Emscripten
// payloads under js/ (JsMaterialX*.data / *.wasm, including versioned
// names like JsMaterialXGenShader-1.39.5.data). The webview must NOT be
// able to read arbitrary disk paths through this bridge — no slashes
// beyond the fixed 'js/' prefix, no '..' escapes (the character class
// admits dots but the single fixed prefix means the path can never leave
// js/), nothing that isn't a MaterialX payload.
const FETCH_WHITELIST_RE = /^js\/JsMaterialX[\w.\-]*\.(data|wasm)$/;

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

// Handles the two message types every MaterialX webview can send,
// regardless of which command created it:
//   - 'mtlx-fetch'  { id, path }: media/bootstrap.js's fetch() bridge
//     asking for a MaterialX Emscripten payload's raw bytes. The webview
//     resource pipeline corrupts these large binaries in transit (packed
//     virtual-FS slice offsets shift; the stdlib XML then parse-fails at
//     a packed file's EOF), so bootstrap.js intercepts the glue code's
//     fetch() and we serve the on-disk bytes from the extension host
//     instead. Reply: { type: 'mtlx-fetch-result', id, ok, bytesB64|error }
//     — NOT a raw Uint8Array/Buffer: VS Code's extension<->webview
//     postMessage channel does NOT reliably deliver typed arrays as typed
//     arrays (despite docs suggesting structured-clone semantics); in
//     practice a Node Buffer posted here JSON-serializes into a plain
//     `{ '0': 0, '1': 97, ... }` object on the webview side. That surfaced
//     as `WebAssembly.instantiate(): expected magic word 00 61 73 6d,
//     found 5b 6f 62 6a` — "5b 6f 62 6a" is ASCII "[obj", i.e.
//     `new Response(thatObject)` stringifying to "[object Object]". Base64
//     text has no such ambiguity crossing the boundary; the ~33% size
//     overhead on a payload that's at most a few MB is negligible next to
//     correctness.
//   - 'mtlx-error'  { text }: an uncaught error / unhandled rejection
//     inside the webview, forwarded to the shared OutputChannel for
//     diagnostics.
// `outputChannel` is optional — omitted, the lazily-created shared
// channel is used. Returns the Disposable for the listener; callers
// dispose it with their panel.
function wireCommonWebviewMessages(webview, repoRootUri, outputChannel) {
    return webview.onDidReceiveMessage(async (msg) => {
        if (!msg) return;
        if (msg.type === 'mtlx-fetch') {
            const id = msg.id;
            const relPath = msg.path;
            try {
                if (typeof relPath !== 'string' || !FETCH_WHITELIST_RE.test(relPath)) {
                    webview.postMessage({ type: 'mtlx-fetch-result', id, ok: false, error: 'path not allowed: ' + String(relPath) });
                    return;
                }
                const fileUri = vscode.Uri.joinPath(repoRootUri, ...relPath.split('/'));
                const bytes = await vscode.workspace.fs.readFile(fileUri);
                webview.postMessage({ type: 'mtlx-fetch-result', id, ok: true, bytesB64: Buffer.from(bytes).toString('base64') });
            } catch (err) {
                // bootstrap.js falls back to its native fetch on
                // { ok: false }, so a read failure here is never worse
                // than not having the bridge at all.
                webview.postMessage({ type: 'mtlx-fetch-result', id, ok: false, error: err && err.message ? err.message : String(err) });
            }
        } else if (msg.type === 'mtlx-error') {
            const channel = outputChannel || getSharedOutputChannel();
            channel.appendLine('[' + new Date().toISOString() + '] ' + String(msg.text || ''));
        }
    });
}

// Turn a Node Buffer/Uint8Array-keyed files map (docScanner's return
// shape) into a plain object of base64 strings for the 'mtlx-open'
// message's `filesB64` field. Same reasoning as the 'mtlx-fetch-result'
// bytesB64 field above: VS Code's extension<->webview postMessage channel
// does NOT reliably deliver typed arrays as typed arrays — despite an
// earlier assumption here that VS Code >=1.57 sends Uint8Array natively,
// observed behavior is that a Node Buffer posted as-is JSON-serializes
// into a plain object on the webview side. That defect was masked for
// this path (unlike the 'mtlx-fetch' stdlib payload, which fails loudly
// with a WebAssembly magic-word error) only because nothing here parses
// the bytes as anything more demanding than an opaque Blob — but it was
// silently producing corrupt texture/include payloads all the same.
// media/bootstrap.js decodes each entry back to a Uint8Array before
// wrapping it in a Blob.
function toMessageFilesB64(files) {
    const out = {};
    for (const key of Object.keys(files)) out[key] = Buffer.from(files[key]).toString('base64');
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

// Command handler for materialxPlayground.saveGraph (registered in
// extension.js, bound to the Ctrl+S/Cmd+S keybinding above). Asks the
// active panel's webview to run its own save path (media/bootstrap.js's
// requestGraphSave(), which still gates on the Node Graph view actually
// being mounted) rather than duplicating that logic here — the reply
// comes back as the existing 'mtlx-save' message, handled exactly as it
// always was in resolveCustomTextEditor below.
function saveActiveGraph() {
    if (!activePanelInfo) {
        vscode.window.showInformationMessage('No active MaterialX Playground editor.');
        return;
    }
    activePanelInfo.panel.webview.postMessage({ type: 'mtlx-request-save' });
}

class MaterialXEditorProvider {
    constructor(context) {
        this.context = context;
    }

    async resolveCustomTextEditor(document, webviewPanel /*, _token */) {
        try {
            const uriKey = document.uri.toString();
            // The materialx.defaultView setting picks which view is
            // shown first (the initial hash) — the document itself is
            // always loaded into both views (see sendUpdate's mode:
            // 'both' below), so this only decides what the user sees on
            // first paint. The header nav switches to the other view,
            // already loaded.
            const defaultView = vscode.workspace.getConfiguration('materialx').get('defaultView', 'viewer');
            const initialHash = defaultView === 'graph' ? '#!graph' : '#!viewer';

            const repoRootUri = await buildHtml(this.context, webviewPanel.webview, initialHash);

            // Fetch bridge + error forwarding, shared with the docs
            // panel (see wireCommonWebviewMessages above).
            const commonSub = wireCommonWebviewMessages(webviewPanel.webview, repoRootUri);

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

            // The document is sent to BOTH views (mode: 'both' below) —
            // initialHash (fixed above, for the lifetime of this panel)
            // only controls which one is visible first. Switching
            // materialx.defaultView after the fact doesn't yank an
            // already-open tab from one view to the other on the next
            // live-reload tick; it only affects panels opened afterward.
            const sendUpdate = async () => {
                try {
                    const xml = document.getText();
                    const name = path.basename(document.uri.fsPath, path.extname(document.uri.fsPath));
                    const { files, warnings } = await docScanner.scan(document.uri, xml);
                    if (warnings.length) {
                        // Non-fatal (missing texture, unresolved include,
                        // etc.) — logged, not surfaced as an error dialog
                        // per file, or every dangling texture ref in a
                        // large scene would pop a toast.
                        console.warn('[MaterialX Playground] ' + document.fileName + ':\n  ' + warnings.join('\n  '));
                    }
                    webviewPanel.webview.postMessage({
                        type: 'mtlx-open',
                        mode: 'both',
                        name,
                        xml,
                        filesB64: toMessageFilesB64(files),
                    });
                } catch (err) {
                    vscode.window.showErrorMessage(
                        'MaterialX Playground: failed to load "' + path.basename(document.fileName) + '" — '
                        + (err && err.message ? err.message : String(err))
                    );
                }
            };

            // Echo-suppression marker for the 'mtlx-save' handler below:
            // set to the exact text just written by applyEdit, immediately
            // before that call; consumed (and cleared) by the changeSub
            // listener's matching onDidChangeTextDocument fire so the
            // live-reload resend it would otherwise schedule is skipped —
            // see the comment on changeSub for why that resend must not
            // happen. null whenever no webview-originated save is
            // in-flight, so it can never accidentally suppress a real
            // external edit that happens to arrive with nothing pending.
            let lastWebviewSaveText = null;

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
                        // Set BEFORE applyEdit: applyEdit synchronously
                        // fires onDidChangeTextDocument (changeSub below),
                        // so the marker has to already be in place by the
                        // time that listener runs, or the echo-suppression
                        // check there would miss it.
                        lastWebviewSaveText = xml;
                        const applied = await vscode.workspace.applyEdit(edit);
                        if (!applied) {
                            lastWebviewSaveText = null;
                            throw new Error('edit was not applied (document may have changed concurrently)');
                        }
                        await document.save();
                        webviewPanel.webview.postMessage({ type: 'mtlx-save-result', ok: true });
                    } catch (err) {
                        lastWebviewSaveText = null;
                        const message = err && err.message ? err.message : String(err);
                        vscode.window.showErrorMessage(
                            'MaterialX Playground: failed to save "' + path.basename(document.fileName) + '" — ' + message
                        );
                        webviewPanel.webview.postMessage({ type: 'mtlx-save-result', ok: false, error: message });
                    }
                }
            });

            // Live reload: re-scan + resend whenever THIS document's text
            // changes, debounced so a fast typist doesn't trigger a
            // filesystem crawl per keystroke.
            let debounceTimer = null;
            const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() !== uriKey) return;
                // Echo suppression: this fires for the 'mtlx-save' handler's
                // own applyEdit above too, since that's a change to THIS
                // document like any other. Resending in that case would
                // re-ingest the graph's own just-written serialization back
                // into the webview on the next debounce tick, destroying its
                // undo history/selection over data it JUST saved — so when
                // the new text matches what mtlx-save wrote, consume the
                // marker and skip scheduling a resend for this change only.
                if (lastWebviewSaveText !== null && e.document.getText() === lastWebviewSaveText) {
                    lastWebviewSaveText = null;
                    return;
                }
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
                'MaterialX Playground: failed to open the editor — ' + (err && err.message ? err.message : String(err))
            );
        }
    }

    // Document-less variant for extension.js's materialxPlayground.openDocs
    // command: same HTML/chrome, no document payload ever sent (the docs
    // view browses the node library entirely on its own, same as visiting
    // index.html#!docs directly). Takes the whole panel (not just its
    // webview) so it can wire the shared fetch-bridge/error-forwarding
    // handler and dispose it with the panel — the docs view needs the
    // WASM payloads (its spec parser runs shader-lib code) exactly as
    // much as the viewer/graph views do.
    static async renderStaticHtml(context, panel, initialHash) {
        try {
            const repoRootUri = await buildHtml(context, panel.webview, initialHash);
            const commonSub = wireCommonWebviewMessages(panel.webview, repoRootUri);
            panel.onDidDispose(() => commonSub.dispose());
        } catch (err) {
            vscode.window.showErrorMessage(
                'MaterialX Playground: failed to open node documentation — ' + (err && err.message ? err.message : String(err))
            );
        }
    }
}

module.exports = { MaterialXEditorProvider, wireCommonWebviewMessages, saveActiveGraph };
