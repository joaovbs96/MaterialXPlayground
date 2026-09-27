// Exercises nextFreeExampleName.js: smallest free numeric suffix,
// starting at 1, never touching an occupied name.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { nextFreeExampleName } = require('../../vscode_extension/src/nextFreeExampleName.js');

function existsAmong(taken) {
  return async (candidate) => taken.has(candidate);
}

test('base name free returns it unsuffixed', async () => {
  const result = await nextFreeExampleName('gold', existsAmong(new Set()));
  assert.equal(result.name, 'gold');
  assert.equal(result.n, 0);
});

test('base name taken returns _1', async () => {
  const result = await nextFreeExampleName('gold', existsAmong(new Set(['gold'])));
  assert.equal(result.name, 'gold_1');
});

test('base and _1 taken returns _2', async () => {
  const taken = new Set(['gold', 'gold_1']);
  const result = await nextFreeExampleName('gold', existsAmong(taken));
  assert.equal(result.name, 'gold_2');
});

test('base and _2 taken (but not _1) returns _1, not _3', async () => {
  const taken = new Set(['gold', 'gold_2']);
  const result = await nextFreeExampleName('gold', existsAmong(taken));
  assert.equal(result.name, 'gold_1');
});

test('startAt resumes the search past a known-taken number', async () => {
  const taken = new Set(['gold', 'gold_1', 'gold_2']);
  const result = await nextFreeExampleName('gold', existsAmong(taken), 2);
  assert.equal(result.name, 'gold_3');
});

test('existsFn is only asked about each candidate once, in order', async () => {
  const taken = new Set(['gold', 'gold_1']);
  const asked = [];
  const result = await nextFreeExampleName('gold', async (c) => {
    asked.push(c);
    return taken.has(c);
  });
  assert.equal(result.name, 'gold_2');
  assert.deepEqual(asked, ['gold', 'gold_1', 'gold_2']);
});
