// mtlxColors.js  -  color3/color4 value parsing and display conversion for
// the DocumentColorProvider. Pure Node: must NOT require('vscode'), same
// rule as mtlxSymbols.js  -  symbolProviders.js does the vscode.* boundary
// conversion. Built on mtlxSymbols.scanElements's element tree.
//
// Colorspace handling: an element's OWN colorspace attribute wins, else
// the nearest ancestor's (nodegraph, then the materialx root), else
// MaterialX's own default, lin_rec709. lin_rec709 is converted to sRGB
// for display with the exact IEC 61966-2-1 transfer function;
// srgb_texture and any other colorspace are shown RAW (already
// approximately display-referred, or not a color this provider knows how
// to convert)  -  never rewritten unless the user picks a new color.
'use strict';

const { scanElements, walkAll } = require('./mtlxSymbols');

const COLOR_TYPES = new Set(['color3', 'color4']);

function clamp01(x) {
    return Math.min(1, Math.max(0, x));
}

function linearToSrgb(c) {
    c = clamp01(c);
    return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function srgbToLinear(c) {
    c = clamp01(c);
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Splits a `value="r, g, b"` / `"r,g,b"` string into numeric components
// plus the separator style actually used, so provideColorPresentations
// can round-trip the document's existing formatting instead of always
// normalizing to one style.
function splitValue(raw) {
    const sep = raw.includes(', ') ? ', ' : ',';
    const parts = raw.split(',').map((s) => Number(s.trim()));
    return { parts, sep };
}

// Nearest colorspace: the element's own attribute first, then walking up
// through its ancestors (nodegraph, materialx root, ...).
function colorspaceFor(element) {
    let cur = element;
    while (cur) {
        if (cur.attrs && cur.attrs.colorspace) return cur.attrs.colorspace.value;
        cur = cur.parent;
    }
    return 'lin_rec709';
}

// components (raw, unclamped) + colorspace -> display color in sRGB,
// clamped to 0..1 for display only. lin_rec709 is the only colorspace
// this converts; every other colorspace (including srgb_texture) is
// shown as-is, clamped.
function toDisplayColor(components, colorspace) {
    const [r, g, b, a] = components;
    let red, green, blue;
    if (colorspace === 'lin_rec709') {
        red = linearToSrgb(r);
        green = linearToSrgb(g);
        blue = linearToSrgb(b);
    } else {
        red = clamp01(r);
        green = clamp01(g);
        blue = clamp01(b);
    }
    const alpha = a === undefined ? 1 : clamp01(a);
    return { red, green, blue, alpha };
}

// Inverse of toDisplayColor: a picked sRGB color -> the element's own
// colorspace's raw components. Alpha is carried through unconverted.
function fromDisplayColor(picked, colorspace, hasAlpha) {
    let r, g, b;
    if (colorspace === 'lin_rec709') {
        r = srgbToLinear(picked.red);
        g = srgbToLinear(picked.green);
        b = srgbToLinear(picked.blue);
    } else {
        r = clamp01(picked.red);
        g = clamp01(picked.green);
        b = clamp01(picked.blue);
    }
    const out = [r, g, b];
    if (hasAlpha) out.push(clamp01(picked.alpha));
    return out;
}

// Up to 4 decimals, trailing zeros (and a trailing '.') trimmed.
function formatComponent(n) {
    let s = n.toFixed(4);
    if (s.indexOf('.') !== -1) {
        s = s.replace(/0+$/, '').replace(/\.$/, '');
    }
    return s === '' || s === '-0' ? '0' : s;
}

function formatValue(components, sep) {
    return components.map(formatComponent).join(sep);
}

// Every color3/color4 `value="..."` element in the document (inputs,
// nodedef inputs, constants, tokens  -  anywhere the type+value attributes
// appear), as { element, type, components, sep, colorspace, range }.
// `range` is the value attribute's own char range (quotes excluded).
function collectColorElements(root) {
    const out = [];
    walkAll(root, (el) => {
        const typeAttr = el.attrs.type;
        const valueAttr = el.attrs.value;
        if (!typeAttr || !valueAttr) return;
        if (!COLOR_TYPES.has(typeAttr.value)) return;
        const { parts, sep } = splitValue(valueAttr.value);
        const expected = typeAttr.value === 'color4' ? 4 : 3;
        if (parts.length !== expected || parts.some((n) => Number.isNaN(n))) return;
        out.push({
            element: el,
            type: typeAttr.value,
            components: parts,
            sep,
            colorspace: colorspaceFor(el),
            range: valueAttr.range,
        });
    });
    return out;
}

function scanColorElements(text) {
    const { root } = scanElements(text);
    return collectColorElements(root);
}

module.exports = {
    scanColorElements,
    collectColorElements,
    colorspaceFor,
    toDisplayColor,
    fromDisplayColor,
    formatValue,
    formatComponent,
    splitValue,
    linearToSrgb,
    srgbToLinear,
};
