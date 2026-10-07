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
export const PBRT_NAMED_METALS = {
  Ag: { eta: [0.1552646489, 0.1167232965, 0.1383806959], k: [4.8283433224, 3.1222459278, 2.1469504455] },
  Al: { eta: [1.6574599595, 0.8803689579, 0.5212287346], k: [9.2238691996, 6.2695232477, 4.8370012281] },
  Au: { eta: [0.1431189557, 0.3749570432, 1.4424785571], k: [3.9831604247, 2.3857207478, 1.6032152899] },
  Cu: { eta: [0.2004376970, 0.9240334304, 1.1022119527], k: [3.9129485033, 2.4528477015, 2.1421879552] },
  // pbrt-v4 metal-CuZn-eta/-k (spectrum.cpp) integrated like Tungsten's rows: CIE 1931 / sum(y), XYZ to linear sRGB.
  CuZn: { eta: [0.5197690597, 0.4885060235, 1.0420098075], k: [4.3305825766, 2.5481059654, 1.5918905964] },
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

// ------------------------------------------------- renderer texture graphs

// Format-neutral textures from the pbrt and Mitsuba importers, { kind }: constant, image,
// scale, mix, checker (even floor(u) + floor(v) picks tex1) or unsupported. uv is null or
// [a, b, c, d, e, f]: u' = a u + c v + e, v' = b u + d v + f, MaterialX v (0 at the bottom).

// Calls fn on every image texture inside a texture description.
export function forEachImageTexture(spec, fn, depth = 0) {
  if (!spec || typeof spec !== "object" || depth > 32) return;
  if (spec.kind === "image") { fn(spec); return; }
  for (const key of ["tex", "scale", "tex1", "tex2", "amount"]) {
    if (spec[key] && typeof spec[key] === "object") forEachImageTexture(spec[key], fn, depth + 1);
  }
}

// Graph values: { k } is a folded constant (number or rgb), { n, t } a node output
// of type "float" or "color3". Constants fold in JS, so untextured documents stay plain.
const isK = (x) => x && x.k !== undefined;
const typeOf = (x) => (isK(x) ? (Array.isArray(x.k) ? "color3" : "float") : x.t);

function setOperand(node, input, type, x) {
  if (!isK(x)) return connect(node, input, type, x.n);
  const k = x.k;
  return setInput(node, input, type, {
    value: type === "color3" ? formatVector(Array.isArray(k) ? k : [k, k, k], 3) : formatNumber(Array.isArray(k) ? k[0] : k),
  });
}

function asColor(ctx, x) {
  if (isK(x)) return Array.isArray(x.k) ? x : { k: [x.k, x.k, x.k] };
  if (x.t === "color3") return x;
  const n = ctx.doc.addNode("convert", "to_color", "color3");
  connect(n, "in", "float", x.n);
  return { n, t: "color3" };
}

function asFloat(ctx, x) {
  if (isK(x)) return Array.isArray(x.k) ? { k: x.k[0] } : x;
  if (x.t === "float") return x;
  const n = ctx.doc.addNode("extract", "channel", "float");
  connect(n, "in", "color3", x.n);
  setInput(n, "index", "integer", { value: "0", uniform: "true" });
  return { n, t: "float" };
}

const asType = (ctx, x, type) => (type === "color3" ? asColor(ctx, x) : asFloat(ctx, x));
const foldK = (type, a, b, fn) => (type === "color3"
  ? [0, 1, 2].map((i) => fn(Array.isArray(a) ? a[i] : a, Array.isArray(b) ? b[i] : b))
  : fn(Array.isArray(a) ? a[0] : a, Array.isArray(b) ? b[0] : b));
const BINARY = { power: Math.pow, multiply: (a, b) => a * b, add: (a, b) => a + b, subtract: (a, b) => a - b, divide: (a, b) => a / b, min: Math.min, max: Math.max };

function binary(ctx, category, a, b, name) {
  const type = typeOf(a) === "color3" || typeOf(b) === "color3" ? "color3" : "float";
  if (isK(a) && isK(b)) return { k: foldK(type, a.k, b.k, BINARY[category]) };
  const n = ctx.doc.addNode(category, name || category, type);
  setOperand(n, "in1", type, asType(ctx, a, type));
  setOperand(n, "in2", type, asType(ctx, b, type));
  return { n, t: type };
}

function sqrtOp(ctx, x, name) {
  const f = asFloat(ctx, x);
  if (isK(f)) return { k: Math.sqrt(f.k) };
  const n = ctx.doc.addNode("sqrt", name || "sqrt", "float");
  setOperand(n, "in", "float", f);
  return { n, t: "float" };
}

function clampOp(ctx, x, lo, hi, name) {
  const type = typeOf(x);
  if (isK(x)) return { k: foldK(type, x.k, 0, (v) => Math.min(hi, Math.max(lo, v))) };
  const n = ctx.doc.addNode("clamp", name || "clamp", type);
  setOperand(n, "in", type, x);
  setOperand(n, "low", type, { k: lo });
  setOperand(n, "high", type, { k: hi });
  return { n, t: type };
}

function mixOp(ctx, bg, fg, amount, type, name) {
  const b = asType(ctx, bg, type), f = asType(ctx, fg, type), m = asFloat(ctx, amount);
  if (isK(b) && isK(f) && isK(m)) return { k: foldK(type, b.k, f.k, (x, y) => x * (1 - m.k) + y * m.k) };
  const n = ctx.doc.addNode("mix", name || "mix", type);
  setOperand(n, "fg", type, f);
  setOperand(n, "bg", type, b);
  setOperand(n, "mix", "float", m);
  return { n, t: type };
}

const isIdentityUv = (m) => !Array.isArray(m) || (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0);

function texcoordNode(ctx) {
  if (!ctx.texcoord) ctx.texcoord = ctx.doc.addNode("texcoord", "texcoord", "vector2");
  return ctx.texcoord;
}

// vector2 node of an affine uv map, one per distinct map; null for the identity
// unless force (then the plain texcoord node).
function uvNode(ctx, m, force = false) {
  if (isIdentityUv(m)) return force ? texcoordNode(ctx) : null;
  const key = m.map(formatNumber).join(",");
  ctx.uvNodes = ctx.uvNodes || new Map();
  if (ctx.uvNodes.has(key)) return ctx.uvNodes.get(key);
  const [a, b, c, d, e, f] = m;
  const tc = texcoordNode(ctx);
  let out = tc;
  if (b === 0 && c === 0) {
    if (a !== 1 || d !== 1) {
      out = ctx.doc.addNode("multiply", "uv_scale", "vector2");
      connect(out, "in1", "vector2", tc);
      setInput(out, "in2", "vector2", { value: formatVector([a, d], 2) });
    }
  } else {
    const row = (name, coeffs) => {
      const dot = ctx.doc.addNode("dotproduct", name, "float");
      connect(dot, "in1", "vector2", tc);
      setInput(dot, "in2", "vector2", { value: formatVector(coeffs, 2) });
      return dot;
    };
    const du = row("uv_u", [a, c]), dv = row("uv_v", [b, d]);
    out = ctx.doc.addNode("combine2", "uv_affine", "vector2");
    connect(out, "in1", "float", du);
    connect(out, "in2", "float", dv);
  }
  if (e !== 0 || f !== 0) {
    const add = ctx.doc.addNode("add", "uv_offset", "vector2");
    connect(add, "in1", "vector2", out);
    setInput(add, "in2", "vector2", { value: formatVector([e, f], 2) });
    out = add;
  }
  ctx.uvNodes.set(key, out);
  return out;
}

const ADDRESS_MODES = new Set(["clamp", "constant", "mirror"]);

// One image read. Float reads take the first channel, or the luminance
// (Mitsuba); a colour-managed or luminance read goes through a color3 image.
function imageOp(ctx, spec, want, label) {
  const file = ctx.textureFile ? ctx.textureFile(spec) : spec.file;
  if (!file) {
    ctx.notes.push(label + ': texture file "' + spec.file + '" could not be resolved, the default is used');
    return null;
  }
  const direct = want === "float" && spec.floatChannel !== "luminance" && !spec.colorspace;
  const type = direct ? "float" : "color3";
  const node = ctx.doc.addNode("image", label + "_image", type);
  setInput(node, "file", "filename", { value: file, colorspace: spec.colorspace || undefined, uniform: "true" });
  if (ADDRESS_MODES.has(spec.uaddress)) setInput(node, "uaddressmode", "string", { value: spec.uaddress, uniform: "true" });
  if (ADDRESS_MODES.has(spec.vaddress)) setInput(node, "vaddressmode", "string", { value: spec.vaddress, uniform: "true" });
  const uv = uvNode(ctx, spec.uv);
  if (uv) connect(node, "texcoord", "vector2", uv);
  let x = { n: ctx.doc.share(node), t: type };
  if (want === "float" && !direct) {
    if (spec.floatChannel === "luminance") {
      const lum = ctx.doc.addNode("luminance", label + "_luminance", "color3");
      connect(lum, "in", "color3", x.n);
      x = { n: lum, t: "color3" };
    }
    x = asFloat(ctx, x);
  }
  if (Number.isFinite(spec.scale) && spec.scale !== 1) x = binary(ctx, "multiply", x, { k: spec.scale }, label + "_scale");
  if (spec.invert) x = binary(ctx, "max", binary(ctx, "subtract", { k: 1 }, x, label + "_invert"), { k: 0 }, label + "_positive");
  return asType(ctx, x, want);
}

// Graph value of a texture description as want ("float" or "color3"), or
// null (with a note) when it cannot be built; the caller then uses its default.
function textureOp(ctx, spec, want, label, depth = 0) {
  if (!spec || depth > 32) { ctx.notes.push(label + ": texture is missing, the default is used"); return null; }
  switch (spec.kind) {
    case "constant": return asType(ctx, { k: spec.value }, want);
    case "image": return imageOp(ctx, spec, want, label);
    case "scale": {
      const t = textureOp(ctx, spec.tex, want, label, depth + 1);
      const s = textureOp(ctx, spec.scale, "float", label + "_factor", depth + 1);
      return t && s ? asType(ctx, binary(ctx, "multiply", t, s, label + "_scaled"), want) : null;
    }
    case "mix": {
      const a = textureOp(ctx, spec.tex1, want, label + "_a", depth + 1);
      const b = textureOp(ctx, spec.tex2, want, label + "_b", depth + 1);
      const m = textureOp(ctx, spec.amount, "float", label + "_amount", depth + 1);
      return a && b && m ? mixOp(ctx, a, b, m, want, label + "_mix") : null;
    }
    case "checker": {
      const a = textureOp(ctx, spec.tex1, want, label + "_a", depth + 1);
      const b = textureOp(ctx, spec.tex2, want, label + "_b", depth + 1);
      if (!a || !b) return null;
      const cell = ctx.doc.addNode("floor", label + "_cell", "vector2");
      connect(cell, "in", "vector2", uvNode(ctx, spec.uv, true));
      const sum = ctx.doc.addNode("dotproduct", label + "_cell_sum", "float");
      connect(sum, "in1", "vector2", cell);
      setInput(sum, "in2", "vector2", { value: "1, 1" });
      const parity = ctx.doc.addNode("modulo", label + "_parity", "float");
      connect(parity, "in1", "float", sum);
      setInput(parity, "in2", "float", { value: "2" });
      return mixOp(ctx, a, b, { n: parity, t: "float" }, want, label + "_checker");
    }
    default:
      ctx.notes.push(label + ": " + (spec.reason || "texture type is not supported") + ", the default is used");
      return null;
  }
}

// ---------------------------------------------------------------- PBRT v4

// Reads one parsed parameter ({ type, values }) as an RGB triple, or null.
function pbrtRgb(param, notes, label) {
  if (!param) return null;
  const v = param.values || [];
  if (param.type === "rgb" || param.type === "color") return v.length >= 3 ? [Number(v[0]), Number(v[1]), Number(v[2])] : null;
  if (param.type === "float" && v.length) return [Number(v[0]), Number(v[0]), Number(v[0])];
  if (param.type === "texture") { notes.push(label + " is a texture, which is not supported here; the default is used"); return null; }
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

// A pbrt texture parameter ("texture name", resolved by the loader into
// param.texture): its graph value, null (default) when unusable, undefined when not a texture.
function pbrtTextureParam(ctx, param, want, label) {
  if (!param || param.type !== "texture") return undefined;
  if (!param.texture) {
    ctx.notes.push(label + ': texture "' + (param.values || [])[0] + '" is not defined, the default is used');
    return null;
  }
  return textureOp(ctx, param.texture, want, label);
}

// The roughness above as a graph value: textured roughness builds the same
// remap, average and square root with MaterialX math nodes.
function pbrtRoughnessOp(ctx, params) {
  const p = params || {};
  if (!["roughness", "uroughness", "vroughness"].some((k) => p[k] && p[k].type === "texture")) return { k: pbrtMaterialRoughness(p, ctx.notes) };
  const textures = new Map();
  const read = (param, fallback) => {
    if (!param) return fallback;
    if (param.type === "texture" && textures.has(param.values[0])) return textures.get(param.values[0]);
    const tex = pbrtTextureParam(ctx, param, "float", "roughness");
    if (tex) textures.set(param.values[0], tex);
    if (tex !== undefined) return tex || fallback;
    const v = Number((param.values || [])[0]);
    return Number.isFinite(v) ? { k: v } : fallback;
  };
  const base = read(p.roughness, { k: 0 });
  const u = p.uroughness ? read(p.uroughness, base) : base;
  const v = p.vroughness ? read(p.vroughness, base) : base;
  const remap = pbrtBool(p.remaproughness, true);
  const alpha = (x, axis) => {
    const positive = binary(ctx, "max", x, { k: 0 }, "roughness_" + axis);
    return remap ? sqrtOp(ctx, positive, "alpha_" + axis) : positive;
  };
  let mean;
  if (u === v) mean = alpha(u, "u");
  else {
    ctx.notes.push("anisotropic roughness is averaged");
    mean = binary(ctx, "multiply", binary(ctx, "add", alpha(u, "u"), alpha(v, "v"), "alpha_sum"), { k: 0.5 }, "alpha_mean");
  }
  return binary(ctx, "min", sqrtOp(ctx, mean, "openpbr_roughness"), { k: 1 }, "roughness_clamped");
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
  if (param && param.type === "texture") { notes.push("eta is a texture, which pbrt-v4 does not accept here; 1.5 is used"); return 1.5; }
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

// One open_pbr_surface document for a pbrt-v4 material ({ type, params }); emission is
// an AreaLightSource's rgb radiance. "texture" params carry the loader's description in
// param.texture; textureFile(spec) maps an image texture to its file value.
export function pbrtMaterialDocument({ name, material, emission, textureFile } = {}) {
  const doc = createDocument();
  const notes = [];
  const ctx = { doc, notes, textureFile };
  const shader = doc.addNode("open_pbr_surface", "SR_" + (name || "material"), "surfaceshader");
  const type = (material && material.type) || "diffuse";
  const params = (material && material.params) || {};
  const used = new Set(["type"]);
  const take = (key) => { used.add(key); return params[key]; };
  const roughness = () => { PBRT_ROUGHNESS_KEYS.forEach((key) => used.add(key)); return pbrtRoughnessOp(ctx, params); };
  const color = (key, fallback) => {
    const param = take(key);
    const tex = pbrtTextureParam(ctx, param, "color3", key);
    if (tex) return tex;
    if (tex === null) return { k: fallback };
    return { k: pbrtRgb(param, notes, key) || fallback };
  };
  const set = (input, type, x) => setOperand(shader, input, type, x);

  if (type === "diffuse") {
    set("base_color", "color3", color("reflectance", [0.5, 0.5, 0.5]));
    set("specular_weight", "float", { k: 0 });
  } else if (type === "coateddiffuse") {
    const base = color("reflectance", [0.5, 0.5, 0.5]);
    const rough = roughness();
    const eta = pbrtEta(take("eta"), notes);
    const thicknessParam = take("thickness");
    if (thicknessParam && thicknessParam.type === "texture") notes.push("textured coating thickness is not imported, 0.01 is used for the albedo match");
    const thickness = Math.max(0, pbrtFloat(thicknessParam, 0.01));
    const maxDepth = pbrtFloat(take("maxdepth"), 10);
    take("nsamples");
    const albedoParam = take("albedo"), gParam = take("g");
    const albedoValues = albedoParam && (pbrtRgb(albedoParam, [], "albedo") || [1]);
    if (albedoValues && albedoValues.some((v) => Number(v) !== 0)) notes.push("the scattering coating medium (albedo, g) is not imported");
    else if (gParam && pbrtFloat(gParam, 0) !== 0) notes.push("g has no effect without a coating albedo");
    // Match pbrt's diffuse albedo (thickness, maxdepth, the coat in and out) through base_color.
    const alpha = isK(rough) ? rough.k * rough.k : 0.1;
    if (!isK(rough)) notes.push("textured roughness: the coated albedo match uses alpha 0.1");
    if (isK(base)) {
      const matched = pbrtCoatedDiffuseBaseColor(base.k, eta, alpha, thickness, maxDepth);
      if (matched.clamped) notes.push("reflectance needs an albedo outside OpenPBR's base_color range in " + matched.clamped + " channel(s), clamped");
      set("base_color", "color3", { k: matched.color.map((v) => Number(v.toFixed(6))) });
    } else {
      notes.push("textured reflectance is matched per RGB channel, without pbrt's spectral coat");
      set("base_color", "color3", pbrtCoatedDiffuseBaseColorOp(ctx, base, eta, alpha, thickness, maxDepth));
    }
    set("specular_weight", "float", { k: 0 });
    set("coat_weight", "float", { k: 1 });
    set("coat_ior", "float", { k: eta });
    set("coat_roughness", "float", rough);
  } else if (type === "dielectric") {
    const rough = roughness();
    const eta = pbrtEta(take("eta"), notes);
    set("base_color", "color3", { k: [1, 1, 1] });
    set("transmission_weight", "float", { k: 1 });
    set("specular_ior", "float", { k: eta });
    set("specular_roughness", "float", rough);
  } else if (type === "conductor") {
    const rough = roughness();
    const reflectance = params.reflectance;
    const etaParam = take("eta");
    const kParam = take("k");
    set("base_metalness", "float", { k: 1 });
    if (reflectance) {
      set("base_color", "color3", color("reflectance", [1, 1, 1]));
    } else {
      const eta = pbrtConductorChannel(etaParam, "eta", notes);
      const k = pbrtConductorChannel(kParam, "k", notes);
      set("base_color", "color3", { k: conductorF0(eta, k) });
      set("specular_color", "color3", { k: conductorF82Tint(eta, k) });
    }
    set("specular_roughness", "float", rough);
  } else {
    notes.push("material type \"" + type + "\" is not supported, a grey diffuse is used");
    for (const key of Object.keys(params)) used.add(key);
    set("base_color", "color3", { k: [0.5, 0.5, 0.5] });
    set("specular_weight", "float", { k: 0 });
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
  if (prop.type === "texture") { notes.push(label + " is a texture, which Mitsuba does not accept here; the default is used"); return fallback; }
  const v = Number(prop.value);
  return Number.isFinite(v) ? v : fallback;
}

function mitsubaRgb(prop, fallback, notes, label) {
  if (!prop) return fallback;
  if (prop.type === "rgb") return prop.value.slice(0, 3).map(Number);
  if (prop.type === "float") return [prop.value, prop.value, prop.value].map(Number);
  if (prop.type === "texture") { notes.push(label + " is a " + (prop.plugin || "texture") + " texture, which is not imported; the default is used"); return fallback; }
  notes.push(label + " is a " + prop.type + " value, which is not imported; the default is used");
  return fallback;
}

// A Mitsuba colour property as a graph value: a texture (prop.spec, built by
// the loader) or a constant.
function mitsubaColorOp(ctx, prop, fallback, label) {
  if (prop && prop.type === "texture" && prop.spec) return textureOp(ctx, prop.spec, "color3", label) || { k: fallback };
  return { k: mitsubaRgb(prop, fallback, ctx.notes, label) };
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

// The roughness above as a graph value; textured alphas build the average and
// square root with MaterialX math nodes.
function mitsubaRoughnessOp(ctx, props, fallbackAlpha) {
  const p = props || {};
  const keys = ["alpha", "alpha_u", "alpha_v"];
  if (!keys.some((k) => p[k] && p[k].type === "texture" && p[k].spec)) return { k: mitsubaMaterialRoughness(p, fallbackAlpha, ctx.notes) };
  const read = (key) => {
    const v = p[key];
    if (!v) return null;
    if (v.type === "texture") return v.spec ? textureOp(ctx, v.spec, "float", key) : (ctx.notes.push(key + " is a texture, which is not imported"), null);
    const n = Number(v.value);
    return { k: Number.isFinite(n) ? n : 0 };
  };
  const base = read("alpha");
  const au = read("alpha_u") ?? base ?? { k: fallbackAlpha };
  const av = read("alpha_v") ?? base ?? { k: fallbackAlpha };
  let mean = au;
  if (au !== av) {
    ctx.notes.push("anisotropic alpha is averaged");
    mean = binary(ctx, "multiply", binary(ctx, "add", au, av, "alpha_sum"), { k: 0.5 }, "alpha_mean");
  }
  const positive = binary(ctx, "max", mean, { k: 0 }, "alpha_positive");
  return binary(ctx, "min", sqrtOp(ctx, positive, "openpbr_roughness"), { k: 1 }, "roughness_clamped");
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
  return cosineAverage((x) => openPbrDielectricDirAlbedo(x, eta, alpha));
}

// The same albedo for one view cosine x (the layer throughput is 1 minus this).
export function openPbrDielectricDirAlbedo(x, eta, alpha) {
  const y = Math.min(1, Math.max(alpha, 1e-8)), y2 = y * y, x2 = x * x;
  const f0 = ((eta - 1) / (eta + 1)) ** 2;
  const r = GGX_ALBEDO_FIT.map((k) => k[0] + k[1] * x + k[2] * y + k[3] * x * y + k[4] * x2 + k[5] * y2 + k[6] * x2 * y + k[7] * x * y2 + k[8] * x2 * y2);
  const a = Math.min(1, Math.max(0, r[0] / r[2])), b = Math.min(1, Math.max(0, r[1] / r[3]));
  return (f0 * a + b) * (1 + dielectricFresnel(x, eta) * (1 - (a + b)) / (a + b));
}

// ---------------------------------------------------------------- pbrt coateddiffuse

// Smith Lambda of pbrt's TrowbridgeReitzDistribution (isotropic alpha) at cosine mu.
function ggxLambda(mu, alpha) {
  const tan2 = (1 - mu * mu) / Math.max(mu * mu, 1e-12);
  return (Math.sqrt(1 + alpha * alpha * tan2) - 1) / 2;
}

// pbrt's DielectricBxDF hit at cosine mu (relative ior eta), integrated over visible
// normals (n x n stratified, Heitz 2018 sampling as in pbrt's Sample_wm). Calls
// visit(weight, |cos out|, reflected) for every reflected or refracted direction kept.
function pbrtDielectricScatter(mu, eta, alpha, visit, n = 32) {
  const s = Math.sqrt(Math.max(0, 1 - mu * mu));
  let vx = alpha * s, vz = mu;
  const vl = Math.hypot(vx, vz); vx /= vl; vz /= vl;
  const lamO = ggxLambda(mu, alpha), g1 = 1 / (1 + lamO), w = 1 / (n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const r = Math.sqrt((i + 0.5) / n), phi = 2 * Math.PI * (j + 0.5) / n;
      const t1 = r * Math.cos(phi), h = Math.sqrt(Math.max(0, 1 - t1 * t1)), q = 0.5 * (1 + vz);
      const t2 = (1 - q) * h + q * r * Math.sin(phi), t3 = Math.sqrt(Math.max(0, 1 - t1 * t1 - t2 * t2));
      // T1 = (0, 1, 0), T2 = vh x T1 = (-vz, 0, vx); visible normal back to the ellipsoid.
      let mx = alpha * (-t2 * vz + t3 * vx), my = alpha * t1, mz = Math.max(1e-6, t2 * vx + t3 * vz);
      const ml = Math.hypot(mx, my, mz); mx /= ml; my /= ml; mz /= ml;
      const c = s * mx + mu * mz, F = dielectricFresnel(c, eta);
      const rz = 2 * c * mz - mu;
      if (rz > 0) visit(F / (1 + lamO + ggxLambda(rz, alpha)) / g1 * w, rz, true);
      const sin2t = (1 - c * c) / (eta * eta);
      if (sin2t < 1) {
        const tz = -mu / eta + (c / eta - Math.sqrt(1 - sin2t)) * mz;
        if (tz < 0) visit((1 - F) / (1 + lamO + ggxLambda(-tz, alpha)) / g1 * w, -tz, false);
      }
    }
  }
}

const pbrtCoatTermsCache = new Map();

// Constants of pbrt-v4's CoatedDiffuseBxDF (bxdfs.h LayeredBxDF, albedo 0) seen head-on:
// t0 enters and crosses the slab once, e leaves after a Lambertian bounce, k returns to
// the base (internal reflection, two crossings); each crossing is exp(-thickness/|cos|).
export function pbrtCoatedDiffuseTerms(eta, alpha, thickness) {
  const key = eta + "|" + alpha + "|" + thickness;
  if (pbrtCoatTermsCache.has(key)) return pbrtCoatTermsCache.get(key);
  const tr = (mu) => Math.exp(-thickness / Math.max(mu, 1e-9));
  let terms;
  if (alpha < 1e-3) {
    // EffectivelySmooth: perfect specular interface.
    const fi = (mu) => dielectricFresnel(mu, 1 / eta);
    terms = {
      t0: (1 - dielectricFresnel(1, eta)) * Math.exp(-thickness),
      e: cosineAverage((mu) => tr(mu) * (1 - fi(mu)), 2048),
      k: cosineAverage((mu) => tr(mu) * tr(mu) * fi(mu), 2048),
    };
  } else {
    let t0 = 0, e = 0, k = 0;
    pbrtDielectricScatter(1, eta, alpha, (w, mu, refl) => { if (!refl) t0 += w * tr(mu); });
    const nmu = 32;
    for (let i = 0; i < nmu; i++) {
      const mu = Math.sqrt((i + 0.5) / nmu); // cosine-distributed internal directions
      pbrtDielectricScatter(mu, 1 / eta, alpha, (w, out, refl) => {
        if (refl) k += tr(mu) * w * tr(out) / nmu; else e += tr(mu) * w / nmu;
      });
    }
    terms = { t0, e, k };
  }
  pbrtCoatTermsCache.set(key, terms);
  return terms;
}

// Diffuse albedo leaving pbrt's coateddiffuse head-on in a white furnace: maxdepth
// steps of the random walk give ceil(maxdepth / 2) base bounces (geometric series cut).
export function pbrtCoatedDiffuseAlbedo(R, eta, alpha, thickness, maxDepth = 10) {
  const { t0, e, k } = pbrtCoatedDiffuseTerms(eta, alpha, thickness);
  let sum = 0, x = 1;
  for (let i = 0; i < pbrtCoatBounces(maxDepth); i++) { sum += x; x *= R * k; }
  return t0 * e * R * sum;
}

const pbrtCoatBounces = (maxDepth) => Math.min(1000, Math.max(1, Math.ceil(maxDepth / 2)));

// OpenPBR's head-on diffuse albedo under coat_weight 1 (open_pbr_surface.mtlx, 1.39.5):
// b (1 - Kcoat) / (1 - b Kcoat) times the coat layer throughput 1 - E_coat(1).
export function openPbrCoatTerms(eta, alpha) {
  const kc = 1 - (1 - ((eta - 1) / (eta + 1)) ** 2) / (eta * eta);
  return { c: (1 - openPbrDielectricDirAlbedo(1, eta, alpha)) * (1 - kc), kc };
}

// base_color whose OpenPBR albedo matches pbrt's coateddiffuse with reflectance R: the
// pbrt series in R, (1 - (R k)^n) / (1 - R k), then b = D / (c + Kcoat D), clamped to [0, 1]. Works on
// constants (folded) and on texture graphs alike.
function pbrtCoatedDiffuseBaseColorOp(ctx, base, eta, alpha, thickness, maxDepth) {
  const { t0, e, k } = pbrtCoatedDiffuseTerms(eta, alpha, thickness);
  const { c, kc } = openPbrCoatTerms(eta, alpha);
  const rk = binary(ctx, "multiply", base, { k: k }, "coat_rk");
  const cut = binary(ctx, "subtract", { k: 1 }, binary(ctx, "power", rk, { k: pbrtCoatBounces(maxDepth) }, "coat_rk_n"), "coat_cut");
  const series = binary(ctx, "divide", cut, binary(ctx, "subtract", { k: 1 }, rk, "coat_one_minus_rk"), "coat_series");
  const d = binary(ctx, "multiply", binary(ctx, "multiply", base, { k: t0 * e }, "coat_entry"), series, "coat_albedo");
  const denom = binary(ctx, "add", { k: c }, binary(ctx, "multiply", d, { k: kc }, "coat_darkening"), "coat_denominator");
  return clampOp(ctx, binary(ctx, "divide", d, denom, "coat_base_raw"), 0, 1, "coat_base_color");
}

// CIE 1931 2-degree observer, CIE D65 and the sRGB matrices at 5 nm over 360..830 nm,
// as tabulated in pbrt-v4's src/pbrt/cmd/rgb2spec_opt.cpp (cie_x/y/z, cie_d65).
const PBRT_CIE = {
  X: [0.0001299, 0.0002321, 0.0004149, 0.0007416, 0.001368, 0.002236, 0.004243, 0.00765, 0.01431, 0.02319, 0.04351, 0.07763, 0.13438, 0.21477, 0.2839, 0.3285, 0.34828, 0.34806, 0.3362, 0.3187, 0.2908, 0.2511, 0.19536, 0.1421, 0.09564, 0.05795, 0.03201, 0.0147, 0.0049, 0.0024, 0.0093, 0.0291, 0.06327, 0.1096, 0.1655, 0.22575, 0.2904, 0.3597, 0.43345, 0.51205, 0.5945, 0.6784, 0.7621, 0.8425, 0.9163, 0.9786, 1.0263, 1.0567, 1.0622, 1.0456, 1.0026, 0.9384, 0.85445, 0.7514, 0.6424, 0.5419, 0.4479, 0.3608, 0.2835, 0.2187, 0.1649, 0.1212, 0.0874, 0.0636, 0.04677, 0.0329, 0.0227, 0.01584, 0.0113592, 0.00811092, 0.00579035, 0.00410946, 0.00289933, 0.00204919, 0.00143997, 0.000999949, 0.000690079, 0.000476021, 0.000332301, 0.000234826, 0.000166151, 0.000117413, 8.30753e-05, 5.87065e-05, 4.15099e-05, 2.93533e-05, 2.06738e-05, 1.45598e-05, 1.0254e-05, 7.22146e-06, 5.08587e-06, 3.58165e-06, 2.52253e-06, 1.77651e-06, 1.25114e-06],
  Y: [3.917e-06, 6.965e-06, 1.239e-05, 2.202e-05, 3.9e-05, 6.4e-05, 0.00012, 0.000217, 0.000396, 0.00064, 0.00121, 0.00218, 0.004, 0.0073, 0.0116, 0.01684, 0.023, 0.0298, 0.038, 0.048, 0.06, 0.0739, 0.09098, 0.1126, 0.13902, 0.1693, 0.20802, 0.2586, 0.323, 0.4073, 0.503, 0.6082, 0.71, 0.7932, 0.862, 0.91485, 0.954, 0.9803, 0.99495, 1, 0.995, 0.9786, 0.952, 0.9154, 0.87, 0.8163, 0.757, 0.6949, 0.631, 0.5668, 0.503, 0.4412, 0.381, 0.321, 0.265, 0.217, 0.175, 0.1382, 0.107, 0.0816, 0.061, 0.04458, 0.032, 0.0232, 0.017, 0.01192, 0.00821, 0.005723, 0.004102, 0.002929, 0.002091, 0.001484, 0.001047, 0.00074, 0.00052, 0.0003611, 0.0002492, 0.0001719, 0.00012, 8.48e-05, 6e-05, 4.24e-05, 3e-05, 2.12e-05, 1.499e-05, 1.06e-05, 7.4657e-06, 5.2578e-06, 3.7029e-06, 2.6078e-06, 1.8366e-06, 1.2934e-06, 9.1093e-07, 6.4153e-07, 4.5181e-07],
  Z: [0.0006061, 0.001086, 0.001946, 0.003486, 0.00645, 0.01055, 0.02005, 0.03621, 0.06785, 0.1102, 0.2074, 0.3713, 0.6456, 1.03905, 1.3856, 1.62296, 1.74706, 1.7826, 1.77211, 1.7441, 1.6692, 1.5281, 1.28764, 1.0419, 0.81295, 0.6162, 0.46518, 0.3533, 0.272, 0.2123, 0.1582, 0.1117, 0.07825, 0.05725, 0.04216, 0.02984, 0.0203, 0.0134, 0.00875, 0.00575, 0.0039, 0.00275, 0.0021, 0.0018, 0.00165, 0.0014, 0.0011, 0.001, 0.0008, 0.0006, 0.00034, 0.00024, 0.00019, 0.0001, 5e-05, 3e-05, 2e-05, 1e-05, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  D65: [46.6383, 49.3637, 52.0891, 51.0323, 49.9755, 52.3118, 54.6482, 68.7015, 82.7549, 87.1204, 91.486, 92.4589, 93.4318, 90.057, 86.6823, 95.7736, 104.865, 110.936, 117.008, 117.41, 117.812, 116.336, 114.861, 115.392, 115.923, 112.367, 108.811, 109.082, 109.354, 108.578, 107.802, 106.296, 104.79, 106.239, 107.689, 106.047, 104.405, 104.225, 104.046, 102.023, 100, 98.1671, 96.3342, 96.0611, 95.788, 92.2368, 88.6856, 89.3459, 90.0062, 89.8026, 89.5991, 88.6489, 87.6987, 85.4936, 83.2886, 83.4939, 83.6992, 81.863, 80.0268, 80.1207, 80.2146, 81.2462, 82.2778, 80.281, 78.2842, 74.0027, 69.7213, 70.6652, 71.6091, 72.979, 74.349, 67.9765, 61.604, 65.7448, 69.8856, 72.4863, 75.087, 69.3398, 63.5927, 55.0054, 46.4182, 56.6118, 66.8054, 65.0941, 63.3828, 63.8434, 64.304, 61.8779, 59.4519, 55.7054, 51.959, 54.6998, 57.4406, 58.8765, 60.3125],
  XYZ_TO_SRGB: [3.24048, -1.53715, -0.498535, -0.969256, 1.87599, 0.041556, 0.055648, -0.204043, 1.05731],
  SRGB_TO_XYZ: [0.412453, 0.35758, 0.180423, 0.212671, 0.71516, 0.072169, 0.019334, 0.119193, 0.950227],
};

let pbrtSpectralTables = null;

// rgb2spec_opt.cpp init_tables(SRGB): Simpson 3/8 weights on the 3x refined grid,
// sRGB response per sample under D65, normalized so a flat spectrum maps to white.
function pbrtSpectral() {
  if (pbrtSpectralTables) return pbrtSpectralTables;
  const n = 94 * 3 + 1, h = 470 / (n - 1);
  const interp = (data, l) => {
    const x = (l - 360) / 5, o = Math.min(93, Math.max(0, Math.floor(x))), f = x - o;
    return (1 - f) * data[o] + f * data[o + 1];
  };
  const M = PBRT_CIE.XYZ_TO_SRGB, rgb = [[], [], []], lt = [], wp = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const l = 360 + i * h, I = interp(PBRT_CIE.D65, l);
    let w = (3 / 8) * h * (i === 0 || i === n - 1 ? 1 : (i - 1) % 3 === 2 ? 2 : 3);
    const xyz = [interp(PBRT_CIE.X, l), interp(PBRT_CIE.Y, l), interp(PBRT_CIE.Z, l)];
    for (let k = 0; k < 3; k++) rgb[k].push((M[3 * k] * xyz[0] + M[3 * k + 1] * xyz[1] + M[3 * k + 2] * xyz[2]) * I * w);
    for (let k = 0; k < 3; k++) wp[k] += xyz[k] * I * w;
    lt.push((l - 360) / 470);
  }
  for (let k = 0; k < 3; k++) rgb[k] = rgb[k].map((v) => v / wp[1]);
  pbrtSpectralTables = { rgb, lt, wp: wp.map((v) => v / wp[1]) };
  return pbrtSpectralTables;
}

const pbrtSigmoid = (x) => 0.5 * x / Math.sqrt(1 + x * x) + 0.5;
const pbrtSpectrum = (c) => pbrtSpectral().lt.map((l) => pbrtSigmoid((c[0] * l + c[1]) * l + c[2]));
const pbrtSpectrumRgb = (s) => pbrtSpectral().rgb.map((row) => row.reduce((a, v, i) => a + v * s[i], 0));

function pbrtLab(rgb) {
  const M = PBRT_CIE.SRGB_TO_XYZ, wp = pbrtSpectral().wp, d = 6 / 29;
  const f = (t) => (t > d * d * d ? Math.cbrt(t) : t / (d * d * 3) + 4 / 29);
  const v = [0, 1, 2].map((k) => (M[3 * k] * rgb[0] + M[3 * k + 1] * rgb[1] + M[3 * k + 2] * rgb[2]) / wp[k]);
  return [116 * f(v[1]) - 16, 500 * (f(v[0]) - f(v[1])), 200 * (f(v[1]) - f(v[2]))];
}

// pbrt-v4's RGBAlbedoSpectrum for an sRGB reflectance: the sigmoid-polynomial spectrum
// rgb2spec_opt.cpp fits (Gauss-Newton on the CIELAB residual, warm-started along brightness).
export function pbrtAlbedoSpectrum(rgb) {
  const target = rgb.map((v) => Math.min(1, Math.max(0, v)));
  let c = [0, 0, 0];
  const residual = (cc, tgt) => { const a = pbrtLab(tgt), b = pbrtLab(pbrtSpectrumRgb(pbrtSpectrum(cc))); return a.map((v, i) => v - b[i]); };
  for (let step = 1; step <= 9; step++) {
    const tgt = target.map((v) => v * (0.1 + 0.1 * step));
    for (let it = 0; it < 15; it++) {
      const r = residual(c, tgt);
      const J = [0, 1, 2].map(() => [0, 0, 0]);
      for (let i = 0; i < 3; i++) {
        const lo = c.slice(), hi = c.slice(); lo[i] -= 1e-4; hi[i] += 1e-4;
        const r0 = residual(lo, tgt), r1 = residual(hi, tgt);
        for (let j = 0; j < 3; j++) J[j][i] = (r1[j] - r0[j]) / 2e-4;
      }
      const x = solve3(J, r);
      if (!x) return null;
      c = c.map((v, i) => v - x[i]);
    }
  }
  const s = pbrtSpectrum(c);
  return pbrtSpectrumRgb(s).every((v, i) => Math.abs(v - target[i]) < 1e-3) ? s : null;
}

function solve3(A, b) {
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(A);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-300) return null;
  return [0, 1, 2].map((k) => det(A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)))) / d);
}

