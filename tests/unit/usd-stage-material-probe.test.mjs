import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// The worker is a module with no exports, so run its source in a vm the way
// the other usd-stage-worker tests do and pick the helpers out of it.
function loadHelpers() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const workerPath = path.join(root, 'js', 'usd', 'usd-stage-worker.js');
  const sharedPath = path.join(root, 'js', 'shared', 'mesh-subdivision.js');
  const source = fs.readFileSync(sharedPath, 'utf8') + '\n'
    + fs.readFileSync(workerPath, 'utf8')
      .replace('import "../shared/mesh-subdivision.js";', '')
      .replace('const RUNTIME_DIR = new URL("../../vendor/usd-webview-bindings/", import.meta.url);', 'const RUNTIME_DIR = null;')
    + '\nthis.__helpers = { buildMaterialProbeLayer, materialRecordIsBare, probeMaterialPayloads,'
    + ' readUsdzEntries, rewritePackageTextureRefs, resolveInlinePackageTextures };';
  const context = {
    ArrayBuffer, Blob, DataView, Float32Array, Float64Array, Int32Array, Map, Math,
    Number, Set, TextDecoder, TextEncoder, Uint8Array, Uint32Array, URL,
    console,
    fetch: async () => { throw new Error('fetch is unavailable in this unit test'); },
    postMessage() {},
    self: {},
  };
  vm.runInNewContext(source, context, { filename: workerPath });
  return context.__helpers;
}

const {
  buildMaterialProbeLayer, materialRecordIsBare, probeMaterialPayloads,
  readUsdzEntries, rewritePackageTextureRefs, resolveInlinePackageTextures,
} = loadHelpers();
// Objects built inside the vm context have their own prototype; compare plain copies.
const plain = (value) => JSON.parse(JSON.stringify(value));
const encode = (text) => new TextEncoder().encode(text);
const decode = (bytes) => new TextDecoder().decode(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);

// Minimal stored (method 0) zip writer, the USDZ layout; `method` forces another
// method id on an entry to model a compressed one.
function writeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data, method = 0 } of entries) {
    const nameBytes = Buffer.from(name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28);
    chunks.push(header, nameBytes, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, directory, end]));
}

// --- probe layer text ----------------------------------------------------

test('probe layer references each target under its own scope with the same leaf name', () => {
  const { text, probePaths } = buildMaterialProbeLayer('/scene.usdz', [
    { path: '/World/mtl/A', block: true },
    { path: '/World/mtl/B', block: false },
  ]);
  assert.deepEqual(plain(Object.fromEntries(probePaths)), {
    '/World/mtl/A': '/__mtlxMaterialProbe/m0/A',
    '/World/mtl/B': '/__mtlxMaterialProbe/m1/B',
  });
  assert.equal(text.match(/def Scope "__mtlxMaterialProbe"/g).length, 1);
  assert.match(text, /def Material "A" \(\n\s+prepend references = @\/scene\.usdz@<\/World\/mtl\/A>\n\s+\)/);
  assert.match(text, /rel material:binding = <\/__mtlxMaterialProbe\/m1\/B>/);
  // Only the blocked target loses its outputs:surface connection.
  assert.equal(text.match(/token outputs:surface\.connect = None/g).length, 1);
  const blockA = text.slice(text.indexOf('def Material "A"'), text.indexOf('def Mesh'));
  assert.match(blockA, /outputs:surface\.connect = None/);
});

test('probe layer keeps every prim multi-line and skips unsafe or duplicate paths', () => {
  const { text, probePaths } = buildMaterialProbeLayer('/root.usda', [
    { path: '/A/M', block: false },
    { path: '/A/M', block: true },
    { path: '/__Prototype_1/Looks/M', block: false },
    { path: '/A/bad name', block: false },
    { path: '', block: false },
  ]);
  assert.deepEqual([...probePaths.keys()], ['/A/M']);
  assert.ok(!/outputs:surface/.test(text), 'the duplicate entry does not add a block');
  for (const line of text.split('\n')) {
    assert.ok(!(/\bdef\b/.test(line) && /[{}]/.test(line)), 'no one-line prim: ' + line);
  }
});

// --- bare records --------------------------------------------------------

test('a record is bare only without shader id, network and textures', () => {
  assert.equal(materialRecordIsBare({ path: '/M', roughness: 0.55, metallic: 0.05, opacity: 1 }), true);
  assert.equal(materialRecordIsBare({ path: '/M', shaderId: 'UsdPreviewSurface' }), false);
  assert.equal(materialRecordIsBare({ path: '/M', materialX: { path: '__inline_M.mtlx' } }), false);
  assert.equal(materialRecordIsBare({ path: '/M', diffuseTexture: { path: 'a.png' } }), false);
  assert.equal(materialRecordIsBare(null), false);
});

// --- probe driver with a fake runtime ------------------------------------

