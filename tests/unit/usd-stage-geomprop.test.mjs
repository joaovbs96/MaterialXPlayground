import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadWorkerHelpers({ forceHashCollision = false } = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const workerPath = path.join(root, 'js', 'usd', 'usd-stage-worker.js');
  const sharedPath = path.join(root, 'js', 'shared', 'mesh-subdivision.js');
  const sharedSource = fs.readFileSync(sharedPath, 'utf8')
    .replace(
      'function hashWeldNumber(value) {',
      `function hashWeldNumber(value) {${forceHashCollision ? ' return 0x12345678;' : ''}`,
    );
  const source = sharedSource + '\n' + fs.readFileSync(workerPath, 'utf8')
    .replace('import "../shared/mesh-subdivision.js";', '')
    .replace('const RUNTIME_DIR = new URL("../../vendor/usd-webview-bindings/", import.meta.url);', 'const RUNTIME_DIR = null;')
    + '\nthis.__helpers = { applyOrientation, copyGeomprop, snapshotDraw, subdivideMesh, weldMesh, copyStageResult, readMeshTokens, snapshotEvaluatedTransforms, collectCameras, collectLights, hashWeldNumber: globalThis.MtlxMeshSubdivision.hashWeldNumber, readMeshCastsShadow, readMeshCastsShadowOverride, readInstanceCastsShadow };';  const context = {
    ArrayBuffer,
    Blob,
    Float32Array,
    Float64Array,
    Int32Array,
    Map,
    Math,
    Number,
    Set,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    Uint32Array,
    URL,
    console,
    fetch: async () => { throw new Error('fetch is unavailable in this unit test'); },
    postMessage() {},
    self: {},
  };
  vm.runInNewContext(source, context, { filename: workerPath });
  return context.__helpers;
}

const { applyOrientation, copyGeomprop, snapshotDraw, subdivideMesh, weldMesh, copyStageResult, readMeshTokens, snapshotEvaluatedTransforms, collectCameras, collectLights, hashWeldNumber, readMeshCastsShadow, readMeshCastsShadowOverride, readInstanceCastsShadow } = loadWorkerHelpers();

function loadSceneGeometry() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'usd-scene-renderer.js'), 'utf8');
  const start = source.indexOf('const sceneObjectCastsShadow =');
  const end = source.indexOf('\n// Constant primvars', start);
  assert.ok(end > start, 'sceneGeometry extraction boundary is present');
  const context = {
    Float32Array,
    Number,
    THREE: {
      BufferAttribute: class {
        constructor(array, itemSize) { this.array = array; this.itemSize = itemSize; }
      },
      BufferGeometry: class {
        constructor() { this.attributes = {}; }
        setAttribute(name, attribute) { this.attributes[name] = attribute; }
        setIndex(attribute) { this.index = attribute; }
        computeVertexNormals() {}
        addGroup() {}
      },
    },
    window: {},
    sceneArray: value => Array.isArray(value) ? value : [],
  };
  vm.runInNewContext(source.slice(start, end) + String.fromCharCode(10) + 'this.sceneGeometry = sceneGeometry; this.sceneObjectCastsShadow = sceneObjectCastsShadow;', context, { filename: 'usd-scene-renderer.js' });
  return { sceneGeometry: context.sceneGeometry, sceneObjectCastsShadow: context.sceneObjectCastsShadow };
}

const { sceneGeometry, sceneObjectCastsShadow } = loadSceneGeometry();

