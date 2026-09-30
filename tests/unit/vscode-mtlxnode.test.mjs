// Coverage for mtlxNode.js's per-call embind cleanup (a, fake env, every
// code path) and its xi:include containment against the real WASM (b,
// an absolute href must never reach Node's fs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mtlxNodePath = path.join(ROOT, 'vscode_extension', 'src', 'mtlxNode.js');

const { validateWithEnv, validateSemantic, getParseFailureCount } = await import(pathToFileURL(mtlxNodePath).href);

// ---------------------------------------------------------------------
// (a) fake env, every code path, delete() spied.

function makeDeletable(label, deletions) {
  return {
    _label: label,
    delete() {
      deletions.push(label);
    },
  };
}

// Builds a fake mx whose createDocument()/XmlReadOptions() objects push
// their label onto `deletions` when delete() runs, and whose
// readFromXmlString/validate behavior is driven by `behavior`.
function makeFakeMx(behavior, deletions, calls) {
  const hasXmlReadOptions = behavior.hasXmlReadOptions !== false;
  const mx = {
    createDocument() {
      const doc = makeDeletable('doc', deletions);
      doc.setDataLibrary = () => {};
      doc.validate = (holder) => {
        if (behavior.validateThrows) throw new Error('validate boom');
        if (behavior.validateOk === false) {
          holder.message = 'line one\nline two';
          return false;
        }
        return true;
      };
      return doc;
    },
    readFromXmlString(doc, text, searchPath, opts) {
      calls.push({ text, searchPath, opts });
      if (behavior.parseRejects) return Promise.reject(new Error('parse boom'));
      return Promise.resolve();
    },
  };
  if (hasXmlReadOptions) {
    mx.XmlReadOptions = function XmlReadOptions() {
      const o = makeDeletable('opts', deletions);
      o.readXIncludes = true; // default, mirrors the real binding
      return o;
    };
  }
  return mx;
}

test('validateWithEnv frees doc+opts exactly once when the parse rejects', async () => {
  const deletions = [];
  const calls = [];
  const mx = makeFakeMx({ parseRejects: true }, deletions, calls);
  const before = getParseFailureCount();
  const result = await validateWithEnv({ mx, stdlib: {} }, '<materialx/>');

  assert.equal(result.available, true);
  assert.match(result.messages[0].text, /could not parse/);
  assert.deepEqual(deletions.sort(), ['doc', 'opts']);
  assert.equal(getParseFailureCount(), before + 1);
  assert.equal(calls[0].opts.readXIncludes, false);
});

test('validateWithEnv frees doc+opts exactly once when validate() throws', async () => {
  const deletions = [];
  const calls = [];
  const mx = makeFakeMx({ validateThrows: true }, deletions, calls);
  const result = await validateWithEnv({ mx, stdlib: {} }, '<materialx/>');

  assert.equal(result.available, true);
  assert.match(result.messages[0].text, /failed validation/);
  assert.deepEqual(deletions.sort(), ['doc', 'opts']);
});

test('validateWithEnv frees doc+opts exactly once when validate() returns false', async () => {
  const deletions = [];
  const calls = [];
  const mx = makeFakeMx({ validateOk: false }, deletions, calls);
  const result = await validateWithEnv({ mx, stdlib: {} }, '<materialx/>');

  assert.equal(result.available, true);
  assert.equal(result.messages.length, 2);
  assert.deepEqual(deletions.sort(), ['doc', 'opts']);
});

test('validateWithEnv frees doc+opts exactly once when validate() returns true', async () => {
  const deletions = [];
  const calls = [];
  const mx = makeFakeMx({ validateOk: true }, deletions, calls);
  const result = await validateWithEnv({ mx, stdlib: {} }, '<materialx/>');

  assert.deepEqual(result, { available: true, messages: [] });
  assert.deepEqual(deletions.sort(), ['doc', 'opts']);
});

test('validateWithEnv frees only doc when XmlReadOptions is unbound', async () => {
  const deletions = [];
  const calls = [];
  const mx = makeFakeMx({ validateOk: true, hasXmlReadOptions: false }, deletions, calls);
  const result = await validateWithEnv({ mx, stdlib: {} }, '<materialx/>');

  assert.deepEqual(result, { available: true, messages: [] });
  assert.deepEqual(deletions, ['doc']);
  assert.equal(calls[0].opts, undefined);
});

// ---------------------------------------------------------------------
// (b) real WASM: an absolute xi:include href must never reach Node's fs.

test('validateSemantic never reads an absolute xi:include href from disk', async (t) => {
  const original = {
    readFile: fs.readFile,
    readFileSync: fs.readFileSync,
    openSync: fs.openSync,
  };
  const recordedPaths = [];
  const record = (fn) => function patched(p, ...rest) {
    recordedPaths.push(String(p));
    return fn.call(fs, p, ...rest);
  };
  fs.readFile = record(original.readFile);
  fs.readFileSync = record(original.readFileSync);
  fs.openSync = record(original.openSync);
  t.after(() => {
    fs.readFile = original.readFile;
    fs.readFileSync = original.readFileSync;
    fs.openSync = original.openSync;
  });

  const xml = '<?xml version="1.0"?><materialx version="1.39">'
    + '<xi:include href="/definitely/absent.mtlx"/></materialx>';
  const result = await validateSemantic(ROOT, xml);

  assert.equal(result.available, true, 'the bundled WASM must load in this environment');
  const leaked = recordedPaths.filter((p) => p.includes('definitely'));
  assert.deepEqual(leaked, [], 'no fs read should ever touch the malicious href');
});
