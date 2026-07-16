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
const { MaterialXEditorProvider, saveActiveGraph, undoActiveGraph, redoActiveGraph, openDocsPanel, getSharedOutputChannel, logLine } = require('./editorProvider');
const validator = require('./validator');
const hoverProvider = require('./hoverProvider');
const { errMsg } = require('./util');

// Diagnostics + status bar are created once in activate() but read/
// written from the module-scope helpers below (toVsDiagnostics,
// updateStatusBar, runValidation), so they're tracked at module scope
// rather than as activate()-local consts.
let diagnosticCollection = null;
let statusBarItem = null;

// materialx.autoOpenPlayground bookkeeping (see maybeAutoOpen() in
// activate()): which .mtlx files have already had the playground
// auto-opened for them this extension-host session, keyed by
// uri.toString(). Module scope (not activate()-local) because
// vscode.workspace.onDidCloseTextDocument's re-arm handler and
// vscode.window.onDidChangeActiveTextEditor's trigger handler both need
// to see the same Set across the whole session, exactly like
// diagnosticCollection/statusBarItem above.
const autoOpenedUris = new Set();

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
        logLine(getSharedOutputChannel(), 'MaterialX semantic validation (tier 2) is unavailable: ' + warning);
    }
    updateStatusBar();
}

// Debounced per-document so a fast typist doesn't re-run tier 1/2 on
// every keystroke, and so multiple open .mtlx tabs don't share (and
// clobber) a single timer. Naming mirrors editorProvider.js's
// RELOAD_DEBOUNCE_MS, but not the pattern: that file debounces one
// active panel/document with a single closure-scoped timer, while this
// one debounces however many .mtlx documents are open at once, so it
// needs a timer PER document (the debounceTimers Map below), keyed by
// uri.toString().
const VALIDATE_DEBOUNCE_MS = 400;
const debounceTimers = new Map(); // uri.toString() -> NodeJS.Timeout

