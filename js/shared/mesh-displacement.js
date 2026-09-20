// Pure CPU displacement math shared by the page and (later) the worker.
// Plain script (no import/export); sets globalThis.MtlxMeshDisplacement =
// { computeDisplacedAttributes }. No THREE, no WebGL, no DOM.
(function () {
  'use strict';

function vlen(x, y, z) { return Math.hypot(x, y, z); }

function vnorm(x, y, z) {
  const len = vlen(x, y, z);
  if (len <= 1e-20) return [0, 0, 0];
  return [x / len, y / len, z / len];
}

function vcross(ax, ay, az, bx, by, bz) {
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

// Branchless stable orthonormal basis around a unit normal n (Duff et al.,
// "Building an Orthonormal Basis, Revisited"). Used only when tangents are
// missing entirely; both tangent and bitangent come from this basis.
function orthonormalBasis(nx, ny, nz) {
  const sign = nz >= 0 ? 1 : -1;
  const a = -1 / (sign + nz);
  const b = nx * ny * a;
  const t = vnorm(1 + sign * nx * nx * a, sign * b, -sign * nx);
  const bt = vnorm(b, sign + ny * ny * a, -ny);
  return { t, bt };
}

function isBadNumber(v) {
  return !Number.isFinite(v);
}

function isZeroVec(v) {
  return v[0] === 0 && v[1] === 0 && v[2] === 0;
}

// Interior angle between two edges leaving one corner, from their (possibly
// zero-length) edge vectors. A degenerate edge contributes angle 0 so its
// corner is skipped rather than producing a bogus acos input.
function edgeAngle(e1, e2) {
  const u1 = vnorm(e1[0], e1[1], e1[2]);
  const u2 = vnorm(e2[0], e2[1], e2[2]);
  if (isZeroVec(u1) || isZeroVec(u2)) return 0;
  const dot = Math.min(1, Math.max(-1, u1[0] * u2[0] + u1[1] * u2[1] + u1[2] * u2[2]));
  return Math.acos(dot);
}

// Angle-weighted corner contributions for one triangle: each corner gets the
// triangle's UNIT face normal times its own interior angle there. A flat
// quad sums to the same total per corner regardless of which diagonal split.
function triangleAngleContributions(pa, pb, pc) {
  const ab = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
  const ac = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
  const bc = [pc[0] - pb[0], pc[1] - pb[1], pc[2] - pb[2]];
  const raw = vcross(ab[0], ab[1], ab[2], ac[0], ac[1], ac[2]);
  const n = vnorm(raw[0], raw[1], raw[2]);
  if (isZeroVec(n)) return { A: [0, 0, 0], B: [0, 0, 0], C: [0, 0, 0] };
  const angleA = edgeAngle(ab, ac);
  const angleB = edgeAngle([-ab[0], -ab[1], -ab[2]], bc);
  const angleC = edgeAngle([-ac[0], -ac[1], -ac[2]], [-bc[0], -bc[1], -bc[2]]);
  return {
    A: [n[0] * angleA, n[1] * angleA, n[2] * angleA],
    B: [n[0] * angleB, n[1] * angleB, n[2] * angleB],
    C: [n[0] * angleC, n[1] * angleC, n[2] * angleC],
  };
}

function computeDisplacedAttributes(input) {
  const {
    positions, normals, tangents, bitangents, indices, offsets,
    mode, vertexMask, weldTolerance,
  } = input;

  const vertexCount = positions.length / 3;
  const cornerCount = indices ? indices.length : positions.length / 3;
  const triangleCount = Math.floor(cornerCount / 3);
  const vertexAt = (cornerIndex) => (indices ? indices[cornerIndex] : cornerIndex);

  // Bounding box diagonal drives the default weld tolerance; a degenerate
  // (single-point) mesh falls back to the minimum floor below.
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let v = 0; v < vertexCount; v++) {
    const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diagonal = vlen(maxX - minX, maxY - minY, maxZ - minZ);
  const tol = Math.max(weldTolerance != null ? weldTolerance : 1e-5 * diagonal, 1e-9);

  // Weld by quantized position. Math.round on an integer key means -0 and
  // 0 stringify identically, so no separate sign normalization is needed.
  const groupOf = new Int32Array(vertexCount);
  const groupMembers = [];
  const posKeyMap = new Map();
  for (let v = 0; v < vertexCount; v++) {
    const qx = Math.round(positions[v * 3] / tol);
    const qy = Math.round(positions[v * 3 + 1] / tol);
    const qz = Math.round(positions[v * 3 + 2] / tol);
    const key = qx + ',' + qy + ',' + qz;
    let g = posKeyMap.get(key);
    if (g === undefined) {
      g = groupMembers.length;
      posKeyMap.set(key, g);
      groupMembers.push([]);
    }
    groupOf[v] = g;
    groupMembers[g].push(v);
  }
  const groupCount = groupMembers.length;

  const triVertex = new Int32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    triVertex[t * 3] = vertexAt(t * 3);
    triVertex[t * 3 + 1] = vertexAt(t * 3 + 1);
    triVertex[t * 3 + 2] = vertexAt(t * 3 + 2);
  }

  // Angle-weighted smooth normal per welded group, from the original
  // (undisplaced) positions. Degenerate sums fall back to the average of
  // the group members' own input normals. Triangulation-independent.
  const groupNormalAccum = new Float64Array(groupCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    const ia = triVertex[t * 3], ib = triVertex[t * 3 + 1], ic = triVertex[t * 3 + 2];
    const pa = [positions[ia * 3], positions[ia * 3 + 1], positions[ia * 3 + 2]];
    const pb = [positions[ib * 3], positions[ib * 3 + 1], positions[ib * 3 + 2]];
    const pc = [positions[ic * 3], positions[ic * 3 + 1], positions[ic * 3 + 2]];
    const contrib = triangleAngleContributions(pa, pb, pc);
    for (const [v, w] of [[ia, contrib.A], [ib, contrib.B], [ic, contrib.C]]) {
      const g = groupOf[v];
      groupNormalAccum[g * 3] += w[0];
      groupNormalAccum[g * 3 + 1] += w[1];
      groupNormalAccum[g * 3 + 2] += w[2];
    }
  }
  const groupSmoothNormal = new Float64Array(groupCount * 3);
  for (let g = 0; g < groupCount; g++) {
    const sx = groupNormalAccum[g * 3], sy = groupNormalAccum[g * 3 + 1], sz = groupNormalAccum[g * 3 + 2];
    let n = vnorm(sx, sy, sz);
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) {
      let ax = 0, ay = 0, az = 0;
      for (const v of groupMembers[g]) { ax += normals[v * 3]; ay += normals[v * 3 + 1]; az += normals[v * 3 + 2]; }
      n = vnorm(ax, ay, az);
    }
    groupSmoothNormal[g * 3] = n[0]; groupSmoothNormal[g * 3 + 1] = n[1]; groupSmoothNormal[g * 3 + 2] = n[2];
  }

  // Isotropic test drives 'auto' resolution and is reported regardless.
  let isotropic = true;
  for (let v = 0; v < vertexCount; v++) {
    if (vertexMask && !vertexMask[v]) continue;
    const x = offsets[v * 3], y = offsets[v * 3 + 1], z = offsets[v * 3 + 2];
    const eps = 1e-6 * Math.max(1, Math.abs(x));
    if (Math.abs(x - y) > eps || Math.abs(y - z) > eps) { isotropic = false; break; }
  }
  const resolvedMode = mode === 'auto' ? (isotropic ? 'float' : 'vector3') : mode;

  const hasTangents = !!tangents;
  const tangentStride = hasTangents ? Math.round(tangents.length / vertexCount) : 0;
  const tangentFallback = resolvedMode === 'vector3' && !hasTangents;

  // Per-vertex object-space displacement vector, before weld averaging.
  const vecX = new Float64Array(vertexCount);
  const vecY = new Float64Array(vertexCount);
  const vecZ = new Float64Array(vertexCount);
  let invalidOffsets = 0;
  for (let v = 0; v < vertexCount; v++) {
    let ox = offsets[v * 3], oy = offsets[v * 3 + 1], oz = offsets[v * 3 + 2];
    if (isBadNumber(ox) || isBadNumber(oy) || isBadNumber(oz)) {
      ox = 0; oy = 0; oz = 0;
      invalidOffsets++;
    }
    if (resolvedMode === 'float') {
      const g = groupOf[v];
      vecX[v] = groupSmoothNormal[g * 3] * ox;
      vecY[v] = groupSmoothNormal[g * 3 + 1] * ox;
      vecZ[v] = groupSmoothNormal[g * 3 + 2] * ox;
    } else {
      const n = vnorm(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
      let t, bt;
      if (hasTangents) {
        const tx = tangents[v * tangentStride], ty = tangents[v * tangentStride + 1], tz = tangents[v * tangentStride + 2];
        const dotNT = tx * n[0] + ty * n[1] + tz * n[2];
        t = vnorm(tx - n[0] * dotNT, ty - n[1] * dotNT, tz - n[2] * dotNT);
        if (bitangents) {
          bt = vnorm(bitangents[v * 3], bitangents[v * 3 + 1], bitangents[v * 3 + 2]);
        } else {
          const handedness = tangentStride === 4 ? (tangents[v * 4 + 3] < 0 ? -1 : 1) : 1;
          const c = vcross(n[0], n[1], n[2], t[0], t[1], t[2]);
          bt = [c[0] * handedness, c[1] * handedness, c[2] * handedness];
        }
      } else {
        const basis = orthonormalBasis(n[0], n[1], n[2]);
        t = basis.t; bt = basis.bt;
      }
      vecX[v] = t[0] * ox + bt[0] * oy + n[0] * oz;
      vecY[v] = t[1] * ox + bt[1] * oy + n[1] * oz;
      vecZ[v] = t[2] * ox + bt[2] * oy + n[2] * oz;
    }
  }

  // Weld averaging: average the masked members' vectors per group, then
  // give every member of the group (masked or not) that same average.
  const assignedX = new Float64Array(vertexCount);
  const assignedY = new Float64Array(vertexCount);
  const assignedZ = new Float64Array(vertexCount);
  for (let g = 0; g < groupCount; g++) {
    let sx = 0, sy = 0, sz = 0, count = 0;
    for (const v of groupMembers[g]) {
      if (vertexMask && !vertexMask[v]) continue;
      sx += vecX[v]; sy += vecY[v]; sz += vecZ[v];
      count++;
    }
    const ax = count > 0 ? sx / count : 0;
    const ay = count > 0 ? sy / count : 0;
    const az = count > 0 ? sz / count : 0;
    for (const v of groupMembers[g]) { assignedX[v] = ax; assignedY[v] = ay; assignedZ[v] = az; }
  }

  const outPositions = new Float32Array(positions.length);
  let maxOffset = 0;
  for (let v = 0; v < vertexCount; v++) {
    outPositions[v * 3] = positions[v * 3] + assignedX[v];
    outPositions[v * 3 + 1] = positions[v * 3 + 1] + assignedY[v];
    outPositions[v * 3 + 2] = positions[v * 3 + 2] + assignedZ[v];
    const len = vlen(assignedX[v], assignedY[v], assignedZ[v]);
    if (len > maxOffset) maxOffset = len;
  }

  // New normals: angle-weighted face normals from the displaced positions,
  // accumulated per (welded group, quantized input-normal sector), so
  // authored hard edges stay hard and UV seams stay smooth.
  const sectorKeyOf = (v) => {
    const qx = Math.round(normals[v * 3] / 1e-3);
    const qy = Math.round(normals[v * 3 + 1] / 1e-3);
    const qz = Math.round(normals[v * 3 + 2] / 1e-3);
    return groupOf[v] + '|' + qx + ',' + qy + ',' + qz;
  };
  const normalAccum = new Map();
  for (let t = 0; t < triangleCount; t++) {
    const ia = triVertex[t * 3], ib = triVertex[t * 3 + 1], ic = triVertex[t * 3 + 2];
    const pa = [outPositions[ia * 3], outPositions[ia * 3 + 1], outPositions[ia * 3 + 2]];
    const pb = [outPositions[ib * 3], outPositions[ib * 3 + 1], outPositions[ib * 3 + 2]];
    const pc = [outPositions[ic * 3], outPositions[ic * 3 + 1], outPositions[ic * 3 + 2]];
    const contrib = triangleAngleContributions(pa, pb, pc);
    for (const [v, w] of [[ia, contrib.A], [ib, contrib.B], [ic, contrib.C]]) {
      const key = sectorKeyOf(v);
      let acc = normalAccum.get(key);
      if (!acc) { acc = [0, 0, 0]; normalAccum.set(key, acc); }
      acc[0] += w[0]; acc[1] += w[1]; acc[2] += w[2];
    }
  }
  const outNormals = new Float32Array(normals.length);
  for (let v = 0; v < vertexCount; v++) {
    const acc = normalAccum.get(sectorKeyOf(v));
    let n = acc ? vnorm(acc[0], acc[1], acc[2]) : [0, 0, 0];
    if (n[0] === 0 && n[1] === 0 && n[2] === 0) {
      n = [normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]];
    }
    outNormals[v * 3] = n[0]; outNormals[v * 3 + 1] = n[1]; outNormals[v * 3 + 2] = n[2];
  }

  return {
    positions: outPositions,
    normals: outNormals,
    mode: resolvedMode,
    stats: {
      vertices: vertexCount,
      welded: groupCount,
      maxOffset,
      invalidOffsets,
      isotropic,
      tangentFallback,
    },
  };
}

  globalThis.MtlxMeshDisplacement = { computeDisplacedAttributes };
})();
