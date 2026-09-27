// actionsView.js: TreeDataProvider for the materialxPlayground.actions
// view (activity bar container). UI-only glue over actionsModel.js's pure
// row list, same split as outlineView.js over outlineModel.js. Refreshes
// on onDidChangeActiveMtlxDocument so the two "Open in ..." rows track
// whether a MaterialX document is currently active.
'use strict';

const vscode = require('vscode');
const actionsModel = require('./actionsModel');

class MtlxActionsProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this._rows = actionsModel.buildActionRows(false);
    }

    setActiveDocument(document) {
        this._rows = actionsModel.buildActionRows(!!document);
        this._onDidChangeTreeData.fire();
    }

    getChildren() {
        return this._rows;
    }

    getTreeItem(row) {
        const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
        item.id = row.id;
        item.iconPath = new vscode.ThemeIcon(row.icon);
        if (row.description) item.description = row.description;
        if (row.command) {
            item.command = { command: row.command, title: row.label };
        }
        return item;
    }
}

// register(context, { getActiveDocument, onDidChangeActiveDocument }):
// same shape as outlineView.js's register, reused here for the action
// rows' active-document dependent rows.
function register(context, { getActiveDocument, onDidChangeActiveDocument }) {
    const provider = new MtlxActionsProvider();
    provider.setActiveDocument(getActiveDocument());

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('materialxPlayground.actions', provider),
        onDidChangeActiveDocument((doc) => provider.setActiveDocument(doc))
    );

    return provider;
}

module.exports = { register, MtlxActionsProvider };
