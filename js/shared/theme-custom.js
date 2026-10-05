// Custom themes for js/shared/theme.js: theme codes, the store (host hook or localStorage), drafts and application.
// theme.js parser-inserts this file on pages that persist themes (web, Electron, VS Code) and loads it on demand in
// embeds; it registers through MTLX_THEME_TOKENS.installCustom. The engine and the contrast pairs load on demand.
(function (root) {
    'use strict';

    const d = root.MTLX_THEME_TOKENS;
    if (!d || typeof d.installCustom !== 'function') return;

    d.installCustom(function (core) {
        const DATA = core.DATA;
        const doc = root.document;
        const CKEY = 'mtlxCustomThemes';
        const DRAFT = 'custom:__draft';
        const TOKENS = Object.keys(DATA.themes.dark || {});
        const SEEDS = ['background', 'foreground', 'accent'];
        const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        const MAX = 50;
        const done = core.done;
        const asked = core.asked;
        const broken = {};
        const applied = {};
        const styles = {};
        let customs = [];
        let waiters = null;
        let groups = null;
        let draft = false;
        let draftSeq = 0;

        function custom(id) {
            for (let i = 0; i < customs.length; i++) if (customs[i].spec.id === id) return customs[i];
            return null;
        }

        // ---- Codes (untrusted): mtlx2.<base64url>. Bytes: base (0x0c dark, 0x2c light: codes start mtlx2.D or mtlx2.L),
        // the id of the built-in theme it is based on (length-prefixed, length 0 = none), seeds (3 x RGB, only without
        // a base theme), slug and UTF-8 label (length-prefixed), override count, per override the token name
        // (length-prefixed) and RGB, then, without a base theme, optionally contrast + 20 and tint in 0.05 steps.
        // Nothing else may follow.
        function bad(m, old) { const e = new Error(m); if (old) e.old = true; throw e; }
        function clip(v) { return String(v).replace(/[^\w-]/g, '?').slice(0, 24); }
        function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
        function obj(o, what) { if (!o || typeof o !== 'object' || Array.isArray(o)) bad(what + ' must be an object'); return o; }
        function keys(o, allowed, what) { Object.keys(o).forEach(function (k) { if (allowed.indexOf(k) < 0) bad('Unknown ' + what + ' "' + clip(k) + '"'); }); }
        function hex(v, what) {
            const h = typeof v === 'string' ? v.toLowerCase() : '';
            if (!/^#[0-9a-f]{6}$/.test(h)) bad(what + ' must be a #rrggbb color');
            return h;
        }
        function step(v, lo, hi, what) {
            if (typeof v !== 'number' || !isFinite(v) || v < lo || v > hi) bad(what + ' must be a number from ' + lo + ' to ' + hi);
            return Math.round(v * 20) / 20 + 0;
        }

        // Normalized copy of a spec, or throws a short user-facing Error. A draft may omit id and label.
        function validate(spec, isDraft) {
            keys(obj(spec, 'Theme'), ['v', 'id', 'label', 'base', 'from', 'seeds', 'overrides', 'modifiers'], 'theme field');
            if (spec.v !== undefined && spec.v !== 1) bad('Unsupported theme version');
            const out = { v: 1 };
            if (!isDraft || spec.id !== undefined) {
                if (typeof spec.id !== 'string' || !/^custom:[a-z0-9-]{1,40}$/.test(spec.id)) bad('Theme id must be custom: plus 1 to 40 of a-z, 0-9 and -');
                out.id = spec.id;
            }
            if (!isDraft || spec.label !== undefined) {
                const l = spec.label;
                if (typeof l !== 'string' || !l.trim() || Array.from(l).length > 40) bad('Name must be 1 to 40 characters');
                if (/[\u0000-\u001f\u007f-\u009f<>\u2028\u2029]|[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/.test(l)) bad('Name contains characters that are not allowed');
                out.label = l;
            }
            if (spec.base !== 'dark' && spec.base !== 'light') bad('Base must be dark or light');
            out.base = spec.base;
            const from = spec.from;
            if (from !== undefined) {
                const e = typeof from === 'string' ? core.entry(from) : null;
                if (!e || (e.base !== 'dark' && e.base !== 'light')) bad(typeof from === 'string' && !e && !/^custom:/.test(from) ? 'Unknown base theme "' + clip(from) + '"' : 'A theme can only be based on a built-in theme');
                if (spec.seeds !== undefined) bad('A theme based on another theme has no seeds');
                if (spec.modifiers !== undefined) bad('A theme based on another theme has no modifiers');
                if (e.base !== spec.base) bad('Base does not match the theme it is based on');
                out.from = from;
            } else {
                const seeds = obj(spec.seeds, 'Seeds');
                keys(seeds, SEEDS, 'seed');
                out.seeds = {};
                SEEDS.forEach(function (k) { out.seeds[k] = hex(seeds[k], 'Seed ' + k); });
            }
            const ov = spec.overrides === undefined ? {} : obj(spec.overrides, 'Overrides');
            keys(ov, TOKENS, 'color role');
            out.overrides = {};
            TOKENS.forEach(function (t) { if (own(ov, t)) out.overrides[t] = hex(ov[t], 'Color for ' + t); });
            if (from !== undefined) return out;
            const mo = spec.modifiers === undefined ? {} : obj(spec.modifiers, 'Modifiers');
            keys(mo, ['contrast', 'tint'], 'modifier');
            out.modifiers = { contrast: step(mo.contrast === undefined ? 0 : mo.contrast, -1, 1, 'Contrast'), tint: step(mo.tint === undefined ? 0 : mo.tint, 0, 1, 'Tint') };
            return out;
        }

        function b64(b) {
            let s = '';
            for (let i = 0; i < b.length; i += 3) {
                const n = b[i] << 16 | (b[i + 1] || 0) << 8 | (b[i + 2] || 0);
                s += B64[n >> 18 & 63] + B64[n >> 12 & 63] + (i + 1 < b.length ? B64[n >> 6 & 63] : '') + (i + 2 < b.length ? B64[n & 63] : '');
            }
            return s;
        }

        function encodeTheme(spec) {
            const s = validate(spec);
            const b = [s.base === 'light' ? 0x2c : 0x0c];
            const rgb = function (h) { for (let i = 1; i < 7; i += 2) b.push(parseInt(h.substr(i, 2), 16)); };
            const str = function (t) { b.push(t.length); for (let i = 0; i < t.length; i++) b.push(t.charCodeAt(i)); };
            str(s.from || '');
            if (!s.from) SEEDS.forEach(function (k) { rgb(s.seeds[k]); });
            str(s.id.slice(7));
            str(unescape(encodeURIComponent(s.label)));
            const ks = Object.keys(s.overrides);
            b.push(ks.length);
            ks.forEach(function (t) { str(t); rgb(s.overrides[t]); });
            if (!s.from && (s.modifiers.contrast || s.modifiers.tint)) b.push(Math.round(s.modifiers.contrast * 20) + 20, Math.round(s.modifiers.tint * 20));
            return 'mtlx2.' + b64(b);
        }

        function decodeTheme(code) {
            const c = typeof code === 'string' ? code.trim() : '';
            if (c.length > 8192) bad('Theme code is too long');
            const m = /^mtlx(\d{1,3})\.([A-Za-z0-9_-]{2,})$/.exec(c);
            if (!m) bad('Not a theme code');
            if (m[1] === '1') bad('This theme code is from an older version and can no longer be read.', true);
            if (m[1] !== '2') bad('This theme code needs a newer version of the app');
            const s = m[2], b = [];
            for (let i = 0; i < s.length; i += 4) {
                let n = 0;
                for (let j = 0; j < 4; j++) n = n << 6 | (i + j < s.length ? B64.indexOf(s[i + j]) : 0);
                b.push(n >> 16 & 255);
                if (i + 2 < s.length) b.push(n >> 8 & 255);
                if (i + 3 < s.length) b.push(n & 255);
            }
            if (b64(b) !== s) bad('Damaged theme code');
            let p = 0;
            const take = function (n) { if (p + n > b.length) bad('Damaged theme code'); p += n; return b.slice(p - n, p); };
            const color = function () { return '#' + take(3).map(function (v) { return (256 + v).toString(16).slice(1); }).join(''); };
            const text = function () { return String.fromCharCode.apply(null, take(take(1)[0])); };
            const head = take(1)[0];
            if (head !== 0x0c && head !== 0x2c) bad('Damaged theme code');
            const spec = { base: head === 0x2c ? 'light' : 'dark', overrides: {} };
            const from = text();
            if (from) spec.from = from;
            else {
                spec.seeds = {};
                SEEDS.forEach(function (k) { spec.seeds[k] = color(); });
            }
            spec.id = 'custom:' + text();
            try { spec.label = decodeURIComponent(escape(text())); } catch (e) { bad('Damaged theme code'); }
            const n = take(1)[0];
            for (let i = 0; i < n; i++) {
                const t = text();
                if (TOKENS.indexOf(t) < 0) bad('Unknown color role "' + clip(t) + '"');
                if (own(spec.overrides, t)) bad('Damaged theme code');
                spec.overrides[t] = color();
            }
            if (!spec.from && p < b.length) {
                const mo = take(2);
                if (mo[0] > 40 || mo[1] > 20) bad('Damaged theme code');
                spec.modifiers = { contrast: (mo[0] - 20) / 20, tint: mo[1] / 20 };
            }
            if (p !== b.length) bad('Damaged theme code');
            return validate(spec);
        }

        // ---- Store. A temp entry (a code used as a preference, e.g. an embed) is never persisted, never replaces a
        // saved theme with the same id, and only one is kept.
        function addCustom(spec, temp) {
            const code = encodeTheme(spec);
            const old = custom(spec.id);
            if (temp && old && !old.temp) return old;
            if (temp) customs.filter(function (c) { return c.temp && c !== old; }).forEach(function (c) { drop(c.spec.id); });
            const e = { spec: spec, code: code, temp: !!temp && (!old || old.temp) };
            if (old) customs[customs.indexOf(old)] = e; else customs.push(e);
            (DATA.bases = DATA.bases || {})[spec.id] = spec.base;
            if (applied[spec.id] !== code) { done[spec.id] = false; asked[spec.id] = false; }
            return e;
        }

        function drop(id) {
            customs = customs.filter(function (c) { return c.spec.id !== id; });
            const st = styles[id];
            if (st && st.parentNode) st.parentNode.removeChild(st);
            [styles, applied, done, asked, broken, DATA.themes, DATA.params].forEach(function (m) { delete m[id]; });
        }

        // Replaces the saved list (at most MAX) from codes or web store entries ({ code, ... }); invalid ones are skipped.
        function setCodes(codes) {
            const old = customs.filter(function (c) { return !c.temp; }).map(function (c) { return c.spec.id; });
            customs = customs.filter(function (c) { return c.temp; });
            let older = 0;
            (Array.isArray(codes) ? codes : []).slice(0, MAX).forEach(function (code) {
                try {
                    const s = decodeTheme(code && typeof code === 'object' ? code.code : code);
                    const c = custom(s.id);
                    if (c && !c.temp) return;
                    if (c) customs.splice(customs.indexOf(c), 1);
                    addCustom(s, false);
                } catch (e) { if (e.old) older++; else if (root.console) root.console.warn('[theme] skipped a custom theme: ' + e.message); }
            });
            if (older && root.console) root.console.warn('[theme] skipped ' + older + ' custom theme(s) saved by an older version');
            old.forEach(function (id) { if (!custom(id)) drop(id); });
        }

        function readCodes() {
            if (Array.isArray(root.__MTLX_CUSTOM_THEMES__)) return root.__MTLX_CUSTOM_THEMES__;
            if (!core.canPersist()) return [];
            try { const v = JSON.parse(root.localStorage.getItem(CKEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
        }

        // Host hook first (Electron, VS Code: codes), else localStorage as { code, id, label, base } so theme.js can list
        // labels without this file; embeds and no-persist pages never write.
        function persistCustoms() {
            if (!core.canPersist()) return;
            const codes = customs.filter(function (c) { return !c.temp; }).map(function (c) { return c.code; });
            try {
                if (typeof root.__mtlxCustomThemesPersist === 'function') root.__mtlxCustomThemesPersist(codes);
                else if (root.localStorage) root.localStorage.setItem(CKEY, JSON.stringify(customs.filter(function (c) { return !c.temp; }).map(function (c) { return { code: c.code, id: c.spec.id, label: c.spec.label, base: c.spec.base }; })));
            } catch (e) { /* storage blocked */ }
        }

        function listCustom() { return customs.map(function (c) { return JSON.parse(JSON.stringify(c.spec)); }); }

        // ---- Application: the engine, js/gen/theme-pairs.js and, for a theme based on a preset, that preset's file
        // (js/gen/themes/<id>.js, loaded as theme.js loads presets) load parser-inserted while the head parses (applied
        // before first paint), else as scripts. cb(err) runs synchronously once everything it needs is in.
        const started = {};

        function baseReady(from) {
            return !from || from === 'dark' || from === 'light' || !!(DATA.themes[from] && DATA.params && DATA.params[from]);
        }

        function ready(from) { return !!(root.MtlxThemeEngine && DATA.customPairs && baseReady(from)); }

        function ping() {
            if (!waiters) return;
            const now = waiters.filter(function (w) { return ready(w.from); });
            if (!now.length) return;
            waiters = waiters.filter(function (w) { return now.indexOf(w) < 0; });
            if (!waiters.length) waiters = null;
            now.forEach(function (w) { w.cb(null); });
        }

        function prepare(cb, from) {
            if (ready(from)) return cb(null);
            if (waiters) waiters.push({ cb: cb, from: from });
            else waiters = [{ cb: cb, from: from }];
            DATA.ping = ping;
            if (!started.hook) {
                started.hook = true;
                const prev = DATA.onEngine;
                if (!root.MtlxThemeEngine) DATA.onEngine = function (E) { if (typeof prev === 'function') prev(E); ping(); };
                const loaded = DATA.loaded;
                DATA.loaded = function () { const r = loaded.apply(this, arguments); ping(); return r; };
            }
            const parse = core.parsing();
            const fail = function (f) {
                const w = (waiters || []).filter(function (x) { return !f || x.from === f; });
                waiters = (waiters || []).filter(function (x) { return w.indexOf(x) < 0; });
                if (!waiters.length) waiters = null;
                w.forEach(function (x) { x.cb(new Error('The theme engine could not be loaded')); });
            };
            const files = [!DATA.customPairs && 'js/gen/theme-pairs.js', !root.MtlxThemeEngine && 'js/shared/theme-engine.js'];
            const preset = from && !baseReady(from) && !asked[from] ? from : null;
            if (preset) { asked[preset] = true; files.push('js/gen/themes/' + preset + '.js'); }
            files.forEach(function (f) {
                if (!f || started[f]) return;
                started[f] = true;
                if (parse) return doc.write('<script src="' + core.BASE + f + '"><\/script>');
                if (!doc || !doc.head) return fail();
                const e = doc.createElement('script');
                e.async = false;
                e.onload = ping;
                e.onerror = function () { started[f] = false; if (f === 'js/gen/themes/' + preset + '.js') asked[preset] = false; fail(f === 'js/gen/themes/' + preset + '.js' ? preset : null); };
                e.src = core.BASE + f;
                doc.head.appendChild(e);
            });
        }

        // The built-in theme a spec is based on: its exact map and params at its own contrast level.
        function baselineOf(id) {
            const E = root.MtlxThemeEngine;
            const e = core.entry(id);
            if (!e || !baseReady(id)) return null;
            const light = id === 'light';
            return {
                tokens: light ? Object.assign({}, DATA.themes.dark, DATA.themes.light) : DATA.themes[id],
                params: id === 'dark' ? DATA.params.dark : light ? E.deriveTheme({ base: 'light', data: DATA }).params : DATA.params[id],
                level: e.contrast,
            };
        }

        function resolveSpec(spec) {
            try {
                return root.MtlxThemeEngine.resolveCustom(spec, { data: DATA, pairs: DATA.customPairs.pairs, level: DATA.customPairs.contrast, baseline: spec.from ? baselineOf(spec.from) : undefined });
            } catch (e) { return { ok: false, error: 'This theme could not be built', adjusted: [], report: [] }; }
        }

        // One <style> per applied theme: the id is a validated slug, the values #rrggbb from the engine.
        function put(id, r) {
            DATA.themes[id] = r.tokens;
            DATA.params[id] = r.params;
            (DATA.bases = DATA.bases || {})[id] = r.base;
            let st = styles[id];
            if (!st) {
                st = styles[id] = doc.createElement('style');
                st.id = 'mtlx-theme-' + id;
                (doc.head || doc.documentElement).appendChild(st);
            }
            st.textContent = root.MtlxThemeEngine.themeCss(id, r.tokens, r.params, TOKENS);
        }

        // A theme that cannot be applied (engine missing, contrast unreachable) shows its base theme instead.
        function applyCustom(id, err) {
            const c = custom(id);
            if (!c) return;
            const r = err ? { ok: false, error: err.message } : resolveSpec(c.spec);
            if (r.ok) {
                try { put(id, r); applied[id] = c.code; return DATA.loaded(id, true); } catch (e) { r.error = e.message; }
            }
            broken[id] = c.code;
            if (root.console) root.console.warn('[theme] custom theme not applied: ' + r.error);
            core.update(false);
        }

        // After the list changed: a missing custom preference falls back to system, then listeners hear about it.
        function changed() {
            const p = core.pref();
            if (p !== 'system' && !core.entry(p) && !custom(p)) core.pref('system');
            core.update(false);
            core.emit('mtlx-custom-themes-change', { themes: listCustom() });
        }

        function saveCustom(spec) {
            return new Promise(function (res) {
                let s;
                try { s = validate(spec); } catch (e) { return res({ ok: false, spec: null, adjusted: [], error: e.message }); }
                if (!custom(s.id) && customs.length >= MAX) return res({ ok: false, spec: s, adjusted: [], error: 'You can keep up to ' + MAX + ' custom themes' });
                prepare(function (err) {
                    const r = err ? { ok: false, error: err.message } : resolveSpec(s);
                    if (!r.ok) return res({ ok: false, spec: s, adjusted: [], error: r.error });
                    addCustom(s, false);
                    persistCustoms();
                    changed();
                    res({ ok: true, spec: JSON.parse(JSON.stringify(s)), adjusted: r.adjusted, error: null });
                }, s.from);
            });
        }

        function deleteCustom(id) {
            if (!custom(id)) return false;
            customs = customs.filter(function (c) { return c.spec.id !== id; });
            persistCustoms();
            if (core.pref() === id) core.persist('system');
            changed();
            drop(id);
            return true;
        }

        function setCustomThemes(codes, opts) {
            setCodes(codes);
            if (!opts || opts.persist !== false) persistCustoms();
            changed();
            return listCustom();
        }

        // Live preview as data-theme="custom:__draft"; resolves to the contrast report (uncorrected colors when not ok).
        function previewDraft(spec) {
            const n = ++draftSeq;
            return new Promise(function (res) {
                let s;
                try { s = validate(spec, true); } catch (e) { return res({ ok: false, adjusted: [], report: [], error: e.message }); }
                prepare(function (err) {
                    if (err) return res({ ok: false, adjusted: [], report: [], error: err.message });
                    const r = resolveSpec(s);
                    if (n === draftSeq && r.tokens) {
                        put(DRAFT, r);
                        draft = true;
                        done[DRAFT] = true;
                        core.update(false, true);
                    }
                    res({ ok: r.ok, adjusted: r.adjusted, report: r.report, error: r.error || null });
                }, s.from);
            });
        }

        // The resolved { ok, tokens, params, report, adjusted, error } of a code or spec without applying it (a draft
        // may omit id and label). Rejects on an invalid spec or when the engine cannot load; ok false keeps raw tokens.
        function resolveCustomTheme(input) {
            return new Promise(function (res, rej) {
                let s;
                try { s = validate(typeof input === 'string' ? decodeTheme(input) : input, true); } catch (e) { return rej(e); }
                prepare(function (err) {
                    if (err) return rej(err);
                    const r = resolveSpec(s);
                    res(JSON.parse(JSON.stringify({ ok: !!r.ok, tokens: r.tokens || {}, params: r.params || {}, report: r.report || [], adjusted: r.adjusted || [], error: r.error || null })));
                }, s.from);
            });
        }

        function clearDraft() {
            draftSeq++;
            if (!draft) return;
            draft = false;
            drop(DRAFT);
            delete DATA.bases[DRAFT];
            core.update(false);
        }

        function getTokenGroups() {
            groups = groups || new Promise(function (res, rej) {
                const out = function () { if (DATA.groups) res(DATA.groups); };
                if (DATA.groups) return out();
                DATA.onGroups = out;
                const s = doc.createElement('script');
                s.onload = out;
                s.onerror = function () { groups = null; rej(new Error('The color roles could not be loaded')); };
                s.src = core.BASE + 'js/gen/theme-groups.js';
                doc.head.appendChild(s);
            });
            return groups.then(function (g) { return JSON.parse(JSON.stringify(g)); });
        }

        setCodes(readCodes());

        return {
            // A code becomes a temp custom theme (an invalid code means dark); undefined: not a custom preference.
            normalize: function (p) {
                if (/^mtlx\d+\./.test(p.trim())) {
                    try { return addCustom(decodeTheme(p), true).spec.id; } catch (e) { return 'dark'; }
                }
                return custom(p) ? p : undefined;
            },
            resolve: function (t) {
                if (draft) return DRAFT;
                const c = custom(t);
                return c ? (broken[t] === c.code ? c.spec.base : t) : null;
            },
            request: function (id) {
                if (!custom(id)) return false;
                prepare(function (err) { applyCustom(id, err); }, custom(id).spec.from);
                return true;
            },
            entries: function () { return customs.map(function (c) { const b = c.spec.from && core.entry(c.spec.from); return { id: c.spec.id, label: c.spec.label, base: c.spec.base, group: 'custom', contrast: b ? b.contrast : 'AA' }; }); },
            code: function (id) { const c = custom(id); return c ? c.code : null; },
            storage: function (e) {
                if (!e || e.key !== CKEY) return false;
                let v = [];
                try { v = JSON.parse(e.newValue || '[]'); } catch (x) { /* empty list */ }
                setCustomThemes(v, { persist: false });
                return true;
            },
            api: {
                listCustom: listCustom,
                saveCustom: saveCustom,
                deleteCustom: deleteCustom,
                setCustomThemes: setCustomThemes,
                encodeTheme: encodeTheme,
                decodeTheme: decodeTheme,
                previewDraft: previewDraft,
                resolveCustomTheme: resolveCustomTheme,
                clearDraft: clearDraft,
                loadEngine: function () { return new Promise(function (res, rej) { prepare(function (err) { if (err) rej(err); else res(root.MtlxThemeEngine); }); }); },
                getTokenGroups: getTokenGroups,
            },
        };
    });
})(typeof self !== 'undefined' ? self : this);
