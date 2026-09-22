// Unit coverage for js/usd/mtlx-material-docs.js: the three material
// converters (glTF PBR, OBJ/MTL, flattened UsdPreviewSurface), the MTL
// parser and the shared name/number helpers.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatNumber,
  gltfPbrDocument,
  objMtlDocument,
  parseMtl,
  sanitizeMtlxName,
  usdPreviewSurfaceDocument,
  xmlEscape,
} from '../../js/usd/mtlx-material-docs.js';

// Pulls the attributes of one <input> line out of a document.
function elementPattern(nodeName) {
  return new RegExp(`^<[A-Za-z_][A-Za-z0-9_]* name="${nodeName}"`);
}

function inputLine(xml, nodeName, inputName) {
  const lines = xml.split('\n');
  const pattern = elementPattern(nodeName);
  const start = lines.findIndex(line => pattern.test(line.trim()));
  assert.ok(start >= 0, `node ${nodeName} not found in\n${xml}`);
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('<input')) break;
    if (line.includes(`name="${inputName}"`)) return line;
  }
  return null;
}

function nodeLine(xml, nodeName) {
  const pattern = elementPattern(nodeName);
  return xml.split('\n').find(line => pattern.test(line.trim())) || null;
}

const allRefs = info => ({
  file: `textures/tex${info.index}.png`,
  wrapS: 33071,
  wrapT: 10497,
  magFilter: 9728,
  texCoord: info.texCoord,
});

test('gltf: constant factors with no textures', () => {
  const { xml, materialName, notes } = gltfPbrDocument({
    name: 'Red Metal',
    material: {
      pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1], metallicFactor: 1, roughnessFactor: 0.25 },
      emissiveFactor: [0, 0.5, 0],
    },
    textureRefs: () => null,
  });
  assert.equal(materialName, 'M_Red_Metal');
  assert.match(xml, /^<\?xml version="1\.0"\?>\n<materialx version="1\.39"/);
  assert.match(xml, /<gltf_pbr name="SR_Red_Metal" type="surfaceshader">/);
  assert.match(xml, /<surfacematerial name="M_Red_Metal" type="material">/);
  assert.match(inputLine(xml, 'SR_Red_Metal', 'base_color'), /value="1, 0, 0"/);
  assert.match(inputLine(xml, 'SR_Red_Metal', 'roughness'), /value="0\.25"/);
  assert.match(inputLine(xml, 'SR_Red_Metal', 'metallic'), /value="1"/);
  assert.match(inputLine(xml, 'SR_Red_Metal', 'emissive'), /value="0, 0\.5, 0"/);
  assert.match(inputLine(xml, 'SR_Red_Metal', 'alpha_mode'), /value="0"/);
  assert.deepEqual(notes, []);
  assert.ok(!xml.includes('gltf_colorimage'));
});

