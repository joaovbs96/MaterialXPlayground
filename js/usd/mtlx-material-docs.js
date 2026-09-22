// Pure ESM MaterialX 1.39 document emitters for glTF PBR, OBJ/MTL and the
// flattened UsdPreviewSurface payload. No DOM, no THREE, no WASM, so the
// stage worker, main-thread loaders and node tests can all import it.

const MTLX_VERSION = "1.39";
const SRGB = "srgb_texture";

// ---------------------------------------------------------------- utilities

export function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function formatNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  let out = n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  if (out === "-0" || out === "") out = "0";
  return out;
}

export function formatVector(values, size, fallback = 0) {
  const out = [];
  for (let i = 0; i < size; i++) {
    const v = Array.isArray(values) ? values[i] : undefined;
    out.push(formatNumber(v === undefined ? fallback : v));
  }
  return out.join(", ");
}

// MaterialX names accept letters, digits and underscore, and must not start
// with a digit. `used` keeps names unique inside one document.
export function sanitizeMtlxName(name, used) {
  let base = String(name ?? "").replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
  base = base.replace(/^_+/, "").replace(/_+$/, "");
  if (!base) base = "material";
  if (/^[0-9]/.test(base)) base = "_" + base;
  if (!used) return base;
  if (!used.has(base)) { used.add(base); return base; }
  let i = 2;
  while (used.has(base + "_" + i)) i++;
  const unique = base + "_" + i;
  used.add(unique);
  return unique;
}

// Tiny deterministic XML builder: nodes in insertion order, inputs in the
// order they were set, 2-space indentation like usd-stage-worker.js.
function createDocument() {
  const nodes = [];
  const used = new Set();
  const doc = {
    used,
    addNode(category, name, type) {
      const node = { category, name: sanitizeMtlxName(name, used), type, inputs: [] };
      nodes.push(node);
      return node;
    },
    toXml() {
      const lines = ['<?xml version="1.0"?>', `<materialx version="${MTLX_VERSION}" colorspace="lin_rec709">`];
      for (const node of orderNodes(nodes)) {
        const head = `  <${node.category} name="${xmlEscape(node.name)}" type="${xmlEscape(node.type)}"`;
        if (!node.inputs.length) { lines.push(head + " />"); continue; }
        lines.push(head + ">");
        for (const input of node.inputs) {
          let attrs = `name="${xmlEscape(input.name)}" type="${xmlEscape(input.type)}"`;
          for (const [key, value] of input.attrs) attrs += ` ${key}="${xmlEscape(value)}"`;
          lines.push(`    <input ${attrs} />`);
        }
        lines.push(`  </${node.category}>`);
      }
      lines.push("</materialx>", "");
      return lines.join("\n");
    },
  };
  return doc;
}

// Upstream nodes first, so no element references a name defined below it.
// Insertion order breaks ties, which keeps the output deterministic.
function orderNodes(nodes) {
  const byName = new Map(nodes.map(node => [node.name, node]));
  const seen = new Set();
  const out = [];
  const visit = (node, stack) => {
    if (seen.has(node.name) || stack.has(node.name)) return;
    stack.add(node.name);
    for (const input of node.inputs) {
      const link = input.attrs.find(([key]) => key === "nodename");
      const source = link && byName.get(link[1]);
      if (source) visit(source, stack);
    }
    stack.delete(node.name);
    seen.add(node.name);
    out.push(node);
  };
  for (const node of nodes) visit(node, new Set());
  return out;
}

function setInput(node, name, type, attrs) {
  const entries = [];
  for (const key of ["value", "nodename", "output", "colorspace", "uniform"]) {
    if (attrs && attrs[key] !== undefined && attrs[key] !== null) entries.push([key, attrs[key]]);
  }
  const existing = node.inputs.find(input => input.name === name);
  if (existing) { existing.type = type; existing.attrs = entries; return node; }
  node.inputs.push({ name, type, attrs: entries });
  return node;
}

function connect(node, name, type, source, output) {
  setInput(node, name, type, { nodename: source.name, output });
  return node;
}

function finish(doc, shader, materialName) {
  const material = doc.addNode("surfacematerial", materialName, "material");
  connect(material, "surfaceshader", "surfaceshader", shader);
  return { xml: doc.toXml(), materialName: material.name, shaderName: shader.name };
}

// -------------------------------------------------------------- glTF PBR

const GLTF_WRAP = { 33071: "clamp", 33648: "mirror", 10497: "periodic" };

const KNOWN_GLTF_EXTENSIONS = new Set([
  "KHR_materials_clearcoat", "KHR_materials_transmission", "KHR_materials_volume",
  "KHR_materials_ior", "KHR_materials_sheen", "KHR_materials_specular",
  "KHR_materials_iridescence", "KHR_materials_anisotropy", "KHR_materials_dispersion",
  "KHR_materials_emissive_strength", "KHR_texture_transform",
  "KHR_materials_unlit", "KHR_materials_pbrSpecularGlossiness",
]);

