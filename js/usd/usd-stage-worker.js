/*
 * OpenUSD stage extraction worker.
 *
 * The native usd-wg-webview bindings own USD composition (references,
 * sublayers, payloads, variants and usdMtlx). This file only copies their
 * result out of Emscripten memory into ordinary transferable buffers.
 */

import "../shared/mesh-subdivision.js";

const { subdivideMesh, subdivideCatmullClark, weldMesh } = globalThis.MtlxMeshSubdivision;

const RUNTIME_DIR = new URL("../../vendor/usd-webview-bindings/", import.meta.url);
let runtimePromise;
let activeStage;
const nativeWarnings = [];
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);
// Reused scalar storage keeps weld hashing allocation-free while retaining
// the fractional bits that distinguish neighboring geometry samples.
const weldHashBuffer = new ArrayBuffer(8);
const weldHashFloat64 = new Float64Array(weldHashBuffer);
const weldHashWords = new Uint32Array(weldHashBuffer);
function hashWeldNumber(value) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) return 0x7fc00000;
  if (numeric === 0) {
    weldHashWords[0] = 0;
    weldHashWords[1] = 0;
    return 0;
  }
  weldHashFloat64[0] = numeric;
  return (Math.imul(weldHashWords[0], 0x9e3779b1) ^ Math.imul(weldHashWords[1], 0x85ebca6b)) >>> 0;
}
// Bounded copy of the native runtime's console output (Emscripten binds
// console.error/warn), so load() can read diagnostics openStage does not
// return, such as an asset path it failed to resolve.
const STDERR_BUFFER_MAX = 500;
const stderrBuffer = [];
function pushStderrLine(args) {
  const line = args.map(value => String(value)).join(" ");
  stderrBuffer.push(line);
  if (stderrBuffer.length > STDERR_BUFFER_MAX) stderrBuffer.shift();
}
console.error = (...args) => {
  nativeWarnings.push(args.map(value => String(value)).join(" "));
  pushStderrLine(args);
  originalConsoleError(...args);
};
console.warn = (...args) => {
  pushStderrLine(args);
  originalConsoleWarn(...args);
};

// Input cache: this worker now persists across loads, but closeStage wipes
// MEMFS, so createDataFile still runs every time. This only avoids re-reading
// a File and re-decoding its text when the same identity reappears. Bytes and
// text for one key are always evicted together (one LRU entry per key).
const INPUT_CACHE_MAX_BYTES = 192 * 1024 * 1024;
const INPUT_CACHE_BYTES_MAX_BYTES = 8 * 1024 * 1024;
const INPUT_CACHE_TEXT_MAX_LENGTH = 32 * 1024 * 1024;
const inputCache = new Map();
let inputCacheBytes = 0;

function inputCacheEntrySize(entry) {
  return (entry.bytes ? entry.bytes.byteLength : 0) + (entry.text ? 2 * entry.text.length : 0);
}

function inputCacheGet(key) {
  const entry = inputCache.get(key);
  if (!entry) return undefined;
  inputCache.delete(key);
  inputCache.set(key, entry); // refresh recency
  return entry;
}

function inputCacheAdmit(key, bytes, text) {
  const entry = {};
  if (bytes && bytes.byteLength <= INPUT_CACHE_BYTES_MAX_BYTES) entry.bytes = bytes;
  if (typeof text === "string" && text.length <= INPUT_CACHE_TEXT_MAX_LENGTH) entry.text = text;
  if (!entry.bytes && !entry.text) return;
  const existing = inputCache.get(key);
  if (existing) inputCacheBytes -= inputCacheEntrySize(existing);
  inputCache.set(key, entry);
  inputCacheBytes += inputCacheEntrySize(entry);
  for (const [oldKey, oldEntry] of inputCache) {
    if (inputCacheBytes <= INPUT_CACHE_MAX_BYTES) break;
    inputCache.delete(oldKey);
    inputCacheBytes -= inputCacheEntrySize(oldEntry);
  }
}

function runtime() {
  if (!runtimePromise) {
    // The published convenience wrapper is browser-global by design. Giving
    // it a window alias is sufficient in a dedicated module Worker and keeps
    // its filesystem/path handling identical to the supported browser build.
    globalThis.window ??= globalThis;
    runtimePromise = import("../../vendor/usd-webview-bindings/usdWebViewBindings.js")
      .then(() => globalThis.UsdWebViewBindings.createRuntime({
        locateFile: path => new URL(path, RUNTIME_DIR).href,
      }))
      .catch(error => {
        console.error(error);
        runtimePromise = null;
        throw new Error(
          'USD runtime is not installed: vendor/usd-webview-bindings/ is missing or unreachable. Run "npm run vendor" (or "npm run build") in the repository root, then reload.'
        );
      });
  }
  return runtimePromise;
}

function arrayCopy(value, Type = Float32Array) {
  if (value == null) return undefined;
  try {
    if (ArrayBuffer.isView(value)) return new Type(value);
    if (value instanceof ArrayBuffer) return new Type(value.slice(0));
    if (Array.isArray(value)) return Type.from(value);
    if (typeof value.size === "function" && typeof value.get === "function") {
      const result = new Type(value.size());
      for (let i = 0; i < result.length; i++) result[i] = Number(value.get(i));
      return result;
    }
    if (typeof value.length === "number") return Type.from(value);
    if (typeof value.byteLength === "number") {
      const result = new Type(value.byteLength / Type.BYTES_PER_ELEMENT);
      for (let i = 0; i < result.length; i++) result[i] = Number(value[i] ?? value[String(i)] ?? 0);
      return result;
    }
    return undefined;
  } catch (error) {
    throw new Error(`OpenUSD native array copy failed (${Type.name}): ${error?.message ?? error}`);
  }
}

// The wasm module is only present once a runtime has booted; read every
// field defensively since the wrapper build can change without notice.
function wasmHeapBuffer() {
  try {
    const module = globalThis.__USD_WEBVIEW_MODULE__;
    return module?.HEAPU8?.buffer ?? module?.wasmMemory?.buffer ?? module?.asm?.memory?.buffer ?? null;
  } catch {
    return null;
  }
}

// copyStageResult runs after every native draw/payload view has already been
// copied out by snapshotDraw/snapshotPayloads, and after weldMesh/subdivide*
// build their own fresh typed arrays. By that point mesh.positions and its
// siblings are always plain JS-owned buffers, never a live wasm heap view, so
// arrayCopy on them just doubles the same bytes. Reuse the array when it is
// already the right type and not backed by the wasm heap; only fall back to
// a real copy otherwise (a stale view, a mismatched type, or a plain array).
function ownedTyped(value, Type) {
  if (value == null) return undefined;
  if (value instanceof Type) {
    const heapBuffer = wasmHeapBuffer();
    if (!heapBuffer || value.buffer !== heapBuffer) return value;
  }
  return arrayCopy(value, Type);
}

function text(value) {
  return value == null ? undefined : String(value);
}

// Meshes with no bound material but a constant displayColor (for example
// Pixar's Kitchen_set) fall back to this synthetic MaterialX material, which
// the renderer tints per mesh.
const DISPLAY_COLOR_MATERIAL_PATH = "/__displayColor__";
const DISPLAY_COLOR_SOURCE_ASSET = "__displaycolor.mtlx";
const DISPLAY_COLOR_MATERIAL_NAME = "M_displayColor";

// Extensions no code path here ever opens: .vdb volumes are unsupported (the
// scene graph warns from the prim type, not the file), and .rat/.tx are
// renderer-specific texture caches no loader on either side decodes.
const VFS_SKIP_EXTENSIONS = new Set([".vdb", ".rat", ".tx"]);

function shouldSkipVfsUpload(path) {
  const lower = String(path ?? "").toLowerCase();
  const dot = lower.lastIndexOf(".");
  return dot >= 0 && VFS_SKIP_EXTENSIONS.has(lower.slice(dot));
}

function normalizePath(path) {
  let value = String(path ?? "").replaceAll("\\", "/");
  value = value.replace(/^\/+/, "");
  const parts = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

// OpenStage's public summary currently exposes upAxis but omits the resolved
// metersPerUnit metadata.  Recover only the root USDA header here. Stage
// metadata lives in the root layer's header; values inside customLayerData,
// sublayers, prims or quoted comments must not be mistaken for stage units.
// Binary roots are deliberately left to the native API (or the USD default)
// because this worker cannot parse a crate layer. Keep this bounded: large
// ASCII geometry files must not be decoded into a second whole-file string.
const USD_HEADER_SCAN_BYTES = 1024 * 1024;

function parseRootUsdMetrics(data) {
  if (data == null) return { ascii: false, metersPerUnit: null, upAxis: null };
  let bytes;
  try {
    if (data instanceof Uint8Array) bytes = data;
    else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else bytes = arrayCopy(data, Uint8Array);
  } catch { bytes = null; }
  if (!bytes || bytes.length < 5) return { ascii: false, metersPerUnit: null, upAxis: null };
  let offset = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  const magic = String.fromCharCode(...bytes.slice(offset, offset + 5));
  if (magic !== "#usda") return { ascii: false, metersPerUnit: null, upAxis: null };
  const scanTruncated = bytes.length - offset > USD_HEADER_SCAN_BYTES;
  let source;
  try {
    // Decode from after the optional BOM. TextDecoder normally removes a BOM,
    // but using an offset also keeps source indices aligned in every browser.
    source = new TextDecoder().decode(bytes.slice(offset, offset + USD_HEADER_SCAN_BYTES));
  } catch {
    return { ascii: true, metersPerUnit: null, upAxis: null, truncated: scanTruncated };
  }

  // The root layer metadata parenthesis must be the first non-comment token
  // after the #usda version line. A later '(' can belong to a prim field and
  // must never be treated as stage metadata.
  let i = source.indexOf("\n");
  if (i < 0) return { ascii: true, metersPerUnit: null, upAxis: null, truncated: scanTruncated, headerFound: false };
  i++;
  const skipSpaceAndCommentsAt = (at) => {
    let cursor = at;
    for (;;) {
      while (cursor < source.length && /\s/.test(source[cursor])) cursor++;
      if (source[cursor] !== '#') return cursor;
      while (cursor < source.length && source[cursor] !== '\n' && source[cursor] !== '\r') cursor++;
    }
  };
  const open = skipSpaceAndCommentsAt(i);
  if (source[open] !== '(') {
    // Seeing a non-'(' token immediately after the version line proves that
    // this layer has no root metadata block, even when geometry continues
    // beyond the bounded prefix.
    return { ascii: true, metersPerUnit: null, upAxis: null, truncated: false, headerFound: false };
  }

  let metersPerUnit = null;
  let upAxis = null;
  let depthParen = 1;
  let depthBracket = 0;
  let depthBrace = 0;
  let quote = null;
  let escaped = false;
  let comment = false;
  const isIdentStart = c => /[A-Za-z_]/.test(c);
  const isIdent = c => /[A-Za-z0-9_:]/.test(c);
  const skipSpaceAndComments = (at) => {
    let cursor = at;
    for (;;) {
      while (cursor < source.length && /\s/.test(source[cursor])) cursor++;
      if (source[cursor] !== '#') return cursor;
      while (cursor < source.length && source[cursor] !== '\n' && source[cursor] !== '\r') cursor++;
    }
  };
  let closed = false;
  for (i = open + 1; i < source.length && depthParen > 0; i++) {
    const c = source[i];
    if (comment) { if (c === "\n" || c === "\r") comment = false; continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (quote === 'tripleSingle' && source.startsWith("'''", i)) { quote = null; i += 2; }
      else if (quote === 'triple' && source.startsWith('"""', i)) { quote = null; i += 2; }
      else if (quote === 'single' && c === "'") quote = null;
      else if (quote === 'double' && c === '"') quote = null;
      continue;
    }
    if (c === '#') { comment = true; continue; }
    if (source.startsWith("'''", i)) { quote = 'tripleSingle'; i += 2; continue; }
    if (source.startsWith('"""', i)) { quote = 'triple'; i += 2; continue; }
    if (c === "'") { quote = 'single'; continue; }
    if (c === '"') { quote = 'double'; continue; }
    // Asset paths are delimited by @ and may contain parentheses or quotes.
    if (c === '@') {
      const close = source.indexOf('@', i + 1);
      if (close < 0) break;
      i = close;
      continue;
    }
    if (c === '(') { depthParen++; continue; }
    if (c === ')') { depthParen--; if (depthParen === 0) closed = true; continue; }
    if (c === '[') { depthBracket++; continue; }
    if (c === ']') { depthBracket = Math.max(0, depthBracket - 1); continue; }
    if (c === '{') { depthBrace++; continue; }
    if (c === '}') { depthBrace = Math.max(0, depthBrace - 1); continue; }
    if (depthParen !== 1 || depthBracket !== 0 || depthBrace !== 0 || !isIdentStart(c)) continue;
    let end = i + 1;
    while (end < source.length && isIdent(source[end])) end++;
    const key = source.slice(i, end);
    const equals = skipSpaceAndComments(end);
    if (source[equals] !== '=') { i = end - 1; continue; }
    const valueStart = skipSpaceAndComments(equals + 1);
    if (key === 'metersPerUnit' && metersPerUnit === null) {
      const match = source.slice(valueStart).match(/^[+\-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+\-]?\d+)?/);
      const value = match ? Number(match[0]) : NaN;
      if (Number.isFinite(value) && value > 0) metersPerUnit = value;
    } else if (key === 'upAxis' && upAxis === null && (source[valueStart] === '"' || source[valueStart] === "'")) {
      const delimiter = source[valueStart];
      const triple = source.startsWith(delimiter.repeat(3), valueStart);
      const start = valueStart + (triple ? 3 : 1);
      const closeToken = delimiter.repeat(triple ? 3 : 1);
      const close = source.indexOf(closeToken, start);
      const value = close >= 0 ? source.slice(start, close).toUpperCase() : '';
      if (value === 'Y' || value === 'Z') upAxis = value;
    }
    i = end - 1;
  }
  return { ascii: true, metersPerUnit, upAxis, truncated: scanTruncated && !closed, headerFound: closed };
}

function resolveStageMetrics(summary, rootMetrics) {
  const nativeMeters = Number(summary?.metersPerUnit);
  const nativeUp = text(summary?.upAxis)?.toUpperCase();
  const metersPerUnit = Number.isFinite(nativeMeters) && nativeMeters > 0
    ? nativeMeters
    : Number.isFinite(rootMetrics?.metersPerUnit) && rootMetrics.metersPerUnit > 0
      ? rootMetrics.metersPerUnit : 0.01; // USD's documented default
  const headerUp = rootMetrics?.upAxis === 'Y' || rootMetrics?.upAxis === 'Z' ? rootMetrics.upAxis : null;
  const upAxis = nativeUp === 'Y' || nativeUp === 'Z' ? nativeUp : (headerUp || 'Y');
  const warnings = [];
  if (!(Number.isFinite(nativeMeters) && nativeMeters > 0)) {
    if (rootMetrics?.ascii && Number.isFinite(rootMetrics.metersPerUnit)) {
      warnings.push(`[info] Native USD summary omitted metersPerUnit; using root USDA header value ${rootMetrics.metersPerUnit}`);
    } else if (!rootMetrics?.ascii) {
      warnings.push('[info] Native USD summary omitted metersPerUnit for a binary root; using USD default 0.01 (authored binary metadata unavailable)');
    }
  }
  if (!(nativeUp === 'Y' || nativeUp === 'Z')) {
    if (headerUp) warnings.push(`[info] Native USD summary omitted upAxis; using root USDA header value ${headerUp}`);
    else if (!rootMetrics?.ascii) warnings.push('[info] Native USD summary omitted upAxis for a binary root; using USD default Y (authored binary metadata unavailable)');
  }
  return { metersPerUnit, upAxis, warnings };
}

