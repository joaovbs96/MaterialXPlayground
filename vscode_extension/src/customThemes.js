// Pure helpers for user-made themes in the extension host (tests/unit/vscode-custom-themes.test.mjs).
// Theme codes are untrusted: the host stores strings (type, length and count capped) and never decodes them;
// the webview decodes through MtlxTheme.decodeTheme. Sidebar labels come from the webview as {id, label} meta.
'use strict';

const CUSTOM_PREF_RE = /^custom:[a-z0-9-]{1,40}$/;
const MAX_CODES = 50;
const MAX_CODE_LENGTH = 4096;
const MAX_LABEL_LENGTH = 40;

function isCustomPref(value) {
    return typeof value === 'string' && CUSTOM_PREF_RE.test(value);
}

function sanitizeCodes(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const c of list) {
        if (out.length >= MAX_CODES) break;
        if (typeof c === 'string' && c.length > 0 && c.length <= MAX_CODE_LENGTH) out.push(c);
    }
    return out;
}

// Sidebar entries: id must match the slug shape, label is plain text (rendered with textContent).
function sanitizeMeta(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const m of list) {
        if (out.length >= MAX_CODES) break;
        if (m && isCustomPref(m.id) && typeof m.label === 'string' && m.label.length > 0) {
            out.push({ id: m.id, label: m.label.slice(0, MAX_LABEL_LENGTH) });
        }
    }
    return out;
}

function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Adds data-custom-themes (JSON array of codes) after the theme-kind attribute of the bootstrap script tag.
function injectCustomThemes(html, codes) {
    const attr = ' data-custom-themes="' + escapeAttr(JSON.stringify(sanitizeCodes(codes))) + '"';
    return html.replace(/(data-vscode-theme-kind="[^"]*")/, (m) => m + attr);
}

module.exports = { CUSTOM_PREF_RE, MAX_CODES, MAX_CODE_LENGTH, isCustomPref, sanitizeCodes, sanitizeMeta, escapeAttr, injectCustomThemes };
