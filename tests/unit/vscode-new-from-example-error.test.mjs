// The error path of newFromExample.js must raise the "Show Output" popup
// through the real editorProvider helper (an undefined reportError once threw instead).
import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const calls = { errors: [], shown: 0 };
const channel = { appendLine() {}, show() { calls.shown++; }, name: 'MaterialX' };
class Uri { static joinPath() { return new Uri(); } }
const fakeVscode = new Proxy({
    Uri,
    window: {
        showErrorMessage: (text, ...actions) => { calls.errors.push({ text, actions }); return Promise.resolve('Show Output'); },
        createOutputChannel: () => channel,
    },
    workspace: { getConfiguration: () => ({ get: (_k, d) => d }) },
    commands: { registerCommand: () => ({ dispose() {} }) },
}, { get: (t, k) => (k in t ? t[k] : function () {}) });

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') return fakeVscode;
    return origLoad.call(this, request, ...rest);
};
const nfe = require('../../vscode_extension/src/newFromExample.js');
const ep = require('../../vscode_extension/src/editorProvider.js');
Module._load = origLoad;

test('unknown example id raises the Show Output popup and logs to the channel', async () => {
    calls.errors.length = 0; calls.shown = 0;
    await nfe.handleCommand({ extensionUri: new Uri(), subscriptions: [] }, 'no-such-example-id');
    assert.equal(calls.errors.length, 1);
    assert.match(calls.errors[0].text, /unknown example id "no-such-example-id"/);
    assert.deepEqual(calls.errors[0].actions, ['Show Output']);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.shown, 1, 'choosing Show Output reveals the channel');
});

test('reportError uses the shared showHostError helper', () => {
    calls.errors.length = 0;
    nfe.reportError('boom');
    assert.deepEqual(calls.errors.map((e) => e.text), ['boom']);
    assert.equal(typeof ep.showHostError, 'function');
});
