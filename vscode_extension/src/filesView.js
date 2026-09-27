// filesView.js: TreeDataProvider for the materialxPlayground.files view
// (activity bar container). Lists the active .mtlx document's own file
// references (textures and xi:includes), via docScanner.scan's structured
// `refs` array (see docScanner.js). Same "getActiveDocument/
// onDidChangeActiveDocument" wiring as outlineView.js, and the same
// debounced-rebuild-on-edit shape.
'use strict';

const vscode = require('vscode');
const docScanner = require('./docScanner');
const filePicker = require('./filePicker');
const { MTLX_TEXTURE_EXTS } = require('../../js/shared/texture-formats.js');

const DEBOUNCE_MS = 300;

// Same test-only gate as actionsView.js/exampleGallery.js: inert unless
// the packaged-extension smoke run sets this in the extension host's own
// environment.
const TEST_TRANSPORT = process.env.MTLX_TEST_TRANSPORT === '1';
let activeProvider = null;

class MtlxFilesProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this._document = null;
        this._refs = [];
        this._timer = null;
        this._scanSeq = 0;
    }

    setActiveDocument(document) {
        const next = document && document.languageId === 'mtlx' ? document : null;
        if (this._document && next && this._document.uri.toString() === next.uri.toString()) return;
        this._document = next;
        this._rebuild();
    }

    // Called on every workspace text-document change; a no-op unless the
    // edited document is the one currently backing this view.
    scheduleRefresh(document) {
        if (!this._document || document.uri.toString() !== this._document.uri.toString()) return;
        if (this._timer) clearTimeout(this._timer);
        this._timer = setTimeout(() => this._rebuild(), DEBOUNCE_MS);
    }

    async _rebuild() {
        const document = this._document;
        const seq = ++this._scanSeq;
        if (!document) {
            this._refs = [];
            this._onDidChangeTreeData.fire();
            this._updateVisibleContext();
            return;
        }
        let refs = [];
        try {
            const result = await docScanner.scan(document.uri, document.getText());
            refs = result.refs || [];
        } catch (e) {
            refs = [];
        }
        if (seq !== this._scanSeq) return; // superseded by a later edit/document switch
        this._refs = refs;
        this._onDidChangeTreeData.fire();
        this._updateVisibleContext();
    }

    _updateVisibleContext() {
        vscode.commands.executeCommand('setContext', 'materialxPlayground.filesVisible', !!this._document);
    }

    getChildren() {
        return this._refs;
    }

    getTreeItem(ref) {
        const item = new vscode.TreeItem(ref.value, vscode.TreeItemCollapsibleState.None);
        item.description = ref.status === 'found' ? undefined : (ref.reason || ref.status);
        item.tooltip = ref.reason ? ref.value + '\n' + ref.reason : ref.value;
        item.iconPath = ref.status === 'found'
            ? new vscode.ThemeIcon('file-media')
            : ref.status === 'missing'
                ? new vscode.ThemeIcon('warning')
                : new vscode.ThemeIcon('circle-slash');
        item.contextValue = ref.status === 'found' ? 'mtlxFileRefFound' : 'mtlxFileRef';
        item.command = { command: 'materialxPlayground.openFileRef', title: 'Open Reference', arguments: [ref] };
        return item;
    }
}

// Reveals ref's own line in the active document's text editor -- used for
// a missing/skipped ref (nothing to open), and as the fallback when a
// "found" ref has no offset to build an exact selection from.
async function revealRefLine(document, ref) {
    const editor = await vscode.window.showTextDocument(document, { preserveFocus: false });
    const line = typeof ref.line === 'number' ? ref.line : 0;
    const pos = new vscode.Position(line, 0);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    editor.selection = new vscode.Selection(pos, pos);
}

function register(context, { getActiveDocument, onDidChangeActiveDocument }) {
    const provider = new MtlxFilesProvider();
    if (TEST_TRANSPORT) activeProvider = provider;
    provider.setActiveDocument(getActiveDocument());

    const treeView = vscode.window.createTreeView('materialxPlayground.files', { treeDataProvider: provider });

    async function openFileRef(ref) {
        if (!ref || typeof ref.value !== 'string') return;
        const document = provider._document;
        if (!document) return;
        if (ref.status === 'found' && ref.uri) {
            await vscode.commands.executeCommand('vscode.open', ref.uri);
            return;
        }
        await revealRefLine(document, ref);
    }

    async function replaceFileRef(ref) {
        if (!ref || typeof ref.offset !== 'number' || typeof ref.endOffset !== 'number') return;
        const document = provider._document;
        if (!document) return;
        const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { Images: MTLX_TEXTURE_EXTS, 'All Files': ['*'] },
            title: 'MaterialX Playground: choose a replacement file',
        });
        if (!picked || !picked.length) return;
        const value = filePicker.computeFilePathValue(
            { scheme: document.uri.scheme, fsPath: document.uri.fsPath },
            picked[0].fsPath
        );
        const start = document.positionAt(ref.offset);
        const end = document.positionAt(ref.endOffset);
        const editor = await vscode.window.showTextDocument(document, { preserveFocus: true });
        await editor.edit((builder) => builder.replace(new vscode.Range(start, end), value));
    }

    context.subscriptions.push(
        treeView,
        onDidChangeActiveDocument((doc) => provider.setActiveDocument(doc)),
        vscode.workspace.onDidChangeTextDocument((e) => provider.scheduleRefresh(e.document)),
        vscode.commands.registerCommand('materialxPlayground.openFileRef', openFileRef),
        vscode.commands.registerCommand('materialxPlayground.replaceFileRef', replaceFileRef),
        vscode.commands.registerCommand('materialxPlayground.revealFileRefInExplorer', (ref) => {
            if (ref && ref.uri) vscode.commands.executeCommand('revealInExplorer', ref.uri);
        }),
        { dispose: () => { if (provider._timer) clearTimeout(provider._timer); } }
    );

    return provider;
}

// Test-only (MTLX_TEST_TRANSPORT=1): the current refs list, for the
// packaged-extension smoke run to poll (the scan is async/debounced).
let testApi = null;
if (TEST_TRANSPORT) {
    testApi = {
        getRefs() {
            return activeProvider ? activeProvider._refs.slice() : [];
        },
    };
}

module.exports = { register, MtlxFilesProvider, testApi };
