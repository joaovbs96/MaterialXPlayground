// Theme preference helpers for the Electron main process: pure, no electron import (tests/unit/electron-theme-prefs.test.mjs).
// Only registry entries this host offers count: no `hosts`, or hosts naming electron or web (the renderer's theme.js host),
// with a fixed dark or light base. 'vscode' (base auto, hosts ['vscode']) is not one, so a stored 'vscode' reads as 'system'.
'use strict';

function electronRegistry(registry) {
    return (registry || []).filter((e) => e && (!e.hosts || e.hosts.includes('electron') || e.hosts.includes('web'))
        && (e.base === 'dark' || e.base === 'light'));
}

function themePrefs(registry) {
    return ['system'].concat(electronRegistry(registry).map((e) => e.id));
}

// Stored or injected preference to a usable one: unknown ids, and ids of other hosts, become 'system'.
function normalizeThemePref(value, registry) {
    return themePrefs(registry).includes(value) ? value : 'system';
}

function themeBase(pref, registry) {
    const t = electronRegistry(registry).find((x) => x.id === pref);
    return t ? t.base : 'dark';
}

module.exports = { electronRegistry, themePrefs, normalizeThemePref, themeBase };
