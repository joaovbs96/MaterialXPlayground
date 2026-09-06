// Dependency-free animated GIF89a encoder (MMCQ quantization, Floyd-
// Steinberg dithering, hash-table LZW) plus an off-main-thread recorder.
// mtlxGifCore has no outer-scope refs: it is stringified into a Blob worker.

function mtlxGifCore() {
    'use strict';

    var SIGBITS = 5;
    var RSHIFT = 8 - SIGBITS;
    var HISTO_SIZE = 1 << (3 * SIGBITS);
    var MAX_ITER = 1000;
    var FRACT_BY_POPULATIONS = 0.75;

    function naturalOrder(a, b) { return a < b ? -1 : (a > b ? 1 : 0); }

    function getColorIndex(r, g, b) { return (r << (2 * SIGBITS)) + (g << SIGBITS) + b; }

    // MMCQ color box: bounds are in reduced (5-bit) channel space.
    // count()/avg() derive from the shared histogram, so no per-pixel
    // list needs to survive past histogram construction.
    function VBox(r1, r2, g1, g2, b1, b2, histo) {
        this.r1 = r1; this.r2 = r2;
        this.g1 = g1; this.g2 = g2;
        this.b1 = b1; this.b2 = b2;
        this.histo = histo;
    }

    VBox.prototype.volume = function (force) {
        if (this._volume === undefined || force) {
            this._volume = (this.r2 - this.r1 + 1) * (this.g2 - this.g1 + 1) * (this.b2 - this.b1 + 1);
        }
        return this._volume;
    };

    VBox.prototype.count = function (force) {
        if (this._count === undefined || force) {
            var npix = 0, i, j, k;
            for (i = this.r1; i <= this.r2; i++) {
                for (j = this.g1; j <= this.g2; j++) {
                    for (k = this.b1; k <= this.b2; k++) {
                        npix += this.histo[getColorIndex(i, j, k)];
                    }
                }
            }
            this._count = npix;
        }
        return this._count;
    };

    VBox.prototype.copy = function () {
        return new VBox(this.r1, this.r2, this.g1, this.g2, this.b1, this.b2, this.histo);
    };

    VBox.prototype.avg = function (force) {
        if (this._avg === undefined || force) {
            var mult = 1 << RSHIFT;
            var ntot = 0, rsum = 0, gsum = 0, bsum = 0, hval, i, j, k;
            for (i = this.r1; i <= this.r2; i++) {
                for (j = this.g1; j <= this.g2; j++) {
                    for (k = this.b1; k <= this.b2; k++) {
                        hval = this.histo[getColorIndex(i, j, k)];
                        ntot += hval;
                        rsum += hval * (i + 0.5) * mult;
                        gsum += hval * (j + 0.5) * mult;
                        bsum += hval * (k + 0.5) * mult;
                    }
                }
            }
            if (ntot) {
                this._avg = [Math.round(rsum / ntot), Math.round(gsum / ntot), Math.round(bsum / ntot)];
            } else {
                this._avg = [
                    Math.round(mult * (this.r1 + this.r2 + 1) / 2),
                    Math.round(mult * (this.g1 + this.g2 + 1) / 2),
                    Math.round(mult * (this.b1 + this.b2 + 1) / 2)
                ];
            }
        }
        return this._avg;
    };

    // Splits the widest axis of a box at the point nearest to its
    // population median, biased so left/right pixel counts balance.
    function medianCutSplit(histo, vbox, axis) {
        var min1, max1, min2, max2, min3, max3;
        if (axis === 'r') { min1 = vbox.r1; max1 = vbox.r2; min2 = vbox.g1; max2 = vbox.g2; min3 = vbox.b1; max3 = vbox.b2; }
        else if (axis === 'g') { min1 = vbox.g1; max1 = vbox.g2; min2 = vbox.r1; max2 = vbox.r2; min3 = vbox.b1; max3 = vbox.b2; }
        else { min1 = vbox.b1; max1 = vbox.b2; min2 = vbox.r1; max2 = vbox.r2; min3 = vbox.g1; max3 = vbox.g2; }

        var partialsum = [], total = 0, i, j, k, sum;
        for (i = min1; i <= max1; i++) {
            sum = 0;
            for (j = min2; j <= max2; j++) {
                for (k = min3; k <= max3; k++) {
                    var idx;
                    if (axis === 'r') idx = getColorIndex(i, j, k);
                    else if (axis === 'g') idx = getColorIndex(j, i, k);
                    else idx = getColorIndex(j, k, i);
                    sum += histo[idx];
                }
            }
            total += sum;
            partialsum[i] = total;
        }

        var splitAt = min1;
        for (i = min1; i <= max1; i++) {
            if (partialsum[i] > total / 2) { splitAt = i; break; }
        }

        var vbox1 = vbox.copy(), vbox2 = vbox.copy();
        var d1 = splitAt - min1, d2 = max1 - splitAt;
        var cut = (d1 <= d2) ? Math.min(max1 - 1, splitAt) : Math.max(min1, splitAt - 1);

        if (axis === 'r') { vbox1.r2 = cut; vbox2.r1 = cut + 1; }
        else if (axis === 'g') { vbox1.g2 = cut; vbox2.g1 = cut + 1; }
        else { vbox1.b2 = cut; vbox2.b1 = cut + 1; }
        return [vbox1, vbox2];
    }

    function medianCutApply(histo, vbox) {
        if (!vbox.count()) return false;
        if (vbox.count() === 1) return [vbox.copy()];

        var rangeR = vbox.r2 - vbox.r1;
        var rangeG = vbox.g2 - vbox.g1;
        var rangeB = vbox.b2 - vbox.b1;
        var maxRange = Math.max(rangeR, rangeG, rangeB);
        if (maxRange === 0) return [vbox.copy()];

        var axis = maxRange === rangeR ? 'r' : (maxRange === rangeG ? 'g' : 'b');
        return medianCutSplit(histo, vbox, axis);
    }

    // Minimal binary-heap-free priority queue: re-sorts lazily, which
    // is fine at the box counts (<=256) this quantizer ever handles.
    function PQueue(comparator) {
        this.contents = [];
        this.sorted = false;
        this.comparator = comparator;
    }
    PQueue.prototype.sort = function () { this.contents.sort(this.comparator); this.sorted = true; };
    PQueue.prototype.push = function (o) { this.contents.push(o); this.sorted = false; };
    PQueue.prototype.pop = function () { if (!this.sorted) this.sort(); return this.contents.pop(); };
    PQueue.prototype.size = function () { return this.contents.length; };
    PQueue.prototype.map = function (f) { return this.contents.map(f); };

    // MMCQ: split by population until ~75% of maxColors boxes exist,
    // then switch to population*volume so sparse-but-wide boxes split too.
    function quantizeColors(histo, initialBox, maxColors) {
        if (maxColors < 2) maxColors = 2;
        if (maxColors > 256) maxColors = 256;

        var pq = new PQueue(function (a, b) { return naturalOrder(a.count(), b.count()); });
        pq.push(initialBox);

        function iterate(target, comparator) {
            var niters = 0;
            while (niters < MAX_ITER) {
                if (pq.size() >= target) return;
                var vbox = pq.pop();
                if (!vbox || !vbox.count()) { if (vbox) pq.push(vbox); niters++; continue; }
                var vboxes = medianCutApply(histo, vbox);
                if (!vboxes) { niters++; continue; }
                pq.push(vboxes[0]);
                if (vboxes.length > 1) pq.push(vboxes[1]);
                pq.comparator = comparator;
                niters++;
            }
        }

        iterate(Math.ceil(FRACT_BY_POPULATIONS * maxColors), pq.comparator);
        pq.comparator = function (a, b) { return naturalOrder(a.count() * a.volume(), b.count() * b.volume()); };
        pq.sorted = false;
        iterate(maxColors, pq.comparator);

        return pq.map(function (vbox) { return vbox.avg(); });
    }

    // Builds the reduced-space histogram and box bounds directly from
    // an RGBA buffer, skipping pixels below the alpha threshold.
    function buildHistogram(rgba, transparent) {
        var histo = new Int32Array(HISTO_SIZE);
        var rmin = 31, rmax = 0, gmin = 31, gmax = 0, bmin = 31, bmax = 0;
        var any = false;
        for (var p = 0; p < rgba.length; p += 4) {
            if (transparent && rgba[p + 3] < 128) continue;
            var rv = rgba[p] >> RSHIFT, gv = rgba[p + 1] >> RSHIFT, bv = rgba[p + 2] >> RSHIFT;
            histo[getColorIndex(rv, gv, bv)]++;
            if (rv < rmin) rmin = rv; if (rv > rmax) rmax = rv;
            if (gv < gmin) gmin = gv; if (gv > gmax) gmax = gv;
            if (bv < bmin) bmin = bv; if (bv > bmax) bmax = bv;
            any = true;
        }
        if (!any) { rmin = gmin = bmin = 0; rmax = gmax = bmax = 0; }
        return { histo: histo, box: new VBox(rmin, rmax, gmin, gmax, bmin, bmax, histo) };
    }

    function bitsForColorCount(n) {
        var bits = 1;
        while ((1 << bits) < n) bits++;
        return Math.max(2, bits);
    }

    function nextPow2(n) {
        var p = 2;
        while (p < n) p *= 2;
        return p;
    }

    // Hash-table LZW encoder for GIF image data (variable code size,
    // clear/EOI codes, 4095-entry limit with clear-and-reset).
    function encodeLZW(indices, colorDepth, out) {
        var EOF = -1;
        var BITS = 12;
        var HSIZE = 5003;
        var masks = [0x0000, 0x0001, 0x0003, 0x0007, 0x000F, 0x001F, 0x003F, 0x007F,
            0x00FF, 0x01FF, 0x03FF, 0x07FF, 0x0FFF, 0x1FFF, 0x3FFF, 0x7FFF, 0xFFFF];

        var initCodeSize = Math.max(2, colorDepth);
        var curPixel = 0;
        var htab = new Int32Array(HSIZE);
        var codetab = new Int32Array(HSIZE);
        var cur_accum = 0, cur_bits = 0;
        var accum = [], a_count = 0;
        var free_ent = 0, maxcode = 0, clear_flg = false, n_bits = 0, g_init_bits = 0;
        var ClearCode = 0, EOFCode = 0;

        function MAXCODE(nb) { return (1 << nb) - 1; }

        function flushChar() {
            if (a_count > 0) {
                out.writeByte(a_count);
                for (var i = 0; i < a_count; i++) out.writeByte(accum[i]);
                a_count = 0;
            }
        }

        function charOut(c) {
            accum[a_count++] = c & 0xff;
            if (a_count >= 254) flushChar();
        }

        function clHash() { for (var i = 0; i < HSIZE; i++) htab[i] = -1; }

        function output(code) {
            cur_accum &= masks[cur_bits];
            if (cur_bits > 0) cur_accum |= (code << cur_bits);
            else cur_accum = code;
            cur_bits += n_bits;
            while (cur_bits >= 8) {
                charOut(cur_accum & 0xff);
                cur_accum >>= 8;
                cur_bits -= 8;
            }
            if (free_ent > maxcode || clear_flg) {
                if (clear_flg) {
                    n_bits = g_init_bits;
                    maxcode = MAXCODE(n_bits);
                    clear_flg = false;
                } else {
                    n_bits++;
                    maxcode = (n_bits === BITS) ? (1 << BITS) : MAXCODE(n_bits);
                }
            }
            if (code === EOFCode) {
                while (cur_bits > 0) {
                    charOut(cur_accum & 0xff);
                    cur_accum >>= 8;
                    cur_bits -= 8;
                }
                flushChar();
            }
        }

        function clBlock() {
            clHash();
            free_ent = ClearCode + 2;
            clear_flg = true;
            output(ClearCode);
        }

        function nextPixel() {
            if (curPixel === indices.length) return EOF;
            return indices[curPixel++];
        }

        g_init_bits = initCodeSize + 1;
        n_bits = g_init_bits;
        maxcode = MAXCODE(n_bits);
        ClearCode = 1 << initCodeSize;
        EOFCode = ClearCode + 1;
        free_ent = ClearCode + 2;
        clear_flg = false;
        a_count = 0;

        out.writeByte(initCodeSize);

        var ent = nextPixel();
        var hshift = 0;
        for (var fc = HSIZE; fc < 65536; fc *= 2) hshift++;
        hshift = 8 - hshift;
        clHash();
        output(ClearCode);

        var c, fcode, i, disp;
        outerLoop:
        while ((c = nextPixel()) !== EOF) {
            fcode = (c << BITS) + ent;
            i = (c << hshift) ^ ent;
            if (htab[i] === fcode) { ent = codetab[i]; continue; }
            if (htab[i] >= 0) {
                disp = (i === 0) ? 1 : (HSIZE - i);
                do {
                    i -= disp;
                    if (i < 0) i += HSIZE;
                    if (htab[i] === fcode) { ent = codetab[i]; continue outerLoop; }
                } while (htab[i] >= 0);
            }
            output(ent);
            ent = c;
            if (free_ent < (1 << BITS)) {
                codetab[i] = free_ent++;
                htab[i] = fcode;
            } else {
                clBlock();
            }
        }
        output(ent);
        output(EOFCode);
        out.writeByte(0);
    }

    // Growable byte buffer, doubling capacity, sliced down on output.
    function ByteBuffer(initial) {
        this.buf = new Uint8Array(initial || 4096);
        this.len = 0;
    }
    ByteBuffer.prototype.ensure = function (extra) {
        if (this.len + extra <= this.buf.length) return;
        var ns = this.buf.length * 2;
        while (ns < this.len + extra) ns *= 2;
        var nb = new Uint8Array(ns);
        nb.set(this.buf.subarray(0, this.len));
        this.buf = nb;
    };
    ByteBuffer.prototype.writeByte = function (b) { this.ensure(1); this.buf[this.len++] = b & 0xff; };
    ByteBuffer.prototype.writeBytes = function (arr) {
        this.ensure(arr.length);
        this.buf.set(arr, this.len);
        this.len += arr.length;
    };
    ByteBuffer.prototype.writeString = function (s) {
        this.ensure(s.length);
        for (var i = 0; i < s.length; i++) this.buf[this.len++] = s.charCodeAt(i) & 0xff;
    };
    ByteBuffer.prototype.writeU16LE = function (v) { this.writeByte(v & 0xff); this.writeByte((v >> 8) & 0xff); };
    ByteBuffer.prototype.toUint8Array = function () { return this.buf.slice(0, this.len); };

    function colorKey(r, g, b) { return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3); }

    function nearestColorIndex(palette, startIdx, r, g, b) {
        var best = startIdx, bestDist = Infinity;
        for (var i = startIdx; i < palette.length; i++) {
            var c = palette[i];
            var dr = c[0] - r, dg = c[1] - g, db = c[2] - b;
            var dist = dr * dr + dg * dg + db * db;
            if (dist < bestDist) { bestDist = dist; best = i; }
        }
        return best;
    }

    function createEncoder(options) {
        options = options || {};
        var width = options.width | 0;
        var height = options.height | 0;
        var repeat = options.repeat !== undefined ? options.repeat : 0;
        var transparent = !!options.transparent;

        var out = new ByteBuffer(4096 + width * height);
        out.writeString('GIF89a');
        out.writeU16LE(width);
        out.writeU16LE(height);
        out.writeByte(0x00);
        out.writeByte(0x00);
        out.writeByte(0x00);

        out.writeByte(0x21); out.writeByte(0xFF); out.writeByte(0x0B);
        out.writeString('NETSCAPE2.0');
        out.writeByte(0x03); out.writeByte(0x01);
        out.writeU16LE(repeat);
        out.writeByte(0x00);

        var finished = false;

        function addFrame(rgba, frameOptions) {
            if (finished) throw new Error('mtlx-gif: encoder already finished');
            frameOptions = frameOptions || {};
            var delayMs = frameOptions.delayMs !== undefined ? frameOptions.delayMs : 40;
            var dither = frameOptions.dither !== undefined ? frameOptions.dither : true;

            var maxColors = transparent ? 255 : 256;
            var hist = buildHistogram(rgba, transparent);
            var quantized = quantizeColors(hist.histo, hist.box, maxColors);
            if (!quantized.length) quantized = [[0, 0, 0]];

            var palette = transparent ? [[0, 0, 0]].concat(quantized) : quantized;
            var startIdx = transparent ? 1 : 0;
            var colorDepth = bitsForColorCount(palette.length);
            var tableSize = nextPow2(Math.max(2, palette.length));

            var indices = new Uint8Array(width * height);
            var cache = new Int32Array(32768);
            for (var ci = 0; ci < cache.length; ci++) cache[ci] = -1;

            var work = null;
            if (dither) {
                work = new Float64Array(width * height * 3);
                for (var p = 0; p < width * height; p++) {
                    work[p * 3] = rgba[p * 4];
                    work[p * 3 + 1] = rgba[p * 4 + 1];
                    work[p * 3 + 2] = rgba[p * 4 + 2];
                }
            }

            function lookup(r, g, b) {
                r = r < 0 ? 0 : (r > 255 ? 255 : r);
                g = g < 0 ? 0 : (g > 255 ? 255 : g);
                b = b < 0 ? 0 : (b > 255 ? 255 : b);
                var key = colorKey(r, g, b);
                var idx = cache[key];
                if (idx === -1) { idx = nearestColorIndex(palette, startIdx, r, g, b); cache[key] = idx; }
                return idx;
            }

            for (var y = 0; y < height; y++) {
                var leftToRight = !dither || (y % 2 === 0);
                var xStart = leftToRight ? 0 : width - 1;
                var xEnd = leftToRight ? width : -1;
                var xStep = leftToRight ? 1 : -1;
                for (var x = xStart; x !== xEnd; x += xStep) {
                    var pos = y * width + x;
                    var alphaLow = transparent && rgba[pos * 4 + 3] < 128;
                    if (alphaLow) { indices[pos] = 0; continue; }

                    var r, g, b;
                    if (dither) { r = work[pos * 3]; g = work[pos * 3 + 1]; b = work[pos * 3 + 2]; }
                    else { r = rgba[pos * 4]; g = rgba[pos * 4 + 1]; b = rgba[pos * 4 + 2]; }

                    var idx = lookup(r, g, b);
                    indices[pos] = idx;

                    if (dither) {
                        var pc = palette[idx];
                        var er = r - pc[0], eg = g - pc[1], eb = b - pc[2];
                        var nxr = x + xStep, nxl = x - xStep;
                        diffuse(work, nxr, y, width, height, er, eg, eb, 7 / 16, transparent, rgba);
                        diffuse(work, nxl, y + 1, width, height, er, eg, eb, 3 / 16, transparent, rgba);
                        diffuse(work, x, y + 1, width, height, er, eg, eb, 5 / 16, transparent, rgba);
                        diffuse(work, nxr, y + 1, width, height, er, eg, eb, 1 / 16, transparent, rgba);
                    }
                }
            }

            var disposal = transparent ? 2 : 1;
            var delayCs = Math.max(2, Math.round(delayMs / 10));
            out.writeByte(0x21); out.writeByte(0xF9); out.writeByte(0x04);
            out.writeByte((disposal << 2) | (transparent ? 1 : 0));
            out.writeU16LE(delayCs);
            out.writeByte(0x00);
            out.writeByte(0x00);

            out.writeByte(0x2C);
            out.writeU16LE(0); out.writeU16LE(0);
            out.writeU16LE(width); out.writeU16LE(height);
            var sizeField = Math.round(Math.log(tableSize) / Math.LN2) - 1;
            out.writeByte(0x80 | (sizeField & 0x07));

            for (var pi = 0; pi < tableSize; pi++) {
                var col = pi < palette.length ? palette[pi] : [0, 0, 0];
                out.writeByte(col[0]); out.writeByte(col[1]); out.writeByte(col[2]);
            }

            encodeLZW(indices, colorDepth, out);
        }

        function finish() {
            if (!finished) { out.writeByte(0x3B); finished = true; }
            return out.toUint8Array();
        }

        return { addFrame: addFrame, finish: finish };
    }

    function diffuse(work, x, y, width, height, er, eg, eb, weight, transparent, rgba) {
        if (x < 0 || x >= width || y < 0 || y >= height) return;
        var pos = y * width + x;
        if (transparent && rgba[pos * 4 + 3] < 128) return;
        work[pos * 3] = clamp255(work[pos * 3] + er * weight);
        work[pos * 3 + 1] = clamp255(work[pos * 3 + 1] + eg * weight);
        work[pos * 3 + 2] = clamp255(work[pos * 3 + 2] + eb * weight);
    }

    function clamp255(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

    return { createEncoder: createEncoder };
}

