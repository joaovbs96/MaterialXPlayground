// Loop subdivision shared by the USD worker and the page. Plain script (no
// import/export) so a module worker and a page script tag load it alike;
// sets globalThis.MtlxMeshSubdivision = { subdivideMesh, weldMesh }.
(function () {
  'use strict';

// Loop-subdivides per-corner triangle streams welded by position (face-varying
// UVs keep seams sharp) and returns deindexed corners with smooth normals, or
// null for degenerate input. creaseByNormals treats normal breaks as creases.
function subdivideMesh(mesh, levels, options = {}) {
  const { creaseByNormals = false } = options;
  const positions = mesh.positions;
  if (!positions || positions.length < 9 || levels <= 0) return null;
  const indices = mesh.indices;
  const cornerCount = indices ? indices.length : positions.length / 3;
  if (cornerCount < 3 || cornerCount % 3 !== 0) return null;
  const hasUV = mesh.uvs && mesh.uvs.length === (positions.length / 3) * 2;
  const creaseCapable = !!(creaseByNormals && mesh.normals && mesh.normals.length === positions.length);

  // Normalize -0 so sign noise near zero cannot split a weld (toFixed keeps
  // the sign of a tiny negative value, e.g. (-1e-7).toFixed(5) === "-0.00000").
  const noSignZero = (v) => (v === 0 ? 0 : v);
  const posKey = (x, y, z) => `${noSignZero(x).toFixed(5)},${noSignZero(y).toFixed(5)},${noSignZero(z).toFixed(5)}`;
  const posMap = new Map();
  let weldedPositions = [];
  const cornerVertex = (cornerIndex) => {
    const srcIndex = indices ? indices[cornerIndex] : cornerIndex;
    const x = positions[srcIndex * 3], y = positions[srcIndex * 3 + 1], z = positions[srcIndex * 3 + 2];
    const key = posKey(x, y, z);
    let vi = posMap.get(key);
    if (vi === undefined) {
      vi = weldedPositions.length;
      weldedPositions.push([x, y, z]);
      posMap.set(key, vi);
    }
    return vi;
  };
  const cornerNormal = creaseCapable ? (cornerIndex) => {
    const srcIndex = indices ? indices[cornerIndex] : cornerIndex;
    return [mesh.normals[srcIndex * 3], mesh.normals[srcIndex * 3 + 1], mesh.normals[srcIndex * 3 + 2]];
  } : null;

  let triangles = [];
  for (let c = 0; c + 2 < cornerCount; c += 3) {
    const a = cornerVertex(c), b = cornerVertex(c + 1), cc = cornerVertex(c + 2);
    const uv = hasUV ? [
      [mesh.uvs[c * 2], mesh.uvs[c * 2 + 1]],
      [mesh.uvs[(c + 1) * 2], mesh.uvs[(c + 1) * 2 + 1]],
      [mesh.uvs[(c + 2) * 2], mesh.uvs[(c + 2) * 2 + 1]],
    ] : null;
    const n = creaseCapable ? [cornerNormal(c), cornerNormal(c + 1), cornerNormal(c + 2)] : null;
    triangles.push({ v: [a, b, cc], uv, n });
  }
  if (weldedPositions.length < 4 || !triangles.length) return null;

  const edgeKey = (x, y) => (x < y ? `${x}_${y}` : `${y}_${x}`);

  // Initial crease edges, detected once from the input per-corner normals.
  // Child edges of a crease edge stay creases on later subdivision levels
  // (propagated at the bottom of the level loop below).
  let creaseSet = new Set();
  if (creaseCapable) {
    const edgeTris0 = new Map();
    for (let ti = 0; ti < triangles.length; ti++) {
      const [a, b, c] = triangles[ti].v;
      for (const [x, y] of [[a, b], [b, c], [c, a]]) {
        const ek = edgeKey(x, y);
        let list = edgeTris0.get(ek);
        if (!list) { list = []; edgeTris0.set(ek, list); }
        list.push(ti);
      }
    }
    const cornerNormalAt = (ti, vertex) => {
      const tri = triangles[ti];
      return tri.n[tri.v.indexOf(vertex)];
    };
    const differs = (n0, n1) =>
      Math.abs(n0[0] - n1[0]) > 1e-4 || Math.abs(n0[1] - n1[1]) > 1e-4 || Math.abs(n0[2] - n1[2]) > 1e-4;
    for (const [ek, adj] of edgeTris0) {
      if (adj.length !== 2) continue;
      const [x, y] = ek.split('_').map(Number);
      if (differs(cornerNormalAt(adj[0], x), cornerNormalAt(adj[1], x)) ||
          differs(cornerNormalAt(adj[0], y), cornerNormalAt(adj[1], y))) {
        creaseSet.add(ek);
      }
    }
  }

  for (let level = 0; level < levels; level++) {
    const n = weldedPositions.length;
    const edgeTriangles = new Map();
    const vertexNeighbors = Array.from({ length: n }, () => new Set());
    for (let ti = 0; ti < triangles.length; ti++) {
      const [a, b, c] = triangles[ti].v;
      for (const [x, y] of [[a, b], [b, c], [c, a]]) {
        const ek = edgeKey(x, y);
        let list = edgeTriangles.get(ek);
        if (!list) { list = []; edgeTriangles.set(ek, list); }
        list.push(ti);
        vertexNeighbors[x].add(y);
        vertexNeighbors[y].add(x);
      }
    }

    const evenPositions = new Array(n);
    for (let vi = 0; vi < n; vi++) {
      const neighbors = Array.from(vertexNeighbors[vi]);
      const boundaryNeighbors = neighbors.filter(nb =>
        edgeTriangles.get(edgeKey(vi, nb)).length === 1 || creaseSet.has(edgeKey(vi, nb)));
      const p = weldedPositions[vi];
      if (boundaryNeighbors.length) {
        if (boundaryNeighbors.length === 2) {
          const p0 = weldedPositions[boundaryNeighbors[0]], p1 = weldedPositions[boundaryNeighbors[1]];
          evenPositions[vi] = [
            0.75 * p[0] + 0.125 * (p0[0] + p1[0]),
            0.75 * p[1] + 0.125 * (p0[1] + p1[1]),
            0.75 * p[2] + 0.125 * (p0[2] + p1[2]),
          ];
        } else {
          evenPositions[vi] = p.slice();
        }
      } else {
        const k = neighbors.length || 1;
        const beta = k === 3 ? 3 / 16 : 3 / (8 * k);
        let sx = 0, sy = 0, sz = 0;
        for (const nb of neighbors) { const pn = weldedPositions[nb]; sx += pn[0]; sy += pn[1]; sz += pn[2]; }
        evenPositions[vi] = [
          (1 - k * beta) * p[0] + beta * sx,
          (1 - k * beta) * p[1] + beta * sy,
          (1 - k * beta) * p[2] + beta * sz,
        ];
      }
    }

    const newPositions = evenPositions.slice();
    const oddIndex = new Map();
    const getOdd = (a, b) => {
      const ek = edgeKey(a, b);
      let idx = oddIndex.get(ek);
      if (idx !== undefined) return idx;
      const adj = edgeTriangles.get(ek);
      const isCrease = creaseSet.has(ek);
      const pa = weldedPositions[a], pb = weldedPositions[b];
      // Degenerate triangles and non-manifold edges break the interior
      // mask, so they fall back to the boundary midpoint rule instead of
      // failing on bad topology.
      const oppOf = (ti) => triangles[ti]?.v.find(v => v !== a && v !== b);
      let pc, pd;
      if (adj.length === 2 && !isCrease) {
        pc = weldedPositions[oppOf(adj[0])];
        pd = weldedPositions[oppOf(adj[1])];
      }
      let pos;
      if (pc && pd) {
        pos = [
          0.375 * (pa[0] + pb[0]) + 0.125 * (pc[0] + pd[0]),
          0.375 * (pa[1] + pb[1]) + 0.125 * (pc[1] + pd[1]),
          0.375 * (pa[2] + pb[2]) + 0.125 * (pc[2] + pd[2]),
        ];
      } else {
        pos = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
      }
      idx = newPositions.length;
      newPositions.push(pos);
      oddIndex.set(ek, idx);
      return idx;
    };

    const lerpUV = (u0, u1, t) => [u0[0] + (u1[0] - u0[0]) * t, u0[1] + (u1[1] - u0[1]) * t];
    const newTriangles = [];
    for (const tri of triangles) {
      const [a, b, c] = tri.v;
      const ab = getOdd(a, b), bc = getOdd(b, c), ca = getOdd(c, a);
      if (tri.uv) {
        const [uvA, uvB, uvC] = tri.uv;
        const uvAB = lerpUV(uvA, uvB, 0.5), uvBC = lerpUV(uvB, uvC, 0.5), uvCA = lerpUV(uvC, uvA, 0.5);
        newTriangles.push({ v: [a, ab, ca], uv: [uvA, uvAB, uvCA] });
        newTriangles.push({ v: [b, bc, ab], uv: [uvB, uvBC, uvAB] });
        newTriangles.push({ v: [c, ca, bc], uv: [uvC, uvCA, uvBC] });
        newTriangles.push({ v: [ab, bc, ca], uv: [uvAB, uvBC, uvCA] });
      } else {
        newTriangles.push({ v: [a, ab, ca], uv: null });
        newTriangles.push({ v: [b, bc, ab], uv: null });
        newTriangles.push({ v: [c, ca, bc], uv: null });
        newTriangles.push({ v: [ab, bc, ca], uv: null });
      }
    }
    weldedPositions = newPositions;
    triangles = newTriangles;

    if (creaseSet.size) {
      const newCreaseSet = new Set();
      for (const ek of creaseSet) {
        const [x, y] = ek.split('_').map(Number);
        const mid = oddIndex.get(ek);
        if (mid === undefined) continue;
        newCreaseSet.add(edgeKey(x, mid));
        newCreaseSet.add(edgeKey(y, mid));
      }
      creaseSet = newCreaseSet;
    }
  }

  const cornerN = triangles.length * 3;
  const outPositions = new Float32Array(cornerN * 3);
  const outNormals = new Float32Array(cornerN * 3);
  const outUVs = hasUV ? new Float32Array(cornerN * 2) : undefined;

  if (creaseCapable) {
    // Sector-aware normals: average face normals per welded vertex, but only
    // within the fan of faces not separated by a crease edge, so hard edges
    // stay hard instead of being smoothed away.
    const faceNormals = triangles.map(tri => {
      const [a, b, c] = tri.v;
      const pa = weldedPositions[a], pb = weldedPositions[b], pc = weldedPositions[c];
      const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
      const e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
      return [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
    });
    const edgeTrianglesFinal = new Map();
    const vertexTris = new Map();
    for (let ti = 0; ti < triangles.length; ti++) {
      const [a, b, c] = triangles[ti].v;
      for (const [x, y] of [[a, b], [b, c], [c, a]]) {
        const ek = edgeKey(x, y);
        let list = edgeTrianglesFinal.get(ek);
        if (!list) { list = []; edgeTrianglesFinal.set(ek, list); }
        list.push(ti);
      }
      for (const v of [a, b, c]) {
        let list = vertexTris.get(v);
        if (!list) { list = []; vertexTris.set(v, list); }
        if (!list.includes(ti)) list.push(ti);
      }
    }
    const cornerNormalMap = new Map();
    for (const [vi, triList] of vertexTris) {
      const visited = new Set();
      for (const startTi of triList) {
        if (visited.has(startTi)) continue;
        const group = [startTi];
        visited.add(startTi);
        const stack = [startTi];
        while (stack.length) {
          const ti = stack.pop();
          const others = triangles[ti].v.filter(v => v !== vi);
          for (const ov of others) {
            const ek = edgeKey(vi, ov);
            if (creaseSet.has(ek)) continue;
            const adj = edgeTrianglesFinal.get(ek) || [];
            for (const t2 of adj) {
              if (t2 !== ti && !visited.has(t2) && triList.includes(t2)) {
                visited.add(t2);
                group.push(t2);
                stack.push(t2);
              }
            }
          }
        }
        let sx = 0, sy = 0, sz = 0;
        for (const ti of group) { const fn = faceNormals[ti]; sx += fn[0]; sy += fn[1]; sz += fn[2]; }
        const len = Math.hypot(sx, sy, sz) || 1;
        const groupNormal = [sx / len, sy / len, sz / len];
        for (const ti of group) cornerNormalMap.set(`${ti}_${vi}`, groupNormal);
      }
    }
    let cursor = 0;
    for (let ti = 0; ti < triangles.length; ti++) {
      const tri = triangles[ti];
      for (let k = 0; k < 3; k++) {
        const vi = tri.v[k];
        const p = weldedPositions[vi], n = cornerNormalMap.get(`${ti}_${vi}`);
        outPositions[cursor * 3] = p[0]; outPositions[cursor * 3 + 1] = p[1]; outPositions[cursor * 3 + 2] = p[2];
        outNormals[cursor * 3] = n[0]; outNormals[cursor * 3 + 1] = n[1]; outNormals[cursor * 3 + 2] = n[2];
        if (outUVs && tri.uv) {
          outUVs[cursor * 2] = tri.uv[k][0]; outUVs[cursor * 2 + 1] = tri.uv[k][1];
        }
        cursor++;
      }
    }
    return {
      positions: outPositions,
      normals: outNormals,
      ...(outUVs ? { uvs: outUVs } : {}),
      triangleCount: triangles.length,
    };
  }

  // Area-weighted smooth normals from the final welded topology.
  const smoothNormals = weldedPositions.map(() => [0, 0, 0]);
  for (const tri of triangles) {
    const [a, b, c] = tri.v;
    const pa = weldedPositions[a], pb = weldedPositions[b], pc = weldedPositions[c];
    const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    for (const vi of [a, b, c]) {
      smoothNormals[vi][0] += nx; smoothNormals[vi][1] += ny; smoothNormals[vi][2] += nz;
    }
  }
  for (const n of smoothNormals) {
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    n[0] /= len; n[1] /= len; n[2] /= len;
  }

  // Re-expand to deindexed corners (sequential index, matching the current
  // renderer path exactly).
  let cursor = 0;
  for (const tri of triangles) {
    for (let k = 0; k < 3; k++) {
      const vi = tri.v[k];
      const p = weldedPositions[vi], n = smoothNormals[vi];
      outPositions[cursor * 3] = p[0]; outPositions[cursor * 3 + 1] = p[1]; outPositions[cursor * 3 + 2] = p[2];
      outNormals[cursor * 3] = n[0]; outNormals[cursor * 3 + 1] = n[1]; outNormals[cursor * 3 + 2] = n[2];
      if (outUVs && tri.uv) {
        outUVs[cursor * 2] = tri.uv[k][0]; outUVs[cursor * 2 + 1] = tri.uv[k][1];
      }
      cursor++;
    }
  }

  return {
    positions: outPositions,
    normals: outNormals,
    ...(outUVs ? { uvs: outUVs } : {}),
    triangleCount: triangles.length,
  };
}

// Welds bitwise-equal corners (position, normal, uv) into an indexed buffer so
// tangents average across shared vertices; seams and hard edges stay split and
// corner order is kept, so subset start/count ranges stay valid.
function weldMesh(mesh) {
  const positions = mesh.positions;
  const normals = mesh.normals;
  if (!positions || !normals) return mesh;
  const cornerCount = Math.floor(positions.length / 3);
  if (cornerCount < 3 || normals.length !== positions.length) return mesh;
  const uvs = mesh.uvs;
  const hasUV = uvs && uvs.length === cornerCount * 2;
  const vertexMap = new Map();
  const outPositions = [];
  const outNormals = [];
  const outUVs = hasUV ? [] : undefined;
  const indices = new Uint32Array(cornerCount);
  for (let c = 0; c < cornerCount; c++) {
    const px = positions[c * 3], py = positions[c * 3 + 1], pz = positions[c * 3 + 2];
    const nx = normals[c * 3], ny = normals[c * 3 + 1], nz = normals[c * 3 + 2];
    const key = hasUV
      ? `${px},${py},${pz}|${nx},${ny},${nz}|${uvs[c * 2]},${uvs[c * 2 + 1]}`
      : `${px},${py},${pz}|${nx},${ny},${nz}`;
    let vi = vertexMap.get(key);
    if (vi === undefined) {
      vi = outPositions.length / 3;
      outPositions.push(px, py, pz);
      outNormals.push(nx, ny, nz);
      if (hasUV) outUVs.push(uvs[c * 2], uvs[c * 2 + 1]);
      vertexMap.set(key, vi);
    }
    indices[c] = vi;
  }
  mesh.positions = Float32Array.from(outPositions);
  mesh.normals = Float32Array.from(outNormals);
  if (hasUV) mesh.uvs = Float32Array.from(outUVs);
  mesh.indices = indices;
  mesh.welded = true;
  mesh.weldedCornerCount = cornerCount;
  mesh.weldedVertexCount = outPositions.length / 3;
  return mesh;
}

  globalThis.MtlxMeshSubdivision = { subdivideMesh, weldMesh };
})();
