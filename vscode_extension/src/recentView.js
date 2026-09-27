// recentView.js: TreeDataProvider for the materialxPlayground.recent view
// (activity bar container). Last 10 .mtlx/scene files opened in our own
// views, kept in context.globalState so it survives a window reload, most
// recent first. extension.js calls the returned `record(uri, kind)` on
// every .mtlx text-document open and every Scene Viewer tab open -- this
// module never scans for opens itself.
'use strict';

const vscode = require('vscode');
const path = require('path');
const { pushRecentEntry, MAX_ITEMS } = require('./recentModel');

const STORAGE_KEY = 'materialxPlayground.recentFiles';

// Same test-only gate as actionsView.js/filesView.js.
const TEST_TRANSPORT = process.env.MTLX_TEST_TRANSPORT === '1';
let activeProvider = null;

class MtlxRecentProvider {
    constructor(context) {
        this._context = context;
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this._items = context.globalState.get(STORAGE_KEY, []);
    }

    record(uri, kind) {
        const label = path.basename(uri.fsPath || uri.path);
        const entry = { uri: uri.toString(), label, kind, time: Date.now() };
        this._items = pushRecentEntry(this._items, entry, MAX_ITEMS);
        this._save();
    }

    clear() {
        this._items = [];
        this._save();
    }

    _save() {
        this._context.globalState.update(STORAGE_KEY, this._items);
        this._onDidChangeTreeData.fire();
        this._updateVisibleContext();
    }

    // Files removed since they were recorded are dropped on refresh; a
    // non-file uri (nothing this view records today, but defensive) is
    // kept as-is since it can't be stat'd.
    async _pruneMissing() {
        const kept = [];
        for (const item of this._items) {
            try {
                const uri = vscode.Uri.parse(item.uri);
                if (uri.scheme !== 'file') { kept.push(item); continue; }
                await vscode.workspace.fs.stat(uri);
                kept.push(item);
            } catch (e) { /* dropped: file no longer exists */ }
        }
        if (kept.length !== this._items.length) {
            this._items = kept;
            this._context.globalState.update(STORAGE_KEY, this._items);
        }
        this._updateVisibleContext();
    }

    _updateVisibleContext() {
        vscode.commands.executeCommand('setContext', 'materialxPlayground.recentVisible', this._items.length > 0);
    }

    async getChildren() {
        await this._pruneMissing();
        return this._items;
    }

    getTreeItem(item) {
        const treeItem = new vscode.TreeItem(item.label, vscode.TreeItemCollapsibleState.None);
        treeItem.description = item.kind === 'scene' ? 'Scene' : 'MaterialX';
        treeItem.tooltip = item.uri;
        treeItem.iconPath = new vscode.ThemeIcon(item.kind === 'scene' ? 'globe' : 'file-code');
        treeItem.command = { command: 'materialxPlayground.openRecentItem', title: 'Open', arguments: [item] };
        return treeItem;
    }
}

function register(context) {
    const provider = new MtlxRecentProvider(context);
    if (TEST_TRANSPORT) activeProvider = provider;
    provider._updateVisibleContext();
    const treeView = vscode.window.createTreeView('materialxPlayground.recent', { treeDataProvider: provider });
    // Required lazily: sceneProvider.js isn't otherwise a dependency of
    // this module, only its exported VIEW_TYPE constant, and requiring it
    // eagerly at module scope would need extension.js to load this file
    // strictly after sceneProvider.js registers.
    const sceneProvider = require('./sceneProvider');

    context.subscriptions.push(
        treeView,
        vscode.commands.registerCommand('materialxPlayground.openRecentItem', async (item) => {
            if (!item || typeof item.uri !== 'string') return;
            const uri = vscode.Uri.parse(item.uri);
            if (item.kind === 'scene') {
                await vscode.commands.executeCommand('vscode.openWith', uri, sceneProvider.VIEW_TYPE);
            } else {
                await vscode.window.showTextDocument(uri);
            }
        }),
        vscode.commands.registerCommand('materialxPlayground.clearRecent', () => provider.clear())
    );

    return { record: (uri, kind) => provider.record(uri, kind) };
}

// Test-only (MTLX_TEST_TRANSPORT=1): the current recent list and a way to
// trigger "Open"/"Clear" through the real commands.
let testApi = null;
if (TEST_TRANSPORT) {
    testApi = {
        getItems() {
            return activeProvider ? activeProvider._items.slice() : [];
        },
        async open(item) {
            await vscode.commands.executeCommand('materialxPlayground.openRecentItem', item);
        },
        async clear() {
            await vscode.commands.executeCommand('materialxPlayground.clearRecent');
        },
    };
}

module.exports = { register, MtlxRecentProvider, testApi };
