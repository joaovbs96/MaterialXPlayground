// smoke-fixtures.mjs: generates the SMALL fixture set the packaged-
// extension smoke suite needs (a few 256x256 PNGs, one small EXR, a
// handful of .mtlx documents). Always regenerated -- everything here is
// well under 5 MB total, so idempotency (unlike lib/fixtures.mjs's
// multi-GB payloads) isn't worth the complexity.
'use strict';

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { encodePNG } from './png.mjs';
import { writeHalfRgbaExr } from './exr.mjs';

function hashBuffer(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function writePngRecordHash(filePath, buf) {
    fs.writeFileSync(filePath, buf);
    return { size: buf.length, sha256: hashBuffer(buf) };
}

function genBaseColorPng() {
    return encodePNG({
        width: 256, height: 256, bitDepth: 8, colorType: 2,
        fillRow: (y, row) => {
            for (let x = 0; x < 256; x++) {
                const o = x * 3;
                row[o] = x & 0xFF; row[o + 1] = y & 0xFF; row[o + 2] = 0x80;
            }
        },
    });
}

function genRoughnessPng() {
    return encodePNG({
        width: 256, height: 256, bitDepth: 8, colorType: 0,
        fillRow: (y, row) => { for (let x = 0; x < 256; x++) row[x] = (x + y) & 0xFF; },
    });
}

function genSecretPng() {
    return encodePNG({
        width: 64, height: 64, bitDepth: 8, colorType: 2,
        fillRow: (y, row) => { for (let x = 0; x < 64; x++) { const o = x * 3; row[o] = 0xEE; row[o + 1] = x & 0xFF; row[o + 2] = y & 0xFF; } },
    });
}

// main.mtlx: one small material fed by the three small textures below --
// used for the editor end-to-end, viewer-rendered and save-bridge scenarios.
function mainMtlxDoc() {
    return '<?xml version="1.0"?>\n' +
        '<materialx version="1.39">\n' +
        '  <image name="img_basecolor" type="color3">\n' +
        '    <input name="file" type="filename" value="../textures/basecolor.png" />\n' +
        '  </image>\n' +
        '  <image name="img_roughness" type="float">\n' +
        '    <input name="file" type="filename" value="../textures/roughness.png" />\n' +
        '  </image>\n' +
        '  <image name="img_env" type="color3">\n' +
        '    <input name="file" type="filename" value="../textures/env.exr" />\n' +
        '  </image>\n' +
        '  <standard_surface name="SR_smoke" type="surfaceshader">\n' +
        '    <input name="base_color" type="color3" nodename="img_basecolor" />\n' +
        '    <input name="specular_roughness" type="float" nodename="img_roughness" />\n' +
        '    <input name="emission" type="float" value="0.0" />\n' +
        '    <input name="emission_color" type="color3" nodename="img_env" />\n' +
        '  </standard_surface>\n' +
        '  <surfacematerial name="M_smoke" type="material">\n' +
        '    <input name="surfaceshader" type="surfaceshader" nodename="SR_smoke" />\n' +
        '  </surfacematerial>\n' +
        '</materialx>\n';
}

// outside_ref.mtlx: a single ref resolving outside the workspace folder
// (ws/mat/ -> .. -> ws/ -> .. -> fixtures/ -> outside/secret.png).
function outsideRefMtlxDoc() {
    return '<?xml version="1.0"?>\n' +
        '<materialx version="1.39">\n' +
        '  <image name="img_outside" type="color3">\n' +
        '    <input name="file" type="filename" value="../../outside/secret.png" />\n' +
        '  </image>\n' +
        '</materialx>\n';
}

// validation_error.mtlx: well-formed XML (tier 1 clean) but a semantic
// type mismatch tier 1 cannot see -- base_color is declared color3 by
// standard_surface's nodedef, given type="float" here. Only the deeper
// MaterialX WASM validate() pass (tier 2) reports this.
function validationErrorMtlxDoc() {
    return '<?xml version="1.0"?>\n' +
        '<materialx version="1.39">\n' +
        '  <standard_surface name="SR_bad" type="surfaceshader">\n' +
        '    <input name="base_color" type="float" value="0.5" />\n' +
        '  </standard_surface>\n' +
        '  <surfacematerial name="M_bad" type="material">\n' +
        '    <input name="surfaceshader" type="surfaceshader" nodename="SR_bad" />\n' +
        '  </surfacematerial>\n' +
        '</materialx>\n';
}

// hover.mtlx: a bare <image> tag to hover over -- hover docs use plain
// text documents, never the custom editor. "image" (unlike e.g.
// standard_surface) has its own `### \`image\`` heading in
// MaterialX.StandardNodes.md, so specDocs.js actually resolves a
// description + spec anchor for it.
function hoverMtlxDoc() {
    return '<?xml version="1.0"?>\n' +
        '<materialx version="1.39">\n' +
        '  <image name="img_hover" type="color3" />\n' +
        '</materialx>\n';
}

function genCheckerPng() {
    return encodePNG({
        width: 64, height: 64, bitDepth: 8, colorType: 2,
        fillRow: (y, row) => {
            for (let x = 0; x < 64; x++) {
                const on = ((x >> 3) + (y >> 3)) & 1;
                const o = x * 3;
                row[o] = on ? 0xE0 : 0x20; row[o + 1] = on ? 0x90 : 0x30; row[o + 2] = on ? 0x30 : 0xC0;
            }
        },
    });
}

// USD scene fixture: usdscene/scene/root.usda only sublayers
// ../layers/geo.usda (a textured card bound to a UsdPreviewSurface), whose
// UsdUVTexture reads ../textures/checker.png. Neither sits in the root
// layer's folder, so the scene file set must follow the references.
// Multi-line on purpose: one-line USDA prims abort the USD wasm.
function usdRootLayer(sublayer) {
    return [
        '#usda 1.0',
        '(',
        '    defaultPrim = "World"',
        '    metersPerUnit = 1',
        '    subLayers = [',
        '        @' + (sublayer || '../layers/geo.usda') + '@',
        '    ]',
        '    upAxis = "Y"',
        ')',
        '',
    ].join('\n');
}

function usdGeoLayer() {
    return [
        '#usda 1.0',
        '(',
        '    defaultPrim = "World"',
        '    metersPerUnit = 1',
        '    upAxis = "Y"',
        ')',
        '',
        'def Xform "World"',
        '{',
        '    def Mesh "Card" (',
        '        prepend apiSchemas = ["MaterialBindingAPI"]',
        '    )',
        '    {',
        '        float3[] extent = [(-1, -1, 0), (1, 1, 0)]',
        '        int[] faceVertexCounts = [4]',
        '        int[] faceVertexIndices = [0, 1, 2, 3]',
        '        normal3f[] normals = [(0, 0, 1), (0, 0, 1), (0, 0, 1), (0, 0, 1)] (',
        '            interpolation = "vertex"',
        '        )',
        '        point3f[] points = [(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)]',
        '        texCoord2f[] primvars:st = [(0, 0), (1, 0), (1, 1), (0, 1)] (',
        '            interpolation = "vertex"',
        '        )',
        '        uniform token subdivisionScheme = "none"',
        '        rel material:binding = </World/Looks/CheckerMat>',
        '    }',
        '',
        '    def Scope "Looks"',
        '    {',
        '        def Material "CheckerMat"',
        '        {',
        '            token outputs:surface.connect = </World/Looks/CheckerMat/PreviewSurface.outputs:surface>',
        '',
        '            def Shader "PreviewSurface"',
        '            {',
        '                uniform token info:id = "UsdPreviewSurface"',
        '                color3f inputs:diffuseColor.connect = </World/Looks/CheckerMat/Checker.outputs:rgb>',
        '                float inputs:metallic = 0',
        '                float inputs:roughness = 0.5',
        '                token outputs:surface',
        '            }',
        '',
        '            def Shader "Checker"',
        '            {',
        '                uniform token info:id = "UsdUVTexture"',
        '                asset inputs:file = @../textures/checker.png@',
        '                float2 inputs:st.connect = </World/Looks/CheckerMat/StReader.outputs:result>',
        '                float3 outputs:rgb',
        '            }',
        '',
        '            def Shader "StReader"',
        '            {',
        '                uniform token info:id = "UsdPrimvarReader_float2"',
        '                string inputs:varname = "st"',
        '                float2 outputs:result',
        '            }',
        '        }',
        '    }',
        '}',
        '',
    ].join('\n');
}

// Second stage (usdmtlx/) for the material preview scenario: one card bound
// to a MaterialX material referenced from ../materials/card.mtlx, so a double
// click has a MaterialX document (a UsdPreviewSurface card has none).
function usdMtlxLayer() {
    return [
        '#usda 1.0',
        '(',
        '    defaultPrim = "World"',
        '    metersPerUnit = 1',
        '    upAxis = "Y"',
        ')',
        '',
        'def Xform "World"',
        '{',
        '    def Scope "Looks"',
        '    {',
        '        def Material "CardMat" (',
        '            references = @../materials/card.mtlx@</MaterialX/Materials/card_material>',
        '        )',
        '        {',
        '        }',
        '    }',
        '',
        '    def Mesh "Card" (',
        '        prepend apiSchemas = ["MaterialBindingAPI"]',
        '    )',
        '    {',
        '        float3[] extent = [(-1, -1, 0), (1, 1, 0)]',
        '        int[] faceVertexCounts = [4]',
        '        int[] faceVertexIndices = [0, 1, 2, 3]',
        '        normal3f[] normals = [(0, 0, 1), (0, 0, 1), (0, 0, 1), (0, 0, 1)] (',
        '            interpolation = "vertex"',
        '        )',
        '        point3f[] points = [(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)]',
        '        uniform token subdivisionScheme = "none"',
        '        rel material:binding = </World/Looks/CardMat>',
        '    }',
        '}',
        '',
    ].join('\n');
}

// autoOpenSceneViewer TEXT-half fixture: a small, self-contained .usda
// (no sublayers/references) -- the sceneAutoOpen scenario only needs VS
// Code to open it as a real text editor, not a working stage.
function autoOpenUsdaDoc() {
    return [
        '#usda 1.0',
        '(',
        '    defaultPrim = "World"',
        '    upAxis = "Y"',
        ')',
        '',
        'def Xform "World"',
        '{',
        '}',
        '',
    ].join('\n');
}

// autoOpenSceneViewer BINARY-half fixture: content VS Code's own binary
// sniffing (a NUL byte within the first chunk) will flag as "not
// displayed in the text editor" -- the sceneAutoOpen scenario only checks
// that this placeholder tab gets replaced by the scene viewer, not that
// the (fake) stage actually renders, so real USD/zip bytes aren't needed.
function genUsdzPlaceholder() {
    const buf = Buffer.alloc(2048);
    for (let i = 0; i < buf.length; i++) buf[i] = i % 7 === 0 ? 0 : (i * 31) & 0xFF;
    return buf;
}

function usdCardMtlx() {
    return [
        '<?xml version="1.0"?>',
        '<materialx version="1.39" colorspace="lin_rec709">',
        '  <constant name="card_color" type="color3">',
        '    <input name="value" type="color3" value="0.8, 0.3, 0.1" />',
        '  </constant>',
        '  <standard_surface name="card_surface" type="surfaceshader">',
        '    <input name="base_color" type="color3" nodename="card_color" />',
        '  </standard_surface>',
        '  <surfacematerial name="card_material" type="material">',
        '    <input name="surfaceshader" type="surfaceshader" nodename="card_surface" />',
        '  </surfacematerial>',
        '</materialx>',
        '',
    ].join('\n');
}

function genBaseColorTexPng() {
    return encodePNG({
        width: 32, height: 32, bitDepth: 8, colorType: 2,
        fillRow: (y, row) => { for (let x = 0; x < 32; x++) { const o = x * 3; row[o] = 0xC0; row[o + 1] = 0x40; row[o + 2] = 0x20; } },
    });
}

function u32le(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n, 0);
    return b;
}

