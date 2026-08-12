// scripts/lib/mtlx-versions.mjs
//
// Single source of truth for which MaterialX JS/WASM builds this repo
// ships. Upstream publishes MaterialX_JavaScript.zip for only a couple
// of releases (JS bindings + a release zip both have to exist), so this
// list is short and hand-maintained — see scripts/fetch-mtlx-versions.mjs
// for how each entry is turned into js/materialx/<version>/.
//
// MUST NOT import scripts/lib/version.mjs: that module imports
// DEFAULT_MTLX_VERSION from here (see its header comment), and
// scripts/vendor.mjs does a top-level `await readVersionMeta()` — an
// import cycle here would break the whole build at module-load time.

// Newest first by convention; DEFAULT_MTLX_VERSION below is computed,
// not read off this ordering, so the ordering itself carries no meaning.
export const MTLX_VERSIONS = [
  {
    version: "1.39.5",
    tag: "v1.39.5",
    zipSha256: "fbb0afe06064b4a5606d52dafe3b740f093de084000f11340ac0a6a88a7ecb0b",
    zipBytes: 1140418,
    files: {
      "JsMaterialXGenShader.js": 169263,
      "JsMaterialXGenShader.wasm": 2190442,
      "JsMaterialXGenShader.data": 1481718,
    },
  },
  {
    version: "1.39.4",
    tag: "v1.39.4",
    zipSha256: "223146f9952e5471adb165b81f3065e16829c1ba2426bf89a8842da86e433c78",
    zipBytes: 1248166,
    files: {
      "JsMaterialXGenShader.js": 194647,
      "JsMaterialXGenShader.wasm": 2642151,
      "JsMaterialXGenShader.data": 1512004,
    },
  },
];

/** Release asset URL for one MTLX_VERSIONS entry. */
export function mtlxVersionAssetUrl(entry) {
  return `https://github.com/AcademySoftwareFoundation/MaterialX/releases/download/${entry.tag}/MaterialX_JavaScript.zip`;
}

/** Parses "X.Y.Z" into [X, Y, Z] as numbers for a numeric (not lexicographic) comparison. */
function versionIntegers(version) {
  return version.split(".").map((part) => Number.parseInt(part, 10));
}

function compareVersionsDesc(a, b) {
  const ai = versionIntegers(a.version);
  const bi = versionIntegers(b.version);
  for (let i = 0; i < Math.max(ai.length, bi.length); i++) {
    const diff = (bi[i] || 0) - (ai[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// DEFAULT_MTLX_VERSION is COMPUTED as the max by numeric version
// components, never hand-picked, so "the newest version is always the
// default" is a mechanical property of this table rather than a
// convention someone can forget to update. scripts/extract-mtlx-version.mjs
// asserts this equals the version the committed WASM actually reports.
// ---------------------------------------------------------------------------
export const DEFAULT_MTLX_VERSION = [...MTLX_VERSIONS].sort(compareVersionsDesc)[0].version;