test('gltf: textures, channel extracts and vertex color', () => {
  const { xml, notes } = gltfPbrDocument({
    name: 'tex',
    material: {
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 1],
        baseColorTexture: { index: 0 },
        metallicRoughnessTexture: { index: 1 },
        metallicFactor: 0.5,
        roughnessFactor: 1,
      },
      normalTexture: { index: 2, scale: 2 },
      occlusionTexture: { index: 3 },
      emissiveTexture: { index: 4 },
      emissiveFactor: [1, 1, 1],
    },
    textureRefs: allRefs,
    hints: { hasVertexColor: true },
  });
  // base color goes through gltf_colorimage, alpha comes off outa
  assert.match(nodeLine(xml, 'base_color_image'), /<gltf_colorimage name="base_color_image" type="multioutput">/);
  assert.match(inputLine(xml, 'base_color_image', 'file'), /value="textures\/tex0\.png" colorspace="srgb_texture"/);
  assert.match(inputLine(xml, 'base_color_image', 'uaddressmode'), /value="clamp"/);
  assert.match(inputLine(xml, 'base_color_image', 'vaddressmode'), /value="periodic"/);
  assert.match(inputLine(xml, 'base_color_image', 'filtertype'), /value="closest"/);
  // OPAQUE ignores alpha entirely, so nothing is wired to it
  assert.equal(inputLine(xml, 'SR_tex', 'alpha'), null);
  // vertex color multiply sits between the image and base_color
  assert.match(inputLine(xml, 'base_color_vertex', 'in1'), /nodename="base_color_image" output="outcolor"/);
  assert.match(inputLine(xml, 'vertex_color', 'geomprop'), /value="color"/);
  assert.match(inputLine(xml, 'SR_tex', 'base_color'), /nodename="base_color_vertex"/);
  // metallic roughness: G roughness (factor 1, no multiply), B metallic scaled
  assert.match(inputLine(xml, 'roughness_channel', 'index'), /value="1"/);
  assert.match(inputLine(xml, 'SR_tex', 'roughness'), /nodename="roughness_channel"/);
  assert.match(inputLine(xml, 'metallic_channel', 'index'), /value="2"/);
  assert.match(inputLine(xml, 'metallic_scaled', 'in2'), /value="0\.5"/);
  assert.match(inputLine(xml, 'SR_tex', 'metallic'), /nodename="metallic_scaled"/);
  // normal scale 2 needs the image plus a normalmap, gltf_normalmap has no scale
  assert.match(nodeLine(xml, 'normal_image'), /<gltf_image name="normal_image" type="vector3">/);
  assert.match(inputLine(xml, 'normal_image', 'default'), /value="0\.5, 0\.5, 1"/);
  assert.match(inputLine(xml, 'normal_image_normalmap', 'scale'), /value="2"/);
  assert.match(inputLine(xml, 'SR_tex', 'normal'), /nodename="normal_image_normalmap"/);
  assert.match(inputLine(xml, 'occlusion_channel', 'index'), /value="0"/);
  assert.match(inputLine(xml, 'SR_tex', 'emissive'), /nodename="emissive_image" output="outcolor"/);
  assert.deepEqual(notes, []);
});

test('gltf: an unscaled normal texture stays on gltf_normalmap', () => {
  const { xml } = gltfPbrDocument({
    name: 'n',
    material: { normalTexture: { index: 0 } },
    textureRefs: allRefs,
  });
  assert.match(nodeLine(xml, 'normal_image'), /<gltf_normalmap name="normal_image" type="vector3">/);
  assert.match(inputLine(xml, 'SR_n', 'normal'), /nodename="normal_image"/);
});

test('gltf: occlusion strength becomes a mix against 1', () => {
  const { xml } = gltfPbrDocument({
    name: 'ao',
    material: { occlusionTexture: { index: 0, strength: 0.25 } },
    textureRefs: allRefs,
  });
  assert.match(inputLine(xml, 'occlusion_strength', 'fg'), /nodename="occlusion_channel"/);
  assert.match(inputLine(xml, 'occlusion_strength', 'bg'), /value="1"/);
  assert.match(inputLine(xml, 'occlusion_strength', 'mix'), /value="0\.25"/);
  assert.match(inputLine(xml, 'SR_ao', 'occlusion'), /nodename="occlusion_strength"/);
});

test('gltf: base color alpha only reaches alpha when the mode is not OPAQUE', () => {
  const material = {
    alphaMode: 'BLEND',
    pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], baseColorTexture: { index: 0 } },
  };
  const { xml } = gltfPbrDocument({ name: 'b', material, textureRefs: allRefs });
  assert.match(inputLine(xml, 'SR_b', 'alpha'), /nodename="base_color_image" output="outa"/);
});

test('gltf: alpha modes', () => {
  const mask = gltfPbrDocument({ name: 'm', material: { alphaMode: 'MASK', alphaCutoff: 0.25 }, textureRefs: () => null });
  assert.match(inputLine(mask.xml, 'SR_m', 'alpha_mode'), /value="1" uniform="true"/);
  assert.match(inputLine(mask.xml, 'SR_m', 'alpha_cutoff'), /value="0\.25"/);
  const blend = gltfPbrDocument({ name: 'm', material: { alphaMode: 'BLEND' }, textureRefs: () => null });
  assert.match(inputLine(blend.xml, 'SR_m', 'alpha_mode'), /value="2"/);
  assert.equal(inputLine(blend.xml, 'SR_m', 'alpha_cutoff'), null);
});

