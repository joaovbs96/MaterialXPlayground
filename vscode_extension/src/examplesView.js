// examplesView.js: WebviewViewProvider for the materialxPlayground.examples
// sidebar view (activity bar container, under Actions). Same searchable
// card grid as exampleGallery.js's panel -- reuses its
// buildResolvedGroups(), exampleGalleryModel.js and media/gallery-cards.*
// instead of duplicating them -- but grouped into collapsible sections by
// media/examples-view.js and sized for the sidebar's own width.
// The Actions view's "New Material from Example" button now reveals and
// focuses this view (materialxPlayground.examples.focus) instead of
// running the newFromExample command; the Command Palette entry and the
// Explorer folder context menu still run that command, since only they
// know the target folder to hand the gallery tab.
'use strict';

const vscode = require('vscode');
const crypto = require('crypto');
const exampleCatalog = require('./exampleCatalog');
const galleryModel = require('./exampleGalleryModel');
const newFromExample = require('./newFromExample');
const exampleGallery = require('./exampleGallery');

// Inert unless the packaged-extension smoke run sets this in the
// extension host's own environment, never true for a real user session --
// same gate exampleGallery.js/actionsView.js use for their own test
// transports.
const TEST_TRANSPORT = process.env.MTLX_TEST_TRANSPORT === '1';
let activeProvider = null;

function getNonce() {
    return crypto.randomBytes(16).toString('base64');
}

class MtlxExamplesViewProvider {
    constructor(context) {
        this._context = context;
        this._view = null;
        this._groups = [];
    }

    async resolveWebviewView(webviewView) {
        this._view = webviewView;
        const webview = webviewView.webview;
        const mediaRoot = vscode.Uri.joinPath(this._context.extensionUri, 'vscode_extension', 'media');
        // localResourceRoots needs the whole extensionUri, not just media/,
        // since thumbnails live under gallery/thumbs/ (same as the panel).
        webview.options = { enableScripts: true, localResourceRoots: [this._context.extensionUri] };

        const nonce = getNonce();
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'examples-view.js')).toString();
        const cardsScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'gallery-cards.js')).toString();
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'examples-view.css')).toString();
        const cardsStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'gallery-cards.css')).toString();

        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(mediaRoot, 'examples-view.html'));
        let html = Buffer.from(bytes).toString('utf8');
        html = html.split('${cspSource}').join(webview.cspSource);
        html = html.split('${nonce}').join(nonce);
        html = html.split('${scriptUri}').join(scriptUri);
        html = html.split('${cardsScriptUri}').join(cardsScriptUri);
        html = html.split('${styleUri}').join(styleUri);
        html = html.split('${cardsStyleUri}').join(cardsStyleUri);
        webview.html = html;

        this._groups = exampleGallery.buildResolvedGroups(webview, this._context.extensionUri);
        webview.onDidReceiveMessage((msg) => this._handleMessage(msg));
    }

    _postInit() {
        if (!this._view) return;
        this._view.webview.postMessage({ type: 'init', groups: this._groups });
    }

    // Message validation: only 'ready' (send the initial data) and 'run'
    // with an id from the exact group list this view last sent are
    // honored, same contract as exampleGallery.js's handleMessage.
    async _handleMessage(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ready') { this._postInit(); return; }
        if (msg.type === 'rendered' && typeof msg.cardCount === 'number') {
            if (TEST_TRANSPORT && testHooks) testHooks.emitRendered({ cardCount: msg.cardCount });
            return;
        }
        if (msg.type !== 'run' || typeof msg.id !== 'string') return;
        if (!galleryModel.isKnownCardId(this._groups, msg.id)) return;

        const example = exampleCatalog.getExample(msg.id);
        if (!example) return; // defensive: catalog and this._groups are built from the same source

        // No Explorer folder here (this is a sidebar view, not a context
        // menu): the usual active-editor/workspace-folder/prompt chain in
        // newFromExample.js's resolveTargetFolder runs, same as any other
        // sidebar or Command Palette invocation without a folder argument.
        await newFromExample.createFromExample(this._context, example, null, null);
    }
}

function register(context) {
    const provider = new MtlxExamplesViewProvider(context);
    if (TEST_TRANSPORT) activeProvider = provider;

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('materialxPlayground.examples', provider)
    );

    return provider;
}

// Test-only instrumentation (MTLX_TEST_TRANSPORT=1 only, see TEST_TRANSPORT
// above): lets the packaged-extension smoke run confirm the view actually
// resolved and rendered N cards, and drive a card click without simulating
// real DOM events.
let testHooks = null;
let testApi = null;
if (TEST_TRANSPORT) {
    const renderedListeners = [];
    // Every view in the sidebar container resolves together the first
    // time the container itself is revealed (not one at a time on its
    // own focus), so 'rendered' can already have fired -- and be gone --
    // before a later waitForRendered() call registers its listener.
    // lastRendered lets that late call resolve immediately instead of
    // waiting for an event that already happened.
    let lastRendered = null;
    testHooks = {
        emitRendered(report) {
            lastRendered = report;
            for (const listener of renderedListeners) listener(report);
        },
    };
    testApi = {
        async focus() {
            await vscode.commands.executeCommand('materialxPlayground.examples.focus');
        },
        isResolved() {
            return !!(activeProvider && activeProvider._view);
        },
        waitForRendered(timeoutMs) {
            if (lastRendered) return Promise.resolve(lastRendered);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    const idx = renderedListeners.indexOf(onReport);
                    if (idx !== -1) renderedListeners.splice(idx, 1);
                    reject(new Error('timeout waiting for the examples view to report its rendered card count'));
                }, timeoutMs || 5000);
                function onReport(report) {
                    clearTimeout(timer);
                    resolve(report);
                }
                renderedListeners.push(onReport);
            });
        },
        // Bypasses the webview's own DOM entirely, but goes through the
        // exact same validated _handleMessage() a real click would.
        async triggerCard(id) {
            if (!activeProvider) throw new Error('the examples view is not resolved');
            await activeProvider._handleMessage({ type: 'run', id: id });
        },
    };
}

module.exports = { register, testApi };
