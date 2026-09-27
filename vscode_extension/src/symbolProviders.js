// symbolProviders.js  -  registers the DocumentSymbolProvider,
// DefinitionProvider, ReferenceProvider and DocumentColorProvider for
// the 'mtlx' language. UI-only glue over mtlxSymbols.js/mtlxColors.js
// (pure Node, no vscode)  -  same split as hoverProvider.js over
// specDocs.js/nodeSignature.js.
'use strict';

const vscode = require('vscode');
const mtlxSymbols = require('./mtlxSymbols');
const mtlxColors = require('./mtlxColors');
const docScanner = require('./docScanner');

function toVsRange(range) {
    return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

function toVsPos(position) {
    return { line: position.line, character: position.character };
}

const KIND_MAP = {
    nodegraph: vscode.SymbolKind.Module,
    nodedef: vscode.SymbolKind.Interface,
    look: vscode.SymbolKind.Namespace,
    input: vscode.SymbolKind.Property,
    output: vscode.SymbolKind.Field,
    node: vscode.SymbolKind.Object,
};

function toDocumentSymbol(sym) {
    const kind = KIND_MAP[sym.kind] || vscode.SymbolKind.Object;
    const ds = new vscode.DocumentSymbol(sym.name, sym.detail, kind, toVsRange(sym.range), toVsRange(sym.selectionRange));
    ds.children = sym.children.map(toDocumentSymbol);
    return ds;
}

function registerDocumentSymbols(context) {
    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider('mtlx', {
            provideDocumentSymbols(document) {
                const { root } = mtlxSymbols.scanElements(document.getText());
                return mtlxSymbols.buildDocumentSymbols(root).map(toDocumentSymbol);
            },
        })
    );
}

function registerDefinitions(context) {
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider('mtlx', {
            provideDefinition(document, position) {
                const { root } = mtlxSymbols.scanElements(document.getText());
                const hit = mtlxSymbols.attributeValueAt(root, toVsPos(position));
                if (!hit || !mtlxSymbols.REF_ATTRS.includes(hit.attrName)) return null;
                const target = mtlxSymbols.resolveReference(root, hit.element, hit.attrName, hit.value);
                if (!target) return null;
                const nameRange = target.attrs.name ? target.attrs.name.range : target.range;
                return new vscode.Location(document.uri, toVsRange(nameRange));
            },
        })
    );
}

function registerReferences(context) {
    context.subscriptions.push(
        vscode.languages.registerReferenceProvider('mtlx', {
            provideReferences(document, position, refContext) {
                const { root } = mtlxSymbols.scanElements(document.getText());
                const pos = toVsPos(position);
                let target = null;

                const hit = mtlxSymbols.attributeValueAt(root, pos);
                if (hit && hit.attrName === 'name') {
                    target = hit.element;
                } else if (hit && mtlxSymbols.REF_ATTRS.includes(hit.attrName)) {
                    target = mtlxSymbols.resolveReference(root, hit.element, hit.attrName, hit.value);
                }
                if (!target) return [];

                const locations = mtlxSymbols
                    .findReferencesTo(root, target)
                    .map((r) => new vscode.Location(document.uri, toVsRange(r.range)));
                if (refContext.includeDeclaration && target.attrs.name) {
                    locations.push(new vscode.Location(document.uri, toVsRange(target.attrs.name.range)));
                }
                return locations;
            },
        })
    );
}

function registerColors(context) {
    context.subscriptions.push(
        vscode.languages.registerColorProvider('mtlx', {
            provideDocumentColors(document) {
                return mtlxColors.scanColorElements(document.getText()).map((e) => {
                    const disp = mtlxColors.toDisplayColor(e.components, e.colorspace);
                    const color = new vscode.Color(disp.red, disp.green, disp.blue, disp.alpha);
                    return new vscode.ColorInformation(toVsRange(e.range), color);
                });
            },
            provideColorPresentations(color, ctx) {
                // Re-locate the same color entry by its value range (the
                // exact range this provider handed back from
                // provideDocumentColors)  -  never touches any OTHER
                // element's value, so unrelated colors stay untouched.
                const els = mtlxColors.scanColorElements(ctx.document.getText());
                const found = els.find(
                    (e) => e.range.start.line === ctx.range.start.line && e.range.start.character === ctx.range.start.character
                );
                if (!found) return [];

                const picked = { red: color.red, green: color.green, blue: color.blue, alpha: color.alpha };
                const back = mtlxColors.fromDisplayColor(picked, found.colorspace, found.type === 'color4');
                const label = mtlxColors.formatValue(back, found.sep);
                const presentation = new vscode.ColorPresentation(label);
                presentation.textEdit = vscode.TextEdit.replace(toVsRange(found.range), label);
                return [presentation];
            },
        })
    );
}

// F2 rename: thin wrappers over mtlxSymbols.js's prepareRename and
// computeRenameEdits, which throw a user-facing Error on an invalid
// position, name, or collision (VS Code shows it and cancels the rename).
function registerRename(context) {
    context.subscriptions.push(
        vscode.languages.registerRenameProvider('mtlx', {
            prepareRename(document, position) {
                const { root } = mtlxSymbols.scanElements(document.getText());
                const result = mtlxSymbols.prepareRename(root, toVsPos(position));
                return { range: toVsRange(result.range), placeholder: result.placeholder };
            },
            provideRenameEdits(document, position, newName) {
                const { root } = mtlxSymbols.scanElements(document.getText());
                const edits = mtlxSymbols.computeRenameEdits(root, toVsPos(position), newName);
                const workspaceEdit = new vscode.WorkspaceEdit();
                for (const edit of edits) {
                    workspaceEdit.replace(document.uri, toVsRange(edit.range), edit.newText);
                }
                return workspaceEdit;
            },
        })
    );
}

// DocumentLinkProvider (E9): each filename ref becomes a link, resolved
// through docScanner.js's own containment helpers (the same ones the
// webview's texture scan uses), so a rejected ref just gets no link.
function registerDocumentLinks(context) {
    context.subscriptions.push(
        vscode.languages.registerDocumentLinkProvider('mtlx', {
            async provideDocumentLinks(document) {
                const { root } = mtlxSymbols.scanElements(document.getText());
                const refs = mtlxSymbols.collectFilenameRefs(root);
                if (!refs.length) return [];

                const containmentRoot = docScanner.containmentRoot(document.uri);
                if (!containmentRoot) return [];

                const deps = docScanner.defaultDeps();
                const isFileScheme = containmentRoot.scheme === 'file';
                let rootRealpath = null;
                if (isFileScheme) {
                    try {
                        rootRealpath = (await deps.realpath(containmentRoot.fsPath)).replace(/\\/g, '/');
                    } catch (e) {
                        rootRealpath = null;
                    }
                }
                const ctx = { root: containmentRoot, rootRealpath, isFileScheme, totalBytes: 0 };
                const docDirUri = vscode.Uri.joinPath(document.uri, '..');

                const links = [];
                for (const ref of refs) {
                    const resolved = await docScanner.resolveContained(deps, ctx, docDirUri, ref.ref, 'texture');
                    if (resolved.skip) continue;
                    links.push(new vscode.DocumentLink(toVsRange(ref.range), resolved.uri));
                }
                return links;
            },
        })
    );
}

function register(context) {
    registerDocumentSymbols(context);
    registerDefinitions(context);
    registerReferences(context);
    registerColors(context);
    registerRename(context);
    registerDocumentLinks(context);
}

module.exports = { register };
