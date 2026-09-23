// completionProvider.js: registers a vscode.CompletionItemProvider for
// the 'mtlx' language. UI-only glue over mtlxCompletions.js (pure Node,
// no vscode), the same split as hoverProvider.js over specDocs.js/
// nodeSignature.js, and symbolProviders.js over mtlxSymbols.js/
// mtlxColors.js.
'use strict';

const vscode = require('vscode');
const mtlxCompletions = require('./mtlxCompletions');

const KIND_MAP = {
    node: vscode.CompletionItemKind.Class,
    structural: vscode.CompletionItemKind.Struct,
    input: vscode.CompletionItemKind.Snippet,
    type: vscode.CompletionItemKind.TypeParameter,
    colorspace: vscode.CompletionItemKind.EnumMember,
    nodedef: vscode.CompletionItemKind.Interface,
    nodegraph: vscode.CompletionItemKind.Module,
    nodename: vscode.CompletionItemKind.Reference,
    output: vscode.CompletionItemKind.Field,
    interfacename: vscode.CompletionItemKind.Property,
    'input-name': vscode.CompletionItemKind.Property,
    'attr-name': vscode.CompletionItemKind.Keyword,
};

// Sort order within one completion list: real node/attribute data first
// (the most likely pick), the generic '<input name=... />' snippet
// enrichment and bare attribute-name snippets after, label-alphabetical
// within each bucket (VS Code's default when sortText ties).
const KIND_SORT_PREFIX = { node: '0', structural: '1', 'attr-name': '8', input: '9' };

function toCompletionItem(document, cand) {
    const kind = KIND_MAP[cand.kind] || vscode.CompletionItemKind.Text;
    const item = new vscode.CompletionItem(cand.label, kind);
    if (cand.detail) item.detail = cand.detail;
    item.sortText = (KIND_SORT_PREFIX[cand.kind] || '5') + cand.label;
    item.insertText = cand.isSnippet ? new vscode.SnippetString(cand.insertText) : cand.insertText;
    if (typeof cand.replaceStart === 'number' && typeof cand.replaceEnd === 'number') {
        item.range = new vscode.Range(document.positionAt(cand.replaceStart), document.positionAt(cand.replaceEnd));
    }
    return item;
}

function register(context) {
    const repoRoot = context.extensionUri.fsPath;
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            'mtlx',
            {
                provideCompletionItems(document, position) {
                    const candidates = mtlxCompletions.getCompletions({
                        text: document.getText(),
                        offset: document.offsetAt(position),
                        repoRoot,
                    });
                    return candidates.map((c) => toCompletionItem(document, c));
                },
            },
            '<', '"', ' '
        )
    );
}

module.exports = { register };