function loadUdimMeshParts() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'usd-scene-renderer.js'), 'utf8');
  const udimStart = source.indexOf('const sceneUdimCode =');
  const udimEnd = source.indexOf('const sceneUdimRefs =', udimStart);
  const meshStart = source.indexOf('const meshParts =');
  const meshEnd = source.indexOf('\n        // A stage dome seeds', meshStart);
  class BufferAttribute {
    constructor(array, itemSize) {
      this.array = array;
      this.itemSize = itemSize;
      this.count = array.length / itemSize;
    }
  }
  class BufferGeometry {
    constructor() { this.attributes = {}; }
    setAttribute(name, attribute) { this.attributes[name] = attribute; }
    setIndex(index) {
      this.index = Array.isArray(index) ? new BufferAttribute(Uint32Array.from(index), 1) : index;
    }
    computeVertexNormals() {}
  }
  const material = { userData: { mtlxSceneCompiled: { geomprops: [{ name: 'mask', type: 'float' }] } } };
  const context = {
    Array,
    Float32Array,
    Map,
    Number,
    Set,
    Uint32Array,
    THREE: { BufferAttribute, BufferGeometry },
    byPath: new Map([['mat', {
      material,
      compiled: material.userData.mtlxSceneCompiled,
      udimRefs: [{ tiles: new Map([[1001, { path: 'mask.1001.png' }]]) }],
    }]]),
    materials: new Set(),
    sceneArray: value => Array.isArray(value) ? value : [],
    sceneGeompropConstants: () => null,
    sceneNeutralMaterial: () => material,
    udimMaterial: () => material,
    udimWarnings: new Set(),
    warnings: [],
    window: { prepGeometry() {}, bindGeompropAttributes() {} },
  };
  const sourceText = source.slice(udimStart, udimEnd) + String.fromCharCode(10)
    + source.slice(meshStart, meshEnd) + String.fromCharCode(10)
    + 'this.meshParts = meshParts;';
  vm.runInNewContext(sourceText, context, { filename: 'usd-scene-renderer.js' });
  return context.meshParts;
}

function loadBindGeompropAttributes() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'mtlx-engine.js'), 'utf8');
  const start = source.indexOf('const GEOMPROP_ITEM_SIZE =');
  const end = source.indexOf('\n\n// Center a geometry', start);
  class BufferAttribute {
    constructor(array, itemSize) {
      this.array = array;
      this.itemSize = itemSize;
      this.count = array.length / itemSize;
    }
  }
  const context = {
    Array,
    Float32Array,
    Number,
    THREE: { BufferAttribute },
  };
  vm.runInNewContext(source.slice(start, end) + String.fromCharCode(10)
    + 'this.bindGeompropAttributes = bindGeompropAttributes;', context, { filename: 'mtlx-engine.js' });
  return context.bindGeompropAttributes;
}

const meshParts = loadUdimMeshParts();
const bindGeompropAttributes = loadBindGeompropAttributes();

function tetrahedron() {
  const points = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0],
    [0, 0, 1],
  ];
  const faces = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [2, 0, 3]];
  const positions = [];
  const normals = [];
  for (const face of faces) {
    const a = points[face[0]], b = points[face[1]], c = points[face[2]];
    const ab = b.map((value, i) => value - a[i]);
    const ac = c.map((value, i) => value - a[i]);
    const n = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    for (const point of [a, b, c]) {
      positions.push(...point);
      normals.push(...n);
    }
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals) };
}

function assertStreamInvariant(mesh) {
  const vertexCount = mesh.positions.length / 3;
  for (const stream of mesh.geomprops ?? []) {
    assert.equal(stream.data.length, vertexCount * stream.itemSize, stream.name);
    assert.ok(Array.from(stream.data).every(Number.isFinite), stream.name);
  }
}

test('copies geomprop views into independent Float32Arrays', () => {
  const source = new Float32Array([1, 2, 3]);
  const prop = copyGeomprop({ name: 'rest', itemSize: 3, interpolation: 'vertex', data: source });
  source[0] = 99;
  assert.deepEqual(Array.from(prop.data), [1, 2, 3]);
  assert.equal(prop.itemSize, 3);
  assert.equal(prop.interpolation, 'vertex');
});

