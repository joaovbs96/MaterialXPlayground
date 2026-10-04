// Theme engine: OKLab/OKLCH color math, WCAG contrast, recipe-based theme derivation, a contrast pass and runtime sources.
// Build: scripts/build-theme.mjs resolves presets. Browser: loaded on demand only (js/gen/themes/vscode.js, custom themes).
// UMD: window.MtlxThemeEngine in the browser (then MTLX_THEME_TOKENS.onEngine(api) runs), module.exports under Node.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else {
        root.MtlxThemeEngine = api;
        const d = root.MTLX_THEME_TOKENS;
        const f = d && d.onEngine;
        if (typeof f === 'function') { d.onEngine = null; f(api); }
    }
})(typeof self !== 'undefined' ? self : this, function (root) {
    'use strict';

    // ---- sRGB, OKLab, OKLCH (Ottosson's matrices) ----
    function parseHex(hex) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
        if (!m) throw new Error('theme-engine: "' + hex + '" is not #rrggbb');
        const n = parseInt(m[1], 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function toHex(rgb) {
        return '#' + rgb.map(function (v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'); }).join('');
    }

    function normHex(hex) { return toHex(parseHex(hex)); }

    const toLinear = function (c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const toGamma = function (c) { return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055); };

    function rgbToOklab(rgb) {
        const r = toLinear(rgb[0]), g = toLinear(rgb[1]), b = toLinear(rgb[2]);
        const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
        const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
        const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
        return [
            0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
        ];
    }

    function oklabToLinear(lab) {
        const l = Math.pow(lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2], 3);
        const m = Math.pow(lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2], 3);
        const s = Math.pow(lab[0] - 0.0894841775 * lab[1] - 1.2914855480 * lab[2], 3);
        return [
            4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
            -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
            -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
        ];
    }

    const inGamut = function (c) { return c.every(function (v) { return v >= -1e-4 && v <= 1 + 1e-4; }); };

    function labToLch(lab) {
        const h = Math.atan2(lab[2], lab[1]) * 180 / Math.PI;
        return [lab[0], Math.hypot(lab[1], lab[2]), h < 0 ? h + 360 : h];
    }

    function lchToLab(lch) {
        const r = lch[2] * Math.PI / 180;
        return [lch[0], lch[1] * Math.cos(r), lch[1] * Math.sin(r)];
    }

    // OKLab to hex; out-of-gamut colors keep L and hue and lose chroma (binary search) until they fit.
    function fromOklab(lab) {
        const L = Math.max(0, Math.min(1, lab[0]));
        let c = oklabToLinear([L, lab[1], lab[2]]);
        if (!inGamut(c)) {
            const lch = labToLch([L, lab[1], lab[2]]);
            let lo = 0, hi = lch[1];
            for (let i = 0; i < 24; i++) {
                const mid = (lo + hi) / 2;
                if (inGamut(oklabToLinear(lchToLab([L, mid, lch[2]])))) lo = mid; else hi = mid;
            }
            c = oklabToLinear(lchToLab([L, lo, lch[2]]));
        }
        return toHex(c.map(function (v) { return toGamma(Math.max(0, Math.min(1, v))); }));
    }

    function toOklab(hex) { return rgbToOklab(parseHex(hex)); }
    function toOklch(hex) { return labToLch(toOklab(hex)); }
    function fromOklch(lch) { return fromOklab(lchToLab(lch)); }

    // OKLab interpolation; t outside 0..1 extrapolates along the same line (clamped to gamut).
    function mix(a, b, t) {
        const x = toOklab(a), y = toOklab(b);
        return fromOklab([0, 1, 2].map(function (i) { return x[i] + (y[i] - x[i]) * t; }));
    }

    // OKLCH offsets: lightness adds, chroma multiplies, hue adds degrees.
    function adjust(hex, o) {
        const lch = toOklch(hex);
        return fromOklch([
            lch[0] + (o.lightness || 0),
            lch[1] * (o.chroma == null ? 1 : o.chroma),
            lch[2] + (o.hue || 0),
        ]);
    }

    function lighten(hex, d) { return adjust(hex, { lightness: d }); }
    function darken(hex, d) { return adjust(hex, { lightness: -d }); }

    // 8-bit sRGB alpha composite, the same rounding as a legacy rgba() fill over a solid ground.
    function composite(fg, bg, alpha) {
        const f = parseHex(fg), b = parseHex(bg);
        return toHex(f.map(function (v, i) { return Math.round(v * alpha + b[i] * (1 - alpha)); }));
    }

    function luminance(hex) {
        const c = parseHex(hex).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }

    function contrast(a, b) {
        const x = luminance(a), y = luminance(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    }

    // OKLab Euclidean distance x 100 (about 2 is a just noticeable difference).
    function deltaE(a, b) {
        const x = toOklab(a), y = toOklab(b);
        return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
    }

    // ---- Recipes ----
    // Per base, per token: { from: seed } copies a seed; + mixToward/amount is an OKLab mix (amount may leave 0..1);
    // + lightness/chroma/hue are OKLCH offsets (chroma multiplies); { fixedFromBase: true } copies the base theme.
    // Fitted by scratchpad calibration against the hand-authored dark and light maps; params always come from the base.
    const RECIPES = {
        dark: {
            'surface-base': { from: 'background' },
            'surface-raised': { from: 'background', mixToward: 'foreground', amount: 0.09 },
            'surface-sunken': { from: 'background' },
            'surface-card': { from: 'background', mixToward: 'foreground', amount: 0.0315 },
            'chrome': { from: 'background' },
            'control': { from: 'background', mixToward: 'foreground', amount: 0.09 },
            'chip': { from: 'background', mixToward: 'foreground', amount: 0.215 },
            'stage': { from: 'background' },
            'stage-fg-muted': { from: 'background', mixToward: 'foreground', amount: 0.665 },
            'stage-fg-subtle': { from: 'background', mixToward: 'foreground', amount: 0.45 },
            'veil': { from: 'background' },
            'scrim': { from: 'background', mixToward: 'foreground', amount: -0.106 },
            'hover': { from: 'background', mixToward: 'foreground', amount: 0.215 },
            'hover-subtle': { from: 'background', mixToward: 'foreground', amount: 0.09 },
            'hover-strong': { from: 'background', mixToward: 'foreground', amount: 0.312 },
            'pressed': { from: 'background', mixToward: 'foreground', amount: 0.215 },
            'line': { from: 'background', mixToward: 'foreground', amount: 0.215 },
            'line-subtle': { from: 'background', mixToward: 'foreground', amount: 0.09 },
            'line-control': { from: 'background', mixToward: 'foreground', amount: 0.215 },
            'line-strong': { from: 'background', mixToward: 'foreground', amount: 0.312 },
            'line-heavy': { from: 'background', mixToward: 'foreground', amount: 0.45 },
            'fg-strong': { from: 'background', mixToward: 'foreground', amount: 1.044 },
            'fg': { from: 'foreground' },
            'fg-soft': { from: 'background', mixToward: 'foreground', amount: 0.948 },
            'fg-secondary': { from: 'background', mixToward: 'foreground', amount: 0.874 },
            'fg-muted': { from: 'background', mixToward: 'foreground', amount: 0.665 },
            'fg-subtle': { from: 'background', mixToward: 'foreground', amount: 0.45 },
            'fg-faint': { from: 'background', mixToward: 'foreground', amount: 0.312 },
            'fg-disabled': { from: 'background', mixToward: 'foreground', amount: 0.312 },
            'fg-inverse': { from: 'background' },
            'accent-base': { from: 'accent' },
            'accent-fill': { from: 'accent', lightness: -0.0769, chroma: 1.145, hue: 3.1 },
            'accent-fill-hover': { from: 'accent' },
            'accent-fill-pressed': { from: 'accent', lightness: -0.1349, chroma: 1.155, hue: 4.6 },
            'accent-fill-translucent': { from: 'accent', lightness: -0.0769, chroma: 1.145, hue: 3.1 },
            'accent-fill-translucent-hover': { from: 'accent' },
            'accent-wash': { from: 'accent' },
            'accent-fg': { from: 'accent', lightness: 0.0907, chroma: 0.763, hue: -5.2 },
            'accent-fg-strong': { from: 'accent', lightness: 0.186, chroma: 0.508, hue: -8 },
            'accent-fg-bright': { from: 'accent', lightness: 0.2593, chroma: 0.303, hue: -5.7 },
            'on-accent': { fixedFromBase: true },
            'on-accent-muted': { from: 'accent', lightness: 0.3088, chroma: 0.168, hue: -4.2 },
            'accent-text-on-tint': { from: 'accent', lightness: 0.3088, chroma: 0.168, hue: -4.2 },
            'selection': { from: 'accent', lightness: -0.0769, chroma: 1.145, hue: 3.1 },
            'focus': { from: 'accent' },
            'progress': { from: 'accent', lightness: 0.0907, chroma: 0.763, hue: -5.2 },
            'drop-target': { from: 'accent', lightness: -0.3408, chroma: 0.465, hue: 8.1 },
            'hover-accent': { from: 'accent', lightness: -0.244, chroma: 0.733, hue: 5.7 },
            'success': { fixedFromBase: true },
            'success-text': { fixedFromBase: true },
            'success-hue': { fixedFromBase: true },
            'success-fill': { fixedFromBase: true },
            'success-bg': { fixedFromBase: true },
            'success-border': { fixedFromBase: true },
            'warning': { fixedFromBase: true },
            'warning-text': { fixedFromBase: true },
            'warning-text-strong': { fixedFromBase: true },
            'warning-marker': { fixedFromBase: true },
            'warning-hue': { fixedFromBase: true },
            'warning-bg': { fixedFromBase: true },
            'warning-border': { fixedFromBase: true },
            'error': { fixedFromBase: true },
            'error-text': { fixedFromBase: true },
            'error-hue': { fixedFromBase: true },
            'error-fill': { fixedFromBase: true },
            'error-fill-hover': { fixedFromBase: true },
            'error-bg': { fixedFromBase: true },
            'error-border': { fixedFromBase: true },
            'info': { fixedFromBase: true },
            'info-text': { fixedFromBase: true },
            'info-bg': { fixedFromBase: true },
            'info-border': { fixedFromBase: true },
            'experimental': { fixedFromBase: true },
            'experimental-hue': { fixedFromBase: true },
            'hud': { from: 'background' },
            'hud-raised': { from: 'background', mixToward: 'foreground', amount: 0.09 },
            'hud-line': { from: 'background', mixToward: 'foreground', amount: 0.312 },
            'hud-fg': { from: 'background', mixToward: 'foreground', amount: 0.874 },
            'hud-fg-muted': { from: 'background', mixToward: 'foreground', amount: 0.665 },
            'hud-fg-strong': { from: 'background', mixToward: 'foreground', amount: 1 },
            'hud-hover': { from: 'background', mixToward: 'foreground', amount: 0.215 },
            'hud-selection': { from: 'accent', lightness: 0.0907, chroma: 0.763, hue: -5.2 },
            'shadow': { fixedFromBase: true },
            'scrollbar-track': { from: 'background', mixToward: 'foreground', amount: 0.09 },
            'scrollbar-thumb': { from: 'background', mixToward: 'foreground', amount: 0.215 },
            'brand-mark': { fixedFromBase: true },
            'brand-accent': { from: 'accent', lightness: 0.0907, chroma: 0.763, hue: -5.2 },
            'brand-logo-inner': { fixedFromBase: true },
            'code-fg': { from: 'background', mixToward: 'foreground', amount: 0.874 },
            'code-muted': { from: 'background', mixToward: 'foreground', amount: 0.45 },
            'code-name': { from: 'accent', lightness: 0.0907, chroma: 0.763, hue: -5.2 },
            'code-attr': { from: 'background', mixToward: 'foreground', amount: 0.665 },
            'code-string': { fixedFromBase: true },
            'code-inline-bg': { from: 'background', mixToward: 'foreground', amount: 0.215 },
            'code-inline-fg': { fixedFromBase: true },
            'code-block-bg': { from: 'background', mixToward: 'foreground', amount: -0.039 },
            'code-syntax-text': { from: 'background', mixToward: 'foreground', amount: 0.871 },
            'code-syntax-comment': { fixedFromBase: true },
            'code-syntax-string': { fixedFromBase: true },
            'code-syntax-number': { fixedFromBase: true },
            'code-syntax-keyword': { fixedFromBase: true },
            'code-syntax-type': { fixedFromBase: true },
            'code-syntax-directive': { fixedFromBase: true },
            'code-syntax-function': { fixedFromBase: true },
            'code-syntax-param': { fixedFromBase: true },
            'code-syntax-link': { fixedFromBase: true },
            'code-syntax-error': { fixedFromBase: true },
            'code-syntax-caret': { from: 'background', mixToward: 'foreground', amount: 0.719 },
            'code-syntax-selection': { fixedFromBase: true },
            'code-syntax-highlight': { fixedFromBase: true },
            'code-syntax-assist-selected': { fixedFromBase: true },
            'graph-canvas': { from: 'background' },
            'graph-grid': { from: 'background', mixToward: 'foreground', amount: 0.215 },
            'builder-stage': { from: 'background', mixToward: 'foreground', amount: -0.036 },
            'builder-stage-grid': { from: 'background', mixToward: 'foreground', amount: 0.45 },
            'graph-edge-draft': { from: 'accent', lightness: 0.0907, chroma: 0.763, hue: -5.2 },
            'graph-edge-selected': { from: 'accent' },
            'graph-node': { from: 'background', mixToward: 'foreground', amount: 0.09 },
            'graph-node-header': { from: 'background' },
            'graph-node-line': { from: 'background', mixToward: 'foreground', amount: 0.312 },
            'graph-node-line-iface': { from: 'background', mixToward: 'foreground', amount: 0.45 },
            'graph-node-selected': { from: 'accent' },
            'graph-minimap-bg': { from: 'background', mixToward: 'foreground', amount: 0.09 },
            'graph-minimap-mask': { from: 'background' },
            'graph-minimap-stroke': { from: 'background' },
            'type-boolean': { fixedFromBase: true },
            'type-bsdf': { fixedFromBase: true },
            'type-color3': { fixedFromBase: true },
            'type-color4': { fixedFromBase: true },
            'type-displacementshader': { fixedFromBase: true },
            'type-edf': { fixedFromBase: true },
            'type-filename': { fixedFromBase: true },
            'type-float': { fixedFromBase: true },
            'type-integer': { fixedFromBase: true },
            'type-lightshader': { fixedFromBase: true },
            'type-material': { fixedFromBase: true },
            'type-matrix33': { fixedFromBase: true },
            'type-matrix44': { fixedFromBase: true },
            'type-string': { fixedFromBase: true },
            'type-surfaceshader': { fixedFromBase: true },
            'type-vector2': { fixedFromBase: true },
            'type-vector3': { fixedFromBase: true },
            'type-vector4': { fixedFromBase: true },
            'type-vdf': { fixedFromBase: true },
            'type-volumeshader': { fixedFromBase: true },
            'type-node': { fixedFromBase: true },
            'type-nodegraph': { fixedFromBase: true },
            'type-untyped': { fixedFromBase: true },
            'native-window-bg': { from: 'background', mixToward: 'foreground', amount: -0.053 },
            'native-titlebar': { from: 'background' },
            'native-titlebar-symbol': { from: 'background', mixToward: 'foreground', amount: 0.948 },
        },
        light: {
            'surface-base': { from: 'background' },
            'surface-raised': { from: 'background', mixToward: 'foreground', amount: -0.044 },
            'surface-sunken': { from: 'background', mixToward: 'foreground', amount: -0.023 },
            'surface-card': { from: 'background', mixToward: 'foreground', amount: -0.015 },
            'chrome': { from: 'background' },
            'control': { from: 'background', mixToward: 'foreground', amount: -0.044 },
            'chip': { from: 'background', mixToward: 'foreground', amount: 0.052 },
            'stage': { from: 'background' },
            'stage-fg-muted': { from: 'background', mixToward: 'foreground', amount: 0.785 },
            'stage-fg-subtle': { from: 'background', mixToward: 'foreground', amount: 0.688 },
            'veil': { from: 'background', mixToward: 'foreground', amount: -0.023 },
            'scrim': { from: 'background', mixToward: 'foreground', amount: 0.787 },
            'hover': { from: 'background', mixToward: 'foreground', amount: 0.052 },
            'hover-subtle': { from: 'background', mixToward: 'foreground', amount: 0.032 },
            'hover-strong': { from: 'background', mixToward: 'foreground', amount: 0.126 },
            'pressed': { from: 'background', mixToward: 'foreground', amount: 0.061 },
            'line': { from: 'background', mixToward: 'foreground', amount: 0.126 },
            'line-subtle': { from: 'background', mixToward: 'foreground', amount: 0.052 },
            'line-control': { from: 'background', mixToward: 'foreground', amount: 0.438 },
            'line-strong': { from: 'background', mixToward: 'foreground', amount: 0.478 },
            'line-heavy': { from: 'background', mixToward: 'foreground', amount: 0.55 },
            'fg-strong': { from: 'background', mixToward: 'foreground', amount: 1.106 },
            'fg': { from: 'foreground' },
            'fg-soft': { from: 'background', mixToward: 'foreground', amount: 0.91 },
            'fg-secondary': { from: 'background', mixToward: 'foreground', amount: 0.785 },
            'fg-muted': { from: 'background', mixToward: 'foreground', amount: 0.688 },
            'fg-subtle': { from: 'background', mixToward: 'foreground', amount: 0.55 },
            'fg-faint': { from: 'background', mixToward: 'foreground', amount: 0.438 },
            'fg-disabled': { from: 'background', mixToward: 'foreground', amount: 0.335 },
            'fg-inverse': { from: 'background' },
            'accent-base': { from: 'accent', lightness: 0.0769, chroma: 0.874, hue: -3.1 },
            'accent-fill': { from: 'accent' },
            'accent-fill-hover': { from: 'accent', lightness: -0.058, chroma: 1.009, hue: 1.5 },
            'accent-fill-pressed': { from: 'accent', lightness: -0.1217, chroma: 0.84, hue: 2.8 },
            'accent-fill-translucent': { from: 'accent' },
            'accent-fill-translucent-hover': { from: 'accent', lightness: -0.058, chroma: 1.009, hue: 1.5 },
            'accent-wash': { from: 'accent', lightness: 0.0769, chroma: 0.874, hue: -3.1 },
            'accent-fg': { from: 'accent' },
            'accent-fg-strong': { from: 'accent', lightness: -0.058, chroma: 1.009, hue: 1.5 },
            'accent-fg-bright': { from: 'accent', lightness: -0.1217, chroma: 0.84, hue: 2.8 },
            'on-accent': { fixedFromBase: true },
            'on-accent-muted': { from: 'accent', lightness: 0.4243, chroma: 0.066, hue: -8.3 },
            'accent-text-on-tint': { from: 'accent', lightness: -0.1217, chroma: 0.84, hue: 2.8 },
            'selection': { from: 'accent', lightness: 0.0769, chroma: 0.874, hue: -3.1 },
            'focus': { from: 'accent' },
            'progress': { from: 'accent' },
            'drop-target': { from: 'accent', lightness: 0.3362, chroma: 0.265, hue: -8.8 },
            'hover-accent': { from: 'accent', lightness: 0.2629, chroma: 0.444, hue: -11.1 },
            'success': { fixedFromBase: true },
            'success-text': { fixedFromBase: true },
            'success-hue': { fixedFromBase: true },
            'success-fill': { fixedFromBase: true },
            'success-bg': { fixedFromBase: true },
            'success-border': { fixedFromBase: true },
            'warning': { fixedFromBase: true },
            'warning-text': { fixedFromBase: true },
            'warning-text-strong': { fixedFromBase: true },
            'warning-marker': { fixedFromBase: true },
            'warning-hue': { fixedFromBase: true },
            'warning-bg': { fixedFromBase: true },
            'warning-border': { fixedFromBase: true },
            'error': { fixedFromBase: true },
            'error-text': { fixedFromBase: true },
            'error-hue': { fixedFromBase: true },
            'error-fill': { fixedFromBase: true },
            'error-fill-hover': { fixedFromBase: true },
            'error-bg': { fixedFromBase: true },
            'error-border': { fixedFromBase: true },
            'info': { fixedFromBase: true },
            'info-text': { fixedFromBase: true },
            'info-bg': { fixedFromBase: true },
            'info-border': { fixedFromBase: true },
            'experimental': { fixedFromBase: true },
            'experimental-hue': { fixedFromBase: true },
            'hud': { from: 'background', mixToward: 'foreground', amount: -0.023 },
            'hud-raised': { from: 'background', mixToward: 'foreground', amount: -0.044 },
            'hud-line': { from: 'background', mixToward: 'foreground', amount: 0.438 },
            'hud-fg': { from: 'background', mixToward: 'foreground', amount: 0.91 },
            'hud-fg-muted': { from: 'background', mixToward: 'foreground', amount: 0.785 },
            'hud-fg-strong': { from: 'background', mixToward: 'foreground', amount: 1.106 },
            'hud-hover': { from: 'background', mixToward: 'foreground', amount: 0.052 },
            'hud-selection': { from: 'accent', lightness: 0.1676, chroma: 0.666, hue: -8.3 },
            'shadow': { fixedFromBase: true },
            'scrollbar-track': { from: 'background' },
            'scrollbar-thumb': { from: 'background', mixToward: 'foreground', amount: 0.438 },
            'brand-mark': { fixedFromBase: true },
            'brand-accent': { from: 'accent' },
            'brand-logo-inner': { fixedFromBase: true },
            'code-fg': { from: 'background', mixToward: 'foreground', amount: 0.91 },
            'code-muted': { from: 'background', mixToward: 'foreground', amount: 0.55 },
            'code-name': { from: 'accent', lightness: -0.058, chroma: 1.009, hue: 1.5 },
            'code-attr': { from: 'background', mixToward: 'foreground', amount: 0.688 },
            'code-string': { fixedFromBase: true },
            'code-inline-bg': { from: 'background', mixToward: 'foreground', amount: 0.052 },
            'code-inline-fg': { fixedFromBase: true },
            'code-block-bg': { from: 'background', mixToward: 'foreground', amount: -0.011 },
            'code-syntax-text': { from: 'background', mixToward: 'foreground', amount: 1 },
            'code-syntax-comment': { fixedFromBase: true },
            'code-syntax-string': { fixedFromBase: true },
            'code-syntax-number': { fixedFromBase: true },
            'code-syntax-keyword': { fixedFromBase: true },
            'code-syntax-type': { fixedFromBase: true },
            'code-syntax-directive': { fixedFromBase: true },
            'code-syntax-function': { fixedFromBase: true },
            'code-syntax-param': { fixedFromBase: true },
            'code-syntax-link': { fixedFromBase: true },
            'code-syntax-error': { fixedFromBase: true },
            'code-syntax-caret': { from: 'background', mixToward: 'foreground', amount: 1 },
            'code-syntax-selection': { fixedFromBase: true },
            'code-syntax-highlight': { fixedFromBase: true },
            'code-syntax-assist-selected': { fixedFromBase: true },
            'graph-canvas': { from: 'background' },
            'graph-grid': { from: 'background', mixToward: 'foreground', amount: 0.314 },
            'builder-stage': { from: 'background' },
            'builder-stage-grid': { from: 'background', mixToward: 'foreground', amount: 0.314 },
            'graph-edge-draft': { from: 'accent', lightness: 0.0769, chroma: 0.874, hue: -3.1 },
            'graph-edge-selected': { from: 'accent' },
            'graph-node': { from: 'background', mixToward: 'foreground', amount: -0.044 },
            'graph-node-header': { from: 'background', mixToward: 'foreground', amount: 0.017 },
            'graph-node-line': { from: 'background', mixToward: 'foreground', amount: 0.438 },
            'graph-node-line-iface': { from: 'background', mixToward: 'foreground', amount: 0.55 },
            'graph-node-selected': { from: 'accent' },
            'graph-minimap-bg': { from: 'background', mixToward: 'foreground', amount: -0.044 },
            'graph-minimap-mask': { from: 'background', mixToward: 'foreground', amount: 0.126 },
            'graph-minimap-stroke': { from: 'background', mixToward: 'foreground', amount: -0.044 },
            'type-boolean': { fixedFromBase: true },
            'type-bsdf': { fixedFromBase: true },
            'type-color3': { fixedFromBase: true },
            'type-color4': { fixedFromBase: true },
            'type-displacementshader': { fixedFromBase: true },
            'type-edf': { fixedFromBase: true },
            'type-filename': { fixedFromBase: true },
            'type-float': { fixedFromBase: true },
            'type-integer': { fixedFromBase: true },
            'type-lightshader': { fixedFromBase: true },
            'type-material': { fixedFromBase: true },
            'type-matrix33': { fixedFromBase: true },
            'type-matrix44': { fixedFromBase: true },
            'type-string': { fixedFromBase: true },
            'type-surfaceshader': { fixedFromBase: true },
            'type-vector2': { fixedFromBase: true },
            'type-vector3': { fixedFromBase: true },
            'type-vector4': { fixedFromBase: true },
            'type-vdf': { fixedFromBase: true },
            'type-volumeshader': { fixedFromBase: true },
            'type-node': { fixedFromBase: true },
            'type-nodegraph': { fixedFromBase: true },
            'type-untyped': { fixedFromBase: true },
            'native-window-bg': { from: 'background' },
            'native-titlebar': { from: 'background' },
            'native-titlebar-symbol': { from: 'background', mixToward: 'foreground', amount: 0.785 },
        },
    };

    const SEED_OF = { background: 'surface-base', foreground: 'fg', accent: 'accent-base' };

    function tokenData(data) {
        const d = data || root.MTLX_THEME_TOKENS || (typeof require === 'function' ? require('./theme-tokens.js') : null);
        if (!d || !d.themes || !d.themes.dark) throw new Error('theme-engine: no token data');
        return d;
    }

    // Modifier contrast c (-1..1) on a neutral mix amount: layers and lines (amount < 0.5) move away from the
    // background by (1 + c/2), text levels toward the foreground by (1 - c/2). Tint t (0..1) moves the OKLab a/b
    // of a derived neutral toward 20% of the accent's chroma at the accent's hue, keeping lightness.
    function modAmount(a, c) { return a < 0.5 ? a * (1 + c / 2) : 1 - (1 - a) * (1 - c / 2); }

    function tintHex(hex, accent, t) {
        const x = toOklab(hex), y = toOklab(accent);
        return fromOklab([x[0], x[1] + (0.2 * y[1] - x[1]) * t, x[2] + (0.2 * y[2] - x[2]) * t]);
    }

    function evalRecipe(r, token, seeds, baseMap, darkMap, mods) {
        if (!r || r.fixedFromBase) return normHex(token in baseMap ? baseMap[token] : darkMap[token]);
        const src = seeds[r.from];
        if (!src) throw new Error('theme-engine: recipe for "' + token + '" names unknown seed "' + r.from + '"');
        if (r.mixToward) {
            const m = mix(src, seeds[r.mixToward], mods.contrast ? modAmount(r.amount, mods.contrast) : r.amount);
            return mods.tint ? tintHex(m, seeds.accent, mods.tint) : m;
        }
        if (r.lightness != null || r.chroma != null || r.hue != null) return adjust(src, r);
        return normHex(src);
    }

    function mergeParams(baseParams, extra) {
        const out = {};
        Object.keys(baseParams || {}).forEach(function (g) { out[g] = Object.assign({}, baseParams[g]); });
        Object.keys(extra || {}).forEach(function (g) { out[g] = Object.assign(out[g] || {}, extra[g]); });
        return out;
    }

    // Full token map from a base ('dark' | 'light'), partial seeds, partial overrides (token -> hex) and optional
    // modifiers { contrast, tint } (custom themes only; 0 or absent leaves the recipes untouched).
    // Returns { tokens, params, sources }; sources[token] is 'override', 'recipe' or 'base'.
    function deriveTheme(opts) {
        const o = opts || {};
        const data = tokenData(o.data);
        const base = o.base === 'light' ? 'light' : 'dark';
        const baseMap = data.themes[base] || {};
        const darkMap = data.themes.dark;
        const seedDefaults = (data.seeds && data.seeds[base]) || {};
        const seeds = {};
        Object.keys(SEED_OF).forEach(function (k) { seeds[k] = normHex((o.seeds && o.seeds[k]) || seedDefaults[k] || baseMap[SEED_OF[k]]); });
        const overrides = o.overrides || {};
        const recipes = (o.recipes || RECIPES)[base] || {};
        const tokens = {};
        const sources = {};
        const mo = o.modifiers || {};
        const mods = { contrast: Math.max(-1, Math.min(1, +mo.contrast || 0)), tint: Math.max(0, Math.min(1, +mo.tint || 0)) };
        Object.keys(darkMap).forEach(function (t) {
            if (t in overrides) { tokens[t] = normHex(overrides[t]); sources[t] = 'override'; return; }
            const r = recipes[t];
            tokens[t] = evalRecipe(r, t, seeds, baseMap, darkMap, mods);
            sources[t] = !r || r.fixedFromBase ? 'base' : 'recipe';
        });
        Object.keys(overrides).forEach(function (t) { if (!(t in darkMap)) throw new Error('theme-engine: override of unknown token "' + t + '"'); });
        const params = mergeParams(mergeParams((data.params && data.params.dark) || {}, data.params && data.params[base]), o.params);
        return { base: base, seeds: seeds, tokens: tokens, params: params, sources: sources };
    }

    // ---- Contrast ----
    const LEVELS = {
        AA: { text: 4.5, large: 3, ui: 3, decorative: 0 },
        AAA: { text: 7, large: 4.5, ui: 3, decorative: 0 },
    };

    function pairAlpha(p, params) {
        if (p.alphaParam) {
            const g = params && params[p.alphaParam[0]];
            const v = g && g[p.alphaParam[1]];
            return typeof v === 'number' ? v : null;
        }
        return p.alpha != null ? p.alpha : null;
    }

    // Ratio of one meta pair ({ fg, bg, kind, alpha? | alphaParam?, under? }) in a token map.
    function measurePair(map, p, params, fgOverride) {
        const a = pairAlpha(p, params);
        const bg = a == null ? map[p.bg] : composite(map[p.bg], map[p.under], a);
        return contrast(fgOverride || map[p.fg], bg);
    }

    function pairBg(map, p, params) {
        const a = pairAlpha(p, params);
        return a == null ? map[p.bg] : composite(map[p.bg], map[p.under], a);
    }

    // Moves each failing pair's FOREGROUND token in OKLCH lightness, away from its ground, by the smallest
    // step that passes. Locked tokens (seeds) never move; an unreachable pair throws naming the pair.
    // Errors of the contrast pass carry the pair (fg, bg, kind, ratio, need, why: 'seed' | 'unreachable') for user messages.
    function pairError(msg, p, ratio, need, why) {
        const e = new Error(msg);
        e.pair = { fg: p.fg, bg: p.bg, kind: p.kind, ratio: ratio, need: need, why: why };
        return e;
    }

    function enforceContrast(map, pairs, level, opts) {
        const o = opts || {};
        const need = LEVELS[level];
        if (!need) throw new Error('theme-engine: unknown contrast level "' + level + '"');
        const locked = new Set(o.locked || ['surface-base', 'fg', 'accent-base']);
        const tokens = Object.assign({}, map);
        const moved = {};
        const label = o.name ? o.name + ': ' : '';
        for (let pass = 0; pass < 12; pass++) {
            let changed = false;
            for (const p of pairs) {
                const req = need[p.kind];
                if (req == null) throw new Error('theme-engine: pair ' + p.fg + '|' + p.bg + ' has unknown kind "' + p.kind + '"');
                if (!req || measurePair(tokens, p, o.params) >= req) continue;
                const name = p.fg + '|' + p.bg;
                const ratio = measurePair(tokens, p, o.params);
                if (locked.has(p.fg)) throw pairError('theme-engine: ' + label + 'pair ' + name + ' fails (' + ratio.toFixed(2) + ' < ' + req + ') and its foreground is a seed', p, ratio, req, 'seed');
                const bg = pairBg(tokens, p, o.params);
                const lch = toOklch(tokens[p.fg]);
                const dir = luminance(tokens[p.fg]) >= luminance(bg) ? 1 : -1;
                let found = null;
                for (let k = 1; k <= 500 && !found; k++) {
                    const L = lch[0] + dir * k * 0.002;
                    const hex = fromOklch([Math.max(0, Math.min(1, L)), lch[1], lch[2]]);
                    if (measurePair(tokens, p, o.params, hex) >= req) found = hex;
                    else if (L <= 0 || L >= 1) break;
                }
                if (!found) throw pairError('theme-engine: ' + label + 'pair ' + name + ' (' + p.kind + ', needs ' + req + ') cannot be satisfied by moving ' + p.fg, p, ratio, req, 'unreachable');
                if (!moved[p.fg]) moved[p.fg] = { from: tokens[p.fg] };
                tokens[p.fg] = found;
                moved[p.fg].to = found;
                changed = true;
            }
            if (!changed) break;
            if (pass === 11) throw new Error('theme-engine: ' + label + 'contrast pass did not settle (pairs fight over a token)');
        }
        const report = pairs.map(function (p) {
            const req = need[p.kind];
            const r = measurePair(tokens, p, o.params);
            return { fg: p.fg, bg: p.bg, kind: p.kind, need: req, ratio: r, before: measurePair(map, p, o.params), pass: !req || r >= req };
        });
        return { tokens: tokens, moved: moved, report: report };
    }

    // Preset ({ base, seeds, overrides, params, contrast }) to a checked, full theme.
    function resolvePreset(preset, opts) {
        const o = opts || {};
        const d = deriveTheme({ base: preset.base, seeds: preset.seeds, overrides: preset.overrides, params: preset.params, data: o.data });
        const c = enforceContrast(d.tokens, o.pairs || [], preset.contrast || 'AA', { params: d.params, name: o.name });
        return { base: d.base, seeds: d.seeds, tokens: c.tokens, params: d.params, sources: d.sources, moved: c.moved, report: c.report };
    }

    // ---- Custom themes ----
    // Solid fills (accent, success, error) and accent-base that fail under on-accent move in OKLCH lightness away from
    // it first: on-accent is shared by all of them, so the contrast pass cannot fix them. Overrides stay put.
    function fitFills(tokens, pairs, need, params, keep) {
        const moved = [];
        pairs.forEach(function (p) {
            const req = need[p.kind];
            if (p.fg !== 'on-accent' || !/-fill(-|$)|^accent-base$/.test(p.bg) || keep[p.bg] || !req || measurePair(tokens, p, params) >= req) return;
            const lch = toOklch(tokens[p.bg]);
            const dir = luminance(tokens[p.fg]) >= luminance(tokens[p.bg]) ? -1 : 1;
            for (let k = 1; k <= 500; k++) {
                const L = lch[0] + dir * k * 0.002;
                if (L < 0 || L > 1) break;
                const t = Object.assign({}, tokens);
                t[p.bg] = fromOklch([L, lch[1], lch[2]]);
                if (measurePair(t, p, params) < req) continue;
                moved.push({ fg: p.fg, bg: p.bg, token: p.bg, from: tokens[p.bg], to: t[p.bg] });
                tokens[p.bg] = t[p.bg];
                break;
            }
        });
        return moved;
    }

    // A validated custom spec ({ base, seeds, overrides, modifiers } or { base, from, overrides } plus opts.baseline) to { ok, base, tokens, params, adjusted, report, error }.
    // adjusted: [{ fg, bg, token, from, to }] per fixed pair (token is the color that moved; only surface-base and fg are
    // locked, as for VS Code). ok false: tokens are the uncorrected derivation and error is a short user-facing message.
    function resolveCustom(spec, opts) {
        const o = opts || {};
        const pairs = o.pairs || [];
        let level = o.level || 'AA';
        let d;
        if (spec.from) {
            // Based on a built-in theme: its exact map and params plus the overrides, at that theme's level.
            const bl = o.baseline;
            if (!bl || !bl.tokens) return { ok: false, base: spec.base, tokens: {}, params: {}, adjusted: [], report: [], error: 'The theme "' + spec.from + '" it is based on is not available' };
            level = bl.level || level;
            const tokens = Object.assign({}, bl.tokens);
            const ov = spec.overrides || {};
            Object.keys(ov).forEach(function (t) {
                if (!(t in tokens)) throw new Error('theme-engine: override of unknown token "' + t + '"');
                tokens[t] = normHex(ov[t]);
            });
            d = { base: spec.base, tokens: tokens, params: JSON.parse(JSON.stringify(bl.params || {})) };
        } else {
            d = deriveTheme({ base: spec.base, seeds: spec.seeds, overrides: spec.overrides, modifiers: spec.modifiers, data: o.data });
        }
        const out = { ok: true, base: d.base, tokens: d.tokens, params: d.params, adjusted: [], report: [], error: null };
        try {
            const fitted = Object.assign({}, d.tokens);
            out.adjusted = fitFills(fitted, pairs, LEVELS[level] || LEVELS.AA, d.params, spec.overrides || {});
            const c = enforceContrast(fitted, pairs, level, { params: d.params, name: 'custom', locked: ['surface-base', 'fg'] });
            out.tokens = c.tokens;
            out.report = c.report;
            c.report.forEach(function (r) {
                const m = c.moved[r.fg];
                if (m && r.need && r.before < r.need) out.adjusted.push({ fg: r.fg, bg: r.bg, token: r.fg, from: m.from, to: m.to });
            });
        } catch (e) {
            const q = e.pair;
            out.ok = false;
            out.error = !q ? 'These colors cannot all reach ' + level + ' contrast together. Pick other colors.'
                : q.why === 'seed' ? 'Contrast too low: ' + q.fg + ' on ' + q.bg + ' is ' + q.ratio.toFixed(2) + ':1, needs ' + q.need + ':1. Change the base colors.'
                    : q.fg + ' on ' + q.bg + ' cannot reach ' + q.need + ':1 contrast. Pick other colors.';
            const need = LEVELS[level];
            out.report = pairs.map(function (p) {
                const r = measurePair(d.tokens, p, d.params);
                return { fg: p.fg, bg: p.bg, kind: p.kind, need: need[p.kind], ratio: r, before: r, pass: !need[p.kind] || r >= need[p.kind] };
            });
        }
        return out;
    }

    // ---- Runtime sources (VS Code) ----
    // CSS color (#rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba()) to #rrggbb; alpha composites over `under` (else dropped).
    function parseCssColor(str, under) {
        const s = String(str == null ? '' : str).trim().toLowerCase();
        let c = null, a = 1, m;
        if ((m = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s))) {
            let h = m[1];
            if (h.length < 6) h = h.split('').map(function (x) { return x + x; }).join('');
            c = [0, 2, 4].map(function (i) { return parseInt(h.substr(i, 2), 16); });
            if (h.length === 8) a = parseInt(h.substr(6, 2), 16) / 255;
        } else if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?))?\s*\)$/.exec(s))) {
            c = [m[1], m[2], m[3]].map(Number);
            if (m[4] != null) a = Number(m[4]) / (m[5] ? 100 : 1);
        }
        if (!c || c.some(isNaN)) return null;
        const hex = toHex(c);
        return a < 1 && under ? composite(hex, under, Math.max(0, a)) : hex;
    }

    // Seed vars in priority order; VS Code writes them on <html style> in its webviews.
    const VSCODE_VARS = {
        background: ['--vscode-editor-background'],
        foreground: ['--vscode-editor-foreground', '--vscode-foreground'],
        accent: ['--vscode-button-background', '--vscode-focusBorder', '--vscode-textLink-foreground'],
        focus: ['--vscode-focusBorder'],
    };

    // Kind: body class (live), then the injected kind, then background luminance. hc: a high contrast kind.
    function vscodeKind(w, bg) {
        const doc = w.document;
        const cl = doc && doc.body && doc.body.classList;
        const has = function (c) { return !!(cl && cl.contains(c)); };
        if (has('vscode-high-contrast-light')) return { base: 'light', hc: true };
        if (has('vscode-high-contrast')) return { base: 'dark', hc: true };
        if (has('vscode-light')) return { base: 'light', hc: false };
        if (has('vscode-dark')) return { base: 'dark', hc: false };
        const k = w.__MTLX_VSCODE_THEME_KIND__;
        if (k === 'highContrastLight' || k === 'highContrast') return { base: k === 'highContrast' ? 'dark' : 'light', hc: true };
        if (k === 'light' || k === 'dark') return { base: k, hc: false };
        return { base: luminance(bg) > 0.18 ? 'light' : 'dark', hc: false };
    }

    // { background, foreground, accent, focus, base, hc } from the webview, or null while --vscode-editor-background is unset.
    function readVscode(w) {
        const doc = w && w.document;
        const el = doc && doc.documentElement;
        if (!el) return null;
        let cs = null;
        try { cs = typeof w.getComputedStyle === 'function' ? w.getComputedStyle(el) : null; } catch (e) { cs = null; }
        const read = function (n) {
            const v = (cs && cs.getPropertyValue(n)) || (el.style && typeof el.style.getPropertyValue === 'function' ? el.style.getPropertyValue(n) : '');
            return String(v || '').trim();
        };
        const pick = function (names, under) {
            for (let i = 0; i < names.length; i++) { const c = parseCssColor(read(names[i]), under); if (c) return c; }
            return null;
        };
        const bg = pick(VSCODE_VARS.background, null);
        if (!bg) return null;
        const kind = vscodeKind(w, bg);
        return { background: bg, foreground: pick(VSCODE_VARS.foreground, bg), accent: pick(VSCODE_VARS.accent, bg), focus: pick(VSCODE_VARS.focus, bg), base: kind.base, hc: kind.hc };
    }

    // Moves the accent seed in OKLCH lightness (nearest first, either way) until white on-accent reads on the accent fills
    // and the accent reads on raised surfaces; the contrast pass cannot fix these (on-accent is shared with status fills).
    function fitAccent(o) {
        const need = LEVELS[o.level || 'AA'];
        const ps = (o.pairs || []).filter(function (p) { return (p.fg === 'on-accent' && /^accent-/.test(p.bg)) || p.fg === 'accent-base'; });
        const lch = toOklch(o.seeds.accent);
        for (let k = 0; k <= 100; k++) {
            for (const dir of k ? [-1, 1] : [1]) {
                const L = lch[0] + dir * k * 0.01;
                if (L < 0 || L > 1) continue;
                const accent = fromOklch([L, lch[1], lch[2]]);
                const d = deriveTheme({ base: o.base, seeds: Object.assign({}, o.seeds, { accent: accent }), overrides: o.overrides, data: o.data });
                if (ps.every(function (p) { return measurePair(d.tokens, p, d.params) >= need[p.kind]; })) return accent;
            }
        }
        return null;
    }

    // Seeds from readVscode to a checked theme: derive, then the contrast pass (only surface-base locked). Falls back to
    // the base accent, then the base seeds; `fallback` is the attempt used (0: the editor's colors, accent fitted).
    function deriveVscode(s, opts) {
        const o = opts || {};
        const data = tokenData(o.data);
        const base = s.base === 'light' ? 'light' : 'dark';
        const level = o.level || 'AA';
        const pairs = o.pairs || [];
        const over = (o.overrides || {})[base] || {};
        const seeds = {};
        if (s.background) seeds.background = s.background;
        if (s.foreground) seeds.foreground = s.foreground;
        const tries = [null];
        if (s.accent) tries[0] = [Object.assign({ accent: fitAccent({ base: base, seeds: Object.assign({ accent: s.accent }, seeds), overrides: over, data: data, pairs: pairs, level: level }) || s.accent }, seeds), s.focus];
        tries.push([seeds, s.focus], [seeds, null], [{}, null]);
        let err = null;
        for (let i = 0; i < tries.length; i++) {
            if (!tries[i]) continue;
            const ov = Object.assign({}, over);
            if (tries[i][1]) ov.focus = tries[i][1];
            try {
                const d = deriveTheme({ base: base, seeds: tries[i][0], overrides: ov, data: data });
                const c = enforceContrast(d.tokens, pairs, level, { params: d.params, locked: ['surface-base'], name: 'vscode' });
                return { base: base, seeds: d.seeds, tokens: c.tokens, params: d.params, moved: c.moved, report: c.report, fallback: i };
            } catch (e) { err = e; }
        }
        throw err;
    }

    function kebab(x) { return x.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }); }

    // One `:root[data-theme="<id>"]` block in the generated CSS format (every token as R G B, then params).
    function themeCss(id, tokens, params, order) {
        const lines = (order || Object.keys(tokens)).map(function (t) { return '  --mtlx-' + t + ': ' + parseHex(tokens[t]).join(' ') + ';'; });
        Object.keys(params || {}).forEach(function (g) {
            Object.keys(params[g]).forEach(function (k) { lines.push('  --mtlx-' + kebab(g) + '-' + kebab(k) + ': ' + params[g][k] + ';'); });
        });
        return ':root[data-theme="' + id + '"] {\n' + lines.join('\n') + '\n}\n';
    }

    // Live VS Code source: derives now (before first paint when the vars are set), then again when <html> style or class
    // or <body> class change the seeds or kind. Publishes data.themes/params/bases[id], one <style>, then data.loaded.
    function startVscode(o) {
        const w = o.root;
        const data = o.data;
        const doc = w.document;
        const id = o.id || 'vscode';
        const src = o.source || {};
        let key = null;
        let last = null;
        let timer = null;
        let style = null;
        function apply() {
            timer = null;
            const s = readVscode(w);
            if (!s) return;
            const k = JSON.stringify(s);
            if (k === key) return;
            key = k;
            if (s.hc) return; // js/shared/theme.js maps high contrast kinds to the hc presets
            let r;
            try {
                r = deriveVscode(s, { data: data, pairs: src.pairs, overrides: src.overrides, level: src.contrast });
            } catch (e) {
                if (w.console) w.console.warn('[theme] VS Code colors could not be matched: ' + e.message);
                return;
            }
            const css = themeCss(id, r.tokens, r.params, Object.keys(data.themes.dark));
            if (css === last) return;
            const first = last === null;
            last = css;
            if (!style) {
                style = doc.createElement('style');
                style.id = 'mtlx-theme-' + id;
                (doc.head || doc.documentElement).appendChild(style);
            }
            style.textContent = css;
            data.themes[id] = r.tokens;
            (data.params = data.params || {})[id] = r.params;
            (data.bases = data.bases || {})[id] = r.base;
            if (typeof data.loaded === 'function') data.loaded(id, !first);
        }
        // The first appearance of the vars applies at once; later changes are debounced (VS Code rewrites in bursts).
        const kick = function () {
            if (key === null || typeof w.setTimeout !== 'function') return apply();
            if (timer === null) timer = w.setTimeout(apply, o.debounce == null ? 50 : o.debounce);
        };
        if (typeof w.MutationObserver === 'function') {
            try {
                const mo = new w.MutationObserver(kick);
                const watchBody = function () { if (doc.body) mo.observe(doc.body, { attributes: true, attributeFilter: ['class'] }); };
                mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
                if (doc.body) watchBody();
                else if (typeof doc.addEventListener === 'function') doc.addEventListener('DOMContentLoaded', function () { watchBody(); kick(); });
            } catch (e) { /* no observer: the first derivation stays */ }
        }
        apply();
        return { refresh: apply };
    }

    const SOURCES = { vscode: startVscode };

    // Entry point for js/gen/themes/<id>.js of a runtime source (registry base auto).
    function startSource(id, opts) {
        const f = SOURCES[id];
        if (!f) throw new Error('theme-engine: unknown theme source "' + id + '"');
        return f(Object.assign({ id: id }, opts));
    }

    return {
        parseHex: parseHex, toHex: toHex, normHex: normHex,
        toOklab: toOklab, fromOklab: fromOklab, toOklch: toOklch, fromOklch: fromOklch,
        mix: mix, adjust: adjust, lighten: lighten, darken: darken, composite: composite,
        luminance: luminance, contrast: contrast, deltaE: deltaE,
        RECIPES: RECIPES, LEVELS: LEVELS,
        deriveTheme: deriveTheme, measurePair: measurePair, enforceContrast: enforceContrast, resolvePreset: resolvePreset, resolveCustom: resolveCustom,
        parseCssColor: parseCssColor, VSCODE_VARS: VSCODE_VARS, readVscode: readVscode, fitAccent: fitAccent,
        deriveVscode: deriveVscode, themeCss: themeCss, startVscode: startVscode, startSource: startSource,
    };
});
