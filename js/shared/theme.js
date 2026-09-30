// Theme runtime: resolves the active theme and exposes token helpers as window.MtlxTheme.
// Eager classic script; loads after js/shared/theme-tokens.js and before any stylesheet.
(function (root) {
    'use strict';

    const DATA = root.MTLX_THEME_TOKENS || { themes: { dark: {} }, params: { dark: {} } };
    const FALLBACK = 'dark';
    const EVENT = 'mtlx-theme-change';
    let theme = FALLBACK;

    // Phase 1: no stored or system preference yet, always the dark theme.
    function resolvePreference() {
        return FALLBACK;
    }

    function resolveTheme() {
        const pref = resolvePreference();
        return DATA.themes && DATA.themes[pref] ? pref : FALLBACK;
    }

    function apply() {
        theme = resolveTheme();
        try {
            if (root.document && root.document.documentElement) root.document.documentElement.dataset.theme = theme;
        } catch (e) { /* no DOM */ }
    }

    function get(token) {
        const map = DATA.themes[theme] || {};
        return token in map ? map[token] : DATA.themes[FALLBACK][token];
    }

    function onChange(cb) {
        if (typeof root.addEventListener !== 'function') return function () {};
        const handler = function (e) { cb(e && e.detail ? e.detail.theme : theme); };
        root.addEventListener(EVENT, handler);
        return function () { root.removeEventListener(EVENT, handler); };
    }

    function typeFallback() {
        const p = (DATA.params && (DATA.params[theme] || DATA.params[FALLBACK])) || {};
        return Object.assign({}, p.typeFallback);
    }

    function tailwindConfig() {
        const colors = {};
        Object.keys(DATA.themes[FALLBACK] || {}).forEach(function (t) {
            colors[t] = 'rgb(var(--mtlx-' + t + ') / <alpha-value>)';
        });
        return { theme: { extend: { colors: colors } } };
    }

    apply();

    root.MtlxTheme = {
        current: function () { return theme; },
        get: get,
        var: function (token) { return 'rgb(var(--mtlx-' + token + '))'; },
        // Legacy rgba() quantizes alpha to 8 bits; match it so composited pixels stay identical.
        rgba: function (token, a) { return 'rgb(var(--mtlx-' + token + ') / calc(' + Math.round(a * 255) + ' / 255))'; },
        onChange: onChange,
        typeFallback: typeFallback,
        tailwindConfig: tailwindConfig,
    };
})(typeof self !== 'undefined' ? self : this);
