// extension.js, activation entry point for the MaterialX Playground
// extension. Registers the custom editor (editorProvider.js) that hosts
// the site's Material Viewer / Node Graph Editor in a webview, plus two
// commands: one that sends a .mtlx file into both views at once, and one
// that opens the docs-only view, which has no backing document. Also
// wires up live .mtlx diagnostics (validator.js: tier 1 XML well-
// formedness, tier 2 MaterialX semantic validation) into a
// DiagnosticCollection and a status bar summary, and hover documentation
// (hoverProvider.js) for node categories.
'use strict';

const path = require('path');
const vscode = require('vscode');
const { MaterialXEditorProvider, saveActiveGraph, undoActiveGraph, redoActiveGraph, openDocsPanel, isDocsPanelOpen, postDocsFilter, getSharedOutputChannel, logLine, disposeSharedOutputChannel, getPanelForUri, setPendingInitialView, postToDocumentPanel, onDidSelectInGraph, testApi } = require('./editorProvider');
const mtlxSymbols = require('./mtlxSymbols');
const validator = require('./validator');
const { ValidationClient } = require('./validationClient');
const hoverProvider = require('./hoverProvider');
const symbolProviders = require('./symbolProviders');
const completionProvider = require('./completionProvider');
const newFromExample = require('./newFromExample');
const exampleGallery = require('./exampleGallery');
const newDocument = require('./newDocument');
const outlineView = require('./outlineView');
const actionsView = require('./actionsView');
const outlineModel = require('./outlineModel');
const filePicker = require('./filePicker');
const sceneProvider = require('./sceneProvider');
const usdFileSet = require('./usdFileSet');
const docScanner = require('./docScanner');
const { errMsg } = require('./util');
const { getSetting } = require('./settingsHost');

// Diagnostics + status bar are created once in activate() but read/
// written from the module-scope helpers below (toVsDiagnostics,
// updateStatusBar, runValidation), so they're tracked at module scope
// rather than as activate()-local consts.
let diagnosticCollection = null;
let statusBarItem = null;
let validationClient = null;

// activeMtlxDocument()/onDidChangeActiveMtlxDocument (E16b/E17): the ONE
// place that decides which .mtlx document is "active" for the status bar,
// the Outline view and the Open in Graph Editor/Viewer actions (when
// invoked with no explicit uri): the focused text editor's document when
// it's a .mtlx file, else the document backing the active MaterialX
// Playground custom-editor tab (if the active tab IS one), else null.
// vscode.window.activeTextEditor alone (the previous behavior for all of
// these) is undefined whenever a webview/custom-editor tab has focus, so
// none of them worked while the Playground itself was focused; this is
// the single fix shared by all three instead of three separate ad hoc
// tab-scans. Exposed as a function (not a cached value) since tab-group
// state can change without a matching text-editor event, and the two
// pieces of state (activeTextEditor, tabGroups.activeTabGroup) aren't
// guaranteed to update in the same tick.
function activeMtlxDocument() {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'mtlx') return editor.document;
    const tabGroup = vscode.window.tabGroups.activeTabGroup;
    const tab = tabGroup && tabGroup.activeTab;
    const input = tab && tab.input;
    if (input instanceof vscode.TabInputCustom && input.viewType === 'materialxPlayground.editor') {
        const uriStr = input.uri.toString();
        return vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriStr) || null;
    }
    return null;
}

const activeMtlxDocumentEmitter = new vscode.EventEmitter();
const onDidChangeActiveMtlxDocument = activeMtlxDocumentEmitter.event;
let lastActiveMtlxDocumentUri = null;

// W1: element tags that are MaterialX structure/graph-plumbing, never node
// categories -- mirrors js/docs-app.jsx's own MTLX_STRUCTURAL_TAGS (kept in
// sync by hand; that copy also excludes these from its local-file picker's
// scan, so a VS Code-driven filter and a browser-picked-file filter agree
// on what counts as a category).
const DOCS_FILTER_STRUCTURAL_TAGS = new Set([
    'materialx', 'nodegraph', 'nodedef', 'nodegraphoutput', 'input', 'output',
    'token', 'member', 'implementation', 'typedef', 'attributedef', 'attributeset',
    'targetdef', 'unitdef', 'unittypedef', 'unit', 'propertyset', 'property',
    'propertyassign', 'variantset', 'variant', 'variantassign', 'geominfo',
    'geomprop', 'geomattr', 'geomattrvalue', 'collection', 'collectionadd',
    'collectionremove', 'look', 'lookgroup', 'materialassign', 'visibility', 'backdrop',
    'xi:include',
]);

// W1: node categories referenced by a .mtlx document's text, for the docs
// panel's file-based filter (js/docs-app.jsx's `mtlx-docs-filter` window
// event contract). Built on mtlxSymbols.scanElements's tolerant element
// tree (same scanner the outline/hover/completion providers use) rather
// than a standalone regex, so a malformed/in-progress edit is tolerated
// the same way everywhere.
function categoriesFromMtlxText(text) {
    const { root } = mtlxSymbols.scanElements(String(text || ''));
    const tags = new Set();
    mtlxSymbols.walkAll(root, (node) => {
        if (!node.tag) return;
        const tag = node.tag.toLowerCase();
        if (!DOCS_FILTER_STRUCTURAL_TAGS.has(tag)) tags.add(tag);
    });
    return Array.from(tags);
}

// W1: whether the docs panel's file filter currently tracks the active
// .mtlx document automatically (the default -- see the design note on
// updateDocsFilter below) or was turned off by the
// materialxPlayground.filterDocsByFile toggle command.
let docsFilterAutoEnabled = true;
let docsFilterDebounce = null;