// Constant reflectance: pbrt applies the coat per wavelength, so a saturated colour is
// matched through its spectrum (the series is nonlinear in R). Returns the base_color.
export function pbrtCoatedDiffuseBaseColor(rgb, eta, alpha, thickness, maxDepth = 10) {
  const albedo = (R) => pbrtCoatedDiffuseAlbedo(R, eta, alpha, thickness, maxDepth);
  const flat = rgb[0] === rgb[1] && rgb[1] === rgb[2];
  const s = flat ? null : pbrtAlbedoSpectrum(rgb);
  const target = s ? pbrtSpectrumRgb(s.map(albedo)) : rgb.map((r) => albedo(Math.min(1, Math.max(0, r))));
  const { c, kc } = openPbrCoatTerms(eta, alpha);
  let clamped = 0;
  const color = target.map((d) => {
    const b = d / (c + kc * d);
    if (b > 1.005 || b < -0.005) clamped++;
    return Math.min(1, Math.max(0, b));
  });
  return { color, clamped, target, spectral: !!s };
}

// The constants of the plastic match below: base_color = R / (1 - k Fdr_int) * scale.
export function mitsubaPlasticTerms(eta, alpha = 0) {
  const fdrInt = mitsubaFdrFit(1 / eta);
  const tExt = 1 - cosineAverage((mu) => dielectricFresnel(mu, eta));
  const scale = (tExt * tExt) / (eta * eta) / (1 - openPbrDielectricAlbedo(eta, alpha));
  return { fdrInt, scale };
}

