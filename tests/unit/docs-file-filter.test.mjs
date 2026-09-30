// Unit coverage for js/docs-app.jsx's file-based tree filter helpers
// (scanMtlxFileTags, categoriesFromFileTags). The file is Babel/JSX-only
// (mixed with React code further down) so it can't be import()'d directly
// in Node; this test extracts just those two trivial, JSX-free function
// bodies by source text and evaluates them in isolation instead.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, '../../js/docs-app.jsx'), 'utf8');

// Pulls one top-level `function <name>(...) { ... }` out of src by
// brace-matching from its first `{`, since the file has no export map.
function extractFunction(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found in docs-app.jsx`);
  const braceStart = src.indexOf('{', start);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

// scanMtlxFileTags closes over this module-level const; pull it out the
// same brace-matching way (it's a `new Set([...])` literal, single stmt).
function extractConst(name) {
  const start = src.indexOf(`const ${name} =`);
  assert.ok(start >= 0, `const ${name} not found in docs-app.jsx`);
  const end = src.indexOf(');', start) + 2;
  return src.slice(start, end);
}

const scanMtlxFileTags = new Function(
  `${extractConst('MTLX_STRUCTURAL_TAGS')}\n${extractFunction('scanMtlxFileTags')}\nreturn scanMtlxFileTags;`
)();
const categoriesFromFileTags = new Function(
  `${extractFunction('categoriesFromFileTags')}\nreturn categoriesFromFileTags;`
)();

test('scanMtlxFileTags: drops structural elements, keeps node tags', () => {
  const xml = `<?xml version="1.0"?>
<materialx version="1.39">
  <nodegraph name="NG_main">
    <image name="img1" type="color3">
      <input name="file" type="filename" value="tex.png" />
    </image>
    <mix name="m1" type="color3">
      <input name="fg" type="color3" nodename="img1" />
    </mix>
    <output name="out" type="color3" nodename="m1" />
  </nodegraph>
</materialx>`;
  const tags = scanMtlxFileTags(xml);
  assert.deepEqual(new Set(tags), new Set(['image', 'mix']));
});

test('scanMtlxFileTags: empty/garbage input yields no tags', () => {
  assert.deepEqual(scanMtlxFileTags(''), []);
  assert.deepEqual(scanMtlxFileTags(null), []);
  assert.deepEqual(scanMtlxFileTags('not xml at all'), []);
});

test('categoriesFromFileTags: intersects with the loaded library', () => {
  const jsonData = {
    stdlib: {
      texture2d: { image: {}, tiledimage: {} },
      compositing: { mix: {} },
    },
  };
  const result = categoriesFromFileTags(['image', 'mix', 'not_a_node'], jsonData);
  assert.deepEqual(result.sort(), ['image', 'mix']);
});

test('categoriesFromFileTags: no jsonData or no tags returns empty', () => {
  assert.deepEqual(categoriesFromFileTags(['image'], null), []);
  assert.deepEqual(categoriesFromFileTags([], { stdlib: { g: { image: {} } } }), []);
});
