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
//   3. store the mean escape visibility and its first directional moment.
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
    // Pair each direction with its exact antipode so an unoccluded cell has a
    // zero first moment even at the finite sample counts used by the bake.
    function sphereDirections(count) {
        const dirs = new Float32Array(count * 3);
        const golden = Math.PI * (3 - Math.sqrt(5));
        const pairs = Math.floor(count / 2);
        for (let i = 0; i < pairs; i++) {
            const y = (i + 0.5) / pairs;
            const r = Math.sqrt(Math.max(0, 1 - y * y));
            const a = i * golden;
            const x = Math.cos(a) * r;
            const z = Math.sin(a) * r;
            dirs[i * 3] = x;
            dirs[i * 3 + 1] = y;
            dirs[i * 3 + 2] = z;
            const opposite = (i + pairs) * 3;
            dirs[opposite] = -x;
            dirs[opposite + 1] = -y;
            dirs[opposite + 2] = -z;
        }
        return dirs;
    }

    // Marks every cell a triangle touches. Sampling the triangle rather than
    // running an exact box overlap test: this feeds a visibility estimate, and
    // the sample count is derived from the triangle's own size in cells, so a
    // floor spanning the grid is still filled solidly.
    function rasterizeTriangle(occ, dim, min, inv, ax, ay, az, bx, by, bz, cx, cy, cz, opacity) {
        const coverage = Math.max(0, Math.min(1, Number(opacity) || 0));
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
                const cell = (gz * dimY + gy) * dimX + gx;
                // Max merge keeps tessellation and duplicate back/front
                // triangles from changing a cell's effective opacity.
                occ[cell] = Math.max(occ[cell], coverage);
            }
        }
    }

    // Amanatides and Woo grid traversal. Returns remaining visibility when the
    // ray leaves the grid. A contiguous occupied run is one coarse surface;
    // this avoids multiplying a thin wall once per voxel while preserving
    // opaque behavior. Distinct surfaces that touch in one cell are an
    // acknowledged resolution limit of this inexpensive bake.
    function escapeVisibility(occ, dim, sx, sy, sz, dx, dy, dz) {
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
        let visibility = 1;
        let occupiedRun = false;
        for (;;) {
            if (tX < tY && tX < tZ) { x += stepX; tX += invX; } else if (tY < tZ) { y += stepY; tY += invY; } else { z += stepZ; tZ += invZ; }
            if (x < 0 || y < 0 || z < 0 || x >= dimX || y >= dimY || z >= dimZ) return visibility;
            const coverage = occ[(z * dimY + y) * dimX + x];
            if (coverage > 0) {
                if (!occupiedRun) visibility *= 1 - coverage;
                occupiedRun = true;
                if (visibility <= 0) return 0;
            } else occupiedRun = false;
        }
    }

    // meshes: [{ geometry, matrixWorld }]. box: THREE.Box3 of the stage.
    // Returns { data: Uint8Array (RGBA), dim, min, size, cell, occupiedFraction }
    // ready for a RGBA DataTexture3D, or null when the stage is degenerate.
    // R stores a=<V>, while GBA store the signed first moment d=2<V omega>
    // with a centered 128/127 UNORM encoding. The shader reconstructs the
    // diffuse visibility for a normal with clamp(a + dot(d, N), 0, 1).
    function buildSkyVisibility(meshes, box, options) {
        const opts = options || {};
        const resolution = Math.max(8, Math.min(96, opts.resolution || 32));
        const requestedRays = Math.floor(Math.max(8, Math.min(128, Number(opts.rays) || 32)));
        const rayCount = requestedRays % 2 === 0 ? requestedRays : (requestedRays < 128 ? requestedRays + 1 : requestedRays - 1);
        if (!meshes || !meshes.length || !box || box.isEmpty()) return null;

        const size = box.getSize(new THREE.Vector3());
        const longest = Math.max(size.x, size.y, size.z);
        if (!(longest > 0)) return null;
        // Pad by two cells so the shader's one-and-a-half-cell normal bias can
        // land in an actual air-cell centre even when a surface lies exactly
        // on the stage bounding-box boundary. A single cell of padding puts a
        // zero-thickness boundary plane on the last in-grid cell and the
        // biased lookup either samples that occupied slice or exits the grid.
        const cell = longest / resolution;
        const padding = 2 * cell;
        const min = [box.min.x - padding, box.min.y - padding, box.min.z - padding];
        const dim = [
            Math.max(4, Math.ceil(size.x / cell) + 4),
            Math.max(4, Math.ceil(size.y / cell) + 4),
            Math.max(4, Math.ceil(size.z / cell) + 4),
        ];
        const total = dim[0] * dim[1] * dim[2];
        const occ = new Float32Array(total);
        const inv = 1 / cell;

        // Triangle budget. A global stride is unsafe: if a dense decorative
        // mesh pushes the total over budget, it can skip every other triangle
        // of a two-triangle wall or floor and open a room-sized leak. Preserve
        // all structural triangles whose world span reaches a cell, and only
        // subsample the redundant sub-cell triangles.
        let triangles = 0;
        let structuralTriangles = 0;
        let subcellTriangles = 0;
        const prepared = [];
        const v = new THREE.Vector3();
        const edgeSpan = (world, a, b, c) => Math.max(
            Math.max(Math.abs(world[b * 3] - world[a * 3]), Math.abs(world[b * 3 + 1] - world[a * 3 + 1]), Math.abs(world[b * 3 + 2] - world[a * 3 + 2])),
            Math.max(Math.abs(world[c * 3] - world[a * 3]), Math.abs(world[c * 3 + 1] - world[a * 3 + 1]), Math.abs(world[c * 3 + 2] - world[a * 3 + 2])),
            Math.max(Math.abs(world[c * 3] - world[b * 3]), Math.abs(world[c * 3 + 1] - world[b * 3 + 1]), Math.abs(world[c * 3 + 2] - world[b * 3 + 2]))
        );
        for (const mesh of meshes) {
            const g = mesh.geometry;
            const pos = g && g.getAttribute && g.getAttribute('position');
            if (!pos) continue;
            const idx = g.getIndex();
            const count = idx ? idx.count : pos.count;
            const world = new Float32Array(pos.count * 3);
            const m = mesh.matrixWorld;
            for (let i = 0; i < pos.count; i++) {
                v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(m);
                world[i * 3] = v.x; world[i * 3 + 1] = v.y; world[i * 3 + 2] = v.z;
            }
            let localStructural = 0;
            let localSubcell = 0;
            for (let t = 0; t + 2 < count; t += 3) {
                const a = idx ? idx.getX(t) : t;
                const b = idx ? idx.getX(t + 1) : t + 1;
                const c = idx ? idx.getX(t + 2) : t + 2;
                const structural = edgeSpan(world, a, b, c) * inv >= 1;
                if (structural) localStructural++;
                else localSubcell++;
            }
            triangles += localStructural + localSubcell;
            structuralTriangles += localStructural;
            subcellTriangles += localSubcell;
            prepared.push({ mesh, geometry: g, position: pos, index: idx, count, world, localStructural, localSubcell });
        }
        const budget = Math.max(1, opts.maxTriangles || 400000);
        const subcellBudget = Math.max(0, budget - structuralTriangles);
        // If structural coverage consumes the nominal budget, retain one
        // deterministic subcell sample per period rather than rasterizing an
        // unbounded dense mesh. Structural triangles are always retained.
        const stride = subcellTriangles
            ? Math.max(1, Math.ceil(subcellTriangles / Math.max(1, subcellBudget))) : 1;

        let subcellOrdinal = 0;
        let sampledTriangles = 0;
        for (const item of prepared) {
            const { index, count, world } = item;
            for (let t = 0; t + 2 < count; t += 3) {
                const a = index ? index.getX(t) : t;
                const b = index ? index.getX(t + 1) : t + 1;
                const c = index ? index.getX(t + 2) : t + 2;
                const structural = edgeSpan(world, a, b, c) * inv >= 1;
                if (!structural && (subcellOrdinal++ % stride) !== 0) continue;
                sampledTriangles++;
                rasterizeTriangle(occ, dim, min, inv,
                    world[a * 3], world[a * 3 + 1], world[a * 3 + 2],
                    world[b * 3], world[b * 3 + 1], world[b * 3 + 2],
                    world[c * 3], world[c * 3 + 1], world[c * 3 + 2], item.mesh && item.mesh.opacity != null ? item.mesh.opacity : 1);
            }
        }

        let occupied = 0;
        for (let i = 0; i < total; i++) if (occ[i]) occupied++;

        const dirs = sphereDirections(rayCount);
        const data = new Uint8Array(total * 4);
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
                    let visibilitySum = 0;
                    let dirX = 0;
                    let dirY = 0;
                    let dirZ = 0;
                    for (let r = 0; r < rayCount; r++) {
                        const visibility = escapeVisibility(occ, dim, x, y, z, dirs[r * 3], dirs[r * 3 + 1], dirs[r * 3 + 2]);
                        visibilitySum += visibility;
                        dirX += dirs[r * 3] * visibility;
                        dirY += dirs[r * 3 + 1] * visibility;
                        dirZ += dirs[r * 3 + 2] * visibility;
                    }
                    const a = visibilitySum / rayCount;
                    const encodeMoment = (sum) => Math.round(128 + 127 * Math.max(-1, Math.min(1, 2 * sum / rayCount)));
                    const o = idx * 4;
                    data[o] = Math.round(255 * a);
                    data[o + 1] = encodeMoment(dirX);
                    data[o + 2] = encodeMoment(dirY);
                    data[o + 3] = encodeMoment(dirZ);
                }
            }
        }

        return {
            data,
            channels: 4,
            format: 'rgba8',
            dim,
            min,
            cell,
            size: [dim[0] * cell, dim[1] * cell, dim[2] * cell],
            occupiedFraction: total ? occupied / total : 0,
            triangles,
            stride,
            sampledTriangles,
            structuralTriangles,
            subcellTriangles,
        };
    }

    window.buildSkyVisibility = buildSkyVisibility;
    window.UsdSceneSkyVisibility = { build: buildSkyVisibility };
})();
