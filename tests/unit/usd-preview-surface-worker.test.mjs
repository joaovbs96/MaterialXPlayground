import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// The worker is a module with no exports, so run its source in a vm the way
// the other usd-stage-worker tests do and pick the builder out of it.
function loadBuilder() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const workerPath = path.join(root, 'js', 'usd', 'usd-stage-worker.js');
  const sharedPath = path.join(root, 'js', 'shared', 'mesh-subdivision.js');
  const source = fs.readFileSync(sharedPath, 'utf8') + '\n'
    + fs.readFileSync(workerPath, 'utf8')
      .replace('import "../shared/mesh-subdivision.js";', '')
      .replace('const RUNTIME_DIR = new URL("../../vendor/usd-webview-bindings/", import.meta.url);', 'const RUNTIME_DIR = null;')
    + '\nthis.__helpers = { buildUsdShadeMaterialX };';
  const context = {
    ArrayBuffer, Blob, Float32Array, Float64Array, Int32Array, Map, Math,
    Number, Set, TextDecoder, TextEncoder, Uint8Array, Uint32Array, URL,
    console,
    fetch: async () => { throw new Error('fetch is unavailable in this unit test'); },
    postMessage() {},
    self: {},
  };
  vm.runInNewContext(source, context, { filename: workerPath });
  return context.__helpers.buildUsdShadeMaterialX;
}

const buildUsdShadeMaterialX = loadBuilder();
const build = (text, options) =>
  buildUsdShadeMaterialX({}, {}, '/Root/Mat', [{ path: 'assets/scene.usda', text }], options);

const PREVIEW_USDA = `#usda 1.0
def Material "Mat"
{
    token outputs:surface.connect = </Root/Mat/Preview.outputs:surface>

    def Shader "Preview"
    {
        uniform token info:id = "UsdPreviewSurface"
        color3f inputs:diffuseColor.connect = </Root/Mat/Diffuse.outputs:rgb>
        float inputs:opacity.connect = </Root/Mat/Diffuse.outputs:a>
        normal3f inputs:normal.connect = </Root/Mat/Normal.outputs:rgb>
        float inputs:roughness = 0.4
        token outputs:surface
    }

    def Shader "Diffuse"
    {
        uniform token info:id = "UsdUVTexture"
        asset inputs:file = @textures/base.png@ (
            colorSpace = "sRGB"
        )
        float2 inputs:st.connect = </Root/Mat/Uv.outputs:result>
        token inputs:wrapS = "repeat"
        token inputs:wrapT = "useMetadata"
        float4 inputs:scale = (1, 1, 1, 1)
        float3 outputs:rgb
        float outputs:a
    }

    def Shader "Normal"
    {
        uniform token info:id = "UsdUVTexture"
        asset inputs:file = @textures/normal.png@
        float3 outputs:rgb
    }

    def Shader "Uv"
    {
        uniform token info:id = "UsdPrimvarReader_float2"
        token inputs:varname = "st"
        float2 outputs:result
    }
}
`;

test('usd preview: outputs:surface builds a UsdPreviewSurface document', () => {
  const built = build(PREVIEW_USDA, { allowPreviewSurface: true });
  assert.ok(built, 'expected a document');
  assert.equal(built.materialName, 'M_Mat_usdshade');
  const xml = built.xml;
  assert.match(xml, /<UsdPreviewSurface name="Preview" type="surfaceshader">/);
  assert.match(xml, /<UsdUVTexture name="Diffuse" type="multioutput">/);
  // Multi-output nodes always carry an explicit output attribute.
  assert.match(xml, /name="diffuseColor" type="color3" nodename="Diffuse" output="rgb"/);
  assert.match(xml, /name="opacity" type="float" nodename="Diffuse" output="a"/);
  // The asset path is anchored to the layer that authored it.
  assert.match(xml, /name="file" type="filename" value="assets\/textures\/base\.png" colorspace="srgb_texture"/);
  assert.match(xml, /<surfacematerial name="M_Mat_usdshade" type="material">/);
});

