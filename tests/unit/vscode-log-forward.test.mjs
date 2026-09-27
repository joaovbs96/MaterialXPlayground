// Unit tests for editorProvider.js's E21 log forwarding: logLine's severity/
// documentName tagging, the ring-buffer dedupe of identical consecutive
// lines, and replaying buffered history to a webview's 'ready' via
// wireCommonWebviewMessages -- filtered to lines naming no document (global)
// or this panel's own document.
import assert from 'node:assert/strict';
import test from 'node:test';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Same minimal 'vscode' stand-in as vscode-lifecycle.test.mjs, plus
// createOutputChannel (getSharedOutputChannel's dependency).
const vscodeStub = {
    Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join('/'), toString() { return this.path; } }) },
    workspace: { fs: { readFile: () => Promise.resolve(Buffer.from('')) } },
    window: {
        showErrorMessage: () => {},
        createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {} }),
    },
    version: 'test',
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.call(this, request, ...rest);
};
const editorProvider = require('../../vscode_extension/src/editorProvider.js');
Module._load = originalLoad;

// Fake panel/webview: onDidReceiveMessage supports multiple independent
// listeners (like the real VS Code webview event), postMessage just records.
function fakePanel() {
    const disposeListeners = [];
    const messageListeners = [];
    const posted = [];
    const webview = {
        postMessage(m) { posted.push(m); return Promise.resolve(true); },
        onDidReceiveMessage(fn) { messageListeners.push(fn); return { dispose() {} }; },
    };
    return {
        webview, posted,
        onDidDispose(fn) { disposeListeners.push(fn); return { dispose() {} }; },
        dispose() { for (const fn of disposeListeners) fn(); },
        emit(msg) { for (const fn of messageListeners) fn(msg); },
    };
}

function makePanel(documentUri) {
    const panel = fakePanel();
    const life = editorProvider.panelLifecycle(panel);
    editorProvider.wireCommonWebviewMessages(panel.webview, undefined, documentUri, life);
    return { panel, life };
}

const docUri = { toString: () => 'file:///a.mtlx', fsPath: 'C:/a.mtlx' };
const otherDocUri = { toString: () => 'file:///b.mtlx', fsPath: 'C:/b.mtlx' };

test('logLine forwards a mtlx-log message with severity to a live webview', () => {
    const { panel } = makePanel(docUri);
    const channel = { appendLine: () => {} };
    editorProvider.logLine(channel, 'something warned', 'warning', 'a.mtlx');
    const forwarded = panel.posted.filter((m) => m.type === 'mtlx-log');
    assert.equal(forwarded.length, 1);
    assert.deepEqual(forwarded[0], { type: 'mtlx-log', severity: 'warning', text: 'something warned' });
});

test('logLine defaults to info severity when none is given', () => {
    const { panel } = makePanel(docUri);
    const channel = { appendLine: () => {} };
    editorProvider.logLine(channel, 'plain line');
    const forwarded = panel.posted.filter((m) => m.type === 'mtlx-log');
    assert.equal(forwarded[0].severity, 'info');
});

test('identical consecutive lines are deduped, not re-broadcast', () => {
    const { panel } = makePanel(docUri);
    const channel = { appendLine: () => {} };
    editorProvider.logLine(channel, 'repeat me', 'warning', 'a.mtlx');
    editorProvider.logLine(channel, 'repeat me', 'warning', 'a.mtlx');
    editorProvider.logLine(channel, 'repeat me', 'warning', 'a.mtlx');
    assert.equal(panel.posted.filter((m) => m.type === 'mtlx-log').length, 1);
    // A different document tag makes it a distinct line again.
    editorProvider.logLine(channel, 'repeat me', 'warning', 'other.mtlx');
    assert.equal(panel.posted.filter((m) => m.type === 'mtlx-log').length, 2);
});

// The buffer/live-webview set is module-scoped state shared across every
// test in this file (editorProvider.js is require()'d once), so these two
// tests use unique text/document tags and assert by inclusion/exclusion
// rather than an exact replayed list, which would otherwise be polluted by
// whatever earlier tests already logged.
test('ready replays buffered history filtered by document', () => {
    const channel = { appendLine: () => {} };
    editorProvider.logLine(channel, 'r1-global-notice', 'info', null);
    editorProvider.logLine(channel, 'r1-about-a', 'warning', 'r1-a.mtlx');
    editorProvider.logLine(channel, 'r1-about-b', 'error', 'r1-b.mtlx');

    // A panel for r1-a.mtlx, opened AFTER those lines, replays on 'ready'.
    const { panel } = makePanel({ toString: () => 'file:///r1-a.mtlx', fsPath: 'C:/r1-a.mtlx' });
    panel.emit({ type: 'ready' });
    const replayed = panel.posted.filter((m) => m.type === 'mtlx-log').map((m) => m.text);
    assert.ok(replayed.includes('r1-global-notice'), 'global lines replay to every panel');
    assert.ok(replayed.includes('r1-about-a'), 'lines for this panel\'s own document replay');
    assert.ok(!replayed.includes('r1-about-b'), 'lines for a different document do not replay');
});

test('a panel with no document only replays global (document-less) lines', () => {
    const channel = { appendLine: () => {} };
    editorProvider.logLine(channel, 'r2-global-only', 'info', null);
    editorProvider.logLine(channel, 'r2-tied-to-a', 'warning', 'r2-a.mtlx');
    const { panel } = makePanel(null);
    panel.emit({ type: 'ready' });
    const replayed = panel.posted.filter((m) => m.type === 'mtlx-log').map((m) => m.text);
    assert.ok(replayed.includes('r2-global-only'));
    assert.ok(!replayed.includes('r2-tied-to-a'), 'a document-tagged line does not replay to a document-less panel');
});

test('a disposed panel is dropped from the live broadcast set', () => {
    const { panel } = makePanel(otherDocUri);
    const channel = { appendLine: () => {} };
    editorProvider.logLine(channel, 'before dispose', 'info', 'b.mtlx');
    assert.equal(panel.posted.filter((m) => m.type === 'mtlx-log').length, 1);
    panel.dispose();
    editorProvider.logLine(channel, 'after dispose', 'info', 'b.mtlx');
    assert.equal(panel.posted.filter((m) => m.type === 'mtlx-log').length, 1);
});
