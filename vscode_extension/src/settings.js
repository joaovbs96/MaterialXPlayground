// settings.js: pure resolver for the materialxPlayground.* settings and
// their deprecated materialx.* twins. Must NOT require('vscode') (see
// util.js's file banner for why some modules keep this rule) -- so
// resolveSetting() is exercised directly in plain Node unit tests. The
// vscode-facing wrapper lives in settingsHost.js.
'use strict';

// VS Code's own scope precedence for a single configuration section,
// highest first. workspaceFolderValue only exists when the setting is
// resource-scoped and a folder is open; languageId-scoped variants are
// intentionally not consulted here, none of the three settings this
// resolver covers are language-scoped.
const SCOPE_KEYS = ['workspaceFolderValue', 'workspaceValue', 'globalValue'];

// Returns the first explicitly-set value across `inspected`'s scopes
// (workspaceFolder, then workspace, then global), or undefined if the
// setting was left at its default in every scope. `inspected` is the
// object vscode.WorkspaceConfiguration#inspect(key) returns (or an
// equivalent plain object in tests).
function explicitValue(inspected) {
    if (!inspected) return undefined;
    for (const scopeKey of SCOPE_KEYS) {
        if (inspected[scopeKey] !== undefined) return inspected[scopeKey];
    }
    return undefined;
}

// resolveSetting(newInspected, oldInspected): the effective value for one
// setting, given the inspect() results of its materialxPlayground.* name
// and its deprecated materialx.* twin. An explicitly set new-key value
// wins over an explicitly set old-key value, which wins over the
// (new-key) default. Never writes or migrates anything -- this is a pure
// read-side fallback.
function resolveSetting(newInspected, oldInspected) {
    const fromNew = explicitValue(newInspected);
    if (fromNew !== undefined) return fromNew;
    const fromOld = explicitValue(oldInspected);
    if (fromOld !== undefined) return fromOld;
    return newInspected ? newInspected.defaultValue : undefined;
}

module.exports = { resolveSetting, explicitValue, SCOPE_KEYS };
