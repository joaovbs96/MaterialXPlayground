// ------------------------------------------------------------------
// Pure-JS image comparison metrics for the render-comparison feature.
// Operates on RGBA buffers as produced by getImageData; alpha ignored.
// Tuned for live per-frame use: SSIM runs on summed-area tables (O(1)
// per window) and the diff heatmap uses a precomputed log-mapped LUT
// with no per-pixel allocation. Scratch buffers are cached module-
// level and reused across calls. Exposed as window.MtlxImageMetrics.
// ------------------------------------------------------------------

function assertBufferSize(buf, w, h, name) {
    if (buf.length !== w * h * 4) {
        throw new Error(`MtlxImageMetrics: ${name} length ${buf.length} does not match ${w}x${h}x4`);
    }
}

const SSIM_WIN = 8;
const SSIM_STRIDE = 4;
const SSIM_K1 = 0.01;
const SSIM_K2 = 0.03;
const SSIM_L = 255;
const SSIM_C1 = (SSIM_K1 * SSIM_L) ** 2;
const SSIM_C2 = (SSIM_K2 * SSIM_L) ** 2;

// Reused scratch buffers for the luma planes and their summed-area
// tables. Reallocated only when the frame size (w,h) changes.
let ssimCacheW = 0;
let ssimCacheH = 0;
let lumaA = new Float32Array(0);
let lumaB = new Float32Array(0);
let satA = new Float64Array(0);
let satB = new Float64Array(0);
let satAA = new Float64Array(0);
let satBB = new Float64Array(0);
let satAB = new Float64Array(0);

function ensureSsimBuffers(w, h) {
    if (w === ssimCacheW && h === ssimCacheH) return;
    ssimCacheW = w;
    ssimCacheH = h;
    const n = w * h;
    const sn = (w + 1) * (h + 1);
    lumaA = new Float32Array(n);
    lumaB = new Float32Array(n);
    satA = new Float64Array(sn);
    satB = new Float64Array(sn);
    satAA = new Float64Array(sn);
    satBB = new Float64Array(sn);
    satAB = new Float64Array(sn);
}

// Rec.709 luma plane, written into a reused buffer (no allocation).
function writeLumaPlane(buf, out) {
    for (let i = 0, p = 0; p < out.length; i += 4, p++) {
        out[p] = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
    }
}

// Builds summed-area tables for both luma planes and their squares/
// product in a single pass. Tables are (w+1)x(h+1); row/col 0 stay
// zero from allocation and are never touched again on reuse.
function buildSummedAreaTables(w, h) {
    const stride = w + 1;
    for (let y = 1; y <= h; y++) {
        const rowBase = y * stride;
        const prevRowBase = rowBase - stride;
        const srcRow = (y - 1) * w;
        let rA = 0, rB = 0, rAA = 0, rBB = 0, rAB = 0;
        for (let x = 1; x <= w; x++) {
            const va = lumaA[srcRow + x - 1];
            const vb = lumaB[srcRow + x - 1];
            rA += va;
            rB += vb;
            rAA += va * va;
            rBB += vb * vb;
            rAB += va * vb;
            const idx = rowBase + x;
            const pidx = prevRowBase + x;
            satA[idx] = satA[pidx] + rA;
            satB[idx] = satB[pidx] + rB;
            satAA[idx] = satAA[pidx] + rAA;
            satBB[idx] = satBB[pidx] + rBB;
            satAB[idx] = satAB[pidx] + rAB;
        }
    }
}

// Mean SSIM over overlapping 8x8 windows (stride 4), read from the
// summed-area tables in O(1) per window; windows that don't fully
// fit inside the image are skipped rather than clamped.
function computeSSIM(w, h) {
    if (w < SSIM_WIN || h < SSIM_WIN) return 1;

    const stride = w + 1;
    const n = SSIM_WIN * SSIM_WIN;
    let ssimSum = 0;
    let windowCount = 0;

    for (let wy = 0; wy <= h - SSIM_WIN; wy += SSIM_STRIDE) {
        const y0 = wy, y1 = wy + SSIM_WIN;
        for (let wx = 0; wx <= w - SSIM_WIN; wx += SSIM_STRIDE) {
            const x0 = wx, x1 = wx + SSIM_WIN;
            const i00 = y0 * stride + x0, i01 = y0 * stride + x1;
            const i10 = y1 * stride + x0, i11 = y1 * stride + x1;

            const sumA = satA[i11] - satA[i10] - satA[i01] + satA[i00];
            const sumB = satB[i11] - satB[i10] - satB[i01] + satB[i00];
            const sumAA = satAA[i11] - satAA[i10] - satAA[i01] + satAA[i00];
            const sumBB = satBB[i11] - satBB[i10] - satBB[i01] + satBB[i00];
            const sumAB = satAB[i11] - satAB[i10] - satAB[i01] + satAB[i00];

            const meanA = sumA / n;
            const meanB = sumB / n;
            let varA = sumAA / n - meanA * meanA;
            let varB = sumBB / n - meanB * meanB;
            const cov = sumAB / n - meanA * meanB;
            if (varA < 0) varA = 0;
            if (varB < 0) varB = 0;

            const numerator = (2 * meanA * meanB + SSIM_C1) * (2 * cov + SSIM_C2);
            const denominator = (meanA * meanA + meanB * meanB + SSIM_C1) * (varA + varB + SSIM_C2);
            ssimSum += numerator / denominator;
            windowCount++;
        }
    }

    return windowCount === 0 ? 1 : ssimSum / windowCount;
}

