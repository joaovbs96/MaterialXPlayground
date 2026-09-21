// Shared mesh subdivision and welding. This file is loaded as a plain
// global script by the page and imported by the USD module worker.
(function () {
  'use strict';

  const weldHashBuffer = new ArrayBuffer(8);
  const weldHashFloat64 = new Float64Array(weldHashBuffer);
  const weldHashWords = new Uint32Array(weldHashBuffer);
  function hashWeldNumber(value) {
    const numeric = Number(value);
    if (Number.isNaN(numeric)) return 0x7fc00000;
    if (numeric === 0) {
      weldHashWords[0] = 0;
      weldHashWords[1] = 0;
      return 0;
    }
    weldHashFloat64[0] = numeric;
    return (Math.imul(weldHashWords[0], 0x9e3779b1) ^ Math.imul(weldHashWords[1], 0x85ebca6b)) >>> 0;
  }
  function subdivideMesh(mesh, levels, options = {}) {
  const positions = mesh.positions;
  if (!positions || positions.length < 9 || levels <= 0) return null;
  const indices = mesh.indices;
  const cornerCount = indices ? indices.length : positions.length / 3;
  if (cornerCount < 3 || cornerCount % 3 !== 0) return null;
  const hasUV = mesh.uvs && mesh.uvs.length === (positions.length / 3) * 2;
  const creaseCapable = !!(options.creaseByNormals && mesh.normals && mesh.normals.length === positions.length);
  const geompropDescs = (mesh.geomprops ?? [])
    .filter(prop => prop && Number.isInteger(prop.itemSize) && prop.itemSize > 0 && prop.data &&
      prop.data.length === (positions.length / 3) * prop.itemSize)
    .map(prop => ({ name: prop.name, itemSize: prop.itemSize, interpolation: prop.interpolation, data: prop.data }));

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
    const sourceCorner = cornerIndex => indices ? indices[cornerIndex] : cornerIndex;
    const sourceA = sourceCorner(c), sourceB = sourceCorner(c + 1), sourceC = sourceCorner(c + 2);
    const uv = hasUV ? [
      [mesh.uvs[sourceA * 2], mesh.uvs[sourceA * 2 + 1]],
      [mesh.uvs[sourceB * 2], mesh.uvs[sourceB * 2 + 1]],
      [mesh.uvs[sourceC * 2], mesh.uvs[sourceC * 2 + 1]],
    ] : null;
    const gp = geompropDescs.length ? geompropDescs.map(desc => [
      Array.from(desc.data.subarray(sourceA * desc.itemSize, (sourceA + 1) * desc.itemSize)),
      Array.from(desc.data.subarray(sourceB * desc.itemSize, (sourceB + 1) * desc.itemSize)),
      Array.from(desc.data.subarray(sourceC * desc.itemSize, (sourceC + 1) * desc.itemSize)),
    ]) : null;
    const n = creaseCapable ? [cornerNormal(c), cornerNormal(c + 1), cornerNormal(c + 2)] : null;
    triangles.push({ v: [a, b, cc], uv, gp, n });
  }
  if (weldedPositions.length < 4 || !triangles.length) return null;

  const edgeKey = (x, y) => (x < y ? `${x}_${y}` : `${y}_${x}`);  let creaseSet = new Set();
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
          differs(cornerNormalAt(adj[0], y), cornerNormalAt(adj[1], y))) creaseSet.add(ek);
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
      const boundaryNeighbors = neighbors.filter(nb => edgeTriangles.get(edgeKey(vi, nb)).length === 1 || creaseSet.has(edgeKey(vi, nb)));
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
      const pa = weldedPositions[a], pb = weldedPositions[b];
      // Real-world meshes can have degenerate triangles (a collapsed
      // diagonal) or non-manifold edges (shared by more than two
      // triangles). Both break the textbook interior mask; fall back to
      // the boundary midpoint rule rather than crashing on bad topology.
      const oppOf = (ti) => triangles[ti]?.v.find(v => v !== a && v !== b);
      let pc, pd;
      if (adj.length === 2 && !creaseSet.has(ek)) {
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
    // Componentwise average, the same midpoint rule as lerpUV(..., 0.5).
    const lerpGP = (v0, v1) => v0.map((x, i) => (x + v1[i]) / 2);
    const newTriangles = [];
    for (const tri of triangles) {
      const [a, b, c] = tri.v;
      const ab = getOdd(a, b), bc = getOdd(b, c), ca = getOdd(c, a);
      const gp = tri.gp ? tri.gp.map(([gA, gB, gC]) => {
        const gAB = lerpGP(gA, gB), gBC = lerpGP(gB, gC), gCA = lerpGP(gC, gA);
        return { gA, gB, gC, gAB, gBC, gCA };
      }) : null;
      if (tri.uv) {
        const [uvA, uvB, uvC] = tri.uv;
        const uvAB = lerpUV(uvA, uvB, 0.5), uvBC = lerpUV(uvB, uvC, 0.5), uvCA = lerpUV(uvC, uvA, 0.5);
        newTriangles.push({ v: [a, ab, ca], uv: [uvA, uvAB, uvCA], gp: gp && gp.map(g => [g.gA, g.gAB, g.gCA]) });
        newTriangles.push({ v: [b, bc, ab], uv: [uvB, uvBC, uvAB], gp: gp && gp.map(g => [g.gB, g.gBC, g.gAB]) });
        newTriangles.push({ v: [c, ca, bc], uv: [uvC, uvCA, uvBC], gp: gp && gp.map(g => [g.gC, g.gCA, g.gBC]) });
        newTriangles.push({ v: [ab, bc, ca], uv: [uvAB, uvBC, uvCA], gp: gp && gp.map(g => [g.gAB, g.gBC, g.gCA]) });
      } else {
        newTriangles.push({ v: [a, ab, ca], uv: null, gp: gp && gp.map(g => [g.gA, g.gAB, g.gCA]) });
        newTriangles.push({ v: [b, bc, ab], uv: null, gp: gp && gp.map(g => [g.gB, g.gBC, g.gAB]) });
        newTriangles.push({ v: [c, ca, bc], uv: null, gp: gp && gp.map(g => [g.gC, g.gCA, g.gBC]) });
        newTriangles.push({ v: [ab, bc, ca], uv: null, gp: gp && gp.map(g => [g.gAB, g.gBC, g.gCA]) });
      }
    }
    if (creaseCapable) {
      const newCreaseSet = new Set();
      for (const ek of creaseSet) {
        const [a, b] = ek.split('_').map(Number);
        const mid = oddIndex.get(ek);
        if (mid === undefined) continue;
        newCreaseSet.add(edgeKey(a, mid));
        newCreaseSet.add(edgeKey(mid, b));
      }
      creaseSet = newCreaseSet;
    }
    weldedPositions = newPositions;
    triangles = newTriangles;
  }

  // Area-weighted smooth normals from the final welded topology. At a pole
  // vertex where incident faces fold back on themselves (e.g. a welded UV
  // seam at the tip of a cap), the area-weighted sum can cancel to exactly
  // zero even though every incident face is well formed; normalizing that
  // would hand the renderer a zero-length normal (NaN once it normalizes
  // again downstream). Track one non-degenerate incident face normal per
  // vertex as a fallback for exactly that case.
  const smoothNormals = weldedPositions.map(() => [0, 0, 0]);
  const fallbackNormals = weldedPositions.map(() => null);
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
      if (!fallbackNormals[vi] && (nx || ny || nz)) fallbackNormals[vi] = [nx, ny, nz];
    }
  }
  for (let vi = 0; vi < smoothNormals.length; vi++) {
    const n = smoothNormals[vi];
    let len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-12 && fallbackNormals[vi]) {
      const f = fallbackNormals[vi];
      n[0] = f[0]; n[1] = f[1]; n[2] = f[2];
      len = Math.hypot(n[0], n[1], n[2]);
    }
    if (len < 1e-12) len = 1;
    n[0] /= len; n[1] /= len; n[2] /= len;
  }

  // Re-expand to deindexed corners (sequential index, matching the current
  // renderer path exactly).
  const cornerN = triangles.length * 3;
  const outPositions = new Float32Array(cornerN * 3);
  const outNormals = new Float32Array(cornerN * 3);
  const outUVs = hasUV ? new Float32Array(cornerN * 2) : undefined;
  const outGeomprops = geompropDescs.map(desc => new Float32Array(cornerN * desc.itemSize));
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
      if (tri.gp) {
        for (let si = 0; si < geompropDescs.length; si++) {
          const itemSize = geompropDescs[si].itemSize;
          const values = tri.gp[si][k];
          const base = cursor * itemSize;
          for (let vc = 0; vc < itemSize; vc++) outGeomprops[si][base + vc] = values[vc];
        }
      }
      cursor++;
    }
  }

  return {
    positions: outPositions,
    normals: outNormals,
    ...(outUVs ? { uvs: outUVs } : {}),
    ...(geompropDescs.length ? {
      geomprops: geompropDescs.map((desc, si) => ({
        name: desc.name,
        itemSize: desc.itemSize,
        interpolation: desc.interpolation,
        data: outGeomprops[si],
      })),
    } : {}),
    triangleCount: triangles.length,
  };
}

