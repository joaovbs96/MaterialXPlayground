// symbolProviders.js  -  registers the DocumentSymbolProvider,
// DefinitionProvider, ReferenceProvider and DocumentColorProvider for
// the 'mtlx' language. UI-only glue over mtlxSymbols.js/mtlxColors.js
// (pure Node, no vscode)  -  same split as hoverProvider.js over
// specDocs.js/nodeSignature.js.
'use strict';

const vscode = require('vscode');
const mtlxSymbols = require('./mtlxSymbols');
const mtlxColors = require('./mtlxColors');

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

function register(context) {
    registerDocumentSymbols(context);
    registerDefinitions(context);
    registerReferences(context);
    registerColors(context);
}

module.exports = { register };
