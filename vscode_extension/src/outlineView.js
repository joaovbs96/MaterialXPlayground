// outlineView.js: TreeDataProvider for the materialxPlayground.outline
// view (activity bar container, package.json's views/viewsContainers).
// UI-only glue over outlineModel.js's pure tree building, same split as
// symbolProviders.js over mtlxSymbols.js. Tracks whichever document
// extension.js's activeMtlxDocument() currently reports (passed in via
// register()'s getActiveDocument/onDidChangeActiveDocument, the single
// source of truth for "which .mtlx document has focus", E16b/E17), not
// vscode.window.activeTextEditor directly, so the Outline keeps showing
// the right document while a MaterialX Playground custom-editor tab (not
// a plain text editor) has focus.
'use strict';

const vscode = require('vscode');
const outlineModel = require('./outlineModel');

const DEBOUNCE_MS = 200;

class MtlxOutlineProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this._onDidSelectPath = new vscode.EventEmitter();
        this.onDidSelectPath = this._onDidSelectPath.event;
        this._document = null;
        this._tree = { roots: [], byId: new Map() };
        this._timer = null;
        this._treeView = null;
        // id -> time of our own reveal(select: true), so the selection event
        // it causes is not mistaken for a user pick (onDidSelectPath).
        this._programmatic = new Map();
    }

    markProgrammatic(id) {
        this._programmatic.set(id, Date.now());
    }

    // True (and consumed) when this selection came from our own reveal.
    consumeProgrammatic(id) {
        const at = this._programmatic.get(id);
        this._programmatic.delete(id);
        return at !== undefined && Date.now() - at < 1500;
    }

    setTreeView(treeView) {
        this._treeView = treeView;
    }

    setActiveDocument(document) {
        const next = document && document.languageId === 'mtlx' ? document : null;
        this._document = next;
        this._rebuild();
    }

    // Called on every workspace text-document change; a no-op unless the
    // edited document is the one currently backing the Outline.
    scheduleRefresh(document) {
        if (!this._document || document.uri.toString() !== this._document.uri.toString()) return;
        if (this._timer) clearTimeout(this._timer);
        this._timer = setTimeout(() => {
            this._timer = null;
            this._rebuild();
        }, DEBOUNCE_MS);
    }

    _rebuild() {
        this._tree = this._document
            ? outlineModel.buildOutlineTree(this._document.getText())
            : { roots: [], byId: new Map() };
        this._onDidChangeTreeData.fire();
    }

    getChildren(node) {
        return node ? node.children : this._tree.roots;
    }

    getParent(node) {
        if (!node || !node.parentId) return undefined;
        return this._tree.byId.get(node.parentId);
    }

    getTreeItem(node) {
        const collapsible = node.children.length
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None;
        const item = new vscode.TreeItem(node.name, collapsible);
        item.id = node.id;
        item.description = node.detail;
        item.iconPath = new vscode.ThemeIcon(outlineModel.iconForKind(node.kind));
        item.command = {
            command: 'materialxPlayground.revealOutlineNode',
            title: 'Reveal in Document',
            arguments: [node],
        };
        return item;
    }

    revealPath(nodePath) {
        const node = this._tree.byId.get(nodePath);
        if (!node || !this._treeView) return;
        this.markProgrammatic(node.id);
        Promise.resolve(this._treeView.reveal(node, { select: true, focus: false, expand: true }))
            .catch(() => { /* best effort: a race with a tree rebuild is not fatal */ });
    }

    // pathAt/nodeAt take the vscode document/position directly (unlike
    // outlineModel.js's own pathAt, which is pure text+plain-position) so
    // callers (the cursor-follow listener below, and a later batch wiring
    // graph-editor selection) never need to know this provider's internal
    // tree shape.
    pathAt(document, position) {
        if (!document || document.languageId !== 'mtlx') return null;
        return outlineModel.pathAt(document.getText(), { line: position.line, character: position.character });
    }

    nodeAt(document, position) {
        const nodePath = this.pathAt(document, position);
        return nodePath ? this._tree.byId.get(nodePath) : null;
    }
}

function toVsRange(range) {
    return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

// Reveals node.selectionRange in a visible editor for `document` without
// stealing focus when the text is already open (preserveFocus: true keeps
// a focused Playground panel focused); opens beside (also preserveFocus)
// when the text isn't visible anywhere yet.
async function revealNode(document, node) {
    if (!document || !node) return;
    const range = toVsRange(node.selectionRange || node.range);
    const visible = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === document.uri.toString()
    );
    const viewColumn = visible ? visible.viewColumn : vscode.ViewColumn.Beside;
    const editor = await vscode.window.showTextDocument(document, { viewColumn, preserveFocus: true });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    editor.selection = new vscode.Selection(range.start, range.end);
}

// register(context, { getActiveDocument, onDidChangeActiveDocument }):
// getActiveDocument() returns extension.js's current activeMtlxDocument()
// (or null); onDidChangeActiveDocument is that same module's event, fired
// whenever the answer changes. Returns { revealPath, onDidSelectPath,
// pathAt }: onDidSelectPath fires (path, document) when the USER picks an
// Outline item, never for the reveals this module does itself.
function register(context, { getActiveDocument, onDidChangeActiveDocument }) {
    const provider = new MtlxOutlineProvider();
    provider.setActiveDocument(getActiveDocument());

    const treeView = vscode.window.createTreeView('materialxPlayground.outline', {
        treeDataProvider: provider,
        showCollapseAll: true,
    });
    provider.setTreeView(treeView);

    let followingCursor = false;

    context.subscriptions.push(
        treeView,
        onDidChangeActiveDocument((doc) => provider.setActiveDocument(doc)),
        treeView.onDidChangeSelection((e) => {
            const node = e.selection && e.selection[0];
            if (!node || e.selection.length !== 1) return;
            if (provider.consumeProgrammatic(node.id)) return;
            provider._onDidSelectPath.fire({ path: node.id, document: provider._document });
        }),
        vscode.workspace.onDidChangeTextDocument((e) => provider.scheduleRefresh(e.document)),
        vscode.commands.registerCommand('materialxPlayground.revealOutlineNode', (node) => {
            revealNode(getActiveDocument(), node);
        }),
        vscode.window.onDidChangeTextEditorSelection((e) => {
            if (followingCursor) return; // reveal() below re-fires selection on some hosts; avoid feedback loops
            const active = getActiveDocument();
            if (!active || e.textEditor.document.uri.toString() !== active.uri.toString()) return;
            const pos = e.selections[0] && e.selections[0].active;
            if (!pos) return;
            const node = provider.nodeAt(active, pos);
            if (!node) return;
            provider.markProgrammatic(node.id);
            followingCursor = true;
            Promise.resolve(treeView.reveal(node, { select: true, focus: false, expand: true }))
                .catch(() => { /* best effort: a race with a tree rebuild is not fatal */ })
                .then(() => { followingCursor = false; });
        })
    );

    return {
        revealPath: (nodePath) => provider.revealPath(nodePath),
        onDidSelectPath: provider.onDidSelectPath,
        pathAt: (document, position) => provider.pathAt(document, position),
    };
}

module.exports = { register, MtlxOutlineProvider };
