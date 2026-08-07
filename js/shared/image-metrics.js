// ------------------------------------------------------------------
// Pure-JS image comparison metrics for the render-comparison feature.
// Operates on RGBA buffers (Uint8ClampedArray/Uint8Array) as produced
// by CanvasRenderingContext2D.getImageData. Alpha is ignored. Exposed
// as window.MtlxImageMetrics; no module system in this codebase.
// ------------------------------------------------------------------

function assertBufferSize(buf, w, h, name) {
    if (buf.length !== w * h * 4) {
        throw new Error(`MtlxImageMetrics: ${name} length ${buf.length} does not match ${w}x${h}x4`);
    }
}

// Rec.709 luma plane, computed once and reused across the SSIM window pass.
function toLumaPlane(buf, w, h) {
    const out = new Float32Array(w * h);
    for (let i = 0, p = 0; p < out.length; i += 4, p++) {
        out[p] = 0.2126 * buf[i] + 0.7152 * buf[i + 1] + 0.0722 * buf[i + 2];
    }
    return out;
}

const SSIM_WIN = 8;
const SSIM_STRIDE = 4;
const SSIM_K1 = 0.01;
const SSIM_K2 = 0.03;
const SSIM_L = 255;
const SSIM_C1 = (SSIM_K1 * SSIM_L) ** 2;
const SSIM_C2 = (SSIM_K2 * SSIM_L) ** 2;

// Mean SSIM over overlapping 8x8 windows (stride 4); windows that don't
// fully fit inside the image are skipped rather than clamped.
function computeSSIM(grayA, grayB, w, h) {
    if (w < SSIM_WIN || h < SSIM_WIN) return 1;

    let ssimSum = 0;
    let windowCount = 0;
    const n = SSIM_WIN * SSIM_WIN;

    for (let wy = 0; wy <= h - SSIM_WIN; wy += SSIM_STRIDE) {
        for (let wx = 0; wx <= w - SSIM_WIN; wx += SSIM_STRIDE) {
            let sumA = 0, sumB = 0;
            for (let y = 0; y < SSIM_WIN; y++) {
                let row = (wy + y) * w + wx;
                for (let x = 0; x < SSIM_WIN; x++, row++) {
                    sumA += grayA[row];
                    sumB += grayB[row];
                }
            }
            const meanA = sumA / n;
            const meanB = sumB / n;

            let varA = 0, varB = 0, cov = 0;
            for (let y = 0; y < SSIM_WIN; y++) {
                let row = (wy + y) * w + wx;
                for (let x = 0; x < SSIM_WIN; x++, row++) {
                    const da = grayA[row] - meanA;
                    const db = grayB[row] - meanB;
                    varA += da * da;
                    varB += db * db;
                    cov += da * db;
                }
            }
            varA /= n;
            varB /= n;
            cov /= n;

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

    const grayA = toLumaPlane(a, w, h);
    const grayB = toLumaPlane(b, w, h);
    const ssim = computeSSIM(grayA, grayB, w, h);

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

function makeDiffHeatmap(a, b, w, h, { gain = 1 } = {}) {
    assertBufferSize(a, w, h, 'a');
    assertBufferSize(b, w, h, 'b');

    const out = new ImageData(w, h);
    const data = out.data;
    for (let i = 0; i < a.length; i += 4) {
        const dr = Math.abs(a[i] - b[i]);
        const dg = Math.abs(a[i + 1] - b[i + 1]);
        const db = Math.abs(a[i + 2] - b[i + 2]);
        const d = (dr + dg + db) / 3;
        const t = Math.min(1, (d / 255) * gain);
        const [r, g, bl] = rampColor(t);
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = bl;
        data[i + 3] = 255;
    }
    return out;
}

window.MtlxImageMetrics = { computeMetrics, makeDiffHeatmap };
