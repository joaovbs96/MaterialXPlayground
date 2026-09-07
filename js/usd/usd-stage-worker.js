/*
 * OpenUSD stage extraction worker.
 *
 * The native usd-wg-webview bindings own USD composition (references,
 * sublayers, payloads, variants and usdMtlx). This file only copies their
 * result out of Emscripten memory into ordinary transferable buffers.
 */

const RUNTIME_DIR = new URL("../../vendor/usd-webview-bindings/", import.meta.url);
let runtimePromise;
let activeStage;
const nativeWarnings = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  nativeWarnings.push(args.map(value => String(value)).join(" "));
  originalConsoleError(...args);
};

function runtime() {
  if (!runtimePromise) {
    // The published convenience wrapper is browser-global by design. Giving
    // it a window alias is sufficient in a dedicated module Worker and keeps
    // its filesystem/path handling identical to the supported browser build.
    globalThis.window ??= globalThis;
    runtimePromise = import("../../vendor/usd-webview-bindings/usdWebViewBindings.js")
      .then(() => globalThis.UsdWebViewBindings.createRuntime({
        locateFile: path => new URL(path, RUNTIME_DIR).href,
      }))
      .catch(error => {
        console.error(error);
        runtimePromise = null;
        throw new Error(
          'USD runtime is not installed: vendor/usd-webview-bindings/ is missing or unreachable. Run "npm run vendor" (or "npm run build") in the repository root, then reload.'
        );
      });
  }
  return runtimePromise;
}

function arrayCopy(value, Type = Float32Array) {
  if (value == null) return undefined;
  try {
    if (ArrayBuffer.isView(value)) return new Type(value);
    if (value instanceof ArrayBuffer) return new Type(value.slice(0));
    if (Array.isArray(value)) return Type.from(value);
    if (typeof value.size === "function" && typeof value.get === "function") {
      const result = new Type(value.size());
      for (let i = 0; i < result.length; i++) result[i] = Number(value.get(i));
      return result;
    }
    if (typeof value.length === "number") return Type.from(value);
    if (typeof value.byteLength === "number") {
      const result = new Type(value.byteLength / Type.BYTES_PER_ELEMENT);
      for (let i = 0; i < result.length; i++) result[i] = Number(value[i] ?? value[String(i)] ?? 0);
      return result;
    }
    return undefined;
  } catch (error) {
    throw new Error(`OpenUSD native array copy failed (${Type.name}): ${error?.message ?? error}`);
  }
}

function text(value) {
  return value == null ? undefined : String(value);
}

function normalizePath(path) {
  let value = String(path ?? "").replaceAll("\\", "/");
  value = value.replace(/^\/+/, "");
  const parts = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function copyTexture(texture, assets) {
  if (!texture) return undefined;
  const data = arrayCopy(texture.data, Uint8Array);
  const result = {
    path: normalizePath(texture.path),
    mimeType: text(texture.mimeType) ?? "application/octet-stream",
  };
  if (data) {
    result.data = data;
    const key = result.path;
    if (key && !assets.has(key)) assets.set(key, data);
  }
  return result;
}

function copyMaterial(material, assets) {
  if (!material) return undefined;
  const result = {};
  for (const key of [
    "path", "shaderId", "roughness", "metallic", "opacity", "clearcoat",
    "clearcoatRoughness", "ior",
  ]) {
    if (material[key] !== undefined) result[key] = material[key];
  }
  for (const key of ["diffuseColor", "emissiveColor"]) {
    const value = arrayCopy(material[key], Float32Array);
    if (value) result[key] = Array.from(value);
  }
  for (const key of [
    "diffuseTexture", "roughnessTexture", "metallicTexture", "normalTexture",
    "occlusionTexture", "emissiveTexture", "clearcoatTexture",
    "clearcoatRoughnessTexture", "opacityTexture",
  ]) {
    const texture = copyTexture(material[key], assets);
    if (texture) result[key] = texture;
  }
  if (material.materialX) {
    const mx = material.materialX;
    const resources = arrayItems(mx.resources)
      .map(resource => copyTexture(resource, assets)).filter(Boolean);
    const data = arrayCopy(mx.data, Uint8Array);
    const path = normalizePath(mx.path);
    result.materialX = {
      path,
      mimeType: text(mx.mimeType) ?? "application/xml",
      materialName: text(mx.materialName),
      ...(data ? { data } : {}),
      ...(resources.length ? { resources } : {}),
      ...(mx.report !== undefined ? { report: mx.report } : {}),
    };
    // The renderer needs the authored source asset and selected MaterialX
    // element, while materialX retains the native byte payload for a USDZ
    // entry that does not exist in the caller's original file map.
    result.sourceAsset = path;
    result.materialName = text(mx.materialName);
    const explicitSubIdentifier = text(mx.sourceAssetSubIdentifier ?? mx.subIdentifier);
    if (explicitSubIdentifier) {
      result.subIdentifier = explicitSubIdentifier;
    } else if (text(mx.materialName)) {
      // The current native payload has no field distinguishing an authored
      // sourceAsset subidentifier from the composed Material prim alias.
      // Preserve the name as a hint, never as authoritative XML selection.
      result.materialX.selectionIsInferred = true;
    }
    if (data && path && !assets.has(path)) assets.set(path, data);
  }
  return result;
}

function arrayItems(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.size === "function" && typeof value.get === "function") {
    const result = [];
    for (let i = 0; i < value.size(); i++) result.push(value.get(i));
    return result;
  }
  if (typeof value.length === "number") return Array.from(value);
  return [];
}

