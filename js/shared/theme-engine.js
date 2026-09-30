// Theme engine: OKLab/OKLCH color math, WCAG contrast, recipe-based theme derivation and a contrast pass.
// Used by scripts/build-theme.mjs to resolve presets; never loaded eagerly (a future theme editor may load it).
// UMD: window.MtlxThemeEngine in the browser, module.exports under Node.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.MtlxThemeEngine = api;
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
            'brand-accent': { fixedFromBase: true },
            'brand-logo-inner': { fixedFromBase: true },
            'code-fg': { from: 'background', mixToward: 'foreground', amount: 0.874 },
            'code-muted': { from: 'background', mixToward: 'foreground', amount: 0.45 },
            'code-name': { from: 'accent', lightness: 0.0907, chroma: 0.763, hue: -5.2 },
            'code-attr': { from: 'background', mixToward: 'foreground', amount: 0.665 },
            'code-string': { fixedFromBase: true },
            'code-inline-bg': { from: 'background', mixToward: 'foreground', amount: 0.215 },
            'code-inline-fg': { fixedFromBase: true },
            'code-block-bg': { from: 'background', mixToward: 'foreground', amount: -0.039 },
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
            'surface-deep': { from: 'background', mixToward: 'foreground', amount: -0.106 },
            'scrim-alt': { fixedFromBase: true },
            'on-accent-soft': { from: 'background', mixToward: 'foreground', amount: 1 },
            'success-border-muted': { fixedFromBase: true },
            'warning-bg-strong': { fixedFromBase: true },
            'warning-border-alt': { fixedFromBase: true },
            'error-text-strong': { fixedFromBase: true },
            'error-bg-strong': { fixedFromBase: true },
            'error-border-strong': { fixedFromBase: true },
            'info-border-alt': { fixedFromBase: true },
            'notice-bg': { from: 'background', mixToward: 'foreground', amount: 0.091 },
            'notice-line': { from: 'background', mixToward: 'foreground', amount: 0.31 },
            'notice-text': { from: 'background', mixToward: 'foreground', amount: 0.949 },
            'notice-text-strong': { from: 'background', mixToward: 'foreground', amount: 1.002 },
            'experimental-fill': { fixedFromBase: true },
            'code-inline-fg-alt': { fixedFromBase: true },
            'code-block-bg-alt': { from: 'background', mixToward: 'foreground', amount: -0.004 },
        },
        light: {
            'surface-base': { from: 'background' },
            'surface-raised': { from: 'background', mixToward: 'foreground', amount: -0.044 },
            'surface-sunken': { from: 'background', mixToward: 'foreground', amount: -0.023 },
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
            'brand-accent': { fixedFromBase: true },
            'brand-logo-inner': { fixedFromBase: true },
            'code-fg': { from: 'background', mixToward: 'foreground', amount: 0.91 },
            'code-muted': { from: 'background', mixToward: 'foreground', amount: 0.55 },
            'code-name': { from: 'accent', lightness: -0.058, chroma: 1.009, hue: 1.5 },
            'code-attr': { from: 'background', mixToward: 'foreground', amount: 0.688 },
            'code-string': { fixedFromBase: true },
            'code-inline-bg': { from: 'background', mixToward: 'foreground', amount: 0.052 },
            'code-inline-fg': { fixedFromBase: true },
            'code-block-bg': { from: 'background', mixToward: 'foreground', amount: -0.011 },
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
            'surface-deep': { from: 'background', mixToward: 'foreground', amount: -0.023 },
            'scrim-alt': { fixedFromBase: true },
            'on-accent-soft': { from: 'background', mixToward: 'foreground', amount: -0.044 },
            'success-border-muted': { fixedFromBase: true },
            'warning-bg-strong': { fixedFromBase: true },
            'warning-border-alt': { fixedFromBase: true },
            'error-text-strong': { fixedFromBase: true },
            'error-bg-strong': { fixedFromBase: true },
            'error-border-strong': { fixedFromBase: true },
            'info-border-alt': { fixedFromBase: true },
            'notice-bg': { from: 'background', mixToward: 'foreground', amount: -0.044 },
            'notice-line': { from: 'background', mixToward: 'foreground', amount: 0.478 },
            'notice-text': { from: 'background', mixToward: 'foreground', amount: 0.91 },
            'notice-text-strong': { from: 'background', mixToward: 'foreground', amount: 1 },
            'experimental-fill': { fixedFromBase: true },
            'code-inline-fg-alt': { fixedFromBase: true },
            'code-block-bg-alt': { from: 'background', mixToward: 'foreground', amount: -0.011 },
        },
    };

    const SEED_OF = { background: 'surface-base', foreground: 'fg', accent: 'accent-base' };

    function tokenData(data) {
        const d = data || root.MTLX_THEME_TOKENS || (typeof require === 'function' ? require('./theme-tokens.js') : null);
        if (!d || !d.themes || !d.themes.dark) throw new Error('theme-engine: no token data');
        return d;
    }

    function evalRecipe(r, token, seeds, baseMap, darkMap) {
        if (!r || r.fixedFromBase) return normHex(token in baseMap ? baseMap[token] : darkMap[token]);
        const src = seeds[r.from];
        if (!src) throw new Error('theme-engine: recipe for "' + token + '" names unknown seed "' + r.from + '"');
        if (r.mixToward) return mix(src, seeds[r.mixToward], r.amount);
        if (r.lightness != null || r.chroma != null || r.hue != null) return adjust(src, r);
        return normHex(src);
    }

    function mergeParams(baseParams, extra) {
        const out = {};
        Object.keys(baseParams || {}).forEach(function (g) { out[g] = Object.assign({}, baseParams[g]); });
        Object.keys(extra || {}).forEach(function (g) { out[g] = Object.assign(out[g] || {}, extra[g]); });
        return out;
    }

    // Full token map from a base ('dark' | 'light'), partial seeds and partial overrides (token -> hex).
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
        Object.keys(darkMap).forEach(function (t) {
            if (t in overrides) { tokens[t] = normHex(overrides[t]); sources[t] = 'override'; return; }
            const r = recipes[t];
            tokens[t] = evalRecipe(r, t, seeds, baseMap, darkMap);
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
                if (locked.has(p.fg)) throw new Error('theme-engine: ' + label + 'pair ' + name + ' fails (' + measurePair(tokens, p, o.params).toFixed(2) + ' < ' + req + ') and its foreground is a seed');
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
                if (!found) throw new Error('theme-engine: ' + label + 'pair ' + name + ' (' + p.kind + ', needs ' + req + ') cannot be satisfied by moving ' + p.fg);
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

    return {
        parseHex: parseHex, toHex: toHex, normHex: normHex,
        toOklab: toOklab, fromOklab: fromOklab, toOklch: toOklch, fromOklch: fromOklch,
        mix: mix, adjust: adjust, lighten: lighten, darken: darken, composite: composite,
        luminance: luminance, contrast: contrast, deltaE: deltaE,
        RECIPES: RECIPES, LEVELS: LEVELS,
        deriveTheme: deriveTheme, measurePair: measurePair, enforceContrast: enforceContrast, resolvePreset: resolvePreset,
    };
});
