// Main-thread pbrt-v4 scene loader: parses a .pbrt file (plus Include/Import
// and plymesh files, .ply.gz too) into the neutral stage payload. THREE and
// THREE.PLYLoader are window globals here; the parser parts are pure.

import { pbrtMaterialDocument, sanitizeMtlxName, forEachImageTexture } from "./mtlx-material-docs.js";
import {
  checkAborted, normalizePath, dirOf, basenameOf, joinPath, toArrayBuffer, resolveScenePath, createWarningSink,
  IDENTITY, mat4Multiply, mat4Invert, mat3Determinant, translateMatrix, scaleMatrix, rotateMatrix, bakeMeshTransform,
  cameraLensForFov, sceneCameraRecord, uniformDomeLight, texturedDomeLight, distantLightRecord, materialEntryFromDocument, bakedMeshRecord, scenePayload,
  rectangleFromTriangles, windingNormal, emitterStandInLight, prepareSceneTextures, decodeFloatImage, sanitizeAssetName,
} from "./scene-import-common.js";
import { encodeRadianceHdr } from "./pfm-image.js";

export { joinPath, IDENTITY, mat4Multiply, mat4Invert, mat3Determinant, translateMatrix, scaleMatrix, rotateMatrix, bakeMeshTransform };

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

// ------------------------------------------------------------------- camera

// pbrt's perspective fov spans the shorter image axis.
export function pbrtCameraLens(fovDeg, aspect) { return cameraLensForFov(fovDeg, aspect, "smaller"); }

// ------------------------------------------------------------------ parsing

// pbrt resolves next to the including file, then next to the root file.
export const resolvePbrtPath = resolveScenePath;

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
    distantLights: [],
    textures: new Map(),
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
          if (a[0] === "infinite") scene.infiniteLights.push({ params: d.params, ctm: state.ctm.slice(), dir: here });
          else if (a[0] === "distant") scene.distantLights.push({ params: d.params, ctm: state.ctm.slice() });
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
        case "Texture": {
          if (scene.textures.has(a[0])) warn('Texture "' + a[0] + '" is defined twice; the last definition is used');
          scene.textures.set(a[0], { name: a[0], type: a[1] || "spectrum", texClass: a[2] || "", params: d.params, dir: here });
          break;
        }
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

// ----------------------------------------------------------------- textures

const PBRT_WRAP = { repeat: "periodic", clamp: "clamp", black: "constant" };
const FLOAT_IMAGE = /\.(exr|pfm|hdr)$/i;

// MaterialX file colorspace for a pbrt-v4 imagemap: "encoding" defaults to sRGB for
// every 8-bit image, as the file format spec defines it; float images are always linear.
export function pbrtImageColorspace(filename, encoding, warn = () => {}) {
  if (FLOAT_IMAGE.test(String(filename))) return null;
  const enc = String(encoding ?? "sRGB").trim();
  if (enc === "sRGB") return "srgb_texture";
  if (enc === "linear") return null;
  const g = /^gamma\s+([0-9.eE+-]+)$/.exec(enc);
  if (g) {
    const gamma = Number(g[1]);
    if (Math.abs(gamma - 2.2) < 1e-3) return "g22_rec709";
    if (Math.abs(gamma - 1.8) < 1e-3) return "g18_rec709";
    const near = Math.abs(gamma - 1.8) < Math.abs(gamma - 2.2) ? "g18_rec709" : "g22_rec709";
    warn('encoding "' + enc + '" is approximated with MaterialX ' + near);
    return near;
  }
  warn('encoding "' + enc + '" is not recognized, the image is read as linear');
  return null;
}

// pbrt's 2D "uv" mapping (s = su u + du, t = sv v + dv) as an affine uv map; pbrt-v4
// flips t for the image lookup, so its texcoord convention is MaterialX's own.
export function pbrtUvMapping(params, warn = () => {}) {
  const p = params || {};
  const mapping = p.mapping ? String(p.mapping.values[0]) : "uv";
  if (mapping !== "uv") warn('mapping "' + mapping + '" is not supported, uv mapping is used');
  const n = (key, fallback) => { const v = p[key] ? Number(p[key].values[0]) : fallback; return Number.isFinite(v) ? v : fallback; };
  const m = [n("uscale", 1), 0, 0, n("vscale", 1), n("udelta", 0), n("vdelta", 0)];
  return m[0] === 1 && m[3] === 1 && m[4] === 0 && m[5] === 0 ? null : m;
}