function copyInstanceMatrices(value) {
  if (value == null) return { matrices: [], invalid: false };
  // Native bindings normally expose a vector of 16-element arrays.  Accept
  // the flat 16*N form too; constructing Float64Array(value) from a nested
  // array would otherwise coerce each row to NaN.
  if (ArrayBuffer.isView(value) || (Array.isArray(value) && value.every(item => typeof item === "number"))) {
    const flat = arrayCopy(value, Float64Array) ?? [];
    const matrices = [];
    for (let i = 0; i + 15 < flat.length; i += 16) matrices.push(Array.from(flat.slice(i, i + 16)));
    return {
      matrices: matrices.filter(matrix => matrix.every(Number.isFinite)),
      invalid: flat.length % 16 !== 0 || matrices.some(matrix => !matrix.every(Number.isFinite)),
    };
  }
  const matrices = [];
  let invalid = false;
  const copyOne = item => {
    const matrix = arrayCopy(item, Float64Array);
    if (!matrix || matrix.length !== 16) { invalid = true; return; }
    const values = Array.from(matrix);
    if (values.every(Number.isFinite)) matrices.push(values);
    else invalid = true;
  };
  // Copy each Embind row before asking the vector for the next row.  The next
  // native allocation can grow the WASM heap and detach an earlier view.
  if (typeof value.size === "function" && typeof value.get === "function") {
    for (let i = 0; i < value.size(); i++) copyOne(value.get(i));
  } else {
    for (const item of arrayItems(value)) copyOne(item);
  }
  return { matrices, invalid };
}

function copySubset(subset) {
  return {
    start: Number(subset.start ?? 0),
    count: Number(subset.count ?? 0),
    ...(text(subset.materialPath) ? { materialPath: text(subset.materialPath) } : {}),
    ...(text(subset.path) ? { path: text(subset.path) } : {}),
    ...(text(subset.name) ? { name: text(subset.name) } : {}),
  };
}

function copyMesh(mesh, assets, materials) {
  const positions = arrayCopy(mesh.positions ?? mesh.points, Float32Array);
  if (!positions || !positions.length) return undefined;
  const normals = arrayCopy(mesh.normals, Float32Array);
  const uvs = arrayCopy(mesh.uvs, Float32Array);
  const indices = arrayCopy(mesh.indices, Uint32Array);
  const material = copyMaterial(mesh.material, assets);
  const materialPath = text(mesh.materialPath) ?? text(mesh.material?.path);
  if (materialPath && material) materials.set(materialPath, material);
  const groups = arrayItems(mesh.subsets ?? mesh.materialSubsets).map(copySubset);
  const matrix = arrayCopy(mesh.matrix, Float64Array);
  const hasInstanceMatrices = mesh.instanceMatrices != null;
  const instance = copyInstanceMatrices(mesh.instanceMatrices);
  return {
    primPath: text(mesh.path) ?? text(mesh.primPath) ?? "",
    name: text(mesh.name) ?? "",
    positions,
    ...(normals ? { normals } : {}),
    ...(uvs ? { uvs } : {}),
    ...(indices ? { indices } : {}),
    matrix: matrix ? Array.from(matrix) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    orientation: mesh.orientation === "leftHanded" ? "leftHanded" : "rightHanded",
    ...(materialPath ? { materialPath } : {}),
    ...(groups.length ? { groups } : {}),
    ...(hasInstanceMatrices ? {
      instanceMatrices: instance.matrices,
      ...(instance.invalid ? { instanceMatricesInvalid: true } : {}),
    } : {}),
    ...(text(mesh.instanceOwnerPath) ? { instanceOwnerPath: text(mesh.instanceOwnerPath) } : {}),
  };
}