// Shape-validated signature token for the materialxPlayground.openDocs
// command's optional second argument: `<outType>` optionally followed by
// `(<name>:<type>,...)` — exactly the grammar vscode_extension/src/
// nodeSignature.js's buildSigToken emits (see that file's own comment on
// why every token it can produce is guaranteed to match this), and the
// same grammar js/docs/doc-links.jsx's parseSigHint expects on the other
// end. Validated here (plus a length cap) before ever being spliced into
// a URI — a command: link's JSON-encoded args are effectively untrusted
// input by the time they reach a command handler (built from hover
// markdown over a possibly hand-edited/untrusted .mtlx document).
const SIG_TOKEN_RE = /^[\w.\-:]+(\([\w.\-:]+:[\w.\-:]+(,[\w.\-:]+:[\w.\-:]+)*\))?$/;

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

    // 'splitRight' placement for openInPlayground below (materialx.
    // openBehavior, package.json contributes.configuration) — figures out
    // WHERE to open the playground so it lands beside a text editor
    // already open on the same file, then issues the `vscode.openWith`
    // call itself. Returns true if it did so (placement handled — the
    // caller must not also do its own plain open), false if there was
    // nothing to split against or anything about the tab-group scan
    // failed, in which case the caller falls back to opening in the
    // active group. Never throws.
    //
    // vscode.window.tabGroups.all exposes every editor group with a
    // numeric `viewColumn` and each tab's `input`, which is
    // `vscode.TabInputText` (has `.uri`) for a plain text tab, or
    // `vscode.TabInputCustom` (has both `.uri` and `.viewType`) for an
    // already-open custom editor tab like ours.
    const openBesideTextEditor = async (uri, preserveFocus) => {
        try {
            const uriStr = uri.toString();
            let textGroupColumn = null; // viewColumn of the group holding a TEXT tab for this uri
            let existingPlaygroundColumn = null; // viewColumn of a group already showing OUR editor for this uri

            for (const group of vscode.window.tabGroups.all) {
                for (const tab of group.tabs) {
                    const input = tab.input;
                    if (input instanceof vscode.TabInputText && input.uri.toString() === uriStr) {
                        textGroupColumn = group.viewColumn;
                    } else if (
                        input instanceof vscode.TabInputCustom
                        && input.viewType === 'materialxPlayground.editor'
                        && input.uri.toString() === uriStr
                    ) {
                        existingPlaygroundColumn = group.viewColumn;
                    }
                }
            }

            // A playground tab for this exact file is already open
            // somewhere — reveal it (openWith to the same resource +
            // viewType reveals the existing tab rather than duplicating
            // it) instead of splitting open a second copy elsewhere.
            if (existingPlaygroundColumn !== null) {
                await vscode.commands.executeCommand(
                    'vscode.openWith', uri, 'materialxPlayground.editor',
                    { viewColumn: existingPlaygroundColumn, preserveFocus }
                );
                return true;
            }

            // No open text editor for this file to split against at all
            // (e.g. an Explorer right-click on a file nothing has opened
            // yet) — nothing for 'splitRight' to do here.
            if (textGroupColumn === null) return false;

            const targetColumn = textGroupColumn + 1;
            const rightGroupExists = vscode.window.tabGroups.all.some((g) => g.viewColumn === targetColumn);

            if (rightGroupExists) {
                // Reuse the existing right-hand group instead of splitting
                // again — this is the whole point of 'splitRight': repeat
                // opens land in the SAME group beside the text editor
                // rather than each one creating a fresh split.
                // vscode.ViewColumn.Beside would NOT give us this: it
                // creates a brand-new group whenever the currently ACTIVE
                // group happens to be the rightmost one
                // (https://github.com/microsoft/vscode/issues/133260), so
                // an explicit, already-known viewColumn is what makes the
                // reuse deterministic here.
                await vscode.commands.executeCommand(
                    'vscode.openWith', uri, 'materialxPlayground.editor',
                    { viewColumn: targetColumn, preserveFocus }
                );
                return true;
            }

            // No group to the right exists yet. vscode.ViewColumn.Beside
            // always splits relative to whichever group is currently
            // ACTIVE — not relative to textGroupColumn — and there is no
            // API to say "create a new group at column N" directly. So:
            // make the text editor's group the active one first (showing
            // the document that's already open there is cheap — it does
            // not reload anything), THEN ask for Beside, which now
            // deterministically splits to the right of it.
            const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriStr)
                || await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { viewColumn: textGroupColumn, preserveFocus: false });
            await vscode.commands.executeCommand(
                'vscode.openWith', uri, 'materialxPlayground.editor',
                { viewColumn: vscode.ViewColumn.Beside, preserveFocus }
            );
            return true;
        } catch (err) {
            // Placement is a nice-to-have — never let it break opening the
            // playground at all. The caller falls back to its own plain
            // open in the active group.
            return false;
        }
    };

    // `options.preserveFocus`, when set, is threaded down to whichever
    // `vscode.openWith` call actually runs — used by maybeAutoOpen()
    // below so an auto-opened playground doesn't steal keyboard focus
    // from the text editor the user is actively typing in.
    const openInPlayground = async (uriArg, { preserveFocus } = {}) => {
        try {
            const uri = resolveTargetUri(uriArg);
            if (!uri) {
                vscode.window.showErrorMessage('MaterialX Playground: no .mtlx file to open (no active editor and no file selected).');
                return;
            }

            const openBehavior = vscode.workspace.getConfiguration('materialx').get('openBehavior', 'splitRight');
            if (openBehavior === 'splitRight') {
                const placed = await openBesideTextEditor(uri, preserveFocus);
                if (placed) return;
                // Nothing to split against (or the scan itself failed) —
                // fall through to the plain open below. Opening SOMEWHERE
                // beats not opening at all.
            }

            // 'sameGroup', or a 'splitRight' fallback: today's plain open
            // in the active group. `{ preserveFocus }` is only passed when
            // the caller actually set it, so a bare `openInPlayground(uri)`
            // call — every pre-existing call site — stays byte-identical
            // to the original `executeCommand('vscode.openWith', uri,
            // 'materialxPlayground.editor')` call with no third argument.
            if (preserveFocus !== undefined) {
                await vscode.commands.executeCommand('vscode.openWith', uri, 'materialxPlayground.editor', { preserveFocus });
            } else {
                await vscode.commands.executeCommand('vscode.openWith', uri, 'materialxPlayground.editor');
            }
        } catch (err) {
            vscode.window.showErrorMessage('MaterialX Playground: failed to open — ' + errMsg(err));
        }
    };

    // materialx.autoOpenPlayground companion: the first time a .mtlx file
    // becomes the active text editor (and on every subsequent FIRST time
    // after the file is closed and reopened — see the re-arm comment on
    // the onDidCloseTextDocument listener below), automatically open the
    // playground beside it. preserveFocus: true is load-bearing here —
    // the whole point is a side panel that appears without stealing
    // keystrokes out from under whatever the user is actively typing.
    const maybeAutoOpen = (editor) => {
        if (!editor || !editor.document || editor.document.uri.scheme !== 'file' || editor.document.languageId !== 'mtlx') return;
        if (!vscode.workspace.getConfiguration('materialx').get('autoOpenPlayground', true)) return;
        const key = editor.document.uri.toString();
        if (autoOpenedUris.has(key)) return;
        autoOpenedUris.add(key);
        openInPlayground(editor.document.uri, { preserveFocus: true });
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
        // Interactive Documentation" command link on a node hover, e.g.
        // command:materialxPlayground.openDocs?["standard_surface"] — it
        // instead deep-links straight to that node, using the SAME
        // name-only permalink hash format the website's own hashToSel
        // (js/docs/doc-links.jsx) resolves by search (exact match, then
        // squashed-lowercase fallback), so an arbitrary category string
        // always lands somewhere sensible even without knowing its
        // lib/group. `sig` is a further-optional signature-token second
        // argument (also from hoverProvider.js, when the hovered
        // element's own signature was derivable) that additionally
        // pre-selects the matching signature/version once the node
        // resolves — see js/docs/doc-links.jsx's parseSigHint and
        // js/docs-app.jsx's matchSigHintToGroups. Both args are
        // backward compatible: no-arg and category-only calls (existing
        // callers, older cached command URIs) behave exactly as before.
        vscode.commands.registerCommand('materialxPlayground.openDocs', async (category, sig) => {
            try {
                // Context-menu invocations (the Explorer / editor tab
                // title entries contributed for this command) pass the
                // target vscode.Uri as the FIRST argument — same calling
                // convention as materialxPlayground.open's uriArg — but
                // this command has no file-backed behavior for a Uri to
                // select: it always opens the same document-less node
                // library browser. Treat any non-string first argument as
                // "no category" rather than URL-encoding a Uri's string
                // form into a bogus '#/<uri>' deep-link hash; a menu click
                // then opens the plain library browser ('#!docs'), same
                // as the Command Palette / no-arg case.
                if (typeof category !== 'string') {
                    category = undefined;
                    sig = undefined;
                }
                // Shares the docs-panel singleton with the graph editor's
                // "?" button (editorProvider.js's openDocsPanel, which the
                // editor webview's message handler also calls) — no
                // document payload ever sent (the docs view browses the
                // node library on its own, same as visiting
                // index.html#!docs directly in a browser), and
                // reveals/re-navigates the existing panel instead of
                // spawning a new one if it's already open.
                const sigOk = typeof sig === 'string' && sig.length <= 512 && SIG_TOKEN_RE.test(sig);
                const hash = category
                    ? '#/' + encodeURIComponent(String(category)) + (sigOk ? '?sig=' + encodeURIComponent(sig) : '')
                    : '#!docs';
                await openDocsPanel(context, hash, vscode.ViewColumn.Active);
            } catch (err) {
                vscode.window.showErrorMessage('MaterialX Playground: failed to open node documentation — ' + errMsg(err));
            }
        })
    );

    // materialx.autoOpenPlayground listeners (see maybeAutoOpen() above):
    // trigger on every active-editor change, and re-arm per file only once
    // that FILE is actually closed — not merely defocused by switching
    // tabs. This distinction is load-bearing: without it, tabbing away
    // from a .mtlx editor and back would look identical to "reopening the
    // file" and pop the playground back open even after the user
    // deliberately closed it, which would defeat the point of closing it
    // at all. Deleting the key only on onDidCloseTextDocument means the
    // auto-open is genuinely a per-"open" thing, not a per-"focus" thing.
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(maybeAutoOpen),
        vscode.workspace.onDidCloseTextDocument((doc) => autoOpenedUris.delete(doc.uri.toString()))
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

    // activate() itself is triggered by the onLanguage:mtlx activation
    // event (package.json activationEvents), which means a .mtlx file can
    // already be the active editor by the time this function runs — i.e.
    // BEFORE the onDidChangeActiveTextEditor listener registered above
    // ever gets a chance to fire for it. Run the same auto-open check once
    // more, by hand, against whatever's active right now, so that first
    // file isn't skipped.
    maybeAutoOpen(vscode.window.activeTextEditor);
}

function deactivate() {}

module.exports = { activate, deactivate };