// A named pbrt texture as the format-neutral description mtlx-material-docs.js
// builds graphs from (imagemap, constant, scale, mix, 2D checkerboard).
export function pbrtTextureSpec(name, textures, warn = () => {}, stack = []) {
  const tex = textures && textures.get(name);
  if (!tex) return { kind: "unsupported", reason: 'texture "' + name + '" is not defined' };
  if (stack.includes(name)) return { kind: "unsupported", reason: 'texture "' + name + '" references itself' };
  const p = tex.params || {};
  const say = (message) => warn('Texture "' + name + '": ' + message);
  const inner = stack.concat(name);
  const value = (key, fallback) => {
    const param = p[key];
    if (!param) return { kind: "constant", value: fallback };
    if (param.type === "texture") return pbrtTextureSpec(String(param.values[0]), textures, warn, inner);
    if ((param.type === "rgb" || param.type === "color") && param.values.length >= 3) return { kind: "constant", value: param.values.slice(0, 3).map(Number) };
    if (param.type === "float") return { kind: "constant", value: Number(param.values[0]) };
    say(key + " given as " + param.type + " is not supported, " + fallback + " is used");
    return { kind: "constant", value: fallback };
  };
  const str = (key, fallback) => (p[key] ? String(p[key].values[0]) : fallback);
  switch (tex.texClass) {
    case "imagemap": {
      const file = str("filename", "");
      if (!file) return { kind: "unsupported", reason: 'texture "' + name + '" has no filename' };
      const wrapName = str("wrap", "repeat");
      let wrap = PBRT_WRAP[wrapName];
      if (!wrap) { say('wrap "' + wrapName + '" is read as repeat'); wrap = "periodic"; }
      const scale = p.scale ? Number(p.scale.values[0]) : 1;
      return {
        kind: "image", file, dir: tex.dir, colorspace: pbrtImageColorspace(file, p.encoding ? p.encoding.values[0] : undefined, say),
        uaddress: wrap, vaddress: wrap, uv: pbrtUvMapping(p, say),
        scale: Number.isFinite(scale) ? scale : 1, invert: !!(p.invert && p.invert.values[0] === true), floatChannel: "first",
      };
    }
    case "constant": return value("value", 1);
    case "scale": return { kind: "scale", tex: value("tex", 1), scale: value("scale", 1) };
    case "mix": return { kind: "mix", tex1: value("tex1", 0), tex2: value("tex2", 1), amount: value("amount", 0.5) };
    case "checkerboard": {
      const dim = p.dimension ? Number(p.dimension.values[0]) : 2;
      if (dim !== 2) return { kind: "unsupported", reason: 'texture "' + name + '" is a 3D checkerboard, which is not supported' };
      return { kind: "checker", tex1: value("tex1", 1), tex2: value("tex2", 0), uv: pbrtUvMapping(p, say) };
    }
    default:
      return { kind: "unsupported", reason: 'texture "' + name + '" of type "' + tex.texClass + '" is not supported' };
  }
}

// The material with every "texture" parameter resolved into param.texture.
export function pbrtMaterialWithTextures(material, textures, warn = () => {}) {
  if (!material || !material.params) return material;
  const params = {};
  for (const [key, param] of Object.entries(material.params)) {
    params[key] = param && param.type === "texture" && textures && textures.has(String(param.values[0]))
      ? { ...param, texture: pbrtTextureSpec(String(param.values[0]), textures, warn) } : param;
  }
  return { ...material, params };
}

// ------------------------------------------------------- infinite and distant

// pbrt-v4 EqualAreaSquareToSphere (src/pbrt/util/math.cpp), [0, 1]^2 to the unit sphere.
export function equalAreaSquareToSphere(px, py) {
  const u = 2 * px - 1, v = 2 * py - 1;
  const up = Math.abs(u), vp = Math.abs(v);
  const signedDistance = 1 - (up + vp);
  const r = 1 - Math.abs(signedDistance);
  const phi = (r === 0 ? 1 : (vp - up) / r + 1) * Math.PI / 4;
  const z = (signedDistance < 0 || Object.is(signedDistance, -0) ? -1 : 1) * (1 - r * r);
  const cosPhi = Math.abs(Math.cos(phi)) * (u < 0 || Object.is(u, -0) ? -1 : 1);
  const sinPhi = Math.abs(Math.sin(phi)) * (v < 0 || Object.is(v, -0) ? -1 : 1);
  const s = r * Math.sqrt(Math.max(0, 2 - r * r));
  return [cosPhi * s, sinPhi * s, z];
}

