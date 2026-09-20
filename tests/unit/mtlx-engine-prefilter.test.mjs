import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

function loadEnsurePrefilteredEnv() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const enginePath = path.join(root, 'js', 'mtlx-engine.js');
  const source = fs.readFileSync(enginePath, 'utf8');
  const start = source.indexOf('const ensurePrefilteredEnv =');
  const end = source.indexOf('\n\n// The radiance sampler', start);
  const context = {
    getSpecularEnvMethod: () => 'prefilter',
    mtlxWarn() {},
  };
  vm.runInNewContext(source.slice(start, end) + '\nthis.ensurePrefilteredEnv = ensurePrefilteredEnv;', context, {
    filename: enginePath,
  });
  return context.ensurePrefilteredEnv;
}

test('environment prefilter remains retryable until a WebGL2 renderer is available', () => {
  const ensurePrefilteredEnv = loadEnsurePrefilteredEnv();
  const env = { radiance: {} };

  assert.equal(ensurePrefilteredEnv(null, env), env);
  assert.equal(env.prefilterTried, undefined);

  assert.equal(ensurePrefilteredEnv({ capabilities: { isWebGL2: false } }, env), env);
  assert.equal(env.prefilterTried, undefined);

  const renderer = {
    capabilities: { isWebGL2: true },
    extensions: { get: () => null },
  };
  assert.equal(ensurePrefilteredEnv(renderer, env), env);
  assert.equal(env.prefilterTried, true);
});
