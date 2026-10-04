// Theme runtime: resolves the active theme and exposes token helpers as window.MtlxTheme.
// Eager classic script; loads after js/shared/theme-tokens.js and before any stylesheet.
// Preference is system, a registry id or custom:<slug>; current() is the applied theme id, currentBase() its base.
// Custom themes live in js/shared/theme-custom.js: parser-inserted when the initial preference is one, else loaded on
// first use. Until then list() shows the web store's cached labels and the custom API calls load it.
(function (root) {
    'use strict';

    const DATA = root.MTLX_THEME_TOKENS || { themes: { dark: {} }, params: { dark: {} } };
    const REG = DATA.registry || [];
    const FALLBACK = 'dark';
    const EVENT = 'mtlx-theme-change';
    const KEY = 'mtlxTheme';
    const doc = root.document;
    const me = doc && doc.currentScript;
    // Presets sit beside this script (js/shared/theme.js -> js/gen/themes/), so every host's base URL works.
    const BASE = me && me.src ? me.src.replace(/js\/shared\/theme\.js([?#].*)?$/, '') : '';
    const DIR = BASE + 'js/gen/themes/';
    const CODE = /^\s*mtlx\d+\./;
    const SLUG = /^custom:[a-z0-9-]{1,40}$/;
    const CKEY = 'mtlxCustomThemes';
    const done = { dark: true, light: true };
    const asked = {};
    let ext = null;
    let extQueue = null;
    let extWritten = false;
    let userSet = false;
    let cache = [];
    let unlabelled = false;
    let booting = true;
    let theme = null;
    let want = null;
    let preference = null;
    let shown = null;
    let mql = null;
    let bodyObserved = false;

    function entry(id) {
        for (let i = 0; i < REG.length; i++) if (REG[i].id === id) return REG[i];
        return null;
    }

    function baseOf(id) { const e = entry(id), b = (DATA.bases || {})[id] || e && e.base; return b === 'auto' ? baseOf(systemTheme()) : b === 'light' ? 'light' : 'dark'; }

    // Theme codes and custom ids need theme-custom.js; until it is in, a code means dark.
    function normalize(p) {
        if (p === 'auto' || p === 'system') return 'system';
        if (typeof p !== 'string') return null;
        return (ext ? ext.normalize(p) : CODE.test(p) ? FALLBACK : null) || (entry(p) ? p : null);
    }

    // List entries from the web store ({ code, id, label, base }; labels are display data, the code is decoded later).
    // Injected host codes and bare codes carry no label: list() then loads theme-custom.js.
    function readCache() {
        const inj = root.__MTLX_CUSTOM_THEMES__;
        unlabelled = Array.isArray(inj) && inj.length > 0;
        cache = [];
        if (Array.isArray(inj) || !canPersist()) return;
        let v = [];
        try { v = JSON.parse(root.localStorage.getItem(CKEY) || '[]'); } catch (e) { /* empty */ }
        (Array.isArray(v) ? v : []).slice(0, 50).forEach(function (x) {
            if (x && /^\s*mtlx1\./.test(String(x.code))) unlabelled = true;
            else if (x && SLUG.test(x.id) && typeof x.label === 'string' && x.label.length <= 80 && !/[\u0000-\u001f<>]/.test(x.label) && /^(dark|light)$/.test(x.base)) cache.push({ id: x.id, label: x.label, base: x.base });
            else if (x) unlabelled = true;
        });
    }

    function emit(type, detail) {
        try { root.dispatchEvent(new root.CustomEvent(type, { detail: detail })); } catch (e) { /* no events */ }
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

    // VS Code: body class first (live), then the injected kind, else dark. High contrast maps to hc-dark / hc-light.
    function vscodeTheme() {
        const cl = doc && doc.body && doc.body.classList;
        if (cl) {
            if (cl.contains('vscode-high-contrast-light')) return 'hc-light';
            if (cl.contains('vscode-high-contrast')) return 'hc-dark';
            if (cl.contains('vscode-light')) return 'light';
            if (cl.contains('vscode-dark')) return 'dark';
        }
        const k = root.__MTLX_VSCODE_THEME_KIND__;
        return k === 'light' ? 'light' : k === 'highContrastLight' ? 'hc-light' : k === 'highContrast' ? 'hc-dark' : 'dark';
    }

    function systemTheme() {
        if (root.__MTLX_VSCODE__) return vscodeTheme();
        return mql && mql.matches === false ? 'light' : 'dark';
    }

    // vscode: system outside VS Code and for high contrast kinds.
    function resolveTheme() {
        const t = preference === 'system' || preference === 'vscode' && !(root.__MTLX_VSCODE__ && vscodeTheme().indexOf('hc-')) ? systemTheme() : preference;
        return ext && ext.resolve(t) || (entry(t) ? t : FALLBACK);
    }

    // Current theme's map, then its base, then dark; read on every call so a switch is visible at once.
    function get(token) {
        const map = DATA.themes[theme] || DATA.themes[baseOf(theme)] || {};
        return token in map ? map[token] : DATA.themes[FALLBACK][token];
    }

    function writeDom() {
        try {
            const el = doc && doc.documentElement;
            if (el) { el.dataset.theme = theme; el.dataset.themeBase = baseOf(theme); }
            const meta = doc && doc.querySelector && doc.querySelector('meta[name="theme-color"]');
            if (meta) meta.setAttribute('content', get('surface-base'));
        } catch (e) { /* no DOM */ }
    }

    // Apply a ready theme; notify only when the applied theme or the preference changed.
    function commit(next, silent, force) {
        const changed = force || next !== theme || preference !== shown;
        theme = next;
        shown = preference;
        writeDom();
        if (!changed || silent) return;
        try {
            if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
                root.dispatchEvent(new root.CustomEvent(EVENT, { detail: { theme: theme, base: baseOf(theme), preference: preference } }));
            }
        } catch (e) { /* no events */ }
    }

    // js/gen/themes/<id>.js registers the map, adds its CSS, then calls DATA.loaded(id). During this script's
    // own run it is document.written, which blocks first paint (no flash).
    function request(id) {
        if (asked[id]) return;
        asked[id] = true;
        if (ext && ext.request(id)) return;
        const src = DIR + id + '.js';
        if (booting && me && !me.async && doc.readyState === 'loading') return doc.write('<script src="' + src + '"><\/script>');
        if (!doc || !doc.head) return;
        const s = doc.createElement('script');
        s.onerror = function () { asked[id] = false; };
        s.src = src;
        doc.head.appendChild(s);
    }

    DATA.loaded = function (id, force) { done[id] = true; if (id === want) commit(id, false, force); };

    // A preset not yet loaded keeps the previous theme (first run: the preset's base) until DATA.loaded.
    function update(silent, force) {
        want = resolveTheme();
        if (DATA.themes[want] && done[want]) return commit(want, silent, force);
        if (theme === null) commit(baseOf(want), true);
        request(want);
    }

    function setPreference(pref, opts) {
        if (!ext && (CODE.test(pref) || SLUG.test(pref))) return loadExt(function () { if (ext || CODE.test(pref)) setPreference(ext ? pref : FALLBACK, opts); });
        const p = normalize(pref);
        if (!p) return;
        userSet = true;
        preference = p;
        if (!opts || opts.persist !== false) persist(p);
        update(false);
    }

    function onChange(cb) {
        if (typeof root.addEventListener !== 'function') return function () {};
        const handler = function () { cb({ theme: theme, base: baseOf(theme), preference: preference }); };
        root.addEventListener(EVENT, handler);
        return function () { root.removeEventListener(EVENT, handler); };
    }

    // Keeps a <materialx-viewer> on the site's preference (system maps to auto, a custom theme to its code).
    function bindEmbed(el) {
        const apply = function (pref) { el.theme = pref === 'system' ? 'auto' : ext && ext.code(pref) || pref; };
        apply(preference);
        return onChange(function (d) { apply(d.preference); });
    }

    function params(t) { return (DATA.params || {})[t] || {}; }

    function typeFallback() {
        return Object.assign({}, params(theme).typeFallback || params(baseOf(theme)).typeFallback || params(FALLBACK).typeFallback);
    }

    // Numeric theme param (params.<theme>.<group>.<key>), falling back to the base, then dark, then `fallback`.
    function param(group, key, fallback) {
        const v = [theme, baseOf(theme), FALLBACK].map(function (t) { return (params(t)[group] || {})[key]; })
            .filter(function (x) { return typeof x === 'number'; })[0];
        return v === undefined ? fallback : v;
    }

    function tailwindConfig() {
        const colors = {};
        Object.keys(DATA.themes[FALLBACK] || {}).forEach(function (t) {
            colors[t] = 'rgb(var(--mtlx-' + t + ') / <alpha-value>)';
        });
        return { theme: { extend: { colors: colors } } };
    }

    function observeBody() {
        if (bodyObserved || !doc || !doc.body || typeof root.MutationObserver !== 'function') return;
        bodyObserved = true;
        try {
            new root.MutationObserver(function () { update(false); })
                .observe(doc.body, { attributes: true, attributeFilter: ['class'] });
        } catch (e) { /* no observer */ }
    }

    function watchSystem() {
        if (root.__MTLX_VSCODE__) {
            observeBody();
            if (!bodyObserved && doc && typeof doc.addEventListener === 'function') {
                doc.addEventListener('DOMContentLoaded', function () {
                    observeBody();
                    update(false);
                });
            }
            return;
        }
        try { mql = typeof root.matchMedia === 'function' ? root.matchMedia('(prefers-color-scheme: dark)') : null; } catch (e) { mql = null; }
        if (!mql) return;
        const onScheme = function () { update(false); };
        if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onScheme);
        else if (typeof mql.addListener === 'function') mql.addListener(onScheme);
    }

    // theme-custom.js registers here; parser-inserted, it runs right after this script, still before first paint.
    function loadExt(cb) {
        if (ext) return cb();
        if (extQueue) return extQueue.push(cb);
        extQueue = [cb];
        const src = BASE + 'js/shared/theme-custom.js';
        const fail = function () { const q = extQueue || []; extQueue = null; q.forEach(function (f) { f(); }); };
        if (booting && me && !me.async && doc.readyState === 'loading') { extWritten = true; return doc.write('<script src="' + src + '"><\/script>'); }
        if (!doc || !doc.head) return fail();
        const s = doc.createElement('script');
        s.onerror = fail;
        s.src = src;
        doc.head.appendChild(s);
    }

    DATA.installCustom = function (factory) {
        if (ext) return;
        booting = extWritten && doc.readyState === 'loading';
        ext = factory({
            DATA: DATA, BASE: BASE, done: done, asked: asked, entry: entry, update: update, persist: persist, canPersist: canPersist,
            emit: emit,
            pref: function (p) { if (p !== undefined) preference = p; return preference; },
            parsing: function () { return booting && me && !me.async && doc.readyState === 'loading'; },
        });
        Object.assign(root.MtlxTheme || {}, ext.api);
        const p = !userSet && (normalize(root.__MTLX_THEME_PREF__) || readStored());
        if (p && p !== preference) { preference = p; update(booting); }
        booting = false;
        const list = ext.api.listCustom();
        if (list.length) emit('mtlx-custom-themes-change', { themes: list });
        const q = extQueue || [];
        extQueue = null;
        q.forEach(function (f) { f(); });
    };

    readCache();
    const inj = root.__MTLX_THEME_PREF__;
    let stored = null;
    try { stored = canPersist() && root.localStorage.getItem(KEY); } catch (e) { /* blocked */ }
    preference = normalize(inj) || readStored() || 'system';
    watchSystem();
    update(true);
    // Before first paint only when the initial preference is a code or a custom theme that may exist.
    if (CODE.test(inj || '') || (SLUG.test(inj) || !normalize(inj) && SLUG.test(stored)) && (cache.length || unlabelled)) loadExt(function () {});
    booting = false;

    // Other tabs: follow a changed stored preference without writing it back.
    if (typeof root.addEventListener === 'function' && canPersist()) {
        root.addEventListener('storage', function (e) {
            if (ext && ext.storage(e)) return;
            if (e && e.key === CKEY) { readCache(); return emit('mtlx-custom-themes-change', {}); }
            if (e && e.key && e.key !== KEY) return;
            const p = normalize(e && e.newValue) || 'system';
            if (p === preference) return;
            preference = p;
            update(false);
        });
    }

    const api = root.MtlxTheme = {
        current: function () { return theme; },
        currentBase: function () { return baseOf(theme); },
        list: function () { return REG.filter(function (e) { return !e.hosts || e.hosts.indexOf(root.__MTLX_VSCODE__ ? 'vscode' : 'web') >= 0; }).map(function (e) { return Object.assign({}, e); }).concat(ext ? ext.entries() : lazyList()); },
        getPreference: function () { return preference; },
        setPreference: setPreference,
        get: get,
        var: function (token) { return 'rgb(var(--mtlx-' + token + '))'; },
        // Legacy rgba() quantizes alpha to 8 bits; match it so composited pixels stay identical.
        rgba: function (token, a) { return 'rgb(var(--mtlx-' + token + ') / calc(' + Math.round(a * 255) + ' / 255))'; },
        onChange: onChange,
        bindEmbed: bindEmbed,
        typeFallback: typeFallback,
        param: param,
        tailwindConfig: tailwindConfig,
    };
    function lazyList() {
        if (unlabelled) loadExt(function () {});
        return cache.map(function (c) { return { id: c.id, label: c.label, base: c.base, group: 'custom', contrast: 'AA' }; });
    }

    // Custom theme API (contract in docs/local/theme-tokens.md) until theme-custom.js is in: the async calls load it
    // first (the first five names); setCustomThemes and deleteCustom run once it is in; listCustom, encodeTheme and decodeTheme start loading
    // it (mtlx-custom-themes-change follows) and meanwhile return [] or throw a short "still loading" error.
    'saveCustom previewDraft loadEngine getTokenGroups resolveCustomTheme setCustomThemes deleteCustom listCustom encodeTheme decodeTheme clearDraft'.split(' ').forEach(function (n, i) {
        api[n] = function () {
            const a = arguments;
            if (i < 5) return new Promise(function (res, rej) { loadExt(function () { if (ext) res(ext.api[n].apply(null, a)); else rej(new Error('Custom themes could not be loaded')); }); });
            if (i > 9) return;
            loadExt(function () { if (ext && i < 7) ext.api[n].apply(null, a); });
            if (i > 7) throw new Error('Theme tools are still loading; try again in a moment');
            return i === 6 ? cache.some(function (c) { return c.id === a[0]; }) : [];
        };
    });
})(typeof self !== 'undefined' ? self : this);
