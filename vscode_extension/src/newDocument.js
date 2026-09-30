// newDocument.js: registers materialxPlayground.newDocument (E13), which
// opens a brand-new untitled .mtlx document seeded with the mtlxdoc
// skeleton. UI/vscode.workspace glue, same split as newFromExample.js;
// the skeleton text itself comes from mtlxDocSkeleton.js (pure, no
// vscode, see that file's own comment on why).
'use strict';

const vscode = require('vscode');
const { readSkeletonBody } = require('./mtlxDocSkeleton');
const { errMsg } = require('./util');

const COMMAND_ID = 'materialxPlayground.newDocument';

async function handleCommand(context) {
    try {
        const body = readSkeletonBody(context.extensionUri.fsPath);
        const document = await vscode.workspace.openTextDocument({ language: 'mtlx' });
        const editor = await vscode.window.showTextDocument(document);
        await editor.insertSnippet(new vscode.SnippetString(body));
    } catch (err) {
        // Lazy require: editorProvider pulls in much of the extension.
        const ep = require('./editorProvider');
        const text = 'MaterialX Playground: failed to create a new MaterialX document: ' + errMsg(err);
        ep.logLine(ep.getSharedOutputChannel(), text);
        ep.showHostError(text);
    }
}

function register(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMAND_ID, () => handleCommand(context))
    );
}

module.exports = { register, COMMAND_ID };
