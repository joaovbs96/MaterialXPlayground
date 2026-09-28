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
    'doc-snippet': vscode.CompletionItemKind.Snippet,
    'file-browse': vscode.CompletionItemKind.File,
};

// Sort order within one completion list: real node/attribute data first
// (the most likely pick), the generic '<input name=... />' snippet
// enrichment and bare attribute-name snippets after, label-alphabetical
// within each bucket (VS Code's default when sortText ties).
const KIND_SORT_PREFIX = { node: '0', structural: '1', 'attr-name': '8', input: '9', 'file-browse': '0' };

// Zero-padded so string comparison (what sortText uses) matches numeric
// order for any realistic candidate-list length.
function orderSuffix(cand) {
    return typeof cand.sortIndex === 'number' ? String(cand.sortIndex).padStart(4, '0') : cand.label;
}

function pickFileOnFilenameInputEnabled() {
    return vscode.workspace.getConfiguration('materialxPlayground').get('pickFileOnFilenameInput', true);
}

function toCompletionItem(document, cand, filenamePickerEnabled) {
    const kind = KIND_MAP[cand.kind] || vscode.CompletionItemKind.Text;
    const item = new vscode.CompletionItem(cand.label, kind);
    if (cand.detail) item.detail = cand.detail;
    // cand.sortIndex (set by mtlxCompletions.js for attribute-name and
    // value completions) is that module's own curated/spec-derived
    // order; without it, vscode's own alphabetical-by-label tiebreak
    // applies (node/structural lists, which have no such priority).
    item.sortText = (KIND_SORT_PREFIX[cand.kind] || '5') + orderSuffix(cand);
    if (cand.preselect) item.preselect = true;
    // filenameValueEligible (set by mtlxCompletions.js: this candidate
    // creates a fresh, name-only-or-typed <input> with no value= yet, for
    // a filename-typed input) is gated on the pickFileOnFilenameInput
    // setting here, since that pure module has no vscode config access.
    // Disabled/unset: insertText is untouched, same as before this
    // feature (the "Browse for file..." item inside value="" still works).
    let insertText = cand.insertText;
    if (cand.filenameValueEligible && filenamePickerEnabled && !cand.isSnippet) {
        insertText = insertText + '" value="';
    }
    item.insertText = cand.isSnippet ? new vscode.SnippetString(insertText) : insertText;
    if (typeof cand.replaceStart === 'number' && typeof cand.replaceEnd === 'number') {
        item.range = new vscode.Range(document.positionAt(cand.replaceStart), document.positionAt(cand.replaceEnd));
    }
    // E3: an attribute-name item inserts name="$1" with the cursor already
    // inside the quotes; immediately re-triggering suggest means the value
    // list for that attribute shows up without the user pressing
    // Ctrl+Space themselves.
    if (cand.kind === 'attr-name') {
        item.command = { command: 'editor.action.triggerSuggest', title: '' };
    }
    // E10a: "Browse for file..." inserts nothing itself, it hands off to
    // the file-picker command (implemented elsewhere) with the document
    // URI and the value text's own range, so it can replace exactly that.
    if (cand.kind === 'file-browse' && typeof cand.replaceStart === 'number' && typeof cand.replaceEnd === 'number') {
        const start = document.positionAt(cand.replaceStart);
        const end = document.positionAt(cand.replaceEnd);
        item.command = {
            command: 'materialxPlayground.pickFile',
            title: 'Browse for file...',
            arguments: [
                document.uri.toString(),
                { line: start.line, character: start.character },
                { line: end.line, character: end.character },
            ],
        };
    }
    // Filename auto-attach: `insertText` above already ends in `" value="`
    // for this candidate, and the pre-existing quote right after the
    // completion's original replace range closes it, landing an empty
    // value="" right at replaceStart + insertText.length characters into
    // the SAME line as replaceStart (insertText here is always a single
    // attribute-text line, never multi-line). That offset is computable
    // from the document as it stood BEFORE this edit, since nothing before
    // replaceStart moves and insertText carries no newline to cross.
    if (cand.filenameValueEligible && filenamePickerEnabled && typeof cand.replaceStart === 'number') {
        const start = document.positionAt(cand.replaceStart);
        const pos = { line: start.line, character: start.character + insertText.length };
        item.command = {
            command: 'materialxPlayground.pickFile',
            title: 'Pick file...',
            arguments: [document.uri.toString(), pos, pos],
        };
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
                    const filenamePickerEnabled = pickFileOnFilenameInputEnabled();
                    return candidates.map((c) => toCompletionItem(document, c, filenamePickerEnabled));
                },
            },
            '<', '"', ' ', '/'
        )
    );
}

module.exports = { register };
