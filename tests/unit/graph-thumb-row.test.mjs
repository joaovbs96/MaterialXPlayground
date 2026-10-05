import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadStyle() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const source = fs.readFileSync(path.join(root, 'js', 'graph', 'style.jsx'), 'utf8');
  const win = { ReactFlow: { MarkerType: {} } };
  const sandbox = { window: win, console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return win;
}
const S = loadStyle();

test('a code node keeps the normal large thumbnail row', () => {
  const normal = { inputs: [], outputs: [], thumb: true, thumbSize: 'large' };
  const code = { ...normal, slx: { source: '' } };
  assert.equal(S.thumbRowH(normal), S.THUMB_SIDE + 1);
  assert.equal(S.thumbRowH(code), S.THUMB_SIDE + 1);
  assert.equal(S.nodeWidth(code), S.SLX_NODE_W);
  const bare = { inputs: [], outputs: [], slx: { source: '' } };
  assert.equal(S.nodeHeight(code) - S.nodeHeight(bare), S.THUMB_SIDE + 1);
});