function copyTexture(texture, assets) {
  if (!texture) return undefined;
  const data = arrayCopy(texture.data, Uint8Array);
  const result = {
    path: normalizePath(texture.path),
    mimeType: text(texture.mimeType) ?? "application/octet-stream",
  };
  if (data) {
    result.data = data;
    const key = result.path;
    if (key && !assets.has(key)) assets.set(key, data);
  }
  return result;
}

function copyMaterial(material, assets) {
  if (!material) return undefined;
  const result = {};
  for (const key of [
    "path", "shaderId", "roughness", "metallic", "opacity", "clearcoat",
    "clearcoatRoughness", "ior",
  ]) {
    if (material[key] !== undefined) result[key] = material[key];
  }
  for (const key of ["diffuseColor", "emissiveColor"]) {
    const value = arrayCopy(material[key], Float32Array);
    if (value) result[key] = Array.from(value);
  }
  for (const key of [
    "diffuseTexture", "roughnessTexture", "metallicTexture", "normalTexture",
    "occlusionTexture", "emissiveTexture", "clearcoatTexture",
    "clearcoatRoughnessTexture", "opacityTexture",
  ]) {
    const texture = copyTexture(material[key], assets);
    if (texture) result[key] = texture;
  }
  if (material.materialX) {
    const mx = material.materialX;
    const resources = arrayItems(mx.resources)
      .map(resource => copyTexture(resource, assets)).filter(Boolean);
    const data = arrayCopy(mx.data, Uint8Array);
    const path = normalizePath(mx.path);
    result.materialX = {
      path,
      mimeType: text(mx.mimeType) ?? "application/xml",
      materialName: text(mx.materialName),
      ...(data ? { data } : {}),
      ...(resources.length ? { resources } : {}),
      ...(mx.report !== undefined ? { report: mx.report } : {}),
    };
    // The renderer needs the authored source asset and selected MaterialX
    // element, while materialX retains the native byte payload for a USDZ
    // entry that does not exist in the caller's original file map.
    result.sourceAsset = path;
    result.materialName = text(mx.materialName);
    const explicitSubIdentifier = text(mx.sourceAssetSubIdentifier ?? mx.subIdentifier);
    if (explicitSubIdentifier) {
      result.subIdentifier = explicitSubIdentifier;
    } else if (text(mx.materialName)) {
      // The current native payload has no field distinguishing an authored
      // sourceAsset subidentifier from the composed Material prim alias.
      // Preserve the name as a hint, never as authoritative XML selection.
      result.materialX.selectionIsInferred = true;
    }
    if (data && path && !assets.has(path)) assets.set(path, data);
  }
  return result;
}

function arrayItems(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value.size === "function" && typeof value.get === "function") {
    const result = [];
    for (let i = 0; i < value.size(); i++) result.push(value.get(i));
    return result;
  }
  if (typeof value.length === "number") return Array.from(value);
  return [];
}

function copyInstanceMatrices(value) {
  if (value == null) return { matrices: [], invalid: false };
  // Native bindings normally expose a vector of 16-element arrays.  Accept
  // the flat 16*N form too; constructing Float64Array(value) from a nested
  // array would otherwise coerce each row to NaN.
  if (ArrayBuffer.isView(value) || (Array.isArray(value) && value.every(item => typeof item === "number"))) {
    const flat = arrayCopy(value, Float64Array) ?? [];
    const matrices = [];
    for (let i = 0; i + 15 < flat.length; i += 16) matrices.push(Array.from(flat.slice(i, i + 16)));
    return {
      matrices: matrices.filter(matrix => matrix.every(Number.isFinite)),
      invalid: flat.length % 16 !== 0 || matrices.some(matrix => !matrix.every(Number.isFinite)),
    };
  }
  const matrices = [];
  let invalid = false;
  const copyOne = item => {
    const matrix = arrayCopy(item, Float64Array);
    if (!matrix || matrix.length !== 16) { invalid = true; return; }
    const values = Array.from(matrix);
    if (values.every(Number.isFinite)) matrices.push(values);
    else invalid = true;
  };
  // Copy each Embind row before asking the vector for the next row.  The next
  // native allocation can grow the WASM heap and detach an earlier view.
  if (typeof value.size === "function" && typeof value.get === "function") {
    for (let i = 0; i < value.size(); i++) copyOne(value.get(i));
  } else {
    for (const item of arrayItems(value)) copyOne(item);
  }
  return { matrices, invalid };
}

function copySubset(subset) {
  return {
    start: Number(subset.start ?? 0),
    count: Number(subset.count ?? 0),
    ...(text(subset.materialPath) ? { materialPath: text(subset.materialPath) } : {}),
    ...(text(subset.path) ? { path: text(subset.path) } : {}),
    ...(text(subset.name) ? { name: text(subset.name) } : {}),
  };
}

function copyGeomprop(prop, copyFn = arrayCopy) {
  return {
    name: text(prop.name) ?? "",
    itemSize: Number(prop.itemSize ?? 0),
    interpolation: text(prop.interpolation) ?? "",
    data: copyFn(prop.data, Float32Array),
  };
}

// copyMesh only ever runs on drawSnapshot meshes: JS objects that snapshotDraw
// already copied out of wasm memory, and that weldMesh/subdivide* only ever
// replace with fresh JS typed arrays. So every stream here is JS-owned and
// ownedTyped can hand the same array back instead of allocating a duplicate.
function copyMesh(mesh, assets, materials) {
  const positions = ownedTyped(mesh.positions ?? mesh.points, Float32Array);
  if (!positions || !positions.length) return undefined;
  const normals = ownedTyped(mesh.normals, Float32Array);
  const uvs = ownedTyped(mesh.uvs, Float32Array);
  const indices = ownedTyped(mesh.indices, Uint32Array);
  // The draw exposes displayColor as a single constant colour, never the
  // authored per-vertex array; kept for geompropvalue fallbacks.
  const displayColor = arrayCopy(mesh.displayColor, Float32Array);
  const vertexCount = positions.length / 3;
  const geomprops = arrayItems(mesh.geomprops).map(prop => copyGeomprop(prop, ownedTyped)).filter(prop => prop.data && Number.isInteger(prop.itemSize) && prop.itemSize > 0 && prop.data.length === vertexCount * prop.itemSize);
  const material = copyMaterial(mesh.material, assets);
  const materialPath = text(mesh.materialPath) ?? text(mesh.material?.path);
  if (materialPath && material) materials.set(materialPath, material);
  const groups = arrayItems(mesh.subsets ?? mesh.materialSubsets).map(copySubset);
  const matrix = ownedTyped(mesh.matrix, Float64Array);
  const hasInstanceMatrices = mesh.instanceMatrices != null;
  const instance = copyInstanceMatrices(mesh.instanceMatrices);
  const cage = mesh.cage ? {
    positions: ownedTyped(mesh.cage.positions, Float32Array),
    ...(mesh.cage.normals ? { normals: ownedTyped(mesh.cage.normals, Float32Array) } : {}),
    ...(mesh.cage.uvs ? { uvs: ownedTyped(mesh.cage.uvs, Float32Array) } : {}),
    ...(mesh.cage.indices ? { indices: ownedTyped(mesh.cage.indices, Uint32Array) } : {}),
    ...(mesh.cage.subsets?.length ? { subsets: mesh.cage.subsets.map(copySubset) } : {}),
    ...(mesh.cage.geomprops?.length ? { geomprops: mesh.cage.geomprops.map(prop => copyGeomprop(prop, ownedTyped)).filter(prop => prop.data && prop.data.length) } : {}),
  } : undefined;
  return {
    primPath: text(mesh.path) ?? text(mesh.primPath) ?? "",
    name: text(mesh.name) ?? "",
    positions,
    ...(normals ? { normals } : {}),
    ...(uvs ? { uvs } : {}),
    ...(geomprops.length ? { geomprops } : {}),
    ...(displayColor && displayColor.length ? { displayColor: Array.from(displayColor) } : {}),
    ...(indices ? { indices } : {}),
    matrix: matrix ? Array.from(matrix) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    orientation: mesh.orientation === "leftHanded" ? "leftHanded" : "rightHanded",
    castsShadow: mesh.castsShadow !== false,
    ...(mesh.subdivisionScheme ? { subdivisionScheme: mesh.subdivisionScheme } : {}),
    ...(Number.isFinite(mesh.subdivisionLevelsApplied) ? { subdivisionLevelsApplied: mesh.subdivisionLevelsApplied } : {}),
    ...(cage ? { cage } : {}),
    ...(materialPath ? { materialPath } : {}),
    ...(groups.length ? { groups } : {}),
    ...(hasInstanceMatrices ? {
      instanceMatrices: instance.matrices,
      ...(instance.invalid ? { instanceMatricesInvalid: true } : {}),
    } : {}),
    ...(text(mesh.instanceOwnerPath) ? { instanceOwnerPath: text(mesh.instanceOwnerPath) } : {}),
  };
}

// Make a raw-shape snapshot while the native draw object is still valid.  A
// normalized mesh is deliberately not used here: copyStageResult needs the
// native field names (path/subsets/material) to retain mesh-level provenance.
function snapshotDraw(draw) {
  const snapshotMesh = (mesh) => {
    if (!mesh) return undefined;
    const positions = arrayCopy(mesh.positions ?? mesh.points, Float32Array);
    if (!positions || !positions.length) return undefined;
    const normals = arrayCopy(mesh.normals, Float32Array);
    const uvs = arrayCopy(mesh.uvs, Float32Array);
    const indices = arrayCopy(mesh.indices, Uint32Array);
    const displayColor = arrayCopy(mesh.displayColor, Float32Array);
    // Copy geomprops here, not on demand later: their `data` is a view into
    // WASM memory and the next source.get(i) below can detach it (see the
    // comment on the caller loop).
    const geomprops = arrayItems(mesh.geomprops)
      .map(prop => copyGeomprop(prop))
      .filter(prop => prop.data && prop.data.length && Number.isInteger(prop.itemSize) && prop.itemSize > 0 &&
        prop.data.length === (positions.length / 3) * prop.itemSize);
    const matrix = arrayCopy(mesh.matrix, Float64Array);
    const hasInstanceMatrices = mesh.instanceMatrices != null;
    const instance = copyInstanceMatrices(mesh.instanceMatrices);
    return {
      path: text(mesh.path) ?? text(mesh.primPath) ?? "",
      name: text(mesh.name) ?? "",
      positions,
      ...(normals ? { normals } : {}),
      ...(uvs ? { uvs } : {}),
      ...(geomprops.length ? { geomprops } : {}),
      ...(displayColor && displayColor.length ? { displayColor: Array.from(displayColor) } : {}),
      ...(indices ? { indices } : {}),
      matrix,
      materialPath: text(mesh.materialPath) ?? text(mesh.material?.path),
      material: copyMaterial(mesh.material, new Map()),
      castsShadow: mesh.castsShadow !== false,
      subsets: arrayItems(mesh.subsets ?? mesh.materialSubsets).map(copySubset),
      ...(hasInstanceMatrices ? {
        instanceMatrices: instance.matrices,
        ...(instance.invalid ? { instanceMatricesInvalid: true } : {}),
      } : {}),
      ...(text(mesh.instanceOwnerPath) ? { instanceOwnerPath: text(mesh.instanceOwnerPath) } : {}),
    };
  };
  const meshes = [];
  const source = draw?.meshes;
  // Calling get(i) for every native mesh first can allocate the next native
  // result and grow WASM memory, detaching the previous mesh's view. Copy
  // each item before requesting the next one.
  if (source && typeof source.size === "function" && typeof source.get === "function") {
    for (let i = 0; i < source.size(); i++) {
      const snapshot = snapshotMesh(source.get(i));
      if (snapshot) meshes.push(snapshot);
    }
  } else {
    for (const mesh of arrayItems(source)) {
      const snapshot = snapshotMesh(mesh);
      if (snapshot) meshes.push(snapshot);
    }
  }
  return { meshes };
}

function snapshotPayloads(payloads) {
  const snapshots = [];
  const copy = (entry) => {
    if (!entry) return;
    snapshots.push({ path: text(entry.path), material: copyMaterial(entry.material, new Map()) });
  };
  if (payloads && typeof payloads.size === "function" && typeof payloads.get === "function") {
    for (let i = 0; i < payloads.size(); i++) copy(payloads.get(i));
  } else {
    for (const entry of arrayItems(payloads)) copy(entry);
  }
  return snapshots;
}

function sameNumberArray(left, right, epsilon = 1e-6) {
  if (!left || !right || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (Math.abs(Number(left[i]) - Number(right[i])) > epsilon) return false;
  }
  return true;
}

function sameFiniteStream(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (!Number.isFinite(Number(left[i])) || !Number.isFinite(Number(right[i]))) return false;
    if (Math.abs(Number(left[i]) - Number(right[i])) > 1e-6) return false;
  }
  return true;
}

function sameCornerIndices(generated, ordinary, vertexCount) {
  if (generated?.length && ordinary?.length) return sameNumberArray(generated, ordinary, 0);
  if (ordinary?.length) return false;
  if (!generated || generated.length !== vertexCount) return false;
  for (let index = 0; index < generated.length; index++) {
    if (Number(generated[index]) !== index) return false;
  }
  return true;
}

// The native draw ignores UsdGeomMesh orientation = "leftHanded" for topology.
// Authored normals already carry the authored orientation, while generated
// smooth normals follow the native right-handed fallback and need a sign fix.
// getPrimAttributes exposes the authored token and normal provenance so the
// worker can correct only the generated stream.
function readOrientation(api, root, primPath) {
  return readMeshTokens(api, root, primPath).orientation;
}

function hasAuthoredNormalData(record) {
  const typeName = text(record?.typeName)?.replace(/\s+/g, "").toLowerCase();
  const supportedTypes = new Set(["float3[]", "vector3f[]", "point3f[]", "normal3f[]", "color3f[]", "texcoord3f[]"]);
  if (!record?.isAuthored || !supportedTypes.has(typeName)) return false;
  const rawCount = record?.valueElementCount;
  if (rawCount != null && String(rawCount).trim() !== "") {
    const count = Number(rawCount);
    if (Number.isFinite(count)) return count > 0;
  }
  return parseNumbers(record?.value).length >= 3;
}

