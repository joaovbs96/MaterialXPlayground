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
    const refs = (info) => ({ file: `t${info.index}.png`, wrapS: 33071, wrapT: 10497, magFilter: 9728, texCoord: info.texCoord });
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