// Catmull-Clark on a deindexed triangle mesh: recovers the original n-gons
// from the native fan triangulation, then subdivides them with USD's
// edgeAndCorner boundary rule (fixed corners, smoothed straight edges).
function subdivideCatmullClark(mesh, levels, subsets, options = {}) {
  const positions = mesh.positions;
  if (!positions || positions.length < 9 || levels <= 0) return null;
  const indices = mesh.indices;
  const cornerCount = indices ? indices.length : positions.length / 3;
  if (cornerCount < 3 || cornerCount % 3 !== 0) return null;
  const hasUV = mesh.uvs && mesh.uvs.length === (positions.length / 3) * 2;
  const geompropDescs = (mesh.geomprops ?? [])
    .filter(prop => prop && Number.isInteger(prop.itemSize) && prop.itemSize > 0 && prop.data &&
      prop.data.length === (positions.length / 3) * prop.itemSize)
    .map(prop => ({ name: prop.name, itemSize: prop.itemSize, interpolation: prop.interpolation, data: prop.data }));

  const noSignZero = (v) => (v === 0 ? 0 : v);
  const posKey = (x, y, z) => `${noSignZero(x).toFixed(5)},${noSignZero(y).toFixed(5)},${noSignZero(z).toFixed(5)}`;
  const posMap = new Map();
  const positionsList = [];
  const cornerVertex = (cornerIndex) => {
    const srcIndex = indices ? indices[cornerIndex] : cornerIndex;
    const x = positions[srcIndex * 3], y = positions[srcIndex * 3 + 1], z = positions[srcIndex * 3 + 2];
    const key = posKey(x, y, z);
    let vi = posMap.get(key);
    if (vi === undefined) {
      vi = positionsList.length;
      positionsList.push([x, y, z]);
      posMap.set(key, vi);
    }
    return vi;
  };

  const triCount = cornerCount / 3;
  const triVerts = new Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const c = t * 3;
    triVerts[t] = [cornerVertex(c), cornerVertex(c + 1), cornerVertex(c + 2)];
  }
  if (positionsList.length < 3) return null;

  // UVs and geomprops are face-varying per-corner streams; a corner is
  // remapped through indices exactly like positions above.
  const uvAt = (c) => {
    const srcIndex = indices ? indices[c] : c;
    return [mesh.uvs[srcIndex * 2], mesh.uvs[srcIndex * 2 + 1]];
  };
  const gpAt = (desc, c) => {
    const srcIndex = indices ? indices[c] : c;
    return Array.from(desc.data.subarray(srcIndex * desc.itemSize, (srcIndex + 1) * desc.itemSize));
  };

  // Authored faceVertexCounts may be missing or only a prefix, so subset
  // boundaries remain a second, independent hint that a fan must not merge
  // triangles across a material split even when the fan pattern would allow it.
  const subsetStartTriangles = new Set();
  if (Array.isArray(subsets)) {
    for (const s of subsets) {
      if (Number.isFinite(s.start)) subsetStartTriangles.add(s.start / 3);
    }
  }

  // Recover polygons from the triangle-fan pattern the native draw emits per
  // face: (v0,v1,v2),(v0,v2,v3),... Authored faceVertexCounts (possibly only
  // a prefix) disambiguate real n-gons; once a count fails to check out, the
  // rest of the mesh falls back to a heuristic capped at quads, which keeps
  // faces that only share a vertex (never a real edge) from being merged.
  const authoredCounts = Array.isArray(options.faceVertexCounts) ? options.faceVertexCounts : null;
  let countIndex = 0;
  let trustCounts = !!(authoredCounts && authoredCounts.length);
  const chainMatches = (candidate, a2, b2, c2) =>
    a2 === candidate[0] && b2 === candidate[candidate.length - 1] && !candidate.includes(c2);
  const faces = [];
  let ti = 0;
  while (ti < triCount) {
    const [a, b, c] = triVerts[ti];
    if (a === b || b === c || c === a) { trustCounts = false; ti++; continue; }
    const startCorner = ti * 3;
    let verts = null;
    if (trustCounts) {
      if (countIndex < authoredCounts.length) {
        const n = authoredCounts[countIndex];
        countIndex++;
        if (Number.isInteger(n) && n >= 3) {
          const need = n - 2;
          if (ti + need <= triCount) {
            const candidate = [a, b, c];
            let valid = true;
            for (let k = 1; k < need; k++) {
              const idx = ti + k;
              const [a2, b2, c2] = triVerts[idx];
              if (subsetStartTriangles.has(idx) || a2 === b2 || b2 === c2 || c2 === a2 || !chainMatches(candidate, a2, b2, c2)) {
                valid = false; break;
              }
              candidate.push(c2);
            }
            if (valid) verts = candidate;
          }
        }
        if (!verts) trustCounts = false;
      } else {
        trustCounts = false;
      }
    }
    if (!verts) {
      // Heuristic: a lone triangle, or a fan pair capped at a quad. Never
      // extends further, so two faces that only touch at a vertex (not a
      // shared edge) cannot be merged into one false n-gon.
      verts = [a, b, c];
      const next = ti + 1;
      if (next < triCount && !subsetStartTriangles.has(next)) {
        const [a2, b2, c2] = triVerts[next];
        if (!(a2 === b2 || b2 === c2 || c2 === a2) && chainMatches(verts, a2, b2, c2)) verts.push(c2);
      }
    }
    const used = verts.length - 2;
    const uv = hasUV ? [uvAt(startCorner), uvAt(startCorner + 1), uvAt(startCorner + 2)] : null;
    const gp = geompropDescs.length
      ? geompropDescs.map(desc => [gpAt(desc, startCorner), gpAt(desc, startCorner + 1), gpAt(desc, startCorner + 2)])
      : null;
    for (let k = 1; k < used; k++) {
      const idx = ti + k;
      if (uv) uv.push(uvAt(idx * 3 + 2));
      if (gp) gp.forEach((arr, gi) => arr.push(gpAt(geompropDescs[gi], idx * 3 + 2)));
    }
    faces.push({ verts, uv, gp, n: verts.length, startCorner });
    ti += used;
  }
  if (!faces.length) return null;

  const edgeKey = (x, y) => (x < y ? `${x}_${y}` : `${y}_${x}`);
  let currentFaces = faces.map(f => ({
    verts: f.verts.slice(),
    uv: f.uv ? f.uv.map(uv => uv.slice()) : null,
    gp: f.gp ? f.gp.map(arr => arr.map(v => v.slice())) : null,
  }));
  let currentPositions = positionsList;

  for (let level = 0; level < levels; level++) {
    const n = currentPositions.length;

    const facePoints = new Array(currentFaces.length);
    for (let fi = 0; fi < currentFaces.length; fi++) {
      const verts = currentFaces[fi].verts;
      let sx = 0, sy = 0, sz = 0;
      for (const vi of verts) { const p = currentPositions[vi]; sx += p[0]; sy += p[1]; sz += p[2]; }
      facePoints[fi] = [sx / verts.length, sy / verts.length, sz / verts.length];
    }

    // Edges are shared across faces (position only; UV and geomprops stay face-varying).
    const edges = new Map();
    for (let fi = 0; fi < currentFaces.length; fi++) {
      const verts = currentFaces[fi].verts;
      const m = verts.length;
      for (let i = 0; i < m; i++) {
        const a = verts[i], b = verts[(i + 1) % m];
        const ek = edgeKey(a, b);
        let e = edges.get(ek);
        if (!e) { e = { a: Math.min(a, b), b: Math.max(a, b), faces: [] }; edges.set(ek, e); }
        e.faces.push(fi);
      }
    }

    const vertexFaces = Array.from({ length: n }, () => []);
    const vertexEdges = Array.from({ length: n }, () => []);
    const edgePointPos = new Map();
    for (const [ek, e] of edges) {
      const pa = currentPositions[e.a], pb = currentPositions[e.b];
      const mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
      let pos = mid;
      if (e.faces.length === 2) {
        const f0 = facePoints[e.faces[0]], f1 = facePoints[e.faces[1]];
        pos = [
          (pa[0] + pb[0] + f0[0] + f1[0]) / 4,
          (pa[1] + pb[1] + f0[1] + f1[1]) / 4,
          (pa[2] + pb[2] + f0[2] + f1[2]) / 4,
        ];
      }
      edgePointPos.set(ek, pos);
      vertexEdges[e.a].push({ other: e.b, faceCount: e.faces.length, midpoint: mid });
      vertexEdges[e.b].push({ other: e.a, faceCount: e.faces.length, midpoint: mid });
    }
    for (let fi = 0; fi < currentFaces.length; fi++) {
      for (const vi of currentFaces[fi].verts) vertexFaces[vi].push(fi);
    }

    // Vertex points: interior smoothing, or USD's edgeAndCorner boundary
    // rule (fixed corners, smoothed straight boundary edges).
    const vertexPoints = new Array(n);
    for (let vi = 0; vi < n; vi++) {
      const p = currentPositions[vi];
      const vEdges = vertexEdges[vi];
      const boundaryEdges = vEdges.filter(e => e.faceCount === 1);
      const nonManifold = vEdges.some(e => e.faceCount > 2);
      if (boundaryEdges.length > 0 || nonManifold) {
        if (!nonManifold && boundaryEdges.length === 2 && vertexFaces[vi].length > 1) {
          const b0 = currentPositions[boundaryEdges[0].other], b1 = currentPositions[boundaryEdges[1].other];
          vertexPoints[vi] = [
            0.75 * p[0] + 0.125 * (b0[0] + b1[0]),
            0.75 * p[1] + 0.125 * (b0[1] + b1[1]),
            0.75 * p[2] + 0.125 * (b0[2] + b1[2]),
          ];
        } else {
          vertexPoints[vi] = p.slice();
        }
      } else {
        const k = vEdges.length || 1;
        let qx = 0, qy = 0, qz = 0;
        for (const fi of vertexFaces[vi]) { const fp = facePoints[fi]; qx += fp[0]; qy += fp[1]; qz += fp[2]; }
        const fCount = vertexFaces[vi].length || 1;
        qx /= fCount; qy /= fCount; qz /= fCount;
        let rx = 0, ry = 0, rz = 0;
        for (const e of vEdges) { rx += e.midpoint[0]; ry += e.midpoint[1]; rz += e.midpoint[2]; }
        rx /= k; ry /= k; rz /= k;
        vertexPoints[vi] = [
          (qx + 2 * rx + (k - 3) * p[0]) / k,
          (qy + 2 * ry + (k - 3) * p[1]) / k,
          (qz + 2 * rz + (k - 3) * p[2]) / k,
        ];
      }
    }

    const newPositions = vertexPoints.slice();
    const edgeIndex = new Map();
    for (const [ek, pos] of edgePointPos) { edgeIndex.set(ek, newPositions.length); newPositions.push(pos); }
    const faceIndexOffset = newPositions.length;
    for (const fp of facePoints) newPositions.push(fp);

    const lerpUV = (u0, u1, t) => [u0[0] + (u1[0] - u0[0]) * t, u0[1] + (u1[1] - u0[1]) * t];
    // Componentwise average, the same midpoint rule as lerpUV(..., 0.5).
    const lerpGP = (v0, v1) => v0.map((x, i) => (x + v1[i]) / 2);
    const newFaces = [];
    for (let fi = 0; fi < currentFaces.length; fi++) {
      const verts = currentFaces[fi].verts;
      const uv = currentFaces[fi].uv;
      const gp = currentFaces[fi].gp;
      const m = verts.length;
      let faceUVAvg = null;
      if (uv) {
        let ux = 0, uy = 0;
        for (const u of uv) { ux += u[0]; uy += u[1]; }
        faceUVAvg = [ux / m, uy / m];
      }
      let faceGPAvg = null;
      if (gp) {
        faceGPAvg = gp.map(arr => {
          const itemSize = arr[0].length;
          const sum = new Array(itemSize).fill(0);
          for (const v of arr) for (let k = 0; k < itemSize; k++) sum[k] += v[k];
          return sum.map(s => s / m);
        });
      }
      const facePointIndex = faceIndexOffset + fi;
      for (let i = 0; i < m; i++) {
        const prev = (i - 1 + m) % m;
        const next = (i + 1) % m;
        const eNext = edgeIndex.get(edgeKey(verts[i], verts[next]));
        const ePrev = edgeIndex.get(edgeKey(verts[prev], verts[i]));
        const quadVerts = [verts[i], eNext, facePointIndex, ePrev];
        let quadUV = null;
        if (uv) {
          quadUV = [uv[i], lerpUV(uv[i], uv[next], 0.5), faceUVAvg, lerpUV(uv[prev], uv[i], 0.5)];
        }
        let quadGP = null;
        if (gp) {
          quadGP = gp.map((arr, gi) => [arr[i], lerpGP(arr[i], arr[next]), faceGPAvg[gi], lerpGP(arr[prev], arr[i])]);
        }
        newFaces.push({ verts: quadVerts, uv: quadUV, gp: quadGP });
      }
    }
    currentPositions = newPositions;
    currentFaces = newFaces;
  }

  // Triangulate the final quads and compute area-weighted smooth normals
  // from the resulting welded topology, same policy as subdivideMesh.
  const triangles = [];
  for (const f of currentFaces) {
    const [a, b, c, d] = f.verts;
    const triUV = (idxs) => f.uv ? idxs.map(i => f.uv[i]) : null;
    const triGP = (idxs) => f.gp ? f.gp.map(arr => idxs.map(i => arr[i])) : null;
    triangles.push({ v: [a, b, c], uv: triUV([0, 1, 2]), gp: triGP([0, 1, 2]) });
    triangles.push({ v: [a, c, d], uv: triUV([0, 2, 3]), gp: triGP([0, 2, 3]) });
  }
  if (!triangles.length) return null;

  const smoothNormals = currentPositions.map(() => [0, 0, 0]);
  for (const tri of triangles) {
    const [a, b, c] = tri.v;
    const pa = currentPositions[a], pb = currentPositions[b], pc = currentPositions[c];
    const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    for (const vi of [a, b, c]) {
      smoothNormals[vi][0] += nx; smoothNormals[vi][1] += ny; smoothNormals[vi][2] += nz;
    }
  }
  for (const nrm of smoothNormals) {
    const len = Math.hypot(nrm[0], nrm[1], nrm[2]) || 1;
    nrm[0] /= len; nrm[1] /= len; nrm[2] /= len;
  }

  const cornerN = triangles.length * 3;
  const outPositions = new Float32Array(cornerN * 3);
  const outNormals = new Float32Array(cornerN * 3);
  const outUVs = hasUV ? new Float32Array(cornerN * 2) : undefined;
  const outGeomprops = geompropDescs.map(desc => new Float32Array(cornerN * desc.itemSize));
  let cursor = 0;
  for (const tri of triangles) {
    for (let k = 0; k < 3; k++) {
      const vi = tri.v[k];
      const p = currentPositions[vi], nrm = smoothNormals[vi];
      outPositions[cursor * 3] = p[0]; outPositions[cursor * 3 + 1] = p[1]; outPositions[cursor * 3 + 2] = p[2];
      outNormals[cursor * 3] = nrm[0]; outNormals[cursor * 3 + 1] = nrm[1]; outNormals[cursor * 3 + 2] = nrm[2];
      if (outUVs && tri.uv) {
        outUVs[cursor * 2] = tri.uv[k][0]; outUVs[cursor * 2 + 1] = tri.uv[k][1];
      }
      if (tri.gp) {
        for (let si = 0; si < geompropDescs.length; si++) {
          const itemSize = geompropDescs[si].itemSize;
          const values = tri.gp[si][k];
          const base = cursor * itemSize;
          for (let vc = 0; vc < itemSize; vc++) outGeomprops[si][base + vc] = values[vc];
        }
      }
      cursor++;
    }
  }

  const result = {
    positions: outPositions,
    normals: outNormals,
    ...(outUVs ? { uvs: outUVs } : {}),
    ...(geompropDescs.length ? {
      geomprops: geompropDescs.map((desc, si) => ({
        name: desc.name,
        itemSize: desc.itemSize,
        interpolation: desc.interpolation,
        data: outGeomprops[si],
      })),
    } : {}),
    triangleCount: triangles.length,
  };

  // Each original face yields n * 4^(levels-1) quads (6 corners each) and
  // families never interleave, so subset ranges stay contiguous spans.
  if (Array.isArray(subsets) && subsets.length) {
    const familyCorners = faces.map(f => f.n * 4 ** (levels - 1) * 6);
    const familyStart = new Array(faces.length);
    let offset = 0;
    for (let i = 0; i < faces.length; i++) { familyStart[i] = offset; offset += familyCorners[i]; }
    result.subsets = subsets.map(subset => {
      const end = subset.start + subset.count;
      let newStart = null, newCount = 0;
      for (let i = 0; i < faces.length; i++) {
        if (faces[i].startCorner >= subset.start && faces[i].startCorner < end) {
          if (newStart === null) newStart = familyStart[i];
          newCount += familyCorners[i];
        }
      }
      return { ...subset, start: newStart ?? 0, count: newCount };
    });
  }

  return result;
}