// base_color whose OpenPBR diffuse albedo b (1 - E_spec) matches Mitsuba 3 plastic's
// R / (1 - k Fdr_int) (1 - Fdr_ext)^2 / eta^2 (k = R if nonlinear, else 1); per channel,
// clamped to [0, 1]. roughplastic is approximated with the smooth interface terms.
export function mitsubaPlasticBaseColor(rgb, eta, alpha = 0, nonlinear = false) {
  const { fdrInt, scale } = mitsubaPlasticTerms(eta, alpha);
  let clamped = 0;
  const color = rgb.map((r) => {
    const b = (r / (1 - (nonlinear ? r : 1) * fdrInt)) * scale;
    if (b > 1 || b < 0) clamped++;
    return Math.min(1, Math.max(0, b));
  });
  return { color, clamped };
}

// The same match for a textured R, exact in the graph: linear in R (one multiply)
// unless nonlinear, whose R / (1 - R Fdr_int) term is built from multiply, subtract and divide nodes.
function mitsubaPlasticBaseColorOp(ctx, base, eta, alpha, nonlinear) {
  const { fdrInt, scale } = mitsubaPlasticTerms(eta, alpha);
  let b;
  if (!nonlinear) b = binary(ctx, "multiply", base, { k: scale / (1 - fdrInt) }, "plastic_albedo");
  else {
    const denom = binary(ctx, "subtract", { k: 1 }, binary(ctx, "multiply", base, { k: fdrInt }, "plastic_fdr"), "plastic_denominator");
    b = binary(ctx, "divide", binary(ctx, "multiply", base, { k: scale }, "plastic_scaled"), denom, "plastic_albedo");
  }
  return clampOp(ctx, b, 0, 1, "plastic_base_color");
}

