// Pure helpers shared by the renderer scene importers (pbrt-v4, Mitsuba):
// paths, the XML reader and Mitsuba scene detection, 4x4 matrices, transform
// baking, camera lens, payload records. No DOM, no THREE, so node tests can import it.

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

// --------------------------------------------------------------- XML parser

const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decodeEntities = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => (e[0] === "#"
  ? String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
  : XML_ENTITIES[e]));

// Minimal XML reader for scene files: elements { name, attrs, children }.
// Text content, comments, processing instructions, DOCTYPE and CDATA are
// skipped (Mitsuba stores every value in attributes).
export function parseXml(text) {
  const src = String(text ?? "");
  const root = { name: "#document", attrs: {}, children: [] };
  const stack = [root];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) break;
    if (src.startsWith("<!--", lt)) { const e = src.indexOf("-->", lt + 4); if (e === -1) throw new Error("Unterminated XML comment"); i = e + 3; continue; }
    if (src.startsWith("<![CDATA[", lt)) { const e = src.indexOf("]]>", lt); if (e === -1) throw new Error("Unterminated CDATA"); i = e + 3; continue; }
    if (src[lt + 1] === "?" || src[lt + 1] === "!") { const e = src.indexOf(">", lt); if (e === -1) throw new Error("Unterminated XML declaration"); i = e + 1; continue; }
    if (src[lt + 1] === "/") {
      const e = src.indexOf(">", lt);
      if (e === -1) throw new Error("Unterminated closing tag");
      const name = src.slice(lt + 2, e).trim();
      const top = stack.pop();
      if (!top || top.name !== name || !stack.length) throw new Error("Mismatched closing tag </" + name + ">");
      i = e + 1;
      continue;
    }
    let j = lt + 1;
    while (j < n && !/[\s/>]/.test(src[j])) j++;
    const el = { name: src.slice(lt + 1, j), attrs: {}, children: [] };
    for (;;) {
      while (j < n && /\s/.test(src[j])) j++;
      if (j >= n) throw new Error("Unterminated tag <" + el.name + ">");
      if (src[j] === ">" || (src[j] === "/" && src[j + 1] === ">")) break;
      let k = j;
      while (k < n && !/[\s=/>]/.test(src[k])) k++;
      const key = src.slice(j, k);
      while (k < n && /\s/.test(src[k])) k++;
      if (src[k] !== "=") throw new Error("Attribute " + key + " of <" + el.name + "> has no value");
      k++;
      while (k < n && /\s/.test(src[k])) k++;
      const q = src[k];
      if (q !== '"' && q !== "'") throw new Error("Attribute " + key + " of <" + el.name + "> is not quoted");
      const end = src.indexOf(q, k + 1);
      if (end === -1) throw new Error("Unterminated attribute " + key);
      el.attrs[key] = decodeEntities(src.slice(k + 1, end));
      j = end + 1;
    }
    stack[stack.length - 1].children.push(el);
    if (src[j] === "/") { i = j + 2; continue; }
    stack.push(el);
    i = j + 1;
  }
  if (stack.length !== 1) throw new Error("Unclosed element <" + stack[stack.length - 1].name + ">");
  return root.children[0] || null;
}

// ------------------------------------------------------ Mitsuba detection

// Mitsuba 3 requires a version on the root element (xml.cpp: "missing version
// attribute in root element"), so a <scene> without one is not a Mitsuba scene.
export const MITSUBA_VERSION_PATTERN = /^\d+(\.\d+){1,2}$/;
const MITSUBA_SCENE_CHILDREN = new Set(["shape", "sensor", "emitter", "integrator"]);
export const MITSUBA_SNIFF_BYTES = 4096;