test('snapshots every native geomprop before the next mesh is requested', () => {
  const native = [0, 1].map(index => ({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    geomprops: [{ name: `mask${index}`, itemSize: 1, interpolation: 'vertex', data: new Float32Array([index, index + 1, index + 2]) }],
  }));
  const source = {
    size: () => native.length,
    get: index => {
      const mesh = native[index];
      if (index === 1) native[0].geomprops[0].data.fill(-1);
      return mesh;
    },
  };
  const result = snapshotDraw({ meshes: source });
  assert.deepEqual(Array.from(result.meshes[0].geomprops[0].data), [0, 1, 2]);
  assert.deepEqual(Array.from(result.meshes[1].geomprops[0].data), [1, 2, 3]);
});

test('subdivision carries constant and vector geomprops with valid lengths', () => {
  const mesh = tetrahedron();
  mesh.geomprops = [
    { name: 'constantMask', itemSize: 1, interpolation: 'constant', data: new Float32Array(mesh.positions.length / 3).fill(7) },
    { name: 'rest', itemSize: 3, interpolation: 'vertex', data: Float32Array.from(mesh.positions) },
  ];
  const subdivided = subdivideMesh(mesh, 2);
  assert.ok(subdivided);
  assertStreamInvariant(subdivided);
  assert.deepEqual(Array.from(subdivided.geomprops[0].data).filter(value => value !== 7), []);
  assert.equal(subdivided.geomprops[1].data.length, subdivided.positions.length);
});

test('weld hashing preserves fractional distinctions and canonical values', () => {
  assert.notEqual(hashWeldNumber(0.125), hashWeldNumber(0.875));
  assert.equal(hashWeldNumber(-0), hashWeldNumber(0));
  assert.equal(hashWeldNumber(Number.NaN), hashWeldNumber(Number.NaN));
});
test('welding keeps corners split when geomprop values differ', () => {
  const mesh = {
    positions: Float32Array.from([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 0, 0, 0, 1, 0, 0, 0, 1,
    ]),
    normals: new Float32Array(18).fill(1),
    geomprops: [{ name: 'mask', itemSize: 1, interpolation: 'vertex', data: Float32Array.from([1, 2, 3, 9, 3, 4]) }],
  };
  weldMesh(mesh);
  assert.equal(mesh.positions.length / 3, 5);
  assert.deepEqual(Array.from(mesh.geomprops[0].data), [1, 2, 3, 9, 4]);
  assert.deepEqual(Array.from(mesh.indices), [0, 1, 2, 3, 2, 4]);
  assertStreamInvariant(mesh);
});

test('subdivision resolves indexed position and per-vertex streams by source index', () => {
  const mesh = {
    positions: Float32Array.from([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    ]),
    normals: new Float32Array(12).fill(1),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 1]),
    geomprops: [{ name: 'mask', itemSize: 1, interpolation: 'vertex', data: Float32Array.from([10, 20, 30, 40]) }],
  };
  const subdivided = subdivideMesh(mesh, 1);
  assert.ok(subdivided);
  assertStreamInvariant(subdivided);
  assert.ok(Array.from(subdivided.uvs).every(Number.isFinite));
  const expanded = {
    positions: Float32Array.from([
      0, 0, 0, 1, 0, 0, 1, 1, 0,
      0, 0, 0, 1, 1, 0, 0, 1, 0,
    ]),
    normals: new Float32Array(18).fill(1),
    uvs: Float32Array.from([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]),
    geomprops: [{ name: 'mask', itemSize: 1, interpolation: 'vertex', data: Float32Array.from([10, 20, 30, 10, 30, 40]) }],
  };
  const expandedSubdivided = subdivideMesh(expanded, 1);
  const identityIndexed = { ...expanded, indices: Uint32Array.from([0, 1, 2, 3, 4, 5]) };
  const identitySubdivided = subdivideMesh(identityIndexed, 1);
  assert.deepEqual(Array.from(subdivided.positions), Array.from(expandedSubdivided.positions));
  assert.deepEqual(Array.from(subdivided.uvs), Array.from(expandedSubdivided.uvs));
  assert.deepEqual(Array.from(subdivided.geomprops[0].data), Array.from(expandedSubdivided.geomprops[0].data));
  assert.deepEqual(Array.from(identitySubdivided.geomprops[0].data), Array.from(expandedSubdivided.geomprops[0].data));
});

