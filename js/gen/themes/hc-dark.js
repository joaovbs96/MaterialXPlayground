// GENERATED FILE, DO NOT EDIT BY HAND. Theme "hc-dark" resolved from the presets in scripts/theme-tokens-meta.mjs
// by scripts/build-theme.mjs (js/shared/theme-engine.js: recipes, then the contrast pass).
(function (root) {
    'use strict';
    var id = "hc-dark";
    var base = "dark";
    var tokens = {
        "surface-base": "#000000",
        "surface-raised": "#020202",
        "surface-sunken": "#000000",
        "surface-card": "#000000",
        "chrome": "#000000",
        "control": "#020202",
        "chip": "#191919",
        "stage": "#000000",
        "stage-fg-muted": "#959595",
        "stage-fg-subtle": "#959595",
        "veil": "#000000",
        "scrim": "#000000",
        "hover": "#191919",
        "hover-subtle": "#020202",
        "hover-strong": "#313131",
        "pressed": "#191919",
        "line": "#737373",
        "line-subtle": "#525252",
        "line-control": "#a3a3a3",
        "line-strong": "#a3a3a3",
        "line-heavy": "#d4d4d4",
        "fg-strong": "#ffffff",
        "fg": "#ffffff",
        "fg-soft": "#eeeeee",
        "fg-secondary": "#d5d5d5",
        "fg-muted": "#969696",
        "fg-subtle": "#969696",
        "fg-faint": "#757575",
        "fg-disabled": "#313131",
        "fg-inverse": "#000000",
        "accent-base": "#3b82f6",
        "accent-fill": "#1e40af",
        "accent-fill-hover": "#1e3a8a",
        "accent-fill-pressed": "#172554",
        "accent-fill-translucent": "#1e40af",
        "accent-fill-translucent-hover": "#1e3a8a",
        "accent-wash": "#3b82f6",
        "accent-fg": "#60a5fa",
        "accent-fg-strong": "#93c5fd",
        "accent-fg-bright": "#bfdbfe",
        "on-accent": "#ffffff",
        "on-accent-muted": "#dbeafe",
        "accent-text-on-tint": "#dbeafe",
        "selection": "#1e40af",
        "focus": "#93c5fd",
        "progress": "#60a5fa",
        "drop-target": "#172554",
        "hover-accent": "#1e3a8a",
        "success": "#4ade80",
        "success-text": "#86efac",
        "success-hue": "#22c55e",
        "success-fill": "#166534",
        "success-bg": "#052e16",
        "success-border": "#15803d",
        "warning": "#fcd34d",
        "warning-text": "#fde68a",
        "warning-text-strong": "#fef3c7",
        "warning-marker": "#fbbf24",
        "warning-hue": "#f59e0b",
        "warning-bg": "#78350f",
        "warning-border": "#b45309",
        "error": "#f87171",
        "error-text": "#fca5a5",
        "error-hue": "#ef4444",
        "error-fill": "#991b1b",
        "error-fill-hover": "#7f1d1d",
        "error-bg": "#450a0a",
        "error-border": "#991b1b",
        "info": "#7dd3fc",
        "info-text": "#bfdbfe",
        "info-bg": "#172554",
        "info-border": "#1e40af",
        "experimental": "#fcd34d",
        "experimental-hue": "#f59e0b",
        "hud": "#000000",
        "hud-raised": "#020202",
        "hud-line": "#a3a3a3",
        "hud-fg": "#d5d5d5",
        "hud-fg-muted": "#959595",
        "hud-fg-strong": "#ffffff",
        "hud-hover": "#191919",
        "hud-selection": "#60a5fa",
        "shadow": "#000000",
        "scrollbar-track": "#020202",
        "scrollbar-thumb": "#a3a3a3",
        "brand-mark": "#ffffff",
        "brand-accent": "#60a5fa",
        "brand-logo-inner": "#ffffff",
        "code-fg": "#d5d5d5",
        "code-muted": "#969696",
        "code-name": "#60a5fa",
        "code-attr": "#969696",
        "code-string": "#4ade80",
        "code-inline-bg": "#191919",
        "code-inline-fg": "#fcd34d",
        "code-block-bg": "#000000",
        "code-syntax-text": "#d4d4d4",
        "code-syntax-comment": "#72a25d",
        "code-syntax-string": "#ce9178",
        "code-syntax-number": "#b5cea8",
        "code-syntax-keyword": "#569cd6",
        "code-syntax-type": "#4ec9b0",
        "code-syntax-directive": "#c586c0",
        "code-syntax-function": "#dcdcaa",
        "code-syntax-param": "#9cdcfe",
        "code-syntax-link": "#559bd5",
        "code-syntax-error": "#ff5e5b",
        "code-syntax-caret": "#a4a4a4",
        "code-syntax-selection": "#264f78",
        "code-syntax-highlight": "#90cdff",
        "code-syntax-assist-selected": "#04395e",
        "graph-canvas": "#000000",
        "graph-grid": "#191919",
        "builder-stage": "#000000",
        "builder-stage-grid": "#555555",
        "graph-edge-draft": "#60a5fa",
        "graph-edge-selected": "#3b82f6",
        "graph-node": "#020202",
        "graph-node-header": "#000000",
        "graph-node-line": "#a3a3a3",
        "graph-node-line-iface": "#d4d4d4",
        "graph-node-selected": "#3b82f6",
        "graph-minimap-bg": "#020202",
        "graph-minimap-mask": "#000000",
        "graph-minimap-stroke": "#000000",
        "type-boolean": "#d2372b",
        "type-bsdf": "#338237",
        "type-color3": "#fdd835",
        "type-color4": "#f4511e",
        "type-displacementshader": "#8d6e63",
        "type-edf": "#cddc39",
        "type-filename": "#90a4ae",
        "type-float": "#566bd0",
        "type-integer": "#ab45c8",
        "type-lightshader": "#ff934f",
        "type-material": "#ff404f",
        "type-matrix33": "#cfd8dc",
        "type-matrix44": "#5c7682",
        "type-string": "#d7c4a3",
        "type-surfaceshader": "#00897b",
        "type-vector2": "#5c6bc0",
        "type-vector3": "#b388ff",
        "type-vector4": "#ec407a",
        "type-vdf": "#9ccc65",
        "type-volumeshader": "#00bcd4",
        "type-node": "#a1887f",
        "type-nodegraph": "#9f652c",
        "type-untyped": "#94a3b8",
        "native-window-bg": "#000000",
        "native-titlebar": "#000000",
        "native-titlebar-symbol": "#eeeeee"
    };
    var params = {
        "typeFallback": {
            "saturation": 65,
            "lightness": 62
        },
        "graph": {
            "minimapMaskAlpha": 0.75
        },
        "alpha": {
            "hudPopover": 1,
            "accentFillTranslucent": 1
        }
    };
    var seeds = {
        "background": "#000000",
        "foreground": "#ffffff",
        "accent": "#3b82f6"
    };
    if (typeof module === 'object' && module.exports) { module.exports = { id: id, base: base, tokens: tokens, params: params, seeds: seeds }; return; }
    var d = root.MTLX_THEME_TOKENS;
    var doc = root.document;
    if (!d || !doc) return;
    d.themes[id] = tokens;
    d.params[id] = params;
    (d.seeds = d.seeds || {})[id] = seeds;
    var me = doc.currentScript;
    var href = me && me.src ? me.src.replace(/\.js([?#].*)?$/, '.css') : 'js/gen/themes/' + id + '.css';
    var done = function () { if (typeof d.loaded === 'function') d.loaded(id); };
    if (doc.readyState === 'loading' && me && !me.async) {
        doc.write('<link rel="stylesheet" href="' + href + '">');
        done();
        return;
    }
    var link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.onload = done;
    link.onerror = function () { if (root.console) root.console.warn('[theme] could not load ' + href); };
    link.href = href;
    doc.head.appendChild(link);
})(typeof self !== 'undefined' ? self : this);
