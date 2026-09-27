// actionsView.js: WebviewViewProvider for the materialxPlayground.actions
// view (activity bar container). UI glue over actionsModel.js's pure row
// list, rendered as full-width icon buttons by media/actions-view.*
// (strict CSP, message validation below). Refreshes on
// onDidChangeActiveMtlxDocument so the two "Open in ..." rows track
// whether a MaterialX document is currently active.
//
// Also hosts what used to be the separate materialxPlayground.examples
// view (the "New Material from Example" card grid, now embedded directly
// below that button, hidden until toggled) and the sidebar header (brand,
// About overlay, GitHub link) -- see actionsModel.js's buildAboutData for
// the About payload's assembly.
'use strict';

const vscode = require('vscode');
const fs = require('fs');
const crypto = require('crypto');
const actionsModel = require('./actionsModel');
const exampleGallery = require('./exampleGallery');
const galleryModel = require('./exampleGalleryModel');
const exampleCatalog = require('./exampleCatalog');
const newFromExample = require('./newFromExample');
const mtlxNode = require('./mtlxNode');

// Every command a row can ever carry, computed once from the model itself
// -- the webview can only ever trigger one of these, never an arbitrary
// string it sends us.
const KNOWN_COMMANDS = new Set(
    actionsModel.buildActionRows(true).map((r) => r.command).filter(Boolean)
);

// MaterialX Playground's repo, hardcoded here rather than required from
// the browser-only js/site-header.js -- must match LINKS.repo there. The
// GitHub button's message payload is never used to build this URL.
const REPO_URL = 'https://github.com/joaovbs96/MaterialXPlayground';
const ISSUES_URL = REPO_URL + '/issues';

function getNonce() {
    return crypto.randomBytes(16).toString('base64');
}

// Inert unless the packaged-extension smoke run sets this in the
// extension host's own environment, never true for a real user session --
// same gate exampleGallery.js/editorProvider.js use for their own test
// transports.
const TEST_TRANSPORT = process.env.MTLX_TEST_TRANSPORT === '1';
let activeProvider = null;

// js/gen/vendor-deps.js is a browser script (`window.MTLX_VENDOR_DEPS =
// {...}`); its object literal is valid JSON, so it's read as text and
// parsed here rather than required -- there is no `window` in the
// extension host, and this stays the single source of truth (never
// hand-typed) for third-party credits.
function loadVendorDeps(extensionUri) {
    try {
        const raw = fs.readFileSync(vscode.Uri.joinPath(extensionUri, 'js', 'gen', 'vendor-deps.js').fsPath, 'utf8');
        const m = raw.match(/window\.MTLX_VENDOR_DEPS\s*=\s*(\{[\s\S]*\});?\s*$/);
        return m ? JSON.parse(m[1]) : {};
    } catch (e) {
        return {};
    }
}

// vsce renames the repo's root LICENSE to LICENSE.txt inside the packaged
// .vsix (LicenseProcessor); this extension host always serves that
// packaged/staged tree, so try LICENSE.txt first, same fallback order
// js/shell.jsx's AboutDialog uses inside VS Code.
function loadLicenseText(extensionUri) {
    for (const name of ['LICENSE.txt', 'LICENSE']) {
        try {
            return fs.readFileSync(vscode.Uri.joinPath(extensionUri, name).fsPath, 'utf8');
        } catch (e) { /* try the next name */ }
    }
    return null;
}

class MtlxActionsViewProvider {
    constructor(context) {
        this._context = context;
        this._hasActiveDocument = false;
        this._view = null;
        this._groups = [];
        this._examplesExpanded = false;
        this._aboutRequests = 0;
        this._githubOpens = 0;
    }

    setActiveDocument(document) {
        this._hasActiveDocument = !!document;
        this._postState();
    }

    _buildAbout() {
        const extensionUri = this._context.extensionUri;
        const license = loadLicenseText(extensionUri);
        return actionsModel.buildAboutData({
            extensionVersion: this._context.extension && this._context.extension.packageJSON.version,
            vscodeVersion: vscode.version,
            mtlxTag: 'v' + mtlxNode.getDefaultMtlxVersion(extensionUri.fsPath),
            vendorDeps: loadVendorDeps(extensionUri),
            repoUrl: REPO_URL,
            issuesUrl: ISSUES_URL,
            license,
            licenseError: license === null,
        });
    }

