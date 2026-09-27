// Exercises mtlxSymbols.js's collectFilenameRefs() (E9's pure resolver):
// fileprefix inheritance, UDIM/empty skip, value-range extraction. The
// actual file Uri resolution is docScanner.js's job, covered elsewhere.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mtlxSymbols = require('../../vscode_extension/src/mtlxSymbols.js');

test('collectFilenameRefs: a root-level filename input with no fileprefix resolves to its own value', () => {
  const doc = '<materialx version="1.39"><input name="i" type="filename" value="tex.png" /></materialx>';
  const { root } = mtlxSymbols.scanElements(doc);
  const refs = mtlxSymbols.collectFilenameRefs(root);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].value, 'tex.png');
  assert.equal(refs[0].ref, 'tex.png');
});

test('collectFilenameRefs: root <materialx fileprefix> is prepended to a top-level filename ref', () => {
  const doc = '<materialx version="1.39" fileprefix="textures/">'
    + '<input name="i" type="filename" value="tex.png" />'
    + '</materialx>';
  const { root } = mtlxSymbols.scanElements(doc);
  const refs = mtlxSymbols.collectFilenameRefs(root);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].ref, 'textures/tex.png');
});

test('collectFilenameRefs: a nodegraph fileprefix is inherited on top of the root prefix', () => {
  const doc = '<materialx version="1.39" fileprefix="base/">'
    + '<nodegraph name="NG1" fileprefix="sub/">'
    + '<image name="img" type="color3"><input name="file" type="filename" value="tex.png" /></image>'
    + '</nodegraph>'
    + '</materialx>';
  const { root } = mtlxSymbols.scanElements(doc);
  const refs = mtlxSymbols.collectFilenameRefs(root);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].ref, 'base/sub/tex.png');
});

test('collectFilenameRefs: a filename ref outside any nodegraph does not pick up a sibling nodegraph\'s fileprefix', () => {
  const doc = '<materialx version="1.39" fileprefix="base/">'
    + '<nodegraph name="NG1" fileprefix="sub/">'
    + '<image name="img" type="color3"><input name="file" type="filename" value="a.png" /></image>'
    + '</nodegraph>'
    + '<input name="i" type="filename" value="b.png" />'
    + '</materialx>';
  const { root } = mtlxSymbols.scanElements(doc);
  const refs = mtlxSymbols.collectFilenameRefs(root);
  const byValue = Object.fromEntries(refs.map((r) => [r.value, r.ref]));
  assert.equal(byValue['a.png'], 'base/sub/a.png');
  assert.equal(byValue['b.png'], 'base/b.png');
});

test('collectFilenameRefs: a <UDIM>/templated value is skipped entirely', () => {
  const doc = '<materialx version="1.39">'
    + '<input name="i" type="filename" value="tex_<UDIM>.png" />'
    + '<input name="j" type="filename" value="ok.png" />'
    + '</materialx>';
  const { root } = mtlxSymbols.scanElements(doc);
  const refs = mtlxSymbols.collectFilenameRefs(root);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].value, 'ok.png');
});

test('collectFilenameRefs: an empty value= is skipped', () => {
  const doc = '<materialx version="1.39"><input name="i" type="filename" value="" /></materialx>';
  const { root } = mtlxSymbols.scanElements(doc);
  const refs = mtlxSymbols.collectFilenameRefs(root);
  assert.equal(refs.length, 0);
});

test('collectFilenameRefs: a non-filename input is ignored, even with a similar-looking value', () => {
  const doc = '<materialx version="1.39"><input name="i" type="string" value="tex.png" /></materialx>';
  const { root } = mtlxSymbols.scanElements(doc);
  const refs = mtlxSymbols.collectFilenameRefs(root);
  assert.equal(refs.length, 0);
});

test('collectFilenameRefs: the returned range is the value text\'s own quoted range', () => {
  const doc = '<materialx version="1.39"><input name="i" type="filename" value="tex.png" /></materialx>';
  const { root } = mtlxSymbols.scanElements(doc);
  const refs = mtlxSymbols.collectFilenameRefs(root);
  const line = doc.split('\n')[refs[0].range.start.line];
  const extracted = line.slice(refs[0].range.start.character, refs[0].range.end.character);
  assert.equal(extracted, 'tex.png');
});

test('isTemplatedFilenameValue: true for empty and for any value containing "<"', () => {
  assert.equal(mtlxSymbols.isTemplatedFilenameValue(''), true);
  assert.equal(mtlxSymbols.isTemplatedFilenameValue(null), true);
  assert.equal(mtlxSymbols.isTemplatedFilenameValue('a<UDIM>.png'), true);
  assert.equal(mtlxSymbols.isTemplatedFilenameValue('plain.png'), false);
});
