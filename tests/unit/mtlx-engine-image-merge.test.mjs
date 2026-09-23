import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Slices the element helpers and the duplicate-image pass out of the engine,
// the same way mtlx-engine-texture-sampler.test.mjs slices the sampler code.
function loadMergeHarness() {
  const source = fs.readFileSync(path.join(root, 'js', 'mtlx-engine.js'), 'utf8');
  const take = (from, to) => {
    const a = source.indexOf(from);
    const b = source.indexOf(to, a);
    assert.ok(a >= 0 && b > a, 'slice anchor is present: ' + from);
    return source.slice(a, b);
  };
  const helpers = take('const vecToArray =', 'const mxSetColorspace =');
  const merge = take('// Image-family nodes that cost one sampler2D',
    '// ------------------------------------------------------------------\n// generatePreviewSources');
  const context = { console, window: {}, mxWarnIfLocked: () => {} };
  vm.runInNewContext(helpers + '\n' + merge
    + '\nthis.mergeDuplicateImageNodes = mergeDuplicateImageNodes;'
    + '\nthis.mxNodeSignature = mxNodeSignature;', context, {
    filename: path.join(root, 'js', 'mtlx-engine.js'),
  });
  return context;
}

// Minimal stand-ins for the wasm element bindings the pass uses.
function element(category, name, type, attrs = {}, children = []) {
  const own = Object.assign({ type }, attrs);
  return {
    getCategory: () => category,
    getName: () => name,
    getType: () => type,
    getAttributeNames: () => Object.keys(own),
    getAttribute: (key) => (own[key] === undefined ? '' : own[key]),
    hasAttribute: (key) => own[key] !== undefined,
    setAttribute: (key, value) => { own[key] = value; },
    getChildren: () => children,
    getInputs: () => children.filter((child) => child.getCategory() === 'input'),
    attrs: own,
  };
}

const input = (name, type, attrs) => element('input', name, type, attrs);

function imageNode(name, file, extra = []) {
  return element('image', name, 'color3', {}, [input('file', 'filename', { value: file }), ...extra]);
}

function documentOf(children, graphs = []) {
  return {
    getChildren: () => children,
    getNodeGraphs: () => graphs,
  };
}

test('merges two identical image nodes and rewires downstream inputs', () => {
  const { mergeDuplicateImageNodes } = loadMergeHarness();
  const a = imageNode('img_a', 'wood.png');
  const b = imageNode('img_b', 'wood.png');
  const consumer = element('multiply', 'mul', 'color3', {}, [
    input('in1', 'color3', { nodename: 'img_a' }),
    input('in2', 'color3', { nodename: 'img_b' }),
  ]);
  const doc = documentOf([a, b, consumer]);

  const result = mergeDuplicateImageNodes(doc);
  assert.equal(result.merged, 1);
  // The pass runs in its own vm realm, so compare by value, not by shape.
  assert.equal(JSON.stringify(result.groups), JSON.stringify([{ kept: 'img_a', merged: 'img_b' }]));
  assert.equal(consumer.getInputs()[1].getAttribute('nodename'), 'img_a');

  result.restore();
  assert.equal(consumer.getInputs()[1].getAttribute('nodename'), 'img_b');
});

test('keeps image nodes that differ in file, colorspace or address mode', () => {
  const { mergeDuplicateImageNodes } = loadMergeHarness();
  const doc = documentOf([
    imageNode('a', 'wood.png'),
    imageNode('b', 'metal.png'),
    element('image', 'c', 'color3', {}, [input('file', 'filename', { value: 'wood.png', colorspace: 'srgb_texture' })]),
    element('image', 'd', 'color3', {}, [
      input('file', 'filename', { value: 'wood.png' }),
      input('uaddressmode', 'string', { value: 'clamp' }),
    ]),
    element('tiledimage', 'e', 'color3', {}, [input('file', 'filename', { value: 'wood.png' })]),
  ]);
  assert.equal(mergeDuplicateImageNodes(doc).merged, 0);
});

test('leaves non-image nodes and interface-bound images alone', () => {
  const { mergeDuplicateImageNodes } = loadMergeHarness();
  const doc = documentOf([
    element('add', 'x', 'float', {}, [input('in2', 'float', { value: '1' })]),
    element('add', 'y', 'float', {}, [input('in2', 'float', { value: '1' })]),
    element('image', 'bound_a', 'color3', {}, [input('file', 'filename', { interfacename: 'tex' })]),
    element('image', 'bound_b', 'color3', {}, [input('file', 'filename', { interfacename: 'tex' })]),
  ]);
  assert.equal(mergeDuplicateImageNodes(doc).merged, 0);
});

test('merges inside a nodegraph and rewires its output element', () => {
  const { mergeDuplicateImageNodes } = loadMergeHarness();
  const a = imageNode('g_a', 'wood.png');
  const b = imageNode('g_b', 'wood.png');
  const out = element('output', 'out', 'color3', { nodename: 'g_b' });
  const graph = {
    getChildren: () => [a, b, out],
    getNodeGraphs: () => [],
  };
  const doc = documentOf([], [graph]);

  const result = mergeDuplicateImageNodes(doc);
  assert.equal(result.merged, 1);
  assert.equal(out.getAttribute('nodename'), 'g_a');
  result.restore();
  assert.equal(out.getAttribute('nodename'), 'g_b');
});

test('node signature ignores editor-only attributes', () => {
  const { mxNodeSignature } = loadMergeHarness();
  const a = element('image', 'a', 'color3', { xpos: '1', ypos: '2' }, [input('file', 'filename', { value: 'wood.png' })]);
  const b = element('image', 'b', 'color3', { xpos: '9' }, [input('file', 'filename', { value: 'wood.png' })]);
  assert.equal(mxNodeSignature(a), mxNodeSignature(b));
});
