// Unit tests for editorProvider.js's panel lifecycle guards: a webview panel
// closed while buildHtml awaits its template must not throw "Webview is
// disposed" (the E19 throw site was `webview.html = ...` after that await).
import assert from 'node:assert/strict';
import test from 'node:test';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Minimal 'vscode' stand-in: only what editorProvider.js touches at load time
// and in buildHtml. readFile resolves when the test releases it.
let releaseRead = null;
const vscodeStub = {
    Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join('/'), toString() { return this.path; } }) },
    workspace: { getConfiguration: () => ({ get: () => 'light', inspect: () => undefined }), fs: { readFile: () => new Promise((resolve) => { releaseRead = () => resolve(Buffer.from('<html>${cspSource}|${themePref}|${themeKind}</html>')); }) } },
    window: { showErrorMessage: () => {}, activeColorTheme: { kind: 2 } },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    version: 'test',
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.call(this, request, ...rest);
};
const editorProvider = require('../../vscode_extension/src/editorProvider.js');
Module._load = originalLoad;

// Fake panel whose webview throws like VS Code's once disposed.
function fakePanel() {
    const disposeListeners = [];
    let disposed = false;
    const posted = [];
    const assertLive = () => { if (disposed) throw new Error('Webview is disposed'); };
    const webview = {
        cspSource: 'csp',
        asWebviewUri: (u) => ({ toString: () => 'https://wv/' + u.path }),
        set options(v) { assertLive(); this._options = v; },
        get options() { return this._options; },
        set html(v) { assertLive(); this._html = v; },
        get html() { return this._html; },
        postMessage(m) { assertLive(); posted.push(m); return Promise.resolve(true); },
    };
    return {
        webview, posted,
        onDidDispose(fn) { disposeListeners.push(fn); return { dispose() {} }; },
        dispose() { disposed = true; for (const fn of disposeListeners) fn(); },
    };
}
const context = { extensionUri: { path: '/ext' }, extension: { packageJSON: { version: '1.0.0' } } };

test('buildHtml resolves false without touching html when the panel closes mid-await', async () => {
    const panel = fakePanel();
    const life = editorProvider.panelLifecycle(panel);
    const pending = editorProvider.buildHtml(context, life.webview, '#!viewer', false, null, false, life.isLive);
    panel.dispose();
    releaseRead();
    assert.equal(await pending, false);
    assert.equal(panel.webview.html, undefined);
});

test('buildHtml still renders a live panel', async () => {
    const panel = fakePanel();
    const life = editorProvider.panelLifecycle(panel);
    const pending = editorProvider.buildHtml(context, life.webview, '#!viewer', false, null, false, life.isLive);
    releaseRead();
    assert.equal(await pending, true);
    assert.equal(panel.webview.html, '<html>csp|light|dark</html>');
});

test('post after dispose is dropped, not thrown', async () => {
    const panel = fakePanel();
    const life = editorProvider.panelLifecycle(panel);
    assert.equal(await life.post({ type: 'a' }), true);
    panel.dispose();
    assert.equal(life.disposed, true);
    assert.equal(await life.post({ type: 'b' }), false);
    assert.deepEqual(panel.posted.map((m) => m.type), ['a']);
});

test('subscriptions and dispose hooks registered late run immediately', () => {
    const panel = fakePanel();
    const life = editorProvider.panelLifecycle(panel);
    let early = 0;
    let late = 0;
    let hook = 0;
    life.track({ dispose() { early++; } });
    panel.dispose();
    assert.equal(early, 1);
    life.track({ dispose() { late++; } });
    life.onDispose(() => { hook++; });
    assert.equal(late, 1);
    assert.equal(hook, 1);
});
