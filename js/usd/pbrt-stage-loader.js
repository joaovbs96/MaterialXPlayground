// Main-thread pbrt-v4 scene loader: parses a .pbrt file (plus Include/Import
// and plymesh files, .ply.gz too) into the neutral stage payload. THREE and
// THREE.PLYLoader are window globals here; the parser parts are pure.

import { pbrtMaterialDocument, sanitizeMtlxName } from "./mtlx-material-docs.js";

function checkAborted(signal) {
  if (signal && signal.aborted) {
    const err = new Error("Aborted");
    err.name = "AbortError";
    throw err;
  }
}

const normalizePath = (path) => String(path ?? "").replace(/\\/g, "/");
const dirOf = (path) => { const p = normalizePath(path); const i = p.lastIndexOf("/"); return i === -1 ? "" : p.slice(0, i); };
const basenameOf = (path) => normalizePath(path).split("/").pop();

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

async function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  if (data && typeof data.arrayBuffer === "function") return await data.arrayBuffer();
  throw new Error("Unsupported file data");
}

// ---------------------------------------------------------------- tokenizer

// Tokens: { t: "str" | "num" | "id" | "[" | "]", v }. Comments run from an
// unquoted "#" to the end of the line.
export function tokenizePbrt(text) {
  const src = String(text ?? "");
  const tokens = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v") { i++; continue; }
    if (c === "#") { while (i < n && src[i] !== "\n" && src[i] !== "\r") i++; continue; }
    if (c === "[" || c === "]") { tokens.push({ t: c }); i++; continue; }
    if (c === '"') {
      let s = "";
      i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === "\\" && i + 1 < n) {
          const e = src[i + 1];
          s += e === "n" ? "\n" : e === "t" ? "\t" : e;
          i += 2;
          continue;
        }
        s += src[i++];
      }
      if (i >= n) throw new Error("Unterminated string in pbrt file");
      i++;
      tokens.push({ t: "str", v: s });
      continue;
    }
    let j = i;
    while (j < n && !/[\s"[\]#]/.test(src[j])) j++;
    const word = src.slice(i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(word)) tokens.push({ t: "num", v: parseFloat(word) });
    else tokens.push({ t: "id", v: word });
  }
  return tokens;
}

// Positional string arguments before the parameter list, per directive.
const PBRT_POSITIONAL_STRINGS = {
  Texture: 3, MediumInterface: 2,
  Attribute: 1, Accelerator: 1, Camera: 1, Film: 1, Integrator: 1, PixelFilter: 1, Sampler: 1,
  ColorSpace: 1, MakeNamedMaterial: 1, Material: 1, NamedMaterial: 1, Shape: 1, LightSource: 1,
  AreaLightSource: 1, Include: 1, Import: 1, ObjectBegin: 1, ObjectInstance: 1,
  CoordinateSystem: 1, CoordSysTransform: 1, MakeNamedMedium: 1, ActiveTransform: 0, Option: 0,
};
const PBRT_NUMERIC = { Transform: 16, ConcatTransform: 16, Translate: 3, Scale: 3, Rotate: 4, LookAt: 9, TransformTimes: 2 };

