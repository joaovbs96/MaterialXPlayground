// Pure helpers shared by the renderer scene importers (pbrt-v4, Mitsuba):
// paths, 4x4 matrices, transform baking, camera lens, and the neutral stage
// payload records. No DOM, no THREE, so node tests can import it.

export function checkAborted(signal) {
  if (signal && signal.aborted) {
    const err = new Error("Aborted");
    err.name = "AbortError";
    throw err;
  }
}

export const normalizePath = (path) => String(path ?? "").replace(/\\/g, "/");
export const dirOf = (path) => { const p = normalizePath(path); const i = p.lastIndexOf("/"); return i === -1 ? "" : p.slice(0, i); };
export const basenameOf = (path) => normalizePath(path).split("/").pop();

// Joins a base directory and a relative reference, resolving "." and "..".
export function joinPath(dir, rel) {
  const parts = normalizePath(dir).split("/").concat(normalizePath(rel).split("/"));
  const out = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part);
  }
  return out.join("/");
}

export async function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (data && typeof data.arrayBuffer === "function") return await data.arrayBuffer();
  throw new Error("Unsupported file data");
}

// Resolves a file reference: next to the referencing file, then next to
// the root file, then a unique basename anywhere in the drop.
export function resolveScenePath(ref, fromDir, rootDir, fileByPath) {
  const raw = normalizePath(ref);
  for (const candidate of [joinPath(fromDir, raw), joinPath(rootDir, raw)]) {
    if (fileByPath.has(candidate)) return candidate;
  }
  const base = basenameOf(raw).toLowerCase();
  let hit = null;
  for (const path of fileByPath.keys()) {
    if (basenameOf(path).toLowerCase() !== base) continue;
    if (hit) return null; // ambiguous
    hit = path;
  }
  return hit;
}

// Collects warnings once each, in first-seen order.
export function createWarningSink() {
  const warnings = [];
  const seen = new Set();
  return { warnings, warn: (message) => { if (!seen.has(message)) { seen.add(message); warnings.push(message); } } };
}

// ------------------------------------------------------------------ matrices

// 4x4 matrices are column-major arrays of 16 (THREE's layout).
export const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function mat4Multiply(a, b) {
  const out = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function mat4Invert(m) {
  const inv = new Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (!det) throw new Error("Singular transform in the scene file");
  return inv.map((v) => v / det);
}

// Determinant of the upper-left 3x3 (the sign tells whether a transform
// swaps handedness).
export function mat3Determinant(m) {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

export function translateMatrix(x, y, z) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; }
export function scaleMatrix(x, y, z) { return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]; }

// Rotation by deg degrees about an axis, right-hand rule (pbrt and Mitsuba agree).
export function rotateMatrix(deg, ax, ay, az) {
  const len = Math.hypot(ax, ay, az) || 1;
  const x = ax / len, y = ay / len, z = az / len;
  const t = (deg * Math.PI) / 180;
  const s = Math.sin(t), c = Math.cos(t);
  return [
    x * x + (1 - x * x) * c, x * y * (1 - c) + z * s, x * z * (1 - c) - y * s, 0,
    x * y * (1 - c) - z * s, y * y + (1 - y * y) * c, y * z * (1 - c) + x * s, 0,
    x * z * (1 - c) + y * s, y * z * (1 - c) - x * s, z * z + (1 - z * z) * c, 0,
    0, 0, 0, 1,
  ];
}

