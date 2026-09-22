// Main-thread glTF/GLB loader: turns a dropped file set into the same
// neutral stage payload js/usd/usd-stage-worker.js produces for USD, with
// materials converted to MaterialX documents by mtlx-material-docs.js.
// THREE r128 (GLTFLoader, DRACOLoader) is the window global already loaded
// by index.html; this module never imports three itself.

import { gltfPbrDocument, sanitizeMtlxName } from "./mtlx-material-docs.js";

const DRACO_TIMEOUT_MS = 20000;

const IMAGE_EXT_BY_MIME = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/ktx2": "ktx2",
};

// glTF extensions this loader (or mtlx-material-docs.js) already understands,
// so only genuinely unhandled extensions produce a warning.
const KNOWN_TOP_EXTENSIONS = new Set([
  "KHR_draco_mesh_compression", "KHR_texture_transform", "KHR_texture_basisu",
  "KHR_mesh_quantization", "KHR_materials_clearcoat", "KHR_materials_transmission",
  "KHR_materials_volume", "KHR_materials_ior", "KHR_materials_sheen",
  "KHR_materials_specular", "KHR_materials_iridescence", "KHR_materials_anisotropy",
  "KHR_materials_dispersion", "KHR_materials_emissive_strength",
]);

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

function extOf(path) {
  const p = normalizePath(path);
  const dot = p.lastIndexOf(".");
  return dot === -1 ? "" : p.slice(dot + 1).toLowerCase();
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

function toBlob(data, type) {
  if (typeof Blob !== "undefined" && data instanceof Blob) return data;
  return type ? new Blob([data], { type }) : new Blob([data]);
}

export function decodeDataUri(uri) {
  const match = /^data:([^;,]*)(;[^,]*)?,([\s\S]*)$/.exec(uri);
  if (!match) return null;
  const isBase64 = /;base64/i.test(match[2] || "");
  if (isBase64) {
    const binary = atob(match[3]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  return new TextEncoder().encode(decodeURIComponent(match[3]));
}

// Strips every texture reference from a parsed glTF JSON in place, so
// GLTFLoader never requests an image. Mirrors js/mtlx-engine.js's
// stripGltfTextures (custom preview geometry loading path).
function stripGltfTextures(json) {
  delete json.images;
  delete json.textures;
  delete json.samplers;
  (json.materials || []).forEach((mat) => {
    delete mat.normalTexture;
    delete mat.occlusionTexture;
    delete mat.emissiveTexture;
    if (mat.pbrMetallicRoughness) {
      delete mat.pbrMetallicRoughness.baseColorTexture;
      delete mat.pbrMetallicRoughness.metallicRoughnessTexture;
    }
    Object.keys(mat.extensions || {}).forEach((key) => {
      const ext = mat.extensions[key];
      if (!ext || typeof ext !== "object") return;
      Object.keys(ext).forEach((k) => { if (/Texture$/.test(k)) delete ext[k]; });
    });
  });
  ["extensionsUsed", "extensionsRequired"].forEach((key) => {
    if (Array.isArray(json[key])) json[key] = json[key].filter((n) => !/texture/i.test(n));
  });
}

// Reads a .glb container's two chunks. Returns null on any parse anomaly.
function readGlbChunks(arrayBuffer) {
  try {
    if (!arrayBuffer || arrayBuffer.byteLength < 12) return null;
    const header = new DataView(arrayBuffer, 0, 12);
    const magic = String.fromCharCode.apply(null, new Uint8Array(arrayBuffer, 0, 4));
    if (magic !== "glTF") return null;
    const version = header.getUint32(4, true);
    const totalLength = header.getUint32(8, true);
    if (version < 2 || totalLength > arrayBuffer.byteLength) return null;
    let jsonBytes = null;
    let binBytes = null;
    let offset = 12;
    while (offset + 8 <= totalLength) {
      const chunkHeader = new DataView(arrayBuffer, offset, 8);
      const chunkLength = chunkHeader.getUint32(0, true);
      const chunkType = chunkHeader.getUint32(4, true);
      const dataStart = offset + 8;
      if (dataStart + chunkLength > totalLength) return null;
      if (chunkType === 0x4e4f534a) jsonBytes = new Uint8Array(arrayBuffer, dataStart, chunkLength); // 'JSON'
      else if (chunkType === 0x004e4942) binBytes = arrayBuffer.slice(dataStart, dataStart + chunkLength); // 'BIN\0'
      offset = dataStart + chunkLength;
    }
    if (!jsonBytes) return null;
    return { json: JSON.parse(new TextDecoder().decode(jsonBytes)), binBytes };
  } catch (e) {
    return null;
  }
}

// Rebuilds a binary GLB container from a (texture-stripped) JSON object and
// the original BIN chunk, so GLTFLoader still takes its binary-chunk path.
function buildGlb(json, binBytes) {
  let jsonText = JSON.stringify(json);
  while (jsonText.length % 4 !== 0) jsonText += " ";
  const jsonBytes = new TextEncoder().encode(jsonText);
  const jsonChunkLen = 8 + jsonBytes.length;
  const binChunkLen = binBytes ? 8 + binBytes.byteLength : 0;
  const totalLength = 12 + jsonChunkLen + binChunkLen;
  const out = new ArrayBuffer(totalLength);
  const outView = new DataView(out);
  const outBytes = new Uint8Array(out);
  outBytes.set([0x67, 0x6c, 0x54, 0x46], 0); // 'glTF'
  outView.setUint32(4, 2, true);
  outView.setUint32(8, totalLength, true);
  outView.setUint32(12, jsonBytes.length, true);
  outView.setUint32(16, 0x4e4f534a, true); // 'JSON'
  outBytes.set(jsonBytes, 20);
  if (binBytes) {
    const binOffset = 12 + jsonChunkLen;
    outView.setUint32(binOffset, binBytes.byteLength, true);
    outView.setUint32(binOffset + 4, 0x004e4942, true); // 'BIN\0'
    outBytes.set(new Uint8Array(binBytes), binOffset + 8);
  }
  return out;
}

function bufferHasExternalUri(bufferDef) {
  return !!bufferDef && typeof bufferDef.uri === "string" && !/^data:/i.test(bufferDef.uri);
}

// Resolves every glTF buffer to raw bytes up front: the embedded GLB BIN
// chunk for buffer 0, data: URIs decoded in place, external files read from
// the drop. A bufferView-embedded image can reference any buffer index, not
// just 0, so this runs before any texture is resolved rather than lazily.
// Throws when an external .bin the document needs was not dropped, since a
// local file set can never fetch it over the network.
export async function resolveGltfBuffers(bufferDefs, { rootDir, binBytes, fileByPath, fileByBasename }) {
  const buffers = [];
  for (let i = 0; i < (bufferDefs || []).length; i++) {
    const bufferDef = bufferDefs[i];
    let bytes = null;
    if (bufferHasExternalUri(bufferDef)) {
      let uri = bufferDef.uri;
      try { uri = decodeURIComponent(uri); } catch (e) { /* not percent-encoded */ }
      const resolved = joinPath(rootDir, uri);
      const entry = fileByPath.get(resolved) || fileByBasename.get(basenameOf(uri).toLowerCase());
      if (!entry) throw new Error("Select the .gltf together with its .bin file(s)");
      bytes = new Uint8Array(await toArrayBuffer(entry.data));
    } else if (bufferDef && typeof bufferDef.uri === "string") {
      bytes = decodeDataUri(bufferDef.uri);
    } else if (i === 0 && binBytes) {
      bytes = new Uint8Array(binBytes);
    }
    buffers.push(bytes);
  }
  return buffers;
}

export async function loadGltfStage({ files, rootPath, signal, onProgress } = {}) {
  if (typeof THREE === "undefined" || typeof THREE.GLTFLoader === "undefined") {
    throw new Error("GLTFLoader unavailable in this build.");
  }
  const report = (phase, done, total, message) => {
    if (typeof onProgress === "function") {
      onProgress({ phase, done, total, fraction: total > 0 ? done / total : 0, message });
    }
  };

  const list = Array.isArray(files) ? files : [];
  const fileByPath = new Map();
  const fileByBasename = new Map();
  for (const entry of list) {
    if (!entry || !entry.path) continue;
    const path = normalizePath(entry.path);
    fileByPath.set(path, entry);
    const base = basenameOf(path).toLowerCase();
    if (!fileByBasename.has(base)) fileByBasename.set(base, entry);
  }

  const root = normalizePath(rootPath);
  const rootFile = fileByPath.get(root);
  if (!rootFile) throw new Error("Root glTF/GLB file not found: " + root);
  const rootDir = dirOf(root);
  const ext = extOf(root);
  if (ext !== "gltf" && ext !== "glb") throw new Error("Unsupported root file extension: " + ext);

  checkAborted(signal);
  report("parse", 0, 1, "Reading " + basenameOf(root));
  const rootBytes = await toArrayBuffer(rootFile.data);

  let rawJson;
  let binBytes = null;
  if (ext === "gltf") {
    let text;
    try { text = new TextDecoder().decode(rootBytes); } catch (e) { throw new Error('Could not parse "' + root + '": ' + e.message); }
    try { rawJson = JSON.parse(text); } catch (e) { throw new Error('Could not parse "' + root + '": ' + e.message); }
  } else {
    const parsed = readGlbChunks(rootBytes);
    if (!parsed) throw new Error('Could not parse "' + root + '": invalid GLB container');
    rawJson = parsed.json;
    binBytes = parsed.binBytes;
  }
  const strippedJson = JSON.parse(JSON.stringify(rawJson));
  stripGltfTextures(strippedJson);

  const warnings = [];

  // Resolved once, up front: a local file set never resolves a missing
  // external .bin over the network, so a missing buffer fails fast here
  // with a targeted message instead of GLTFLoader hanging or producing an
  // empty mesh. The bytes are also what lets a bufferView-embedded image
  // (any buffer index, not just 0) be sliced synchronously later on.
  const buffers = await resolveGltfBuffers(rawJson.buffers, { rootDir, binBytes, fileByPath, fileByBasename });

  for (const name of rawJson.extensionsUsed || []) {
    if (!KNOWN_TOP_EXTENSIONS.has(name)) warnings.push("Unsupported glTF extension: " + name + " (ignored)");
  }
  for (const name of rawJson.extensionsRequired || []) {
    if (!KNOWN_TOP_EXTENSIONS.has(name)) warnings.push("[error] Unsupported glTF extension: " + name + " (ignored)");
  }
  if (Array.isArray(rawJson.materials) && rawJson.materials.some((m) => m && m.doubleSided === false)) {
    warnings.push("[info] Some materials are single-sided (doubleSided: false); backface culling is not applied by this importer");
  }

  checkAborted(signal);

  // Object URLs for every dropped file, so the LoadingManager can redirect
  // external .bin requests without a network fetch. Keyed by basename, the
  // same trick js/mtlx-engine.js's parseModelRoot uses for custom-geometry
  // sidecars (:5588-5596).
  const objectUrls = [];
  const urlByBasename = new Map();
  for (const [path, entry] of fileByPath) {
    const url = URL.createObjectURL(toBlob(entry.data));
    objectUrls.push(url);
    const base = basenameOf(path).toLowerCase();
    if (!urlByBasename.has(base)) urlByBasename.set(base, url);
  }
  const releaseUrls = () => { for (const url of objectUrls) URL.revokeObjectURL(url); };

  let dracoLoader = null;
  try {
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((url) => {
      let decoded = url;
      try { decoded = decodeURIComponent(url); } catch (e) { /* not percent-encoded */ }
      const base = basenameOf(decoded).toLowerCase();
      return urlByBasename.has(base) ? urlByBasename.get(base) : url;
    });

    const gltfLoader = new THREE.GLTFLoader(manager);
    // Textures are already stripped; a KTX2/Basis reference that slips
    // through anyway gets a blank texture instead of a thrown error.
    gltfLoader.setKTX2Loader({ load: (u, onLoad) => onLoad(new THREE.Texture()) });

    const declaresDraco = Array.isArray(rawJson.extensionsUsed) && rawJson.extensionsUsed.indexOf("KHR_draco_mesh_compression") !== -1;
    if (declaresDraco && typeof THREE.DRACOLoader !== "undefined") {
      dracoLoader = new THREE.DRACOLoader().setDecoderPath(new URL("vendor/three/draco/", document.baseURI).href);
      try {
        await dracoLoader.preload();
      } catch (e) {
        throw new Error('"' + root + '" uses Draco mesh compression, but the decoder is unavailable (script blocked/offline): ' + ((e && e.message) || e));
      }
      gltfLoader.setDRACOLoader(dracoLoader);
    }

    checkAborted(signal);
    report("parse", 1, 1, "Parsing " + basenameOf(root));

    const resourcePath = rootDir ? rootDir + "/" : "";
    const payload = ext === "gltf" ? JSON.stringify(strippedJson) : buildGlb(strippedJson, binBytes);

    let gltf;
    try {
      const parsePromise = new Promise((resolve, reject) => {
        try { gltfLoader.parse(payload, resourcePath, resolve, reject); } catch (e) { reject(e); }
      });
      gltf = declaresDraco
        ? await Promise.race([parsePromise, new Promise((_, reject) => {
            setTimeout(() => reject(new Error('"' + root + '" timed out decoding (possibly a corrupt Draco payload).')), DRACO_TIMEOUT_MS);
          })])
        : await parsePromise;
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (/timed out decoding/.test(msg)) throw e;
      if (/DRACOLoader/i.test(msg)) throw new Error('"' + root + '" uses Draco mesh compression, but the decoder is unavailable (script blocked/offline).');
      if (/KTX2|basisu/i.test(msg)) throw new Error('"' + root + '" uses KTX2/Basis texture compression, which is not supported here: re-export without KTX2/Basis textures.');
      throw new Error('Could not load "' + root + '": ' + msg);
    }

    checkAborted(signal);
    report("extract-geometry", 0, 1, "Extracting meshes");

    const sceneRoot = gltf.scene || (gltf.scenes && gltf.scenes[0]);
    const parser = gltf.parser;
    if (!sceneRoot || !parser) throw new Error("No renderable meshes in " + root);
    sceneRoot.updateMatrixWorld(true);

    const stem = basenameOf(root).replace(/\.[^.]+$/, "");
    const embeddedAssets = new Map(); // asset path -> Uint8Array
    const mtlxAssets = new Map(); // asset path -> Uint8Array

    const resolveBufferBytes = (bufferIndex) => buffers[bufferIndex] || null;

    const embeddedImageBytes = (image) => {
      if (typeof image.uri === "string" && /^data:/i.test(image.uri)) return decodeDataUri(image.uri);
      if (!Number.isInteger(image.bufferView)) return null;
      const bufferView = Array.isArray(rawJson.bufferViews) ? rawJson.bufferViews[image.bufferView] : null;
      if (!bufferView) return null;
      const bytes = resolveBufferBytes(bufferView.buffer);
      if (!bytes) return null;
      const offset = bufferView.byteOffset || 0;
      const length = bufferView.byteLength || (bytes.length - offset);
      return bytes.slice(offset, offset + length);
    };

    const resolveGltfTextureRef = (textureInfo) => {
      if (!textureInfo || !Array.isArray(rawJson.textures)) return null;
      const texture = rawJson.textures[textureInfo.index];
      if (!texture) return null;
      let sourceIndex = texture.source;
      const basisu = texture.extensions && texture.extensions.KHR_texture_basisu;
      if (basisu && Number.isInteger(basisu.source)) sourceIndex = basisu.source;
      const image = Array.isArray(rawJson.images) ? rawJson.images[sourceIndex] : null;
      if (!image) return null;

      let file = null;
      if (typeof image.uri === "string" && !/^data:/i.test(image.uri)) {
        let uri = image.uri;
        try { uri = decodeURIComponent(uri); } catch (e) { /* not percent-encoded */ }
        const resolved = joinPath(rootDir, uri);
        if (fileByPath.has(resolved)) file = resolved;
      } else {
        const bytes = embeddedImageBytes(image);
        if (bytes) {
          const fileExt = IMAGE_EXT_BY_MIME[image.mimeType] || "bin";
          const path = (rootDir ? rootDir + "/" : "") + "__gltf_" + stem + "/images/" + sourceIndex + "." + fileExt;
          if (!embeddedAssets.has(path)) embeddedAssets.set(path, bytes);
          file = path;
        }
      }
      if (!file) return null;

      const ref = { file };
      const sampler = Number.isInteger(texture.sampler) && Array.isArray(rawJson.samplers) ? rawJson.samplers[texture.sampler] : null;
      if (sampler) {
        if (sampler.wrapS !== undefined) ref.wrapS = sampler.wrapS;
        if (sampler.wrapT !== undefined) ref.wrapT = sampler.wrapT;
        if (sampler.magFilter !== undefined) ref.magFilter = sampler.magFilter;
      }
      if (Number.isFinite(textureInfo.texCoord)) ref.texCoord = textureInfo.texCoord;
      if (textureInfo.extensions && textureInfo.extensions.KHR_texture_transform) ref.transform = textureInfo.extensions.KHR_texture_transform;
      return ref;
    };

    const usedMaterialNames = new Set();
    const usedPrimNames = new Set();
    const materialEntries = [];
    const materialPathCache = new Map(); // "index:vc" -> materialPath
    let materialCounter = 0;

    const materialPathFor = (materialIndex, hasVertexColor) => {
      const key = materialIndex + ":" + (hasVertexColor ? 1 : 0);
      if (materialPathCache.has(key)) return materialPathCache.get(key);
      const gltfMat = materialIndex >= 0 && Array.isArray(rawJson.materials) ? rawJson.materials[materialIndex] : null;
      if (materialIndex < 0) warnings.push("A mesh has no material binding, the default glTF material is used");
      let baseName = (gltfMat && gltfMat.name) || (materialIndex >= 0 ? ("material_" + materialIndex) : "default");
      if (hasVertexColor && materialPathCache.has(materialIndex + ":0")) baseName += "_vc";
      const sanitizedBase = sanitizeMtlxName(baseName, usedMaterialNames);
      const doc = gltfPbrDocument({
        name: sanitizedBase,
        material: gltfMat || {},
        textureRefs: resolveGltfTextureRef,
        hints: { hasVertexColor },
      });
      for (const note of doc.notes) warnings.push(doc.materialName + ": " + note);
      const bytes = new TextEncoder().encode(doc.xml);
      const mtlxPath = "__gltf_" + stem + "_" + materialCounter + ".mtlx";
      mtlxAssets.set(mtlxPath, bytes);
      const materialPath = "/Materials/" + sanitizedBase + "_" + materialCounter;
      materialEntries.push({
        path: materialPath,
        shaderId: "gltf_pbr",
        materialX: { path: mtlxPath, mimeType: "application/xml", materialName: doc.materialName, data: bytes },
        sourceAsset: mtlxPath,
        materialName: doc.materialName,
      });
      materialCounter++;
      materialPathCache.set(key, materialPath);
      return materialPath;
    };

    const meshRecords = [];
    sceneRoot.traverse((object) => {
      if (object.isPoints || object.isLine || object.isLineSegments) {
        warnings.push("Skipped a non-triangle primitive (points/lines): " + (object.name || "(unnamed)"));
        return;
      }
      if (!object.isMesh) return;
      const geometry = object.geometry;
      const posAttr = geometry && geometry.attributes && geometry.attributes.position;
      if (!posAttr || !posAttr.count) {
        warnings.push("Skipped a mesh with no position data: " + (object.name || "(unnamed)"));
        return;
      }
      const vertexCount = posAttr.count;
      const positions = Float32Array.from(posAttr.array);
      const normals = geometry.attributes.normal ? Float32Array.from(geometry.attributes.normal.array) : undefined;
      const uvs = geometry.attributes.uv ? Float32Array.from(geometry.attributes.uv.array) : undefined;

      const geomprops = [];
      if (geometry.attributes.uv2) {
        geomprops.push({ name: "UV1", itemSize: 2, interpolation: "vertex", data: Float32Array.from(geometry.attributes.uv2.array) });
      }
      let hasVertexColor = false;
      if (geometry.attributes.color) {
        hasVertexColor = true;
        const colorAttr = geometry.attributes.color;
        const itemSize = colorAttr.itemSize;
        let colorData;
        if (itemSize === 3) {
          colorData = Float32Array.from(colorAttr.array);
        } else {
          colorData = new Float32Array(vertexCount * 3);
          for (let i = 0; i < vertexCount; i++) {
            colorData[i * 3] = colorAttr.array[i * itemSize];
            colorData[i * 3 + 1] = colorAttr.array[i * itemSize + 1];
            colorData[i * 3 + 2] = colorAttr.array[i * itemSize + 2];
          }
        }
        geomprops.push({ name: "color", itemSize: 3, interpolation: "vertex", data: colorData });
      }

      const indices = geometry.index
        ? Uint32Array.from(geometry.index.array)
        : Uint32Array.from({ length: vertexCount }, (_, i) => i);

      const assoc = parser.associations.get(object.material);
      let materialIndex = assoc && assoc.type === "materials" && Number.isInteger(assoc.index) ? assoc.index : -1;
      if (materialIndex < 0 && object.material && object.material.name && Array.isArray(rawJson.materials)) {
        const idx = rawJson.materials.findIndex((m) => m && m.name === object.material.name);
        if (idx >= 0) materialIndex = idx;
      }
      const materialPath = materialPathFor(materialIndex, hasVertexColor);

      const primName = sanitizeMtlxName(object.name || "mesh", usedPrimNames);
      meshRecords.push({
        primPath: "/" + primName,
        name: object.name || "",
        positions,
        ...(normals ? { normals } : {}),
        ...(uvs ? { uvs } : {}),
        ...(geomprops.length ? { geomprops } : {}),
        displayColor: null,
        indices,
        matrix: Array.from(object.matrixWorld.elements),
        orientation: "rightHanded",
        castsShadow: true,
        subdivisionScheme: "none",
        materialPath,
        groups: [],
      });
    });

    if (!meshRecords.length) throw new Error("No renderable meshes in " + root);

    report("extract-geometry", 1, 1, "Extracted meshes");
    report("extract-materials", 1, 1, "Extracted materials");
    report("prepare-geometry", 1, 1, "Prepared geometry");

    const assets = [];
    for (const [path, bytes] of embeddedAssets) assets.push({ path, data: bytes.buffer });
    for (const [path, bytes] of mtlxAssets) assets.push({ path, data: bytes.buffer });

    return {
      rootPath: root,
      upAxis: "Y",
      metersPerUnit: 1,
      summary: {
        rootFile: root,
        sourceKind: "gltf",
        upAxis: "Y",
        metersPerUnit: 1,
        meshCount: meshRecords.length,
        materialCount: materialEntries.length,
        generator: rawJson.asset && rawJson.asset.generator,
        version: rawJson.asset && rawJson.asset.version,
      },
      meshes: meshRecords,
      materials: materialEntries,
      assets,
      cameras: [],
      lights: [],
      warnings,
      transfer: [],
    };
  } finally {
    releaseUrls();
    if (dracoLoader && typeof dracoLoader.dispose === "function") dracoLoader.dispose();
  }
}