function computeMetrics(a, b, w, h) {
    assertBufferSize(a, w, h, 'a');
    assertBufferSize(b, w, h, 'b');

    let sumAbs = 0;
    let sumSq = 0;
    for (let i = 0; i < a.length; i += 4) {
        const dr = a[i] - b[i];
        const dg = a[i + 1] - b[i + 1];
        const db = a[i + 2] - b[i + 2];
        sumAbs += Math.abs(dr) + Math.abs(dg) + Math.abs(db);
        sumSq += dr * dr + dg * dg + db * db;
    }

    const sampleCount = w * h * 3;
    const meanAbsDiff = sumAbs / sampleCount;
    const mse = sumSq / sampleCount;
    const rmse = Math.sqrt(mse);
    const psnr = rmse === 0 ? Infinity : 20 * Math.log10(255 / rmse);

    ensureSsimBuffers(w, h);
    writeLumaPlane(a, lumaA);
    writeLumaPlane(b, lumaB);
    buildSummedAreaTables(w, h);
    const ssim = computeSSIM(w, h);

    return { rmse, psnr, meanAbsDiff, ssim };
}

// Piecewise-linear false-color ramp: black -> blue -> cyan -> yellow -> red.
const HEATMAP_STOPS = [
    [0, 0, 0, 0],
    [0.25, 0, 0, 255],
    [0.5, 0, 255, 255],
    [0.75, 255, 255, 0],
    [1, 255, 0, 0],
];

// Used only while building HEATMAP_LUT below (256 calls at module
// load); not on the per-pixel hot path.
function rampColor(t) {
    for (let i = 1; i < HEATMAP_STOPS.length; i++) {
        const [t1, r1, g1, b1] = HEATMAP_STOPS[i];
        if (t <= t1) {
            const [t0, r0, g0, b0] = HEATMAP_STOPS[i - 1];
            const span = t1 - t0;
            const f = span === 0 ? 0 : (t - t0) / span;
            return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f];
        }
    }
    const last = HEATMAP_STOPS[HEATMAP_STOPS.length - 1];
    return [last[1], last[2], last[3]];
}

// Log-mapped diff -> RGB lookup table (d=0..255 -> 3 bytes each), so
// small differences stay visible without an adjustable gain control.
// d=0 maps to t=0, which is exactly the black stop.
const HEATMAP_LUT = new Uint8Array(256 * 3);
(function buildHeatmapLUT() {
    for (let d = 0; d < 256; d++) {
        const t = Math.min(1, Math.log2(1 + d) / 8);
        const [r, g, bl] = rampColor(t);
        HEATMAP_LUT[d * 3] = Math.round(r);
        HEATMAP_LUT[d * 3 + 1] = Math.round(g);
        HEATMAP_LUT[d * 3 + 2] = Math.round(bl);
    }
})();

// Reused ImageData; ImageData can't be resized, so it's recreated
// only when w/h change.
let heatCacheW = 0;
let heatCacheH = 0;
let heatImageData = null;

function makeDiffHeatmap(a, b, w, h) {
    assertBufferSize(a, w, h, 'a');
    assertBufferSize(b, w, h, 'b');

    if (w !== heatCacheW || h !== heatCacheH) {
        heatImageData = new ImageData(w, h);
        heatCacheW = w;
        heatCacheH = h;
    }

    const data = heatImageData.data;
    for (let i = 0; i < a.length; i += 4) {
        const dr = Math.abs(a[i] - b[i]);
        const dg = Math.abs(a[i + 1] - b[i + 1]);
        const db = Math.abs(a[i + 2] - b[i + 2]);
        const lutIdx = Math.round((dr + dg + db) / 3) * 3;
        data[i] = HEATMAP_LUT[lutIdx];
        data[i + 1] = HEATMAP_LUT[lutIdx + 1];
        data[i + 2] = HEATMAP_LUT[lutIdx + 2];
        data[i + 3] = 255;
    }
    return heatImageData;
}

window.MtlxImageMetrics = { computeMetrics, makeDiffHeatmap };