// Make a raw-shape snapshot while the native draw object is still valid.  A
// normalized mesh is deliberately not used here: copyStageResult needs the
// native field names (path/subsets/material) to retain mesh-level provenance.
function snapshotDraw(draw) {
  const snapshotMesh = (mesh) => {
    if (!mesh) return undefined;
    const positions = arrayCopy(mesh.positions ?? mesh.points, Float32Array);
    if (!positions || !positions.length) return undefined;
    const normals = arrayCopy(mesh.normals, Float32Array);
    const uvs = arrayCopy(mesh.uvs, Float32Array);
    const indices = arrayCopy(mesh.indices, Uint32Array);
    const matrix = arrayCopy(mesh.matrix, Float64Array);
    const hasInstanceMatrices = mesh.instanceMatrices != null;
    const instance = copyInstanceMatrices(mesh.instanceMatrices);
    return {
      path: text(mesh.path) ?? text(mesh.primPath) ?? "",
      name: text(mesh.name) ?? "",
      positions,
      ...(normals ? { normals } : {}),
      ...(uvs ? { uvs } : {}),
      ...(indices ? { indices } : {}),
      matrix,
      materialPath: text(mesh.materialPath) ?? text(mesh.material?.path),
      material: copyMaterial(mesh.material, new Map()),
      subsets: arrayItems(mesh.subsets ?? mesh.materialSubsets).map(copySubset),
      ...(hasInstanceMatrices ? {
        instanceMatrices: instance.matrices,
        ...(instance.invalid ? { instanceMatricesInvalid: true } : {}),
      } : {}),
      ...(text(mesh.instanceOwnerPath) ? { instanceOwnerPath: text(mesh.instanceOwnerPath) } : {}),
    };
  };
  const meshes = [];
  const source = draw?.meshes;
  // Calling get(i) for every native mesh first can allocate the next native
  // result and grow WASM memory, detaching the previous mesh's view. Copy
  // each item before requesting the next one.
  if (source && typeof source.size === "function" && typeof source.get === "function") {
    for (let i = 0; i < source.size(); i++) {
      const snapshot = snapshotMesh(source.get(i));
      if (snapshot) meshes.push(snapshot);
    }
  } else {
    for (const mesh of arrayItems(source)) {
      const snapshot = snapshotMesh(mesh);
      if (snapshot) meshes.push(snapshot);
    }
  }
  return { meshes };
}

function snapshotPayloads(payloads) {
  const snapshots = [];
  const copy = (entry) => {
    if (!entry) return;
    snapshots.push({ path: text(entry.path), material: copyMaterial(entry.material, new Map()) });
  };
  if (payloads && typeof payloads.size === "function" && typeof payloads.get === "function") {
    for (let i = 0; i < payloads.size(); i++) copy(payloads.get(i));
  } else {
    for (const entry of arrayItems(payloads)) copy(entry);
  }
  return snapshots;
}

function sameNumberArray(left, right, epsilon = 1e-6) {
  if (!left || !right || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (Math.abs(Number(left[i]) - Number(right[i])) > epsilon) return false;
  }
  return true;
}

function sameFiniteStream(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (!Number.isFinite(Number(left[i])) || !Number.isFinite(Number(right[i]))) return false;
    if (Math.abs(Number(left[i]) - Number(right[i])) > 1e-6) return false;
  }
  return true;
}

function sameCornerIndices(generated, ordinary, vertexCount) {
  if (generated?.length && ordinary?.length) return sameNumberArray(generated, ordinary, 0);
  if (ordinary?.length) return false;
  if (!generated || generated.length !== vertexCount) return false;
  for (let index = 0; index < generated.length; index++) {
    if (Number(generated[index]) !== index) return false;
  }
  return true;
}

// The native draw ignores UsdGeomMesh orientation = "leftHanded": it emits
// clockwise winding and inward normals for such prims. getPrimAttributes
// exposes the authored token so the worker can correct the stream itself.
// Array-valued attributes from this API are truncated past 512 elements and
// must never be read as data; the orientation token is always safe.
function readOrientation(api, root, primPath) {
  return readMeshTokens(api, root, primPath).orientation;
}

// Reads orientation and subdivisionScheme together with a single
// getPrimAttributes call, since array-valued attributes from this API
// truncate past 512 elements but these two tokens are always safe.
function readMeshTokens(api, root, primPath) {
  const tokens = { orientation: "rightHanded", subdivisionScheme: undefined };
  if (typeof api.getPrimAttributes !== "function" || !primPath) return tokens;
  try {
    for (const record of arrayItems(api.getPrimAttributes(root, primPath))) {
      const name = text(record?.name);
      if (name === "orientation") tokens.orientation = text(record.value) === "leftHanded" ? "leftHanded" : "rightHanded";
      else if (name === "subdivisionScheme") tokens.subdivisionScheme = text(record.value);
    }
  } catch {
    // Tolerate any native failure and fall back to the USD default.
  }
  return tokens;
}

