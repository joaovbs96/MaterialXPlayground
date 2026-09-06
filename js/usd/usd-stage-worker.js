/*
 * OpenUSD stage extraction worker.
 *
 * The native usd-wg-webview bindings own USD composition (references,
 * sublayers, payloads, variants and usdMtlx). This file only copies their
 * result out of Emscripten memory into ordinary transferable buffers.
 */

const RUNTIME_DIR = new URL("../../vendor/usd-webview-bindings/", import.meta.url);
let runtimePromise;
let activeStage;
const nativeWarnings = [];
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  nativeWarnings.push(args.map(value => String(value)).join(" "));
  originalConsoleError(...args);
};

function runtime() {
  if (!runtimePromise) {
    // The published convenience wrapper is browser-global by design. Giving
    // it a window alias is sufficient in a dedicated module Worker and keeps
    // its filesystem/path handling identical to the supported browser build.
    globalThis.window ??= globalThis;
    runtimePromise = import("../../vendor/usd-webview-bindings/usdWebViewBindings.js")
      .then(() => globalThis.UsdWebViewBindings.createRuntime({
        locateFile: path => new URL(path, RUNTIME_DIR).href,
      }));
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

function text(value) {
  return value == null ? undefined : String(value);
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

function copyMesh(mesh, assets, materials) {
  const positions = arrayCopy(mesh.positions ?? mesh.points, Float32Array);
  if (!positions || !positions.length) return undefined;
  const normals = arrayCopy(mesh.normals, Float32Array);
  const uvs = arrayCopy(mesh.uvs, Float32Array);
  const indices = arrayCopy(mesh.indices, Uint32Array);
  const material = copyMaterial(mesh.material, assets);
  const materialPath = text(mesh.materialPath) ?? text(mesh.material?.path);
  if (materialPath && material) materials.set(materialPath, material);
  const groups = arrayItems(mesh.subsets ?? mesh.materialSubsets).map(copySubset);
  const matrix = arrayCopy(mesh.matrix, Float64Array);
  const hasInstanceMatrices = mesh.instanceMatrices != null;
  const instance = copyInstanceMatrices(mesh.instanceMatrices);
  return {
    primPath: text(mesh.path) ?? text(mesh.primPath) ?? "",
    name: text(mesh.name) ?? "",
    positions,
    ...(normals ? { normals } : {}),
    ...(uvs ? { uvs } : {}),
    ...(indices ? { indices } : {}),
    matrix: matrix ? Array.from(matrix) : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
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
    const matrix = arrayCopy(mesh.matrix, Float64Array);
    const hasInstanceMatrices = mesh.instanceMatrices != null;
    const instance = copyInstanceMatrices(mesh.instanceMatrices);
    return {
      path: text(mesh.path) ?? text(mesh.primPath) ?? "",
      name: text(mesh.name) ?? "",
      positions,
      ...(normals ? { normals } : {}),
      ...(uvs ? { uvs } : {}),
      ...(indices ? { indices } : {}),
      matrix,
      materialPath: text(mesh.materialPath) ?? text(mesh.material?.path),
      material: copyMaterial(mesh.material, new Map()),
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
  const generated = drawSnapshot.meshes.filter(mesh => mesh.instanceOwnerPath && !mesh.normals);
  if (!generated.length || !api.inspectPrimRelationships || !api.createDataFile || !api.openStage) return [];
  const probes = new Map();
  const warnings = [];
  for (const mesh of generated) {
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

function copyStageResult(summary, draw, payloads) {
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
    upAxis: summary?.upAxis,
    metersPerUnit: summary?.metersPerUnit,
    summary: summary ?? null,
    meshes,
    materials: materialList,
    assets: assetList,
    warnings: Array.from(new Set(warnings)),
    transfer,
  };
}

async function load(request) {
  const api = await runtime();
  const fileTotal = (request.files ?? []).filter(file => file?.path).length;
  postMessage({ id: request.id, type: "progress", value: { phase: "worker", done: 0, total: fileTotal, fraction: 0.05, message: "Preparing input files" } });
  let loadedFiles = 0;
  for (const file of request.files ?? []) {
    if (!file?.path) continue;
    const source = typeof file.data?.arrayBuffer === "function"
      ? await file.data.arrayBuffer()
      : file.data;
    const data = source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : arrayCopy(source, Uint8Array);
    if (!data) continue;
    api.createDataFile(normalizePath(file.path), data);
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
  if (activeStage) api.closeStage(activeStage);
  activeStage = root;
  postMessage({ id: request.id, type: "progress", value: { phase: "parse", done: 0, total: 0, fraction: 0.3, message: "Composing stage" } });
  const summary = api.openStage(root, true);
  if (summary?.error) throw new Error(summary.error);
  postMessage({ id: request.id, type: "progress", value: { phase: "parse", done: 1, total: 1, fraction: 0.4, message: "Composed stage" } });
  if (!api.createStageDriver(root)) throw new Error("OpenUSD stage driver could not be created");
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
    for (let index = 0; index < uniqueMeshPaths.length; index++) {
      const path = uniqueMeshPaths[index];
      let subtree = api.stageDriverDrawSubtree(root, path, purposePolicy);
      try {
        for (const mesh of snapshotDraw(subtree).meshes) {
          if (!mesh.path || !copiedMeshPaths.has(mesh.path)) {
            drawSnapshot.meshes.push(mesh);
            if (mesh.path) copiedMeshPaths.add(mesh.path);
          }
        }
      } catch (error) {
        // Some large stages can leave the first subtree's view on a stale
        // heap generation even though no later API call was made. Reissue
        // this same bounded subtree request once; the second native result
        // is independently copied and avoids recovering from a detached
        // view, which is impossible.
        if (!/detached|out-of-bounds/i.test(String(error?.message ?? error))) throw error;
        subtree = api.stageDriverDrawSubtree(root, path, purposePolicy);
        for (const mesh of snapshotDraw(subtree).meshes) {
          if (!mesh.path || !copiedMeshPaths.has(mesh.path)) {
            drawSnapshot.meshes.push(mesh);
            if (mesh.path) copiedMeshPaths.add(mesh.path);
          }
        }
      }
      postMessage({ id: request.id, type: "progress", value: {
        phase: "geometry", done: index + 1, total: uniqueMeshPaths.length,
        fraction: 0.45 + 0.3 * ((index + 1) / uniqueMeshPaths.length),
        message: "Copied mesh data",
      } });
    }
  } else {
    const draw = api.stageDriverDraw(root, true, purposePolicy);
    // Snapshot before making the next native call; diagnostics and payload
    // extraction may also refresh the Emscripten heap.
    drawSnapshot = snapshotDraw(draw);
  }
  postMessage({ id: request.id, type: "progress", value: { phase: "material", done: 0, total: 0, fraction: 0.8, message: "Extracting material payloads" } });
  const payloads = api.extractMaterialPayloads(root);
  // Payload material/texture views have the same lifetime as draw views.  Do
  // the copy before diagnostics can touch the native heap, then pass only
  // ordinary JS data to the result assembly below.
  const payloadSnapshot = snapshotPayloads(payloads);
  const diagnostics = api.stageDriverGetDiagnostics?.(root);
  const normalRecoveryWarnings = await recoverInstanceNormals(
    api, root, pointInstancerPaths, drawSnapshot, purposePolicy
  );
  postMessage({ id: request.id, type: "progress", value: {
    phase: "material", done: 1, total: 1, fraction: 0.9, message: "Extracted material payloads",
  } });
  const result = copyStageResult(summary, drawSnapshot, payloadSnapshot);
  result.warnings.push(...normalRecoveryWarnings);
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
load(request).catch(error => postMessage({
    id: request.id,
    type: "error",
    error: error instanceof Error ? (error.stack || error.message) : String(error),
  }));
};
