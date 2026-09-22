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
  "KHR_lights_punctual",
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

// glTF normalized integer accessors: the divisor per component type, with
// signed types clamped to -1 as the spec requires.
const NORMALIZE_DIVISOR = new Map([
  ["Int8Array", 127], ["Uint8Array", 255],
  ["Int16Array", 32767], ["Uint16Array", 65535],
  ["Int32Array", 2147483647], ["Uint32Array", 4294967295],
]);

function normalizeDivisorOf(array) {
  const name = array && array.constructor ? array.constructor.name : "";
  return NORMALIZE_DIVISOR.get(name) || 0;
}

// Copies a three BufferAttribute into a plain Float32Array, undoing
// normalized integer encodings (KHR_mesh_quantization, packed colours) and
// interleaving. Reading `.array` directly leaves raw integers such as 65535.
export function attributeToFloat32(attribute, itemSizeOverride) {
  if (!attribute || !attribute.array) return null;
  const itemSize = itemSizeOverride || attribute.itemSize || 1;
  const sourceItemSize = attribute.itemSize || itemSize;
  const count = attribute.count !== undefined
    ? attribute.count
    : Math.floor(attribute.array.length / sourceItemSize);
  const divisor = attribute.normalized ? normalizeDivisorOf(attribute.array) : 0;
  const signed = !!divisor && /^Int/.test(attribute.array.constructor.name);
  const interleaved = !!(attribute.data && Number.isFinite(attribute.data.stride));
  const stride = interleaved ? attribute.data.stride : sourceItemSize;
  const base = interleaved ? (attribute.offset || 0) : 0;
  const out = new Float32Array(count * itemSize);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < itemSize; c++) {
      let value = c < sourceItemSize ? Number(attribute.array[base + i * stride + c]) : 0;
      if (divisor) value = signed ? Math.max(value / divisor, -1) : value / divisor;
      out[i * itemSize + c] = value;
    }
  }
  return out;
}

// glTF puts texcoord (0,0) at the TOP-left of the image, MaterialX and USD
// put it at the bottom-left, and the generated shaders sample file textures
// for the MaterialX convention. Flipping V here is what makes a glTF and a
// USD stage land the same way on screen.
export function flipUvV(uvs) {
  if (!uvs) return uvs;
  for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i];
  return uvs;
}

// Finds the source glTF node and primitive index for a mesh GLTFLoader
// emitted: a single-primitive mesh IS the node object, a multi-primitive
// one is a child of the node group, in primitive order.
export function gltfPrimitiveLocation(object, associations) {
  const assocOf = (node) => (associations && node ? associations.get(node) : null);
  let current = object;
  let primitiveIndex = 0;
  while (current) {
    const assoc = assocOf(current);
    if (assoc && assoc.type === "nodes" && Number.isInteger(assoc.index)) {
      return { nodeIndex: assoc.index, primitiveIndex };
    }
    const parent = current.parent;
    if (!parent) return null;
    const siblings = (parent.children || []).filter((child) => child && !assocOf(child));
    const idx = siblings.indexOf(current);
    primitiveIndex = idx >= 0 ? idx : 0;
    current = parent;
  }
  return null;
}

// The authoritative material binding: the primitive's own `material` index
// in the source JSON, which survives every material clone and cache hit
// GLTFLoader makes. Returns -1 only when the primitive truly has none.
export function gltfMaterialIndexForNode(json, nodeIndex, primitiveIndex) {
  const nodeDef = json && Array.isArray(json.nodes) ? json.nodes[nodeIndex] : null;
  if (!nodeDef || !Number.isInteger(nodeDef.mesh)) return -1;
  const meshDef = Array.isArray(json.meshes) ? json.meshes[nodeDef.mesh] : null;
  const primitives = meshDef && Array.isArray(meshDef.primitives) ? meshDef.primitives : [];
  const primitive = primitives[primitiveIndex] || (primitives.length === 1 ? primitives[0] : null);
  if (!primitive || !Number.isInteger(primitive.material)) return -1;
  return primitive.material;
}