// getPrimAttributes stringifies faceVertexCounts and truncates long arrays
// with a "... N more" tail; valueElementCount holds the true total but only
// the printed prefix is ever needed here, so anything after "..." is dropped.
function parseFaceVertexCounts(record) {
  const raw = String(record?.value ?? "");
  const cut = raw.indexOf("...");
  const prefix = cut >= 0 ? raw.slice(0, cut) : raw;
  const matches = prefix.match(/-?\d+/g);
  return matches && matches.length ? matches.map(Number) : undefined;
}

// Reads orientation, subdivisionScheme, authored normal provenance, and a
// (possibly truncated) faceVertexCounts prefix with a single
// getPrimAttributes call. Normal array values may be truncated too, so only
// their type, authored flag, and bounded nonempty metadata are inspected.
function readMeshTokens(api, root, primPath) {
  const tokens = { orientation: "rightHanded", subdivisionScheme: undefined, authoredNormals: false, faceVertexCounts: undefined };
  if (typeof api.getPrimAttributes !== "function" || !primPath) return tokens;
  try {
    for (const record of arrayItems(api.getPrimAttributes(root, primPath))) {
      const name = text(record?.name);
      if (name === "orientation") tokens.orientation = text(record.value) === "leftHanded" ? "leftHanded" : "rightHanded";
      else if (name === "subdivisionScheme") tokens.subdivisionScheme = text(record.value);
      else if (name === "faceVertexCounts") tokens.faceVertexCounts = parseFaceVertexCounts(record);
      else if (name === "primvars:normals" || name === "normals") {
        tokens.authoredNormals ||= hasAuthoredNormalData(record);
      }
    }
  } catch {
    // Tolerate any native failure and fall back to the USD default.
  }
  return tokens;
}

// --- Camera transform composition --------------------------------------
// ExtractTransformsAtTime only covers meshes; camera world matrices are
// composed here from raw xformOp attributes using plain row-major USD
// matrix math (row vectors: p' = p * M), matching the layout mesh.matrix
// already uses so the renderer can treat both the same way.

function parseOpOrderList(value) {
  const inner = String(value ?? "").replace(/^\s*\[/, "").replace(/\]\s*$/, "");
  if (!inner.trim()) return [];
  return inner.split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

function parseNumbers(value) {
  const matches = String(value ?? "").match(/-?\d+\.?\d*(?:[eE][-+]?\d+)?/g);
  return matches ? matches.map(Number) : [];
}

function identity4() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }

function mul4(a, b) {
  const r = new Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[i * 4 + k] * b[k * 4 + j];
      r[i * 4 + j] = sum;
    }
  }
  return r;
}

function translateM(x, y, z) { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]; }
function scaleM(x, y, z) { return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1]; }

function rotateXM(deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
}
function rotateYM(deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}
function rotateZM(deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function orientM(w, x, y, z) {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ];
}

// Generic 4x4 inverse via Gauss-Jordan elimination on an augmented matrix;
// used only for the rare `!invert!` xformOp prefix.
function invert4(m) {
  const a = m.slice();
  const inv = identity4();
  for (let col = 0; col < 4; col++) {
    let pivot = col;
    for (let row = col + 1; row < 4; row++) {
      if (Math.abs(a[row * 4 + col]) > Math.abs(a[pivot * 4 + col])) pivot = row;
    }
    if (Math.abs(a[pivot * 4 + col]) < 1e-12) return identity4();
    if (pivot !== col) {
      for (let k = 0; k < 4; k++) {
        [a[col * 4 + k], a[pivot * 4 + k]] = [a[pivot * 4 + k], a[col * 4 + k]];
        [inv[col * 4 + k], inv[pivot * 4 + k]] = [inv[pivot * 4 + k], inv[col * 4 + k]];
      }
    }
    const div = a[col * 4 + col];
    for (let k = 0; k < 4; k++) { a[col * 4 + k] /= div; inv[col * 4 + k] /= div; }
    for (let row = 0; row < 4; row++) {
      if (row === col) continue;
      const factor = a[row * 4 + col];
      if (!factor) continue;
      for (let k = 0; k < 4; k++) {
        a[row * 4 + k] -= factor * a[col * 4 + k];
        inv[row * 4 + k] -= factor * inv[col * 4 + k];
      }
    }
  }
  return inv;
}

const ROTATE_TRIPLE_AXES = {
  rotateXYZ: ["X", "Y", "Z"], rotateXZY: ["X", "Z", "Y"], rotateYXZ: ["Y", "X", "Z"],
  rotateYZX: ["Y", "Z", "X"], rotateZXY: ["Z", "X", "Y"], rotateZYX: ["Z", "Y", "X"],
};
const ROTATE_AXIS_FN = { X: rotateXM, Y: rotateYM, Z: rotateZM };

// Composes one prim's local matrix from its own xformOpOrder tokens.
// Returns { matrix, unsupported } where unsupported names the first op kind
// this worker cannot compose (the caller drops the prim in that case).
function composeLocalMatrix(orderTokens, attrMap, primPath, warn, label = "Camera") {
  let m = identity4();
  for (const token of orderTokens) {
    if (token === "!resetXformStack!") continue;
    let name = token;
    let invert = false;
    if (name.startsWith("!invert!")) { invert = true; name = name.slice("!invert!".length); }
    const withoutPrefix = name.startsWith("xformOp:") ? name.slice("xformOp:".length) : name;
    const kind = withoutPrefix.split(":")[0];
    const record = attrMap.get(name);
    const nums = record ? parseNumbers(record.value) : [];
    let opM;
    if (kind === "translate") opM = translateM(nums[0] || 0, nums[1] || 0, nums[2] || 0);
    else if (kind === "scale") opM = scaleM(nums[0] ?? 1, nums[1] ?? 1, nums[2] ?? 1);
    else if (kind === "rotateX") opM = rotateXM(nums[0] || 0);
    else if (kind === "rotateY") opM = rotateYM(nums[0] || 0);
    else if (kind === "rotateZ") opM = rotateZM(nums[0] || 0);
    else if (ROTATE_TRIPLE_AXES[kind]) {
      const [a1, a2, a3] = ROTATE_TRIPLE_AXES[kind];
      opM = mul4(mul4(ROTATE_AXIS_FN[a1](nums[0] || 0), ROTATE_AXIS_FN[a2](nums[1] || 0)), ROTATE_AXIS_FN[a3](nums[2] || 0));
    } else if (kind === "orient") {
      opM = orientM(nums[0] || 0, nums[1] || 0, nums[2] || 0, nums[3] || 0);
    } else if (kind === "transform") {
      opM = nums.length >= 16 ? nums.slice(0, 16) : identity4();
    } else {
      warn(`${label} ${primPath}: unsupported transform op ${name}, ${label.toLowerCase()} skipped`);
      return { matrix: identity4(), unsupported: true };
    }
    if (invert) opM = invert4(opM);
    // xformOpOrder lists the outermost op first: a point meets the last op
    // first, so each op is prepended (row vectors: p' = p * opN * ... * op1).
    m = mul4(opM, m);
  }
  return { matrix: m, unsupported: false };
}

function readPrimAttrMap(api, root, primPath) {
  const map = new Map();
  if (typeof api.getPrimAttributes !== "function" || !primPath) return map;
  try {
    for (const record of arrayItems(api.getPrimAttributes(root, primPath))) {
      const name = text(record?.name);
      if (name) map.set(name, record);
    }
  } catch {
    // Tolerate any native failure; the prim contributes an identity matrix.
  }
  return map;
}

function parentPrimPath(primPath) {
  const normalized = text(primPath)?.replace(/\/+$/, "");
  if (!normalized || normalized === "/") return "";
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}

// Karma's rendervisibility token is inherited by descendants. The viewer only
// consumes the evidenced -shadow token; every other value keeps the default
// shadow-casting behavior.
function readMeshCastsShadowOverride(api, root, primPath) {
  let current = text(primPath);
  while (current) {
    const attributes = readPrimAttrMap(api, root, current);
    const record = attributes.get("primvars:karma:object:rendervisibility");
    if (record && record.isAuthored !== false) {
      const value = text(record.value) ?? "";
      const tokens = value.split(/[^A-Za-z0-9_-]+/).filter(Boolean);
      return !tokens.includes("-shadow");
    }
    current = parentPrimPath(current);
  }
  return undefined;
}

function readMeshCastsShadow(api, root, primPath) {
  return readMeshCastsShadowOverride(api, root, primPath) ?? true;
}

function readInstanceCastsShadow(api, root, mesh) {
  const owner = text(mesh?.instanceOwnerPath);
  const ownerOverride = readMeshCastsShadowOverride(api, root, owner);
  if (ownerOverride !== undefined) return ownerOverride;
  const marker = "/__instances__/";
  const instancePath = text(mesh?.path);
  const markerIndex = instancePath ? instancePath.indexOf(marker) : -1;
  if (markerIndex < 0 || typeof api.inspectPrimRelationships !== "function") return true;
  const tail = instancePath.slice(markerIndex + marker.length);
  const prototypeName = tail.split("/")[0];
  if (!prototypeName) return true;
  let targets = [];
  try { targets = collectPrototypeTargets(api.inspectPrimRelationships(root, owner)); } catch { targets = []; }
  const matching = [...new Set(targets)].filter(target => target.split("/").pop() === prototypeName);
  if (matching.length !== 1) return true;
  const relativeMeshPath = tail.slice(prototypeName.length).replace(/^\//, "");
  const prototypePath = relativeMeshPath ? `${matching[0]}/${relativeMeshPath}` : matching[0];
  return readMeshCastsShadowOverride(api, root, prototypePath) ?? true;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Finds the `{ ... }` body of a `def "name" ... {` or `over "name" ... {`
// block in a USD text layer (balanced braces, nested prim blocks included),
// trying every occurrence of the name in turn and accepting only a body
// that actually authors at least one `inputs:` attribute. This is tolerant
// of an unrelated prim (e.g. a Mesh) sharing the Material's leaf name: such
// a block has no `inputs:` lines and is skipped in favor of the real one.
function findNamedBlockBodyWithInputs(usdaText, name) {
  const openRe = new RegExp('(?:\\bdef\\b|\\bover\\b)\\s+(?:\\w+\\s+)?"' + escapeRegExp(name) + '"[^{]*\\{', "g");
  let match;
  while ((match = openRe.exec(usdaText))) {
    const braceStart = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = braceStart; i < usdaText.length; i++) {
      const c = usdaText[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          const body = usdaText.slice(braceStart + 1, i);
          if (/\binputs:/.test(body)) return body;
          openRe.lastIndex = i + 1;
          break;
        }
      }
    }
  }
  return null;
}

// `over`/`def` prim names declared anywhere inside a block body, regardless
// of nesting depth (a shader-node override sits one level under its
// Material's own `over` block, but this stays correct if a DCC nests it
// deeper).
function collectNamedChildren(blockBody) {
  const names = new Set();
  const re = /\b(?:def|over)\s+(?:\w+\s+)?"([^"]+)"/g;
  let m;
  while ((m = re.exec(blockBody))) names.add(m[1]);
  return names;
}

// Balanced `{...}` body starting at the first brace of `text`, or null.
function leadingBraceBody(text) {
  const start = text.indexOf("{");
  if (start < 0 || text.slice(0, start).trim()) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start + 1, i);
  }
  return null;
}

// Value text immediately after an `=`: a parenthesised/bracketed tuple, a
// quoted string, or the rest of the line.
function leadingValueText(text) {
  const open = text[0];
  const close = open === "(" ? ")" : open === "[" ? "]" : null;
  if (close) {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === open) depth++;
      else if (text[i] === close && --depth === 0) return text.slice(0, i + 1).trim();
    }
  }
  return text.split("\n")[0].trim();
}

// `time: value` pairs of a `.timeSamples` map, in authored order.
function parseTimeSamples(body) {
  const samples = [];
  const re = /(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*:\s*/g;
  let m;
  while ((m = re.exec(body))) {
    const value = leadingValueText(body.slice(m.index + m[0].length));
    if (value) samples.push([Number(m[1]), value.replace(/,$/, "")]);
  }
  return samples;
}

// `inputs:*` attributes authored directly in one plain-text USD block scope.
function collectScopeInputs(scopeText) {
  const inputs = new Map();
  const re = /\binputs:([A-Za-z0-9_:]+?)(\.timeSamples)?\s*=\s*/g;
  let m;
  while ((m = re.exec(scopeText))) {
    const rest = scopeText.slice(m.index + m[0].length);
    const entry = inputs.get(m[1]) ?? { value: null, timeSamples: null };
    if (m[2]) {
      const body = leadingBraceBody(rest);
      if (body !== null) entry.timeSamples = parseTimeSamples(body);
    } else {
      entry.value = leadingValueText(rest) || entry.value;
    }
    inputs.set(m[1], entry);
  }
  return inputs;
}

// `inputs:*` attributes a plain-text layer authors inside a Material block,
// keyed by shader-node name (null for the Material prim itself). Nested
// blocks contribute under their own name at any depth, matching
// collectNamedChildren.
function collectAuthoredBlockInputs(blockBody, out = new Map()) {
  const re = /\b(?:def|over)\s+(?:\w+\s+)?"([^"]+)"[^{]*\{/g;
  let own = "", cursor = 0, m;
  while ((m = re.exec(blockBody))) {
    if (m.index < cursor) continue;
    const braceStart = m.index + m[0].length - 1;
    let depth = 0, end = -1;
    for (let i = braceStart; i < blockBody.length; i++) {
      const c = blockBody[i];
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { end = i; break; }
    }
    if (end < 0) break;
    own += blockBody.slice(cursor, m.index);
    const inner = collectAuthoredBlockInputs(blockBody.slice(braceStart + 1, end), new Map());
    const merged = out.get(m[1]) ?? new Map();
    for (const [name, entry] of inner.get(null) ?? new Map()) merged.set(name, entry);
    out.set(m[1], merged);
    for (const [node, inputs] of inner) if (node !== null) out.set(node, inputs);
    cursor = end + 1;
    re.lastIndex = end + 1;
  }
  own += blockBody.slice(cursor);
  const ownInputs = out.get(null) ?? new Map();
  for (const [name, entry] of collectScopeInputs(own)) ownInputs.set(name, entry);
  out.set(null, ownInputs);
  return out;
}

// Value of a `.timeSamples` map at `time`: the last sample at or before it,
// falling back to the first. Integer frames land on a sample, so the held
// read matches USD's own resolution there.
function sampleValueAtTime(samples, time) {
  if (!Array.isArray(samples) || !samples.length) return null;
  const sorted = samples.slice().sort((a, b) => a[0] - b[0]);
  if (!Number.isFinite(time)) return sorted[0][1];
  let picked = sorted[0][1];
  for (const [at, value] of sorted) {
    if (at > time) break;
    picked = value;
  }
  return picked;
}

