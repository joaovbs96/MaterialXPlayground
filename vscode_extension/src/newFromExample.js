// newFromExample.js: registers materialxPlayground.newFromExample, which
// copies a catalog entry (exampleCatalog.js) into the workspace and
// opens it. UI/vscode.workspace.fs glue, same split as hoverProvider.js.
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const exampleCatalog = require('./exampleCatalog');
const { errMsg } = require('./util');
const { nextFreeExampleName } = require('./nextFreeExampleName');

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
// document resolves to example.mtlxPath exactly. A manifest entry's id can
// differ from its source file's basename (e.g. AnimatedChristmasTreeOrnament
// vs. ChristmasTreeOrnament016_1K-JPG.mtlx), so this compares full resolved
// paths across every entry instead of pre-filtering by id === basename.
function galleryIdFor(materials, example) {
    const entry = materials.find((m) => {
        const entryPath = m.origin === 'materialx' ? 'vendor/materialx/' + m.docPath : m.docPath;
        return entryPath === example.mtlxPath;
    });
    return entry ? entry.id : null;
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

// destUrisFor: every path a copy under destName would write. Single-file
// examples land at "<target>/<name>.mtlx"; textured ones land under
// "<target>/<name>/" with each file's original relative name kept, so
// only the folder itself needs a numeric suffix, never a texture name.
function destUrisFor(targetFolder, example, single, destName) {
    return example.files.map((file) => ({
        file,
        destUri: single
            ? vscode.Uri.joinPath(targetFolder, destName + '.mtlx')
            : vscode.Uri.joinPath(targetFolder, destName, ...file.rel.split('/')),
    }));
}

// Copies example.files into targetFolder, returning the new .mtlx's Uri.
// Never overwrites: if <name>(.mtlx|/) already exists, picks the smallest
// free "<name>_N" instead. Re-checks every path immediately before
// writing, and retries at the next number if something appeared in the
// meantime, so a race never overwrites an existing file or texture.
async function copyExample(extensionUri, example, targetFolder) {
    const single = !example.hasTextures;

    async function anyExists(destName) {
        for (const { destUri } of destUrisFor(targetFolder, example, single, destName)) {
            if (await pathExists(destUri)) return true;
        }
        return false;
    }

    let startAt = 0;
    for (;;) {
        const picked = await nextFreeExampleName(example.destName, anyExists, startAt);
        const entries = destUrisFor(targetFolder, example, single, picked.name);

        let collided = false;
        for (const { destUri } of entries) {
            if (await pathExists(destUri)) { collided = true; break; }
        }
        if (collided) { startAt = picked.n + 1; continue; }

        let newMtlxUri = null;
        for (const { file, destUri } of entries) {
            const srcUri = vscode.Uri.joinPath(extensionUri, ...file.from.split('/'));
            const bytes = await vscode.workspace.fs.readFile(srcUri);
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(destUri, '..'));
            await vscode.workspace.fs.writeFile(destUri, bytes);
            if (file === example.files[0]) newMtlxUri = destUri;
        }
        return newMtlxUri;
    }
}

// createFromExample: the actual copy-and-open flow, shared by every
// caller (old QuickPick, the gallery panel's card click, and any future
// programmatic caller) once an example is already chosen. targetFolderUri
// wins over explorerFolderUri/resolveTargetFolder's own precedence chain.
async function createFromExample(context, example, explorerFolderUri, targetFolderUri) {
    try {
        const folder = targetFolderUri || await resolveTargetFolder(explorerFolderUri);
        if (!folder) return; // user cancelled the folder dialog

        const newUri = await copyExample(context.extensionUri, example, folder);

        // Open the .mtlx TEXT editor, same as double-clicking it in the
        // Explorer. That fires onDidChangeActiveTextEditor, which is what
        // extension.js's maybeAutoOpen uses to open the Playground beside
        // it per the user's Open Behavior/Default View settings (and to
        // skip it entirely in Restricted Mode). Calling
        // materialxPlayground.open here instead would open ONLY the
        // Playground webview and never show the text editor at all.
        const doc = await vscode.workspace.openTextDocument(newUri);
        await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
        vscode.window.showErrorMessage('MaterialX Playground: failed to create material from example: ' + errMsg(err));
    }
}

// arg1/arg2: (exampleId, targetFolderUri) for programmatic use (the
// gallery panel's card click) skips both the gallery and the folder-
// resolution prompt; an Explorer folder Uri or no arguments (Command
// Palette, sidebar button) opens the gallery panel instead of copying
// anything directly. exampleGallery.js is required lazily here (it
// requires this module back, for createFromExample/galleryIdFor) so
// neither module's top-level exports need to be ready before the other's.
async function handleCommand(context, arg1, arg2) {
    if (typeof arg1 === 'string') {
        const example = exampleCatalog.getExample(arg1);
        if (!example) {
            vscode.window.showErrorMessage('MaterialX Playground: unknown example id "' + arg1 + '".');
            return;
        }
        await createFromExample(context, example, null, arg2 instanceof vscode.Uri ? arg2 : null);
        return;
    }

    const explorerFolderUri = arg1 instanceof vscode.Uri ? arg1 : null;
    try {
        await require('./exampleGallery').openGallery(context, explorerFolderUri);
    } catch (err) {
        // Fallback for a host that can't render webviews at all.
        const example = await pickExample(context.extensionUri);
        if (!example) return; // user cancelled the QuickPick
        await createFromExample(context, example, explorerFolderUri, null);
    }
}

function register(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMAND_ID, (arg1, arg2) => handleCommand(context, arg1, arg2))
    );
}

module.exports = { register, COMMAND_ID, galleryIdFor, createFromExample, pickExample, resolveTargetFolder };