test('meshes without geomprops preserve the existing transform shape', () => {
  const mesh = tetrahedron();
  const subdivided = subdivideMesh(mesh, 1);
  assert.ok(subdivided);
  assert.equal('geomprops' in subdivided, false);
  weldMesh(mesh);
  assert.equal('geomprops' in mesh, false);
  assert.equal(mesh.indices.length, mesh.positions.length / 3);
});

test('subdivision rejects noninteger geomprop item sizes', () => {
  const mesh = tetrahedron();
  mesh.geomprops = [{ name: 'fractional', itemSize: 1.5, interpolation: 'vertex', data: new Float32Array(18).fill(2) }];
  const subdivided = subdivideMesh(mesh, 1);
  assert.ok(subdivided);
  assert.equal('geomprops' in subdivided, false);
});
test('normal metadata recognizes authored nonempty vec3 arrays only', () => {
  const read = records => readMeshTokens({ getPrimAttributes: () => records }, '/root.usd', '/Mesh');
  assert.equal(read([{ name: 'primvars:normals', typeName: 'vector3f[]', isAuthored: true, valueElementCount: 2 }]).authoredNormals, true);
  assert.equal(read([{ name: 'normals', typeName: 'normal3f[]', isAuthored: true, value: '[(0,0,1)]' }]).authoredNormals, true);
  assert.equal(read([{ name: 'normals', typeName: 'normal3f[]', isAuthored: true, valueElementCount: 0, value: '[]' }]).authoredNormals, false);
  assert.equal(read([{ name: 'normals', typeName: 'normal3d[]', isAuthored: true, valueElementCount: 2 }]).authoredNormals, false);
  assert.equal(read([{ name: 'normals', typeName: 'normal3f[]', isAuthored: false, valueElementCount: 2 }]).authoredNormals, false);
});

function triangleNormalDot(mesh) {
  const indices = mesh.indices ? Array.from(mesh.indices.slice(0, 3)) : [0, 1, 2];
  const point = index => [mesh.positions[index * 3], mesh.positions[index * 3 + 1], mesh.positions[index * 3 + 2]];
  const a = point(indices[0]), b = point(indices[1]), c = point(indices[2]);
  const ab = b.map((value, i) => value - a[i]);
  const ac = c.map((value, i) => value - a[i]);
  const cross = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const normal = [mesh.normals[indices[0] * 3], mesh.normals[indices[0] * 3 + 1], mesh.normals[indices[0] * 3 + 2]];
  return cross[0] * normal[0] + cross[1] * normal[1] + cross[2] * normal[2];
}
test('shadow visibility inherits authored no-shadow and defaults to casting', () => {
  const attrs = new Map([
    ['/World/geometry/macbeth_chart', [{ name: 'primvars:karma:object:rendervisibility', value: '-shadow', isAuthored: true }]],
    ['/World/geometry/macbeth_chart/visible', [{ name: 'primvars:karma:object:rendervisibility', value: 'visible', isAuthored: true }]],
    ['/World/geometry/ignored', [{ name: 'primvars:karma:object:rendervisibility', value: '-shadow', isAuthored: false }]],
  ]);
  const api = { getPrimAttributes: (_root, primPath) => attrs.get(primPath) ?? [] };
  assert.equal(readMeshCastsShadow(api, '/World/root.usda', '/World/geometry/macbeth_chart/mesh'), false);
  assert.equal(readMeshCastsShadow(api, '/World/root.usda', '/World/geometry/macbeth_chart/visible/mesh'), true);
  assert.equal(readMeshCastsShadow(api, '/World/root.usda', '/World/geometry/ignored/mesh'), true);
  assert.equal(readMeshCastsShadow(api, '/World/root.usda', '/World/geometry/egg/mesh'), true);
});

