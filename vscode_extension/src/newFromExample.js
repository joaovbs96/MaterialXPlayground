// newFromExample.js: registers materialxPlayground.newFromExample, which
// copies a catalog entry (exampleCatalog.js) into the workspace and
// opens it. UI/vscode.workspace.fs glue, same split as hoverProvider.js.
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const exampleCatalog = require('./exampleCatalog');
const { errMsg } = require('./util');

const COMMAND_ID = 'materialxPlayground.newFromExample';

// The trimmed gallery/manifest.json the release package job ships (see
// scripts/gallery-shots.mjs's --prune-ids-auto), or [] when missing/absent
// (plain checkout, or an id-basename collision means no gallery entry).
function loadGalleryMaterials(extensionUri) {
    try {
        const raw = fs.readFileSync(vscode.Uri.joinPath(extensionUri, 'gallery', 'manifest.json').fsPath, 'utf8');
        return JSON.parse(raw).materials || [];
    } catch (e) {
        return [];
    }
}

// A catalog entry's gallery id, ONLY when a manifest entry's OWN source
// file matches example.mtlxPath exactly - two different files can share a
// basename (e.g. this catalog's "materials/open_pbr_default.mtlx" vs. the
// gallery's own "open_pbr_default" id, vendor's unrelated OpenPbr example),
// and picking by basename alone would show the wrong preview image.
function galleryIdFor(materials, example) {
    const base = example.mtlxPath.split('/').pop().replace(/\.mtlx$/i, '');
    const entry = materials.find((m) => m.id === base);
    if (!entry) return null;
    const entryPath = entry.origin === 'materialx' ? 'vendor/materialx/' + entry.docPath : entry.docPath;
    return entryPath === example.mtlxPath ? entry.id : null;
}

function exampleIconPath(extensionUri, materials, example) {
    const id = galleryIdFor(materials, example);
    if (!id) return null;
    const uri = vscode.Uri.joinPath(extensionUri, 'gallery', 'thumbs', id + '.jpg');
    return fs.existsSync(uri.fsPath) ? uri : null;
}

// QuickPick grouped by source, using QuickPickItemKind.Separator rows as
// group headers (insertion order == exampleCatalog's definition order, so
// "MaterialX Playground" lists before "MaterialX Examples").
async function pickExample(extensionUri) {
    const materials = loadGalleryMaterials(extensionUri);
    const bySource = new Map();
    for (const example of exampleCatalog.getCatalog()) {
        if (!bySource.has(example.source)) bySource.set(example.source, []);
        const iconPath = exampleIconPath(extensionUri, materials, example);
        bySource.get(example.source).push({
            label: example.label,
            description: example.shadingModel,
            detail: example.license,
            iconPath: iconPath || undefined,
            example,
        });
    }

    const items = [];
    for (const [source, list] of bySource) {
        items.push({ label: source, kind: vscode.QuickPickItemKind.Separator });
        items.push(...list);
    }

    const picked = await vscode.window.showQuickPick(items, {
        title: 'MaterialX Playground: New Material from Example',
        placeHolder: 'Choose an example material to copy into your workspace',
        matchOnDescription: true,
        matchOnDetail: true,
    });
    return picked ? picked.example : null;
}

// Target folder precedence: the invoked-on folder, else the active
// .mtlx file's folder, else the active Playground custom-editor tab's file
// (activeTextEditor is undefined while a webview tab has focus, same gap
// extension.js's activeMtlxDocument() closes), else the first workspace
// folder, else ask via showOpenDialog. Returns null only when the user
// cancels the dialog.
async function resolveTargetFolder(explorerFolderUri) {
    if (explorerFolderUri instanceof vscode.Uri) return explorerFolderUri;

    const active = vscode.window.activeTextEditor;
    if (active && active.document && active.document.uri.scheme === 'file'
        && /\.mtlx$/i.test(active.document.uri.fsPath)) {
        return vscode.Uri.joinPath(active.document.uri, '..');
    }

    const tabGroup = vscode.window.tabGroups.activeTabGroup;
    const tab = tabGroup && tabGroup.activeTab;
    const input = tab && tab.input;
    if (input instanceof vscode.TabInputCustom && input.viewType === 'materialxPlayground.editor'
        && input.uri && input.uri.scheme === 'file') {
        return vscode.Uri.joinPath(input.uri, '..');
    }

    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) return folders[0].uri;

    const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Choose Destination Folder',
        title: 'MaterialX Playground: choose a destination folder for the new material',
    });
    return picked && picked.length ? picked[0] : null;
}

async function pathExists(uri) {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch (e) {
        return false;
    }
}

// Copies example.files into targetFolder, returning the new .mtlx's Uri
// (or null if the user declined to overwrite). Single-file examples land
// at "<target>/<name>.mtlx"; textured ones land under "<target>/<name>/".
async function copyExample(extensionUri, example, targetFolder) {
    const single = !example.hasTextures;
    const destLabel = single ? example.destName + '.mtlx' : example.destName + '/';
    const checkUri = single
        ? vscode.Uri.joinPath(targetFolder, example.destName + '.mtlx')
        : vscode.Uri.joinPath(targetFolder, example.destName);

    if (await pathExists(checkUri)) {
        const choice = await vscode.window.showWarningMessage(
            'MaterialX Playground: "' + destLabel + '" already exists in the destination folder.',
            { modal: true },
            'Overwrite'
        );
        if (choice !== 'Overwrite') return null;
    }

    let newMtlxUri = null;
    for (const file of example.files) {
        const srcUri = vscode.Uri.joinPath(extensionUri, ...file.from.split('/'));
        const bytes = await vscode.workspace.fs.readFile(srcUri);
        const destUri = single
            ? vscode.Uri.joinPath(targetFolder, example.destName + '.mtlx')
            : vscode.Uri.joinPath(targetFolder, example.destName, ...file.rel.split('/'));
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(destUri, '..'));
        await vscode.workspace.fs.writeFile(destUri, bytes);
        if (file === example.files[0]) newMtlxUri = destUri;
    }
    return newMtlxUri;
}

// arg1/arg2: an Explorer folder Uri, no arguments (Command Palette), or
// (exampleId, targetFolderUri) for programmatic use, which skips both
// the QuickPick and the folder-resolution prompt.
async function handleCommand(context, arg1, arg2) {
    try {
        let example = null;
        let explorerFolderUri = null;
        let targetFolderUri = null;

        if (typeof arg1 === 'string') {
            example = exampleCatalog.getExample(arg1);
            if (!example) {
                vscode.window.showErrorMessage('MaterialX Playground: unknown example id "' + arg1 + '".');
                return;
            }
            if (arg2 instanceof vscode.Uri) targetFolderUri = arg2;
        } else if (arg1 instanceof vscode.Uri) {
            explorerFolderUri = arg1;
        }

        if (!example) {
            example = await pickExample(context.extensionUri);
            if (!example) return; // user cancelled the QuickPick
        }

        const folder = targetFolderUri || await resolveTargetFolder(explorerFolderUri);
        if (!folder) return; // user cancelled the folder dialog

        const newUri = await copyExample(context.extensionUri, example, folder);
        if (!newUri) return; // user declined to overwrite

        await vscode.commands.executeCommand('materialxPlayground.open', newUri);
    } catch (err) {
        vscode.window.showErrorMessage('MaterialX Playground: failed to create material from example: ' + errMsg(err));
    }
}

function register(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMAND_ID, (arg1, arg2) => handleCommand(context, arg1, arg2))
    );
}

module.exports = { register, COMMAND_ID };