test('gltf: extensions map onto gltf_pbr inputs, unknown ones are noted', () => {
  const { xml, notes } = gltfPbrDocument({
    name: 'ext',
    material: {
      extensions: {
        KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatRoughnessFactor: 0.1 },
        KHR_materials_transmission: { transmissionFactor: 0.8 },
        KHR_materials_volume: { thicknessFactor: 2, attenuationDistance: 3, attenuationColor: [1, 0.5, 0.5] },
        KHR_materials_ior: { ior: 1.45 },
        KHR_materials_sheen: { sheenColorFactor: [0.2, 0.2, 0.2], sheenRoughnessFactor: 0.4 },
        KHR_materials_specular: { specularFactor: 0.3, specularColorFactor: [0.9, 0.9, 1] },
        KHR_materials_iridescence: { iridescenceFactor: 1, iridescenceIor: 1.8, iridescenceThicknessMaximum: 550 },
        KHR_materials_anisotropy: { anisotropyStrength: 0.6, anisotropyRotation: 1.2 },
        KHR_materials_emissive_strength: { emissiveStrength: 4 },
        KHR_materials_dispersion: { dispersion: 0.2 },
        KHR_materials_diffuse_transmission: {},
      },
    },
    textureRefs: () => null,
  });
  assert.match(inputLine(xml, 'SR_ext', 'clearcoat'), /value="1"/);
  assert.match(inputLine(xml, 'SR_ext', 'clearcoat_roughness'), /value="0\.1"/);
  assert.match(inputLine(xml, 'SR_ext', 'transmission'), /value="0\.8"/);
  assert.match(inputLine(xml, 'SR_ext', 'thickness'), /value="2"/);
  assert.match(inputLine(xml, 'SR_ext', 'attenuation_distance'), /value="3"/);
  assert.match(inputLine(xml, 'SR_ext', 'attenuation_color'), /value="1, 0\.5, 0\.5"/);
  assert.match(inputLine(xml, 'SR_ext', 'ior'), /value="1\.45"/);
  assert.match(inputLine(xml, 'SR_ext', 'sheen_color'), /value="0\.2, 0\.2, 0\.2"/);
  assert.match(inputLine(xml, 'SR_ext', 'sheen_roughness'), /value="0\.4"/);
  assert.match(inputLine(xml, 'SR_ext', 'specular'), /value="0\.3"/);
  assert.match(inputLine(xml, 'SR_ext', 'specular_color'), /value="0\.9, 0\.9, 1"/);
  assert.match(inputLine(xml, 'SR_ext', 'iridescence_ior'), /value="1\.8"/);
  assert.match(inputLine(xml, 'SR_ext', 'iridescence_thickness'), /value="550"/);
  assert.match(inputLine(xml, 'SR_ext', 'anisotropy_strength'), /value="0\.6"/);
  assert.match(inputLine(xml, 'SR_ext', 'anisotropy_rotation'), /value="1\.2"/);
  assert.match(inputLine(xml, 'SR_ext', 'emissive_strength'), /value="4"/);
  assert.match(inputLine(xml, 'SR_ext', 'dispersion'), /value="0\.2"/);
  assert.deepEqual(notes, ['Unsupported glTF extension: KHR_materials_diffuse_transmission (ignored)']);
});

test('gltf: anisotropy texture goes through gltf_anisotropy_image', () => {
  const { xml, notes } = gltfPbrDocument({
    name: 'an',
    material: {
      extensions: {
        KHR_materials_anisotropy: { anisotropyStrength: 0.8, anisotropyRotation: 1.2, anisotropyTexture: { index: 0 } },
      },
    },
    textureRefs: allRefs,
  });
  assert.match(nodeLine(xml, 'anisotropy_image'), /<gltf_anisotropy_image name="anisotropy_image" type="multioutput">/);
  assert.match(inputLine(xml, 'anisotropy_image', 'anisotropy_strength'), /value="0\.8"/);
  assert.match(inputLine(xml, 'anisotropy_image', 'anisotropy_rotation'), /value="1\.2"/);
  assert.match(inputLine(xml, 'SR_an', 'anisotropy_strength'), /nodename="anisotropy_image" output="anisotropy_strength_out"/);
  assert.match(inputLine(xml, 'SR_an', 'anisotropy_rotation'), /nodename="anisotropy_image" output="anisotropy_rotation_out"/);
  assert.deepEqual(notes, []);
});