test('valid-normal point instances use owner shadow metadata then prototype fallback', () => {
  const attrs = new Map([
    ['/World/Prototype/mesh', [{ name: 'primvars:karma:object:rendervisibility', value: '-shadow', isAuthored: true }]],
    ['/World/Instancer', []],
    ['/World/OwnerNoShadow', [{ name: 'primvars:karma:object:rendervisibility', value: 'visible', isAuthored: true }]],
  ]);
  const api = {
    getPrimAttributes: (_root, primPath) => attrs.get(primPath) ?? [],
    inspectPrimRelationships: () => ({ relationships: [{ name: 'prototypes', targets: ['/World/Prototype'] }] }),
  };
  const prototypeFallback = { path: '/__instances__/Prototype/mesh', instanceOwnerPath: '/World/Instancer', normals: new Float32Array(3) };
  const ownerOverride = { path: '/__instances__/Prototype/mesh', instanceOwnerPath: '/World/OwnerNoShadow', normals: new Float32Array(3) };
  assert.equal(readMeshCastsShadowOverride(api, '/World/root.usda', '/World/Instancer'), undefined);
  assert.equal(readInstanceCastsShadow(api, '/World/root.usda', prototypeFallback), false);
  assert.equal(readInstanceCastsShadow(api, '/World/root.usda', ownerOverride), true);
});

test('renderer shadow caster flag defaults on and honors explicit no-shadow', () => {
  assert.equal(sceneObjectCastsShadow({}), true);
  assert.equal(sceneObjectCastsShadow({ userData: { castsShadow: true } }), true);
  assert.equal(sceneObjectCastsShadow({ userData: { castsShadow: false } }), false);
});

test('left-handed nonindexed meshes reorder geomprops with their corners', () => {
  const mesh = {
    orientation: 'leftHanded',
    positions: Float32Array.from([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 0, 0, 0, 1, 0, 0, 0, 1,
    ]),
    normals: new Float32Array(18).fill(1),
    uvs: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 1, 1]),
    geomprops: [{ name: 'mask', itemSize: 1, data: Float32Array.from([1, 2, 3, 4, 5, 6]) }],
  };
  applyOrientation(mesh);
  assert.deepEqual(Array.from(mesh.geomprops[0].data), [1, 3, 2, 4, 6, 5]);
  assert.deepEqual(Array.from(mesh.normals), new Array(18).fill(-1));
});

test('left-handed authored normals swap corners without a sign flip', () => {
  const mesh = {
    orientation: 'leftHanded',
    authoredNormals: true,
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: Float32Array.from([0, 0, -1, 0, 0, -1, 0, 0, -1]),
    geomprops: [{ name: 'mask', itemSize: 1, data: Float32Array.from([1, 2, 3]) }],
  };
  applyOrientation(mesh);
  assert.deepEqual(Array.from(mesh.normals), [0, 0, -1, 0, 0, -1, 0, 0, -1]);
  assert.deepEqual(Array.from(mesh.geomprops[0].data), [1, 3, 2]);
  assert.ok(triangleNormalDot(mesh) > 0);
});

