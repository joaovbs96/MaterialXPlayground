#!/usr/bin/env node
// scripts/build-gallery.mjs
//
// Scans vendor/materialx/resources/Materials/Examples/**/*.mtlx plus a
// handful of our own showcase materials, and writes gallery/manifest.json
// (schema: docs/local/GALLERY.md). Pure Node (node:fs/node:path only, no
// XML parser): a regex/string port of vscode_extension/src/docScanner.js
// and js/shared/mtlx-ui.jsx's extractFilenameRefs.
//
// Usage: node scripts/build-gallery.mjs [--out <dir>]

import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const MATERIALX_ROOT = path.join(REPO_ROOT, "vendor", "materialx");
const MATERIALX_MANIFEST_PATH = path.join(MATERIALX_ROOT, "manifest.json");
const EXAMPLES_ROOT = path.join(MATERIALX_ROOT, "resources", "Materials", "Examples");

const FAMILY_LABELS = {
  StandardSurface: "Standard Surface",
  OpenPbr: "OpenPBR",
  GltfPbr: "glTF PBR",
  UsdPreviewSurface: "USD Preview Surface",
  DisneyPrincipled: "Disney Principled",
  SimpleHair: "Simple Hair",
};

const FAMILY_PREFIXES = {
  StandardSurface: "standard_surface_",
  OpenPbr: "open_pbr_",
  GltfPbr: "gltf_pbr_",
  UsdPreviewSurface: "usd_preview_surface_",
  DisneyPrincipled: "disney_principled_",
  SimpleHair: "simple_hair_",
};

// Every entry carries a license the gallery can display in place. `origin`
// picks the resolver: "materialx" goes through MtlxAssets.repoUrl (the
// vendored copy locally, raw.githubusercontent when remote), "site" is
// site-relative.
const MATERIALX_LICENSE = { label: "Apache License 2.0", origin: "materialx", path: "LICENSE" };
const REPO_LICENSE = { label: "Apache License 2.0", origin: "site", path: "LICENSE" };

// Curated showcase materials, appended after the vendored examples. Paths
// are absolute so collectTextures() can resolve their own local refs.
const PLAYGROUND_ENTRIES = [
  {
    id: "Motley_Patchwork_Rug",
    name: "Motley Patchwork Rug",
    absPath: path.join(REPO_ROOT, "materials", "Motley_Patchwork_Rug", "Motley_Patchwork_Rug.mtlx"),
    docPath: "materials/Motley_Patchwork_Rug/Motley_Patchwork_Rug.mtlx",
    license: { label: "MIT License", origin: "site", path: "materials/Motley_Patchwork_Rug/LICENSE.txt" },
    note: "Redistributed under the MIT License; see materials/Motley_Patchwork_Rug/LICENSE.txt for the source and full license text.",
  },
  {
    id: "standard_surface_carpaint_to_openpbr",
    name: "Carpaint to OpenPBR",
    absPath: path.join(REPO_ROOT, "materials", "standard_surface_carpaint_to_openpbr.mtlx"),
    docPath: "materials/standard_surface_carpaint_to_openpbr.mtlx",
  },
  {
    id: "animated_noise",
    name: "Animated Noise",
    absPath: path.join(REPO_ROOT, "examples", "animated_noise.mtlx"),
    docPath: "examples/animated_noise.mtlx",
  },
  {
    id: "AnimatedChristmasTreeOrnament",
    name: "Animated Christmas Tree Ornament",
    absPath: path.join(REPO_ROOT, "materials", "AnimatedChristmasTreeOrnament", "ChristmasTreeOrnament016_1K-JPG.mtlx"),
    docPath: "materials/AnimatedChristmasTreeOrnament/ChristmasTreeOrnament016_1K-JPG.mtlx",
    license: { label: "CC0 1.0 Universal", origin: "site", path: "materials/AnimatedChristmasTreeOrnament/LICENSE.txt" },
    note: "Textures released under CC0 1.0 Universal; see materials/AnimatedChristmasTreeOrnament/LICENSE.txt for the full license text.",
  },
];

function log(...args) {
  console.log(...args);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  let outDir = path.join(REPO_ROOT, "gallery");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" && argv[i + 1]) {
      outDir = path.resolve(argv[i + 1]);
      i++;
    } else if (arg.startsWith("--out=")) {
      outDir = path.resolve(arg.slice("--out=".length));
    }
  }
  return { outDir };
}

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function dedupe(arr) {
  return [...new Set(arr)];
}

