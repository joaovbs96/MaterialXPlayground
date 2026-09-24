// js/shared/mesh-udim.js: UDIM tile classification and triangle
// partitioning/compaction, shared by the Material Viewer's custom-geometry
// UDIM split (js/mtlx-engine.js) and, later, the Scene (P6). Pure helpers,
// no load-time THREE; ported verbatim from js/usd-scene-renderer.js's
// sceneUdim*/bucket helpers (see each function's header comment below).
(function () {
    'use strict';

    // sceneUdimCode, verbatim.
    const tileCode = (u, v) => 1001 + u + v * 10;

    // sceneUdimTile, verbatim: u > 9 returns null (U=10 would alias the
    // V=1,U=0 tile 1011), eps 1e-7.
    const tileOf = (u, v) => {
        if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || v < 0) return null;
        const epsilon = 1e-7;
        const tu = Math.floor(u + epsilon);
        const tv = Math.floor(v + epsilon);
        if (tu > 9) return null;
        return { u: tu, v: tv, code: tileCode(tu, tv) };
    };

    // sceneUdimTriangle, generalized to explicit corner indices plus an
    // optional vFlip (glTF's V=0-at-top vs UDIM/OBJ's V=0-at-bottom): the
    // stored UVs are never mutated, vFlip only affects classification.
    const classifyTriangle = (uvs, a, b, c, opts) => {
        const vFlip = !!(opts && opts.vFlip);
        if (!uvs) return null;
        const values = [a, b, c].map((index) => {
            const u = Number(uvs[index * 2]);
            let v = Number(uvs[index * 2 + 1]);
            if (vFlip) v = 1 - v;
            return [u, v];
        });
        if (values.some(([u, v]) => !Number.isFinite(u) || !Number.isFinite(v) || u < 0 || v < 0)) return null;
        const center = values.reduce((sum, value) => [sum[0] + value[0], sum[1] + value[1]], [0, 0]);
        const tile = tileOf(center[0] / 3, center[1] / 3);
        if (!tile) return null;
        const epsilon = 1e-6;
        if (values.some(([u, v]) => u < tile.u - epsilon || u > tile.u + 1 + epsilon
            || v < tile.v - epsilon || v > tile.v + 1 + epsilon)) return { crossing: true };
        return tile;
    };

    // partitionTriangles: buckets every triangle in indices[start:end] by
    // UDIM tile code, mirroring the Scene's bucket loop
    // (js/usd-scene-renderer.js ~3910-3930). bucketKey: 'crossing', or the
    // tile's numeric code as a string. Returns { buckets, crossingCount }.
    const partitionTriangles = ({ uvs, indices, start = 0, end, vFlip = false }) => {
        const idx = indices || [];
        const stop = end != null ? end : idx.length;
        const buckets = new Map();
        let crossingCount = 0;
        for (let cursor = start; cursor + 2 < stop; cursor += 3) {
            const a = idx[cursor], b = idx[cursor + 1], c = idx[cursor + 2];
            const classification = classifyTriangle(uvs, a, b, c, { vFlip });
            const crossing = !classification || classification.crossing === true;
            const tile = crossing ? null : classification;
            if (crossing) crossingCount += 1;
            const bucketKey = crossing ? 'crossing' : String(tile.code);
            let bucket = buckets.get(bucketKey);
            if (!bucket) { bucket = { triangles: [], tile, crossing }; buckets.set(bucketKey, bucket); }
            bucket.triangles.push([a, b, c]);
        }
        return { buckets, crossingCount };
    };

    // compactBucket: welds a bucket's triangles into a fresh, tightly
    // indexed vertex set (source-index dedup, first-seen order), mirroring
    // js/usd-scene-renderer.js's per-bucket vertex remap (~3931-3958). No
    // THREE: returns plain arrays, the caller builds its own geometry.
    const compactBucket = ({ positions, normals, uvs, geomprops, triangles }) => {
        const vertexMap = new Map();
        const outPositions = [], outNormals = [], outUvs = [], outIndices = [];
        const streams = Array.isArray(geomprops) ? geomprops : [];
        const outGeomprops = streams.map(() => []);
        const addVertex = (sourceIndex) => {
            if (vertexMap.has(sourceIndex)) return vertexMap.get(sourceIndex);
            const n = vertexMap.size;
            outPositions.push(positions[sourceIndex * 3], positions[sourceIndex * 3 + 1], positions[sourceIndex * 3 + 2]);
            if (normals && normals.length >= positions.length) {
                outNormals.push(normals[sourceIndex * 3], normals[sourceIndex * 3 + 1], normals[sourceIndex * 3 + 2]);
            }
            if (uvs && uvs.length >= (positions.length / 3) * 2) {
                outUvs.push(uvs[sourceIndex * 2], uvs[sourceIndex * 2 + 1]);
            }
            streams.forEach((stream, streamIndex) => {
                const base = sourceIndex * stream.itemSize;
                for (let c = 0; c < stream.itemSize; c += 1) outGeomprops[streamIndex].push(stream.data[base + c]);
            });
            vertexMap.set(sourceIndex, n);
            return n;
        };
        triangles.forEach((tri) => tri.forEach((index) => outIndices.push(addVertex(index))));
        return {
            positions: outPositions,
            normals: outNormals.length ? outNormals : null,
            uvs: outUvs.length ? outUvs : null,
            geomprops: streams.map((stream, i) => ({ name: stream.name, itemSize: stream.itemSize, data: outGeomprops[i] })),
            indices: outIndices,
        };
    };

    globalThis.MtlxMeshUdim = { tileCode, tileOf, classifyTriangle, partitionTriangles, compactBucket };
})();