// USD-style camera records use a physical aperture + focal length pair,
// glTF perspective cameras use a vertical field of view. 36mm horizontal
// aperture (full-frame stills) is the fixed reference; the vertical one
// follows the aspect ratio, and focalLength is solved from the same
// fov = 2*atan(verticalAperture / (2*focalLength)) relation the renderer
// uses to turn a USD camera record back into a fov.
const USD_HORIZONTAL_APERTURE_MM = 36;
const DEFAULT_ASPECT = 16 / 9;

export function apertureAndFocalLengthFromYfov(yfovRadians, aspectRatio) {
  const aspect = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : DEFAULT_ASPECT;
  const horizontalAperture = USD_HORIZONTAL_APERTURE_MM;
  const verticalAperture = horizontalAperture / aspect;
  const yfov = Number.isFinite(yfovRadians) && yfovRadians > 0 ? yfovRadians : 0.8;
  const focalLength = (verticalAperture / 2) / Math.tan(yfov / 2);
  return { horizontalAperture, verticalAperture, focalLength };
}

// KHR_lights_punctual spot cones are inner/outer angles in radians; the USD
// sphere-light shaping API this maps onto is a cone angle (degrees) plus a
// 0..1 softness fraction between the inner and outer cosines. Solving
// coneOf()'s own inner = outer + (1-outer)*softness for softness given both
// cosines keeps the reconstructed cone exact.
export function spotConeSoftnessFromAngles(innerConeAngleRadians, outerConeAngleRadians) {
  const inner = Number.isFinite(innerConeAngleRadians) ? innerConeAngleRadians : 0;
  const outer = Number.isFinite(outerConeAngleRadians) ? outerConeAngleRadians : Math.PI / 4;
  const cosInner = Math.cos(Math.min(Math.max(inner, 0), Math.PI / 2));
  const cosOuter = Math.cos(Math.min(Math.max(outer, 0), Math.PI / 2));
  const denom = 1 - cosOuter;
  if (!(denom > 1e-6)) return 0;
  return Math.min(1, Math.max(0, (cosInner - cosOuter) / denom));
}

// Shared shape for every light record this loader emits, matching the
// fields js/usd/usd-stage-worker.js's collectLights() produces so
// js/usd-scene-lights.js needs no glTF-specific branch.
function baseLightRecord() {
  return {
    primPath: "", name: "", type: "",
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    textureFile: null, textureFormat: "automatic",
    intensity: 1, exposure: 0, diffuse: 1, specular: 1,
    color: [1, 1, 1],
    enableColorTemperature: false, colorTemperature: 6500,
    radius: null, width: null, height: null, length: null, angle: null,
    normalize: false, treatAsPoint: false,
    coneAngle: null, coneSoftness: null,
  };
}

// A point/spot's tiny sphere radius: small enough it never reads as a
// visible sphere, large enough validAreaDimensions() in usd-scene-lights.js
// accepts it. Sphere lights use `normalize: true`, which makes
// radianceOf() apply a fixed 0.25 factor instead of the sphere's surface
// area, so this radius choice does not change the delivered intensity.
const GLTF_POINT_LIGHT_RADIUS = 0.01;