// Element names declared in a MaterialX document's XML text: any tag with a
// `name="..."` attribute (nodes, nodegraph children, the surfacematerial),
// excluding structural elements (`materialx`, and an element's own `input`/
// `output`/`token`/`member` children, which are not themselves override
// targets).
const MTLX_NON_TARGET_TAGS = new Set(["materialx", "input", "output", "token", "member"]);
function collectMtlxElementNames(mtlxText) {
  const names = new Set();
  const re = /<([A-Za-z_][\w.]*)\b[^>]*\bname\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(mtlxText))) {
    if (MTLX_NON_TARGET_TAGS.has(m[1])) continue;
    names.add(m[2]);
  }
  return names;
}

// Text of the MaterialX document(s) relevant to one material record: the
// native inline materialX.data payload when present (the resolved network
// actually selected, includes composed from a usdMtlx nodegraph), plus the
// uploaded sourceAsset .mtlx file's own text as a fallback/second source.
function decodeMtlxTextsForMaterial(material, mtlxFileTextsByPath) {
  const texts = [];
  try {
    const data = material?.materialX?.data;
    if (data) texts.push(new TextDecoder().decode(data));
  } catch { /* not text, skip */ }
  const sourceAsset = text(material?.sourceAsset) || text(material?.materialX?.path);
  if (sourceAsset) {
    const fromFiles = mtlxFileTextsByPath.get(normalizePath(sourceAsset));
    if (fromFiles) texts.push(fromFiles);
  }
  return texts;
}

// Safe over-approximation of "this mesh's bound material can ever produce a
// MaterialX displacement": true whenever any available text source mentions
// "displacement" (the MaterialX node category/shader type and the UsdShade
// output token both contain that substring). Must never return false for a
// material that actually displaces, since the renderer only re-subdivides
// from mesh.cage when it later confirms displacement after compiling the
// shader; a missed cage there would silently re-subdivide the wrong mesh.
function meshMaterialMayDisplace(mesh, mtlxFileTextsByPath, usdaTexts) {
  if (!mesh.materialPath && !mesh.material) return false; // no bound material at all
  const texts = decodeMtlxTextsForMaterial(mesh.material, mtlxFileTextsByPath);
  if (texts.some((t) => /displacement/i.test(t))) return true;
  const leaf = text(mesh.materialPath)?.split("/").filter(Boolean).pop();
  if (!leaf) return true; // material bound but path unknown here, stay conservative
  for (const layer of usdaTexts) {
    if (layer.text.includes(leaf) && /displacement/i.test(layer.text)) return true;
  }
  return false;
}

// USD `over` blocks under a Material prim (asset file swaps, place2d scale,
// glass parameters, etc.) are authored on the material's descendant shader
// prims. Candidate child names come from two sources: primarily the
// material's own resolved MaterialX document text (mtlxTexts) -- the
// authoritative node/nodegraph/material-alias namespace, and the only source
// that still works when the override's root USD layer is a binary usdc file
// -- and secondarily the uploaded USD text layers, scanned for the Material
// prim's own named block, so an override naming a node that does not exist
// in the document at all is still discovered and can be reported as a
// missing-node warning instead of silently dropped (getSceneGraph itself
// cannot help here: it only lists prims with a resolved type, and an
// override-only prim has none, even though getPrimAttributes resolves it
// directly once its path is known). The Scene applies the composed
// attribute values onto the resolved MaterialX document.
function collectMaterialOverrides(api, root, usdaLayers, mtlxTexts, materialPath, stageTime = Number.NaN) {
  const overrides = [];
  if (!materialPath) return overrides;
  const leafName = materialPath.split("/").filter(Boolean).pop();
  if (!leafName) return overrides;
  const childNames = new Set();
  for (const mtlxText of mtlxTexts) {
    for (const name of collectMtlxElementNames(mtlxText)) childNames.add(name);
  }
  // Attributes the uploaded text layers author inside this Material's block.
  // getPrimAttributes reads at the default time only, so a value composed
  // from a time-sampled `over` comes back as the fallback; the text layers
  // are the one source that still carries the samples.
  const authored = new Map();
  for (const layer of usdaLayers) {
    const body = findNamedBlockBodyWithInputs(layer.text, leafName);
    if (!body) continue;
    for (const name of collectNamedChildren(body)) childNames.add(name);
    for (const [node, inputs] of collectAuthoredBlockInputs(body)) {
      const merged = authored.get(node) ?? new Map();
      for (const [name, entry] of inputs) merged.set(name, entry);
      authored.set(node, merged);
    }
  }
  // Default-time value text of each time-sampled Material interface input,
  // mapped to its value at the stage start time. A value shared by two
  // animated interfaces is ambiguous and is left out.
  const animatedFallbacks = new Map();
  const readInto = (primPath, node) => {
    const attrMap = readPrimAttrMap(api, root, primPath);
    const scope = authored.get(node);
    for (const [name, record] of attrMap) {
      if (!name.startsWith("inputs:")) continue;
      const input = name.slice("inputs:".length);
      const samples = scope?.get(input)?.timeSamples;
      const composed = text(record?.value);
      const sampled = samples ? sampleValueAtTime(samples, stageTime) : null;
      if (node === null && sampled && composed) {
        animatedFallbacks.set(composed, animatedFallbacks.has(composed) ? null : sampled);
      }
      // A shader-node input whose composed value is the fallback of an
      // animated Material interface input is driven by that interface: USD
      // gives the connection precedence, but getPrimAttributes reads at the
      // default time and cannot follow it, so the raw read is stale. The
      // native payload already resolved it at the stage start time, and
      // re-applying the default-time read would overwrite that with the
      // fallback. Carry the start-time sample instead.
      const retargeted = node !== null && composed ? animatedFallbacks.get(composed) : undefined;
      const valueText = sampled ?? retargeted ?? composed;
      if (!valueText) continue; // metadata-only attribute, no authored value
      overrides.push({ node, input, value: valueText });
    }
  };
  readInto(materialPath, null);
  for (const name of childNames) readInto(materialPath + "/" + name, name);
  return overrides;
}

// UsdShade network to MaterialX: the native payload drops vector2 connections
// and skips networks nested in a NodeGraph, so rebuild them from USD text
// layers (connections) and composed attribute values.

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sanitizeMtlxName(name) {
  let value = String(name ?? "").replace(/[^A-Za-z0-9_]/g, "_");
  if (!/^[A-Za-z_]/.test(value)) value = "_" + value;
  return value || "_node";
}

// Body of the first `def`/`over` block named `name` in `scopeText`; unlike
// findNamedBlockBodyWithInputs it accepts containers without inputs.
function findNamedBlockBody(scopeText, name) {
  const openRe = new RegExp('(?:\\bdef\\b|\\bover\\b)\\s+(?:\\w+\\s+)?"' + escapeRegExp(name) + '"[^{]*\\{', "g");
  let match;
  while ((match = openRe.exec(scopeText))) {
    const braceStart = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = braceStart; i < scopeText.length; i++) {
      const c = scopeText[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return scopeText.slice(braceStart + 1, i);
      }
    }
  }
  return null;
}

// Resolves a Material's block body by walking its full path (Scope/Xform
// ancestors included) through nested def/over blocks, so the correct prim is
// found even when an unrelated sibling shares the Material's leaf name.
function findMaterialBlockBody(usdaText, materialPath) {
  const segments = String(materialPath ?? "").split("/").filter(Boolean);
  if (!segments.length) return null;
  let scope = usdaText;
  for (const segment of segments) {
    const body = findNamedBlockBody(scope, segment);
    if (body == null) return null;
    scope = body;
  }
  return scope;
}

// Direct child `def`/`over` blocks of `body` with their spans, so callers can
// recurse into children or strip them to read a prim's own attributes.
function extractChildBlocks(body) {
  const results = [];
  const re = /\b(?:def|over)\s+(?:(\w+)\s+)?"([^"]+)"[^{]*\{/g;
  let match;
  while ((match = re.exec(body))) {
    const typeName = match[1] || null;
    const name = match[2];
    const braceStart = match.index + match[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = braceStart; i < body.length; i++) {
      const c = body[i];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) break;
    results.push({ name, typeName, body: body.slice(braceStart + 1, end), start: match.index, end: end + 1 });
    re.lastIndex = end + 1;
  }
  return results;
}

function stripChildBlocks(body, childBlocks) {
  let result = "";
  let cursor = 0;
  for (const child of childBlocks) {
    result += body.slice(cursor, child.start);
    cursor = child.end;
  }
  result += body.slice(cursor);
  return result;
}

function extractAngleTarget(value) {
  const match = String(value ?? "").match(/<([^>]+)>/);
  return match ? match[1] : null;
}

// A prim's own info:id, inputs and outputs (children stripped), line by line
// so an attribute's trailing metadata block (colorSpace) can be read.
function parseShadeAttrs(bodyText) {
  const childBlocks = extractChildBlocks(bodyText);
  const ownText = stripChildBlocks(bodyText, childBlocks);
  const lines = ownText.split(/\r?\n/);
  const inputs = new Map();
  const outputs = new Map();
  let id = null;
  const idRe = /\binfo:id\s*=\s*"([^"]+)"/;
  const declOnlyRe = /^\s*(?:uniform\s+)?(\w[\w:]*)\s+outputs:([\w:]+)\s*$/;
  const attrRe = /^\s*(?:uniform\s+)?(\w[\w:]*)\s+(inputs|outputs):([\w:]+)(\.connect)?\s*=\s*(.*)$/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idMatch = line.match(idRe);
    if (idMatch) { id = idMatch[1]; continue; }
    const declMatch = line.match(declOnlyRe);
    if (declMatch) {
      if (!outputs.has(declMatch[2])) outputs.set(declMatch[2], { usdType: declMatch[1], isConnect: false });
      continue;
    }
    const attrMatch = line.match(attrRe);
    if (!attrMatch) continue;
    const [, usdType, kind, name, connectFlag, rawRest] = attrMatch;
    const isConnect = !!connectFlag;
    let rest = rawRest.trim();
    let colorSpace;
    if (!isConnect && rest.endsWith("(")) {
      // A dangling open paren means the value's own metadata block starts
      // here (an asset input's colorSpace); scan forward to the close.
      rest = rest.slice(0, -1).trim();
      let j = i + 1;
      const metaLines = [];
      while (j < lines.length && !lines[j].includes(")")) { metaLines.push(lines[j]); j++; }
      if (j < lines.length) metaLines.push(lines[j].slice(0, lines[j].indexOf(")")));
      const metaText = metaLines.join("\n");
      const csMatch = metaText.match(/colorSpace\s*=\s*"([^"]+)"/);
      if (csMatch) colorSpace = csMatch[1];
      i = j;
    }
    const entry = {
      usdType,
      isConnect,
      connect: isConnect ? extractAngleTarget(rest) : undefined,
      value: isConnect ? undefined : rest,
      colorSpace,
    };
    if (kind === "inputs") inputs.set(name, entry);
    else outputs.set(name, entry);
  }
  return { id, inputs, outputs };
}

function parseUsdShadeConnectTarget(raw) {
  const match = String(raw ?? "").match(/^(.*)\.(outputs|inputs):([\w:]+)$/);
  if (!match) return null;
  return { path: match[1], kind: match[2], port: match[3] };
}

// Follows a connection through NodeGraph outputs and interface inputs to the
// originating shader node output, or to a plain value authored on the
// NodeGraph itself. Returns null on any unresolved hop (a genuine gap).
function resolveShadeConnection(rawTarget, shaders, nodeGraphs, depth = 0) {
  if (!rawTarget || depth > 32) return null;
  const parsed = parseUsdShadeConnectTarget(rawTarget);
  if (!parsed) return null;
  if (shaders.has(parsed.path)) return { kind: "node", path: parsed.path, port: parsed.port };
  const graph = nodeGraphs.get(parsed.path);
  if (!graph) return null;
  const bucket = parsed.kind === "inputs" ? graph.attrs.inputs : graph.attrs.outputs;
  const entry = bucket.get(parsed.port);
  if (!entry) return null;
  if (entry.isConnect) return resolveShadeConnection(entry.connect, shaders, nodeGraphs, depth + 1);
  if (entry.value !== undefined && entry.value !== "") {
    return { kind: "value", usdType: entry.usdType, value: entry.value, colorSpace: entry.colorSpace, path: graph.path, port: parsed.port };
  }
  return null;
}

const USD_TO_MTLX_TYPE = {
  float: "float", double: "float",
  float2: "vector2", texCoord2f: "vector2",
  float3: "vector3", normal3f: "vector3", vector3f: "vector3", point3f: "vector3",
  color3f: "color3",
  color4f: "color4",
  float4: "vector4",
  int: "integer",
  bool: "boolean",
  string: "string", token: "string",
  asset: "filename",
  matrix3d: "matrix33",
  matrix4d: "matrix44",
};

const MTLX_TYPE_SUFFIXES = [
  "_surfaceshader", "_displacementshader", "_volumeshader", "_material",
  "_matrix33", "_matrix44", "_boolean", "_integer", "_filename", "_string",
  "_color4", "_color3", "_vector4", "_vector3", "_vector2", "_float",
].sort((a, b) => b.length - a.length);

// MaterialX category and type from `info:id` (strip ND_ and a type suffix);
// ids without a suffix (1.38 ND_normalmap) take the USD output type.
function resolveNodeCategoryAndType(id, declaredOutputUsdType) {
  const base = id.startsWith("ND_") ? id.slice(3) : id;
  for (const suffix of MTLX_TYPE_SUFFIXES) {
    if (base.endsWith(suffix) && base.length > suffix.length) {
      return { category: base.slice(0, -suffix.length), type: suffix.slice(1) };
    }
  }
  return { category: base, type: USD_TO_MTLX_TYPE[declaredOutputUsdType] || "float" };
}

function primaryOutput(attrs) {
  if (attrs.outputs.has("out")) return { name: "out", ...attrs.outputs.get("out") };
  const first = attrs.outputs.entries().next();
  return first.done ? null : { name: first.value[0], ...first.value[1] };
}

function mapColorSpace(value) {
  if (!value) return undefined;
  if (value === "sRGB") return "srgb_texture";
  if (value === "raw") return "none";
  return value;
}