// Groups tokens into directives { name, args, params }. params maps a
// parameter name to { type, values }; bare true/false become booleans.
export function parsePbrtDirectives(tokens) {
  const out = [];
  let i = 0;
  const value = (tok) => (tok.t === "id" && (tok.v === "true" || tok.v === "false") ? tok.v === "true" : tok.v);
  const isWordValue = (tok) => tok && tok.t === "id" && (tok.v === "true" || tok.v === "false");
  while (i < tokens.length) {
    const tok = tokens[i++];
    if (tok.t !== "id") throw new Error("Unexpected " + (tok.t === "str" ? '"' + tok.v + '"' : tok.t === "num" ? String(tok.v) : tok.t) + " in pbrt file, expected a directive");
    const name = tok.v;
    const directive = { name, args: [], params: {} };
    if (PBRT_NUMERIC[name] !== undefined) {
      let bracket = false;
      if (tokens[i] && tokens[i].t === "[") { bracket = true; i++; }
      while (tokens[i] && tokens[i].t === "num") directive.args.push(tokens[i++].v);
      if (bracket) { if (!tokens[i] || tokens[i].t !== "]") throw new Error(name + ": expected ]"); i++; }
      if (directive.args.length !== PBRT_NUMERIC[name]) throw new Error(name + " expects " + PBRT_NUMERIC[name] + " numbers, got " + directive.args.length);
      out.push(directive);
      continue;
    }
    let positional = PBRT_POSITIONAL_STRINGS[name] ?? 0;
    while (positional > 0 && tokens[i] && tokens[i].t === "str") { directive.args.push(tokens[i++].v); positional--; }
    // Parameter list: "type name" followed by a bracketed list or one value.
    while (tokens[i] && tokens[i].t === "str") {
      const decl = tokens[i++].v.trim().split(/\s+/);
      if (decl.length !== 2) throw new Error(name + ': malformed parameter "' + decl.join(" ") + '"');
      const values = [];
      const next = tokens[i];
      if (next && next.t === "[") {
        i++;
        while (tokens[i] && tokens[i].t !== "]") {
          const v = tokens[i++];
          if (v.t === "[") throw new Error(name + ": nested [ in parameter " + decl[1]);
          values.push(value(v));
        }
        if (!tokens[i]) throw new Error(name + ": missing ] after parameter " + decl[1]);
        i++;
      } else if (next && (next.t === "num" || next.t === "str" || isWordValue(next))) {
        values.push(value(next));
        i++;
      } else {
        throw new Error(name + ": parameter " + decl[1] + " has no value");
      }
      let type = decl[0];
      if (type === "point") type = "point3";
      if (type === "normal3") type = "normal";
      if (type === "vector") type = "vector3";
      if (type === "color") type = "rgb";
      if (type === "bool") for (let k = 0; k < values.length; k++) if (values[k] === "true" || values[k] === "false") values[k] = values[k] === "true";
      directive.params[decl[1]] = { type, values };
    }
    out.push(directive);
  }
  return out;
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
  if (!det) throw new Error("Singular transform in pbrt file");
  return inv.map((v) => v / det);
}

// Determinant of the upper-left 3x3 (the sign tells whether a transform
// swaps handedness).
export function mat3Determinant(m) {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

export function translateMatrix(x, y, z) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; }
export function scaleMatrix(x, y, z) { return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]; }

// pbrt's Rotate(theta degrees, axis): the usual right-hand-rule matrix.
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

// pbrt's LookAt: cameraFromWorld for a camera at eye looking at look,
// built as the inverse of the frame (right, up, dir, eye).
export function lookAtMatrix(ex, ey, ez, lx, ly, lz, ux, uy, uz) {
  const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]); if (!l) throw new Error("LookAt: degenerate vector"); return v.map((c) => c / l); };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dir = norm([lx - ex, ly - ey, lz - ez]);
  const right = norm(cross(norm([ux, uy, uz]), dir));
  const up = cross(dir, right);
  return mat4Invert([right[0], right[1], right[2], 0, up[0], up[1], up[2], 0, dir[0], dir[1], dir[2], 0, ex, ey, ez, 1]);
}

// `Transform [16]` lists pbrt's matrix column by column, which is exactly
// this column-major layout (pbrt transposes its row-major read).
export function pbrtTransformMatrix(values) { return values.slice(0, 16).map(Number); }

// ---------------------------------------------------------------- handedness

// pbrt cameras see +z with +x right and +y up; ours see -z. One world axis
// (Z) is mirrored when the camera frame is proper (det > 0, a left-handed
// pbrt scene); scenes whose camera already flips (det < 0) need none.
export function pbrtHandedness(cameraFromWorld) {
  const det = cameraFromWorld ? mat3Determinant(cameraFromWorld) : 1;
  const mirror = det > 0;
  return { mirror, axis: mirror ? "Z" : null, matrix: mirror ? scaleMatrix(1, 1, -1) : IDENTITY.slice() };
}

