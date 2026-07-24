#!/usr/bin/env node
// scripts/build-webview.mjs
//
// Generates vscode_extension/media/webview.html from index.html: the
// webview needs the exact same <head>/<body> skeleton as the real site
// (vendored library tags, inline embed-mode detection, the boot script,
// every style block) PLUS a handful of webview-only insertions (a
// Content-Security-Policy meta tag, a <base> tag so relative URLs resolve
// against the webview-resource root, a bootstrap <script> tag, and a
// :focus{outline:none} rule VS Code's Chromium needs but a real browser
// doesn't). Before this script existed that combination was a
// hand-maintained mirror a human had to remember to update every time
// index.html changed — this script does the splice instead, so
// `npm run build` (or `npm run build:webview`) regenerates the mirror and
// `npm run check` (via `--check`) fails CI the moment it drifts.
//
// The fragments below (CSP_BLOCK / BASE_BLOCK / BOOTSTRAP_BLOCK /
// FOCUS_CSS_BLOCK) are the webview-only insertions, copied verbatim from
// the committed webview.html and kept here as the source of truth going
// forward: index.html supplies the shared skeleton, this file supplies
// the webview-only parts, and webview.html is pure generated output. To
// change shared markup, edit index.html. To change a webview-only
// insertion, edit the matching fragment constant below.
//
// Usage:
//   node scripts/build-webview.mjs           (Re)generate
//                                             vscode_extension/media/webview.html
//                                             by splicing the fragments
//                                             below into a copy of
//                                             index.html.
//   node scripts/build-webview.mjs --check   Verify only: rebuild in
//                                             memory and byte-compare
//                                             against the committed file.
//                                             Writes nothing. Non-zero
//                                             exit on drift (or on any
//                                             anchor/sanity failure).

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const INDEX_PATH = path.join(REPO_ROOT, "index.html");
const OUTPUT_PATH = path.join(REPO_ROOT, "vscode_extension", "media", "webview.html");
const RELATIVE_OUTPUT_PATH = path.relative(REPO_ROOT, OUTPUT_PATH);

const CHECK_MODE = process.argv.includes("--check");