test('left-handed generated normals flip sign after winding correction', () => {
  const mesh = {
    orientation: 'leftHanded',
    authoredNormals: false,
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: Uint32Array.from([0, 1, 2]),
  };
  applyOrientation(mesh);
  assert.deepEqual(Array.from(mesh.indices), [0, 2, 1]);
  assert.deepEqual(Array.from(mesh.normals).map(value => value === 0 ? 0 : value), [0, 0, -1, 0, 0, -1, 0, 0, -1]);
  assert.ok(triangleNormalDot(mesh) > 0);
});
test('copyStageResult transfers geomprop buffers exactly once', () => {
  const data = new Float32Array([1, 2, 3]);
  const result = copyStageResult({}, {
    meshes: [{
      positions: new Float32Array(9),
      normals: new Float32Array(9),
      geomprops: [{ name: 'mask', itemSize: 1, interpolation: 'vertex', data }],
      cage: { positions: new Float32Array(9), normals: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), geomprops: [{ name: 'cageMask', itemSize: 1, interpolation: 'vertex', data: new Float32Array([4, 5, 6]) }] },
      subdivisionScheme: 'catmullClark',
      subdivisionLevelsApplied: 1,
    }],
  }, [], [], []);
  const copiedData = result.meshes[0].geomprops[0].data;
  assert.equal(result.transfer.filter(buffer => buffer === copiedData.buffer).length, 1);
  assert.deepEqual(Array.from(result.meshes[0].geomprops[0].data), [1, 2, 3]);
  assert.equal(result.meshes[0].subdivisionScheme, 'catmullClark');
  assert.equal(result.meshes[0].subdivisionLevelsApplied, 1);
  assert.deepEqual(Array.from(result.meshes[0].cage.geomprops[0].data), [4, 5, 6]);
  assert.equal(result.transfer.filter(buffer => buffer === result.meshes[0].cage.geomprops[0].data.buffer).length, 1);
});

test('copied mesh records preserve explicit and default shadow casting', () => {
  const result = copyStageResult({}, {
    meshes: [
      { positions: new Float32Array(9), castsShadow: false },
      { positions: new Float32Array(9) },
    ],
  }, [], [], []);
  assert.equal(result.meshes[0].castsShadow, false);
  assert.equal(result.meshes[1].castsShadow, true);
});

test('renderer binds only exact geomprop streams', () => {
  const geometry = sceneGeometry({
    positions: new Float32Array(9),
    geomprops: [
      { name: 'exact', itemSize: 1, data: new Float32Array([1, 2, 3]) },
      { name: 'oversized', itemSize: 1, data: new Float32Array([1, 2, 3, 4]) },
      { name: 'fractional', itemSize: 1.5, data: new Float32Array([1, 2, 3, 4]) },
    ],
  });
  assert.ok(geometry.attributes.i_geomprop_exact);
  assert.equal(geometry.attributes.i_geomprop_exact.array.length, 3);
  assert.equal('i_geomprop_oversized' in geometry.attributes, false);
  assert.equal('i_geomprop_fractional' in geometry.attributes, false);
});

test('UDIM repartition copies geomprops by rebuilt source vertex index', () => {
  const parts = meshParts({
    positions: Float32Array.from([
      0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
    ]),
    normals: new Float32Array(12).fill(1),
    uvs: Float32Array.from([0.1, 0.1, 0.2, 0.1, 0.2, 0.2, 0.1, 0.2]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    materialPath: 'mat',
    geomprops: [{ name: 'mask', itemSize: 1, interpolation: 'vertex', data: Float32Array.from([10, 20, 30, 40]) }],
  }, () => ({ userData: { mtlxSceneCompiled: { geomprops: [] } } }));
  assert.equal(parts.length, 1);
  const geometry = parts[0].geometry;
  assert.deepEqual(Array.from(geometry.index.array), [0, 1, 2, 0, 2, 3]);
  assert.deepEqual(Array.from(geometry.attributes.i_geomprop_mask.array), [10, 20, 30, 40]);
  assert.equal(geometry.attributes.i_geomprop_mask.count, geometry.attributes.position.count);
});

test('MaterialX geomprop binding keeps a present stream and defaults missing streams', () => {
  class Geometry {
    constructor() {
      this.attributes = {
        position: { count: 3 },
        i_geomprop_rest: { array: Float32Array.from([1, 2, 3]), itemSize: 1, count: 3 },
      };
    }
    getAttribute(name) { return this.attributes[name]; }
    setAttribute(name, attribute) { this.attributes[name] = attribute; }
  }
  const geometry = new Geometry();
  const notices = [];
  const existing = geometry.getAttribute('i_geomprop_rest');
  bindGeompropAttributes(geometry, [
    { name: 'rest', type: 'float', defaultValue: [0.25] },
    { name: 'missing', type: 'float', defaultValue: [0.5] },
  ], text => notices.push(text));
  assert.equal(geometry.getAttribute('i_geomprop_rest'), existing);
  assert.deepEqual(Array.from(geometry.getAttribute('i_geomprop_missing').array), [0.5, 0.5, 0.5]);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /missing.*reads 0\.5/);
});

