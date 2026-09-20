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
//
// The SAME voxel grid also carries a one-bounce diffuse irradiance bake (see
// bakeBounceGeometry/shadeBounce below): the blockers' own outgoing radiance,
// not a whole-scene mean, reflected onto every other cell. See
// scratchpad/displacement-verified/color-parity/bounce/v3-design.md.
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
    //
    // alb is null unless the caller asked for an albedo bake (opts.albedo in
    // voxelizeStage): a Float32Array(3*total) of per-cell RGB, one triplet per
    // cell, written by the sample that wins the occ max-merge (same winner
    // that owns occ[cell]). nrm is null unless opts.normals asked for it: a
    // Float32Array(3*total) SUMMED (not max-merged) with this triangle's own
    // unnormalized normal (cross(edge1,edge2), magnitude 2*area) divided by
    // the sample count, so a triangle's total contribution over every sample
    // it touches in a cell approximates its own area-weighted normal
    // regardless of tessellation density; voxelizeStage normalizes at the end.
    // Hoisting both null checks out of the sample loop keeps the no-option
    // path doing the exact same work as before (see the byte-identity guard
    // test).
    function rasterizeTriangle(occ, alb, nrm, dim, min, inv, ax, ay, az, bx, by, bz, cx, cy, cz, opacity, albedoRGB) {
        const coverage = Math.max(0, Math.min(1, Number(opacity) || 0));
        const e1 = Math.max(Math.abs(bx - ax), Math.abs(by - ay), Math.abs(bz - az));
        const e2 = Math.max(Math.abs(cx - ax), Math.abs(cy - ay), Math.abs(cz - az));
        const cells = Math.max(e1, e2) * inv;
        const n = Math.max(1, Math.min(96, Math.ceil(cells * 1.5)));
        const dimX = dim[0], dimY = dim[1], dimZ = dim[2];
        const hasAlbedo = !!alb;
        const hasNormal = !!nrm;
        let ntx = 0, nty = 0, ntz = 0, sampleCount = 0;
        if (hasNormal) {
            const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
            const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
            ntx = e1y * e2z - e1z * e2y;
            nty = e1z * e2x - e1x * e2z;
            ntz = e1x * e2y - e1y * e2x;
            for (let i = 0; i <= n; i++) sampleCount += (n - i + 1);
            if (sampleCount < 1) sampleCount = 1;
        }
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
                // triangles from changing a cell's effective opacity. The
                // winning (raising) coverage also owns the albedo, when asked.
                if (coverage > occ[cell]) {
                    occ[cell] = coverage;
                    if (hasAlbedo) {
                        alb[cell * 3] = albedoRGB[0];
                        alb[cell * 3 + 1] = albedoRGB[1];
                        alb[cell * 3 + 2] = albedoRGB[2];
                    }
                }
                if (hasNormal) {
                    nrm[cell * 3] += ntx / sampleCount;
                    nrm[cell * 3 + 1] += nty / sampleCount;
                    nrm[cell * 3 + 2] += ntz / sampleCount;
                }
            }
        }
    }

    // Amanatides and Woo grid traversal. Returns remaining visibility when the
    // ray leaves the grid. A contiguous occupied run is one coarse surface;
    // this avoids multiplying a thin wall once per voxel while preserving
    // opaque behavior. Distinct surfaces that touch in one cell are an
    // acknowledged resolution limit of this inexpensive bake.
    // maxT (cells) stops the march early: used by the AO volume bake, whose
    // occlusion is local rather than sky-scale. Infinity (the default) is a
    // byte for byte no-op against the original unbounded march.
    function escapeVisibility(occ, dim, sx, sy, sz, dx, dy, dz, maxT) {
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
        const limit = maxT != null ? maxT : Infinity;
        for (;;) {
            if (Math.min(tX, tY, tZ) > limit) return visibility;
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

    // Same march as escapeVisibility, plus the index of the first NON-SELF
    // occupied cell the ray entered (-1 when it escapes or only ever touches
    // its own origin run). Used by bakeBounceGeometry to look up the
    // blocker's own albedo/normal/sky-visibility at that cell.
    //
    // skipSelfCells (cell units, default 0) discards the entire contiguous
    // occupied run the ray is IN or FIRST enters within that many cells of
    // the origin: a ray cast from a cell that is itself part of a blocker
    // (a floor tile, a thin card) would otherwise immediately re-hit its own
    // structure and contribute nothing (a "self-hit"), which starves the
    // bake of the very neighbours it is supposed to see. Once a run starts
    // at or beyond skipSelfCells it is treated as a normal blocker.
    function escapeVisibilityHit(occ, dim, sx, sy, sz, dx, dy, dz, maxT, skipSelfCells) {
        const dimX = dim[0], dimY = dim[1], dimZ = dim[2];
        let x = sx, y = sy, z = sz;
        const stepX = dx > 0 ? 1 : -1;
        const stepY = dy > 0 ? 1 : -1;
        const stepZ = dz > 0 ? 1 : -1;
        const invX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
        const invY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
        const invZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
        let tX = dx !== 0 ? invX * 0.5 : Infinity;
        let tY = dy !== 0 ? invY * 0.5 : Infinity;
        let tZ = dz !== 0 ? invZ * 0.5 : Infinity;
        let visibility = 1;
        let occupiedRun = false;
        let inSkippedRun = false;
        let hitIndex = -1;
        const limit = maxT != null ? maxT : Infinity;
        const skip = skipSelfCells > 0 ? skipSelfCells : 0;
        // A degenerate direction or maxT cannot make this loop leave the grid
        // (analytically it always does, within dimX+dimY+dimZ steps); this cap
        // is a cheap safety net against any future regression, not a fix for
        // a known non-termination.
        const stepCap = dimX + dimY + dimZ + 4;
        for (let steps = 0; ; steps++) {
            if (steps > stepCap) {
                console.error('[usd-scene-skyvis] escapeVisibilityHit exceeded ' + stepCap + ' steps, aborting the march early');
                return { visibility, hitIndex };
            }
            const t = Math.min(tX, tY, tZ);
            if (t > limit) return { visibility, hitIndex };
            if (tX < tY && tX < tZ) { x += stepX; tX += invX; } else if (tY < tZ) { y += stepY; tY += invY; } else { z += stepZ; tZ += invZ; }
            if (x < 0 || y < 0 || z < 0 || x >= dimX || y >= dimY || z >= dimZ) return { visibility, hitIndex };
            const idx = (z * dimY + y) * dimX + x;
            const coverage = occ[idx];
            if (coverage > 0) {
                if (!occupiedRun) {
                    inSkippedRun = t < skip;
                    if (!inSkippedRun) {
                        visibility *= 1 - coverage;
                        if (hitIndex === -1) hitIndex = idx;
                    }
                }
                occupiedRun = true;
                if (!inSkippedRun && visibility <= 0) return { visibility: 0, hitIndex };
            } else { occupiedRun = false; inSkippedRun = false; }
        }
    }

    // meshes: [{ geometry, matrixWorld, albedo? }]. box: THREE.Box3 of the stage.
    // Returns { occ, dim, min, cell, occupiedFraction, triangles, stride,
    // sampledTriangles, structuralTriangles, subcellTriangles, resolution },
    // plus .alb / .normals when opts.albedo / opts.normals are requested, or
    // null when the stage is degenerate. occ is a Float32Array of per-cell
    // opacity, the shared input to marchVisibility.
    //
    // mesh.albedo, when opts.albedo is set, is expected as an [r, g, b]
    // triplet (sceneBounceAlbedo in js/usd-scene-renderer.js); missing or
    // malformed entries fall back to a neutral [0.5, 0.5, 0.5].
    function voxelizeStage(meshes, box, options) {
        const opts = options || {};
        const resolution = Math.max(8, Math.min(96, opts.resolution || 32));
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
        // Only allocated when a bounce bake asks for them: the byte-identity
        // regression guard requires the no-option path to do no extra
        // allocation and take no extra branch inside the inner raster loop.
        const alb = opts.albedo ? new Float32Array(total * 3) : null;
        const nrm = opts.normals ? new Float32Array(total * 3) : null;
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
                const meshAlbedo = alb
                    ? (Array.isArray(item.mesh && item.mesh.albedo) && item.mesh.albedo.length >= 3
                        ? item.mesh.albedo : [0.5, 0.5, 0.5])
                    : undefined;
                rasterizeTriangle(occ, alb, nrm, dim, min, inv,
                    world[a * 3], world[a * 3 + 1], world[a * 3 + 2],
                    world[b * 3], world[b * 3 + 1], world[b * 3 + 2],
                    world[c * 3], world[c * 3 + 1], world[c * 3 + 2],
                    item.mesh && item.mesh.opacity != null ? item.mesh.opacity : 1,
                    meshAlbedo);
            }
        }

        let occupied = 0;
        for (let i = 0; i < total; i++) if (occ[i]) occupied++;

        // Normalize the accumulated per-cell normal sum. A cell with no
        // accumulated normal (no triangle sample landed exactly on it, or the
        // sums cancelled) falls back to the negated central-difference
        // gradient of occ: occ increases INTO solid material, so -grad(occ)
        // points away from it, which is the right sense for a surface normal.
        if (nrm) {
            const dimX = dim[0], dimY = dim[1], dimZ = dim[2];
            const occAt = (x, y, z) => {
                if (x < 0 || y < 0 || z < 0 || x >= dimX || y >= dimY || z >= dimZ) return 0;
                return occ[(z * dimY + y) * dimX + x];
            };
            for (let z = 0; z < dimZ; z++) {
                for (let y = 0; y < dimY; y++) {
                    for (let x = 0; x < dimX; x++) {
                        const idx = (z * dimY + y) * dimX + x;
                        const o = idx * 3;
                        const len = Math.hypot(nrm[o], nrm[o + 1], nrm[o + 2]);
                        if (len > 1e-8) {
                            nrm[o] /= len; nrm[o + 1] /= len; nrm[o + 2] /= len;
                        } else {
                            const gx = occAt(x + 1, y, z) - occAt(x - 1, y, z);
                            const gy = occAt(x, y + 1, z) - occAt(x, y - 1, z);
                            const gz = occAt(x, y, z + 1) - occAt(x, y, z - 1);
                            const glen = Math.hypot(gx, gy, gz);
                            if (glen > 1e-8) {
                                nrm[o] = -gx / glen; nrm[o + 1] = -gy / glen; nrm[o + 2] = -gz / glen;
                            }
                            // else: an isolated cell with no gradient information
                            // at all is left at (0,0,0), a documented resolution
                            // limit rather than a fabricated direction.
                        }
                    }
                }
            }
        }

        const result = {
            occ,
            dim,
            min,
            cell,
            occupiedFraction: total ? occupied / total : 0,
            triangles,
            stride,
            sampledTriangles,
            structuralTriangles,
            subcellTriangles,
            resolution,
        };
        if (alb) result.alb = alb;
        if (nrm) result.normals = nrm;
        return result;
    }

    // voxels: a voxelizeStage() result. Casts rays from every cell (occupied
    // ones included, see below) and stores the mean escape visibility plus its
    // first directional moment. Returns { data: Uint8Array (RGBA), rayCount }.
    // R stores a=<V>, while GBA store the signed first moment d=2<V omega>
    // with a centered 128/127 UNORM encoding. The shader reconstructs the
    // diffuse visibility for a normal with clamp(a + dot(d, N), 0, 1).
    // opts.maxDistance (world units) caps the march; unset marches to the
    // grid edge, the original unbounded behaviour.
    function marchVisibility(voxels, options) {
        const opts = options || {};
        const { occ, dim, cell } = voxels;
        const requestedRays = Math.floor(Math.max(8, Math.min(128, Number(opts.rays) || 32)));
        const rayCount = requestedRays % 2 === 0 ? requestedRays : (requestedRays < 128 ? requestedRays + 1 : requestedRays - 1);
        const maxDistance = Number(opts.maxDistance);
        const maxT = (Number.isFinite(maxDistance) && maxDistance > 0 && cell > 0) ? maxDistance / cell : Infinity;
        const dirs = sphereDirections(rayCount);
        const total = dim[0] * dim[1] * dim[2];
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
                        const visibility = escapeVisibility(occ, dim, x, y, z, dirs[r * 3], dirs[r * 3 + 1], dirs[r * 3 + 2], maxT);
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
        return { data, rayCount };
    }

    // meshes/box/options: see voxelizeStage. Reuses opts.voxels when its own
    // resolution already matches, so a second bake at the same resolution
    // (the AO volume, at the sky's resolution) skips re-voxelizing the stage.
    function buildSkyVisibility(meshes, box, options) {
        const opts = options || {};
        const resolution = Math.max(8, Math.min(96, opts.resolution || 32));
        const voxels = (opts.voxels && opts.voxels.resolution === resolution)
            ? opts.voxels : voxelizeStage(meshes, box, { resolution, maxTriangles: opts.maxTriangles });
        if (!voxels) return null;
        const marched = marchVisibility(voxels, { rays: opts.rays, maxDistance: opts.maxDistance });
        return {
            data: marched.data,
            channels: 4,
            format: 'rgba8',
            dim: voxels.dim,
            min: voxels.min,
            cell: voxels.cell,
            size: [voxels.dim[0] * voxels.cell, voxels.dim[1] * voxels.cell, voxels.dim[2] * voxels.cell],
            occupiedFraction: voxels.occupiedFraction,
            triangles: voxels.triangles,
            stride: voxels.stride,
            sampledTriangles: voxels.sampledTriangles,
            structuralTriangles: voxels.structuralTriangles,
            subcellTriangles: voxels.subcellTriangles,
            voxels,
        };
    }

    // GEOMETRY pass of the one-bounce diffuse irradiance bake (v3-design.md
    // section 5/7). Depends only on the voxel grid and the sky bake's own
    // per-cell visibility, never on the environment/exposure, so it is cached
    // by the caller (js/usd-scene-renderer.js's buildSkyBounceVolume) and
    // re-run only when geometry rebuilds, not when the dome yaw or exposure
    // changes.
    //
    // voxels: a voxelizeStage() result baked WITH opts.normals (needs its
    // .normals array; returns null otherwise -- .alb is only needed later, by
    // shadeBounce). visibilityData: the sky bake's RGBA8 Uint8Array at the
    // SAME voxel grid (marchVisibility's .data / buildSkyVisibility's .data).
    //
    // For every cell and every one of the same ray directions marchVisibility
    // casts, casts via escapeVisibilityHit (with opts.skipSelfCells, default
    // 1 cell, discarding the blocker's own contiguous run so a surface cell
    // does not "see" only itself). Returns
    // { hitIndex: Int32Array(cells*rays), blocked: Float32Array(cells*rays),
    //   blockerVis: Float32Array(cells*rays), rays, dirs }. blockerVis is the
    // hit cell's OWN mean sky visibility (visibilityData[hit*4]/255), read
    // once here because it too is a purely geometric quantity (the sky bake
    // does not depend on the environment either) and is what shadeBounce's
    // key-light gating multiplies by.
    function bakeBounceGeometry(voxels, visibilityData, options) {
        const opts = options || {};
        if (!voxels || !voxels.normals || !visibilityData) return null;
        const { occ, dim, cell } = voxels;
        const requestedRays = Math.floor(Math.max(8, Math.min(128, Number(opts.rays) || 32)));
        const rayCount = requestedRays % 2 === 0 ? requestedRays : (requestedRays < 128 ? requestedRays + 1 : requestedRays - 1);
        const maxDistance = Number(opts.maxDistance);
        const maxT = (Number.isFinite(maxDistance) && maxDistance > 0 && cell > 0) ? maxDistance / cell : Infinity;
        const skipSelfCells = Number.isFinite(opts.skipSelfCells) ? opts.skipSelfCells : 1.0;
        const dirs = sphereDirections(rayCount);
        const total = dim[0] * dim[1] * dim[2];
        const hitIndex = new Int32Array(total * rayCount);
        const blocked = new Float32Array(total * rayCount);
        const blockerVis = new Float32Array(total * rayCount);
        for (let z = 0; z < dim[2]; z++) {
            for (let y = 0; y < dim[1]; y++) {
                for (let x = 0; x < dim[0]; x++) {
                    const cellIdx = (z * dim[1] + y) * dim[0] + x;
                    const base = cellIdx * rayCount;
                    for (let r = 0; r < rayCount; r++) {
                        const dx = dirs[r * 3], dy = dirs[r * 3 + 1], dz = dirs[r * 3 + 2];
                        const hit = escapeVisibilityHit(occ, dim, x, y, z, dx, dy, dz, maxT, skipSelfCells);
                        const o = base + r;
                        if (hit.hitIndex !== -1) {
                            hitIndex[o] = hit.hitIndex;
                            blocked[o] = Math.max(0, Math.min(1, 1 - hit.visibility));
                            blockerVis[o] = visibilityData[hit.hitIndex * 4] / 255;
                        } else {
                            hitIndex[o] = -1;
                        }
                    }
                }
            }
        }
        return { hitIndex, blocked, blockerVis, rays: rayCount, dirs };
    }

    // SHADING pass of the one-bounce bake. Depends on the environment
    // (lighting.eStored) and is cheap to re-run alone (one irradiance sample
    // per cached hit, no re-marching) whenever the dome yaw, exposure or
    // environment changes -- the reason bakeBounceGeometry and shadeBounce
    // are two functions instead of one.
    //
    // geometry: a bakeBounceGeometry() result. voxels: the SAME voxelizeStage
    // result (needs its .alb, the per-cell RGB albedo). lighting.eStored is a
    // function(nx, ny, nz, Vb) -> [r, g, b] returning the stored-unit (already
    // divided by pi, see makeEStoredSampler in js/usd-scene-renderer.js)
    // irradiance a surface with that normal and own sky visibility Vb would
    // receive: the convolved dome term plus the key light's own contribution,
    // gated by Vb per v3-design.md section 6.
    //
    // Per cell, per ray: L = blocked * albedoRGB[hit] * eStored(normal[hit],
    // blockerVis[hit]). Accumulates a scalar SH1 (L0 = mean luminance, L1 =
    // 2 * mean(luminance * rayDirection), one RGBA8 sampler3D per
    // v3-design.md section 4) plus ONE global albedo-weighted mean chroma
    // (u_bounceTint), normalized to luminance 1, and a single global scale
    // (the bake's own reconstructed maximum) so the UNORM8 encoding spans the
    // real range instead of clamping at 1.
    function shadeBounce(geometry, voxels, lighting) {
        if (!geometry || !voxels || !voxels.alb || !voxels.normals || !lighting
            || typeof lighting.eStored !== 'function') return null;
        const { hitIndex, blocked, blockerVis, rays, dirs } = geometry;
        const { alb, normals, dim } = voxels;
        const total = dim[0] * dim[1] * dim[2];
        const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const l0 = new Float32Array(total);
        const l1x = new Float32Array(total), l1y = new Float32Array(total), l1z = new Float32Array(total);
        let tintR = 0, tintG = 0, tintB = 0;
        let maxRecon = 0;
        for (let idx = 0; idx < total; idx++) {
            const base = idx * rays;
            let sumLum = 0, mx = 0, my = 0, mz = 0;
            for (let r = 0; r < rays; r++) {
                const o = base + r;
                const hit = hitIndex[o];
                if (hit === -1) continue;
                const b = blocked[o];
                if (b <= 0) continue;
                const hb = hit * 3;
                const e = lighting.eStored(normals[hb], normals[hb + 1], normals[hb + 2], blockerVis[o]);
                const Lr = b * alb[hb] * e[0];
                const Lg = b * alb[hb + 1] * e[1];
                const Lb = b * alb[hb + 2] * e[2];
                const l = lum(Lr, Lg, Lb);
                if (l <= 0) continue;
                sumLum += l;
                const dx = dirs[r * 3], dy = dirs[r * 3 + 1], dz = dirs[r * 3 + 2];
                mx += l * dx; my += l * dy; mz += l * dz;
                tintR += l * Lr; tintG += l * Lg; tintB += l * Lb;
            }
            const meanLum = sumLum / rays;
            const mlx = 2 * mx / rays, mly = 2 * my / rays, mlz = 2 * mz / rays;
            l0[idx] = meanLum;
            l1x[idx] = mlx; l1y[idx] = mly; l1z[idx] = mlz;
            const recon = meanLum + Math.hypot(mlx, mly, mlz);
            if (recon > maxRecon) maxRecon = recon;
        }
        const scale = maxRecon > 1e-8 ? maxRecon : 1;
        const data = new Uint8Array(total * 4);
        const encode = (v) => Math.round(128 + 127 * Math.max(-1, Math.min(1, v / scale)));
        for (let idx = 0; idx < total; idx++) {
            const o = idx * 4;
            data[o] = Math.round(255 * Math.max(0, Math.min(1, l0[idx] / scale)));
            data[o + 1] = encode(l1x[idx]);
            data[o + 2] = encode(l1y[idx]);
            data[o + 3] = encode(l1z[idx]);
        }
        const tintLum = lum(tintR, tintG, tintB);
        const tint = tintLum > 1e-8 ? [tintR / tintLum, tintG / tintLum, tintB / tintLum] : [1, 1, 1];
        return { data, scale, tint, rayCount: rays };
    }

    // opts.voxels: the sky bake's own voxel grid, REBAKED with opts.albedo
    // AND opts.normals so it carries .alb/.normals (see buildSkyBounceVolume
    // in js/usd-scene-renderer.js, which voxelizes once for both). opts.
    // visibility: the sky bake's RGBA8 data at that same grid. opts.lighting:
    // see shadeBounce. Returns null (never re-voxelizes on its own) when any
    // of the three is missing, matching buildSkyVisibility's shape otherwise
    // plus { scale, tint, geometry } (geometry is exposed so the caller can
    // cache it and call shadeBounce again on its own after an environment
    // change, without a second bakeBounceGeometry pass).
    function buildSkyBounce(meshes, box, options) {
        const opts = options || {};
        const voxels = opts.voxels;
        const visibility = opts.visibility;
        const lighting = opts.lighting;
        if (!voxels || !voxels.alb || !voxels.normals || !visibility || !lighting) return null;
        const geometry = bakeBounceGeometry(voxels, visibility, { rays: opts.rays, maxDistance: opts.maxDistance, skipSelfCells: opts.skipSelfCells });
        if (!geometry) return null;
        const shaded = shadeBounce(geometry, voxels, lighting);
        if (!shaded) return null;
        return {
            data: shaded.data,
            scale: shaded.scale,
            tint: shaded.tint,
            channels: 4,
            format: 'rgba8',
            dim: voxels.dim,
            min: voxels.min,
            cell: voxels.cell,
            size: [voxels.dim[0] * voxels.cell, voxels.dim[1] * voxels.cell, voxels.dim[2] * voxels.cell],
            voxels,
            geometry,
        };
    }

    window.buildSkyVisibility = buildSkyVisibility;
    window.buildSkyBounce = buildSkyBounce;
    window.UsdSceneSkyVisibility = {
        build: buildSkyVisibility, voxelizeStage, marchVisibility,
        bakeBounceGeometry, shadeBounce, buildSkyBounce,
    };
})();