function log(...args) {
  console.log("[build-webview]", ...args);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ---------------------------------------------------------------------
// Anchors: content-based splice points into index.html. Both are exact
// literal strings verified (as of writing) to occur EXACTLY ONCE in
// index.html — see the anchor-count guard in build() below, which
// hard-fails rather than silently splicing into the wrong spot (or
// spraying the insertion across multiple spots) if index.html is ever
// restructured.
// ---------------------------------------------------------------------

// The viewport meta tag: stable head boilerplate (unlike <title>, which
// churns with SEO work) that sits right before where the webview-only
// head insertions belong. CSP/<base> must precede every URL-bearing tag
// below them (per the HTML spec, <base> only affects URLs parsed AFTER
// it), so they're spliced in immediately after this anchor rather than at
// the very top of <head>.
const HEAD_ANCHOR = '    <meta name="viewport" content="width=device-width, initial-scale=1.0">\n';

// The </style></body> boundary: there are TWO </style> tags in
// index.html (one for the embed-mode style block near the top of <head>,
// one closing the big style block at the end of <body>) so a bare
// last-</style> heuristic is not safe here — this anchor pins to the one
// immediately followed by </body>, which is unique.
const STYLE_ANCHOR = '    </style>\n</body>';

// ---------------------------------------------------------------------
// Fragments: webview-only insertions, copied verbatim from the committed
// webview.html (this file is now their source of truth — edit them here,
// not in the generated output). Literal `${...}` sequences inside these
// fragments are runtime placeholders substituted by
// vscode_extension/src/editorProvider.js's buildHtml(), NOT things this
// script should interpolate — they're escaped as `\${` below so the
// template literals treat them as plain text.
// ---------------------------------------------------------------------

// Banner: replaces the old hand-maintained-mirror notice with one
// pointing at this generator. (The banner it replaces said "four
// placeholders" — it's actually five; fixed here.)
const BANNER = `    <!-- ================================================================
         vscode_extension/media/webview.html — GENERATED FILE, DO NOT
         EDIT BY HAND.

         Generated from ../../index.html by scripts/build-webview.mjs
         (\`npm run build:webview\`, part of \`npm run build\`; \`npm run
         check\` fails CI on drift). Shared markup lives in index.html —
         edit it there and regenerate; webview-only insertions (this CSP
         meta tag, the <base> tag, the bootstrap script tag, and the
         focus-outline CSS near the bottom) are fragments defined in
         scripts/build-webview.mjs — edit them there instead. Contains
         five \${...} placeholders substituted at runtime by
         vscode_extension/src/editorProvider.js's buildHtml().
         ================================================================ -->`;

// CSP meta tag + its explainer comment. See the comment inside this
// fragment for the full per-directive rationale.
const CSP_BLOCK = `    <!-- Content-Security-Policy: webviews block everything by default
         unless explicitly allowed. Directives, one per concern:
           default-src 'none'          — deny-by-default baseline.
           script-src  \${cspSource} 'unsafe-inline' 'unsafe-eval'
                       'wasm-unsafe-eval'
                       — \${cspSource} for this extension's own local
                         resources (bootstrap.js) and, via
                         localResourceRoots, the repo's js/*.js(x) AND the
                         committed vendor/ tree (Tailwind, React, Babel
                         standalone, three.js, RGBELoader/GLTFLoader/
                         OrbitControls, fflate all ship locally now — no
                         remote host needed here); 'unsafe-eval' because
                         Babel standalone transpiles+evals the site's
                         type="text/babel" scripts IN the browser (no
                         build step, by design — js/shell.jsx,
                         js/graph-app.jsx, etc. are all loaded that way);
                         'wasm-unsafe-eval' for WebAssembly.instantiate
                         (js/JsMaterialXCore.wasm / JsMaterialXGenShader.wasm).
           style-src   \${cspSource} 'unsafe-inline'
                       — the vendored Tailwind Play build injects a
                         <style> tag at runtime from \${cspSource}, and the
                         site itself uses inline style attributes/blocks
                         throughout.
           font-src    \${cspSource}  — KaTeX web fonts (lazy-loaded by the
                       docs view), served from vendor/katex/fonts/.
           img-src     \${cspSource} https: blob: data:
                       — blob: for object-URL textures/snapshots the app
                         creates itself, data: for small inline assets,
                         https: kept for any remote-fetched preset/texture
                         images (web-parity fallback — see connect-src).
           connect-src \${cspSource} https://raw.githubusercontent.com
                       blob: data:
                       — fetch() for local resources (vendored libs,
                         default preset, environment maps, WASM binaries,
                         .data files) plus the ONE remote host the app can
                         still reach: raw.githubusercontent.com, used only
                         by js/mtlx-assets.js's remote-mode resolver to
                         pull MaterialX spec/template/preset files when
                         the packaged build ships without
                         vendor/materialx/ (web-parity fallback; a fully
                         offline packaged build ships that folder and the
                         resolver never constructs a remote URL at all —
                         see js/mtlx-assets.js). blob:/data: cover the
                         object-URL and inline-asset fetches issued
                         against the img-src sources above.
           frame-src   \${cspSource}
                       — the graph editor's docs-dialog iframes
                         index.html?embed=1#/... back into itself, which
                         under <base href="\${baseUri}"> resolves to a
                         \${cspSource} (webview-resource) URL.
         TRADEOFF: 'unsafe-inline' is in script-src (not just style-src)
         because index.html's inline scripts (embed-mode detection, the
         ReactDOM.createRoot(...) boot call) and this template's own
         inline scripts are not nonce'd in v1 — a real nonce scheme is
         future work, not required for a read/view-only v1 that already
         runs third-party code via 'unsafe-eval'. -->
    <meta http-equiv="Content-Security-Policy" content="
        default-src 'none';
        script-src \${cspSource} 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval';
        style-src \${cspSource} 'unsafe-inline';
        font-src \${cspSource};
        img-src \${cspSource} https: blob: data:;
        connect-src \${cspSource} https://raw.githubusercontent.com blob: data:;
        frame-src \${cspSource};
    ">`;

// <base href="${baseUri}">: every relative URL in the document resolves
// against this, so index.html's existing site-relative tags/paths work
// unmodified inside the webview.
const BASE_BLOCK = `    <!-- Every relative URL below (favicon.ico, js/..., ...) resolves
         against this — the webview-resource URI of the repo root — so
         index.html's existing site-relative tags/paths work completely
         unmodified. MUST precede every tag below that carries a relative
         URL (per the HTML spec, <base> only affects URLs parsed AFTER
         it). -->
    <base href="\${baseUri}">`;

// Bootstrap <script>: must be the first script to run, before the site's
// own boot. See vscode_extension/media/bootstrap.js.
const BOOTSTRAP_BLOCK = `    <!-- Bootstrap: MUST be the first script to run, before the site's own
         boot (js/shell.jsx reads location.hash for routing). Sets the
         initial hash from data-initial-hash, flags window.__MTLX_VSCODE__
         (and, from data-docs-only, window.__MTLX_DOCS_ONLY__ — read by
         js/site-header.js to hide the file-bound Viewer/Graph tabs in the
         standalone docs panel), installs the in-page link interceptor,
         and wires up the extension <-> webview postMessage contract. See
         vscode_extension/media/bootstrap.js. -->
    <script src="\${bootstrapUri}" data-initial-hash="\${initialHash}" data-docs-only="\${docsOnly}"></script>`;

// Webview-only :focus{outline:none} — VS Code's Chromium build shows a
// native focus outline a regular browser's :focus-visible heuristics
// would normally suppress; NOT mirrored back to index.html / the real
// site.
const FOCUS_CSS_BLOCK = `
        /* WEBVIEW-ONLY — do NOT mirror this rule back to index.html / the
           real site. VS Code webview only (not in index.html / the real
           site): the webview's Chromium build shows a native focus outline
           on click for elements like React Flow's tabIndex'd pane/nodes
           that a regular browser's :focus-visible heuristics would
           normally suppress. */
        :focus {
            outline: none;
        }`;

const PLACEHOLDERS = ["${cspSource}", "${baseUri}", "${bootstrapUri}", "${initialHash}", "${docsOnly}"];

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack, needle) {
  let count = 0;
  let i = 0;
  while (true) {
    i = haystack.indexOf(needle, i);
    if (i === -1) break;
    count++;
    i += needle.length;
  }
  return count;
}

