// Main-thread Mitsuba scene loader: parses a Mitsuba 3/2 (or 0.5/0.6,
// upgraded like Mitsuba 3 does) scene .xml plus its .obj meshes into the
// neutral stage payload. THREE.OBJLoader is a window global; the rest is pure.

import { mitsubaMaterialDocument, sanitizeMtlxName } from "./mtlx-material-docs.js";
import { objHasVertexNormals, computeSmoothNormals } from "./obj-stage-loader.js";
import {
  checkAborted, normalizePath, dirOf, basenameOf, toArrayBuffer, resolveScenePath, createWarningSink,
  IDENTITY, mat4Multiply, mat3Determinant, translateMatrix, scaleMatrix, rotateMatrix, bakeMeshTransform,
  cameraLensForFov, sceneCameraRecord, uniformDomeLight, materialEntryFromDocument, bakedMeshRecord, scenePayload,
  parseXml, MITSUBA_VERSION_PATTERN,
} from "./scene-import-common.js";

export { parseXml };

// --------------------------------------------------------- version upgrade

export function parseMitsubaVersion(value) {
  const parts = String(value ?? "").split(".").map((p) => parseInt(p, 10));
  return parts.length && Number.isFinite(parts[0]) ? [parts[0], parts[1] || 0, parts[2] || 0] : null;
}

// Mitsuba 3's camelCase to snake_case rule (xml.cpp upgrade_tree): an
// underscore before each lower-to-upper step, and that capital run lowered.
export function mitsubaSnakeCase(name) {
  let s = String(name);
  for (let i = 0; i < s.length - 1; ++i) {
    if (/[a-z]/.test(s[i]) && /[A-Z]/.test(s[i + 1])) {
      s = s.slice(0, i + 1) + "_" + s.slice(i + 1);
      i += 2;
      while (i < s.length && /[A-Z]/.test(s[i])) { s = s.slice(0, i) + s[i].toLowerCase() + s.slice(i + 1); ++i; }
    }
  }
  return s;
}

// The upgrade Mitsuba 3 applies to pre-2.0 files: snake_case parameter
// names (not <default>), lookAt to lookat, diffuse's diffuse_reflectance to
// reflectance, "_" ids renamed. Texture uoffset/uscale moves are not needed.
export function upgradeMitsubaTree(root, version, warn = () => {}) {
  if (!version || version[0] >= 2) return root;
  const visit = (el, parent) => {
    if (el.name === "lookAt") el.name = "lookat";
    if (el.attrs.name !== undefined && el.name !== "default") el.attrs.name = mitsubaSnakeCase(el.attrs.name);
    if (parent && parent.name === "bsdf" && parent.attrs.type === "diffuse" && el.attrs.name === "diffuse_reflectance") el.attrs.name = "reflectance";
    if (el.attrs.id && el.attrs.id[0] === "_") el.attrs.id = "ID" + el.attrs.id + "__UPGR";
    if (["uoffset", "voffset", "uscale", "vscale"].includes(el.attrs.name)) warn('Mitsuba 0.x texture parameter "' + el.attrs.name + '" is not upgraded, ignored');
    for (const c of el.children) visit(c, el);
  };
  for (const c of root.children) visit(c, root);
  return root;
}

// Replaces $name references in every attribute with <default> values (and
// collects the defaults, which apply in document order).
export function applyMitsubaDefaults(root, warn = () => {}, overrides = {}) {
  const values = { ...overrides };
  const visit = (el) => {
    if (el.name === "default") {
      if (el.attrs.name && values[el.attrs.name] === undefined) values[el.attrs.name] = el.attrs.value ?? "";
      return;
    }
    for (const key of Object.keys(el.attrs)) {
      el.attrs[key] = el.attrs[key].replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, name) => {
        if (values[name] !== undefined) return values[name];
        warn('Reference "$' + name + '" has no <default>, left as is');
        return m;
      });
    }
    for (const c of el.children) visit(c);
  };
  visit(root);
  return values;
}

// ------------------------------------------------------------- properties

