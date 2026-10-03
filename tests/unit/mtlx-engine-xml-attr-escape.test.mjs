import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'js/mtlx-engine.js'), 'utf8');

// Isolate the pure XML text helpers (attribute escaping and the
// formatting-preserving save) without pulling in the rest of the engine.
const start = source.indexOf('const escapeXmlAttrSpecials =');
const end = source.indexOf('// Session-lifetime texture cache', start);
assert.ok(start >= 0 && end > start, 'could not locate the XML text helpers in mtlx-engine.js');
const context = {};
vm.createContext(context);
vm.runInContext(source.slice(start, end)
  + '\nthis.escapeXmlAttrSpecials = escapeXmlAttrSpecials;'
  + '\nthis.preserveSourceFormatting = preserveSourceFormatting;', context);
const { escapeXmlAttrSpecials, preserveSourceFormatting } = context;

// What MaterialX's writer emits for an attribute holding SLX code: &, " and
// line breaks escaped, but <, > and tabs left raw.
const WRITTEN = [
  '<?xml version="1.0"?>',
  '<materialx version="1.39">',
  '  <!-- a < b > c\tstays -->',
  '  <nodegraph name="NG_f" slxsource="if (a < b &amp;&amp; c > d)&#10;\treturn &quot;x&quot;;" xpos="1">',
  '    <input name="in1" type="float" value="0" />',
  '  </nodegraph>',
  '</materialx>',
].join('\n');

test('escapes <, > and tabs inside attribute values only', () => {
  const out = escapeXmlAttrSpecials(WRITTEN);
  assert.match(out, /slxsource="if \(a &lt; b &amp;&amp; c &gt; d\)&#10;&#9;return &quot;x&quot;;" xpos="1">/);
  assert.match(out, /<!-- a < b > c\tstays -->/);
  assert.equal(out.replace(/slxsource="[^"]*"/, ''), WRITTEN.replace(/slxsource="[^"]*"/, ''));
});

test('leaves a document without such attributes untouched', () => {
  const plain = '<materialx version="1.39">\n  <constant name="c" type="float" />\n</materialx>';
  assert.equal(escapeXmlAttrSpecials(plain), plain);
});

test('a changed multi-line attribute keeps its line breaks escaped through a formatting-preserving save', () => {
  const sourceText = [
    '<materialx version="1.39">',
    '  <nodegraph name="NG_f"   slxsource="a&#10;b"   xpos="1">',
    '  </nodegraph>',
    '</materialx>',
  ].join('\n');
  const written = escapeXmlAttrSpecials([
    '<materialx version="1.39">',
    '  <nodegraph name="NG_f" slxsource="a < 1&#10;&#9;c" xpos="1">',
    '  </nodegraph>',
    '</materialx>',
  ].join('\n'));
  const saved = preserveSourceFormatting(sourceText, written);
  // The source tag's own layout (extra spaces) is kept, its value patched.
  assert.match(saved, /<nodegraph name="NG_f" {3}slxsource="a &lt; 1&#10;&#9;c" {3}xpos="1">/);
  assert.doesNotMatch(saved.split('slxsource="')[1].split('"')[0], /[\n\t<]/);
});