function titleCase(snakeCase) {
  return snakeCase
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Regex/string XML parsing, ported from vscode_extension/src/docScanner.js
// and js/shared/mtlx-ui.jsx's extractFilenameRefs (double-quote-only
// attribute matching for fileprefix/type/value/name, tolerant of either
// quote style for xi:include href, same as those two files).
// ---------------------------------------------------------------------------

const XI_INCLUDE_RE = /<xi:include\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*?\/?>(?:\s*<\/xi:include>)?/g;

function attrDq(tag, name) {
  const m = new RegExp("\\b" + name + '\\s*=\\s*"([^"]*)"').exec(tag);
  return m ? m[1] : null;
}

/** Filename refs in `xml`, fileprefix-resolved within nodegraph scopes.
 * Values are returned as authored (fileprefix + value), unresolved. */
function extractFilenameRefs(xml) {
  const rootAttrs = (/<materialx\b([^>]*)>/.exec(xml) || [])[1] || "";
  const rootPrefix = attrDq(rootAttrs, "fileprefix") || "";
  const scopes = [];
  let cursor = 0;
  const NG = /<nodegraph\b([^>]*)>([\s\S]*?)<\/nodegraph>/g;
  let ngm;
  while ((ngm = NG.exec(xml)) !== null) {
    scopes.push({ text: xml.slice(cursor, ngm.index), prefix: rootPrefix });
    const ngPrefix = attrDq(ngm[1], "fileprefix") || "";
    scopes.push({ text: ngm[2], prefix: rootPrefix + ngPrefix });
    cursor = ngm.index + ngm[0].length;
  }
  scopes.push({ text: xml.slice(cursor), prefix: rootPrefix });
  const refs = [];
  for (const scope of scopes) {
    const tags = scope.text.match(/<input\b[^>]*>/g) || [];
    for (const tag of tags) {
      if (!/\btype\s*=\s*"filename"/.test(tag)) continue;
      const raw = attrDq(tag, "value");
      if (!raw) continue;
      refs.push(scope.prefix + raw);
    }
  }
  return refs;
}

function extractIncludeHrefs(xml) {
  const hrefs = [];
  XI_INCLUDE_RE.lastIndex = 0;
  let m;
  while ((m = XI_INCLUDE_RE.exec(xml)) !== null) {
    const href = m[1] || m[2];
    if (href) hrefs.push(href);
  }
  return hrefs;
}

/** <surfacematerial>/<material> node names, anywhere in the (already
 * include-folded) document text. */
function extractRenderables(xml) {
  const names = [];
  const TAG_RE = /<(?:surfacematerial|material)\b([^>]*)>/g;
  let m;
  while ((m = TAG_RE.exec(xml)) !== null) {
    const name = attrDq(m[1], "name");
    if (name) names.push(name);
  }
  return names;
}

/** Strips <nodegraph>/<nodedef> bodies so a nested helper node (e.g. a
 * "surface" node wired up inside a nodegraph) is never mistaken for the
 * document's actual top-level surface shader. */
function rootScope(xml) {
  return xml.replace(/<nodegraph\b[^>]*>[\s\S]*?<\/nodegraph>/g, "").replace(/<nodedef\b[^>]*>[\s\S]*?<\/nodedef>/g, "");
}

/** The category (element tag name) of the document's surface shader node:
 * the first root-scope node whose type="surfaceshader", skipping the
 * <input>/<output> declarations that can carry that same type attribute. */
function extractShaderCategory(xml) {
  const scope = rootScope(xml);
  const TAG_RE = /<(\w[\w.-]*)\b([^>]*)>/g;
  let m;
  while ((m = TAG_RE.exec(scope)) !== null) {
    const tagName = m[1];
    if (tagName === "input" || tagName === "output") continue;
    if (!/\btype\s*=\s*"surfaceshader"/.test(m[2])) continue;
    return tagName;
  }
  return null;
}

/** The HTML-comment text on 1-indexed `lineNumber` of `xml`, or null. */
function extractLineComment(xml, lineNumber) {
  const lines = xml.split(/\r?\n/);
  const line = lines[lineNumber - 1] || "";
  const m = /<!--\s*(.*?)\s*-->/.exec(line);
  return m ? m[1] : null;
}

/** Walks xi:include siblings (BFS, resolved relative to each doc's own
 * directory), folding in their filename refs (also resolved per-doc) and
 * raw text. Returns unique texture count/bytes and the concatenated text
 * (root doc first, then includes) for renderable/shader extraction. */
async function collectDocument(rootPath, rootXml) {
  const seenRefs = new Set();
  const refs = [];
  // Fingerprint of everything this material renders from. A deploy reuses
  // the previously published thumbnail when this is unchanged, so it has
  // to cover the root doc, every include, and every texture byte.
  const hash = createHash("sha256");
  hash.update(rootXml);
  const pieces = [rootXml];
  const visited = new Set([rootPath]);
  const queue = [{ dir: path.dirname(rootPath), xml: rootXml }];

  while (queue.length) {
    const item = queue.shift();
    for (const href of extractIncludeHrefs(item.xml)) {
      const incPath = path.resolve(item.dir, href);
      if (visited.has(incPath)) continue;
      visited.add(incPath);
      if (!existsSync(incPath)) {
        console.warn(`warning: xi:include href not found on disk: ${incPath} (from ${rootPath})`);
        continue;
      }
      const incXml = await readFile(incPath, "utf8");
      hash.update(href);
      hash.update(incXml);
      pieces.push(incXml);
      queue.push({ dir: path.dirname(incPath), xml: incXml });
    }
    for (const rawRef of extractFilenameRefs(item.xml)) {
      if (seenRefs.has(rawRef)) continue;
      seenRefs.add(rawRef);
      refs.push({ ref: rawRef, dir: item.dir });
    }
  }

  let textureCount = 0;
  let textureBytes = 0;
  for (const { ref, dir } of refs) {
    const abs = path.resolve(dir, ref);
    try {
      const st = await stat(abs);
      textureCount++;
      textureBytes += st.size;
      hash.update(ref);
      hash.update(await readFile(abs));
    } catch (e) {
      console.warn(`warning: texture ref not found on disk: ${abs} (ref "${ref}")`);
    }
  }

  const combinedXml = pieces.join("\n");
  return {
    textureCount,
    textureBytes,
    hash: hash.digest("hex").slice(0, 16),
    renderables: extractRenderables(combinedXml),
    shader: extractShaderCategory(combinedXml) || "unknown",
  };
}

// ---------------------------------------------------------------------------
// vendor/materialx/resources/Materials/Examples scan
// ---------------------------------------------------------------------------

/** { family, fileName, absPath }[], sorted by family then filename. */
async function listExampleFiles() {
  const familyEntries = await readdir(EXAMPLES_ROOT, { withFileTypes: true });
  const families = familyEntries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const files = [];
  for (const family of families) {
    const dir = path.join(EXAMPLES_ROOT, family);
    const dirEntries = await readdir(dir, { withFileTypes: true });
    const names = dirEntries
      .filter((e) => e.isFile() && e.name.endsWith(".mtlx"))
      .map((e) => e.name)
      .sort();
    for (const fileName of names) {
      files.push({ family, fileName, absPath: path.join(dir, fileName) });
    }
  }
  return files;
}

async function buildExampleEntry(family, fileName, absPath) {
  const xml = await readFile(absPath, "utf8");
  const stats = await stat(absPath);
  const { textureCount, textureBytes, hash, renderables, shader } = await collectDocument(absPath, xml);

  const id = fileName.replace(/\.mtlx$/, "");
  const familyLabel = FAMILY_LABELS[family] || family;
  const prefix = FAMILY_PREFIXES[family] || "";
  const rest = id.startsWith(prefix) ? id.slice(prefix.length) : id;
  const name = titleCase(rest);
  const textured = textureCount > 0;

  const entry = {
    id,
    name,
    family,
    familyLabel,
    origin: "materialx",
    docPath: toPosix(path.relative(MATERIALX_ROOT, absPath)),
    bytes: stats.size,
    textured,
    textureCount,
    textureBytes,
    renderables,
    shader,
    tags: dedupe([familyLabel, textured ? "Textured" : "Procedural", shader]),
    thumb: `thumbs/${id}.jpg`,
    hash,
    license: MATERIALX_LICENSE,
  };
  if (id === "standard_surface_chess_set") {
    const note = extractLineComment(xml, 3);
    if (note) entry.note = note;
  }
  return entry;
}

async function buildPlaygroundEntry(def) {
  const xml = await readFile(def.absPath, "utf8");
  const stats = await stat(def.absPath);
  const { textureCount, textureBytes, hash, renderables, shader } = await collectDocument(def.absPath, xml);
  const textured = textureCount > 0;
  const familyLabel = "Playground";

  const entry = {
    id: def.id,
    name: def.name,
    family: "Playground",
    familyLabel,
    origin: "playground",
    docPath: def.docPath,
    bytes: stats.size,
    textured,
    textureCount,
    textureBytes,
    renderables,
    shader,
    tags: dedupe([familyLabel, textured ? "Textured" : "Procedural", shader]),
    thumb: `thumbs/${def.id}.jpg`,
    hash,
    license: def.license || REPO_LICENSE,
  };
  if (def.note) entry.note = def.note;
  return entry;
}

async function main() {
  const { outDir } = parseArgs(process.argv.slice(2));

  if (!existsSync(MATERIALX_MANIFEST_PATH)) {
    fail(
      [
        "error: vendor/materialx/ is not populated (vendor/materialx/manifest.json missing).",
        "Run `npm run vendor:offline` first (node scripts/vendor.mjs --with-materialx) to fetch the MaterialX examples snapshot.",
      ].join("\n")
    );
  }
  const mxManifest = JSON.parse(await readFile(MATERIALX_MANIFEST_PATH, "utf8"));

  const materials = [];
  for (const { family, fileName, absPath } of await listExampleFiles()) {
    materials.push(await buildExampleEntry(family, fileName, absPath));
  }
  for (const def of PLAYGROUND_ENTRIES) {
    materials.push(await buildPlaygroundEntry(def));
  }

  const manifest = {
    version: 1,
    source: { repo: "AcademySoftwareFoundation/MaterialX", tag: mxManifest.tag },
    generatedAt: new Date().toISOString(),
    materials,
  };

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const texturedCount = materials.filter((m) => m.textured).length;
  const totalTextureBytes = materials.reduce((sum, m) => sum + m.textureBytes, 0);
  log(`gallery manifest: ${materials.length} materials, ${texturedCount} textured, ${totalTextureBytes} texture bytes total.`);
}

await main();