// Welds per-corner streams (positions/normals/uvs bitwise equal) into an
// indexed vertex buffer so computeTangents can average tangents across every
// face sharing a vertex instead of computing one tangent per lone corner.
// UV seams and hard normal edges stay split naturally since their corners
// differ. Corner order is preserved in the output indices, so material
// subset start/count ranges (which are ranges over corners) stay valid.
function weldMesh(mesh) {
  const positions = mesh.positions;
  const normals = mesh.normals;
  if (!positions || !normals) return mesh;
  const cornerCount = Math.floor(positions.length / 3);
  if (cornerCount < 3 || normals.length !== positions.length) return mesh;
  const uvs = mesh.uvs;
  const hasUV = uvs && uvs.length === cornerCount * 2;
  // Every stream feeds the weld key. Numeric buckets avoid retaining a long
  // concatenated string per corner; exact stream equality resolves collisions.
  const geompropDescs = (mesh.geomprops ?? [])
    .filter(prop => prop && Number.isInteger(prop.itemSize) && prop.itemSize > 0 && prop.data && prop.data.length === cornerCount * prop.itemSize)
    .map(prop => ({ name: prop.name, itemSize: prop.itemSize, interpolation: prop.interpolation, data: prop.data }));
  const hashNumber = hashWeldNumber;
  const hashValue = (hash, value) => Math.imul(hash ^ hashNumber(value), 16777619) >>> 0;
  const hashCorner = corner => {
    let hash = 2166136261;
    const base = corner * 3;
    hash = hashValue(hash, positions[base]);
    hash = hashValue(hash, positions[base + 1]);
    hash = hashValue(hash, positions[base + 2]);
    hash = hashValue(hash, normals[base]);
    hash = hashValue(hash, normals[base + 1]);
    hash = hashValue(hash, normals[base + 2]);
    if (hasUV) {
      const uvBase = corner * 2;
      hash = hashValue(hash, uvs[uvBase]);
      hash = hashValue(hash, uvs[uvBase + 1]);
    }
    for (const desc of geompropDescs) {
      const gpBase = corner * desc.itemSize;
      for (let vc = 0; vc < desc.itemSize; vc++) hash = hashValue(hash, desc.data[gpBase + vc]);
    }
    return hash;
  };
  const sameValue = (left, right) => left === right || (Number.isNaN(Number(left)) && Number.isNaN(Number(right)));
  const sameCorner = (leftCorner, rightCorner) => {
    const leftBase = leftCorner * 3, rightBase = rightCorner * 3;
    for (let c = 0; c < 3; c++) {
      if (!sameValue(positions[leftBase + c], positions[rightBase + c])
          || !sameValue(normals[leftBase + c], normals[rightBase + c])) return false;
    }
    if (hasUV) {
      const leftUV = leftCorner * 2, rightUV = rightCorner * 2;
      for (let c = 0; c < 2; c++) if (!sameValue(uvs[leftUV + c], uvs[rightUV + c])) return false;
    }
    for (const desc of geompropDescs) {
      const leftGP = leftCorner * desc.itemSize, rightGP = rightCorner * desc.itemSize;
      for (let c = 0; c < desc.itemSize; c++) {
        if (!sameValue(desc.data[leftGP + c], desc.data[rightGP + c])) return false;
      }
    }
    return true;
  };

  // First pass retains only representative source corners and the remap.
  const vertexMap = new Map();
  const representativeCorners = new Uint32Array(cornerCount);
  const cornerVertices = new Uint32Array(cornerCount);
  let vertexCount = 0;
  for (let corner = 0; corner < cornerCount; corner++) {
    const hash = hashCorner(corner);
    const bucket = vertexMap.get(hash);
    let vertex = -1;
    if (bucket === undefined) {
      vertex = vertexCount;
    } else if (Array.isArray(bucket)) {
      for (const candidate of bucket) {
        if (sameCorner(corner, representativeCorners[candidate])) { vertex = candidate; break; }
      }
      if (vertex < 0) vertex = vertexCount;
    } else if (sameCorner(corner, representativeCorners[bucket])) {
      vertex = bucket;
    } else {
      vertex = vertexCount;
    }
    if (vertex === vertexCount) {
      representativeCorners[vertexCount++] = corner;
      if (bucket === undefined) vertexMap.set(hash, vertex);
      else if (Array.isArray(bucket)) bucket.push(vertex);
      else vertexMap.set(hash, [bucket, vertex]);
    }
    cornerVertices[corner] = vertex;
  }

  const outPositions = new Float32Array(vertexCount * 3);
  const outNormals = new Float32Array(vertexCount * 3);
  const outUVs = hasUV ? new Float32Array(vertexCount * 2) : undefined;
  const outGeomprops = geompropDescs.map(desc => new Float32Array(vertexCount * desc.itemSize));
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const corner = representativeCorners[vertex];
    const sourceBase = corner * 3, outputBase = vertex * 3;
    for (let c = 0; c < 3; c++) {
      outPositions[outputBase + c] = positions[sourceBase + c];
      outNormals[outputBase + c] = normals[sourceBase + c];
    }
    if (hasUV) {
      const sourceUV = corner * 2, outputUV = vertex * 2;
      outUVs[outputUV] = uvs[sourceUV];
      outUVs[outputUV + 1] = uvs[sourceUV + 1];
    }
    for (let si = 0; si < geompropDescs.length; si++) {
      const desc = geompropDescs[si];
      const sourceGP = corner * desc.itemSize, outputGP = vertex * desc.itemSize;
      for (let c = 0; c < desc.itemSize; c++) outGeomprops[si][outputGP + c] = desc.data[sourceGP + c];
    }
  }

  mesh.positions = outPositions;
  mesh.normals = outNormals;
  if (hasUV) mesh.uvs = outUVs;
  if (geompropDescs.length) {
    mesh.geomprops = geompropDescs.map((desc, si) => ({
      name: desc.name,
      itemSize: desc.itemSize,
      interpolation: desc.interpolation,
      data: outGeomprops[si],
    }));
  } else {
    delete mesh.geomprops;
  }
  const indices = new Uint32Array(cornerCount);
  indices.set(cornerVertices);
  mesh.indices = indices;
  mesh.welded = true;
  mesh.weldedCornerCount = cornerCount;
  mesh.weldedVertexCount = vertexCount;
  return mesh;
}  globalThis.MtlxMeshSubdivision = { subdivideMesh, subdivideCatmullClark, weldMesh, hashWeldNumber };
})();