// Sends (or clears) the docs panel's file filter for the given document,
// only bothering if the docs panel is actually open right now. `immediate`
// skips the debounce (active-document switches; the toggle command).
function updateDocsFilter(document, immediate) {
    if (!isDocsPanelOpen()) return;
    if (docsFilterDebounce) { clearTimeout(docsFilterDebounce); docsFilterDebounce = null; }
    const send = () => {
        if (!docsFilterAutoEnabled) return;
        if (!document || document.languageId !== 'mtlx') { postDocsFilter(null, null); return; }
        const file = path.basename(document.fileName);
        postDocsFilter(file, categoriesFromMtlxText(document.getText()));
    };
    if (immediate) send();
    else docsFilterDebounce = setTimeout(send, 300);
}

// Fires onDidChangeActiveMtlxDocument only when activeMtlxDocument()'s
// answer actually changed (by uri), so switching focus between two
// editors on the SAME .mtlx file, or an event that doesn't actually
// change the answer, doesn't force an unnecessary Outline rebuild.
function fireActiveMtlxDocumentChangeIfNeeded() {
    const doc = activeMtlxDocument();
    const uri = doc ? doc.uri.toString() : null;
    if (uri === lastActiveMtlxDocumentUri) return;
    lastActiveMtlxDocumentUri = uri;
    activeMtlxDocumentEmitter.fire(doc);
    updateDocsFilter(doc, true);
}

// Selection sync (E18, materialxPlayground.syncSelection): text cursor moves
// and Outline picks select the element in the Graph Editor; graph picks
// select it in the Outline and the visible text editor, never taking focus.
const SELECTION_SYNC_DEBOUNCE_MS = 150;
// A selection we set ourselves is ignored when its echo arrives this soon.
const HOST_SELECTION_ECHO_MS = 1000;

function selectionKey(sel) {
    return sel.start.line + ':' + sel.start.character + '-' + sel.end.line + ':' + sel.end.character;
}

function registerSelectionSync(context, outline) {
    const enabled = () => getSetting('syncSelection') !== false;
    // uri -> last path the graph was sent or reported (dedupes cursor moves
    // inside one element); uri -> { key, at } of the host's own selection.
    const lastPath = new Map();
    const hostSelections = new Map();
    let timer = null;

    const postPath = (document, nodePath, force) => {
        if (nodePath == null || document.isClosed) return;
        const key = document.uri.toString();
        if (!getPanelForUri(key)) return;
        if (!force && lastPath.get(key) === nodePath) return;
        const target = outlineModel.graphTargetForPath(outlineModel.buildOutlineTree(document.getText()), nodePath);
        if (!target) return;
        if (postToDocumentPanel(key, { type: 'mtlx-select', path: nodePath, scope: target.scope, id: target.id })) {
            lastPath.set(key, nodePath);
        }
    };

    const onGraphSelection = ({ uri, path: nodePath }) => {
        const key = uri.toString();
        lastPath.set(key, nodePath);
        if (!enabled() || !nodePath) return;
        const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
        if (!document) return;
        const r = outlineModel.rangeForPath(outlineModel.buildOutlineTree(document.getText()), nodePath);
        if (!r) return; // unknown path (e.g. a library graph): ignored
        const active = activeMtlxDocument();
        if (active && active.uri.toString() === key) outline.revealPath(nodePath);
        const range = new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character);
        const sel = new vscode.Selection(range.start, range.end);
        for (const editor of vscode.window.visibleTextEditors) {
            if (editor.document.uri.toString() !== key) continue;
            hostSelections.set(key, { key: selectionKey(sel), at: Date.now() });
            editor.selection = sel;
            editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        }
    };

    context.subscriptions.push(
        onDidSelectInGraph(onGraphSelection),
        vscode.window.onDidChangeTextEditorSelection((e) => {
            if (!enabled()) return;
            const document = e.textEditor.document;
            if (document.languageId !== 'mtlx' || !e.selections[0]) return;
            const key = document.uri.toString();
            if (!getPanelForUri(key)) return;
            const mark = hostSelections.get(key);
            if (mark && Date.now() - mark.at < HOST_SELECTION_ECHO_MS && mark.key === selectionKey(e.selections[0])) return;
            const pos = e.selections[0].active;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                if (document.isClosed) return;
                postPath(document, outlineModel.syncPathAt(document.getText(), { line: pos.line, character: pos.character }), false);
            }, SELECTION_SYNC_DEBOUNCE_MS);
        }),
        outline.onDidSelectPath(({ path: nodePath, document }) => {
            if (enabled() && document) postPath(document, nodePath, true);
        }),
        { dispose: () => { if (timer) clearTimeout(timer); } }
    );
}

// materialxPlayground.autoOpenPlayground bookkeeping (see maybeAutoOpen() in
// activate()): which .mtlx files have already had the playground
// auto-opened for them this extension-host session, keyed by
// uri.toString(). Module scope (not activate()-local) because
// vscode.workspace.onDidCloseTextDocument's re-arm handler and
// vscode.window.onDidChangeActiveTextEditor's trigger handler both need
// to see the same Set across the whole session, exactly like
// diagnosticCollection/statusBarItem above.
const autoOpenedUris = new Set();

