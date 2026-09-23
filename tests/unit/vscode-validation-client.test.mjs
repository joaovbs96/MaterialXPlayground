// Coverage for validationClient.js against the fixture worker (queueing,
// timeout/respawn, crash counting, the unavailable cap, dispose) plus one
// real round trip through validationWorker.js itself.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { ValidationClient } = await import(
  pathToFileURL(path.join(ROOT, 'vscode_extension', 'src', 'validationClient.js')).href
);
const FIXTURE_WORKER = path.join(ROOT, 'tests', 'unit', 'fixtures', 'vscode', 'slow-worker.cjs');
const REAL_WORKER = path.join(ROOT, 'vscode_extension', 'src', 'validationWorker.js');

// repoRoot is where the fixture reads its behavior config from (see that
// file's own header comment) - the real client never inspects repoRoot
// itself, so this is safe to repurpose for tests only.
function makeClient(cfg, options) {
  return new ValidationClient({
    repoRoot: JSON.stringify(cfg),
    workerPath: FIXTURE_WORKER,
    timeoutMs: 5000,
    ...options,
  });
}

test('a newer request for a still-queued key supersedes the older one', async () => {
  const client = makeClient({ delayMs: 300 });
  try {
    const first = client.validate('key1', 'a'); // starts running immediately
    const supersededP = client.validate('key2', 'b'); // queued
    const winnerP = client.validate('key2', 'c'); // supersedes the queued 'b'

    const superseded = await supersededP;
    assert.deepEqual(superseded, { status: 'superseded' });

    const [firstResult, winner] = await Promise.all([first, winnerP]);
    assert.equal(firstResult.status, 'ok');
    assert.equal(winner.status, 'ok');
  } finally {
    await client.dispose();
  }
});

test('a timeout fails the job and respawns a fresh worker lazily', async () => {
  const client = makeClient({ hang: true }, { timeoutMs: 100, maxRestarts: 3 });
  try {
    const result = await client.validate('k', 'text');
    assert.deepEqual(result, { status: 'failed', reason: 'timeout' });

    // Not yet degraded (1 failure <= maxRestarts 3) - a second call must
    // still attempt a fresh worker rather than short-circuit unavailable.
    const result2 = await client.validate('k', 'text2');
    assert.deepEqual(result2, { status: 'failed', reason: 'timeout' });
  } finally {
    await client.dispose();
  }
});

test('crashes count toward the restart cap, then the client degrades', async () => {
  const client = makeClient({ crashOnMessage: true }, { maxRestarts: 2 });
  try {
    const r1 = await client.validate('k', 't1');
    assert.deepEqual(r1, { status: 'failed', reason: 'crashed' });
    const r2 = await client.validate('k', 't2');
    assert.deepEqual(r2, { status: 'failed', reason: 'crashed' });
    // Third crash pushes failureCount (3) past maxRestarts (2).
    const r3 = await client.validate('k', 't3');
    assert.deepEqual(r3, { status: 'failed', reason: 'crashed' });

    const r4 = await client.validate('k', 't4');
    assert.deepEqual(r4, { status: 'failed', reason: 'unavailable' });
  } finally {
    await client.dispose();
  }
});

test('dispose resolves pending and in-flight jobs as disposed, idempotently', async () => {
  const client = makeClient({ delayMs: 300 });
  const inFlight = client.validate('k1', 'a');
  const queued = client.validate('k2', 'b');

  const disposePromise = client.dispose();
  const again = client.dispose();
  assert.equal(disposePromise, again, 'dispose() must be idempotent');

  const [inFlightResult, queuedResult] = await Promise.all([inFlight, queued]);
  assert.deepEqual(inFlightResult, { status: 'failed', reason: 'disposed' });
  assert.deepEqual(queuedResult, { status: 'failed', reason: 'disposed' });

  const afterDispose = await client.validate('k3', 'c');
  assert.deepEqual(afterDispose, { status: 'failed', reason: 'disposed' });
  await disposePromise;
});

// ---------------------------------------------------------------------
// Real round trip through validationWorker.js (real validator.js +
// mtlxNode.js inside the worker, no fixture).

test('real worker: a tier-1-broken document resolves ok with tier 1 items', async () => {
  const client = new ValidationClient({
    repoRoot: ROOT,
    workerPath: REAL_WORKER,
    timeoutMs: 30000,
  });
  try {
    const broken = '<materialx version="1.39"><node';
    const result = await client.validate('broken', broken);
    assert.equal(result.status, 'ok');
    assert.ok(result.items.length > 0, 'a malformed document must report at least one diagnostic');
  } finally {
    await client.dispose();
  }
});

test('real worker: a clean document resolves ok with no items', async () => {
  const client = new ValidationClient({
    repoRoot: ROOT,
    workerPath: REAL_WORKER,
    timeoutMs: 30000,
  });
  try {
    const clean = '<?xml version="1.0"?>\n<materialx version="1.39">\n'
      + '  <standard_surface name="SS" type="surfaceshader">\n'
      + '    <input name="base_color" type="color3" value="0.8, 0.8, 0.8" />\n'
      + '  </standard_surface>\n</materialx>';
    const result = await client.validate('clean', clean);
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.items, []);
  } finally {
    await client.dispose();
  }
});
