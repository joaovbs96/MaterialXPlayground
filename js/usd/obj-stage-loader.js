// Main-thread OBJ(+MTL) loader: turns a dropped file set into the same
// neutral stage payload js/usd/usd-stage-worker.js produces for USD, with
// materials converted to MaterialX documents by mtlx-material-docs.js.
// THREE r128 (OBJLoader) is the window global already loaded by
// index.html; this module never imports three itself.

import { objMtlDocument, parseMtl, sanitizeMtlxName } from "./mtlx-material-docs.js";

function checkAborted(signal) {
  if (signal && signal.aborted) {
    const err = new Error("Aborted");
    err.name = "AbortError";
    throw err;
  }
}

function normalizePath(path) {
  return String(path ?? "").replace(/\\/g, "/");
}

function dirOf(path) {
  const p = normalizePath(path);
  const idx = p.lastIndexOf("/");
  return idx === -1 ? "" : p.slice(0, idx);
}

function basenameOf(path) {
  return normalizePath(path).split("/").pop();
}

// Joins a base directory and a relative reference, resolving "." and "..".
function joinPath(dir, rel) {
  const parts = normalizePath(dir).split("/").concat(normalizePath(rel).split("/"));
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part);
  }
  return out.join("/");
}

async function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (data && typeof data.arrayBuffer === "function") return await data.arrayBuffer();
  throw new Error("Unsupported file data");
}

// Builds a basename index: lowercase basename -> every file path sharing it,
// so a unique-basename fallback can tell a single hit from an ambiguous one.
function indexByBasename(fileByPath) {
  const index = new Map();
  for (const path of fileByPath.keys()) {
    const base = basenameOf(path).toLowerCase();
    if (!index.has(base)) index.set(base, []);
    index.get(base).push(path);
  }
  return index;
}

// ---------------------------------------------------- pure, THREE-free parts

// Every `mtllib` line's file names, in the order declared. A line can list
// more than one library, space separated.
export function findMtllibNames(text) {
  const names = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !/^mtllib\s/i.test(line)) continue;
    const rest = line.slice(line.indexOf(" ") + 1).trim();
    for (const token of rest.split(/\s+/).filter(Boolean)) names.push(normalizePath(token));
  }
  return names;
}

// Resolves one mtllib reference: next to the .obj first, then anywhere in
// the drop by basename. Returns the matching file path, or null.
export function resolveMtllibPath(name, objDir, fileByPath, basenameIndex) {
  const direct = joinPath(objDir, name);
  if (fileByPath.has(direct)) return direct;
  const base = basenameOf(name).toLowerCase();
  const hits = basenameIndex.get(base);
  return hits && hits.length ? hits[0] : null;
}

// Resolves one MTL map record's texture: relative to the .mtl's directory,
// then the .obj's directory, then a unique basename across the whole drop.
// An ambiguous basename (two files share it) is treated as unresolved.
export function resolveMtlTexturePath(record, mtlDir, objDir, fileByPath, basenameIndex) {
  if (!record || !record.path) return null;
  const raw = normalizePath(record.path);
  const fromMtl = joinPath(mtlDir, raw);
  if (fileByPath.has(fromMtl)) return fromMtl;
  const fromObj = joinPath(objDir, raw);
  if (fileByPath.has(fromObj)) return fromObj;
  const base = basenameOf(raw).toLowerCase();
  const hits = basenameIndex.get(base);
  return hits && hits.length === 1 ? hits[0] : null;
}

// True if the OBJ text declares at least one `vn` line. Files with authored
// normals are used as-is; only normal-free files get smoothing computed.
export function objHasVertexNormals(text) {
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "vn" || line.startsWith("vn ") || line.startsWith("vn\t")) return true;
  }
  return false;
}