// One textured quad (4 verts, 2 triangles), shared by the glTF/GLB
// fixtures below: positions/normals/uvs/indices as a single packed
// buffer plus the accessors/material JSON that reference it, with the
// caller filling in `buffers`/`images` (external uri vs GLB-embedded).
function quadGeometryBuffer() {
    const positions = [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];
    const normals = [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1];
    const uvs = [0, 1, 1, 1, 1, 0, 0, 0];
    const indices = [0, 1, 2, 0, 2, 3];

    const posBuf = Buffer.alloc(positions.length * 4);
    positions.forEach((v, i) => posBuf.writeFloatLE(v, i * 4));
    const normBuf = Buffer.alloc(normals.length * 4);
    normals.forEach((v, i) => normBuf.writeFloatLE(v, i * 4));
    const uvBuf = Buffer.alloc(uvs.length * 4);
    uvs.forEach((v, i) => uvBuf.writeFloatLE(v, i * 4));
    const idxBuf = Buffer.alloc(indices.length * 2);
    indices.forEach((v, i) => idxBuf.writeUInt16LE(v, i * 2));

    const posMin = [0, 1, 2].map((axis) => Math.min(...positions.filter((_, i) => i % 3 === axis)));
    const posMax = [0, 1, 2].map((axis) => Math.max(...positions.filter((_, i) => i % 3 === axis)));

    const buffer = Buffer.concat([posBuf, normBuf, uvBuf, idxBuf]);
    if (buffer.length % 4 !== 0) throw new Error('quadGeometryBuffer: not 4-byte aligned');

    const accessors = [
        { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: posMin, max: posMax },
        { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
        { bufferView: 2, componentType: 5126, count: uvs.length / 2, type: 'VEC2' },
        { bufferView: 3, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ];
    const bufferViews = [
        { buffer: 0, byteOffset: 0, byteLength: posBuf.length, target: 34962 },
        { buffer: 0, byteOffset: posBuf.length, byteLength: normBuf.length, target: 34962 },
        { buffer: 0, byteOffset: posBuf.length + normBuf.length, byteLength: uvBuf.length, target: 34962 },
        { buffer: 0, byteOffset: posBuf.length + normBuf.length + uvBuf.length, byteLength: idxBuf.length, target: 34963 },
    ];
    return { buffer, accessors, bufferViews };
}

function quadGltfJson(geo, buffers, images) {
    return {
        asset: { version: '2.0', generator: 'mxpt smoke-fixtures.mjs' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, name: 'Quad' }],
        meshes: [{ name: 'Quad', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
        materials: [{
            name: 'TexturedQuad',
            pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.7 },
        }],
        textures: [{ source: 0 }],
        images,
        accessors: geo.accessors,
        bufferViews: geo.bufferViews,
        buffers,
    };
}

// quad.gltf + quad.bin (external buffer) + textures/base.png (external
// image): the plain-text half of the scene-format smoke scenarios.
function genGltfFixture() {
    const geo = quadGeometryBuffer();
    const json = quadGltfJson(geo, [{ byteLength: geo.buffer.length, uri: 'quad.bin' }], [{ uri: 'textures/base.png' }]);
    return { json: JSON.stringify(json, null, 2), bin: geo.buffer };
}

// quad.glb: same quad, geometry buffer embedded in the GLB's own BIN
// chunk (no external .bin needed), texture kept external so the "texture
// file was part of the sent file set" assertion still has something to
// check for the GLB scenario too.
function genGlbFixture() {
    const geo = quadGeometryBuffer();
    const json = quadGltfJson(geo, [{ byteLength: geo.buffer.length }], [{ uri: 'textures/base.png' }]);
    let jsonText = JSON.stringify(json);
    while (jsonText.length % 4 !== 0) jsonText += ' ';
    const jsonBuf = Buffer.from(jsonText, 'utf8');
    const jsonChunk = Buffer.concat([u32le(jsonBuf.length), Buffer.from('JSON', 'ascii'), jsonBuf]);
    const binPad = (4 - (geo.buffer.length % 4)) % 4;
    const binPadded = Buffer.concat([geo.buffer, Buffer.alloc(binPad, 0)]);
    const binChunk = Buffer.concat([u32le(binPadded.length), Buffer.from('BIN\0', 'ascii'), binPadded]);
    const totalLength = 12 + jsonChunk.length + binChunk.length;
    const header = Buffer.concat([Buffer.from('glTF', 'ascii'), u32le(2), u32le(totalLength)]);
    return Buffer.concat([header, jsonChunk, binChunk]);
}

// quad.obj + quad.mtl (mtllib) + textures/base.png (map_Kd in a subfolder):
// the OBJ half of the scene-format smoke scenarios.
function genObjFixture() {
    const obj = [
        'mtllib quad.mtl',
        'v -0.5 -0.5 0',
        'v 0.5 -0.5 0',
        'v 0.5 0.5 0',
        'v -0.5 0.5 0',
        'vt 0 0',
        'vt 1 0',
        'vt 1 1',
        'vt 0 1',
        'vn 0 0 1',
        'usemtl TexturedQuad',
        'f 1/1/1 2/2/1 3/3/1',
        'f 1/1/1 3/3/1 4/4/1',
        '',
    ].join('\n');
    const mtl = [
        'newmtl TexturedQuad',
        'Kd 1.0 1.0 1.0',
        'map_Kd textures/base.png',
        '',
    ].join('\n');
    return { obj, mtl };
}

async function generateSmokeFixtures(fixturesDir) {
    const wsDir = path.join(fixturesDir, 'ws');
    const texDir = path.join(wsDir, 'textures');
    const matDir = path.join(wsDir, 'mat');
    const outsideDir = path.join(fixturesDir, 'outside');
    for (const d of [wsDir, texDir, matDir, outsideDir]) fs.mkdirSync(d, { recursive: true });

    const manifest = {};
    manifest['ws/textures/basecolor.png'] = writePngRecordHash(path.join(texDir, 'basecolor.png'), genBaseColorPng());
    manifest['ws/textures/roughness.png'] = writePngRecordHash(path.join(texDir, 'roughness.png'), genRoughnessPng());
    manifest['ws/textures/env.exr'] = await writeHalfRgbaExr(path.join(texDir, 'env.exr'), 64, 64);
    manifest['outside/secret.png'] = writePngRecordHash(path.join(outsideDir, 'secret.png'), genSecretPng());

    const mainMtlxPath = path.join(matDir, 'main.mtlx');
    const outsideMtlxPath = path.join(matDir, 'outside_ref.mtlx');
    const validationMtlxPath = path.join(matDir, 'validation_error.mtlx');
    const hoverMtlxPath = path.join(matDir, 'hover.mtlx');
    fs.writeFileSync(mainMtlxPath, mainMtlxDoc());
    fs.writeFileSync(outsideMtlxPath, outsideRefMtlxDoc());
    fs.writeFileSync(validationMtlxPath, validationErrorMtlxDoc());
    fs.writeFileSync(hoverMtlxPath, hoverMtlxDoc());
    const usdDir = path.join(wsDir, 'usdscene');
    for (const sub of ['scene', 'layers', 'textures']) fs.mkdirSync(path.join(usdDir, sub), { recursive: true });
    const usdRootPath = path.join(usdDir, 'scene', 'root.usda');
    fs.writeFileSync(usdRootPath, usdRootLayer());
    fs.writeFileSync(path.join(usdDir, 'layers', 'geo.usda'), usdGeoLayer());
    manifest['ws/usdscene/textures/checker.png'] = writePngRecordHash(path.join(usdDir, 'textures', 'checker.png'), genCheckerPng());
    const usdMtlxDir = path.join(wsDir, 'usdmtlx');
    for (const sub of ['scene', 'materials']) fs.mkdirSync(path.join(usdMtlxDir, sub), { recursive: true });
    const usdMtlxRootPath = path.join(usdMtlxDir, 'scene', 'mtlx_card.usda');
    fs.writeFileSync(usdMtlxRootPath, usdMtlxLayer());
    fs.writeFileSync(path.join(usdMtlxDir, 'materials', 'card.mtlx'), usdCardMtlx());

    const autoOpenDir = path.join(wsDir, 'usdautoopen');
    fs.mkdirSync(autoOpenDir, { recursive: true });
    const autoOpenUsdaPath = path.join(autoOpenDir, 'scene.usda');
    const autoOpenUsdzPath = path.join(autoOpenDir, 'scene.usdz');
    fs.writeFileSync(autoOpenUsdaPath, autoOpenUsdaDoc());
    fs.writeFileSync(autoOpenUsdzPath, genUsdzPlaceholder());

    // glTF: quad.gltf (text) + quad.bin + textures/base.png, all sent.
    const gltfDir = path.join(wsDir, 'scenegltf');
    fs.mkdirSync(path.join(gltfDir, 'textures'), { recursive: true });
    const gltfFixture = genGltfFixture();
    const gltfRootPath = path.join(gltfDir, 'quad.gltf');
    fs.writeFileSync(gltfRootPath, gltfFixture.json);
    fs.writeFileSync(path.join(gltfDir, 'quad.bin'), gltfFixture.bin);
    manifest['ws/scenegltf/textures/base.png'] = writePngRecordHash(path.join(gltfDir, 'textures', 'base.png'), genBaseColorTexPng());

    // GLB: quad.glb (binary) + textures/base.png (external, referenced
    // from the GLB's own JSON chunk).
    const glbDir = path.join(wsDir, 'sceneglb');
    fs.mkdirSync(path.join(glbDir, 'textures'), { recursive: true });
    const glbRootPath = path.join(glbDir, 'quad.glb');
    fs.writeFileSync(glbRootPath, genGlbFixture());
    manifest['ws/sceneglb/textures/base.png'] = writePngRecordHash(path.join(glbDir, 'textures', 'base.png'), genBaseColorTexPng());

    // OBJ: quad.obj (text) + quad.mtl (mtllib) + textures/base.png
    // (map_Kd, in a subfolder).
    const objDir = path.join(wsDir, 'sceneobj');
    fs.mkdirSync(path.join(objDir, 'textures'), { recursive: true });
    const objFixture = genObjFixture();
    const objRootPath = path.join(objDir, 'quad.obj');
    fs.writeFileSync(objRootPath, objFixture.obj);
    fs.writeFileSync(path.join(objDir, 'quad.mtl'), objFixture.mtl);
    manifest['ws/sceneobj/textures/base.png'] = writePngRecordHash(path.join(objDir, 'textures', 'base.png'), genBaseColorTexPng());

    // sceneNoSiblings: a folder holding the actual scene (quad.glb +
    // textures/base.png) plus several unrelated .glb/.usda files that
    // nothing references. Opening quad.glb must send only quad.glb and its
    // referenced texture -- proof there is no folder walk (see
    // vscode_extension/src/usdFileSet.js).
    const noSiblingsDir = path.join(wsDir, 'scenenosiblings');
    fs.mkdirSync(path.join(noSiblingsDir, 'textures'), { recursive: true });
    const noSiblingsRootPath = path.join(noSiblingsDir, 'quad.glb');
    fs.writeFileSync(noSiblingsRootPath, genGlbFixture());
    manifest['ws/scenenosiblings/textures/base.png'] = writePngRecordHash(path.join(noSiblingsDir, 'textures', 'base.png'), genBaseColorTexPng());
    const noSiblingUnrelatedPaths = [
        path.join(noSiblingsDir, 'unrelated1.glb'),
        path.join(noSiblingsDir, 'unrelated2.glb'),
        path.join(noSiblingsDir, 'unrelated.usda'),
    ];
    for (const p of noSiblingUnrelatedPaths) {
        fs.writeFileSync(p, p.endsWith('.usda') ? usdRootLayer() : genGlbFixture());
    }

    // sceneMissingRoundTrip: root.usda sublayers layers/geo.usda, whose
    // UsdUVTexture reads ../textures/checker.png. The scenario turns the
    // static reference scan off, so both arrive through on-demand rounds.
    const missingDir = path.join(wsDir, 'scenemissing');
    for (const sub of ['layers', 'textures']) fs.mkdirSync(path.join(missingDir, sub), { recursive: true });
    const missingRootPath = path.join(missingDir, 'root.usda');
    fs.writeFileSync(missingRootPath, usdRootLayer('layers/geo.usda'));
    fs.writeFileSync(path.join(missingDir, 'layers', 'geo.usda'), usdGeoLayer());
    manifest['ws/scenemissing/textures/checker.png'] = writePngRecordHash(path.join(missingDir, 'textures', 'checker.png'), genCheckerPng());

    // textureSwap: one unlit material on ws/texswap/tex.png; the scenario
    // copies blue.png over it (same size as red.png) and expects the viewer to follow.
    const swapDir = path.join(wsDir, 'texswap');
    const swapSrcDir = path.join(fixturesDir, 'texswap-src');
    for (const d of [swapDir, swapSrcDir]) fs.mkdirSync(d, { recursive: true });
    const solidPng = (r, g, b) => encodePNG({
        width: 16, height: 16, bitDepth: 8, colorType: 2,
        fillRow: (y, row) => { for (let x = 0; x < 16; x++) { row[x * 3] = r; row[x * 3 + 1] = g; row[x * 3 + 2] = b; } },
    });
    const swapRedPath = path.join(swapSrcDir, 'red.png');
    const swapBluePath = path.join(swapSrcDir, 'blue.png');
    fs.writeFileSync(swapRedPath, solidPng(230, 20, 20));
    fs.writeFileSync(swapBluePath, solidPng(20, 20, 230));
    const swapTexPath = path.join(swapDir, 'tex.png');
    fs.copyFileSync(swapRedPath, swapTexPath);
    const swapMtlxPath = path.join(swapDir, 'swap.mtlx');
    fs.writeFileSync(swapMtlxPath, [
        '<?xml version="1.0"?>',
        '<materialx version="1.39">',
        '  <image name="img" type="color3">',
        '    <input name="file" type="filename" value="tex.png" />',
        '  </image>',
        '  <surface_unlit name="unlit" type="surfaceshader">',
        '    <input name="emission_color" type="color3" nodename="img" />',
        '  </surface_unlit>',
        '  <surfacematerial name="M_swap" type="material">',
        '    <input name="surfaceshader" type="surfaceshader" nodename="unlit" />',
        '  </surfacematerial>',
        '</materialx>',
        '',
    ].join('\n'));

    fs.writeFileSync(path.join(fixturesDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    return {
        fixturesDir, wsDir, texDir, matDir, outsideDir, manifest,
        mainMtlxPath, outsideMtlxPath, validationMtlxPath, hoverMtlxPath, usdRootPath, usdMtlxRootPath,
        autoOpenUsdaPath, autoOpenUsdzPath,
        gltfRootPath, glbRootPath, objRootPath,
        noSiblingsRootPath, noSiblingUnrelatedPaths,
        missingRootPath,
        swapMtlxPath, swapTexPath, swapRedPath, swapBluePath,
    };
}

export { generateSmokeFixtures };