test('usd preview: wrap tokens map onto the MaterialX enum', () => {
  const xml = build(PREVIEW_USDA, { allowPreviewSurface: true }).xml;
  assert.match(xml, /name="wrapS" type="string" value="periodic"/);
  // useMetadata has no MaterialX equivalent and falls back to the default.
  assert.doesNotMatch(xml, /name="wrapT"/);
  assert.match(xml, /name="scale" type="color4" value="1, 1, 1, 1"/);
});

test('usd preview: a float2 primvar reader becomes texcoord', () => {
  const xml = build(PREVIEW_USDA, { allowPreviewSurface: true }).xml;
  assert.match(xml, /<texcoord name="Uv" type="vector2">/);
  assert.doesNotMatch(xml, /UsdPrimvarReader/);
  assert.match(xml, /name="st" type="vector2" nodename="Uv"\/>/);
});

test('usd preview: a color3 output feeding a vector3 input gets a convert', () => {
  const xml = build(PREVIEW_USDA, { allowPreviewSurface: true }).xml;
  assert.match(xml, /<convert name="Preview_normal_convert" type="vector3">/);
  assert.match(xml, /<input name="in" type="color3" nodename="Normal" output="rgb"\/>/);
  assert.match(xml, /name="normal" type="vector3" nodename="Preview_normal_convert"\/>/);
});

test('usd preview: outputs:surface is ignored without the flattened shader id', () => {
  assert.equal(build(PREVIEW_USDA, {}), null);
  assert.equal(build(PREVIEW_USDA), null);
});

test('usd preview: an authored MaterialX terminal wins over the preview network', () => {
  const usda = `#usda 1.0
def Material "Mat"
{
    token outputs:mtlx:surface.connect = </Root/Mat/SR.outputs:out>
    token outputs:surface.connect = </Root/Mat/Preview.outputs:surface>

    def Shader "SR"
    {
        uniform token info:id = "ND_standard_surface_surfaceshader"
        color3f inputs:base_color = (1, 0, 0)
        token outputs:out
    }

    def Shader "Preview"
    {
        uniform token info:id = "UsdPreviewSurface"
        token outputs:surface
    }
}
`;
  const xml = build(usda, { allowPreviewSurface: true }).xml;
  assert.match(xml, /<input name="surfaceshader" type="surfaceshader" nodename="SR"\/>/);
});

test('usd preview: an unknown shader id keeps the flattened payload', () => {
  const usda = `#usda 1.0
def Material "Mat"
{
    token outputs:surface.connect = </Root/Mat/Preview.outputs:surface>

    def Shader "Preview"
    {
        uniform token info:id = "UsdPreviewSurface"
        color3f inputs:diffuseColor.connect = </Root/Mat/Weird.outputs:out>
        token outputs:surface
    }

    def Shader "Weird"
    {
        uniform token info:id = "StudioNoise"
        color3f outputs:out
    }
}
`;
  assert.equal(build(usda, { allowPreviewSurface: true }), null);
});

test('usd preview: an rgba read selects the 2.2 UsdUVTexture nodedef', () => {
  const usda = `#usda 1.0
def Material "Mat"
{
    token outputs:surface.connect = </Root/Mat/Preview.outputs:surface>

    def Shader "Preview"
    {
        uniform token info:id = "UsdPreviewSurface"
        color3f inputs:diffuseColor.connect = </Root/Mat/Tex.outputs:rgba>
        token outputs:surface
    }

    def Shader "Tex"
    {
        uniform token info:id = "UsdUVTexture"
        asset inputs:file = @t.png@
        float4 outputs:rgba
    }
}
`;
  const xml = build(usda, { allowPreviewSurface: true }).xml;
  assert.match(xml, /<UsdUVTexture name="Tex" type="multioutput" version="2\.2">/);
  assert.match(xml, /<convert name="Preview_diffuseColor_convert" type="color3">/);
});