const ATAN_FIT = [0.406758566246788489601959989e-5, 0.636226545274016134946890922156, 0.61572017898280213493197203466e-2,
  -0.247333733281268944196501420480, 0.881770664775316294736387951347e-1, 0.419038818029165735901852432784e-1, -0.251390972343483509333252996350e-1];

// pbrt-v4 EqualAreaSphereToSquare (Clarberg's mapping), the inverse of the above.
export function equalAreaSphereToSquare(dx, dy, dz) {
  const x = Math.abs(dx), y = Math.abs(dy), z = Math.abs(dz);
  const r = Math.sqrt(Math.max(0, 1 - z));
  const a = Math.max(x, y);
  const b = a === 0 ? 0 : Math.min(x, y) / a;
  let phi = 0;
  for (let i = ATAN_FIT.length - 1; i >= 0; i--) phi = phi * b + ATAN_FIT[i];
  if (x < y) phi = 1 - phi;
  let v = phi * r;
  let u = r - v;
  if (dz < 0) { const t = u; u = 1 - v; v = 1 - t; }
  u = dx < 0 || Object.is(dx, -0) ? -u : u;
  v = dy < 0 || Object.is(dy, -0) ? -v : v;
  return [0.5 * (u + 1), 0.5 * (v + 1)];
}

// pbrt-v4 RemapPixelCoords for WrapMode::OctahedralSphere (util/image.h).
function octahedralTexel(x, y, w, h) {
  if (x < 0) { x = -x; y = h - 1 - y; } else if (x >= w) { x = 2 * w - 1 - x; y = h - 1 - y; }
  if (y < 0) { x = w - 1 - x; y = -y; } else if (y >= h) { x = w - 1 - x; y = 2 * h - 1 - y; }
  return [Math.min(w - 1, Math.max(0, x)), Math.min(h - 1, Math.max(0, y))];
}

// Resamples an equal-area square map (rgb, top row first) into a lat-long in the dome's
// convention (+z at the centre, +x at u = 0.25, +y on top); domeToLight (3x3, column-major)
// maps dome directions into the light frame. Bilinear, with pbrt's octahedral wrap.
export function equalAreaToLatLong({ width: n, height, data }, outWidth = Math.min(4096, Math.max(1024, 2 * n)), domeToLight = [1, 0, 0, 0, 1, 0, 0, 0, 1]) {
  const W = outWidth, H = W / 2;
  const out = new Float32Array(W * H * 3);
  const L = domeToLight;
  const at = (x, y, c) => { const [tx, ty] = octahedralTexel(x, y, n, height); return data[(ty * n + tx) * 3 + c]; };
  for (let j = 0; j < H; j++) {
    const theta = ((j + 0.5) / H) * Math.PI;
    const st = Math.sin(theta), ct = Math.cos(theta);
    for (let i = 0; i < W; i++) {
      const phi = ((i + 0.5) / W) * 2 * Math.PI;
      const d = [Math.sin(phi) * st, ct, -Math.cos(phi) * st];
      const lx = L[0] * d[0] + L[3] * d[1] + L[6] * d[2];
      const ly = L[1] * d[0] + L[4] * d[1] + L[7] * d[2];
      const lz = L[2] * d[0] + L[5] * d[1] + L[8] * d[2];
      const len = Math.hypot(lx, ly, lz) || 1;
      const [s, t] = equalAreaSphereToSquare(lx / len, ly / len, lz / len);
      const fx = s * n - 0.5, fy = t * height - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const ax = fx - x0, ay = fy - y0;
      for (let c = 0; c < 3; c++) {
        const top = at(x0, y0, c) * (1 - ax) + at(x0 + 1, y0, c) * ax;
        const bottom = at(x0, y0 + 1, c) * (1 - ax) + at(x0 + 1, y0 + 1, c) * ax;
        out[(j * W + i) * 3 + c] = top * (1 - ay) + bottom * ay;
      }
    }
  }
  return { width: W, height: H, data: out };
}

// Upper-hemisphere (light-space +z) illuminance of an equal-area map, as pbrt-v4
// computes it for the "illuminance" parameter (lights.cpp, including its 2 pi / N^2).
export function equalAreaIlluminance({ width, height, data }) {
  let sum = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const w = equalAreaSquareToSphere((x + 0.5) / width, (y + 0.5) / height);
      if (w[2] <= 0) continue;
      const i = (y * width + x) * 3;
      sum += (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) * w[2];
    }
  }
  return (sum * 2 * Math.PI) / (width * height);
}

