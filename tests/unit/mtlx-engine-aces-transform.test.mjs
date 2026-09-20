import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const enginePath = path.join(root, 'js', 'mtlx-engine.js');
const engineSource = fs.readFileSync(enginePath, 'utf8');

// Karma's own EXR-linear -> PNG-sRGB ground truth for the 6 neutral chart
// patches (brown-chart/chart_table.json), used below to check the fitted
// curve reproduces Karma's real "ACES 1.0 - SDR Video" response.
const chartTablePath = path.join(
  root, 'scratchpad', 'displacement-verified', 'color-parity', 'brown-chart', 'chart_table.json',
);
const chartTable = JSON.parse(fs.readFileSync(chartTablePath, 'utf8'));
const neutrals = chartTable.filter((r) => r.label === 'white' || r.label.startsWith('neutral') || r.label === 'black');

// Exact numeric transcription of TONE_CURVE_GLSL('aces') (js/mtlx-engine.js),
// matrices copied verbatim, WITHOUT the 1/0.6 pre-scale that was removed.
function acesFit([r, g, b]) {
  const acesIn = [
    [0.59719, 0.35458, 0.04823],
    [0.07600, 0.90834, 0.01566],
    [0.02840, 0.13383, 0.83777],
  ];
  const acesOut = [
    [1.60475, -0.53108, -0.07367],
    [-0.10208, 1.10813, -0.00605],
    [-0.00327, -0.07276, 1.07602],
  ];
  const matmul = (m, v) => [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
  const x = matmul(acesIn, [r, g, b]);
  const a = x.map((v) => v * (v + 0.0245786) - 0.000090537);
  const bb = x.map((v) => v * (0.983729 * v + 0.4329510) + 0.238081);
  const ab = a.map((v, i) => v / bb[i]);
  return matmul(acesOut, ab);
}

function srgbOETF([r, g, b]) {
  return [r, g, b].map((v) => {
    v = Math.min(Math.max(v, 0), 1);
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  });
}

test('TONE_CURVE_GLSL aces path has no 1/0.6 pre-scale (three\'s normalisation constant removed)', () => {
  assert.doesNotMatch(engineSource, /_c \*= \(1\.0 \/ 0\.6\)/);
  assert.doesNotMatch(engineSource, /acesInInv \* x\) \* 0\.6/);
});

test('mid-gray linear 0.18 stays finite and monotonic through the fit (no pre-scale)', () => {
  const midGray = acesFit([0.18, 0.18, 0.18]);
  const srgb255 = srgbOETF(midGray).map((v) => v * 255);
  midGray.forEach((v) => assert.ok(Number.isFinite(v) && v >= 0));
  // Without the removed 1/0.6 pre-scale, 0.18 linear should land well below
  // the old over-bright output (roughly mid-gray sRGB, not blown toward white).
  srgb255.forEach((v) => assert.ok(v > 80 && v < 160, `expected mid-gray sRGB, got ${v}`));
});

test('fitted ACES curve (no pre-scale) reproduces Karma\'s neutral-patch PNG within 3 sRGB units', () => {
  assert.ok(neutrals.length >= 6, 'expected the 6 neutral chart patches in chart_table.json');
  let sqerr = 0;
  let n = 0;
  for (const row of neutrals) {
    const acesOutC = acesFit(row.karma_exr_linear);
    const srgb255 = srgbOETF(acesOutC).map((v) => v * 255);
    srgb255.forEach((v, i) => {
      const diff = Math.abs(v - row.karma_png_srgb255[i]);
      assert.ok(diff <= 3, `${row.label} channel ${i}: viewer-fit ${v} vs Karma PNG ${row.karma_png_srgb255[i]} (diff ${diff})`);
      sqerr += diff * diff;
      n += 1;
    });
  }
  const rms = Math.sqrt(sqerr / n);
  assert.ok(rms <= 3, `RMS over neutrals too high: ${rms}`);
});

test('raster default display transform (srgb) is untouched: OETF only, no ACES curve text nearby', () => {
  const idx = engineSource.indexOf("if (mode === 'lin_rec709') return head");
  assert.notEqual(idx, -1, 'ACES_SRGB_GLSL lin_rec709 branch not found');
  // srgb mode must still skip TONE_CURVE_GLSL entirely (guarded branch call
  // only fires for 'aces'/'neutral' inside TONE_CURVE_GLSL itself).
  assert.match(engineSource, /if \(mode === 'aces'\) \{/);
  assert.match(engineSource, /if \(mode === 'neutral'\) \{/);
  assert.match(engineSource, /return '';\s*\n\};/); // srgb/lin_rec709 fall through to the empty-string return
});
