import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = fs.readFileSync(path.join(root, 'js', 'usd', 'usd-stage-worker.js'), 'utf8').split('\r\n').join('\n');
const start = src.indexOf('function rewriteRuntimeWarnings');
const end = src.indexOf('\n}\n', start) + 3;
const ctx = {};
vm.runInNewContext(src.slice(start, end) + '\nthis.f = rewriteRuntimeWarnings;', ctx);
const msg = (op) => `Warning: in _GetOrderedXformOps at line 690 of x/xformable.cpp -- Unable to get attribute associated with the xformOp 'xformOp:${op}', on the prim at path </glove_baseball/geo/glove_baseball>. Skipping xformOp in the computation of the local transformation at prim.`;

test('xformOp warnings collapse to one info note per prim', () => {
  const out = ctx.f([msg('translate'), 'Other warning', msg('orient'), msg('scale')]);
  assert.deepEqual(Array.from(out), [
    '[info] The file lists transform steps without values (translate, orient, scale on glove_baseball); they were ignored.',
    'Other warning',
  ]);
});
