// extension.js — activation entry point for the MaterialX Playground
// extension. Registers the custom editor (editorProvider.js) that hosts
// the site's Material Viewer / Node Graph Editor in a webview, plus two
// commands: one that sends a .mtlx file into both views at once, and one
// that opens the docs-only view, which has no backing document. Also
// wires up live .mtlx diagnostics (validator.js: tier 1 XML well-
// formedness, tier 2 MaterialX semantic validation) into a
// DiagnosticCollection and a status bar summary, and hover documentation
// (hoverProvider.js) for node categories.
'use strict';

const vscode = require('vscode');
const { MaterialXEditorProvider, saveActiveGraph, undoActiveGraph, redoActiveGraph, openDocsPanel, getSharedOutputChannel } = require('./editorProvider');
const validator = require('./validator');
const hoverProvider = require('./hoverProvider');

// Diagnostics + status bar are created once in activate() but read/
// written from the module-scope helpers below (toVsDiagnostics,
// updateStatusBar, runValidation), so they're tracked at module scope
// rather than as activate()-local consts.
let diagnosticCollection = null;
let statusBarItem = null;

// validator.js's return shape ({ message, startLine, startChar, endLine,
// endChar, severity: 'error' }) is plain objects, not vscode.Diagnostic
// instances — validator.js/mtlxNode.js must stay independently loadable
// with plain `node` (no require('vscode')), so this conversion happens
// at the extension.js boundary instead.
function toVsDiagnostics(items) {
    return items.map((it) => new vscode.Diagnostic(
        new vscode.Range(it.startLine, it.startChar, it.endLine, it.endChar),
        it.message,
        it.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error
    ));
}

// Reads the currently active editor itself (no args) — called after
// every diagnosticCollection update and on active-editor changes, so the
// status bar always reflects whichever .mtlx tab (if any) is focused.
function updateStatusBar() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'mtlx') {
        statusBarItem.hide();
        return;
    }
    const diags = diagnosticCollection.get(editor.document.uri) || [];
    if (diags.length === 0) {
        statusBarItem.text = '$(check) MaterialX';
        statusBarItem.tooltip = 'No MaterialX validation issues.';
    } else {
        statusBarItem.text = '$(error) MaterialX: ' + diags.length;
        const preview = diags.slice(0, 3).map((d) => '• ' + d.message).join('\n');
        statusBarItem.tooltip = 'MaterialX validation issue' + (diags.length === 1 ? '' : 's') + ' (' + diags.length + '):\n' + preview + (diags.length > 3 ? '\n…' : '');
    }
    statusBarItem.show();
}

// Runs tier 1 + (when clean) tier 2 validation on `document` and updates
// its diagnostics/the status bar. Never throws — a validator bug must
// not break the editor.
async function runValidation(document) {
    if (document.languageId !== 'mtlx') return;
    let items = [];
    try {
        items = await validator.validateDocument(document.getText());
    } catch (e) {
        items = []; // never let a validator bug break the editor
    }
    diagnosticCollection.set(document.uri, toVsDiagnostics(items));
    const warning = validator.consumeTier2Warning();
    if (warning) {
        getSharedOutputChannel().appendLine('[' + new Date().toISOString() + '] MaterialX semantic validation (tier 2) is unavailable: ' + warning);
    }
    updateStatusBar();
}

// Debounced per-document so a fast typist doesn't re-run tier 1/2 on
// every keystroke, and so multiple open .mtlx tabs don't share (and
// clobber) a single timer. Mirrors editorProvider.js's
// RELOAD_DEBOUNCE_MS naming/pattern.
const VALIDATE_DEBOUNCE_MS = 400;
const debounceTimers = new Map(); // uri.toString() -> NodeJS.Timeout

function activate(context) {
    // Before anything else, so semantic (tier 2) validation is ready as
    // soon as the first .mtlx document is opened.
    validator.init(context.extensionUri.fsPath);

    diagnosticCollection = vscode.languages.createDiagnosticCollection('materialx');
    context.subscriptions.push(diagnosticCollection);

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    statusBarItem.command = 'workbench.actions.view.problems';
    context.subscriptions.push(statusBarItem);

    // Hover documentation for node categories (hoverProvider.js) — pushes
    // its own disposable onto context.subscriptions.
    hoverProvider.register(context);

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
        // Bound to the Ctrl+Z/Cmd+Z and Ctrl+Shift+Z/Cmd+Shift+Z/Ctrl+Y
        // keybindings contributed in package.json (same `when` clause as
        // saveGraph above) — these SHADOW VS Code's built-in text-document
        // undo/redo while our editor is active, so Ctrl+Z routes to the
        // graph's own in-page undo/redo instead of reverting the .mtlx
        // file underneath the live graph session. See
        // editorProvider.js's undoActiveGraph()/redoActiveGraph().
        vscode.commands.registerCommand('materialxPlayground.undoGraph', () => undoActiveGraph()),
        vscode.commands.registerCommand('materialxPlayground.redoGraph', () => redoActiveGraph()),
        // `category` is optional: no-arg (Command Palette / explorer menu)
        // opens the docs library browser exactly as before ('#!docs').
        // Passed a category string — from hoverProvider.js's "Open
        // documentation" command link on a node hover, e.g.
        // command:materialxPlayground.openDocs?["standard_surface"] — it
        // instead deep-links straight to that node, using the SAME
        // name-only permalink hash format the website's own hashToSel
        // (js/docs/doc-links.jsx) resolves by search (exact match, then
        // squashed-lowercase fallback), so an arbitrary category string
        // always lands somewhere sensible even without knowing its
        // lib/group.
        vscode.commands.registerCommand('materialxPlayground.openDocs', async (category) => {
            try {
                // Shares the docs-panel singleton with the graph editor's
                // "?" button (editorProvider.js's openDocsPanel, which the
                // editor webview's message handler also calls) — no
                // document payload ever sent (the docs view browses the
                // node library on its own, same as visiting
                // index.html#!docs directly in a browser), and
                // reveals/re-navigates the existing panel instead of
                // spawning a new one if it's already open.
                const hash = category ? '#/' + encodeURIComponent(String(category)) : '#!docs';
                await openDocsPanel(context, hash, vscode.ViewColumn.Active);
            } catch (err) {
                vscode.window.showErrorMessage('MaterialX Playground: failed to open node documentation — ' + (err && err.message ? err.message : String(err)));
            }
        })
    );

    // Live .mtlx diagnostics: validate anything already open, then keep
    // validating on open/edit/close, and keep the status bar in sync
    // with whichever editor is active.
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId === 'mtlx') runValidation(doc);
    }
    updateStatusBar();

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((doc) => {
            if (doc.languageId === 'mtlx') runValidation(doc);
        }),
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.languageId !== 'mtlx') return;
            const key = e.document.uri.toString();
            const existing = debounceTimers.get(key);
            if (existing) clearTimeout(existing);
            debounceTimers.set(key, setTimeout(() => {
                debounceTimers.delete(key);
                runValidation(e.document);
            }, VALIDATE_DEBOUNCE_MS));
        }),
        vscode.workspace.onDidCloseTextDocument((doc) => {
            const key = doc.uri.toString();
            const existing = debounceTimers.get(key);
            if (existing) { clearTimeout(existing); debounceTimers.delete(key); }
            diagnosticCollection.delete(doc.uri);
            updateStatusBar();
        }),
        vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar())
    );
}

function deactivate() {}

module.exports = { activate, deactivate };