test('gltf: specular and sheen roughness read the alpha channel', () => {
  const { xml } = gltfPbrDocument({
    name: 'a',
    material: {
      extensions: {
        KHR_materials_specular: { specularFactor: 0.5, specularTexture: { index: 0 } },
        KHR_materials_sheen: { sheenRoughnessFactor: 0.5, sheenRoughnessTexture: { index: 1 } },
      },
    },
    textureRefs: allRefs,
  });
  assert.match(nodeLine(xml, 'specular_image'), /<gltf_image name="specular_image" type="color4">/);
  assert.match(inputLine(xml, 'specular_image_channel', 'index'), /value="3"/);
  assert.match(inputLine(xml, 'specular_image_scaled', 'in2'), /value="0\.5"/);
  assert.match(inputLine(xml, 'SR_a', 'specular'), /nodename="specular_image_scaled"/);
  assert.match(inputLine(xml, 'sheen_roughness_image_channel', 'index'), /value="3"/);
  assert.match(inputLine(xml, 'SR_a', 'sheen_roughness'), /nodename="sheen_roughness_image_scaled"/);
});

test('gltf: KHR_materials_pbrSpecularGlossiness maps onto gltf_pbr', () => {
  const constant = gltfPbrDocument({
    name: 'sg',
    material: {
      extensions: {
        KHR_materials_pbrSpecularGlossiness: {
          diffuseFactor: [0.8, 0.6, 0.4, 1], specularFactor: [0.9, 0.9, 1], glossinessFactor: 0.75,
        },
      },
    },
    textureRefs: () => null,
  });
  assert.match(inputLine(constant.xml, 'SR_sg', 'base_color'), /value="0\.8, 0\.6, 0\.4"/);
  assert.match(inputLine(constant.xml, 'SR_sg', 'metallic'), /value="0"/);
  assert.match(inputLine(constant.xml, 'SR_sg', 'specular_color'), /value="0\.9, 0\.9, 1"/);
  assert.match(inputLine(constant.xml, 'SR_sg', 'roughness'), /value="0\.25"/);
  assert.ok(constant.notes.some(note => note.startsWith('KHR_materials_pbrSpecularGlossiness is legacy')));

  const textured = gltfPbrDocument({
    name: 'sgt',
    material: {
      extensions: {
        KHR_materials_pbrSpecularGlossiness: {
          diffuseTexture: { index: 0 }, glossinessFactor: 1,
          specularGlossinessTexture: { index: 1 }, specularFactor: [1, 1, 1],
        },
      },
    },
    textureRefs: allRefs,
  });
  assert.match(nodeLine(textured.xml, 'base_color_image'), /<gltf_colorimage/);
  assert.match(inputLine(textured.xml, 'SR_sgt', 'specular_color'), /nodename="specular_glossiness_image" output="outcolor"/);
  assert.match(inputLine(textured.xml, 'glossiness_to_roughness', 'in1'), /value="1"/);
  assert.match(inputLine(textured.xml, 'glossiness_to_roughness', 'in2'), /nodename="specular_glossiness_image" output="outa"/);
  assert.match(inputLine(textured.xml, 'SR_sgt', 'roughness'), /nodename="glossiness_to_roughness"/);
});