// Prolog check on the head of a file: BOM, XML declaration, comments, DOCTYPE
// and whitespace, then <scene version="x.y[.z]">. Returns the version or null.
export function sniffMitsubaSceneVersion(head) {
  const s = String(head ?? "");
  let i = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s.startsWith("<?", i)) { const e = s.indexOf("?>", i + 2); if (e === -1) return null; i = e + 2; continue; }
    if (s.startsWith("<!--", i)) { const e = s.indexOf("-->", i + 4); if (e === -1) return null; i = e + 3; continue; }
    if (/^<!DOCTYPE/i.test(s.slice(i, i + 9))) {
      const gt = s.indexOf(">", i), br = s.indexOf("[", i);
      const e = br !== -1 && (gt === -1 || br < gt) ? s.indexOf("]", br) : i;
      const close = e === -1 ? -1 : s.indexOf(">", e);
      if (close === -1) return null;
      i = close + 1;
      continue;
    }
    break;
  }
  const open = /^<([A-Za-z_][\w.:-]*)/.exec(s.slice(i, i + 256));
  if (!open || open[1] !== "scene") return null;
  const end = s.indexOf(">", i);
  if (end === -1) return null;
  const tag = s.slice(i + open[0].length, end);
  const attr = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = attr.exec(tag))) {
    if (m[1] !== "version") continue;
    const value = (m[2] ?? m[3] ?? "").trim();
    return MITSUBA_VERSION_PATTERN.test(value) ? value : null;
  }
  return null;
}

// Full check: a <scene version> root with at least one direct shape, sensor,
// emitter or integrator child that has a type. Returns { version, includes } or null.
export function mitsubaSceneInfo(text) {
  if (!sniffMitsubaSceneVersion(String(text ?? "").slice(0, MITSUBA_SNIFF_BYTES))) return null;
  let root;
  try { root = parseXml(text); } catch (e) { return null; }
  if (!root || root.name !== "scene" || !MITSUBA_VERSION_PATTERN.test(String(root.attrs.version || "").trim())) return null;
  if (!root.children.some((c) => MITSUBA_SCENE_CHILDREN.has(c.name) && c.attrs.type)) return null;
  const includes = root.children.filter((c) => c.name === "include" && c.attrs.filename).map((c) => c.attrs.filename);
  return { version: root.attrs.version.trim(), includes };
}

// Numeric version order ("3.0.0" > "0.6.0", "2.10" > "2.9").
export function compareMitsubaVersions(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let k = 0; k < 3; k++) { const d = (pa[k] || 0) - (pb[k] || 0); if (d) return d; }
  return 0;
}

// Text of a dropped entry's data (File/Blob, ArrayBuffer, typed array or string),
// optionally only its first maxBytes.
export async function readEntryText(data, maxBytes = Infinity) {
  if (typeof data === "string") return Number.isFinite(maxBytes) ? data.slice(0, maxBytes) : data;
  if (data && typeof data.slice === "function" && typeof data.text === "function") {
    return Number.isFinite(maxBytes) ? data.slice(0, maxBytes).text() : data.text();
  }
  let bytes;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else return "";
  return new TextDecoder().decode(Number.isFinite(maxBytes) ? bytes.subarray(0, maxBytes) : bytes);
}

