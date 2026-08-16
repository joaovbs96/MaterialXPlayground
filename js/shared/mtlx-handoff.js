// js/shared/mtlx-handoff.js: thin contract between the site-header
// update banner and a view's registered autosave hooks.
//
// Views call MtlxHandoff.register(view, hooks); capture() runs before
// a self-triggered reload, delegating to save(), which must persist
// durably and mark continue-intent before resolving truthy. Storage
// lives in js/shared/mtlx-autosave.js. Plain ES5, loaded eagerly.

(function () {
    'use strict';

    // view name -> { hasWork, canSave, save, exportForUser }
    var registry = {};

    function register(view, hooks) {
        registry[view] = hooks || {};
    }

    // First registered view that currently reports work, or null. There
    // is only ever one active view at a time, so "first with work" is
    // the whole selection policy.
    function findActiveHooks() {
        var views = Object.keys(registry);
        for (var i = 0; i < views.length; i++) {
            var hooks = registry[views[i]];
            var has = false;
            try { has = !!(hooks && hooks.hasWork && hooks.hasWork()); } catch (e) { has = false; }
            if (has) return { view: views[i], hooks: hooks };
        }
        return null;
    }

    function hasWork() {
        return !!findActiveHooks();
    }

    function canSave() {
        var active = findActiveHooks();
        if (!active) return { ok: true, reason: null, bytes: 0 };
        try {
            var res = active.hooks.canSave ? active.hooks.canSave() : null;
            if (res && typeof res === 'object') {
                return {
                    ok: res.ok !== false,
                    reason: typeof res.reason === 'string' ? res.reason : null,
                    bytes: typeof res.bytes === 'number' ? res.bytes : 0,
                };
            }
        } catch (e) {
            return { ok: false, reason: 'could not check handoff readiness', bytes: 0 };
        }
        return { ok: true, reason: null, bytes: 0 };
    }

    function exportForUser() {
        var active = findActiveHooks();
        if (!active || !active.hooks.exportForUser) return;
        try { active.hooks.exportForUser(); } catch (e) { /* best-effort */ }
    }

    // Delegates to the active view's save() hook (durable persistence
    // lives in js/shared/mtlx-autosave.js). Never rejects; resolves
    // false on any failure so a caller never needs a catch of its own.
    function capture() {
        var active = findActiveHooks();
        if (!active || !active.hooks.save) return Promise.resolve(false);
        var gate;
        try {
            gate = active.hooks.canSave ? active.hooks.canSave() : { ok: true };
        } catch (e) {
            gate = { ok: false };
        }
        if (!gate || gate.ok === false) return Promise.resolve(false);

        return Promise.resolve()
            .then(function () { return active.hooks.save(); })
            .then(function (saved) {
                if (!saved) return false;
                // Suppress the next beforeunload prompt (this reload is
                // intentional); re-armed after 3s so an aborted reload
                // does not silently disarm a later genuine close.
                window.__mtlxSuppressUnloadPrompt = true;
                setTimeout(function () {
                    window.__mtlxSuppressUnloadPrompt = false;
                }, 3000);
                return true;
            })
            .catch(function () { return false; });
    }

    window.MtlxHandoff = {
        register: register,
        hasWork: hasWork,
        canSave: canSave,
        capture: capture,
        exportForUser: exportForUser,
    };
})();