// Per-triangle smoothing-group id, in face-declaration order, matching the
// fan triangulation OBJLoader uses for each `f` line (n-2 triangles, all
// sharing that face's group). `s off`/`s 0` isolates each face into its own
// id so it never merges with any other face, matching "off = flat". When the
// file has no `s` lines at all every triangle gets group 0, so grouping is a
// no-op and only the crease angle governs smoothing.
export function parseObjSmoothingGroups(text) {
  let sawSmoothingLine = false;
  let off = false;
  let currentGroup = 0;
  let offCounter = -1;
  const groups = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line[0] === "#") continue;
    if (line === "s" || /^s\s/.test(line)) {
      sawSmoothingLine = true;
      const value = line.slice(1).trim();
      if (value === "" || value === "off" || value === "0") {
        off = true;
      } else {
        const n = parseInt(value, 10);
        off = false;
        currentGroup = Number.isFinite(n) ? n : 0;
      }
      continue;
    }
    if (line === "f" || /^f\s/.test(line)) {
      const verts = line.slice(1).trim().split(/\s+/).filter(Boolean);
      const triCount = Math.max(0, verts.length - 2);
      if (!triCount) continue;
      const faceGroup = !sawSmoothingLine ? 0 : off ? offCounter-- : currentGroup;
      for (let i = 0; i < triCount; i++) groups.push(faceGroup);
    }
  }
  return groups;
}

// Computes smooth per-corner normals for a non-indexed triangle soup with no
// authored normals. Vertices are welded by quantized position; a corner's
// normal is the area-weighted average (unnormalized cross products, so tiny
// sliver triangles contribute less than large ones) of every face sharing
// that position whose face normal is within `creaseAngleDeg` of this face's
// own normal, and whose smoothing-group id matches (when groupIds is given).
// Runs in O(n * average vertex valence), which is O(n) for typical meshes.
export function computeSmoothNormals(positions, options = {}) {
  const creaseAngleDeg = options.creaseAngleDeg != null ? options.creaseAngleDeg : 60;
  const groupIds = options.groupIds || null;
  const weldScale = options.weldScale || 1e4;
  const creaseCos = Math.cos((creaseAngleDeg * Math.PI) / 180);

  const vertexCount = positions.length / 3;
  const triCount = vertexCount / 3;
  const faceRaw = new Float64Array(triCount * 3); // area-weighted (unnormalized)
  const faceUnit = new Float64Array(triCount * 3);

  for (let t = 0; t < triCount; t++) {
    const i0 = t * 9, i1 = i0 + 3, i2 = i0 + 6;
    const ax = positions[i1] - positions[i0], ay = positions[i1 + 1] - positions[i0 + 1], az = positions[i1 + 2] - positions[i0 + 2];
    const bx = positions[i2] - positions[i0], by = positions[i2 + 1] - positions[i0 + 1], bz = positions[i2 + 2] - positions[i0 + 2];
    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;
    const fi = t * 3;
    faceRaw[fi] = nx; faceRaw[fi + 1] = ny; faceRaw[fi + 2] = nz;
    const len = Math.hypot(nx, ny, nz) || 1;
    faceUnit[fi] = nx / len; faceUnit[fi + 1] = ny / len; faceUnit[fi + 2] = nz / len;
  }

  // Numeric open-addressing weld: slot -> group id, chained via next[].
  const cap = 1 << Math.max(4, Math.ceil(Math.log2(vertexCount * 2 + 1)));
  const mask = cap - 1;
  const slotGroup = new Int32Array(cap).fill(-1);
  const groupRep = new Int32Array(vertexCount);
  const groupHead = new Int32Array(vertexCount);
  const next = new Int32Array(vertexCount);
  const vertGroup = new Int32Array(vertexCount);
  let groupCount = 0;
  for (let v = 0; v < vertexCount; v++) {
    const p = v * 3;
    const kx = Math.round(positions[p] * weldScale);
    const ky = Math.round(positions[p + 1] * weldScale);
    const kz = Math.round(positions[p + 2] * weldScale);
    let h = (Math.imul(kx | 0, 73856093) ^ Math.imul(ky | 0, 19349663) ^ Math.imul(kz | 0, 83492791)) & mask;
    let gid = -1;
    for (;;) {
      const g = slotGroup[h];
      if (g < 0) {
        gid = groupCount++;
        slotGroup[h] = gid;
        groupRep[gid] = v;
        groupHead[gid] = -1;
        break;
      }
      const r = groupRep[g] * 3;
      if (Math.round(positions[r] * weldScale) === kx && Math.round(positions[r + 1] * weldScale) === ky && Math.round(positions[r + 2] * weldScale) === kz) { gid = g; break; }
      h = (h + 1) & mask;
    }
    next[v] = groupHead[gid];
    groupHead[gid] = v;
    vertGroup[v] = gid;
  }

  const out = new Float32Array(positions.length);
  for (let v = 0; v < vertexCount; v++) {
    const t = (v / 3) | 0;
    const fi = t * 3;
    const ownGroup = groupIds ? groupIds[t] : 0;
    const nx0 = faceUnit[fi], ny0 = faceUnit[fi + 1], nz0 = faceUnit[fi + 2];
    let sx = 0, sy = 0, sz = 0;
    for (let w = groupHead[vertGroup[v]]; w !== -1; w = next[w]) {
      const tw = (w / 3) | 0;
      if (groupIds && groupIds[tw] !== ownGroup) continue;
      const fwi = tw * 3;
      const dot = nx0 * faceUnit[fwi] + ny0 * faceUnit[fwi + 1] + nz0 * faceUnit[fwi + 2];
      if (Math.min(1, Math.max(-1, dot)) < creaseCos) continue;
      sx += faceRaw[fwi]; sy += faceRaw[fwi + 1]; sz += faceRaw[fwi + 2];
    }
    let len = Math.hypot(sx, sy, sz);
    if (!len) { sx = nx0; sy = ny0; sz = nz0; len = 1; }
    const o = v * 3;
    out[o] = sx / len; out[o + 1] = sy / len; out[o + 2] = sz / len;
  }
  return out;
}