function num(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Address modes, filter, UV set and KHR_texture_transform, shared by every
// gltf_image / gltf_colorimage / gltf_normalmap instance.
function applyGltfImageCommon(ctx, node, ref, colorspace) {
  setInput(node, "file", "filename", { value: ref.file, colorspace, uniform: "true" });
  const texCoord = num(ref.transform && ref.transform.texCoord, num(ref.texCoord, 0));
  if (texCoord === 1) connect(node, "texcoord", "vector2", uv1Node(ctx));
  const transform = ref.transform;
  if (transform) {
    if (Array.isArray(transform.scale)) setInput(node, "scale", "vector2", { value: formatVector(transform.scale, 2, 1) });
    if (num(transform.rotation, 0) !== 0) {
      setInput(node, "rotate", "float", { value: formatNumber((transform.rotation * 180) / Math.PI) });
    }
    if (Array.isArray(transform.offset)) setInput(node, "offset", "vector2", { value: formatVector(transform.offset, 2, 0) });
  }
  const uwrap = GLTF_WRAP[ref.wrapS];
  const vwrap = GLTF_WRAP[ref.wrapT];
  if (uwrap) setInput(node, "uaddressmode", "string", { value: uwrap, uniform: "true" });
  if (vwrap) setInput(node, "vaddressmode", "string", { value: vwrap, uniform: "true" });
  if (ref.magFilter === 9728) setInput(node, "filtertype", "string", { value: "closest", uniform: "true" });
  return node;
}

function uv1Node(ctx) {
  if (!ctx.uv1) {
    ctx.uv1 = ctx.doc.addNode("geompropvalue", "uv1", "vector2");
    setInput(ctx.uv1, "geomprop", "string", { value: "UV1", uniform: "true" });
  }
  return ctx.uv1;
}

function resolveRef(ctx, textureInfo, label) {
  if (!textureInfo) return null;
  const ref = ctx.textureRefs ? ctx.textureRefs(textureInfo) : null;
  if (!ref || !ref.file) {
    ctx.notes.push(`Texture for ${label} could not be resolved, the constant factor is used instead`);
    return null;
  }
  if (textureInfo.extensions && textureInfo.extensions.KHR_texture_transform && !ref.transform) {
    ref.transform = textureInfo.extensions.KHR_texture_transform;
  }
  if (ref.texCoord === undefined) ref.texCoord = num(textureInfo.texCoord, 0);
  return ref;
}

function scaleFloat(ctx, source, name, factor, output) {
  if (factor === undefined || factor === 1) return source;
  const scaled = ctx.doc.addNode("multiply", name, "float");
  connect(scaled, "in1", "float", source, output);
  setInput(scaled, "in2", "float", { value: formatNumber(factor) });
  return scaled;
}

// A float channel read: gltf_image float (red) or vector3 + extract.
function floatTexture(ctx, ref, name, channel, factor) {
  if (channel === 0) {
    const node = ctx.doc.addNode("gltf_image", name, "float");
    applyGltfImageCommon(ctx, node, ref);
    if (factor !== undefined && factor !== 1) setInput(node, "factor", "float", { value: formatNumber(factor) });
    return node;
  }
  const image = ctx.doc.addNode("gltf_image", name, "vector3");
  applyGltfImageCommon(ctx, image, ref);
  const extract = ctx.doc.addNode("extract", name + "_channel", "float");
  connect(extract, "in", "vector3", image);
  setInput(extract, "index", "integer", { value: String(channel), uniform: "true" });
  return scaleFloat(ctx, extract, name + "_scaled", factor);
}

// glTF packs the specular factor and the sheen roughness in the alpha
// channel, which needs the color4 gltf_image plus an extract.
function alphaTexture(ctx, ref, name, factor) {
  const image = ctx.doc.addNode("gltf_image", name, "color4");
  applyGltfImageCommon(ctx, image, ref);
  const extract = ctx.doc.addNode("extract", name + "_channel", "float");
  connect(extract, "in", "color4", image);
  setInput(extract, "index", "integer", { value: "3", uniform: "true" });
  return scaleFloat(ctx, extract, name + "_scaled", factor);
}

function colorTexture(ctx, ref, name, factorRgba) {
  const node = ctx.doc.addNode("gltf_colorimage", name, "multioutput");
  applyGltfImageCommon(ctx, node, ref, SRGB);
  if (factorRgba) setInput(node, "color", "color4", { value: formatVector(factorRgba, 4, 1) });
  return node;
}

// gltf_normalmap has no strength input, so a scaled normal texture is built
// from the same pieces: the glTF image read plus a normalmap with scale.
function normalMapNode(ctx, ref, name, scale) {
  if (scale === 1) {
    const node = ctx.doc.addNode("gltf_normalmap", name, "vector3");
    applyGltfImageCommon(ctx, node, ref);
    return node;
  }
  const image = ctx.doc.addNode("gltf_image", name, "vector3");
  applyGltfImageCommon(ctx, image, ref);
  setInput(image, "default", "vector3", { value: "0.5, 0.5, 1" });
  const normalmap = ctx.doc.addNode("normalmap", name + "_normalmap", "vector3");
  connect(normalmap, "in", "vector3", image);
  setInput(normalmap, "scale", "float", { value: formatNumber(scale) });
  return normalmap;
}

// Extract one channel of an existing gltf_image vector3 and scale it.
function channelOf(ctx, image, index, name, factor) {
  const extract = ctx.doc.addNode("extract", name + "_channel", "float");
  connect(extract, "in", "vector3", image);
  setInput(extract, "index", "integer", { value: String(index), uniform: "true" });
  return scaleFloat(ctx, extract, name + "_scaled", factor);
}

// Base color and its alpha, shared by gltf_pbr, the legacy spec/gloss
// mapping and the unlit surface. Returns the factor when there is no map.
function gltfBaseColor(ctx, pbr, hasVertexColor) {
  const factor = Array.isArray(pbr.baseColorFactor) ? pbr.baseColorFactor : [1, 1, 1, 1];
  const ref = resolveRef(ctx, pbr.baseColorTexture, "base color");
  let color = null;
  let alpha = null;
  if (ref) {
    const image = colorTexture(ctx, ref, "base_color_image", factor);
    color = { node: image, output: "outcolor" };
    alpha = { node: image, output: "outa" };
  }
  if (hasVertexColor) {
    const vertex = ctx.doc.addNode("geompropvalue", "vertex_color", "color3");
    setInput(vertex, "geomprop", "string", { value: "color", uniform: "true" });
    setInput(vertex, "default", "color3", { value: "1, 1, 1" });
    const mul = ctx.doc.addNode("multiply", "base_color_vertex", "color3");
    if (color) connect(mul, "in1", "color3", color.node, color.output);
    else setInput(mul, "in1", "color3", { value: formatVector(factor, 3, 1) });
    connect(mul, "in2", "color3", vertex);
    color = { node: mul };
  }
  return { color, alpha, factor };
}

// glTF ignores alpha entirely when the mode is OPAQUE; MASK is a hard cut
// at the cutoff, which surface_unlit needs spelled out as an ifgreater.
function alphaSource(ctx, base, alphaMode, alphaCutoff, masked) {
  if (alphaMode === "OPAQUE") return null;
  let source = base.alpha ? { node: base.alpha.node, output: base.alpha.output } : null;
  const constant = num(base.factor[3], 1);
  if (!masked) return source || { value: constant };
  const cut = ctx.doc.addNode("ifgreater", "alpha_cutoff_mask", "float");
  if (source) connect(cut, "value1", "float", source.node, source.output);
  else setInput(cut, "value1", "float", { value: formatNumber(constant) });
  setInput(cut, "value2", "float", { value: formatNumber(alphaCutoff) });
  setInput(cut, "in1", "float", { value: "1" });
  setInput(cut, "in2", "float", { value: "0" });
  return { node: cut };
}

function setFloatSource(node, name, source) {
  if (!source) return;
  if (source.node) connect(node, name, "float", source.node, source.output);
  else setInput(node, name, "float", { value: formatNumber(source.value) });
}

export function gltfPbrDocument({ name, material, textureRefs, hints } = {}) {
  const source = material || {};
  const doc = createDocument();
  const ctx = { doc, textureRefs, notes: [], uv1: null };
  const label = name || "material";
  const extensions = source.extensions && typeof source.extensions === "object" ? source.extensions : {};
  const hasVertexColor = !!(hints && hints.hasVertexColor);
  const alphaMode = String(source.alphaMode || "OPAQUE").toUpperCase();
  const alphaCutoff = num(source.alphaCutoff, 0.5);

  for (const key of Object.keys(extensions)) {
    if (!KNOWN_GLTF_EXTENSIONS.has(key)) ctx.notes.push(`Unsupported glTF extension: ${key} (ignored)`);
  }

  const shader = extensions.KHR_materials_unlit
    ? unlitShader(ctx, "SR_" + label, source, alphaMode, alphaCutoff, hasVertexColor)
    : pbrShader(ctx, "SR_" + label, source, extensions, alphaMode, alphaCutoff, hasVertexColor);

  const result = finish(doc, shader, "M_" + label);
  return { xml: result.xml, materialName: result.materialName, shaderName: result.shaderName, notes: ctx.notes };
}

// KHR_materials_unlit has no gltf_pbr equivalent, so the base color is shown
// as unlit emission, the same substitution materialxgltf makes.
function unlitShader(ctx, shaderName, source, alphaMode, alphaCutoff, hasVertexColor) {
  const shader = ctx.doc.addNode("surface_unlit", shaderName, "surfaceshader");
  const base = gltfBaseColor(ctx, source.pbrMetallicRoughness || {}, hasVertexColor);
  setInput(shader, "emission", "float", { value: "1" });
  if (base.color) connect(shader, "emission_color", "color3", base.color.node, base.color.output);
  else setInput(shader, "emission_color", "color3", { value: formatVector(base.factor, 3, 1) });
  setFloatSource(shader, "opacity", alphaSource(ctx, base, alphaMode, alphaCutoff, alphaMode === "MASK"));
  ctx.notes.push("KHR_materials_unlit has no gltf_pbr equivalent, the base color is emitted as unlit emission and lighting is ignored");
  return shader;
}

function pbrShader(ctx, shaderName, source, extensions, alphaMode, alphaCutoff, hasVertexColor) {
  const doc = ctx.doc;
  const shader = doc.addNode("gltf_pbr", shaderName, "surfaceshader");
  const specGloss = extensions.KHR_materials_pbrSpecularGlossiness;
  const pbr = source.pbrMetallicRoughness || {};

  // Base color and alpha, then metallic and roughness. The legacy
  // spec/gloss extension replaces both of those blocks.
  const base = specGloss
    ? specularGlossiness(ctx, shader, specGloss, hasVertexColor)
    : gltfBaseColor(ctx, pbr, hasVertexColor);
  if (base.color) connect(shader, "base_color", "color3", base.color.node, base.color.output);
  else setInput(shader, "base_color", "color3", { value: formatVector(base.factor, 3, 1) });
  setFloatSource(shader, "alpha", alphaSource(ctx, base, alphaMode, alphaCutoff, false));

  if (!specGloss) {
    // Metallic and roughness share one texture: G roughness, B metallic.
    const metallicFactor = num(pbr.metallicFactor, 1);
    const roughnessFactor = num(pbr.roughnessFactor, 1);
    const mrRef = resolveRef(ctx, pbr.metallicRoughnessTexture, "metallic roughness");
    if (mrRef) {
      const image = doc.addNode("gltf_image", "metallic_roughness_image", "vector3");
      applyGltfImageCommon(ctx, image, mrRef);
      connect(shader, "roughness", "float", channelOf(ctx, image, 1, "roughness", roughnessFactor));
      connect(shader, "metallic", "float", channelOf(ctx, image, 2, "metallic", metallicFactor));
    } else {
      setInput(shader, "roughness", "float", { value: formatNumber(roughnessFactor) });
      setInput(shader, "metallic", "float", { value: formatNumber(metallicFactor) });
    }
  }

  // Normal, occlusion, emissive.
  const normalRef = resolveRef(ctx, source.normalTexture, "normal");
  if (normalRef) {
    const scale = num(source.normalTexture && source.normalTexture.scale, 1);
    connect(shader, "normal", "vector3", normalMapNode(ctx, normalRef, "normal_image", scale));
  }
  const occlusionRef = resolveRef(ctx, source.occlusionTexture, "occlusion");
  if (occlusionRef) {
    const image = doc.addNode("gltf_image", "occlusion_image", "vector3");
    applyGltfImageCommon(ctx, image, occlusionRef);
    const channel = channelOf(ctx, image, 0, "occlusion", 1);
    const strength = num(source.occlusionTexture && source.occlusionTexture.strength, 1);
    if (strength === 1) {
      connect(shader, "occlusion", "float", channel);
    } else {
      // glTF: 1 + strength * (occlusion - 1), which is mix(1, occlusion).
      const mix = doc.addNode("mix", "occlusion_strength", "float");
      connect(mix, "fg", "float", channel);
      setInput(mix, "bg", "float", { value: "1" });
      setInput(mix, "mix", "float", { value: formatNumber(strength) });
      connect(shader, "occlusion", "float", mix);
    }
  }
  const emissiveFactor = Array.isArray(source.emissiveFactor) ? source.emissiveFactor : [0, 0, 0];
  const emissiveRef = resolveRef(ctx, source.emissiveTexture, "emissive");
  if (emissiveRef) {
    const image = colorTexture(ctx, emissiveRef, "emissive_image", [emissiveFactor[0], emissiveFactor[1], emissiveFactor[2], 1]);
    connect(shader, "emissive", "color3", image, "outcolor");
  } else if (emissiveFactor.some(v => num(v, 0) !== 0)) {
    setInput(shader, "emissive", "color3", { value: formatVector(emissiveFactor, 3, 0) });
  }

  // Alpha mode.
  const alphaModeValue = alphaMode === "MASK" ? 1 : alphaMode === "BLEND" ? 2 : 0;
  setInput(shader, "alpha_mode", "integer", { value: String(alphaModeValue), uniform: "true" });
  if (alphaModeValue === 1) {
    setInput(shader, "alpha_cutoff", "float", { value: formatNumber(alphaCutoff), uniform: "true" });
  }

  applyGltfExtensions(ctx, shader, extensions);
  return shader;
}

// KHR_materials_pbrSpecularGlossiness: diffuse becomes the base color of a
// non-metal, the specular colour drives F0 and glossiness inverts.
function specularGlossiness(ctx, shader, sg, hasVertexColor) {
  const diffuse = Array.isArray(sg.diffuseFactor) ? sg.diffuseFactor : [1, 1, 1, 1];
  const specular = Array.isArray(sg.specularFactor) ? sg.specularFactor : [1, 1, 1];
  const glossiness = num(sg.glossinessFactor, 1);
  const base = gltfBaseColor(ctx, { baseColorFactor: diffuse, baseColorTexture: sg.diffuseTexture }, hasVertexColor);
  setInput(shader, "metallic", "float", { value: "0" });
  const ref = resolveRef(ctx, sg.specularGlossinessTexture, "specular glossiness");
  if (ref) {
    const image = colorTexture(ctx, ref, "specular_glossiness_image", [specular[0], specular[1], specular[2], glossiness]);
    connect(shader, "specular_color", "color3", image, "outcolor");
    const roughness = ctx.doc.addNode("subtract", "glossiness_to_roughness", "float");
    setInput(roughness, "in1", "float", { value: "1" });
    connect(roughness, "in2", "float", image, "outa");
    connect(shader, "roughness", "float", roughness);
  } else {
    setInput(shader, "specular_color", "color3", { value: formatVector(specular, 3, 1) });
    setInput(shader, "roughness", "float", { value: formatNumber(1 - glossiness) });
  }
  ctx.notes.push("KHR_materials_pbrSpecularGlossiness is legacy: diffuse becomes the base color with metallic 0, the specular color drives specular_color and glossiness becomes roughness");
  return base;
}

function applyGltfExtensions(ctx, shader, extensions) {
  const clearcoat = extensions.KHR_materials_clearcoat;
  if (clearcoat) {
    const factor = num(clearcoat.clearcoatFactor, 0);
    const roughness = num(clearcoat.clearcoatRoughnessFactor, 0);
    const ref = resolveRef(ctx, clearcoat.clearcoatTexture, "clearcoat");
    if (ref) connect(shader, "clearcoat", "float", floatTexture(ctx, ref, "clearcoat_image", 0, factor));
    else setInput(shader, "clearcoat", "float", { value: formatNumber(factor) });
    const roughRef = resolveRef(ctx, clearcoat.clearcoatRoughnessTexture, "clearcoat roughness");
    if (roughRef) connect(shader, "clearcoat_roughness", "float", floatTexture(ctx, roughRef, "clearcoat_roughness_image", 1, roughness));
    else setInput(shader, "clearcoat_roughness", "float", { value: formatNumber(roughness) });
    const normalRef = resolveRef(ctx, clearcoat.clearcoatNormalTexture, "clearcoat normal");
    if (normalRef) {
      const scale = num(clearcoat.clearcoatNormalTexture && clearcoat.clearcoatNormalTexture.scale, 1);
      connect(shader, "clearcoat_normal", "vector3", normalMapNode(ctx, normalRef, "clearcoat_normal_image", scale));
    }
  }
  const transmission = extensions.KHR_materials_transmission;
  if (transmission) {
    const factor = num(transmission.transmissionFactor, 0);
    const ref = resolveRef(ctx, transmission.transmissionTexture, "transmission");
    if (ref) connect(shader, "transmission", "float", floatTexture(ctx, ref, "transmission_image", 0, factor));
    else setInput(shader, "transmission", "float", { value: formatNumber(factor) });
  }
  const volume = extensions.KHR_materials_volume;
  if (volume) {
    const thickness = num(volume.thicknessFactor, 0);
    const ref = resolveRef(ctx, volume.thicknessTexture, "thickness");
    if (ref) connect(shader, "thickness", "float", floatTexture(ctx, ref, "thickness_image", 1, thickness));
    else setInput(shader, "thickness", "float", { value: formatNumber(thickness) });
    if (Number.isFinite(volume.attenuationDistance)) {
      setInput(shader, "attenuation_distance", "float", { value: formatNumber(volume.attenuationDistance), uniform: "true" });
    }
    if (Array.isArray(volume.attenuationColor)) {
      setInput(shader, "attenuation_color", "color3", { value: formatVector(volume.attenuationColor, 3, 1), uniform: "true" });
    }
  }
  const ior = extensions.KHR_materials_ior;
  if (ior && Number.isFinite(ior.ior)) setInput(shader, "ior", "float", { value: formatNumber(ior.ior), uniform: "true" });
  const sheen = extensions.KHR_materials_sheen;
  if (sheen) {
    const color = Array.isArray(sheen.sheenColorFactor) ? sheen.sheenColorFactor : [0, 0, 0];
    const ref = resolveRef(ctx, sheen.sheenColorTexture, "sheen color");
    if (ref) connect(shader, "sheen_color", "color3", colorTexture(ctx, ref, "sheen_color_image", [color[0], color[1], color[2], 1]), "outcolor");
    else setInput(shader, "sheen_color", "color3", { value: formatVector(color, 3, 0) });
    const roughness = num(sheen.sheenRoughnessFactor, 0);
    const roughRef = resolveRef(ctx, sheen.sheenRoughnessTexture, "sheen roughness");
    if (roughRef) connect(shader, "sheen_roughness", "float", alphaTexture(ctx, roughRef, "sheen_roughness_image", roughness));
    else setInput(shader, "sheen_roughness", "float", { value: formatNumber(roughness) });
  }
  const specular = extensions.KHR_materials_specular;
  if (specular) {
    const factor = num(specular.specularFactor, 1);
    const ref = resolveRef(ctx, specular.specularTexture, "specular");
    if (ref) connect(shader, "specular", "float", alphaTexture(ctx, ref, "specular_image", factor));
    else setInput(shader, "specular", "float", { value: formatNumber(factor) });
    const color = Array.isArray(specular.specularColorFactor) ? specular.specularColorFactor : [1, 1, 1];
    const colorRef = resolveRef(ctx, specular.specularColorTexture, "specular color");
    if (colorRef) connect(shader, "specular_color", "color3", colorTexture(ctx, colorRef, "specular_color_image", [color[0], color[1], color[2], 1]), "outcolor");
    else setInput(shader, "specular_color", "color3", { value: formatVector(color, 3, 1) });
  }
  const iridescence = extensions.KHR_materials_iridescence;
  if (iridescence) {
    const factor = num(iridescence.iridescenceFactor, 0);
    const ref = resolveRef(ctx, iridescence.iridescenceTexture, "iridescence");
    if (ref) connect(shader, "iridescence", "float", floatTexture(ctx, ref, "iridescence_image", 0, factor));
    else setInput(shader, "iridescence", "float", { value: formatNumber(factor) });
    setInput(shader, "iridescence_ior", "float", { value: formatNumber(num(iridescence.iridescenceIor, 1.3)), uniform: "true" });
    const thicknessMin = num(iridescence.iridescenceThicknessMinimum, 100);
    const thicknessMax = num(iridescence.iridescenceThicknessMaximum, 400);
    const thicknessRef = resolveRef(ctx, iridescence.iridescenceThicknessTexture, "iridescence thickness");
    if (thicknessRef) {
      const node = ctx.doc.addNode("gltf_iridescence_thickness", "iridescence_thickness_image", "float");
      applyGltfImageCommon(ctx, node, thicknessRef);
      setInput(node, "thicknessMin", "float", { value: formatNumber(thicknessMin) });
      setInput(node, "thicknessMax", "float", { value: formatNumber(thicknessMax) });
      connect(shader, "iridescence_thickness", "float", node);
    } else {
      setInput(shader, "iridescence_thickness", "float", { value: formatNumber(thicknessMax) });
    }
  }
  const anisotropy = extensions.KHR_materials_anisotropy;
  if (anisotropy) {
    // Both are radians: gltf_pbr turns anisotropy_rotation into degrees with
    // a -57.29578 multiply, and glTF stores the rotation in radians too.
    const strength = num(anisotropy.anisotropyStrength, 0);
    const rotation = num(anisotropy.anisotropyRotation, 0);
    const ref = resolveRef(ctx, anisotropy.anisotropyTexture, "anisotropy");
    if (ref) {
      // RG hold the tangent-space direction and B the strength multiplier;
      // gltf_anisotropy_image does the decode and the atan2 internally.
      const node = ctx.doc.addNode("gltf_anisotropy_image", "anisotropy_image", "multioutput");
      applyGltfImageCommon(ctx, node, ref);
      setInput(node, "anisotropy_strength", "float", { value: formatNumber(strength) });
      setInput(node, "anisotropy_rotation", "float", { value: formatNumber(rotation) });
      connect(shader, "anisotropy_strength", "float", node, "anisotropy_strength_out");
      connect(shader, "anisotropy_rotation", "float", node, "anisotropy_rotation_out");
    } else {
      setInput(shader, "anisotropy_strength", "float", { value: formatNumber(strength) });
      setInput(shader, "anisotropy_rotation", "float", { value: formatNumber(rotation) });
    }
  }
  const dispersion = extensions.KHR_materials_dispersion;
  if (dispersion) setInput(shader, "dispersion", "float", { value: formatNumber(num(dispersion.dispersion, 0)) });
  const emissiveStrength = extensions.KHR_materials_emissive_strength;
  if (emissiveStrength && Number.isFinite(emissiveStrength.emissiveStrength)) {
    setInput(shader, "emissive_strength", "float", { value: formatNumber(emissiveStrength.emissiveStrength), uniform: "true" });
  }
}

// ------------------------------------------------------------- OBJ and MTL

// Flags and how many tokens each consumes, so the file path is whatever is
// left after the last option.
const MTL_OPTIONS = {
  "-blendu": 1, "-blendv": 1, "-cc": 1, "-clamp": 1, "-bm": 1, "-boost": 1,
  "-imfchan": 1, "-texres": 1, "-type": 1, "-mm": 2, "-o": 3, "-s": 3, "-t": 3,
};

const MTL_NUMERIC = new Set(["Ns", "Ni", "d", "Tr", "illum", "Pr", "Pm", "Ps", "Pc", "Pcr", "Ke_strength"]);
const MTL_COLOR = new Set(["Ka", "Kd", "Ks", "Ke", "Tf"]);

function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/").trim();
}