// Worker bootstrap source, built by stringifying mtlxGifCore so it
// runs with zero closures over this file's scope inside the Blob.
var GIF_WORKER_SOURCE = '(' + mtlxGifCore.toString() + ')';

function buildGifWorkerScript() {
    return 'var __mtlxGif = (' + GIF_WORKER_SOURCE + ')();\n' +
        'var __mtlxEncoder = null;\n' +
        'var __mtlxFrames = 0;\n' +
        'self.onmessage = function (e) {\n' +
        '  var msg = e.data;\n' +
        '  try {\n' +
        '    if (msg.type === "init") {\n' +
        '      __mtlxEncoder = __mtlxGif.createEncoder({ width: msg.width, height: msg.height, repeat: msg.repeat, transparent: msg.transparent });\n' +
        '      __mtlxFrames = 0;\n' +
        '    } else if (msg.type === "frame") {\n' +
        '      var rgba = new Uint8ClampedArray(msg.buffer);\n' +
        '      __mtlxEncoder.addFrame(rgba, { delayMs: msg.delayMs, dither: msg.dither });\n' +
        '      __mtlxFrames++;\n' +
        '      self.postMessage({ type: "frame-done", encoded: __mtlxFrames });\n' +
        '    } else if (msg.type === "finish") {\n' +
        '      var bytes = __mtlxEncoder.finish();\n' +
        '      var buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);\n' +
        '      self.postMessage({ type: "done", buffer: buf }, [buf]);\n' +
        '    }\n' +
        '  } catch (err) {\n' +
        '    self.postMessage({ type: "error", message: (err && err.message) ? err.message : String(err) });\n' +
        '  }\n' +
        '};\n';
}

