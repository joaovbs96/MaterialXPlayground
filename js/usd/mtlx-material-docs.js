// Pure ESM MaterialX 1.39 document emitters for glTF PBR, OBJ/MTL, pbrt-v4, Mitsuba and the
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
  const byShape = new Map();
  // file value -> colorspaces of the image nodes kept for it, so a caller
  // can report an image that still costs two texture reads.
  const fileUses = new Map();
  const shapeOf = (node) => JSON.stringify([node.category, node.type, node.inputs.map(i => [i.name, i.type, i.attrs])]);
  const doc = {
    used,
    addNode(category, name, type) {
      const node = { category, name: sanitizeMtlxName(name, used), type, inputs: [] };
      nodes.push(node);
      return node;
    },
    // One texture read per distinct image node: returns an earlier node with
    // the same category, type and inputs and drops the one just built, so
    // slots that share an image also share a sampler. Call once, fully built.
    share(node) {
      const key = shapeOf(node);
      const existing = byShape.get(key);
      if (existing && existing !== node) {
        const at = nodes.indexOf(node);
        if (at >= 0) nodes.splice(at, 1);
        used.delete(node.name);
        return existing;
      }
      byShape.set(key, node);
      const file = node.inputs.find(i => i.name === "file");
      if (file) {
        const value = (file.attrs.find(([k]) => k === "value") || [])[1];
        const colorspace = (file.attrs.find(([k]) => k === "colorspace") || [])[1] || "raw";
        if (!fileUses.has(value)) fileUses.set(value, []);
        fileUses.get(value).push(colorspace);
      }
      return node;
    },
    fileUses,
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

// A float channel read: gltf_image float (red) or vector3 + extract. The
// factor is a separate multiply, so two slots on one image still share it.
function floatTexture(ctx, ref, name, channel, factor) {
  if (channel === 0) {
    const node = ctx.doc.share(applyGltfImageCommon(ctx, ctx.doc.addNode("gltf_image", name, "float"), ref));
    return scaleFloat(ctx, node, name + "_scaled", factor);
  }
  const image = ctx.doc.share(applyGltfImageCommon(ctx, ctx.doc.addNode("gltf_image", name, "vector3"), ref));
  const extract = ctx.doc.addNode("extract", name + "_channel", "float");
  connect(extract, "in", "vector3", image);
  setInput(extract, "index", "integer", { value: String(channel), uniform: "true" });
  return scaleFloat(ctx, extract, name + "_scaled", factor);
}

// glTF packs the specular factor and the sheen roughness in the alpha
// channel, which needs the color4 gltf_image plus an extract.
function alphaTexture(ctx, ref, name, factor) {
  const image = ctx.doc.share(applyGltfImageCommon(ctx, ctx.doc.addNode("gltf_image", name, "color4"), ref));
  const extract = ctx.doc.addNode("extract", name + "_channel", "float");
  connect(extract, "in", "color4", image);
  setInput(extract, "index", "integer", { value: "3", uniform: "true" });
  return scaleFloat(ctx, extract, name + "_scaled", factor);
}

function colorTexture(ctx, ref, name, factorRgba) {
  const node = ctx.doc.addNode("gltf_colorimage", name, "multioutput");
  applyGltfImageCommon(ctx, node, ref, SRGB);
  if (factorRgba) setInput(node, "color", "color4", { value: formatVector(factorRgba, 4, 1) });
  return ctx.doc.share(node);
}

// gltf_normalmap has no strength input, so a scaled normal texture is built
// from the same pieces: the glTF image read plus a normalmap with scale.
function normalMapNode(ctx, ref, name, scale) {
  if (scale === 1) {
    return ctx.doc.share(applyGltfImageCommon(ctx, ctx.doc.addNode("gltf_normalmap", name, "vector3"), ref));
  }
  const built = ctx.doc.addNode("gltf_image", name, "vector3");
  applyGltfImageCommon(ctx, built, ref);
  setInput(built, "default", "vector3", { value: "0.5, 0.5, 1" });
  const image = ctx.doc.share(built);
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

// One note per image that still costs more than one texture read, which
// happens when one slot needs the sRGB decode and another the raw data.
function noteRepeatedImages(ctx) {
  for (const [file, uses] of ctx.doc.fileUses) {
    if (uses.length < 2) continue;
    const mixed = new Set(uses).size > 1;
    ctx.notes.push(`${file} is read ${uses.length} times` + (mixed
      ? ", because one slot needs the sRGB decode and another the raw values"
      : ", because the slots using it need different sampling settings"));
  }
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

  noteRepeatedImages(ctx);
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
      const image = doc.share(applyGltfImageCommon(ctx, doc.addNode("gltf_image", "metallic_roughness_image", "vector3"), mrRef));
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
    const image = doc.share(applyGltfImageCommon(ctx, doc.addNode("gltf_image", "occlusion_image", "vector3"), occlusionRef));
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
      connect(shader, "iridescence_thickness", "float", ctx.doc.share(node));
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
      const built = ctx.doc.addNode("gltf_anisotropy_image", "anisotropy_image", "multioutput");
      applyGltfImageCommon(ctx, built, ref);
      setInput(built, "anisotropy_strength", "float", { value: formatNumber(strength) });
      setInput(built, "anisotropy_rotation", "float", { value: formatNumber(rotation) });
      const node = ctx.doc.share(built);
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
const MTL_MAPS = new Set(["map_Ka", "map_Kd", "map_Ks", "map_Ke", "map_Ns", "map_d", "map_Tr", "map_Bump",
  "map_Normal", "map_Pr", "map_Pm", "map_Ps", "map_Pc", "map_Pcr", "bump", "norm", "disp", "decal"]);
// MTL keywords are matched case-insensitively: every known keyword is stored
// under this canonical spelling, so map_bump, MAP_KD or kd reach the consumers.
const MTL_CANONICAL = new Map([...MTL_NUMERIC, ...MTL_COLOR, ...MTL_MAPS, "newmtl"].map(k => [k.toLowerCase(), k]));

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
    const rawKey = space < 0 ? line : line.slice(0, space);
    const lowerKey = rawKey.toLowerCase();
    const key = MTL_CANONICAL.get(lowerKey) ?? (lowerKey.startsWith("map_") ? lowerKey : rawKey);
    const rest = space < 0 ? "" : line.slice(space + 1).trim();
    if (key === "newmtl") {
      current = { name: rest };
      materials.set(rest, current);
      continue;
    }
    if (!current) continue;
    if (key.startsWith("map_") || MTL_MAPS.has(key)) {
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
  return ctx.doc.share(node);
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
    const image = applyMtlImageCommon(ctx, doc.addNode("image", "base_color_image", "color3"), kdFile, source.map_Kd.options, SRGB);
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
    const image = applyMtlImageCommon(ctx, doc.addNode("image", "roughness_image", "float"), prFile, source.map_Pr.options);
    connect(shader, "specular_roughness", "float", image);
  } else {
    setInput(shader, "specular_roughness", "float", { value: formatNumber(roughness) });
  }

  // Metalness.
  const pmFile = mtlFile(ctx, source.map_Pm, "metalness");
  if (pmFile) {
    const image = applyMtlImageCommon(ctx, doc.addNode("image", "metalness_image", "float"), pmFile, source.map_Pm.options);
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
    const image = applyMtlImageCommon(ctx, doc.addNode("image", "opacity_image", "float"), dFile, source.map_d.options);
    connect(shader, "geometry_opacity", "float", image);
  } else if (opacity !== 1) {
    setInput(shader, "geometry_opacity", "float", { value: formatNumber(opacity) });
  }

  // Emission.
  const ke = Array.isArray(source.Ke) ? source.Ke : null;
  const keFile = mtlFile(ctx, source.map_Ke, "emission");
  if (keFile) {
    const image = applyMtlImageCommon(ctx, doc.addNode("image", "emission_image", "color3"), keFile, source.map_Ke.options, SRGB);
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
    const image = applyMtlImageCommon(ctx, doc.addNode("image", "normal_image", "vector3"), normalFile, normalRecord.options);
    const normalmap = doc.addNode("normalmap", "normal_map", "vector3");
    connect(normalmap, "in", "vector3", image);
    connect(shader, "geometry_normal", "vector3", normalmap);
  } else {
    const bumpFile = mtlFile(ctx, bumpRecord, "bump map");
    if (bumpFile) {
      const image = applyMtlImageCommon(ctx, doc.addNode("image", "bump_image", "float"), bumpFile, bumpRecord.options);
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

  noteRepeatedImages(ctx);
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
    connect(shader, "diffuseColor", "color3", doc.share(image));
  } else if (Array.isArray(source.diffuseColor)) {
    setInput(shader, "diffuseColor", "color3", { value: formatVector(source.diffuseColor, 3, 0.18) });
  }

  const emissiveFile = usdFile(ctx, source.emissiveTexture, "emissive color");
  if (emissiveFile) {
    const image = doc.addNode("image", "emissive_image", "color3");
    setInput(image, "file", "filename", { value: emissiveFile, colorspace: SRGB, uniform: "true" });
    connect(shader, "emissiveColor", "color3", doc.share(image));
  } else if (Array.isArray(source.emissiveColor)) {
    setInput(shader, "emissiveColor", "color3", { value: formatVector(source.emissiveColor, 3, 0) });
  }

  const textured = new Set();
  for (const [field, input, nodeName] of USD_FLOAT_TEXTURES) {
    const file = usdFile(ctx, source[field], input);
    if (!file) continue;
    const image = doc.addNode("image", nodeName, "float");
    setInput(image, "file", "filename", { value: file, uniform: "true" });
    connect(shader, input, "float", doc.share(image));
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
    connect(shader, "normal", "vector3", doc.share(image));
  }

  ctx.notes.push("Channel picks, wrap modes and texture transforms are not available in the flattened USD payload");
  noteRepeatedImages(ctx);
  const result = finish(doc, shader, "M_" + (name || "material"));
  return { xml: result.xml, materialName: result.materialName, shaderName: result.shaderName, notes: ctx.notes };
}

// ---------------------------------------------------------------- PBRT v4

// RGB complex IOR of pbrt-v4's named metal spectra ("metal-<X>-eta/-k"):
// Tungsten's ComplexIorData.hpp (spectral data integrated to linear sRGB).
// CuZn is absent there: Mitsuba's documented brass RGB is used instead.
export const PBRT_NAMED_METALS = {
  Ag: { eta: [0.1552646489, 0.1167232965, 0.1383806959], k: [4.8283433224, 3.1222459278, 2.1469504455] },
  Al: { eta: [1.6574599595, 0.8803689579, 0.5212287346], k: [9.2238691996, 6.2695232477, 4.8370012281] },
  Au: { eta: [0.1431189557, 0.3749570432, 1.4424785571], k: [3.9831604247, 2.3857207478, 1.6032152899] },
  Cu: { eta: [0.2004376970, 0.9240334304, 1.1022119527], k: [3.9129485033, 2.4528477015, 2.1421879552] },
  CuZn: { eta: [0.444, 0.527, 1.094], k: [3.695, 2.765, 1.829] },
  MgO: { eta: [2.0895885542, 1.6507224525, 1.5948759692], k: [0, 0, 0] },
  TiO2: { eta: [3.4566203131, 2.8017076558, 2.9051485020], k: [0.0001026662, 0, 0.0006356902] },
};

// pbrt-v4 RoughnessToAlpha is sqrt(r) when remaproughness is true (the
// default), else the value is alpha itself; OpenPBR uses alpha = r^2.
export function pbrtRoughnessToOpenPbr(value, remap = true) {
  const r = Math.max(0, Number(value) || 0);
  const alpha = remap ? Math.sqrt(r) : r;
  return Math.min(1, Math.sqrt(alpha));
}

// Normal-incidence reflectance of a conductor, n + ik per channel.
export function conductorF0(eta, k) {
  return [0, 1, 2].map((i) => {
    const n = eta[i], kk = k[i];
    return ((n - 1) * (n - 1) + kk * kk) / ((n + 1) * (n + 1) + kk * kk);
  });
}

// Exact unpolarized Fresnel of a conductor (pbrt's FrComplex), one channel.
function frComplex(cosI, n, k) {
  const mul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
  const div = (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };
  const sqrtC = (a) => {
    const m = Math.hypot(a[0], a[1]);
    return [Math.sqrt((m + a[0]) / 2), Math.sqrt(Math.max(0, (m - a[0]) / 2)) * (a[1] < 0 ? -1 : 1)];
  };
  const eta = [n, k];
  const sin2T = div([1 - cosI * cosI, 0], mul(eta, eta));
  const cosT = sqrtC([1 - sin2T[0], -sin2T[1]]);
  const etaCosI = [n * cosI, k * cosI];
  const etaCosT = mul(eta, cosT);
  const rParl = div([etaCosI[0] - cosT[0], etaCosI[1] - cosT[1]], [etaCosI[0] + cosT[0], etaCosI[1] + cosT[1]]);
  const rPerp = div([cosI - etaCosT[0], -etaCosT[1]], [cosI + etaCosT[0], etaCosT[1]]);
  return (rParl[0] * rParl[0] + rParl[1] * rParl[1] + rPerp[0] * rPerp[0] + rPerp[1] * rPerp[1]) / 2;
}

// OpenPBR's F82 tint (specular_color on a metal): the exact Fresnel at
// cos = 1/7 over Schlick's value there, clamped to [0, 1].
export function conductorF82Tint(eta, k) {
  const f0 = conductorF0(eta, k);
  const mu = 1 / 7;
  return [0, 1, 2].map((i) => {
    const schlick = f0[i] + (1 - f0[i]) * Math.pow(1 - mu, 5);
    const exact = frComplex(mu, eta[i], k[i]);
    return Math.min(1, Math.max(0, schlick > 0 ? exact / schlick : 1));
  });
}

// Reads one parsed parameter ({ type, values }) as an RGB triple, or null.
function pbrtRgb(param, notes, label) {
  if (!param) return null;
  const v = param.values || [];
  if (param.type === "rgb" || param.type === "color") return v.length >= 3 ? [Number(v[0]), Number(v[1]), Number(v[2])] : null;
  if (param.type === "float" && v.length) return [Number(v[0]), Number(v[0]), Number(v[0])];
  if (param.type === "texture") { notes.push(label + " is a texture; textures are not imported, the default is used"); return null; }
  notes.push(label + " is a " + param.type + " value, which is not imported; the default is used");
  return null;
}

function pbrtFloat(param, fallback) {
  if (!param || param.type === "texture") return fallback;
  const v = Number((param.values || [])[0]);
  return Number.isFinite(v) ? v : fallback;
}

function pbrtBool(param, fallback) {
  if (!param) return fallback;
  const v = (param.values || [])[0];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return fallback;
}

// OpenPBR roughness from roughness/uroughness/vroughness/remaproughness.
// Anisotropic alphas are averaged, with a note.
export function pbrtMaterialRoughness(params, notes = []) {
  const p = params || {};
  if (p.roughness && p.roughness.type === "texture") notes.push("roughness is a texture; textures are not imported");
  const base = pbrtFloat(p.roughness, 0);
  const u = pbrtFloat(p.uroughness, base);
  const v = pbrtFloat(p.vroughness, base);
  const remap = pbrtBool(p.remaproughness, true);
  const au = remap ? Math.sqrt(Math.max(0, u)) : Math.max(0, u);
  const av = remap ? Math.sqrt(Math.max(0, v)) : Math.max(0, v);
  if (Math.abs(au - av) > 1e-9) notes.push("anisotropic roughness (u " + u + ", v " + v + ") is averaged");
  return Math.min(1, Math.sqrt((au + av) / 2));
}

// A conductor's eta or k: rgb, a named "metal-X-eta/k" spectrum, or the
// pbrt default (copper).
function pbrtConductorChannel(param, which, notes) {
  if (!param) return PBRT_NAMED_METALS.Cu[which];
  const first = (param.values || [])[0];
  if (param.type === "spectrum" && typeof first === "string") {
    const m = /^metal-([A-Za-z0-9]+)-(eta|k)$/.exec(first);
    if (m && PBRT_NAMED_METALS[m[1]]) return PBRT_NAMED_METALS[m[1]][m[2]];
    notes.push("unknown named spectrum \"" + first + "\" for " + which + ", copper is used");
    return PBRT_NAMED_METALS.Cu[which];
  }
  return pbrtRgb(param, notes, which) || PBRT_NAMED_METALS.Cu[which];
}

const PBRT_ROUGHNESS_KEYS = ["roughness", "uroughness", "vroughness", "remaproughness"];

function pbrtEta(param, notes) {
  if (param && param.type === "spectrum") { notes.push("spectral eta is not imported, 1.5 is used"); return 1.5; }
  return pbrtFloat(param, 1.5);
}

// uniform_edf emits emission_color * emission_luminance as radiance, so
// luminance 1 with color L reproduces a renderer's radiance L literally.
function setRadianceEmission(shader, emission) {
  if (Array.isArray(emission) && emission.some((v) => v !== 0)) {
    setInput(shader, "emission_color", "color3", { value: formatVector(emission, 3) });
    setInput(shader, "emission_luminance", "float", { value: "1" });
  }
}

// One MaterialX open_pbr_surface document for a pbrt-v4 material
// ({ type, params }); emission is the rgb radiance of an AreaLightSource.
export function pbrtMaterialDocument({ name, material, emission } = {}) {
  const doc = createDocument();
  const notes = [];
  const shader = doc.addNode("open_pbr_surface", "SR_" + (name || "material"), "surfaceshader");
  const type = (material && material.type) || "diffuse";
  const params = (material && material.params) || {};
  const used = new Set(["type"]);
  const take = (key) => { used.add(key); return params[key]; };
  const roughness = () => { PBRT_ROUGHNESS_KEYS.forEach((key) => used.add(key)); return pbrtMaterialRoughness(params, notes); };

  if (type === "diffuse") {
    const rgb = pbrtRgb(take("reflectance"), notes, "reflectance") || [0.5, 0.5, 0.5];
    setInput(shader, "base_color", "color3", { value: formatVector(rgb, 3) });
    setInput(shader, "specular_weight", "float", { value: "0" });
  } else if (type === "coateddiffuse") {
    const rgb = pbrtRgb(take("reflectance"), notes, "reflectance") || [0.5, 0.5, 0.5];
    const rough = roughness();
    const eta = pbrtEta(take("eta"), notes);
    for (const key of ["thickness", "albedo", "g", "maxdepth", "nsamples"]) {
      if (params[key]) { used.add(key); notes.push(key + " (coating layer) is not imported"); }
    }
    setInput(shader, "base_color", "color3", { value: formatVector(rgb, 3) });
    setInput(shader, "specular_weight", "float", { value: "0" });
    setInput(shader, "coat_weight", "float", { value: "1" });
    setInput(shader, "coat_ior", "float", { value: formatNumber(eta) });
    setInput(shader, "coat_roughness", "float", { value: formatNumber(rough) });
  } else if (type === "dielectric") {
    const rough = roughness();
    const eta = pbrtEta(take("eta"), notes);
    setInput(shader, "base_color", "color3", { value: "1, 1, 1" });
    setInput(shader, "transmission_weight", "float", { value: "1" });
    setInput(shader, "specular_ior", "float", { value: formatNumber(eta) });
    setInput(shader, "specular_roughness", "float", { value: formatNumber(rough) });
  } else if (type === "conductor") {
    const rough = roughness();
    const reflectance = take("reflectance");
    const etaParam = take("eta");
    const kParam = take("k");
    setInput(shader, "base_metalness", "float", { value: "1" });
    if (reflectance) {
      const rgb = pbrtRgb(reflectance, notes, "reflectance") || [1, 1, 1];
      setInput(shader, "base_color", "color3", { value: formatVector(rgb, 3) });
    } else {
      const eta = pbrtConductorChannel(etaParam, "eta", notes);
      const k = pbrtConductorChannel(kParam, "k", notes);
      setInput(shader, "base_color", "color3", { value: formatVector(conductorF0(eta, k), 3) });
      setInput(shader, "specular_color", "color3", { value: formatVector(conductorF82Tint(eta, k), 3) });
    }
    setInput(shader, "specular_roughness", "float", { value: formatNumber(rough) });
  } else {
    notes.push("material type \"" + type + "\" is not supported, a grey diffuse is used");
    for (const key of Object.keys(params)) used.add(key);
    setInput(shader, "base_color", "color3", { value: "0.5, 0.5, 0.5" });
    setInput(shader, "specular_weight", "float", { value: "0" });
  }
  for (const key of Object.keys(params)) {
    if (!used.has(key)) notes.push("parameter \"" + key + "\" is not imported");
  }

  setRadianceEmission(shader, emission);

  const result = finish(doc, shader, "M_" + (name || "material"));
  return { xml: result.xml, materialName: result.materialName, shaderName: result.shaderName, notes };
}

// ---------------------------------------------------------------- Mitsuba

// Mitsuba's named IORs (include/mitsuba/render/ior.h).
export const MITSUBA_NAMED_IORS = {
  "vacuum": 1.0, "helium": 1.000036, "hydrogen": 1.000132, "air": 1.000277,
  "carbon dioxide": 1.00045, "water": 1.333, "acetone": 1.36, "ethanol": 1.361,
  "carbon tetrachloride": 1.461, "glycerol": 1.4729, "benzene": 1.501, "silicone oil": 1.52045,
  "bromine": 1.661, "water ice": 1.31, "fused quartz": 1.458, "pyrex": 1.47,
  "acrylic glass": 1.49, "polypropylene": 1.49, "bk7": 1.5046, "sodium chloride": 1.544,
  "amber": 1.55, "pet": 1.575, "diamond": 2.419,
};

// Mitsuba alpha is the microfacet alpha; OpenPBR roughness r has alpha = r^2.
export function mitsubaAlphaToOpenPbr(alpha) {
  return Math.min(1, Math.sqrt(Math.max(0, Number(alpha) || 0)));
}

// An IOR property: a float, or a name from the table (unknown names: 1.5).
export function mitsubaIor(prop, fallback, notes = [], label = "ior") {
  if (!prop) return fallback;
  if (prop.type === "string") {
    const key = String(prop.value).trim().toLowerCase();
    if (MITSUBA_NAMED_IORS[key] !== undefined) return MITSUBA_NAMED_IORS[key];
    notes.push(label + ': unknown IOR name "' + prop.value + '", 1.5 is used');
    return 1.5;
  }
  const v = Number(prop.value);
  return Number.isFinite(v) ? v : fallback;
}

function mitsubaRgb(prop, fallback, notes, label) {
  if (!prop) return fallback;
  if (prop.type === "rgb") return prop.value.slice(0, 3).map(Number);
  if (prop.type === "float") return [prop.value, prop.value, prop.value].map(Number);
  if (prop.type === "texture") { notes.push(label + " is a " + (prop.plugin || "texture") + " texture; textures are not imported, the default is used"); return fallback; }
  notes.push(label + " is a " + prop.type + " value, which is not imported; the default is used");
  return fallback;
}

// OpenPBR roughness from alpha or alpha_u/alpha_v (averaged, with a note).
export function mitsubaMaterialRoughness(props, fallbackAlpha, notes = []) {
  const p = props || {};
  const read = (key) => {
    const v = p[key];
    if (v && v.type === "texture") { notes.push(key + " is a texture; textures are not imported"); return null; }
    return v ? Number(v.value) : null;
  };
  const base = read("alpha");
  const au = read("alpha_u") ?? base ?? fallbackAlpha;
  const av = read("alpha_v") ?? base ?? fallbackAlpha;
  if (Math.abs(au - av) > 1e-9) notes.push("anisotropic alpha (u " + au + ", v " + av + ") is averaged");
  return mitsubaAlphaToOpenPbr((au + av) / 2);
}

// A conductor's complex IOR from eta/k or a named material (relative to
// ext_eta); null means "none", Mitsuba's perfect mirror.
function mitsubaConductorIor(p, notes, legacy) {
  const ext = mitsubaIor(p.ext_eta, 1, notes, "ext_eta");
  if (p.eta || p.k) {
    const eta = mitsubaRgb(p.eta, [0, 0, 0], notes, "eta");
    const k = mitsubaRgb(p.k, [1, 1, 1], notes, "k");
    return { eta: eta.map((c) => c / ext), k: k.map((c) => c / ext) };
  }
  const name = p.material ? String(p.material.value) : (legacy ? "Cu" : "none");
  if (name === "none") return null;
  let metal = PBRT_NAMED_METALS[name] || PBRT_NAMED_METALS[name.replace(/_palik$/, "")];
  if (!metal) {
    notes.push('named conductor "' + name + '" is not in the RGB table, copper is used');
    metal = PBRT_NAMED_METALS.Cu;
  }
  return { eta: metal.eta.map((c) => c / ext), k: metal.k.map((c) => c / ext) };
}

// Mitsuba's fresnel_diffuse_reflectance fit (render/fresnel.h).
function mitsubaFdrFit(eta) {
  const inv = 1 / eta;
  if (eta < 1) return 0.0636 * inv + eta * (eta * -1.4399 + 0.7099) + 0.6681;
  return 0.919317 + inv * (-3.4793 + inv * (6.75335 + inv * (-7.80989 + inv * (4.98554 + inv * -1.36881))));
}

// Unpolarized dielectric Fresnel, same as MaterialX mx_fresnel_dielectric.
function dielectricFresnel(c, eta) {
  const g2 = eta * eta + c * c - 1;
  if (g2 < 0) return 1;
  const g = Math.sqrt(g2);
  return 0.5 * ((g - c) / (g + c)) ** 2 * (1 + (((g + c) * c - 1) / ((g - c) * c + 1)) ** 2);
}

// Cosine-weighted hemisphere average of f(mu): integral of f(mu) 2 mu dmu.
function cosineAverage(f, n = 512) {
  let sum = 0;
  for (let i = 0; i < n; i++) { const mu = (i + 0.5) / n; sum += f(mu) * 2 * mu; }
  return sum / n;
}

const GGX_ALBEDO_FIT = [
  [0.1003, -0.6303, 9.748, -2.038, 29.34, -8.245, -26.44, 19.99, -5.448],
  [0.9345, -2.323, 2.229, -3.748, 1.424, -0.7684, 1.436, 0.2913, 0.6286],
  [1, -1.765, 8.263, 11.53, 28.96, -7.507, -36.11, 15.86, 33.37],
  [1, 0.2281, 15.94, -55.83, 13.08, 41.26, 54.9, 300.2, -285.1],
];

// Hemispherical albedo of OpenPBR's dielectric specular layer as MaterialX
// renders it: mx_ggx_dir_albedo_analytic times mx_ggx_energy_compensation.
export function openPbrDielectricAlbedo(eta, alpha) {
  const y = Math.min(1, Math.max(alpha, 1e-8)), y2 = y * y;
  const f0 = ((eta - 1) / (eta + 1)) ** 2;
  return cosineAverage((x) => {
    const x2 = x * x;
    const r = GGX_ALBEDO_FIT.map((k) => k[0] + k[1] * x + k[2] * y + k[3] * x * y + k[4] * x2 + k[5] * y2 + k[6] * x2 * y + k[7] * x * y2 + k[8] * x2 * y2);
    const a = Math.min(1, Math.max(0, r[0] / r[2])), b = Math.min(1, Math.max(0, r[1] / r[3]));
    return (f0 * a + b) * (1 + dielectricFresnel(x, eta) * (1 - (a + b)) / (a + b));
  });
}

// base_color whose OpenPBR diffuse albedo b (1 - E_spec) matches Mitsuba 3 plastic's
// R / (1 - k Fdr_int) (1 - Fdr_ext)^2 / eta^2 (k = R if nonlinear, else 1); per channel,
// clamped to [0, 1]. roughplastic is approximated with the smooth interface terms.
export function mitsubaPlasticBaseColor(rgb, eta, alpha = 0, nonlinear = false) {
  const fdrInt = mitsubaFdrFit(1 / eta);
  const tExt = 1 - cosineAverage((mu) => dielectricFresnel(mu, eta));
  const scale = (tExt * tExt) / (eta * eta) / (1 - openPbrDielectricAlbedo(eta, alpha));
  let clamped = 0;
  const color = rgb.map((r) => {
    const b = (r / (1 - (nonlinear ? r : 1) * fdrInt)) * scale;
    if (b > 1 || b < 0) clamped++;
    return Math.min(1, Math.max(0, b));
  });
  return { color, clamped };
}

const MITSUBA_SILENT_KEYS = ["distribution", "sample_visible"];

// One open_pbr_surface document for a Mitsuba bsdf ({ type, props }, already
// unwrapped from twosided); emission is an area emitter's rgb radiance.
// legacy marks pre-2.0 files, whose conductor default material is Cu.
export function mitsubaMaterialDocument({ name, bsdf, emission, legacy = false } = {}) {
  const doc = createDocument();
  const notes = [];
  const shader = doc.addNode("open_pbr_surface", "SR_" + (name || "material"), "surfaceshader");
  const type = (bsdf && bsdf.type) || "diffuse";
  const props = (bsdf && bsdf.props) || {};
  const used = new Set(MITSUBA_SILENT_KEYS);
  const take = (key) => { used.add(key); return props[key]; };
  const rough = type.startsWith("rough");
  const roughness = () => {
    ["alpha", "alpha_u", "alpha_v"].forEach((k) => used.add(k));
    return rough ? mitsubaMaterialRoughness(props, 0.1, notes) : 0;
  };
  const checkDistribution = () => {
    const d = props.distribution ? String(props.distribution.value) : "beckmann";
    if (rough && d === "beckmann") notes.push("the Beckmann distribution is rendered with the GGX of OpenPBR");
  };
  const setColor = (input, rgb) => setInput(shader, input, "color3", { value: formatVector(rgb, 3) });
  const setFloat = (input, v) => setInput(shader, input, "float", { value: formatNumber(v) });
  const notWhite = (rgb) => rgb.some((c) => c !== 1);

  if (type === "diffuse") {
    setColor("base_color", mitsubaRgb(take("reflectance"), [0.5, 0.5, 0.5], notes, "reflectance"));
    setFloat("specular_weight", 0);
  } else if (type === "plastic" || type === "roughplastic") {
    const base = mitsubaRgb(take("diffuse_reflectance"), [0.5, 0.5, 0.5], notes, "diffuse_reflectance");
    const spec = mitsubaRgb(take("specular_reflectance"), [1, 1, 1], notes, "specular_reflectance");
    const ior = mitsubaIor(take("int_ior"), 1.49, notes, "int_ior") / mitsubaIor(take("ext_ior"), 1.000277, notes, "ext_ior");
    const nonlinear = take("nonlinear");
    checkDistribution();
    const specRoughness = roughness();
    const matched = mitsubaPlasticBaseColor(base, ior, specRoughness * specRoughness, !!(nonlinear && nonlinear.value === true));
    if (matched.clamped) notes.push("diffuse_reflectance needs an albedo outside OpenPBR's base_color range in " + matched.clamped + " channel(s), clamped");
    setColor("base_color", matched.color);
    setFloat("specular_weight", 1);
    if (notWhite(spec)) setColor("specular_color", spec);
    setFloat("specular_ior", ior);
    setFloat("specular_roughness", specRoughness);
  } else if (type === "dielectric" || type === "roughdielectric" || type === "thindielectric") {
    const ior = mitsubaIor(take("int_ior"), 1.5046, notes, "int_ior") / mitsubaIor(take("ext_ior"), 1.000277, notes, "ext_ior");
    const spec = mitsubaRgb(take("specular_reflectance"), [1, 1, 1], notes, "specular_reflectance");
    const trans = mitsubaRgb(take("specular_transmittance"), [1, 1, 1], notes, "specular_transmittance");
    checkDistribution();
    setColor("base_color", [1, 1, 1]);
    setFloat("transmission_weight", 1);
    if (notWhite(trans)) setColor("transmission_color", trans);
    if (notWhite(spec)) setColor("specular_color", spec);
    setFloat("specular_ior", ior);
    setFloat("specular_roughness", roughness());
    if (type === "thindielectric") setFloat("geometry_thin_walled", 1);
  } else if (type === "conductor" || type === "roughconductor") {
    ["material", "eta", "k", "ext_eta"].forEach((k) => used.add(k));
    const ior = mitsubaConductorIor(props, notes, legacy);
    const spec = mitsubaRgb(take("specular_reflectance"), [1, 1, 1], notes, "specular_reflectance");
    checkDistribution();
    setFloat("base_metalness", 1);
    if (!ior) {
      setColor("base_color", spec);
    } else {
      setColor("base_color", conductorF0(ior.eta, ior.k).map((c, i) => c * spec[i]));
      setColor("specular_color", conductorF82Tint(ior.eta, ior.k));
    }
    setFloat("specular_roughness", roughness());
  } else {
    notes.push('bsdf "' + type + '" is not supported, a grey diffuse is used');
    for (const key of Object.keys(props)) used.add(key);
    setColor("base_color", [0.5, 0.5, 0.5]);
    setFloat("specular_weight", 0);
  }
  for (const key of Object.keys(props)) {
    if (!used.has(key)) notes.push('parameter "' + key + '" is not imported');
  }
  setRadianceEmission(shader, emission);

  const result = finish(doc, shader, "M_" + (name || "material"));
  return { xml: result.xml, materialName: result.materialName, shaderName: result.shaderName, notes };
}
