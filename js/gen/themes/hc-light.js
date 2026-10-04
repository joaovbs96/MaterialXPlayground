// GENERATED FILE, DO NOT EDIT BY HAND. Theme "hc-light" resolved from the presets in scripts/theme-tokens-meta.mjs
// by scripts/build-theme.mjs (js/shared/theme-engine.js: recipes, then the contrast pass).
(function (root) {
    'use strict';
    var id = "hc-light";
    var base = "light";
    var tokens = {
        "surface-base": "#ffffff",
        "surface-raised": "#ffffff",
        "surface-sunken": "#ffffff",
        "chrome": "#ffffff",
        "control": "#ffffff",
        "chip": "#eeeeee",
        "stage": "#ffffff",
        "stage-fg-muted": "#191919",
        "stage-fg-subtle": "#313131",
        "veil": "#ffffff",
        "scrim": "#191919",
        "hover": "#eeeeee",
        "hover-subtle": "#f4f4f4",
        "hover-strong": "#d5d5d5",
        "pressed": "#ebebeb",
        "line": "#737373",
        "line-subtle": "#a3a3a3",
        "line-control": "#404040",
        "line-strong": "#404040",
        "line-heavy": "#262626",
        "fg-strong": "#000000",
        "fg": "#000000",
        "fg-soft": "#020202",
        "fg-secondary": "#191919",
        "fg-muted": "#313131",
        "fg-subtle": "#555555",
        "fg-faint": "#757575",
        "fg-disabled": "#949494",
        "fg-inverse": "#ffffff",
        "accent-base": "#1d4ed8",
        "accent-fill": "#1e40af",
        "accent-fill-hover": "#1e3a8a",
        "accent-fill-pressed": "#172554",
        "accent-fill-translucent": "#1e40af",
        "accent-fill-translucent-hover": "#1e3a8a",
        "accent-wash": "#2f6ee3",
        "accent-fg": "#1a4ad4",
        "accent-fg-strong": "#1838c5",
        "accent-fg-bright": "#142598",
        "on-accent": "#ffffff",
        "on-accent-muted": "#e0e7f0",
        "accent-text-on-tint": "#172b9d",
        "selection": "#1d4ed8",
        "focus": "#1d4ed8",
        "progress": "#1d4ed8",
        "drop-target": "#adc8eb",
        "hover-accent": "#82b2ea",
        "success": "#00672d",
        "success-text": "#166534",
        "success-hue": "#16a34a",
        "success-fill": "#166534",
        "success-bg": "#bbf7d0",
        "success-border": "#16a34a",
        "warning": "#934100",
        "warning-text": "#803300",
        "warning-text-strong": "#78350f",
        "warning-marker": "#d97706",
        "warning-hue": "#f59e0b",
        "warning-bg": "#fde68a",
        "warning-border": "#d97706",
        "error": "#b6000f",
        "error-text": "#961719",
        "error-hue": "#ef4444",
        "error-fill": "#991b1b",
        "error-fill-hover": "#7f1d1d",
        "error-bg": "#fee2e2",
        "error-border": "#f87171",
        "info": "#005d90",
        "info-text": "#1736a5",
        "info-bg": "#bfdbfe",
        "info-border": "#60a5fa",
        "experimental": "#934100",
        "experimental-hue": "#f59e0b",
        "hud": "#ffffff",
        "hud-raised": "#ffffff",
        "hud-line": "#404040",
        "hud-fg": "#020202",
        "hud-fg-muted": "#191919",
        "hud-fg-strong": "#000000",
        "hud-hover": "#eeeeee",
        "hud-selection": "#5192e7",
        "shadow": "#64748b",
        "scrollbar-track": "#ffffff",
        "scrollbar-thumb": "#525252",
        "brand-mark": "#111827",
        "brand-accent": "#1d4ed8",
        "brand-logo-inner": "#ffffff",
        "code-fg": "#020202",
        "code-muted": "#555555",
        "code-name": "#1838c5",
        "code-attr": "#313131",
        "code-string": "#00672d",
        "code-inline-bg": "#eeeeee",
        "code-inline-fg": "#934100",
        "code-block-bg": "#ffffff",
        "code-syntax-text": "#000000",
        "code-syntax-comment": "#006800",
        "code-syntax-string": "#a31515",
        "code-syntax-number": "#006642",
        "code-syntax-keyword": "#0000ff",
        "code-syntax-type": "#006178",
        "code-syntax-directive": "#9500bb",
        "code-syntax-function": "#6f541b",
        "code-syntax-param": "#001080",
        "code-syntax-link": "#005c9a",
        "code-syntax-error": "#b40d00",
        "code-syntax-caret": "#000000",
        "code-syntax-selection": "#add6ff",
        "code-syntax-highlight": "#004c91",
        "code-syntax-assist-selected": "#d6ebff",
        "graph-canvas": "#ffffff",
        "graph-grid": "#9a9a9a",
        "builder-stage": "#ffffff",
        "builder-stage-grid": "#9a9a9a",
        "graph-edge-draft": "#2f6ee3",
        "graph-edge-selected": "#1d4ed8",
        "graph-node": "#ffffff",
        "graph-node-header": "#f9f9f9",
        "graph-node-line": "#525252",
        "graph-node-line-iface": "#262626",
        "graph-node-selected": "#1d4ed8",
        "graph-minimap-bg": "#ffffff",
        "graph-minimap-mask": "#d5d5d5",
        "graph-minimap-stroke": "#ffffff",
        "type-boolean": "#d2372b",
        "type-bsdf": "#2e7d32",
        "type-color3": "#a28915",
        "type-color4": "#e64a19",
        "type-displacementshader": "#8d6e63",
        "type-edf": "#869112",
        "type-filename": "#6e8590",
        "type-float": "#3949ab",
        "type-integer": "#8e24aa",
        "type-lightshader": "#d56d23",
        "type-material": "#e8313f",
        "type-matrix33": "#37474f",
        "type-matrix44": "#546e7a",
        "type-string": "#998768",
        "type-surfaceshader": "#00897b",
        "type-vector2": "#5c6bc0",
        "type-vector3": "#9c70e8",
        "type-vector4": "#ec407a",
        "type-vdf": "#6a972e",
        "type-volumeshader": "#1b98aa",
        "type-node": "#9e857c",
        "type-nodegraph": "#854d0e",
        "type-untyped": "#7d8ca0",
        "native-window-bg": "#ffffff",
        "native-titlebar": "#ffffff",
        "native-titlebar-symbol": "#191919",
        "surface-deep": "#ffffff",
        "scrim-alt": "#334155",
        "on-accent-soft": "#ffffff",
        "code-inline-fg-alt": "#b45309",
        "code-block-bg-alt": "#ffffff"
    };
    var params = {
        "typeFallback": {
            "saturation": 65,
            "lightness": 34
        },
        "graph": {
            "minimapMaskAlpha": 0.5
        },
        "alpha": {
            "hudPopover": 1,
            "accentFillTranslucent": 1
        }
    };
    if (typeof module === 'object' && module.exports) { module.exports = { id: id, base: base, tokens: tokens, params: params }; return; }
    var d = root.MTLX_THEME_TOKENS;
    var doc = root.document;
    if (!d || !doc) return;
    d.themes[id] = tokens;
    d.params[id] = params;
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