function swapCorners(array, triangleIndex, stride) {
  const base = triangleIndex * 3 * stride;
  for (let c = 0; c < stride; c++) {
    const a = base + stride + c;
    const b = base + 2 * stride + c;
    const tmp = array[a];
    array[a] = array[b];
    array[b] = tmp;
  }
}

// Corrects a leftHanded mesh so the renderer receives outward normals and
// counter-clockwise winding, matching what rightHanded prims already get.
// Never recomputes normals: the native smooth cage normals are correct up
// to sign, only the winding and the sign need fixing.
function applyOrientation(mesh) {
  if (!mesh || mesh.orientation !== "leftHanded") return mesh;
  const { positions, normals, uvs, indices } = mesh;
  if (indices && indices.length) {
    for (let k = 0; k + 2 < indices.length; k += 3) {
      const tmp = indices[k + 1];
      indices[k + 1] = indices[k + 2];
      indices[k + 2] = tmp;
    }
  } else if (positions && positions.length >= 9) {
    const triangleCount = Math.floor(positions.length / 9);
    for (let t = 0; t < triangleCount; t++) {
      swapCorners(positions, t, 3);
      if (normals && normals.length === positions.length) swapCorners(normals, t, 3);
      if (uvs && uvs.length === (positions.length / 3) * 2) swapCorners(uvs, t, 2);
    }
  }
  if (normals) {
    for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];
  }
  return mesh;
}

