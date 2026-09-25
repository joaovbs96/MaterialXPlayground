// Coverage for validator.js's scanXml tier-1 scanner: deleting one closing
// '>' on an element with children used to cascade into 3 diagnostics
// (the malformed tag, plus a mismatched-close and an orphan-close for its
// ancestors) instead of just the one that actually happened.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { scanXml } = await import(
  pathToFileURL(path.join(ROOT, 'vscode_extension', 'src', 'validator.js')).href
);

test('a missing ">" on an element with children reports one diagnostic, not a cascade', () => {
  const xml = '<materialx version="1.39"><nodegraph name="ng"<input name="in" type="float"/>'
    + '<output name="out" type="float" nodename="n"/></nodegraph></materialx>';
  const errors = scanXml(xml);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Malformed attribute syntax in tag <nodegraph>/);
});

test('two independent malformed tags still each report their own diagnostic', () => {
  const xml = '<materialx><a name="x"<b/></a><c name="y"<d/></c></materialx>';
  const errors = scanXml(xml);
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /<a>/);
  assert.match(errors[1].message, /<c>/);
});

test('a genuine mismatched closing tag unrelated to any malformed tag still reports', () => {
  const xml = '<materialx><a></b></materialx>';
  const errors = scanXml(xml);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Mismatched closing tag: expected <\/a> but found <\/b>/);
});

test('a missing ">" on a CLOSING tag reports one diagnostic, not a cascade', () => {
  const xml = '<materialx><nodegraph name="ng"><input name="in" type="float"/>'
    + '<output name="out" type="float" nodename="n"/></nodegraph</materialx>';
  const errors = scanXml(xml);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Unterminated tag <\/nodegraph>/);
});

test('a missing ">" on the final CLOSING tag at EOF reports one diagnostic', () => {
  const xml = '<materialx></materialx';
  const errors = scanXml(xml);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Unterminated tag <\/materialx>/);
});

test('unclosed tags at EOF are still reported one per remaining entry', () => {
  const xml = '<materialx><nodegraph name="ng">';
  const errors = scanXml(xml);
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /Unclosed tag <materialx>/);
  assert.match(errors[1].message, /Unclosed tag <nodegraph>/);
});