const linear3 = (m) => [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
const normalize3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return v.map((c) => c / l); };

// Dome of an image infinite light: its rotation (handedness mirror times CTM, no scale)
// splits into a yaw about +y, the dome matrix, and the rest (tilt, any mirror), which
// domeToLight folds into the resampled image so a level sky's zenith is the top row.
export function pbrtInfiniteDome(ctm, worldMirror) {
  const m = mat4Multiply(worldMirror, ctm);
  const mirrored = mat3Determinant(m) < 0;
  const cols = [0, 1, 2].map((c) => normalize3([m[c * 4], m[c * 4 + 1], m[c * 4 + 2]]));
  if (mirrored) cols[2] = cols[2].map((v) => -v);
  const P = [...cols[0], ...cols[1], ...cols[2]]; // proper rotation, 3x3 column-major
  const yaw = Math.atan2(P[6], P[8]);
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const yawT = [c, 0, s, 0, 1, 0, -s, 0, c]; // Ry(yaw) transposed
  // domeToLight = S * P^T * Ry(yaw), S the z flip of a mirrored transform.
  const PT = [P[0], P[3], P[6], P[1], P[4], P[7], P[2], P[5], P[8]];
  const ry = [yawT[0], yawT[3], yawT[6], yawT[1], yawT[4], yawT[7], yawT[2], yawT[5], yawT[8]];
  const mul3 = (A, B) => { const o = new Array(9); for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) o[j * 3 + i] = A[i] * B[j * 3] + A[3 + i] * B[j * 3 + 1] + A[6 + i] * B[j * 3 + 2]; return o; };
  const domeToLight = mul3(mirrored ? [1, 0, 0, 0, 1, 0, 0, 0, -1] : [1, 0, 0, 0, 1, 0, 0, 0, 1], mul3(PT, ry));
  const matrix = [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  return { matrix, mirrored, yawDeg: (yaw * 180) / Math.PI, domeToLight };
}

// An rgb emission parameter (rgb or float L), white by default.
function pbrtLightColor(params, warn) {
  const p = params || {};
  if (p.L && (p.L.type === "rgb" || p.L.type === "float")) {
    const v = p.L.values.map(Number);
    return p.L.type === "float" ? [v[0], v[0], v[0]] : v.slice(0, 3);
  }
  if (p.L) warn("Light radiance given as " + p.L.type + " is not supported, white is used");
  return [1, 1, 1];
}

// pbrt-v4 DistantLight: rgb L times scale (times "illuminance") is the irradiance facing
// the light, like UsdLux DistantLight's intensity * color in lux, so color = L and
// intensity = scale (* illuminance); the light travels from "from" to "to".
export function pbrtDistantLight({ params, ctm }, worldMirror, warn = () => {}, name = "distant") {
  const p = params || {};
  const color = pbrtLightColor(p, warn);
  const scale = p.scale ? Number(p.scale.values[0]) : 1;
  const illuminance = p.illuminance ? Number(p.illuminance.values[0]) : -1;
  const point = (key, fallback) => (p[key] ? p[key].values.slice(0, 3).map(Number) : fallback);
  const from = point("from", [0, 0, 0]), to = point("to", [0, 0, 1]);
  const w = [from[0] - to[0], from[1] - to[1], from[2] - to[2]];
  if (!(Math.hypot(w[0], w[1], w[2]) > 0)) { warn('LightSource "distant" with from = to skipped'); return null; }
  const m = linear3(mat4Multiply(worldMirror, ctm));
  const toLight = [m[0] * w[0] + m[3] * w[1] + m[6] * w[2], m[1] * w[0] + m[4] * w[1] + m[7] * w[2], m[2] * w[0] + m[5] * w[1] + m[8] * w[2]];
  const intensity = (Number.isFinite(scale) ? scale : 1) * (illuminance > 0 ? illuminance : 1);
  return distantLightRecord({ name, toLight, color, intensity });
}

// pbrt-v4 uniform infinite light radiance: rgb L times scale, times
// illuminance / pi when "illuminance" is given (lights.cpp).
export function pbrtUniformInfiniteRadiance(params, warn = () => {}) {
  const p = params || {};
  const rgb = pbrtLightColor(p, warn);
  const scale = p.scale ? Number(p.scale.values[0]) : 1;
  const illuminance = p.illuminance ? Number(p.illuminance.values[0]) : -1;
  const k = (Number.isFinite(scale) ? scale : 1) * (illuminance > 0 ? illuminance / Math.PI : 1);
  return rgb.map((c) => c * k);
}