const numbersOf = (value) => String(value ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
const PLUGIN_TAGS = new Set(["bsdf", "texture", "emitter", "shape", "sensor", "film", "sampler", "rfilter", "integrator", "medium", "phase", "volume", "spectrum_plugin"]);

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

// Mitsuba's look_at: columns (left, up, dir, origin) with left = up x dir.
export function mitsubaLookAt(origin, target, up) {
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return l ? v.map((c) => c / l) : null; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dir = norm([target[0] - origin[0], target[1] - origin[1], target[2] - origin[2]]);
  if (!dir) throw new Error("lookat: origin and target coincide");
  let left = up ? norm(cross(up, dir)) : null;
  if (!left) {
    // Mitsuba picks an orthogonal up when none (or a parallel one) is given.
    const alt = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    left = norm(cross(alt, dir));
  }
  const newUp = cross(dir, left);
  return [left[0], left[1], left[2], 0, newUp[0], newUp[1], newUp[2], 0, dir[0], dir[1], dir[2], 0, origin[0], origin[1], origin[2], 1];
}

// "value" (one or three numbers) or x/y/z attributes, as expand_value_to_xyz.
function xyzOf(el, fallback) {
  if (el.attrs.value !== undefined) {
    const v = numbersOf(el.attrs.value);
    if (v.length === 1) return [v[0], v[0], v[0]];
    if (v.length === 3) return v;
    throw new Error("<" + el.name + '> value must have 1 or 3 numbers: "' + el.attrs.value + '"');
  }
  return ["x", "y", "z"].map((k) => (el.attrs[k] !== undefined ? Number(el.attrs[k]) : fallback));
}

// A <transform> block: each operation left-multiplies the matrix so far.
export function mitsubaTransform(el, warn = () => {}) {
  let m = IDENTITY.slice();
  for (const op of el.children) {
    let t;
    if (op.name === "translate") { const v = xyzOf(op, 0); t = translateMatrix(v[0], v[1], v[2]); }
    else if (op.name === "scale") { const v = xyzOf(op, 1); t = scaleMatrix(v[0], v[1], v[2]); }
    else if (op.name === "rotate") { const v = xyzOf(op, 0); t = rotateMatrix(Number(op.attrs.angle) || 0, v[0], v[1], v[2]); }
    else if (op.name === "lookat") {
      const up = op.attrs.up !== undefined ? numbersOf(op.attrs.up) : null;
      t = mitsubaLookAt(numbersOf(op.attrs.origin), numbersOf(op.attrs.target), up);
    } else if (op.name === "matrix") {
      const v = numbersOf(op.attrs.value);
      if (v.length === 16) t = [0, 1, 2, 3].flatMap((c) => [v[c], v[4 + c], v[8 + c], v[12 + c]]); // row-major in, column-major out
      else if (v.length === 9) t = [v[0], v[3], v[6], 0, v[1], v[4], v[7], 0, v[2], v[5], v[8], 0, 0, 0, 0, 1];
      else throw new Error("matrix: expected 16 or 9 values, got " + v.length);
    } else { warn("Transform operation <" + op.name + "> is not supported, ignored"); continue; }
    m = mat4Multiply(t, m);
  }
  return m;
}

// Reads a plugin element: typed properties by name, nested plugins, and
// unnamed <ref id> children. Values: { type, value } with rgb as [r, g, b].
export function readMitsubaPlugin(el, warn = () => {}) {
  const props = {};
  const children = [];
  const refs = [];
  for (const c of el.children) {
    const name = c.attrs.name;
    const v = c.attrs.value;
    switch (c.name) {
      case "float": props[name] = { type: "float", value: Number(v) }; break;
      case "integer": props[name] = { type: "integer", value: parseInt(v, 10) }; break;
      case "boolean": props[name] = { type: "boolean", value: String(v).trim().toLowerCase() === "true" }; break;
      case "string": props[name] = { type: "string", value: String(v ?? "") }; break;
      case "rgb":
      case "color":
      case "srgb": {
        let rgb = numbersOf(v);
        if (rgb.length === 1) rgb = [rgb[0], rgb[0], rgb[0]];
        if (c.name === "srgb") rgb = rgb.map((x) => (x > 1 ? srgbToLinear(x / 255) : srgbToLinear(x)));
        props[name] = rgb.length === 3 ? { type: "rgb", value: rgb } : { type: "invalid", value: v };
        break;
      }
      case "spectrum": {
        if (c.attrs.filename !== undefined) { props[name] = { type: "spectral file", value: c.attrs.filename }; break; }
        const tokens = String(v ?? "").split(/[\s,]+/).filter(Boolean);
        if (tokens.length === 1 && !tokens[0].includes(":")) props[name] = { type: "float", value: Number(tokens[0]) };
        else props[name] = { type: "sampled spectrum", value: v };
        break;
      }
      case "blackbody": props[name] = { type: "blackbody", value: c.attrs.temperature }; break;
      case "point":
      case "vector": props[name] = { type: c.name, value: c.attrs.value !== undefined ? numbersOf(c.attrs.value) : ["x", "y", "z"].map((k) => Number(c.attrs[k] || 0)) }; break;
      case "transform": props[name] = { type: "transform", value: mitsubaTransform(c, warn) }; break;
      case "ref":
        if (name) props[name] = { type: "ref", value: c.attrs.id };
        else refs.push(c.attrs.id);
        break;
      default:
        if (PLUGIN_TAGS.has(c.name)) {
          children.push(c);
          if (c.name === "texture" && name) props[name] = { type: "texture", plugin: c.attrs.type, value: null };
        } else if (c.name !== "default") {
          warn("Element <" + c.name + "> is not supported, ignored");
        }
    }
  }
  return { tag: el.name, type: el.attrs.type || "", id: el.attrs.id, props, children, refs };
}

// --------------------------------------------------------------- the scene

// rgb radiance from an emitter property (float and rgb kept literally).
function mitsubaRadiance(prop, warn) {
  if (!prop) return [1, 1, 1];
  if (prop.type === "rgb") return prop.value.slice(0, 3);
  if (prop.type === "float") return [prop.value, prop.value, prop.value];
  warn("Emitter radiance given as a " + prop.type + " is not supported, white is used");
  return [1, 1, 1];
}

// Mitsuba's fov parsing: fov plus fov_axis (default x), or a 35 mm
// equivalent focal_length ("50mm" default) measured on the diagonal.
export function mitsubaFov(props) {
  if (props.fov) return { fov: Number(props.fov.value), axis: props.fov_axis ? String(props.fov_axis.value).toLowerCase() : "x" };
  const f = props.focal_length ? parseFloat(String(props.focal_length.value)) : 50;
  const fov = (2 * Math.atan(Math.hypot(36, 24) / (2 * (f > 0 ? f : 50))) * 180) / Math.PI;
  return { fov, axis: "diagonal" };
}

// Our camera-to-world (looking down -z, +x right) from Mitsuba's to_world
// (looking down +z, +x to the image left): flip x and z, no world mirror.
// Scale is dropped; a mirroring to_world keeps its view but not the flip.
export function mitsubaCameraMatrix(toWorld) {
  const m = mat4Multiply(toWorld, scaleMatrix(-1, 1, -1));
  const sign = mat3Determinant(m) < 0 ? -1 : 1;
  for (let c = 0; c < 3; c++) {
    const len = (Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]) || 1) * (c === 0 ? sign : 1);
    for (let r = 0; r < 3; r++) m[c * 4 + r] /= len;
  }
  return m;
}