// Valid Mitsuba roots among .xml entries [{ path, data }]: sniff, full check,
// minus files another candidate <include>s. Best first: highest version,
// shallowest path, alphabetical. Every other .xml is an ordinary companion file.
export async function classifyMitsubaXmlFiles(files) {
  const scenes = [];
  for (const entry of Array.isArray(files) ? files : []) {
    if (!entry || !/\.xml$/i.test(String(entry.path || ""))) continue;
    let info = null;
    try {
      if (sniffMitsubaSceneVersion(await readEntryText(entry.data, MITSUBA_SNIFF_BYTES))) info = mitsubaSceneInfo(await readEntryText(entry.data));
    } catch (e) { info = null; }
    if (info) scenes.push({ path: normalizePath(entry.path), ...info });
  }
  const included = new Set();
  for (const scene of scenes) {
    for (const ref of scene.includes) included.add(joinPath(dirOf(scene.path), ref).toLowerCase());
  }
  const depth = (p) => p.split("/").length;
  const roots = scenes.filter((s) => !included.has(s.path.toLowerCase())).sort((a, b) => compareMitsubaVersions(b.version, a.version)
    || depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { roots: roots.map((s) => s.path), versions: Object.fromEntries(roots.map((s) => [s.path, s.version])) };
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

// --------------------------------------------------- emitter stand-in lights

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);

// A mesh that is exactly a planar rectangle: 2 triangles over 4 distinct corners
// sharing one diagonal, planar and with equal diagonals within tolerance (relative
// to the diagonal). Returns { center, xAxis, yAxis, normal, width, height } or null.
export function rectangleFromTriangles(positions, indices, tolerance = 1e-4) {
  const idx = indices ? Array.from(indices) : Array.from({ length: Math.floor(positions.length / 3) }, (_, i) => i);
  if (idx.length !== 6) return null;
  const pts = idx.map((i) => [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
  if (!pts.every((p) => p.every(Number.isFinite))) return null;
  let extent = 0;
  for (const a of pts) for (const b of pts) extent = Math.max(extent, len3(sub3(a, b)));
  if (!(extent > 0)) return null;
  const eps = tolerance * extent;
  const corners = [];
  const cornerOf = pts.map((p) => {
    let k = corners.findIndex((c) => len3(sub3(c, p)) <= eps);
    if (k === -1) { k = corners.length; corners.push(p); }
    return k;
  });
  if (corners.length !== 4) return null;
  const triA = cornerOf.slice(0, 3), triB = cornerOf.slice(3, 6);
  if (new Set(triA).size !== 3 || new Set(triB).size !== 3) return null;
  const shared = triA.filter((k) => triB.includes(k));
  if (shared.length !== 2) return null;
  const P = corners[shared[0]], Q = corners[shared[1]];
  const R = corners[triA.find((k) => !shared.includes(k))], S = corners[triB.find((k) => !shared.includes(k))];
  const n = cross3(sub3(Q, P), sub3(R, P));
  const nl = len3(n);
  if (!(nl > 0)) return null;
  if (Math.abs(dot3(sub3(S, P), n)) / nl > eps) return null;
  const midPQ = [(P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2, (P[2] + Q[2]) / 2];
  const midRS = [(R[0] + S[0]) / 2, (R[1] + S[1]) / 2, (R[2] + S[2]) / 2];
  if (len3(sub3(midPQ, midRS)) > eps || Math.abs(len3(sub3(Q, P)) - len3(sub3(S, R))) > eps) return null;
  const e1 = sub3(R, P), e2 = sub3(Q, R);
  const width = len3(e1), height = len3(e2);
  if (!(width > eps && height > eps)) return null;
  const xAxis = e1.map((c) => c / width), yAxis = e2.map((c) => c / height);
  const normal = cross3(xAxis, yAxis);
  return { center: midPQ, xAxis, yAxis, normal: normal.map((c) => c / len3(normal)), width, height };
}

// Sum of the right-hand winding normals of indexed triangles (unnormalized).
export function windingNormal(positions, indices) {
  const idx = indices ? Array.from(indices) : Array.from({ length: Math.floor(positions.length / 3) }, (_, i) => i);
  const out = [0, 0, 0];
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const p = [0, 1, 2].map((c) => [positions[idx[t + c] * 3], positions[idx[t + c] * 3 + 1], positions[idx[t + c] * 3 + 2]]);
    const n = cross3(sub3(p[1], p[0]), sub3(p[2], p[0]));
    out[0] += n[0]; out[1] += n[1]; out[2] += n[2];
  }
  return out;
}

// Viewer-only UsdLux rect light standing in for a rectangular area emitter, which
// the real-time view cannot light from. It emits along the rectangle normal on
// facing's side (local -Z); radiance is literal (intensity 1, exposure 0, normalize false).
export function emitterStandInLight({ rect, facing, color, meshPath, name }) {
  const side = rect ? dot3(facing, rect.normal) : 0;
  if (!(Math.abs(side) > 0)) return null;
  const z = rect.normal.map((c) => (side > 0 ? -c : c));
  const x = rect.xAxis;
  const y = cross3(z, x);
  return {
    primPath: "/Lights/" + name, name, type: "rectlight",
    matrix: [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, rect.center[0], rect.center[1], rect.center[2], 1],
    textureFile: null, textureFormat: "automatic",
    intensity: 1, exposure: 0, diffuse: 1, specular: 1,
    color: color.slice(0, 3),
    enableColorTemperature: false, colorTemperature: 6500,
    radius: null, width: rect.width, height: rect.height, length: null, angle: null,
    normalize: false, treatAsPoint: false, coneAngle: null, coneSoftness: null,
    derivedFromEmitter: meshPath,
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
