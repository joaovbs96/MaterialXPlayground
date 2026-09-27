// exampleGallery.js: the "New Material from Example" webview PANEL,
// opened by materialxPlayground.newFromExample instead of the old
// QuickPick (newFromExample.js keeps the QuickPick as an internal
// fallback for a host that can't render webviews). One panel is reused
// across calls; a second call with a different Explorer folder just
// updates the reused panel's target folder rather than opening another.
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const crypto = require('crypto');
const exampleCatalog = require('./exampleCatalog');
const galleryModel = require('./exampleGalleryModel');
const newFromExample = require('./newFromExample');
const { errMsg } = require('./util');
const { panelIconPath } = require('./editorProvider');

const VIEW_TYPE = 'materialxPlayground.exampleGallery';

// Inert unless the packaged-extension smoke run sets this in the
// extension host's own environment, never true for a real user session --
// same gate editorProvider.js uses for its own test transport.
const TEST_TRANSPORT = process.env.MTLX_TEST_TRANSPORT === '1';

let panelInfo = null; // { panel, targetFolderUri, groups } | null
let storedContext = null; // set by register(); read by the test API below

// register(context): stores the extension context the test API needs to
// open a panel on its own (a real user session always reaches openGallery
// through newFromExample.js's command handler instead, which already has
// its own context from vscode.commands.registerCommand's closure).
function register(context) {
    storedContext = context;
}

function getNonce() {
    return crypto.randomBytes(16).toString('base64');
}

// The trimmed gallery/manifest.json the release package job ships, or []
// when missing (plain checkout). Mirrors newFromExample.js's own loader.
function loadGalleryMaterials(extensionUri) {
    try {
        const raw = fs.readFileSync(vscode.Uri.joinPath(extensionUri, 'gallery', 'manifest.json').fsPath, 'utf8');
        return JSON.parse(raw).materials || [];
    } catch (e) {
        return [];
    }
}

// Resolves each card's thumbId (from exampleGalleryModel.buildGalleryData)
// to a webview-safe asWebviewUri, dropping it when the .jpg was pruned
// out of this package (see gallery-shots.mjs's --prune-ids-auto).
function withThumbUris(webview, extensionUri, groups) {
    return groups.map((group) => ({
        source: group.source,
        cards: group.cards.map((card) => {
            let thumbUri = null;
            if (card.thumbId) {
                const fileUri = vscode.Uri.joinPath(extensionUri, 'gallery', 'thumbs', card.thumbId + '.jpg');
                if (fs.existsSync(fileUri.fsPath)) thumbUri = webview.asWebviewUri(fileUri).toString();
            }
            return { id: card.id, label: card.label, shadingModel: card.shadingModel, license: card.license, thumbUri };
        }),
    }));
}

// buildResolvedGroups: exampleGalleryModel.buildGalleryData plus this
// webview's own asWebviewUri thumbnails, in one call. Shared by this
// panel and actionsView.js's embedded examples grid so neither duplicates
// the catalog/manifest/thumbnail wiring.
function buildResolvedGroups(webview, extensionUri) {
    const materials = loadGalleryMaterials(extensionUri);
    const baseGroups = galleryModel.buildGalleryData(exampleCatalog.getCatalog(), materials);
    return withThumbUris(webview, extensionUri, baseGroups);
}

async function buildHtml(context, webview) {
    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'vscode_extension', 'media');
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'gallery.js')).toString();
    const cardsScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'gallery-cards.js')).toString();
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'gallery.css')).toString();
    const cardsStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'gallery-cards.css')).toString();

    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(mediaRoot, 'gallery.html'));
    let html = Buffer.from(bytes).toString('utf8');
    html = html.split('${cspSource}').join(webview.cspSource);
    html = html.split('${nonce}').join(nonce);
    html = html.split('${scriptUri}').join(scriptUri);
    html = html.split('${cardsScriptUri}').join(cardsScriptUri);
    html = html.split('${styleUri}').join(styleUri);
    html = html.split('${cardsStyleUri}').join(cardsStyleUri);
    return html;
}

// Message validation: only 'ready' (send the initial data) and 'run' with
// an id from the exact group list this panel last sent are honored. A
// 'run' for any other id -- unknown, or from a stale/tampered message --
// is silently dropped, never executed.
async function handleMessage(context, info, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') {
        info.panel.webview.postMessage({ type: 'init', groups: info.groups });
        return;
    }
    if (msg.type === 'rendered' && typeof msg.cardCount === 'number') {
        if (TEST_TRANSPORT && testHooks) testHooks.emitRendered({ cardCount: msg.cardCount });
        return;
    }
    if (msg.type !== 'run' || typeof msg.id !== 'string') return;
    if (!galleryModel.isKnownCardId(info.groups, msg.id)) return;

    const example = exampleCatalog.getExample(msg.id);
    if (!example) return; // defensive: catalog and info.groups are built from the same source
    await newFromExample.createFromExample(context, example, info.targetFolderUri, null);
}

// openGallery(context, explorerFolderUri): explorerFolderUri is the
// Explorer-context-menu folder (or null for the Command Palette/sidebar
// button). Reveals and re-targets the existing panel if one is open.
async function openGallery(context, explorerFolderUri) {
    if (panelInfo) {
        panelInfo.targetFolderUri = explorerFolderUri || null;
        panelInfo.panel.reveal(undefined, false);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        VIEW_TYPE,
        'New Material from Example',
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [context.extensionUri],
        }
    );
    panel.iconPath = panelIconPath(context.extensionUri);

    const groups = buildResolvedGroups(panel.webview, context.extensionUri);

    const info = { panel, targetFolderUri: explorerFolderUri || null, groups };
    panelInfo = info;
    panel.onDidDispose(() => { if (panelInfo === info) panelInfo = null; });
    panel.webview.onDidReceiveMessage((msg) => handleMessage(context, info, msg));
    panel.webview.html = await buildHtml(context, panel.webview);
}

function isGalleryOpen() {
    return !!panelInfo;
}

// Test-only instrumentation (MTLX_TEST_TRANSPORT=1 only, see TEST_TRANSPORT
// above): lets the packaged-extension smoke run confirm the panel actually
// rendered N cards, and drive a card click without simulating real DOM
// events (which a webview's own process doesn't expose to the test host).
let testHooks = null;
let testApi = null;
if (TEST_TRANSPORT) {
    const renderedListeners = [];
    testHooks = {
        emitRendered(report) {
            for (const listener of renderedListeners) listener(report);
        },
    };
    testApi = {
        async open(folderFsPath) {
            await openGallery(storedContext, folderFsPath ? vscode.Uri.file(folderFsPath) : null);
        },
        isOpen: isGalleryOpen,
        waitForRendered(timeoutMs) {
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    const idx = renderedListeners.indexOf(onReport);
                    if (idx !== -1) renderedListeners.splice(idx, 1);
                    reject(new Error('timeout waiting for the gallery to report its rendered card count'));
                }, timeoutMs || 5000);
                function onReport(report) {
                    clearTimeout(timer);
                    resolve(report);
                }
                renderedListeners.push(onReport);
            });
        },
        // Bypasses the webview's own DOM entirely, but goes through the
        // exact same validated handleMessage() a real click would.
        async triggerCard(id) {
            if (!panelInfo) throw new Error('the gallery panel is not open');
            await handleMessage(storedContext, panelInfo, { type: 'run', id: id });
        },
    };
}

module.exports = { register, openGallery, isGalleryOpen, buildResolvedGroups, testApi };
