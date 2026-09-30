// settingsHost.js: thin vscode-facing wrapper around settings.js's pure
// resolveSetting(). Every extension.js/editorProvider.js read of
// defaultView, openBehavior or autoOpenPlayground goes through
// getSetting() here, so the materialxPlayground.* / deprecated materialx.*
// fallback logic lives in exactly one place.
'use strict';

const vscode = require('vscode');
const { resolveSetting } = require('./settings');
const { getThemeChoices } = require('./themeChoices');

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

// Theme preference ('system' or a registry id, from the package.json enum), no deprecated twin.
const THEME_VALUES = getThemeChoices().map((c) => c.id);
function getThemePreference() {
    const v = vscode.workspace.getConfiguration(NEW_SECTION).get('theme');
    return THEME_VALUES.includes(v) ? v : 'system';
}

function setThemePreference(value) {
    if (!THEME_VALUES.includes(value)) return Promise.resolve();
    return Promise.resolve(vscode.workspace.getConfiguration(NEW_SECTION).update('theme', value, vscode.ConfigurationTarget.Global)).catch(() => {});
}

// activeColorTheme.kind mapped to the names theme.js expects.
function getThemeKind() {
    const K = vscode.ColorThemeKind;
    const kind = vscode.window.activeColorTheme && vscode.window.activeColorTheme.kind;
    if (kind === K.Light) return 'light';
    if (kind === K.HighContrast) return 'highContrast';
    if (kind === K.HighContrastLight) return 'highContrastLight';
    return 'dark';
}

module.exports = { getSetting, affectsSetting, getThemePreference, setThemePreference, getThemeKind };