// Bakes a transform into positions, normals and winding. Winding reverses
// when the transform (times reverseOrientation) swaps handedness, so the
// geometric facing stays consistent with the transformed normals.
export function bakeMeshTransform({ positions, normals, indices }, matrix, reverseOrientation = false) {
  const m = matrix;
  const outP = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
    outP[i] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    outP[i + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    outP[i + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
  }
  let outN = null;
  if (normals && normals.length === positions.length) {
    const inv = mat4Invert(m); // normals use the inverse transpose
    const sign = reverseOrientation ? -1 : 1;
    outN = new Float32Array(normals.length);
    for (let i = 0; i < normals.length; i += 3) {
      const x = normals[i], y = normals[i + 1], z = normals[i + 2];
      const nx = inv[0] * x + inv[1] * y + inv[2] * z;
      const ny = inv[4] * x + inv[5] * y + inv[6] * z;
      const nz = inv[8] * x + inv[9] * y + inv[10] * z;
      const len = Math.hypot(nx, ny, nz) || 1;
      outN[i] = (sign * nx) / len; outN[i + 1] = (sign * ny) / len; outN[i + 2] = (sign * nz) / len;
    }
  }
  const flip = (mat3Determinant(m) < 0) !== !!reverseOrientation;
  const outI = Uint32Array.from(indices);
  if (flip) {
    for (let i = 0; i + 2 < outI.length; i += 3) { const t = outI[i + 1]; outI[i + 1] = outI[i + 2]; outI[i + 2] = t; }
  }
  return { positions: outP, normals: outN, indices: outI, flipped: flip };
}

// ------------------------------------------------------------------- camera

const HORIZONTAL_APERTURE_MM = 36;

// USD-style lens (36 mm wide aperture, height from the aspect) whose fov
// spans the given image axis: "x", "y", "diagonal", "smaller" or "larger".
export function cameraLensForFov(fovDeg, aspect, axis = "x") {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1280 / 720;
  const fov = ((Number.isFinite(fovDeg) && fovDeg > 0 ? fovDeg : 90) * Math.PI) / 180;
  const horizontalAperture = HORIZONTAL_APERTURE_MM;
  const verticalAperture = horizontalAperture / a;
  const span = axis === "y" ? verticalAperture
    : axis === "diagonal" ? Math.hypot(horizontalAperture, verticalAperture)
    : axis === "smaller" ? Math.min(horizontalAperture, verticalAperture)
    : axis === "larger" ? Math.max(horizontalAperture, verticalAperture)
    : horizontalAperture;
  const focalLength = span / 2 / Math.tan(fov / 2);
  return { horizontalAperture, verticalAperture, focalLength };
}

// Camera record in the glTF/USD shape the renderer reads; matrix is a
// camera-to-world transform for a camera looking down -z, +y up.
export function sceneCameraRecord({ matrix, lens, focusDistance = 0, name = "camera" }) {
  return {
    primPath: "/Cameras/" + name, name,
    matrix,
    focalLength: lens.focalLength, horizontalAperture: lens.horizontalAperture, verticalAperture: lens.verticalAperture,
    horizontalApertureOffset: 0, verticalApertureOffset: 0,
    clippingRange: [0.001, 1000000], focusDistance: Number.isFinite(focusDistance) ? focusDistance : 0,
    projection: "perspective", defaultCamera: true,
  };
}

// A constant environment: a uniform dome light whose colour is the radiance.
export function uniformDomeLight(color) {
  return {
    primPath: "/Lights/environment", name: "environment", type: "domelight",
    matrix: IDENTITY.slice(), textureFile: null, textureFormat: "automatic",
    intensity: 1, exposure: 0, diffuse: 1, specular: 1,
    color,
    enableColorTemperature: false, colorTemperature: 6500,
    radius: null, width: null, height: null, length: null, angle: null,
    normalize: false, treatAsPoint: false, coneAngle: null, coneSoftness: null,
  };
}

// ------------------------------------------------------------------ payload

// Material entry for one generated MaterialX document ({ xml, materialName }).
export function materialEntryFromDocument(doc, name, prefix) {
  const bytes = new TextEncoder().encode(doc.xml);
  const mtlxPath = "__" + prefix + "_" + name + ".mtlx";
  return {
    path: "/Materials/" + name,
    shaderId: "open_pbr_surface",
    materialX: { path: mtlxPath, mimeType: "application/xml", materialName: doc.materialName, data: bytes },
    sourceAsset: mtlxPath,
    materialName: doc.materialName,
  };
}

// Mesh record with world-space (already baked) geometry.
export function bakedMeshRecord({ primName, positions, normals, uvs, indices, materialPath, doubleSided = true }) {
  return {
    primPath: "/" + primName,
    name: primName,
    positions,
    ...(normals ? { normals } : {}),
    ...(uvs ? { uvs } : {}),
    displayColor: null,
    indices,
    matrix: IDENTITY.slice(),
    orientation: "rightHanded",
    castsShadow: true,
    subdivisionScheme: "none",
    materialPath,
    doubleSided,
    groups: [],
  };
}

export function scenePayload({ rootPath, sourceKind, meshes, materials, cameras, lights, warnings }) {
  return {
    rootPath,
    upAxis: "Y",
    metersPerUnit: 1,
    summary: {
      rootFile: rootPath,
      sourceKind,
      upAxis: "Y",
      metersPerUnit: 1,
      meshCount: meshes.length,
      materialCount: materials.length,
    },
    meshes,
    materials,
    assets: materials.map((m) => ({ path: m.materialX.path, data: m.materialX.data.buffer })),
    cameras,
    lights,
    warnings,
    transfer: [],
  };
}
