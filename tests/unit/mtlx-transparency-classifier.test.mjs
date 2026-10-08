// classifyTransparentGraph (js/shared/mtlx-gen-core.js) against the shipped 1.39.5 WASM:
// transmission the WASM verdict (mx.isTransparentSurface) misses, inside nodedef graphs
// (disney_principled) and hand-built BSDF networks, plus the alpha fold it feeds.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const context = {};
context.globalThis = context;
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, 'js/shared/mtlx-gen-core.js'), 'utf8'), context);
const { classifyTransparentGraph, transmissionWeightExpr, patchTransmissionAlpha } = context.MtlxGenCore;

const versionDir = path.join(root, 'js/materialx/1.39.5');
const mod = await import(pathToFileURL(path.join(versionDir, 'JsMaterialXGenShader.js')).href);
const mx = await mod.default({ locateFile: (p) => path.join(versionDir, p) });
const gen = mx.EsslShaderGenerator.create();
const genContext = new mx.GenContext(gen);
const stdlib = mx.loadStandardLibraries(genContext);

const load = async (body) => {
  const doc = mx.createDocument();
  await mx.readFromXmlString(doc, '<materialx version="1.39">' + body + '</materialx>');
  doc.setDataLibrary(stdlib);
  return doc.getNode('surf');
};
const verdicts = async (body) => {
  const node = await load(body);
  return { node, wasm: !!mx.isTransparentSurface(node, gen.getTarget()), graph: classifyTransparentGraph(node, mx) };
};

const CASES = {
  disney_glass: ['<disney_principled name="surf" type="surfaceshader"><input name="specTrans" type="float" value="1.0"/></disney_principled>', true],
  disney_default: ['<disney_principled name="surf" type="surfaceshader"/>', false],
  disney_glass_metal: ['<disney_principled name="surf" type="surfaceshader"><input name="specTrans" type="float" value="1.0"/><input name="metallic" type="float" value="1.0"/></disney_principled>', false],
  dielectric_rt_surface: ['<dielectric_bsdf name="d" type="BSDF"><input name="scatter_mode" type="string" value="RT"/></dielectric_bsdf><surface name="surf" type="surfaceshader"><input name="bsdf" type="BSDF" nodename="d"/></surface>', true],
  dielectric_r_surface: ['<dielectric_bsdf name="d" type="BSDF"><input name="scatter_mode" type="string" value="R"/></dielectric_bsdf><surface name="surf" type="surfaceshader"><input name="bsdf" type="BSDF" nodename="d"/></surface>', false],
  zero_mix_dielectric: ['<dielectric_bsdf name="d" type="BSDF"><input name="scatter_mode" type="string" value="T"/></dielectric_bsdf><oren_nayar_diffuse_bsdf name="o" type="BSDF"/><mix name="m" type="BSDF"><input name="fg" type="BSDF" nodename="d"/><input name="bg" type="BSDF" nodename="o"/><input name="mix" type="float" value="0"/></mix><surface name="surf" type="surfaceshader"><input name="bsdf" type="BSDF" nodename="m"/></surface>', false],
  gltf_transmission: ['<gltf_pbr name="surf" type="surfaceshader"><input name="transmission" type="float" value="1.0"/></gltf_pbr>', true],
  standard_surface_default: ['<standard_surface name="surf" type="surfaceshader"/>', false],
  open_pbr_default: ['<open_pbr_surface name="surf" type="surfaceshader"/>', false],
};

for (const [name, [body, expected]] of Object.entries(CASES)) {
  test(name + ' is ' + (expected ? 'transparent' : 'opaque') + ' (WASM or graph classifier)', async () => {
    const { wasm, graph } = await verdicts(body);
    assert.equal(wasm || graph.transparent, expected, JSON.stringify({ wasm, graph: graph.transparent }));
  });
}

test('the WASM misses Disney glass and RT dielectrics; the classifier names their drivers', async () => {
  const disney = await verdicts(CASES.disney_glass[0]);
  assert.equal(disney.wasm, false);
  assert.equal(disney.graph.reason, 'transmission');
  assert.ok(disney.graph.drivers.includes('specTrans') && disney.graph.drivers.includes('metallic'));
  const expr = transmissionWeightExpr(disney.graph.weights, 'uniform float specTrans;\nuniform float metallic;\n');
  assert.ok(/specTrans/.test(expr) && /\(1\.0 - metallic\)/.test(expr), expr);
  const layered = await verdicts(CASES.dielectric_rt_surface[0]);
  assert.equal(layered.wasm, false);
  assert.equal(layered.graph.transparent, true);
});

test('the alpha fold uses the classifier weight on a generated Disney shader', async () => {
  const { node, graph } = await verdicts(CASES.disney_glass[0]);
  genContext.getOptions().hwTransparency = true;
  const shader = gen.generate('disney', node, genContext);
  const source = shader.getSourceCode('pixel');
  // Without a weight the pass leaves the shader alone, so opaque materials keep their bytes.
  assert.equal(patchTransmissionAlpha(source, {}), source);
  const patched = patchTransmissionAlpha(source, { weightExpr: transmissionWeightExpr(graph.weights, source) });
  assert.ok(patched.includes('uniform int u_peelMode;'));
  const fold = (patched.match(/float _tT = [^;]*;/) || [''])[0];
  assert.ok(/specTrans/.test(fold) && /\(1\.0 - metallic\)/.test(fold), fold);
});