function parseMapLine(rest) {
  const tokens = rest.split(/\s+/).filter(Boolean);
  const options = {};
  let i = 0;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const flag = tokens[i].toLowerCase();
    const arity = MTL_OPTIONS[flag] !== undefined ? MTL_OPTIONS[flag] : 1;
    const values = tokens.slice(i + 1, i + 1 + arity);
    const key = flag.slice(1);
    options[key] = arity === 1 ? values[0] : values.map(v => Number(v));
    i += 1 + arity;
  }
  const path = normalizePath(tokens.slice(i).join(" "));
  if (!path) return null;
  return { path, options };
}

export function parseMtl(text) {
  const materials = new Map();
  let current = null;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const space = line.search(/\s/);
    const key = space < 0 ? line : line.slice(0, space);
    const rest = space < 0 ? "" : line.slice(space + 1).trim();
    if (key === "newmtl") {
      current = { name: rest };
      materials.set(rest, current);
      continue;
    }
    if (!current) continue;
    if (key.startsWith("map_") || key === "bump" || key === "norm" || key === "disp" || key === "decal") {
      const record = parseMapLine(rest);
      if (record) current[key] = record;
      continue;
    }
    if (MTL_COLOR.has(key)) {
      const parts = rest.split(/\s+/).filter(Boolean);
      if (parts[0] === "spectral" || parts[0] === "xyz") continue;
      const values = parts.map(Number).filter(Number.isFinite);
      if (values.length === 1) current[key] = [values[0], values[0], values[0]];
      else if (values.length >= 3) current[key] = values.slice(0, 3);
      continue;
    }
    if (MTL_NUMERIC.has(key)) {
      const value = Number(rest.split(/\s+/)[0]);
      if (Number.isFinite(value)) current[key] = value;
      continue;
    }
  }
  return materials;
}