test('gltf: KHR_materials_unlit becomes surface_unlit', () => {
  const blend = gltfPbrDocument({
    name: 'u',
    material: {
      alphaMode: 'BLEND',
      pbrMetallicRoughness: { baseColorFactor: [1, 0.2, 0.2, 0.5] },
      extensions: { KHR_materials_unlit: {} },
    },
    textureRefs: () => null,
  });
  assert.match(nodeLine(blend.xml, 'SR_u'), /<surface_unlit name="SR_u" type="surfaceshader">/);
  assert.match(inputLine(blend.xml, 'SR_u', 'emission'), /value="1"/);
  assert.match(inputLine(blend.xml, 'SR_u', 'emission_color'), /value="1, 0\.2, 0\.2"/);
  assert.match(inputLine(blend.xml, 'SR_u', 'opacity'), /value="0\.5"/);
  assert.ok(blend.notes.some(note => note.startsWith('KHR_materials_unlit')));

  const masked = gltfPbrDocument({
    name: 'um',
    material: {
      alphaMode: 'MASK', alphaCutoff: 0.4,
      pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
      extensions: { KHR_materials_unlit: {} },
    },
    textureRefs: allRefs,
  });
  assert.match(inputLine(masked.xml, 'alpha_cutoff_mask', 'value1'), /nodename="base_color_image" output="outa"/);
  assert.match(inputLine(masked.xml, 'alpha_cutoff_mask', 'value2'), /value="0\.4"/);
  assert.match(inputLine(masked.xml, 'SR_um', 'opacity'), /nodename="alpha_cutoff_mask"/);

  const opaque = gltfPbrDocument({
    name: 'uo',
    material: { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.2] }, extensions: { KHR_materials_unlit: {} } },
    textureRefs: () => null,
  });
  assert.equal(inputLine(opaque.xml, 'SR_uo', 'opacity'), null);
});

test('gltf: iridescence thickness texture uses gltf_iridescence_thickness', () => {
  const { xml } = gltfPbrDocument({
    name: 'ir',
    material: {
      extensions: {
        KHR_materials_iridescence: {
          iridescenceFactor: 1,
          iridescenceThicknessMinimum: 120,
          iridescenceThicknessMaximum: 600,
          iridescenceThicknessTexture: { index: 7 },
        },
      },
    },
    textureRefs: allRefs,
  });
  assert.match(nodeLine(xml, 'iridescence_thickness_image'), /<gltf_iridescence_thickness/);
  assert.match(inputLine(xml, 'iridescence_thickness_image', 'thicknessMin'), /value="120"/);
  assert.match(inputLine(xml, 'iridescence_thickness_image', 'thicknessMax'), /value="600"/);
  assert.match(inputLine(xml, 'SR_ir', 'iridescence_thickness'), /nodename="iridescence_thickness_image"/);
});

test('gltf: KHR_texture_transform and the second UV set', () => {
  const { xml } = gltfPbrDocument({
    name: 'xf',
    material: {
      pbrMetallicRoughness: {
        baseColorTexture: {
          index: 0,
          texCoord: 1,
          extensions: { KHR_texture_transform: { offset: [0.25, 0.5], rotation: Math.PI / 2, scale: [2, 4] } },
        },
      },
    },
    textureRefs: info => ({ file: 'base.png', texCoord: info.texCoord }),
  });
  assert.match(inputLine(xml, 'base_color_image', 'scale'), /value="2, 4"/);
  assert.match(inputLine(xml, 'base_color_image', 'rotate'), /value="90"/);
  assert.match(inputLine(xml, 'base_color_image', 'offset'), /value="0\.25, 0\.5"/);
  assert.match(inputLine(xml, 'base_color_image', 'texcoord'), /nodename="uv1"/);
  assert.match(inputLine(xml, 'uv1', 'geomprop'), /value="UV1"/);
});

test('gltf: a missing texture falls back to the factor and records a note', () => {
  const { xml, notes } = gltfPbrDocument({
    name: 'miss',
    material: { alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [0.2, 0.3, 0.4, 0.5], baseColorTexture: { index: 0 } } },
    textureRefs: () => null,
  });
  assert.ok(!xml.includes('name="file"'));
  assert.match(inputLine(xml, 'SR_miss', 'base_color'), /value="0\.2, 0\.3, 0\.4"/);
  assert.match(inputLine(xml, 'SR_miss', 'alpha'), /value="0\.5"/);
  assert.deepEqual(notes, ['Texture for base color could not be resolved, the constant factor is used instead']);
});

