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
    return themePrefs(registry).includes(value) || isCustomPref(value) ? value : 'system';
}

// Custom themes are opaque to main: only the id shape is checked here, decoding happens in the renderer.
const CUSTOM_PREF_RE = /^custom:[a-z0-9-]{1,40}$/;
const MAX_CUSTOM_THEMES = 50;
const MAX_CUSTOM_CODE_LENGTH = 4096;

function isCustomPref(value) {
    return typeof value === 'string' && CUSTOM_PREF_RE.test(value);
}

// Stored or received code list to a safe one: strings only, length and count capped, no interpretation.
function sanitizeCustomThemes(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const c of list) {
        if (out.length >= MAX_CUSTOM_THEMES) break;
        if (typeof c === 'string' && c.length > 0 && c.length <= MAX_CUSTOM_CODE_LENGTH) out.push(c);
    }
    return out;
}

function normalizeBase(value) {
    return value === 'light' || value === 'dark' ? value : null;
}

// customBase is the renderer-reported base of a custom preference.
function themeBase(pref, registry, customBase) {
    if (isCustomPref(pref)) return normalizeBase(customBase) || 'dark';
    const t = electronRegistry(registry).find((x) => x.id === pref);
    return t ? t.base : 'dark';
}

// nativeTheme.themeSource: a custom theme with an unknown base follows the OS.
function themeSource(pref, registry, customBase) {
    if (pref === 'system') return 'system';
    if (isCustomPref(pref)) return normalizeBase(customBase) || 'system';
    return themeBase(pref, registry);
}

module.exports = {
    electronRegistry, themePrefs, normalizeThemePref, themeBase, themeSource,
    isCustomPref, sanitizeCustomThemes, normalizeBase, MAX_CUSTOM_THEMES, MAX_CUSTOM_CODE_LENGTH,
};
