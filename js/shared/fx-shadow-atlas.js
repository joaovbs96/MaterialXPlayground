// Key-light/stage shadow atlas pieces shared by renderers (moved out of the Scene
// renderer in render parity P9): atlas and record layout, the moments, blur and
// entry-depth materials, and pure face fitting/allocation. Exports MtlxRender.shadowAtlas.
(function () {
    'use strict';

    // Shadow pass for MaterialX materials. MaterialX generates
    // mx_shadow_occlusion() against a variance (moments) map, so we render our own
    // vec2(z, z*z) rather than reuse three's VSM target, whose packing is not
    // guaranteed to match and would misread rather than error.
    // A pool of 512px cells, 8 x 4 = 32 total. A directional caster gets one
    // 1024px tile (2x2 cells); an omni/area caster gets up to six single cells,
    // one per cube face. RGBA16F at 4096x2048 is 64MB, RGBA32F is 128MB.
    const SHADOW_CELL_SIZE = 512;
    const SHADOW_CELL_COLS = 8;
    const SHADOW_CELL_ROWS = 4;
    const SHADOW_CELL_TOTAL = SHADOW_CELL_COLS * SHADOW_CELL_ROWS;
    const SHADOW_TILE_SIZE = SHADOW_CELL_SIZE * 2;
    const SHADOW_TILE_COLS = SHADOW_CELL_COLS / 2;
    const SHADOW_TILE_ROWS = SHADOW_CELL_ROWS / 2;
    const SHADOW_ATLAS_WIDTH = SHADOW_CELL_SIZE * SHADOW_CELL_COLS;
    const SHADOW_ATLAS_HEIGHT = SHADOW_CELL_SIZE * SHADOW_CELL_ROWS;
    // Compile-time GLSL array size for shadow faces, set by mtlx-engine.js and
    // read here so the two files cannot drift out of sync.
    const SHADOW_ATLAS_FACE_SLOTS = (typeof window !== 'undefined' && Number(window.SHADOW_FACE_SLOTS)) || 24;
    // Shadow transmittance records: one 256px cell per face, two planes (R1
    // nearest, R2 product) stacked vertically in one texture. R2's cell is
    // always R1's offset by half the height; see mx_shadow_transmittance.
    // Two records bound the design: stacked solids share the nearest entry
    // depth and a third transmitter is only present in the product record.
    const SHADOW_RECORD_CELL_SIZE = 256;
    const SHADOW_RECORD_COLS = 8;
    const SHADOW_RECORD_ROWS = Math.ceil(SHADOW_ATLAS_FACE_SLOTS / SHADOW_RECORD_COLS);
    const SHADOW_RECORD_WIDTH = SHADOW_RECORD_CELL_SIZE * SHADOW_RECORD_COLS;
    const SHADOW_RECORD_HEIGHT = SHADOW_RECORD_CELL_SIZE * SHADOW_RECORD_ROWS * 2;
    const shadowRecordCellRect = (faceIndex) => ({
        px: (faceIndex % SHADOW_RECORD_COLS) * SHADOW_RECORD_CELL_SIZE,
        py: Math.floor(faceIndex / SHADOW_RECORD_COLS) * SHADOW_RECORD_CELL_SIZE,
        size: SHADOW_RECORD_CELL_SIZE,
    });
    const shadowRecordCellUv = (faceIndex) => {
        const rect = shadowRecordCellRect(faceIndex);
        return new THREE.Vector4(
            rect.px / SHADOW_RECORD_WIDTH, rect.py / SHADOW_RECORD_HEIGHT,
            rect.size / SHADOW_RECORD_WIDTH, rect.size / SHADOW_RECORD_HEIGHT,
        );
    };
    // Variance shadow maps are meant to be blurred: filtering the moments is what
    // turns the hard per-texel test into a soft edge. Without it an orthographic
    // frustum covering a whole room stair-steps every silhouette.
    const createShadowBlurMaterial = () => new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: [
            'in vec3 position;',
            'in vec2 uv;',
            'out vec2 vUv;',
            'void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        ].join('\n'),
        fragmentShader: [
            'precision highp float;',
            'in vec2 vUv;',
            'out vec4 fragColor;',
            'uniform sampler2D tMoments;',
            'uniform vec2 uStep;',
            // Gaussian weights for a 9 tap separable kernel.
            'void main() {',
            '    vec2 sum = texture(tMoments, vUv).xy * 0.2270270270;',
            '    sum += texture(tMoments, vUv + uStep * 1.3846153846).xy * 0.3162162162;',
            '    sum += texture(tMoments, vUv - uStep * 1.3846153846).xy * 0.3162162162;',
            '    sum += texture(tMoments, vUv + uStep * 3.2307692308).xy * 0.0702702703;',
            '    sum += texture(tMoments, vUv - uStep * 3.2307692308).xy * 0.0702702703;',
            '    fragColor = vec4(sum, 0.0, 1.0);',
            '}',
        ].join('\n'),
        depthTest: false,
        depthWrite: false,
    });
    const createShadowDepthMaterial = () => new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: [
            'in vec3 position;',
            'uniform mat4 modelMatrix;',
            'uniform mat4 modelViewMatrix;',
            'uniform mat4 projectionMatrix;',
            'out vec3 vWorld;',
            'void main() { vWorld = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        ].join('\n'),
        fragmentShader: [
            'precision highp float;',
            'in vec3 vWorld;',
            'uniform vec4 uDepthPlane;',
            'uniform float uCoverage;',
            'out vec4 fragColor;',
            // Store linear light-view depth. Post-projection z allocates almost
            // all precision to the near plane for perspective emitters, which
            // collapses tabletop blocker separation across a room scale. The
            // renderer computes this plane from the same camera near/far pair
            // used by the receiver lookup, so both sides compare identical d.
            // Store the finite texel footprint in the second moment. This is the
            // standard VSM derivative correction and replaces polygonOffset,
            // which only affects the depth buffer and cannot bias color moments.
            // A standard 4x4 Bayer permutation keeps approximately coverage*16
            // texels (the old thresholds kept only 3/16 at coverage .5). Compute
            // derivatives before the coverage discard so their values remain
            // defined across the fragment quad.
            'float mx_shadowDither() { int x = int(mod(gl_FragCoord.x, 4.0)); int y = int(mod(gl_FragCoord.y, 4.0)); vec4 row = y == 0 ? vec4(0.0, 8.0, 2.0, 10.0) : (y == 1 ? vec4(12.0, 4.0, 14.0, 6.0) : (y == 2 ? vec4(3.0, 11.0, 1.0, 9.0) : vec4(15.0, 7.0, 13.0, 5.0))); return (row[x] + 0.5) / 16.0; }',
            'void main() { float d = clamp(dot(vec4(vWorld, 1.0), uDepthPlane), 0.0, 1.0); float dx = dFdx(d); float dy = dFdy(d); float m2 = d * d + 0.25 * (dx * dx + dy * dy); if (uCoverage < 0.99999 && uCoverage <= mx_shadowDither()) discard; fragColor = vec4(d, m2, 0.0, 1.0); }',
        ].join('\n'),
        uniforms: {
            uDepthPlane: { value: new THREE.Vector4(0, 0, 0, 1) },
            uCoverage: { value: 1 },
        },
        // Cast from both faces. USD stages carry plenty of single-sided and
        // inverted-winding geometry (17 of the 21 chess meshes are leftHanded, and
        // props are routinely open shells), and front-face-only casting made all of
        // it transparent to the shadow pass.
        side: THREE.DoubleSide,
        // Color moments carry the writer-side texel-footprint correction with the standard
        // derivative variance term. WebGL polygonOffset changes only the depth
        // buffer and cannot bias these color moments, so it is intentionally not
        // used as a false acne fix here.
    });
    // Shadow transmittance pass A: a solid transmitter's front-face entry depth
    // into the 256px scratch target, LESS depth test so the nearest front face
    // wins. Same linear light-view depth plane convention as the VSM writer.
    const createShadowEntryDepthMaterial = () => new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: [
            'in vec3 position;',
            'uniform mat4 modelMatrix;',
            'uniform mat4 modelViewMatrix;',
            'uniform mat4 projectionMatrix;',
            'out vec3 vWorld;',
            'void main() { vWorld = (modelMatrix * vec4(position, 1.0)).xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        ].join('\n'),
        fragmentShader: [
            'precision highp float;',
            'in vec3 vWorld;',
            'uniform vec4 uDepthPlane;',
            'out vec4 fragColor;',
            'void main() { float d = clamp(dot(vec4(vWorld, 1.0), uDepthPlane), 0.0, 1.0); fragColor = vec4(d, d, d, 1.0); }',
        ].join('\n'),
        uniforms: { uDepthPlane: { value: new THREE.Vector4(0, 0, 0, 1) } },
        side: THREE.DoubleSide,
        depthTest: true,
        depthWrite: true,
    });

    // A directional caster gets one orthographic tile; an area/omni
    // source gets perspective cube faces, fitted from the mesh geometry
    // each face actually sees rather than receiver vertex samples.
    const shadowClassifyCaster = (rec) => {
        const position = rec.source.position || null;
        if (rec.directional || !position) return 'distant';
        return (rec.planarSource && rec.source.direction) ? 'area' : 'omni';
    };
    // Forward-depth interval of a world-space box's eight corners in a
    // face camera's view space, clamped at 0 for a box that straddles
    // the camera plane (its front-facing part still needs a near of 0).
    const shadowBoxDepthInterval = (shadowCamera, box) => {
        let lower = Infinity; let upper = -Infinity;
        const corner = new THREE.Vector3();
        for (const x of [box.min.x, box.max.x]) {
            for (const y of [box.min.y, box.max.y]) {
                for (const z of [box.min.z, box.max.z]) {
                    corner.set(x, y, z).applyMatrix4(shadowCamera.matrixWorldInverse);
                    const depth = -corner.z;
                    if (depth < lower) lower = depth;
                    if (depth > upper) upper = depth;
                }
            }
        }
        return { lower: Math.max(0, lower), upper };
    };
    // near = 0.9 * the smallest non-straddling lower bound (or 1e-3 *
    // far if every box straddles), floored at the source radius;
    // far = 1.05 * the largest upper bound.
    const shadowFitDepthRangeFromBoxes = (intervals, sourceRadius, minFloor) => {
        if (!intervals.length) return null;
        let far = 0;
        for (const iv of intervals) far = Math.max(far, iv.upper);
        far = Math.max(minFloor * 2, far * 1.05);
        // A box that contains the emitter (a mesh enclosing its light)
        // must pull near down to the floor, or its geometry is clipped
        // out of the map and light streaks through it.
        let minPositiveLower = Infinity, straddles = false;
        for (const iv of intervals) { if (iv.lower > 0) minPositiveLower = Math.min(minPositiveLower, iv.lower); else straddles = true; }
        const floor = Math.max(minFloor, far * 1e-3, sourceRadius * 0.1);
        const nearBase = (!straddles && Number.isFinite(minPositiveLower)) ? 0.9 * minPositiveLower : floor;
        const near = Math.min(far * 0.99, Math.max(nearBase, floor));
        return { near, far };
    };
    // Fixed-size pool of 512px cells for the atlas: 8 x 4 = 32. A
    // directional/area caster claims a tile-aligned 2x2 block (one
    // 1024px tile); an omni caster claims up to six single cells.
    const shadowAllocateTile = (pool) => {
        for (let tileRow = 0; tileRow < SHADOW_TILE_ROWS; tileRow++) {
            for (let tileCol = 0; tileCol < SHADOW_TILE_COLS; tileCol++) {
                const baseCol = tileCol * 2; const baseRow = tileRow * 2;
                const cells = [
                    baseRow * SHADOW_CELL_COLS + baseCol, baseRow * SHADOW_CELL_COLS + baseCol + 1,
                    (baseRow + 1) * SHADOW_CELL_COLS + baseCol, (baseRow + 1) * SHADOW_CELL_COLS + baseCol + 1,
                ];
                if (cells.some((ci) => pool[ci])) continue;
                cells.forEach((ci) => { pool[ci] = 1; });
                return { px: baseCol * SHADOW_CELL_SIZE, py: baseRow * SHADOW_CELL_SIZE, size: SHADOW_TILE_SIZE };
            }
        }
        return null;
    };
    const shadowAllocateCell = (pool) => {
        for (let ci = 0; ci < SHADOW_CELL_TOTAL; ci++) {
            if (pool[ci]) continue;
            pool[ci] = 1;
            const col = ci % SHADOW_CELL_COLS; const row = Math.floor(ci / SHADOW_CELL_COLS);
            return { px: col * SHADOW_CELL_SIZE, py: row * SHADOW_CELL_SIZE, size: SHADOW_CELL_SIZE };
        }
        return null;
    };

    window.MtlxRender = Object.assign(window.MtlxRender || {}, {
        shadowAtlas: {
            SHADOW_CELL_SIZE,
            SHADOW_CELL_COLS,
            SHADOW_CELL_ROWS,
            SHADOW_CELL_TOTAL,
            SHADOW_TILE_SIZE,
            SHADOW_TILE_COLS,
            SHADOW_TILE_ROWS,
            SHADOW_ATLAS_WIDTH,
            SHADOW_ATLAS_HEIGHT,
            SHADOW_ATLAS_FACE_SLOTS,
            SHADOW_RECORD_CELL_SIZE,
            SHADOW_RECORD_COLS,
            SHADOW_RECORD_ROWS,
            SHADOW_RECORD_WIDTH,
            SHADOW_RECORD_HEIGHT,
            shadowRecordCellRect,
            shadowRecordCellUv,
            createShadowBlurMaterial,
            createShadowDepthMaterial,
            createShadowEntryDepthMaterial,
            shadowClassifyCaster,
            shadowBoxDepthInterval,
            shadowFitDepthRangeFromBoxes,
            shadowAllocateTile,
            shadowAllocateCell,
        },
    });
})();