function fakeApi({ payloads, mtlxTerminals = [], openError = null }) {
  const calls = { created: [], opened: [] };
  const api = {
    getPrimAttributes: (root, primPath) => mtlxTerminals.includes(primPath)
      ? [{ name: 'outputs:mtlx:surface', isAuthored: true }] : [],
    createDataFile: (p, data) => calls.created.push({ path: p, text: decode(data) }),
    openStage: (p) => { calls.opened.push(p); return openError ? { error: openError } : { rootFile: p }; },
    extractMaterialPayloads: () => payloads(calls.created.at(-1).text),
  };
  return { api, calls };
}

const inlinePayload = (probePath, leaf, xml) => ({
  path: probePath,
  material: {
    path: probePath,
    shaderId: 'ND_UsdPreviewSurface_surfaceshader',
    materialX: { path: `/__inline_${leaf}.mtlx`, materialName: `M_${leaf}_inline`, data: encode(xml), resources: [] },
  },
});

test('a bare bound record with an authored mtlx terminal gets the probed network', () => {
  const result = {
    materials: [{ path: '/W/mtl/A', roughness: 0.55 }, { path: '/W/mtl/Keep', shaderId: 'UsdPreviewSurface' }],
    materialPrims: [{ path: '/W/mtl/A' }, { path: '/W/mtl/Keep' }],
    assets: [], transfer: [], warnings: [],
  };
  const { api, calls } = fakeApi({
    mtlxTerminals: ['/W/mtl/A'],
    payloads: () => [inlinePayload('/__mtlxMaterialProbe/m0/A', 'A', '<materialx/>')],
  });
  const out = probeMaterialPayloads(api, 'scene.usdz', result);
  assert.deepEqual(plain(out.replaced), ['/W/mtl/A']);
  assert.match(calls.created[0].text, /@\/scene\.usdz@<\/W\/mtl\/A>/);
  assert.match(calls.created[0].text, /outputs:surface\.connect = None/);
  const record = result.materials[0];
  assert.equal(record.path, '/W/mtl/A');
  assert.equal(record.sourceAsset, '__inline_A.mtlx');
  assert.equal(record.materialName, 'M_A_inline');
  assert.equal(result.materials[1].shaderId, 'UsdPreviewSurface');
  assert.deepEqual(result.assets.map((asset) => asset.path), ['__inline_A.mtlx']);
  assert.equal(result.transfer.length, 1);
});

test('unbound materials come back as a separate list with the unbound flag', () => {
  const result = {
    materials: [{ path: '/W/Looks/Mat', shaderId: 'UsdPreviewSurface' }],
    materialPrims: [{ path: '/W/Looks/Mat' }, { path: '/Lib/Looks/Mat' }, { path: '/Lib/Looks/Empty' }],
    assets: [{ path: '__inline_Mat.mtlx', data: new ArrayBuffer(1) }], transfer: [], warnings: [],
  };
  const { api, calls } = fakeApi({
    payloads: () => [
      inlinePayload('/__mtlxMaterialProbe/m0/Mat', 'Mat', '<materialx/>'),
      { path: '/__mtlxMaterialProbe/m1/Empty', material: { path: '/__mtlxMaterialProbe/m1/Empty', roughness: 0.5 } },
    ],
  });
  const out = probeMaterialPayloads(api, 'lib.usda', result);
  assert.equal(calls.opened.length, 1);
  assert.equal(result.materials.length, 1, 'bound materials are untouched');
  assert.equal(out.unbound.length, 1, 'a bare unbound payload is dropped');
  const [record] = plain(out.unbound);
  assert.equal(record.path, '/Lib/Looks/Mat');
  assert.equal(record.unbound, true);
  // Same leaf as a bound material: the network gets its own asset path.
  assert.equal(record.sourceAsset, '__inline_Mat__2.mtlx');
  assert.equal(record.materialX.path, '__inline_Mat__2.mtlx');
  assert.ok(result.assets.some((asset) => asset.path === '__inline_Mat__2.mtlx'));
});

test('nothing to probe means no temporary stage', () => {
  const result = {
    materials: [{ path: '/W/M', shaderId: 'UsdPreviewSurface' }],
    materialPrims: [{ path: '/W/M' }], assets: [], transfer: [], warnings: [],
  };
  const { api, calls } = fakeApi({ payloads: () => [] });
  const out = probeMaterialPayloads(api, 'a.usda', result);
  assert.equal(calls.created.length, 0);
  assert.deepEqual(plain(out), { warnings: [], unbound: [], replaced: [] });
});

test('a probe stage that fails to open leaves every record as it was', () => {
  const result = {
    materials: [{ path: '/W/mtl/A', roughness: 0.55 }],
    materialPrims: [{ path: '/W/mtl/A' }, { path: '/W/mtl/B' }], assets: [], transfer: [], warnings: [],
  };
  const { api } = fakeApi({ mtlxTerminals: ['/W/mtl/A'], openError: 'boom', payloads: () => [] });
  const out = probeMaterialPayloads(api, 'a.usdz', result);
  assert.equal(out.unbound.length, 0);
  assert.equal(result.materials[0].sourceAsset, undefined);
  assert.match(out.warnings[0], /^\[info\] Material probe stage could not be opened: boom/);
});

// --- USDZ entries and package texture refs -------------------------------