// Main-thread recorder: pipelines capture and encode via a Worker,
// falling back to yielded main-thread encoding when unavailable.
function createGifRecorder(options) {
    options = options || {};
    var width = options.width | 0;
    var height = options.height | 0;
    var delayMs = options.delayMs !== undefined ? options.delayMs : 40;
    var repeat = options.repeat !== undefined ? options.repeat : 0;
    var transparent = !!options.transparent;
    var dither = options.dither !== undefined ? options.dither : true;
    var onProgress = options.onProgress;

    var encoded = 0;
    var queued = 0;
    var aborted = false;
    var pending = [];
    var finishResolve = null, finishReject = null;
    var finishPromise = null;
    var worker = null;
    var fallbackEncoder = null;

    function reportProgress() {
        if (typeof onProgress === 'function') {
            try { onProgress({ encoded: encoded, queued: queued }); } catch (e) { /* ignore listener errors */ }
        }
    }

    function makeAbortError() {
        var err = new Error('mtlx-gif: recorder aborted');
        err.name = 'AbortError';
        return err;
    }

    function rejectAll(err) {
        aborted = true;
        var waiting = pending.slice();
        pending.length = 0;
        waiting.forEach(function (p) { p.reject(err); });
        if (finishReject) { finishReject(err); finishReject = null; finishResolve = null; }
    }

    function tryCreateWorker() {
        if (typeof Worker === 'undefined' || typeof Blob === 'undefined' ||
            typeof URL === 'undefined' || !URL.createObjectURL) return null;
        try {
            var src = buildGifWorkerScript();
            var blob = new Blob([src], { type: 'application/javascript' });
            var url = URL.createObjectURL(blob);
            var w = new Worker(url);
            URL.revokeObjectURL(url);
            return w;
        } catch (e) {
            return null;
        }
    }

    worker = tryCreateWorker();

    if (worker) {
        worker.onmessage = function (e) {
            var msg = e.data;
            if (msg.type === 'frame-done') {
                encoded = msg.encoded;
                queued = Math.max(0, queued - 1);
                reportProgress();
                var p = pending.shift();
                if (p) p.resolve();
            } else if (msg.type === 'done') {
                var blob = new Blob([msg.buffer], { type: 'image/gif' });
                if (finishResolve) { finishResolve(blob); finishResolve = null; finishReject = null; }
            } else if (msg.type === 'error') {
                rejectAll(new Error(msg.message));
            }
        };
        worker.onerror = function (e) {
            rejectAll(new Error(e && e.message ? e.message : 'mtlx-gif: worker error'));
        };
        worker.postMessage({ type: 'init', width: width, height: height, repeat: repeat, transparent: transparent });
    } else {
        fallbackEncoder = mtlxGifCore().createEncoder({ width: width, height: height, repeat: repeat, transparent: transparent });
    }

    function extractRgba(imageData) {
        if (!imageData || !imageData.data) throw new Error('mtlx-gif: addFrame requires an ImageData-like object');
        if (imageData.width !== undefined && imageData.width !== width) throw new Error('mtlx-gif: frame width mismatch');
        if (imageData.height !== undefined && imageData.height !== height) throw new Error('mtlx-gif: frame height mismatch');
        if (imageData.data.length !== width * height * 4) throw new Error('mtlx-gif: frame data length mismatch');
        return imageData.data;
    }

    function addFrame(imageData, frameOptions) {
        if (aborted) return Promise.reject(makeAbortError());
        var srcData = extractRgba(imageData);
        frameOptions = frameOptions || {};
        var frameDelay = frameOptions.delayMs !== undefined ? frameOptions.delayMs : delayMs;
        var frameDither = frameOptions.dither !== undefined ? frameOptions.dither : dither;

        var buf = new ArrayBuffer(srcData.length);
        new Uint8ClampedArray(buf).set(srcData);

        if (worker) {
            queued++;
            return new Promise(function (resolve, reject) {
                pending.push({ resolve: resolve, reject: reject });
                worker.postMessage({ type: 'frame', buffer: buf, delayMs: frameDelay, dither: frameDither }, [buf]);
            });
        }

        return new Promise(function (resolve, reject) {
            setTimeout(function () {
                if (aborted) { reject(makeAbortError()); return; }
                try {
                    fallbackEncoder.addFrame(new Uint8ClampedArray(buf), { delayMs: frameDelay, dither: frameDither });
                    encoded++;
                    reportProgress();
                    resolve();
                } catch (err) {
                    reject(err);
                }
            }, 0);
        });
    }

    function finish() {
        if (aborted) return Promise.reject(makeAbortError());
        if (finishPromise) return finishPromise;

        if (worker) {
            finishPromise = new Promise(function (resolve, reject) {
                finishResolve = resolve;
                finishReject = reject;
                worker.postMessage({ type: 'finish' });
            });
        } else {
            finishPromise = new Promise(function (resolve, reject) {
                setTimeout(function () {
                    if (aborted) { reject(makeAbortError()); return; }
                    try {
                        var bytes = fallbackEncoder.finish();
                        resolve(new Blob([bytes], { type: 'image/gif' }));
                    } catch (err) {
                        reject(err);
                    }
                }, 0);
            });
        }
        return finishPromise;
    }

    function abort() {
        if (aborted) return;
        if (worker) worker.terminate();
        rejectAll(makeAbortError());
    }

    return { addFrame: addFrame, finish: finish, abort: abort };
}

if (typeof window !== 'undefined') {
    Object.assign(window, { createGifRecorder: createGifRecorder, mtlxGifCore: mtlxGifCore });
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createGifRecorder: createGifRecorder, mtlxGifCore: mtlxGifCore };
}