// ------------------------------------------------------------------ meshes

// Emitting side of a baked pbrt emitter, in our frame. pbrt's triangle normal is
// the winding normal, flipped by ReverseOrientation xor a handedness-swapping CTM,
// or turned toward the shading normals N when given; our Z mirror negates the winding.
export function pbrtEmitterFacing({ baked, indices, ctm, reverseOrientation, mirror }) {
  if (baked.normals && baked.normals.length) {
    const sum = [0, 0, 0];
    for (let i = 0; i < baked.normals.length; i += 3) { sum[0] += baked.normals[i]; sum[1] += baked.normals[i + 1]; sum[2] += baked.normals[i + 2]; }
    return sum;
  }
  const sign = ((!!reverseOrientation !== (mat3Determinant(ctm) < 0)) ? -1 : 1) * (mirror ? -1 : 1);
  return windingNormal(baked.positions, indices).map((c) => c * sign);
}

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

// An image infinite light as a textured dome: the equal-area square map is resampled
// into a lat-long .hdr payload asset, intensity = scale (times illuminance / the map's
// upper-hemisphere illuminance when given). Returns { light, asset } or null.
export async function pbrtImageDomeLight({ light, handed, rootDir, fileByPath, readBytes, warn = () => {}, decodeExr }) {
  const p = light.params;
  const ref = String(p.filename.values[0]);
  const path = resolvePbrtPath(ref, light.dir ?? rootDir, rootDir, fileByPath);
  if (!path) { warn('Environment map not found: "' + ref + '" (drop the textures folder together with the scene)'); return null; }
  if (p.L) warn('Infinite light: "L" and "filename" together are not valid in pbrt-v4; the image is used');
  if (p.portal) warn("Infinite light portals are not supported, ignored");
  try {
    const image = await decodeFloatImage(await readBytes(path), path, { decodeExr });
    if (image.width !== image.height) throw new Error("pbrt-v4 needs a square equal-area map, this one is " + image.width + "x" + image.height);
    const dome = pbrtInfiniteDome(light.ctm, handed.matrix);
    const latlong = equalAreaToLatLong(image, undefined, dome.domeToLight);
    const scale = p.scale ? Number(p.scale.values[0]) : 1;
    let intensity = Number.isFinite(scale) ? scale : 1;
    const illuminance = p.illuminance ? Number(p.illuminance.values[0]) : -1;
    if (illuminance > 0) {
      const k = equalAreaIlluminance(image);
      if (k > 0) intensity *= illuminance / k;
    }
    const assetPath = "__pbrt_env_" + sanitizeAssetName(basenameOf(path)) + ".hdr";
    warn("[info] Environment map " + basenameOf(path) + ": pbrt's equal-area square resampled to a " + latlong.width + "x" + latlong.height + " lat-long .hdr"
      + ", yaw " + dome.yawDeg.toFixed(1) + " deg on the dome, tilt" + (dome.mirrored ? " and mirror" : "") + " folded into the image");
    return {
      light: texturedDomeLight({ textureFile: assetPath, matrix: dome.matrix, intensity }),
      asset: { path: assetPath, data: encodeRadianceHdr(latlong).buffer },
    };
  } catch (e) {
    if (e && e.name === "AbortError") throw e;
    warn('Environment map "' + path + '" could not be read (' + ((e && e.message) || e) + "); the default environment is used");
    return null;
  }
}

// ------------------------------------------------------------------- loader