// Anchors an asset value (already stripped of its @...@ delimiters) relative
// to the USD layer that authored it, matching normalizePath's join style so
// the result reads root-relative like the native inline payload does.
function anchorAssetPath(layerPath, assetValue) {
  if (/^[A-Za-z][\w+.-]*:\/\//.test(assetValue) || assetValue.startsWith("/")) return normalizePath(assetValue);
  const dir = normalizePath(layerPath ?? "").split("/").slice(0, -1).join("/");
  return normalizePath(dir ? dir + "/" + assetValue : assetValue);
}

function formatShadeValue(rawValue, usdType) {
  let value = String(rawValue ?? "").trim();
  if (usdType === "asset") return value.replace(/^@/, "").replace(/@$/, "").trim();
  if (value.startsWith("(") && value.endsWith(")")) value = value.slice(1, -1).trim();
  if (usdType === "bool") return (value === "1" || value.toLowerCase() === "true") ? "true" : "false";
  return value;
}

// MaterialX 1.39 document for the UsdShade network under `materialPath`
// (direct shaders or inside NodeGraphs). Returns null on any gap, which keeps
// the native payload.
function buildUsdShadeMaterialX(api, root, materialPath, usdaLayers) {
  try {
    let materialBody = null;
    let layerPath = null;
    for (const layer of usdaLayers) {
      const body = findMaterialBlockBody(layer.text, materialPath);
      if (body != null) { materialBody = body; layerPath = layer.path; break; }
    }
    if (materialBody == null) {
      const leaf = materialPath.split("/").filter(Boolean).pop();
      if (leaf) {
        for (const layer of usdaLayers) {
          const body = findNamedBlockBodyWithInputs(layer.text, leaf) ?? findNamedBlockBody(layer.text, leaf);
          if (body != null) { materialBody = body; layerPath = layer.path; break; }
        }
      }
    }
    if (materialBody == null) return null;

    const shaders = new Map();
    const nodeGraphs = new Map();
    const walk = (body, basePath, parentGraphName) => {
      for (const child of extractChildBlocks(body)) {
        const childPath = basePath + "/" + child.name;
        const attrs = parseShadeAttrs(child.body);
        if (attrs.id) {
          shaders.set(childPath, { name: child.name, path: childPath, id: attrs.id, attrs, parentGraphName });
        } else {
          nodeGraphs.set(childPath, { name: child.name, path: childPath, attrs });
          walk(child.body, childPath, child.name);
        }
      }
    };
    walk(materialBody, materialPath, null);
    if (!shaders.size) return null;

    const materialAttrs = parseShadeAttrs(materialBody);
    const surfaceEntry = materialAttrs.outputs.get("mtlx:surface");
    if (!surfaceEntry?.isConnect) return null;
    const surfaceResolved = resolveShadeConnection(surfaceEntry.connect, shaders, nodeGraphs);
    if (!surfaceResolved || surfaceResolved.kind !== "node" || !shaders.has(surfaceResolved.path)) return null;

    const displacementEntry = materialAttrs.outputs.get("mtlx:displacement");
    const volumeEntry = materialAttrs.outputs.get("mtlx:volume");
    const displacementResolved = displacementEntry?.isConnect
      ? resolveShadeConnection(displacementEntry.connect, shaders, nodeGraphs) : null;
    const volumeResolved = volumeEntry?.isConnect
      ? resolveShadeConnection(volumeEntry.connect, shaders, nodeGraphs) : null;

    // Display names: the shader's own leaf name, prefixed with its parent
    // NodeGraph's name only when two shaders in different graphs collide.
    const leafCounts = new Map();
    for (const path of shaders.keys()) {
      const leaf = path.split("/").pop();
      leafCounts.set(leaf, (leafCounts.get(leaf) || 0) + 1);
    }
    const displayNames = new Map();
    const usedNames = new Set();
    for (const [path, node] of shaders) {
      const leaf = path.split("/").pop();
      const base = sanitizeMtlxName(
        leafCounts.get(leaf) > 1 && node.parentGraphName ? `${node.parentGraphName}_${leaf}` : leaf
      );
      let candidate = base;
      let suffix = 1;
      while (usedNames.has(candidate)) candidate = `${base}_${suffix++}`;
      usedNames.add(candidate);
      displayNames.set(path, candidate);
    }

    // Composed values (readPrimAttrMap) win over the text, which may be a
    // weaker layer's opinion.
    const attrMapCache = new Map();
    const composedValue = (primPath, inputName, fallback) => {
      let map = attrMapCache.get(primPath);
      if (!map) { map = readPrimAttrMap(api, root, primPath); attrMapCache.set(primPath, map); }
      const record = map.get("inputs:" + inputName);
      const composed = record ? text(record.value) : undefined;
      return composed !== undefined && composed !== "" ? composed : fallback;
    };

    let gapFound = false;
    const nodeBlocks = [];
    for (const [path, node] of shaders) {
      const output = primaryOutput(node.attrs);
      const { category, type } = resolveNodeCategoryAndType(node.id, output?.usdType);
      const displayName = displayNames.get(path);
      const inputLines = [];
      for (const [inputName, entry] of node.attrs.inputs) {
        const mtlxType = USD_TO_MTLX_TYPE[entry.usdType] || entry.usdType;
        if (entry.isConnect) {
          const resolved = resolveShadeConnection(entry.connect, shaders, nodeGraphs);
          if (!resolved) { gapFound = true; break; }
          if (resolved.kind === "node") {
            const targetNode = shaders.get(resolved.path);
            if (!targetNode) { gapFound = true; break; }
            const targetOutputName = primaryOutput(targetNode.attrs)?.name || "out";
            const outputAttr = resolved.port && resolved.port !== targetOutputName
              ? ` output="${xmlEscape(resolved.port)}"` : "";
            inputLines.push(
              `    <input name="${xmlEscape(sanitizeMtlxName(inputName))}" type="${xmlEscape(mtlxType)}" nodename="${xmlEscape(displayNames.get(resolved.path))}"${outputAttr}/>`
            );
          } else {
            const rawValue = composedValue(resolved.path, resolved.port, resolved.value);
            const formatted = formatShadeValue(rawValue, resolved.usdType);
            inputLines.push(buildShadeInputTag(inputName, mtlxType, formatted, resolved.colorSpace, layerPath));
          }
        } else {
          if (entry.value === undefined || entry.value === "") continue;
          const rawValue = composedValue(path, inputName, entry.value);
          const formatted = formatShadeValue(rawValue, entry.usdType);
          inputLines.push(buildShadeInputTag(inputName, mtlxType, formatted, entry.colorSpace, layerPath));
        }
      }
      if (gapFound) break;
      nodeBlocks.push(
        `  <${category} name="${xmlEscape(displayName)}" type="${xmlEscape(type)}">\n${inputLines.join("\n")}${inputLines.length ? "\n" : ""}  </${category}>`
      );
    }
    if (gapFound) return null;

    const materialLeaf = sanitizeMtlxName(materialPath.split("/").filter(Boolean).pop());
    const materialXName = `M_${materialLeaf}_usdshade`;
    const materialInputs = [
      `    <input name="surfaceshader" type="surfaceshader" nodename="${xmlEscape(displayNames.get(surfaceResolved.path))}"/>`,
    ];
    if (displacementResolved?.kind === "node" && shaders.has(displacementResolved.path)) {
      materialInputs.push(`    <input name="displacementshader" type="displacementshader" nodename="${xmlEscape(displayNames.get(displacementResolved.path))}"/>`);
    }
    if (volumeResolved?.kind === "node" && shaders.has(volumeResolved.path)) {
      materialInputs.push(`    <input name="volumeshader" type="volumeshader" nodename="${xmlEscape(displayNames.get(volumeResolved.path))}"/>`);
    }
    const materialBlock = `  <surfacematerial name="${xmlEscape(materialXName)}" type="material">\n${materialInputs.join("\n")}\n  </surfacematerial>`;

    const xml = [
      '<?xml version="1.0"?>',
      '<materialx version="1.39">',
      ...nodeBlocks,
      materialBlock,
      "</materialx>",
      "",
    ].join("\n");
    return { xml, materialName: materialXName };
  } catch {
    return null;
  }
}

function buildShadeInputTag(inputName, mtlxType, formattedValue, colorSpace, layerPath) {
  let value = formattedValue;
  let colorSpaceAttr = "";
  if (mtlxType === "filename") {
    value = anchorAssetPath(layerPath, value);
    const mapped = mapColorSpace(colorSpace);
    if (mapped) colorSpaceAttr = ` colorspace="${xmlEscape(mapped)}"`;
  }
  return `    <input name="${xmlEscape(sanitizeMtlxName(inputName))}" type="${xmlEscape(mtlxType)}" value="${xmlEscape(value)}"${colorSpaceAttr}/>`;
}

// True when `materialPath`'s own USD block (in any layer) authors an
// `inputs:<name>.connect` line; used to warn once per layer file that a real
// external .mtlx material's USD-side connections are ignored.
function findUsdConnectionLayer(usdaLayers, materialPath) {
  const leaf = materialPath.split("/").filter(Boolean).pop();
  for (const layer of usdaLayers) {
    const body = findMaterialBlockBody(layer.text, materialPath)
      ?? (leaf ? findNamedBlockBodyWithInputs(layer.text, leaf) : null);
    if (body != null && /inputs:[A-Za-z_]\w*\.connect\s*=/.test(body)) return layer.path;
  }
  return null;
}

// Input names per top-level node of a flat MaterialX document (the native
// inline payload), to spot inputs whose USD connection was dropped.
function collectInlineMtlxNodeInputs(mtlxText) {
  const nodeOpens = [];
  const re = /<([A-Za-z_][\w.]*)\b[^>]*\bname\s*=\s*"([^"]+)"[^>]*>/g;
  let match;
  while ((match = re.exec(mtlxText))) {
    if (MTLX_NON_TARGET_TAGS.has(match[1])) continue;
    nodeOpens.push({ name: match[2], start: match.index, end: re.lastIndex });
  }
  const result = new Map();
  for (let i = 0; i < nodeOpens.length; i++) {
    const start = nodeOpens[i].end;
    const end = i + 1 < nodeOpens.length ? nodeOpens[i + 1].start : mtlxText.length;
    const chunk = mtlxText.slice(start, end);
    const inputs = new Set();
    const inputRe = /<input\s+name="([^"]+)"/g;
    let inputMatch;
    while ((inputMatch = inputRe.exec(chunk))) inputs.add(inputMatch[1]);
    result.set(nodeOpens[i].name, inputs);
  }
  return result;
}

// For a kept native inline payload: "<node>.<input>" labels of inputs that
// are connected in USD (authored, no value) but missing from the document.
function collectInlineConnectionGaps(api, root, material, usdaLayers) {
  try {
    const data = material?.materialX?.data;
    if (!data) return [];
    let mtlxText;
    try { mtlxText = new TextDecoder().decode(data); } catch { return []; }
    const nodeInputs = collectInlineMtlxNodeInputs(mtlxText);
    let materialBody = null;
    for (const layer of usdaLayers) {
      materialBody = findMaterialBlockBody(layer.text, material.path);
      if (materialBody != null) break;
    }
    if (materialBody == null) {
      const leaf = material.path.split("/").filter(Boolean).pop();
      if (leaf) {
        for (const layer of usdaLayers) {
          materialBody = findNamedBlockBodyWithInputs(layer.text, leaf);
          if (materialBody != null) break;
        }
      }
    }
    if (materialBody == null) return [];
    const shaders = new Map();
    const walk = (body, basePath) => {
      for (const child of extractChildBlocks(body)) {
        const childPath = basePath + "/" + child.name;
        const attrs = parseShadeAttrs(child.body);
        if (attrs.id) shaders.set(childPath, { name: child.name, path: childPath });
        else walk(child.body, childPath);
      }
    };
    walk(materialBody, material.path);
    const gaps = [];
    for (const node of shaders.values()) {
      const declaredInputs = nodeInputs.get(node.name);
      if (!declaredInputs) continue;
      let attrMap;
      try { attrMap = readPrimAttrMap(api, root, node.path); } catch { continue; }
      for (const [name, record] of attrMap) {
        if (!name.startsWith("inputs:") || !record?.isAuthored) continue;
        if (text(record.value)) continue; // has a value, not a dropped connection
        const inputName = name.slice("inputs:".length);
        if (!declaredInputs.has(inputName)) gaps.push(`${node.name}.${inputName}`);
      }
    }
    return gaps;
  } catch {
    return [];
  }
}

// Walks a prim's ancestor chain and accumulates the world matrix, returning
// the leaf's attribute map alongside it so the caller does not read it twice.
// Shared by cameras and lights; `label` only shapes the unsupported-op warning.
function composeWorldMatrix(api, root, primPath, warn, label) {
  const segments = primPath.split("/").filter(Boolean);
  let running = "";
  const ancestorPaths = segments.map(seg => (running += "/" + seg, running));
  let worldSoFar = identity4();
  let leafMap = null;
  for (const path of ancestorPaths) {
    const attrMap = readPrimAttrMap(api, root, path);
    if (path === primPath) leafMap = attrMap;
    const orderRecord = attrMap.get("xformOpOrder");
    const orderTokens = orderRecord ? parseOpOrderList(orderRecord.value) : [];
    if (orderTokens.includes("!resetXformStack!")) worldSoFar = identity4();
    const { matrix, unsupported } = composeLocalMatrix(orderTokens, attrMap, primPath, warn, label);
    if (unsupported) return { matrix: identity4(), leafMap: null, unsupported: true };
    worldSoFar = mul4(matrix, worldSoFar);
  }
  return {
    matrix: worldSoFar,
    leafMap: leafMap ?? readPrimAttrMap(api, root, primPath),
    unsupported: false,
  };
}

// Snapshot evaluated transforms once at the stage driver start time. Native
// records include Mesh, Camera, and UsdLuxLightAPI paths; plain Xforms are
// intentionally omitted. Invalid records never replace composed fallbacks.
function stageStartTime(api, root, summary) {
  let time = Number.NaN;
  try { time = Number(api?.stageDriverGetTiming?.(root)?.start); } catch {}
  if (!Number.isFinite(time)) time = Number(summary?.startTimeCode);
  if (!Number.isFinite(time)) time = 0;
  return time;
}

function snapshotEvaluatedTransforms(api, root, summary) {
  if (typeof api?.extractTransformsAtTime !== "function") return new Map();
  const time = stageStartTime(api, root, summary);
  let records;
  try { records = arrayItems(api.extractTransformsAtTime(root, time)); } catch { return new Map(); }
  const transforms = new Map();
  for (const record of records) {
    const primPath = text(record?.path);
    if (!primPath) continue;
    let matrix;
    try { matrix = Array.from(record.matrix ?? []); } catch { continue; }
    if (matrix.length !== 16 || !matrix.every(value => typeof value === "number" && Number.isFinite(value))) continue;
    transforms.set(primPath, matrix.slice());
  }
  return transforms;
}
// Graph entries carry a resolved typeName, so prims are picked by type here.
// A prim authored purely as an `over` has no resolved type and never appears.
function graphEntriesOfType(graph, matches) {
  return arrayItems(graph).filter(entry => {
    const typeName = (text(entry?.typeName) ?? "").toLowerCase();
    if (!typeName || !matches(typeName)) return false;
    if (!text(entry?.path)) return false;
    if (entry?.active === false || entry?.isActive === false) return false;
    return true;
  });
}

