// Main-thread pbrt-v4 scene loader: parses a .pbrt file (plus Include/Import
// and plymesh files, .ply.gz too) into the neutral stage payload. THREE and
// THREE.PLYLoader are window globals here; the parser parts are pure.

import { pbrtMaterialDocument, sanitizeMtlxName } from "./mtlx-material-docs.js";
import {
  checkAborted, normalizePath, dirOf, basenameOf, joinPath, toArrayBuffer, resolveScenePath, createWarningSink,
  IDENTITY, mat4Multiply, mat4Invert, mat3Determinant, translateMatrix, scaleMatrix, rotateMatrix, bakeMeshTransform,
  cameraLensForFov, sceneCameraRecord, uniformDomeLight, materialEntryFromDocument, bakedMeshRecord, scenePayload,
} from "./scene-import-common.js";

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

  // A constant infinite light becomes a uniform dome (colour = radiance).
  const lights = [];
  scene.infiniteLights.forEach((light, i) => {
    if (i > 0) { warn("More than one infinite light; only the first is used"); return; }
    lights.push(uniformDomeLight(pbrtAreaLightRadiance(light.params, warn)));
  });

  if (oneSidedEmitters) warn("[info] " + oneSidedEmitters + " one-sided area light(s) emit from both faces here (pbrt emits from the front face only)");
  warn("[info] pbrt scene: " + meshRecords.length + " mesh(es), " + emitterCount + " area light emitter(s), "
    + (handed.mirror ? "Z axis mirrored to convert pbrt's left-handed frame" : "no mirror needed (the camera transform already flips handedness)"));

  report("extract-materials", 1, 1, "Extracted materials");
  report("prepare-geometry", 1, 1, "Prepared geometry");

  return scenePayload({ rootPath: root, sourceKind: "pbrt", meshes: meshRecords, materials: materialEntries, cameras, lights, warnings });
}