// Address modes from the -clamp option, applied to plain stdlib image nodes.
function applyMtlImageCommon(ctx, node, file, options, colorspace) {
  setInput(node, "file", "filename", { value: file, colorspace, uniform: "true" });
  const clamp = options && String(options.clamp || "").toLowerCase() === "on";
  if (clamp) {
    setInput(node, "uaddressmode", "string", { value: "clamp", uniform: "true" });
    setInput(node, "vaddressmode", "string", { value: "clamp", uniform: "true" });
  }
  return node;
}

function mtlFile(ctx, record, label) {
  if (!record) return null;
  const file = ctx.textureRefs ? ctx.textureRefs(record) : null;
  if (!file) {
    ctx.notes.push(`Texture for ${label} could not be resolved, the constant value is used instead`);
    return null;
  }
  return file;
}

export function objMtlDocument({ name, mtl, textureRefs } = {}) {
  const source = mtl || {};
  const doc = createDocument();
  const ctx = { doc, textureRefs, notes: [] };
  const shader = doc.addNode("open_pbr_surface", "SR_" + (name || "material"), "surfaceshader");

  // Base color: map_Kd modulated by Kd when Kd is not white.
  const kd = Array.isArray(source.Kd) ? source.Kd : [0.8, 0.8, 0.8];
  const kdFile = mtlFile(ctx, source.map_Kd, "base color");
  if (kdFile) {
    const image = doc.addNode("image", "base_color_image", "color3");
    applyMtlImageCommon(ctx, image, kdFile, source.map_Kd.options, SRGB);
    if (kd.some(v => num(v, 1) !== 1)) {
      const mul = doc.addNode("multiply", "base_color_tint", "color3");
      connect(mul, "in1", "color3", image);
      setInput(mul, "in2", "color3", { value: formatVector(kd, 3, 1) });
      connect(shader, "base_color", "color3", mul);
    } else {
      connect(shader, "base_color", "color3", image);
    }
  } else {
    setInput(shader, "base_color", "color3", { value: formatVector(kd, 3, 0.8) });
  }

  // Roughness: Ns converted, then overridden by Pr or map_Pr.
  const ns = num(source.Ns, undefined);
  let roughness = ns === undefined ? 0.3 : Math.min(1, Math.max(0, Math.sqrt(2 / (ns + 2))));
  if (Number.isFinite(source.Pr)) roughness = source.Pr;
  const prFile = mtlFile(ctx, source.map_Pr, "roughness");
  if (prFile) {
    const image = doc.addNode("image", "roughness_image", "float");
    applyMtlImageCommon(ctx, image, prFile, source.map_Pr.options);
    connect(shader, "specular_roughness", "float", image);
  } else {
    setInput(shader, "specular_roughness", "float", { value: formatNumber(roughness) });
  }

  // Metalness.
  const pmFile = mtlFile(ctx, source.map_Pm, "metalness");
  if (pmFile) {
    const image = doc.addNode("image", "metalness_image", "float");
    applyMtlImageCommon(ctx, image, pmFile, source.map_Pm.options);
    connect(shader, "base_metalness", "float", image);
  } else if (Number.isFinite(source.Pm)) {
    setInput(shader, "base_metalness", "float", { value: formatNumber(source.Pm) });
  }

  if (Array.isArray(source.Ks)) setInput(shader, "specular_color", "color3", { value: formatVector(source.Ks, 3, 1) });
  if (Number.isFinite(source.Ni)) setInput(shader, "specular_ior", "float", { value: formatNumber(source.Ni) });

  // Opacity: map_d wins, else d, else 1 - Tr.
  const opacity = Number.isFinite(source.d) ? source.d : Number.isFinite(source.Tr) ? 1 - source.Tr : 1;
  const dFile = mtlFile(ctx, source.map_d, "opacity");
  if (dFile) {
    const image = doc.addNode("image", "opacity_image", "float");
    applyMtlImageCommon(ctx, image, dFile, source.map_d.options);
    connect(shader, "geometry_opacity", "float", image);
  } else if (opacity !== 1) {
    setInput(shader, "geometry_opacity", "float", { value: formatNumber(opacity) });
  }

  // Emission.
  const ke = Array.isArray(source.Ke) ? source.Ke : null;
  const keFile = mtlFile(ctx, source.map_Ke, "emission");
  if (keFile) {
    const image = doc.addNode("image", "emission_image", "color3");
    applyMtlImageCommon(ctx, image, keFile, source.map_Ke.options, SRGB);
    connect(shader, "emission_color", "color3", image);
    setInput(shader, "emission_luminance", "float", { value: "1" });
  } else if (ke && ke.some(v => num(v, 0) !== 0)) {
    setInput(shader, "emission_color", "color3", { value: formatVector(ke, 3, 0) });
    setInput(shader, "emission_luminance", "float", { value: "1" });
  }

  // Normals: a real normal map wins over a height map.
  const normalRecord = source.norm || source.map_Normal;
  const bumpRecord = source.map_Bump || source.bump;
  const normalFile = mtlFile(ctx, normalRecord, "normal map");
  if (normalFile) {
    const image = doc.addNode("image", "normal_image", "vector3");
    applyMtlImageCommon(ctx, image, normalFile, normalRecord.options);
    const normalmap = doc.addNode("normalmap", "normal_map", "vector3");
    connect(normalmap, "in", "vector3", image);
    connect(shader, "geometry_normal", "vector3", normalmap);
  } else {
    const bumpFile = mtlFile(ctx, bumpRecord, "bump map");
    if (bumpFile) {
      const image = doc.addNode("image", "bump_image", "float");
      applyMtlImageCommon(ctx, image, bumpFile, bumpRecord.options);
      const height = doc.addNode("heighttonormal", "bump_to_normal", "vector3");
      connect(height, "in", "float", image);
      const bm = Number(bumpRecord.options && bumpRecord.options.bm);
      setInput(height, "scale", "float", { value: formatNumber(Number.isFinite(bm) ? bm : 1) });
      const normalmap = doc.addNode("normalmap", "bump_normal_map", "vector3");
      connect(normalmap, "in", "vector3", height);
      connect(shader, "geometry_normal", "vector3", normalmap);
    }
  }

  // illum 4, 6 and 7 are the transmissive models.
  if (source.illum === 4 || source.illum === 6 || source.illum === 7) {
    setInput(shader, "transmission_weight", "float", { value: formatNumber(1 - opacity) });
  }

  const result = finish(doc, shader, "M_" + (name || "material"));
  return { xml: result.xml, materialName: result.materialName, shaderName: result.shaderName, notes: ctx.notes };
}