function collectCameras(api, root, graph, warn, evaluatedTransforms = null) {
  const cameraEntries = graphEntriesOfType(graph, name => name === "camera");
  const cameras = [];
  for (const entry of cameraEntries) {
    const primPath = text(entry.path);
    const segments = primPath.split("/").filter(Boolean);
    const { matrix: worldSoFar, leafMap, unsupported } = composeWorldMatrix(api, root, primPath, warn, "Camera");
    if (unsupported) continue;
    const map = leafMap;
    const numberOf = (name, fallback) => {
      const record = map.get(name);
      const nums = record ? parseNumbers(record.value) : [];
      return nums.length ? nums[0] : fallback;
    };
    const clipRecord = map.get("clippingRange");
    const clipNums = clipRecord ? parseNumbers(clipRecord.value) : [];
    const projectionRecord = map.get("projection");
    cameras.push({
      primPath,
      name: segments[segments.length - 1] || primPath,
      matrix: evaluatedTransforms?.get(primPath) ?? worldSoFar,
      focalLength: numberOf("focalLength", 50),
      horizontalAperture: numberOf("horizontalAperture", 36),
      verticalAperture: numberOf("verticalAperture", 24),
      clippingRange: [clipNums[0] ?? 0.1, clipNums[1] ?? 1000000],
      focusDistance: numberOf("focusDistance", 0),
      projection: projectionRecord ? text(projectionRecord.value) : "perspective",
    });
  }
  return cameras;
}

// The camera relationship's first target on a UsdRender RenderSettings prim.
// inspectPrimRelationships' exact wrapper shape (single entry vs an array of
// one) is not guaranteed, so this tolerates both like collectPrototypeTargets.
function findRenderSettingsCameraPath(api, root, primPath) {
  let relEntries;
  try { relEntries = arrayItems(api.inspectPrimRelationships(root, primPath)); } catch { return null; }
  const entry = relEntries.find(item => text(item?.path) === primPath) ?? (relEntries.length === 1 ? relEntries[0] : null);
  const relationships = entry ? arrayItems(entry.relationships) : relEntries;
  for (const rel of relationships) {
    if (String(rel?.name ?? "").toLowerCase() !== "camera") continue;
    const targets = arrayItems(rel?.targets).map(text).filter(Boolean);
    if (targets.length) return targets[0];
  }
  return null;
}

// Marks exactly one collected camera as the default: a RenderSettings prim's
// camera relationship wins, otherwise the first camera in scene-graph order.
function markDefaultCamera(api, root, graph, cameras) {
  if (!cameras.length) return;
  let defaultCamera = null;
  if (typeof api.inspectPrimRelationships === "function") {
    const renderSettingsEntries = graphEntriesOfType(graph, name => name === "rendersettings");
    for (const entry of renderSettingsEntries) {
      const primPath = text(entry.path);
      if (!primPath) continue;
      const cameraPath = findRenderSettingsCameraPath(api, root, primPath);
      if (!cameraPath) continue;
      const match = cameras.find(camera => camera.primPath === cameraPath);
      if (match) { defaultCamera = match; break; }
    }
  }
  if (!defaultCamera) defaultCamera = cameras[0];
  defaultCamera.defaultCamera = true;
}

// UsdLux defaults for the attributes a dome light import reads, applied when
// an attribute is unauthored. A DCC also writes declaration-only attributes
// with no value at all, so an empty value text falls back the same way.
const LIGHT_DEFAULTS = { intensity: 1, exposure: 0, diffuse: 1, specular: 1 };
// Types the Scene converts to MaterialX lights. Anything else is reported
// once so a dropped light is never silent.
const IMPORTED_LIGHT_TYPES = new Set([
  "domelight", "distantlight", "spherelight", "rectlight", "disklight", "cylinderlight",
]);

function collectLights(api, root, graph, warn, evaluatedTransforms = null) {
  const entries = graphEntriesOfType(graph, name => name.endsWith("light"));
  const lights = [];
  for (const entry of entries) {
    const primPath = text(entry.path);
    const typeName = text(entry.typeName) ?? "";
    const { matrix, leafMap, unsupported } = composeWorldMatrix(api, root, primPath, warn, "Light");
    if (unsupported) continue;
    const segments = primPath.split("/").filter(Boolean);
    const valueOf = (name) => {
      const record = leafMap.get(name);
      const value = record ? text(record.value) : undefined;
      return value && value.trim() ? value.trim() : undefined;
    };
    const numberOf = (name, fallback) => {
      const nums = parseNumbers(valueOf(name));
      return nums.length ? nums[0] : fallback;
    };
    const colorNums = parseNumbers(valueOf("inputs:color"));
    lights.push({
      primPath,
      name: segments[segments.length - 1] || primPath,
      type: typeName,
      matrix: evaluatedTransforms?.get(primPath) ?? matrix,
      textureFile: valueOf("inputs:texture:file") ?? null,
      textureFormat: valueOf("inputs:texture:format") ?? "automatic",
      intensity: numberOf("inputs:intensity", LIGHT_DEFAULTS.intensity),
      exposure: numberOf("inputs:exposure", LIGHT_DEFAULTS.exposure),
      diffuse: numberOf("inputs:diffuse", LIGHT_DEFAULTS.diffuse),
      specular: numberOf("inputs:specular", LIGHT_DEFAULTS.specular),
      color: colorNums.length >= 3 ? colorNums.slice(0, 3) : [1, 1, 1],
      // UsdLuxLightAPI colorTemperature: a Kelvin value multiplied onto
      // inputs:color when enableColorTemperature is authored true.
      enableColorTemperature: valueOf("inputs:enableColorTemperature") === "1"
        || valueOf("inputs:enableColorTemperature") === "true",
      colorTemperature: numberOf("inputs:colorTemperature", 6500),
      // Emitter shape, used to normalize intensity by area and to pick the
      // MaterialX light type. Absent attributes stay null so the converter
      // can tell "unauthored" from "authored zero".
      radius: numberOf("inputs:radius", null),
      width: numberOf("inputs:width", null),
      height: numberOf("inputs:height", null),
      length: numberOf("inputs:length", null),
      angle: numberOf("inputs:angle", null),
      normalize: valueOf("inputs:normalize") === "1" || valueOf("inputs:normalize") === "true",
      treatAsPoint: valueOf("treatAsPoint") === "1" || valueOf("treatAsPoint") === "true",
      // UsdLuxShapingAPI: how a real spot light is authored.
      coneAngle: numberOf("inputs:shaping:cone:angle", null),
      coneSoftness: numberOf("inputs:shaping:cone:softness", null),
    });
  }
  const domes = lights.filter(light => light.type.toLowerCase() === "domelight");
  if (domes.length > 1) warn(`Stage has ${domes.length} dome lights; using ${domes[0].primPath}`);
  for (const light of lights) {
    const kind = light.type.toLowerCase();
    if (kind === "domelight") {
      if (light !== domes[0]) warn(`Light ${light.primPath} (${light.type}) is not imported`);
      continue;
    }
    if (!IMPORTED_LIGHT_TYPES.has(kind)) warn(`Light ${light.primPath} (${light.type}) is not imported`);
  }
  return lights;
}

function swapCorners(array, triangleIndex, stride) {
  const base = triangleIndex * 3 * stride;
  for (let c = 0; c < stride; c++) {
    const a = base + stride + c;
    const b = base + 2 * stride + c;
    const tmp = array[a];
    array[a] = array[b];
    array[b] = tmp;
  }
}

// Corrects a leftHanded mesh so the renderer receives counter-clockwise
// winding. Authored normals retain their sign after corner reordering;
// generated right-handed fallback normals also need a sign flip.
function applyOrientation(mesh) {
  if (!mesh || mesh.orientation !== "leftHanded") return mesh;
  const { positions, normals, uvs, indices } = mesh;
  const geomprops = mesh.geomprops ?? [];
  if (indices && indices.length) {
    for (let k = 0; k + 2 < indices.length; k += 3) {
      const tmp = indices[k + 1];
      indices[k + 1] = indices[k + 2];
      indices[k + 2] = tmp;
    }
  } else if (positions && positions.length >= 9) {
    const triangleCount = Math.floor(positions.length / 9);
    for (let t = 0; t < triangleCount; t++) {
      swapCorners(positions, t, 3);
      if (normals && normals.length === positions.length) swapCorners(normals, t, 3);
      if (uvs && uvs.length === (positions.length / 3) * 2) swapCorners(uvs, t, 2);
      for (const stream of geomprops) {
        if (stream?.itemSize > 0 && Number.isInteger(stream.itemSize) &&
            stream.data?.length === (positions.length / 3) * stream.itemSize) {
          swapCorners(stream.data, t, stream.itemSize);
        }
      }
    }
  }
  if (normals && mesh.authoredNormals !== true) {
    for (let i = 0; i < normals.length; i++) normals[i] = -normals[i];
  }
  return mesh;
}

// Loop-subdivides a deindexed triangle mesh (positions/normals/uvs are flat
// per-corner streams, indices absent or a trivial identity sequence, exactly
// what the native draw produces). Welds corners by exact position so shared
// cage vertices merge into one manifold topology, runs `levels` Loop
// subdivision passes with face-varying UVs (interpolated per corner so UV
// seams stay sharp), recomputes area-weighted smooth normals from the welded
// topology, and re-expands to deindexed corners with a sequential index so
// the renderer path is unchanged. Returns null if the mesh cannot be welded
// into a usable triangle list (degenerate/point mesh).
function collectPrototypeTargets(value, result = []) {
  if (value == null) return result;
  if (typeof value === "string") {
    if (value.startsWith("/")) result.push(value);
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectPrototypeTargets(item, result));
    return result;
  }
  if (typeof value !== "object") return result;
  for (const [key, item] of Object.entries(value)) {
    if (/prototype/i.test(key)) collectPrototypeTargets(item, result);
    else if (key === "relationships" && Array.isArray(item)) {
      for (const relationship of item) {
        if (String(relationship?.name ?? "").toLowerCase() === "prototypes") {
          collectPrototypeTargets(relationship.targets, result);
        }
      }
    }
  }
  return result;
}