    _postState() {
        if (!this._view) return;
        this._groups = exampleGallery.buildResolvedGroups(this._view.webview, this._context.extensionUri);
        this._view.webview.postMessage({
            type: 'state',
            rows: actionsModel.buildActionRows(this._hasActiveDocument),
            examplesGroups: this._groups,
            about: this._buildAbout(),
        });
    }

    async resolveWebviewView(webviewView) {
        this._view = webviewView;
        const webview = webviewView.webview;
        const mediaRoot = vscode.Uri.joinPath(this._context.extensionUri, 'vscode_extension', 'media');
        // localResourceRoots needs the whole extensionUri, not just
        // media/: the embedded examples cards load thumbnails from
        // gallery/thumbs/, same as exampleGallery.js's panel used to.
        webview.options = { enableScripts: true, localResourceRoots: [this._context.extensionUri] };

        const nonce = getNonce();
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'actions-view.js')).toString();
        const cardsScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'gallery-cards.js')).toString();
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'actions-view.css')).toString();
        const cardsStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'gallery-cards.css')).toString();

        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(mediaRoot, 'actions-view.html'));
        let html = Buffer.from(bytes).toString('utf8');
        html = html.split('${cspSource}').join(webview.cspSource);
        html = html.split('${nonce}').join(nonce);
        html = html.split('${scriptUri}').join(scriptUri);
        html = html.split('${cardsScriptUri}').join(cardsScriptUri);
        html = html.split('${styleUri}').join(styleUri);
        html = html.split('${cardsStyleUri}').join(cardsStyleUri);
        webview.html = html;

        webview.onDidReceiveMessage((msg) => this._handleMessage(msg));
    }

    // Message validation: only a known type is ever handled. 'run' maps
    // only to a row's own (already-vetted) command, or an examples card id
    // present in the exact group list this view last sent (never an
    // arbitrary string); 'github' always opens this file's own hardcoded
    // REPO_URL, the message's payload is never used to build a URL.
    async _handleMessage(msg) {
        if (!msg || typeof msg !== 'object' || !actionsModel.isValidMessageType(msg.type)) return;

        if (msg.type === 'ready') { this._postState(); return; }
        if (msg.type === 'rendered' && typeof msg.cardCount === 'number') {
            if (TEST_TRANSPORT && testHooks) testHooks.emitRendered({ cardCount: msg.cardCount });
            return;
        }
        if (msg.type === 'toggleExamples') { this._examplesExpanded = !!msg.expanded; return; }
        if (msg.type === 'about') { this._aboutRequests += 1; return; }
        if (msg.type === 'github') {
            this._githubOpens += 1;
            // TEST_TRANSPORT never actually opens a browser -- the smoke
            // run only needs to confirm the intent reached this handler.
            if (!TEST_TRANSPORT) vscode.env.openExternal(vscode.Uri.parse(REPO_URL));
            return;
        }
        if (msg.type !== 'run' || typeof msg.id !== 'string') return;

        const rows = actionsModel.buildActionRows(this._hasActiveDocument);
        const row = rows.find((r) => r.id === msg.id);
        if (row) {
            if (row.disabled || !row.command || !KNOWN_COMMANDS.has(row.command)) return;
            vscode.commands.executeCommand(row.command);
            return;
        }

        // Not an action row id: try it as an examples card id, validated
        // against the exact groups this view last sent -- same contract as
        // exampleGallery.js's own handleMessage. No Explorer folder here
        // (this is a sidebar view), so the usual active-editor/workspace-
        // folder/prompt chain in newFromExample.js's resolveTargetFolder
        // runs, same as any other sidebar or Command Palette invocation.
        if (!galleryModel.isKnownCardId(this._groups, msg.id)) return;
        const example = exampleCatalog.getExample(msg.id);
        if (!example) return; // defensive: catalog and this._groups are built from the same source
        await newFromExample.createFromExample(this._context, example, null, null);
    }
}

