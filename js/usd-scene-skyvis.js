// Sky visibility volume: the occlusion term MaterialX's image based lighting
// does not have.
//
// MaterialX's IBL integrates the whole environment at every shading point with
// no visibility test at all, so a surface facing a wall still receives the full
// sky. In an interior lit by an outdoor dome, which is exactly what the OpenPBR
// Shader Playground is, that floods the room: measured on that stage the back
// wall sat at 0.68 linear, the value you get from an unoccluded hemisphere,
// where an offline render that traces the sky puts it an order of magnitude
// lower. It is the single largest reason a raster interior reads flat and
// overlit next to a path traced one.
//
// Screen space occlusion cannot fix this. Its radius is a few centimetres and
// it only knows about geometry currently on screen, whereas "can this point see
// the sky" is a metres-scale question about walls that are usually off screen
// or behind the camera.
//
// So bake it, once, into a coarse 3D grid:
//   1. voxelize the stage into an occupancy grid,
//   2. from each empty cell cast rays over the sphere and march the grid,
//   3. store the fraction that escape.
// The shader samples that volume trilinearly at the shading point. It is low
// frequency by construction, which is what the effect actually is, and it costs
// one 3D texture lookup.
//
// Deliberately coarse: a 32 cube grid over a 5 metre room is a 16 cm cell,
// which resolves "under the desk", "behind the chair" and "facing the wall"
// without pretending to resolve contact shading. Contact shading is the screen
// space pass's job, and the two multiply.
(function () {
    'use strict';

    // Ray directions over the full sphere. Fibonacci rather than random so the
    // result is stable between runs and does not shimmer if a stage reloads.
    function sphereDirections(count) {
        const dirs = new Float32Array(count * 3);
        const golden = Math.PI * (3 - Math.sqrt(5));
        for (let i = 0; i < count; i++) {
            const y = 1 - (i + 0.5) / count * 2;
            const r = Math.sqrt(Math.max(0, 1 - y * y));
            const a = i * golden;
            dirs[i * 3] = Math.cos(a) * r;
            dirs[i * 3 + 1] = y;
            dirs[i * 3 + 2] = Math.sin(a) * r;
        }
        return dirs;
    }

    // Marks every cell a triangle touches. Sampling the triangle rather than
    // running an exact box overlap test: this feeds a visibility estimate, and
    // the sample count is derived from the triangle's own size in cells, so a
    // floor spanning the grid is still filled solidly.
    function rasterizeTriangle(occ, dim, min, inv, ax, ay, az, bx, by, bz, cx, cy, cz) {
        const e1 = Math.max(Math.abs(bx - ax), Math.abs(by - ay), Math.abs(bz - az));
        const e2 = Math.max(Math.abs(cx - ax), Math.abs(cy - ay), Math.abs(cz - az));
        const cells = Math.max(e1, e2) * inv;
        const n = Math.max(1, Math.min(96, Math.ceil(cells * 1.5)));
        const dimX = dim[0], dimY = dim[1], dimZ = dim[2];
        for (let i = 0; i <= n; i++) {
            const u = i / n;
            for (let j = 0; j <= n - i; j++) {
                const v = j / n;
                const w = 1 - u - v;
                const px = ax * w + bx * u + cx * v;
                const py = ay * w + by * u + cy * v;
                const pz = az * w + bz * u + cz * v;
                const gx = Math.floor((px - min[0]) * inv);
                const gy = Math.floor((py - min[1]) * inv);
                const gz = Math.floor((pz - min[2]) * inv);
                if (gx < 0 || gy < 0 || gz < 0 || gx >= dimX || gy >= dimY || gz >= dimZ) continue;
                occ[(gz * dimY + gy) * dimX + gx] = 1;
            }
        }
    }

    // Amanatides and Woo grid traversal. Returns true when the ray leaves the
    // grid without meeting an occupied cell, i.e. it reached the sky.
    function escapes(occ, dim, sx, sy, sz, dx, dy, dz) {
        const dimX = dim[0], dimY = dim[1], dimZ = dim[2];
        let x = sx, y = sy, z = sz;
        const stepX = dx > 0 ? 1 : -1;
        const stepY = dy > 0 ? 1 : -1;
        const stepZ = dz > 0 ? 1 : -1;
        const invX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
        const invY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
        const invZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
        // Start from cell centres, so the first boundary is half a cell away.
        let tX = dx !== 0 ? invX * 0.5 : Infinity;
        let tY = dy !== 0 ? invY * 0.5 : Infinity;
        let tZ = dz !== 0 ? invZ * 0.5 : Infinity;
        for (;;) {
            if (tX < tY && tX < tZ) { x += stepX; tX += invX; } else if (tY < tZ) { y += stepY; tY += invY; } else { z += stepZ; tZ += invZ; }
            if (x < 0 || y < 0 || z < 0 || x >= dimX || y >= dimY || z >= dimZ) return true;
            if (occ[(z * dimY + y) * dimX + x]) return false;
        }
    }

    // meshes: [{ geometry, matrixWorld }]. box: THREE.Box3 of the stage.
    // Returns { data: Uint8Array (RED), dim, min, size, cell, occupiedFraction }
    // ready for a DataTexture3D, or null when the stage is degenerate.
    function buildSkyVisibility(meshes, box, options) {
        const opts = options || {};
        const resolution = Math.max(8, Math.min(64, opts.resolution || 32));
        const rayCount = Math.max(8, Math.min(128, opts.rays || 32));
        if (!meshes || !meshes.length || !box || box.isEmpty()) return null;

        const size = box.getSize(new THREE.Vector3());
        const longest = Math.max(size.x, size.y, size.z);
        if (!(longest > 0)) return null;
        // Pad so surfaces on the stage boundary are not clipped by the grid.
        const cell = longest / resolution;
        const min = [box.min.x - cell, box.min.y - cell, box.min.z - cell];
        const dim = [
            Math.max(2, Math.ceil(size.x / cell) + 2),
            Math.max(2, Math.ceil(size.y / cell) + 2),
            Math.max(2, Math.ceil(size.z / cell) + 2),
        ];
        const total = dim[0] * dim[1] * dim[2];
        const occ = new Uint8Array(total);
        const inv = 1 / cell;

        // Triangle budget. The grid is coarse enough that a dense mesh marks
        // the same cells many times over, so a stride costs almost no accuracy
        // on a big stage and keeps the bake bounded. Counted first so the
        // stride is uniform across the whole stage rather than per mesh.
        let triangles = 0;
        for (const mesh of meshes) {
            const g = mesh.geometry;
            const pos = g && g.getAttribute && g.getAttribute('position');
            if (!pos) continue;
            const idx = g.getIndex();
            triangles += Math.floor((idx ? idx.count : pos.count) / 3);
        }
        const budget = Math.max(1, opts.maxTriangles || 400000);
        const stride = Math.max(1, Math.ceil(triangles / budget));

        const v = new THREE.Vector3();
        for (const mesh of meshes) {
            const geometry = mesh.geometry;
            const position = geometry && geometry.getAttribute && geometry.getAttribute('position');
            if (!position) continue;
            const index = geometry.getIndex();
            const m = mesh.matrixWorld;
            const count = index ? index.count : position.count;
            const world = new Float32Array(position.count * 3);
            for (let i = 0; i < position.count; i++) {
                v.set(position.getX(i), position.getY(i), position.getZ(i)).applyMatrix4(m);
                world[i * 3] = v.x; world[i * 3 + 1] = v.y; world[i * 3 + 2] = v.z;
            }
            for (let t = 0; t + 2 < count; t += 3 * stride) {
                const a = index ? index.getX(t) : t;
                const b = index ? index.getX(t + 1) : t + 1;
                const c = index ? index.getX(t + 2) : t + 2;
                rasterizeTriangle(occ, dim, min, inv,
                    world[a * 3], world[a * 3 + 1], world[a * 3 + 2],
                    world[b * 3], world[b * 3 + 1], world[b * 3 + 2],
                    world[c * 3], world[c * 3 + 1], world[c * 3 + 2]);
            }
        }

        let occupied = 0;
        for (let i = 0; i < total; i++) if (occ[i]) occupied++;

        const dirs = sphereDirections(rayCount);
        const data = new Uint8Array(total);
        for (let z = 0; z < dim[2]; z++) {
            for (let y = 0; y < dim[1]; y++) {
                for (let x = 0; x < dim[0]; x++) {
                    const idx = (z * dim[1] + y) * dim[0] + x;
                    // Every cell is evaluated, occupied ones included. Shading
                    // points sit ON surfaces, so they land in cells the surface
                    // itself marked occupied; skipping those and storing zero
                    // made every lit surface sample "sees no sky" and killed the
                    // environment term outright. The traversal below steps
                    // before it tests, so a cell never occludes itself and an
                    // occupied cell reports what the air right at it can see.
                    let hits = 0;
                    for (let r = 0; r < rayCount; r++) {
                        if (escapes(occ, dim, x, y, z, dirs[r * 3], dirs[r * 3 + 1], dirs[r * 3 + 2])) hits++;
                    }
                    data[idx] = Math.round(255 * hits / rayCount);
                }
            }
        }

        return {
            data,
            dim,
            min,
            cell,
            size: [dim[0] * cell, dim[1] * cell, dim[2] * cell],
            occupiedFraction: total ? occupied / total : 0,
            triangles,
            stride,
        };
    }

    window.buildSkyVisibility = buildSkyVisibility;
    window.UsdSceneSkyVisibility = { build: buildSkyVisibility };
})();
