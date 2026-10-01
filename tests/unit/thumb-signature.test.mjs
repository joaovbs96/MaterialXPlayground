import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadModule() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'graph', 'thumb-signature.js'), 'utf8');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return sandbox.MtlxThumbSignature;
}
const deepEq = (a, b) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);
const { computeSignatures, fnv64 } = loadModule();

// Tiny XML parser: elements, attributes, comments and self-closing tags only.
function parse(xml) {
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/)?([\w:.-]+)((?:\s+[\w:.-]+="[^"]*")*)\s*(\/)?>/g;
  const stack = [];
  let rootEl = null;
  let m;
  while ((m = re.exec(xml))) {
    if (!m[2]) continue;
    if (m[1]) { stack.pop(); continue; }
    const attrs = {};
    for (const a of m[3].matchAll(/([\w:.-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    const el = { tag: m[2], attrs, kids: [] };
    if (stack.length) stack[stack.length - 1].kids.push(el);
    else rootEl = el;
    if (!m[4]) stack.push(el);
  }
  return rootEl;
}

const BASE = `<?xml version="1.0"?>
<materialx version="1.39" colorspace="srgb_texture" fileprefix="tex/">
  <constant name="c1" type="color3">
    <input name="value" type="color3" value="0.1, 0.2, 0.3" />
  </constant>
  <noise2d name="n1" type="float" xpos="1" ypos="2" uicolor="0.1,0.2,0.3">
    <input name="amplitude" type="float" value="0.5" />
  </noise2d>
  <mix name="m1" type="color3">
    <input name="fg" type="color3" nodename="c1" />
    <input name="bg" type="color3" value="1, 1, 1" />
    <input name="mix" type="float" nodename="n1" />
  </mix>
  <image name="img" type="color3">
    <input name="file" type="filename" value="a.png" />
  </image>
  <nodegraph name="ng1">
    <input name="k" type="float" value="2" />
    <multiply name="mul" type="float">
      <input name="in1" type="float" interfacename="k" />
      <input name="in2" type="float" value="3" />
    </multiply>
    <output name="out" type="float" nodename="mul" />
  </nodegraph>
  <convert name="down" type="float">
    <input name="in" type="float" nodegraph="ng1" output="out" />
  </convert>
  <output name="top" type="color3" nodename="m1" />
</materialx>`;

const T = (id, scope = '') => [{ key: 'k', scope, id }];
const sigOf = (xml, id, scope = '', opts = { salt: 's' }) => computeSignatures(parse(xml), T(id, scope), opts).k;
const edit = (from, to) => {
  assert.ok(BASE.includes(from), 'edit anchor present: ' + from);
  return BASE.replace(from, to);
};

test('fnv64 matches the reference vectors', () => {
  assert.equal(fnv64(''), 'cbf29ce484222325');
  assert.equal(fnv64('a'), 'af63dc4c8601ec8c');
  assert.equal(fnv64('foobar'), '85944171f73967e8');
});

test('stable under rename, position edits, unrelated edits and re-parse', () => {
  const s = sigOf(BASE, 'n:m1');
  assert.match(s, /^[0-9a-f]{16}$/);
  assert.equal(sigOf(BASE, 'n:m1'), s);
  assert.equal(sigOf(edit('name="c1"', 'name="renamed"').replace('nodename="c1"', 'nodename="renamed"'), 'n:m1'), s);
  assert.equal(sigOf(edit('xpos="1" ypos="2"', 'xpos="99" ypos="-4"'), 'n:m1'), s);
  assert.equal(sigOf(edit('uicolor="0.1,0.2,0.3"', 'uicolor="0.9,0.9,0.9"'), 'n:m1'), s);
  assert.equal(sigOf(edit('value="0.5"', 'value="0.5"').replace('<mix name="m1"', '<mix name="m1" doc="hi" uiname="Mix"'), 'n:m1'), s);
  // Unrelated: the image node and a new unrelated node.
  assert.equal(sigOf(edit('value="a.png"', 'value="b.png"'), 'n:m1'), s);
  assert.equal(sigOf(edit('<output name="top"', '<constant name="zzz" type="float"><input name="value" type="float" value="1" /></constant><output name="top"'), 'n:m1'), s);
});

test('stable under nodegraph rename for g: card and downstream node', () => {
  const renamed = edit('<nodegraph name="ng1">', '<nodegraph name="ngX">').replace('nodegraph="ng1"', 'nodegraph="ngX"');
  assert.equal(sigOf(renamed, 'g:ngX'), sigOf(BASE, 'g:ng1'));
  assert.equal(sigOf(renamed, 'n:down'), sigOf(BASE, 'n:down'));
});

test('changes on an upstream value edit', () => {
  const s = sigOf(BASE, 'n:m1');
  assert.notEqual(sigOf(edit('value="0.1, 0.2, 0.3"', 'value="0.1, 0.2, 0.4"'), 'n:m1'), s);
  assert.notEqual(sigOf(edit('value="0.5"', 'value="0.6"'), 'n:m1'), s);
  assert.notEqual(sigOf(edit('value="1, 1, 1"', 'value="1, 1, 0"'), 'n:m1'), s);
});

test('changes on a connection change', () => {
  const s = sigOf(BASE, 'n:m1');
  assert.notEqual(sigOf(edit('<input name="mix" type="float" nodename="n1" />', '<input name="mix" type="float" value="0.5" />'), 'n:m1'), s);
  assert.notEqual(sigOf(edit('<input name="fg" type="color3" nodename="c1" />', '<input name="fg" type="color3" nodename="img" />'), 'n:m1'), s);
  assert.notEqual(sigOf(edit('<input name="in" type="float" nodegraph="ng1" output="out" />', '<input name="in" type="float" value="1" />'), 'n:down'), sigOf(BASE, 'n:down'));
});

test('an edit inside a referenced nodegraph reaches the g: card and downstream node', () => {
  const edited = edit('<input name="in2" type="float" value="3" />', '<input name="in2" type="float" value="4" />');
  assert.notEqual(sigOf(edited, 'g:ng1'), sigOf(BASE, 'g:ng1'));
  assert.notEqual(sigOf(edited, 'n:down'), sigOf(BASE, 'n:down'));
  assert.equal(sigOf(edited, 'n:m1'), sigOf(BASE, 'n:m1'));
  // Inside the graph, only the node that uses it moves.
  assert.notEqual(sigOf(edited, 'n:mul', 'ng1'), sigOf(BASE, 'n:mul', 'ng1'));
});

test('a local nodedef edit affects an instance, an unrelated node is unaffected', () => {
  const withDef = (v) => `<materialx version="1.39">
    <nodedef name="ND_my" node="my">
      <input name="a" type="float" value="${v}" />
      <output name="out" type="float" />
    </nodedef>
    <my name="inst" type="float"><input name="a" type="float" value="1" /></my>
    <constant name="plain" type="float"><input name="value" type="float" value="1" /></constant>
  </materialx>`;
  assert.notEqual(sigOf(withDef('0.1'), 'n:inst'), sigOf(withDef('0.2'), 'n:inst'));
  assert.equal(sigOf(withDef('0.1'), 'n:plain'), sigOf(withDef('0.2'), 'n:plain'));
  assert.notEqual(sigOf(withDef('0.1'), 'd:ND_my'), sigOf(withDef('0.2'), 'd:ND_my'));
});

test('functional graph scope depends on the definitions', () => {
  const doc = (v) => `<materialx version="1.39">
    <nodedef name="ND_f" node="f"><input name="a" type="float" value="${v}" /><output name="out" type="float" /></nodedef>
    <nodegraph name="NG_f" nodedef="ND_f">
      <multiply name="m" type="float"><input name="in1" type="float" interfacename="a" /><input name="in2" type="float" value="2" /></multiply>
      <output name="out" type="float" nodename="m" />
    </nodegraph>
  </materialx>`;
  assert.notEqual(sigOf(doc('1'), 'n:m', 'NG_f'), sigOf(doc('2'), 'n:m', 'NG_f'));
});

test('interface input value change reaches nodes that use it', () => {
  const s = sigOf(BASE, 'n:mul', 'ng1');
  assert.notEqual(sigOf(edit('<input name="k" type="float" value="2" />', '<input name="k" type="float" value="5" />'), 'n:mul', 'ng1'), s);
});

test('ancestor fileprefix and colorspace changes invalidate', () => {
  const s = sigOf(BASE, 'n:img');
  assert.notEqual(sigOf(edit('fileprefix="tex/"', 'fileprefix="other/"'), 'n:img'), s);
  assert.notEqual(sigOf(edit('colorspace="srgb_texture"', 'colorspace="lin_rec709"'), 'n:img'), s);
  const inGraph = BASE.replace('<nodegraph name="ng1">', '<nodegraph name="ng1" colorspace="acescg">');
  assert.notEqual(sigOf(inGraph, 'n:mul', 'ng1'), sigOf(BASE, 'n:mul', 'ng1'));
});

test('fileIdentity feeds filename inputs and changes invalidate', () => {
  const ids = { 'a.png': 'v1' };
  const calls = [];
  const opts = () => ({ salt: 's', fileIdentity: (v, el, anc) => { calls.push([v, el.tag, anc.length]); return ids[v] || v; } });
  const s1 = sigOf(BASE, 'n:img', '', opts());
  deepEq(calls[0], ['a.png', 'input', 2]);
  ids['a.png'] = 'v2';
  assert.notEqual(sigOf(BASE, 'n:img', '', opts()), s1);
  // The image is not upstream of the mix node, so its identity does not matter there.
  const m1 = sigOf(BASE, 'n:m1', '', opts());
  ids['a.png'] = 'v3';
  assert.equal(sigOf(BASE, 'n:m1', '', opts()), m1);
});

test('salt changes every signature', () => {
  assert.notEqual(sigOf(BASE, 'n:m1', '', { salt: 'a' }), sigOf(BASE, 'n:m1', '', { salt: 'b' }));
});

test('o: and i: targets work, unknown targets are absent', () => {
  const o = sigOf(BASE, 'o:top');
  assert.ok(o);
  assert.notEqual(sigOf(edit('value="0.5"', 'value="0.7"'), 'o:top'), o);
  const i = sigOf(BASE, 'i:k', 'ng1');
  assert.ok(i);
  assert.notEqual(sigOf(edit('<input name="k" type="float" value="2" />', '<input name="k" type="float" value="3" />'), 'i:k', 'ng1'), i);
  assert.ok(sigOf(BASE, 'o:out', 'ng1'));
  const res = computeSignatures(parse(BASE), [
    { key: 'a', scope: '', id: 'n:nope' },
    { key: 'b', scope: 'nope', id: 'n:mul' },
    { key: 'c', scope: '', id: 'i:k' },
    { key: 'd', scope: '', id: 'x:m1' },
    { key: 'e', scope: '', id: 'n:m1' },
  ], { salt: 's' });
  deepEq(Object.keys(res), ['e']);
});

test('origin adds the origin element and its upstream', () => {
  const target = { key: 'k', scope: 'ng1', id: 'n:mul', originId: 'n:m1', originScope: '' };
  const plain = computeSignatures(parse(BASE), [{ key: 'k', scope: 'ng1', id: 'n:mul' }], { salt: 's' }).k;
  const withOrigin = (xml) => computeSignatures(parse(xml), [target], { salt: 's' }).k;
  assert.notEqual(withOrigin(BASE), plain);
  assert.notEqual(withOrigin(edit('value="0.1, 0.2, 0.3"', 'value="0.1, 0.2, 0.5"')), withOrigin(BASE));
});

test('i: targets in a functional graph resolve to the nodedef input', () => {
  const doc = (v, extra = '') => `<materialx version="1.39">
    <nodedef name="ND_f" node="f"><input name="a" type="float" value="${v}" /><output name="out" type="float" /></nodedef>
    <nodegraph name="NG_f" nodedef="ND_f">
      <multiply name="m" type="float"><input name="in1" type="float" interfacename="a" /><input name="in2" type="float" value="2" /></multiply>
      <output name="out" type="float" nodename="m" />
    </nodegraph>${extra}
  </materialx>`;
  const s1 = sigOf(doc('1'), 'i:a', 'NG_f');
  assert.ok(s1, 'signature exists');
  assert.notEqual(s1, sigOf(doc('2'), 'i:a', 'NG_f'));
  assert.equal(s1, sigOf(doc('1'), 'i:a', 'NG_f'));
  assert.equal(sigOf(doc('1'), 'i:missing', 'NG_f'), undefined);
  // An unrelated definition edit still moves it (defsHash is included).
  const other = '<nodedef name="ND_g" node="g"><output name="out" type="float" /></nodedef>';
  assert.notEqual(s1, sigOf(doc('1', other), 'i:a', 'NG_f'));
});
