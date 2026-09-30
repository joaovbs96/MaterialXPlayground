// Theme runtime: resolves the active theme and exposes token helpers as window.MtlxTheme.
// Eager classic script; loads after js/shared/theme-tokens.js and before any stylesheet.
// Preference is light | dark | system (default system); current() is the resolved light | dark.
(function (root) {
    'use strict';

    const DATA = root.MTLX_THEME_TOKENS || { themes: { dark: {} }, params: { dark: {} } };
    const FALLBACK = 'dark';
    const EVENT = 'mtlx-theme-change';
    const KEY = 'mtlxTheme';
    const SCHEME_QUERY = '(prefers-color-scheme: dark)';
    let theme = null;
    let preference = null;
    let shown = null;
    let mql = null;
    let bodyObserved = false;

    function normalize(p) {
        if (p === 'auto') return 'system';
        return p === 'light' || p === 'dark' || p === 'system' ? p : null;
    }

    function canPersist() {
        return !root.__MTLX_EMBED && !root.__MTLX_THEME_NO_PERSIST__;
    }

    function readStored() {
        if (!canPersist()) return null;
        try { return normalize(root.localStorage && root.localStorage.getItem(KEY)); } catch (e) { return null; }
    }

    function persist(p) {
        if (!canPersist()) return;
        try {
            if (typeof root.__mtlxThemePersist === 'function') root.__mtlxThemePersist(p);
            else if (root.localStorage) root.localStorage.setItem(KEY, p);
        } catch (e) { /* storage blocked */ }
    }

    // VS Code: body class first (live), then the injected kind, else dark. High contrast light maps to light.
    function vscodeTheme() {
        const body = root.document && root.document.body;
        const cl = body && body.classList;
        if (cl) {
            if (cl.contains('vscode-high-contrast-light') || cl.contains('vscode-light')) return 'light';
            if (cl.contains('vscode-dark') || cl.contains('vscode-high-contrast')) return 'dark';
        }
        const k = root.__MTLX_VSCODE_THEME_KIND__;
        return k === 'light' || k === 'highContrastLight' ? 'light' : 'dark';
    }

    function systemTheme() {
        if (root.__MTLX_VSCODE__) return vscodeTheme();
        return mql && mql.matches === false ? 'light' : 'dark';
    }

    function resolveTheme() {
        const t = preference === 'system' ? systemTheme() : preference;
        return DATA.themes && DATA.themes[t] ? t : FALLBACK;
    }

    // Reads the current theme's map on every call (no cache), so a theme switch is visible at once.
    function get(token) {
        const map = DATA.themes[theme] || {};
        return token in map ? map[token] : DATA.themes[FALLBACK][token];
    }

    function writeDom() {
        const doc = root.document;
        try {
            if (doc && doc.documentElement) doc.documentElement.dataset.theme = theme;
            const meta = doc && doc.querySelector && doc.querySelector('meta[name="theme-color"]');
            if (meta) meta.setAttribute('content', get('surface-base'));
        } catch (e) { /* no DOM */ }
    }

    // Re-resolve, write the DOM and notify only when the resolved theme or the preference changed.
    function update(silent) {
        const next = resolveTheme();
        const changed = next !== theme || preference !== shown;
        theme = next;
        shown = preference;
        writeDom();
        if (!changed || silent) return;
        try {
            if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
                root.dispatchEvent(new root.CustomEvent(EVENT, { detail: { theme: theme, preference: preference } }));
            }
        } catch (e) { /* no events */ }
    }

    function setPreference(pref, opts) {
        const p = normalize(pref);
        if (!p) return;
        preference = p;
        if (!opts || opts.persist !== false) persist(p);
        update(false);
    }

    function onChange(cb) {
        if (typeof root.addEventListener !== 'function') return function () {};
        const handler = function (e) {
            const d = e && e.detail;
            cb({ theme: d && d.theme ? d.theme : theme, preference: d && d.preference ? d.preference : preference });
        };
        root.addEventListener(EVENT, handler);
        return function () { root.removeEventListener(EVENT, handler); };
    }

    function typeFallback() {
        const p = (DATA.params && (DATA.params[theme] || DATA.params[FALLBACK])) || {};
        return Object.assign({}, p.typeFallback);
    }

    // Numeric theme param (params.<theme>.<group>.<key>), falling back to dark, then to `fallback`.
    function param(group, key, fallback) {
        const pick = function (t) { const g = DATA.params && DATA.params[t] && DATA.params[t][group]; return g && typeof g[key] === 'number' ? g[key] : undefined; };
        const v = pick(theme);
        return v !== undefined ? v : (pick(FALLBACK) !== undefined ? pick(FALLBACK) : fallback);
    }

    function tailwindConfig() {
        const colors = {};
        Object.keys(DATA.themes[FALLBACK] || {}).forEach(function (t) {
            colors[t] = 'rgb(var(--mtlx-' + t + ') / <alpha-value>)';
        });
        return { theme: { extend: { colors: colors } } };
    }

    function observeBody() {
        const doc = root.document;
        if (bodyObserved || !doc || !doc.body || typeof root.MutationObserver !== 'function') return;
        bodyObserved = true;
        try {
            new root.MutationObserver(function () { if (preference === 'system') update(false); })
                .observe(doc.body, { attributes: true, attributeFilter: ['class'] });
        } catch (e) { /* no observer */ }
    }

    function watchSystem() {
        if (root.__MTLX_VSCODE__) {
            observeBody();
            const doc = root.document;
            if (!bodyObserved && doc && typeof doc.addEventListener === 'function') {
                doc.addEventListener('DOMContentLoaded', function () {
                    observeBody();
                    if (preference === 'system') update(false);
                });
            }
            return;
        }
        try { mql = typeof root.matchMedia === 'function' ? root.matchMedia(SCHEME_QUERY) : null; } catch (e) { mql = null; }
        if (!mql) return;
        const onScheme = function () { if (preference === 'system') update(false); };
        if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onScheme);
        else if (typeof mql.addListener === 'function') mql.addListener(onScheme);
    }

    preference = normalize(root.__MTLX_THEME_PREF__) || readStored() || 'system';
    watchSystem();
    update(true);

    // Other tabs: follow a changed stored preference without writing it back.
    if (typeof root.addEventListener === 'function' && canPersist()) {
        root.addEventListener('storage', function (e) {
            if (e && e.key && e.key !== KEY) return;
            const p = normalize(e && e.newValue) || 'system';
            if (p === preference) return;
            preference = p;
            update(false);
        });
    }

    root.MtlxTheme = {
        current: function () { return theme; },
        getPreference: function () { return preference; },
        setPreference: setPreference,
        get: get,
        var: function (token) { return 'rgb(var(--mtlx-' + token + '))'; },
        // Legacy rgba() quantizes alpha to 8 bits; match it so composited pixels stay identical.
        rgba: function (token, a) { return 'rgb(var(--mtlx-' + token + ') / calc(' + Math.round(a * 255) + ' / 255))'; },
        onChange: onChange,
        typeFallback: typeFallback,
        param: param,
        tailwindConfig: tailwindConfig,
    };
})(typeof self !== 'undefined' ? self : this);
