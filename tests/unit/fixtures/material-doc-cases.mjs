// Every importer material document the app can author, one per branch.
// Shared by the nodedef guard test and scripts/check-material-docs-wasm.mjs.
import {
  gltfPbrDocument, objMtlDocument, parseMtl, usdPreviewSurfaceDocument, pbrtMaterialDocument, mitsubaMaterialDocument,
} from '../../../js/usd/mtlx-material-docs.js';

const num = (v) => ({ type: 'float', value: v });
const rgb = (v) => ({ type: 'rgb', value: v });


export const materialDocCases = () => {
  const cases = [];
  const add = (label, xml) => cases.push({ label, xml });
  {
    const types = ['diffuse', 'plastic', 'roughplastic', 'dielectric', 'roughdielectric', 'thindielectric',
      'conductor', 'roughconductor', 'bogus'];
    for (const type of types) {
      for (const legacy of [false, true]) {
        const { xml } = mitsubaMaterialDocument({ name: type, legacy, emission: [1, 2, 3], bsdf: { type, props: {
          reflectance: rgb([0.2, 0.3, 0.4]), diffuse_reflectance: rgb([0.5, 0.2, 0.1]), specular_reflectance: rgb([0.9, 0.8, 0.7]),
          specular_transmittance: rgb([0.9, 0.9, 0.5]), alpha: num(0.2), int_ior: num(1.5), ext_ior: num(1),
          material: { type: 'string', value: 'Cu' },
        } } });
        add(`mitsuba ${type} legacy=${legacy}`, xml);
      }
    }
  }
  
  {
    const params = { reflectance: { type: 'rgb', values: [0.5, 0.2, 0.1] }, roughness: { type: 'float', values: [0.2] }, eta: { type: 'float', values: [1.5] } };
    for (const type of ['diffuse', 'coateddiffuse', 'dielectric', 'thindielectric', 'conductor', 'bogus']) {
      for (const emission of [undefined, [5, 5, 5]]) {
        add(`pbrt ${type}`, pbrtMaterialDocument({ name: type, material: { type, params }, emission }).xml);
      }
    }
  }

  {
    // Texture graphs: every pbrt texture kind on each colour slot, textured roughness.
    const img = (extra = {}) => ({ kind: 'image', file: 't.png', colorspace: 'srgb_texture', uaddress: 'periodic', vaddress: 'periodic', uv: null, scale: 1, invert: false, floatChannel: 'first', ...extra });
    const tex = (spec, name = 'T') => ({ type: 'texture', values: [name], texture: spec });
    const specs = {
      imagemap: img({ uv: [2, 0, 0, 3, 0.5, 0.25], uaddress: 'clamp', vaddress: 'constant', scale: 0.5, invert: true }),
      'imagemap linear rotated': img({ colorspace: null, uv: [0.8, 0.6, -0.6, 0.8, 0, 0] }),
      'imagemap gamma': img({ colorspace: 'g22_rec709' }),
      constant: { kind: 'constant', value: [0.2, 0.4, 0.6] },
      scale: { kind: 'scale', tex: img(), scale: img({ file: 's.png', colorspace: null }) },
      mix: { kind: 'mix', tex1: img(), tex2: { kind: 'constant', value: 0.3 }, amount: img({ file: 'm.png', colorspace: null }) },
      checkerboard: { kind: 'checker', tex1: { kind: 'constant', value: 1 }, tex2: img(), uv: [4, 0, 0, 4, 0, 0] },
      unsupported: { kind: 'unsupported', reason: 'texture "F" of type "fbm" is not supported' },
    };
    for (const [label, spec] of Object.entries(specs)) {
      for (const type of ['diffuse', 'coateddiffuse', 'conductor']) {
        add(`pbrt ${type} texture ${label}`, pbrtMaterialDocument({ name: 'T', material: { type, params: { reflectance: tex(spec) } } }).xml);
      }
    }
    add('pbrt coateddiffuse textured anisotropic roughness', pbrtMaterialDocument({ name: 'R', material: { type: 'coateddiffuse', params: {
      uroughness: tex(img({ colorspace: null }), 'U'), vroughness: { type: 'float', values: [0.1] } } } }).xml);
    add('pbrt dielectric textured roughness (sRGB float read)', pbrtMaterialDocument({ name: 'R', material: { type: 'dielectric', params: {
      roughness: tex(img()), remaproughness: { type: 'bool', values: [false] } } } }).xml);
    add('pbrt conductor textured roughness checker', pbrtMaterialDocument({ name: 'R', material: { type: 'conductor', params: {
      roughness: tex(specs.checkerboard) } } }).xml);
  }

  {
    // Mitsuba textures: bitmap and checkerboard on colours and alphas, plastic albedo matching.
    const bitmap = { kind: 'image', file: 'b.jpg', colorspace: 'srgb_texture', uaddress: 'mirror', vaddress: 'mirror', uv: [0.8, -0.6, 0.6, 0.8, 0.1, 0.2], scale: 1, invert: false, floatChannel: 'luminance' };
    const raw = { ...bitmap, file: 'r.png', colorspace: null, uaddress: 'clamp', vaddress: 'clamp', uv: null };
    const checker = { kind: 'checker', tex1: { kind: 'constant', value: 0.4 }, tex2: bitmap, uv: [2, 0, 0, -2, 0, 2] };
    const t = (spec) => ({ type: 'texture', plugin: spec.kind === 'checker' ? 'checkerboard' : 'bitmap', value: null, spec });
    for (const [label, spec] of Object.entries({ bitmap, raw, checker })) {
      add(`mitsuba diffuse ${label}`, mitsubaMaterialDocument({ name: 'D', bsdf: { type: 'diffuse', props: { reflectance: t(spec) } } }).xml);
      for (const nonlinear of [false, true]) {
        add(`mitsuba roughplastic ${label} nonlinear=${nonlinear}`, mitsubaMaterialDocument({ name: 'P', bsdf: { type: 'roughplastic', props: {
          diffuse_reflectance: t(spec), specular_reflectance: t(raw), alpha: num(0.1), nonlinear: { type: 'boolean', value: nonlinear } } } }).xml);
      }
      add(`mitsuba roughconductor alpha ${label}`, mitsubaMaterialDocument({ name: 'C', bsdf: { type: 'roughconductor', props: {
        alpha_u: t(spec), alpha_v: num(0.2), specular_reflectance: t(spec), material: { type: 'string', value: 'Au' } } } }).xml);
      add(`mitsuba roughdielectric ${label}`, mitsubaMaterialDocument({ name: 'G', bsdf: { type: 'roughdielectric', props: {
        alpha: t(spec), specular_transmittance: t(spec), specular_reflectance: t(raw) } } }).xml);
    }
    add('mitsuba plastic textured alpha', mitsubaMaterialDocument({ name: 'A', bsdf: { type: 'roughplastic', props: {
      diffuse_reflectance: t(bitmap), alpha: t(raw) } } }).xml);
  }

  {
    const refs = (info) =>({ file: `t${info.index}.png`, wrapS: 33071, wrapT: 10497, magFilter: 9728, texCoord: info.texCoord });
    const ext = {
      KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatRoughnessFactor: 0.1 }, KHR_materials_transmission: { transmissionFactor: 0.8 },
      KHR_materials_volume: { thicknessFactor: 2, attenuationDistance: 3, attenuationColor: [1, 0.5, 0.5] }, KHR_materials_ior: { ior: 1.45 },
      KHR_materials_sheen: { sheenColorFactor: [0.2, 0.2, 0.2], sheenRoughnessFactor: 0.4 },
      KHR_materials_specular: { specularFactor: 0.3, specularColorFactor: [0.9, 0.9, 1] },
      KHR_materials_iridescence: { iridescenceFactor: 1, iridescenceIor: 1.8, iridescenceThicknessMaximum: 550 },
      KHR_materials_anisotropy: { anisotropyStrength: 0.6, anisotropyRotation: 1.2 },
      KHR_materials_emissive_strength: { emissiveStrength: 4 }, KHR_materials_dispersion: { dispersion: 0.2 },
    };
    const textured = {
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.5], baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 1 }, metallicFactor: 0.5, roughnessFactor: 1 },
      normalTexture: { index: 2, scale: 2 }, occlusionTexture: { index: 3, strength: 0.5 }, emissiveTexture: { index: 4 }, emissiveFactor: [1, 1, 1],
    };
    const cases = {
      plain: { material: {}, textureRefs: () => null },
      extensions: { material: { extensions: ext }, textureRefs: () => null },
      textured: { material: textured, textureRefs: refs, hints: { hasVertexColor: true } },
      mask: { material: { alphaMode: 'MASK', alphaCutoff: 0.3, ...textured }, textureRefs: refs },
      blend: { material: { alphaMode: 'BLEND' }, textureRefs: () => null },
      unlit: { material: { extensions: { KHR_materials_unlit: {} } }, textureRefs: () => null },
      specGloss: { material: { extensions: { KHR_materials_pbrSpecularGlossiness: { diffuseFactor: [1, 1, 1, 1], specularFactor: [1, 1, 1], glossinessFactor: 0.5 } } }, textureRefs: () => null },
    };
    for (const [label, args] of Object.entries(cases)) add(`gltf ${label}`, gltfPbrDocument({ name: label, ...args }).xml);
  }
  
  {
    const mtl = parseMtl(['newmtl W', 'Kd 1 1 1', 'Ks 0.5 0.5 0.5', 'Ke 1 0.5 0', 'Ns 2', 'Ni 1.6', 'd 0.25', 'illum 6',
      'map_Kd -clamp on wood.png', 'map_Bump -bm 0.5 height.png', 'map_Ke e.png', 'map_Ks s.png', 'map_d a.png', 'Pr 0.2', 'Pm 0.9'].join('\n')).get('W');
    add('obj', objMtlDocument({ name: 'W', mtl, textureRefs: (r) => r.path }).xml);
    add('obj plain', objMtlDocument({ name: 'P', mtl: parseMtl('newmtl P\nKd 1 0 0').get('P'), textureRefs: () => null }).xml);
    add('usd', usdPreviewSurfaceDocument({ name: 'U', record: {
      diffuseColor: [0.4, 0.4, 0.4], emissiveColor: [1, 0, 0], roughness: 0.3, metallic: 1, opacity: 0.5, ior: 1.5, clearcoat: 1,
      diffuseTexture: 'd', roughnessTexture: 'r', metallicTexture: 'm', emissiveTexture: 'e', normalTexture: 'n', opacityTexture: 'o',
    }, textureRefs: () => 'tex.png' }).xml);
  }
  // Copy of the displayColor fallback in js/usd/usd-stage-worker.js.
  add('usd displayColor fallback', '<?xml version="1.0"?><materialx version="1.39"><standard_surface name="SR_displayColor" type="surfaceshader"><input name="base" type="float" value="1" /><input name="base_color" type="color3" value="0.18, 0.18, 0.18" /><input name="specular_roughness" type="float" value="0.5" /></standard_surface><surfacematerial name="M_displayColor" type="material"><input name="surfaceshader" type="surfaceshader" nodename="SR_displayColor" /></surfacematerial></materialx>');
  return cases;
};

