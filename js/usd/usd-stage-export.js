// Export of a neutral glTF/OBJ stage payload to USD. Pure ESM, no DOM.
// buildExportJob() produces the files and the ExportStage spec the OpenUSD
// worker consumes; the worker also runs packageExportBytes() (no main thread).

const MATERIAL_ROOT = "/Root/Materials";
const GEOM_ROOT = "/Root/Geom";
const CAMERA_ROOT = "/Root/Cameras";
const LIGHT_ROOT = "/Root/Lights";

export function sanitizeUsdName(name, used, fallback = "prim") {
  let base = String(name ?? "").replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
  if (!base || /^_+$/.test(base)) base = fallback;
  if (/^[0-9]/.test(base)) base = "_" + base;
  if (!used) return base;
  let out = base;
  let i = 2;
  while (used.has(out.toLowerCase())) out = base + "_" + i++;
  used.add(out.toLowerCase());
  return out;
}

export function exportStem(rootPath) {
  const base = String(rootPath ?? "").replace(/\\/g, "/").split("/").pop() || "";
  return sanitizeUsdName(base.replace(/\.[^.]+$/, ""), null, "scene");
}

// glTF KHR_lights_punctual light record -> UsdLux values, export only (the viewer
// keeps raw glTF intensity). UsdLux intensity is luminance in nits (cd/m2), a
// photometric unit like glTF's cd and lux, so no 683 lm/W factor is needed.
// Sphere + normalize: L = I / (4 pi r^2), cd = L pi r^2, so nits = 4 * cd (r cancels).
// Distant + normalize: E = L pi sin^2(angle/2) with L = I / that, so nits = lux.
// Cone shaping only masks and never renormalizes in UsdLux, same as glTF spots.
export function gltfLightToUsdLux(record) {
  const intensity = Number.isFinite(record.intensity) ? record.intensity : 1;
  const base = { color: Array.from(record.color ?? [1, 1, 1]).slice(0, 3), exposure: 0, normalize: true };
  if (record.type === "distantlight") return { ...base, type: "distant", intensity, angle: 0 };
  const out = { ...base, type: "sphere", intensity: intensity * 4, radius: record.radius > 0 ? record.radius : 0.01, treatAsPoint: true };
  if (record.coneAngle != null) {
    out.shaping = { coneAngle: record.coneAngle, coneSoftness: record.coneSoftness ?? 0 };
  }
  return out;
}

const normalizePath = (path) => String(path ?? "").replace(/\\/g, "/").replace(/^\.?\/+/, "");
const lastSegment = (path) => String(path ?? "").split("/").filter(Boolean).pop() || "";