/** Split `text` on `anchor`, asserting the anchor occurs exactly once
 * (hard-fails otherwise — see the module comment). Returns [before, after].
 * Uses split/indexOf, never String.replace: the fragments above contain
 * literal `$` sequences, and replace()'s replacement-string semantics
 * (`$&`, `$'`, ...) would silently corrupt them. */
function splitOnAnchor(text, anchor, label) {
  const count = countOccurrences(text, anchor);
  if (count !== 1) {
    fail(
      `error: index.html anchor "${label}" found ${count} time(s), expected exactly 1 — ` +
        "index.html was restructured; update the anchors in scripts/build-webview.mjs, then rerun npm run build:webview."
    );
  }
  const idx = text.indexOf(anchor);
  return [text.slice(0, idx), text.slice(idx + anchor.length)];
}

/** Build the webview.html contents in memory from the current index.html.
 * Never writes anything — the caller decides whether to write (normal
 * mode) or byte-compare against the committed file (--check mode). */
async function build() {
  const indexHtml = await readFile(INDEX_PATH, "utf8");

  if (indexHtml.includes("${")) {
    fail(
      "error: index.html contains a literal \\${ — buildHtml()'s runtime placeholder " +
        "substitution would silently rewrite it; remove/escape it before regenerating the webview."
    );
  }
  if (indexHtml.includes('http-equiv="Content-Security-Policy"') || indexHtml.includes("<base ")) {
    fail(
      "error: index.html already contains a CSP meta tag or a <base> tag — " +
        "scripts/build-webview.mjs would double-insert; remove it from index.html (these belong " +
        "in the webview-only fragments in this script) before regenerating."
    );
  }

  const [beforeHead, afterHead] = splitOnAnchor(indexHtml, HEAD_ANCHOR, HEAD_ANCHOR.trim());
  const headInsert = "\n" + BANNER + "\n\n" + CSP_BLOCK + "\n\n" + BASE_BLOCK + "\n\n" + BOOTSTRAP_BLOCK + "\n\n";
  const withHead = beforeHead + HEAD_ANCHOR + headInsert + afterHead;

  const [beforeStyle, afterStyle] = splitOnAnchor(withHead, STYLE_ANCHOR, STYLE_ANCHOR.trim());
  const footInsert = FOCUS_CSS_BLOCK + "\n";
  const output = beforeStyle + footInsert + STYLE_ANCHOR + afterStyle;

  const missing = PLACEHOLDERS.filter((p) => !output.includes(p));
  if (missing.length > 0) {
    fail(
      `error: generated webview.html is missing runtime placeholder(s): ${missing.join(", ")} — ` +
        "the splice dropped a fragment; check the fragment constants in scripts/build-webview.mjs."
    );
  }

  return output;
}

async function main() {
  const output = await build();

  if (CHECK_MODE) {
    if (!existsSync(OUTPUT_PATH)) {
      fail(`${RELATIVE_OUTPUT_PATH} is stale — run \`npm run build:webview\` (or \`npm run build\`) and commit`);
    }
    const committed = await readFile(OUTPUT_PATH, "utf8");
    if (committed !== output) {
      let firstDiffLine = null;
      const committedLines = committed.split("\n");
      const outputLines = output.split("\n");
      for (let i = 0; i < Math.max(committedLines.length, outputLines.length); i++) {
        if (committedLines[i] !== outputLines[i]) {
          firstDiffLine = i + 1;
          break;
        }
      }
      fail(
        `${RELATIVE_OUTPUT_PATH} is stale — run \`npm run build:webview\` (or \`npm run build\`) and commit` +
          (firstDiffLine ? ` (first differing line: ${firstDiffLine})` : "")
      );
    }
    log(`OK — ${RELATIVE_OUTPUT_PATH} matches a fresh build.`);
    return;
  }

  await writeFile(OUTPUT_PATH, output);
  log(`wrote ${RELATIVE_OUTPUT_PATH}: ${Buffer.byteLength(output)} bytes`);
}

await main();
