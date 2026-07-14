// extension.js — activation entry point for the MaterialX Playground
// extension. Registers the custom editor (editorProvider.js) that hosts
// the site's Material Viewer / Node Graph Editor in a webview, plus two
// commands: one that sends a .mtlx file into both views at once, and one
// that opens the docs-only view, which has no backing document.
'use strict';

const vscode = require('vscode');
const { MaterialXEditorProvider, saveActiveGraph } = require('./editorProvider');

function activate(context) {
    const provider = new MaterialXEditorProvider(context);

    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            'materialxPlayground.editor',
            provider,
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false,
            }
        )
    );

    // Resolve the .mtlx uri a command should act on: an explicit uri arg
    // (explorer context menu / programmatic invocation) wins, otherwise
    // fall back to the active text editor's document.
    const resolveTargetUri = (uriArg) => {
        if (uriArg instanceof vscode.Uri) return uriArg;
        const active = vscode.window.activeTextEditor;
        if (active && active.document && active.document.uri) return active.document.uri;
        return null;
    };

    const openInPlayground = async (uriArg) => {
        try {
            const uri = resolveTargetUri(uriArg);
            if (!uri) {
                vscode.window.showErrorMessage('MaterialX Playground: no .mtlx file to open (no active editor and no file selected).');
                return;
            }
            await vscode.commands.executeCommand('vscode.openWith', uri, 'materialxPlayground.editor');
        } catch (err) {
            vscode.window.showErrorMessage('MaterialX Playground: failed to open — ' + (err && err.message ? err.message : String(err)));
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('materialxPlayground.open', (uriArg) => openInPlayground(uriArg)),
        // Bound to the Ctrl+S/Cmd+S keybinding contributed in package.json
        // (when: activeCustomEditorId == 'materialxPlayground.editor') —
        // see editorProvider.js's saveActiveGraph() and the comment on
        // activePanelInfo there for why this is the robust path (a
        // webview's in-iframe keydown listener alone isn't a reliable
        // Ctrl+S responder against VS Code's own keybinding service).
        vscode.commands.registerCommand('materialxPlayground.saveGraph', () => saveActiveGraph()),
        vscode.commands.registerCommand('materialxPlayground.openDocs', async () => {
            try {
                // No backing .mtlx document — a plain WebviewPanel using the
                // same HTML builder, initial hash '#!docs', no document
                // payload ever sent (the docs view browses the node
                // library on its own, same as visiting index.html#!docs
                // directly in a browser). renderStaticHtml sets
                // webview.options (enableScripts + localResourceRoots)
                // itself, same as resolveCustomTextEditor does, and wires
                // the same shared 'mtlx-fetch'/'mtlx-error' handler
                // (editorProvider.js wireCommonWebviewMessages) — the
                // docs view loads the MaterialX WASM payloads too, so it
                // needs the fetch bridge just like the viewer/graph
                // views. That's why the whole panel is passed here, not
                // just panel.webview: the handler's Disposable is tied to
                // panel.onDidDispose.
                const panel = vscode.window.createWebviewPanel(
                    'materialxPlayground.docs',
                    'MaterialX: Node Documentation',
                    vscode.ViewColumn.Active,
                    { retainContextWhenHidden: true }
                );
                await MaterialXEditorProvider.renderStaticHtml(context, panel, '#!docs');
            } catch (err) {
                vscode.window.showErrorMessage('MaterialX Playground: failed to open node documentation — ' + (err && err.message ? err.message : String(err)));
            }
        })
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
