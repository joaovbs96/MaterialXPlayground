// extension.js — activation entry point for the MaterialX Playground
// extension. Registers the custom editor (editorProvider.js) that hosts
// the site's Material Viewer / Node Graph Editor in a webview, plus three
// commands that jump a .mtlx file into one of those views (or into the
// docs-only view, which has no backing document).
'use strict';

const vscode = require('vscode');
const { MaterialXEditorProvider } = require('./editorProvider');

// Handshake between the "open in X" commands and the custom editor
// provider: vscode.openWith() re-resolves (or activates) the custom
// editor for a uri, but doesn't let the caller pass along "which mode
// should this webview boot into" — the provider only ever sees the
// document + a fresh webview panel. So the command records the requested
// mode here, keyed by the document's uri string, immediately before
// calling openWith(); resolveCustomTextEditor reads (and clears) it when
// it runs, moments later, falling back to the materialx.defaultView
// setting if nothing was recorded (e.g. the user opened the file via
// Explorer double-click / "Reopen Editor With" instead of a command).
// Module-level Map, not extension state: this is a one-shot,
// same-activation-session handoff, not something that needs to survive
// a reload.
const pendingModeByUri = new Map();

function activate(context) {
    const provider = new MaterialXEditorProvider(context, pendingModeByUri);

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

    const openWithMode = async (uriArg, mode) => {
        try {
            const uri = resolveTargetUri(uriArg);
            if (!uri) {
                vscode.window.showErrorMessage('MaterialX Playground: no .mtlx file to open (no active editor and no file selected).');
                return;
            }
            pendingModeByUri.set(uri.toString(), mode);
            await vscode.commands.executeCommand('vscode.openWith', uri, 'materialxPlayground.editor');
        } catch (err) {
            vscode.window.showErrorMessage('MaterialX Playground: failed to open "' + mode + '" view — ' + (err && err.message ? err.message : String(err)));
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('materialxPlayground.openInViewer', (uriArg) => openWithMode(uriArg, 'viewer')),
        vscode.commands.registerCommand('materialxPlayground.openInGraphEditor', (uriArg) => openWithMode(uriArg, 'graph')),
        vscode.commands.registerCommand('materialxPlayground.openDocs', async () => {
            try {
                // No backing .mtlx document — a plain WebviewPanel using the
                // same HTML builder, initial hash '#!docs', no message
                // payload ever sent (the docs view browses the node
                // library on its own, same as visiting index.html#!docs
                // directly in a browser). renderStaticHtml sets
                // webview.options (enableScripts + localResourceRoots)
                // itself, same as resolveCustomTextEditor does.
                const panel = vscode.window.createWebviewPanel(
                    'materialxPlayground.docs',
                    'MaterialX: Node Documentation',
                    vscode.ViewColumn.Active,
                    { retainContextWhenHidden: true }
                );
                await MaterialXEditorProvider.renderStaticHtml(context, panel.webview, '#!docs');
            } catch (err) {
                vscode.window.showErrorMessage('MaterialX Playground: failed to open node documentation — ' + (err && err.message ? err.message : String(err)));
            }
        })
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
