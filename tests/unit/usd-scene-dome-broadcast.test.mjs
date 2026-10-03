// P6 S2 fixes in js/usd-scene-renderer.js: an active stage dome ignores
// global environment broadcasts (LIVE_VIEWS setEnvironment without
// {user:true}), and leaving the dome clears its tilt.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = fs.readFileSync(path.join(root, 'js', 'usd-scene-renderer.js'), 'utf8');

function loadSetEnvironment(state) {
  const start = source.indexOf('        const setEnvironment = (next, opts) => {');
  const end = source.indexOf('        const applyEnvironment = (next) => {', start);
  assert.ok(start >= 0 && end > start, 'setEnvironment is present');
  const context = {
    state,
    applied: [],
  };
  vm.runInNewContext(
    'var stopped = false; var domeActive = state.domeActive; var envTilt = state.envTilt;\n'
    + 'const applyEnvironment = (next) => { applied.push(next); return true; };\n'
    + source.slice(start, end)
    + '\nthis.setEnvironment = setEnvironment; this.read = () => ({ domeActive, envTilt });',
    context, { filename: 'usd-scene-renderer.js' });
  return context;
}

test('an active dome ignores a broadcast without {user:true}', () => {
  const ctx = loadSetEnvironment({ domeActive: true, envTilt: 'TILT' });
  assert.equal(ctx.setEnvironment('global-env'), false);
  assert.equal(ctx.applied.length, 0);
  assert.deepEqual({ ...ctx.read() }, { domeActive: true, envTilt: 'TILT' });
});

test('a user environment replaces the dome and clears its tilt', () => {
  const ctx = loadSetEnvironment({ domeActive: true, envTilt: 'TILT' });
  assert.equal(ctx.setEnvironment('imported', { user: true }), true);
  assert.deepEqual([...ctx.applied], ['imported']);
  assert.deepEqual({ ...ctx.read() }, { domeActive: false, envTilt: null });
});

test('without a dome every setEnvironment applies', () => {
  const ctx = loadSetEnvironment({ domeActive: false, envTilt: null });
  assert.equal(ctx.setEnvironment('global-env'), true);
  assert.deepEqual([...ctx.applied], ['global-env']);
});

test('applyDomeLight restores the dome tilt and the dome guard', () => {
  const start = source.indexOf('        const applyDomeLight = () => {');
  const body = source.slice(start, source.indexOf('\n        };', start));
  assert.ok(start >= 0, 'applyDomeLight is present');
  assert.ok(body.includes('envTilt = domeTilt;') && body.includes('domeActive = true;'));
  assert.ok(source.includes("refreshKeyLight: () => { if (!stopped && env) applyEnvironment(env); }"),
    'the key light refresh re-applies the current env without leaving the dome');
});
