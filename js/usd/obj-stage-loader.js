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

  const buildMeshRecord = (name, positions, normals, uvs, colors, start, count, materialName) => {
    if (!count) return;
    const posSlice = Float32Array.from(positions.subarray(start * 3, (start + count) * 3));
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
      ...(normals ? { normals: Float32Array.from(normals.subarray(start * 3, (start + count) * 3)) } : {}),
      ...(uvs ? { uvs: Float32Array.from(uvs.subarray(start * 2, (start + count) * 2)) } : {}),
      ...(geomprops.length ? { geomprops } : {}),
      displayColor: null,
      indices,
      matrix: identityMatrix.slice(),
      orientation: "rightHanded",
      castsShadow: true,
      subdivisionScheme: "none",
      materialPath: materialPathForName(materialName),
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