test('readUsdzEntries lists stored entries at their data offsets', () => {
  const png = new Uint8Array([1, 2, 3, 4, 5]);
  const zip = writeZip([
    { name: 'scene.usda', data: Buffer.from('#usda 1.0\n') },
    { name: '0/red.png', data: Buffer.from(png) },
    { name: 'deflated.png', data: Buffer.from([9, 9]), method: 8 },
  ]);
  const entries = readUsdzEntries(zip);
  assert.deepEqual([...entries.keys()], ['scene.usda', '0/red.png']);
  const { offset, size } = entries.get('0/red.png');
  assert.deepEqual(Array.from(zip.slice(offset, offset + size)), Array.from(png));
  assert.equal(readUsdzEntries(new Uint8Array(64)).size, 0, 'no end record, no entries');
  assert.equal(readUsdzEntries(null).size, 0);
});

test('relative and anchored package references become package keys', () => {
  const packages = new Map([['models/glove.usdz', new Set(['0/bc.jpg', '0/n.jpg'])]]);
  const xml = '<materialx version="1.39">'
    + '<input name="file" type="filename" value="0/bc.jpg" />'
    + '<input name="file" type="filename" value="/models/glove.usdz[0/n.jpg]" />'
    + '<input name="file" type="filename" value="0/missing.jpg" />'
    + '<input name="file" type="filename" value="https://example.com/0/bc.jpg" />'
    + '<input name="name" type="string" value="0/bc.jpg" />'
    + '</materialx>';
  const { xml: out, refs } = rewritePackageTextureRefs(xml, packages);
  assert.match(out, /value="models\/glove\.usdz\[0\/bc\.jpg\]"/);
  assert.match(out, /value="models\/glove\.usdz\[0\/n\.jpg\]"/);
  assert.match(out, /value="0\/missing\.jpg"/);
  assert.match(out, /value="https:\/\/example\.com\/0\/bc\.jpg"/);
  assert.match(out, /type="string" value="0\/bc\.jpg"/, 'only filename inputs are touched');
  assert.deepEqual(plain(refs).map((ref) => ref.key), ['models/glove.usdz[0/bc.jpg]', 'models/glove.usdz[0/n.jpg]']);
});

test('ambiguous entries and fileprefix documents are left alone', () => {
  const packages = new Map([['a.usdz', new Set(['t.png'])], ['b.usdz', new Set(['t.png'])]]);
  const ambiguous = rewritePackageTextureRefs('<input type="filename" value="t.png" />', packages);
  assert.equal(ambiguous.refs.length, 0);
  const prefixed = '<materialx fileprefix="tex/"><input type="filename" value="t.png" /></materialx>';
  assert.equal(rewritePackageTextureRefs(prefixed, new Map([['a.usdz', new Set(['tex/t.png'])]])).xml, prefixed);
});

test('inline networks are rewritten and each package entry is published once', () => {
  const zip = writeZip([{ name: '0/red.png', data: Buffer.from([7, 7, 7]) }]);
  const packages = new Map([['scene.usdz', { data: zip, entries: readUsdzEntries(zip) }]]);
  const xml = encode('<materialx><input name="file" type="filename" value="0/red.png" /></materialx>');
  const other = encode('<materialx><input name="file" type="filename" value="0/red.png" /></materialx>');
  const bound = { path: '/W/A', sourceAsset: '__inline_A.mtlx', materialX: { path: '__inline_A.mtlx', data: xml } };
  const unbound = { path: '/W/B', sourceAsset: '__inline_B.mtlx', materialX: { path: '__inline_B.mtlx', data: other }, unbound: true };
  const authored = { path: '/W/C', sourceAsset: 'looks/c.mtlx', materialX: { path: 'looks/c.mtlx', data: encode('<materialx><input type="filename" value="0/red.png" /></materialx>') } };
  const result = {
    assets: [{ path: '__inline_A.mtlx', data: xml.buffer }, { path: '__inline_B.mtlx', data: other.buffer }],
    transfer: [xml.buffer, other.buffer],
  };
  resolveInlinePackageTextures(result, [bound, unbound, authored], packages);
  assert.match(decode(bound.materialX.data), /value="scene\.usdz\[0\/red\.png\]"/);
  assert.match(decode(unbound.materialX.data), /value="scene\.usdz\[0\/red\.png\]"/);
  assert.match(decode(authored.materialX.data), /value="0\/red\.png"/, 'authored documents keep their paths');
  const texture = result.assets.filter((asset) => asset.path === 'scene.usdz[0/red.png]');
  assert.equal(texture.length, 1);
  assert.deepEqual(Array.from(new Uint8Array(texture[0].data)), [7, 7, 7]);
  assert.match(decode(result.assets[0].data), /scene\.usdz\[0\/red\.png\]/, 'the published asset follows the record');
  assert.equal(new Set(result.transfer).size, result.transfer.length, 'no buffer is transferred twice');
  assert.ok(!result.transfer.includes(xml.buffer), 'the replaced bytes are not transferred');
  assert.equal(zip.byteLength > 0, true, 'the package bytes are never detached');
});