// USD-style camera-to-world matrix: worldMirror * worldFromCamera * flipZ,
// so the pbrt +z view direction becomes the camera's -z.
export function pbrtCameraMatrix(cameraFromWorld, worldMirror) {
  return mat4Multiply(mat4Multiply(worldMirror, mat4Invert(cameraFromWorld)), scaleMatrix(1, 1, -1));
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

// pbrt's perspective fov spans the shorter image axis. Returns a USD-style
// lens (36 mm wide aperture, height from the aspect, focal length solved).
export function pbrtCameraLens(fovDeg, aspect) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1280 / 720;
  const fov = ((Number.isFinite(fovDeg) && fovDeg > 0 ? fovDeg : 90) * Math.PI) / 180;
  const horizontalAperture = HORIZONTAL_APERTURE_MM;
  const verticalAperture = horizontalAperture / a;
  const shorter = Math.min(horizontalAperture, verticalAperture);
  const focalLength = shorter / 2 / Math.tan(fov / 2);
  return { horizontalAperture, verticalAperture, focalLength };
}

// ------------------------------------------------------------------ parsing

// Resolves a file reference: next to the referencing file, then next to
// the root file (pbrt's own search directory), then a unique basename.
export function resolvePbrtPath(ref, fromDir, rootDir, fileByPath) {
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

const IGNORED_DIRECTIVES = new Set(["Integrator", "Sampler", "PixelFilter", "Accelerator", "Option", "TransformTimes", "WorldEnd"]);

// Walks the directive stream of the root file (and its Include/Import
// files) and returns the scene description: shapes with their transform,
// material and area light, named materials, camera, film and lights.
// readText(path) returns a file's text, resolve(ref, dir) a file path or
// null, warn(message) collects warnings.
export async function interpretPbrtScene({ rootPath, readText, resolve, warn }) {
  const scene = {
    film: { xresolution: 1280, yresolution: 720 },
    camera: null,
    namedMaterials: new Map(),
    shapes: [],
    infiniteLights: [],
  };
  let state = { ctm: IDENTITY.slice(), material: { type: "diffuse", params: {} }, areaLight: null, reverseOrientation: false };
  const stack = [];
  const coordSystems = new Map();
  let inObject = 0;
  let worldBegun = false;
  const visiting = [];

  const concat = (m) => { state.ctm = mat4Multiply(state.ctm, m); };

  const runFile = async (path) => {
    if (visiting.includes(path)) throw new Error("Include cycle: " + visiting.concat(path).join(" -> "));
    visiting.push(path);
    const text = await readText(path);
    const directives = parsePbrtDirectives(tokenizePbrt(text));
    const here = dirOf(path);
    for (const d of directives) {
      const a = d.args;
      switch (d.name) {
        case "Include":
        case "Import": {
          const target = resolve(a[0], here);
          if (!target) { warn(d.name + ' file not found: "' + a[0] + '" (drop it together with the scene)'); break; }
          await runFile(target);
          break;
        }
        case "Transform": state.ctm = pbrtTransformMatrix(a); break;
        case "ConcatTransform": concat(pbrtTransformMatrix(a)); break;
        case "Translate": concat(translateMatrix(a[0], a[1], a[2])); break;
        case "Scale": concat(scaleMatrix(a[0], a[1], a[2])); break;
        case "Rotate": concat(rotateMatrix(a[0], a[1], a[2], a[3])); break;
        case "LookAt": concat(lookAtMatrix(...a)); break;
        case "Identity": state.ctm = IDENTITY.slice(); break;
        case "CoordinateSystem": coordSystems.set(a[0], state.ctm.slice()); warn("[info] CoordinateSystem \"" + a[0] + "\" is used"); break;
        case "CoordSysTransform":
          if (coordSystems.has(a[0])) { state.ctm = coordSystems.get(a[0]).slice(); warn("[info] CoordSysTransform \"" + a[0] + "\" is used"); }
          else warn('CoordSysTransform to an unknown coordinate system "' + a[0] + '" ignored');
          break;
        case "ActiveTransform": warn("ActiveTransform (motion blur) is not supported; transforms apply to both times"); break;
        case "Film": {
          const xr = d.params.xresolution, yr = d.params.yresolution;
          if (xr) scene.film.xresolution = Number(xr.values[0]) || scene.film.xresolution;
          if (yr) scene.film.yresolution = Number(yr.values[0]) || scene.film.yresolution;
          break;
        }
        case "Camera": {
          const fov = d.params.fov ? Number(d.params.fov.values[0]) : 90;
          scene.camera = { type: a[0], fov, cameraFromWorld: state.ctm.slice(), params: d.params };
          coordSystems.set("camera", mat4Invert(state.ctm));
          if (a[0] !== "perspective") warn('Camera "' + a[0] + '" is not supported, it is imported as a perspective camera');
          break;
        }
        case "WorldBegin":
          worldBegun = true;
          state.ctm = IDENTITY.slice();
          coordSystems.set("world", IDENTITY.slice());
          break;
        case "AttributeBegin":
        case "TransformBegin":
          stack.push({ kind: d.name, state: { ...state, ctm: state.ctm.slice() } });
          break;
        case "AttributeEnd":
        case "TransformEnd": {
          const top = stack.pop();
          if (!top) { warn("Unmatched " + d.name + " ignored"); break; }
          if (d.name === "TransformEnd" || top.kind === "TransformBegin") state.ctm = top.state.ctm;
          else state = top.state;
          break;
        }
        case "ReverseOrientation": state.reverseOrientation = !state.reverseOrientation; break;
        case "MakeNamedMaterial": {
          const typeParam = d.params.type;
          const type = typeParam ? String(typeParam.values[0]) : "";
          if (!type) warn('MakeNamedMaterial "' + a[0] + '" has no "string type", a grey diffuse is used');
          const params = { ...d.params };
          delete params.type;
          scene.namedMaterials.set(a[0], { type: type || "diffuse", params });
          break;
        }
        case "Material": state.material = { type: a[0] || "diffuse", params: d.params }; break;
        case "NamedMaterial": state.material = { named: a[0] }; break;
        case "AreaLightSource": {
          if (a[0] !== "diffuse") { warn('AreaLightSource "' + a[0] + '" is not supported, skipped'); state.areaLight = null; break; }
          state.areaLight = { params: d.params };
          break;
        }
        case "LightSource": {
          if (a[0] === "infinite" && !d.params.filename) scene.infiniteLights.push({ params: d.params, ctm: state.ctm.slice() });
          else if (a[0] === "infinite") warn('LightSource "infinite" with an environment map ("' + d.params.filename.values[0] + '") is not supported, skipped');
          else warn('LightSource "' + a[0] + '" is not supported, skipped');
          break;
        }
        case "Shape": {
          if (inObject) break;
          if (a[0] !== "plymesh" && a[0] !== "trianglemesh") { warn('Shape "' + a[0] + '" is not supported, skipped'); break; }
          scene.shapes.push({
            kind: a[0], params: d.params, dir: here, ctm: state.ctm.slice(),
            material: state.material, areaLight: state.areaLight, reverseOrientation: state.reverseOrientation,
          });
          break;
        }
        case "ObjectBegin": inObject++; warn("ObjectBegin/ObjectInstance (instancing) is not supported, object \"" + a[0] + "\" skipped"); break;
        case "ObjectEnd": inObject = Math.max(0, inObject - 1); break;
        case "ObjectInstance": warn('ObjectInstance "' + a[0] + '" is not supported, skipped'); break;
        case "Texture": warn('Texture "' + a[0] + '" is not supported, skipped'); break;
        case "MakeNamedMedium":
        case "MediumInterface": warn(d.name + " (participating media) is not supported, ignored"); break;
        case "Attribute": warn('Attribute "' + a[0] + '" defaults are not supported, ignored'); break;
        case "ColorSpace": warn('ColorSpace "' + a[0] + '" is not supported, values are read as linear sRGB'); break;
        default:
          if (!IGNORED_DIRECTIVES.has(d.name)) warn('Unknown pbrt directive "' + d.name + '" ignored');
      }
    }
    visiting.pop();
  };

  await runFile(normalizePath(rootPath));
  if (!worldBegun) warn("The file has no WorldBegin");
  return scene;
}

// Area light radiance: rgb L times scale, taken literally (pbrt-v4 divides
// by the illuminant's photometric value, which keeps rgb L as rgb radiance).
export function pbrtAreaLightRadiance(params, warn) {
  const p = params || {};
  let rgb = [1, 1, 1];
  if (p.L && (p.L.type === "rgb" || p.L.type === "float")) {
    const v = p.L.values.map(Number);
    rgb = p.L.type === "float" ? [v[0], v[0], v[0]] : v.slice(0, 3);
  } else if (p.L) {
    warn("Light radiance given as " + p.L.type + " is not supported, white is used");
  }
  const scale = p.scale ? Number(p.scale.values[0]) : 1;
  if (p.power) warn('Light "power" is not supported, the radiance L is used as given');
  if (p.illuminance) warn('Light "illuminance" is not supported, the radiance L is used as given');
  return rgb.map((c) => c * (Number.isFinite(scale) ? scale : 1));
}

// ------------------------------------------------------------------ meshes

// Reads the pbrt trianglemesh parameters into typed arrays.
export function trianglemeshArrays(params) {
  const P = params.P ? params.P.values.map(Number) : null;
  if (!P || P.length < 9) throw new Error('trianglemesh without "point3 P"');
  let indices = params.indices ? params.indices.values.map(Number) : null;
  if (!indices) {
    if (P.length !== 9) throw new Error('trianglemesh without "integer indices"');
    indices = [0, 1, 2];
  }
  const N = params.N ? params.N.values.map(Number) : null;
  const uv = params.uv ? params.uv.values.map(Number) : (params.st ? params.st.values.map(Number) : null);
  return {
    positions: Float32Array.from(P),
    normals: N && N.length === P.length ? Float32Array.from(N) : null,
    uvs: uv && uv.length === (P.length / 3) * 2 ? Float32Array.from(uv) : null,
    indices: Uint32Array.from(indices),
  };
}

const PLY_PROPERTY_MAPPING = { u: "s", v: "t", texture_u: "s", texture_v: "t", texture_s: "s", texture_t: "t" };

// Default PLY decoder: three r128's PLYLoader (triangulates quads), with
// pbrt's u/v property names mapped onto the loader's s/t.
function decodePlyWithThree(buffer) {
  if (typeof THREE === "undefined" || typeof THREE.PLYLoader === "undefined") throw new Error("PLYLoader unavailable in this build.");
  const loader = new THREE.PLYLoader();
  loader.setPropertyNameMapping(PLY_PROPERTY_MAPPING);
  const geometry = loader.parse(buffer);
  const pos = geometry.getAttribute("position");
  const nrm = geometry.getAttribute("normal");
  const uv = geometry.getAttribute("uv");
  const index = geometry.getIndex();
  const out = {
    positions: Float32Array.from(pos.array),
    normals: nrm ? Float32Array.from(nrm.array) : null,
    uvs: uv ? Float32Array.from(uv.array) : null,
    indices: index ? Uint32Array.from(index.array) : Uint32Array.from({ length: pos.count }, (_, i) => i),
  };
  geometry.dispose();
  return out;
}

function defaultGunzip(bytes) {
  const pako = typeof globalThis !== "undefined" ? globalThis.pako : undefined;
  if (!pako || typeof pako.ungzip !== "function") throw new Error("pako unavailable, cannot read .ply.gz");
  return pako.ungzip(bytes);
}

// ------------------------------------------------------------------- loader

// options.decodePly(arrayBuffer) and options.gunzip(Uint8Array) override the
// browser defaults (PLYLoader, pako), which lets Node tests run the loader.
export async function loadPbrtStage({ files, rootPath, signal, onProgress, decodePly, gunzip } = {}) {
  const report = (phase, done, total, message) => {
    if (typeof onProgress === "function") onProgress({ phase, done, total, fraction: total > 0 ? done / total : 0, message });
  };
  const fileByPath = new Map();
  for (const entry of Array.isArray(files) ? files : []) {
    if (entry && entry.path) fileByPath.set(normalizePath(entry.path), entry);
  }
  const root = normalizePath(rootPath);
  if (!fileByPath.has(root)) throw new Error("Root pbrt file not found: " + root);
  const decode = typeof decodePly === "function" ? decodePly : decodePlyWithThree;
  const ungz = typeof gunzip === "function" ? gunzip : defaultGunzip;

  const warnings = [];
  const seen = new Set();
  const warn = (message) => { if (!seen.has(message)) { seen.add(message); warnings.push(message); } };

  report("parse", 0, 1, "Reading " + basenameOf(root));
  const readText = async (path) => {
    checkAborted(signal);
    return new TextDecoder().decode(await toArrayBuffer(fileByPath.get(path).data));
  };
  const scene = await interpretPbrtScene({
    rootPath: root, readText, warn,
    resolve: (ref, dir) => resolvePbrtPath(ref, dir, dirOf(root), fileByPath),
  });
  report("parse", 1, 1, "Parsed " + basenameOf(root));

  const handed = pbrtHandedness(scene.camera && scene.camera.cameraFromWorld);
  const rootDir = dirOf(root);

  // Materials: one document per (material, emission) pair actually used.
  const usedMaterialNames = new Set();
  const materialEntries = [];
  const materialPathByKey = new Map();
  const materialPathFor = (shapeMaterial, emission) => {
    let material = shapeMaterial;
    let label;
    if (shapeMaterial && shapeMaterial.named !== undefined) {
      label = shapeMaterial.named;
      material = scene.namedMaterials.get(label);
      if (!material) { warn('NamedMaterial "' + label + '" is not defined, a grey diffuse is used'); material = { type: "diffuse", params: {} }; }
    } else {
      label = "pbrt_" + ((material && material.type) || "diffuse");
    }
    const contentKey = shapeMaterial && shapeMaterial.named !== undefined ? "named:" + label : "anon:" + JSON.stringify(material);
    const key = contentKey + "|" + (emission ? emission.join(",") : "");
    if (materialPathByKey.has(key)) return materialPathByKey.get(key);
    const name = sanitizeMtlxName(emission ? label + "_emissive" : label, usedMaterialNames);
    const doc = pbrtMaterialDocument({ name, material, emission });
    for (const note of doc.notes) warn(label + ": " + note);
    const bytes = new TextEncoder().encode(doc.xml);
    const mtlxPath = "__pbrt_" + name + ".mtlx";
    const materialPath = "/Materials/" + name;
    materialEntries.push({
      path: materialPath,
      shaderId: "open_pbr_surface",
      materialX: { path: mtlxPath, mimeType: "application/xml", materialName: doc.materialName, data: bytes },
      sourceAsset: mtlxPath,
      materialName: doc.materialName,
    });
    materialPathByKey.set(key, materialPath);
    return materialPath;
  };

  const plyCache = new Map();
  const readPly = async (path) => {
    if (plyCache.has(path)) return plyCache.get(path);
    let bytes = new Uint8Array(await toArrayBuffer(fileByPath.get(path).data));
    if (/\.gz$/i.test(path) || (bytes[0] === 0x1f && bytes[1] === 0x8b)) bytes = ungz(bytes);
    const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
    const decoded = decode(buffer);
    plyCache.set(path, decoded);
    return decoded;
  };

  const meshRecords = [];
  const usedPrimNames = new Set();
  let emitterCount = 0;
  let oneSidedEmitters = 0;
  const total = scene.shapes.length;
  report("extract-geometry", 0, total, "Reading meshes");
  for (let s = 0; s < total; s++) {
    checkAborted(signal);
    const shape = scene.shapes[s];
    let arrays;
    let label;
    try {
      if (shape.kind === "plymesh") {
        const ref = shape.params.filename && shape.params.filename.values[0];
        if (!ref) { warn('Shape "plymesh" without "string filename" skipped'); continue; }
        label = basenameOf(ref).replace(/\.ply(\.gz)?$/i, "");
        const resolved = resolvePbrtPath(ref, shape.dir, rootDir, fileByPath);
        if (!resolved) { warn('PLY file not found: "' + ref + '" (drop the models folder together with the scene)'); continue; }
        arrays = await readPly(resolved);
        if (shape.params.displacement) warn("plymesh displacement is not supported, ignored");
      } else {
        label = "trianglemesh";
        arrays = trianglemeshArrays(shape.params);
      }
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      warn("Shape skipped: " + ((e && e.message) || e));
      continue;
    }
    if (shape.params.alpha) warn('Shape "alpha" (cutout) is not supported, ignored');
    const matrix = mat4Multiply(handed.matrix, shape.ctm);
    const baked = bakeMeshTransform(arrays, matrix, shape.reverseOrientation);
    let emission = null;
    if (shape.areaLight) {
      emission = pbrtAreaLightRadiance(shape.areaLight.params, warn);
      emitterCount++;
      const twoSided = shape.areaLight.params.twosided;
      if (!(twoSided && twoSided.values[0] === true)) oneSidedEmitters++;
    }
    const primName = sanitizeMtlxName(emission ? label + "_light" : label, usedPrimNames);
    meshRecords.push({
      primPath: "/" + primName,
      name: primName,
      positions: baked.positions,
      ...(baked.normals ? { normals: baked.normals } : {}),
      ...(arrays.uvs ? { uvs: Float32Array.from(arrays.uvs) } : {}),
      displayColor: null,
      indices: baked.indices,
      matrix: IDENTITY.slice(),
      orientation: "rightHanded",
      castsShadow: true,
      subdivisionScheme: "none",
      materialPath: materialPathFor(shape.material, emission),
      doubleSided: true,
      groups: [],
    });
    report("extract-geometry", s + 1, total, "Reading meshes");
  }
  if (!meshRecords.length) throw new Error("No renderable meshes in " + root);

  // Camera record in the glTF/USD shape the renderer already reads.
  const cameras = [];
  if (scene.camera) {
    const aspect = scene.film.xresolution / scene.film.yresolution;
    const lens = pbrtCameraLens(scene.camera.fov, aspect);
    const focus = scene.camera.params.focaldistance ? Number(scene.camera.params.focaldistance.values[0]) : 0;
    cameras.push({
      primPath: "/Cameras/camera", name: "camera",
      matrix: pbrtCameraMatrix(scene.camera.cameraFromWorld, handed.matrix),
      focalLength: lens.focalLength, horizontalAperture: lens.horizontalAperture, verticalAperture: lens.verticalAperture,
      horizontalApertureOffset: 0, verticalApertureOffset: 0,
      clippingRange: [0.001, 1000000], focusDistance: Number.isFinite(focus) ? focus : 0,
      projection: "perspective", defaultCamera: true,
    });
  }

  // A constant infinite light becomes a uniform dome (colour = radiance).
  const lights = [];
  scene.infiniteLights.forEach((light, i) => {
    if (i > 0) { warn("More than one infinite light; only the first is used"); return; }
    lights.push({
      primPath: "/Lights/environment", name: "environment", type: "domelight",
      matrix: IDENTITY.slice(), textureFile: null, textureFormat: "automatic",
      intensity: 1, exposure: 0, diffuse: 1, specular: 1,
      color: pbrtAreaLightRadiance(light.params, warn),
      enableColorTemperature: false, colorTemperature: 6500,
      radius: null, width: null, height: null, length: null, angle: null,
      normalize: false, treatAsPoint: false, coneAngle: null, coneSoftness: null,
    });
  });

  if (oneSidedEmitters) warn("[info] " + oneSidedEmitters + " one-sided area light(s) emit from both faces here (pbrt emits from the front face only)");
  warn("[info] pbrt scene: " + meshRecords.length + " mesh(es), " + emitterCount + " area light emitter(s), "
    + (handed.mirror ? "Z axis mirrored to convert pbrt's left-handed frame" : "no mirror needed (the camera transform already flips handedness)"));

  report("extract-materials", 1, 1, "Extracted materials");
  report("prepare-geometry", 1, 1, "Prepared geometry");

  return {
    rootPath: root,
    upAxis: "Y",
    metersPerUnit: 1,
    summary: {
      rootFile: root,
      sourceKind: "pbrt",
      upAxis: "Y",
      metersPerUnit: 1,
      meshCount: meshRecords.length,
      materialCount: materialEntries.length,
    },
    meshes: meshRecords,
    materials: materialEntries,
    assets: materialEntries.map((m) => ({ path: m.materialX.path, data: m.materialX.data.buffer })),
    cameras,
    lights,
    warnings,
    transfer: [],
  };
}