test('mtl: parses options, numbers and paths', () => {
  const text = [
    '# comment',
    'newmtl Body',
    'Kd 0.8 0.2 0.1',
    'Ks 1 1 1',
    'Ns 120',
    'Ni 1.45',
    'd 0.5',
    'illum 4',
    'map_Kd -s 2 2 1 -o 0 0 0 -clamp on textures\\wood diffuse.png',
    'map_Bump -bm 0.75 bump.png',
    'newmtl 2nd Material',
    'Pr 0.3',
    'Pm 1',
  ].join('\n');
  const materials = parseMtl(text);
  assert.deepEqual([...materials.keys()], ['Body', '2nd Material']);
  const body = materials.get('Body');
  assert.deepEqual(body.Kd, [0.8, 0.2, 0.1]);
  assert.equal(body.Ns, 120);
  assert.equal(body.Ni, 1.45);
  assert.equal(body.d, 0.5);
  assert.equal(body.illum, 4);
  assert.equal(body.map_Kd.path, 'textures/wood diffuse.png');
  assert.deepEqual(body.map_Kd.options.s, [2, 2, 1]);
  assert.equal(body.map_Kd.options.clamp, 'on');
  assert.equal(body.map_Bump.options.bm, '0.75');
  assert.equal(materials.get('2nd Material').Pr, 0.3);
});

test('mtl: converts to open_pbr_surface', () => {
  const materials = parseMtl([
    'newmtl Wood',
    'Kd 1 1 1',
    'Ks 0.5 0.5 0.5',
    'Ke 1 0.5 0',
    'Ns 2',
    'Ni 1.6',
    'd 0.25',
    'illum 6',
    'map_Kd -clamp on wood.png',
    'map_Bump -bm 0.5 height.png',
  ].join('\n'));
  const { xml, materialName, notes } = objMtlDocument({
    name: 'Wood',
    mtl: materials.get('Wood'),
    textureRefs: record => record.path,
  });
  assert.equal(materialName, 'M_Wood');
  assert.match(xml, /<open_pbr_surface name="SR_Wood" type="surfaceshader">/);
  assert.match(inputLine(xml, 'base_color_image', 'file'), /value="wood\.png" colorspace="srgb_texture"/);
  assert.match(inputLine(xml, 'base_color_image', 'uaddressmode'), /value="clamp"/);
  assert.match(inputLine(xml, 'SR_Wood', 'base_color'), /nodename="base_color_image"/);
  // Ns 2 -> sqrt(2 / 4) = 0.707107
  assert.match(inputLine(xml, 'SR_Wood', 'specular_roughness'), /value="0\.707107"/);
  assert.match(inputLine(xml, 'SR_Wood', 'specular_color'), /value="0\.5, 0\.5, 0\.5"/);
  assert.match(inputLine(xml, 'SR_Wood', 'specular_ior'), /value="1\.6"/);
  assert.match(inputLine(xml, 'SR_Wood', 'geometry_opacity'), /value="0\.25"/);
  assert.match(inputLine(xml, 'SR_Wood', 'emission_color'), /value="1, 0\.5, 0"/);
  assert.match(inputLine(xml, 'SR_Wood', 'emission_luminance'), /value="1"/);
  assert.match(inputLine(xml, 'SR_Wood', 'transmission_weight'), /value="0\.75"/);
  assert.match(inputLine(xml, 'bump_to_normal', 'scale'), /value="0\.5"/);
  assert.match(inputLine(xml, 'bump_normal_map', 'in'), /nodename="bump_to_normal"/);
  assert.match(inputLine(xml, 'SR_Wood', 'geometry_normal'), /nodename="bump_normal_map"/);
  assert.deepEqual(notes, []);
});

test('mtl: Pr overrides Ns, norm map wins over bump, missing texture is noted', () => {
  const materials = parseMtl([
    'newmtl M',
    'Ns 400',
    'Pr 0.2',
    'Pm 0.9',
    'norm normal.png',
    'map_Bump bump.png',
    'map_Kd missing.png',
  ].join('\n'));
  const { xml, notes } = objMtlDocument({
    name: 'M',
    mtl: materials.get('M'),
    textureRefs: record => (record.path === 'missing.png' ? null : record.path),
  });
  assert.match(inputLine(xml, 'SR_M', 'specular_roughness'), /value="0\.2"/);
  assert.match(inputLine(xml, 'SR_M', 'base_metalness'), /value="0\.9"/);
  assert.match(inputLine(xml, 'SR_M', 'geometry_normal'), /nodename="normal_map"/);
  assert.ok(!xml.includes('bump_image'));
  assert.deepEqual(notes, ['Texture for base color could not be resolved, the constant value is used instead']);
});