// register(context, { getActiveDocument, onDidChangeActiveDocument }):
// same shape as outlineView.js's register, reused here for the action
// rows' active-document dependent rows.
function register(context, { getActiveDocument, onDidChangeActiveDocument }) {
    const provider = new MtlxActionsViewProvider(context);
    if (TEST_TRANSPORT) activeProvider = provider;

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('materialxPlayground.actions', provider),
        onDidChangeActiveDocument((doc) => provider.setActiveDocument(doc))
    );
    provider.setActiveDocument(getActiveDocument());

    return provider;
}

// Test-only instrumentation (MTLX_TEST_TRANSPORT=1 only): lets the
// packaged-extension smoke run confirm the webview view actually resolved
// (VS Code only calls resolveWebviewView once the sidebar view is
// revealed), see the row ids it would have rendered, drive the embedded
// examples grid and About overlay, and confirm the GitHub button's intent
// without actually opening a browser.
let testHooks = null;
let testApi = null;
if (TEST_TRANSPORT) {
    const renderedListeners = [];
    // The examples grid renders once at 'ready' regardless of its hidden/
    // expanded state, so 'rendered' can already have fired -- and be gone
    // -- before a later waitForExamplesRendered() call registers its
    // listener. lastRendered lets that late call resolve immediately.
    let lastRendered = null;
    testHooks = {
        emitRendered(report) {
            lastRendered = report;
            for (const listener of renderedListeners) listener(report);
        },
    };
    testApi = {
        async focus() {
            await vscode.commands.executeCommand('materialxPlayground.actions.focus');
        },
        getState() {
            const rows = actionsModel.buildActionRows(activeProvider ? activeProvider._hasActiveDocument : false);
            return {
                resolved: !!(activeProvider && activeProvider._view),
                rowIds: rows.map((r) => r.id),
                examplesExpanded: activeProvider ? activeProvider._examplesExpanded : false,
                aboutRequests: activeProvider ? activeProvider._aboutRequests : 0,
                githubOpens: activeProvider ? activeProvider._githubOpens : 0,
            };
        },
        // Drives the GitHub button through the same validated
        // _handleMessage() a real click would, without opening a browser
        // (TEST_TRANSPORT short-circuits vscode.env.openExternal above).
        async triggerGithub() {
            if (!activeProvider) throw new Error('the actions view is not resolved');
            await activeProvider._handleMessage({ type: 'github' });
        },
        // Bypasses the webview's own DOM, but goes through the exact same
        // validated _handleMessage() a real row click would.
        async triggerRow(id) {
            if (!activeProvider) throw new Error('the actions view is not resolved');
            await activeProvider._handleMessage({ type: 'run', id: id });
        },
        async triggerCard(id) {
            if (!activeProvider) throw new Error('the actions view is not resolved');
            await activeProvider._handleMessage({ type: 'run', id: id });
        },
        async toggleExamples(expanded) {
            if (!activeProvider) throw new Error('the actions view is not resolved');
            await activeProvider._handleMessage({ type: 'toggleExamples', expanded: !!expanded });
        },
        waitForExamplesRendered(timeoutMs) {
            if (lastRendered) return Promise.resolve(lastRendered);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    const idx = renderedListeners.indexOf(onReport);
                    if (idx !== -1) renderedListeners.splice(idx, 1);
                    reject(new Error('timeout waiting for the actions view to report its examples card count'));
                }, timeoutMs || 5000);
                function onReport(report) {
                    clearTimeout(timer);
                    resolve(report);
                }
                renderedListeners.push(onReport);
            });
        },
        // Host-computed About payload, independent of the webview's own
        // overlay DOM -- what a real "?" click would populate it with.
        async getAboutData() {
            if (!activeProvider) throw new Error('the actions view is not resolved');
            await activeProvider._handleMessage({ type: 'about' });
            return activeProvider._buildAbout();
        },
    };
}

module.exports = { register, MtlxActionsViewProvider, testApi };