// Maps one KHR_lights_punctual light def + its node's world matrix onto a
// USD-shaped light record. glTF intensity is candela (point/spot) or lux
// (directional); both are passed through as-is into `intensity` the same
// way collectLights() passes through UsdLux inputs:intensity, since neither
// schema commits to a shared radiometric convention to convert against.
export function gltfLightToRecord(lightDef, matrixArray, primPath, name) {
  const record = baseLightRecord();
  record.primPath = primPath;
  record.name = name;
  record.matrix = matrixArray;
  const color = Array.isArray(lightDef.color) && lightDef.color.length >= 3 ? lightDef.color.slice(0, 3) : [1, 1, 1];
  record.color = color;
  const intensity = Number.isFinite(lightDef.intensity) ? lightDef.intensity : 1;
  record.intensity = intensity;

  const kind = lightDef.type;
  if (kind === "directional") {
    record.type = "distantlight";
    return record;
  }
  // point and spot both become a sphere light with a token radius; a spot
  // additionally authors the shaping cone usd-scene-lights.js reads.
  record.type = "spherelight";
  record.radius = GLTF_POINT_LIGHT_RADIUS;
  record.normalize = true;
  if (kind === "spot") {
    const spot = lightDef.spot || {};
    const inner = Number.isFinite(spot.innerConeAngle) ? spot.innerConeAngle : 0;
    const outer = Number.isFinite(spot.outerConeAngle) ? spot.outerConeAngle : Math.PI / 4;
    record.coneAngle = outer * (180 / Math.PI);
    record.coneSoftness = spotConeSoftnessFromAngles(inner, outer);
  }
  return record;
}

