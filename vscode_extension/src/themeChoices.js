// Theme choices for the materialxPlayground.theme setting, derived from the
// root package.json enum so the host and the sidebar never drift from it.
// A unit test keeps that enum equal to the registry in js/shared/theme-tokens.js.
'use strict';

const pkg = require('../../package.json');

const VSCODE = { id: 'vscode', label: 'Match VS Code', group: 'system' };
const SYSTEM = { id: 'system', label: 'System', group: 'system' };

function groupOf(id) {
    if (id === 'light' || id === 'dark') return 'standard';
    if (id.startsWith('hc-')) return 'accessibility';
    return 'presets';
}

// Built from the enum and its enumDescriptions (registry labels).
function buildThemeChoices(configProps) {
    const raw = (configProps || {})['materialxPlayground.theme'] || {};
    // The setting is anyOf [enum of built-ins, custom:<slug> pattern]; a plain enum shape still works.
    const prop = Array.isArray(raw.anyOf) ? (raw.anyOf.find((x) => x && Array.isArray(x.enum)) || {}) : raw;
    const ids = Array.isArray(prop.enum) ? prop.enum : ['vscode', 'system'];
    const descs = Array.isArray(prop.enumDescriptions) ? prop.enumDescriptions : [];
    return ids.map((id, i) => {
        if (id === 'vscode') return VSCODE;
        if (id === 'system') return SYSTEM;
        return { id, label: String(descs[i] || id).replace(/\.$/, ''), group: groupOf(id) };
    });
}

function getThemeChoices() {
    const cfg = pkg.contributes && pkg.contributes.configuration;
    return buildThemeChoices(cfg && cfg.properties);
}

module.exports = { buildThemeChoices, getThemeChoices, groupOf };
