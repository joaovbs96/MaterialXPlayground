// Exercises settings.js's resolveSetting(): the materialxPlayground.* /
// deprecated materialx.* fallback, given plain inspect()-shaped objects
// (no vscode dependency, see settings.js's file banner).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const settings = require('../../vscode_extension/src/settings.js');

// Builds an inspect()-shaped object with only the scopes given explicitly
// set (undefined keys are simply absent, matching real vscode behavior).
function inspected({ defaultValue, globalValue, workspaceValue, workspaceFolderValue } = {}) {
  const out = { key: 'k', defaultValue };
  if (globalValue !== undefined) out.globalValue = globalValue;
  if (workspaceValue !== undefined) out.workspaceValue = workspaceValue;
  if (workspaceFolderValue !== undefined) out.workspaceFolderValue = workspaceFolderValue;
  return out;
}

test('neither key set: returns the new key default', () => {
  const result = settings.resolveSetting(inspected({ defaultValue: 'graph' }), inspected({ defaultValue: 'graph' }));
  assert.equal(result, 'graph');
});

test('only the new key set (global): new value wins', () => {
  const newI = inspected({ defaultValue: 'graph', globalValue: 'viewer' });
  const oldI = inspected({ defaultValue: 'graph' });
  assert.equal(settings.resolveSetting(newI, oldI), 'viewer');
});

test('only the old key set (global): old value is the fallback', () => {
  const newI = inspected({ defaultValue: 'graph' });
  const oldI = inspected({ defaultValue: 'graph', globalValue: 'viewer' });
  assert.equal(settings.resolveSetting(newI, oldI), 'viewer');
});

test('both set at global scope: new key wins', () => {
  const newI = inspected({ defaultValue: 'graph', globalValue: 'viewer' });
  const oldI = inspected({ defaultValue: 'graph', globalValue: 'graph' });
  assert.equal(settings.resolveSetting(newI, oldI), 'viewer');
});

test('new key set at workspace, old key set at workspaceFolder: new key still wins (new beats old at any scope)', () => {
  const newI = inspected({ defaultValue: 'graph', workspaceValue: 'viewer' });
  const oldI = inspected({ defaultValue: 'graph', workspaceFolderValue: 'graph' });
  assert.equal(settings.resolveSetting(newI, oldI), 'viewer');
});

test('new key: workspaceFolder beats workspace beats global', () => {
  const newI = inspected({
    defaultValue: 'graph',
    globalValue: 'viewer',
    workspaceValue: 'graph',
    workspaceFolderValue: 'viewer',
  });
  assert.equal(settings.resolveSetting(newI, inspected({ defaultValue: 'graph' })), 'viewer');
});

test('old key: workspaceFolder beats workspace beats global, used only because the new key is unset', () => {
  const oldI = inspected({
    defaultValue: 'splitRight',
    globalValue: 'sameGroup',
    workspaceValue: 'splitRight',
    workspaceFolderValue: 'sameGroup',
  });
  assert.equal(settings.resolveSetting(inspected({ defaultValue: 'splitRight' }), oldI), 'sameGroup');
});

test('boolean setting: explicit false on the new key is respected, not treated as unset', () => {
  const newI = inspected({ defaultValue: true, globalValue: false });
  const oldI = inspected({ defaultValue: true });
  assert.equal(settings.resolveSetting(newI, oldI), false);
});

test('explicitValue returns undefined when nothing is set in any scope', () => {
  assert.equal(settings.explicitValue(inspected({ defaultValue: 'graph' })), undefined);
});

test('resolveSetting handles a missing old inspect result (e.g. key never registered) gracefully', () => {
  const newI = inspected({ defaultValue: 'graph' });
  assert.equal(settings.resolveSetting(newI, undefined), 'graph');
});