// PointInstancer extraction intentionally emits corner-expanded geometry but
// currently omits authored normals.  Recover them through an ordinary native
// draw of the composed prototype, never by welding unrelated scene vertices.
// The temporary layer remains in the native VFS until the next whole-stage
// close; this avoids wrapper.closeStage() unlinking the caller's input files.
async function recoverInstanceNormals(api, root, pointInstancerPaths, drawSnapshot, purposePolicy) {
  const generated = drawSnapshot.meshes.filter(mesh => mesh.instanceOwnerPath);
  for (const mesh of generated) mesh.castsShadow = readInstanceCastsShadow(api, root, mesh);
  const normalRecoveryMeshes = generated.filter(mesh => !mesh.normals);
  if (!normalRecoveryMeshes.length || !api.inspectPrimRelationships || !api.createDataFile || !api.openStage) return [];
  const probes = new Map();
  const warnings = [];
  for (const mesh of normalRecoveryMeshes) {
    const marker = "/__instances__/";
    const markerIndex = mesh.path.indexOf(marker);
    if (markerIndex < 0) continue;
    const owner = mesh.instanceOwnerPath;
    const tail = mesh.path.slice(markerIndex + marker.length);
    const prototypeName = tail.split("/")[0];
    if (!prototypeName) continue;
    let targets = [];
    try { targets = collectPrototypeTargets(api.inspectPrimRelationships(root, owner)); } catch { targets = []; }
    targets = [...new Set(targets)];
    const matching = targets.filter(target => target.split("/").pop() === prototypeName);
    const target = matching.length === 1 ? matching[0] : null;
    if (!target) {
      warnings.push(`PointInstancer normal recovery skipped ambiguous prototype: ${owner}/${prototypeName}`);
      continue;
    }
    const relativeMeshPath = tail.slice(prototypeName.length).replace(/^\//, "");
    const key = `${target}\n${relativeMeshPath}`;
    if (!probes.has(key)) probes.set(key, { target, relativeMeshPath, meshes: [] });
    probes.get(key).meshes.push(mesh);
  }
  if (!probes.size) return warnings;
  const probeLines = ["#usda 1.0", "(", ")", ""];
  let probeIndex = 0;
  const probeRoots = [];
  const byTarget = new Map();
  for (const probe of probes.values()) {
    let rootProbe = byTarget.get(probe.target);
    if (!rootProbe) {
      rootProbe = { target: probe.target, meshes: [] };
      byTarget.set(probe.target, rootProbe);
      probeRoots.push(rootProbe);
    }
    rootProbe.meshes.push(...probe.meshes);
  }
  for (const probe of probeRoots) {
    const name = `Probe${probeIndex++}`;
    probe.probeName = name;
    probeLines.push(`def "${name}" ( references = @${root}@<${probe.target}> ) {}`);
  }
  const probePath = `__usd_instance_normals_${Date.now()}.usda`;
  try {
    api.createDataFile(probePath, new TextEncoder().encode(probeLines.join("\n")));
    const probeSummary = api.openStage(probePath, true);
    if (probeSummary?.error) {
      warnings.push(`PointInstancer normal recovery temporary prototype stage failed: ${probeSummary.error}`);
      return warnings;
    }
    if (!probeSummary || !api.createStageDriver(probePath)) {
      return warnings.concat("PointInstancer normal recovery temporary prototype stage could not be opened");
    }
    for (const probe of probes.values()) {
      const probeRoot = probeRoots.find(item => item.target === probe.target);
      const probeName = probeRoot?.probeName;
      // The orientation attribute lives on the composed prototype mesh prim
      // in the real stage, not on the temporary probe layer or the generated
      // __instances__ record, so it is read from the actual target path.
      const actualMeshPath = probe.relativeMeshPath ? `${probe.target}/${probe.relativeMeshPath}` : probe.target;
      const tokens = readMeshTokens(api, root, actualMeshPath);
      const orientation = tokens.orientation;
      const castsShadow = readMeshCastsShadow(api, root, actualMeshPath);
      for (const generatedMesh of probe.meshes) {
        const marker = "/__instances__/";
        const tail = generatedMesh.path.slice(generatedMesh.path.indexOf(marker) + marker.length);
        const prototypeName = tail.split("/")[0];
        const relativeMeshPath = tail.slice(prototypeName.length).replace(/^\//, "");
        const proxyMeshPath = relativeMeshPath ? `/${probeName}/${relativeMeshPath}` : `/${probeName}`;
        let subtree = api.stageDriverDrawSubtree?.(probePath, proxyMeshPath, purposePolicy);
        let ordinary;
        try {
          ordinary = snapshotDraw(subtree).meshes;
        } catch (error) {
          if (!/detached|out-of-bounds/i.test(String(error?.message ?? error))) throw error;
          subtree = api.stageDriverDrawSubtree?.(probePath, proxyMeshPath, purposePolicy);
          ordinary = snapshotDraw(subtree).meshes;
        }
        const candidate = ordinary.find(mesh => mesh.path === proxyMeshPath ||
          mesh.path.replace(/\/+$/, "") === proxyMeshPath);
        if (!candidate || !candidate.normals ||
            candidate.normals.length !== candidate.positions?.length ||
            !candidate.normals.every(Number.isFinite) ||
            !sameFiniteStream(generatedMesh.positions, candidate.positions) ||
            (!generatedMesh.uvs && !candidate.uvs ? false : !sameFiniteStream(generatedMesh.uvs, candidate.uvs)) ||
            !sameCornerIndices(generatedMesh.indices, candidate.indices, generatedMesh.positions.length / 3)) {
          warnings.push(`PointInstancer normal recovery stream mismatch: ${generatedMesh.path}`);
          continue;
        }
        generatedMesh.normals = candidate.normals;
        generatedMesh.orientation = orientation;
        generatedMesh.subdivisionScheme = tokens.subdivisionScheme;
        generatedMesh.faceVertexCounts = tokens.faceVertexCounts;
        generatedMesh.authoredNormals = tokens.authoredNormals;
        generatedMesh.castsShadow = readInstanceCastsShadow(api, root, generatedMesh);
      }
    }
  } catch (error) {
    warnings.push(`PointInstancer normal recovery failed: ${error?.message ?? error}`);
  } finally {
    if (api.deleteStageDriver) {
      try { api.deleteStageDriver(probePath); } catch {}
    }
  }
  return warnings;
}

// A .mtlx referenced with a Windows backslash path fails to compose and the
// draw binds some other material; from the "Could not open asset" line, add
// the uploaded file as the bound material and repoint the mesh (no recompose).
function resolveBackslashMaterialReferences(api, root, result, stderrLines, uploadedPaths, graph) {
  try {
    if (!stderrLines?.length || typeof api.inspectPrimRelationships !== "function") return;
    const graphPaths = new Set(arrayItems(graph).map(entry => text(entry?.path)).filter(Boolean));
    const lineRe = /Could not open asset @([^@]+)@ for [^\n]*? introduced by @([^@]+)@(<[^>]+>)/;
    const seen = new Set();
    for (const line of stderrLines) {
      const match = line.match(lineRe);
      if (!match) continue;
      const [, assetRef, layerRef, primToken] = match;
      if (!assetRef.includes("\\") || !/\.mtlx$/i.test(assetRef)) continue;
      const primPath = primToken.slice(1, -1);
      const dedupeKey = assetRef + "|" + layerRef + "|" + primPath;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const layerDir = normalizePath(layerRef).split("/").slice(0, -1).join("/");
      const candidate1 = normalizePath(layerDir ? layerDir + "/" + assetRef : assetRef);
      const candidate2 = normalizePath(assetRef);
      const resolvedPath = [candidate1, candidate2].find(candidate => uploadedPaths.has(candidate));
      if (!resolvedPath) continue;
      const parentPath = primPath.split("/").slice(0, -1).join("/");
      const candidateMeshes = result.meshes.filter(mesh =>
        mesh.primPath === parentPath || (mesh.primPath && mesh.primPath.startsWith(parentPath + "/")));
      let resolvedAny = false;
      for (const mesh of candidateMeshes) {
        let relEntries;
        try { relEntries = arrayItems(api.inspectPrimRelationships(root, mesh.primPath)); } catch { continue; }
        const entry = relEntries.find(item => text(item?.path) === mesh.primPath);
        if (!entry) continue;
        const bindings = arrayItems(entry.relationships).filter(rel => rel?.isMaterialBinding);
        const allTargets = bindings.flatMap(rel => arrayItems(rel.targets).map(text)).filter(Boolean);
        const missingTargets = allTargets.filter(target => target.startsWith(primPath + "/") && !graphPaths.has(target));
        if (!missingTargets.length) continue;
        for (const target of missingTargets) {
          if (!result.materials.some(material => material.path === target)) {
            result.materials.push({
              path: target,
              sourceAsset: resolvedPath,
              materialName: target.split("/").filter(Boolean).pop(),
            });
          }
        }
        const target = missingTargets[0];
        const singleBinding = allTargets.length === 1;
        const previousFallback = mesh.materialPath;
        mesh.materialPath = target;
        if (singleBinding && Array.isArray(mesh.groups)) {
          for (const group of mesh.groups) {
            if (group.materialPath === previousFallback) group.materialPath = target;
          }
        }
        resolvedAny = true;
      }
      if (resolvedAny) {
        // The native "Could not open asset" lines for this path are now handled.
        const marker = "@" + assetRef + "@";
        result.warnings = result.warnings.filter(warning => !String(warning).includes(marker));
        result.warnings.push(`[info] Read Windows-style path ${assetRef} as ${resolvedPath}`);
      }
    }
  } catch {
    // Never let a diagnostics-parsing failure affect the rest of the result.
  }
}

function copyStageResult(summary, draw, payloads, cameras, lights, metrics = null) {
  const assets = new Map();
  const materials = new Map();
  for (const entry of arrayItems(payloads)) {
    const material = copyMaterial(entry.material, assets);
    if (material) {
      // `entry.path` was a geometry/binding path in an older native build;
      // the material object's UsdShade path is the stable identity whenever
      // it is present.
      const path = text(entry.material?.path) ?? text(material.path) ?? text(entry.path);
      if (path) materials.set(path, material);
    }
  }
  const meshes = arrayItems(draw?.meshes)
    .map(mesh => copyMesh(mesh, assets, materials)).filter(Boolean);
  const materialList = Array.from(materials, ([path, material]) => ({ path, ...material }));
  const transfer = [];
  const transferred = new Set();
  const addTransfer = buffer => {
    if (buffer && !transferred.has(buffer)) {
      transferred.add(buffer);
      transfer.push(buffer);
    }
  };
  for (const mesh of meshes) {
    for (const key of ["positions", "normals", "uvs", "indices"]) if (mesh[key]) addTransfer(mesh[key].buffer);
    for (const prop of mesh.geomprops ?? []) if (prop.data?.buffer) addTransfer(prop.data.buffer);
    if (mesh.cage) for (const prop of mesh.cage.geomprops ?? []) if (prop.data?.buffer) addTransfer(prop.data.buffer);
    if (mesh.cage) {
      for (const key of ["positions", "normals", "uvs", "indices"]) if (mesh.cage[key]) addTransfer(mesh.cage[key].buffer);
    }
  }
  for (const material of materialList) {
    for (const value of Object.values(material)) {
      if (value?.data?.buffer) addTransfer(value.data.buffer);
      if (value?.materialX?.data?.buffer) addTransfer(value.materialX.data.buffer);
      for (const resource of value?.resources ?? []) if (resource.data?.buffer) addTransfer(resource.data.buffer);
    }
  }
  const assetList = Array.from(assets, ([path, data]) => {
    addTransfer(data.buffer);
    return { path, data: data.buffer };
  });
  const warnings = Array.from(new Set(nativeWarnings));
  return {
    rootPath: summary?.rootFile ?? "",
    upAxis: metrics?.upAxis ?? summary?.upAxis,
    metersPerUnit: metrics?.metersPerUnit ?? summary?.metersPerUnit,
    summary: summary ?? null,
    meshes,
    materials: materialList,
    assets: assetList,
    cameras: cameras ?? [],
    lights: lights ?? [],
    warnings: Array.from(new Set(warnings)),
    transfer,
  };
}

// Exact Catmull-Clark triangle count needs each face's vertex count: a face
// with n vertices yields n quads, so n * 2 triangles per level-1 subdivision,
// times 4 per further level. faceVertexCounts may only be a truncated prefix
// (the native attribute reader caps at 512 entries), so it is only trusted
// when it fully accounts for originalTriangles; otherwise fall back to the
// quad-typical factor used for a plain quad mesh.
function catmullClarkProjectedTriangles(mesh, levels, originalTriangles) {
  const counts = mesh.faceVertexCounts;
  if (Array.isArray(counts) && counts.length) {
    let sum = 0;
    for (const n of counts) sum += Math.max(0, n - 2);
    if (sum === originalTriangles) {
      let triangles = 0;
      for (const n of counts) triangles += n * 2 * 4 ** (levels - 1);
      return triangles;
    }
  }
  return originalTriangles * (4 ** levels);
}

async function load(request) {
  // A persistent worker must not let a second load inherit the first
  // stage's warnings.
  nativeWarnings.length = 0;
  const api = await runtime();
  // Vendor closeStage unlinks every tracked MEMFS file, so the previous
  // stage must be closed (and its driver released) before this load writes
  // any new files, not after. This also stops scene A's assets resolving
  // inside scene B.
  if (activeStage) {
    api.closeStage(activeStage);
    api.deleteStageDriver?.(activeStage);
    activeStage = undefined;
  }
  let inputCacheHits = 0;
  let inputCacheMisses = 0;
  const fileTotal = (request.files ?? []).filter(file => file?.path).length;
  postMessage({ id: request.id, type: "progress", value: { phase: "worker", done: 0, total: fileTotal, fraction: 0.05, message: "Preparing input files" } });
  let loadedFiles = 0;
  // Plain-text USD layers, kept so USD override `over` blocks can be found
  // by name: getSceneGraph only lists prims with a resolved type, but an
  // override-only child prim (no matching `def` anywhere) has none and
  // never appears there, even though getPrimAttributes still resolves it
  // directly once its path is known.
  const usdaTexts = [];
  // Only "#usda" text layers are decoded (never crates); the cap only guards
  // against a string too large for V8.
  const OVERRIDE_SCAN_MAX_BYTES = 256 * 1024 * 1024;
  const scanWarnings = [];
  const requestedRootPath = normalizePath(request.rootPath);
  let rootMetrics = null;
  // Uploaded .mtlx file text, keyed by normalized path, so a material whose
  // native materialX.data payload is unavailable can still fall back to its
  // sourceAsset's own uploaded bytes when enumerating override candidates.
  const mtlxFileTextsByPath = new Map();
  const uploadedPaths = new Set();
  for (const file of request.files ?? []) {
    if (!file?.path) continue;
    const normalizedPath = normalizePath(file.path);
    if (shouldSkipVfsUpload(normalizedPath)) {
      // Never read or copy these bytes at all: no reader on either side of
      // the worker ever opens them (see VFS_SKIP_EXTENSIONS above).
      uploadedPaths.add(normalizedPath);
      loadedFiles++;
      postMessage({ id: request.id, type: "progress", value: {
        phase: "worker", done: loadedFiles, total: fileTotal,
        fraction: 0.05 + 0.2 * (loadedFiles / Math.max(1, fileTotal)),
        message: "Reading input files",
      } });
      continue;
    }
    // MEMFS is wiped by closeStage on every load, so createDataFile always
    // runs; this cache only avoids re-reading the File and re-decoding text.
    const size = Number.isFinite(file.size) ? file.size : (typeof file.data?.size === "number" ? file.data.size : undefined);
    const lastModified = Number.isFinite(file.lastModified) ? file.lastModified
      : (typeof file.data?.lastModified === "number" ? file.data.lastModified : -1);
    const cacheKey = `${normalizedPath}|${size ?? -1}|${lastModified}`;
    const cached = inputCacheGet(cacheKey);
    let data = cached?.bytes;
    const cachedText = cached?.text;
    if (data) {
      inputCacheHits++;
    } else {
      inputCacheMisses++;
      const source = typeof file.data?.arrayBuffer === "function"
        ? await file.data.arrayBuffer()
        : file.data;
      data = source instanceof ArrayBuffer
        ? new Uint8Array(source)
        : arrayCopy(source, Uint8Array);
    }
    if (!data) continue;
    uploadedPaths.add(normalizedPath);
    if (normalizedPath === requestedRootPath) rootMetrics = parseRootUsdMetrics(data);
    // Only text layers (#usda magic) under the cap are scanned; a binary
    // crate (PXR-USDC) decoded as a string can exceed V8's limit and kill
    // the tab before the stage loads (1.86 GB Lion crate, 2026-09-08).
    let resolvedText;
    if (/\.usda?$/i.test(String(file.path))) {
      const isTextLayer = data.length >= 6 && data[0] === 0x23 && data[1] === 0x75 && data[2] === 0x73 && data[3] === 0x64 && data[4] === 0x61;
      if (isTextLayer && data.length <= OVERRIDE_SCAN_MAX_BYTES) {
        try {
          resolvedText = cachedText !== undefined ? cachedText : new TextDecoder().decode(data);
          usdaTexts.push({ path: file.path, text: resolvedText });
        } catch { /* skip */ }
      } else if (isTextLayer) {
        scanWarnings.push(`USD text layer too large to read material edits from: ${file.path} (${(data.length / 1048576).toFixed(1)} MB)`);
      }
    } else if (/\.mtlx$/i.test(String(file.path)) && data.length <= OVERRIDE_SCAN_MAX_BYTES) {
      try {
        resolvedText = cachedText !== undefined ? cachedText : new TextDecoder().decode(data);
        mtlxFileTextsByPath.set(normalizedPath, resolvedText);
      } catch { /* skip */ }
    }
    inputCacheAdmit(cacheKey, data, resolvedText);
    api.createDataFile(normalizedPath, data);
    loadedFiles++;
    postMessage({ id: request.id, type: "progress", value: {
      phase: "worker", done: loadedFiles, total: fileTotal,
      fraction: 0.05 + 0.2 * (loadedFiles / Math.max(1, fileTotal)),
      message: "Reading input files",
    } });
  }
  if (!loadedFiles) throw new Error("USD file buffers were empty or not transferable");
  const root = normalizePath(request.rootPath);
  if (!root) throw new Error("USD rootPath is required");
  postMessage({ id: request.id, type: "progress", value: { phase: "parse", done: 0, total: 0, fraction: 0.3, message: "Composing stage" } });
  stderrBuffer.length = 0;
  const summary = api.openStage(root, true);
  const openStageStderrLines = stderrBuffer.slice();
  if (summary?.error) throw new Error(summary.error);
  // Only adopt the stage as active once openStage has succeeded, so a
  // failed load never leaves a half-composed stage marked as closeable.
  activeStage = root;
  const stageMetrics = resolveStageMetrics(summary, rootMetrics);
  postMessage({ id: request.id, type: "progress", value: { phase: "parse", done: 1, total: 1, fraction: 0.4, message: "Composed stage" } });
  if (!api.createStageDriver(root)) throw new Error("OpenUSD stage driver could not be created");
  const evaluatedTransforms = snapshotEvaluatedTransforms(api, root, summary);
  const stageTime = stageStartTime(api, root, summary);
  // A full draw can itself grow the native heap while it is constructing
  // multiple MeshUpdate objects. Earlier objects then retain detached views
  // by the time the native call returns. Enumerate mesh prims and draw each
  // subtree separately so every result is copied before the next draw call.
  // Keep the full-draw fallback for runtimes without scene-graph support.
  const purposePolicy = request.purposePolicy ?? "defaultRender";
  let drawSnapshot;
  const graph = api.getSceneGraph?.(root);
  const meshPaths = arrayItems(graph)
    .filter(entry => (text(entry?.typeName) ?? "").toLowerCase() === "mesh" && text(entry?.path))
    .map(entry => text(entry.path));
  const pointInstancerPaths = arrayItems(graph)
    .filter(entry => (text(entry?.typeName) ?? "").toLowerCase() === "pointinstancer" && text(entry?.path))
    .map(entry => text(entry.path));
  // PointInstancers are represented by generated __instances__ MeshUpdates;
  // their authored prototype Mesh paths are not drawable by themselves.
  const uniqueMeshPaths = Array.from(new Set([...meshPaths, ...pointInstancerPaths]));
  if (uniqueMeshPaths.length && api.stageDriverDrawSubtree) {
    drawSnapshot = { meshes: [] };
    const copiedMeshPaths = new Set();
    // PointInstancer paths only ever produce generated __instances__ meshes
    // (instanceOwnerPath set); their orientation is resolved later from the
    // prototype mesh prim inside recoverInstanceNormals. Ordinary mesh prims
    // get their own orientation token read here, once per drawn prim.
    const pushMesh = mesh => {
      if (!mesh.path || !copiedMeshPaths.has(mesh.path)) {
        if (!mesh.instanceOwnerPath) {
          const tokens = readMeshTokens(api, root, mesh.path || path);
          mesh.orientation = tokens.orientation;
          mesh.subdivisionScheme = tokens.subdivisionScheme;
          mesh.faceVertexCounts = tokens.faceVertexCounts;
          mesh.authoredNormals = tokens.authoredNormals;
          mesh.castsShadow = readMeshCastsShadow(api, root, mesh.path || path);
        }
        drawSnapshot.meshes.push(mesh);
        if (mesh.path) copiedMeshPaths.add(mesh.path);
      }
    };
    for (let index = 0; index < uniqueMeshPaths.length; index++) {
      const path = uniqueMeshPaths[index];
      let subtree = api.stageDriverDrawSubtree(root, path, purposePolicy);
      try {
        for (const mesh of snapshotDraw(subtree).meshes) pushMesh(mesh);
      } catch (error) {
        // Some large stages can leave the first subtree's view on a stale
        // heap generation even though no later API call was made. Reissue
        // this same bounded subtree request once; the second native result
        // is independently copied and avoids recovering from a detached
        // view, which is impossible.
        if (!/detached|out-of-bounds/i.test(String(error?.message ?? error))) throw error;
        subtree = api.stageDriverDrawSubtree(root, path, purposePolicy);
        for (const mesh of snapshotDraw(subtree).meshes) pushMesh(mesh);
      }
      postMessage({ id: request.id, type: "progress", value: {
        phase: "extract-geometry", done: index + 1, total: uniqueMeshPaths.length,
        fraction: 0.45 + 0.3 * ((index + 1) / uniqueMeshPaths.length),
        message: "Copied mesh data",
      } });
    }
  } else {
    const draw = api.stageDriverDraw(root, true, purposePolicy);
    // Snapshot before making the next native call; diagnostics and payload
    // extraction may also refresh the Emscripten heap.
    drawSnapshot = snapshotDraw(draw);
    for (const mesh of drawSnapshot.meshes) {
      const tokens = readMeshTokens(api, root, mesh.path);
      mesh.orientation = tokens.orientation;
      mesh.subdivisionScheme = tokens.subdivisionScheme;
      mesh.faceVertexCounts = tokens.faceVertexCounts;
      mesh.authoredNormals = tokens.authoredNormals;
      mesh.castsShadow = readMeshCastsShadow(api, root, mesh.path);
    }
  }
  postMessage({ id: request.id, type: "progress", value: { phase: "extract-materials", done: 0, total: 0, fraction: 0.8, message: "Extracting material payloads" } });
  const payloads = api.extractMaterialPayloads(root);
  // Payload material/texture views have the same lifetime as draw views.  Do
  // the copy before diagnostics can touch the native heap, then pass only
  // ordinary JS data to the result assembly below.
  const payloadSnapshot = snapshotPayloads(payloads);
  const diagnostics = api.stageDriverGetDiagnostics?.(root);
  const normalRecoveryWarnings = await recoverInstanceNormals(
    api, root, pointInstancerPaths, drawSnapshot, purposePolicy
  );
  // Orientation correction runs last, after recovery has copied normals from
  // the (still unflipped) prototype draw into the generated instanced meshes
  // and stamped their orientation, so every snapshot mesh is flipped exactly
  // once here.
  for (const mesh of drawSnapshot.meshes) applyOrientation(mesh);
  {
    const levels = Math.max(0, Math.min(2, Number.isFinite(request.subdivisionLevel) ? request.subdivisionLevel : 0));
    if (levels > 0) {
      const triangleLimits = request.triangleLimits !== false;
      const MESH_TRIANGLE_LIMIT = 700000;
      const STAGE_TRIANGLE_LIMIT = 6000000;
      const factor = 4 ** levels;
      let stageTriangleTotal = 0;
      for (const mesh of drawSnapshot.meshes) {
        const cornerCount = mesh.indices ? mesh.indices.length : (mesh.positions ? mesh.positions.length / 3 : 0);
        stageTriangleTotal += Math.floor(cornerCount / 3);
      }
      let budgetWarned = false;
      for (const mesh of drawSnapshot.meshes) {
        const scheme = mesh.subdivisionScheme;
        if (scheme !== "catmullClark" && scheme !== "loop") continue;
        if (mesh.instanceOwnerPath && !mesh.normals) continue;
        const cornerCount = mesh.indices ? mesh.indices.length : (mesh.positions ? mesh.positions.length / 3 : 0);
        const originalTriangles = Math.floor(cornerCount / 3);
        if (!originalTriangles) continue;
        const projectedTriangles = scheme === "catmullClark"
          ? catmullClarkProjectedTriangles(mesh, levels, originalTriangles)
          : originalTriangles * factor;
        if (triangleLimits && projectedTriangles > MESH_TRIANGLE_LIMIT) {
          drawSnapshot.warnings ??= [];
          drawSnapshot.warnings.push(
            `Subdivision skipped (would exceed ${MESH_TRIANGLE_LIMIT} triangles): ${mesh.path || mesh.name || "mesh"}`
          );
          continue;
        }
        if (triangleLimits && stageTriangleTotal - originalTriangles + projectedTriangles > STAGE_TRIANGLE_LIMIT) {
          if (!budgetWarned) {
            drawSnapshot.warnings ??= [];
            drawSnapshot.warnings.push(`Subdivision stopped: stage triangle budget (${STAGE_TRIANGLE_LIMIT}) reached`);
            budgetWarned = true;
          }
          continue;
        }
        const subdivided = scheme === "catmullClark"
          ? subdivideCatmullClark(mesh, levels, mesh.subsets, { faceVertexCounts: mesh.faceVertexCounts })
          : subdivideMesh(mesh, levels);
        delete mesh.faceVertexCounts;
        if (!subdivided) continue;
        // Only meshes whose bound material can possibly displace ever need
        // the pre-subdivision cage (see meshMaterialMayDisplace); every
        // other mesh skips this copy and its transfer to the main thread.
        if (meshMaterialMayDisplace(mesh, mtlxFileTextsByPath, usdaTexts)) mesh.cage = {
          positions: mesh.positions,
          normals: mesh.normals,
          uvs: mesh.uvs,
          indices: mesh.indices,
          subsets: Array.isArray(mesh.subsets) ? mesh.subsets.slice() : undefined,
          geomprops: Array.isArray(mesh.geomprops) ? mesh.geomprops : undefined,
        };
        mesh.subdivisionLevelsApplied = levels;
        stageTriangleTotal += subdivided.triangleCount - originalTriangles;
        mesh.positions = subdivided.positions;
        mesh.normals = subdivided.normals;
        if (subdivided.uvs) mesh.uvs = subdivided.uvs;
        if (subdivided.geomprops) mesh.geomprops = subdivided.geomprops;
        else delete mesh.geomprops;
        delete mesh.indices;
        if (scheme === "catmullClark") {
          if (subdivided.subsets) mesh.subsets = subdivided.subsets;
        } else if (Array.isArray(mesh.subsets) && mesh.subsets.length) {
          mesh.subsets = mesh.subsets.map(subset => ({
            ...subset,
            start: subset.start * factor,
            count: subset.count * factor,
          }));
        }
      }
    }
  }
  // Weld every ordinary mesh (with or without subdivision) so the renderer
  // gets an indexed vertex buffer and computeTangents averages tangents
  // across shared faces instead of per lone corner.
  for (const mesh of drawSnapshot.meshes) {
    if (mesh.instanceOwnerPath && !mesh.normals) continue;
    weldMesh(mesh);
  }
  postMessage({ id: request.id, type: "progress", value: {
    phase: "extract-materials", done: 1, total: 1, fraction: 0.9, message: "Extracted material payloads",
  } });
  const volumePaths = Array.from(new Set(graphEntriesOfType(
    graph, name => name === "volume"
  ).map(entry => text(entry.path)).filter(Boolean)));
  const volumeWarnings = volumePaths.map(path =>
    "Unsupported USD volume rendering: " + path + " (VDB volume data was not imported)"
  );
  const cameraWarnings = [];
  const cameras = collectCameras(api, root, graph, message => cameraWarnings.push(message), evaluatedTransforms);
  markDefaultCamera(api, root, graph, cameras);
  const lightWarnings = [];
  const lights = collectLights(api, root, graph, message => lightWarnings.push(message), evaluatedTransforms);
  const result = copyStageResult(summary, drawSnapshot, payloadSnapshot, cameras, lights, stageMetrics);
  result.warnings.push(...stageMetrics.warnings, ...volumeWarnings);
  const connectionWarnedLayers = new Set();
  for (const material of result.materials) {
    const mtlxTexts = decodeMtlxTextsForMaterial(material, mtlxFileTextsByPath);
    const overrides = collectMaterialOverrides(api, root, usdaTexts, mtlxTexts, material.path, stageTime);
    if (overrides.length) material.overrides = overrides;

    const built = buildUsdShadeMaterialX(api, root, material.path, usdaTexts);
    if (built) {
      const bytes = new TextEncoder().encode(built.xml);
      const mtlxPath = `__usdshade_${material.path.split("/").filter(Boolean).pop()}.mtlx`;
      material.materialX = {
        path: mtlxPath,
        mimeType: "application/xml",
        materialName: built.materialName,
        data: bytes,
      };
      material.sourceAsset = mtlxPath;
      material.materialName = built.materialName;
      delete material.subIdentifier;
      result.assets.push({ path: mtlxPath, data: bytes.buffer });
      result.transfer.push(bytes.buffer);
      continue;
    }
    const sourceAsset = text(material.sourceAsset) || "";
    if (sourceAsset.startsWith("__inline_")) {
      const gaps = collectInlineConnectionGaps(api, root, material, usdaTexts);
      if (gaps.length) {
        result.warnings.push(`${material.path}: some USD shader connections could not be read and use default values (${gaps.join(", ")})`);
      }
    } else if (sourceAsset && !sourceAsset.startsWith("__usdshade_")) {
      const layerPath = findUsdConnectionLayer(usdaTexts, material.path);
      if (layerPath && !connectionWarnedLayers.has(layerPath)) {
        connectionWarnedLayers.add(layerPath);
        result.warnings.push(
          "USD connections are not supported yet: " + layerPath + " connects shader inputs in USD, which is ignored. Materials keep the connections from their MaterialX files; input values set in USD still apply."
        );
      }
    }
  }
  // Unbound meshes with a displayColor share one synthetic material, tinted
  // per mesh by the renderer. Runs after the loop above so the record never
  // reaches collectMaterialOverrides / buildUsdShadeMaterialX.
  const displayColorMeshes = result.meshes.filter(mesh =>
    mesh.displayColor && !mesh.materialPath &&
    !(Array.isArray(mesh.groups) && mesh.groups.some(group => group.materialPath)));
  if (displayColorMeshes.length) {
    for (const mesh of displayColorMeshes) mesh.materialPath = DISPLAY_COLOR_MATERIAL_PATH;
    const xml = [
      '<?xml version="1.0"?>',
      '<materialx version="1.39">',
      '  <standard_surface name="SR_displayColor" type="surfaceshader">',
      '    <input name="base" type="float" value="1" />',
      '    <input name="base_color" type="color3" value="0.18, 0.18, 0.18" />',
      '    <input name="specular_roughness" type="float" value="0.5" />',
      '  </standard_surface>',
      '  <surfacematerial name="M_displayColor" type="material">',
      '    <input name="surfaceshader" type="surfaceshader" nodename="SR_displayColor" />',
      '  </surfacematerial>',
      '</materialx>',
      '',
    ].join("\n");
    const bytes = new TextEncoder().encode(xml);
    result.materials.push({
      path: DISPLAY_COLOR_MATERIAL_PATH,
      materialX: {
        path: DISPLAY_COLOR_SOURCE_ASSET,
        mimeType: "application/xml",
        materialName: DISPLAY_COLOR_MATERIAL_NAME,
        data: bytes,
      },
      sourceAsset: DISPLAY_COLOR_SOURCE_ASSET,
      materialName: DISPLAY_COLOR_MATERIAL_NAME,
      displayColorFallback: true,
    });
    result.assets.push({ path: DISPLAY_COLOR_SOURCE_ASSET, data: bytes.buffer });
    result.transfer.push(bytes.buffer);
    result.warnings.push(`[info] ${displayColorMeshes.length} meshes have no material and use their USD display color`);
  }
  resolveBackslashMaterialReferences(api, root, result, openStageStderrLines, uploadedPaths, graph);
  result.warnings.push(...cameraWarnings);
  result.warnings.push(...lightWarnings);
  result.warnings.push(...scanWarnings);
  result.warnings.push(...normalRecoveryWarnings);
  if (drawSnapshot.warnings?.length) result.warnings.push(...drawSnapshot.warnings);
  const extractedOwners = new Set(result.meshes.map(mesh => mesh.instanceOwnerPath).filter(Boolean));
  for (const path of pointInstancerPaths) {
    if (!extractedOwners.has(path)) {
      result.warnings.push(`Unsupported PointInstancer extraction: ${path}`);
    }
  }
  if (diagnostics !== undefined) {
    try {
      result.diagnostics = JSON.parse(JSON.stringify(diagnostics));
    } catch {
      result.diagnostics = { unavailable: true };
    }
  }
  result.diagnostics = {
    ...(result.diagnostics ?? {}),
    inputCache: { hits: inputCacheHits, misses: inputCacheMisses, bytes: inputCacheBytes },
  };
  // Lets the loader decide whether this load grew the wasm heap enough that
  // the persistent worker should be discarded instead of pinning it for the
  // rest of the session; undefined (never negative) when unavailable.
  const heapBuffer = wasmHeapBuffer();
  if (heapBuffer) result.wasmHeapBytes = heapBuffer.byteLength;
  const transfer = result.transfer;
  delete result.transfer;
  try {
    postMessage({ id: request.id, type: "result", result }, transfer);
  } catch (error) {
    // Keep structured-clone failures actionable instead of leaving the main
    // thread's promise pending (for example, a future native report field).
    postMessage({
      id: request.id,
      type: "error",
      error: `OpenUSD result could not cross Worker boundary: ${error?.message ?? error}`,
    });
  }
}

self.onmessage = event => {
  const request = event.data;
  if (!request || request.type !== "load") return;
load(request).catch(error => {
    if (error instanceof Error) console.error(error.stack || error.message);
    postMessage({
      id: request.id,
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  });
};
