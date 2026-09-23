// settingsHost.js: thin vscode-facing wrapper around settings.js's pure
// resolveSetting(). Every extension.js/editorProvider.js read of
// defaultView, openBehavior or autoOpenPlayground goes through
// getSetting() here, so the materialxPlayground.* / deprecated materialx.*
// fallback logic lives in exactly one place.
'use strict';

const vscode = require('vscode');
const { resolveSetting } = require('./settings');

const NEW_SECTION = 'materialxPlayground';
const OLD_SECTION = 'materialx';

// getSetting('defaultView' | 'openBehavior' | 'autoOpenPlayground'):
// reads both the current materialxPlayground.<key> and the deprecated
// materialx.<key> fresh from vscode.workspace.getConfiguration() (never
// cached, so this always reflects the latest onDidChangeConfiguration
// event for either name) and returns the effective value.
function getSetting(key) {
    const newInspected = vscode.workspace.getConfiguration(NEW_SECTION).inspect(key);
    const oldInspected = vscode.workspace.getConfiguration(OLD_SECTION).inspect(key);
    return resolveSetting(newInspected, oldInspected);
}

// True if a workspace.onDidChangeConfiguration event `e` affects either
// the new or the deprecated old name for `key` -- callers that want to
// react live to either name should gate on this instead of hand-rolling
// two affectsConfiguration() checks.
function affectsSetting(e, key) {
    return e.affectsConfiguration(NEW_SECTION + '.' + key) || e.affectsConfiguration(OLD_SECTION + '.' + key);
}

module.exports = { getSetting, affectsSetting };