// Maps one glTF camera def + its node's world matrix onto a USD-shaped
// camera record. Orthographic cameras are emitted faithfully (apertures
// from xmag/ymag) even though the current Scene Viewer camera rig only
// ever computes a perspective fov from aperture/focalLength; see the
// caller's warning.
export function gltfCameraToRecord(cameraDef, matrixArray, primPath, name) {
  const record = {
    primPath, name, matrix: matrixArray,
    focalLength: 50, horizontalAperture: 36, verticalAperture: 24,
    clippingRange: [0.1, 1000000], focusDistance: 0, projection: "perspective",
  };
  if (cameraDef.type === "orthographic") {
    const params = cameraDef.orthographic || {};
    const xmag = Number.isFinite(params.xmag) ? params.xmag : 1;
    const ymag = Number.isFinite(params.ymag) ? params.ymag : 1;
    record.projection = "orthographic";
    record.horizontalAperture = xmag * 2;
    record.verticalAperture = ymag * 2;
    record.clippingRange = [
      Number.isFinite(params.znear) ? params.znear : 0.01,
      Number.isFinite(params.zfar) ? params.zfar : 1000000,
    ];
    return record;
  }
  const params = cameraDef.perspective || {};
  const { horizontalAperture, verticalAperture, focalLength } =
    apertureAndFocalLengthFromYfov(params.yfov, params.aspectRatio);
  record.horizontalAperture = horizontalAperture;
  record.verticalAperture = verticalAperture;
  record.focalLength = focalLength;
  record.clippingRange = [
    Number.isFinite(params.znear) ? params.znear : 0.01,
    Number.isFinite(params.zfar) ? params.zfar : 1000000,
  ];
  return record;
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
      // Only reached when the source primitives really bind no material.
      if (materialIndex < 0) warnings.push("[info] The file binds no material to some meshes, the default glTF material (white, fully rough metal) is used");
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
      const positions = attributeToFloat32(posAttr, 3);
      const normals = geometry.attributes.normal ? attributeToFloat32(geometry.attributes.normal, 3) : undefined;
      const uvs = geometry.attributes.uv ? flipUvV(attributeToFloat32(geometry.attributes.uv, 2)) : undefined;

      const geomprops = [];
      if (geometry.attributes.uv2) {
        const uv1 = flipUvV(attributeToFloat32(geometry.attributes.uv2, 2));
        geomprops.push({ name: "UV1", itemSize: 2, interpolation: "vertex", data: uv1 });
      }
      let hasVertexColor = false;
      if (geometry.attributes.color) {
        hasVertexColor = true;
        const colorData = attributeToFloat32(geometry.attributes.color, 3);
        geomprops.push({ name: "color", itemSize: 3, interpolation: "vertex", data: colorData });
      }

      const indices = geometry.index
        ? Uint32Array.from(geometry.index.array)
        : Uint32Array.from({ length: vertexCount }, (_, i) => i);

      // Source JSON first: a primitive's own material index is immune to
      // every clone, cache hit and default-material substitution three makes.
      const location = gltfPrimitiveLocation(object, parser.associations);
      let materialIndex = location ? gltfMaterialIndexForNode(rawJson, location.nodeIndex, location.primitiveIndex) : -1;
      if (materialIndex < 0) {
        const assoc = parser.associations.get(object.material);
        if (assoc && assoc.type === "materials" && Number.isInteger(assoc.index)) materialIndex = assoc.index;
      }
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

    // Cameras and KHR_lights_punctual lights, read from the source JSON via
    // each object's node association the same way materialPathFor() reads
    // materials: immune to GLTFLoader's own defaulting and cloning.
    const usedCameraNames = new Set();
    const usedLightNames = new Set();
    const cameraRecords = [];
    const lightRecords = [];
    const lightsExtRoot = rawJson.extensions && rawJson.extensions.KHR_lights_punctual;
    sceneRoot.traverse((object) => {
      if (object.isCamera) {
        const location = gltfPrimitiveLocation(object, parser.associations);
        const nodeDef = location ? rawJson.nodes[location.nodeIndex] : null;
        const cameraIndex = nodeDef && Number.isInteger(nodeDef.camera) ? nodeDef.camera : null;
        const cameraDef = Number.isInteger(cameraIndex) && Array.isArray(rawJson.cameras) ? rawJson.cameras[cameraIndex] : null;
        if (!cameraDef) return;
        const baseName = (nodeDef && nodeDef.name) || cameraDef.name || object.name || ("camera" + cameraIndex);
        const camName = sanitizeMtlxName(baseName, usedCameraNames);
        cameraRecords.push(gltfCameraToRecord(cameraDef, Array.from(object.matrixWorld.elements), "/Cameras/" + camName, baseName));
        return;
      }
      if (object.isLight) {
        const location = gltfPrimitiveLocation(object, parser.associations);
        const nodeDef = location ? rawJson.nodes[location.nodeIndex] : null;
        const lightExt = nodeDef && nodeDef.extensions && nodeDef.extensions.KHR_lights_punctual;
        const lightIndex = lightExt && Number.isInteger(lightExt.light) ? lightExt.light : null;
        const lightDef = Number.isInteger(lightIndex) && lightsExtRoot && Array.isArray(lightsExtRoot.lights)
          ? lightsExtRoot.lights[lightIndex] : null;
        if (!lightDef) return;
        const baseName = (nodeDef && nodeDef.name) || lightDef.name || object.name || ("light" + lightIndex);
        const lightName = sanitizeMtlxName(baseName, usedLightNames);
        lightRecords.push(gltfLightToRecord(lightDef, Array.from(object.matrixWorld.elements), "/Lights/" + lightName, baseName));
      }
    });
    // glTF has no default-camera concept; the first camera in traversal
    // order gets the flag, the same fallback markDefaultCamera() in
    // js/usd/usd-stage-worker.js uses once no RenderSettings prim claims one.
    if (cameraRecords.length) cameraRecords[0].defaultCamera = true;
    const orthoCameraCount = cameraRecords.filter((c) => c.projection === "orthographic").length;
    if (orthoCameraCount) {
      warnings.push("[info] " + orthoCameraCount + " orthographic camera(s) imported; the camera picker frames them as perspective");
    }
    if (cameraRecords.length || lightRecords.length) {
      warnings.push("[info] " + cameraRecords.length + " camera(s) and " + lightRecords.length + " light(s) imported from glTF");
    }

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
      cameras: cameraRecords,
      lights: lightRecords,
      warnings,
      transfer: [],
    };
  } finally {
    releaseUrls();
    if (dracoLoader && typeof dracoLoader.dispose === "function") dracoLoader.dispose();
  }
}
