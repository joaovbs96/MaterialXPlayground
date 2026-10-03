import assert from 'node:assert/strict';
import test from 'node:test';

// Numeric JS transcription of the real display pipeline the studio backdrop's
// inverse must undo: forward tone curve (js/mtlx-engine.js's TONE_CURVE_GLSL,
// mode === 'neutral', lines ~1269-1290), clamp, sRGB OETF
// (DISPLAY_TRANSFORM_SWITCH_GLSL, ~1304-1322); and the inverse, srgb decode
// then the closed-form tone-curve inverse (studioInverseAcesSrgbGlsl's
// neutral branch, ~js/mtlx-engine.js:9211). Both sides are copied to match
// the GLSL verbatim, so a change to either shader source should update this
// test too.

function srgbToLinear([r, g, b]) {
  return [r, g, b].map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
}

function srgbOETF([r, g, b]) {
  return [r, g, b].map((v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
}

function clamp01([r, g, b]) {
  return [r, g, b].map((v) => Math.min(Math.max(v, 0), 1));
}

function neutralForward([r, g, b]) {
  const nsc = 0.76;
  const nds = 0.15;
  let c = [r, g, b];
  const nx = Math.min(...c);
  const noff = nx < 0.08 ? nx - 6.25 * nx * nx : 0.04;
  c = c.map((v) => v - noff);
  const npk = Math.max(...c);
  if (npk >= nsc) {
    const nd = 1 - nsc;
    const nnp = 1 - (nd * nd) / (npk + nd - nsc);
    c = c.map((v) => v * (nnp / npk));
    const ng = 1 - 1 / (nds * (npk - nnp) + 1);
    c = c.map((v) => v * (1 - ng) + nnp * ng);
  }
  return c;
}

// Takes a DISPLAY color (post sRGB OETF), like the shader's `col` param.
function neutralInverse(colDisplay) {
  const nsc = 0.76;
  const nds = 0.15;
  const nd = 1 - nsc;
  let y = srgbToLinear(colDisplay);
  const peak = Math.max(...y);
  let c1;
  if (peak < nsc) {
    c1 = y;
  } else {
    // The forward curve never reaches 1 exactly; clamp just below it to
    // avoid the nd*nd/(1-nnp) division blowing up at white, and rescale y
    // by the same factor so its ratios (hue) stay consistent with the clamp.
    const nnp = Math.min(peak, 0.9999);
    y = y.map((v) => v * (nnp / peak));
    const npk = (nd * nd) / (1 - nnp) - nd + nsc;
    const ng = 1 - 1 / (nds * (npk - nnp) + 1);
    const c2 = y.map((v) => (v - nnp * ng) / (1 - ng));
    c1 = c2.map((v) => v * (npk / nnp));
  }
  const m = Math.min(...c1);
  const nx = m < 0.04 ? Math.sqrt(Math.max(m, 0)) / 2.5 : m + 0.04;
  const noff = nx < 0.08 ? nx - 6.25 * nx * nx : 0.04;
  return c1.map((v) => v + noff);
}

const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

// Same literal colors as js/mtlx-engine.js's STUDIO_GRADIENT_STOPS and
// STUDIO_HOTSPOT, the only colors this inverse actually needs to survive.
// #ffffff (the light gradient's stop1) is the white/division-by-zero case.
const GRADIENT_STOPS = {
  light: ['#f6f6f6', '#ffffff', '#e3e3e3', '#c8c8c8'].map(hexToRgb),
  dark: ['#1d2635', '#242e40', '#131a28', '#0c1220'].map(hexToRgb),
};
const HOTSPOT_COLORS = {
  light: [1, 1, 1],
  dark: [151 / 255, 170 / 255, 200 / 255],
};

// Runs the real round trip: decode+invert to pre-tonemap linear x, then the
// real forward pipeline (tone curve, clamp, OETF) back to a display color,
// and checks x is finite and the result lands within 1/255 of the original.
function checkRoundTrip(label, displayColor) {
  const x = neutralInverse(displayColor);
  x.forEach((v, i) => assert.ok(Number.isFinite(v), `${label} channel ${i}: inverse produced non-finite ${v}`));
  const back = srgbOETF(clamp01(neutralForward(x)));
  back.forEach((v, i) => {
    const diff = Math.abs(v - displayColor[i]);
    assert.ok(diff < 1 / 255, `${label} channel ${i}: round-trip ${v} vs ${displayColor[i]} (diff ${diff})`);
  });
}

test('neutral display transform: studio gradient stops round-trip through the real display pipeline', () => {
  for (const variant of ['light', 'dark']) {
    GRADIENT_STOPS[variant].forEach((stop, i) => checkRoundTrip(`${variant} stop ${i} (${stop})`, stop));
  }
});

test('neutral display transform: studio hotspot colors round-trip through the real display pipeline', () => {
  for (const variant of ['light', 'dark']) {
    checkRoundTrip(`${variant} hotspot`, HOTSPOT_COLORS[variant]);
  }
});
