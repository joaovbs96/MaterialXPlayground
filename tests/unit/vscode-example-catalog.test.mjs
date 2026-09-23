// Exercises exampleCatalog.js's static data: every entry must point at
// real repo files, list every texture its .mtlx references, use a unique
// id, and (upstream MaterialX Examples) have no filename input or include.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const catalog = require('../../vscode_extension/src/exampleCatalog.js');
const { extractFilenameRefs } = require('../../vscode_extension/src/docScanner.js');

const REPO_ROOT = catalog.REPO_ROOT;

test('every catalog entry has a unique id', () => {
  const entries = catalog.getCatalog();
  assert.ok(entries.length >= 8, 'expected a non-trivial catalog, got ' + entries.length);
  const ids = new Set();
  for (const e of entries) {
    assert.ok(!ids.has(e.id), 'duplicate id: ' + e.id);
    ids.add(e.id);
  }
});

test('every file in every entry exists on disk under the repo', () => {
  for (const e of catalog.getCatalog()) {
    assert.ok(e.files.length > 0, e.id + ': no files listed');
    for (const f of e.files) {
      const abs = path.join(REPO_ROOT, ...f.from.split('/'));
      assert.ok(fs.existsSync(abs), e.id + ': missing source file ' + f.from);
    }
  }
});

test('every texture referenced by an example is present in its copy list', () => {
  for (const e of catalog.getCatalog()) {
    const abs = path.join(REPO_ROOT, ...e.mtlxPath.split('/'));
    const text = fs.readFileSync(abs, 'utf8');
    const refs = extractFilenameRefs(text).map((r) => r.replace(/\\/g, '/').replace(/^\.\//, ''));
    const relSet = new Set(e.files.map((f) => f.rel));
    for (const ref of refs) {
      assert.ok(relSet.has(ref), e.id + ': texture ref "' + ref + '" not in copy list ' + JSON.stringify(e.files.map((f) => f.rel)));
    }
    // hasTextures must agree with there actually being texture refs.
    assert.equal(e.hasTextures, refs.length > 0, e.id + ': hasTextures disagrees with the document\'s own filename refs');
  }
});

test('upstream MaterialX Examples entries have no filename inputs and no xi:include', () => {
  const upstream = catalog.getCatalog().filter((e) => e.source === catalog.SOURCE_EXAMPLES);
  assert.ok(upstream.length >= 8 && upstream.length <= 12, 'expected 8-12 curated upstream examples, got ' + upstream.length);
  for (const e of upstream) {
    const abs = path.join(REPO_ROOT, ...e.mtlxPath.split('/'));
    const text = fs.readFileSync(abs, 'utf8');
    assert.ok(!/type\s*=\s*"filename"/.test(text), e.id + ': has a filename input, not allowed in the curated upstream set');
    assert.ok(!/xi:include/.test(text), e.id + ': has an xi:include, not allowed in the curated upstream set');
    assert.equal(e.files.length, 1, e.id + ': upstream entry should copy exactly the .mtlx file');
    assert.equal(e.hasTextures, false, e.id + ': upstream entry should have no textures');
  }
});

test('every entry has a label, shading model, source and license', () => {
  for (const e of catalog.getCatalog()) {
    assert.ok(e.label && e.label.length > 0, e.id + ': missing label');
    assert.ok(e.shadingModel && e.shadingModel.length > 0, e.id + ': missing shadingModel');
    assert.ok(e.source && e.source.length > 0, e.id + ': missing source');
    assert.ok(e.license && e.license.length > 0, e.id + ': missing license');
  }
});

test('getExample resolves a known id and returns null for an unknown one', () => {
  const entries = catalog.getCatalog();
  const first = entries[0];
  assert.equal(catalog.getExample(first.id), catalog.getExample(first.id)); // same shape twice
  assert.equal(catalog.getExample(first.id).id, first.id);
  assert.equal(catalog.getExample('not-a-real-id'), null);
});
