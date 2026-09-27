// insertNodeView.js: WebviewViewProvider for the materialxPlayground.
// insertNode view (activity bar container). Search + output-type filter
// over mtlxCompletions.js's node library index; clicking/Enter on a row
// inserts the same snippet the element completion uses
// (buildNodeElementSnippet) at the cursor of the active MaterialX TEXT
// editor, via editor.insertSnippet. UI glue over insertNodeModel.js's pure
// helpers, same split as actionsView.js/actionsModel.js.
'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const mtlxCompletions = require('./mtlxCompletions');
const insertNodeModel = require('./insertNodeModel');

const MESSAGE_TYPES = new Set(['ready', 'insert']);
const NOTE_TEXT = 'Open a .mtlx file in the text editor to insert nodes.';

// Same test-only gate as actionsView.js/filesView.js.
const TEST_TRANSPORT = process.env.MTLX_TEST_TRANSPORT === '1';
let activeProvider = null;

function getNonce() {
    return crypto.randomBytes(16).toString('base64');
}

class MtlxInsertNodeProvider {
    constructor(context) {
        this._context = context;
        this._view = null;
        this._lastMtlxUri = null;
    }

    // Prefers the truly-focused text editor; falls back to the last known
    // MaterialX text editor if it's still visible (clicking into this
    // webview defocuses the text editor without closing it).
    _resolveEditor() {
        const active = vscode.window.activeTextEditor;
        if (active && active.document.languageId === 'mtlx') return active;
        if (this._lastMtlxUri) {
            const found = vscode.window.visibleTextEditors.find(
                (e) => e.document.languageId === 'mtlx' && e.document.uri.toString() === this._lastMtlxUri
            );
            if (found) return found;
        }
        return null;
    }

    noteEditorChange(editor) {
        if (editor && editor.document.languageId === 'mtlx') this._lastMtlxUri = editor.document.uri.toString();
        this._postState();
    }

    _postState() {
        if (!this._view) return;
        const hasEditor = !!this._resolveEditor();
        let rows = [];
        let outputTypes = [];
        try {
            const index = mtlxCompletions.getLibraryIndex(this._context.extensionUri.fsPath);
            rows = insertNodeModel.allCategoryRows(index);
            outputTypes = insertNodeModel.outputTypesInIndex(index);
        } catch (e) {
            // js/gen/nodelib.json not built yet: an empty list, not a crash.
        }
        this._view.webview.postMessage({
            type: 'state', hasEditor, rows, outputTypes,
            note: hasEditor ? null : NOTE_TEXT,
        });
    }

    async resolveWebviewView(webviewView) {
        this._view = webviewView;
        const webview = webviewView.webview;
        const mediaRoot = vscode.Uri.joinPath(this._context.extensionUri, 'vscode_extension', 'media');
        webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };

        const nonce = getNonce();
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'insert-node.js')).toString();
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'insert-node.css')).toString();

        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(mediaRoot, 'insert-node.html'));
        let html = Buffer.from(bytes).toString('utf8');
        html = html.split('${cspSource}').join(webview.cspSource);
        html = html.split('${nonce}').join(nonce);
        html = html.split('${scriptUri}').join(scriptUri);
        html = html.split('${styleUri}').join(styleUri);
        webview.html = html;

        webview.onDidReceiveMessage((msg) => this._handleMessage(msg));
    }

    async _handleMessage(msg) {
        if (!msg || typeof msg !== 'object' || !MESSAGE_TYPES.has(msg.type)) return;
        if (msg.type === 'ready') { this._postState(); return; }
        if (msg.type === 'insert') { await this._insert(msg.category, msg.outputType); return; }
    }

    async _insert(category, outputType) {
        if (typeof category !== 'string') return;
        const editor = this._resolveEditor();
        if (!editor) return;

        let index;
        try {
            index = mtlxCompletions.getLibraryIndex(this._context.extensionUri.fsPath);
        } catch (e) {
            return;
        }
        const entry = index.categories.get(category);
        if (!entry) return; // never trust the message's category beyond the known set

        const document = editor.document;
        const text = document.getText();
        const offset = document.offsetAt(editor.selection.active);
        const existingNames = insertNodeModel.allNamesInText(text);
        const wantType = (typeof outputType === 'string' && entry.outputTypes.indexOf(outputType) !== -1) ? outputType : null;
        // buildNodeElementSnippet's text starts right after a '<' (its
        // completion caller already has one, typed by the user); this view
        // inserts a whole new element from scratch, so add it here.
        const body = '<' + mtlxCompletions.buildNodeElementSnippet(category, entry, existingNames, wantType);

        const plan = insertNodeModel.insertPlan(text, offset);
        const snippetText = plan.mode === 'cursor' ? body : (plan.prefix + plan.indent + body + plan.suffix);
        const pos = document.positionAt(plan.offset);
        await editor.insertSnippet(new vscode.SnippetString(snippetText), pos);
    }
}

function register(context) {
    const provider = new MtlxInsertNodeProvider(context);
    if (TEST_TRANSPORT) activeProvider = provider;
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('materialxPlayground.insertNode', provider),
        vscode.window.onDidChangeActiveTextEditor((e) => provider.noteEditorChange(e))
    );
    return provider;
}

// Test-only (MTLX_TEST_TRANSPORT=1): drives an insert through the exact
// same validated _insert() a real click would, no webview DOM needed.
let testApi = null;
if (TEST_TRANSPORT) {
    testApi = {
        async insert(category, outputType) {
            if (!activeProvider) throw new Error('the insert node view is not registered');
            await activeProvider._insert(category, outputType);
        },
        hasEditor() {
            return !!(activeProvider && activeProvider._resolveEditor());
        },
    };
}

module.exports = { register, MtlxInsertNodeProvider, testApi };