// --------------------------------------------------------- UsdPreviewSurface

const USD_FLOAT_TEXTURES = [
  ["roughnessTexture", "roughness", "roughness_image"],
  ["metallicTexture", "metallic", "metallic_image"],
  ["occlusionTexture", "occlusion", "occlusion_image"],
  ["opacityTexture", "opacity", "opacity_image"],
  ["clearcoatTexture", "clearcoat", "clearcoat_image"],
  ["clearcoatRoughnessTexture", "clearcoatRoughness", "clearcoat_roughness_image"],
];

const USD_FLOAT_VALUES = [
  ["roughness", "roughness"],
  ["metallic", "metallic"],
  ["opacity", "opacity"],
  ["clearcoat", "clearcoat"],
  ["clearcoatRoughness", "clearcoatRoughness"],
  ["ior", "ior"],
];

function usdFile(ctx, record, label) {
  if (!record) return null;
  const file = ctx.textureRefs ? ctx.textureRefs(record) : null;
  if (!file) {
    ctx.notes.push(`Texture for ${label} could not be resolved, the constant value is used instead`);
    return null;
  }
  return file;
}

export function usdPreviewSurfaceDocument({ name, record, textureRefs } = {}) {
  const source = record || {};
  const doc = createDocument();
  const ctx = { doc, textureRefs, notes: [] };
  const shader = doc.addNode("UsdPreviewSurface", "SR_" + (name || "material"), "surfaceshader");

  const diffuseFile = usdFile(ctx, source.diffuseTexture, "diffuse color");
  if (diffuseFile) {
    const image = doc.addNode("image", "diffuse_image", "color3");
    setInput(image, "file", "filename", { value: diffuseFile, colorspace: SRGB, uniform: "true" });
    connect(shader, "diffuseColor", "color3", image);
  } else if (Array.isArray(source.diffuseColor)) {
    setInput(shader, "diffuseColor", "color3", { value: formatVector(source.diffuseColor, 3, 0.18) });
  }

  const emissiveFile = usdFile(ctx, source.emissiveTexture, "emissive color");
  if (emissiveFile) {
    const image = doc.addNode("image", "emissive_image", "color3");
    setInput(image, "file", "filename", { value: emissiveFile, colorspace: SRGB, uniform: "true" });
    connect(shader, "emissiveColor", "color3", image);
  } else if (Array.isArray(source.emissiveColor)) {
    setInput(shader, "emissiveColor", "color3", { value: formatVector(source.emissiveColor, 3, 0) });
  }

  const textured = new Set();
  for (const [field, input, nodeName] of USD_FLOAT_TEXTURES) {
    const file = usdFile(ctx, source[field], input);
    if (!file) continue;
    const image = doc.addNode("image", nodeName, "float");
    setInput(image, "file", "filename", { value: file, uniform: "true" });
    connect(shader, input, "float", image);
    textured.add(input);
  }
  for (const [field, input] of USD_FLOAT_VALUES) {
    if (textured.has(input) || !Number.isFinite(source[field])) continue;
    setInput(shader, input, "float", { value: formatNumber(source[field]) });
  }

  // UsdPreviewSurface takes a tangent space normal and does the transform
  // itself, so the image feeds the input with no normalmap node.
  const normalFile = usdFile(ctx, source.normalTexture, "normal");
  if (normalFile) {
    const image = doc.addNode("image", "normal_image", "vector3");
    setInput(image, "file", "filename", { value: normalFile, uniform: "true" });
    setInput(image, "default", "vector3", { value: "0.5, 0.5, 1" });
    connect(shader, "normal", "vector3", image);
  }

  ctx.notes.push("Channel picks, wrap modes and texture transforms are not available in the flattened USD payload");
  const result = finish(doc, shader, "M_" + (name || "material"));
  return { xml: result.xml, materialName: result.materialName, shaderName: result.shaderName, notes: ctx.notes };
}