// Mitsuba's rectangle: [-1, 1]^2 in the local xy plane, normal +z.
export function rectangleArrays() {
  return {
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

// Flat per-corner normals of an indexed triangle mesh (face_normals=true):
// the mesh is split so no vertex is shared between faces.
export function flatShadedArrays({ positions, uvs, indices }) {
  const triCount = Math.floor(indices.length / 3);
  const p = new Float32Array(triCount * 9);
  const n = new Float32Array(triCount * 9);
  const t = uvs ? new Float32Array(triCount * 6) : null;
  for (let f = 0; f < triCount; f++) {
    const ids = [indices[f * 3], indices[f * 3 + 1], indices[f * 3 + 2]];
    ids.forEach((v, c) => { for (let k = 0; k < 3; k++) p[f * 9 + c * 3 + k] = positions[v * 3 + k]; if (t) { t[f * 6 + c * 2] = uvs[v * 2]; t[f * 6 + c * 2 + 1] = uvs[v * 2 + 1]; } });
    const o = f * 9;
    const ax = p[o + 3] - p[o], ay = p[o + 4] - p[o + 1], az = p[o + 5] - p[o + 2];
    const bx = p[o + 6] - p[o], by = p[o + 7] - p[o + 1], bz = p[o + 8] - p[o + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    for (let c = 0; c < 3; c++) { n[o + c * 3] = nx / len; n[o + c * 3 + 1] = ny / len; n[o + c * 3 + 2] = nz / len; }
  }
  return { positions: p, normals: n, uvs: t, indices: Uint32Array.from({ length: triCount * 3 }, (_, i) => i) };
}

const IGNORED_TOP_LEVEL = new Set(["default", "integrator"]);
const BSDF_WRAPPERS = new Set(["bumpmap", "normalmap", "mask"]);

// Interprets the parsed <scene> into shapes, bsdfs, camera, film and
// constant environments. Returns { version, legacy, shapes, camera, film,
// environments }; warn(message) collects warnings.
export function interpretMitsubaScene(rootEl, warn = () => {}) {
  if (!rootEl || rootEl.name !== "scene") throw new Error("Not a Mitsuba scene: the root element is <" + (rootEl ? rootEl.name : "none") + ">, expected <scene>");
  // Mitsuba requires the version attribute (see MITSUBA_VERSION_PATTERN).
  if (!MITSUBA_VERSION_PATTERN.test(String(rootEl.attrs.version || "").trim())) throw new Error("Not a Mitsuba scene: the <scene> has no valid version attribute");
  const version = parseMitsubaVersion(rootEl.attrs.version);
  if (version[0] > 3) warn("Mitsuba scene version " + version.join(".") + " is newer than 3.x; it is read as 3.x");
  upgradeMitsubaTree(rootEl, version, warn);
  if (version[0] < 2) warn("[info] Mitsuba " + version.join(".") + " scene upgraded to the 3.x parameter names");
  applyMitsubaDefaults(rootEl, warn);

  const byId = new Map();
  const register = (el) => { if (el.attrs.id) byId.set(el.attrs.id, el); };
  for (const c of rootEl.children) register(c);
  const legacy = version[0] < 2;

  // Resolves a bsdf element (or ref id) into { key, label, bsdf, twoSided }.
  const resolveBsdf = (el, refId) => {
    let node = el;
    if (!node && refId) {
      node = byId.get(refId);
      if (!node) { warn('Reference to an undefined id "' + refId + '", a grey diffuse is used'); return null; }
      if (node.name !== "bsdf") { warn('Reference "' + refId + '" is a <' + node.name + ">, not a bsdf; a grey diffuse is used"); return null; }
    }
    const label = node.attrs.id || null;
    let twoSided = false;
    for (let depth = 0; depth < 8; depth++) {
      const plugin = readMitsubaPlugin(node, warn);
      const inner = plugin.children.filter((c) => c.name === "bsdf").concat(plugin.refs.map((id) => byId.get(id)).filter((e) => e && e.name === "bsdf"));
      if (plugin.type === "twosided") {
        twoSided = true;
        if (inner.length > 1) warn("twosided with two different bsdfs: the front one is used on both faces");
        if (!inner.length) { warn("twosided without a nested bsdf, a grey diffuse is used"); return { label, twoSided, bsdf: { type: "diffuse", props: {} }, key: "el:" + (label || JSON.stringify(node)) }; }
        node = inner[0];
        continue;
      }
      if (BSDF_WRAPPERS.has(plugin.type) && inner.length) {
        warn('bsdf "' + plugin.type + '" needs textures, which are not imported; its nested bsdf is used');
        node = inner[0];
        continue;
      }
      return { label: label || node.attrs.id || null, twoSided, bsdf: { type: plugin.type, props: plugin.props }, key: label ? "id:" + label : "inline:" + twoSided + ":" + JSON.stringify(plugin.props) + plugin.type };
    }
    throw new Error("bsdf nesting is too deep");
  };

  const scene = { version, legacy, shapes: [], camera: null, film: { width: 768, height: 576 }, environments: [] };
  for (const el of rootEl.children) {
    if (IGNORED_TOP_LEVEL.has(el.name) || el.name === "bsdf" || el.name === "texture") continue;
    if (el.name === "sensor") {
      if (scene.camera) { warn("More than one <sensor>; the first is used"); continue; }
      const plugin = readMitsubaPlugin(el, warn);
      if (plugin.type !== "perspective" && plugin.type !== "thinlens") warn('Sensor "' + plugin.type + '" is not supported, it is imported as a perspective camera');
      if (plugin.type === "thinlens") warn("thinlens depth of field is not imported, a pinhole camera is used");
      const film = plugin.children.find((c) => c.name === "film");
      if (film) {
        const fp = readMitsubaPlugin(film, () => {}).props;
        if (fp.width) scene.film.width = Number(fp.width.value) || scene.film.width;
        if (fp.height) scene.film.height = Number(fp.height.value) || scene.film.height;
      }
      const toWorld = plugin.props.to_world;
      scene.camera = { type: plugin.type, toWorld: toWorld ? toWorld.value : IDENTITY.slice(), ...mitsubaFov(plugin.props), focusDistance: plugin.props.focus_distance ? Number(plugin.props.focus_distance.value) : 0 };
      continue;
    }
    if (el.name === "emitter") {
      const plugin = readMitsubaPlugin(el, warn);
      if (plugin.type === "constant") scene.environments.push(mitsubaRadiance(plugin.props.radiance, warn));
      else warn('Emitter "' + plugin.type + '" is not supported, skipped');
      continue;
    }
    if (el.name === "shape") {
      const plugin = readMitsubaPlugin(el, warn);
      if (plugin.type !== "obj" && plugin.type !== "rectangle") { warn('Shape "' + plugin.type + '" is not supported, skipped'); continue; }
      const bsdfEl = plugin.children.find((c) => c.name === "bsdf");
      const bsdfRef = plugin.refs.find((id) => { const t = byId.get(id); return !t || t.name === "bsdf"; });
      for (const id of plugin.refs) { const t = byId.get(id); if (t && t.name !== "bsdf") warn("Shape reference to a <" + t.name + '> ("' + id + '") is not supported, ignored'); }
      if (plugin.props.bsdf && plugin.props.bsdf.type === "ref" && !bsdfRef) warn("Named bsdf references are read as unnamed ones");
      const material = (bsdfEl || bsdfRef || (plugin.props.bsdf && plugin.props.bsdf.type === "ref"))
        ? resolveBsdf(bsdfEl, bsdfRef || (plugin.props.bsdf && plugin.props.bsdf.value))
        : null;
      const emitterEl = plugin.children.find((c) => c.name === "emitter");
      let emission = null;
      if (emitterEl) {
        const ep = readMitsubaPlugin(emitterEl, warn);
        if (ep.type === "area") emission = mitsubaRadiance(ep.props.radiance, warn);
        else warn('Shape emitter "' + ep.type + '" is not supported, skipped');
      }
      for (const c of plugin.children) if (c.name !== "bsdf" && c.name !== "emitter") warn("Shape child <" + c.name + "> is not supported, ignored");
      const p = plugin.props;
      scene.shapes.push({
        kind: plugin.type, id: plugin.id || null,
        filename: p.filename ? p.filename.value : null,
        toWorld: p.to_world ? p.to_world.value : IDENTITY.slice(),
        faceNormals: !!(p.face_normals && p.face_normals.value),
        flipNormals: !!(p.flip_normals && p.flip_normals.value),
        material, emission,
      });
      continue;
    }
    if (el.name === "include") { warn('<include> of "' + (el.attrs.filename || "") + '" is not supported, skipped'); continue; }
    if (el.name === "medium") { warn("<medium> (participating media) is not supported, skipped"); continue; }
    warn("Element <" + el.name + "> is not supported, skipped");
  }
  return scene;
}

// ------------------------------------------------------------------ meshes

// Default OBJ decoder: three r128's OBJLoader (the same parser the OBJ
// loader uses); every mesh and group is merged, mtllib/usemtl are ignored.
function decodeObjWithThree(text) {
  if (typeof THREE === "undefined" || typeof THREE.OBJLoader === "undefined") throw new Error("OBJLoader unavailable in this build.");
  const container = new THREE.OBJLoader().parse(text);
  const parts = [];
  container.traverse((object) => {
    if (!object.isMesh) return;
    const g = object.geometry;
    const pos = g && g.getAttribute && g.getAttribute("position");
    if (!pos || !pos.count) return;
    const nrm = g.getAttribute("normal");
    const uv = g.getAttribute("uv");
    parts.push({ p: pos.array, n: nrm ? nrm.array : null, t: uv ? uv.array : null, count: pos.count });
  });
  const total = parts.reduce((s, x) => s + x.count, 0);
  const positions = new Float32Array(total * 3);
  const normals = parts.every((x) => x.n) ? new Float32Array(total * 3) : null;
  const uvs = parts.every((x) => x.t) ? new Float32Array(total * 2) : null;
  let o = 0;
  for (const x of parts) {
    positions.set(x.p.subarray(0, x.count * 3), o * 3);
    if (normals) normals.set(x.n.subarray(0, x.count * 3), o * 3);
    if (uvs) uvs.set(x.t.subarray(0, x.count * 2), o * 2);
    o += x.count;
  }
  return { positions, normals, uvs, indices: Uint32Array.from({ length: total }, (_, i) => i) };
}

// ------------------------------------------------------------------- loader

// options.decodeObj(text) overrides the browser default (THREE.OBJLoader),
// which lets Node tests run the loader without THREE.
export async function loadMitsubaStage({ files, rootPath, signal, onProgress, decodeObj } = {}) {
  const report = (phase, done, total, message) => {
    if (typeof onProgress === "function") onProgress({ phase, done, total, fraction: total > 0 ? done / total : 0, message });
  };
  const fileByPath = new Map();
  for (const entry of Array.isArray(files) ? files : []) {
    if (entry && entry.path) fileByPath.set(normalizePath(entry.path), entry);
  }
  const root = normalizePath(rootPath);
  if (!fileByPath.has(root)) throw new Error("Root Mitsuba file not found: " + root);
  const decode = typeof decodeObj === "function" ? decodeObj : decodeObjWithThree;
  const { warnings, warn } = createWarningSink();
  const rootDir = dirOf(root);
  const readText = async (path) => {
    checkAborted(signal);
    return new TextDecoder().decode(await toArrayBuffer(fileByPath.get(path).data));
  };

  report("parse", 0, 1, "Reading " + basenameOf(root));
  const scene = interpretMitsubaScene(parseXml(await readText(root)), warn);
  report("parse", 1, 1, "Parsed " + basenameOf(root));

  const usedMaterialNames = new Set();
  const materialEntries = [];
  const materialPathByKey = new Map();
  const materialPathFor = (material, emission) => {
    const resolved = material || { label: null, key: "default", bsdf: { type: "diffuse", props: {} }, twoSided: false };
    const key = resolved.key + "|" + (emission ? emission.join(",") : "");
    if (materialPathByKey.has(key)) return materialPathByKey.get(key);
    const label = resolved.label || "mitsuba_" + resolved.bsdf.type;
    const name = sanitizeMtlxName(emission ? label + "_emissive" : label, usedMaterialNames);
    const doc = mitsubaMaterialDocument({ name, bsdf: resolved.bsdf, emission, legacy: scene.legacy });
    for (const note of doc.notes) warn(label + ": " + note);
    const entry = materialEntryFromDocument(doc, name, "mitsuba");
    materialEntries.push(entry);
    materialPathByKey.set(key, entry.path);
    return entry.path;
  };

  const objCache = new Map();
  const readObj = async (path) => {
    if (objCache.has(path)) return objCache.get(path);
    const text = await readText(path);
    const decoded = decode(text);
    if (!decoded.normals || !objHasVertexNormals(text)) decoded.normals = null; // OBJLoader fills flat normals when vn is absent
    objCache.set(path, decoded);
    return decoded;
  };

  const meshRecords = [];
  const usedPrimNames = new Set();
  let emitterCount = 0;
  let smoothed = 0;
  const total = scene.shapes.length;
  report("extract-geometry", 0, total, "Reading meshes");
  for (let s = 0; s < total; s++) {
    checkAborted(signal);
    const shape = scene.shapes[s];
    let arrays;
    let label = shape.id;
    try {
      if (shape.kind === "obj") {
        if (!shape.filename) { warn('Shape "obj" without a filename skipped'); continue; }
        const resolved = resolveScenePath(shape.filename, rootDir, rootDir, fileByPath);
        if (!resolved) { warn('OBJ file not found: "' + shape.filename + '" (drop the models folder together with the scene)'); continue; }
        arrays = await readObj(resolved);
        label = label || basenameOf(shape.filename).replace(/\.obj$/i, "");
      } else {
        arrays = rectangleArrays();
        label = label || "rectangle";
      }
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      warn("Shape skipped: " + ((e && e.message) || e));
      continue;
    }
    if (shape.faceNormals) arrays = flatShadedArrays(arrays);
    else if (!arrays.normals) {
      // Mitsuba recomputes smooth vertex normals with no crease angle.
      arrays = { ...arrays, normals: computeSmoothNormals(arrays.positions, { creaseAngleDeg: 180 }) };
      smoothed++;
    }
    const baked = bakeMeshTransform(arrays, shape.toWorld, shape.flipNormals);
    if (shape.emission) emitterCount++;
    const primName = sanitizeMtlxName(shape.emission ? label + "_light" : label, usedPrimNames);
    meshRecords.push(bakedMeshRecord({
      primName, positions: baked.positions, normals: baked.normals,
      uvs: arrays.uvs ? Float32Array.from(arrays.uvs) : null, indices: baked.indices,
      materialPath: materialPathFor(shape.material, shape.emission),
      doubleSided: !!(shape.material && shape.material.twoSided),
    }));
    report("extract-geometry", s + 1, total, "Reading meshes");
  }
  if (!meshRecords.length) throw new Error("No renderable meshes in " + root);

  const cameras = [];
  if (scene.camera) {
    const aspect = scene.film.width / scene.film.height;
    if (mat3Determinant(scene.camera.toWorld) < 0) warn("The sensor to_world mirrors the image; the camera is imported unmirrored");
    cameras.push(sceneCameraRecord({
      matrix: mitsubaCameraMatrix(scene.camera.toWorld),
      lens: cameraLensForFov(scene.camera.fov, aspect, scene.camera.axis),
      focusDistance: scene.camera.focusDistance,
    }));
  }

  const lights = [];
  scene.environments.forEach((color, i) => {
    if (i > 0) { warn("More than one constant emitter; only the first is used"); return; }
    lights.push(uniformDomeLight(color));
  });

  if (smoothed) warn("[info] " + smoothed + " OBJ mesh(es) without normals got smooth normals computed");
  if (emitterCount) warn("[info] " + emitterCount + " area light(s) emit from both faces here (Mitsuba emits from the front face only)");
  warn("[info] Mitsuba " + scene.version.join(".") + " scene: " + meshRecords.length + " mesh(es), " + emitterCount + " area light emitter(s), no axis mirror needed");

  report("extract-materials", 1, 1, "Extracted materials");
  report("prepare-geometry", 1, 1, "Prepared geometry");
  return scenePayload({ rootPath: root, sourceKind: "mitsuba", meshes: meshRecords, materials: materialEntries, cameras, lights, warnings });
}