test('usd: flattened payload becomes UsdPreviewSurface', () => {
  const { xml, materialName, notes } = usdPreviewSurfaceDocument({
    name: '3M Plastic',
    record: {
      diffuseColor: [0.4, 0.4, 0.4],
      emissiveColor: [0, 0, 0],
      roughness: 0.3,
      metallic: 1,
      opacity: 0.5,
      ior: 1.52,
      clearcoat: 0.25,
      clearcoatRoughness: 0.05,
      diffuseTexture: { path: 'tex/albedo.png', mimeType: 'image/png' },
      roughnessTexture: { path: 'tex/rough.png' },
      normalTexture: { path: 'tex/normal.png' },
    },
    textureRefs: record => record.path,
  });
  assert.equal(materialName, 'M_3M_Plastic');
  assert.match(xml, /<UsdPreviewSurface name="SR_3M_Plastic" type="surfaceshader">/);
  assert.match(inputLine(xml, 'diffuse_image', 'file'), /value="tex\/albedo\.png" colorspace="srgb_texture"/);
  assert.match(inputLine(xml, 'SR_3M_Plastic', 'diffuseColor'), /nodename="diffuse_image"/);
  assert.match(inputLine(xml, 'SR_3M_Plastic', 'roughness'), /nodename="roughness_image"/);
  assert.match(inputLine(xml, 'SR_3M_Plastic', 'metallic'), /value="1"/);
  assert.match(inputLine(xml, 'SR_3M_Plastic', 'opacity'), /value="0\.5"/);
  assert.match(inputLine(xml, 'SR_3M_Plastic', 'ior'), /value="1\.52"/);
  assert.match(inputLine(xml, 'SR_3M_Plastic', 'clearcoat'), /value="0\.25"/);
  assert.match(inputLine(xml, 'SR_3M_Plastic', 'normal'), /nodename="normal_image"/);
  assert.equal(inputLine(xml, 'roughness_image', 'colorspace'), null);
  assert.ok(notes.some(note => note.includes('flattened USD payload')));
});

test('name sanitization: invalid characters, leading digits, uniqueness', () => {
  assert.equal(sanitizeMtlxName('mesh/Material #1'), 'mesh_Material_1');
  assert.equal(sanitizeMtlxName('3dmat'), '_3dmat');
  assert.equal(sanitizeMtlxName(''), 'material');
  const used = new Set();
  assert.equal(sanitizeMtlxName('a', used), 'a');
  assert.equal(sanitizeMtlxName('a', used), 'a_2');
  assert.equal(sanitizeMtlxName('a', used), 'a_3');
  // A document with a name that collides with a helper node keeps both
  const { xml } = gltfPbrDocument({
    name: 'base color image',
    material: { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } },
    textureRefs: () => ({ file: 'a.png' }),
  });
  assert.match(xml, /name="SR_base_color_image"/);
  assert.match(xml, /name="M_base_color_image"/);
});

test('helpers: escaping and number formatting', () => {
  assert.equal(xmlEscape('a & b < c > "d" \'e\''), 'a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;');
  assert.equal(formatNumber(1), '1');
  assert.equal(formatNumber(0.1 + 0.2), '0.3');
  assert.equal(formatNumber(1e-9), '0');
  assert.equal(formatNumber(Number.NaN), '0');
  assert.equal(formatNumber(Infinity), '0');
  assert.equal(formatNumber(-0), '0');
  // file paths with an ampersand survive into the document
  const { xml } = objMtlDocument({
    name: 'esc',
    mtl: { map_Kd: { path: 'a&b.png', options: {} } },
    textureRefs: record => record.path,
  });
  assert.match(xml, /value="a&amp;b\.png"/);
});