test('evaluated transforms use stage start time and reject malformed records', () => {
  const calls = [];
  const transforms = snapshotEvaluatedTransforms({
    stageDriverGetTiming: () => ({ start: 1 }),
    extractTransformsAtTime: (root, time) => {
      calls.push([root, time]);
      return [
        { path: '/World/Camera', matrix: Array.from({ length: 16 }, (_, i) => i) },
        { path: '/World/Bad', matrix: [1, 2, 3] },
        { path: '/World/NaN', matrix: Array.from({ length: 16 }, (_, i) => i === 4 ? NaN : i) },
        { path: '/World/Null', matrix: Array.from({ length: 16 }, (_, i) => i === 4 ? null : i) },
      ];
    },
  }, '/root.usda', {});
  assert.deepEqual(calls, [['/root.usda', 1]]);
  assert.deepEqual(Array.from(transforms.get('/World/Camera')), Array.from({ length: 16 }, (_, i) => i));
  assert.equal(transforms.has('/World/Bad'), false);
  assert.equal(transforms.has('/World/NaN'), false);
  assert.equal(transforms.has('/World/Null'), false);
});

test('camera and light collectors prefer valid evaluated transforms', () => {
  const api = { getPrimAttributes: () => [] };
  const graph = [
    { path: '/World/Camera', typeName: 'Camera' },
    { path: '/World/Dome', typeName: 'UsdLuxDomeLight' },
  ];
  const cameraMatrix = Array.from({ length: 16 }, (_, i) => i + 10);
  const lightMatrix = Array.from({ length: 16 }, (_, i) => i + 30);
  const transforms = new Map([['/World/Camera', cameraMatrix], ['/World/Dome', lightMatrix]]);
  const cameras = collectCameras(api, '/root.usda', graph, () => {}, transforms);
  const lights = collectLights(api, '/root.usda', graph, () => {}, transforms);
  assert.deepEqual(Array.from(cameras[0].matrix), cameraMatrix);
  assert.deepEqual(Array.from(lights[0].matrix), lightMatrix);
});

test('camera and light collectors preserve composed fallback without evaluated records', () => {
  const api = { getPrimAttributes: () => [] };
  const graph = [
    { path: '/World/Camera', typeName: 'Camera' },
    { path: '/World/Dome', typeName: 'UsdLuxDomeLight' },
  ];
  const cameras = collectCameras(api, '/root.usda', graph, () => {}, new Map());
  const lights = collectLights(api, '/root.usda', graph, () => {}, new Map());
  assert.deepEqual(Array.from(cameras[0].matrix), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.deepEqual(Array.from(lights[0].matrix), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
});
test('welding resolves numeric hash collisions with exact stream equality', () => {
  const collisionWeld = loadWorkerHelpers({ forceHashCollision: true }).weldMesh;
  const mesh = {
    positions: Float32Array.from([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 0, 0, 1, 0, 0, 0, 1, 0,
    ]),
    normals: new Float32Array(18).fill(1),
    geomprops: [{ name: 'mask', itemSize: 1, interpolation: 'vertex', data: Float32Array.from([1, 2, 3, 9, 2, 3]) }],
  };
  collisionWeld(mesh);
  assert.equal(mesh.weldedVertexCount, 4);
  assert.deepEqual(Array.from(mesh.indices), [0, 1, 2, 3, 1, 2]);
  assert.deepEqual(Array.from(mesh.geomprops[0].data), [1, 2, 3, 9]);
  assertStreamInvariant(mesh);
});