// Loop-subdivides a deindexed triangle mesh (positions/normals/uvs are flat
// per-corner streams, indices absent or a trivial identity sequence, exactly
// what the native draw produces). Welds corners by exact position so shared
// cage vertices merge into one manifold topology, runs `levels` Loop
// subdivision passes with face-varying UVs (interpolated per corner so UV
// seams stay sharp), recomputes area-weighted smooth normals from the welded
// topology, and re-expands to deindexed corners with a sequential index so
// the renderer path is unchanged. Returns null if the mesh cannot be welded
// into a usable triangle list (degenerate/point mesh).
function subdivideMesh(mesh, levels) {
  const positions = mesh.positions;
  if (!positions || positions.length < 9 || levels <= 0) return null;
  const indices = mesh.indices;
  const cornerCount = indices ? indices.length : positions.length / 3;
  if (cornerCount < 3 || cornerCount % 3 !== 0) return null;
  const hasUV = mesh.uvs && mesh.uvs.length === (positions.length / 3) * 2;

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

  let triangles = [];
  for (let c = 0; c + 2 < cornerCount; c += 3) {
    const a = cornerVertex(c), b = cornerVertex(c + 1), cc = cornerVertex(c + 2);
    const uv = hasUV ? [
      [mesh.uvs[c * 2], mesh.uvs[c * 2 + 1]],
      [mesh.uvs[(c + 1) * 2], mesh.uvs[(c + 1) * 2 + 1]],
      [mesh.uvs[(c + 2) * 2], mesh.uvs[(c + 2) * 2 + 1]],
    ] : null;
    triangles.push({ v: [a, b, cc], uv });
  }
  if (weldedPositions.length < 4 || !triangles.length) return null;

  const edgeKey = (x, y) => (x < y ? `${x}_${y}` : `${y}_${x}`);

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
      const boundaryNeighbors = neighbors.filter(nb => edgeTriangles.get(edgeKey(vi, nb)).length === 1);
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
      if (adj.length === 2) {
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
  const cornerN = triangles.length * 3;
  const outPositions = new Float32Array(cornerN * 3);
  const outNormals = new Float32Array(cornerN * 3);
  const outUVs = hasUV ? new Float32Array(cornerN * 2) : undefined;
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

function collectPrototypeTargets(value, result = []) {
  if (value == null) return result;
  if (typeof value === "string") {
    if (value.startsWith("/")) result.push(value);
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectPrototypeTargets(item, result));
    return result;
  }
  if (typeof value !== "object") return result;
  for (const [key, item] of Object.entries(value)) {
    if (/prototype/i.test(key)) collectPrototypeTargets(item, result);
    else if (key === "relationships" && Array.isArray(item)) {
      for (const relationship of item) {
        if (String(relationship?.name ?? "").toLowerCase() === "prototypes") {
          collectPrototypeTargets(relationship.targets, result);
        }
      }
    }
  }
  return result;
}

// PointInstancer extraction intentionally emits corner-expanded geometry but
// currently omits authored normals.  Recover them through an ordinary native
// draw of the composed prototype, never by welding unrelated scene vertices.
// The temporary layer remains in the native VFS until the next whole-stage
// close; this avoids wrapper.closeStage() unlinking the caller's input files.
async function recoverInstanceNormals(api, root, pointInstancerPaths, drawSnapshot, purposePolicy) {
  const generated = drawSnapshot.meshes.filter(mesh => mesh.instanceOwnerPath && !mesh.normals);
  if (!generated.length || !api.inspectPrimRelationships || !api.createDataFile || !api.openStage) return [];
  const probes = new Map();
  const warnings = [];
  for (const mesh of generated) {
    const marker = "/__instances__/";
    const markerIndex = mesh.path.indexOf(marker);
    if (markerIndex < 0) continue;
    const owner = mesh.instanceOwnerPath;
    const tail = mesh.path.slice(markerIndex + marker.length);
    const prototypeName = tail.split("/")[0];
    if (!prototypeName) continue;
    let targets = [];
    try { targets = collectPrototypeTargets(api.inspectPrimRelationships(root, owner)); } catch { targets = []; }
    targets = [...new Set(targets)];
    const matching = targets.filter(target => target.split("/").pop() === prototypeName);
    const target = matching.length === 1 ? matching[0] : null;
    if (!target) {
      warnings.push(`PointInstancer normal recovery skipped ambiguous prototype: ${owner}/${prototypeName}`);
      continue;
    }
    const relativeMeshPath = tail.slice(prototypeName.length).replace(/^\//, "");
    const key = `${target}\n${relativeMeshPath}`;
    if (!probes.has(key)) probes.set(key, { target, relativeMeshPath, meshes: [] });
    probes.get(key).meshes.push(mesh);
  }
  if (!probes.size) return warnings;
  const probeLines = ["#usda 1.0", "(", ")", ""];
  let probeIndex = 0;
  const probeRoots = [];
  const byTarget = new Map();
  for (const probe of probes.values()) {
    let rootProbe = byTarget.get(probe.target);
    if (!rootProbe) {
      rootProbe = { target: probe.target, meshes: [] };
      byTarget.set(probe.target, rootProbe);
      probeRoots.push(rootProbe);
    }
    rootProbe.meshes.push(...probe.meshes);
  }
  for (const probe of probeRoots) {
    const name = `Probe${probeIndex++}`;
    probe.probeName = name;
    probeLines.push(`def "${name}" ( references = @${root}@<${probe.target}> ) {}`);
  }
  const probePath = `__usd_instance_normals_${Date.now()}.usda`;
  try {
    api.createDataFile(probePath, new TextEncoder().encode(probeLines.join("\n")));
    const probeSummary = api.openStage(probePath, true);
    if (probeSummary?.error) {
      warnings.push(`PointInstancer normal recovery temporary prototype stage failed: ${probeSummary.error}`);
      return warnings;
    }
    if (!probeSummary || !api.createStageDriver(probePath)) {
      return warnings.concat("PointInstancer normal recovery temporary prototype stage could not be opened");
    }
    for (const probe of probes.values()) {
      const probeRoot = probeRoots.find(item => item.target === probe.target);
      const probeName = probeRoot?.probeName;
      // The orientation attribute lives on the composed prototype mesh prim
      // in the real stage, not on the temporary probe layer or the generated
      // __instances__ record, so it is read from the actual target path.
      const actualMeshPath = probe.relativeMeshPath ? `${probe.target}/${probe.relativeMeshPath}` : probe.target;
      const tokens = readMeshTokens(api, root, actualMeshPath);
      const orientation = tokens.orientation;
      for (const generatedMesh of probe.meshes) {
        const marker = "/__instances__/";
        const tail = generatedMesh.path.slice(generatedMesh.path.indexOf(marker) + marker.length);
        const prototypeName = tail.split("/")[0];
        const relativeMeshPath = tail.slice(prototypeName.length).replace(/^\//, "");
        const proxyMeshPath = relativeMeshPath ? `/${probeName}/${relativeMeshPath}` : `/${probeName}`;
        let subtree = api.stageDriverDrawSubtree?.(probePath, proxyMeshPath, purposePolicy);
        let ordinary;
        try {
          ordinary = snapshotDraw(subtree).meshes;
        } catch (error) {
          if (!/detached|out-of-bounds/i.test(String(error?.message ?? error))) throw error;
          subtree = api.stageDriverDrawSubtree?.(probePath, proxyMeshPath, purposePolicy);
          ordinary = snapshotDraw(subtree).meshes;
        }
        const candidate = ordinary.find(mesh => mesh.path === proxyMeshPath ||
          mesh.path.replace(/\/+$/, "") === proxyMeshPath);
        if (!candidate || !candidate.normals ||
            candidate.normals.length !== candidate.positions?.length ||
            !candidate.normals.every(Number.isFinite) ||
            !sameFiniteStream(generatedMesh.positions, candidate.positions) ||
            (!generatedMesh.uvs && !candidate.uvs ? false : !sameFiniteStream(generatedMesh.uvs, candidate.uvs)) ||
            !sameCornerIndices(generatedMesh.indices, candidate.indices, generatedMesh.positions.length / 3)) {
          warnings.push(`PointInstancer normal recovery stream mismatch: ${generatedMesh.path}`);
          continue;
        }
        generatedMesh.normals = candidate.normals;
        generatedMesh.orientation = orientation;
        generatedMesh.subdivisionScheme = tokens.subdivisionScheme;
      }
    }
  } catch (error) {
    warnings.push(`PointInstancer normal recovery failed: ${error?.message ?? error}`);
  } finally {
    if (api.deleteStageDriver) {
      try { api.deleteStageDriver(probePath); } catch {}
    }
  }
  return warnings;
}

function copyStageResult(summary, draw, payloads) {
  const assets = new Map();
  const materials = new Map();
  for (const entry of arrayItems(payloads)) {
    const material = copyMaterial(entry.material, assets);
    if (material) {
      // `entry.path` was a geometry/binding path in an older native build;
      // the material object's UsdShade path is the stable identity whenever
      // it is present.
      const path = text(entry.material?.path) ?? text(material.path) ?? text(entry.path);
      if (path) materials.set(path, material);
    }
  }
  const meshes = arrayItems(draw?.meshes)
    .map(mesh => copyMesh(mesh, assets, materials)).filter(Boolean);
  const materialList = Array.from(materials, ([path, material]) => ({ path, ...material }));
  const transfer = [];
  const transferred = new Set();
  const addTransfer = buffer => {
    if (buffer && !transferred.has(buffer)) {
      transferred.add(buffer);
      transfer.push(buffer);
    }
  };
  for (const mesh of meshes) {
    for (const key of ["positions", "normals", "uvs", "indices"]) if (mesh[key]) addTransfer(mesh[key].buffer);
  }
  for (const material of materialList) {
    for (const value of Object.values(material)) {
      if (value?.data?.buffer) addTransfer(value.data.buffer);
      if (value?.materialX?.data?.buffer) addTransfer(value.materialX.data.buffer);
      for (const resource of value?.resources ?? []) if (resource.data?.buffer) addTransfer(resource.data.buffer);
    }
  }
  const assetList = Array.from(assets, ([path, data]) => {
    addTransfer(data.buffer);
    return { path, data: data.buffer };
  });
  const warnings = Array.from(new Set(nativeWarnings));
  return {
    rootPath: summary?.rootFile ?? "",
    upAxis: summary?.upAxis,
    metersPerUnit: summary?.metersPerUnit,
    summary: summary ?? null,
    meshes,
    materials: materialList,
    assets: assetList,
    warnings: Array.from(new Set(warnings)),
    transfer,
  };
}

async function load(request) {
  const api = await runtime();
  const fileTotal = (request.files ?? []).filter(file => file?.path).length;
  postMessage({ id: request.id, type: "progress", value: { phase: "worker", done: 0, total: fileTotal, fraction: 0.05, message: "Preparing input files" } });
  let loadedFiles = 0;
  for (const file of request.files ?? []) {
    if (!file?.path) continue;
    const source = typeof file.data?.arrayBuffer === "function"
      ? await file.data.arrayBuffer()
      : file.data;
    const data = source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : arrayCopy(source, Uint8Array);
    if (!data) continue;
    api.createDataFile(normalizePath(file.path), data);
    loadedFiles++;
    postMessage({ id: request.id, type: "progress", value: {
      phase: "worker", done: loadedFiles, total: fileTotal,
      fraction: 0.05 + 0.2 * (loadedFiles / Math.max(1, fileTotal)),
      message: "Reading input files",
    } });
  }
  if (!loadedFiles) throw new Error("USD file buffers were empty or not transferable");
  const root = normalizePath(request.rootPath);
  if (!root) throw new Error("USD rootPath is required");
  if (activeStage) api.closeStage(activeStage);
  activeStage = root;
  postMessage({ id: request.id, type: "progress", value: { phase: "parse", done: 0, total: 0, fraction: 0.3, message: "Composing stage" } });
  const summary = api.openStage(root, true);
  if (summary?.error) throw new Error(summary.error);
  postMessage({ id: request.id, type: "progress", value: { phase: "parse", done: 1, total: 1, fraction: 0.4, message: "Composed stage" } });
  if (!api.createStageDriver(root)) throw new Error("OpenUSD stage driver could not be created");
  // A full draw can itself grow the native heap while it is constructing
  // multiple MeshUpdate objects. Earlier objects then retain detached views
  // by the time the native call returns. Enumerate mesh prims and draw each
  // subtree separately so every result is copied before the next draw call.
  // Keep the full-draw fallback for runtimes without scene-graph support.
  const purposePolicy = request.purposePolicy ?? "defaultRender";
  let drawSnapshot;
  const graph = api.getSceneGraph?.(root);
  const meshPaths = arrayItems(graph)
    .filter(entry => (text(entry?.typeName) ?? "").toLowerCase() === "mesh" && text(entry?.path))
    .map(entry => text(entry.path));
  const pointInstancerPaths = arrayItems(graph)
    .filter(entry => (text(entry?.typeName) ?? "").toLowerCase() === "pointinstancer" && text(entry?.path))
    .map(entry => text(entry.path));
  // PointInstancers are represented by generated __instances__ MeshUpdates;
  // their authored prototype Mesh paths are not drawable by themselves.
  const uniqueMeshPaths = Array.from(new Set([...meshPaths, ...pointInstancerPaths]));
  if (uniqueMeshPaths.length && api.stageDriverDrawSubtree) {
    drawSnapshot = { meshes: [] };
    const copiedMeshPaths = new Set();
    // PointInstancer paths only ever produce generated __instances__ meshes
    // (instanceOwnerPath set); their orientation is resolved later from the
    // prototype mesh prim inside recoverInstanceNormals. Ordinary mesh prims
    // get their own orientation token read here, once per drawn prim.
    const pushMesh = mesh => {
      if (!mesh.path || !copiedMeshPaths.has(mesh.path)) {
        if (!mesh.instanceOwnerPath) {
          const tokens = readMeshTokens(api, root, mesh.path || path);
          mesh.orientation = tokens.orientation;
          mesh.subdivisionScheme = tokens.subdivisionScheme;
        }
        drawSnapshot.meshes.push(mesh);
        if (mesh.path) copiedMeshPaths.add(mesh.path);
      }
    };
    for (let index = 0; index < uniqueMeshPaths.length; index++) {
      const path = uniqueMeshPaths[index];
      let subtree = api.stageDriverDrawSubtree(root, path, purposePolicy);
      try {
        for (const mesh of snapshotDraw(subtree).meshes) pushMesh(mesh);
      } catch (error) {
        // Some large stages can leave the first subtree's view on a stale
        // heap generation even though no later API call was made. Reissue
        // this same bounded subtree request once; the second native result
        // is independently copied and avoids recovering from a detached
        // view, which is impossible.
        if (!/detached|out-of-bounds/i.test(String(error?.message ?? error))) throw error;
        subtree = api.stageDriverDrawSubtree(root, path, purposePolicy);
        for (const mesh of snapshotDraw(subtree).meshes) pushMesh(mesh);
      }
      postMessage({ id: request.id, type: "progress", value: {
        phase: "geometry", done: index + 1, total: uniqueMeshPaths.length,
        fraction: 0.45 + 0.3 * ((index + 1) / uniqueMeshPaths.length),
        message: "Copied mesh data",
      } });
    }
  } else {
    const draw = api.stageDriverDraw(root, true, purposePolicy);
    // Snapshot before making the next native call; diagnostics and payload
    // extraction may also refresh the Emscripten heap.
    drawSnapshot = snapshotDraw(draw);
  }
  postMessage({ id: request.id, type: "progress", value: { phase: "material", done: 0, total: 0, fraction: 0.8, message: "Extracting material payloads" } });
  const payloads = api.extractMaterialPayloads(root);
  // Payload material/texture views have the same lifetime as draw views.  Do
  // the copy before diagnostics can touch the native heap, then pass only
  // ordinary JS data to the result assembly below.
  const payloadSnapshot = snapshotPayloads(payloads);
  const diagnostics = api.stageDriverGetDiagnostics?.(root);
  const normalRecoveryWarnings = await recoverInstanceNormals(
    api, root, pointInstancerPaths, drawSnapshot, purposePolicy
  );
  // Orientation correction runs last, after recovery has copied normals from
  // the (still unflipped) prototype draw into the generated instanced meshes
  // and stamped their orientation, so every snapshot mesh is flipped exactly
  // once here.
  for (const mesh of drawSnapshot.meshes) applyOrientation(mesh);
  {
    const levels = Math.max(0, Math.min(2, Number.isFinite(request.subdivisionLevel) ? request.subdivisionLevel : 1));
    if (levels > 0) {
      const MESH_TRIANGLE_LIMIT = 600000;
      const STAGE_TRIANGLE_LIMIT = 6000000;
      const factor = 4 ** levels;
      let stageTriangleTotal = 0;
      for (const mesh of drawSnapshot.meshes) {
        const cornerCount = mesh.indices ? mesh.indices.length : (mesh.positions ? mesh.positions.length / 3 : 0);
        stageTriangleTotal += Math.floor(cornerCount / 3);
      }
      let budgetWarned = false;
      for (const mesh of drawSnapshot.meshes) {
        const scheme = mesh.subdivisionScheme;
        if (scheme !== "catmullClark" && scheme !== "loop") continue;
        if (mesh.instanceOwnerPath && !mesh.normals) continue;
        const cornerCount = mesh.indices ? mesh.indices.length : (mesh.positions ? mesh.positions.length / 3 : 0);
        const originalTriangles = Math.floor(cornerCount / 3);
        if (!originalTriangles) continue;
        const projectedTriangles = originalTriangles * factor;
        if (projectedTriangles > MESH_TRIANGLE_LIMIT) {
          drawSnapshot.warnings ??= [];
          drawSnapshot.warnings.push(
            `Subdivision skipped (would exceed ${MESH_TRIANGLE_LIMIT} triangles): ${mesh.path || mesh.name || "mesh"}`
          );
          continue;
        }
        if (stageTriangleTotal - originalTriangles + projectedTriangles > STAGE_TRIANGLE_LIMIT) {
          if (!budgetWarned) {
            drawSnapshot.warnings ??= [];
            drawSnapshot.warnings.push(`Subdivision stopped: stage triangle budget (${STAGE_TRIANGLE_LIMIT}) reached`);
            budgetWarned = true;
          }
          continue;
        }
        const subdivided = subdivideMesh(mesh, levels);
        if (!subdivided) continue;
        stageTriangleTotal += subdivided.triangleCount - originalTriangles;
        mesh.positions = subdivided.positions;
        mesh.normals = subdivided.normals;
        if (subdivided.uvs) mesh.uvs = subdivided.uvs;
        delete mesh.indices;
        if (Array.isArray(mesh.subsets) && mesh.subsets.length) {
          mesh.subsets = mesh.subsets.map(subset => ({
            ...subset,
            start: subset.start * factor,
            count: subset.count * factor,
          }));
        }
      }
    }
  }
  // Weld every ordinary mesh (with or without subdivision) so the renderer
  // gets an indexed vertex buffer and computeTangents averages tangents
  // across shared faces instead of per lone corner.
  for (const mesh of drawSnapshot.meshes) {
    if (mesh.instanceOwnerPath && !mesh.normals) continue;
    weldMesh(mesh);
  }
  postMessage({ id: request.id, type: "progress", value: {
    phase: "material", done: 1, total: 1, fraction: 0.9, message: "Extracted material payloads",
  } });
  const result = copyStageResult(summary, drawSnapshot, payloadSnapshot);
  result.warnings.push(...normalRecoveryWarnings);
  if (drawSnapshot.warnings?.length) result.warnings.push(...drawSnapshot.warnings);
  const extractedOwners = new Set(result.meshes.map(mesh => mesh.instanceOwnerPath).filter(Boolean));
  for (const path of pointInstancerPaths) {
    if (!extractedOwners.has(path)) {
      result.warnings.push(`Unsupported PointInstancer extraction: ${path}`);
    }
  }
  if (diagnostics !== undefined) {
    try {
      result.diagnostics = JSON.parse(JSON.stringify(diagnostics));
    } catch {
      result.diagnostics = { unavailable: true };
    }
  }
  const transfer = result.transfer;
  delete result.transfer;
  try {
    postMessage({ id: request.id, type: "result", result }, transfer);
  } catch (error) {
    // Keep structured-clone failures actionable instead of leaving the main
    // thread's promise pending (for example, a future native report field).
    postMessage({
      id: request.id,
      type: "error",
      error: `OpenUSD result could not cross Worker boundary: ${error?.message ?? error}`,
    });
  }
}

self.onmessage = event => {
  const request = event.data;
  if (!request || request.type !== "load") return;
load(request).catch(error => {
    if (error instanceof Error) console.error(error.stack || error.message);
    postMessage({
      id: request.id,
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  });
};