const MITSUBA_SILENT_KEYS = ["distribution", "sample_visible"];

// One open_pbr_surface document for a Mitsuba bsdf ({ type, props }, unwrapped from
// twosided; texture props carry their description in prop.spec); emission is an area
// emitter's rgb radiance. legacy marks pre-2.0 files, whose conductor default is Cu.
export function mitsubaMaterialDocument({ name, bsdf, emission, legacy = false, textureFile } = {}) {
  const doc = createDocument();
  const notes = [];
  const ctx = { doc, notes, textureFile };
  const shader = doc.addNode("open_pbr_surface", "SR_" + (name || "material"), "surfaceshader");
  const type = (bsdf && bsdf.type) || "diffuse";
  const props = (bsdf && bsdf.props) || {};
  const used = new Set(MITSUBA_SILENT_KEYS);
  const take = (key) => { used.add(key); return props[key]; };
  const rough = type.startsWith("rough");
  const roughness = () => {
    ["alpha", "alpha_u", "alpha_v"].forEach((k) => used.add(k));
    return rough ? mitsubaRoughnessOp(ctx, props, 0.1) : { k: 0 };
  };
  const checkDistribution = () => {
    const d = props.distribution ? String(props.distribution.value) : "beckmann";
    if (rough && d === "beckmann") notes.push("the Beckmann distribution is rendered with the GGX of OpenPBR");
  };
  const color = (key, fallback) => mitsubaColorOp(ctx, take(key), fallback, key);
  const setColor = (input, x) => setOperand(shader, input, "color3", x);
  const setFloat = (input, x) => setOperand(shader, input, "float", isK(x) || (x && x.n) ? x : { k: x });
  const notWhite = (x) => !isK(x) || x.k.some((c) => c !== 1);

  if (type === "diffuse") {
    setColor("base_color", color("reflectance", [0.5, 0.5, 0.5]));
    setFloat("specular_weight", 0);
  } else if (type === "plastic" || type === "roughplastic") {
    const base = color("diffuse_reflectance", [0.5, 0.5, 0.5]);
    const spec = color("specular_reflectance", [1, 1, 1]);
    const ior = mitsubaIor(take("int_ior"), 1.49, notes, "int_ior") / mitsubaIor(take("ext_ior"), 1.000277, notes, "ext_ior");
    const nonlinear = take("nonlinear");
    const isNonlinear = !!(nonlinear && nonlinear.value === true);
    checkDistribution();
    const specRoughness = roughness();
    const alpha = isK(specRoughness) ? specRoughness.k * specRoughness.k : 0.1;
    if (!isK(specRoughness)) notes.push("plastic alpha is a float in Mitsuba; the texture drives the specular roughness, the albedo match uses alpha 0.1");
    if (isK(base)) {
      const matched = mitsubaPlasticBaseColor(base.k, ior, alpha, isNonlinear);
      if (matched.clamped) notes.push("diffuse_reflectance needs an albedo outside OpenPBR's base_color range in " + matched.clamped + " channel(s), clamped");
      setColor("base_color", { k: matched.color });
    } else {
      setColor("base_color", mitsubaPlasticBaseColorOp(ctx, base, ior, alpha, isNonlinear));
    }
    setFloat("specular_weight", 1);
    if (notWhite(spec)) setColor("specular_color", spec);
    setFloat("specular_ior", ior);
    setFloat("specular_roughness", specRoughness);
  } else if (type === "dielectric" || type === "roughdielectric" || type === "thindielectric") {
    const ior = mitsubaIor(take("int_ior"), 1.5046, notes, "int_ior") / mitsubaIor(take("ext_ior"), 1.000277, notes, "ext_ior");
    const spec = color("specular_reflectance", [1, 1, 1]);
    const trans = color("specular_transmittance", [1, 1, 1]);
    checkDistribution();
    setColor("base_color", { k: [1, 1, 1] });
    setFloat("transmission_weight", 1);
    if (notWhite(trans)) setColor("transmission_color", trans);
    if (notWhite(spec)) setColor("specular_color", spec);
    setFloat("specular_ior", ior);
    setFloat("specular_roughness", roughness());
    if (type === "thindielectric") setInput(shader, "geometry_thin_walled", "boolean", { value: "true", uniform: "true" });
  } else if (type === "conductor" || type === "roughconductor") {
    ["material", "eta", "k", "ext_eta"].forEach((k) => used.add(k));
    const ior = mitsubaConductorIor(props, notes, legacy);
    const spec = color("specular_reflectance", [1, 1, 1]);
    checkDistribution();
    setFloat("base_metalness", 1);
    if (!ior) {
      setColor("base_color", spec);
    } else {
      setColor("base_color", binary(ctx, "multiply", { k: conductorF0(ior.eta, ior.k) }, spec, "conductor_base_color"));
      setColor("specular_color", { k: conductorF82Tint(ior.eta, ior.k) });
    }
    setFloat("specular_roughness", roughness());
  } else {
    notes.push('bsdf "' + type + '" is not supported, a grey diffuse is used');
    for (const key of Object.keys(props)) used.add(key);
    setColor("base_color", { k: [0.5, 0.5, 0.5] });
    setFloat("specular_weight", 0);
  }
  for (const key of Object.keys(props)) {
    if (!used.has(key)) notes.push('parameter "' + key + '" is not imported');
  }
  setRadianceEmission(shader, emission);

  const result = finish(doc, shader, "M_" + (name || "material"));
  return { xml: result.xml, materialName: result.materialName, shaderName: result.shaderName, notes };
}