// materialxPlayground.autoOpenSceneViewer bookkeeping (see
// maybeAutoOpenSceneText()/maybeAutoOpenSceneTab() in activate()): same
// per-open (not per-focus) semantics as autoOpenedUris above, keyed by
// uri.toString(), but for USD scene files. A separate Set because a scene
// file and a .mtlx file are never the same uri, but the two features are
// independent and shouldn't share re-arm timing.
const autoOpenedSceneUris = new Set();

// validator.js's return shape ({ message, startLine, startChar, endLine,
// endChar, severity: 'error' }) is plain objects, not vscode.Diagnostic
// instances, validator.js/mtlxNode.js must stay independently loadable
// with plain `node` (no require('vscode')), so this conversion happens
// at the extension.js boundary instead.
function toVsDiagnostics(items) {
    return items.map((it) => new vscode.Diagnostic(
        new vscode.Range(it.startLine, it.startChar, it.endLine, it.endChar),
        it.message,
        it.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error
    ));
}

// Reads the currently active editor itself (no args), called after
// every diagnosticCollection update and on active-editor changes, so the
// status bar always reflects whichever .mtlx tab (if any) is focused.
function updateStatusBar() {
    const document = activeMtlxDocument();
    if (!document) {
        statusBarItem.hide();
        return;
    }
    const diags = diagnosticCollection.get(document.uri) || [];
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

// Set once the first validationClient 'failed' result is logged, so a
// dead/degraded worker doesn't spam the output channel on every
// keystroke, mirrors mtlxNode.js's own one-shot init-error reporting.
let loggedClientFailure = false;

// Runs tier 1 + (when clean) tier 2 validation off-thread via
// validationClient, never throws. Captures the document's version so a
// superseded, closed, or edited-meanwhile result gets dropped instead.
async function runValidation(document) {
    if (document.languageId !== 'mtlx') return;
    const version = document.version;
    const text = document.getText();

    let items = [];
    try {
        const result = await validationClient.validate(document.uri.toString(), text);
        if (result.status === 'superseded') return;
        if (document.isClosed || document.version !== version) return;

        if (result.status === 'ok') {
            items = result.items || [];
            if (result.tier2Warning) {
                logLine(getSharedOutputChannel(), 'MaterialX semantic validation (tier 2) is unavailable: ' + result.tier2Warning, 'warning', path.basename(document.fileName));
            }
        } else {
            if (!loggedClientFailure) {
                loggedClientFailure = true;
                logLine(getSharedOutputChannel(), 'MaterialX validation worker unavailable (' + result.reason + '); falling back to tier 1 only.', 'warning', path.basename(document.fileName));
            }
            // A 4 MB+ tier-1 scan on the host thread defeats the point
            // of the worker existing at all, so skip it too.
            items = text.length > 4 * 1024 * 1024 ? [] : validator.scanXml(text);
        }
    } catch (e) {
        items = []; // never let a validator bug break the editor
    }
    diagnosticCollection.set(document.uri, toVsDiagnostics(items));
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
// `(<name>:<type>,...)`, exactly the grammar vscode_extension/src/
// nodeSignature.js's buildSigToken emits (see that file's own comment on
// why every token it can produce is guaranteed to match this), and the
// same grammar js/docs/doc-links.jsx's parseSigHint expects on the other
// end. Validated here (plus a length cap) before ever being spliced into
// a URI, a command: link's JSON-encoded args are effectively untrusted
// input by the time they reach a command handler (built from hover
// markdown over a possibly hand-edited/untrusted .mtlx document).
const SIG_TOKEN_RE = /^[\w.\-:]+(\([\w.\-:]+:[\w.\-:]+(,[\w.\-:]+:[\w.\-:]+)*\))?$/;

// Pure guards for materialxPlayground.autoOpenPlayground/autoOpenSceneViewer:
// "is this document a fresh candidate", i.e. the exact same checks
// maybeAutoOpen/maybeAutoOpenSceneText run per editor-change, factored out
// here so they're a SINGLE rule shared with the workspace-trust rescan
// (rescanAutoOpenAfterTrust in activate(), which checks every open
// document rather than just the active editor) and independently coverable
// by a plain Node unit test, a real vscode.TextEditor/TextDocument can't
// be constructed outside a live host, but `doc` here only needs the same
// shape (`uri.scheme`, `uri.toString()`, `languageId`).
function isMtlxAutoOpenTarget(doc, alreadyOpenedUris) {
    return !!doc && !!doc.uri && doc.uri.scheme === 'file' && doc.languageId === 'mtlx'
        && !alreadyOpenedUris.has(doc.uri.toString());
}
function isSceneAutoOpenTarget(doc, alreadyOpenedSceneUris, isSceneUri) {
    return !!doc && !!doc.uri && doc.uri.scheme === 'file' && isSceneUri(doc.uri)
        && !alreadyOpenedSceneUris.has(doc.uri.toString());
}

// rescanAutoOpenAfterTrust companion: identifies the built-in Workspace
// Trust editor tab (the one the user just clicked "Trust" in). It has no
// vscode.TabInput at all (unlike every other editor kind this extension
// deals with), so it's told apart by that plus its fixed label.
function isWorkspaceTrustEditorTab(tab) {
    return !!tab && !tab.input && tab.label === 'Workspace Trust';
}

function activate(context) {
    // Before anything else, so semantic (tier 2) validation is ready as
    // soon as the first .mtlx document is opened. Runs in its own
    // worker_threads Worker (validationWorker.js), never on this thread.
    validationClient = new ValidationClient({
        repoRoot: context.extensionUri.fsPath,
        workerPath: path.join(__dirname, 'validationWorker.js'),
    });
    context.subscriptions.push({ dispose: () => validationClient.dispose() });
    context.subscriptions.push(new vscode.Disposable(disposeSharedOutputChannel));

    diagnosticCollection = vscode.languages.createDiagnosticCollection('materialx');
    context.subscriptions.push(diagnosticCollection);

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    statusBarItem.command = 'workbench.actions.view.problems';
    context.subscriptions.push(statusBarItem);

    // Hover documentation for node categories (hoverProvider.js), pushes
    // its own disposable onto context.subscriptions.
    hoverProvider.register(context);

    // Outline/breadcrumbs, go to definition, find references and color
    // swatches (symbolProviders.js), pushes its own disposables onto
    // context.subscriptions.
    symbolProviders.register(context);

    // Auto-complete for node categories, structural elements, node inputs
    // and reference-attribute values (completionProvider.js), pushes its
    // own disposable onto context.subscriptions.
    completionProvider.register(context);

    // materialxPlayground.newFromExample: copies a curated example .mtlx
    // (plus textures) into the workspace and opens it (newFromExample.js),
    // pushes its own disposable onto context.subscriptions.
    newFromExample.register(context);

    // materialxPlayground.newDocument: opens an untitled .mtlx document
    // seeded with the mtlxdoc snippet skeleton (newDocument.js).
    newDocument.register(context);

    // USD Scene Viewer custom editor for .usd/.usda/.usdc/.usdz plus the
    // materialxPlayground.openScene command (sceneProvider.js).
    sceneProvider.register(context);

    context.subscriptions.push(activeMtlxDocumentEmitter);

    // materialxPlayground.outline (activity bar container): tracks
    // whichever document activeMtlxDocument() currently reports, see that
    // function's own comment (outlineView.js).
    const outline = outlineView.register(context, {
        getActiveDocument: activeMtlxDocument,
        onDidChangeActiveDocument: onDidChangeActiveMtlxDocument,
    });
    registerSelectionSync(context, outline);

    // materialxPlayground.actions (activity bar container): a webview view
    // of action buttons (actionsView.js/actionsModel.js), the "Open in
    // ..." rows tracking activeMtlxDocument().
    actionsView.register(context, {
        getActiveDocument: activeMtlxDocument,
        onDidChangeActiveDocument: onDidChangeActiveMtlxDocument,
    });

    // exampleGallery.js needs the extension context for its test API only
    // (a real user session reaches it through newFromExample.js's own
    // command handler, which has its own context already).
    exampleGallery.register(context);

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
        const doc = activeMtlxDocument();
        return doc ? doc.uri : null;
    };

    // 'splitRight' placement for openInPlayground below (materialxPlayground.
    // openBehavior, package.json contributes.configuration), figures out
    // WHERE to open the given custom editor (`viewType`) so it lands
    // beside a text editor already open on the same file, then issues the
    // `vscode.openWith` call itself. Returns true if it did so (placement
    // handled, the caller must not also do its own plain open), false if
    // there was nothing to split against or anything about the tab-group
    // scan failed, in which case the caller falls back to opening in the
    // active group. Never throws. Shared by openInPlayground (viewType
    // 'materialxPlayground.editor') and maybeAutoOpenSceneText below
    // (viewType sceneProvider.VIEW_TYPE): one placement algorithm, not
    // duplicated per editor.
    //
    // vscode.window.tabGroups.all exposes every editor group with a
    // numeric `viewColumn` and each tab's `input`, which is
    // `vscode.TabInputText` (has `.uri`) for a plain text tab, or
    // `vscode.TabInputCustom` (has both `.uri` and `.viewType`) for an
    // already-open custom editor tab like ours.
    const openBesideTextEditor = async (uri, preserveFocus, viewType) => {
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
                        && input.viewType === viewType
                        && input.uri.toString() === uriStr
                    ) {
                        existingPlaygroundColumn = group.viewColumn;
                    }
                }
            }

            // A playground tab for this exact file is already open
            // somewhere, reveal it (openWith to the same resource +
            // viewType reveals the existing tab rather than duplicating
            // it) instead of splitting open a second copy elsewhere.
            if (existingPlaygroundColumn !== null) {
                await vscode.commands.executeCommand(
                    'vscode.openWith', uri, viewType,
                    { viewColumn: existingPlaygroundColumn, preserveFocus }
                );
                return true;
            }

            // No open text editor for this file to split against at all
            // (e.g. an Explorer right-click on a file nothing has opened
            // yet), nothing for 'splitRight' to do here.
            if (textGroupColumn === null) return false;

            const targetColumn = textGroupColumn + 1;
            const rightGroupExists = vscode.window.tabGroups.all.some((g) => g.viewColumn === targetColumn);

            if (rightGroupExists) {
                // Reuse the existing right-hand group instead of splitting
                // again, this is the whole point of 'splitRight': repeat
                // opens land in the SAME group beside the text editor
                // rather than each one creating a fresh split.
                // vscode.ViewColumn.Beside would NOT give us this: it
                // creates a brand-new group whenever the currently ACTIVE
                // group happens to be the rightmost one
                // (https://github.com/microsoft/vscode/issues/133260), so
                // an explicit, already-known viewColumn is what makes the
                // reuse deterministic here.
                await vscode.commands.executeCommand(
                    'vscode.openWith', uri, viewType,
                    { viewColumn: targetColumn, preserveFocus }
                );
                return true;
            }

            // No group to the right exists yet. vscode.ViewColumn.Beside
            // always splits relative to whichever group is currently
            // ACTIVE, not relative to textGroupColumn, and there is no
            // API to say "create a new group at column N" directly. So:
            // make the text editor's group the active one first (showing
            // the document that's already open there is cheap, it does
            // not reload anything), THEN ask for Beside, which now
            // deterministically splits to the right of it.
            const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriStr)
                || await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc, { viewColumn: textGroupColumn, preserveFocus: false });
            await vscode.commands.executeCommand(
                'vscode.openWith', uri, viewType,
                { viewColumn: vscode.ViewColumn.Beside, preserveFocus }
            );
            return true;
        } catch (err) {
            // Placement is a nice-to-have, never let it break opening the
            // playground at all. The caller falls back to its own plain
            // open in the active group.
            return false;
        }
    };

    // `options.preserveFocus`, when set, is threaded down to whichever
    // `vscode.openWith` call actually runs, used by maybeAutoOpen()
    // below so an auto-opened playground doesn't steal keyboard focus
    // from the text editor the user is actively typing in.
    const openInPlayground = async (uriArg, { preserveFocus } = {}) => {
        try {
            const uri = resolveTargetUri(uriArg);
            if (!uri) {
                vscode.window.showErrorMessage('MaterialX Playground: no .mtlx file to open (no active editor and no file selected).');
                return;
            }

            const openBehavior = getSetting('openBehavior');
            if (openBehavior === 'splitRight') {
                const placed = await openBesideTextEditor(uri, preserveFocus, 'materialxPlayground.editor');
                if (placed) return;
                // Nothing to split against (or the scan itself failed):
                // fall through to the plain open below. Opening SOMEWHERE
                // beats not opening at all.
            }

            // 'sameGroup', or a 'splitRight' fallback: today's plain open
            // in the active group. `{ preserveFocus }` is only passed when
            // the caller actually set it, so a bare `openInPlayground(uri)`
            // call, every pre-existing call site, stays byte-identical
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

    // materialxPlayground.openInGraphEditor / openInMaterialViewer: open
    // (or reuse) the playground for a .mtlx file and show a SPECIFIC view,
    // regardless of the materialxPlayground.defaultView setting.
    //   - A playground tab for this file is already open somewhere
    //     (editorProvider.js's panelsByUri, populated by every resolved
    //     custom-editor panel): reveal it and ask its webview to switch
    //     view directly (mtlx-switch-view, handled by
    //     media/bootstrap.js): one tab, no duplicate.
    //   - Otherwise: record the requested view as this file's one-shot
    //     initial-view override (editorProvider.js's
    //     setPendingInitialView, consumed once by resolveCustomTextEditor)
    //     and open it through the normal placement path (openInPlayground,
    //     same openBehavior/splitRight rules as materialxPlayground.open).
    const openInPlaygroundView = async (uriArg, hash) => {
        try {
            const uri = resolveTargetUri(uriArg);
            if (!uri) {
                vscode.window.showErrorMessage('MaterialX Playground: no .mtlx file to open (no active editor and no file selected).');
                return;
            }
            const uriStr = uri.toString();
            const existingPanel = getPanelForUri(uriStr);
            if (existingPanel) {
                existingPanel.reveal(existingPanel.viewColumn, false);
                existingPanel.webview.postMessage({ type: 'mtlx-switch-view', hash });
                return;
            }
            setPendingInitialView(uriStr, hash);
            await openInPlayground(uri);
        } catch (err) {
            vscode.window.showErrorMessage('MaterialX Playground: failed to open - ' + errMsg(err));
        }
    };

    // materialxPlayground.autoOpenPlayground companion: the first time a .mtlx file
    // becomes the active text editor (and on every subsequent FIRST time
    // after the file is closed and reopened, see the re-arm comment on
    // the onDidCloseTextDocument listener below), automatically open the
    // playground beside it. preserveFocus: true is load-bearing here:
    // the whole point is a side panel that appears without stealing
    // keystrokes out from under whatever the user is actively typing.
    const maybeAutoOpen = (editor) => {
        // Restricted Mode keeps the extension enabled, but must not
        // auto-open a webview that runs scripts against an untrusted
        // folder's files.
        if (!vscode.workspace.isTrusted) return;
        if (!getSetting('autoOpenPlayground')) return;
        const doc = editor && editor.document;
        if (!isMtlxAutoOpenTarget(doc, autoOpenedUris)) return;
        autoOpenedUris.add(doc.uri.toString());
        openInPlayground(doc.uri, { preserveFocus: true });
    };

    // materialxPlayground.autoOpenSceneViewer companion, TEXT half: a USD
    // scene file that VS Code opens as a genuine text editor (.usda, or a
    // .usd that happens to be ASCII) fires onDidChangeActiveTextEditor
    // exactly like a .mtlx file does, so this mirrors maybeAutoOpen above:
    // same guards, same 'splitRight'/'sameGroup' placement via
    // openBesideTextEditor, same preserveFocus: true so the auto-opened
    // viewer never steals keystrokes from the text editor. The BINARY half
    // (a .usdc/.usdz, or a .usd VS Code can't decode as text) never
    // produces a TextEditor at all, that path is maybeAutoOpenSceneTab
    // below, driven by tabGroups.onDidChangeTabs instead.
    const maybeAutoOpenSceneText = (editor) => {
        if (!vscode.workspace.isTrusted) return;
        if (!getSetting('autoOpenSceneViewer')) return;
        const doc = editor && editor.document;
        if (!isSceneAutoOpenTarget(doc, autoOpenedSceneUris, sceneProvider.isSceneUri)) return;
        autoOpenedSceneUris.add(doc.uri.toString());
        openBesideTextEditor(doc.uri, true, sceneProvider.VIEW_TYPE);
    };

    // materialxPlayground.autoOpenSceneViewer companion, BINARY half: a
    // binary scene file (by extension, a .usd by its first bytes) shows a
    // placeholder tab, which gets REPLACED in place by the scene viewer.
    // Text files are never replaced: an Explorer or Quick Open tab event
    // fires before its TextDocument is registered, so that is no signal.
    const maybeAutoOpenSceneTab = (tab) => {
        if (!vscode.workspace.isTrusted) return;
        if (!getSetting('autoOpenSceneViewer')) return;
        const input = tab && tab.input;
        if (!input || !(input.uri instanceof vscode.Uri)) return;
        const uri = input.uri;
        if (uri.scheme !== 'file') return;
        if (!sceneProvider.isSceneUri(uri)) return;
        // Already the scene viewer, or some other custom editor entirely,
        // either way, not ours to touch.
        if (input instanceof vscode.TabInputCustom) return;
        const uriStr = uri.toString();
        if (autoOpenedSceneUris.has(uriStr)) return;
        (async () => {
            try {
                let head = null;
                if (path.extname(uri.path).toLowerCase() === '.usd') {
                    try { head = await docScanner.defaultDeps().readHead(uri, 8); } catch (e) { head = null; }
                }
                // Text scene files are the TEXT half's job (maybeAutoOpenSceneText).
                if (usdFileSet.sceneFileKind(uri.path, head) !== 'binary') return;
                if (vscode.workspace.textDocuments.some((d) => d.uri.toString() === uriStr)) return;
                if (autoOpenedSceneUris.has(uriStr)) return;
                autoOpenedSceneUris.add(uriStr);
                const viewColumn = tab.group ? tab.group.viewColumn : undefined;
                await vscode.commands.executeCommand(
                    'vscode.openWith', uri, sceneProvider.VIEW_TYPE,
                    viewColumn !== undefined ? { viewColumn } : undefined
                );
                await vscode.window.tabGroups.close(tab);
            } catch (err) {
                // Best effort, never let auto-open break the file actually
                // opening in whatever editor VS Code picked for it.
            }
        })();
    };

    // onDidGrantWorkspaceTrust companion: trust is granted while the
    // Workspace Trust editor itself has focus, so vscode.window.
    // activeTextEditor is undefined at that moment, passing just that
    // (the old behavior) meant nothing opened until the user clicked back
    // to their .mtlx/scene tab. Rescan every OPEN text document (not only
    // the visible ones, a background tab in the same group the Trust
    // editor just occupied is still open) for the mtlx/scene-text cases,
    // plus every tab across every group for the binary scene case, same
    // shape as the startup rescan below (~636). isMtlxAutoOpenTarget/
    // isSceneAutoOpenTarget (and maybeAutoOpenSceneTab's own uri check)
    // already guard autoOpenedUris/autoOpenedSceneUris, so re-running this
    // over documents/tabs already auto-opened is a no-op, never a duplicate.
    // Closes the Workspace Trust editor tab first: it's still open (and
    // still holds the group's "active" slot) at this exact moment, so the
    // splitRight column math below (openBesideTextEditor, which splits
    // beside whichever group holds the text tab) would otherwise land the
    // playground as a SECOND tab in the Trust editor's own group instead
    // of beside the text, closing it makes this rescan see exactly the
    // same tab layout a normal (non-trust) auto-open would.
    const rescanAutoOpenAfterTrust = async () => {
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                if (isWorkspaceTrustEditorTab(tab)) await vscode.window.tabGroups.close(tab);
            }
        }
        for (const doc of vscode.workspace.textDocuments) {
            const editor = { document: doc };
            maybeAutoOpen(editor);
            maybeAutoOpenSceneText(editor);
        }
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) maybeAutoOpenSceneTab(tab);
        }
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('materialxPlayground.open', (uriArg) => openInPlayground(uriArg)),
        // The two explicit, always-visible commands (Command Palette,
        // Explorer context, editor tab context, see package.json's
        // menus): materialxPlayground.open stays registered (the toolbar
        // button and auto-open still bind to it, and existing user
        // keybindings to it keep working) but is hidden from those menus
        // in favor of these two. See openInPlaygroundView above.
        vscode.commands.registerCommand('materialxPlayground.openInGraphEditor', (uriArg) => openInPlaygroundView(uriArg, '#!graph')),
        vscode.commands.registerCommand('materialxPlayground.openInMaterialViewer', (uriArg) => openInPlaygroundView(uriArg, '#!viewer')),
        // Bound to the Ctrl+S/Cmd+S keybinding contributed in package.json
        // (when: activeCustomEditorId == 'materialxPlayground.editor'):
        // see editorProvider.js's saveActiveGraph() and the comment on
        // activePanelInfo there for why this is the robust path (a
        // webview's in-iframe keydown listener alone isn't a reliable
        // Ctrl+S responder against VS Code's own keybinding service).
        vscode.commands.registerCommand('materialxPlayground.saveGraph', () => saveActiveGraph()),
        // Bound to the Ctrl+Z/Cmd+Z and Ctrl+Shift+Z/Cmd+Shift+Z/Ctrl+Y
        // keybindings contributed in package.json (same `when` clause as
        // saveGraph above), these SHADOW VS Code's built-in text-document
        // undo/redo while our editor is active, so Ctrl+Z routes to the
        // graph's own in-page undo/redo instead of reverting the .mtlx
        // file underneath the live graph session. See
        // editorProvider.js's undoActiveGraph()/redoActiveGraph().
        vscode.commands.registerCommand('materialxPlayground.undoGraph', () => undoActiveGraph()),
        vscode.commands.registerCommand('materialxPlayground.redoGraph', () => redoActiveGraph()),
        // `category` is optional: no-arg (Command Palette / explorer menu)
        // opens the docs library browser exactly as before ('#!docs').
        // Passed a category string, from hoverProvider.js's "Open
        // Interactive Documentation" command link on a node hover, e.g.
        // command:materialxPlayground.openDocs?["standard_surface"], it
        // instead deep-links straight to that node, using the SAME
        // name-only permalink hash format the website's own hashToSel
        // (js/docs/doc-links.jsx) resolves by search (exact match, then
        // squashed-lowercase fallback), so an arbitrary category string
        // always lands somewhere sensible even without knowing its
        // lib/group. `sig` is a further-optional signature-token second
        // argument (also from hoverProvider.js, when the hovered
        // element's own signature was derivable) that additionally
        // pre-selects the matching signature/version once the node
        // resolves, see js/docs/doc-links.jsx's parseSigHint and
        // js/docs-app.jsx's matchSigHintToGroups. Both args are
        // backward compatible: no-arg and category-only calls (existing
        // callers, older cached command URIs) behave exactly as before.
        vscode.commands.registerCommand('materialxPlayground.openDocs', async (category, sig) => {
            try {
                // Context-menu invocations (the Explorer / editor tab
                // title entries contributed for this command) pass the
                // target vscode.Uri as the FIRST argument, same calling
                // convention as materialxPlayground.open's uriArg, but
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
                // This docs-panel singleton backs only this command
                // (Command Palette, explorer/editor context menus, and
                // hover deep links), no document payload ever sent (the
                // docs view browses the node library on its own, same as
                // visiting index.html#!docs directly in a browser).
                // Repeated invocations reveal and re-navigate the existing
                // panel instead of spawning a new one.
                const sigOk = typeof sig === 'string' && sig.length <= 512 && SIG_TOKEN_RE.test(sig);
                const hash = category
                    ? '#/' + encodeURIComponent(String(category)) + (sigOk ? '?sig=' + encodeURIComponent(sig) : '')
                    : '#!docs';
                await openDocsPanel(context, hash, vscode.ViewColumn.Active);
                // W1: opened from a .mtlx context (hover link, explorer, or
                // just the active editor) -- send the current filter right
                // away instead of waiting for the next document-change event.
                updateDocsFilter(activeMtlxDocument(), true);
            } catch (err) {
                vscode.window.showErrorMessage('MaterialX Playground: failed to open node documentation — ' + errMsg(err));
            }
        }),
        // W1: manual override for the docs panel's file-based filter, which
        // otherwise tracks the active .mtlx document automatically (see the
        // design note on updateDocsFilter above). Toggling this off clears
        // the filter and stops the automatic tracking until toggled back on
        // -- useful when the auto-applied filter (shown as a dismissable
        // chip in the sidebar) is in the way and the file/document keeps
        // changing under the user.
        vscode.commands.registerCommand('materialxPlayground.filterDocsByFile', () => {
            docsFilterAutoEnabled = !docsFilterAutoEnabled;
            if (!isDocsPanelOpen()) {
                vscode.window.showInformationMessage('MaterialX Playground: open Node Documentation first to filter it by the current file.');
                return;
            }
            if (docsFilterAutoEnabled) updateDocsFilter(activeMtlxDocument(), true);
            else postDocsFilter(null, null);
        }),
        // materialxPlayground.pickFile (E10b): hidden from the Command
        // Palette (package.json), invoked only by the "Browse for
        // file..." completion item (completionProvider.js) with
        // (documentUriString, start, end), start/end being the plain
        // {line, character} range of the filename= value text to replace.
        // showOpenDialog defaults into the document's own folder (an
        // untitled document has none, so no defaultUri); the picked path
        // is written back relative to that folder in POSIX form
        // (filePicker.js), or as an absolute POSIX path for an untitled
        // document.
        vscode.commands.registerCommand('materialxPlayground.pickFile', async (uriString, start, end) => {
            try {
                const docUri = vscode.Uri.parse(uriString);
                const document = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uriString);
                if (!document) return;

                const defaultUri = docUri.scheme === 'untitled' ? undefined : vscode.Uri.joinPath(docUri, '..');
                const picked = await vscode.window.showOpenDialog({
                    canSelectMany: false,
                    defaultUri,
                    filters: {
                        Images: ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'exr', 'hdr', 'ktx2'],
                        'All Files': ['*'],
                    },
                    title: 'MaterialX Playground: choose a texture file',
                });
                if (!picked || !picked.length) return;

                const value = filePicker.computeFilePathValue(
                    { scheme: docUri.scheme, fsPath: docUri.fsPath },
                    picked[0].fsPath
                );
                const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uriString)
                    || await vscode.window.showTextDocument(document, { preserveFocus: true });
                const range = new vscode.Range(start.line, start.character, end.line, end.character);
                await editor.edit((builder) => builder.replace(range, value));
            } catch (err) {
                vscode.window.showErrorMessage('MaterialX Playground: failed to browse for a file: ' + errMsg(err));
            }
        })
    );

    // materialxPlayground.autoOpenPlayground listeners (see maybeAutoOpen() above):
    // trigger on every active-editor change, and re-arm per file only once
    // that FILE is actually closed, not merely defocused by switching
    // tabs. This distinction is load-bearing: without it, tabbing away
    // from a .mtlx editor and back would look identical to "reopening the
    // file" and pop the playground back open even after the user
    // deliberately closed it, which would defeat the point of closing it
    // at all. Deleting the key only on onDidCloseTextDocument means the
    // auto-open is genuinely a per-"open" thing, not a per-"focus" thing.
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(maybeAutoOpen),
        vscode.workspace.onDidCloseTextDocument((doc) => autoOpenedUris.delete(doc.uri.toString())),
        // Trusting the folder mid-session should auto-open immediately for
        // whatever's already open, same as a fresh trusted window, not
        // wait for the next editor-focus change, see rescanAutoOpenAfterTrust
        // above (registered once here; it also covers the scene viewer's
        // own auto-open below, so that section doesn't register it again).
        vscode.workspace.onDidGrantWorkspaceTrust(rescanAutoOpenAfterTrust)
    );

    // materialxPlayground.autoOpenSceneViewer listeners: the TEXT half
    // rides onDidChangeActiveTextEditor (same event/re-arm shape as
    // maybeAutoOpen above), the BINARY half rides tabGroups.onDidChangeTabs
    // (newly opened tabs); see the two functions' own comments for why a
    // single event can't cover both. Re-arm for EITHER half happens when a
    // tab closes and no tab anywhere still references that scene file's
    // uri, since the text case leaves two tabs open (the text editor and
    // the auto-opened viewer beside it) while the binary case leaves only
    // one (the viewer, after replacing the placeholder): checking "any
    // tab left for this uri" covers both without needing to know which
    // case produced the closed tab.
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(maybeAutoOpenSceneText),
        // onDidGrantWorkspaceTrust is registered once, above, via
        // rescanAutoOpenAfterTrust, it covers both this and the
        // playground's own auto-open, so it isn't repeated here.
        vscode.window.tabGroups.onDidChangeTabs((e) => {
            for (const tab of e.opened) maybeAutoOpenSceneTab(tab);
            for (const tab of e.closed) {
                const input = tab.input;
                if (!input || !(input.uri instanceof vscode.Uri) || !sceneProvider.isSceneUri(input.uri)) continue;
                const uriStr = input.uri.toString();
                const stillOpen = vscode.window.tabGroups.all.some((g) =>
                    g.tabs.some((t) => t.input && t.input.uri && t.input.uri.toString() === uriStr));
                if (!stillOpen) autoOpenedSceneUris.delete(uriStr);
            }
        })
    );

    // Live .mtlx diagnostics: validate anything already open, then keep
    // validating on open/edit/close, and keep the status bar in sync
    // with whichever editor is active.
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId === 'mtlx') runValidation(doc);
    }
    fireActiveMtlxDocumentChangeIfNeeded();
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
            // W1: only the ACTIVE document's edits move the docs filter --
            // an edit in a background tab shouldn't change what's showing.
            const active = activeMtlxDocument();
            if (active && active.uri.toString() === key) updateDocsFilter(active, false);
        }),
        vscode.workspace.onDidCloseTextDocument((doc) => {
            const key = doc.uri.toString();
            const existing = debounceTimers.get(key);
            if (existing) { clearTimeout(existing); debounceTimers.delete(key); }
            diagnosticCollection.delete(doc.uri);
            updateStatusBar();
        }),
        vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar()),
        // activeMtlxDocument() (E16b/E17) additionally depends on which
        // custom-editor TAB is active, not just the active text editor, so
        // it's re-checked on every tab-group change too, not only on
        // onDidChangeActiveTextEditor above.
        onDidChangeActiveMtlxDocument(() => updateStatusBar()),
        vscode.window.onDidChangeActiveTextEditor(fireActiveMtlxDocumentChangeIfNeeded),
        vscode.window.tabGroups.onDidChangeTabs(fireActiveMtlxDocumentChangeIfNeeded),
        vscode.window.tabGroups.onDidChangeTabGroups(fireActiveMtlxDocumentChangeIfNeeded)
    );

    // activate() is triggered by the implicit onLanguage:mtlx activation
    // event (from contributes.languages, VS Code >=1.74), so a .mtlx
    // file can already be active before onDidChangeActiveTextEditor fires.
    maybeAutoOpen(vscode.window.activeTextEditor);

    // Same idea for materialxPlayground.autoOpenSceneViewer: the active
    // editor covers the TEXT half (onLanguage-style activation can already
    // have a .usda active before the change event fires), and a scan of
    // every already-open tab covers the BINARY half, since a placeholder
    // tab that was open before activation never fires onDidChangeTabs.
    maybeAutoOpenSceneText(vscode.window.activeTextEditor);
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) maybeAutoOpenSceneTab(tab);
    }

    // testApi is non-null only when MTLX_TEST_TRANSPORT=1 was set in the
    // extension host's own environment before activation, never true for
    // a real user session. Exposes the direct-texture-read transport's
    // test hooks to the stress-test harness driving this Extension
    // Development Host, plus (when present) exampleGallery.js's own test
    // hooks under `.gallery`; undefined otherwise, same as before.
    const merged = Object.assign({}, testApi || {});
    if (exampleGallery.testApi) merged.gallery = exampleGallery.testApi;
    if (actionsView.testApi) merged.actions = actionsView.testApi;
    return Object.keys(merged).length ? { _test: merged } : undefined;
}

function deactivate() {
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
    if (docsFilterDebounce) clearTimeout(docsFilterDebounce);
    autoOpenedUris.clear();
    autoOpenedSceneUris.clear();
    return validationClient ? validationClient.dispose() : undefined;
}

module.exports = { activate, deactivate };
