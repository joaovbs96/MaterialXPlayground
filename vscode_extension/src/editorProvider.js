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
// initial hash and, for the static case, no message wiring.
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
}

// Turn a Node Buffer/Uint8Array-keyed files map (docScanner's return
// shape) into a plain object VS Code's postMessage can structured-clone.
// VS Code (>=1.57) sends Uint8Array across the webview boundary natively,
// so no base64 round-trip is needed here — see media/bootstrap.js, which
// wraps each entry in `new Blob([u8])` on arrival.
function toMessageFiles(files) {
    const out = {};
    for (const key of Object.keys(files)) out[key] = files[key];
    return out;
}

class MaterialXEditorProvider {
    // pendingModeByUri: the Map<uriString, 'viewer'|'graph'> handshake
    // populated by extension.js's openInViewer/openInGraphEditor commands
    // just before they call vscode.commands.executeCommand('vscode.openWith', ...).
    constructor(context, pendingModeByUri) {
        this.context = context;
        this.pendingModeByUri = pendingModeByUri;
    }

    async resolveCustomTextEditor(document, webviewPanel /*, _token */) {
        try {
            const uriKey = document.uri.toString();
            // The command that opened us (if any) wins; otherwise fall
            // back to the configured default. Consumed once — later
            // reopens of the same file without going through a command
            // (e.g. plain double-click) always fall back to the setting.
            const requestedMode = this.pendingModeByUri.get(uriKey);
            this.pendingModeByUri.delete(uriKey);
            const mode = requestedMode
                || vscode.workspace.getConfiguration('materialx').get('defaultView', 'viewer');
            const initialHash = mode === 'graph' ? '#!graph' : '#!viewer';

            await buildHtml(this.context, webviewPanel.webview, initialHash);

            // Fixed for the lifetime of this panel: switching
            // materialx.defaultView after the fact shouldn't yank an
            // already-open tab from the viewer into the graph editor (or
            // vice versa) out from under the user on the next live-reload
            // tick.
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
                        mode,
                        name,
                        xml,
                        files: toMessageFiles(files),
                    });
                } catch (err) {
                    vscode.window.showErrorMessage(
                        'MaterialX Playground: failed to load "' + path.basename(document.fileName) + '" — '
                        + (err && err.message ? err.message : String(err))
                    );
                }
            };

            // The webview sends {type:'ready'} once its own boot (site
            // shell + WASM env warmup kickoff) has reached the point
            // where js/graph-app.jsx / js/viewer-app.jsx's
            // 'mtlx-load-document'/'mtlx-view-document' listeners are
            // registered (see media/bootstrap.js) — sending earlier would
            // race the listener registration and the payload would be
            // dropped on the floor.
            const messageSub = webviewPanel.webview.onDidReceiveMessage((msg) => {
                if (msg && msg.type === 'ready') sendUpdate();
            });

            // Live reload: re-scan + resend whenever THIS document's text
            // changes, debounced so a fast typist doesn't trigger a
            // filesystem crawl per keystroke.
            let debounceTimer = null;
            const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
                if (e.document.uri.toString() !== uriKey) return;
                if (debounceTimer) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(sendUpdate, RELOAD_DEBOUNCE_MS);
            });

            webviewPanel.onDidDispose(() => {
                messageSub.dispose();
                changeSub.dispose();
                if (debounceTimer) clearTimeout(debounceTimer);
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
    // index.html#!docs directly).
    static async renderStaticHtml(context, webview, initialHash) {
        try {
            await buildHtml(context, webview, initialHash);
        } catch (err) {
            vscode.window.showErrorMessage(
                'MaterialX Playground: failed to open node documentation — ' + (err && err.message ? err.message : String(err))
            );
        }
    }
}

module.exports = { MaterialXEditorProvider };