// ------------------------------------------------------------------- loader

export async function loadObjStage({ files, rootPath, signal, onProgress } = {}) {
  if (typeof THREE === "undefined" || typeof THREE.OBJLoader === "undefined") {
    throw new Error("OBJLoader unavailable in this build.");
  }
  const report = (phase, done, total, message) => {
    if (typeof onProgress === "function") {
      onProgress({ phase, done, total, fraction: total > 0 ? done / total : 0, message });
    }
  };

  const list = Array.isArray(files) ? files : [];
  const fileByPath = new Map();
  for (const entry of list) {
    if (!entry || !entry.path) continue;
    fileByPath.set(normalizePath(entry.path), entry);
  }
  const basenameIndex = indexByBasename(fileByPath);

  const root = normalizePath(rootPath);
  const rootFile = fileByPath.get(root);
  if (!rootFile) throw new Error("Root OBJ file not found: " + root);
  const objDir = dirOf(root);

  checkAborted(signal);
  report("parse", 0, 1, "Reading " + basenameOf(root));
  const rootBytes = await toArrayBuffer(rootFile.data);
  const text = new TextDecoder().decode(rootBytes);

  const warnings = [];
  const mtllibNames = findMtllibNames(text);
  const mtlMap = new Map();
  let mtlDir = objDir;
  if (!mtllibNames.length) {
    warnings.push("No .mtl file referenced by " + basenameOf(root) + "; a default grey material is used");
  }
  for (const name of mtllibNames) {
    checkAborted(signal);
    const resolved = resolveMtllibPath(name, objDir, fileByPath, basenameIndex);
    if (!resolved) { warnings.push("Referenced material library not found: " + name); continue; }
    const mtlEntry = fileByPath.get(resolved);
    const mtlBytes = await toArrayBuffer(mtlEntry.data);
    const mtlText = new TextDecoder().decode(mtlBytes);
    const parsed = parseMtl(mtlText);
    for (const [key, value] of parsed) mtlMap.set(key, value);
    mtlDir = dirOf(resolved);
  }

  checkAborted(signal);
  report("parse", 1, 1, "Parsing " + basenameOf(root));

  let container;
  try {
    container = new THREE.OBJLoader().parse(text);
  } catch (e) {
    throw new Error('Could not parse "' + root + '": ' + ((e && e.message) || e));
  }

  report("extract-geometry", 0, 1, "Extracting meshes");

  const usedMaterialNames = new Set();
  const usedPrimNames = new Set();
  const materialEntries = [];
  const materialPathCache = new Map(); // usemtl name ("" for none) -> materialPath
  let materialCounter = 0;
  let defaultMaterialPath = null;

  const textureRefs = (record) => resolveMtlTexturePath(record, mtlDir, objDir, fileByPath, basenameIndex);

  const materialPathForName = (rawName) => {
    const name = rawName || "";
    if (materialPathCache.has(name)) return materialPathCache.get(name);
    const record = name ? mtlMap.get(name) : null;
    if (name && !record) warnings.push("Referenced material not found in any .mtl: " + name);
    if (!record) {
      if (!defaultMaterialPath) {
        const doc = objMtlDocument({ name: "default", mtl: {}, textureRefs });
        for (const note of doc.notes) warnings.push(doc.materialName + ": " + note);
        const bytes = new TextEncoder().encode(doc.xml);
        const mtlxPath = "__obj_default.mtlx";
        defaultMaterialPath = "/Materials/__default";
        materialEntries.push({
          path: defaultMaterialPath,
          shaderId: "open_pbr_surface",
          materialX: { path: mtlxPath, mimeType: "application/xml", materialName: doc.materialName, data: bytes },
          sourceAsset: mtlxPath,
          materialName: doc.materialName,
        });
      }
      materialPathCache.set(name, defaultMaterialPath);
      return defaultMaterialPath;
    }
    const sanitizedBase = sanitizeMtlxName(name, usedMaterialNames);
    const doc = objMtlDocument({ name: sanitizedBase, mtl: record, textureRefs });
    for (const note of doc.notes) warnings.push(doc.materialName + ": " + note);
    const bytes = new TextEncoder().encode(doc.xml);
    const mtlxPath = "__obj_" + sanitizedBase + "_" + materialCounter + ".mtlx";
    const materialPath = "/Materials/" + sanitizedBase + "_" + materialCounter;
    materialEntries.push({
      path: materialPath,
      shaderId: "open_pbr_surface",
      materialX: { path: mtlxPath, mimeType: "application/xml", materialName: doc.materialName, data: bytes },
      sourceAsset: mtlxPath,
      materialName: doc.materialName,
    });
    materialCounter++;
    materialPathCache.set(name, materialPath);
    return materialPath;
  };

  const meshRecords = [];
  const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  const attrArray = (geometry, attrName) => {
    const attr = geometry.getAttribute && geometry.getAttribute(attrName);
    return attr ? attr.array : null;
  };

  // OBJLoader always supplies flat per-face normals when the file has no
  // `vn` lines; recompute smooth ones instead, honoring `s` groups when the
  // file declares them. smoothCursor tracks position in faceGroups because
  // meshes/material groups are extracted in the same order faces appear.
  const hasVN = objHasVertexNormals(text);
  const faceGroups = hasVN ? null : parseObjSmoothingGroups(text);
  let globalNormals = null;
  let globalCursor = 0; // vertex offset into globalNormals
  let normalsRecomputed = false;

  // Smooth normals are computed once over every mesh so vertices shared
  // across g/o groups and materials get identical normals (no seams).
  if (!hasVN) {
    const slices = [];
    let total = 0;
    container.traverse((object) => {
      if (!object.isMesh) return;
      const g = object.geometry;
      const pa = g && g.getAttribute && g.getAttribute("position");
      if (!pa || !pa.count) return;
      const gs = g.groups && g.groups.length ? g.groups : [{ start: 0, count: pa.count }];
      for (const gr of gs) {
        if (!gr.count) continue;
        slices.push([pa.array, gr.start, gr.count]);
        total += gr.count;
      }
    });
    const all = new Float32Array(total * 3);
    let o = 0;
    for (const [arr, start, count] of slices) {
      all.set(arr.subarray(start * 3, (start + count) * 3), o);
      o += count * 3;
    }
    const usable = faceGroups && faceGroups.length === total / 3;
    globalNormals = computeSmoothNormals(all, { creaseAngleDeg: 60, groupIds: usable ? faceGroups : null });
  }

  const buildMeshRecord = (name, positions, normals, uvs, colors, start, count, materialName) => {
    if (!count) return;
    const posSlice = Float32Array.from(positions.subarray(start * 3, (start + count) * 3));
    let normalSlice = normals ? Float32Array.from(normals.subarray(start * 3, (start + count) * 3)) : null;
    if (!hasVN) {
      normalSlice = globalNormals.slice(globalCursor * 3, (globalCursor + count) * 3);
      globalCursor += count;
      normalsRecomputed = true;
    }
    const geomprops = [];
    if (colors) {
      geomprops.push({
        name: "color", itemSize: 3, interpolation: "vertex",
        data: Float32Array.from(colors.subarray(start * 3, (start + count) * 3)),
      });
    }
    const indices = Uint32Array.from({ length: count }, (_, i) => i);
    const primName = sanitizeMtlxName(name || "mesh", usedPrimNames);
    meshRecords.push({
      primPath: "/" + primName,
      name: name || "",
      positions: posSlice,
      ...(normalSlice ? { normals: normalSlice } : {}),
      ...(uvs ? { uvs: Float32Array.from(uvs.subarray(start * 2, (start + count) * 2)) } : {}),
      ...(geomprops.length ? { geomprops } : {}),
      displayColor: null,
      indices,
      matrix: identityMatrix.slice(),
      orientation: "rightHanded",
      castsShadow: true,
      subdivisionScheme: "none",
      materialPath: materialPathForName(materialName),
      doubleSided: true, // OBJ has no sidedness; exported as double sided
      groups: [],
    });
  };

  container.traverse((object) => {
    if (object.isPoints || object.isLine || object.isLineSegments) {
      warnings.push("Skipped a non-triangle primitive: " + (object.name || "(unnamed)"));
      return;
    }
    if (!object.isMesh) return;
    const geometry = object.geometry;
    const posAttr = geometry && geometry.getAttribute && geometry.getAttribute("position");
    if (!posAttr || !posAttr.count) {
      warnings.push("Skipped a mesh with no position data: " + (object.name || "(unnamed)"));
      return;
    }
    const vertexCount = posAttr.count;
    const positions = posAttr.array;
    const normals = attrArray(geometry, "normal");
    const uvs = attrArray(geometry, "uv");
    const colors = attrArray(geometry, "color");
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const groups = geometry.groups && geometry.groups.length
      ? geometry.groups
      : [{ start: 0, count: vertexCount, materialIndex: 0 }];

    if (groups.length === 1) {
      const mat = materials[groups[0].materialIndex] || materials[0];
      buildMeshRecord(object.name, positions, normals, uvs, colors, groups[0].start, groups[0].count, mat && mat.name);
    } else {
      groups.forEach((group, gi) => {
        const mat = materials[group.materialIndex] || materials[0];
        const label = (object.name || "mesh") + "_" + gi;
        buildMeshRecord(label, positions, normals, uvs, colors, group.start, group.count, mat && mat.name);
      });
    }
  });

  if (!meshRecords.length) throw new Error("No renderable meshes in " + root);
  if (normalsRecomputed) {
    warnings.push("[info] OBJ has no normals; smooth normals were computed (60 degree crease)");
  }

  report("extract-geometry", 1, 1, "Extracted meshes");
  report("extract-materials", 1, 1, "Extracted materials");
  report("prepare-geometry", 1, 1, "Prepared geometry");

  const assets = materialEntries.map((material) => ({
    path: material.materialX.path,
    data: material.materialX.data.buffer,
  }));

  return {
    rootPath: root,
    upAxis: "Y",
    metersPerUnit: 1,
    summary: {
      rootFile: root,
      sourceKind: "obj",
      upAxis: "Y",
      metersPerUnit: 1,
      meshCount: meshRecords.length,
      materialCount: materialEntries.length,
    },
    meshes: meshRecords,
    materials: materialEntries,
    assets,
    cameras: [],
    lights: [],
    warnings,
    transfer: [],
  };
}
