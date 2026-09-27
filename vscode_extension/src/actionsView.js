// actionsView.js: WebviewViewProvider for the materialxPlayground.actions
// view (activity bar container). UI glue over actionsModel.js's pure row
// list, rendered as full-width icon buttons by media/actions-view.*
// (strict CSP, message validation below). Refreshes on
// onDidChangeActiveMtlxDocument so the two "Open in ..." rows track
// whether a MaterialX document is currently active.
'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const actionsModel = require('./actionsModel');

// Every command a row can ever carry, computed once from the model itself
// -- the webview can only ever trigger one of these, never an arbitrary
// string it sends us.
const KNOWN_COMMANDS = new Set(
    actionsModel.buildActionRows(true).map((r) => r.command).filter(Boolean)
);

function getNonce() {
    return crypto.randomBytes(16).toString('base64');
}

// Inert unless the packaged-extension smoke run sets this in the
// extension host's own environment, never true for a real user session --
// same gate exampleGallery.js/editorProvider.js use for their own test
// transports.
const TEST_TRANSPORT = process.env.MTLX_TEST_TRANSPORT === '1';
let activeProvider = null;

class MtlxActionsViewProvider {
    constructor(context) {
        this._context = context;
        this._hasActiveDocument = false;
        this._view = null;
    }

    setActiveDocument(document) {
        this._hasActiveDocument = !!document;
        this._postState();
    }

    _postState() {
        if (!this._view) return;
        this._view.webview.postMessage({
            type: 'state',
            rows: actionsModel.buildActionRows(this._hasActiveDocument),
        });
    }

    async resolveWebviewView(webviewView) {
        this._view = webviewView;
        const webview = webviewView.webview;
        const mediaRoot = vscode.Uri.joinPath(this._context.extensionUri, 'vscode_extension', 'media');
        webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };

        const nonce = getNonce();
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'actions-view.js')).toString();
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'actions-view.css')).toString();

        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(mediaRoot, 'actions-view.html'));
        let html = Buffer.from(bytes).toString('utf8');
        html = html.split('${cspSource}').join(webview.cspSource);
        html = html.split('${nonce}').join(nonce);
        html = html.split('${scriptUri}').join(scriptUri);
        html = html.split('${styleUri}').join(styleUri);
        webview.html = html;

        webview.onDidReceiveMessage((msg) => this._handleMessage(msg));
    }

    // Message validation: only a known row id maps to only that row's own
    // (already-vetted) command; a disabled row or an unrecognized id never
    // runs anything.
    _handleMessage(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ready') { this._postState(); return; }
        if (msg.type !== 'run' || typeof msg.id !== 'string') return;
        const row = actionsModel.buildActionRows(this._hasActiveDocument).find((r) => r.id === msg.id);
        if (!row || row.disabled || !row.command || !KNOWN_COMMANDS.has(row.command)) return;
        vscode.commands.executeCommand(row.command);
    }
}

// register(context, { getActiveDocument, onDidChangeActiveDocument }):
// same shape as outlineView.js's register, reused here for the action
// rows' active-document dependent rows.
function register(context, { getActiveDocument, onDidChangeActiveDocument }) {
    const provider = new MtlxActionsViewProvider(context);
    if (TEST_TRANSPORT) activeProvider = provider;

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('materialxPlayground.actions', provider),
        onDidChangeActiveDocument((doc) => provider.setActiveDocument(doc))
    );
    provider.setActiveDocument(getActiveDocument());

    return provider;
}

// Test-only instrumentation (MTLX_TEST_TRANSPORT=1 only): lets the
// packaged-extension smoke run confirm the webview view actually resolved
// (VS Code only calls resolveWebviewView once the sidebar view is
// revealed) and see the row ids it would have rendered.
const testApi = TEST_TRANSPORT ? {
    async focus() {
        await vscode.commands.executeCommand('materialxPlayground.actions.focus');
    },
    getState() {
        const rows = actionsModel.buildActionRows(activeProvider ? activeProvider._hasActiveDocument : false);
        return { resolved: !!(activeProvider && activeProvider._view), rowIds: rows.map((r) => r.id) };
    },
    // Bypasses the webview's own DOM, but goes through the exact same
    // validated _handleMessage() a real row click would.
    async triggerRow(id) {
        if (!activeProvider) throw new Error('the actions view is not resolved');
        activeProvider._handleMessage({ type: 'run', id: id });
    },
} : null;

module.exports = { register, MtlxActionsViewProvider, testApi };