// options.decodePly(arrayBuffer) and options.gunzip(Uint8Array) override the
// browser defaults (PLYLoader, pako), which lets Node tests run the loader.
export async function loadPbrtStage({ files, rootPath, signal, onProgress, decodePly, gunzip, decodeExr } = {}) {
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

  const { warnings, warn } = createWarningSink();

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
  const readBytes = async (path) => { checkAborted(signal); return new Uint8Array(await toArrayBuffer(fileByPath.get(path).data)); };

  // Image textures the materials use: resolved against the drop, PFM converted.
  const images = [];
  const usedTextureNames = new Set();
  const collectTextures = (material) => {
    for (const param of Object.values((material && material.params) || {})) {
      if (param && param.type === "texture") usedTextureNames.add(String(param.values[0]));
    }
  };
  scene.namedMaterials.forEach(collectTextures);
  scene.shapes.forEach((shape) => collectTextures(shape.material));
  for (const name of usedTextureNames) forEachImageTexture(pbrtTextureSpec(name, scene.textures), (spec) => images.push(spec));
  const textures = await prepareSceneTextures({ images, rootDir, fileByPath, prefix: "pbrt", warn, readBytes });
  const assets = textures.assets.slice();

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
    const doc = pbrtMaterialDocument({ name, material: pbrtMaterialWithTextures(material, scene.textures, warn), emission, textureFile: textures.textureFile });
    for (const note of doc.notes) warn(label + ": " + note);
    const entry = materialEntryFromDocument(doc, name, "pbrt");
    materialEntries.push(entry);
    materialPathByKey.set(key, entry.path);
    return entry.path;
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
  const standIns = [];
  let nonRectEmitters = 0;
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
    meshRecords.push(bakedMeshRecord({
      primName, positions: baked.positions, normals: baked.normals,
      uvs: arrays.uvs ? Float32Array.from(arrays.uvs) : null, indices: baked.indices,
      materialPath: materialPathFor(shape.material, emission), doubleSided: true,
    }));
    if (emission) {
      const rect = rectangleFromTriangles(baked.positions, baked.indices);
      if (!rect) nonRectEmitters++;
      else {
        const facing = pbrtEmitterFacing({ baked, indices: arrays.indices, ctm: shape.ctm, reverseOrientation: shape.reverseOrientation, mirror: handed.mirror });
        const twoSided = shape.areaLight.params.twosided && shape.areaLight.params.twosided.values[0] === true;
        const meshPath = "/" + primName;
        for (const [side, suffix] of twoSided ? [[1, "_standin"], [-1, "_standin_back"]] : [[1, "_standin"]]) {
          const light = emitterStandInLight({ rect, facing: facing.map((c) => c * side), color: emission, meshPath, name: primName + suffix });
          if (light) standIns.push(light);
        }
      }
    }
    report("extract-geometry", s + 1, total, "Reading meshes");
  }
  if (!meshRecords.length) throw new Error("No renderable meshes in " + root);

  // Camera record in the glTF/USD shape the renderer already reads.
  const cameras = [];
  if (scene.camera) {
    const aspect = scene.film.xresolution / scene.film.yresolution;
    const lens = pbrtCameraLens(scene.camera.fov, aspect);
    const focus = scene.camera.params.focaldistance ? Number(scene.camera.params.focaldistance.values[0]) : 0;
    cameras.push(sceneCameraRecord({ matrix: pbrtCameraMatrix(scene.camera.cameraFromWorld, handed.matrix), lens, focusDistance: focus }));
  }

  // The first infinite light is the dome: uniform (colour = radiance) or an image.
  const lights = [];
  if (scene.infiniteLights.length > 1) warn("More than one infinite light; only the first is used");
  const infinite = scene.infiniteLights[0];
  if (infinite && infinite.params.filename) {
    const dome = await pbrtImageDomeLight({ light: infinite, handed, rootDir, fileByPath, readBytes, warn, decodeExr });
    if (dome) { lights.push(dome.light); assets.push(dome.asset); }
  } else if (infinite) {
    lights.push(uniformDomeLight(pbrtUniformInfiniteRadiance(infinite.params, warn)));
  }
  scene.distantLights.forEach((light, i) => {
    const record = pbrtDistantLight(light, handed.matrix, warn, i ? "distant_" + (i + 1) : "distant");
    if (record) lights.push(record);
  });
  lights.push(...standIns);
  if (standIns.length) warn("[info] " + standIns.length + " viewer-only rect light(s) stand in for rectangular area emitters in the real-time view; Export USD keeps only the emissive meshes");
  if (nonRectEmitters) warn("[info] " + nonRectEmitters + " area emitter(s) are not planar rectangles: they glow but do not light the real-time view");

  if (oneSidedEmitters) warn("[info] " + oneSidedEmitters + " one-sided area light(s) emit from both faces here (pbrt emits from the front face only)");
  warn("[info] pbrt scene: " + meshRecords.length + " mesh(es), " + emitterCount + " area light emitter(s), "
    + (handed.mirror ? "Z axis mirrored to convert pbrt's left-handed frame" : "no mirror needed (the camera transform already flips handedness)"));

  report("extract-materials", 1, 1, "Extracted materials");
  report("prepare-geometry", 1, 1, "Prepared geometry");

  return scenePayload({ rootPath: root, sourceKind: "pbrt", meshes: meshRecords, materials: materialEntries, cameras, lights, warnings, assets });
}
