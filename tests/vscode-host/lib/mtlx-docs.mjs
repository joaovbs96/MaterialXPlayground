// mtlx-docs.mjs: builds the .mtlx document text used by the stress-test
// fixture workspace. Kept separate from fixtures.mjs so the XML shape is
// easy to eyeball without wading through binary-encoder code.
'use strict';

// big.mtlx: one material whose inputs are fed by every "big" texture
// (4K base color/roughness/normal, 8K displacement, 8K EXR), so opening it
// exercises the full direct-texture-read transport end to end (S3-S6).
function bigMtlxDoc() {
    return '<?xml version="1.0"?>\n' +
        '<materialx version="1.39">\n' +
        '  <image name="img_basecolor" type="color3">\n' +
        '    <input name="file" type="filename" value="../textures/basecolor_4k.png" />\n' +
        '  </image>\n' +
        '  <image name="img_roughness" type="float">\n' +
        '    <input name="file" type="filename" value="../textures/roughness_4k.png" />\n' +
        '  </image>\n' +
        '  <image name="img_normal" type="vector3">\n' +
        '    <input name="file" type="filename" value="../textures/normal_4k.png" />\n' +
        '  </image>\n' +
        '  <normalmap name="nm_normal" type="vector3">\n' +
        '    <input name="in" type="vector3" nodename="img_normal" />\n' +
        '  </normalmap>\n' +
        '  <image name="img_displacement" type="float">\n' +
        '    <input name="file" type="filename" value="../textures/displacement_8k.png" />\n' +
        '  </image>\n' +
        '  <displacement name="disp_stress" type="displacementshader">\n' +
        '    <input name="displacement" type="float" nodename="img_displacement" />\n' +
        '  </displacement>\n' +
        '  <image name="img_env" type="color3">\n' +
        '    <input name="file" type="filename" value="../textures/env_8k.exr" />\n' +
        '  </image>\n' +
        '  <standard_surface name="SR_stress" type="surfaceshader">\n' +
        '    <input name="base_color" type="color3" nodename="img_basecolor" />\n' +
        '    <input name="specular_roughness" type="float" nodename="img_roughness" />\n' +
        '    <input name="normal" type="vector3" nodename="nm_normal" />\n' +
        '    <input name="emission" type="float" value="0.0" />\n' +
        '    <input name="emission_color" type="color3" nodename="img_env" />\n' +
        '  </standard_surface>\n' +
        '  <surfacematerial name="M_stress" type="material">\n' +
        '    <input name="surfaceshader" type="surfaceshader" nodename="SR_stress" />\n' +
        '    <input name="displacementshader" type="displacementshader" nodename="disp_stress" />\n' +
        '  </surfacematerial>\n' +
        '</materialx>\n';
}

// many.mtlx: 200 standalone image nodes, one per small PNG, keyed flatly
// by their authored value exactly like docScanner.js's texture map.
function manyMtlxDoc(count) {
    const lines = ['<?xml version="1.0"?>', '<materialx version="1.39">'];
    for (let i = 0; i < count; i++) {
        const n = String(i).padStart(3, '0');
        lines.push('  <image name="img_small_' + n + '" type="color3">');
        lines.push('    <input name="file" type="filename" value="../textures/small/small_' + n + '.png" />');
        lines.push('  </image>');
    }
    lines.push('</materialx>', '');
    return lines.join('\n');
}

// s7_outside.mtlx: a single ref that resolves outside the workspace folder
// (ws/mat/ -> .. -> ws/ -> .. -> fixtures/ -> outside/secret.png), used by
// the containment scenario (S7).
function outsideRefMtlxDoc() {
    return '<?xml version="1.0"?>\n' +
        '<materialx version="1.39">\n' +
        '  <image name="img_outside" type="color3">\n' +
        '    <input name="file" type="filename" value="../../outside/secret.png" />\n' +
        '  </image>\n' +
        '</materialx>\n';
}

export { bigMtlxDoc, manyMtlxDoc, outsideRefMtlxDoc };