// UsdShade networks driven through the worker's converter (usd-stage-worker.js).
const SHADER = (name, id, lines) => `    def Shader "${name}"\n    {\n        uniform token info:id = "${id}"\n${lines.map((l) => '        ' + l).join('\n')}\n    }\n`;
const MATERIAL = (terminals, shaders) => `#usda 1.0\ndef Material "M"\n{\n${terminals.map((t) => '    ' + t).join('\n')}\n${shaders.join('')}}\n`;
export const usdShadeCases = async () => {
  const { readFileSync } = await import('node:fs');
  const vm = await import('node:vm');
  // The worker is a classic script: evaluate it the way the other worker unit tests do.
  const workerUrl = new URL('../../../js/usd/usd-stage-worker.js', import.meta.url);
  const source = readFileSync(new URL('../../../js/shared/mesh-subdivision.js', import.meta.url), 'utf8') + '\n' + readFileSync(workerUrl, 'utf8')
    .replace(/^import "[^"]*";\s*$/m, '')
    .replace(/^const RUNTIME_DIR = .*$/m, 'const RUNTIME_DIR = null;')
    + '\nthis.__build = buildUsdShadeMaterialX;';
  const context = { Map, Set, Math, Number, TextDecoder, TextEncoder, ArrayBuffer, Uint8Array, URL, console, postMessage() {}, self: {} };
  vm.runInNewContext(source, context, { filename: workerUrl.pathname });
  const buildUsdShadeMaterialX = context.__build;
  const out = [];
  const build = (label, usda, options = { allowPreviewSurface: true }) => {
    const r = buildUsdShadeMaterialX({}, '/', '/M', [{ path: 'a.usda', text: usda }], options);
    if (!r) throw new Error('usd shade fixture produced no document: ' + label);
    out.push({ label, xml: r.xml });
  };
  build('usd preview network', readFileSync(new URL('./usd-preview-network.usda', import.meta.url), 'utf8'));
  const reader = (name, id, type) => SHADER(name, id, [`string inputs:varname = "set_${name}"`, type + ' outputs:result']);
  build('usd preview rgba texture + primvar readers', MATERIAL(
    ['token outputs:surface.connect = </M/Surf.outputs:surface>'],
    [SHADER('Surf', 'UsdPreviewSurface', ['color3f inputs:diffuseColor.connect = </M/Tex.outputs:rgba>', 'float inputs:opacity.connect = </M/F.outputs:result>',
      'float3 inputs:normal.connect = </M/V3.outputs:result>', 'token outputs:surface']),
    SHADER('Tex', 'UsdUVTexture', ['asset inputs:file = @t.png@', 'float2 inputs:st.connect = </M/Uv.outputs:result>', 'float4 outputs:rgba']),
    reader('Uv', 'UsdPrimvarReader_float2', 'float2'), reader('F', 'UsdPrimvarReader_float', 'float'),
    reader('V3', 'UsdPrimvarReader_float3', 'float3'), reader('S', 'UsdPrimvarReader_string', 'string')]));
  build('usd mtlx network', MATERIAL(
    ['token outputs:mtlx:surface.connect = </M/Surf.outputs:out>', 'token outputs:mtlx:displacement.connect = </M/Disp.outputs:out>'],
    [SHADER('Surf', 'ND_standard_surface_surfaceshader', ['color3f inputs:base_color.connect = </M/Img.outputs:out>', 'float inputs:base = 0.8',
      'float3 inputs:normal.connect = </M/Nm.outputs:out>', 'token outputs:out']),
    SHADER('Img', 'ND_image_color3', ['asset inputs:file = @t.png@', 'float2 inputs:texcoord.connect = </M/Tc.outputs:out>', 'color3f outputs:out']),
    SHADER('Nm', 'ND_normalmap', ['float3 inputs:in.connect = </M/Img2.outputs:out>', 'float inputs:scale = 1', 'float3 outputs:out']),
    SHADER('Img2', 'ND_image_vector3', ['asset inputs:file = @n.png@', 'float3 outputs:out']),
    SHADER('Tc', 'ND_texcoord_vector2', ['float2 outputs:out']),
    SHADER('Disp', 'ND_displacement_float', ['float inputs:displacement = 0.1', 'float inputs:scale = 1', 'token outputs:out'])]), { allowPreviewSurface: false });
  return out;
};