function xmlUnescape(value) {
  return String(value)
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function xmlEscapeAttr(value) {
  return String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Blobs (dropped Files) pass through unread: the worker reads them, so a
// busy main thread never waits once per texture.
function toBytes(data) {
  if (data == null) return null;
  if (data instanceof Uint8Array) return data.slice();
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  if (typeof Blob !== "undefined" && data instanceof Blob) return data;
  return null;
}

// Texture lookup by the file value the MaterialX document carries: embedded
// payload assets first, then the user's loaded files (exact, then case-insensitive).
function createTextureResolver(payload, inputFiles) {
  const exact = new Map();
  const lower = new Map();
  const add = (path, data) => {
    const key = normalizePath(path);
    if (!key || exact.has(key)) return;
    exact.set(key, data);
    lower.set(key.toLowerCase(), data);
  };
  for (const asset of payload.assets ?? []) add(asset.path, asset.data);
  for (const file of inputFiles ?? []) add(file.path, file.data);
  return (path) => {
    const key = normalizePath(path);
    return exact.get(key) ?? lower.get(key.toLowerCase()) ?? null;
  };
}

/**
 * Builds the export job. options: { files (loaded input files), stem,
 * materialMode "reference"|"networks", format "usda"|"usdc"|"usdz", id }.
 * Returns { spec, files: [{ path, bytes (Uint8Array or Blob) }], stem, warnings }.
 */
export async function buildExportJob(payload, options = {}) {
  const warnings = [];
  const materialMode = options.materialMode === "networks" ? "networks" : "reference";
  const format = options.format === "usdc" || options.format === "usdz" ? options.format : "usda";
  const stem = options.stem || exportStem(payload.rootPath);
  const id = options.id || Math.random().toString(36).slice(2, 10);
  const resolveTexture = createTextureResolver(payload, options.files);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const files = [];
  const textureNames = new Map(); // source path -> "textures/<name>"
  const usedTextureNames = new Set();
  const missing = new Set();

  const textureTarget = (rawValue) => {
    const key = normalizePath(rawValue);
    if (!key) return null;
    if (textureNames.has(key)) return textureNames.get(key);
    const bytes = toBytes(resolveTexture(key));
    if (!bytes) {
      if (!missing.has(key)) { missing.add(key); warnings.push("Texture not found, reference left as is: " + key); }
      return null;
    }
    const base = lastSegment(key);
    const dot = base.lastIndexOf(".");
    const extPart = dot > 0 ? base.slice(dot).replace(/[^A-Za-z0-9.]/g, "") : "";
    const stemPart = (dot > 0 ? base.slice(0, dot) : base).replace(/[^A-Za-z0-9_-]+/g, "_") || "texture";
    let name = stemPart + extPart;
    let i = 2;
    while (usedTextureNames.has(name.toLowerCase())) name = stemPart + "_" + i++ + extPart;
    usedTextureNames.add(name.toLowerCase());
    const target = "textures/" + name;
    textureNames.set(key, target);
    files.push({ path: target, bytes });
    return target;
  };

  const usedMaterialNames = new Set();
  const materialPathMap = new Map(); // payload material path -> USD prim path
  const materials = [];
  for (const entry of payload.materials ?? []) {
    const mtlx = entry.materialX;
    if (!mtlx || !mtlx.data) { warnings.push("Material without MaterialX data skipped: " + entry.path); continue; }
    const name = sanitizeUsdName(lastSegment(entry.path), usedMaterialNames, "material");
    let xml = decoder.decode(mtlx.data);
    const tagPattern = /<input\b[^>]*>/g;
    const tags = xml.match(tagPattern) ?? [];
    const replacements = new Map();
    for (const tag of tags) {
      if (!/\btype\s*=\s*"filename"/.test(tag)) continue;
      const valueMatch = /\bvalue\s*=\s*"([^"]*)"/.exec(tag);
      if (!valueMatch) continue;
      const target = textureTarget(xmlUnescape(valueMatch[1]));
      if (!target) continue;
      const rewritten = tag.replace(valueMatch[0], 'value="' + xmlEscapeAttr("../" + target) + '"');
      replacements.set(tag, rewritten);
    }
    if (replacements.size) xml = xml.replace(tagPattern, (tag) => replacements.get(tag) ?? tag);
    files.push({ path: "materials/" + name + ".mtlx", bytes: encoder.encode(xml) });
    const primPath = MATERIAL_ROOT + "/" + name;
    materialPathMap.set(entry.path, primPath);
    materials.push({ primPath, mtlxAsset: "./materials/" + name + ".mtlx", mtlxMaterialName: mtlx.materialName || entry.materialName || name });
  }

  const usedMeshNames = new Set();
  const meshes = [];
  for (const mesh of payload.meshes ?? []) {
    const name = sanitizeUsdName(lastSegment(mesh.primPath) || mesh.name, usedMeshNames, "mesh");
    const out = {
      primPath: GEOM_ROOT + "/" + name,
      matrix: Array.from(mesh.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      points: mesh.positions,
      indices: mesh.indices,
    };
    if (mesh.normals) out.normals = mesh.normals;
    if (mesh.uvs) out.uvs = mesh.uvs;
    if (Array.isArray(mesh.geomprops) && mesh.geomprops.length) {
      out.primvars = mesh.geomprops.map((p) => ({ name: p.name, itemSize: p.itemSize, interpolation: p.interpolation, data: p.data }));
    }
    if (mesh.orientation) out.orientation = mesh.orientation;
    out.doubleSided = mesh.doubleSided === true;
    const material = mesh.materialPath ? materialPathMap.get(mesh.materialPath) : null;
    if (material) out.materialPath = material;
    // glTF/OBJ loaders emit one mesh per material (groups is always empty), so no subsets.
    meshes.push(out);
  }

  const usedCameraNames = new Set();
  const cameras = [];
  for (const cam of payload.cameras ?? []) {
    const m = cam && Array.isArray(cam.matrix) ? cam.matrix : null;
    const clip = cam && Array.isArray(cam.clippingRange) ? cam.clippingRange : null;
    const nums = [cam?.focalLength, cam?.horizontalAperture, cam?.verticalAperture];
    if (!m || m.length !== 16 || !m.every(Number.isFinite) || !clip || !clip.every(Number.isFinite) || !nums.every(Number.isFinite)) {
      warnings.push("Camera skipped (invalid data): " + (cam?.primPath ?? "?"));
      continue;
    }
    cameras.push({
      primPath: CAMERA_ROOT + "/" + sanitizeUsdName(cam.name || lastSegment(cam.primPath), usedCameraNames, "camera"),
      matrix: Array.from(m),
      projection: cam.projection === "orthographic" ? "orthographic" : "perspective",
      focalLength: cam.focalLength,
      horizontalAperture: cam.horizontalAperture,
      verticalAperture: cam.verticalAperture,
      horizontalApertureOffset: cam.horizontalApertureOffset || 0,
      verticalApertureOffset: cam.verticalApertureOffset || 0,
      clippingRange: [clip[0], clip[1]],
      focusDistance: cam.focusDistance || 0,
    });
  }

  const usedLightNames = new Set();
  const lights = [];
  for (const light of payload.lights ?? []) {
    const m = light && Array.isArray(light.matrix) ? light.matrix : null;
    const known = light && (light.type === "distantlight" || light.type === "spherelight");
    if (!m || m.length !== 16 || !m.every(Number.isFinite) || !known) {
      warnings.push("Light skipped (unsupported or invalid): " + (light?.primPath ?? "?"));
      continue;
    }
    lights.push({
      primPath: LIGHT_ROOT + "/" + sanitizeUsdName(light.name || lastSegment(light.primPath), usedLightNames, "light"),
      matrix: Array.from(m),
      ...gltfLightToUsdLux(light),
    });
  }

  const spec = {
    workDir: "/export/" + id,
    rootLayer: stem + (format === "usda" ? ".usda" : ".usdc"),
    materialMode,
    package: format === "usdz" ? "usdz" : "none",
    upAxis: payload.upAxis === "Z" ? "Z" : "Y",
    metersPerUnit: Number(payload.metersPerUnit) || 1,
    defaultPrim: "Root",
    meshes,
    materials,
    cameras,
    lights,
  };
  return { spec, files, stem, materialMode, format, warnings };
}

// Text is deflated; every other file (images, usdc, usdz) is already compressed and stored.
const DEFLATED_EXT = new Set(["usda", "usd", "mtlx", "xml", "json", "txt"]);

let jszipPromise = null;
// Workers keep relative vendor paths. The UMD sets self.JSZip when imported as a module.
function loadJsZip() {
  jszipPromise ??= import("../../vendor/jszip/jszip.min.js").then(() => {
    if (!globalThis.JSZip) throw new Error("JSZip did not load");
    return globalThis.JSZip;
  });
  jszipPromise.catch(() => { jszipPromise = null; });
  return jszipPromise;
}

/** Zips entries [{ path, bytes }] with JSZip: deflate for text, store for compressed formats. */
export async function buildZip(entries) {
  const JSZip = await loadJsZip();
  const zip = new JSZip();
  for (const { path, bytes } of entries) {
    const compression = DEFLATED_EXT.has(path.split(".").pop().toLowerCase()) ? "DEFLATE" : "STORE";
    zip.file(path, bytes, { binary: true, compression, createFolders: false });
  }
  return zip.generateAsync({ type: "uint8array", compression: "STORE" });
}

/**
 * Packages ExportStage's returned files with the job's inputs: { bytes, filename }.
 * reference: zip of root layer + materials/ + textures/; networks usda/usdc:
 * zip of root layer + textures/; networks usdz: the single .usdz file.
 * job = { files: [{ path, bytes: Uint8Array }], stem, materialMode, format }.
 */
export async function packageExportBytes(resultFiles, job) {
  const returned = new Map();
  for (const file of resultFiles ?? []) returned.set(normalizePath(file.path), file.bytes);
  if (!returned.size) throw new Error("The USD runtime returned no files.");
  if (job.format === "usdz") {
    for (const [path, bytes] of returned) {
      if (/\.usdz$/i.test(path)) return { bytes, filename: job.stem + ".usdz" };
    }
    throw new Error("The USD runtime returned no .usdz package.");
  }
  const entries = [];
  const added = new Set();
  const put = (path, bytes) => {
    if (added.has(path)) return;
    added.add(path);
    entries.push({ path, bytes });
  };
  for (const [path, bytes] of returned) put(path, bytes);
  for (const file of job.files ?? []) {
    if (job.materialMode === "networks" && /^materials\//.test(file.path)) continue;
    put(file.path, file.bytes);
  }
  return { bytes: await buildZip(entries), filename: job.stem + ".zip" };
}
